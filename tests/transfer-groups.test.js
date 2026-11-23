import test from 'node:test';
import assert from 'node:assert/strict';
import { groupHfTransfers } from '../src/renderer/transfer-groups.js';

const row = (id, extra = {}) => ({ id, device: 'spark', sparkHost: 'spark', repoId: 'owner/model', revision: 'a'.repeat(40), destination: '/models', filePath: id, status: 'queued', downloaded: 0, total: 100, ...extra });

test('shards and supporting files share one model card with byte-weighted progress and summed active speed', () => {
  const [group] = groupHfTransfers([
    row('config.json', { status: 'done', total: 1, downloaded: 1, speedBps: 1000 }),
    row('part-1.safetensors', { status: 'active', total: 1000, downloaded: 100, speedBps: 10 }),
    row('part-2.safetensors', { status: 'active', total: 2000, downloaded: 200, speedBps: 20 }),
  ]);
  assert.equal(group.files.length, 3);
  assert.equal(group.progress, 301 / 3001);
  assert.equal(group.speedBps, 30);
  assert.equal(group.etaMs, 90000);
  assert.equal(group.counts.done, 1);
  assert.equal(group.dest, '/models/owner/model');
});
test('the same repository on another device, host, revision or destination stays separate', () => {
  const groups = groupHfTransfers([row('a'), row('b'), row('c', { device: 'local', sparkHost: '' }), row('d', { sparkHost: 'other' }), row('e', { revision: 'b'.repeat(40) }), row('f', { destination: '/external' })]);
  assert.deepEqual(groups.map(group => group.files.length), [2, 1, 1, 1, 1]);
});
test('legacy local destinations are grouped by the model folder, including Windows paths', () => {
  const files = ['config.json', 'weights/part1.safetensors'];
  const groups = groupHfTransfers(files.map(file => row(file, { device: 'local', destination: undefined, dest: 'D:\\Models\\owner\\model\\' + file.replaceAll('/', '\\') })));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].root, 'D:/Models');
});
test('unknown sizes never claim model completion and waiting or failed files suppress completion ETA', () => {
  const [unknown] = groupHfTransfers([row('active', { status: 'active', total: 0, downloaded: 10, speedBps: 10 }), row('done', { status: 'done', downloaded: 100 })]);
  assert.equal(unknown.sizeKnown, false); assert.equal(unknown.complete, false); assert.ok(unknown.progress < 1); assert.equal(unknown.etaMs, 0);
  for (const status of ['paused', 'error']) {
    const [group] = groupHfTransfers([row('active', { status: 'active', speedBps: 10 }), row('waiting', { status })]);
    assert.equal(group.status, 'active'); assert.equal(group.counts[status], 1); assert.equal(group.etaMs, 0);
  }
});
test('offline groups retain bytes but never show a live speed; cancelled rows stay out', () => {
  const [group] = groupHfTransfers([row('active', { offline: true, status: 'active', speedBps: 10, downloaded: 20 }), row('cancelled', { status: 'cancelled' })]);
  assert.equal(group.offline, true); assert.equal(group.speedBps, 0); assert.equal(group.downloaded, 20); assert.equal(group.files.length, 1);
});
test('only all completed files finish a model, including zero-byte supporting files', () => {
  const [group] = groupHfTransfers([row('empty', { status: 'done', total: 0 }), row('weight', { status: 'done', downloaded: 100 })]);
  assert.equal(group.status, 'done'); assert.equal(group.progress, 1); assert.equal(group.sizeKnown, true);
});
