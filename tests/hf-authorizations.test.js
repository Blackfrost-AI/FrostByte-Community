import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createHfDownloadAuthorization, describeHfToken, describeSavedHfCredential,
  hfAuthenticatedEndpoint, hfCredentialStateSnapshot, hfTransferAuthorization,
  verifyHfTransferAuthorization,
} from '../src/main/hf-authorizations.js';

test('submitted tokens have a bounded non-secret network identity', () => {
  const token = 'hf_fixture_secret';
  const fingerprint = createHash('sha256').update(token).digest('hex');
  assert.deepEqual(describeHfToken(token), {
    byteLength: Buffer.byteLength(token), fingerprint, generation: `sha256:${fingerprint}`,
  });
  assert.throws(() => describeHfToken('bad\ntoken'), /invalid/i);
  assert.equal(hfAuthenticatedEndpoint({ action: 'model', repoId: 'owner/model', revision: 'feature/test' }),
    'https://huggingface.co/api/models/owner/model/revision/feature%2Ftest?blobs=true');
  assert.equal(hfAuthenticatedEndpoint({ action: 'refs', repoId: 'owner/model' }),
    'https://huggingface.co/api/models/owner/model/refs');
});

test('credential snapshots fail closed on replacement without exposing the token', () => {
  const state = { hfTokenEnc: 'ciphertext-a', hfUser: 'person', hfRole: 'read', hfTokenMigrationRequired: false };
  const first = describeSavedHfCredential(state, 'hf_first');
  assert.equal(first.snapshot, hfCredentialStateSnapshot(state));
  assert.equal(first.snapshot.includes('hf_first'), false);
  state.hfTokenEnc = 'ciphertext-b';
  assert.notEqual(hfCredentialStateSnapshot(state), first.snapshot);
  assert.notEqual(describeSavedHfCredential(state, 'hf_second').generation, first.generation);
});

test('download authority binds root, pinned revision, normalized manifest, and credential generation', () => {
  const generation = describeHfToken('hf_download').generation;
  const summary = createHfDownloadAuthorization({
    repoId: 'owner/model', revision: 'a'.repeat(40), root: '/tmp/models', generation,
    files: [{ path: 'weights/model.gguf', size: 20 }, { path: 'config.json', size: 4 }],
  });
  const reordered = createHfDownloadAuthorization({
    repoId: 'owner/model', revision: 'a'.repeat(40), root: '/tmp/models', generation,
    files: [{ path: 'config.json', size: 4 }, { path: 'weights/model.gguf', size: 20 }],
  });
  assert.equal(summary.manifestDigest, reordered.manifestDigest);
  assert.equal(summary.requestDigest, reordered.requestDigest);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.totalBytes, 24);

  const record = { repoId: 'owner/model', revision: 'a'.repeat(40), baseDir: '/tmp/models',
    filePath: 'config.json', total: 4 };
  const authority = hfTransferAuthorization(summary, { path: record.filePath, size: record.total });
  assert.deepEqual(verifyHfTransferAuthorization(record, authority, generation), authority);
  assert.throws(() => verifyHfTransferAuthorization({ ...record, baseDir: '/tmp/other' }, authority, generation), /changed/);
  assert.throws(() => verifyHfTransferAuthorization({ ...record, total: 5 }, authority, generation), /changed/);
  assert.throws(() => verifyHfTransferAuthorization(record, authority, 'none'), /credential changed/);
  assert.throws(() => verifyHfTransferAuthorization(record, undefined, generation), /no valid native authorization/);
});
