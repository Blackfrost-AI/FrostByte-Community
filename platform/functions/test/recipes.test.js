/**
 * P2 recipe share plane — route-level security + contract tests.
 *
 * Drives the REAL handler (memory store, real Ed25519 crypto, real router) per
 * docs/hub-api.md v2 and p2-review-decisions.md. The security cases here are
 * the red→green list from the two reviewer passes:
 *   - ownership pinned at publish; key rebind never moves withdraw power
 *   - unbound keys cannot publish; API keys cannot publish/withdraw
 *   - check ordering: tombstone before idempotency (no replay resurrection)
 *   - explicit createdAt; server-recomputed digest; real signature verify
 *   - tombstone GET = 410 (never 304), digest manifests stay immutable 200
 *   - operator takedown hides the digest everywhere; moderation rules apply
 *   - anon per-IP ceiling; changes vocabulary + numeric cursor; verbatim feed
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';

import { harness, FIXED_NOW, userFixture, subscriptionFixture } from './harness.js';
import { generateApiKey } from '../src/auth.js';
import { validateRecipe, canonicalDigest, canonicalJson, recipeSigningBytes } from '../src/recipe-manifest.js';
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
  const base = {
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
  };
  return validateRecipe(base);
}

function signedBody(identity, manifest, overrides = {}) {
  const digest = canonicalDigest(manifest);
  const signature = identity.signB64(recipeSigningBytes({ digest, pubkey: manifest.publisher, timestamp: manifest.createdAt }));
  return { manifest, digest, terms: FROSTNET_TERMS, signature, ...overrides };
}

async function seedOtherUser(store) {
  await store.setUser(OTHER_UID, userFixture({ uid: OTHER_UID, email: 'other@example.com' }));
}

/** Bind a key to a uid through the real challenge→bind routes. */
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

/** Second-account harness sharing one store (the rebind attack scenario). */
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

// ── Publish: happy path + contract shape ────────────────────────────────────

test('publish happy path: real signature verifies, head pinned to owner, search finds it', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const body = signedBody(id, manifest);

  const res = await h.request({ method: 'POST', url: '/v1/recipes', body });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.ok, true);
  assert.equal(json.status, 'published');
  assert.equal(json.digest, canonicalDigest(manifest));
  assert.equal(json.currentVersion, 1);

  const head = await h.store.getRecipeHead(manifest.id);
  assert.equal(head.ownerUid, h.uid);
  assert.equal(head.publisher, id.pubKey);
  assert.equal(head.signature, body.signature);
  assert.equal(head.title, manifest.title);
  assert.equal(head.license, 'apache-2.0');

  const search = await h.request({ url: '/v1/search?q=qwen3', auth: false });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().items.length, 1);
  assert.equal(search.json().items[0].id, manifest.id);
  assert.ok(!('total' in search.json()));
});

test('publish requires the exact terms anchor', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest, { terms: '1999-01-01-v0' }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'terms_required');
});

test('publish rejects a missing createdAt — the server never invents a digest', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const raw = recipeFixture(id.pubKey);
  delete raw.createdAt;
  // Sign whatever the validator would default to — the server must still refuse.
  const normalized = validateRecipe(raw);
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, normalized, { manifest: raw }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'created_at_required');
});

test('publish rejects a provided digest that does not match the manifest', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest, { digest: 'c'.repeat(64) }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'digest_mismatch');
});

test('publish rejects a bad signature with real crypto (not a stub)', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest, { signature: Buffer.alloc(64).toString('base64') }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'signature_invalid');
});

test('publish rejects a signature made by a DIFFERENT key than manifest.publisher', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  const impostor = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const digest = canonicalDigest(manifest);
  const forged = impostor.signB64(recipeSigningBytes({ digest, pubkey: id.pubKey, timestamp: manifest.createdAt }));
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: { manifest, digest, terms: FROSTNET_TERMS, signature: forged } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'signature_invalid');
});

