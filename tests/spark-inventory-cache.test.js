import test from 'node:test';
import assert from 'node:assert/strict';
import { SparkInventoryCache } from '../src/main/spark-inventory.js';

const root = '/media/models';
const record = (name = 'config.json', extra = {}) => ({ id: name, repoId: 'owner/model', revision: 'a'.repeat(40), destination: root, dest: `${root}/owner/model/${name}`, filePath: name, total: 12, downloaded: 12, status: 'done', ...extra });
const status = downloads => ({ hostname: 'spark', downloadDir: root, storageRoots: [root], storage: [{ path: root, available: true }], downloads, torrents: [] });
const store = () => ({ state: {}, getSettings: () => ({ sparkHost: 'spark' }), _flush() { this.persisted = structuredClone(this.state); } });
const listing = request => ({ entries: [{ name: 'config.json', relative: 'owner/model/config.json', size: 12, directory: false }, { name: 'model.gguf', relative: 'owner/model/model.gguf', size: 12, directory: false }] });

test('older companion inventory is disk checked, grouped, and survives clearing plus desktop restart', async () => {
  const s = store(), cache = new SparkInventoryCache(s), calls = [];
  const first = await cache.enrich('spark', status([record(), record('model.gguf')]), async request => { calls.push(request); return listing(request); });
  assert.equal(first.inventory.length, 1);
  assert.equal(first.inventory[0].fileCount, 2);
  assert.equal(first.inventory[0].size, 24);
  assert.equal(first.inventory[0].available, true);
  assert.equal(first.inventory[0].browseRelative, 'owner/model');
  assert.equal(calls.length, 1, 'one directory read validates both files');
  s.state = structuredClone(s.persisted);
  const restarted = new SparkInventoryCache(s);
  const cleared = await restarted.enrich('spark', status([]), listing);
  assert.equal(cleared.inventory[0].fileCount, 2);
  assert.equal(cleared.inventory[0].available, true);
  assert.equal(restarted.cached('another-spark'), undefined);
  assert.equal(restarted.cached('spark').downloads, undefined, 'snapshot stores no transfer credentials');
});

test('older companion missing files and unmounted external roots are not reported as available', async () => {
  const cache = new SparkInventoryCache(store());
  const first = await cache.enrich('spark', status([record()]), () => ({ entries: [] }));
  assert.equal(first.inventory[0].available, false);
  assert.equal(first.inventory[0].missingFiles, 1);
  const offlineDrive = status([]); offlineDrive.storage[0].available = false;
  const unavailable = await cache.enrich('spark', offlineDrive, () => assert.fail('must not browse disconnected storage'));
  assert.equal(unavailable.inventory[0].available, false);
  assert.match(unavailable.inventory[0].error, /Storage unavailable/);
  const recovered = await cache.enrich('spark', status([]), listing, { force: true });
  assert.equal(recovered.inventory[0].available, true);
});

test('new revisions replace file provenance without resurrecting older retained transfer rows', async () => {
  const cache = new SparkInventoryCache(store());
  const old = record(), newer = record('config.json', { id: 'new-config', revision: 'b'.repeat(40) });
  await cache.enrich('spark', status([old]), listing);
  const updated = await cache.enrich('spark', status([old, newer]), listing);
  assert.equal(updated.inventory[0].files[0].revision, newer.revision);
  const clearedNewer = await cache.enrich('spark', status([old]), listing);
  assert.equal(clearedNewer.inventory[0].files[0].revision, newer.revision);
});

test('modern companion inventory is authoritative and does not need extra SSH directory reads', async () => {
  const cache = new SparkInventoryCache(store());
  await cache.enrich('spark', status([record()]), listing);
  const modern = await cache.enrich('spark', { ...status([]), inventory: [] }, () => assert.fail('modern inventory is already validated'));
  assert.deepEqual(modern.inventory, []);
  assert.deepEqual(cache.cached('spark').inventory, []);
});

test('malformed legacy paths are ignored and snapshots do not cross device identities', async () => {
  const cache = new SparkInventoryCache(store());
  const bad = await cache.enrich('spark', status([record('../outside'), record('/absolute')]), () => assert.fail('invalid paths must not be requested'));
  assert.deepEqual(bad.inventory, []);
  await cache.enrich('spark', status([record()]), listing);
  const replaced = await cache.enrich('spark', { ...status([]), hostname: 'replacement-spark' }, listing);
  assert.deepEqual(replaced.inventory, []);
});

test('adding a nested storage root keeps existing downloads in their original registered destination', async () => {
  const cache = new SparkInventoryCache(store());
  const overlapping = status([record()]); overlapping.storageRoots.push(`${root}/owner`);
  const first = await cache.enrich('spark', overlapping, listing);
  assert.equal(first.inventory[0].destination, root);
  overlapping.downloads = [];
  const cleared = await cache.enrich('spark', overlapping, listing);
  assert.equal(cleared.inventory[0].available, true);
});

test('serial refreshes preserve new completions when an older directory read is delayed', async () => {
  const s = store(), cache = new SparkInventoryCache(s);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const older = cache.enrich('spark', status([record()]), async () => { started(); await blocked; return listing(); });
  await entered;
  const newer = cache.enrich('spark', status([record(), record('model.gguf')]), listing, { force: true });
  release(); await Promise.all([older, newer]);
  const cleared = await cache.enrich('spark', status([]), listing);
  assert.equal(cleared.inventory[0].fileCount, 2);
  assert.equal(s.persisted.sparkInventory.inventory[0].fileCount, 2);
});

test('free-space changes do not defeat the read cache, but explicit refresh does', async () => {
  const cache = new SparkInventoryCache(store()); let calls = 0;
  const request = () => { calls++; return listing(); };
  const first = status([record()]); first.storage[0].freeBytes = 2000;
  await cache.enrich('spark', first, request);
  first.storage[0].freeBytes = 1000;
  await cache.enrich('spark', first, request);
  assert.equal(calls, 1);
  await cache.enrich('spark', first, request, { force: true });
  assert.equal(calls, 2);
});

test('a connection change rejects an in-flight snapshot and keeps the previous identity out of cache', async () => {
  const cache = new SparkInventoryCache(store()); let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const old = cache.enrich('spark', status([record()]), async () => { started(); await blocked; return listing(); });
  await entered; cache.invalidate(); release();
  await assert.rejects(old, /connection changed/);
  assert.equal(cache.cached('spark'), undefined);
});

test('selected torrent inventory retains its browse folder after transfer removal', async () => {
  const cache = new SparkInventoryCache(store()), current = status([]);
  current.torrents = [{ infoHash: 'a'.repeat(40), name: 'bundle', path: root, dataPath: `${root}/owner/model`, done: true,
    files: [{ path: 'owner/model/config.json', length: 12, selected: true }, { path: 'owner/model/weights.bin', length: 1024, selected: false }] }];
  const result = await cache.enrich('spark', current, listing);
  assert.equal(result.inventory[0].fileCount, 1);
  assert.equal(result.inventory[0].browseRelative, 'owner/model');
  assert.equal(result.inventory[0].available, true);
  const removed = await cache.enrich('spark', status([]), listing);
  assert.equal(removed.inventory[0].fileCount, 1);
});
