/**
 * Identity plane tests (ADR 003): handle aliases, bio validation, publisher-key
 * challenge binding, and the public creator projection.
 *
 * Real Ed25519 keys are generated per test; signatures are produced the same
 * way the desktop signer does (raw hex64 pubkey, SPKI reconstruction server-side).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { harness, FIXED_NOW } from './harness.js';
import { validateHandle, validateBio, validatePubKey, RESERVED_HANDLES } from '../src/identity.js';

/** Generate an Ed25519 identity the way the desktop publisher does. */
function makePublisherIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubKey = spki.subarray(spki.length - 32).toString('hex');
  const sign = (message) => cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
  return { pubKey, sign };
}

const OTHER_UID = 'user_other';

async function seedOtherUser(store) {
  await store.setUser(OTHER_UID, {
    uid: OTHER_UID,
    email: 'other@example.com',
    displayName: 'Other User',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

// ---- Validation rules -------------------------------------------------------

test('validateHandle enforces length, charset, edge underscores, reserved names', () => {
  assert.equal(validateHandle('ab').code, 'handle_invalid');
  assert.equal(validateHandle('a'.repeat(25)).code, 'handle_invalid');
  assert.equal(validateHandle('bad-handle').code, 'handle_invalid');
  assert.equal(validateHandle('bad handle').code, 'handle_invalid');
  assert.equal(validateHandle('_leading').code, 'handle_invalid');
  assert.equal(validateHandle('trailing_').code, 'handle_invalid');
  assert.equal(validateHandle(42).code, 'handle_invalid');
  for (const reserved of ['admin', 'FrostByte', 'SUPPORT']) {
    assert.equal(validateHandle(reserved).code, 'handle_reserved');
  }
  const ok = validateHandle('  Frost_Crafter99  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.handle, 'Frost_Crafter99');
  assert.equal(ok.handleLower, 'frost_crafter99');
  assert.ok(RESERVED_HANDLES.has('frostnet'));
});

test('validateBio enforces 280 chars, rejects control chars, empty clears', () => {
  assert.equal(validateBio('x'.repeat(281)).code, 'bio_invalid');
  assert.equal(validateBio('hello\u0000world').code, 'bio_invalid');
  assert.equal(validateBio('line\nbreak\tok').ok, true);
  assert.deepEqual(validateBio(''), { ok: true, bio: '' });
  assert.deepEqual(validateBio(null), { ok: true, bio: '' });
  assert.equal(validateBio(7).code, 'bio_invalid');
});

test('validatePubKey requires exactly 64 lowercase hex chars', () => {
  assert.equal(validatePubKey('A'.repeat(64)).code, 'pubkey_invalid');
  assert.equal(validatePubKey('a'.repeat(63)).code, 'pubkey_invalid');
  assert.equal(validatePubKey('g'.repeat(64)).code, 'pubkey_invalid');
  assert.equal(validatePubKey('a'.repeat(64)).ok, true);
});

// ---- Handle routes ----------------------------------------------------------

test('handle routes require authentication', async () => {
  const { request } = await harness();
  assert.equal((await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'crafter' }, auth: false })).statusCode, 401);
  assert.equal((await request({ method: 'DELETE', url: '/v1/me/handle', auth: false })).statusCode, 401);
});

test('POST /v1/me/handle reserves a case-preserving alias', async () => {
  const { request, store, uid } = await harness();
  const res = await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'Frost_Crafter99' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().handle, 'Frost_Crafter99');
  assert.equal(res.json().handleLower, 'frost_crafter99');

  const user = await store.getUser(uid);
  assert.equal(user.handle, 'Frost_Crafter99');
  const reservation = await store.getHandle('frost_crafter99');
  assert.equal(reservation.uid, uid);
});

test('handle uniqueness is case-insensitive across users', async () => {
  const { request, store } = await harness();
  await seedOtherUser(store);
  await store.setHandle(OTHER_UID, 'Frost_Crafter99', { nowMs: FIXED_NOW });

  const res = await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'frost_crafter99' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'handle_taken');
});

test('reserved and invalid handles are rejected at the route', async () => {
  const { request } = await harness();
  const reserved = await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'admin' } });
  assert.equal(reserved.statusCode, 400);
  assert.equal(reserved.json().error.code, 'handle_reserved');
  const invalid = await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'x' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'handle_invalid');
});

