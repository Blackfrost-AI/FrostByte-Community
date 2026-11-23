/**
 * Hub protocol constants — shared between app, Hub service, CLI, and MCP.
 * Pure module: no Electron, no Node fs, no fetch. Bounded, deterministic.
 */

export const HUB_API_VERSION = 'v1';
export const HUB_API_PREFIX = `/${HUB_API_VERSION}`;

// Entitlement tiers (source of truth: Stripe webhook → entitlements table).
// `free` = anonymous / no subscription; `offline` = bundle-seeded / air-gap.
export const ENTITLEMENT_TIERS = Object.freeze(['free', 'plus', 'pro', 'offline']);
export const PAID_TIERS = Object.freeze(['plus', 'pro']);
export const TIER_RANK = Object.freeze({ free: 0, offline: 0, plus: 1, pro: 2 });

// Route templates (matches docs/hub-api.md §6).
export const HUB_ROUTES = Object.freeze({
  me: '/v1/me',
  // Auth is Firebase Identity Toolkit (src/main/firebase-auth.js); the deployed
  // Hub verifies Firebase ID tokens and exposes no login/logout route.
  search: '/v1/search',
  recipe: '/v1/recipes/:id',
  recipeManifest: '/v1/recipes/:id/manifest',
  manifestByDigest: '/v1/manifests/:digest',
  publishRecipe: '/v1/recipes',
  withdrawRecipe: '/v1/recipes/:id',
  creator: '/v1/creators/:pubkey',
  follow: '/v1/follows/:pubkey',
  meFollows: '/v1/me/follows',
  feed: '/v1/feed',
  announcements: '/v1/announcements',
  updates: '/v1/updates',
  bundleLatest: '/v1/bundle/latest',
  bundleSegment: '/v1/bundle/:digest',
  changes: '/v1/changes',
  eventsSubscribe: '/v1/events/subscribe',
});

// Pagination & bounds — mirrors hf.js MAX_* pattern and hub-api.md.
export const PAGINATION = Object.freeze({
  DEFAULT_LIMIT: 25,
  MIN_LIMIT: 1,
  MAX_LIMIT: 100,
  MAX_QUERY_LENGTH: 200,
  MAX_BODY_BYTES: 64 * 1024,
  MAX_MANIFEST_BYTES: 1 * 1024 * 1024,
  MAX_URL_LENGTH: 2048,
});

export const RATE_LIMITS = Object.freeze({
  anonPerMinute: 60,
  authedPerMinute: 600,
  publishPerMinute: 10,
});

export const CURSOR_KIND = 'hub-cursor-v1';
export const BUNDLE_DOMAIN = 'frostbyte-bundle/1';
export const RECIPE_SIGN_DOMAIN = 'frostbyte-recipe/2';

// Community home plane (P3) — mirrors platform/functions/src/store/contract.js;
// root drift guards pin these to the deployed values.
export const FOLLOW_CAP = 256;
export const PINNED_ANNOUNCEMENT_CAP = 3;
export const RECIPE_SCAN_WINDOW = 500;
export const FEED_DEFAULT_LIMIT = 25;
export const FEED_MAX_LIMIT = 50;

// ETag helpers — hub serves manifests by sha256 digest as ETag.
export function etagForDigest(digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid digest for ETag.');
  return `"sha256:${digest}"`;
}

export function digestFromEtag(etag) {
  const m = /^\s*"?sha256:([a-f0-9]{64})"?\s*$/.exec(etag || '');
  return m ? m[1] : '';
}

// Cursor helpers — opaque base64; hub is source of truth, client treats as opaque.
export function encodeCursor(value) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > 4096) throw new Error('Cursor payload too large.');
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor) return null;
  if (cursor.length > 4096) throw new Error('Cursor too large.');
  // Allow base64url and legacy base64
  const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cursor shape.');
    return value;
  } catch {
    throw new Error('Invalid cursor.');
  }
}

export function clampLimit(value, fallback = PAGINATION.DEFAULT_LIMIT) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(PAGINATION.MAX_LIMIT, Math.max(PAGINATION.MIN_LIMIT, n));
}

// Tier helpers
export function tierAtLeast(actual, required) {
  const a = TIER_RANK[actual] ?? 0;
  const r = TIER_RANK[required] ?? 0;
  return a >= r;
}

export function isPaidTier(tier) {
  return PAID_TIERS.includes(tier);
}

// Search token preservation — quant tokens like Q4_K_M, 1B, 3.1 must not be lowercased/stemmed.
export function normalizeSearchQuery(query) {
  if (typeof query !== 'string') return '';
  // Trim, collapse whitespace, preserve case for quant tokens; length bounded.
  const trimmed = query.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  if (Buffer.byteLength(trimmed, 'utf8') > PAGINATION.MAX_QUERY_LENGTH) {
    throw new Error('Search query too long.');
  }
  return trimmed;
}

export const HUB_PROTOCOL_VERSION = 1;
