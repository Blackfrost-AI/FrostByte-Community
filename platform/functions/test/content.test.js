/**
 * P3 community content plane — announcements, release notes, public feed.
 *
 * Drives the REAL handler (memory store, real router, real Ed25519 publishes)
 * per the FrostNet home design (2026-11-17, v2). Security cases pinned from the
 * pre-implementation review:
 *   - creator join is a strict public subset (never uid/email/tier/tenant)
 *   - nextCursor comes from the RAW store page: a fully-blocked page paginates
 *   - following=1 is session-only (API keys refused) and filters in ONE scan
 *   - pinned cap 3 enforced on write; admin gate + fresh auth + audit reason
 *   - >1500-byte bodies accepted by the store (index exemption is deploy-time)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { harness, FIXED_NOW, userFixture } from './harness.js';
import { generateApiKey } from '../src/auth.js';
import { validateRecipe, canonicalDigest, recipeSigningBytes } from '../src/recipe-manifest.js';
import { FROSTNET_TERMS } from '../src/recipes.js';

const OTHER_UID = 'user_other';

function makePublisherIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubKey = spki.subarray(spki.length - 32).toString('hex');
  return {
    pubKey,
    privateKey,
    signHex: (message) => cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex'),
    signB64: (bytes) => cryptoSign(null, bytes, privateKey).toString('base64'),
  };
}

function recipeFixture(pubKey, overrides = {}) {
  return validateRecipe({
    schema: 'frostbyte.recipe',
    version: 2,
    id: 'qwen3-32b-q4km',
    title: 'Qwen3-32B text-generation Q4_K_M GGUF server',
    kind: 'tmux',
    publisher: pubKey,
    session: 'qwen3',
    argv: ['llama-server', '-m', 'models/qwen3-32b-q4_k_m.gguf', '--port', '8080'],
    files: [{ path: 'models/qwen3-32b-q4_k_m.gguf', size: 1024, sha256: 'b'.repeat(64) }],
    description: 'A text-generation recipe for Qwen3.',
    modelRef: { repoId: 'Qwen/Qwen3-32B-GGUF', revision: 'a'.repeat(40), variant: 'Q4_K_M' },
    license: { id: 'apache-2.0', statement: 'Apache License 2.0' },
    createdAt: '2026-10-18T11:00:00.000Z',
    ...overrides,
  });
}

function signedBody(identity, manifest) {
  const digest = canonicalDigest(manifest);
  const signature = identity.signB64(recipeSigningBytes({ digest, pubkey: manifest.publisher, timestamp: manifest.createdAt }));
  return { manifest, digest, terms: FROSTNET_TERMS, signature };
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

/** Second-account harness sharing one store (follow-graph scenarios). */
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

async function makeAdmin(h) {
  await h.store.setAdmin(h.uid, { role: 'admin', status: 'active', email: 'admin@example.com' });
}

async function publishAnnouncement(h, overrides = {}) {
  return h.request({
    method: 'POST', url: '/v1/admin/announcements', token: 'admin-token',
    body: { id: 'welcome', title: 'Welcome to FrostNet', body: 'Share your recipes.', reason: 'Launch announcement.', ...overrides },
  });
}

async function publishReleaseNote(h, overrides = {}) {
  return h.request({
    method: 'POST', url: '/v1/admin/release-notes', token: 'admin-token',
    body: { version: '2.0.0', released: '2026-11-15', title: 'FrostByte 2.0', body: 'FrostNet sharing is live.', reason: 'Release notes for 2.0.', ...overrides },
  });
}

// ── Announcements: admin gate, validation, caps, audit ──────────────────────

test('announcements: publish requires admin + fresh auth + audit reason; audited', async () => {
  const h = await harness();
  // Non-admin session → 403.
  const denied = await publishAnnouncement(h);
  assert.equal(denied.statusCode, 403);
  await makeAdmin(h);
  // Missing reason → 400.
  const noReason = await h.request({ method: 'POST', url: '/v1/admin/announcements', token: 'admin-token', body: { id: 'welcome', title: 'Hi', body: 'There' } });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.json().error.code, 'audit_reason_required');
  // Stale admin token → 401 step-up.
  const stale = await publishAnnouncement(h, {});
  assert.equal(stale.statusCode, 201);
  const staleRes = await h.request({
    method: 'POST', url: '/v1/admin/announcements', token: 'admin-token-stale',
    body: { id: 'second', title: 'Second', body: 'Body', reason: 'Testing step-up.' },
  });
  assert.equal(staleRes.statusCode, 403);
  assert.equal(staleRes.json().error.code, 'admin_reauth_required');

  const audit = await h.store.listAudit();
  assert.ok(audit.some(entry => entry.action === 'announcement.publish' && entry.targetId === 'welcome'));
});