test('PATCH /v1/me refuses handle writes (dedicated route required)', async () => {
  const { request } = await harness();
  const res = await request({ method: 'PATCH', url: '/v1/me', body: { handle: 'sneaky' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'handle_route_required');
});

test('PATCH /v1/me validates and stores bio', async () => {
  const { request, store, uid } = await harness();
  const bad = await request({ method: 'PATCH', url: '/v1/me', body: { bio: 'x'.repeat(281) } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'bio_invalid');

  const ok = await request({ method: 'PATCH', url: '/v1/me', body: { bio: 'Local-first model crafter.' } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await store.getUser(uid)).bio, 'Local-first model crafter.');
});

test('rename releases the old handle into a grace window other users cannot take', async () => {
  const { request, store } = await harness();
  await seedOtherUser(store);
  await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'old_name' } });
  const rename = await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'new_name' } });
  assert.equal(rename.statusCode, 200);

  assert.equal(await store.getHandle('old_name'), null);
  const grace = await store.getHandleHistory('old_name');
  assert.ok(grace);
  assert.ok(Date.parse(grace.releasedUntil) > FIXED_NOW);

  // Another user is blocked during grace.
  const blocked = await store.setHandle(OTHER_UID, 'old_name', { nowMs: FIXED_NOW, graceMs: 30 * 86400000 });
  assert.equal(blocked.code, 'handle_grace');
  // The original owner can reclaim immediately.
  const reclaim = await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'old_name' } });
  assert.equal(reclaim.statusCode, 200);
  // After the grace window passes, anyone can take it.
  const later = FIXED_NOW + 31 * 86400000;
  await store.setHandle('user_123', 'new_name', { nowMs: later });
  const afterGrace = await store.setHandle(OTHER_UID, 'old_name', { nowMs: later, graceMs: 30 * 86400000 });
  assert.equal(afterGrace.ok, true);
});

test('DELETE /v1/me/handle releases with grace and 404s the public lookup', async () => {
  const { request, store, uid } = await harness();
  await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'gone_soon' } });
  const del = await request({ method: 'DELETE', url: '/v1/me/handle' });
  assert.equal(del.statusCode, 200);
  const user = await store.getUser(uid);
  assert.ok(!user.handle);
  const lookup = await request({ url: '/v1/creators/by-handle/gone_soon', auth: false });
  assert.equal(lookup.statusCode, 404);
  assert.equal(lookup.json().error.code, 'handle_grace');
});

// ---- Publisher-key challenge binding ----------------------------------------

test('publisher-key routes require authentication', async () => {
  const { request } = await harness();
  assert.equal((await request({ url: '/v1/me/publisher-keys', auth: false })).statusCode, 401);
  assert.equal((await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: 'a'.repeat(64) }, auth: false })).statusCode, 401);
});

test('challenge → signature → bind happy path stores the binding', async () => {
  const { request, store, uid } = await harness();
  const id = makePublisherIdentity();

  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  assert.equal(challenge.statusCode, 200);
  const { challengeId, nonce } = challenge.json();
  assert.match(nonce, /^[a-f0-9]{64}$/);

  const bind = await request({
    method: 'POST', url: '/v1/me/publisher-key',
    body: { pubKey: id.pubKey, challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${nonce}`) },
  });
  assert.equal(bind.statusCode, 200);
  assert.equal(bind.json().pubKey, id.pubKey);

  const binding = await store.getPublisherKey(id.pubKey);
  assert.equal(binding.uid, uid);
  assert.ok(binding.boundAt);
  const user = await store.getUser(uid);
  assert.ok(user.publisherKeys[id.pubKey]);

  const list = await request({ url: '/v1/me/publisher-keys' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().keys.length, 1);
  assert.equal(list.json().keys[0].pubKey, id.pubKey);
});

test('a bad signature burns the challenge — no replay, no brute force', async () => {
  const { request } = await harness();
  const id = makePublisherIdentity();
  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  const { challengeId, nonce } = challenge.json();

  const badSig = '00'.repeat(64);
  const bad = await request({
    method: 'POST', url: '/v1/me/publisher-key',
    body: { pubKey: id.pubKey, challengeId, signature: badSig },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'signature_invalid');

  // Even the CORRECT signature now fails: the challenge was burned.
  const retry = await request({
    method: 'POST', url: '/v1/me/publisher-key',
    body: { pubKey: id.pubKey, challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${nonce}`) },
  });
  assert.equal(retry.statusCode, 400);
  assert.equal(retry.json().error.code, 'challenge_invalid');
});

