import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DownloadInventory } from '../src/main/inventory.js';
import { writeJson } from '../src/main/store.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inventory-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const downloads = path.join(root, 'downloads'), stateFile = path.join(root, 'state.json');
  fs.mkdirSync(downloads);
  const store = { state: { library: [{ path: path.join(root, 'manual-share'), infohash: 'f'.repeat(40) }], hfDownloads: [], transfers: [] },
    _flush() { writeJson(stateFile, this.state); } };
  const inventory = new DownloadInventory(store);
  const put = (relative, bytes, base = downloads) => {
    const dest = path.join(base, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return dest;
  };
  const hf = (filePath, content, extra = {}) => ({ status: 'done', repoId: 'owner/model', filePath,
    dest: put('owner/model/' + filePath, content), baseDir: downloads, downloaded: Buffer.byteLength(content),
    revision: 'a'.repeat(40), startedAt: 10, ...extra });
  return { root, downloads, stateFile, store, inventory, put, hf };
}

test('completed HF files persist separately from sharing and survive history clearing/restart', t => {
  const { store, inventory, hf, stateFile, downloads, put } = fixture(t);
  const first = hf('config.json', '{}'), second = hf('nested/tokenizer.json', '{"tokenizer":1}');
  put('owner/model/unrecorded.gguf', 'not a completed download');
  const shares = structuredClone(store.state.library);
  assert.equal(inventory.registerHf({ ...first, status: 'active' }), null);
  inventory.registerHf({ ...first, token: 'fixture-secret-not-to-persist', controller: {} });
  inventory.registerHf(second);
  store.state.hfDownloads = [];
  store.state.transfers = [];
  store._flush();
  const restored = new DownloadInventory({ state: JSON.parse(fs.readFileSync(stateFile)), _flush() {} });
  const [row] = restored.list();
  assert.equal(row.source, 'hf');
  assert.equal(row.path, path.join(downloads, 'owner/model'));
  assert.equal(row.destination, downloads);
  assert.equal(row.relative, 'owner/model');
  assert.equal(row.browseRelative, 'owner/model');
  assert.equal(row.directory, true);
  assert.equal(row.fileCount, 2);
  assert.deepEqual(row.fileNames, ['owner/model/config.json', 'owner/model/nested/tokenizer.json']);
  assert.equal(row.size, first.downloaded + second.downloaded);
  assert.equal(row.available, true);
  assert.equal(row.missingFiles, 0);
  assert.deepEqual(store.state.library, shares);
  assert.equal(fs.readFileSync(stateFile, 'utf8').includes('fixture-secret'), false);
});

test('same-path HF revisions replace provenance and old transfer migration cannot reverse it', t => {
  const { inventory, store, hf } = fixture(t);
  const old = hf('config.json', '{}');
  inventory.registerHf(old);
  const id = inventory.list()[0].id;
  const newer = hf('config.json', '{"updated":true}', { revision: 'b'.repeat(40) });
  inventory.registerHf(newer);
  assert.deepEqual(inventory.migrateHf([old]), { added: 0, skipped: 1 });
  const [row] = inventory.list({ refresh: true });
  assert.equal(row.id, id);
  assert.equal(row.fileCount, 1);
  assert.equal(row.size, newer.downloaded);
  assert.equal(row.available, true);
  assert.equal(store.state.downloadedItems[0].files[0].revision, newer.revision);
});

test('startup migrates legacy nested HF paths, selects latest provenance and retains missing items', t => {
  const { inventory, store, hf } = fixture(t);
  const old = hf('nested/config.json', '{}', { baseDir: undefined, startedAt: 1 });
  const newest = hf('nested/config.json', 'new version', { baseDir: undefined, startedAt: 2, revision: 'b'.repeat(40) });
  const missing = hf('missing.json', 'missing');
  fs.unlinkSync(missing.dest);
  store.state.hfDownloads = [newest, old, missing, { ...old, filePath: '../wrong' }, { ...old, status: 'error' }];
  assert.deepEqual(inventory.migrateHf(), { added: 3, skipped: 2 });
  const [row] = inventory.list();
  assert.equal(row.fileCount, 2);
  assert.equal(row.size, newest.downloaded + missing.downloaded);
  assert.equal(row.available, false);
  assert.equal(row.missingFiles, 1);
  assert.equal(store.state.downloadedItems[0].files.find(file => file.relative.endsWith('config.json')).revision, newest.revision);
  assert.equal(inventory.migrateHf().added, 0);
});

