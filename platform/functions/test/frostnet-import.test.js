/**
 * P2.3 legacy FrostNet retirement — operator-vouched admin import route.
 *
 * Drives the REAL handler (memory store, real Ed25519 crypto, real router).
 * Trust invariants under test (legacy FrostNet retirement, 2026-11-17):
 *   - admin gate: interactive firebase + frostbyteAdmin + active record +
 *     fresh step-up + audit reason, exactly like takedown
 *   - original publisher key + signature preserved end-to-end (never re-keyed)
 *   - server re-validates manifest, recomputes digest, independently verifies
 *     the signature — client claims are never trusted
 *   - ownerUid = original publisher's bound account when present, else the
 *     importing operator (vouching)
 *   - idempotent per digest; withdrawn ids stay tombstoned; not_owner refuses
 *   - per-record provenance audit entry (migratedFrom, legacySeq, importedAt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { harness, FIXED_NOW, userFixture } from './harness.js';
import { validateRecipe, canonicalDigest, recipeSigningBytes } from '../src/recipe-manifest.js';

const OTHER_UID = 'user_other';

function makePublisherIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubKey = spki.subarray(spki.length - 32).toString('hex');
  return {
    pubKey,
    privateKey,
    signB64: (bytes) => cryptoSign(null, bytes, privateKey).toString('base64'),
  };
}

function recipeFixture(pubKey, overrides = {}) {
  const base = {
    schema: 'frostbyte.recipe',
    version: 2,
    id: 'legacy-llama3-8b',
    title: 'Legacy Llama3-8B Q4_K_M server',
    kind: 'tmux',
    publisher: pubKey,
    session: 'llama3',
    argv: ['llama-server', '-m', 'models/llama3-8b-q4_k_m.gguf', '--port', '8080'],
    files: [{ path: 'models/llama3-8b-q4_k_m.gguf', size: 2048, sha256: 'c'.repeat(64) }],
    description: 'Migrated from the legacy frostnet-si deployment.',
    modelRef: { repoId: 'bartowski/Meta-Llama-3-8B-Instruct-GGUF', revision: 'd'.repeat(40), variant: 'Q4_K_M' },
    license: { id: 'llama3', statement: 'Meta Llama 3 Community License' },
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
  return validateRecipe(base);
}

/** A legacy export record: manifest + digest + original signature + provenance. */
function legacyRecord(identity, manifest, overrides = {}) {
  const digest = canonicalDigest(manifest);
  const signature = identity.signB64(recipeSigningBytes({ digest, pubkey: manifest.publisher, timestamp: manifest.createdAt }));
  return { id: manifest.id, manifest, digest, signature, legacySeq: 7, ...overrides };
}

async function adminHarness() {
  const h = await harness();
  await h.store.setAdmin(h.uid, { role: 'admin', status: 'active', email: 'admin@example.com' });
  return h;
}

function importBody(records, overrides = {}) {
  return { reason: 'Legacy frostnet-si retirement migration, operator-vouched.', records, ...overrides };
}

async function postImport(h, body, token = 'admin-token') {
  return h.request({ method: 'POST', url: '/v1/admin/frostnet-import', body, token });
}

// ── Admin gate ───────────────────────────────────────────────────────────────

test('import gate: non-admin refused, missing reason refused, stale step-up refused', async () => {
  const h = await adminHarness();
  const id = makePublisherIdentity();
  const record = legacyRecord(id, recipeFixture(id.pubKey));

  // Plain user (no frostbyteAdmin claim) → 403 before any record is touched.
  const plain = await postImport(h, importBody([record]), 'valid-token');
  assert.equal(plain.statusCode, 403);
  assert.equal(plain.json().error.code, 'admin_forbidden');
  assert.equal(await h.store.getRecipeHead(record.id), null);

  // Admin but no audit reason → 400.
  const noReason = await postImport(h, { records: [record] });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.json().error.code, 'audit_reason_required');

  // Admin with a stale password auth → step-up required.
  const stale = await postImport(h, importBody([record]), 'admin-token-stale');
  assert.equal(stale.statusCode, 403);
  assert.equal(stale.json().error.code, 'admin_reauth_required');
  assert.equal(await h.store.getRecipeHead(record.id), null);
});

// ── Happy path + provenance ─────────────────────────────────────────────────

