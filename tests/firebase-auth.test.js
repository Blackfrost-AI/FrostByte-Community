import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseAuth, isDeadSessionError } from '../src/main/firebase-auth.js';

const API_KEY = 'AIzaSyDGQ6mJ9RQatE7fGPo43YSFXf9Rl1o8oAU';
const TENANT = 'frostbyte-0ji2f';
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const SAMPLE_CUSTOM_TOKEN = `${'a'.repeat(20)}.${'b'.repeat(40)}.${'c'.repeat(20)}`;

/** Stub fetcher that records calls and returns canned Response-like objects. */
function stubFetcher(handler) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    const result = await handler(url, init, calls.length);
    const status = result?.status ?? 200;
    const body = result?.body ?? {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  fetcher.calls = calls;
  return fetcher;
}

const validCustomExchange = {
  idToken: 'firebase-id-token-abc',
  refreshToken: 'firebase-refresh-token-xyz',
  expiresIn: '3600',
};

test('desktop Firebase auth exposes only exchangeCustomToken and refresh (no direct password methods)', () => {
  const auth = createFirebaseAuth({ apiKey: API_KEY, fetcher: stubFetcher(() => ({})) });
  assert.equal(typeof auth.exchangeCustomToken, 'function');
  assert.equal(typeof auth.refresh, 'function');
  assert.equal(typeof auth.signIn, 'undefined');
  assert.equal(typeof auth.signUp, 'undefined');
  assert.equal(typeof auth.requestPasswordReset, 'undefined');
});