test('publish refuses an UNBOUND key (binding check rejects unboundAt)', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const unbind = await h.request({ method: 'DELETE', url: `/v1/me/publisher-key/${id.pubKey}` });
  assert.equal(unbind.statusCode, 200);
  const manifest = recipeFixture(id.pubKey);
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'publisher_unbound');
});

test('publish refuses a key bound to ANOTHER account', async () => {
  const h = await harness();
  await seedOtherUser(h.store);
  const other = await secondAccountHarness(h);
  const id = makePublisherIdentity();
  await bindKey(other, id, 'other-token');
  // Caller h.uid tries to publish under a key bound to OTHER_UID.
  const manifest = recipeFixture(id.pubKey);
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'publisher_unbound');
});

test('API keys cannot publish or withdraw (session profile required)', async () => {
  const h = await harness();
  const key = generateApiKey({ now: () => FIXED_NOW });
  await h.store.setApiKey(key.keyHash, { uid: h.uid, prefix: key.prefix, createdAt: new Date(FIXED_NOW).toISOString() });
  const id = makePublisherIdentity();
  // Bind through the session first.
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const publish = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest), token: key.plaintext });
  assert.equal(publish.statusCode, 403);
  assert.equal(publish.json().error.code, 'profile_required');

  // Publish via session, then try to withdraw with the API key.
  const ok = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) });
  assert.equal(ok.statusCode, 200);
  const withdraw = await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}`, token: key.plaintext });
  assert.equal(withdraw.statusCode, 403);
  assert.equal(withdraw.json().error.code, 'profile_required');
});

// ── Ownership pinning + the key-rebind attack (review A1) ───────────────────

test('SECURITY: key rebind by another account never transfers withdraw power', async () => {
  const h = await harness();
  await seedOtherUser(h.store);
  const other = await secondAccountHarness(h);
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const publish = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) });
  assert.equal(publish.statusCode, 200);

  // Owner unbinds; the second account rebinds the SAME key.
  assert.equal((await h.request({ method: 'DELETE', url: `/v1/me/publisher-key/${id.pubKey}` })).statusCode, 200);
  await bindKey(other, id, 'other-token');
  const binding = await h.store.getPublisherKey(id.pubKey);
  assert.equal(binding.uid, OTHER_UID); // live binding now points elsewhere

  // The new key holder must NOT be able to withdraw the original author's recipe.
  const attack = await other({ method: 'DELETE', url: `/v1/recipes/${manifest.id}`, token: 'other-token' });
  assert.equal(attack.statusCode, 403);
  assert.equal(attack.json().error.code, 'not_owner');

  // The ORIGINAL owner keeps withdraw power even without a live binding.
  const ownerWithdraw = await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` });
  assert.equal(ownerWithdraw.statusCode, 200);
  assert.equal(ownerWithdraw.json().status, 'withdrawn');
});

test('SECURITY: cross-account id collision is 409, never a silent overwrite', async () => {
  const h = await harness();
  await seedOtherUser(h.store);
  const other = await secondAccountHarness(h);
  const idA = makePublisherIdentity();
  const idB = makePublisherIdentity();
  await bindKey(h.request, idA);
  await bindKey(other, idB, 'other-token');
  const manifestA = recipeFixture(idA.pubKey);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(idA, manifestA) })).statusCode, 200);

  const manifestB = recipeFixture(idB.pubKey, { title: 'Impostor recipe' });
  const collision = await other({ method: 'POST', url: '/v1/recipes', body: signedBody(idB, manifestB), token: 'other-token' });
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.json().error.code, 'not_owner');
  const head = await h.store.getRecipeHead(manifestA.id);
  assert.equal(head.ownerUid, h.uid); // unchanged
});

