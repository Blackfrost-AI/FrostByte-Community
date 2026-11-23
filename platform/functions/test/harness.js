/**
 * Test harness.
 *
 * Drives the real handler over a fake request/response pair with a memory store
 * and injected fetchers. No network, no emulator, no Admin SDK.
 */

import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/store/memory.js';

// Cursors are HMAC-signed with this key. The suite supplies its own rather than
// reading Secret Manager.
process.env.HUB_CURSOR_SECRET ||= 'test-cursor-secret-value-at-least-32-chars-long';

export const FIXED_NOW = Date.parse('2026-10-18T12:00:00.000Z');

/** Hermetic tenant for tests that exercise tenant isolation. */
export const TEST_TENANT_ID = 'test-tenant';

/** Build a request-shaped object the handler can consume. */
export function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const stream = Readable.from(raw === '' ? [] : [Buffer.from(raw, 'utf8')]);
  stream.method = method.toUpperCase();
  stream.url = url;
  stream.headers = { ...headers };
  return stream;
}

/** Build a response recorder. */
export function makeResponse() {
  const headers = {};
  return {
    statusCode: 200,
    writableEnded: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    getHeaders() {
      return { ...headers };
    },
    end(chunk) {
      this.writableEnded = true;
      this.body = chunk === undefined ? '' : String(chunk);
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
}

/** Deterministic fake fetcher: `routes` maps a URL substring to a payload. */
export function fakeFetcher(routes) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    for (const [needle, handler] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        const resolved = typeof handler === 'function' ? await handler(String(url)) : handler;
        if (resolved instanceof Error) throw resolved;
        if (resolved && typeof resolved === 'object' && 'status' in resolved && 'body' in resolved) {
          return {
            status: resolved.status,
            text: async () => (typeof resolved.body === 'string' ? resolved.body : JSON.stringify(resolved.body)),
          };
        }
        return { status: 200, text: async () => JSON.stringify(resolved) };
      }
    }
    throw new Error(`No fake route for ${url}`);
  };
  fetcher.calls = calls;
  return fetcher;
}