test('exchangeCustomToken exchanges custom token and returns a normalized session', async () => {
  const fetcher = stubFetcher(() => ({ body: { ...validCustomExchange, tenantId: TENANT } }));
  const auth = createFirebaseAuth({ apiKey: API_KEY, tenantId: TENANT, fetcher, now: () => NOW });
  const session = await auth.exchangeCustomToken({ customToken: ` ${SAMPLE_CUSTOM_TOKEN} ` });

  assert.equal(session.token, 'firebase-id-token-abc');
  assert.equal(session.refreshToken, 'firebase-refresh-token-xyz');
  assert.equal(session.expiresAt, NOW + 3_600_000);
  assert.equal(session.tenantId, TENANT);

  const call = fetcher.calls[0];
  assert.equal(call.url, `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  const sent = JSON.parse(call.init.body);
  assert.deepEqual(sent, {
    token: SAMPLE_CUSTOM_TOKEN,
    returnSecureToken: true,
    tenantId: TENANT,
  });
});

test('exchangeCustomToken rejects malformed custom tokens before any network call', async () => {
  const fetcher = stubFetcher(() => ({ body: validCustomExchange }));
  const auth = createFirebaseAuth({ apiKey: API_KEY, fetcher });
  for (const bad of ['', '   ', 'short', 'has space in token..................................................', null, 42]) {
    await assert.rejects(() => auth.exchangeCustomToken({ customToken: bad }), /custom token/i);
  }
  assert.equal(fetcher.calls.length, 0);
});

test('exchangeCustomToken maps Firebase error codes to friendly messages and hides raw keys', async () => {
  const cases = [
    ['INVALID_CUSTOM_TOKEN', /invalid|expired/i],
    ['CREDENTIAL_MISMATCH', /did not match FrostByte/i],
    ['USER_DISABLED', /disabled/i],
    ['TOO_MANY_ATTEMPTS_TRY_LATER : Blocked', /too many/i],
    ['TOTALLY_UNKNOWN_CODE', /Sign-in failed/i],
  ];
  for (const [rawCode, pattern] of cases) {
    const fetcher = stubFetcher(() => ({ status: 400, body: { error: { message: rawCode } } }));
    const auth = createFirebaseAuth({ apiKey: API_KEY, fetcher });
    await assert.rejects(() => auth.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN }), (err) => {
      assert.match(err.message, pattern);
      assert.ok(!err.message.includes(API_KEY));
      return true;
    });
  }
});

test('exchangeCustomToken rejects missing tokens, oversized payloads, non-JSON, and network errors safely', async () => {
  const missingId = createFirebaseAuth({
    apiKey: API_KEY,
    fetcher: stubFetcher(() => ({ body: { refreshToken: 'r', expiresIn: '3600' } })),
  });
  await assert.rejects(() => missingId.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN }), /unexpected/i);

  const missingRefresh = createFirebaseAuth({
    apiKey: API_KEY,
    fetcher: stubFetcher(() => ({ body: { idToken: 'i', expiresIn: '3600' } })),
  });
  await assert.rejects(() => missingRefresh.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN }), /unexpected/i);

  const huge = createFirebaseAuth({
    apiKey: API_KEY,
    fetcher: stubFetcher(() => ({ body: 'x'.repeat(70_000) })),
  });
  await assert.rejects(() => huge.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN }), /unexpected/i);

  const nonJson = createFirebaseAuth({
    apiKey: API_KEY,
    fetcher: stubFetcher(() => ({ body: '<html>bad gateway</html>' })),
  });
  await assert.rejects(() => nonJson.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN }), /unexpected/i);

  const netErr = createFirebaseAuth({
    apiKey: API_KEY,
    fetcher: async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); },
  });
  await assert.rejects(() => netErr.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN }), (err) => {
    assert.match(err.message, /Could not reach the sign-in service/i);
    assert.ok(!err.message.includes(API_KEY));
    assert.ok(!err.message.includes('googleapis.com'));
    return true;
  });
});

test('expiry defaults to one hour for invalid or out-of-range values and honors valid sub-24h values', async () => {
  for (const badExpiry of ['0', '-5', '999999', 'nan', undefined]) {
    const auth = createFirebaseAuth({
      apiKey: API_KEY,
      now: () => NOW,
      fetcher: stubFetcher(() => ({ body: { ...validCustomExchange, expiresIn: badExpiry } })),
    });
    const session = await auth.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN });
    assert.equal(session.expiresAt, NOW + 3_600_000);
  }
  const auth = createFirebaseAuth({
    apiKey: API_KEY,
    now: () => NOW,
    fetcher: stubFetcher(() => ({ body: { ...validCustomExchange, expiresIn: '1800' } })),
  });
  const session = await auth.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN });
  assert.equal(session.expiresAt, NOW + 1_800_000);
});

test('tenant: exchangeCustomToken accepts Google VerifyCustomTokenResponse where tenant lives in idToken JWT claims and rejects conflicting claims', async () => {
  const mkJwt = (claims) => [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
  ].join('.');

  const realShapeBody = {
    kind: 'identitytoolkit#VerifyCustomTokenResponse',
    idToken: mkJwt({
      user_id: 'uid_real_1',
      email: 'alice@frostbyte.si',
      name: 'Alice',
      firebase: { tenant: TENANT, sign_in_provider: 'custom' },
    }),
    refreshToken: 'refresh-real-1',
    expiresIn: '3600',
    isNewUser: false,
  };
  const auth = createFirebaseAuth({
    apiKey: API_KEY,
    tenantId: TENANT,
    now: () => NOW,
    fetcher: stubFetcher(() => ({ body: realShapeBody })),
  });
  const session = await auth.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN });
  assert.equal(session.tenantId, TENANT);
  assert.equal(session.uid, 'uid_real_1');
  assert.equal(session.email, 'alice@frostbyte.si');
  assert.equal(session.displayName, 'Alice');

  const conflictingAuth = createFirebaseAuth({
    apiKey: API_KEY,
    tenantId: TENANT,
    now: () => NOW,
    fetcher: stubFetcher(() => ({ body: { ...realShapeBody, tenantId: 'other-tenant' } })),
  });
  await assert.rejects(
    conflictingAuth.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN }),
    (err) => err.code === 'TENANT_MISMATCH',
  );
});

test('tenant: exchangeCustomToken refuses mismatched or missing response tenant when stamped', async () => {
  for (const bad of [
    { ...validCustomExchange, tenantId: 'someone-else-99' },
    validCustomExchange,
  ]) {
    const fetcher = stubFetcher(() => ({ body: bad }));
    const auth = createFirebaseAuth({ apiKey: API_KEY, fetcher, tenantId: TENANT, now: () => NOW });
    await assert.rejects(
      auth.exchangeCustomToken({ customToken: SAMPLE_CUSTOM_TOKEN }),
      (err) => err.code === 'TENANT_MISMATCH' && /tenant did not match FrostByte/i.test(err.message),
    );
  }
});

test('tenant: refresh body stays grant_type+refresh_token only; session carries tenant_id', async () => {
  const fetcher = stubFetcher(() => ({
    body: { id_token: 'refreshed-id-token-2', refresh_token: 'refresh-token-2', expires_in: '3600', user_id: 'uid-1', tenant_id: TENANT },
  }));
  const auth = createFirebaseAuth({ apiKey: API_KEY, fetcher, tenantId: TENANT, now: () => NOW });
  const session = await auth.refresh('refresh-token-1');
  const body = JSON.parse(fetcher.calls[0].init.body);
  assert.deepEqual(body, { grant_type: 'refresh_token', refresh_token: 'refresh-token-1' });
  assert.equal(session.tenantId, TENANT);
});

test('tenant: refresh naming a FOREIGN or ROOT tenant (including real root-pool JWTs) is refused as a dead session', async () => {
  const rootPoolJwt = [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'uid-root', email: 'root@example.com', firebase: { sign_in_provider: 'password' } })).toString('base64url'),
    'sig',
  ].join('.');
  for (const badBody of [
    { id_token: 'foreign-id-token', refresh_token: 'foreign-refresh', expires_in: '3600', user_id: 'uid-1', tenant_id: 'someone-else-99' },
    { id_token: 'foreign-id-token', refresh_token: 'foreign-refresh', expires_in: '3600', user_id: 'uid-1', tenant_id: '' },
    { id_token: rootPoolJwt, refresh_token: 'root-refresh', expires_in: '3600', user_id: 'uid-root' },
  ]) {
    const fetcher = stubFetcher(() => ({ body: badBody }));
    const auth = createFirebaseAuth({ apiKey: API_KEY, fetcher, tenantId: TENANT, now: () => NOW });
    await assert.rejects(auth.refresh('cached-refresh'), (err) => {
      assert.equal(err.code, 'TENANT_MISMATCH');
      assert.ok(isDeadSessionError(err));
      return true;
    });
  }
});

test('isDeadSessionError distinguishes revoked/expired credentials from transient failures', () => {
  for (const code of ['TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND', 'INVALID_REFRESH_TOKEN', 'INVALID_GRANT', 'TENANT_MISMATCH']) {
    assert.equal(isDeadSessionError(Object.assign(new Error('x'), { code })), true);
  }
  for (const code of ['NETWORK_ERROR', 'TOO_MANY_ATTEMPTS_TRY_LATER', '', undefined]) {
    assert.equal(isDeadSessionError(Object.assign(new Error('x'), { code })), false);
  }
});