test('selected torrents count only completed selection and update the same item after a move', t => {
  const { inventory, put, downloads, root } = fixture(t);
  put('bundle/config.json', '{}');
  const torrent = { done: true, partial: true, infoHash: 'c'.repeat(40), name: 'bundle', path: downloads,
    files: [{ path: 'bundle\\config.json', length: 2, selected: true }, { path: 'bundle/weights.gguf', length: 100000, selected: false }] };
  inventory.registerTorrent(torrent);
  const [before] = inventory.list();
  assert.equal(before.fileCount, 1);
  assert.equal(before.size, 2);
  assert.equal(before.available, true);
  assert.equal(before.shareable, false, 'Do not share a folder that may contain skipped-file pieces');
  const completed = path.join(root, 'completed');
  fs.mkdirSync(completed);
  fs.renameSync(path.join(downloads, 'bundle'), path.join(completed, 'bundle'));
  inventory.registerTorrent({ ...torrent, path: completed, dataPath: path.join(completed, 'bundle') });
  const rows = inventory.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, before.id);
  assert.equal(rows[0].path, path.join(completed, 'bundle'));
  assert.equal(rows[0].available, true);
});

test('single-file torrents browse their parent, replace same-path provenance and do not duplicate shares attached to an existing item', t => {
  const { inventory, put, downloads } = fixture(t);
  put('weights.gguf', 'weights');
  const record = { done: true, infoHash: 'd'.repeat(40), name: 'weights', path: downloads, files: [{ path: 'weights.gguf', length: 7 }] };
  assert.equal(inventory.registerTorrent({ ...record, explicitShare: true, inventoryId: "existing-model" }), null);
  inventory.registerTorrent(record);
  inventory.registerTorrent({ ...record, infoHash: 'e'.repeat(40) });
  const rows = inventory.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'torrent:' + 'e'.repeat(40));
  assert.equal(rows[0].directory, false);
  assert.equal(rows[0].browseRelative, '');
  assert.equal(rows[0].shareable, true);
});

test('multi-root torrents remain visible without offering to share the entire destination', t => {
  const { inventory, put, downloads } = fixture(t);
  put('first.bin', 'a'); put('second.bin', 'bb'); put('unrelated.bin', 'private sibling');
  inventory.registerTorrent({ done: true, infoHash: 'd'.repeat(40), name: 'multi', path: downloads,
    files: [{ path: 'first.bin', length: 1 }, { path: 'second.bin', length: 2 }] });
  const [row] = inventory.list();
  assert.equal(row.fileCount, 2);
  assert.equal(row.size, 3);
  assert.equal(row.available, true);
  assert.equal(row.relative, '');
  assert.equal(row.shareable, false);
});

test('missing, changed-size and linked files are unavailable without deleting their inventory entries', t => {
  const { inventory, hf, root } = fixture(t);
  const a = hf('config.json', '{}'), b = hf('nested/tokenizer.json', '{}'), c = hf('empty.json', '');
  for (const record of [a, b, c]) inventory.registerHf(record);
  assert.equal(inventory.list()[0].available, true);
  fs.unlinkSync(a.dest);
  fs.writeFileSync(b.dest, 'changed');
  let row = inventory.list({ refresh: true })[0];
  assert.equal(row.missingFiles, 2);
  assert.equal(row.fileCount, 3);
  fs.writeFileSync(a.dest, '{}');
  fs.writeFileSync(b.dest, '{}');
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'tokenizer.json'), '{}');
  fs.rmSync(path.dirname(b.dest), { recursive: true });
  fs.symlinkSync(outside, path.dirname(b.dest), process.platform === 'win32' ? 'junction' : 'dir');
  row = inventory.list({ refresh: true })[0];
  assert.equal(row.available, false);
  assert.equal(row.missingFiles, 1);
  assert.match(row.error, /symbolic links/);
  assert.equal(row.shareable, false);
  assert.equal(inventory.list().length, 1);
});

test('invalid paths, sizes and persisted manifests cannot become filesystem lookups', t => {
  const { inventory, hf, downloads, store } = fixture(t);
  const record = hf('config.json', '{}');
  for (const patch of [{ repoId: '../model' }, { filePath: '../config.json' }, { baseDir: 'relative' }, { downloaded: -1 },
    { dest: path.join(downloads, 'wrong.json') }, { filePath: 'C:\\outside.json' }]) {
    assert.throws(() => inventory.registerHf({ ...record, ...patch }));
  }
  for (const name of ['../outside', '/absolute', 'C:\\outside', 'folder/file:stream', 'folder//file']) {
    assert.throws(() => inventory.registerTorrent({ done: true, infoHash: 'a'.repeat(40), path: downloads, files: [{ path: name, length: 1 }] }));
  }
  inventory.registerHf(record);
  const valid = store.state.downloadedItems[0];
  const restored = new DownloadInventory({ state: { downloadedItems: [valid, { ...valid, relative: '../outside' },
    { ...valid, files: [{ relative: 'unrelated/file', size: 1 }] }] }, _flush() {} });
  assert.equal(restored.list().length, 1);
});

