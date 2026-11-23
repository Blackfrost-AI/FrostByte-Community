import test from 'node:test';
import assert from 'node:assert/strict';

import { harness, PROVIDER_FIXTURES } from './harness.js';
import { generateApiKey } from '../src/auth.js';

const routes = {
  'huggingface.co': PROVIDER_FIXTURES.huggingface,
  'localmaxxing.com': PROVIDER_FIXTURES.localmaxxing,
  'pirateface.co': PROVIDER_FIXTURES.pirateface,
};

test('health is public and reports the store kind', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/health', auth: false });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'blackfrost-hub-api');
  assert.equal(body.store, 'memory');
});

test('health sets no-store cache headers', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/health', auth: false });
  assert.equal(res.getHeader('cache-control'), 'no-store');
  assert.equal(res.getHeader('x-content-type-options'), 'nosniff');
});

test('discovery without a credential is 401', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/discovery/models?q=qwen', auth: false });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'unauthenticated');
});

test('discovery with a garbage token is 401', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/discovery/models', token: 'garbage' });
  assert.equal(res.statusCode, 401);
});

test('discovery with an expired token is 401', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/discovery/models', token: 'expired-token' });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error.message, /expired/i);
});

test('free tier discovery returns huggingface results only', async () => {
  const { request } = await harness({ tier: 'free', routes });
  const res = await request({ url: '/v1/discovery/models?q=qwen' });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.tier, 'free');
  assert.equal(body.items.every((item) => item.provider === 'huggingface'), true);
});

test('pro tier discovery returns all providers', async () => {
  const { request } = await harness({ tier: 'pro', routes });
  const res = await request({ url: '/v1/discovery/models?q=qwen' });

  const body = res.json();
  assert.equal(body.providers.filter((report) => report.status === 'ok').length, 3);
  assert.equal(new Set(body.items.map((item) => item.provider)).size, 3);
});

test('discovery response carries no upstream secret or raw body', async () => {
  const { request } = await harness({ tier: 'pro', routes });
  const res = await request({ url: '/v1/discovery/models?q=qwen' });
  const text = res.body;

  assert.equal(text.includes('HF_TOKEN'), false);
  assert.equal(text.includes('Bearer'), false);
});

test('an anonymous profile read is 401', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/me', auth: false });
  assert.equal(res.statusCode, 401);
});

test('GET /v1/me returns the profile and entitlement', async () => {
  const { request } = await harness({ tier: 'plus' });
  const res = await request({ url: '/v1/me' });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.uid, 'user_123');
  assert.equal(body.entitlement.tier, 'plus');
  assert.equal(body.entitlement.capabilities.follows, true);
});

test('GET /v1/me never leaks billing identifiers', async () => {
  const { request } = await harness({ tier: 'pro' });
  const res = await request({ url: '/v1/me' });

  assert.equal(res.body.includes('cus_test'), false);
  assert.equal(res.body.includes('sub_test'), false);
});