test('import happy path: original key+signature preserved, operator vouches, audited, searchable', async () => {
  const h = await adminHarness();
  const id = makePublisherIdentity();
  const manifest = recipeFixture(id.pubKey);
  const record = legacyRecord(id, manifest);

  const res = await postImport(h, importBody([record], { source: 'frostnet-si' }));
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.ok, true);
  assert.equal(json.total, 1);
  assert.equal(json.imported, 1);
  assert.equal(json.refused, 0);
  assert.equal(json.results[0].outcome, 'imported');
  assert.equal(json.results[0].digest, record.digest);
  assert.equal(json.results[0].ownerUid, h.uid); // unbound key → importing operator

  const head = await h.store.getRecipeHead(record.id);
  assert.equal(head.publisher, id.pubKey); // ORIGINAL publisher preserved
  assert.equal(head.signature, record.signature); // ORIGINAL signature preserved
  assert.equal(head.digest, record.digest);
  assert.equal(head.ownerUid, h.uid);

  // Provenance receipt in the immutable audit log.
  const audit = await h.store.listAudit();
  const entry = audit.find((a) => a.action === 'recipe.import' && a.targetId === record.id);
  assert.ok(entry, 'import must be audited');
  assert.equal(entry.actorUid, h.uid);
  assert.equal(entry.after.migratedFrom, 'frostnet-si');
  assert.equal(entry.after.legacySeq, 7);
  assert.equal(entry.after.publisher, id.pubKey);
  assert.equal(entry.after.digest, record.digest);

  // The migrated recipe is a first-class citizen: search + GET + manifest fetch.
  const search = await h.request({ url: '/v1/search?q=llama3', auth: false });
  assert.ok(search.json().items.some((item) => item.id === record.id));
  assert.equal((await h.request({ url: `/v1/recipes/${record.id}`, auth: false })).statusCode, 200);
  const fetched = await h.request({ url: `/v1/manifests/${record.digest}`, auth: false });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().signature, record.signature);
});

test('import owner resolution: bound publisher key wins over the importing operator', async () => {
  const h = await adminHarness();
  const id = makePublisherIdentity();
  await h.store.setUser(OTHER_UID, userFixture({ uid: OTHER_UID, email: 'other@example.com' }));
  await h.store.setPublisherKey(id.pubKey, OTHER_UID);
  const record = legacyRecord(id, recipeFixture(id.pubKey));

  const res = await postImport(h, importBody([record]));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().results[0].ownerUid, OTHER_UID);
  const head = await h.store.getRecipeHead(record.id);
  assert.equal(head.ownerUid, OTHER_UID);
  assert.equal(head.publisher, id.pubKey);
});

// ── Idempotency + tombstones ────────────────────────────────────────────────

test('import is idempotent per digest; re-import never advances the revision', async () => {
  const h = await adminHarness();
  const id = makePublisherIdentity();
  const record = legacyRecord(id, recipeFixture(id.pubKey));

  const first = await postImport(h, importBody([record]));
  assert.equal(first.json().imported, 1);
  const second = await postImport(h, importBody([record]));
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().imported, 0);
  assert.equal(second.json().idempotent, 1);
  assert.equal(second.json().results[0].outcome, 'idempotent');
  const head = await h.store.getRecipeHead(record.id);
  assert.equal(head.currentVersion, 1);
});

test('withdrawn ids stay tombstoned: re-import refuses, GET stays 410', async () => {
  const h = await adminHarness();
  const id = makePublisherIdentity();
  const record = legacyRecord(id, recipeFixture(id.pubKey));
  assert.equal((await postImport(h, importBody([record]))).json().imported, 1);

  // Operator takedown of the migrated recipe.
  const takedown = await h.request({
    method: 'POST', url: `/v1/admin/recipes/${record.id}/withdraw`,
    body: { reason: 'Migrated record reported malicious after review.' }, token: 'admin-token',
  });
  assert.equal(takedown.statusCode, 200);

  // Re-importing the SAME legacy record must NOT resurrect it.
  const again = await postImport(h, importBody([record]));
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().imported, 0);
  assert.equal(again.json().refused, 1);
  assert.equal(again.json().results[0].code, 'withdrawn');
  assert.equal((await h.request({ url: `/v1/recipes/${record.id}`, auth: false })).statusCode, 410);
});

