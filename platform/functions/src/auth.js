/**
 * Authentication and request identity.
 *
 * Two credential types, resolved in this order:
 *   1. `Authorization: Bearer <firebase-id-token>` — first-party clients.
 *   2. `Authorization: Bearer bfk_<prefix>_<secret>` — machine clients using a
 *      Hub API key. Only a SHA-256 hash of the secret is stored; the plaintext
 *      is shown once at creation and never again.
 *
 * A request with no credential is anonymous. Routes decide whether anonymous is
 * acceptable; the default is that it is not.
 */

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { bearerToken, unauthorized, forbidden } from './http.js';
import { resolveEntitlement } from './entitlements.js';

const API_KEY_PREFIX = 'bfk';
export const API_KEY_PATTERN = /^bfk_([a-z0-9]{8})_([A-Za-z0-9_-]{32,})$/;

/** Hash an API key secret for storage/lookup. Never store the plaintext. */
export function hashApiKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Generate a new API key. Returns the plaintext once plus what we persist. */
export function generateApiKey({ now = () => Date.now() } = {}) {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${API_KEY_PREFIX}_${prefix}_${secret}`;
  return {
    plaintext,
    prefix,
    keyHash: hashApiKey(plaintext),
    createdAt: new Date(now()).toISOString(),
  };
}

/** Constant-time comparison of two hex digests. */
export function digestsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Resolve the caller.
 *
 * @param {object} options
 * @param {object} options.req
 * @param {object} options.store
 * @param {(token: string) => Promise<object|null>} options.verifyIdToken
 * @returns {Promise<{uid: string, email: string, tier: string, authType: string,
 *                    entitlement: object, apiKey?: object} | null>}
 */
export async function resolveIdentity({ req, store, verifyIdToken, tenantId = '', now = () => Date.now() }) {
  const token = bearerToken(req);
  if (!token) return null;

  if (API_KEY_PATTERN.test(token)) {
    return resolveApiKeyIdentity({ token, store, tenantId, now });
  }

  return resolveFirebaseIdentity({ token, store, verifyIdToken, tenantId, now });
}

async function resolveFirebaseIdentity({ token, store, verifyIdToken, tenantId, now }) {
  if (typeof verifyIdToken !== 'function') throw unauthorized('Sign-in is not configured.');

  let decoded;
  try {
    decoded = await verifyIdToken(token);
  } catch (error) {
    const code = error?.code || '';
    if (code === 'auth/id-token-expired') throw unauthorized('Your session expired. Sign in again.');
    if (code === 'auth/argument-error' || code === 'auth/invalid-id-token') {
      throw unauthorized('That credential is not valid.');
    }
    // A verifier outage must not read as "you are logged out" — but it also
    // must not read as "you are logged in". 401 with a retry hint is correct.
    throw unauthorized('Could not verify your session.');
  }

  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) {
    throw unauthorized('That credential is not valid.');
  }

  // Tenant isolation: when a FrostByte tenant is configured, a token from the
  // project root pool (Blackfrost AI) or any other tenant must never resolve
  // to a FrostByte identity — even when the verifier itself was stubbed.
  const tokenTenant = typeof decoded.firebase?.tenant === 'string' ? decoded.firebase.tenant : '';
  if (tenantId && tokenTenant !== tenantId) {
    throw unauthorized('That credential does not belong to this Hub.');
  }

  // Per-device desktop session revocation: custom tokens minted via
  // /v1/auth/desktop/exchange carry `frostbyteDesktopSession`. Firebase keeps
  // developer claims across refresh-token renewals, so revoking the session doc
  // invalidates only that desktop device without logging out web/other devices.
  const desktopSessionId = typeof decoded.frostbyteDesktopSession === 'string'
    ? decoded.frostbyteDesktopSession
    : '';
  if (desktopSessionId && typeof store.getDesktopSession === 'function') {
    const desktopSession = await store.getDesktopSession(desktopSessionId);
    if (!desktopSession || desktopSession.uid !== decoded.uid || desktopSession.revokedAt) {
      throw unauthorized('This desktop session has been signed out. Sign in again.');
    }
  }

  const user = await store.getUser(decoded.uid);
  if (user?.disabled === true) throw forbidden('This account is disabled.');

  // Admin status is a UX hint for admin routes (every /v1/admin route still
  // re-checks claim AND admins/{uid} AND freshness), and also grants Pro
  // platform entitlement to active operators.
  const hasVerifiedAdminClaim = decoded.frostbyteAdmin === true && decoded.email_verified === true;
  const adminDoc = hasVerifiedAdminClaim && typeof store.getAdmin === 'function' ? await store.getAdmin(decoded.uid) : null;
  const isAdmin = Boolean(hasVerifiedAdminClaim && adminDoc?.status === 'active');

  const subscription = await store.getSubscription(decoded.uid);
  const override = typeof store.getEntitlementOverride === 'function' ? await store.getEntitlementOverride(decoded.uid) : null;
  const entitlement = resolveEntitlement(subscription, now(), override, { isAdmin });

  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email : user?.email || '',
    emailVerified: decoded.email_verified === true,
    displayName: typeof decoded.name === 'string' ? decoded.name : user?.displayName || '',
    photoUrl: typeof decoded.picture === 'string' ? decoded.picture : user?.photoUrl || '',
    authTimeSec: typeof decoded.auth_time === 'number' ? decoded.auth_time : 0,
    claims: decoded,
    tenantId: tokenTenant || tenantId || '',
    desktopSessionId,
    isAdmin,
    adminRole: isAdmin ? adminDoc.role || 'admin' : null,
    tier: entitlement.tier,
    authType: 'firebase',
    entitlement,
    user,
  };
}

async function resolveApiKeyIdentity({ token, store, tenantId, now }) {
  const keyHash = hashApiKey(token);
  const record = await store.getApiKey(keyHash);
  // Uniform message on every rejection path. Distinguishing "revoked" from
  // "unknown" would tell a caller which of their guesses was a real key.
  const rejected = () => unauthorized('That API key is not valid.');

  if (!record) throw rejected();
  if (record.revokedAt) throw rejected();
  if (record.expiresAt && Date.parse(record.expiresAt) <= now()) throw rejected();

  if (typeof record.keyHash === 'string' && !digestsMatch(record.keyHash, keyHash)) {
    throw rejected();
  }

  const user = await store.getUser(record.uid);
  if (!user) throw unauthorized('That API key no longer belongs to an account.');
  if (user.disabled === true) throw forbidden('This account is disabled.');
  // Pre-tenant keys (minted against the shared root pool before isolation)
  // must stop working the moment the tenant goes live.
  if (tenantId && user.tenantId !== tenantId) throw rejected();

  const subscription = await store.getSubscription(record.uid);
  const override = typeof store.getEntitlementOverride === 'function' ? await store.getEntitlementOverride(record.uid) : null;
  const adminDoc = typeof store.getAdmin === 'function' ? await store.getAdmin(record.uid) : null;
  const hasActiveAdminEntitlement = Boolean(adminDoc?.status === 'active');
  const entitlement = resolveEntitlement(subscription, now(), override, { isAdmin: hasActiveAdminEntitlement });

  return {
    uid: record.uid,
    email: user.email || '',
    emailVerified: true,
    displayName: user.displayName || '',
    photoUrl: user.photoUrl || '',
    authTimeSec: 0,
    claims: null,
    tenantId: user.tenantId || '',
    isAdmin: false,
    adminRole: null,
    tier: entitlement.tier,
    authType: 'apiKey',
    entitlement,
    user,
    apiKey: { prefix: record.prefix, keyHash },
  };
}

/** Throw 401 unless an identity was resolved. */
export function requireIdentity(identity) {
  if (!identity) throw unauthorized();
  return identity;
}