test('PATCH /v1/me updates a client-writable field', async () => {
  const { request, store } = await harness();
  const res = await request({
    method: 'PATCH',
    url: '/v1/me',
    body: { displayName: 'New Name' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal((await store.getUser('user_123')).displayName, 'New Name');
});

test('PATCH /v1/me rejects a client write to tier', async () => {
  const { request, store } = await harness();
  const res = await request({
    method: 'PATCH',
    url: '/v1/me',
    body: { tier: 'pro' },
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /not client-writable/);
  assert.equal((await store.getUser('user_123')).tier, undefined);
});

test('PATCH /v1/me rejects every server-owned field', async () => {
  for (const field of ['subscription', 'stripeCustomerId', 'roles', 'disabled', 'entitlementVersion']) {
    const { request } = await harness();
    const res = await request({ method: 'PATCH', url: '/v1/me', body: { [field]: 'x' } });
    assert.equal(res.statusCode, 400, `expected 400 for ${field}`);
  }
});

test('PATCH /v1/me rejects an oversized display name', async () => {
  const { request } = await harness();
  const res = await request({ method: 'PATCH', url: '/v1/me', body: { displayName: 'x'.repeat(500) } });
  assert.equal(res.statusCode, 400);
});

test('PATCH /v1/me rejects an empty patch', async () => {
  const { request } = await harness();
  const res = await request({ method: 'PATCH', url: '/v1/me', body: {} });
  assert.equal(res.statusCode, 400);
});

test('PATCH /v1/me rejects non-object preferences', async () => {
  const { request } = await harness();
  const res = await request({ method: 'PATCH', url: '/v1/me', body: { preferences: ['a'] } });
  assert.equal(res.statusCode, 400);
});

test('PATCH /v1/me writes an audit entry', async () => {
  const { request, store } = await harness();
  await request({ method: 'PATCH', url: '/v1/me', body: { displayName: 'Audited' } });

  const audit = await store.listAudit();
  assert.equal(audit.some((entry) => entry.action === 'user.update'), true);
});

test('GET /v1/me/entitlement returns capabilities without billing ids', async () => {
  const { request } = await harness({ tier: 'pro' });
  const res = await request({ url: '/v1/me/entitlement' });

  const body = res.json();
  assert.equal(body.tier, 'pro');
  assert.equal(body.capabilities.orgs, true);
  assert.equal(res.body.includes('cus_test'), false);
});

test('GET /v1/me/usage reports counters', async () => {
  const { request } = await harness({ tier: 'plus', routes });
  await request({ url: '/v1/discovery/models?q=qwen' });
  const res = await request({ url: '/v1/me/usage' });

  const body = res.json();
  assert.equal(body.tier, 'plus');
  assert.equal(body.discovery >= 1, true);
});

test('free tier cannot create an API key', async () => {
  const { request } = await harness({ tier: 'free' });
  const res = await request({ method: 'POST', url: '/v1/api-keys', body: { label: 'x' } });

  assert.equal(res.statusCode, 403);
  assert.match(res.json().error.message, /Plus or Pro/);
});

test('plus tier can create an API key and gets the plaintext once', async () => {
  const { request } = await harness({ tier: 'plus' });
  const res = await request({ method: 'POST', url: '/v1/api-keys', body: { label: 'ci' } });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.key, /^bfk_[a-z0-9]{8}_[A-Za-z0-9_-]{32,}$/);
  assert.equal(body.label, 'ci');
});

test('a created API key authenticates a later request', async () => {
  const { request } = await harness({ tier: 'plus', routes });
  const created = await request({ method: 'POST', url: '/v1/api-keys', body: { label: 'ci' } });
  const key = created.json().key;

  const res = await request({ url: '/v1/me', token: key, headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().entitlement.tier, 'plus');
});

test('API key listing never returns the plaintext or the hash', async () => {
  const { request } = await harness({ tier: 'plus' });
  await request({ method: 'POST', url: '/v1/api-keys', body: { label: 'ci' } });
  const res = await request({ url: '/v1/api-keys' });

  const body = res.json();
  assert.equal(body.keys.length, 1);
  assert.equal(res.body.includes('bfk_'), false);
  assert.equal(body.keys[0].keyHash, undefined);
});

test('a revoked API key stops working', async () => {
  const { request } = await harness({ tier: 'plus', routes });
  const created = await request({ method: 'POST', url: '/v1/api-keys', body: { label: 'ci' } });
  const { key, prefix } = created.json();

  const revoked = await request({ method: 'DELETE', url: `/v1/api-keys/${prefix}` });
  assert.equal(revoked.statusCode, 200);

  const res = await request({ url: '/v1/me', headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.statusCode, 401);
});

test('the API key limit is enforced', async () => {
  const { request } = await harness({ tier: 'plus' });
  const limit = (await request({ url: '/v1/api-keys' })).json().limit;

  for (let index = 0; index < limit; index += 1) {
    const res = await request({ method: 'POST', url: '/v1/api-keys', body: { label: `k${index}` } });
    assert.equal(res.statusCode, 200);
  }

  const over = await request({ method: 'POST', url: '/v1/api-keys', body: { label: 'over' } });
  assert.equal(over.statusCode, 409);
});

test('unknown routes are 404 with the standard error shape', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/nope' });

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'not_found');
});

test('a wrong method is 405 with an Allow header', async () => {
  const { request } = await harness();
  const res = await request({ method: 'DELETE', url: '/v1/health', auth: false });

  assert.equal(res.statusCode, 405);
  assert.equal(res.getHeader('allow'), 'GET');
});

test('trailing slashes still route', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/health/', auth: false });
  assert.equal(res.statusCode, 200);
});

test('a rate limit produces 429 with Retry-After', async () => {
  const { request } = await harness({ tier: 'free', routes });
  let limited = null;
  for (let index = 0; index < 30; index += 1) {
    const res = await request({ url: '/v1/discovery/models?q=qwen' });
    if (res.statusCode === 429) {
      limited = res;
      break;
    }
  }

  assert.ok(limited, 'expected a 429 within 30 requests');
  assert.equal(limited.json().error.code, 'rate_limited');
  assert.ok(Number(limited.getHeader('retry-after')) > 0);
});

test('an unhandled error returns 500 with a correlation id and no internals', async () => {
  const { request, store } = await harness();
  store.getUser = async () => {
    throw new Error('firestore exploded at /secret/path');
  };

  const res = await request({ url: '/v1/me' });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, 'internal');
  assert.equal(res.body.includes('/secret/path'), false);
  assert.ok(res.getHeader('x-correlation-id'));
});

// --- First-login provisioning -------------------------------------------------
// A freshly created Firebase account has no Firestore user document. The first
// authenticated /v1/me must provision a free profile rather than 404, or new
// accounts can never sign in to the Hub.

test('GET /v1/me provisions a free profile for a brand-new Firebase account', async () => {
  const { request, store, uid } = await harness();
  await store.deleteUser(uid); // simulate a just-created Firebase identity

  const res = await request({ url: '/v1/me' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.uid, uid);
  assert.equal(body.entitlement.tier, 'free');
  assert.equal(body.email, 'user@example.com');

  const stored = await store.getUser(uid);
  assert.ok(stored, 'profile should now exist');
  assert.equal(stored.tier, 'free');
  assert.equal(stored.disabled, false);
  assert.ok(stored.createdAt);
});

test('provisioning is idempotent and never escalates an existing tier', async () => {
  const { request, store, uid } = await harness({ tier: 'pro' });
  const before = await store.getUser(uid);

  const res = await request({ url: '/v1/me' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().entitlement.tier, 'pro');

  const after = await store.getUser(uid);
  assert.equal(after.tier, before.tier);
  assert.equal(after.createdAt, before.createdAt);
});

test('PATCH /v1/me provisions then updates a brand-new account', async () => {
  const { request, store, uid } = await harness();
  await store.deleteUser(uid);

  const res = await request({ method: 'PATCH', url: '/v1/me', body: { displayName: 'New User' } });
  assert.equal(res.statusCode, 200);

  const stored = await store.getUser(uid);
  assert.ok(stored);
  assert.equal(stored.displayName, 'New User');
  assert.equal(stored.tier, 'free');
});

test('an API key whose user is missing is rejected, never provisioned', async () => {
  const { request, store } = await harness();
  const key = generateApiKey({ now: () => Date.parse('2026-10-18T12:00:00.000Z') });
  await store.setApiKey(key.keyHash, {
    uid: 'ghost_user',
    prefix: key.prefix,
    createdAt: key.createdAt,
  });
  // No user document exists for ghost_user.

  const res = await request({ url: '/v1/me', token: key.plaintext });
  assert.equal(res.statusCode, 401);
  assert.equal(await store.getUser('ghost_user'), null);
});

test('concurrent first-login requests provision exactly one profile', async () => {
  const { request, store, uid } = await harness();
  await store.deleteUser(uid); // brand-new Firebase identity, no document yet

  // Fire many overlapping authenticated requests, as a real client does on
  // boot (me + entitlement + usage + dashboard). The get-then-set race would
  // let several provision and clobber each other's createdAt.
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => request({ url: '/v1/me' })),
  );
  for (const res of responses) {
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().entitlement.tier, 'free');
  }
  const stamps = new Set(responses.map((res) => res.json().createdAt));
  assert.equal(stamps.size, 1, 'every response must reflect the one provisioned record');

  const stored = await store.getUser(uid);
  assert.ok(stored);
  assert.equal(stored.tier, 'free');
});

test('createUserIfAbsent never overwrites an existing record', async () => {
  const { store, uid } = await harness({ tier: 'pro' });
  const before = await store.getUser(uid);

  const result = await store.createUserIfAbsent(uid, {
    uid,
    tier: 'free',
    email: 'attacker@example.com',
    createdAt: '1999-01-01T00:00:00.000Z',
  });
  assert.equal(result.created, false);
  assert.equal(result.user.tier, before.tier);

  const after = await store.getUser(uid);
  assert.equal(after.tier, before.tier);
  assert.equal(after.email, before.email);
  assert.equal(after.createdAt, before.createdAt);
});

test('createUserIfAbsent inserts once and reports created only the first time', async () => {
  const { store } = await harness();
  const uid = 'fresh_concurrent_user';
  const record = { uid, tier: 'free', email: 'fresh@example.com', createdAt: '2026-11-13T00:00:00.000Z' };

  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.createUserIfAbsent(uid, record)),
  );
  assert.equal(results.filter((r) => r.created).length, 1, 'exactly one creation wins');
  for (const r of results) {
    assert.equal(r.user.uid, uid);
    assert.equal(r.user.email, 'fresh@example.com');
  }
});