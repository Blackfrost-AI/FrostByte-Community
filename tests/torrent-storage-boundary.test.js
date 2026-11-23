import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import parseTorrent, { toTorrentFile } from 'parse-torrent';
import { MAX_TORRENT_FILES, MAX_TORRENT_FILES_PER_PIECE, MAX_TORRENT_METADATA_BYTES, MAX_TORRENT_PATH_BYTES, MAX_TORRENT_TOTAL_BYTES, MAX_TORRENT_TOTAL_PATH_BYTES, SafeTorrentStore, validateLocalStorageRoot, validateTorrentFiles, validateTorrentLayout } from '../src/main/safe-torrent-store.js';
import { acquireTorrentDescriptor, MAX_TORRENT_OPEN_DESCRIPTORS, torrentDescriptorBudgetSnapshot } from '../src/main/torrent-descriptor-budget.js';
import { sanitizeTorrentDiscovery, TorrentEngine, validateTorrentSessionRecord } from '../src/main/torrent.js';
import { inspectTorrent } from '../src/main/torrent-source.js';

const put = (store, index, data) => new Promise((resolve, reject) => store.put(index, data, error => error ? reject(error) : resolve()));
const get = (store, index) => new Promise((resolve, reject) => store.get(index, (error, data) => error ? reject(error) : resolve(data)));
const close = store => new Promise((resolve, reject) => store.close(error => error ? reject(error) : resolve()));
const destroy = store => new Promise((resolve, reject) => store.destroy(error => error ? reject(error) : resolve()));
const waitFor = async (check, timeout = 10_000) => {
  const until = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > until) throw new Error('Condition timed out');
    await delay(25);
  }
};

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-torrent-boundary-'));
  const root = path.join(home, 'downloads');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, root, outside };
}

test('safe store writes normal nested torrent files inside its approved root', async t => {
  const { root } = fixture(t);
  const store = new SafeTorrentStore(4, {
    approvedRoot: root, path: root, length: 4,
    files: [{ path: 'release/files/model.bin', length: 4, offset: 0 }],
  });
  await put(store, 0, Buffer.from('safe'));
  assert.equal(fs.readFileSync(path.join(root, 'release/files/model.bin'), 'utf8'), 'safe');
  await destroy(store);
  assert.equal(fs.existsSync(path.join(root, 'release/files/model.bin')), false);
});

test('safe store can seed an existing read-only file without weakening write checks', async t => {
  const { root } = fixture(t);
  const target = path.join(root, 'release/model.bin');
  fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, 'seed');
  if (process.platform !== 'win32') fs.chmodSync(target, 0o400);
  const store = new SafeTorrentStore(4, {
    approvedRoot: root, path: root, length: 4, allowExisting: true,
    files: [{ path: 'release/model.bin', length: 4, offset: 0 }],
  });
  assert.equal(Buffer.from(await get(store, 0)).toString(), 'seed');
  await new Promise(resolve => store.close(resolve));
});

