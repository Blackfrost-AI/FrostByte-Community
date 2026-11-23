import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { prepareHfResume, validateHfResumeIds } from '../src/main/hf-resume.js';
import { hfTransferAuthorization, verifyHfTransferAuthorization } from '../src/main/hf-authorizations.js';

const records = () => ['config.json', 'tokenizer.json'].map((filePath, index) => ({
  id: String(index), repoId: 'owner/model', revision: 'a'.repeat(40), filePath,
  baseDir: path.resolve('test-models'), status: index ? 'error' : 'paused', total: 12, downloaded: index,
}));

test('one resume approval binds every file and remains valid for each resumed worker', () => {
  const rows = records();
  const { authorization, downloadedBytes, status } = prepareHfResume(rows, 'none');
  assert.equal(authorization.fileCount, 2);
  assert.equal(authorization.totalBytes, 24);
  assert.equal(downloadedBytes, 1);
  assert.equal(status, 'paused/error');
  for (const row of rows) {
    const grant = hfTransferAuthorization(authorization, { path: row.filePath, size: row.total });
    assert.deepEqual(verifyHfTransferAuthorization(row, grant, 'none'), grant);
  }
});

test('resume selection rejects mixed versions, destinations, duplicate files and ineligible rows', () => {
  for (const patch of [{ repoId: 'owner/other' }, { revision: 'b'.repeat(40) }, { baseDir: path.resolve('other') },
    { status: 'active' }, { downloaded: 13 }, { filePath: 'config.json' }]) {
    const rows = records(); Object.assign(rows[1], patch);
    assert.throws(() => prepareHfResume(rows, 'none'));
  }
  for (const ids of [[], ['a', 'a'], [null], [''], Array.from({ length: 2001 }, (_, index) => String(index))]) {
    assert.throws(() => validateHfResumeIds(ids));
  }
  assert.throws(() => prepareHfResume([undefined], 'none'));
});

test('device resume uses the companion destination with a bound credential and total progress', () => {
  const rows = records().map(row => ({ ...row, baseDir: undefined, destination: '/media/models' }));
  const generation = `sha256:${'b'.repeat(64)}`;
  const { authorization } = prepareHfResume(rows, generation, { remote: true });
  assert.equal(authorization.root, '/media/models');
  assert.equal(authorization.tokenGeneration, generation);
  assert.equal(authorization.fileCount, 2);
});