/** Minimal user + subscription fixtures. */
export function userFixture(overrides = {}) {
  return {
    uid: 'user_123',
    email: 'user@example.com',
    displayName: 'Test User',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function subscriptionFixture(tier, overrides = {}) {
  return {
    provider: 'stripe',
    providerSubscriptionId: 'sub_test',
    providerCustomerId: 'cus_test',
    tier,
    status: 'active',
    currentPeriodEnd: new Date(FIXED_NOW + 20 * 24 * 60 * 60 * 1000).toISOString(),
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

/**
 * Build a full app + store harness.
 *
 * @param {object} [options]
 * @param {string} [options.tier]        Seed the caller with this tier.
 * @param {object} [options.routes]      Fake upstream routes.
 * @param {object} [options.appOptions]  Extra createApp options.
 */
export async function harness({ tier, routes = {}, appOptions = {}, uid = 'user_123', tenantId = '' } = {}) {
  const store = createMemoryStore({ now: () => FIXED_NOW });
  await store.setUser(uid, userFixture({ uid, ...(tenantId ? { tenantId } : {}) }));
  if (tier && tier !== 'free') {
    await store.setSubscription(uid, subscriptionFixture(tier));
  }

  const fetcher = fakeFetcher(routes);

  // Token variants. With tenantId configured, the normal token carries the
  // tenant claim; the root-pool token deliberately does not. auth_time is
  // Unix SECONDS (not ms) — fresh enough for admin step-up by default.
  const authTimeSec = Math.floor(FIXED_NOW / 1000) - 300;
  const tenantClaim = tenantId ? { firebase: { tenant: tenantId, sign_in_provider: 'password' } } : {};
  const adminClaims = { frostbyteAdmin: true, email_verified: true };

  const app = createApp({
    store,
    fetcher,
    now: () => FIXED_NOW,
    tenantId,
    verifyIdToken: async (token) => {
      if (token === 'valid-token') {
        return { uid, email: 'user@example.com', email_verified: true, auth_time: authTimeSec, ...tenantClaim };
      }
      if (token === 'admin-token') {
        return { uid, email: 'admin@example.com', auth_time: authTimeSec, ...adminClaims, ...tenantClaim };
      }
      if (token === 'admin-token-stale') {
        return { uid, email: 'admin@example.com', auth_time: authTimeSec - 7200, ...adminClaims, ...tenantClaim };
      }
      if (token === 'admin-token-unverified') {
        return { uid, email: 'admin@example.com', auth_time: authTimeSec, frostbyteAdmin: true, email_verified: false, ...tenantClaim };
      }
      if (token === 'root-pool-token') {
        // Blackfrost AI root pool: no tenant claim at all.
        return { uid, email: 'user@example.com', email_verified: true, auth_time: authTimeSec };
      }
      if (token === 'other-tenant-token') {
        return { uid, email: 'user@example.com', email_verified: true, auth_time: authTimeSec, firebase: { tenant: 'other-tenant', sign_in_provider: 'password' } };
      }
      if (token === 'expired-token') {
        const error = new Error('expired');
        error.code = 'auth/id-token-expired';
        throw error;
      }
      const error = new Error('invalid');
      error.code = 'auth/argument-error';
      throw error;
    },
    ...appOptions,
  });

  async function request(options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.auth !== false && !headers.authorization) {
      headers.authorization = `Bearer ${options.token || 'valid-token'}`;
    }
    const req = makeRequest({ ...options, headers });
    const res = makeResponse();
    await app(req, res);
    return res;
  }

  return { store, fetcher, app, request, uid };
}

/** Fixture payloads matching the real provider envelopes verified 2026-10-18. */
export const PROVIDER_FIXTURES = Object.freeze({
  huggingface: [
    {
      _id: '680da718233834890aa01f51',
      id: 'Qwen/Qwen3-0.6B',
      likes: 1826,
      private: false,
      downloads: 30073785,
      tags: ['transformers', 'safetensors', 'text-generation', 'apache-2.0'],
      pipeline_tag: 'text-generation',
      library_name: 'transformers',
      createdAt: '2025-04-27T03:40:08.000Z',
      lastModified: '2025-09-01T00:00:00.000Z',
      modelId: 'Qwen/Qwen3-0.6B',
    },
  ],
  localmaxxing: [
    {
      id: 'cmvcupgtg080ole01snwmaifd',
      hfId: 'Feyd89/Qwen3.8-Flash-Next-NVFP4-capy-flash',
      displayName: 'Qwen3.8-Flash-Next-NVFP4-capy-flash',
      organization: 'Feyd89',
      family: 'Qwen',
      params: 180,
      activeParams: null,
      isMoE: true,
      tags: '["ninfer","capy-flash","nvfp4"]',
      pipelineTag: 'text-generation',
      _count: { benchmarkRuns: 1 },
      baseModel: { id: 'cmtoe6f13008pnz014ujje1r9', hfId: 'nvidia/Qwen3.8-Flash-Next-NVFP4' },
      speedStats: { maxTokS: 170.7, minTokS: 170.7, medianTokS: 170.7, total: 1 },
      evalScore: null,
    },
  ],
  pirateface: {
    models: [
      {
        id: 'Qwen/Qwen3.8-27B',
        author: 'Qwen',
        name: 'Qwen3.8-27B',
        task: 'image-text-to-text',
        license: 'apache-2.0',
        params: 27781427952,
        paramLabel: '27.8B',
        activeParams: 27781427952,
        activeParamLabel: '27.8B',
        sizeBytes: 55562855904,
        sizeLabel: '56 GB',
        format: 'safetensors',
        downloads: 7795543,
        likes: 17912,
        revision: '1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0',
        updatedDays: 64,
        hfBacked: true,
        seed: 32,
        leech: 2,
        seeded: true,
        origin: 'cn',
      },
    ],
    nextCursor: 'eyIkb3IiOlt7InRyZW5kaW5nU2NvcmUiOjU1fV19',
  },
});