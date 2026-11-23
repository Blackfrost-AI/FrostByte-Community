/**
 * Entitlements — tier cache + grace + gates. Pure: no store, no fetch here.
 * Store + IPC owner persists/entitlements snapshot; this module is the policy.
 */
import { ENTITLEMENT_TIERS, TIER_RANK, PAID_TIERS } from '../shared/hub-protocol.js';

const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days offline grace
const TTL_MS = 5 * 60 * 1000; // 5 min server-truth TTL

function nowMs(now) { return typeof now === 'function' ? now() : Date.now(); }

export function createEntitlementCache({ now = Date.now } = {}) {
  let snapshot = {
    tier: 'free',
    status: 'inactive',
    entitlements: {},
    currentPeriodEnd: null,
    fetchedAt: 0,
    source: 'local', // local | hub | cache | grace | offline
  };
  return {
    get() { return { ...snapshot }; },
    set(next) {
      if (!next || typeof next !== 'object') throw new Error('Invalid entitlement snapshot.');
      const tier = ENTITLEMENT_TIERS.includes(next.tier) ? next.tier : 'free';
      snapshot = {
        tier,
        status: typeof next.status === 'string' ? next.status.slice(0, 32) : 'inactive',
        entitlements: next.entitlements && typeof next.entitlements === 'object' ? { ...next.entitlements } : {},
        currentPeriodEnd: next.currentPeriodEnd || null,
        fetchedAt: Number.isFinite(next.fetchedAt) ? next.fetchedAt : nowMs(now),
        source: typeof next.source === 'string' ? next.source.slice(0, 16) : 'local',
      };
      return this.get();
    },
    tier() { return snapshot.tier; },
    isPaid() { return PAID_TIERS.includes(snapshot.tier); },
    allows(requiredTier) {
      const want = TIER_RANK[requiredTier] ?? 0;
      const have = TIER_RANK[snapshot.tier] ?? 0;
      return have >= want;
    },
    isStale() {
      if (!snapshot.fetchedAt) return true;
      return (nowMs(now) - snapshot.fetchedAt) > TTL_MS;
    },
    isExpired() {
      if (!snapshot.currentPeriodEnd) return snapshot.tier !== 'free' && snapshot.tier !== 'offline';
      const end = Date.parse(snapshot.currentPeriodEnd);
      if (!Number.isFinite(end)) return false;
      return nowMs(now) > end + GRACE_MS;
    },
    offlineTier() {
      // If hub-unreachable but snapshot still within grace, keep paid tier; otherwise free.
      if (this.isExpired()) return 'free';
      return snapshot.tier;
    },
  };
}

export const ENTITLEMENT_GRACE_MS = GRACE_MS;
export const ENTITLEMENT_TTL_MS = TTL_MS;

export function gate({ tier, required }) {
  const have = TIER_RANK[tier] ?? 0;
  const need = TIER_RANK[required] ?? 0;
  return have >= need;
}
