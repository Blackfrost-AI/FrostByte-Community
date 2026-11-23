/**
 * Hub trust boundaries — pure, no Electron imports.
 *
 * The production build uses one pinned HTTPS Hub API base and one pinned site
 * origin. User-supplied Hub URLs and loopback development Hubs are intentionally
 * unsupported now that FrostNet is live: no bearer credential may leave the
 * machine to any other destination. Paid tiers still require server proof.
 */
import { createHash } from 'node:crypto';

export const MAX_HUB_ORIGIN = 2048;
export const MAX_HUB_TOKEN_BYTES = 4096;
/** Tiers the renderer may select locally. Paid tiers require server proof. */
export const RENDERER_SETTABLE_TIERS = Object.freeze(['free', 'offline']);

export const HUB_API_BASE = 'https://us-central1-blackfrost-ai-prod.cloudfunctions.net/hubApi';
export const HUB_API_ORIGIN = new URL(HUB_API_BASE).origin;

/**
 * Normalize a session expiry to epoch milliseconds, or 0 when unknown.
 * Firebase returns epoch ms (a safe integer); the local development Hub returns
 * an ISO-8601 string. Both must bind to the origin as a positive integer —
 * Store.setHubTokenExpiry rejects an origin-bound expiry of 0, so an unnormalized
 * ISO string would otherwise abort the whole sign-in.
 */
export function normalizeSessionExpiry(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * Validate a Hub API base URL and return the pinned production base. Unlike the
 * legacy helper this preserves the /hubApi path; Cloud Function deployments are
 * not mounted at the bare origin.
 */
export function validateHubBaseUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_HUB_ORIGIN || /[\0\r\n]/.test(value)) {
    throw new Error('Invalid Hub URL.');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Hub URL.'); }
  if (url.username || url.password) throw new Error('Hub URL must not contain credentials.');
  if (url.protocol !== 'https:') throw new Error('Hub URL must use HTTPS.');
  if (url.origin !== HUB_API_ORIGIN || url.pathname.replace(/\/$/, '') !== '/hubApi') {
    throw new Error('Hub URL must be the production FrostByte Hub API.');
  }
  if (url.search || url.hash) throw new Error('Hub URL must not contain a query or fragment.');
  return HUB_API_BASE;
}

/** Backwards-compatible alias: callers now receive the full pinned base. */
export function validateHubOrigin(value) {
  return validateHubBaseUrl(value);
}

/** True when a bearer credential may travel to this pinned Hub API base. */
export function bearerAllowed(origin) {
  try { return validateHubBaseUrl(origin) === HUB_API_BASE; } catch { return false; }
}

export function describeHubToken(token) {
  if (typeof token !== 'string') throw new Error('Hub token is invalid.');
  const byteLength = Buffer.byteLength(token, 'utf8');
  if (!byteLength || byteLength > MAX_HUB_TOKEN_BYTES || /[\0\r\n\s]/.test(token)) throw new Error('Hub token is invalid.');
  return { byteLength, fingerprint: createHash('sha256').update(token, 'utf8').digest('hex') };
}

/**
 * Decode the Identity Platform tenant claim (`firebase.tenant`) from a
 * Firebase ID token WITHOUT verifying the signature — the Hub verifies the
 * token; this is only used to LABEL the local session with its real tenant
 * (review F1) so a root-pool credential can never be fallback-labeled into a
 * tenant-matching one. Any parse failure or malformed claim yields '' (which
 * fails toward eviction on a stamped build, never toward laundering).
 * Manual bfk_ API keys carry no tenant claim and are not JWTs → ''.
 */
export function firebaseTokenTenant(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const claim = payload?.firebase?.tenant;
    return typeof claim === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(claim) ? claim : '';
  } catch { return ''; }
}

/** Stable identifier for "this token at this origin", used to scope remembered approvals. */
export function hubTokenGeneration(origin, fingerprint) {
  const exactOrigin = validateHubBaseUrl(origin);
  if (exactOrigin !== origin) throw new Error('Hub URL must be normalized.');
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new Error('Invalid Hub token fingerprint.');
  return 'sha256:' + createHash('sha256').update(JSON.stringify([exactOrigin, fingerprint])).digest('hex');
}

/** Normalize a renderer request to change the local tier. Paid tiers are refused. */
export function rendererEntitlementRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid entitlement request.');
  const tier = typeof value.tier === 'string' ? value.tier.trim().toLowerCase() : '';
  if (!RENDERER_SETTABLE_TIERS.includes(tier)) {
    throw new Error('Plus and Pro are granted by your Hub account, not set locally.');
  }
  return { tier, status: 'active', source: tier === 'offline' ? 'bundle' : 'local', fetchedAt: Date.now(), entitlements: {} };
}