test('a successful bind cannot be replayed with the same challenge', async () => {
  const { request } = await harness();
  const id = makePublisherIdentity();
  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  const { challengeId, nonce } = challenge.json();
  const body = { pubKey: id.pubKey, challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${nonce}`) };
  assert.equal((await request({ method: 'POST', url: '/v1/me/publisher-key', body })).statusCode, 200);
  const replay = await request({ method: 'POST', url: '/v1/me/publisher-key', body });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error.code, 'challenge_invalid');
});

test('expired challenges are rejected', async () => {
  const { request, store, uid } = await harness();
  const id = makePublisherIdentity();
  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  const { challengeId, nonce } = challenge.json();
  // Overwrite the stored challenge with an already-expired copy.
  await store.createPublisherChallenge({
    challengeId, uid, pubKey: id.pubKey, nonce,
    createdAt: new Date(FIXED_NOW - 3600000).toISOString(),
    expiresAt: new Date(FIXED_NOW - 1).toISOString(),
    usedAt: null,
  });
  const res = await request({
    method: 'POST', url: '/v1/me/publisher-key',
    body: { pubKey: id.pubKey, challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${nonce}`) },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'challenge_invalid');
});

test('a challenge for one key cannot bind a different key', async () => {
  const { request } = await harness();
  const a = makePublisherIdentity();
  const b = makePublisherIdentity();
  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: a.pubKey } });
  const { challengeId, nonce } = challenge.json();
  const res = await request({
    method: 'POST', url: '/v1/me/publisher-key',
    body: { pubKey: b.pubKey, challengeId, signature: b.sign(`frostbyte-bind/1\n${a.pubKey}\n${nonce}`) },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'challenge_invalid');
});

test('one pubkey binds to one account; unbind tombstone allows rebind by another', async () => {
  const { request, store, uid } = await harness();
  await seedOtherUser(store);
  const id = makePublisherIdentity();

  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  const { challengeId, nonce } = challenge.json();
  await request({ method: 'POST', url: '/v1/me/publisher-key', body: { pubKey: id.pubKey, challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${nonce}`) } });

  // Another account cannot even get a challenge for the bound key.
  const stolen = await store.setPublisherKey(id.pubKey, OTHER_UID, { nowMs: FIXED_NOW });
  assert.equal(stolen.code, 'key_bound_elsewhere');

  // Owner-only unbind; a stranger cannot unbind.
  const strangerUnbind = await store.deletePublisherKey(id.pubKey, OTHER_UID, { nowMs: FIXED_NOW });
  assert.equal(strangerUnbind.code, 'not_owner');
  const unbind = await request({ method: 'DELETE', url: `/v1/me/publisher-key/${id.pubKey}` });
  assert.equal(unbind.statusCode, 200);
  const binding = await store.getPublisherKey(id.pubKey);
  assert.ok(binding.unboundAt);
  assert.equal(binding.uid, uid, 'attribution history is preserved');

  // After unbind the key can move to another account (fresh challenge + sig).
  const otherChallenge = await store.createPublisherChallenge({
    challengeId: 'other-challenge', uid: OTHER_UID, pubKey: id.pubKey, nonce: 'n'.repeat(64),
    createdAt: new Date(FIXED_NOW).toISOString(),
    expiresAt: new Date(FIXED_NOW + 600000).toISOString(),
    usedAt: null,
  });
  assert.ok(otherChallenge);
  const rebind = await store.setPublisherKey(id.pubKey, OTHER_UID, { nowMs: FIXED_NOW });
  assert.equal(rebind.ok, true);
});

test('DELETE of an unbound/unknown key is 403, malformed key is 400', async () => {
  const { request } = await harness();
  const unknown = await request({ method: 'DELETE', url: `/v1/me/publisher-key/${'b'.repeat(64)}` });
  assert.equal(unknown.statusCode, 403);
  const malformed = await request({ method: 'DELETE', url: '/v1/me/publisher-key/not-a-key' });
  assert.equal(malformed.statusCode, 400);
});

// ---- Public creator projection ----------------------------------------------

test('GET /v1/creators/:pubKey projects only public fields, never uid/email', async () => {
  const { request } = await harness();
  const id = makePublisherIdentity();
  await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'crafter_prime' } });
  await request({ method: 'PATCH', url: '/v1/me', body: { bio: 'Making local models sing.', displayName: 'Crafter Prime' } });
  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  const { challengeId, nonce } = challenge.json();
  await request({ method: 'POST', url: '/v1/me/publisher-key', body: { pubKey: id.pubKey, challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${nonce}`) } });

  const res = await request({ url: `/v1/creators/${id.pubKey}`, auth: false });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.pubkey, id.pubKey);
  assert.equal(body.handle, 'crafter_prime');
  assert.equal(body.displayName, 'Crafter Prime');
  assert.equal(body.bio, 'Making local models sing.');
  assert.equal(body.verified, true);
  for (const forbiddenField of ['uid', 'email', 'emailLower', 'tenantId', 'tier', 'roles', 'stripeCustomerId', 'publisherKeys']) {
    assert.ok(!(forbiddenField in body), `projection must not expose ${forbiddenField}`);
  }
  assert.deepEqual(Object.keys(body.stats).sort(), ['followers', 'models', 'recipes']);
});