test('SECURITY: withdrawn recipe cannot be resurrected by replaying its signed payload', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const body = signedBody(id, manifest);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body })).statusCode, 200);
  assert.equal((await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` })).statusCode, 200);

  // Exact same signed payload, replayed — must 409, NOT idempotent-200.
  const replay = await h.request({ method: 'POST', url: '/v1/recipes', body });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().error.code, 'withdrawn');
});

test('same-digest republish by the owner is idempotent (no duplicate change event)', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const body = signedBody(id, manifest);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body })).statusCode, 200);
  const again = await h.request({ method: 'POST', url: '/v1/recipes', body });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().currentVersion, 1);
  const changes = await h.request({ url: '/v1/changes', auth: false });
  assert.equal(changes.json().changes.length, 1);
});

test('same owner, same id, NEW digest advances the revision; old manifest stays immutable', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const v1 = recipeFixture(id.pubKey);
  const body1 = signedBody(id, v1);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: body1 })).statusCode, 200);

  const v2 = recipeFixture(id.pubKey, { title: 'Qwen3-32B Q4_K_M v2', argv: ['llama-server', '-m', 'models/qwen3-32b-q4_k_m.gguf', '--port', '8081'] });
  const body2 = signedBody(id, v2);
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: body2 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().currentVersion, 2);
  assert.equal(res.json().digest, canonicalDigest(v2));

  const old = await h.request({ url: `/v1/manifests/${canonicalDigest(v1)}`, auth: false });
  assert.equal(old.statusCode, 200);
  assert.equal(old.json().manifest.title, v1.title);
  const head = await h.request({ url: `/v1/recipes/${v1.id}`, auth: false });
  assert.equal(head.json().head.currentVersion, 2);
  assert.equal(head.json().digest, canonicalDigest(v2));
});

// ── Tombstones (review C1 — new contract) ───────────────────────────────────

test('withdraw: id GET becomes 410 with tombstone headers, never 304; digest stays 200', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const digest = canonicalDigest(manifest);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);

  const etag = `"sha256:${digest}"`;
  const cached = await h.request({ url: `/v1/recipes/${manifest.id}`, headers: { 'if-none-match': etag }, auth: false });
  assert.equal(cached.statusCode, 304);

  assert.equal((await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` })).statusCode, 200);

  // Same conditional request must now surface the withdraw, NOT 304.
  const after = await h.request({ url: `/v1/recipes/${manifest.id}`, headers: { 'if-none-match': etag }, auth: false });
  assert.equal(after.statusCode, 410);
  assert.equal(after.json().error.code, 'withdrawn');
  assert.equal(after.getHeader('x-recipe-status'), 'withdrawn');
  assert.ok(after.getHeader('x-recipe-withdrawn-at'));

  const manifestRoute = await h.request({ url: `/v1/recipes/${manifest.id}/manifest`, auth: false });
  assert.equal(manifestRoute.statusCode, 410);

  // Digest-addressed content remains verifiable for existing importers.
  const byDigest = await h.request({ url: `/v1/manifests/${digest}`, auth: false });
  assert.equal(byDigest.statusCode, 200);
  assert.deepEqual(byDigest.json().manifest, manifest);

  // Search excludes the tombstone.
  const search = await h.request({ url: '/v1/search', auth: false });
  assert.equal(search.json().items.length, 0);
});

test('withdraw is idempotent and owner-only; unknown id is 404', async () => {
  const h = await harness();
  await seedOtherUser(h.store);
  const other = await secondAccountHarness(h);
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);

  const stranger = await other({ method: 'DELETE', url: `/v1/recipes/${manifest.id}`, token: 'other-token' });
  assert.equal(stranger.statusCode, 403);
  const first = await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` });
  assert.equal(first.json().already, false);
  const second = await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` });
  assert.equal(second.json().already, true);
  const missing = await h.request({ method: 'DELETE', url: '/v1/recipes/no-such-recipe' });
  assert.equal(missing.statusCode, 404);
});

// ── Search semantics ────────────────────────────────────────────────────────

