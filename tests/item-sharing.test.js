import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import parseTorrent from 'parse-torrent';
import { MAX_REVIEWED_SHARE_FILES, MAX_TORRENT_SHARE_BYTES, TorrentEngine, torrentSharePieceLength } from '../src/main/torrent.js';
import { acquireTorrentDescriptor, MAX_TORRENT_OPEN_DESCRIPTORS, torrentDescriptorBudgetSnapshot } from '../src/main/torrent-descriptor-budget.js';
import { contentKind, contentType } from '../src/shared/content-kind.js';

const waitFor = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await delay(25); } throw new Error('Timed out waiting for transfer.'); };
test('models are classified by selected content and users can override either category', () => {
  assert.equal(contentKind({ source: 'hf', files: [{ path: 'config.json' }] }), 'model');
  for (const name of ['weights.GGUF', 'model.safetensors', 'encoder.onnx', 'pytorch_model-00001.bin']) assert.equal(contentKind({ name }), 'model');
  for (const name of ['update.zip', 'movie.mkv', 'document.pdf', 'software.exe', 'firmware.bin']) assert.equal(contentKind({ name }), 'torrent');
  assert.equal(contentKind({ files: [{ path: 'model.gguf', selected: false }, { path: 'manual.pdf' }] }), 'torrent');
  assert.equal(contentKind({ name: 'model.safetensors', kind: 'torrent' }), 'torrent');
  assert.equal(contentKind({ name: 'config.json', kind: 'model' }), 'model');
  assert.equal(contentType({ name: 'manual.pdf' }), 'Documents');
  assert.equal(contentType({ name: 'movie.mkv' }), 'Video');
  assert.equal(contentType({ name: 'setup.exe' }), 'Software');
});

