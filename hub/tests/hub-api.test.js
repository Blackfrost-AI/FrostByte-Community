import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHubApp } from '../src/app.js';
import { generateKeypair, signRecipePublish, verifyFeedBody, manifestDigest } from '../src/crypto.js';
import { validateRecipe } from '../../src/shared/recipe-manifest.js';
import { FROSTNET_TERMS } from '../../src/shared/release-manifest.js';

function makeManifest(publisher, overrides = {}) {
  return validateRecipe({
    schema: 'frostbyte.recipe', version: 2, id: 'test-recipe', title: 'Test Recipe', kind: 'native',
    publisher, files: [{ path: 'r.json', size: 10, sha256: 'c'.repeat(64) }],
    license: { id: 'MIT', statement: 'MIT' }, createdAt: new Date().toISOString(), ...overrides,
  });
}

async function startApp(opts = {}) {
  const app = createHubApp({ port: 0, seed: false, ...opts });
  await app.listen();
  const base = app.origin;
  const j = async (p, opt) => {
    const r = await fetch(base + p, opt);
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  return { app, base, j };
}

test('Hub health reports store mode', async () => {
  const { app, j } = await startApp();
  try {
    const { status, body } = await j('/v1/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.store, 'memory');
  } finally { await app.close(); }
});

test('Hub search returns models + recipes with a protocol cursor; bad cursor is 400 not a crash', async () => {
  const { app, j } = await startApp({ seed: true });
  try {
    const { status, body } = await j('/v1/search?q=llama&limit=2');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length <= 2);
    // pagination cursor present when more remain
    const all = await j('/v1/search?limit=2');
    assert.ok(all.body.nextCursor);
    const page2 = await j('/v1/search?limit=2&cursor=' + encodeURIComponent(all.body.nextCursor));
    assert.equal(page2.status, 200);
    // malformed cursor must not crash the process
    const bad = await j('/v1/search?cursor=abc');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_cursor');
    // still alive afterwards
    const alive = await j('/v1/health');
    assert.equal(alive.status, 200);
  } finally { await app.close(); }
});

test('Hub publish requires auth, valid terms, and a valid ed25519 signature', async () => {
  const { app, j } = await startApp();
  const tok = app.auth.devToken;
  const kp = generateKeypair();
  const manifest = makeManifest(kp.publicKeyHex);
  const signature = signRecipePublish(manifest, kp.privateKeyHex);
  const payload = { manifest, digest: manifestDigest(manifest), terms: FROSTNET_TERMS, signature };
  const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
  try {
    // no auth -> 401
    const noauth = await j('/v1/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(noauth.status, 401);
    // any-bearer is NOT enough: unknown token -> 401
    const fake = await j('/v1/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: JSON.stringify(payload) });
    assert.equal(fake.status, 401);
    // bad terms -> 400
    const badTerms = await j('/v1/recipes', post({ ...payload, terms: 'wrong' }));
    assert.equal(badTerms.status, 400);
    assert.equal(badTerms.body.error.code, 'bad_terms');
    // tampered signature -> 400
    const badSig = await j('/v1/recipes', post({ ...payload, signature: 'A'.repeat(86) }));
    assert.equal(badSig.status, 400);
    assert.equal(badSig.body.error.code, 'bad_signature');
    // signature from a DIFFERENT key -> 400
    const otherKp = generateKeypair();
    const wrongKeySig = signRecipePublish(manifest, otherKp.privateKeyHex);
    const wrongKey = await j('/v1/recipes', post({ ...payload, signature: wrongKeySig }));
    assert.equal(wrongKey.status, 400);
    // valid -> 201 with the REAL digest
    const ok = await j('/v1/recipes', post(payload));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.digest, manifestDigest(manifest));
    assert.equal(ok.body.status, 'published');
  } finally { await app.close(); }
});

test('Hub digest addressing is real: fetch by digest binds content; unknown digest is 404', async () => {
  const { app, j } = await startApp();
  const tok = app.auth.devToken;
  const kp = generateKeypair();
  const manifest = makeManifest(kp.publicKeyHex);
  const signature = signRecipePublish(manifest, kp.privateKeyHex);
  try {
    const pub = await j('/v1/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ manifest, terms: FROSTNET_TERMS, signature }) });
    const digest = pub.body.digest;
    const got = await j('/v1/manifests/' + digest);
    assert.equal(got.status, 200);
    assert.equal(got.body.digest, digest);
    assert.equal(manifestDigest(got.body.manifest), digest, 'returned manifest must hash to the requested digest');
    // a different digest must NOT return this content
    const wrong = await j('/v1/manifests/' + 'f'.repeat(64));
    assert.equal(wrong.status, 404);
    // recipe by id
    const byId = await j('/v1/recipes/test-recipe');
    assert.equal(byId.status, 200);
    assert.equal(byId.body.manifest.id, 'test-recipe');
    assert.equal(byId.body.head.currentVersion, 1);
    // ETag -> 304
    const r304 = await fetch(app.origin + '/v1/recipes/test-recipe', { headers: { 'If-None-Match': '"sha256:' + digest + '"' } });
    assert.equal(r304.status, 304);
    // unknown recipe -> 404
    const missing = await j('/v1/recipes/does-not-exist');
    assert.equal(missing.status, 404);
  } finally { await app.close(); }
});

test('Hub update feed requires Plus/Pro and is cryptographically signed', async () => {
  const { app, j } = await startApp({ seed: true });
  const tok = app.auth.devToken;
  try {
    const noauth = await j('/v1/updates');
    assert.equal(noauth.status, 401);
    const fake = await j('/v1/updates', { headers: { Authorization: 'Bearer x' } });
    assert.equal(fake.status, 401);
    const paid = await j('/v1/updates', { headers: { Authorization: 'Bearer ' + tok } });
    assert.equal(paid.status, 200);
    const feed = paid.body;
    for (const key of ['version', 'engines', 'recipes', 'configs', 'containers', 'signature', 'feedPubKey']) {
      assert.ok(key in feed, 'feed must contain ' + key);
    }
    assert.ok(Array.isArray(feed.recipes));
    const { signature, feedPubKey, ...body } = feed;
    assert.equal(verifyFeedBody(body, signature, feedPubKey), true, 'feed signature must verify against the hub feed key');
    // tampering invalidates the signature
    const tampered = { ...body, version: body.version + 1 };
    assert.equal(verifyFeedBody(tampered, signature, feedPubKey), false);
  } finally { await app.close(); }
});

test('Hub entitlement is server-resolved, never client-asserted', async () => {
  const { app, j } = await startApp({ tokens: { 'plus-token': { uid: 'u1', tier: 'plus' }, 'free-token': { uid: 'u2', tier: 'free' } } });
  try {
    const noauth = await j('/v1/me/entitlement');
    assert.equal(noauth.status, 401);
    const plus = await j('/v1/me/entitlement', { headers: { Authorization: 'Bearer plus-token' } });
    assert.equal(plus.status, 200);
    assert.equal(plus.body.tier, 'plus');
    assert.equal(plus.body.source, 'server');
    assert.equal(plus.body.entitlements.liveUpdates, true);
    const free = await j('/v1/me/entitlement', { headers: { Authorization: 'Bearer free-token' } });
    assert.equal(free.body.tier, 'free');
    assert.equal(free.body.entitlements.liveUpdates, false);
    // free token cannot reach paid updates
    const freeUpdates = await j('/v1/updates', { headers: { Authorization: 'Bearer free-token' } });
    assert.equal(freeUpdates.status, 403);
  } finally { await app.close(); }
});

test('Hub changes feed reflects real publishes with a cursor', async () => {
  const { app, j } = await startApp();
  const tok = app.auth.devToken;
  const kp = generateKeypair();
  const manifest = makeManifest(kp.publicKeyHex);
  const signature = signRecipePublish(manifest, kp.privateKeyHex);
  try {
    await j('/v1/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ manifest, terms: FROSTNET_TERMS, signature }) });
    const changes = await j('/v1/changes?cursor=0&limit=10');
    assert.equal(changes.status, 200);
    assert.ok(Array.isArray(changes.body.changes));
    assert.ok(changes.body.changes.some(c => c.type === 'recipe.published'));
    const bad = await j('/v1/changes?cursor=abc');
    assert.equal(bad.status, 400);
  } finally { await app.close(); }
});

test('Hub bundle latest is content-addressed and digest-bound', async () => {
  const { app, j } = await startApp({ seed: true });
  try {
    const latest = await j('/v1/bundle/latest');
    assert.equal(latest.status, 200);
    assert.ok(latest.body.digest);
    assert.equal(manifestDigest(latest.body.manifest), latest.body.digest);
    const byDigest = await j('/v1/bundle/' + latest.body.digest);
    assert.equal(byDigest.status, 200);
    const wrong = await j('/v1/bundle/' + 'f'.repeat(64));
    assert.equal(wrong.status, 404);
  } finally { await app.close(); }
});

test('Hub rejects oversized bodies with 413 and stays alive', async () => {
  const { app } = await startApp();
  const port = app.server.address().port;
  try {
    const result = await new Promise(resolve => {
      const req = http.request({ port, path: '/v1/recipes', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + app.auth.devToken } }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', e => resolve({ error: e.code }));
      req.write('x'.repeat(70000));
      req.end();
    });
    assert.equal(result.status, 413);
    const alive = await fetch(app.origin + '/v1/health');
    assert.equal(alive.status, 200);
  } finally { await app.close(); }
});

test('Hub malformed path and unknown routes return JSON errors, never crash', async () => {
  const { app, j } = await startApp();
  try {
    const malformed = await j('/v1/recipes/%');
    assert.equal(malformed.status, 400);
    const unknown = await j('/v1/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'not_found');
    const alive = await j('/v1/health');
    assert.equal(alive.status, 200);
  } finally { await app.close(); }
});

test('Hub creator lookup returns published recipes', async () => {
  const { app, j } = await startApp();
  const tok = app.auth.devToken;
  const kp = generateKeypair();
  const manifest = makeManifest(kp.publicKeyHex);
  const signature = signRecipePublish(manifest, kp.privateKeyHex);
  try {
    await j('/v1/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ manifest, terms: FROSTNET_TERMS, signature }) });
    const creator = await j('/v1/creators/' + kp.publicKeyHex);
    assert.equal(creator.status, 200);
    assert.equal(creator.body.creator.pubkey, kp.publicKeyHex);
    assert.ok(creator.body.recipes.some(r => r.id === 'test-recipe'));
  } finally { await app.close(); }
});