test('search: quant tokens match VERBATIM (Q4_K_M never matches q4_k_m)', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);

  const exact = await h.request({ url: '/v1/search?quant=Q4_K_M', auth: false });
  assert.equal(exact.json().items.length, 1);
  const wrongCase = await h.request({ url: '/v1/search?quant=q4_k_m', auth: false });
  assert.equal(wrongCase.json().items.length, 0);
  const format = await h.request({ url: '/v1/search?format=gguf', auth: false });
  assert.equal(format.json().items.length, 1);
  const task = await h.request({ url: '/v1/search?task=text-generation', auth: false });
  assert.equal(task.json().items.length, 1);
  const qCase = await h.request({ url: '/v1/search?q=QWEN3', auth: false });
  assert.equal(qCase.json().items.length, 1); // q is case-insensitive
});

test('search: bad cursor is 400 bad_cursor; keyset pagination is stable', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  for (let i = 0; i < 3; i += 1) {
    const manifest = recipeFixture(id.pubKey, { id: `recipe-${i}`, title: `Recipe ${i}` });
    assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);
  }
  const bad = await h.request({ url: '/v1/search?cursor=not-a-cursor', auth: false });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'bad_cursor');

  const page1 = await h.request({ url: '/v1/search?limit=2', auth: false });
  assert.equal(page1.json().items.length, 2);
  assert.ok(page1.json().nextCursor);
  const page2 = await h.request({ url: `/v1/search?limit=2&cursor=${encodeURIComponent(page1.json().nextCursor)}`, auth: false });
  assert.equal(page2.json().items.length, 1);
  const ids = new Set([...page1.json().items, ...page2.json().items].map(item => item.id));
  assert.equal(ids.size, 3);
});

// ── Changes log ─────────────────────────────────────────────────────────────