test('fresh stores never overwrite files that predate or race their construction', async t => {
  const { root } = fixture(t);
  const existing = path.join(root, 'release/existing.bin');
  fs.mkdirSync(path.dirname(existing)); fs.writeFileSync(existing, 'keep');
  const rejected = new SafeTorrentStore(4, {
    approvedRoot: root, path: root, length: 4,
    files: [{ path: 'release/existing.bin', length: 4, offset: 0 }],
  });
  await assert.rejects(put(rejected, 0, Buffer.from('evil')), /already exists/i);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');

  const metadata = toTorrentFile({ info: {
    name: 'release', 'piece length': 16_384,
    pieces: crypto.createHash('sha1').update('keep').digest(),
    files: [{ path: ['existing.bin'], length: 4 }],
  }, announce: [], urlList: [] });
  let clientAdds = 0;
  const inertEngine = {
    _allowPeerAddresses: false, _pendingAdds: new Map(), _downloadPath: root,
    _find() { return null; }, _shape(value) { return value; },
    client: { async get() { return null; }, add() { clientAdds++; } },
  };
  await assert.rejects(TorrentEngine.prototype.add.call(inertEngine, metadata, { path: root }), /already exists/i);
  assert.equal(clientAdds, 0, 'known metadata is rejected before WebTorrent starts');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');

  const racedPath = path.join(root, 'release/raced.bin');
  const raced = new SafeTorrentStore(4, {
    approvedRoot: root, path: root, length: 4,
    files: [{ path: 'release/raced.bin', length: 4, offset: 0 }],
  });
  fs.writeFileSync(racedPath, 'keep');
  await assert.rejects(put(raced, 0, Buffer.from('evil')), /appeared/i);
  assert.equal(fs.readFileSync(racedPath, 'utf8'), 'keep');
  await destroy(raced);
  assert.equal(fs.readFileSync(racedPath, 'utf8'), 'keep');

  const portableAlias = path.join(root, 'release/Portable-Name.bin');
  fs.writeFileSync(portableAlias, 'alias');
  const aliased = new SafeTorrentStore(5, {
    approvedRoot: root, path: root, length: 5,
    files: [{ path: 'release/portable-name.bin', length: 5, offset: 0 }],
  });
  await assert.rejects(put(aliased, 0, Buffer.from('other')), /already exists|collides/i);
  assert.equal(fs.readFileSync(portableAlias, 'utf8'), 'alias');
});

