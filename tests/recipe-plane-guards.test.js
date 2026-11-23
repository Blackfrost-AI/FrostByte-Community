/**
 * P2 recipe plane — vendoring drift guards + store contract parity.
 *
 * These guards exist because the deployed bundle (platform/functions) cannot
 * import from src/shared at deploy time (ADR 002: only platform/functions/ is
 * uploaded). Every duplicated value is pinned here so drift fails `npm test`
 * loudly instead of silently at runtime:
 *
 *  1. BYTE-EQUALITY: platform/functions/src/recipe-manifest.js must be a
 *     byte-identical copy of src/shared/recipe-manifest.js.
 *  2. TERMS ANCHOR: the server's FROSTNET_TERMS must equal the shared export
 *     (it lives in release-manifest.js, NOT in the vendored file).
 *  3. ETAG FORMAT: server etagForDigest must match shared hub-protocol byte
 *     for byte, and the publish body cap must match PAGINATION.MAX_MANIFEST_BYTES.
 *  4. STORE PARITY: REQUIRED_STORE_METHODS must be implemented by BOTH the
 *     memory and Firestore stores (the assertion did not exist before P2 —
 *     review D1), and the recipe plane must behave identically on both
 *     backends, exercised through a transactional in-memory Firestore fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as sharedManifest from '../src/shared/recipe-manifest.js';
import * as vendoredManifest from '../platform/functions/src/recipe-manifest.js';
import { FROSTNET_TERMS as SHARED_TERMS } from '../src/shared/release-manifest.js';
import { FROSTNET_TERMS as SERVER_TERMS, etagForDigest as serverEtag, MAX_RECIPE_CANONICAL_BYTES } from '../platform/functions/src/recipes.js';
import { etagForDigest as sharedEtag, PAGINATION } from '../src/shared/hub-protocol.js';
import { REQUIRED_STORE_METHODS, COLLECTIONS } from '../platform/functions/src/store/contract.js';
import { createMemoryStore } from '../platform/functions/src/store/memory.js';
import { createFirestoreStore } from '../platform/functions/src/store/firestore.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. Byte-equality vendoring guard ────────────────────────────────────────

test('vendored recipe-manifest.js is byte-identical to src/shared (deploy cannot reach shared)', () => {
  const shared = readFileSync(join(ROOT, 'src/shared/recipe-manifest.js'));
  const vendored = readFileSync(join(ROOT, 'platform/functions/src/recipe-manifest.js'));
  assert.equal(vendored.equals(shared), true,
    'platform/functions/src/recipe-manifest.js drifted from src/shared/recipe-manifest.js — re-copy the file verbatim.');
});

test('vendored module exports the same surface as shared', () => {
  assert.deepEqual(Object.keys(vendoredManifest).sort(), Object.keys(sharedManifest).sort());
});

// ── 2. Terms anchor ─────────────────────────────────────────────────────────

test('server FROSTNET_TERMS equals the shared terms anchor (rotation must move both)', () => {
  assert.equal(SERVER_TERMS, SHARED_TERMS);
});

// ── 3. ETag format + byte cap parity ────────────────────────────────────────

test('server ETag format matches shared hub-protocol exactly', () => {
  for (const digest of ['a'.repeat(64), '0123456789abcdef'.repeat(4)]) {
    assert.equal(serverEtag(digest), sharedEtag(digest));
  }
  assert.equal(serverEtag('f'.repeat(64)), `"sha256:${'f'.repeat(64)}"`);
});

test('server canonical byte cap matches the shared manifest pagination cap', () => {
  assert.equal(MAX_RECIPE_CANONICAL_BYTES, PAGINATION.MAX_MANIFEST_BYTES);
});

// ── 4. Store contract parity ────────────────────────────────────────────────

/**
 * Minimal transactional Firestore fake — enough surface for the recipe plane:
 * collection/doc/get/set/create/where/orderBy/limit/count + runTransaction
 * with read-before-write semantics and optimistic retry on conflict.
 */
