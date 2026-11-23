#!/usr/bin/env node
/**
 * P2.4 — real-emulator e2e gate for the deployed recipe plane.
 *
 * Starts a REAL Firestore emulator (demo project, named `blackfrost-hub`
 * database — the exact production database name), then drives the REAL
 * platform handler (createApp + createFirestoreStore, the same wiring
 * index.js uses) over real HTTP:
 *
 *   publish → search → GET → cross-account withdraw 403 → owner withdraw →
 *   GET 410 tombstone → immutable manifest stays 200 → changes feed →
 *   admin legacy import (operator-vouched) → imported recipe searchable →
 *   re-import idempotent → admin takedown → re-import refuses (tombstone).
 *
 * P3 community plane (same gate): announcement publish (>1500-byte body) →
 * feed composition → edit/delete; release-note publish → feed segment;
 * follow → me/follows → following feed → unfollow → follower count drops.
 * HONEST LIMIT: the emulator does not enforce Firestore index-entry byte
 * limits or composite indexes — only a deployed probe verifies those.
 *
 * Auth is the ONLY injected seam (verifyIdToken): the emulator suite has no
 * Identity Platform tenant, so tokens are verified by a local stub that
 * returns realistic decoded claims (tenant, auth_time, frostbyteAdmin). Every
 * gate downstream of verification — tenant isolation, admin record + claim +
 * step-up, owner pin, tombstones, signature crypto — runs for real.
 *
 * Usage:
 *   node scripts/recipe-plane-emulator-e2e.mjs
 *
 * Env:
 *   JAVA_HOME            — must point at a JDK 17+ (Homebrew openjdk@17 works)
 *   FIRESTORE_EMULATOR_PORT — default 8190 (platform/firebase.json)
 *
 * Exit 0 = every gate verified. Non-zero = failure; the emulator is always
 * torn down. Writes a receipt to .receipts/p24-emulator-e2e.receipt.json
 * on success.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'platform/functions/package.json'));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const { createApp } = await import('../platform/functions/src/app.js');
const { createFirestoreStore } = await import('../platform/functions/src/store/firestore.js');
const { validateRecipe, canonicalDigest, recipeSigningBytes } = await import('../platform/functions/src/recipe-manifest.js');
const { FROSTNET_TERMS } = await import('../src/shared/release-manifest.js');

const PROJECT = 'demo-frostbyte-p24';
const DATABASE = 'blackfrost-hub'; // the EXACT production database name
const PORT = Number(process.env.FIRESTORE_EMULATOR_PORT || 8190);
const HOST = `127.0.0.1:${PORT}`;
const TENANT = 'frostbyte-p24-tenant';
const UID_OWNER = 'p24-owner';
const UID_OTHER = 'p24-other';
const UID_ADMIN = 'p24-admin';

// ── Emulator lifecycle ──────────────────────────────────────────────────────

function findJava() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin/java'))) {
    return path.join(process.env.JAVA_HOME, 'bin/java');
  }
  // Emulator jars ≥ v1.20 require Java 21+ (class file 65); java 17 fails
  // with UnsupportedClassVersionError. Prefer newer brew JDKs first.
  for (const candidate of [
    '/opt/homebrew/opt/openjdk/bin/java',
    '/opt/homebrew/opt/openjdk@26/bin/java',
    '/opt/homebrew/opt/openjdk@21/bin/java',
    '/opt/homebrew/opt/openjdk@17/bin/java',
    '/usr/bin/java',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No JDK found. Set JAVA_HOME (JDK 21+ for emulator jars ≥ v1.20).');
}

function findEmulatorJar() {
  const cache = path.join(process.env.HOME || '', '.cache/firebase/emulators');
  if (!fs.existsSync(cache)) throw new Error(`No emulator cache at ${cache}. Run: firebase setup:emulators:firestore`);
  const jars = fs.readdirSync(cache).filter((f) => /^cloud-firestore-emulator-.*\.jar$/.test(f)).sort();
  if (!jars.length) throw new Error('No cloud-firestore-emulator jar in cache. Run: firebase setup:emulators:firestore');
  return path.join(cache, jars[jars.length - 1]);
}

async function waitForEmulator(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${HOST}/`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200 || res.status === 404) return; // emulator answers
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Firestore emulator did not come up on ${HOST} within ${timeoutMs}ms.`);
}

// ── Token seam (the ONLY injected part) ─────────────────────────────────────

const TOKENS = new Map(); // token → decoded claims
function mintToken(uid, { admin = false, stale = false, tenant = TENANT } = {}) {
  const token = `p24-token-${uid}-${admin ? 'admin' : 'user'}-${stale ? 'stale' : 'fresh'}-${TOKENS.size}`;
  const authTimeSec = Math.floor(Date.now() / 1000) - (stale ? 7200 : 60);
  TOKENS.set(token, {
    uid,
    email: `${uid}@example.com`,
    email_verified: true,
    auth_time: authTimeSec,
    firebase: { tenant, sign_in_provider: 'password' },
    ...(admin ? { frostbyteAdmin: true } : {}),
  });
  return token;
}
const verifyIdToken = async (token) => {
  const decoded = TOKENS.get(token);
  if (!decoded) { const e = new Error('bad token'); e.code = 'auth/argument-error'; throw e; }
  return decoded;
};

// ── Crypto helpers (real Ed25519, same scheme as the desktop publisher) ─────

function makeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubKey = spki.subarray(spki.length - 32).toString('hex');
  return {
    pubKey,
    signB64: (bytes) => cryptoSign(null, bytes, privateKey).toString('base64'),
    signHex: (message) => cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex'),
  };
}

function makeRecipe(identity, overrides = {}) {
  const manifest = validateRecipe({
    schema: 'frostbyte.recipe', version: 2, id: 'p24-llama3-server',
    title: 'P24 Llama3-8B Q4_K_M server', kind: 'tmux', publisher: identity.pubKey,
    session: 'llama3', argv: ['llama-server', '-m', 'models/llama3-8b-q4_k_m.gguf', '--port', '8080'],
    files: [{ path: 'models/llama3-8b-q4_k_m.gguf', size: 4096, sha256: 'c'.repeat(64) }],
    description: 'Emulator gate fixture.',
    modelRef: { repoId: 'bartowski/Meta-Llama-3-8B-Instruct-GGUF', revision: 'd'.repeat(40), variant: 'Q4_K_M' },
    license: { id: 'llama3', statement: 'Meta Llama 3 Community License' },
    createdAt: new Date().toISOString(),
    ...overrides,
  });
  const digest = canonicalDigest(manifest);
  const signature = identity.signB64(recipeSigningBytes({ digest, pubkey: manifest.publisher, timestamp: manifest.createdAt }));
  return { manifest, digest, signature };
}

// ── HTTP driver ─────────────────────────────────────────────────────────────

let API = '';
async function call(method, url, { body, token } = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

// ── The gate ────────────────────────────────────────────────────────────────

const steps = [];
function step(name, fn) { steps.push({ name, fn }); }

step('health: real Firestore store reported', async () => {
  const res = await call('GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.store, 'firestore');
});

step('publish: real signature verified, head pinned to owner', async ({ owner, ownerToken }) => {
  const recipe = makeRecipe(owner);
  const res = await call('POST', '/v1/recipes', {
    token: ownerToken,
    body: { manifest: recipe.manifest, digest: recipe.digest, signature: recipe.signature, terms: FROSTNET_TERMS },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, 'published');
  assert.equal(res.json.digest, recipe.digest);
  return recipe;
});

step('publish: forged signature refused (real crypto)', async ({ owner, other }) => {
  const recipe = makeRecipe(owner, { id: 'p24-forged' });
  const forged = makeRecipe(other, { id: 'p24-forged' }); // other key's signature
  const res = await call('POST', '/v1/recipes', {
    token: owner.pubKeyToken,
    body: { manifest: recipe.manifest, digest: recipe.digest, signature: forged.signature, terms: FROSTNET_TERMS },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'signature_invalid');
});

step('search: published recipe discoverable, anonymous', async () => {
  const res = await call('GET', '/v1/search?q=llama3');
  assert.equal(res.status, 200);
  assert.ok(res.json.items.some((i) => i.id === 'p24-llama3-server'));
});

step('GET head + immutable manifest fetch', async ({ recipe }) => {
  const head = await call('GET', '/v1/recipes/p24-llama3-server');
  assert.equal(head.status, 200);
  assert.equal(head.json.digest, recipe.digest);
  const manifest = await call('GET', `/v1/manifests/${recipe.digest}`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.signature, recipe.signature);
});

step('cross-account withdraw → 403 not_owner (publish-time pin)', async ({ otherToken }) => {
  const res = await call('DELETE', '/v1/recipes/p24-llama3-server', { token: otherToken });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'not_owner');
  // Still live after the refused withdraw.
  assert.equal((await call('GET', '/v1/recipes/p24-llama3-server')).status, 200);
});

step('owner withdraw → tombstone; GET 410; search excludes; manifest stays 200', async ({ ownerToken, recipe }) => {
  const res = await call('DELETE', '/v1/recipes/p24-llama3-server', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'withdrawn');
  const gone = await call('GET', '/v1/recipes/p24-llama3-server');
  assert.equal(gone.status, 410);
  const search = await call('GET', '/v1/search?q=llama3');
  assert.ok(!search.json.items.some((i) => i.id === 'p24-llama3-server'));
  // Immutable content addressing: the manifest MUST stay fetchable so
  // downloaders can still verify what they hold.
  assert.equal((await call('GET', `/v1/manifests/${recipe.digest}`)).status, 200);
  // Idempotent repeat.
  const again = await call('DELETE', '/v1/recipes/p24-llama3-server', { token: ownerToken });
  assert.equal(again.status, 200);
  assert.equal(again.json.already, true);
});

step('changes feed carries published + withdrawn events', async () => {
  const res = await call('GET', '/v1/changes?cursor=0&limit=100');
  assert.equal(res.status, 200);
  const types = res.json.changes.map((c) => `${c.type}:${c.id || c.digest}`);
  assert.ok(types.some((t) => t.startsWith('recipe.published:')), JSON.stringify(types));
  assert.ok(types.some((t) => t.startsWith('recipe.withdrawn:')), JSON.stringify(types));
});

step('admin gate: non-admin and stale step-up refused on import', async ({ ownerToken, staleAdminToken, legacy }) => {
  const body = { reason: 'P2.4 emulator gate legacy import.', records: [legacy.record] };
  const plain = await call('POST', '/v1/admin/frostnet-import', { token: ownerToken, body });
  assert.equal(plain.status, 403);
  const stale = await call('POST', '/v1/admin/frostnet-import', { token: staleAdminToken, body });
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error.code, 'admin_reauth_required');
});

step('legacy import: operator-vouched, original key+sig preserved, audited', async ({ adminToken, legacy }) => {
  const res = await call('POST', '/v1/admin/frostnet-import', {
    token: adminToken,
    body: { reason: 'P2.4 emulator gate legacy import.', source: 'frostnet-si', records: [legacy.record] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.imported, 1);
  assert.equal(res.json.results[0].digest, legacy.record.digest);
  // Searchable on the new plane.
  const search = await call('GET', '/v1/search?q=legacy');
  assert.ok(search.json.items.some((i) => i.id === legacy.record.id));
  // Original signature preserved byte-for-byte.
  const manifest = await call('GET', `/v1/manifests/${legacy.record.digest}`);
  assert.equal(manifest.json.signature, legacy.record.signature);
});

step('re-import idempotent; admin takedown; re-import refuses tombstone', async ({ adminToken, legacy }) => {
  const again = await call('POST', '/v1/admin/frostnet-import', {
    token: adminToken,
    body: { reason: 'P2.4 emulator gate idempotency check.', records: [legacy.record] },
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent, 1);
  assert.equal(again.json.imported, 0);

  const takedown = await call('POST', `/v1/admin/recipes/${legacy.record.id}/withdraw`, {
    token: adminToken, body: { reason: 'P2.4 emulator gate takedown drill.' },
  });
  assert.equal(takedown.status, 200);
  assert.equal((await call('GET', `/v1/recipes/${legacy.record.id}`)).status, 410);

  const resurrect = await call('POST', '/v1/admin/frostnet-import', {
    token: adminToken,
    body: { reason: 'P2.4 emulator gate tombstone drill.', records: [legacy.record] },
  });
  assert.equal(resurrect.status, 200);
  assert.equal(resurrect.json.refused, 1);
  assert.equal(resurrect.json.results[0].code, 'withdrawn');
  assert.equal((await call('GET', `/v1/recipes/${legacy.record.id}`)).status, 410);
});

// ── P3 community plane steps ────────────────────────────────────────────────

step('P3 announcement: >1500-byte body publish (real Firestore write)', async ({ adminToken }) => {
  // 4-byte emoji × 1950 = 7800 bytes — far past the 1500-byte index-entry
  // limit. Production writability relies on the body fieldOverride; the
  // emulator does not enforce index limits (documented honest limit).
  const body = '🧊'.repeat(1950);
  const res = await call('POST', '/v1/admin/announcements', {
    token: adminToken,
    body: { id: 'p3-welcome', title: 'Welcome to FrostNet', body, pinned: true, reason: 'P3 emulator gate announcement.' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const feed = await call('GET', '/v1/feed');
  assert.equal(feed.status, 200);
  const pinned = feed.json.pinned.find((a) => a.id === 'p3-welcome');
  assert.ok(pinned, 'pinned announcement must appear in the anon feed');
  assert.equal(pinned.body, body);
  assert.ok(!('authorUid' in pinned), 'public feed must not expose authorUid');
});

step('P3 announcement: edit preserves publishedAt; delete removes from feed', async ({ adminToken }) => {
  const before = (await call('GET', '/v1/announcements')).json.items.find((a) => a.id === 'p3-welcome');
  const patch = await call('PATCH', '/v1/admin/announcements/p3-welcome', {
    token: adminToken, body: { title: 'Welcome aboard', reason: 'P3 emulator gate copy edit.' },
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.announcement.publishedAt, before.publishedAt);
  const del = await call('DELETE', '/v1/admin/announcements/p3-welcome', {
    token: adminToken, body: { reason: 'P3 emulator gate delete drill.' },
  });
  assert.equal(del.status, 200);
  const feed = await call('GET', '/v1/feed');
  assert.ok(!feed.json.pinned.some((a) => a.id === 'p3-welcome'));
  assert.ok(!feed.json.announcements.some((a) => a.id === 'p3-welcome'));
});

step('P3 release note: publish → anon feed segment; delete removes', async ({ adminToken }) => {
  const res = await call('POST', '/v1/admin/release-notes', {
    token: adminToken,
    body: { version: '2.0.0', released: '2026-11-15', title: 'FrostByte 2.0', body: 'FrostNet sharing is live.', current: true, reason: 'P3 emulator gate release notes.' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const feed = await call('GET', '/v1/feed');
  const release = feed.json.releases.find((r) => r.version === '2.0.0');
  assert.ok(release, 'release notes must reach anonymous feed readers');
  assert.ok(!('authorUid' in release));
  const dup = await call('POST', '/v1/admin/release-notes', {
    token: adminToken,
    body: { version: '2.0.0', released: '2026-11-15', title: 'Dup', body: 'Dup', reason: 'P3 duplicate drill.' },
  });
  assert.equal(dup.status, 409);
  const del = await call('DELETE', '/v1/admin/release-notes/2.0.0', {
    token: adminToken, body: { reason: 'P3 emulator gate delete drill.' },
  });
  assert.equal(del.status, 200);
  assert.ok(!(await call('GET', '/v1/feed')).json.releases.some((r) => r.version === '2.0.0'));
});

step('P3 follow: bind other key via REAL challenge flow, follow, graph + counts', async ({ ownerToken, otherToken, other }) => {
  // Real challenge → sign → bind flow for the OTHER account's key.
  const challenge = await call('POST', '/v1/me/publisher-key/challenge', { token: otherToken, body: { pubKey: other.pubKey } });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.json));
  const bind = await call('POST', '/v1/me/publisher-key', {
    token: otherToken,
    body: { pubKey: other.pubKey, challengeId: challenge.json.challengeId, signature: other.signHex(challenge.json.nonce) },
  });
  assert.equal(bind.status, 200, JSON.stringify(bind.json));
  // Set a handle so the creator projection carries an alias.
  const handle = await call('POST', '/v1/me/handle', { token: otherToken, body: { handle: 'p3_other_crafter' } });
  assert.equal(handle.status, 200, JSON.stringify(handle.json));

  const anon = await call('POST', `/v1/follows/${other.pubKey}`);
  assert.equal(anon.status, 401);
  const follow = await call('POST', `/v1/follows/${other.pubKey}`, { token: ownerToken });
  assert.equal(follow.status, 200, JSON.stringify(follow.json));
  assert.equal(follow.json.already, false);
  const again = await call('POST', `/v1/follows/${other.pubKey}`, { token: ownerToken });
  assert.equal(again.json.already, true);

  const mine = await call('GET', '/v1/me/follows', { token: ownerToken });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.follows.map((f) => f.pubkey), [other.pubKey]);
  const creator = await call('GET', `/v1/creators/${other.pubKey}`);
  assert.equal(creator.status, 200);
  assert.equal(creator.json.stats.followers, 1);
  assert.equal(creator.json.handle, 'p3_other_crafter');
});

step('P3 following feed: session-only, filters to the graph, creator join clean', async ({ owner, ownerToken, other }) => {
  // OTHER publishes a live recipe under their bound key.
  const recipe = makeRecipe(other, { id: 'p3-other-recipe', title: 'P3 Other creator recipe' });
  const pub = await call('POST', '/v1/recipes', {
    token: mintToken(UID_OTHER),
    body: { manifest: recipe.manifest, digest: recipe.digest, signature: recipe.signature, terms: FROSTNET_TERMS },
  });
  assert.equal(pub.status, 200, JSON.stringify(pub.json));

  const anon = await call('GET', '/v1/feed?following=1');
  assert.equal(anon.status, 401);
  const feed = await call('GET', '/v1/feed?following=1', { token: ownerToken });
  assert.equal(feed.status, 200, JSON.stringify(feed.json));
  assert.equal(feed.json.following, true);
  assert.deepEqual(feed.json.recipes.map((r) => r.id), ['p3-other-recipe']);
  const creator = feed.json.recipes[0].creator;
  assert.equal(creator.pubkey, other.pubKey);
  assert.equal(creator.handle, 'p3_other_crafter');
  assert.equal(creator.verified, true);
  for (const field of ['uid', 'email', 'emailLower', 'tenantId', 'tier', 'roles', 'bio', 'ownerUid']) {
    assert.ok(!(field in creator), `creator join must not expose ${field}`);
  }
  // The owner's own (withdrawn) recipe never appears in their following feed.
  assert.ok(!feed.json.recipes.some((r) => r.publisher === owner.pubKey));
});

step('P3 unfollow: idempotent, count drops, following feed empties', async ({ ownerToken, other }) => {
  const unfollow = await call('DELETE', `/v1/follows/${other.pubKey}`, { token: ownerToken });
  assert.equal(unfollow.status, 200);
  assert.equal(unfollow.json.removed, true);
  const repeat = await call('DELETE', `/v1/follows/${other.pubKey}`, { token: ownerToken });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.json.removed, false);
  assert.equal((await call('GET', `/v1/creators/${other.pubKey}`)).json.stats.followers, 0);
  const feed = await call('GET', '/v1/feed?following=1', { token: ownerToken });
  assert.equal(feed.json.recipes.length, 0);
});

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
  const java = findJava();
  const jar = findEmulatorJar();
  console.log(`[p24] java=${java}`);
  console.log(`[p24] emulator=${jar}`);

  const emulator = spawn(java, ['-jar', jar, '--host=127.0.0.1', `--port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let emulatorLog = '';
  emulator.stdout.on('data', (d) => { emulatorLog += d.toString(); });
  emulator.stderr.on('data', (d) => { emulatorLog += d.toString(); });
  let exitCode = 1;
  let firestore; let adminApp; let server;
  try {
    await waitForEmulator();
    console.log(`[p24] Firestore emulator up on ${HOST}`);

    process.env.FIRESTORE_EMULATOR_HOST = HOST;
    adminApp = initializeApp({ projectId: PROJECT }, 'p24-gate');
    firestore = getFirestore(adminApp, DATABASE);
    const store = createFirestoreStore({ firestore });

    // Seed the admin record the gate requires (claim alone is never enough).
    await store.setAdmin(UID_ADMIN, { role: 'admin', status: 'active', email: `${UID_ADMIN}@example.com` });
    // User profiles must exist before key binding (setPublisherKey refuses
    // not_found) — same as the real ensureProfile flow on first sign-in.
    for (const uid of [UID_OWNER, UID_OTHER, UID_ADMIN]) {
      await store.setUser(uid, { uid, email: `${uid}@example.com`, tier: 'free', status: 'active' });
    }

    const handler = createApp({ store, verifyIdToken, tenantId: TENANT });
    server = createServer((req, res) => { handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    API = `http://127.0.0.1:${server.address().port}`;
    console.log(`[p24] real handler serving on ${API}`);

    // Fixtures: two user identities + one legacy record signed by a third key.
    const owner = makeIdentity();
    const other = makeIdentity();
    const legacyIdentity = makeIdentity();
    const ownerToken = mintToken(UID_OWNER);
    const otherToken = mintToken(UID_OTHER);
    const adminToken = mintToken(UID_ADMIN, { admin: true });
    const staleAdminToken = mintToken(UID_ADMIN, { admin: true, stale: true });
    owner.pubKeyToken = ownerToken;

    // Bind the owner's key so publish passes the key-binding gate.
    const bind = await store.setPublisherKey(owner.pubKey, UID_OWNER);
    assert.equal(bind.ok, true, `key bind failed: ${JSON.stringify(bind)}`);

    const legacyManifest = validateRecipe({
      schema: 'frostbyte.recipe', version: 2, id: 'p24-legacy-recipe',
      title: 'P24 Legacy migrated recipe', kind: 'native', publisher: legacyIdentity.pubKey,
      files: [{ path: 'legacy.json', size: 128, sha256: 'e'.repeat(64) }],
      license: { id: 'MIT', statement: 'MIT' }, createdAt: '2026-09-01T10:00:00.000Z',
    });
    const legacyDigest = canonicalDigest(legacyManifest);
    const legacyRecord = {
      id: legacyManifest.id, manifest: legacyManifest, digest: legacyDigest,
      signature: legacyIdentity.signB64(recipeSigningBytes({ digest: legacyDigest, pubkey: legacyIdentity.pubKey, timestamp: legacyManifest.createdAt })),
      legacySeq: 42,
    };

    const ctx = { owner, other, ownerToken, otherToken, adminToken, staleAdminToken, legacy: { record: legacyRecord }, recipe: null };
    const results = [];
    for (const { name, fn } of steps) {
      const out = await fn(ctx);
      if (name.startsWith('publish: real signature')) ctx.recipe = out;
      results.push({ step: name, ok: true });
      console.log(`[p24] PASS ${name}`);
    }

    const receipt = {
      ok: true, startedAt, finishedAt: new Date().toISOString(),
      project: PROJECT, database: DATABASE, emulatorHost: HOST,
      java, emulatorJar: jar,
      authSeam: 'verifyIdToken stub (no Identity Platform tenant in emulator); all downstream gates real',
      honestLimits: [
        'Firestore emulator does not enforce index-entry byte limits (announcements/releaseNotes body fieldOverrides verified only by a deployed probe)',
        'Emulator serves queries without composite indexes; P3 uses single-field reads only (zero new composites)',
      ],
      steps: results,
    };
    const receiptPath = path.join(ROOT, '.receipts/p24-emulator-e2e.receipt.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    console.log(`[p24] ALL ${results.length} GATES PASSED — receipt: ${receiptPath}`);
    exitCode = 0;
  } catch (error) {
    console.error(`[p24] FAIL: ${error.message}`);
    console.error(error.stack?.split('\n').slice(0, 8).join('\n'));
    console.error(`[p24] emulator log tail:\n${emulatorLog.slice(-2000)}`);
    exitCode = 1;
  } finally {
    try { if (server) await new Promise((r) => server.close(r)); } catch { /* ignore */ }
    try { if (firestore) await firestore.terminate(); } catch { /* ignore */ }
    try { if (adminApp) await deleteApp(adminApp); } catch { /* ignore */ }
    emulator.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!emulator.killed) emulator.kill('SIGKILL');
  }
  process.exit(exitCode);
}

main();