test('nested symlinks cannot redirect a torrent write outside the approved root', async t => {
  const { root, outside } = fixture(t);
  const release = path.join(root, 'release');
  fs.mkdirSync(release);
  fs.symlinkSync(outside, path.join(release, 'files'), process.platform === 'win32' ? 'junction' : 'dir');
  const victim = path.join(outside, 'model.bin');
  fs.writeFileSync(victim, 'keep');

  const store = new SafeTorrentStore(4, {
    approvedRoot: root, path: root, length: 4,
    files: [{ path: 'release/files/model.bin', length: 4, offset: 0 }],
  });
  await assert.rejects(put(store, 0, Buffer.from('evil')), /linked|symbolic|boundary|outside/i);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('the selected torrent storage root cannot itself be a symbolic link', async t => {
  const { home, outside } = fixture(t);
  const linkedRoot = path.join(home, 'linked-downloads');
  fs.symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const victim = path.join(outside, 'model.bin');
  fs.writeFileSync(victim, 'keep');
  const store = new SafeTorrentStore(4, {
    approvedRoot: linkedRoot, path: linkedRoot, length: 4,
    files: [{ path: 'model.bin', length: 4, offset: 0 }],
  });
  await assert.rejects(put(store, 0, Buffer.from('evil')), /symbolic link|unsafe/i);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('parent traversal and absolute metadata paths fail before creating data', async t => {
  const { root, outside } = fixture(t);
  for (const unsafe of ['../outside/escape.bin', '/tmp/escape.bin', 'C:\\escape.bin']) {
    const store = new SafeTorrentStore(4, {
      approvedRoot: root, path: root, length: 4,
      files: [{ path: unsafe, length: 4, offset: 0 }],
    });
    await assert.rejects(put(store, 0, Buffer.from('evil')), /outside|invalid/i);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('storage roots reject UNC and Windows device namespaces before filesystem use', async t => {
  const { root } = fixture(t);
  assert.equal(validateLocalStorageRoot(root), path.resolve(root));
  for (const unsafe of [
    'relative/downloads',
    '//server/share',
    String.raw`\\server\share`,
    String.raw`\\?\C:\downloads`,
    String.raw`\\.\C:\downloads`,
    String.raw`\??\C:\downloads`,
  ]) {
    assert.throws(() => validateLocalStorageRoot(unsafe), /absolute|local|network|device/i, unsafe);
    const store = new SafeTorrentStore(4, {
      approvedRoot: unsafe, path: unsafe, length: 4,
      files: [{ path: 'release/model.bin', length: 4, offset: 0 }],
    });
    await assert.rejects(put(store, 0, Buffer.from('nope')), /absolute|local|network|device|unsafe/i);
  }
});

test('torrent metadata limits bound file count, individual paths, and aggregate path bytes', () => {
  const file = (path, length = 0) => ({ path, length });
  assert.throws(() => validateTorrentFiles(Array.from({ length: MAX_TORRENT_FILES + 1 }, (_, index) => file(`release/${index}`))), /4096 files/);
  assert.throws(() => validateTorrentFiles([file('x'.repeat(MAX_TORRENT_PATH_BYTES + 1))]), /1024 bytes/);
  const component = 'x'.repeat(200);
  const enough = Math.ceil(MAX_TORRENT_TOTAL_PATH_BYTES / component.length) + 16;
  assert.throws(() => validateTorrentFiles(Array.from({ length: enough }, (_, index) => file(`${component}/${index}`))), /safe metadata limit/);
  assert.throws(() => validateTorrentFiles([file('release/model.bin', Number.MAX_SAFE_INTEGER + 1)]), /file size/);
  assert.throws(() => validateTorrentFiles([file('release/huge.bin', MAX_TORRENT_TOTAL_BYTES + 1)]), /larger than 1 TiB/i);
  assert.deepEqual(validateTorrentFiles([
    { path: 'release/a.bin', length: 2, offset: Number.MAX_SAFE_INTEGER },
    { path: 'release/b.bin', length: 3, offset: -10 },
  ]).map(item => item.offset), [0, 2], 'untrusted offsets never control the physical chunk map');
  assert.throws(() => validateTorrentLayout({
    pieceLength: 16_384,
    pieces: ['f'.repeat(39)],
    files: [file('release/model.bin', 1)],
  }), /piece hashes/i);
});

test('torrent piece layouts cannot fan one request out across an unsafe number of files', async t => {
  const { root } = fixture(t);
  const fileCount = MAX_TORRENT_FILES_PER_PIECE + 1;
  const packed = Array.from({ length: fileCount }, (_, index) => ({ path: `release/${index}.bin`, length: 1 }));
  // The fan-out budget is a transfer-time descriptor bound, so it is enforced
  // where a transfer is scoped. A metadata-only preview passes checkFanout:false
  // and still lists such a torrent, which is what makes a packed shard
  // directory pickable at all.
  assert.throws(() => validateTorrentLayout({
    pieceLength: 16_384,
    pieces: ['f'.repeat(40)],
    files: packed,
  }), new RegExp(`more than ${MAX_TORRENT_FILES_PER_PIECE} .*single piece`, 'i'));
  assert.equal(validateTorrentLayout({
    pieceLength: 16_384,
    pieces: ['f'.repeat(40)],
    files: packed,
  }, { checkFanout: false }).length, fileCount, 'a metadata-only preview must still be able to list a packed layout');
  assert.equal(validateTorrentLayout({
    pieceLength: 16_384,
    pieces: ['f'.repeat(40)],
    files: packed,
  }, { selectedPaths: ['release/0.bin'] }).length, fileCount, 'a one-file selection must lift the whole-torrent fanout limit');

  const spread = Array.from({ length: fileCount }, (_, index) => ({ path: `release/${index}.bin`, length: 16_384 }));
  assert.equal(validateTorrentLayout({
    pieceLength: 16_384,
    pieces: Array.from({ length: fileCount }, () => 'f'.repeat(40)),
    files: spread,
  }).length, fileCount, 'many files remain valid when each piece touches only one file');

  const store = new SafeTorrentStore(16_384, {
    approvedRoot: root, path: root, length: fileCount, files: packed,
  });
  assert.match(store.validationError?.message ?? '', new RegExp(`more than ${MAX_TORRENT_FILES_PER_PIECE} .*single piece`, 'i'));
  await assert.rejects(put(store, 0, Buffer.alloc(fileCount)), error => error === store.validationError);
});

test('a selection lifts the piece-fanout limit for the files it leaves out', async t => {
  const { root } = fixture(t);
  const fileCount = MAX_TORRENT_FILES_PER_PIECE + 1;
  const packed = Array.from({ length: fileCount }, (_, index) => ({ path: `release/${index}.bin`, length: 1 }));

  // Same payload that is rejected above, but only one file is wanted. The other
  // entries are never read or written, so they must not count toward the
  // descriptor bound that exists to protect the transfer.
  const selected = new SafeTorrentStore(1, {
    approvedRoot: root, path: root, length: fileCount, files: packed, selectedPaths: ['release/0.bin'],
  });
  assert.equal(selected.validationError, null, 'a single-file selection must not inherit the whole-torrent fanout limit');
  assert.equal(selected.chunkLength, 1);
  await put(selected, 0, Buffer.from([0x41]));

  // Selecting a set that still fans out stays rejected.
  const stillPacked = new SafeTorrentStore(16_384, {
    approvedRoot: root, path: root, length: fileCount, files: packed,
    selectedPaths: packed.map(file => file.path),
  });
  assert.match(stillPacked.validationError?.message ?? '', new RegExp(`more than ${MAX_TORRENT_FILES_PER_PIECE} .*single piece`, 'i'));

  // Both stores hold a descriptor permit; release them so later tests in this
  // file are not measuring this test's leftovers.
  await close(selected);
  await close(stillPacked);
});

test('a resumable file is adopted only while it can still be a prefix of the payload', async t => {
  const { root } = fixture(t);
  const files = [{ path: 'weights/model.bin', length: 16_384 }];

  // Resume mid-transfer: a partial file is shorter than declared. Legitimate.
  fs.mkdirSync(path.join(root, 'weights'), { recursive: true });
  fs.writeFileSync(path.join(root, 'weights/model.bin'), Buffer.alloc(8_192));
  const resumable = new SafeTorrentStore(16_384, {
    approvedRoot: root, path: root, length: 16_384, files, allowExisting: true,
  });
  assert.equal(resumable.validationError, null);

  // A finished file of exactly the declared size is also legitimate.
  fs.writeFileSync(path.join(root, 'weights/model.bin'), Buffer.alloc(16_384));
  const complete = new SafeTorrentStore(16_384, {
    approvedRoot: root, path: root, length: 16_384, files, allowExisting: true,
  });
  assert.equal(complete.validationError, null);

  // A larger file cannot be a prefix of the payload, so it is a different file
  // sharing the name. Adopting it would overwrite it in place.
  fs.writeFileSync(path.join(root, 'weights/model.bin'), Buffer.alloc(32_768));
  const drifted = new SafeTorrentStore(16_384, {
    approvedRoot: root, path: root, length: 16_384, files, allowExisting: true,
  });
  assert.match(drifted.validationError?.message ?? '', /different file already exists/i);
});

test('parallel torrent stores cannot exceed the process descriptor budget and closed capacity is reusable', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-torrent-fd-budget-'));
  const root = path.join(home, 'downloads');
  fs.mkdirSync(root);
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, 0);
  // Exercise the real capacity boundary without creating tens of thousands of
  // fixture files on machines with a large process soft limit.
  const slots = Math.min(128, MAX_TORRENT_OPEN_DESCRIPTORS);
  const reserved = Array.from({ length: MAX_TORRENT_OPEN_DESCRIPTORS - slots }, () => acquireTorrentDescriptor());
  const stores = Array.from({ length: slots + 8 }, (_, index) => new SafeTorrentStore(1, {
    approvedRoot: root,
    path: root,
    length: 1,
    files: [{ path: `item-${index}.bin`, length: 1, offset: 0 }],
  }));
  t.after(async () => {
    await Promise.allSettled(stores.map(close));
    for (const permit of reserved) permit.release();
    fs.rmSync(home, { recursive: true, force: true });
  });

  assert.equal(torrentDescriptorBudgetSnapshot().inUse, reserved.length);
  const outcomes = await Promise.allSettled(stores.map(store => put(store, 0, Buffer.from('x'))));
  const opened = outcomes.flatMap((outcome, index) => outcome.status === 'fulfilled' ? [index] : []);
  const rejected = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [[index, outcome.reason]] : []);

  assert.equal(opened.length, slots);
  assert.equal(rejected.length, 8);
  for (const [, error] of rejected) assert.equal(error.code, 'FROSTBYTE_DESCRIPTOR_BUDGET');
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, MAX_TORRENT_OPEN_DESCRIPTORS);
  assert.equal(torrentDescriptorBudgetSnapshot().available, 0);
  assert.equal(torrentDescriptorBudgetSnapshot().highWatermark, MAX_TORRENT_OPEN_DESCRIPTORS);

  await close(stores[opened[0]]);
  assert.equal(torrentDescriptorBudgetSnapshot().available, 1);
  await put(stores[rejected[0][0]], 0, Buffer.from('y'));
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, MAX_TORRENT_OPEN_DESCRIPTORS);

  await Promise.all(stores.map(close));
  for (const permit of reserved) permit.release();
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, 0);
});

test('invalid torrent layouts construct only an inert bounded store', async t => {
  const { root } = fixture(t);
  for (const [chunkLength, length] of [[0, 1], [16_384, MAX_TORRENT_TOTAL_BYTES + 1]]) {
    const store = new SafeTorrentStore(chunkLength, {
      approvedRoot: root, path: root, length,
      files: [{ path: 'release/huge.bin', length, offset: Number.MAX_SAFE_INTEGER }],
    });
    assert.ok(store.validationError);
    assert.equal(store.chunkMap.length, 0);
    assert.equal(store.length, 0);
    await assert.rejects(destroy(store), error => error === store.validationError);
  }
});

test('torrent names are portable and cannot alias files or directories', async t => {
  const file = name => ({ path: name, length: 0 });
  for (const unsafe of [
    'release/CON', 'release/con.txt', 'release/CON .txt', 'release/COM1.bin', 'release/LPT\u00b9.log',
    'release/name.', 'release/name ', 'release/file:stream', 'release/what?.bin',
    'release/star*.bin', `release/control-${String.fromCharCode(1)}.bin`,
  ]) assert.throws(() => validateTorrentFiles([file(unsafe)]), /Windows|reserved/i, unsafe);

  for (const colliding of [
    ['release/Model.bin', 'release/model.bin'],
    ['release/Caf\u00e9.bin', 'release/Cafe\u0301.bin'],
    ['release/model', 'release/model/config.json'],
    ['release/Model/config.json', 'release/model'],
    ['release\\model.bin', 'release/model.bin'],
  ]) assert.throws(() => validateTorrentFiles(colliding.map(file)), /collide|file and folder/i, colliding.join(', '));

  // The injectable policy keeps the collision rules directly testable on any
  // host. FrostByte uses the portable policy for remote torrent metadata.
  assert.deepEqual(validateTorrentFiles([file('release/CON')], { platform: 'linux' })[0].path, 'release/CON');

  const { root } = fixture(t);
  const store = new SafeTorrentStore(4, {
    approvedRoot: root, path: root, length: 4,
    files: [
      { path: 'release/Caf\u00e9.bin', length: 2, offset: 0 },
      { path: 'release/Cafe\u0301.bin', length: 2, offset: 2 },
    ],
  });
  await assert.rejects(put(store, 0, Buffer.alloc(4)), /collide/i);
  assert.deepEqual(fs.readdirSync(root), [], 'colliding metadata fails before a directory or file is created');
});

async function savedSession(root, name = 'saved') {
  const metadata = toTorrentFile({ info: { name, 'piece length': 16_384,
    pieces: crypto.createHash('sha1').update(name).digest(), length: 1 },
  announce: ['http://127.0.0.1/announce'], urlList: ['http://169.254.169.254/model'] });
  const parsed = await parseTorrent(metadata);
  return {
    infohash: parsed.infoHash,
    magnet: `magnet:?xt=urn:btih:${parsed.infoHash}&tr=http://127.0.0.1/announce`,
    name,
    path: root,
    paused: false,
    explicitShare: false,
    inventoryId: `torrent:${parsed.infoHash}`,
    hfSource: false,
    kind: 'torrent',
    completionHandled: false,
    addedAt: 1,
    seededMs: 12_345,
    uploadedBytes: 67_890,
    torrentFile: Buffer.from(metadata).toString('base64'),
    selectedPaths: null,
  };
}

test('saved torrent sessions are bounded, plain, local, and identity matched before restore', async t => {
  const { root } = fixture(t);
  const record = await savedSession(root);
  const clean = await validateTorrentSessionRecord(record);
  assert.equal(clean.infohash, record.infohash);
  assert.equal(clean.path, root);
  assert.equal(clean.seededMs, record.seededMs);
  assert.equal(clean.uploadedBytes, record.uploadedBytes);
  const parsed = await parseTorrent(clean.source);
  assert.equal(parsed.infoHash, record.infohash);
  assert.deepEqual(parsed.announce, []);
  assert.deepEqual(parsed.urlList, []);

  const other = await savedSession(root, 'other');
  const badRecords = [
    { ...record, path: 'relative/downloads' },
    { ...record, path: '//server/share' },
    { ...record, path: String.raw`\\server\share` },
    { ...record, path: String.raw`\\?\C:\downloads` },
    { ...record, infohash: 'f'.repeat(40) },
    { ...record, magnet: `magnet:?xt=urn:btih:${'f'.repeat(40)}` },
    { ...record, torrentFile: other.torrentFile },
    { ...record, torrentFile: 'not-base64' },
    { ...record, magnet: `magnet:?xt=urn:btih:${record.infohash}&dn=${'x'.repeat(8192)}` },
    { ...record, paused: 'false' },
    { ...record, completionHandled: 1 },
    { ...record, addedAt: -1 },
    { ...record, addedAt: Number.POSITIVE_INFINITY },
    { ...record, seededMs: -1 },
    { ...record, seededMs: 1.5 },
    { ...record, seededMs: Number.MAX_SAFE_INTEGER },
    { ...record, uploadedBytes: -1 },
    { ...record, uploadedBytes: 1.5 },
    { ...record, uploadedBytes: Number.MAX_SAFE_INTEGER },
    { ...record, inventoryId: 'x'.repeat(1025) },
    { ...record, kind: 'executable' },
    { ...record, selectedPaths: ['x'.repeat(MAX_TORRENT_PATH_BYTES + 1)] },
    { ...record, unsupported: true },
  ];
  for (const unsafe of badRecords) await assert.rejects(validateTorrentSessionRecord(unsafe), /saved|choose|select|metadata/i);

  const inherited = Object.assign(Object.create({ inherited: true }), record);
  await assert.rejects(validateTorrentSessionRecord(inherited), /plain object/i);
  const accessor = { ...record };
  Object.defineProperty(accessor, 'paused', { enumerable: true, get() { throw new Error('must not run'); } });
  await assert.rejects(validateTorrentSessionRecord(accessor), /accessor/i);

  let clientAdds = 0;
  const inertEngine = Object.assign(Object.create(TorrentEngine.prototype), {
    _allowPeerAddresses: false,
    client: { add() { clientAdds++; } },
  });
  await assert.rejects(inertEngine.restore({ ...record, path: '//server/share' }));
  assert.equal(clientAdds, 0, 'invalid saved state is rejected before WebTorrent starts');
  await assert.rejects(TorrentEngine.prototype.add.call({}, path.join(root, 'untrusted.torrent')), /validated torrent metadata/i);
});

test('public torrent discovery cannot supply trackers, web seeds, sources, or direct peers', async () => {
  const hash = 'a'.repeat(40);
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=Safe%20name&tr=http://169.254.169.254/announce&ws=http://127.0.0.1/private&xs=https://example.com/source&x.pe=10.0.0.2:6881`;
  assert.equal(await sanitizeTorrentDiscovery(magnet), `magnet:?xt=urn:btih:${hash}&dn=Safe%20name`);
  const testOnly = await sanitizeTorrentDiscovery(magnet, { allowPeerAddresses: true });
  assert.match(testOnly, /x\.pe=10\.0\.0\.2:6881/); assert.doesNotMatch(testOnly, /(?:tr|ws|xs)=/);

  const metadata = toTorrentFile({ info: { name: 'safe', 'piece length': 16_384,
    pieces: crypto.createHash('sha1').update('fixture').digest(), length: 7 },
  announce: ['http://169.254.169.254/announce'], urlList: ['http://127.0.0.1/private'] });
  const clean = await parseTorrent(await sanitizeTorrentDiscovery(metadata));
  assert.deepEqual(clean.announce, []); assert.deepEqual(clean.urlList, []);

  const inconsistent = toTorrentFile({ info: { name: 'bad-pieces', 'piece length': 16_384,
    pieces: crypto.createHash('sha1').update('only one').digest(), length: 32_768 }, announce: [], urlList: [] });
  await assert.rejects(sanitizeTorrentDiscovery(inconsistent), /piece hashes/i);
});

test('add and seed reject a fatal client failure before torrent startup completes', { timeout: 2_000 }, async t => {
  const { home, root } = fixture(t);
  const source = path.join(home, 'model.bin');
  fs.writeFileSync(source, 'seed fixture');

  const fatalEngine = (method, message) => {
    const failure = new Error(message);
    const torrent = Object.assign(new EventEmitter(), {
      destroyed: false,
      ready: false,
      files: [],
      wires: [],
      _peers: new Map(),
      addPeer() { return true; },
    });
    const client = Object.assign(new EventEmitter(), {
      destroyed: false,
      torrents: [],
      async get() { return null; },
    });
    client[method] = () => {
      queueMicrotask(() => {
        client.destroyed = true;
        torrent.destroyed = true;
        torrent.emit('close');
        client.emit('error', failure);
      });
      return torrent;
    };
    const engine = Object.assign(new EventEmitter(), {
      client,
      _allowPeerAddresses: false,
      _pendingAdds: new Map(),
      _pendingSeeds: new Map(),
      _pendingRemovals: new Map(),
      userPaused: new Set(),
      autoQueued: [],
      addedAt: new Map(),
      doneAt: new Map(),
      _onTorrentDone() {},
    });
    Object.setPrototypeOf(engine, TorrentEngine.prototype);
    return { engine, failure };
  };

  const addFailure = fatalEngine('add', 'simulated add bind failure');
  await assert.rejects(
    addFailure.engine.add(`magnet:?xt=urn:btih:${'a'.repeat(40)}`, { path: root }),
    error => error === addFailure.failure,
  );
  assert.equal(addFailure.engine._pendingAdds.size, 0);

  const seedFailure = fatalEngine('add', 'simulated seed bind failure');
  await assert.rejects(seedFailure.engine.seed(source), error => error === seedFailure.failure);
  assert.equal(seedFailure.engine._pendingSeeds.size, 0);
});

test('file metadata is rejected before engine or preview rendering can expand an oversized list', async t => {
  const { root, home } = fixture(t);
  const files = Array.from({ length: MAX_TORRENT_FILES + 1 }, (_, index) => ({ length: 1, path: [`file-${index}`] }));
  const metadata = toTorrentFile({ info: { name: 'oversized', 'piece length': 16_384,
    pieces: crypto.createHash('sha1').update('fixture').digest(), files }, announce: [], urlList: [] });
  const metadataFile = path.join(home, 'oversized.torrent');
  fs.writeFileSync(metadataFile, metadata);
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(async () => { if (!engine._destroyed) await engine.destroy(); });
  await assert.rejects(engine.add(Buffer.alloc(MAX_TORRENT_METADATA_BYTES + 1), { path: root }), /larger than 8 MB/);
  await assert.rejects(engine.add(metadata, { path: root }), /4096 files/);
  await assert.rejects(inspectTorrent(metadataFile, { dht: false }), /4096 files/);
});

test('deleteData refuses to traverse a replaced parent and preserves outside files', async t => {
  const { root, outside } = fixture(t);
  const store = new SafeTorrentStore(4, {
    approvedRoot: root, path: root, length: 4,
    files: [{ path: 'release/model.bin', length: 4, offset: 0 }],
  });
  await put(store, 0, Buffer.from('ours'));
  fs.renameSync(path.join(root, 'release'), path.join(root, 'detached'));
  fs.mkdirSync(path.join(outside, 'release'));
  const victim = path.join(outside, 'release/model.bin');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(path.join(outside, 'release'), path.join(root, 'release'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(destroy(store), /linked|replaced|symbolic/i);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(root, 'detached/model.bin'), 'utf8'), 'ours');
});

test('magnet metadata is checked by the store before its first filesystem write', { timeout: 20_000 }, async t => {
  const { home, root, outside } = fixture(t);
  const source = path.join(home, 'release');
  fs.mkdirSync(path.join(source, 'files'), { recursive: true });
  fs.writeFileSync(path.join(source, 'files/model.bin'), crypto.randomBytes(256 * 1024));
  fs.mkdirSync(path.join(root, 'release'));
  fs.symlinkSync(outside, path.join(root, 'release/files'), process.platform === 'win32' ? 'junction' : 'dir');
  const victim = path.join(outside, 'model.bin');
  fs.writeFileSync(victim, 'keep');

  const options = { dht: false, tracker: false, lsd: false, allowPeerAddresses: true };
  const seed = new TorrentEngine(options), pull = new TorrentEngine(options);
  t.after(async () => { await seed.destroy(); await pull.destroy(); });
  const shared = await seed.seed(source);
  await waitFor(() => seed.port);
  let reported = '';
  pull.on('torrent-error', error => { reported = error.message; });
  await pull.add(shared.magnetURI + `&x.pe=127.0.0.1:${seed.port}`, { path: root });
  await waitFor(() => reported);
  assert.match(reported, /linked|symbolic|boundary|unsafe/i);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('completion markers survive restore but a remove and fresh add starts unhandled', async t => {
  const { home } = fixture(t);
  const source = path.join(home, 'model.bin');
  fs.writeFileSync(source, crypto.randomBytes(32 * 1024));
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(async () => { if (!engine._destroyed) await engine.destroy(); });

  const seeded = await engine.seed(source);
  assert.equal(seeded.completionHandled, false);
  assert.equal(engine.markCompletionHandled(seeded.infoHash).completionHandled, true);
  const handled = engine.sessions()[0];
  assert.equal(handled.completionHandled, true);

  await engine.remove(seeded.infoHash, false);
  await engine.restore(handled);
  await waitFor(() => engine.list()[0]?.done);
  assert.equal(engine.list()[0].completionHandled, true);

  const metadata = Buffer.from(engine.sessions()[0].torrentFile, 'base64');
  await engine.remove(seeded.infoHash, false);
  const fresh = await engine.add(metadata, { path: path.dirname(source), allowExisting: true });
  assert.equal(fresh.completionHandled, false);
});
