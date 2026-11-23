import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { FirestoreDirectory } from '../frostnet/functions/firestore-directory.js';
import { manifestDigest } from '../src/main/publications.js';
import { FROSTNET_TERMS } from '../src/shared/release-manifest.js';
const require = createRequire(new URL('../frostnet/functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app'), { getFirestore } = require('firebase-admin/firestore');

test('fresh Firestore emulator restores exported manifests, receipts, identities and withdrawal history', { skip: process.env.FROSTNET_RESTORE_FIXTURE !== '1' }, async t => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST, /^(127\.0\.0\.1|localhost):/);
  const directory = process.env.FROSTNET_EMULATOR_BACKUP_DIR;
  assert.ok(directory && path.isAbsolute(directory));
  assert.ok(fs.existsSync(path.join(directory, 'frostnet_export', 'frostnet_export.overall_export_metadata')));
  const imported = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-frostnet-test:import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ database: 'projects/demo-frostnet-test/databases/frostnet', export_directory: path.join(directory, 'frostnet_export', 'frostnet_export.overall_export_metadata') }),
  });
  assert.equal(imported.status, 200, await imported.text());
  const app = initializeApp({ projectId: 'demo-frostnet-test' }, 'frostnet-restore'), db = getFirestore(app, 'frostnet');
  t.after(async () => { await db.terminate(); await deleteApp(app); });
  const storage = new FirestoreDirectory(db), receipt = await storage.get('submissions', 'd'.repeat(64));
  assert.equal(receipt.status, 'published');
  const manifest = await storage.get('manifests', receipt.digest);
  assert.equal(manifestDigest(manifest), receipt.digest);
  assert.equal((await storage.get('releases', receipt.digest)).status, 'withdrawn');
  assert.equal((await storage.search({ q: '', limit: 10, cursor: '' })).items.length, 0);
  const request = { key: 'f'.repeat(64), digest: receipt.digest, publisher: 'blackfrost', withdrawing: true, now: Date.now(), terms: FROSTNET_TERMS };
  assert.equal((await storage.submit(request)).status, 'withdrawn');
  assert.equal((await storage.changes('0', 100)).changes.length, 2, 'restored idempotency receipt prevents duplicate history');
  await assert.rejects(storage.submit({ ...request, key: 'e'.repeat(64), withdrawing: false, manifest, digest: 'f'.repeat(64) }), /Immutable/);
});