test('changes: exact vocabulary, numeric cursor, append-only across publish+withdraw', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);
  assert.equal((await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` })).statusCode, 200);

  const res = await h.request({ url: '/v1/changes', auth: false });
  assert.equal(res.statusCode, 200);
  const { changes, nextCursor } = res.json();
  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map(c => c.type), ['recipe.published', 'recipe.withdrawn']);
  assert.deepEqual(changes.map(c => c.status), ['published', 'withdrawn']);
  assert.deepEqual(changes.map(c => c.seq), [1, 2]);
  for (const change of changes) {
    assert.ok(!('operation' in change));
    assert.equal(change.id, manifest.id);
    assert.equal(change.publisher, id.pubKey);
    assert.ok(change.at);
  }
  assert.equal(nextCursor, null); // page not full

  const paged = await h.request({ url: '/v1/changes?limit=1', auth: false });
  assert.equal(paged.json().changes.length, 1);
  assert.equal(paged.json().nextCursor, '1');
  const rest = await h.request({ url: '/v1/changes?limit=1&cursor=1', auth: false });
  assert.equal(rest.json().changes[0].type, 'recipe.withdrawn');
  const bad = await h.request({ url: '/v1/changes?cursor=abc', auth: false });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'bad_cursor');
});

// ── ETag + provenance ───────────────────────────────────────────────────────

test('recipe GET carries provenance + quoted sha256 ETag; manifest route honors 304', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  await h.store.setHandle(h.uid, 'alex');
  const manifest = recipeFixture(id.pubKey);
  const digest = canonicalDigest(manifest);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);

  const res = await h.request({ url: `/v1/recipes/${manifest.id}`, auth: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('etag'), `"sha256:${digest}"`);
  const json = res.json();
  assert.equal(json.status, 'published');
  assert.equal(json.provenance.publisher, id.pubKey);
  assert.equal(json.provenance.ownerUid, h.uid);
  assert.equal(json.provenance.terms, FROSTNET_TERMS);
  assert.deepEqual(json.manifest, manifest);

  const manifestRes = await h.request({ url: `/v1/recipes/${manifest.id}/manifest`, auth: false });
  assert.equal(manifestRes.statusCode, 200);
  const conditional = await h.request({ url: `/v1/recipes/${manifest.id}/manifest`, headers: { 'if-none-match': `"sha256:${digest}"` }, auth: false });
  assert.equal(conditional.statusCode, 304);
});

// ── Moderation + operator takedown (review A4) ──────────────────────────────

test('moderation rules hide recipes from search and GET', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);

  await h.store.upsertModerationRule({ id: 'rule-1', targetType: 'repo', targetValue: 'Qwen/Qwen3-32B-GGUF', action: 'block' });
  const search = await h.request({ url: '/v1/search', auth: false });
  assert.equal(search.json().items.length, 0);
  const get = await h.request({ url: `/v1/recipes/${manifest.id}`, auth: false });
  assert.equal(get.statusCode, 404);
});

test('operator takedown: admin+reason required; hides id AND digest; audited', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const digest = canonicalDigest(manifest);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);
  await h.store.setAdmin(h.uid, { role: 'admin', status: 'active', email: 'admin@example.com' });

  // No reason → 400.
  const noReason = await h.request({ method: 'POST', url: `/v1/admin/recipes/${manifest.id}/withdraw`, body: {}, token: 'admin-token' });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.json().error.code, 'audit_reason_required');

  const takedown = await h.request({
    method: 'POST', url: `/v1/admin/recipes/${manifest.id}/withdraw`,
    body: { reason: 'Malicious payload reported by two users.' }, token: 'admin-token',
  });
  assert.equal(takedown.statusCode, 200);
  assert.equal(takedown.json().status, 'withdrawn');

  assert.equal((await h.request({ url: `/v1/recipes/${manifest.id}`, auth: false })).statusCode, 410);
  // Takedown hides the digest too — otherwise it is decorative.
  assert.equal((await h.request({ url: `/v1/manifests/${digest}`, auth: false })).statusCode, 404);

  const audit = await h.store.listAudit();
  assert.ok(audit.some(entry => entry.action === 'recipe.takedown' && entry.targetId === manifest.id));

  // A later OWNER withdraw must not clear the takedown flag.
  await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` });
  assert.equal((await h.request({ url: `/v1/manifests/${digest}`, auth: false })).statusCode, 404);
});

test('owner self-withdraw keeps the digest fetchable (not a takedown)', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const digest = canonicalDigest(manifest);
  assert.equal((await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) })).statusCode, 200);
  assert.equal((await h.request({ method: 'DELETE', url: `/v1/recipes/${manifest.id}` })).statusCode, 200);
  assert.equal((await h.request({ url: `/v1/manifests/${digest}`, auth: false })).statusCode, 200);
});

// ── Anonymous rate ceiling (review A6) ──────────────────────────────────────

