import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/store/memory.js';
import {
  FIXED_NOW,
  TEST_TENANT_ID,
  makeRequest,
  makeResponse,
  userFixture,
} from './harness.js';

function makePkcePair() {
  const state = crypto.randomBytes(32).toString('base64url');
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  return { state, codeVerifier, codeChallenge };
}

function buildDesktopHarness({ tenantId = TEST_TENANT_ID, uid = 'user_123' } = {}) {
  let currentNow = FIXED_NOW;
  const mintedTokens = [];
  const store = createMemoryStore({ now: () => currentNow });
  const authTimeSec = Math.floor(FIXED_NOW / 1000) - 60;
  const tenantClaim = tenantId ? { firebase: { tenant: tenantId, sign_in_provider: 'password' } } : {};

  const app = createApp({
    store,
    now: () => currentNow,
    tenantId,
    mintDesktopCustomToken: async ({ uid: targetUid, sessionId }) => {
      mintedTokens.push({ uid: targetUid, claims: { frostbyteDesktopSession: sessionId } });
      return `custom.${targetUid}.${sessionId}`;
    },
    verifyIdToken: async (token) => {
      if (token === 'web-user-token') {
        return { uid, email: 'user@example.com', email_verified: true, auth_time: authTimeSec, ...tenantClaim };
      }
      if (token === 'other-user-token') {
        return { uid: 'user_999', email: 'other@example.com', email_verified: true, auth_time: authTimeSec, ...tenantClaim };
      }
      if (token === 'admin-token') {
        return {
          uid: 'admin_1',
          email: 'admin@example.com',
          email_verified: true,
          frostbyteAdmin: true,
          auth_time: authTimeSec,
          ...tenantClaim,
        };
      }
      if (token === 'root-pool-token') {
        return { uid, email: 'user@example.com', email_verified: true, auth_time: authTimeSec };
      }
      if (token.startsWith('desktop-id:')) {
        const [, tokenUid, sessionId] = token.split(':');
        return {
          uid: tokenUid,
          email: 'user@example.com',
          email_verified: true,
          auth_time: authTimeSec,
          frostbyteDesktopSession: sessionId,
          ...tenantClaim,
        };
      }
      const err = new Error('invalid');
      err.code = 'auth/argument-error';
      throw err;
    },
  });

  async function request({ method = 'GET', url = '/', token, auth = true, body, headers = {} } = {}) {
    const reqHeaders = { ...headers };
    if (auth !== false && !reqHeaders.authorization) {
      reqHeaders.authorization = `Bearer ${token || 'web-user-token'}`;
    }
    const req = makeRequest({ method, url, headers: reqHeaders, body });
    const res = makeResponse();
    await app(req, res);
    return res;
  }

  return {
    store,
    mintedTokens,
    request,
    advanceMs(ms) {
      currentNow += ms;
    },
  };
}

test('desktop PKCE authorize -> exchange mints tenant custom token and session, and burns code against replay', async () => {
  const h = buildDesktopHarness();
  await h.store.setUser('user_123', userFixture({ uid: 'user_123', tenantId: TEST_TENANT_ID }));
  const { state, codeVerifier, codeChallenge } = makePkcePair();

  const authRes = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/authorize',
    token: 'web-user-token',
    body: { state, codeChallenge, codeChallengeMethod: 'S256' },
  });
  assert.equal(authRes.statusCode, 200);
  const authBody = authRes.json();
  assert.equal(authBody.state, state);
  assert.equal(authBody.expiresIn, 180);
  assert.ok(authBody.redirectUri.startsWith('frostbyte://auth?'));

  const exRes = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/exchange',
    auth: false,
    body: { code: authBody.code, state, codeVerifier },
  });
  assert.equal(exRes.statusCode, 200);
  const exBody = exRes.json();
  assert.equal(exBody.tenantId, TEST_TENANT_ID);
  assert.match(exBody.sessionId, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(exBody.customToken, `custom.user_123.${exBody.sessionId}`);
  assert.equal(h.mintedTokens.length, 1);
  assert.deepEqual(h.mintedTokens[0], {
    uid: 'user_123',
    claims: { frostbyteDesktopSession: exBody.sessionId },
  });

  // Replaying the same one-time code fails immediately with 401.
  const replayRes = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/exchange',
    auth: false,
    body: { code: authBody.code, state, codeVerifier },
  });
  assert.equal(replayRes.statusCode, 401);
});

