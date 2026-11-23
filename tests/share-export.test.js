import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildShareExport, shareCsv, readSavedLinks, linkEntries, linkHash } from '../src/shared/share-export.js';
import { createShareMetadata } from '../src/main/torrent.js';
import { atomicExport } from '../src/main/atomic-export.js';
const hash = 'a'.repeat(40);
test('CSV quotes Unicode and formula-safe cells; excludes paths, credentials and tracker tokens', () => {
  const bundle = buildShareExport([{ name: '=模型,"hello"\nworld', infohash: hash, path: '/private/model', token: 'secret', magnet: `magnet:?xt=urn:btih:${hash}&tr=https://tracker.test/secret`, sharingState: 'off' }]);
  const csv = shareCsv(bundle); assert.match(csv, /'=模型,""hello""/); assert.ok(!csv.includes('/private') && !JSON.stringify(bundle).includes('secret'));
  assert.equal(readSavedLinks(bundle).links[0].infohash_v1, hash);
});
test('deduplicates content across devices, preserves distinct swarms, blanks provenance conflicts', () => {
  const bundle = buildShareExport([{ infohash: hash, repoId: 'a/model', revision: 'a'.repeat(40), sharingState: 'off' }, { infohash: hash, repoId: 'b/model', revision: 'b'.repeat(40), sharingState: 'unknown' }, { infohash: 'b'.repeat(40), sharingState: 'active' }, { name: 'missing' }]);
  assert.equal(bundle.links.length, 2); assert.equal(bundle.excluded.length, 1); assert.equal(bundle.links[0].upstream_repo, ''); assert.equal(bundle.links[0].upstream_revision, ''); assert.equal(bundle.links[0].sharing_state, 'unknown'); assert.equal(bundle.links[0].alternatives.upstream_repo.length, 2);
  assert.equal(buildShareExport([{ infohash: hash, sharingState: 'unknown' }, { infohash: hash, sharingState: 'active' }]).links[0].sharing_state, 'active');
  assert.throws(() => readSavedLinks({ schema: 'frostbyte.release', version: 1, links: [] }), /saved-links/);
});
test('offline copy retains saved identity without claiming active sharing', () => {
  const row = { id: 'model', path: '/storage/model', name: 'Model', device: 'spark', deviceId: 'device' };
  const rows = linkEntries({ savedShareLinks: [{ ...row, infohash: hash }], devices: [{ id: 'device', connected: false, status: { inventory: [row], torrents: [{ inventoryId: 'model', explicitShare: true }] } }] });
  assert.equal(rows[0].infohash, hash); assert.equal(rows[0].sharingState, 'unknown');
});
test('indexed library snapshots preserve exact devices, path aliases, first live links and last saved links', () => {
  const first = 'b'.repeat(40), saved = 'c'.repeat(40);
  const rows = linkEntries({
    inventory: [{ id: 'one', path: 'C:\\Models\\One', kind: 'torrent' }, { id: 'two', path: '/models/two' }],
    modelLibrary: { items: [{ id: 'scan:one', device: 'local', path: 'c:/models/one' }] },
    itemKinds: { 'scan:one': 'model' },
    library: [{ path: 'C:/MODELS/ONE', infohash: hash }, { path: '/models/three', infohash: saved }],
    savedShareLinks: [{ path: '/models/two', infohash: hash }, { path: '/models/two', infohash: saved }],
    torrents: [{ infoHash: first, dataPath: 'C:\\Models\\One', magnetURI: `magnet:?xt=urn:btih:${first}`, paused: true },
      { infoHash: hash, inventoryId: 'one', magnetURI: `magnet:?xt=urn:btih:${hash}`, explicitShare: true }],
    devices: [{ id: 'remote', connected: true, status: { inventory: [{ id: 'one', path: 'c:/models/one' }], torrents: [] } }],
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].kind, 'model');
  assert.equal(rows[0].infohash, first, 'first live link wins regardless of matching index');
  assert.equal(rows[0].sharingState, 'active');
  assert.equal(rows[1].infohash, saved, 'latest saved link wins');
  assert.equal(rows[3].deviceId, 'remote');
  assert.equal(rows[3].sharingState, 'off');
});
test('indexed hidden directories preserve segment boundaries and exact device scope', () => {
  const inventory = [{ id: 'a', path: '/models/a' }, { id: 'child', path: '/models/a/nested' },
    { id: 'sibling', path: '/models/ab' }, { id: 'win', path: 'C:\\Models\\Private\\One' }];
  const hiddenItems = [{ device: 'local', path: '/models/a', directory: true },
    { device: 'local', path: 'c:/models/private', directory: true }];
  const state = { inventory, hiddenItems, devices: [{ id: 'other', connected: false, status: { inventory: [inventory[0]] } }] };
  assert.deepEqual(linkEntries(state).map(row => row.id), ['sibling', 'a']);
  assert.equal(linkEntries(state, { includeHidden: true }).length, 5);
});
test('large library snapshots inspect scan identities linearly instead of once per library copy', () => {
  const count = 5000;
  let pathReads = 0;
  const inventory = Array.from({ length: count }, (_, i) => ({ id: `copy:${i}`, path: `/models/${i}`, name: `Model ${i}`, infoHash: i.toString(16).padStart(40, '0') }));
  const scanned = inventory.map((row, i) => ({ id: `scan:${i}`, device: 'local', source: 'scan', get path() { pathReads++; return row.path; } }));
  const torrents = inventory.map(row => ({ inventoryId: row.id, infoHash: row.infoHash, dataPath: row.path, magnetURI: `magnet:?xt=urn:btih:${row.infoHash}`, explicitShare: true }));
  const rows = linkEntries({ inventory, modelLibrary: { items: scanned }, torrents });
  assert.equal(rows.length, count);
  assert.ok(rows.every(row => row.sharingState === 'active'));
  assert.ok(pathReads < count * 20, `scan identity reads must remain linear, got ${pathReads}`);
});
test('saved-link import and re-export retains conflicts and every portable file manifest', () => {
  const original = buildShareExport([{ infohash: hash, name: 'One', files: [{ relative: 'a.gguf', size: 5 }] }, { infohash: hash, name: 'Two', files: [{ relative: 'b.gguf', size: 6 }] }]);
  const imported = readSavedLinks(original);
  assert.deepEqual(imported.links[0].alternatives, original.links[0].alternatives);
  assert.deepEqual(imported.links[0].file_manifests, original.links[0].file_manifests);
  const exported = buildShareExport(linkEntries({ catalog: [{ id: 'saved', name: hash, infohash: hash }], portableLinks: imported.links }));
  assert.deepEqual(exported.links[0].alternatives, original.links[0].alternatives);
  assert.deepEqual(exported.links[0].file_manifests, original.links[0].file_manifests);
  assert.equal(linkHash('magnet:?xt=urn:btih:' + 'A'.repeat(32)), '0'.repeat(40));
  const ipfs = linkEntries({ ipfs: { downloads: [{ id: 'ipfs:test', source: 'ipfs://fixture', dest: '/models/ipfs', name: 'IPFS only', status: 'done', files: [] }] } });
  assert.match(buildShareExport(ipfs).excluded[0].reason, /IPFS-only/);
});
test('metainfo generation is stable, cancellable and never needs a torrent client; atomic files round-trip', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-links-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'model.gguf'); fs.writeFileSync(target, Buffer.alloc(100000, 6));
  const one = await createShareMetadata(target, { files: [{ path: target, size: 100000 }] });
  const two = await createShareMetadata(target, { files: [{ path: target, size: 100000 }] }); assert.equal(one.infohash, two.infohash);
  const controller = new AbortController(); controller.abort(); await assert.rejects(createShareMetadata(target, { signal: controller.signal }));
  atomicExport(path.join(root, 'links.csv'), shareCsv(buildShareExport([one]))); assert.match(fs.readFileSync(path.join(root, 'links.csv'), 'utf8'), new RegExp(one.infohash));
  assert.equal(fs.readFileSync(target).length, 100000);
});
test('atomic export flushes every file before replacement without trying unsupported Windows folder flushes', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-export-sync-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'links.csv');
  const sync = fs.fsyncSync;
  let files = 0, directories = 0;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory()) directories++;
    else files++;
    return sync(fd);
  });
  atomicExport(target, 'first,export\n');
  atomicExport(target, 'replacement,模型\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'replacement,模型\n');
  assert.equal(files, 2, 'both temporary files must be flushed before rename');
  assert.equal(directories, process.platform === 'win32' ? 0 : 2);
  assert.deepEqual(fs.readdirSync(root), ['links.csv']);
});
test('failed export file flush keeps the existing destination and cleans up its temporary file', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-export-sync-failure-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'links.csv'); fs.writeFileSync(target, 'keep existing');
  const failure = Object.assign(new Error('fixture write flush failure'), { code: 'EIO' });
  t.mock.method(fs, 'fsyncSync', () => { throw failure; });
  assert.throws(() => atomicExport(target, 'new export'), error => error === failure);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep existing');
  assert.deepEqual(fs.readdirSync(root), ['links.csv']);
});
test('failed export replacement keeps the existing destination and cleans up its temporary file', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-export-rename-failure-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'links.csv'); fs.writeFileSync(target, 'keep existing');
  const failure = Object.assign(new Error('fixture replacement failure'), { code: 'EACCES' });
  t.mock.method(fs, 'renameSync', () => { throw failure; });
  assert.throws(() => atomicExport(target, 'new export'), error => error === failure);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep existing');
  assert.deepEqual(fs.readdirSync(root), ['links.csv']);
});
