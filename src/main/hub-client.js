/**
 * Hub API client — bounded, testable, no Electron imports.
 * Mirrors hf.js pattern: pure fetcher injected, timeouts, size caps, ETag.
 * Auth: Bearer JWT (optional for public reads). No HF token here.
 *
 * The production Hub API base is pinned. User-supplied Hub URLs, loopback Hubs
 * and plain HTTP are never contacted; a bearer is only attached to the pinned
 * HTTPS Cloud Function.
 */
import { normalizeSearchQuery, clampLimit, PAGINATION } from '../shared/hub-protocol.js';
import { HUB_API_BASE, validateHubBaseUrl, bearerAllowed } from './hub-security.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function hubOrigin(value) {
  return validateHubBaseUrl(value);
}

/**
 * Read a response body with a hard byte ceiling, streaming so a hostile Hub cannot
 * buffer an arbitrarily large payload before rejection. Falls back to .text() for
 * stub responses with no body stream (tests); the byte cap still applies.
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
        if (total > maxBytes) throw new Error('Hub returned an oversized response.');
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
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Hub returned an oversized response.');
  return text;
}

export function createHubClient({ hubUrl = HUB_API_BASE, token, fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  const origin = hubOrigin(hubUrl || HUB_API_BASE);
  let currentToken = token || '';

  async function request(pathname, { method = 'GET', query, body, etag, bearer, timeoutOverrideMs } = {}) {
    if (!origin) throw new Error('FrostByte Hub is not configured correctly.');
    const url = new URL(origin + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    if (url.href.length > PAGINATION.MAX_URL_LENGTH) throw new Error('Hub request URL too long.');
    const headers = { Accept: 'application/json' };
    const effectiveBearer = bearer ?? currentToken;
    if (effectiveBearer) {
      if (!bearerAllowed(origin)) throw new Error('Refusing to send a Hub token over plain HTTP to a remote host.');
      headers.Authorization = 'Bearer ' + effectiveBearer;
    }
    if (etag) headers['If-None-Match'] = etag;
    if (body) headers['Content-Type'] = 'application/json';

    const signal = AbortSignal.timeout(timeoutOverrideMs || timeoutMs);
    const response = await fetcher(url.href, {
      method, headers, signal, redirect: 'error', credentials: 'omit',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 304) return { status: 304, etag: response.headers.get('etag') || etag || '', data: null };
    if (response.status === 404) return null;

    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);

    let data;
    try { data = text ? JSON.parse(text) : null; } catch { throw Object.assign(new Error('Hub returned invalid JSON.'), { status: response.status }); }

    if (!response.ok) {
      throw Object.assign(new Error(data?.error?.message || `Hub returned ${response.status}.`), {
        status: response.status,
        code: data?.error?.code || 'hub_error',
      });
    }
    return { status: response.status, etag: response.headers.get('etag') || '', data, fetchedAt: now() };
  }

  return {
    get origin() { return origin; },
    get configured() { return Boolean(origin); },
    setToken(next) { currentToken = String(next || ''); },
    getToken() { return currentToken; },

    health() {
      // Public liveness probe — /v1/health is deployed; no bearer, no user input.
      return request('/v1/health', { bearer: '' });
    },

    me({ bearer } = {}) {
      return request('/v1/me', { bearer });
    },

    // ---- Account management (ADR 003) -------------------------------------
    // All mutations ride the session bearer; field validation lives in the
    // main-process IPC layer (shared/identity-rules.js) and on the server.

    updateMe(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('A profile patch object is required.');
      return request('/v1/me', { method: 'PATCH', body: patch });
    },

    setHandle(handle) {
      if (typeof handle !== 'string' || !handle.trim()) throw new Error('A handle is required.');
      return request('/v1/me/handle', { method: 'POST', body: { handle } });
    },

    releaseHandle() {
      return request('/v1/me/handle', { method: 'DELETE' });
    },

    publisherKeys() {
      return request('/v1/me/publisher-keys');
    },

    publisherChallenge(pubKey) {
      if (!/^[a-f0-9]{64}$/.test(pubKey || '')) throw new Error('Invalid publisher pubkey.');
      return request('/v1/me/publisher-key/challenge', { method: 'POST', body: { pubKey } });
    },

    bindPublisherKey({ pubKey, challengeId, signature } = {}) {
      if (!/^[a-f0-9]{64}$/.test(pubKey || '')) throw new Error('Invalid publisher pubkey.');
      if (typeof challengeId !== 'string' || !challengeId) throw new Error('A challenge id is required.');
      if (!/^[a-f0-9]{128}$/.test(signature || '')) throw new Error('Invalid signature.');
      return request('/v1/me/publisher-key', { method: 'POST', body: { pubKey, challengeId, signature } });
    },

    unbindPublisherKey(pubKey) {
      if (!/^[a-f0-9]{64}$/.test(pubKey || '')) throw new Error('Invalid publisher pubkey.');
      return request('/v1/me/publisher-key/' + pubKey, { method: 'DELETE' });
    },

    creatorByHandle(handle) {
      if (typeof handle !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(handle)) throw new Error('Invalid creator handle.');
      return request('/v1/creators/by-handle/' + encodeURIComponent(handle));
    },

    entitlement({ bearer } = {}) {
      return request('/v1/me/entitlement', { bearer });
    },

    search({ q, kind, task, format, quant, publisher, cursor, limit } = {}) {
      const query = {};
      if (q != null) query.q = normalizeSearchQuery(String(q));
      if (kind) query.kind = String(kind).slice(0, 64);
      if (task) query.task = String(task).slice(0, 64);
      if (format) query.format = String(format).slice(0, 64);
      if (quant) query.quant = String(quant).slice(0, 64);
      if (publisher) query.publisher = String(publisher).slice(0, 128);
      if (cursor) query.cursor = String(cursor).slice(0, 4096);
      if (limit != null) query.limit = String(clampLimit(limit));
      return request('/v1/search', { query });
    },

    recipe(id, { etag, bearer } = {}) {
      if (!id || typeof id !== 'string') throw new Error('A recipe id is required.');
      return request('/v1/recipes/' + encodeURIComponent(id), { etag, bearer });
    },

    recipeManifest(id, { etag, bearer } = {}) {
      if (!id || typeof id !== 'string') throw new Error('A recipe id is required.');
      return request('/v1/recipes/' + encodeURIComponent(id) + '/manifest', { etag, bearer });
    },

    manifestByDigest(digest, { etag, bearer } = {}) {
      if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid manifest digest.');
      return request('/v1/manifests/' + digest, { etag, bearer });
    },

    publishRecipe({ manifest, digest, terms, signature } = {}) {
      if (!manifest || typeof manifest !== 'object') throw new Error('A manifest is required.');
      if (digest && !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid digest.');
      return request('/v1/recipes', { method: 'POST', body: { manifest, digest, terms, signature } });
    },

    withdrawRecipe(id) {
      if (!/^[a-z0-9-]{1,64}$/.test(id || '')) throw new Error('Invalid recipe id.');
      return request('/v1/recipes/' + id, { method: 'DELETE' });
    },

    creator(pubkey, { etag } = {}) {
      if (!/^[a-f0-9]{64}$/.test(pubkey || '')) throw new Error('Invalid creator pubkey.');
      return request('/v1/creators/' + pubkey, { etag });
    },

    follow(pubkey) {
      if (!/^[a-f0-9]{64}$/.test(pubkey || '')) throw new Error('Invalid creator pubkey.');
      return request('/v1/follows/' + pubkey, { method: 'POST' });
    },

    unfollow(pubkey) {
      if (!/^[a-f0-9]{64}$/.test(pubkey || '')) throw new Error('Invalid creator pubkey.');
      return request('/v1/follows/' + pubkey, { method: 'DELETE' });
    },

    updates({ since, cursor, limit } = {}) {
      const query = {};
      if (since) query.since = String(since).slice(0, 64);
      if (cursor) query.cursor = String(cursor).slice(0, 4096);
      if (limit != null) query.limit = String(clampLimit(limit));
      return request('/v1/updates', { query });
    },

    // ---- Community home plane (P3) ----------------------------------------
    // Anonymous-readable; `following=1` rides the session bearer and the
    // server refuses API keys. Bodies are plain text — render as text only.

    feed({ limit, cursor, following } = {}) {
      const query = {};
      // Feed max is 50 (below search's 100 — bounds creator-join reads).
      if (limit != null) query.limit = String(Math.min(50, clampLimit(limit)));
      if (cursor) query.cursor = String(cursor).slice(0, 4096);
      if (following) query.following = '1';
      return request('/v1/feed', { query });
    },

    announcements({ limit } = {}) {
      const query = {};
      if (limit != null) query.limit = String(Math.min(50, clampLimit(limit)));
      return request('/v1/announcements', { query });
    },

    meFollows() {
      return request('/v1/me/follows');
    },

    bundleLatest({ etag } = {}) {
      return request('/v1/bundle/latest', { etag });
    },

    bundleSegment(digest, { etag } = {}) {
      if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid bundle digest.');
      return request('/v1/bundle/' + digest, { etag });
    },

    changes({ cursor, limit, etag } = {}) {
      const query = {};
      if (cursor) query.cursor = String(cursor).slice(0, 4096);
      if (limit != null) query.limit = String(clampLimit(limit));
      return request('/v1/changes', { query, etag });
    },

    desktopExchange({ code, state, codeVerifier }) {
      return request('/v1/auth/desktop/exchange', {
        method: 'POST',
        body: { code, state, codeVerifier },
      });
    },

    desktopRevoke({ sessionId, bearer }) {
      return request('/v1/auth/desktop/revoke', {
        method: 'POST',
        bearer,
        body: { sessionId },
        timeoutOverrideMs: 4_000,
      });
    },
  };
}

export { hubOrigin, DEFAULT_TIMEOUT_MS };