test('desktop PKCE burns code on wrong verifier or state and rejects expired codes or root-pool callers', async () => {
  const h = buildDesktopHarness();
  await h.store.setUser('user_123', userFixture({ uid: 'user_123', tenantId: TEST_TENANT_ID }));

  // Root-pool token cannot authorize desktop handoff.
  const p0 = makePkcePair();
  const rootRes = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/authorize',
    token: 'root-pool-token',
    body: { state: p0.state, codeChallenge: p0.codeChallenge, codeChallengeMethod: 'S256' },
  });
  assert.equal(rootRes.statusCode, 401);

  // Wrong codeVerifier burns the code on first touch.
  const p1 = makePkcePair();
  const a1 = (await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/authorize',
    body: { state: p1.state, codeChallenge: p1.codeChallenge, codeChallengeMethod: 'S256' },
  })).json();
  const badVerify = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/exchange',
    auth: false,
    body: { code: a1.code, state: p1.state, codeVerifier: makePkcePair().codeVerifier },
  });
  assert.equal(badVerify.statusCode, 401);

  const retryWithGoodVerifier = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/exchange',
    auth: false,
    body: { code: a1.code, state: p1.state, codeVerifier: p1.codeVerifier },
  });
  assert.equal(retryWithGoodVerifier.statusCode, 401);

  // Expired code fails after 180s TTL.
  const p2 = makePkcePair();
  const a2 = (await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/authorize',
    body: { state: p2.state, codeChallenge: p2.codeChallenge, codeChallengeMethod: 'S256' },
  })).json();
  h.advanceMs(181_000);
  const expiredRes = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/exchange',
    auth: false,
    body: { code: a2.code, state: p2.state, codeVerifier: p2.codeVerifier },
  });
  assert.equal(expiredRes.statusCode, 401);
});

test('desktop session revocation invalidates Bearer ID tokens carrying frostbyteDesktopSession immediately', async () => {
  const h = buildDesktopHarness();
  await h.store.setUser('user_123', userFixture({ uid: 'user_123', tenantId: TEST_TENANT_ID }));
  await h.store.setUser('user_999', userFixture({ uid: 'user_999', email: 'other@example.com', tenantId: TEST_TENANT_ID }));
  await h.store.setUser('admin_1', userFixture({ uid: 'admin_1', email: 'admin@example.com', tenantId: TEST_TENANT_ID }));

  const { state, codeVerifier, codeChallenge } = makePkcePair();
  const authBody = (await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/authorize',
    body: { state, codeChallenge, codeChallengeMethod: 'S256' },
  })).json();
  const { sessionId } = (await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/exchange',
    auth: false,
    body: { code: authBody.code, state, codeVerifier },
  })).json();

  const desktopBearer = `desktop-id:user_123:${sessionId}`;

  // Active desktop session succeeds on /v1/me.
  const meBefore = await h.request({ method: 'GET', url: '/v1/me', token: desktopBearer });
  assert.equal(meBefore.statusCode, 200);

  // Another user cannot revoke user_123's desktop session (no oracle: returns revoked:false and session stays active).
  const crossUserRevoke = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/revoke',
    token: 'other-user-token',
    body: { sessionId },
  });
  assert.equal(crossUserRevoke.statusCode, 200);
  assert.equal(crossUserRevoke.json().revoked, false);
  assert.equal((await h.request({ method: 'GET', url: '/v1/me', token: desktopBearer })).statusCode, 200);

  // Owner revokes their desktop session.
  const revokeRes = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/revoke',
    token: desktopBearer,
    body: { sessionId },
  });
  assert.equal(revokeRes.statusCode, 200);

  // Even a non-expired ID token carrying that desktop session claim is now rejected immediately.
  const meAfter = await h.request({ method: 'GET', url: '/v1/me', token: desktopBearer });
  assert.equal(meAfter.statusCode, 401);

  // Web session without frostbyteDesktopSession remains unaffected.
  const webMe = await h.request({ method: 'GET', url: '/v1/me', token: 'web-user-token' });
  assert.equal(webMe.statusCode, 200);
});

test('desktop exchange rate limit keys on rightmost X-Forwarded-For hop and defeats spoofed leading XFF rotation', async () => {
  const h = buildDesktopHarness();
  const realClientIp = '203.0.113.9';
  const dummyBody = {
    code: 'c'.repeat(43),
    state: 's'.repeat(43),
    codeVerifier: 'v'.repeat(43),
  };

  for (let i = 1; i <= 20; i += 1) {
    const res = await h.request({
      method: 'POST',
      url: '/v1/auth/desktop/exchange',
      auth: false,
      headers: { 'x-forwarded-for': `198.51.100.${i}, ${realClientIp}` },
      body: dummyBody,
    });
    assert.equal(res.statusCode, 401);
  }

  // 21st attempt from the same rightmost Cloud Run router IP is rate-limited (429)
  // even when the attacker rotates the spoofed leading X-Forwarded-For entry.
  const limited = await h.request({
    method: 'POST',
    url: '/v1/auth/desktop/exchange',
    auth: false,
    headers: { 'x-forwarded-for': `198.51.100.250, ${realClientIp}` },
    body: dummyBody,
  });
  assert.equal(limited.statusCode, 429);
});
