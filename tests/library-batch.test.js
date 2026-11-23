import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLibraryBatch } from '../src/main/library-batch.js';
function fixture(options = {}) {
  const rows = [{ id: 'same', device: 'spark', deviceId: 'a', path: '/models/a', name: 'A' }, { id: 'same', device: 'spark', deviceId: 'b', path: '/models/b', name: 'B' }];
  const calls = []; let handler;
  registerLibraryBatch({ handle: (_, fn) => { handler = fn; }, resolve: request => {
    const row = rows.find(row => row.id === request.id && row.device === request.device && row.deviceId === request.deviceId);
    if (!row) throw new Error('Missing copy'); return row;
  }, context: row => row.deviceId, review: async () => ({ response: 1 }), stopSharing: async row => calls.push(['stop', row.deviceId]),
  hide: row => calls.push(['hide', row.deviceId]), state: () => ({}), ...options });
  return { rows, calls, run: (action, items = rows) => handler({ action, items }) };
}
test('bulk hide resolves exact copies, deduplicates, and leaves sharing unchanged', async () => {
  const f = fixture(); const result = await f.run('hide', [...f.rows, f.rows[0]]);
  assert.deepEqual(f.calls, [['hide', 'a'], ['hide', 'b']]); assert.equal(result.results.length, 2);
});
test('remove stops before hiding and reports partial failures without hiding the failed copy', async () => {
  const stops = [], f = fixture({ stopSharing: async row => { stops.push(row.deviceId); if (row.deviceId === 'b') throw new Error('Offline'); } });
  const result = await f.run('remove');
  assert.deepEqual(stops, ['a', 'b']); assert.deepEqual(f.calls, [['hide', 'a']]);
  assert.equal(result.results[1].ok, false); assert.match(result.results[1].error, /Offline/);
});
test('cancelled native review performs no mutations', async () => {
  const f = fixture({ review: async () => ({ response: 0 }) });
  assert.equal((await f.run('remove')).cancelled, true); assert.deepEqual(f.calls, []);
});
test('changed file/device identity is not acted on after review', async () => {
  let generation = 1;
  const f = fixture({ context: () => generation, review: async () => { generation++; return { response: 1 }; } });
  assert.equal((await f.run('remove')).results.every(row => !row.ok), true); assert.deepEqual(f.calls, []);
});
test('missing remote device identity and unsupported file deletion are rejected', async () => {
  const f = fixture();
  await assert.rejects(f.run('hide', [{ device: 'spark', id: 'same' }]), /exact library/);
  await assert.rejects(f.run('delete'), /exact library/);
});