test('anonymous reads are capped per IP at 60/min; a spoofed XFF prefix does not evade', async () => {
  const h = await harness();
  let last;
  for (let i = 0; i < 61; i += 1) {
    last = await h.request({ url: '/v1/search', auth: false, headers: { 'x-forwarded-for': '203.0.113.9' } });
  }
  assert.equal(last.statusCode, 429);
  assert.equal(last.json().error.code, 'rate_limited');
  // Spoofed leading hop: the RIGHTMOST address is the trusted one, so the
  // same real client stays throttled.
  const spoofed = await h.request({ url: '/v1/search', auth: false, headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' } });
  assert.equal(spoofed.statusCode, 429);
  // A genuinely different IP has its own budget.
  const otherIp = await h.request({ url: '/v1/search', auth: false, headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(otherIp.statusCode, 200);
});

// ── Update feed (review A3/B1) ──────────────────────────────────────────────

function makeFeedIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const feedPubKey = spki.subarray(spki.length - 32).toString('hex');
  const signEnvelope = (body) => {
    const message = Buffer.from(`frostbyte-bundle/1\n${canonicalJson(body)}`, 'utf8');
    return { ...body, signature: cryptoSign(null, message, privateKey).toString('base64'), feedPubKey };
  };
  return { feedPubKey, signEnvelope };
}

const FEED_BODY = {
  version: 1,
  engines: [{ id: 'llama-cpp', version: 'b4000', severity: 'recommended' }],
  recipes: [],
  configs: [],
  containers: [],
};

test('admin feed import verifies the signature BEFORE storing; served verbatim to paid tiers', async () => {
  const h = await harness({ tier: 'plus' });
  await h.store.setAdmin(h.uid, { role: 'admin', status: 'active', email: 'admin@example.com' });
  const feed = makeFeedIdentity();

  // Unpublished → 503.
  const before = await h.request({ url: '/v1/updates' });
  assert.equal(before.statusCode, 503);

  // Tampered envelope → 400, nothing stored.
  const envelope = feed.signEnvelope(FEED_BODY);
  const tampered = { ...envelope, version: 99 };
  const bad = await h.request({ method: 'POST', url: '/v1/admin/recipes/feed', body: { feed: tampered, reason: 'Rotating the operator feed.' }, token: 'admin-token' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'feed_signature_invalid');
  assert.equal(await h.store.getUpdateFeed(), null);

  const good = await h.request({ method: 'POST', url: '/v1/admin/recipes/feed', body: { feed: envelope, reason: 'Publishing the operator feed.' }, token: 'admin-token' });
  assert.equal(good.statusCode, 201);

  const served = await h.request({ url: '/v1/updates' });
  assert.equal(served.statusCode, 200);
  // VERBATIM: every signed field intact, no server additions beyond the doc id.
  assert.deepEqual(served.json(), envelope);

  // The desktop verifier accepts exactly what the server serves.
  const { verifyUpdateFeed } = await import('../../../src/main/hub-crypto.js');
  assert.equal(verifyUpdateFeed(served.json()), true);
});

test('updates: free tier is upgrade_required; anonymous is 401', async () => {
  const h = await harness();
  const anon = await h.request({ url: '/v1/updates', auth: false });
  assert.equal(anon.statusCode, 401);
  const free = await h.request({ url: '/v1/updates' });
  assert.equal(free.statusCode, 403);
  assert.equal(free.json().error.code, 'upgrade_required');
});

test('admin feed import refuses a bad severity vocabulary and missing arrays', async () => {
  const h = await harness();
  await h.store.setAdmin(h.uid, { role: 'admin', status: 'active', email: 'admin@example.com' });
  const feed = makeFeedIdentity();
  const badSeverity = feed.signEnvelope({ ...FEED_BODY, engines: [{ id: 'x', severity: 'normal' }] });
  const res = await h.request({ method: 'POST', url: '/v1/admin/recipes/feed', body: { feed: badSeverity, reason: 'Testing severity vocabulary.' }, token: 'admin-token' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'feed_invalid');
});

// ── Body caps (review A5) ───────────────────────────────────────────────────

test('publish accepts a large-but-valid manifest under the 1 MiB cap', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const files = [];
  for (let i = 0; i < 400; i += 1) {
    files.push({ path: `models/shard-${String(i).padStart(4, '0')}.gguf`, size: 1024, sha256: createHash('sha256').update(`shard-${i}`).digest('hex') });
  }
  const manifest = recipeFixture(id.pubKey, { files });
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body: signedBody(id, manifest) });
  assert.equal(res.statusCode, 200);
});

test('publish rejects an oversized body with 413', async () => {
  const h = await harness();
  const id = makePublisherIdentity();
  await bindKey(h.request, id);
  const manifest = recipeFixture(id.pubKey);
  const body = signedBody(id, manifest);
  body.padding = 'x'.repeat(1024 * 1024 + 1024);
  const res = await h.request({ method: 'POST', url: '/v1/recipes', body });
  assert.equal(res.statusCode, 413);
});