test('announcements: validation caps (title 140, body 4000, id/tag charset)', async () => {
  const h = await harness();
  await makeAdmin(h);
  assert.equal((await publishAnnouncement(h, { title: 'x'.repeat(141) })).statusCode, 400);
  assert.equal((await publishAnnouncement(h, { body: 'x'.repeat(4001) })).statusCode, 400);
  assert.equal((await publishAnnouncement(h, { body: '   ' })).statusCode, 400);
  assert.equal((await publishAnnouncement(h, { id: 'Bad ID!' })).statusCode, 400);
  assert.equal((await publishAnnouncement(h, { tag: 'UPPER' })).statusCode, 400);
  assert.equal((await publishAnnouncement(h, { id: 'ok-id', tag: 'release' })).statusCode, 201);
});

test('announcements: >1500-byte body accepted (Firestore index exemption is deploy-time)', async () => {
  const h = await harness();
  await makeAdmin(h);
  // 3900 multi-byte chars ≈ 11.7KB — far past Firestore's 1500-byte index
  // entry limit. The store must accept it; fieldOverrides keep it writable
  // in production (the emulator does NOT enforce that limit — documented).
  const body = '🧊'.repeat(1950); // 2 bytes… use 4-byte emoji: 7800 bytes
  const res = await publishAnnouncement(h, { id: 'long-read', body });
  assert.equal(res.statusCode, 201);
  const feed = await h.request({ url: '/v1/feed', auth: false });
  assert.equal(feed.json().announcements.concat(feed.json().pinned).find(a => a.id === 'long-read').body, body);
});

test('announcements: pinned cap 3 enforced on create AND update', async () => {
  const h = await harness();
  await makeAdmin(h);
  for (let i = 1; i <= 3; i += 1) {
    assert.equal((await publishAnnouncement(h, { id: `pin-${i}`, pinned: true })).statusCode, 201);
  }
  const fourth = await publishAnnouncement(h, { id: 'pin-4', pinned: true });
  assert.equal(fourth.statusCode, 409);
  assert.equal(fourth.json().error.code, 'pinned_cap');
  // Updating an existing unpinned item to pinned also hits the cap.
  assert.equal((await publishAnnouncement(h, { id: 'plain' })).statusCode, 201);
  const promote = await h.request({
    method: 'PATCH', url: '/v1/admin/announcements/plain', token: 'admin-token',
    body: { pinned: true, reason: 'Promoting to pinned.' },
  });
  assert.equal(promote.statusCode, 409);
  // Unpinning one frees a slot.
  const unpin = await h.request({
    method: 'PATCH', url: '/v1/admin/announcements/pin-1', token: 'admin-token',
    body: { pinned: false, reason: 'Rotating pinned set.' },
  });
  assert.equal(unpin.statusCode, 200);
  assert.equal((await publishAnnouncement(h, { id: 'pin-4', pinned: true })).statusCode, 201);
});

