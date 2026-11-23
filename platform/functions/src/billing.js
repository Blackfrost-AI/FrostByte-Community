/**
 * Stripe billing webhook.
 *
 * This module is written and tested but **not activated**: without
 * `STRIPE_HUB_WEBHOOK_SECRET` in the environment every request is refused 503,
 * so deploying it cannot silently start mutating entitlements from unsigned
 * input.
 *
 * Signature verification is implemented here rather than pulled from the Stripe
 * SDK so the exact bytes that are signed are obvious and testable. The scheme is
 * Stripe's documented `t=<ts>,v1=<hex hmac-sha256>` over `<ts>.<raw body>`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { HubError, readJsonBody, unauthorized, unavailable, badRequest } from './http.js';

const MAX_BODY_BYTES = 256 * 1024;
const TOLERANCE_SECONDS = 300;

/** Build the signed payload Stripe uses. Exported for tests. */
export function signedPayload(timestamp, rawBody) {
  return `${timestamp}.${rawBody}`;
}

/** Compute the expected v1 signature. */
export function computeSignature(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(signedPayload(timestamp, rawBody), 'utf8').digest('hex');
}

/**
 * Verify a Stripe-Signature header.
 *
 * @returns {{ok: true, timestamp: number} | {ok: false, reason: string}}
 */
export function verifySignature({ header, rawBody, secret, nowMs = Date.now(), toleranceSeconds = TOLERANCE_SECONDS }) {
  if (typeof header !== 'string' || header === '') return { ok: false, reason: 'missing_signature' };
  if (typeof secret !== 'string' || secret === '') return { ok: false, reason: 'missing_secret' };

  const parts = header.split(',').map((entry) => entry.trim());
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't' && /^\d{1,12}$/.test(value || '')) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value || '')) signatures.push(value.toLowerCase());
  }

  if (timestamp === null) return { ok: false, reason: 'missing_timestamp' };
  if (signatures.length === 0) return { ok: false, reason: 'missing_v1_signature' };

  const ageSeconds = Math.abs(nowMs / 1000 - timestamp);
  if (ageSeconds > toleranceSeconds) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const expected = computeSignature(secret, timestamp, rawBody);
  const expectedBuffer = Buffer.from(expected, 'hex');

  for (const candidate of signatures) {
    const candidateBuffer = Buffer.from(candidate, 'hex');
    if (candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer)) {
      return { ok: true, timestamp };
    }
  }

  return { ok: false, reason: 'signature_mismatch' };
}

/**
 * Map a Stripe subscription object onto our internal subscription record.
 * Pure — no I/O — so the mapping is directly testable.
 */