test('manifest sharing keeps paths while Off and seed-goal accounting survive restart', { timeout: 20000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-'))), asset = path.join(home, 'model');
  fs.mkdirSync(path.join(asset, 'nested'), { recursive: true });
  const files = [{ path: path.join(asset, 'config.json'), bytes: Buffer.from('{}\n') }, { path: path.join(asset, 'nested/weights.gguf'), bytes: crypto.randomBytes(256 * 1024) }];
  for (const file of files) fs.writeFileSync(file.path, file.bytes);
  fs.writeFileSync(path.join(asset, 'unrelated-private.txt'), 'not selected');
  let engine = new TorrentEngine({ dht: false, tracker: false, lsd: false, utp: false, allowPeerAddresses: true });
  const peer = new TorrentEngine({ dht: false, tracker: false, lsd: false, utp: false, allowPeerAddresses: true });
  peer.setDownloadPath(path.join(home, 'received'));
  t.after(async () => { await engine.destroy(); await peer.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  const torrent = await engine.seed(asset, { inventoryId: 'hf:fixture', files: files.map(file => ({ path: file.path, size: file.bytes.length })) });
  assert.equal(torrent.inventoryId, 'hf:fixture');
  assert.deepEqual(torrent.files.map(file => file.path).sort(), ['model/config.json', 'model/nested/weights.gguf']);
  assert.equal((await engine.client.get(torrent.infoHash)).pieceLength, torrentSharePieceLength(files.reduce((total, file) => total + file.bytes.length, 0)));
  await peer.add(torrent.magnetURI + '&x.pe=127.0.0.1:' + engine.port);
  await waitFor(() => peer.list()[0]?.done);
  for (const file of files) assert.deepEqual(fs.readFileSync(path.join(home, 'received/model', path.relative(asset, file.path))), file.bytes);
  assert.equal(fs.existsSync(path.join(home, 'received/model/unrelated-private.txt')), false);
  assert.ok(engine.list()[0].uploaded > 0);
  engine.doneAt.set(torrent.infoHash, Date.now() - 65_000);
  await engine.setSharing(torrent.infoHash, false);
  assert.equal(engine.list()[0].paused, true);
  assert.equal((await engine.client.get(torrent.infoHash)).wires.length, 0);
  const beforeRestart = engine.list()[0];
  const session = engine.sessions()[0]; assert.equal(session.paused, true); assert.equal(session.inventoryId, 'hf:fixture');
  assert.equal(session.uploadedBytes, beforeRestart.uploaded);
  assert.ok(session.seededMs >= 65_000);
  await engine.destroy(); engine = new TorrentEngine({ dht: false, tracker: false, lsd: false, utp: false, allowPeerAddresses: true });
  await engine.restore(session); await waitFor(() => engine.list()[0]?.done);
  const restored = engine.list()[0];
  assert.equal(restored.paused, true);
  assert.equal(restored.seeding, false);
  assert.equal(restored.uploaded, session.uploadedBytes, 'WebTorrent starts at zero and the saved upload baseline remains visible');
  assert.equal(restored.ratio, session.uploadedBytes / restored.downloaded);
  assert.ok(restored.seededMs >= session.seededMs, 'elapsed seed time survives the engine restart');
  assert.ok(restored.seededMs < session.seededMs + 10_000, 'time spent shut down is not counted as seeding');
  const raw = await engine.client.get(torrent.infoHash);
  const restoredDoneAt = engine.doneAt.get(torrent.infoHash);
  raw.emit('infoHash');
  assert.equal(engine.doneAt.get(torrent.infoHash), restoredDoneAt, 'a duplicate restore mark cannot reset elapsed seed time');
  raw.uploaded += 321;
  assert.equal(engine.list()[0].uploaded, session.uploadedBytes + 321, 'new uploads accumulate on the restored baseline');
  assert.equal(engine.sessions()[0].uploadedBytes, session.uploadedBytes + 321, 'the next snapshot stays cumulative');
  await engine.setSharing(torrent.infoHash, true);
  assert.equal(engine.list()[0].seeding, true);
  assert.equal(engine.list().length, 1);
  assert.equal(engine.list()[0].infoHash, torrent.infoHash);
  for (const file of files) assert.deepEqual(fs.readFileSync(file.path), file.bytes);
});

test('large sparse shares are bounded before hashing and use overflow-safe piece lengths', async t => {
  assert.equal(torrentSharePieceLength(0), 16 * 1024);
  assert.equal(torrentSharePieceLength(MAX_TORRENT_SHARE_BYTES), 16 * 1024 * 1024);
  assert.throws(() => torrentSharePieceLength(MAX_TORRENT_SHARE_BYTES + 1), /larger than 1 TiB/i);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-sparse-'));
  const model = path.join(home, 'model'), sparse = path.join(model, 'oversized.gguf');
  fs.mkdirSync(model); fs.writeFileSync(sparse, '');
  try { fs.truncateSync(sparse, MAX_TORRENT_SHARE_BYTES + 1); }
  catch (error) {
    fs.rmSync(home, { recursive: true, force: true });
    t.skip(`sparse files unavailable: ${error.code}`);
    return;
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inert = { _pendingRemovals: new Map(), _pendingSeeds: new Map(), client: { torrents: [] } };
  await assert.rejects(TorrentEngine.prototype.seed.call(inert, model), /larger than 1 TiB/i);
  await assert.rejects(
    TorrentEngine.prototype.seed.call(inert, model, { files: [{ path: sparse, size: MAX_TORRENT_SHARE_BYTES + 1 }] }),
    /larger than 1 TiB/i,
  );
});

test('reviewed local shares reserve descriptor headroom below the download metadata cap', async t => {
  assert.ok(MAX_REVIEWED_SHARE_FILES <= 4096);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-fd-cap-'))), model = path.join(home, 'model');
  fs.mkdirSync(model); fs.writeFileSync(path.join(model, 'one.bin'), 'x');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const files = Array.from({ length: MAX_REVIEWED_SHARE_FILES + 1 }, (_, index) => ({ path: path.join(model, `file-${index}.bin`), size: 0 }));
  const inert = { _pendingRemovals: new Map(), _pendingSeeds: new Map() };
  await assert.rejects(TorrentEngine.prototype.seed.call(inert, model, { files }), new RegExp(`no more than ${MAX_REVIEWED_SHARE_FILES} (downloaded )?files`, 'i'));
});

test('reviewed shares share the process descriptor budget and release a partial review on refusal', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-global-fd-budget-')));
  const source = path.join(home, 'model.bin');
  fs.writeFileSync(source, 'descriptor fixture');
  // Windows may not retain a directory descriptor, so saturate the full pool
  // there. POSIX leaves one slot to exercise cleanup after the root was opened.
  const heldCount = process.platform === 'win32' ? MAX_TORRENT_OPEN_DESCRIPTORS : MAX_TORRENT_OPEN_DESCRIPTORS - 1;
  const held = Array.from({ length: heldCount }, () => acquireTorrentDescriptor());
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(async () => {
    for (const permit of held) permit.release();
    await engine.destroy();
    fs.rmSync(home, { recursive: true, force: true });
  });

  await assert.rejects(engine.seed(source), error => error?.code === 'FROSTBYTE_DESCRIPTOR_BUDGET');
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, held.length, 'the root descriptor from the refused review was released');
  for (const permit of held) permit.release();
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, 0);

  const shared = await engine.seed(source);
  assert.ok([1, 2].includes(torrentDescriptorBudgetSnapshot().inUse), 'the reviewed file and supported root handle hold budget permits');
  await engine.remove(shared.infoHash, false);
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, 0);
});