function quoted(value, max, label) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return JSON.stringify(value);
}

const ACTION_LABELS = Object.freeze({
  account: 'Verify your FrostByte account and subscription',
  logout: 'Sign out and revoke your FrostByte session',
  'desktop-auth': 'Complete browser sign-in for FrostByte',
  health: 'Check whether FrostByte Hub is reachable',
  search: 'Search FrostNet',
  recipe: 'Load recipe details',
  manifest: 'Load a recipe manifest',
  creator: 'Load a creator profile',
  updates: 'Check for live updates',
  'bundle-latest': 'Check the latest offline bundle',
  'bundle-segment': 'Load an offline bundle segment',
  changes: 'Load the FrostNet change feed',
  'update-profile': 'Update your FrostByte profile',
  'set-handle': 'Reserve your FrostByte handle',
  'release-handle': 'Release your FrostByte handle',
  'publisher-keys': 'List your bound publisher keys',
  'publisher-bind': 'Bind your publisher key to your FrostByte account',
  'publisher-unbind': 'Unbind a publisher key from your FrostByte account',
  // P2 share loop + P3 community home. EVERY action routed through
  // hubRequestReview must have a label here — an unlisted action throws
  // before any dialog appears, so the feature silently fails in production
  // even when tests stub the review away. Keep in sync with accountClient()
  // and the reviewHub() call sites in index.js (drift-guarded in tests).
  'recipe-publish': 'Publish your signed recipe to FrostNet',
  'recipe-withdraw': 'Withdraw your recipe from FrostNet',
  feed: 'Load the FrostNet community home feed',
  announcements: 'Load FrostNet announcements',
  'me-follows': 'Load the creators your account follows',
  'follows-migrate': 'Add this device’s followed creators to your FrostByte account',
  follow: 'Follow a creator on FrostNet',
  unfollow: 'Unfollow a creator on FrostNet',
});

export const HUB_REVIEW_ACTIONS = Object.freeze(Object.keys(ACTION_LABELS));

/**
 * Native review before any request to a Hub origin. Remembered approval is
 * per origin for anonymous reads, and per origin + token generation when a
 * bearer credential will be attached.
 */
export function hubRequestReview({ origin, action, authenticated = false, tokenGeneration = '' }) {
  const exactOrigin = validateHubBaseUrl(origin);
  if (exactOrigin !== origin) throw new Error('Hub review URL must be normalized.');
  if (!HUB_REVIEW_ACTIONS.includes(action)) throw new Error('Invalid Hub review action.');
  if (authenticated && !/^sha256:[a-f0-9]{64}$/.test(tokenGeneration)) throw new Error('Invalid Hub credential generation.');
  return {
    summary: `${ACTION_LABELS[action]} at ${origin}.${authenticated ? '\n\nYour saved FrostByte token will be sent with this request.' : ''}`,
    remember: authenticated
      ? { kind: 'hub-account-browse', scope: [origin, tokenGeneration], label: 'Never show again for this FrostByte account' }
      : { kind: 'hub-public-browse', scope: [origin], label: 'Never show again for FrostByte Hub' },
    type: 'question',
    buttons: ['Cancel', authenticated ? 'Send authenticated request' : 'Connect'],
    defaultId: 0,
    cancelId: 0,
    message: authenticated ? 'Use your FrostByte account?' : 'Connect to FrostByte Hub?',
    detail: `Hub API: ${quoted(origin, MAX_HUB_ORIGIN, 'Hub API')}\nAction: ${ACTION_LABELS[action]}${authenticated ? `\nCredential generation: ${quoted(tokenGeneration, 71, 'credential generation')}\n\nThe token is hidden, but it will be sent as a Bearer credential.` : '\n\nNo credential is sent.'}`,
  };
}

/** Native review before a submitted token is saved for a specific origin. */
export function hubTokenSaveReview({ origin, byteLength, fingerprint }) {
  const exactOrigin = validateHubBaseUrl(origin);
  if (exactOrigin !== origin) throw new Error('Hub review URL must be normalized.');
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_HUB_TOKEN_BYTES
    || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new Error('Invalid Hub token review.');
  return {
    summary: `Save a FrostByte session for ${origin}. It is encrypted with your system keychain and only sent to this production Hub API.`,
    type: 'question',
    buttons: ['Cancel', 'Save token'],
    defaultId: 0,
    cancelId: 0,
    message: 'Save this FrostByte session?',
    detail: `Hub API: ${quoted(origin, MAX_HUB_ORIGIN, 'Hub API')}\nToken length: ${byteLength} UTF-8 bytes\nToken SHA-256 fingerprint: ${fingerprint}\n\nOnly the production FrostByte Hub API can receive this token.`,
  };
}
