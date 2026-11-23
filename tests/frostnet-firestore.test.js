import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FirestoreDirectory } from '../frostnet/functions/firestore-directory.js';
import { validateRelease, FROSTNET_TERMS } from '../src/shared/release-manifest.js';
import { manifestDigest } from '../src/main/publications.js';
const require = createRequire(new URL('../frostnet/functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app'), { getFirestore } = require('firebase-admin/firestore');
test('real Firestore emulator: atomic idempotency, query pagination, immutable variants and withdrawal feed', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async t => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST, /^(127\.0\.0\.1|localhost):/);
  const app = initializeApp({ projectId: 'demo-frostnet-test' }, 'frostnet-qa'), db = getFirestore(app, 'frostnet'); t.after(async () => { await db.terminate(); await deleteApp(app); });
  const storage = new FirestoreDirectory(db);
  const manifest = validateRelease({ schema: 'frostbyte.release', version: 1, publisher: 'blackfrost', release: 'atomic-v1', variant: 'q4', name: 'Atomic fixture', origin: 'original', files: [{ path: 'model.gguf', size: 4, sha256: 'a'.repeat(64) }], license: { id: 'MIT', statement: 'Local test only' }, torrent: { infohash_v1: 'b'.repeat(40), metainfo_sha256: 'c'.repeat(64), piece_length: 16384 }, verified_at: '2026-10-10T00:00:00Z', redistribution_confirmed: true });
  const digest = manifestDigest(manifest), request = { key: 'd'.repeat(64), digest, manifest, publisher: 'blackfrost', withdrawing: false, now: Date.now(), terms: FROSTNET_TERMS };
  const [a, b] = await Promise.all([storage.submit(request), storage.submit(request)]); assert.deepEqual(a, b);
  assert.equal((await storage.search({ q: 'ato', limit: 1, cursor: '' })).items[0].digest, digest);
  assert.equal((await storage.changes('0', 100)).changes.length, 1);
  await assert.rejects(storage.submit({ ...request, key: 'e'.repeat(64), digest: 'f'.repeat(64) }), /Immutable/);
  await storage.submit({ ...request, key: 'f'.repeat(64), withdrawing: true, manifest: undefined });
  assert.equal((await storage.search({ q: '', limit: 10, cursor: '' })).items.length, 0);
  assert.equal((await storage.get('releases', digest)).status, 'withdrawn');
  assert.equal((await storage.changes('1', 100)).changes[0].status, 'withdrawn');
  if (process.env.FROSTNET_EMULATOR_BACKUP_DIR) {
    const directory = process.env.FROSTNET_EMULATOR_BACKUP_DIR; assert.equal(path.isAbsolute(directory), true); fs.mkdirSync(directory, { recursive: true });
    // Firebase CLI 15.9's export-on-exit exports only (default). Explicitly
    // export the named database so the restore drill cannot pass on an empty DB.
    const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-frostnet-test:export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ database: 'projects/demo-frostnet-test/databases/frostnet', export_directory: directory, export_name: 'frostnet_export' }),
    });
    assert.equal(response.status, 200, await response.text());
  }
});
