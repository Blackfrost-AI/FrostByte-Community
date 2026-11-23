import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EntryLifecycle } from '../src/main/entry-lifecycle.js';
import { DownloadInventory } from '../src/main/inventory.js';
import { entryContainsCopy, hfGroupInventory, entryIsHidden } from '../src/shared/entry-identity.js';
import { planHfPartials, deleteHfPartials } from '../src/main/hf-partials.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lifecycle-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = { state: {}, _flush() {}, _commitStateFields(patch) { if (this.fail) throw new Error('disk full'); Object.assign(this.state, patch); } };
  const inventory = new DownloadInventory(store), lifecycle = new EntryLifecycle(store);
  const make = (base = root) => { const dest = path.join(base, 'owner/model/nested/model.gguf'); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'model'); const record = { id: base, status: 'done', repoId: 'owner/model', revision: 'a'.repeat(40), filePath: 'nested/model.gguf', baseDir: base, dest, downloaded: 5, total: 5 }; inventory.registerHf(record); return record; };
  return { root, store, inventory, lifecycle, make };
}
test('HF copy matching uses device and exact root, not repository name', () => {
  const a = { device: 'local', repoId: 'owner/model', source: 'hf', path: '/diskA/owner/model' }, b = { ...a, path: '/diskB/owner/model' };
  assert.equal(hfGroupInventory({ device: 'local', repoId: a.repoId, dest: b.path }, [a, b]), b);
});
test('owned directories cover normalized Windows descendants only on their exact device and path boundary', () => {
  const owner = { device: 'local', path: 'C:\\Models\\Owner\\Model\\', directory: true };
  assert.equal(entryContainsCopy(owner, { device: 'local', path: 'c:/models/owner/model/model.gguf' }), true);
  assert.equal(entryContainsCopy(owner, { device: 'local', path: 'C:\\MODELS\\Owner\\Model' }), true);
  assert.equal(entryContainsCopy(owner, { device: 'local', path: 'C:\\Models\\Owner\\Model-extra\\model.gguf' }), false);
  assert.equal(entryContainsCopy(owner, { device: 'local', path: 'D:\\Models\\Owner\\Model\\model.gguf' }), false);
  assert.equal(entryContainsCopy({ ...owner, directory: false }, { device: 'local', path: owner.path + 'child' }), false);
  assert.equal(entryContainsCopy({ ...owner, path: '' }, { device: 'local', path: '/model.gguf' }), false);
  const remote = { ...owner, device: 'spark', deviceId: 'desktop-a' };
  assert.equal(entryContainsCopy(remote, { ...remote, path: 'c:/models/owner/model/model.gguf' }), true);
  assert.equal(entryContainsCopy(remote, { ...remote, deviceId: 'desktop-b', path: 'c:/models/owner/model/model.gguf' }), false);
  assert.equal(entryContainsCopy(owner, { ...remote, deviceId: 'local', path: 'c:/models/owner/model/model.gguf' }), false);
  assert.equal(entryContainsCopy({ ...owner, path: '/models/Model' }, { device: 'local', path: '/models/model/child' }), false);
  assert.equal(entryContainsCopy({ ...owner, path: '\\\\nas\\share\\model' }, { device: 'local', path: '//nas/share/model/child' }), true);
});
test('hide survives re-scan identities; restore is explicit and sharing untouched', t => {
  const { lifecycle, store } = fixture(t); const row = { id: 'hf:one', device: 'local', path: '/disk/model', directory: true };
  lifecycle.hide(row); assert.equal(entryIsHidden({ ...row, id: 'scan:two' }, new EntryLifecycle(store).hidden), true);
  assert.equal(entryIsHidden({ ...row, device: 'spark', deviceId: 'one' }, lifecycle.hidden), false);
  store.fail = true; assert.throws(() => lifecycle.restore(row.id), /disk full/); assert.equal(lifecycle.hidden.length, 1);
  store.fail = false; lifecycle.restore(row.id); assert.equal(lifecycle.hidden.length, 0);
});
test('restoring one hidden device copy does not restore a same-ID copy elsewhere', t => {
  const { lifecycle } = fixture(t), a = { id: 'same', device: 'spark', deviceId: 'A', path: '/models/one' }, b = { ...a, deviceId: 'B' };
  lifecycle.hide(a); lifecycle.hide(b); assert.throws(() => lifecycle.restore('same'), /exact device/);
  lifecycle.restore(b); assert.equal(lifecycle.hidden.length, 1); assert.equal(lifecycle.hidden[0].deviceId, 'A');
});
test('exact deletion retains ownership until one durable reconciliation; copy A survives', t => {
  const { root, store, inventory, lifecycle, make } = fixture(t); const a = make(), b = make(path.join(root, 'driveB')); store.state.hfDownloads = [a, b];
  const row = inventory.list().find(row => row.destination === b.baseDir), id = lifecycle.begin({ ...row, device: 'local' }, 'delete');
  inventory.deleteFiles(inventory.deletionPlan(row.id), { forget: false }); assert.equal(inventory.rows.length, 2);
  lifecycle.step(id, 'files-complete'); store.fail = true; assert.throws(() => lifecycle.finish(id, inventory), /disk full/);
  assert.equal(inventory.rows.length, 2); store.fail = false; new EntryLifecycle(store).recover(inventory);
  assert.equal(inventory.rows.length, 1); assert.equal(store.state.hfDownloads.length, 1); assert.equal(fs.readFileSync(a.dest, 'utf8'), 'model');
  assert.equal(entryIsHidden({ ...row, id: 'scan:new' }, lifecycle.hidden), true);
});
test('missing nested directories remain removable without erasing unrelated files', t => {
  const { inventory, make } = fixture(t); const record = make(); fs.unlinkSync(record.dest); fs.rmdirSync(path.dirname(record.dest));
  const row = inventory.list()[0]; inventory.deleteFiles(inventory.deletionPlan(row.id)); assert.equal(inventory.rows.length, 0);
});
test('partial cleanup requires matching pinned ownership, rechecks snapshots and never removes final files', t => {
  const { make } = fixture(t), record = { ...make(), status: 'paused' };
  fs.writeFileSync(record.dest + '.frostpart', 'pa'); fs.writeFileSync(record.dest + '.frostpart.json', JSON.stringify({ repoId: record.repoId, revision: record.revision, filePath: record.filePath, total: 5, etag: 'test' }));
  const plans = planHfPartials([record]); fs.appendFileSync(record.dest + '.frostpart', 'x'); assert.throws(() => deleteHfPartials(plans), /changed/);
  deleteHfPartials(planHfPartials([record])); assert.equal(fs.readFileSync(record.dest, 'utf8'), 'model'); assert.equal(fs.existsSync(record.dest + '.frostpart'), false);
});