test('presence cache is bounded, explicit refresh is immediate and public results are detached', t => {
  const { store, hf } = fixture(t);
  let now = 100;
  const inventory = new DownloadInventory(store, { now: () => now, cacheMs: 1000 });
  const record = hf('config.json', '{}'); inventory.registerHf(record);
  const first = inventory.list(); first[0].name = 'changed only by caller';
  fs.unlinkSync(record.dest);
  assert.equal(inventory.list()[0].available, true);
  now += 1000;
  assert.equal(inventory.list()[0].available, false);
  fs.writeFileSync(record.dest, '{}');
  assert.equal(inventory.list({ refresh: true })[0].available, true);
  assert.equal(inventory.list()[0].name, 'owner/model');
});

test('failed inventory persistence leaves rows, provenance, and cached results unchanged', t => {
  const { inventory, store, hf, put, downloads } = fixture(t);
  const first = hf('config.json', '{}');
  inventory.registerHf(first);
  const beforeState = structuredClone(store.state.downloadedItems);
  const beforeList = inventory.list();
  const flush = store._flush;
  store._flush = () => { throw new Error('fixture inventory write failed'); };

  const newer = hf('config.json', '{"new":true}', { revision: 'b'.repeat(40) });
  assert.throws(() => inventory.registerHf(newer), /inventory write failed/);
  assert.deepEqual(store.state.downloadedItems, beforeState);
  assert.deepEqual(inventory.list(), beforeList);

  put('bundle/model.bin', 'torrent');
  assert.throws(() => inventory.registerTorrent({ done: true, infoHash: 'c'.repeat(40), name: 'bundle', path: downloads,
    files: [{ path: 'bundle/model.bin', length: 7 }] }), /inventory write failed/);
  assert.deepEqual(store.state.downloadedItems, beforeState);
  assert.deepEqual(inventory.list(), beforeList);

  const migrated = hf('extra.json', 'extra', { revision: 'd'.repeat(40) });
  assert.throws(() => inventory.migrateHf([migrated]), /inventory write failed/);
  assert.deepEqual(store.state.downloadedItems, beforeState);
  assert.equal(inventory.list({ refresh: true })[0].fileCount, 1);
  store._flush = flush;
});

test('forget removes only the ownership record and leaves downloaded files in place', t => {
  const { inventory, hf } = fixture(t);
  const record = hf('model.gguf', 'weights');
  inventory.registerHf(record);
  const [item] = inventory.list();
  const proof = inventory.identity(item.id);
  assert.equal(inventory.forget(item.id, proof), true);
  assert.equal(inventory.list().length, 0);
  assert.equal(fs.readFileSync(record.dest, 'utf8'), 'weights');
});

test('deleteFiles removes only reviewed manifest files and empty owned folders', t => {
  const { inventory, hf, put, downloads } = fixture(t);
  const first = hf('model.gguf', 'weights'), second = hf('config.json', '{}');
  put('owner/model/keep.txt', 'not in the completed manifest');
  inventory.registerHf(first); inventory.registerHf(second);
  const [item] = inventory.list();
  const plan = inventory.deletionPlan(item.id);
  assert.equal(inventory.deleteFiles(plan), true);
  assert.equal(inventory.list().length, 0);
  assert.equal(fs.existsSync(first.dest), false);
  assert.equal(fs.existsSync(second.dest), false);
  assert.equal(fs.readFileSync(path.join(downloads, 'owner/model/keep.txt'), 'utf8'), 'not in the completed manifest');
});

test('deleteFiles refuses a file or root changed after review', t => {
  const { inventory, hf } = fixture(t);
  const record = hf('model.gguf', 'weights');
  inventory.registerHf(record);
  const [item] = inventory.list();
  const plan = inventory.deletionPlan(item.id);
  fs.writeFileSync(record.dest, 'changed!');
  assert.throws(() => inventory.deleteFiles(plan), /changed during review/);
  assert.equal(inventory.list().length, 1);
  assert.equal(fs.readFileSync(record.dest, 'utf8'), 'changed!');
});