function createFirestoreFake() {
  const collections = new Map();
  const colData = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const snapshotOf = (id, data) => ({
    id,
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : structuredClone(data)),
  });

  function makeQuery(name, { filters = [], order = null, cap = Infinity } = {}) {
    const run = () => {
      let rows = [...colData(name).entries()].map(([id, data]) => ({ id, data }));
      for (const [field, op, value] of filters) {
        rows = rows.filter(({ data }) => {
          const actual = data?.[field];
          if (op === '==') return actual === value;
          if (op === '>') return actual > value;
          if (op === '>=') return actual >= value;
          return false;
        });
      }
      if (order) {
        const [field, dir] = order;
        rows.sort((a, b) => {
          const cmp = String(a.data?.[field] ?? '').localeCompare(String(b.data?.[field] ?? ''));
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return rows.slice(0, cap);
    };
    return {
      where: (field, op, value) => makeQuery(name, { filters: [...filters, [field, op, value]], order, cap }),
      orderBy: (field, dir = 'asc') => makeQuery(name, { filters, order: [field, dir], cap }),
      limit: (n) => makeQuery(name, { filters, order, cap: n }),
      get: async () => ({ docs: run().map(({ id, data }) => ({ ...snapshotOf(id, data), ref: makeDoc(name, id) })) }),
      count: () => ({ get: async () => ({ data: () => ({ count: run().length }) }) }),
    };
  }

  function makeDoc(name, id) {
    return {
      id,
      get: async () => snapshotOf(id, colData(name).get(id)),
      set: async (data, opts = {}) => {
        const existing = colData(name).get(id);
        colData(name).set(id, opts.merge && existing ? { ...existing, ...structuredClone(data) } : structuredClone(data));
      },
      create: async (data) => {
        if (colData(name).has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
        colData(name).set(id, structuredClone(data));
      },
      delete: async () => {
        colData(name).delete(id);
      },
    };
  }

  const firestore = {
    collection: (name) => ({
      doc: (id) => makeDoc(name, id),
      ...makeQuery(name),
    }),
    runTransaction: async (fn) => {
      // Serial execution with a write-set applied atomically at commit;
      // reads see committed state. Retries once on a create conflict.
      const writes = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => { writes.push(() => ref.set(data, opts)); },
        create: (ref, data) => { writes.push(() => ref.create(data)); },
      };
      const result = await fn(tx);
      for (const write of writes) await write();
      return result;
    },
  };
  return firestore;
}

function recipeFixture(overrides = {}) {
  return sharedManifest.validateRecipe({
    schema: 'frostbyte.recipe',
    version: 2,
    id: 'parity-recipe',
    title: 'Parity Q4_K_M server',
    kind: 'tmux',
    publisher: 'a'.repeat(64),
    session: 'parity',
    argv: ['llama-server', '-m', 'models/parity.gguf'],
    files: [{ path: 'models/parity.gguf', size: 10, sha256: 'b'.repeat(64) }],
    description: 'Parity fixture.',
    modelRef: { repoId: 'org/parity-GGUF', revision: 'c'.repeat(40), variant: 'Q4_K_M' },
    license: { id: 'apache-2.0', statement: 'Apache License 2.0' },
    createdAt: '2026-10-18T11:00:00.000Z',
    ...overrides,
  });
}

test('REQUIRED_STORE_METHODS is implemented by BOTH stores (parity assertion — review D1)', () => {
  const memory = createMemoryStore();
  const firestore = createFirestoreStore({ firestore: createFirestoreFake() });
  for (const method of REQUIRED_STORE_METHODS) {
    assert.equal(typeof memory[method], 'function', `memory store missing ${method}`);
    assert.equal(typeof firestore[method], 'function', `firestore store missing ${method}`);
  }
});

test('recipe plane behaves identically on memory and Firestore backends', async () => {
  const manifest = recipeFixture();
  const digest = sharedManifest.canonicalDigest(manifest);
  const signature = Buffer.alloc(64, 7).toString('base64');
  const now = () => Date.parse('2026-10-18T12:00:00.000Z');
  const stores = {
    memory: createMemoryStore({ now }),
    firestore: createFirestoreStore({ firestore: createFirestoreFake(), now }),
  };

  for (const [label, store] of Object.entries(stores)) {
    // Publish → head pinned, change seq 1.
    const published = await store.publishRecipe({ manifest, digest, signature, ownerUid: 'u1', terms: SHARED_TERMS, nowMs: now() });
    assert.equal(published.ok, true, label);
    assert.equal(published.head.ownerUid, 'u1', label);
    assert.equal(published.head.currentVersion, 1, label);
    assert.equal(published.head.signature, signature, label);
    assert.equal(published.change.type, 'recipe.published', label);
    assert.equal(published.change.seq, 1, label);

    // Idempotent same-digest republish.
    const again = await store.publishRecipe({ manifest, digest, signature, ownerUid: 'u1', terms: SHARED_TERMS, nowMs: now() });
    assert.equal(again.idempotent, true, label);

    // Cross-uid collision.
    const collision = await store.publishRecipe({ manifest, digest, signature, ownerUid: 'u2', terms: SHARED_TERMS, nowMs: now() });
    assert.deepEqual({ ok: collision.ok, code: collision.code }, { ok: false, code: 'not_owner' }, label);

    // New revision by the owner.
    const v2 = recipeFixture({ title: 'Parity Q4_K_M server v2' });
    const v2digest = sharedManifest.canonicalDigest(v2);
    const revised = await store.publishRecipe({ manifest: v2, digest: v2digest, signature, ownerUid: 'u1', terms: SHARED_TERMS, nowMs: now() });
    assert.equal(revised.head.currentVersion, 2, label);
    assert.equal(revised.change.seq, 2, label);
    const oldManifest = await store.getRecipeManifest(digest);
    assert.equal(oldManifest.manifest.title, manifest.title, `${label}: old digest immutable`);

    // Search: verbatim quant, tombstone exclusion after withdraw.
    const found = await store.listRecipes({ quant: 'Q4_K_M', limit: 25 });
    assert.equal(found.items.length, 1, label);
    const wrongCase = await store.listRecipes({ quant: 'q4_k_m', limit: 25 });
    assert.equal(wrongCase.items.length, 0, label);

    // Withdraw: owner pin, idempotency, tombstone.
    const stranger = await store.withdrawRecipe(manifest.id, 'u2', { nowMs: now() });
    assert.deepEqual({ ok: stranger.ok, code: stranger.code }, { ok: false, code: 'not_owner' }, label);
    const withdrawn = await store.withdrawRecipe(manifest.id, 'u1', { nowMs: now() });
    assert.equal(withdrawn.ok, true, label);
    assert.equal(withdrawn.change.type, 'recipe.withdrawn', label);
    assert.equal(withdrawn.change.seq, 3, label);
    const repeat = await store.withdrawRecipe(manifest.id, 'u1', { nowMs: now() });
    assert.equal(repeat.already, true, label);

    // Tombstone blocks republish; search excludes it; digest stays readable.
    const replay = await store.publishRecipe({ manifest, digest, signature, ownerUid: 'u1', terms: SHARED_TERMS, nowMs: now() });
    assert.deepEqual({ ok: replay.ok, code: replay.code }, { ok: false, code: 'withdrawn' }, label);
    const empty = await store.listRecipes({ limit: 25 });
    assert.equal(empty.items.length, 0, label);
    assert.ok(await store.getRecipeManifest(digest), label);

    // Changes log: append-only, numeric cursor, exact vocabulary.
    const changes = await store.listRecipeChanges({ limit: 50 });
    assert.deepEqual(changes.items.map(c => c.type), ['recipe.published', 'recipe.published', 'recipe.withdrawn'], label);
    assert.deepEqual(changes.items.map(c => c.seq), [1, 2, 3], label);
    assert.equal(changes.nextCursor, null, label);
    const page1 = await store.listRecipeChanges({ limit: 2 });
    assert.equal(page1.nextCursor, '2', label);
    const page2 = await store.listRecipeChanges({ limit: 2, cursor: '2' });
    assert.equal(page2.items.length, 1, label);

    // Force takedown marks the head; the CURRENT digest's heads carry the flag.
    const takedown = await store.withdrawRecipe(manifest.id, 'operator', { nowMs: now(), force: true });
    assert.equal(takedown.head.takedown, true, label);
    const heads = await store.listRecipeHeadsByDigest(v2digest);
    assert.ok(heads.some(head => head.takedown === true), label);

    // Update feed round-trips verbatim.
    const envelope = { version: 1, engines: [], recipes: [], configs: [], containers: [], signature: 'sig', feedPubKey: 'd'.repeat(64) };
    await store.setUpdateFeed(envelope);
    const stored = await store.getUpdateFeed();
    for (const key of Object.keys(envelope)) assert.deepEqual(stored[key], envelope[key], `${label}: feed field ${key}`);
  }
});

test('COLLECTIONS covers every recipe-plane collection used by the stores', () => {
  for (const name of ['recipes', 'recipeManifests', 'recipeChanges', 'updateFeed']) {
    assert.ok(Object.values(COLLECTIONS).includes(name), `COLLECTIONS missing ${name}`);
  }
});

// ── 5. P3 community plane: constants drift + store parity ──────────────────

import {
  FOLLOW_CAP as SERVER_FOLLOW_CAP,
  PINNED_ANNOUNCEMENT_CAP as SERVER_PINNED_CAP,
  RECIPE_SCAN_WINDOW as SERVER_SCAN_WINDOW,
  feedCreatorProjection as serverFeedCreator,
} from '../platform/functions/src/store/contract.js';
import {
  FOLLOW_CAP as SHARED_FOLLOW_CAP,
  PINNED_ANNOUNCEMENT_CAP as SHARED_PINNED_CAP,
  RECIPE_SCAN_WINDOW as SHARED_SCAN_WINDOW,
  HUB_ROUTES,
} from '../src/shared/hub-protocol.js';

test('P3 constants match between shared hub-protocol and the deployed contract', () => {
  assert.equal(SERVER_FOLLOW_CAP, SHARED_FOLLOW_CAP);
  assert.equal(SERVER_PINNED_CAP, SHARED_PINNED_CAP);
  assert.equal(SERVER_SCAN_WINDOW, SHARED_SCAN_WINDOW);
  assert.equal(HUB_ROUTES.feed, '/v1/feed');
  assert.equal(HUB_ROUTES.announcements, '/v1/announcements');
  assert.equal(HUB_ROUTES.meFollows, '/v1/me/follows');
  assert.equal(HUB_ROUTES.follow, '/v1/follows/:pubkey');
});

test('P3 COLLECTIONS covers announcements, releaseNotes, follows', () => {
  for (const name of ['announcements', 'releaseNotes', 'follows']) {
    assert.ok(Object.values(COLLECTIONS).includes(name), `COLLECTIONS missing ${name}`);
  }
});

test('feedCreatorProjection is a strict public subset (PII boundary, both stores feed it)', () => {
  const user = {
    uid: 'u1', handle: 'crafter', displayName: 'Crafter', photoUrl: 'https://x/p.png',
    email: 'secret@example.com', emailLower: 'secret@example.com', tier: 'pro',
    tenantId: 't1', roles: ['user'], bio: 'private',
  };
  const projection = serverFeedCreator({ pubKey: 'a'.repeat(64), user, binding: { uid: 'u1' } });
  assert.deepEqual(Object.keys(projection).sort(), ['displayName', 'handle', 'photoUrl', 'pubkey', 'verified']);
  assert.equal(projection.verified, true);
  // Deleted account → key-only, unverified, no ghost identity.
  const ghost = serverFeedCreator({ pubKey: 'a'.repeat(64), user: null, binding: { uid: 'u1' } });
  assert.equal(ghost.verified, false);
  assert.equal(ghost.handle, '');
});

test('P3 content plane behaves identically on memory and Firestore backends', async () => {
  const now = () => Date.parse('2026-11-17T12:00:00.000Z');
  const stores = {
    memory: createMemoryStore({ now }),
    firestore: createFirestoreStore({ firestore: createFirestoreFake(), now }),
  };
  for (const [label, store] of Object.entries(stores)) {
    // Announcements: pinned cap, publishedAt preservation, delete semantics.
    for (let i = 1; i <= 3; i += 1) {
      const res = await store.putAnnouncement({ id: `pin-${i}`, title: `Pin ${i}`, body: 'Body', pinned: true, authorUid: 'op' });
      assert.equal(res.ok, true, label);
    }
    const capped = await store.putAnnouncement({ id: 'pin-4', title: 'Over', body: 'Body', pinned: true, authorUid: 'op' });
    assert.deepEqual({ ok: capped.ok, code: capped.code }, { ok: false, code: 'pinned_cap' }, label);
    const listed = await store.listAnnouncements({ limit: 20 });
    // All three share the fixed clock — assert the pinned set, not tie order.
    assert.deepEqual(listed.map(a => a.id).sort(), ['pin-1', 'pin-2', 'pin-3'], `${label}: pinned-first set`);
    assert.ok(listed.every(a => a.pinned === true), label);
    const edited = await store.putAnnouncement({ id: 'pin-1', title: 'Edited', body: 'New body', pinned: true });
    assert.equal(edited.ok, true, label);
    assert.equal(edited.announcement.publishedAt, new Date(now()).toISOString(), `${label}: publishedAt preserved`);
    assert.equal(edited.announcement.authorUid, 'op', `${label}: authorUid preserved`);
    assert.equal(await store.deleteAnnouncement('pin-1'), true, label);
    assert.equal(await store.deleteAnnouncement('pin-1'), false, label);

    // Release notes: version-keyed, released-DESC order.
    await store.putReleaseNote({ version: '1.9.0', released: '2026-10-01', title: 'Old', body: 'Old notes', authorUid: 'op' });
    await store.putReleaseNote({ version: '2.0.0', released: '2026-11-15', title: 'New', body: 'New notes', current: true, authorUid: 'op' });
    const releases = await store.listReleaseNotes({ limit: 5 });
    assert.deepEqual(releases.map(r => r.version), ['2.0.0', '1.9.0'], label);
    assert.equal(await store.deleteReleaseNote('1.9.0'), true, label);
    assert.equal(await store.deleteReleaseNote('1.9.0'), false, label);

    // Follows: idempotent add, cap, private listing, public count, cleanup.
    const key = 'a'.repeat(64);
    const first = await store.addFollow('u1', key);
    assert.equal(first.ok, true, label);
    assert.equal(first.already, false, label);
    const again = await store.addFollow('u1', key);
    assert.equal(again.already, true, label);
    assert.equal(await store.countFollowers(key), 1, label);
    assert.equal((await store.listFollowsForUser('u2')).length, 0, `${label}: graph is per-user`);
    for (let i = 0; i < SHARED_FOLLOW_CAP; i += 1) {
      const res = await store.addFollow('u2', i.toString(16).padStart(64, '0'));
      assert.equal(res.ok, true, label);
    }
    const over = await store.addFollow('u2', 'f'.repeat(64));
    assert.deepEqual({ ok: over.ok, code: over.code }, { ok: false, code: 'follow_cap' }, label);
    assert.equal(await store.removeFollow('u1', key), true, label);
    assert.equal(await store.removeFollow('u1', key), false, label);
    assert.equal(await store.countFollowers(key), 0, label);
    assert.equal(await store.deleteFollowsForUser('u2'), SHARED_FOLLOW_CAP, label);

    // Following-feed filter: ONE scan against a publisher set.
    const manifestA = recipeFixture({ id: 'parity-a', publisher: 'a'.repeat(64) });
    const manifestB = recipeFixture({ id: 'parity-b', publisher: 'b'.repeat(64), modelRef: { repoId: 'org/other-GGUF', revision: 'd'.repeat(40), variant: 'Q4_K_M' } });
    const sig = Buffer.alloc(64, 7).toString('base64');
    await store.publishRecipe({ manifest: manifestA, digest: sharedManifest.canonicalDigest(manifestA), signature: sig, ownerUid: 'u1', terms: SHARED_TERMS, nowMs: now() });
    await store.publishRecipe({ manifest: manifestB, digest: sharedManifest.canonicalDigest(manifestB), signature: sig, ownerUid: 'u2', terms: SHARED_TERMS, nowMs: now() });
    const filtered = await store.listRecipes({ publishers: ['b'.repeat(64)], limit: 25 });
    assert.deepEqual(filtered.items.map(r => r.id), ['parity-b'], label);
    const none = await store.listRecipes({ publishers: [], limit: 25 });
    assert.equal(none.items.length, 0, `${label}: empty follow set → empty feed`);
    assert.equal(await store.countRecipesByPublisher('a'.repeat(64)), 1, label);
  }
});

test('memory store mirrors the Firestore scan window (no test-only rows beyond the ceiling)', async () => {
  const now = () => Date.parse('2026-11-17T12:00:00.000Z');
  const store = createMemoryStore({ now });
  const sig = Buffer.alloc(64, 7).toString('base64');
  // Publish one row OLDER than the window, then fill the window with newer rows.
  const old = recipeFixture({ id: 'old-row', createdAt: '2026-01-01T00:00:00.000Z' });
  await store.publishRecipe({ manifest: old, digest: sharedManifest.canonicalDigest(old), signature: sig, ownerUid: 'u1', terms: SHARED_TERMS, nowMs: Date.parse('2026-01-01T00:00:00.000Z') });
  for (let i = 0; i < SHARED_SCAN_WINDOW; i += 1) {
    const m = recipeFixture({
      id: `fill-${i}`,
      modelRef: { repoId: `org/fill-${i}`, revision: 'c'.repeat(40), variant: 'Q4_K_M' },
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    await store.publishRecipe({ manifest: m, digest: sharedManifest.canonicalDigest(m), signature: sig, ownerUid: 'u1', terms: SHARED_TERMS, nowMs: Date.parse('2026-06-01T00:00:00.000Z') + i });
  }
  const page = await store.listRecipes({ limit: 100 });
  assert.ok(!page.items.some(r => r.id === 'old-row'), 'row beyond the scan window must not be visible');
});