test('unknown creator pubkey and handle are 404; malformed inputs are 400', async () => {
  const { request } = await harness();
  assert.equal((await request({ url: `/v1/creators/${'c'.repeat(64)}`, auth: false })).statusCode, 404);
  assert.equal((await request({ url: '/v1/creators/by-handle/nobody_here', auth: false })).statusCode, 404);
  assert.equal((await request({ url: '/v1/creators/xyz', auth: false })).statusCode, 400);
  assert.equal((await request({ url: '/v1/creators/by-handle/x', auth: false })).statusCode, 400);
});

test('by-handle lookup resolves to the active bound key; unbound creator 404s', async () => {
  const { request } = await harness();
  const id = makePublisherIdentity();
  await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'alias_finder' } });

  // Handle exists but no key bound yet → 404.
  assert.equal((await request({ url: '/v1/creators/by-handle/alias_finder', auth: false })).statusCode, 404);

  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  const { challengeId, nonce } = challenge.json();
  await request({ method: 'POST', url: '/v1/me/publisher-key', body: { pubKey: id.pubKey, challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${nonce}`) } });

  const res = await request({ url: '/v1/creators/by-handle/ALIAS_FINDER', auth: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().pubkey, id.pubKey);
  assert.equal(res.json().handle, 'alias_finder');
});

test('unbind flips verified=false without erasing the alias projection', async () => {
  const { request } = await harness();
  const id = makePublisherIdentity();
  await request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'still_here' } });
  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  const { challengeId, nonce } = challenge.json();
  await request({ method: 'POST', url: '/v1/me/publisher-key', body: { pubKey: id.pubKey, challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${nonce}`) } });
  await request({ method: 'DELETE', url: `/v1/me/publisher-key/${id.pubKey}` });

  const res = await request({ url: `/v1/creators/${id.pubKey}`, auth: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().verified, false);
  assert.equal(res.json().handle, 'still_here');
});
/* ---- external security report #2: bind signatures are domain-separated */

test('a raw-nonce signature no longer binds; only the frostbyte-bind/1 frame does (report #2)', async () => {
  const { request } = await harness();
  const id = makePublisherIdentity();
  const challenge = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  assert.equal(challenge.statusCode, 200);
  const { nonce, challengeId } = challenge.json();

  // Legacy raw-nonce signature (what a hostile Hub could request pre-fix).
  const raw = await request({ method: 'POST', url: '/v1/me/publisher-key', body: {
    pubKey: id.pubKey, challengeId, signature: id.sign(nonce),
  } });
  assert.equal(raw.statusCode, 400);

  // Challenges are single-use (burned even on failed verify) — the framed
  // bind signature succeeds on a fresh challenge.
  const second = await request({ method: 'POST', url: '/v1/me/publisher-key/challenge', body: { pubKey: id.pubKey } });
  const fresh = second.json();
  const framed = await request({ method: 'POST', url: '/v1/me/publisher-key', body: {
    pubKey: id.pubKey, challengeId: fresh.challengeId, signature: id.sign(`frostbyte-bind/1\n${id.pubKey}\n${fresh.nonce}`),
  } });
  assert.equal(framed.statusCode, 200);
});