test('announcements: public list hides authorUid; edit keeps publishedAt; delete 404s after', async () => {
  const h = await harness();
  await makeAdmin(h);
  assert.equal((await publishAnnouncement(h)).statusCode, 201);

  const list = await h.request({ url: '/v1/announcements', auth: false });
  assert.equal(list.statusCode, 200);
  const item = list.json().items[0];
  assert.equal(item.id, 'welcome');
  assert.ok(!('authorUid' in item), 'public projection must not expose authorUid');

  const adminList = await h.request({ url: '/v1/admin/announcements', token: 'admin-token' });
  assert.equal(adminList.json().items[0].authorUid, h.uid);

  const patch = await h.request({
    method: 'PATCH', url: '/v1/admin/announcements/welcome', token: 'admin-token',
    body: { title: 'Welcome aboard', reason: 'Copy edit.' },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().announcement.title, 'Welcome aboard');
  assert.equal(patch.json().announcement.publishedAt, new Date(FIXED_NOW).toISOString());

  const del = await h.request({
    method: 'DELETE', url: '/v1/admin/announcements/welcome', token: 'admin-token',
    body: { reason: 'Superseded by launch post.' },
  });
  assert.equal(del.statusCode, 200);
  const gone = await h.request({
    method: 'DELETE', url: '/v1/admin/announcements/welcome', token: 'admin-token',
    body: { reason: 'Repeat delete must 404.' },
  });
  assert.equal(gone.statusCode, 404);
  const audit = await h.store.listAudit();
  assert.ok(audit.some(e => e.action === 'announcement.update'));
  assert.ok(audit.some(e => e.action === 'announcement.delete'));
});

// ── Release notes: public feed segment for anon/free users ──────────────────

test('release notes: publish → public feed segment; duplicate POST 409; PATCH/DELETE work', async () => {
  const h = await harness();
  await makeAdmin(h);
  assert.equal((await publishReleaseNote(h)).statusCode, 201);
  assert.equal((await publishReleaseNote(h)).statusCode, 409);

  // Anonymous visitors get release news through the feed (the signed engine
  // /v1/updates stays Plus/Pro — different product).
  const feed = await h.request({ url: '/v1/feed', auth: false });
  assert.equal(feed.statusCode, 200);
  const release = feed.json().releases[0];
  assert.equal(release.version, '2.0.0');
  assert.equal(release.released, '2026-11-15');
  assert.ok(!('authorUid' in release));

  assert.equal((await publishReleaseNote(h, { version: 'not-semver' })).statusCode, 400);
  assert.equal((await publishReleaseNote(h, { version: '2.0.1', released: '15-11-2026' })).statusCode, 400);
  assert.equal((await publishReleaseNote(h, { version: '2.0.1', released: '2026-11-16' })).statusCode, 201);

  const patch = await h.request({
    method: 'PATCH', url: '/v1/admin/release-notes/2.0.0', token: 'admin-token',
    body: { current: true, reason: 'Marking current release.' },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().releaseNote.current, true);

  const del = await h.request({
    method: 'DELETE', url: '/v1/admin/release-notes/2.0.1', token: 'admin-token',
    body: { reason: 'Yanked release.' },
  });
  assert.equal(del.statusCode, 200);
  const feed2 = await h.request({ url: '/v1/feed', auth: false });
  assert.deepEqual(feed2.json().releases.map(r => r.version), ['2.0.0']);
  const audit = await h.store.listAudit();
  assert.ok(audit.some(e => e.action === 'release_note.publish'));
  assert.ok(audit.some(e => e.action === 'release_note.delete'));
});

// ── Feed composition ────────────────────────────────────────────────────────

test('feed: composes pinned → announcements → releases → recipes with public creator join', async () => {
  const h = await harness();
  await makeAdmin(h);
  const id = makePublisherIdentity();
  await h.request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'crafter_prime' } });
  await h.request({ method: 'PATCH', url: '/v1/me', body: { displayName: 'Crafter Prime' } });
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);
  await publishAnnouncement(h, { id: 'pinned-one', pinned: true });
  await publishAnnouncement(h, { id: 'plain-one' });
  await publishReleaseNote(h);

  const feed = await h.request({ url: '/v1/feed', auth: false });
  assert.equal(feed.statusCode, 200);
  const json = feed.json();
  assert.deepEqual(json.pinned.map(a => a.id), ['pinned-one']);
  assert.deepEqual(json.announcements.map(a => a.id), ['plain-one']);
  assert.equal(json.releases.length, 1);
  assert.equal(json.recipes.length, 1);
  assert.equal(json.following, false);

  const recipe = json.recipes[0];
  assert.equal(recipe.id, manifest.id);
  assert.equal(recipe.creator.pubkey, id.pubKey);
  assert.equal(recipe.creator.handle, 'crafter_prime');
  assert.equal(recipe.creator.displayName, 'Crafter Prime');
  assert.equal(recipe.creator.verified, true);
  // totalBytes is derived from the pinned manifest file sizes (fit badges).
  assert.equal(recipe.totalBytes, manifest.files.reduce((sum, f) => sum + f.size, 0));
  assert.ok(recipe.totalBytes > 0);
  // PII boundary: the join is a strict subset — never account internals.
  for (const forbiddenField of ['uid', 'email', 'emailLower', 'tenantId', 'tier', 'roles', 'bio', 'boundAt', 'ownerUid']) {
    assert.ok(!(forbiddenField in recipe.creator), `creator join must not expose ${forbiddenField}`);
  }
});

test('feed: moderation-blocked recipes are hidden; a fully-blocked page still paginates', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const first = recipeFixture(id.pubKey);
  const second = recipeFixture(id.pubKey, {
    id: 'llama3-8b-q5km',
    title: 'Llama3-8B Q5_K_M GGUF server',
    modelRef: { repoId: 'Nous/Llama3-8B-GGUF', revision: 'c'.repeat(40), variant: 'Q5_K_M' },
  });
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, first) })).statusCode, 200);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, second) })).statusCode, 200);

  // Block BOTH repos: page 1 is fully blocked but must still hand back the
  // raw store cursor so the client can keep walking (review S3).
  await h.store.upsertModerationRule({ id: 'r1', targetType: 'repo', targetValue: 'Qwen/Qwen3-32B-GGUF', action: 'block' });
  await h.store.upsertModerationRule({ id: 'r2', targetType: 'repo', targetValue: 'Nous/Llama3-8B-GGUF', action: 'block' });
  const page1 = await h.request({ url: '/v1/feed?limit=1', auth: false });
  assert.equal(page1.statusCode, 200);
  assert.equal(page1.json().recipes.length, 0);
  assert.ok(page1.json().nextCursor, 'fully-blocked page must still paginate');
  const page2 = await h.request({ url: `/v1/feed?limit=1&cursor=${encodeURIComponent(page1.json().nextCursor)}`, auth: false });
  assert.equal(page2.statusCode, 200);
  assert.equal(page2.json().recipes.length, 0);

  // Lift one block: the unblocked recipe surfaces without any cursor change.
  await h.store.deleteModerationRule('r2');
  const open = await h.request({ url: '/v1/feed', auth: false });
  assert.deepEqual(open.json().recipes.map(r => r.id), ['llama3-8b-q5km']);
});

