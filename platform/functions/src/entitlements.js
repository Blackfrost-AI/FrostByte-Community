/**
 * Entitlement policy — the single place tier rules are decided.
 *
 * Mirrors src/shared/hub-protocol.js so the desktop app and the server agree by
 * construction. This module is pure: it takes a subscription-shaped object and
 * answers questions about it. It performs no I/O and reads no clock of its own.
 *
 * The server is the source of truth. The app's `hub-entitlements.js` cache is a
 * UX optimisation with a 7-day grace window; a client that lies about its tier
 * only loses its own features, because every gated route re-resolves the tier
 * from Firestore here.
 */

export const TIERS = Object.freeze(['free', 'plus', 'pro', 'offline']);
export const PAID_TIERS = Object.freeze(['plus', 'pro']);
export const TIER_RANK = Object.freeze({ free: 0, offline: 0, plus: 1, pro: 2 });

/** Subscription states that still grant their tier's features. */
const GRANTING_STATUSES = Object.freeze(['active', 'trialing', 'past_due']);

/** States that never grant features, whatever the tier field says. */
const REVOKED_STATUSES = Object.freeze(['unpaid', 'incomplete_expired', 'revoked']);

export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Longest offline lease an admin override may grant: 30 days. */
export const OVERRIDE_MAX_LEASE_MS = 30 * 24 * 60 * 60 * 1000;

/** Rolling offline lease for active owner/admin accounts: 7 days. */
export const ADMIN_LEASE_MS = 7 * 24 * 60 * 60 * 1000;

export function rank(tier) {
  return TIER_RANK[tier] ?? 0;
}

export function tierAtLeast(actual, required) {
  return rank(actual) >= rank(required);
}

export function isPaidTier(tier) {
  return PAID_TIERS.includes(tier);
}

/**
 * Resolve the effective tier for a user document.
 *
 * Returns `{ tier, status, source, currentPeriodEnd, graceUntil }`.
 *
 * Rules, in order:
 *  1. No subscription → `free`.
 *  2. Unknown tier → `free` (fail closed; never grant on a malformed record).
 *  3. Revoked status → `free` immediately, regardless of period end.
 *  4. `active` / `trialing` / `past_due` → the subscribed tier.
 *  5. `canceled` → the subscribed tier until `currentPeriodEnd`, then `free`.
 *  6. Past `currentPeriodEnd` + 7-day grace → `free`.
 *
 * A user whose billing is unreachable keeps their tier only inside the grace
 * window. This is what makes the offline story work without letting a cancelled
 * card run forever.
 */
export function resolveEntitlement(subscription, nowMs, override = null, options = {}) {
  const fromSubscription = resolveSubscriptionOnly(subscription, nowMs);
  let effective = fromSubscription;

  // An admin override wins only when it outranks the Stripe entitlement (a
  // real paid subscription wins ties), so a user who ALSO pays keeps source
  // 'subscription' and the Stripe billing portal stays available to them.
  if (override && typeof override === 'object' && override.status === 'active' && isPaidTier(override.tier)) {
    const expiresAt = parseTimestamp(override.expiresAt);
    const expiryKnown = override.expiresAt === null || override.expiresAt === undefined || expiresAt !== null;
    if (expiryKnown && (expiresAt === null || expiresAt > nowMs) && rank(override.tier) >= rank(fromSubscription.tier)) {
      // currentPeriodEnd is epoch ms and MUST be finite for a paid tier: the
      // desktop offline lease check treats a null period end on a non-free
      // snapshot as immediately expired. Bound the lease at 30 days so a
      // revoked override stops working offline within a month even if the
      // client never reaches the Hub again.
      const leaseEndMs = expiresAt !== null ? Math.min(expiresAt, nowMs + OVERRIDE_MAX_LEASE_MS) : nowMs + OVERRIDE_MAX_LEASE_MS;
      effective = {
        tier: override.tier,
        status: 'active',
        source: 'admin_override',
        currentPeriodEnd: leaseEndMs,
        graceUntil: leaseEndMs,
      };
    }
  }

  // Active verified owner/admin accounts automatically carry Pro platform
  // entitlement so operators are never stuck on the Free tier on their own Hub.
  // A finite 7-day rolling lease satisfies the desktop offline expiry check
  // while ensuring a revoked admin ages out quickly offline.
  if (options?.isAdmin === true && rank('pro') > rank(effective.tier)) {
    const leaseEndMs = nowMs + ADMIN_LEASE_MS;
    return {
      tier: 'pro',
      status: 'active',
      source: 'admin',
      currentPeriodEnd: leaseEndMs,
      graceUntil: leaseEndMs,
    };
  }

  return effective;
}