export function mapStripeSubscription(stripeSubscription, { nowMs = Date.now() } = {}) {
  if (!stripeSubscription || typeof stripeSubscription !== 'object') {
    throw badRequest('Malformed subscription object.');
  }

  const status = typeof stripeSubscription.status === 'string' ? stripeSubscription.status : 'incomplete';
  const tier = tierFromSubscription(stripeSubscription);
  const periodEnd = Number.isFinite(stripeSubscription.current_period_end)
    ? stripeSubscription.current_period_end * 1000
    : null;

  return {
    provider: 'stripe',
    providerSubscriptionId: String(stripeSubscription.id || ''),
    providerCustomerId: String(stripeSubscription.customer || ''),
    tier,
    status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd).toISOString() : null,
    cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end === true,
    priceId: stripeSubscription.items?.data?.[0]?.price?.id || '',
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Determine the tier from a Stripe subscription.
 *
 * Prefers `metadata.tier` (set at checkout) and falls back to the price ID
 * against a configured map. Anything unrecognized resolves to `free` — never
 * guess upward.
 */
export function tierFromSubscription(stripeSubscription, priceMap = defaultPriceMap()) {
  const metadataTier = stripeSubscription?.metadata?.tier;
  if (metadataTier === 'plus' || metadataTier === 'pro') return metadataTier;

  const priceId = stripeSubscription?.items?.data?.[0]?.price?.id;
  if (typeof priceId === 'string' && priceMap[priceId]) return priceMap[priceId];

  return 'free';
}

function defaultPriceMap() {
  const map = {};
  if (process.env.STRIPE_PRICE_PLUS_MONTHLY) map[process.env.STRIPE_PRICE_PLUS_MONTHLY] = 'plus';
  if (process.env.STRIPE_PRICE_PLUS_YEARLY) map[process.env.STRIPE_PRICE_PLUS_YEARLY] = 'plus';
  if (process.env.STRIPE_PRICE_PRO_MONTHLY) map[process.env.STRIPE_PRICE_PRO_MONTHLY] = 'pro';
  if (process.env.STRIPE_PRICE_PRO_YEARLY) map[process.env.STRIPE_PRICE_PRO_YEARLY] = 'pro';
  return map;
}

/** Stripe webhook secrets are always `whsec_…`. Anything else is inert. */
const STRIPE_SECRET_PATTERN = /^whsec_[A-Za-z0-9]{8,}$/;

/**
 * Handle a webhook delivery.
 *
 * Idempotency: Stripe retries. Each event id is recorded in `auditLog` before
 * the mutation is applied, so a replay is a no-op rather than a double-apply.
 */
export async function handleStripeWebhook({ req, store, now = () => Date.now() }) {
  const secret = process.env.STRIPE_HUB_WEBHOOK_SECRET;
  // Billing is deliberately closed until a real Stripe signing secret is
  // installed. A placeholder value in Secret Manager keeps the deployment valid
  // without ever accepting unsigned input.
  if (!secret || !STRIPE_SECRET_PATTERN.test(secret)) {
    throw unavailable('Billing is not configured on this deployment.');
  }

  const rawBody = await readRawBody(req, MAX_BODY_BYTES);
  const header = req.headers?.['stripe-signature'] || req.headers?.['Stripe-Signature'] || '';

  const verification = verifySignature({ header, rawBody, secret, nowMs: now() });
  if (!verification.ok) {
    // Log the precise reason server-side; return a uniform message so a caller
    // cannot use the response to probe which part of the signature check failed.
    console.warn(JSON.stringify({ severity: 'WARNING', message: 'stripe_signature_rejected', reason: verification.reason }));
    throw unauthorized('Webhook signature rejected.');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw badRequest('Webhook body is not valid JSON.');
  }

  const eventId = typeof event?.id === 'string' ? event.id : '';
  const eventType = typeof event?.type === 'string' ? event.type : '';
  if (!eventId || !eventType) throw badRequest('Webhook event is missing an id or type.');

  const seen = await store.getUsage(`stripeEvent:${eventId}`, 'seen');
  if (seen) return { ok: true, duplicate: true, eventId };

  // Claim the event id *before* applying the mutation. Stripe retries on
  // timeout, and a concurrent duplicate must not double-apply. A crash between
  // claim and apply loses that event — Stripe's retry then hits the claim and
  // no-ops, so we record the claim only for events we are about to apply and
  // accept that tradeoff explicitly (recoverable by replaying from the Stripe
  // dashboard, which is the documented operational path).
  await store.incrementUsage(`stripeEvent:${eventId}`, 'seen', 'count');

  const object = event.data?.object || {};
  const uid = resolveUid(object);

  // Operator-facing billing ledger (spec §5.5): every claimed event lands in
  // stripeEvents exactly once, with enough context for support triage. The
  // raw payload never enters the ledger — only identifiers and outcomes.
  const recordEvent = (fields) =>
    store.recordStripeEvent({
      eventId,
      type: eventType,
      uid: uid || '',
      customerId: typeof object.customer === 'string' ? object.customer : '',
      processedAt: new Date(now()).toISOString(),
      ...fields,
    });

  switch (eventType) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (!uid) throw badRequest('Subscription event has no resolvable user.');
      const record = mapStripeSubscription(object, { nowMs: now() });

      // Out-of-order protection. Stripe does not guarantee delivery order, and
      // it retries. Without this, a delayed `deleted` (canceled, period ended
      // long ago) can clobber a fresh `created` and silently drop a paying
      // user to free until their next event.
      //
      // Compare our record's period end against the stored one: an event
      // describing an *older* period is stale. Equal period ends are allowed
      // through, because that is the normal created -> updated sequence within
      // one billing period (e.g. cancel_at_period_end flipping).
      const existing = await store.getSubscription(uid);
      if (existing && isStaleEvent(record, existing)) {
        await recordEvent({ tier: record.tier, status: 'stale_skipped' });
        await store.appendAudit({
          action: 'billing.stale_skipped',
          actorUid: 'system',
          actorEmail: 'stripe-webhook',
          targetType: 'billing',
          targetId: uid || eventId,
          reason: `Stale Stripe event skipped: ${eventType} (${eventId})`,
          uid,
          eventType,
          eventId,
          storedPeriodEnd: existing.currentPeriodEnd ?? null,
          eventPeriodEnd: record.currentPeriodEnd,
        });
        return { ok: true, eventId, applied: null, stale: true };
      }

      await store.setSubscription(uid, record);
      await recordEvent({ tier: record.tier, status: record.status || 'active' });
      await store.appendAudit({
        action: 'billing.subscription',
        actorUid: 'system',
        actorEmail: 'stripe-webhook',
        targetType: 'billing',
        targetId: uid || eventId,
        reason: `Stripe ${eventType} applied (${eventId})`,
        uid,
        eventType,
        eventId,
        tier: record.tier,
      });
      return { ok: true, eventId, applied: eventType, tier: record.tier };
    }

    default:
      await recordEvent({ tier: '', status: 'ignored' });
      await store.appendAudit({
        action: 'billing.ignored',
        actorUid: 'system',
        actorEmail: 'stripe-webhook',
        targetType: 'billing',
        targetId: eventId,
        reason: `Stripe event ignored: ${eventType} (${eventId})`,
        eventType,
        eventId,
      });
      return { ok: true, eventId, applied: null };
  }
}

/**
 * True when `incoming` describes an older billing period than `stored`.
 *
 * A subscription's `current_period_end` only moves forward as it renews, so it
 * is a reliable ordering key. An event with a strictly earlier period end, or
 * one that has no period end at all while the stored record does, is stale.
 * Records without a period end are not comparable and are never treated as
 * stale — better to apply a real event than to silently drop it.
 */
function isStaleEvent(incoming, stored) {
  const incomingEnd = parsePeriodEnd(incoming.currentPeriodEnd);
  const storedEnd = parsePeriodEnd(stored.currentPeriodEnd);
  if (incomingEnd === null || storedEnd === null) return false;
  return incomingEnd < storedEnd;
}

function parsePeriodEnd(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveUid(object) {
  const fromMetadata = object?.metadata?.uid;
  if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata;
  const fromClientRef = object?.client_reference_id;
  if (typeof fromClientRef === 'string' && fromClientRef) return fromClientRef;
  return '';
}

async function readRawBody(req, maxBytes) {
  if (Buffer.isBuffer(req.rawBody)) {
    if (req.rawBody.length > maxBytes) throw new HubError(413, 'payload_too_large', 'Body too large.');
    return req.rawBody.toString('utf8');
  }
  if (typeof req.rawBody === 'string') return req.rawBody;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HubError(413, 'payload_too_large', 'Body too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export { readJsonBody };