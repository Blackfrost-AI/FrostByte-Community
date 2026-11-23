// Firebase Identity Toolkit authentication for the FrostByte desktop app.
//
// The deployed Hub (platform/functions) verifies Firebase ID tokens directly, so
// the app authenticates against Firebase — exactly like the website — and presents
// the resulting ID token to the Hub as a Bearer credential. The legacy prototype
// `/v1/auth/login` (HS256 session JWT) does not exist in production.
//
// Security posture mirrors hub-client.js: HTTPS only, exact pinned hosts, no
// redirects, bounded time and bytes, and no credential ever appears in an error
// message or log. The web API key is a public project identifier (the same one the
// Desktop never accepts a password: the website authenticates and the resulting
// one-time handoff is exchanged here for ID/refresh tokens. The caller keeps the
// ID token in memory and encrypts the refresh token at rest.

const IDENTITY_HOST = 'identitytoolkit.googleapis.com';
const SECURE_TOKEN_HOST = 'securetoken.googleapis.com';
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

// Firebase returns machine codes; map the common ones to calm, actionable text.
// Anything unrecognized falls back to a generic message so we never echo a raw
// server string (which could carry request details) into the UI.
const ERROR_MESSAGES = {
  INVALID_CUSTOM_TOKEN: 'The sign-in handoff expired or was invalid. Sign in again.',
  CREDENTIAL_MISMATCH: 'Sign-in credential did not match FrostByte.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a moment and try again.',
  USER_DISABLED: 'This account has been disabled.',
  TOKEN_EXPIRED: 'Your session expired. Sign in again.',
  INVALID_REFRESH_TOKEN: 'Your session expired. Sign in again.',
  MISSING_REFRESH_TOKEN: 'Your session expired. Sign in again.',
  INVALID_GRANT_TYPE: 'Your session expired. Sign in again.',
};

function friendlyError(code, fallback) {
  const key = String(code || '').split(' : ')[0].trim();
  return ERROR_MESSAGES[key] || fallback;
}

/**
 * Build an auth error carrying a stable machine `code` so callers can distinguish
 * a definitively dead session (invalid grant) from a transient network failure.
 * The friendly `message` never echoes raw server text, the URL, or the API key.
 */
function authError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Firebase machine codes that mean the refresh credential is permanently dead.
// Only these should cause the stored session to be cleared; everything else
// (network, timeout, unknown) is retryable and must preserve the session.
const DEAD_SESSION_CODES = new Set([
  'TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN', 'MISSING_REFRESH_TOKEN',
  'INVALID_GRANT_TYPE', 'INVALID_GRANT', 'USER_DISABLED', 'USER_NOT_FOUND',
  // Review F2: a refresh that names a different tenant can never become valid
  // for this build — the credential must be cleared, not retried.
  'TENANT_MISMATCH',
]);

/** True when an auth error means the session can never be renewed. */
export function isDeadSessionError(err) {
  return DEAD_SESSION_CODES.has(String(err?.code || '').split(' : ')[0].trim());
}

/**
 * Read a response body with a hard byte ceiling, streaming so a hostile endpoint
 * cannot buffer an arbitrarily large payload into memory before rejection. Counts
 * real bytes (not UTF-16 units). Falls back to .text() only for stub responses that
 * expose no body stream (tests); the byte cap still applies after decoding.
 */
async function readBoundedText(response, maxBytes) {
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw authError('response', 'The sign-in service returned an unexpected response.');
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8').decode(merged);
  }
  // Stub fetchers (tests) may only implement .text(); enforce the cap on bytes.
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw authError('response', 'The sign-in service returned an unexpected response.');
  }
  return text;
}

/**
 * Create a Firebase auth client. `fetcher` is injectable for tests; it must behave
 * like the global fetch (Response with .text()/.ok/.status). `now` is injectable
 * for deterministic expiry math.
 */
function decodeIdTokenClaims(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !parts[1] || parts[1].length > 8192) {
      return { tenant: '', uid: '', email: '', displayName: '' };
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const rawTenant = payload?.firebase?.tenant;
    const tenant = typeof rawTenant === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rawTenant) ? rawTenant : '';
    const rawUid = typeof payload?.user_id === 'string' ? payload.user_id : (typeof payload?.sub === 'string' ? payload.sub : '');
    const uid = rawUid.length <= 128 ? rawUid : '';
    const email = typeof payload?.email === 'string' && payload.email.length <= 320 ? payload.email : '';
    const displayName = typeof payload?.name === 'string' && payload.name.length <= 200 ? payload.name : '';
    return { tenant, uid, email, displayName };
  } catch {
    return { tenant: '', uid: '', email: '', displayName: '' };
  }
}

