/**
 * Rate limiting.
 *
 * Fixed-window counters in Firestore, keyed by identity and day. Cheap, honest,
 * and good enough: the goal is to stop one client from exhausting a shared
 * upstream quota, not to be fair under adversarial load.
 *
 * Every limit is per-tier so a Free user cannot consume a Plus user's budget.
 *
 * Counters are read *before* being incremented, so a request that is already
 * over its limit does not burn further budget. Otherwise a client hammering
 * while throttled would never recover until the window rolled over.
 */

import { rateLimited } from './http.js';

export const LIMITS = Object.freeze({
  free: Object.freeze({ discoveryPerMinute: 20, discoveryPerDay: 500, writesPerMinute: 10, writesPerDay: 500, adminPerMinute: 60 }),
  offline: Object.freeze({ discoveryPerMinute: 20, discoveryPerDay: 500, writesPerMinute: 10, writesPerDay: 500, adminPerMinute: 60 }),
  plus: Object.freeze({ discoveryPerMinute: 60, discoveryPerDay: 5_000, writesPerMinute: 30, writesPerDay: 5_000, adminPerMinute: 60 }),
  pro: Object.freeze({ discoveryPerMinute: 240, discoveryPerDay: 50_000, writesPerMinute: 120, writesPerDay: 20_000, adminPerMinute: 60 }),
});

export function limitsFor(tier) {
  return LIMITS[tier] || LIMITS.free;
}

function minuteKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 16).replace(/[:T]/g, '');
}

function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Consume one unit of a named budget. Throws 429 when exhausted.
 *
 * Reads first, then increments only if the request is allowed. A 429 therefore
 * costs nothing, which is what makes retry-after behaviour sane.
 *
 * @param {object} options
 * @param {object} options.store
 * @param {string} options.uid
 * @param {string} options.tier
 * @param {'discovery'|'writes'|'admin'|'desktopExchange'|'anonReads'} options.bucket
 * @param {() => number} [options.now]
 */
export async function consume({ store, uid, tier, bucket, now = () => Date.now() }) {
  const nowMs = now();
  const limits = limitsFor(tier);

  // The admin console gets its own fixed 60 req/min budget per uid, independent
  // of plan tier and with no daily cap (operators triage in bursts).
  if (bucket === 'admin') {
    const minuteUsage = (await store.getUsage(uid, `m${minuteKey(nowMs)}`)) || {};
    if ((Number(minuteUsage.admin) || 0) >= limits.adminPerMinute) {
      throw rateLimited('Admin rate limit reached. Try again in a minute.', 60);
    }
    await store.incrementUsage(uid, `m${minuteKey(nowMs)}`, 'admin');
    return;
  }

  // Unauthenticated desktop code exchange gets a strict per-IP minute ceiling.
  if (bucket === 'desktopExchange') {
    const minuteUsage = (await store.getUsage(uid, `m${minuteKey(nowMs)}`)) || {};
    if ((Number(minuteUsage.desktopExchange) || 0) >= 20) {
      throw rateLimited('Too many desktop sign-in attempts. Wait a minute and try again.', 60);
    }
    await store.incrementUsage(uid, `m${minuteKey(nowMs)}`, 'desktopExchange');
    return;
  }

  // Anonymous recipe-plane reads (search/recipes/manifests/changes) get a
  // per-IP minute ceiling matching the documented anon 60/min contract. The
  // uid here is the `ip:<hash>` key from recipes.js — never a real account.
  if (bucket === 'anonReads') {
    const minuteUsage = (await store.getUsage(uid, `m${minuteKey(nowMs)}`)) || {};
    if ((Number(minuteUsage.anonReads) || 0) >= 60) {
      throw rateLimited('Anonymous read limit reached. Sign in for a higher quota, or wait a minute.', 60);
    }
    await store.incrementUsage(uid, `m${minuteKey(nowMs)}`, 'anonReads');
    return;
  }

  const perMinute = bucket === 'discovery' ? limits.discoveryPerMinute : limits.writesPerMinute;
  const perDay = bucket === 'discovery' ? limits.discoveryPerDay : limits.writesPerDay;

  const minuteUsage = (await store.getUsage(uid, `m${minuteKey(nowMs)}`)) || {};
  if ((Number(minuteUsage[bucket]) || 0) >= perMinute) {
    throw rateLimited(`Rate limit reached (${perMinute}/minute on ${tier}).`, 60);
  }

  const dayUsage = (await store.getUsage(uid, dayKey(nowMs))) || {};
  if ((Number(dayUsage[bucket]) || 0) >= perDay) {
    throw rateLimited(`Daily limit reached (${perDay}/day on ${tier}).`, 3600);
  }

  const usedMinute = await store.incrementUsage(uid, `m${minuteKey(nowMs)}`, bucket);
  const usedDay = await store.incrementUsage(uid, dayKey(nowMs), bucket);

  return {
    perMinute,
    perDay,
    usedMinute: Number(usedMinute?.[bucket]) || 0,
    usedDay: Number(usedDay?.[bucket]) || 0,
  };
}