test('engine destroy waits for the torrent store when TCP and uTP complete first', { timeout: 10000 }, async t => {
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, 0);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-destroy-boundary-')));
  const source = path.join(home, 'model.bin');
  fs.writeFileSync(source, crypto.randomBytes(32 * 1024));
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  let releaseStore = () => {};
  let releaseUtp = () => {};
  let destroyPromise = null;
  t.after(async () => {
    releaseStore();
    releaseUtp();
    await (destroyPromise || engine.destroy());
    fs.rmSync(home, { recursive: true, force: true });
  });
  if (!engine.client.utp) {
    t.skip('uTP is unavailable on this platform');
    return;
  }

  const shared = await engine.seed(source);
  await waitFor(() => engine.client.listening && engine.client._connPool?.utpServer);
  const torrent = await engine.client.get(shared.infoHash);
  assert.ok(torrent?.store);
  assert.ok(torrentDescriptorBudgetSnapshot().inUse > 0);

  let startStoreClose;
  const storeCloseStarted = new Promise(resolve => { startStoreClose = resolve; });
  let openStoreGate;
  const storeGate = new Promise(resolve => { openStoreGate = resolve; });
  releaseStore = () => openStoreGate();
  const closeStore = torrent.store.close.bind(torrent.store);
  torrent.store.close = callback => {
    startStoreClose();
    storeGate.then(() => closeStore(callback));
  };

  const tcpServer = engine.client._connPool.tcpServer;
  const utpServer = engine.client._connPool.utpServer;
  let tcpClosed = false;
  let utpClosed = false;
  let utpCloseRequested = false;
  let utpCallbackDelivered = false;
  const closeTcp = tcpServer.close.bind(tcpServer);
  const closeUtp = utpServer.close.bind(utpServer);
  tcpServer.close = callback => closeTcp((...args) => { tcpClosed = true; callback?.(...args); });
  utpServer.close = callback => {
    utpCloseRequested = true;
    utpCallbackDelivered = true;
    callback?.();
    let released = false;
    releaseUtp = () => {
      if (released) return;
      released = true;
      closeUtp((...args) => { utpClosed = true; callback?.(...args); });
    };
  };

  let destroySettled = false;
  destroyPromise = engine.destroy().finally(() => { destroySettled = true; });
  await storeCloseStarted;
  await waitFor(() => tcpClosed);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(utpCloseRequested, true);
  assert.equal(utpCallbackDelivered, true);
  assert.equal(utpClosed, false, 'the fixture keeps the native uTP server open without mutating its state');
  assert.equal(destroySettled, false, 'two peer-server callbacks cannot complete shutdown while a store is still open');
  assert.ok(torrentDescriptorBudgetSnapshot().inUse > 0, 'the delayed store still owns its reviewed descriptors');

  releaseStore();
  await destroyPromise;
  assert.equal(tcpClosed, true);
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, 0);
  releaseUtp();
  await waitFor(() => utpClosed);
});