/** Stripe-subscription-only resolution — the historical rules, verbatim. */
function resolveSubscriptionOnly(subscription, nowMs) {
  const base = {
    tier: 'free',
    status: 'inactive',
    source: 'none',
    currentPeriodEnd: null,
    graceUntil: null,
  };

  if (!subscription || typeof subscription !== 'object') return base;

  const rawTier = typeof subscription.tier === 'string' ? subscription.tier : '';
  const status = typeof subscription.status === 'string' ? subscription.status : 'inactive';
  const periodEnd = parseTimestamp(subscription.currentPeriodEnd);

  if (!TIERS.includes(rawTier) || rawTier === 'free' || rawTier === 'offline') {
    return { ...base, status, currentPeriodEnd: periodEnd };
  }

  if (REVOKED_STATUSES.includes(status)) {
    return { ...base, status, currentPeriodEnd: periodEnd };
  }

  // No period end at all is a malformed paid record — do not grant.
  if (periodEnd === null) {
    return { ...base, status, currentPeriodEnd: null };
  }

  const graceUntil = periodEnd + GRACE_MS;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  if (!GRANTING_STATUSES.includes(status)) {
    // `canceled` and any other non-granting state fall through to period-end
    // logic below; anything unrecognised is treated as not granting.
    if (status !== 'canceled') return { ...base, status, currentPeriodEnd: periodEnd };
  }

  if (now <= graceUntil) {
    return {
      tier: rawTier,
      status,
      source: now <= periodEnd ? 'subscription' : 'grace',
      currentPeriodEnd: periodEnd,
      graceUntil,
    };
  }

  return { ...base, status: 'expired', currentPeriodEnd: periodEnd, graceUntil };
}

function parseTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    return value.seconds * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * What each tier may do. Consumed by route guards and echoed to clients so the
 * app can grey out features without hardcoding the matrix a second time.
 */
export const TIER_CAPABILITIES = Object.freeze({
  free: Object.freeze({
    discovery: true,
    discoveryProviders: Object.freeze(['huggingface']),
    maxResultsPerPage: 25,
    follows: false,
    updates: false,
    privateRecipes: false,
    orgs: false,
    apiKeys: 0,
  }),
  plus: Object.freeze({
    discovery: true,
    discoveryProviders: Object.freeze(['huggingface', 'localmaxxing', 'pirateface']),
    maxResultsPerPage: 50,
    follows: true,
    updates: true,
    privateRecipes: false,
    orgs: false,
    apiKeys: 3,
  }),
  pro: Object.freeze({
    discovery: true,
    discoveryProviders: Object.freeze(['huggingface', 'localmaxxing', 'pirateface']),
    maxResultsPerPage: 100,
    follows: true,
    updates: true,
    privateRecipes: true,
    orgs: true,
    apiKeys: 20,
  }),
  offline: Object.freeze({
    discovery: true,
    discoveryProviders: Object.freeze(['huggingface']),
    maxResultsPerPage: 25,
    follows: false,
    updates: false,
    privateRecipes: false,
    orgs: false,
    apiKeys: 0,
  }),
});

export function capabilitiesFor(tier) {
  return TIER_CAPABILITIES[tier] || TIER_CAPABILITIES.free;
}

/** True when `tier` may query `provider`. */
export function allowsProvider(tier, provider) {
  return capabilitiesFor(tier).discoveryProviders.includes(provider);
}

/** The public, client-safe view of an entitlement. No billing identifiers. */
export function publicEntitlement(resolved) {
  return {
    tier: resolved.tier,
    status: resolved.status,
    source: resolved.source,
    currentPeriodEnd: resolved.currentPeriodEnd ? new Date(resolved.currentPeriodEnd).toISOString() : null,
    capabilities: capabilitiesFor(resolved.tier),
  };
}