export function createFirebaseAuth({
  apiKey,
  tenantId = '',
  fetcher = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(apiKey)) {
    throw new Error('A valid Firebase web API key is required.');
  }
  // The FrostByte tenant isolates our accounts from other Blackfrost products.
  // Empty string = legacy root pool (offline/dev before the cutover stamp).
  if (tenantId !== '' && (typeof tenantId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(tenantId))) {
    throw new Error('Firebase tenantId is invalid.');
  }
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required.');

  async function post(host, path, body) {
    const url = `https://${host}${path}?key=${encodeURIComponent(apiKey)}`;
    // Defense in depth: the URL is built from pinned constants, but re-validate.
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.username || parsed.password) {
      throw new Error('Firebase authentication requires a secure connection.');
    }
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network failure, timeout, or a refused redirect. Never surface the URL
      // (it carries the API key) or the underlying error text.
      throw authError('network', 'Could not reach the sign-in service. Check your connection and try again.');
    }
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!response.ok) {
      const code = String(data?.error?.message || '').split(' : ')[0].trim() || 'unknown';
      throw authError(code, friendlyError(code, 'Sign-in failed. Check your details and try again.'));
    }
    if (!data || typeof data !== 'object') throw authError('response', 'The sign-in service returned an unexpected response.');
    return data;
  }

  function normalizeSession(data, { registered }) {
    const idToken = data.idToken;
    const refreshToken = data.refreshToken;
    if (typeof idToken !== 'string' || !idToken || idToken.length > 8192) {
      throw new Error('The sign-in service returned an unexpected response.');
    }
    if (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 8192) {
      throw new Error('The sign-in service returned an unexpected response.');
    }
    const jwtClaims = decodeIdTokenClaims(idToken);
    if (typeof data.tenantId === 'string' && jwtClaims.tenant && data.tenantId !== jwtClaims.tenant) {
      throw authError('TENANT_MISMATCH', 'Sign-in response tenant did not match FrostByte.');
    }
    const resolvedTenant = typeof data.tenantId === 'string' ? data.tenantId : jwtClaims.tenant;
    // Fail closed: when a FrostByte tenant is configured, a session minted for
    // any other tenant (or the root pool) must never be accepted. Google's
    // VerifyCustomTokenResponse omits top-level data.tenantId and places the
    // authoritative tenant claim inside idToken.firebase.tenant.
    if (tenantId && resolvedTenant !== tenantId) {
      throw authError('TENANT_MISMATCH', 'Sign-in response tenant did not match FrostByte.');
    }
    const expiresIn = Number(data.expiresIn);
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 && expiresIn <= 86_400
      ? expiresIn * 1000 : 3_600_000;
    return {
      token: idToken,
      refreshToken,
      expiresAt: now() + lifetimeMs,
      uid: typeof data.localId === 'string' && data.localId ? data.localId : jwtClaims.uid,
      email: typeof data.email === 'string' && data.email ? data.email : jwtClaims.email,
      displayName: typeof data.displayName === 'string' && data.displayName ? data.displayName : jwtClaims.displayName,
      tenantId: resolvedTenant,
      registered: registered === true,
    };
  }

  return {
    /** Exchange a tenant-aware custom token produced by hubApi for a desktop session. */
    async exchangeCustomToken({ customToken } = {}) {
      const trimmed = typeof customToken === 'string' ? customToken.trim() : '';
      if (!trimmed || trimmed.length > 8192 || !/^[A-Za-z0-9._-]{20,8192}$/.test(trimmed)) {
        throw authError('INVALID_CUSTOM_TOKEN', 'A valid sign-in custom token is required.');
      }
      const data = await post(IDENTITY_HOST, '/v1/accounts:signInWithCustomToken', {
        token: trimmed,
        returnSecureToken: true,
        ...(tenantId ? { tenantId } : {}),
      });
      return normalizeSession(data, { registered: true });
    },

    async refresh(refreshToken) {
      if (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 8192) {
        throw authError('MISSING_REFRESH_TOKEN', 'Your session expired. Sign in again.');
      }
      // NOTE: securetoken does not accept a tenantId request field — the tenant
      // is cryptographically bound inside the refresh token and preserved on
      // the minted id_token. The request body stays unchanged.
      const data = await post(SECURE_TOKEN_HOST, '/v1/token', {
        grant_type: 'refresh_token', refresh_token: refreshToken,
      });
      // securetoken uses snake_case and omits email/displayName.
      const idToken = data.id_token;
      const nextRefresh = data.refresh_token;
      if (typeof idToken !== 'string' || !idToken || typeof nextRefresh !== 'string' || !nextRefresh) {
        throw authError('INVALID_REFRESH_TOKEN', 'Your session expired. Sign in again.');
      }
      const expiresIn = Number(data.expires_in);
      const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 && expiresIn <= 86_400
        ? expiresIn * 1000 : 3_600_000;
      const jwtClaims = decodeIdTokenClaims(idToken);
      if (typeof data.tenant_id === 'string' && jwtClaims.tenant && data.tenant_id !== jwtClaims.tenant) {
        throw authError('TENANT_MISMATCH', 'This session belongs to a different FrostByte sign-in. Sign in again.');
      }
      const responseTenant = typeof data.tenant_id === 'string' ? data.tenant_id : jwtClaims.tenant;
      const isStructuredJwt = idToken.split('.').length === 3;
      // Fail closed (review F2, defense in depth): when a FrostByte tenant is
      // configured, any real 3-segment JWT (including a root-pool token that
      // omits both `data.tenant_id` and `firebase.tenant`) or any response that
      // names a tenant must match `tenantId`.
      if (tenantId && (isStructuredJwt || typeof data.tenant_id === 'string' || jwtClaims.tenant) && responseTenant !== tenantId) {
        throw authError('TENANT_MISMATCH', 'This session belongs to a different FrostByte sign-in. Sign in again.');
      }
      return {
        token: idToken,
        refreshToken: nextRefresh,
        expiresAt: now() + lifetimeMs,
        uid: typeof data.user_id === 'string' && data.user_id ? data.user_id : jwtClaims.uid,
        email: jwtClaims.email,
        displayName: jwtClaims.displayName,
        tenantId: responseTenant,
        registered: true,
      };
    },
  };
}