test('a one-file model keeps its real filename and rejects linked content in manifest or folder shares', { timeout: 15000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-one-'))), model = path.join(home, 'model');
  fs.mkdirSync(model);
  const file = path.join(model, 'config.json'); fs.writeFileSync(file, '{}');
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(async () => { await engine.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  await assert.rejects(engine.seed(model, { files: [{ path: file, size: 999 }] }), /missing.*changed/);
  const torrent = await engine.seed(model, { inventoryId: 'hf:one', files: [{ path: file, size: 2 }] });
  assert.equal(torrent.name, 'config.json'); assert.equal(torrent.dataPath, file);
  assert.deepEqual(torrent.files.map(file => file.path), ['config.json']);
  assert.deepEqual((await parseTorrent((await engine.client.get(torrent.infoHash)).torrentFile)).announce, [], 'default sharing has no injected trackers');
  const trackedFile = path.join(home, 'tracked.bin'); fs.writeFileSync(trackedFile, 'tracker fixture');
  const tracker = 'https://tracker.example.invalid/announce';
  const tracked = await engine.seed(trackedFile, { announce: [tracker], name: 'Friendly label that is not a disk path' });
  assert.equal(tracked.name, path.basename(trackedFile), 'a display label cannot redirect the seeder away from the selected file');
  assert.deepEqual((await parseTorrent((await engine.client.get(tracked.infoHash)).torrentFile)).announce, [tracker], 'only the explicitly supplied tracker is embedded');
  await engine.setSharing(torrent.infoHash, false);
  assert.deepEqual(fs.readFileSync(file, 'utf8'), '{}');
  const outside = path.join(home, 'outside'); fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(model, 'linked.txt'));
  await assert.rejects(engine.seed(model, { files: [{ path: path.join(model, 'linked.txt'), size: 7 }] }), /Linked files/);
  await assert.rejects(engine.seed(model), /Symbolic links/);
  if (process.platform !== 'win32') {
    fs.unlinkSync(path.join(model, 'linked.txt'));
    fs.linkSync(outside, path.join(model, 'linked.txt'));
    await assert.rejects(engine.seed(model), /Hard-linked files/);
    const nonportable = path.join(home, 'back\\slash.bin'); fs.writeFileSync(nonportable, 'private');
    await assert.rejects(engine.seed(nonportable), /portable to Windows/i);
  }
});

test('sharing a previously paused local file again resumes its original torrent and attaches its inventory card', { timeout: 10000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-reshare-'))), file = path.join(home, 'weights.gguf');
  fs.writeFileSync(file, 'model fixture');
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(async () => { await engine.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  const original = await engine.seed(file);
  await engine.setSharing(original.infoHash, false);
  const shared = await engine.seed(file, { inventoryId: 'torrent:' + original.infoHash, files: [{ path: file, size: 13 }] });
  assert.equal(shared.infoHash, original.infoHash); assert.equal(shared.seeding, true); assert.equal(shared.paused, false);
  assert.equal(engine.list().length, 1); assert.equal(engine.sessions()[0].paused, false);
  assert.equal(shared.inventoryId, 'torrent:' + original.infoHash);
});

test('identical files in a second model cannot take over the first model sharing switch', { timeout: 10000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-shared-copies-')));
  for (const model of ['first', 'second']) { fs.mkdirSync(path.join(home,model)); fs.writeFileSync(path.join(home,model,'config.json'), '{}'); }
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(async () => { await engine.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  const share = model => engine.seed(path.join(home,model), { inventoryId: 'hf:' + model, files: [{ path: path.join(home,model,'config.json'), size: 2 }] });
  const first = await share('first');
  await engine.setSharing(first.infoHash, false);
  await assert.rejects(share('second'), /another item/);
  assert.equal(engine.list().length, 1);
  assert.equal(engine.list()[0].inventoryId, 'hf:first');
  assert.equal(engine.list()[0].paused, true);
  assert.equal(engine.list()[0].seeding, false);
  await share('first'); assert.equal(engine.list()[0].seeding, true);
});

async function pullReviewedShare(t, home, source, seedOptions, mutate, expectedFiles) {
  let reviews = 0;
  const seeder = new TorrentEngine({
    dht: false, tracker: false, lsd: false, utp: false, allowPeerAddresses: true,
    afterShareReview() { reviews++; mutate(); },
  });
  const peer = new TorrentEngine({ dht: false, tracker: false, lsd: false, utp: false, allowPeerAddresses: true });
  const destination = path.join(home, 'received');
  peer.setDownloadPath(destination);
  try {
    const shared = await seeder.seed(source, seedOptions);
    assert.equal(reviews, 1);
    assert.equal(seeder._shareLeases.size, 1, 'reviewed descriptors stay open only while the share is live');
    await waitFor(() => seeder.port);
    await peer.add(`${shared.magnetURI}&x.pe=127.0.0.1:${seeder.port}`);
    await waitFor(() => peer.list()[0]?.done);
    for (const [relative, bytes] of expectedFiles) {
      assert.deepEqual(fs.readFileSync(path.join(destination, relative)), bytes, `${relative} came from its reviewed descriptor`);
    }
    await seeder.remove(shared.infoHash, false);
    assert.equal(seeder._shareLeases.size, 0, 'removal closes every descriptor lease');
  } finally {
    await seeder.destroy();
    await peer.destroy();
  }
}

function swapReviewedDirectory(source, reviewed, replacement) {
  try {
    fs.renameSync(source, reviewed);
  } catch (error) {
    // Windows can deny renaming a directory containing the reviewed open
    // descriptors. That prevents the attack before substitution; still pull
    // the share below and verify that only its reviewed bytes are served.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    assert.ok(fs.statSync(source).isDirectory(), 'the denied swap retained the original root');
    assert.equal(fs.existsSync(reviewed), false, 'the denied rename moved no reviewed root');
    assert.ok(fs.statSync(replacement).isDirectory(), 'the replacement was never activated');
    return false;
  }
  fs.renameSync(replacement, source);
  return true;
}

test('reviewed descriptors defeat regular-inode, root, and inventory path swaps', { timeout: 30000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-swap-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  {
    const root = path.join(home, 'ordinary-file'); fs.mkdirSync(root);
    const source = path.join(root, 'weights.gguf'), reviewed = path.join(root, 'reviewed.gguf');
    const safe = crypto.randomBytes(64 * 1024), outside = Buffer.alloc(safe.length, 0x7a);
    fs.writeFileSync(source, safe);
    await pullReviewedShare(t, root, source, {}, () => {
      fs.renameSync(source, reviewed);
      fs.writeFileSync(source, outside);
    }, [['weights.gguf', safe]]);
    assert.deepEqual(fs.readFileSync(source), outside, 'the replacement inode was never hashed or served');
  }

  {
    const root = path.join(home, 'ordinary-folder'); fs.mkdirSync(root);
    const source = path.join(root, 'model'), reviewed = path.join(root, 'reviewed-model'), replacement = path.join(root, 'replacement');
    const safe = crypto.randomBytes(48 * 1024), outside = Buffer.alloc(safe.length, 0x6b);
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true }); fs.writeFileSync(path.join(source, 'nested/model.bin'), safe);
    fs.mkdirSync(path.join(replacement, 'nested'), { recursive: true }); fs.writeFileSync(path.join(replacement, 'nested/model.bin'), outside);
    let swapped;
    await pullReviewedShare(t, root, source, {}, () => {
      swapped = swapReviewedDirectory(source, reviewed, replacement);
    }, [['model/nested/model.bin', safe]]);
    assert.deepEqual(fs.readFileSync(path.join(source, 'nested/model.bin')), swapped ? outside : safe,
      swapped ? 'the substituted root was never hashed or served' : 'the blocked swap retained the reviewed bytes');
    if (!swapped) assert.deepEqual(fs.readFileSync(path.join(replacement, 'nested/model.bin')), outside, 'unshared replacement bytes remained untouched');
  }

  {
    const root = path.join(home, 'inventory-many'); fs.mkdirSync(root);
    const source = path.join(root, 'model'), reviewed = path.join(root, 'reviewed-model'), replacement = path.join(root, 'replacement');
    const safeA = crypto.randomBytes(24 * 1024), safeB = crypto.randomBytes(28 * 1024);
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'a.json'), safeA); fs.writeFileSync(path.join(source, 'nested/b.bin'), safeB);
    fs.mkdirSync(path.join(replacement, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(replacement, 'a.json'), Buffer.alloc(safeA.length, 0x31));
    fs.writeFileSync(path.join(replacement, 'nested/b.bin'), Buffer.alloc(safeB.length, 0x32));
    const files = [{ path: path.join(source, 'a.json'), size: safeA.length }, { path: path.join(source, 'nested/b.bin'), size: safeB.length }];
    let swapped;
    await pullReviewedShare(t, root, source, { inventoryId: 'hf:many', files }, () => {
      swapped = swapReviewedDirectory(source, reviewed, replacement);
    }, [['model/a.json', safeA], ['model/nested/b.bin', safeB]]);
    if (!swapped) {
      assert.deepEqual(fs.readFileSync(path.join(source, 'a.json')), safeA);
      assert.deepEqual(fs.readFileSync(path.join(source, 'nested/b.bin')), safeB);
      assert.deepEqual(fs.readFileSync(path.join(replacement, 'a.json')), Buffer.alloc(safeA.length, 0x31));
      assert.deepEqual(fs.readFileSync(path.join(replacement, 'nested/b.bin')), Buffer.alloc(safeB.length, 0x32));
    }
  }
});

test('an inventory symlink swap cannot redirect hashing or serving outside its reviewed file', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-link-swap-'))), model = path.join(home, 'model');
  fs.mkdirSync(model);
  const source = path.join(model, 'config.json'), reviewed = path.join(model, 'reviewed.json'), outside = path.join(home, 'outside.json');
  const safe = Buffer.from('{"reviewed":true}\n'), privateBytes = Buffer.from('{"private!":true}\n');
  assert.equal(safe.length, privateBytes.length);
  fs.writeFileSync(source, safe); fs.writeFileSync(outside, privateBytes);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await pullReviewedShare(t, home, model, { inventoryId: 'hf:one', files: [{ path: source, size: safe.length }] }, () => {
    fs.renameSync(source, reviewed);
    fs.symlinkSync(outside, source);
  }, [['config.json', safe]]);
  assert.deepEqual(fs.readFileSync(outside), privateBytes);
});

test('a hard link added after review aborts before metadata or serving and closes descriptors', { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-hardlink-race-'))), source = path.join(home, 'model.bin');
  fs.writeFileSync(source, crypto.randomBytes(32 * 1024));
  const engine = new TorrentEngine({
    dht: false, tracker: false, lsd: false,
    afterShareReview() { fs.linkSync(source, path.join(home, 'outside-link.bin')); },
  });
  t.after(async () => { await engine.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  await assert.rejects(engine.seed(source), /reviewed shared file changed|hard-linked/i);
  assert.equal(engine.list().length, 0);
  assert.equal(engine._shareLeases.size, 0);
});

test('addition rollback owns exact torrents and restores a pre-existing share intent', { timeout: 15000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-rollback-'))), source = path.join(home, 'model.bin');
  fs.writeFileSync(source, crypto.randomBytes(32 * 1024));
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(async () => { await engine.destroy(); fs.rmSync(home, { recursive: true, force: true }); });

  const created = await engine.seed(source);
  const firstIdentity = engine.transferIdentity(created.infoHash);
  assert.equal(engine.isCurrentIdentity(firstIdentity), true);
  await engine.setSharing(created.infoHash, false);
  const reshared = await engine.seed(source, { inventoryId: 'hf:attached', files: [{ path: source, size: fs.statSync(source).size }] });
  assert.equal(engine.list()[0].paused, false);
  assert.equal(engine.list()[0].inventoryId, 'hf:attached');
  assert.equal(await engine.rollbackAddition(reshared), true);
  assert.equal(engine.list()[0].paused, true);
  assert.equal(engine.list()[0].inventoryId, undefined);

  const duplicate = await engine.add(created.magnetURI, { path: home });
  assert.equal(await engine.rollbackAddition(duplicate), false, 'an unchanged deduplicated torrent is never removed');
  assert.equal(engine.list().length, 1);

  await engine.remove(created.infoHash, false);
  const replacement = await engine.seed(source);
  assert.equal(replacement.infoHash, created.infoHash);
  assert.equal(engine.isCurrentIdentity(firstIdentity), false, 'remove and re-add invalidates the old exact-object token');
  assert.equal(engine.isCurrentIdentity(engine.transferIdentity(replacement.infoHash)), true);
  assert.equal(await engine.rollbackAddition(replacement), true);
  assert.equal(engine.list().length, 0);
  assert.equal(engine._shareLeases.size, 0);
});

test('failed add/seed publication cleans created torrents and failed remove keeps queue intent', { timeout: 10000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-share-failures-'))), source = path.join(home, 'model.bin');
  fs.writeFileSync(source, crypto.randomBytes(16 * 1024));

  const seedEngine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const seedFailure = new Error('simulated seed publication failure');
  seedEngine.on('seeding', () => { throw seedFailure; });
  await assert.rejects(seedEngine.seed(source), error => error === seedFailure);
  assert.equal(seedEngine.list().length, 0);
  assert.equal(seedEngine._shareLeases.size, 0);
  await seedEngine.destroy();

  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(async () => { await engine.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  const addFailure = new Error('simulated add publication failure');
  engine.on('updated', () => { throw addFailure; });
  await assert.rejects(engine.add('a'.repeat(40), { path: path.join(home, 'downloads') }), error => error === addFailure);
  assert.equal(engine.list().length, 0, 'a rejected add does not leave its created torrent running');
  engine.removeAllListeners('updated');

  const shared = await engine.seed(source);
  engine.userPaused.add(shared.infoHash);
  engine.autoQueued.push(shared.infoHash);
  const remove = engine.client.remove;
  engine.client.remove = async () => { throw new Error('simulated remove failure'); };
  await assert.rejects(engine.remove(shared.infoHash, false), /simulated remove failure/);
  engine.client.remove = remove;
  assert.equal(engine.userPaused.has(shared.infoHash), true);
  assert.deepEqual(engine.autoQueued, [shared.infoHash]);
});
