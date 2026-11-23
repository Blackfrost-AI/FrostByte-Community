/**
 * P3 follow graph — session-only writes, private graph, public counts.
 *
 * Pubkey-keyed follows (ADR 003): rebind transfers followers with the key —
 * documented, tested here so it can never be reported as a surprise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { harness, FIXED_NOW, userFixture } from './harness.js';
import { generateApiKey } from '../src/auth.js';
import { FOLLOW_CAP } from '../src/store/contract.js';

const OTHER_UID = 'user_other';

function makePublisherIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubKey = spki.subarray(spki.length - 32).toString('hex');
  return {
    pubKey,
    signHex: (message) => cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex'),
  };
}

async function bindKey(request, identity, token) {
  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: identity.pubKey }, token });
  assert.equal(challenge.statusCode, 200);
  const { challengeId, nonce } = challenge.json();
  const bind = await request({
    method: 'POST', url: '/v1/me/publisher-key',
    body: { pubKey: identity.pubKey, challengeId, signature: identity.signHex(nonce) },
    token,
  });
  assert.equal(bind.statusCode, 200);
}

async function secondAccountHarness(base) {
  const authTimeSec = Math.floor(FIXED_NOW / 1000) - 300;
  const { createApp } = await import('../src/app.js');
  const app = createApp({
    store: base.store,
    fetcher: base.fetcher,
    now: () => FIXED_NOW,
    verifyIdToken: async (token) => {
      if (token === 'other-token') {
        return { uid: OTHER_UID, email: 'other@example.com', email_verified: true, auth_time: authTimeSec };
      }
      throw Object.assign(new Error('invalid'), { code: 'auth/argument-error' });
    },
  });
  const { makeRequest, makeResponse } = await import('./harness.js');
  return async (options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (options.auth !== false && !headers.authorization) headers.authorization = `Bearer ${options.token || 'other-token'}`;
    const req = makeRequest({ ...options, headers });
    const res = makeResponse();
    await app(req, res);
    return res;
  };
}

async function seededCreator() {
  const h = await harness({ tier: 'pro' });
  await h.store.setUser(OTHER_UID, userFixture({ uid: OTHER_UID, email: 'other@example.com' }));
  const other = await secondAccountHarness(h);
  // Set the handle through the REAL route so the handles reservation exists
  // (a direct setUser with handle fields skips the reservation table).
  const handleRes = await other({ method: 'POST', url: '/v1/me/handle', body: { handle: 'other_crafter' } });
  assert.equal(handleRes.statusCode, 200);
  const id = makePublisherIdentity();
  await bindKey(other, id, 'other-token');
  return { h, other, id };
}

test('follow: happy path + idempotent; me/follows lists; unfollow idempotent', async () => {
  const { h, id } = await seededCreator();
  const first = await h.request({ method: 'POST', url: `/v1/follows/${id.pubKey}` });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().already, false);
  const again = await h.request({ method: 'POST', url: `/v1/follows/${id.pubKey}` });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().already, true);

  const mine = await h.request({ url: '/v1/me/follows' });
  assert.equal(mine.statusCode, 200);
  assert.deepEqual(mine.json().follows.map(f => f.pubkey), [id.pubKey]);
  assert.equal(mine.json().limit, FOLLOW_CAP);

  const unfollow = await h.request({ method: 'DELETE', url: `/v1/follows/${id.pubKey}` });
  assert.equal(unfollow.statusCode, 200);
  assert.equal(unfollow.json().removed, true);
  const repeat = await h.request({ method: 'DELETE', url: `/v1/follows/${id.pubKey}` });
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.json().removed, false);
  assert.equal((await h.request({ url: '/v1/me/follows' })).json().follows.length, 0);
});

test('follow: anonymous 401; API keys 403 profile_required on all three routes', async () => {
  const { h, id } = await seededCreator();
  assert.equal((await h.request({ method: 'POST', url: `/v1/follows/${id.pubKey}`, auth: false })).statusCode, 401);
  assert.equal((await h.request({ method: 'DELETE', url: `/v1/follows/${id.pubKey}`, auth: false })).statusCode, 401);
  assert.equal((await h.request({ url: '/v1/me/follows', auth: false })).statusCode, 401);

  const key = generateApiKey({ now: () => FIXED_NOW });
  await h.store.setApiKey(key.keyHash, { uid: h.uid, prefix: key.prefix, createdAt: new Date(FIXED_NOW).toISOString() });
  for (const options of [
    { method: 'POST', url: `/v1/follows/${id.pubKey}` },
    { method: 'DELETE', url: `/v1/follows/${id.pubKey}` },
    { url: '/v1/me/follows' },
  ]) {
    const res = await h.request({ ...options, token: key.plaintext });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'profile_required');
  }
});

test('follow: unknown/ghost creator 404; malformed key 400; self-follow allowed', async () => {
  const { h, id } = await seededCreator();
  const unknown = await h.request({ method: 'POST', url: `/v1/follows/${'c'.repeat(64)}` });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, 'creator_not_found');
  assert.equal((await h.request({ method: 'POST', url: '/v1/follows/xyz' })).statusCode, 400);

  // Binding without a live user (deleted account) is not followable.
  await h.store.deleteUser(OTHER_UID);
  const ghost = await h.request({ method: 'POST', url: `/v1/follows/${id.pubKey}` });
  assert.equal(ghost.statusCode, 404);

  // Self-follow is allowed (creators can track their own key).
  const own = makePublisherIdentity();
  await bindKey(h.request, own);
  assert.equal((await h.request({ method: 'POST', url: `/v1/follows/${own.pubKey}` })).statusCode, 200);
});

test('follow: graph is private — me/follows returns only the caller\'s follows', async () => {
  const { h, other, id } = await seededCreator();
  await h.request({ method: 'POST', url: `/v1/follows/${id.pubKey}` });
  const otherList = await other({ url: '/v1/me/follows' });
  assert.equal(otherList.statusCode, 200);
  assert.equal(otherList.json().follows.length, 0);
  // No public route lists followers — only the aggregate count exists.
  const creator = await h.request({ url: `/v1/creators/${id.pubKey}`, auth: false });
  assert.equal(creator.statusCode, 200);
  assert.equal(creator.json().stats.followers, 1);
  assert.ok(!('followers' in creator.json()) || typeof creator.json().followers === 'undefined');
});

test('follow: creator stats reflect real follower + recipe counts', async () => {
  const { h, other, id } = await seededCreator();
  await h.request({ method: 'POST', url: `/v1/follows/${id.pubKey}` });
  await other({ method: 'POST', url: `/v1/follows/${id.pubKey}` });

  const byKey = await h.request({ url: `/v1/creators/${id.pubKey}`, auth: false });
  assert.equal(byKey.json().stats.followers, 2);
  const byHandle = await h.request({ url: '/v1/creators/by-handle/other_crafter', auth: false });
  assert.equal(byHandle.json().stats.followers, 2);

  // Unfollow decrements.
  await h.request({ method: 'DELETE', url: `/v1/follows/${id.pubKey}` });
  const after = await h.request({ url: `/v1/creators/${id.pubKey}`, auth: false });
  assert.equal(after.json().stats.followers, 1);
});

test('follow: cap 256 enforced (store-level atomicity; route surfaces follow_cap)', async () => {
  const h = await harness({ tier: 'pro' });
  // Seed 256 follows directly (the route budget would throttle long before).
  for (let i = 0; i < FOLLOW_CAP; i += 1) {
    const result = await h.store.addFollow(h.uid, i.toString(16).padStart(64, '0'));
    assert.equal(result.ok, true);
  }
  const overflow = await h.store.addFollow(h.uid, 'f'.repeat(64));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'follow_cap');
  // Idempotent re-follow at the cap still succeeds (no new row).
  const repeat = await h.store.addFollow(h.uid, '0'.repeat(64));
  assert.equal(repeat.ok, true);
  assert.equal(repeat.already, true);
  // Removing one frees a slot.
  await h.store.removeFollow(h.uid, '0'.repeat(64));
  assert.equal((await h.store.addFollow(h.uid, 'f'.repeat(64))).ok, true);
});

test('follow: key rebind transfers followers with the key (ADR 003 consequence)', async () => {
  const { h, other, id } = await seededCreator();
  await h.request({ method: 'POST', url: `/v1/follows/${id.pubKey}` });
  assert.equal((await h.request({ url: `/v1/creators/${id.pubKey}`, auth: false })).json().stats.followers, 1);

  // OTHER releases the key; h binds it to their own account.
  const release = await other({ method: 'DELETE', url: `/v1/me/publisher-key/${id.pubKey}` });
  assert.equal(release.statusCode, 200);
  await bindKey(h.request, id);

  // The follow is pubkey-keyed: it survives and now points at h's identity.
  const creator = await h.request({ url: `/v1/creators/${id.pubKey}`, auth: false });
  assert.equal(creator.statusCode, 200);
  assert.equal(creator.json().stats.followers, 1);
  const mine = await h.request({ url: '/v1/me/follows' });
  assert.deepEqual(mine.json().follows.map(f => f.pubkey), [id.pubKey]);
});

test('follow: deleteFollowsForUser cleans the graph (wiring ready for account deletion)', async () => {
  const { h, id } = await seededCreator();
  await h.request({ method: 'POST', url: `/v1/follows/${id.pubKey}` });
  assert.equal((await h.store.countFollowers(id.pubKey)), 1);
  const removed = await h.store.deleteFollowsForUser(h.uid);
  assert.equal(removed, 1);
  assert.equal((await h.store.countFollowers(id.pubKey)), 0);
  assert.equal((await h.store.listFollowsForUser(h.uid)).length, 0);
});