test('not_owner refusal: an id already owned by another account cannot be migrated over', async () => {
  const h = await adminHarness();
  const idA = makePublisherIdentity();
  const idB = makePublisherIdentity();
  // Account OTHER owns the id via a bound key.
  await h.store.setUser(OTHER_UID, userFixture({ uid: OTHER_UID, email: 'other@example.com' }));
  await h.store.setPublisherKey(idA.pubKey, OTHER_UID);
  const owned = legacyRecord(idA, recipeFixture(idA.pubKey));
  assert.equal((await postImport(h, importBody([owned]))).json().results[0].ownerUid, OTHER_UID);

  // A DIFFERENT key signs the same id; operator-vouched import must refuse
  // rather than steal the id from its owner.
  const thief = legacyRecord(idB, recipeFixture(idB.pubKey));
  const res = await postImport(h, importBody([thief]));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().refused, 1);
  assert.equal(res.json().results[0].code, 'not_owner');
  const head = await h.store.getRecipeHead(owned.id);
  assert.equal(head.ownerUid, OTHER_UID);
  assert.equal(head.publisher, idA.pubKey);
});

// ── Zero-trust record validation ────────────────────────────────────────────

test('bad signature refused; nothing written; other records in the batch still import', async () => {
  const h = await adminHarness();
  const good = makePublisherIdentity();
  const evil = makePublisherIdentity();
  const goodRecord = legacyRecord(good, recipeFixture(good.pubKey));
  // Manifest claims evil's key but carries good's signature → must fail verify.
  const forgedManifest = recipeFixture(evil.pubKey, { id: 'forged-record' });
  const forged = {
    id: 'forged-record', manifest: forgedManifest,
    digest: canonicalDigest(forgedManifest),
    signature: goodRecord.signature, // wrong key for this manifest
  };

  const res = await postImport(h, importBody([forged, goodRecord]));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().imported, 1);
  assert.equal(res.json().refused, 1);
  const refused = res.json().results.find((r) => r.id === 'forged-record');
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'signature_invalid');
  assert.equal(await h.store.getRecipeHead('forged-record'), null);
  assert.ok(await h.store.getRecipeHead(goodRecord.id));
});

test('digest claim mismatch, missing createdAt, and invalid manifest are all refused per-record', async () => {
  const h = await adminHarness();
  const id = makePublisherIdentity();
  const manifest = recipeFixture(id.pubKey);
  const record = legacyRecord(id, manifest);

  const badDigest = { ...record, id: manifest.id, digest: 'f'.repeat(64) };
  const noCreatedAtManifest = recipeFixture(id.pubKey, { id: 'no-created-at' });
  delete noCreatedAtManifest.createdAt;
  const noCreatedAt = { id: 'no-created-at', manifest: noCreatedAtManifest, signature: record.signature };
  const badManifest = { id: 'bad-manifest', manifest: { schema: 'not.a.recipe' }, signature: record.signature };

  const res = await postImport(h, importBody([badDigest, noCreatedAt, badManifest]));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().imported, 0);
  assert.equal(res.json().refused, 3);
  const codes = Object.fromEntries(res.json().results.map((r) => [r.id, r.code]));
  assert.equal(codes[manifest.id], 'digest_mismatch');
  assert.equal(codes['no-created-at'], 'created_at_required');
  assert.equal(codes['bad-manifest'], 'manifest_invalid');
  assert.equal(await h.store.getRecipeHead(manifest.id), null);
});

test('batch shape: empty records and >200 records are refused before any write', async () => {
  const h = await adminHarness();
  const empty = await postImport(h, importBody([]));
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error.code, 'records_required');

  const id = makePublisherIdentity();
  const record = legacyRecord(id, recipeFixture(id.pubKey));
  const tooMany = await postImport(h, importBody(Array.from({ length: 201 }, () => record)));
  assert.equal(tooMany.statusCode, 400);
  assert.equal(tooMany.json().error.code, 'batch_too_large');
  assert.equal(await h.store.getRecipeHead(record.id), null);
});

test('migrated recipe supports owner actions afterwards (bound account can withdraw)', async () => {
  const h = await adminHarness();
  const id = makePublisherIdentity();
  const record = legacyRecord(id, recipeFixture(id.pubKey));
  assert.equal((await postImport(h, importBody([record]))).json().imported, 1);

  // Operator-vouched import pins ownerUid to the operator; the operator's
  // session can then self-withdraw through the normal owner route.
  const withdraw = await h.request({ method: 'DELETE', url: `/v1/recipes/${record.id}` });
  assert.equal(withdraw.statusCode, 200);
  assert.equal((await h.request({ url: `/v1/recipes/${record.id}`, auth: false })).statusCode, 410);
});