test('feed: withdrawn recipes never appear (tombstones excluded by the store)', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) });
  assert.equal((await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` })).statusCode, 200);
  const feed = await h.request({ url: '/v1/feed', auth: false });
  assert.equal(feed.json().recipes.length, 0);
});

test('feed: creator whose account was deleted projects key-only, never a ghost identity', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await h.request({ method: 'POST', url: '/v1/me/handle', body: { handle: 'gone_creator' } });
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) });
  // Simulate account deletion (no deletion route exists yet — store-level).
  await h.store.deleteUser(h.uid);
  const feed = await h.request({ url: '/v1/feed', auth: false });
  const creator = feed.json().recipes[0].creator;
  assert.equal(creator.pubkey, id.pubKey);
  assert.equal(creator.handle, '');
  assert.equal(creator.displayName, '');
  assert.equal(creator.verified, false);
  // The creator route must not project the ghost either.
  assert.equal((await h.request({ url: `/v1/creators/${id.pubKey}`, auth: false })).statusCode, 404);
});

test('feed: following=1 requires a session, refuses API keys, filters to the follow graph', async () => {
  const h = await harness({ tier: 'pro' });
  await h.store.setUser(OTHER_UID, userFixture({ uid: OTHER_UID, email: 'other@example.com' }));
  const other = await secondAccountHarness(h);

  const mine = makePublisherIdentity();
  const theirs = makePublisherIdentity();
  await bindKey(h.request, mine);
  await bindKey(other, theirs, 'other-token');
  const myRecipe = recipeFixture(mine.pubKey);
  const theirRecipe = recipeFixture(theirs.pubKey, {
    id: 'mistral-7b-q4km',
    title: 'Mistral-7B Q4_K_M GGUF server',
    modelRef: { repoId: 'Mistral/Mistral-7B-GGUF', revision: 'd'.repeat(40), variant: 'Q4_K_M' },
  });
  await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(mine, myRecipe) });
  await other({ method: 'POST', url: '/v1/recipes', body: signedBody(theirs, theirRecipe) });

  // Anonymous → 401.
  assert.equal((await h.request({ url: '/v1/feed?following=1', auth: false })).statusCode, 401);
  // API key → 403 profile_required (a leaked key must not read the graph).
  const key = generateApiKey({ now: () => FIXED_NOW });
  await h.store.setApiKey(key.keyHash, { uid: h.uid, prefix: key.prefix, createdAt: new Date(FIXED_NOW).toISOString() });
  const viaKey = await h.request({ url: '/v1/feed?following=1', token: key.plaintext });
  assert.equal(viaKey.statusCode, 403);
  assert.equal(viaKey.json().error.code, 'profile_required');

  // Follow the OTHER creator, then the following feed shows only their recipe.
  assert.equal((await h.request({ method: 'POST', url: `/v1/follows/${theirs.pubKey}` })).statusCode, 200);
  const following = await h.request({ url: '/v1/feed?following=1' });
  assert.equal(following.statusCode, 200);
  assert.equal(following.json().following, true);
  assert.deepEqual(following.json().recipes.map(r => r.id), ['mistral-7b-q4km']);

  // Empty graph → empty recipes segment (not an error, not the full feed).
  const otherFollowing = await other({ url: '/v1/feed?following=1' });
  assert.equal(otherFollowing.statusCode, 200);
  assert.equal(otherFollowing.json().recipes.length, 0);
});

test('feed: limit clamp + invalid cursor rejected; anon budget applies', async () => {
  const h = await harness();
  const big = await h.request({ url: '/v1/feed?limit=500', auth: false });
  assert.equal(big.statusCode, 200); // clamped, not rejected
  const bad = await h.request({ url: '/v1/feed?cursor=not-a-cursor', auth: false });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'bad_cursor');
  // Anon per-IP ceiling: 60/min (same bucket as search).
  let saw429 = false;
  for (let i = 0; i < 65; i += 1) {
    const res = await h.request({ url: '/v1/feed', auth: false });
    if (res.statusCode === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, 'anonymous feed reads must hit the per-IP ceiling');
});