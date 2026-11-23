import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-reliability-')));
process.env.FROSTBYTE_HOME = path.join(root, 'config');
const { Store } = await import('../src/main/store.js');
const { TorrentEngine, extractInfoHash } = await import('../src/main/torrent.js');
const { Catalog } = await import('../src/main/catalog.js');
const { moveCompleted, RateManager, UpnpManager, completionPathIdentity,
  completionRecoveryDisposition, removeOwnedCompletionPath, sameLocalPath } = await import('../src/main/managers.js');
const { hfDownloadFile, hfDestination, hfDestinationPathKeys, hfStatFile, hfTransferId, normalizeHfTransferRecord, validateHfDownloadSelection, validateHfFilePath, validateHfRepoId, sha256File } = await import('../src/main/hf.js');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const waitFor = async (check, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (!await check()) { if (Date.now() > until) throw new Error('Condition timed out'); await delay(40); }
};
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a fresh profile cannot map the router before explicit settings approval', async () => {
  const fresh = new Store();
  assert.equal(fresh.getSettings().upnpEnabled, false);
  let clients = 0;
  class Nat { constructor() { clients++; } async map() {} async destroy() {} }
  const upnp = new UpnpManager({ NatAPI: Nat });
  if (fresh.getSettings().upnpEnabled) await upnp.enable(6881);
  assert.equal(clients, 0);
});

test('restored HF state never silently repeats active, paused, or cancelled intent', () => {
  const baseDir = path.join(root, 'hf-restore-intent');
  const record = { repoId: 'fixture/intent', revision: 'a'.repeat(40), filePath: 'model.bin', baseDir,
    total: 10, downloaded: 4, status: 'active', error: '', startedAt: 1 };
  assert.equal(normalizeHfTransferRecord(record, { forRestore: true }).status, 'paused');
  assert.equal(normalizeHfTransferRecord({ ...record, pauseRequested: true }, { forRestore: true }).status, 'paused');
  assert.equal(normalizeHfTransferRecord({ ...record, cancelled: true }, { forRestore: true }).status, 'cancelled');
  assert.equal(normalizeHfTransferRecord({ ...record, status: 'queued' }, { forRestore: true }).status, 'queued');
});

test('restart recovery trusts only the exact journaled completed destination', () => {
  const sourceIdentity = { type: 'file', dev: '1', ino: '10' };
  const destinationIdentity = { type: 'file', dev: '1', ino: '20' };
  const move = { phase: 'published', sourceIdentity, destinationIdentity };
  const missingSource = { state: 'missing', identity: null };
  assert.deepEqual(completionRecoveryDisposition(move, {
    sourceState: missingSource,
    destinationState: { state: 'present', identity: destinationIdentity },
  }), { published: true, recoverSource: false, recoveryRequired: false });

  const exactSource = { state: 'present', identity: sourceIdentity };
  assert.deepEqual(completionRecoveryDisposition(move, {
    sourceState: exactSource,
    destinationState: { state: 'present', identity: destinationIdentity },
  }), { published: false, recoverSource: true, recoveryRequired: false });
  assert.deepEqual(completionRecoveryDisposition(move, {
    sourceState: exactSource,
    destinationState: { state: 'present', identity: destinationIdentity },
    recoveredPublishedFile: true,
  }), { published: true, recoverSource: false, recoveryRequired: false });
  const replacement = { state: 'present', identity: { type: 'file', dev: '1', ino: '21' } };
  assert.deepEqual(completionRecoveryDisposition(move, {
    sourceState: exactSource, destinationState: replacement,
  }), { published: false, recoverSource: true, recoveryRequired: false });
  assert.deepEqual(completionRecoveryDisposition(move, {
    sourceState: exactSource, destinationState: { state: 'missing', identity: null },
  }), { published: false, recoverSource: true, recoveryRequired: false });
  assert.deepEqual(completionRecoveryDisposition(move, {
    sourceState: missingSource, destinationState: replacement,
  }), { published: false, recoverSource: false, recoveryRequired: true });
});

test('catalog keeps distinct magnet-only entries, edits identity, and hides starter entries', () => {
  const store = new Store();
  const catalog = new Catalog(store);
  assert.deepEqual(catalog.all(), [], 'production catalog has no bundled demo data');
  const starter = {id:'fixture-starter',name:'Fixture starter',infohash:'d'.repeat(40)};
  catalog._starter = [starter];
  const a = catalog.add({name:'First', magnet:'magnet:?xt=urn:btih:' + 'a'.repeat(40)});
  const b = catalog.add({name:'Second', magnet:'magnet:?xt=urn:btih:' + 'b'.repeat(40)});
  assert.equal(store.getUserCatalog().length, 2);
  assert.equal(a.infohash, 'a'.repeat(40));
  catalog.add({...a, name:'Edited', magnet:'magnet:?xt=urn:btih:'+'c'.repeat(40), infohash:''});
  assert.equal(store.getUserCatalog().length, 2);
  assert.equal(catalog.all().find(m => m.id === a.id).name, 'Edited');
  assert.equal(catalog.annotate([b], [{infoHash:b.infohash, seeding:true}])[0].seeding, true);
  assert.equal(catalog.remove(starter.id), true);
  const reloaded = new Catalog(new Store());
  reloaded._starter = [starter];
  assert.equal(reloaded.all().some(m => m.id === starter.id), false);
});

test('catalog imports are bounded, validate fields, and flush once', () => {
  const store = new Store();
  store.setUserCatalog([]);
  const catalog = new Catalog(store);
  let writes = 0;
  const save = store.setCatalogState.bind(store);
  store.setCatalogState = (value, hidden) => { writes++; return save(value, hidden); };
  const result = catalog.addMany([
    { name: 'Good', magnet: 'magnet:?xt=urn:btih:' + '1'.repeat(40), tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`) },
    { name: 'x'.repeat(201), magnet: 'magnet:?xt=urn:btih:' + '2'.repeat(40) },
    { name: 'Missing identity' },
  ]);
  assert.equal(result.added.length, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.added[0].tags.length, 32);
  assert.equal(writes, 1);
  assert.throws(() => catalog.addMany(Array.from({ length: 2001 }, () => ({}))), /up to 2000/);
});

test('catalog imports bind magnets to their declared content and discard network hints', () => {
  const store = new Store();
  store.setUserCatalog([]);
  const catalog = new Catalog(store);
  const good = catalog.addMany([{
    name: 'Sanitized',
    infohash: '3'.repeat(40),
    magnet: `magnet:?xt=urn:btih:${'3'.repeat(40)}&tr=http://127.0.0.1/announce&ws=https://example.test/model&x.pe=10.0.0.1:6881`,
    torrent: '\\\\attacker\\share\\model.torrent',
  }]).added[0];
  assert.equal(good.magnet, `magnet:?xt=urn:btih:${'3'.repeat(40)}`);
  assert.equal(good.torrent, '');
  const bad = catalog.addMany([{
    name: 'Mismatch', infohash: '4'.repeat(40), magnet: `magnet:?xt=urn:btih:${'5'.repeat(40)}`,
  }]);
  assert.equal(bad.added.length, 0);
  assert.equal(bad.skipped, 1);
  assert.throws(() => catalog.add({ name: 'Filesystem source', infohash: '6'.repeat(40), magnet: '\\\\attacker\\share\\model.torrent' }), /magnet scheme/);
});

test('settings writes survive reload and invalid values leave the old state intact', () => {
  const store = new Store();
  const directory = path.join(root, 'downloads');
  store.setSettings({downloadDir:directory, bigPullGB:70, confirmBigPull:false, sparkDownloadHost:'fixture-spark', sparkDownloadDir:'/media/fixture/Models'});
  assert.equal(new Store().getSettings().bigPullGB, 70);
  assert.equal(new Store().getSettings().confirmBigPull, false);
  assert.equal(new Store().getSettings().sparkDownloadDir, '/media/fixture/Models');
  assert.equal(new Store().getSettings().sparkDownloadHost, 'fixture-spark');
  assert.throws(() => store.setSettings({sparkDownloadDir:'relative/models'}));
  assert.throws(() => store.setSettings({sparkDownloadDir:'/media/bad\0path'}));
  assert.throws(() => store.setSettings({maxActiveDownloads:1.5}));
  assert.throws(() => store.setSettings({downLimitKBs:Infinity}));
  assert.throws(() => store.setSettings({catalogUrl:'http://example.com/models.json'}));
  assert.throws(() => store.setSettings({extraTrackers:'file:///tmp/tracker'}));
  assert.throws(() => store.setSettings({extraTrackers:'http://127.0.0.1:8080/announce'}));
  assert.equal(store.setSettings({extraTrackers:'udp://tracker.opentrackr.org:1337/announce'}).extraTrackers, 'udp://tracker.opentrackr.org:1337/announce');
  assert.equal(store.getSettings().maxActiveDownloads, 0);
  assert.equal(fs.existsSync(path.join(store.appDir, 'settings.json.tmp')), false);
  const broken = '{"downloadDir":'; // simulate an old interrupted JSON write
  fs.writeFileSync(path.join(store.appDir, 'settings.json'), broken);
  const recovered = new Store();
  const backup = fs.readdirSync(store.appDir).find(name => name.startsWith('settings.json.corrupt-'));
  assert.equal(fs.readFileSync(path.join(store.appDir, backup), 'utf8'), broken);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(store.appDir, 'settings.json'), 'utf8')));
  const backups = fs.readdirSync(store.appDir).filter(name => name.startsWith('settings.json.corrupt-')).length;
  new Store();
  assert.equal(fs.readdirSync(store.appDir).filter(name => name.startsWith('settings.json.corrupt-')).length, backups, 'recovery is one-shot');
  recovered.setSettings(store.getSettings());
});

test('failed state writes do not accept catalog, library, category, credential, or update mutations', () => {
  const store = new Store();
  store.setUserCatalog([]);
  store.state.hiddenCatalog = [];
  store.state.library = [];
  store.state.itemKinds = {};
  store.setUpdateCheck({ lastChecked: 10, latest: null });
  store.setHfCredentialState({ hfTokenEnc: 'QUJDRA==', hfTokenPlain: undefined, hfTokenMigrationRequired: false,
    hfUser: 'fixture-user', hfRole: 'read' });
  const catalog = new Catalog(store);
  const existing = catalog.add({ name: 'Existing', infohash: '7'.repeat(40) });
  store.addToLibrary({ path: path.join(root, 'persisted-library'), name: 'Persisted', infohash: '8'.repeat(40) });
  store.setItemKinds({ ['torrent:' + '8'.repeat(40)]: 'model' });
  const before = structuredClone({ userCatalog: store.state.userCatalog, hiddenCatalog: store.state.hiddenCatalog,
    library: store.state.library, itemKinds: store.state.itemKinds, updateCheck: store.state.updateCheck,
    hfTokenEnc: store.state.hfTokenEnc, hfTokenPlain: store.state.hfTokenPlain,
    hfTokenMigrationRequired: store.state.hfTokenMigrationRequired, hfUser: store.state.hfUser, hfRole: store.state.hfRole });
  const flush = store._flush;
  store._flush = () => { throw new Error('fixture state write failed'); };
  try {
    assert.throws(() => catalog.add({ name: 'Rejected', infohash: '9'.repeat(40) }), /state write failed/);
    assert.throws(() => catalog.remove(existing.id), /state write failed/);
    assert.throws(() => store.addToLibrary({ path: path.join(root, 'rejected-library'), name: 'Rejected', infohash: 'a'.repeat(40) }), /state write failed/);
    assert.throws(() => store.removeFromLibrary(path.join(root, 'persisted-library')), /state write failed/);
    assert.throws(() => store.removeFromLibraryByHash('8'.repeat(40)), /state write failed/);
    assert.throws(() => store.setItemKinds({ ['torrent:' + 'b'.repeat(40)]: 'torrent' }), /state write failed/);
    assert.throws(() => store.setUpdateCheck({ lastChecked: 20, latest: null }), /state write failed/);
    assert.throws(() => store.setHfCredentialState({ hfTokenEnc: '', hfTokenPlain: undefined, hfTokenMigrationRequired: true,
      hfUser: '', hfRole: '' }), /state write failed/);
    assert.deepEqual({ userCatalog: store.state.userCatalog, hiddenCatalog: store.state.hiddenCatalog,
      library: store.state.library, itemKinds: store.state.itemKinds, updateCheck: store.state.updateCheck,
      hfTokenEnc: store.state.hfTokenEnc, hfTokenPlain: store.state.hfTokenPlain,
      hfTokenMigrationRequired: store.state.hfTokenMigrationRequired, hfUser: store.state.hfUser, hfRole: store.state.hfRole }, before);
  } finally { store._flush = flush; }
  assert.throws(() => store.setHfCredentialState({ hfTokenEnc: '', hfTokenPlain: 'plaintext', hfTokenMigrationRequired: false,
    hfUser: '', hfRole: '' }), /cannot save a plaintext/);
});

test('invalid but parseable settings are quarantined instead of crashing startup', () => {
  const file = path.join(process.env.FROSTBYTE_HOME, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ downloadDir: 42, theme: '<script>', confirmBigPull: false, unknownFutureKey: true }));
  const recovered = new Store();
  assert.equal(recovered.getSettings().downloadDir, path.join(os.homedir(), 'FrostByte'));
  assert.equal(recovered.getSettings().theme, 'frost');
  assert.equal(recovered.getSettings().confirmBigPull, false);
  assert.equal(Object.hasOwn(recovered.getSettings(), 'unknownFutureKey'), false);
  const backup = fs.readdirSync(recovered.appDir).find(name => name.startsWith('settings.json.invalid-'));
  assert.ok(backup, 'the original editable settings file is preserved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(recovered.appDir, backup), 'utf8')).downloadDir, 42);
});

test('settings storage does not follow a substituted symlink', { skip: process.platform === 'win32' }, () => {
  const file = path.join(process.env.FROSTBYTE_HOME, 'settings.json');
  const target = path.join(root, 'outside-settings.json');
  const outside = JSON.stringify({ downloadDir: '/should/not/be/read' });
  fs.writeFileSync(target, outside);
  fs.rmSync(file, { force: true });
  fs.symlinkSync(target, file);
  const recovered = new Store();
  assert.equal(recovered.getSettings().downloadDir, path.join(os.homedir(), 'FrostByte'));
  assert.equal(fs.readFileSync(target, 'utf8'), outside);
  assert.ok(fs.readdirSync(recovered.appDir).some(name => name.startsWith('settings.json.unsafe-')));
});

test('settings descriptor rejects a pathname replacement before chmod or read', () => {
  const store = new Store();
  store.setSettings({ bigPullGB: 73 });
  const file = path.join(store.appDir, 'settings.json');
  const displaced = path.join(store.appDir, 'settings-before-race.json');
  const replacement = path.join(store.appDir, 'settings-race-replacement.json');
  const replacementBody = JSON.stringify({ bigPullGB: 1, downloadDir: path.join(root, 'attacker-choice') });
  fs.writeFileSync(replacement, replacementBody, { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(replacement, 0o644);

  const openSync = fs.openSync, readSync = fs.readSync, fchmodSync = fs.fchmodSync;
  let replacementFd = null, replacementReads = 0, replacementChmods = 0, swapped = false;
  fs.openSync = (target, ...args) => {
    if (!swapped && target === file) {
      swapped = true;
      fs.renameSync(file, displaced);
      fs.renameSync(replacement, file);
    }
    const fd = openSync(target, ...args);
    if (swapped && target === file) replacementFd = fd;
    return fd;
  };
  fs.readSync = (fd, ...args) => {
    if (fd === replacementFd) replacementReads++;
    return readSync(fd, ...args);
  };
  fs.fchmodSync = (fd, ...args) => {
    if (fd === replacementFd) replacementChmods++;
    return fchmodSync(fd, ...args);
  };
  try {
    assert.throws(() => new Store(), /Saved data path changed/);
    assert.equal(replacementReads, 0);
    assert.equal(replacementChmods, 0);
    assert.equal(fs.statSync(file).size, Buffer.byteLength(replacementBody));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  } finally {
    fs.openSync = openSync; fs.readSync = readSync; fs.fchmodSync = fchmodSync;
    if (swapped) {
      if (fs.existsSync(file)) fs.renameSync(file, replacement);
      if (fs.existsSync(displaced)) fs.renameSync(displaced, file);
    }
  }
  assert.equal(fs.readFileSync(replacement, 'utf8'), replacementBody);
});

test('oversized saved settings are rejected before descriptor body reads', () => {
  const store = new Store();
  const file = path.join(store.appDir, 'settings.json');
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 0x20));
  const openSync = fs.openSync, readSync = fs.readSync, closeSync = fs.closeSync;
  let settingsFd = null, settingsReads = 0;
  fs.openSync = (target, ...args) => {
    const fd = openSync(target, ...args);
    if (target === file) settingsFd = fd;
    return fd;
  };
  fs.readSync = (fd, ...args) => {
    if (fd === settingsFd) settingsReads++;
    return readSync(fd, ...args);
  };
  fs.closeSync = (fd, ...args) => {
    if (fd === settingsFd) settingsFd = null;
    return closeSync(fd, ...args);
  };
  try {
    const recovered = new Store();
    assert.equal(recovered.getSettings().downloadDir, path.join(os.homedir(), 'FrostByte'));
    assert.equal(settingsReads, 0);
  } finally {
    fs.openSync = openSync; fs.readSync = readSync; fs.closeSync = closeSync;
  }
  assert.ok(fs.readdirSync(store.appDir).some(name => name.startsWith('settings.json.corrupt-')));
});

test('saved item categories are typed, identity-bound, and capped', () => {
  const store = new Store();
  const stateFile = path.join(store.appDir, 'state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  state.itemKinds = {
    ['torrent:' + 'a'.repeat(40)]: 'torrent',
    ['shared:' + 'b'.repeat(40)]: 'model',
    ['hf:' + 'c'.repeat(64)]: 'model',
    '__proto__': 'model',
    ['torrent:' + 'd'.repeat(40)]: '<script>',
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const restored = new Store();
  assert.deepEqual(restored.getItemKinds(), {
    ['torrent:' + 'a'.repeat(40)]: 'torrent',
    ['shared:' + 'b'.repeat(40)]: 'model',
    ['hf:' + 'c'.repeat(64)]: 'model',
  });
  assert.throws(() => restored.setItemKinds({ arbitrary: 'model' }), /Invalid item category/);
  restored.state.itemKinds = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [
    'hf:' + index.toString(16).padStart(64, '0'), index % 2 ? 'model' : 'torrent',
  ]));
  assert.equal(restored.getItemKinds() && Object.keys(restored.getItemKinds()).length, 10_000);
  restored._flush();
  restored.state.itemKinds = {};
  restored._flush();
});

test('HuggingFace transfer identity includes the selected destination', () => {
  const revision = 'a'.repeat(40);
  const first = hfTransferId('owner/model', revision, 'weights/model.gguf', path.join(root, 'one'));
  const second = hfTransferId('owner/model', revision, 'weights/model.gguf', path.join(root, 'two'));
  assert.notEqual(first, second);
  assert.equal(
    hfTransferId('owner/model', revision, 'weights/model.gguf', 'C:\\Models', 'win32'),
    hfTransferId('owner/model', revision, 'weights/model.gguf', 'c:\\models', 'win32'),
  );
  assert.equal(validateHfRepoId('owner/model-name'), 'owner/model-name');
  assert.throws(() => validateHfRepoId('../private-endpoint'));
});

test('HuggingFace selections reject portable filename aliases before download', () => {
  const revision = 'a'.repeat(40);
  for (const unsafe of ['CON', 'aux.json', 'weights.', 'weights ', 'weights?.gguf', `bad-${String.fromCharCode(1)}.bin`]) {
    assert.throws(() => validateHfFilePath(`weights/${unsafe}`), /Invalid repository file path/i, unsafe);
  }
  assert.throws(() => validateHfRepoId('NUL/model'), /repository ID/i);
  assert.equal(validateHfFilePath('weights/CON', 'linux'), 'weights/CON', 'platform policy remains independently testable');
  for (const paths of [
    ['Weights/model.gguf', 'weights/MODEL.gguf'],
    ['weights/Caf\u00e9.gguf', 'weights/Cafe\u0301.gguf'],
    ['weights/model', 'weights/model/config.json'],
    ['weights/model.gguf', 'weights/model.gguf.frostpart'],
  ]) assert.throws(() => validateHfDownloadSelection('owner/model', paths), /collide|file and folder/i, paths.join(', '));
  assert.throws(() => validateHfDownloadSelection('owner/model', ['x'.repeat(245)]), /longer than/i);

  assert.equal(
    hfTransferId('owner/model', revision, 'Weights/Caf\u00e9.gguf', '/Models', 'darwin'),
    hfTransferId('OWNER/MODEL', revision.toUpperCase(), 'weights/Cafe\u0301.gguf', '/models', 'darwin'),
    'default macOS case and Unicode aliases have one transfer identity',
  );
  assert.deepEqual(
    hfDestinationPathKeys('/Models/owner/model/Weights.gguf', { platform: 'darwin' }),
    hfDestinationPathKeys('/models/OWNER/MODEL/weights.gguf', { platform: 'darwin' }),
  );
});

test('a manual turtle toggle can override an active schedule in either direction', () => {
  const settings = {bandwidthMode:'schedule',schedEnabled:true,schedFrom:'00:00',schedTo:'00:00',schedDays:[1,1,1,1,1,1,1]};
  const rates = new RateManager({}, () => settings);
  assert.equal(rates.inAltMode(), true);
  settings.bandwidthMode = 'normal';
  assert.equal(rates.inAltMode(), false);
  settings.bandwidthMode = 'alt';
  assert.equal(rates.inAltMode(), true);
});

test('UPnP serializes mapping requests and waits for confirmed unmapping on disable', async () => {
  let instances = 0, mapped = 0, unmapped = 0, destroyed = 0;
  class Nat {
    constructor() { instances++; }
    async map() { await delay(20); mapped++; return true; }
    async unmap() { unmapped++; return true; }
    async destroy() { await delay(10); destroyed++; }
  }
  const upnp = new UpnpManager({NatAPI:Nat});
  const requests = [upnp.enable(3000), upnp.enable(3000), upnp.enable(3000)];
  await delay(5);
  await upnp.disable();
  await Promise.all(requests);
  assert.equal(instances, 1);
  assert.equal(mapped, 2);
  assert.equal(unmapped, 2);
  assert.equal(destroyed, 1);
  assert.equal(upnp.mappedPort, null);
});

test('a failed UPnP unmap keeps the live mapping visible and retryable', async () => {
  let unmaps = 0, destroys = 0;
  class Nat {
    async map() { return true; }
    async unmap() { unmaps++; return unmaps !== 1; }
    async destroy() { destroys++; }
  }
  const upnp = new UpnpManager({ NatAPI: Nat });
  await upnp.enable(4567);
  const client = upnp.client;
  await assert.rejects(upnp.disable(), /did not confirm removal/);
  assert.equal(upnp.wanted, false);
  assert.equal(upnp.client, client);
  assert.equal(upnp.mappedPort, 4567);
  assert.deepEqual(upnp.status(), { mappedPort: 4567, cleanupPendingPort: 4567 });
  assert.equal(await upnp.enable(4567), true);
  assert.equal(upnp.wanted, true);
  await upnp.disable();
  assert.equal(destroys, 1);
  assert.equal(upnp.client, null);
  assert.equal(upnp.mappedPort, null);
});

test('a false NAT mapping result never claims that the router is mapped', async () => {
  let instances = 0, maps = 0, destroyed = 0;
  class Nat {
    constructor() { this.instance = ++instances; }
    async map() { maps++; return this.instance > 1; }
    async unmap() { throw new Error('nothing was mapped'); }
    async destroy() { destroyed++; }
  }
  const upnp = new UpnpManager({ NatAPI: Nat });
  assert.equal(await upnp.enable(4568), false);
  assert.equal(upnp.mappedPort, null);
  assert.equal(upnp.client, null);
  assert.equal(destroyed, 1);
  upnp.retryAt = 0;
  assert.equal(await upnp.enable(4568), true);
  assert.equal(instances, 2);
  assert.equal(maps, 3, 'the second attempt performs both TCP and UDP map calls');
  assert.equal(upnp.mappedPort, 4568);
});

test('a thrown TCP map remains cleanup-only state and re-enable performs a fresh map', async () => {
  let instances = 0, maps = 0, unmaps = 0, destroyed = 0;
  class Nat {
    constructor() { this.instance = ++instances; }
    async map() {
      maps++;
      if (this.instance === 1) throw new Error('router reply was lost');
      return true;
    }
    async unmap() { unmaps++; return unmaps > 1; }
    async destroy() { destroyed++; }
  }
  const upnp = new UpnpManager({ NatAPI: Nat });
  await assert.rejects(upnp.enable(4569), /could not be confirmed removed/);
  assert.equal(upnp.mappedPort, 4569);
  assert.equal(upnp.mappedProtocols.has('TCP'), false, 'a thrown request is not a confirmed mapping');
  assert.equal(upnp.uncertainProtocols.has('TCP'), true);
  assert.deepEqual(upnp.status(), { mappedPort: null, cleanupPendingPort: 4569 });
  assert.equal(upnp.client?.instance, 1);

  upnp.retryAt = 0;
  assert.equal(await upnp.enable(4569), true);
  assert.equal(instances, 2, 're-enable cleans the uncertain client and creates a new one');
  assert.equal(maps, 3, 're-enable performs fresh TCP and UDP map calls');
  assert.equal(unmaps, 2, 'the uncertain map is retried until removal is confirmed');
  assert.equal(destroyed, 1);
  assert.equal(upnp.mappedProtocols.has('TCP'), true);
  assert.equal(upnp.uncertainProtocols.size, 0);
  assert.deepEqual(upnp.status(), { mappedPort: 4569, cleanupPendingPort: null });
});

test('same-port callers wait for the complete in-flight UPnP result', async () => {
  let announceUdp, releaseUdp;
  const udpStarted = new Promise(resolve => { announceUdp = resolve; });
  const udpReply = new Promise((_, reject) => { releaseUdp = () => reject(new Error('UDP reply was lost')); });
  class Nat {
    async map({ protocol }) {
      if (protocol === 'TCP') return true;
      announceUdp();
      return udpReply;
    }
    async unmap() { return true; }
    async destroy() {}
  }
  const upnp = new UpnpManager({ NatAPI: Nat });
  const first = upnp.enable(4570);
  await udpStarted;
  const second = upnp.enable(4570);
  releaseUdp();
  assert.equal(await first, false);
  assert.equal(await second, false, 'a confirmed TCP step is not exposed before the whole attempt settles');
  assert.equal(upnp.mappedPort, null);
  assert.equal(upnp.client, null);
});

test('moving a finished model keeps siblings and preserves torrent identity after reopen', async () => {
  const source = path.join(root, 'move-source');
  const done = path.join(root, 'completed');
  fs.mkdirSync(source);
  const payload = crypto.randomBytes(128 * 1024);
  const file = path.join(source, 'weights.gguf');
  fs.writeFileSync(file, payload);
  fs.writeFileSync(path.join(source, 'still-downloading.gguf'), 'keep me');
  const engine = new TorrentEngine({dht:false,tracker:false,lsd:false});
  try {
    const t = await engine.seed(file);
    const record = engine.sessions()[0];
    assert.equal(t.dataPath, file);
    await engine.remove(t.infoHash, false);
    const moved = await moveCompleted(t.dataPath, done);
    assert.equal(moved.moved, true);
    assert.equal(fs.readFileSync(path.join(source, 'still-downloading.gguf'), 'utf8'), 'keep me');
    await engine.restore({...record, path:done});
    await waitFor(() => engine.list()[0]?.done);
    assert.equal(engine.list()[0].infoHash, t.infoHash);
    assert.equal(await sha256File(moved.dest), hash(payload));
    assert.equal((await moveCompleted(moved.dest, done)).moved, false);
  } finally { await engine.destroy(); }
});

test('move-on-complete rejects linked sources and completed folders', async t => {
  const source = path.join(root, 'move-links-source'), destination = path.join(root, 'move-links-destination');
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(source, 'model.bin'), 'model');
  const outside = path.join(root, 'outside.bin'); fs.writeFileSync(outside, 'outside');
  try { fs.symlinkSync(outside, path.join(source, 'linked.bin')); }
  catch { t.skip('symbolic links are unavailable'); return; }
  await assert.rejects(moveCompleted(source, destination), /Linked files/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  fs.rmSync(path.join(source, 'linked.bin'));
  const linkedDestination = path.join(root, 'move-links-alias'); fs.symlinkSync(destination, linkedDestination);
  await assert.rejects(moveCompleted(source, linkedDestination), /linked or unavailable/);
  assert.equal(fs.existsSync(source), true);

  const hardlinkSource = path.join(root, 'move-hardlink-source'), hardlinkVictim = path.join(root, 'move-hardlink-victim.bin');
  fs.mkdirSync(hardlinkSource); fs.writeFileSync(hardlinkVictim, 'shared inode');
  try { fs.linkSync(hardlinkVictim, path.join(hardlinkSource, 'model.bin')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error.code)) return; throw error; }
  await assert.rejects(moveCompleted(hardlinkSource, destination), /Hardlinked files/);
  assert.equal(fs.readFileSync(hardlinkVictim, 'utf8'), 'shared inode');
});

test('move-on-complete accepts stable ancestor aliases and journals canonical paths', async t => {
  const actual = path.join(root, 'completion-alias-target');
  const alias = path.join(root, 'completion-alias');
  fs.mkdirSync(path.join(actual, 'base'), { recursive: true });
  try { fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('directory aliases are unavailable'); return; }
    throw error;
  }
  const source = path.join(alias, 'base', 'model.bin');
  const destination = path.join(alias, 'base', 'completed');
  fs.writeFileSync(source, 'canonical bytes');
  const result = await moveCompleted(source, destination);
  const canonicalDestination = path.join(actual, 'base', 'completed', 'model.bin');
  assert.equal(result.dest, canonicalDestination);
  assert.equal(fs.readFileSync(canonicalDestination, 'utf8'), 'canonical bytes');
  assert.equal(fs.existsSync(source), false);

  const alreadyCompleted = path.join(actual, 'base', 'already-complete.bin');
  fs.writeFileSync(alreadyCompleted, 'already complete');
  const unchanged = await moveCompleted(alreadyCompleted, path.join(alias, 'base'));
  assert.deepEqual(unchanged, { moved: false, reason: 'already in completed folder', dest: alreadyCompleted });
  assert.equal(fs.readFileSync(alreadyCompleted, 'utf8'), 'already complete');

  const directSource = path.join(actual, 'direct.bin');
  fs.writeFileSync(directSource, 'direct alias child');
  const direct = await moveCompleted(directSource, path.join(alias, 'new-completed'));
  assert.equal(direct.dest, path.join(actual, 'new-completed', 'direct.bin'));
  assert.equal(fs.readFileSync(direct.dest, 'utf8'), 'direct alias child');
});

test('an invalid nested completed folder does not mutate the downloaded tree', async () => {
  const source = path.join(root, 'nested-completed-source');
  fs.mkdirSync(path.join(source, 'weights'), { recursive: true });
  fs.writeFileSync(path.join(source, 'weights', 'model.bin'), 'untouched');
  await assert.rejects(moveCompleted(source, path.join(source, 'completed')), /cannot be inside/i);
  assert.equal(fs.existsSync(path.join(source, 'completed')), false);
  assert.deepEqual(fs.readdirSync(source), ['weights']);
  assert.equal(fs.readFileSync(path.join(source, 'weights', 'model.bin'), 'utf8'), 'untouched');
});

test('cross-volume completion copies publish atomically and clean up failed partials', async t => {
  const destination = path.join(root, 'cross-volume-completed');
  fs.mkdirSync(destination, { recursive: true });
  const link = fs.promises.link, unlinkSync = fs.unlinkSync;
  let forceCrossVolume = true;
  fs.promises.link = async (...args) => {
    if (forceCrossVolume) { forceCrossVolume = false; throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' }); }
    return link(...args);
  };
  t.after(() => { fs.promises.link = link; fs.unlinkSync = unlinkSync; });

  const source = path.join(root, 'cross-volume.bin');
  fs.writeFileSync(source, 'complete payload');
  const moved = await moveCompleted(source, destination);
  assert.equal(moved.moved, true);
  assert.equal(fs.readFileSync(moved.dest, 'utf8'), 'complete payload');
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(fs.readdirSync(destination).filter(name => name.startsWith('.frostbyte-moving-')), []);

  const failedSource = path.join(root, 'cross-volume-failed.bin');
  fs.writeFileSync(failedSource, 'original remains');
  forceCrossVolume = true;
  await assert.rejects(moveCompleted(failedSource, destination, {
    afterStage: ({ staging }) => fs.writeFileSync(staging, 'untrusted partial'),
  }), /staging file changed/i);
  assert.equal(fs.readFileSync(failedSource, 'utf8'), 'original remains');
  assert.equal(fs.existsSync(path.join(destination, path.basename(failedSource))), false);
  assert.deepEqual(fs.readdirSync(destination).filter(name => name.startsWith('.frostbyte-moving-')), []);

  const truncatedSource = path.join(root, 'cross-volume-truncated.bin');
  fs.writeFileSync(truncatedSource, 'complete bytes must survive');
  forceCrossVolume = true;
  await assert.rejects(moveCompleted(truncatedSource, destination, {
    beforePublish: ({ staging }) => { if (staging) fs.writeFileSync(staging, 'short'); },
  }), /changed while it was being copied|copy does not match/i);
  assert.equal(fs.readFileSync(truncatedSource, 'utf8'), 'complete bytes must survive');
  assert.equal(fs.existsSync(path.join(destination, path.basename(truncatedSource))), false);

  const substitutedSource = path.join(root, 'cross-volume-substituted.bin');
  fs.writeFileSync(substitutedSource, 'same length original');
  forceCrossVolume = true;
  await assert.rejects(moveCompleted(substitutedSource, destination, {
    beforePublish: ({ staging }) => { if (staging) fs.writeFileSync(staging, 'same length attacker'); },
  }), /changed while it was being copied|copy contents do not match/i);
  assert.equal(fs.readFileSync(substitutedSource, 'utf8'), 'same length original');
  assert.equal(fs.existsSync(path.join(destination, path.basename(substitutedSource))), false);

  const racedSource = path.join(root, 'cross-volume-raced.bin');
  fs.writeFileSync(racedSource, 'same length original');
  forceCrossVolume = true;
  await assert.rejects(moveCompleted(racedSource, destination, {
    beforePublish: ({ staging }) => {
      if (!staging) return;
      fs.writeFileSync(staging, 'same length attacker');
      fs.utimesSync(staging, 1000, 1000);
    },
  }), /changed while it was being copied|published completed files do not match/i);
  assert.equal(fs.readFileSync(racedSource, 'utf8'), 'same length original');
  assert.equal(fs.existsSync(path.join(destination, path.basename(racedSource))), false);

  const cleanupSource = path.join(root, 'cross-volume-cleanup.bin');
  fs.writeFileSync(cleanupSource, 'published data remains authoritative');
  forceCrossVolume = true;
  fs.unlinkSync = target => {
    if (path.basename(target).startsWith('.frostbyte-cleanup-')) throw new Error('source cleanup refused');
    return unlinkSync(target);
  };
  const cleanup = await moveCompleted(cleanupSource, destination);
  assert.equal(cleanup.moved, true); assert.match(cleanup.cleanupWarning, /cleanup refused/);
  assert.equal(fs.readFileSync(cleanup.dest, 'utf8'), 'published data remains authoritative');
  assert.equal(fs.readFileSync(cleanupSource, 'utf8'), 'published data remains authoritative');
});

// A4: filesystems without hardlink support (exFAT/FAT32, many network mounts)
// reject link() with EPERM/ENOTSUP/ENOSYS rather than EXDEV. Move-on-complete must
// publish an independent, byte-verified copy instead of failing permanently.
for (const code of ['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP']) {
  test(`move-on-complete publishes by verified copy when hardlinks are unsupported (${code})`, async t => {
    const destination = path.join(root, `no-hardlink-${code}`);
    fs.mkdirSync(destination);
    const link = fs.promises.link;
    fs.promises.link = async () => { throw Object.assign(new Error('no hardlinks fixture'), { code }); };
    t.after(() => { fs.promises.link = link; });

    // Single file.
    const file = path.join(root, `no-hardlink-${code}.bin`);
    fs.writeFileSync(file, 'complete payload on a hardlink-less volume');
    const movedFile = await moveCompleted(file, destination);
    assert.equal(movedFile.moved, true);
    assert.equal(fs.readFileSync(movedFile.dest, 'utf8'), 'complete payload on a hardlink-less volume');
    assert.equal(fs.existsSync(file), false, 'source removed after verified copy publication');
    assert.notEqual(fs.statSync(movedFile.dest).ino, undefined);

    // Nested directory tree, including an empty directory.
    const tree = path.join(root, `no-hardlink-${code}-tree`);
    fs.mkdirSync(path.join(tree, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'empty'));
    fs.writeFileSync(path.join(tree, 'root.bin'), 'root bytes');
    fs.writeFileSync(path.join(tree, 'nested', 'child.bin'), 'child bytes');
    const movedTree = await moveCompleted(tree, destination);
    assert.equal(movedTree.moved, true);
    assert.equal(fs.readFileSync(path.join(movedTree.dest, 'root.bin'), 'utf8'), 'root bytes');
    assert.equal(fs.readFileSync(path.join(movedTree.dest, 'nested', 'child.bin'), 'utf8'), 'child bytes');
    assert.equal(fs.existsSync(path.join(movedTree.dest, 'empty')), true);
    assert.equal(fs.existsSync(tree), false);
    // The copy is an independent object, not a hardlink to the (removed) source.
    assert.equal(fs.statSync(path.join(movedTree.dest, 'root.bin')).nlink, 1);
  });
}

test('copy publication never clobbers an existing destination on a hardlink-less volume', async t => {
  const destination = path.join(root, 'no-hardlink-no-clobber');
  fs.mkdirSync(destination);
  const link = fs.promises.link;
  fs.promises.link = async () => { throw Object.assign(new Error('no hardlinks fixture'), { code: 'EPERM' }); };
  t.after(() => { fs.promises.link = link; });

  const file = path.join(root, 'collide.bin');
  fs.writeFileSync(file, 'new payload');
  fs.writeFileSync(path.join(destination, 'collide.bin'), 'existing payload');
  const result = await moveCompleted(file, destination);
  assert.equal(result.moved, false, 'an existing destination is never clobbered');
  assert.match(result.reason, /already exists/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new payload', 'source preserved on no-clobber refusal');
  assert.equal(fs.readFileSync(path.join(destination, 'collide.bin'), 'utf8'), 'existing payload');
});

test('cross-volume directory staging copies exact entries and cleans an interrupted partial tree', async t => {
  const destination = path.join(root, 'cross-volume-directory-completed');
  fs.mkdirSync(destination);
  const link = fs.promises.link;
  const open = fs.promises.open;
  let forceCrossVolume = true;
  fs.promises.link = async (...args) => {
    if (forceCrossVolume) { forceCrossVolume = false; throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' }); }
    return link(...args);
  };
  t.after(() => { fs.promises.link = link; fs.promises.open = open; });

  const source = path.join(root, 'cross-volume-directory');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(source, 'empty'));
  fs.writeFileSync(path.join(source, 'first.bin'), 'first bytes');
  fs.writeFileSync(path.join(source, 'nested', 'second.bin'), 'second bytes');
  const moved = await moveCompleted(source, destination);
  assert.equal(moved.moved, true);
  assert.equal(fs.readFileSync(path.join(moved.dest, 'first.bin'), 'utf8'), 'first bytes');
  assert.equal(fs.readFileSync(path.join(moved.dest, 'nested', 'second.bin'), 'utf8'), 'second bytes');
  assert.equal(fs.statSync(path.join(moved.dest, 'empty')).isDirectory(), true);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(fs.readdirSync(destination).filter(name => name.startsWith('.frostbyte-moving-')), []);

  const failedSource = path.join(root, 'cross-volume-directory-failed');
  fs.mkdirSync(path.join(failedSource, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(failedSource, 'first.bin'), 'first survives');
  fs.writeFileSync(path.join(failedSource, 'nested', 'second.bin'), 'second survives');
  let staging = '';
  let writes = 0;
  fs.promises.open = async (value, ...args) => {
    const handle = await open(value, ...args);
    if (staging && typeof value === 'string' && value.startsWith(`${staging}${path.sep}`)
      && (args[0] & fs.constants.O_WRONLY)) {
      const write = handle.write.bind(handle);
      handle.write = async (...writeArgs) => {
        if (++writes === 2) throw new Error('injected staging write failure');
        return write(...writeArgs);
      };
    }
    return handle;
  };
  forceCrossVolume = true;
  await assert.rejects(moveCompleted(failedSource, destination, {
    afterStage: ({ staging: value }) => { staging = value; },
  }), /injected staging write failure/);
  assert.equal(fs.readFileSync(path.join(failedSource, 'first.bin'), 'utf8'), 'first survives');
  assert.equal(fs.readFileSync(path.join(failedSource, 'nested', 'second.bin'), 'utf8'), 'second survives');
  assert.equal(fs.existsSync(path.join(destination, path.basename(failedSource))), false);
  assert.deepEqual(fs.readdirSync(destination).filter(name => name.startsWith('.frostbyte-moving-')), []);
});

test('cross-volume file staging never follows a replacement link', { skip: process.platform === 'win32' }, async t => {
  const source = path.join(root, 'cross-volume-staging-link.bin');
  const destination = path.join(root, 'cross-volume-staging-link-completed');
  const victim = path.join(root, 'cross-volume-staging-victim.bin');
  const staging = path.join(destination, '.frostbyte-moving-00000000-0000-4000-8000-000000000001');
  fs.writeFileSync(source, 'downloaded bytes');
  fs.writeFileSync(victim, 'victim stays');
  fs.mkdirSync(destination);
  const link = fs.promises.link;
  let forceCrossVolume = true;
  fs.promises.link = async (...args) => {
    if (forceCrossVolume) { forceCrossVolume = false; throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' }); }
    return link(...args);
  };
  t.after(() => { fs.promises.link = link; });
  const held = `${staging}.held`;
  await assert.rejects(moveCompleted(source, destination, {
    stagingPath: staging,
    afterStage: ({ staging: reserved }) => {
      fs.renameSync(reserved, held);
      fs.symlinkSync(victim, reserved);
    },
  }), error => /staging path changed/i.test(error.message) && error.completionRecoveryRequired === true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'victim stays');
  assert.equal(fs.readFileSync(source, 'utf8'), 'downloaded bytes');
  assert.equal(fs.existsSync(path.join(destination, path.basename(source))), false);
});

test('cross-volume cleanup retains staging when it becomes the last verified copy', { skip: process.platform === 'win32' }, async t => {
  const source = path.join(root, 'cross-volume-last-staging.bin');
  const destination = path.join(root, 'cross-volume-last-staging-completed');
  const staging = path.join(destination, '.frostbyte-moving-00000000-0000-4000-8000-000000000002');
  fs.writeFileSync(source, 'only verified staging bytes');
  fs.mkdirSync(destination);
  const link = fs.promises.link;
  const open = fs.promises.open;
  let forceCrossVolume = true;
  fs.promises.link = async (...args) => {
    if (forceCrossVolume) { forceCrossVolume = false; throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' }); }
    return link(...args);
  };
  fs.promises.open = async (value, ...args) => {
    const handle = await open(value, ...args);
    if (value === staging) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        fs.unlinkSync(source);
      };
    }
    return handle;
  };
  t.after(() => { fs.promises.link = link; fs.promises.open = open; });
  await assert.rejects(moveCompleted(source, destination, { stagingPath: staging }),
    error => error.completionRecoveryRequired === true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(staging, 'utf8'), 'only verified staging bytes');
  assert.equal(fs.existsSync(path.join(destination, path.basename(source))), false);
});

test('completion publication never replaces a file or directory that appears after the initial check', async () => {
  const destination = path.join(root, 'completion-no-clobber');
  fs.mkdirSync(destination, { recursive: true });

  const fileSource = path.join(root, 'raced-file.bin');
  fs.writeFileSync(fileSource, 'downloaded bytes');
  await assert.rejects(moveCompleted(fileSource, destination, {
    beforePublish: ({ destination: target }) => fs.writeFileSync(target, 'other process'),
  }), /exist|appeared/i);
  assert.equal(fs.readFileSync(path.join(destination, 'raced-file.bin'), 'utf8'), 'other process');
  assert.equal(fs.readFileSync(fileSource, 'utf8'), 'downloaded bytes');

  const directorySource = path.join(root, 'raced-directory');
  fs.mkdirSync(path.join(directorySource, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(directorySource, 'nested', 'model.bin'), 'downloaded tree');
  await assert.rejects(moveCompleted(directorySource, destination, {
    beforePublish: ({ destination: target }) => {
      fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep.txt'), 'other process');
    },
  }), /exist|appeared/i);
  assert.equal(fs.readFileSync(path.join(destination, 'raced-directory', 'keep.txt'), 'utf8'), 'other process');
  assert.equal(fs.readFileSync(path.join(directorySource, 'nested', 'model.bin'), 'utf8'), 'downloaded tree');
});

test('same-volume publication requires exact reviewed source inodes', async t => {
  const destination = path.join(root, 'completion-link-identity');
  fs.mkdirSync(destination);
  const link = fs.promises.link;
  let swapSource = '', attacker = '', held = '';
  fs.promises.link = async (from, to) => {
    if (from !== swapSource) return link(from, to);
    fs.renameSync(swapSource, held);
    fs.renameSync(attacker, swapSource);
    try { return await link(swapSource, to); }
    finally {
      fs.renameSync(swapSource, attacker);
      fs.renameSync(held, swapSource);
    }
  };
  t.after(() => { fs.promises.link = link; });

  const fileSource = path.join(root, 'reviewed-link.bin');
  const fileAttacker = path.join(root, 'attacker-link.bin');
  fs.writeFileSync(fileSource, 'trusted1'); fs.writeFileSync(fileAttacker, 'hostile1');
  swapSource = fileSource; attacker = fileAttacker; held = `${fileSource}.held`;
  await assert.rejects(moveCompleted(fileSource, destination), /not the verified download/i);
  assert.equal(fs.readFileSync(fileSource, 'utf8'), 'trusted1');
  assert.equal(fs.readFileSync(fileAttacker, 'utf8'), 'hostile1');
  assert.equal(fs.existsSync(path.join(destination, path.basename(fileSource))), false);

  const directorySource = path.join(root, 'reviewed-link-tree');
  const nestedSource = path.join(directorySource, 'nested', 'model.bin');
  const nestedAttacker = path.join(root, 'attacker-nested.bin');
  fs.mkdirSync(path.dirname(nestedSource), { recursive: true });
  fs.writeFileSync(nestedSource, 'trusted2'); fs.writeFileSync(nestedAttacker, 'hostile2');
  swapSource = nestedSource; attacker = nestedAttacker; held = `${nestedSource}.held`;
  await assert.rejects(moveCompleted(directorySource, destination), /changed while it was being copied|not the verified download/i);
  assert.equal(fs.readFileSync(nestedSource, 'utf8'), 'trusted2');
  assert.equal(fs.readFileSync(nestedAttacker, 'utf8'), 'hostile2');
  assert.equal(fs.existsSync(path.join(destination, path.basename(directorySource))), false);
});

test('publication recovery preserves a destination that became the last exact copy', async () => {
  const destination = path.join(root, 'last-copy-completed');
  fs.mkdirSync(destination);
  const fileSource = path.join(root, 'last-copy.bin');
  fs.writeFileSync(fileSource, 'last file bytes');
  let publishedFile = '';
  await assert.rejects(moveCompleted(fileSource, destination, {
    onDestinationCreated: ({ destination: target }) => {
      publishedFile = target;
      fs.unlinkSync(fileSource);
    },
  }), error => error.completionRecoveryRequired === true);
  assert.equal(fs.readFileSync(publishedFile, 'utf8'), 'last file bytes');
  assert.equal(fs.existsSync(fileSource), false);

  const directorySource = path.join(root, 'last-copy-directory');
  const sourceFile = path.join(directorySource, 'nested', 'model.bin');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'last directory bytes');
  let publishedDirectory = '';
  await assert.rejects(moveCompleted(directorySource, destination, {
    afterPublish: ({ destination: target }) => {
      publishedDirectory = target;
      fs.unlinkSync(sourceFile);
    },
  }), error => error.completionRecoveryRequired === true);
  assert.equal(fs.readFileSync(path.join(publishedDirectory, 'nested', 'model.bin'), 'utf8'), 'last directory bytes');
  assert.equal(fs.existsSync(sourceFile), false);
});

test('publication rollback rechecks its surviving source after claiming the destination', { skip: process.platform === 'win32' }, async t => {
  const source = path.join(root, 'rollback-last-destination.bin');
  const destination = path.join(root, 'rollback-last-destination-completed');
  fs.writeFileSync(source, 'destination must survive');
  fs.mkdirSync(destination);
  const renameSync = fs.renameSync;
  let published = '';
  fs.renameSync = (from, to) => {
    const result = renameSync(from, to);
    if (from === published && fs.existsSync(source)) fs.unlinkSync(source);
    return result;
  };
  t.after(() => { fs.renameSync = renameSync; });
  await assert.rejects(moveCompleted(source, destination, {
    onDestinationCreated: ({ destination: value }) => { published = value; },
    afterPublish: () => { throw new Error('journal flush failed'); },
  }), error => error.message === 'journal flush failed' && error.completionRecoveryRequired === true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(published, 'utf8'), 'destination must survive');
});

test('staging rollback rechecks its original after claiming the staging copy', { skip: process.platform === 'win32' }, async t => {
  const source = path.join(root, 'rollback-last-staging.bin');
  const destination = path.join(root, 'rollback-last-staging-completed');
  const staging = path.join(destination, '.frostbyte-moving-00000000-0000-4000-8000-000000000003');
  fs.writeFileSync(source, 'staging must survive');
  fs.mkdirSync(destination);
  const link = fs.promises.link;
  const renameSync = fs.renameSync;
  let forceCrossVolume = true;
  fs.promises.link = async (...args) => {
    if (forceCrossVolume) { forceCrossVolume = false; throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' }); }
    return link(...args);
  };
  fs.renameSync = (from, to) => {
    const result = renameSync(from, to);
    if (from === staging && fs.existsSync(source)) fs.unlinkSync(source);
    return result;
  };
  t.after(() => { fs.promises.link = link; fs.renameSync = renameSync; });
  await assert.rejects(moveCompleted(source, destination, {
    stagingPath: staging,
    beforePublish: ({ staging: value }) => {
      if (value && fs.existsSync(value)) throw new Error('publication record failed');
    },
  }), error => error.message === 'publication record failed' && error.completionRecoveryRequired === true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(staging, 'utf8'), 'staging must survive');
  assert.equal(fs.existsSync(path.join(destination, path.basename(source))), false);
});

test('completion publication rechecks its pinned root after journal callbacks', async t => {
  if (process.platform === 'win32') { t.skip('directory replacement is not atomic on Windows'); return; }
  const beforeSource = path.join(root, 'before-root-swap.bin');
  const beforeRoot = path.join(root, 'before-root-swap-completed');
  const beforeDisplaced = path.join(root, 'before-root-swap-displaced');
  fs.writeFileSync(beforeSource, 'before callback bytes'); fs.mkdirSync(beforeRoot);
  await assert.rejects(moveCompleted(beforeSource, beforeRoot, {
    beforePublish: () => {
      fs.renameSync(beforeRoot, beforeDisplaced);
      fs.mkdirSync(beforeRoot);
    },
  }), /completed folder changed/i);
  assert.equal(fs.readFileSync(beforeSource, 'utf8'), 'before callback bytes');
  assert.equal(fs.existsSync(path.join(beforeRoot, path.basename(beforeSource))), false);
  assert.equal(fs.existsSync(path.join(beforeDisplaced, path.basename(beforeSource))), false);

  const afterSource = path.join(root, 'after-root-swap.bin');
  const afterRoot = path.join(root, 'after-root-swap-completed');
  const afterDisplaced = path.join(root, 'after-root-swap-displaced');
  fs.writeFileSync(afterSource, 'after callback bytes'); fs.mkdirSync(afterRoot);
  await assert.rejects(moveCompleted(afterSource, afterRoot, {
    afterPublish: () => {
      fs.renameSync(afterRoot, afterDisplaced);
      fs.mkdirSync(afterRoot);
    },
  }), error => /completed folder changed/i.test(error.message) && error.completionRecoveryRequired === true);
  assert.equal(fs.readFileSync(afterSource, 'utf8'), 'after callback bytes');
  assert.equal(fs.existsSync(path.join(afterRoot, path.basename(afterSource))), false);
  assert.equal(fs.readFileSync(path.join(afterDisplaced, path.basename(afterSource)), 'utf8'), 'after callback bytes');
});

test('source cleanup restores its claim when the published root changes first', async t => {
  if (process.platform === 'win32') { t.skip('the descriptor cleanup hook is POSIX-only'); return; }
  const source = path.join(root, 'cleanup-root-swap.bin');
  const destination = path.join(root, 'cleanup-root-swap-completed');
  const displaced = path.join(root, 'cleanup-root-swap-displaced');
  fs.writeFileSync(source, 'cleanup callback bytes'); fs.mkdirSync(destination);
  const openSync = fs.openSync;
  let armSwap = false;
  fs.openSync = (value, ...args) => {
    if (armSwap && value === source) {
      armSwap = false;
      fs.renameSync(destination, displaced);
      fs.mkdirSync(destination);
    }
    return openSync(value, ...args);
  };
  t.after(() => { fs.openSync = openSync; });
  await assert.rejects(moveCompleted(source, destination, {
    afterPublish: () => { armSwap = true; },
  }), error => /completed folder changed/i.test(error.message) && error.completionRecoveryRequired === true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'cleanup callback bytes');
  assert.equal(fs.existsSync(path.join(destination, path.basename(source))), false);
  assert.equal(fs.readFileSync(path.join(displaced, path.basename(source)), 'utf8'), 'cleanup callback bytes');
});

test('directory source cleanup keeps reviewed files when a published child is replaced', { skip: process.platform === 'win32' }, async t => {
  const source = path.join(root, 'cleanup-child-swap');
  const destination = path.join(root, 'cleanup-child-swap-completed');
  const sourceFile = path.join(source, 'nested', 'model.bin');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'reviewed directory bytes');
  fs.mkdirSync(destination);
  const openSync = fs.openSync;
  let published = '';
  let armSwap = false;
  fs.openSync = (value, ...args) => {
    if (armSwap && value === source) {
      armSwap = false;
      const target = path.join(published, 'nested', 'model.bin');
      fs.unlinkSync(target);
      fs.writeFileSync(target, 'hostile directory bytes');
    }
    return openSync(value, ...args);
  };
  t.after(() => { fs.openSync = openSync; });
  await assert.rejects(moveCompleted(source, destination, {
    afterPublish: ({ destination: target }) => { published = target; armSwap = true; },
  }), error => error.completionRecoveryRequired === true);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), 'reviewed directory bytes');
  assert.equal(fs.readFileSync(path.join(published, 'nested', 'model.bin'), 'utf8'), 'hostile directory bytes');
});

test('cross-volume staging cleanup keeps reviewed files when a published child is replaced', { skip: process.platform === 'win32' }, async t => {
  const source = path.join(root, 'staging-child-swap');
  const destination = path.join(root, 'staging-child-swap-completed');
  const staging = path.join(destination, '.frostbyte-moving-00000000-0000-4000-8000-000000000004');
  const sourceFile = path.join(source, 'nested', 'model.bin');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'reviewed staged bytes');
  fs.mkdirSync(destination);
  const link = fs.promises.link;
  const openSync = fs.openSync;
  let forceCrossVolume = true;
  let published = '';
  let armSwap = false;
  fs.promises.link = async (...args) => {
    if (forceCrossVolume) { forceCrossVolume = false; throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' }); }
    return link(...args);
  };
  fs.openSync = (value, ...args) => {
    if (armSwap && value === staging) {
      armSwap = false;
      const target = path.join(published, 'nested', 'model.bin');
      fs.unlinkSync(target);
      fs.writeFileSync(target, 'hostile staged bytes');
    }
    return openSync(value, ...args);
  };
  t.after(() => { fs.promises.link = link; fs.openSync = openSync; });
  await assert.rejects(moveCompleted(source, destination, {
    stagingPath: staging,
    afterPublish: ({ destination: target }) => { published = target; armSwap = true; },
  }), error => error.completionRecoveryRequired === true);
  assert.equal(fs.existsSync(sourceFile), false);
  assert.equal(fs.readFileSync(path.join(staging, 'nested', 'model.bin'), 'utf8'), 'reviewed staged bytes');
  assert.equal(fs.readFileSync(path.join(published, 'nested', 'model.bin'), 'utf8'), 'hostile staged bytes');
});

test('cross-volume completion rechecks copied bytes after the durable journal callback', async t => {
  const source = path.join(root, 'cross-volume-after-journal.bin');
  const destination = path.join(root, 'cross-volume-after-journal-completed');
  fs.writeFileSync(source, 'trusted-contents'); fs.mkdirSync(destination);
  const link = fs.promises.link;
  let forceCrossVolume = true;
  fs.promises.link = async (...args) => {
    if (forceCrossVolume) { forceCrossVolume = false; throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' }); }
    return link(...args);
  };
  t.after(() => { fs.promises.link = link; });
  await assert.rejects(moveCompleted(source, destination, {
    afterPublish: ({ destination: target }) => fs.writeFileSync(target, 'changed-contents'),
  }), /changed after it was published|published completed files do not match/i);
  assert.equal(fs.readFileSync(source, 'utf8'), 'trusted-contents');
  assert.equal(fs.existsSync(path.join(destination, path.basename(source))), false);
});

test('cross-volume source cleanup keeps the original if the published bytes change', { skip: process.platform === 'win32' }, async t => {
  const source = path.join(root, 'cross-volume-before-source-cleanup.bin');
  const destination = path.join(root, 'cross-volume-before-source-cleanup-completed');
  fs.writeFileSync(source, 'trusted-contents'); fs.mkdirSync(destination);
  const link = fs.promises.link;
  const openSync = fs.openSync;
  let forceCrossVolume = true;
  let published = '';
  let publishedTimes = null;
  let armMutation = false;
  fs.promises.link = async (...args) => {
    if (forceCrossVolume) { forceCrossVolume = false; throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' }); }
    return link(...args);
  };
  fs.openSync = (value, ...args) => {
    if (armMutation && value === source) {
      armMutation = false;
      fs.writeFileSync(published, 'hostile-contents');
      fs.utimesSync(published, publishedTimes.atime, publishedTimes.mtime);
    }
    return openSync(value, ...args);
  };
  t.after(() => { fs.promises.link = link; fs.openSync = openSync; });
  await assert.rejects(moveCompleted(source, destination, {
    afterPublish: ({ destination: target }) => {
      published = target;
      publishedTimes = fs.statSync(target);
      armMutation = true;
    },
  }), error => error.completionRecoveryRequired === true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'trusted-contents');
  assert.equal(fs.readFileSync(published, 'utf8'), 'hostile-contents');
});

test('same-volume completion rejects same-length mutation after the durable journal callback', async () => {
  const source = path.join(root, 'same-volume-after-journal.bin');
  const destination = path.join(root, 'same-volume-after-journal-completed');
  fs.writeFileSync(source, 'trusted-contents'); fs.mkdirSync(destination);
  await assert.rejects(moveCompleted(source, destination, {
    afterPublish: ({ destination: target }) => fs.writeFileSync(target, 'hostile-contents'),
  }), /changed after it was published/i);
  assert.equal(fs.readFileSync(source, 'utf8'), 'hostile-contents');
  assert.equal(fs.existsSync(path.join(destination, path.basename(source))), false);
});

test('nested completion directories are reserved exclusively and journaled before population', async () => {
  const source = path.join(root, 'nested-completion');
  const destination = path.join(root, 'nested-completed');
  fs.mkdirSync(path.join(source, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(source, 'empty'));
  fs.writeFileSync(path.join(source, 'top.json'), '{"ok":true}');
  fs.writeFileSync(path.join(source, 'a', 'b', 'weights.bin'), 'weights');
  const events = [];
  const result = await moveCompleted(source, destination, {
    beforePublish: ({ destination: target }) => {
      events.push('publishing'); assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(source), true);
    },
    onDestinationCreated: ({ destination: target, destinationIdentity }) => {
      events.push('reserved'); assert.equal(destinationIdentity.type, 'directory'); assert.deepEqual(completionPathIdentity(target), destinationIdentity);
      assert.equal(fs.existsSync(source), true);
    },
    afterPublish: ({ destination: target }) => {
      events.push('published'); assert.equal(fs.readFileSync(path.join(target, 'a', 'b', 'weights.bin'), 'utf8'), 'weights');
      assert.equal(fs.existsSync(source), true, 'source is retained until published state is durable');
    },
  });
  assert.equal(result.moved, true);
  assert.deepEqual(events, ['publishing', 'reserved', 'published']);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(result.dest, 'top.json'), 'utf8'), '{"ok":true}');
  assert.equal(fs.statSync(path.join(result.dest, 'a', 'b', 'weights.bin')).nlink, 1);
  assert.equal(fs.statSync(path.join(result.dest, 'empty')).isDirectory(), true);
});

test('completion publication flushes files and directories before the durable journal callback', async t => {
  const source = path.join(root, 'durable-publication');
  const destination = path.join(root, 'durable-publication-completed');
  const sourceFile = path.join(source, 'nested', 'model.bin');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'durable bytes');
  fs.mkdirSync(destination);
  const published = path.join(destination, path.basename(source));
  const publishedFile = path.join(published, 'nested', 'model.bin');
  const publishedNested = path.join(published, 'nested');
  const open = fs.promises.open;
  const synced = [];
  fs.promises.open = async (value, ...args) => {
    const handle = await open(value, ...args);
    if ([publishedFile, publishedNested, published, destination].includes(value)) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { synced.push(value); return sync(); };
    }
    return handle;
  };
  t.after(() => { fs.promises.open = open; });
  await moveCompleted(source, destination, {
    afterPublish: () => {
      assert.ok(synced.indexOf(publishedFile) >= 0);
      assert.ok(synced.indexOf(publishedFile) < synced.indexOf(publishedNested));
      assert.ok(synced.indexOf(publishedNested) < synced.indexOf(published));
      assert.ok(synced.indexOf(published) < synced.indexOf(destination));
    },
  });
});

test('a failed durable-publish record rolls back only its owned partial directory', async () => {
  const source = path.join(root, 'publish-rollback');
  const destination = path.join(root, 'publish-rollback-destination');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'nested', 'model.bin'), 'complete');
  await assert.rejects(moveCompleted(source, destination, {
    afterPublish: () => { throw new Error('journal flush failed'); },
  }), /journal flush failed/);
  assert.equal(fs.existsSync(path.join(destination, path.basename(source))), false);
  assert.equal(fs.readFileSync(path.join(source, 'nested', 'model.bin'), 'utf8'), 'complete');
});

test('completion directory cleanup preserves unrelated children added during publication', async () => {
  const source = path.join(root, 'source-cleanup-manifest');
  const destination = path.join(root, 'source-cleanup-manifest-destination');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'nested', 'model.bin'), 'published model bytes');
  const result = await moveCompleted(source, destination, {
    afterPublish: () => fs.writeFileSync(path.join(source, 'keep-user-file.txt'), 'unrelated user bytes'),
  });
  assert.equal(result.moved, true);
  assert.match(result.cleanupWarning, /changed before it could be cleaned up/i);
  assert.equal(fs.readFileSync(path.join(source, 'keep-user-file.txt'), 'utf8'), 'unrelated user bytes');
  assert.equal(fs.existsSync(path.join(source, 'nested', 'model.bin')), false);
  assert.equal(fs.readFileSync(path.join(result.dest, 'nested', 'model.bin'), 'utf8'), 'published model bytes');
});

test('failed publication rollback keeps an unrelated child inside the owned destination root', async () => {
  const source = path.join(root, 'destination-cleanup-manifest');
  const destination = path.join(root, 'destination-cleanup-manifest-root');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'nested', 'model.bin'), 'source remains');
  let publishedDestination;
  await assert.rejects(moveCompleted(source, destination, {
    afterPublish: ({ destination: target }) => {
      publishedDestination = target;
      fs.writeFileSync(path.join(target, 'keep-user-file.txt'), 'unrelated destination bytes');
      throw new Error('journal flush failed');
    },
  }), error => error.message === 'journal flush failed' && error.completionRecoveryRequired === true);
  assert.equal(fs.readFileSync(path.join(source, 'nested', 'model.bin'), 'utf8'), 'source remains');
  assert.equal(fs.readFileSync(path.join(publishedDestination, 'keep-user-file.txt'), 'utf8'), 'unrelated destination bytes');
  assert.equal(fs.existsSync(path.join(publishedDestination, 'nested', 'model.bin')), false);
});

test('directory cleanup without a durable leaf manifest preserves nonempty contents', async () => {
  const owned = path.join(root, 'restart-directory-without-manifest');
  fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned, 'keep-user-file.txt'), 'keep me');
  const identity = completionPathIdentity(owned);
  assert.equal(await removeOwnedCompletionPath(owned, identity), false);
  assert.equal(fs.readFileSync(path.join(owned, 'keep-user-file.txt'), 'utf8'), 'keep me');
});

test('owned cleanup does not recurse into a directory swapped after its descriptor is opened', { skip: process.platform === 'win32' }, async t => {
  const owned = path.join(root, 'owned-staging');
  const displaced = path.join(root, 'displaced-staging');
  fs.mkdirSync(owned); fs.writeFileSync(path.join(owned, 'partial.bin'), 'partial');
  const identity = completionPathIdentity(owned);
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (from === owned) {
      await rename(owned, displaced);
      fs.mkdirSync(owned); fs.writeFileSync(path.join(owned, 'user-file.txt'), 'keep me');
    }
    return rename(from, to);
  };
  t.after(() => { fs.promises.rename = rename; });
  assert.equal(await removeOwnedCompletionPath(owned, identity), false);
  assert.equal(fs.readFileSync(path.join(owned, 'user-file.txt'), 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(path.join(displaced, 'partial.bin'), 'utf8'), 'partial');
});

test('completion path comparison follows Windows case-insensitive semantics', () => {
  assert.equal(sameLocalPath('C:\\Models\\Llama', 'c:\\models\\LLAMA', { platform: 'win32' }), true);
  assert.equal(sameLocalPath('C:\\Models\\Llama', 'D:\\Models\\Llama', { platform: 'win32' }), false);
  assert.equal(sameLocalPath('/Models/Llama', '/models/Llama', { platform: 'linux' }), false);
});

test('re-sharing a file waits for its previous removal before pause state is recorded', async () => {
  const engine = new TorrentEngine({dht:false,tracker:false,lsd:false});
  const file = path.join(root, 'reshare.gguf');
  fs.writeFileSync(file, crypto.randomBytes(64 * 1024));
  let release, removal, replacement;
  try {
    const original = await engine.seed(file);
    const remove = engine.client.remove.bind(engine.client);
    engine.client.remove = (source, options, callback) => remove(source, options, error => {
      release = () => callback(error); // hold the completed store-close callback
    });
    removal = engine.remove(original.infoHash);
    await waitFor(() => release);
    let reshared = false;
    replacement = engine.seed(file).then(torrent => { reshared = true; return torrent; });
    await delay(40);
    assert.equal(reshared, false, 'new share waits until old removal has fully settled');
    release();
    await removal;
    const seeded = await replacement;
    await engine.pause(seeded.infoHash);
    assert.equal(engine.sessions().find(record => record.infohash === seeded.infoHash).paused, true);
    assert.equal(engine.list().find(torrent => torrent.infoHash === seeded.infoHash).paused, true);
  } finally {
    release?.();
    await Promise.allSettled([removal, replacement]);
    await engine.destroy();
  }
});

test('concurrent magnets resolve separately, active pause stops bytes, and sessions restore paused', async () => {
  const engineOpts = {dht:false,tracker:false,lsd:false,utp:false,allowPeerAddresses:true};
  const seed = new TorrentEngine(engineOpts);
  const leecher = new TorrentEngine(engineOpts);
  let restored;
  try {
    const paths = ['one.gguf','two.gguf'].map(name => path.join(root, name));
    paths.forEach(p => fs.writeFileSync(p, crypto.randomBytes(512 * 1024)));
    const sources = await Promise.all(paths.map(p => seed.seed(p)));
    await waitFor(() => seed.port);
    leecher.setLimits({down:64 * 1024});
    const pulls = await Promise.all(sources.map(s => leecher.add(s.magnetURI + `&x.pe=127.0.0.1:${seed.port}`, {path:path.join(root,'pulls')})));
    assert.deepEqual(pulls.map(t => t.infoHash), sources.map(t => t.infoHash));
    await waitFor(() => leecher.list().some(t => t.downloaded > 0));
    for (const t of pulls) await leecher.pause(t.infoHash);
    await delay(250);
    const stoppedAt = leecher.list().map(t => t.downloaded);
    await delay(400);
    assert.deepEqual(leecher.list().map(t => t.downloaded), stoppedAt);
    assert.ok(leecher.list().every(t => t.paused && !t.seeding));
    const sessions = leecher.sessions();
    await leecher.destroy();
    restored = new TorrentEngine(engineOpts);
    for (const rec of sessions) await restored.restore(rec);
    await waitFor(() => restored.list().every(t => t.ready && t.paused));
    for (const rec of sessions) await restored.resume(rec.infohash);
    for (const raw of restored.client.torrents) raw.addPeer(`127.0.0.1:${seed.port}`);
    await waitFor(() => restored.list().every(t => t.done));
    for (const p of paths) assert.equal(await sha256File(path.join(root,'pulls',path.basename(p))), await sha256File(p));
  } finally {
    await seed.destroy();
    if (!leecher._destroyed) await leecher.destroy();
    if (restored) await restored.destroy();
  }
});

test('base32 and hex magnet identities match', () => {
  assert.equal(extractInfoHash('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), '0'.repeat(40));
  assert.equal(extractInfoHash('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), '0'.repeat(40));
});

test('HTTP downloads verify, resume, obey changing limits, and share the swarm throttle', async t => {
  const payload = crypto.randomBytes(128 * 1024);
  const etag = hash(payload);
  const requests = [];
  const hangingResponses = new Set();
  const hostileRedirects = {
    'redirect-private-v4': 'https://127.0.0.1/admin',
    'redirect-private-v6': 'https://[::1]/admin',
    'redirect-localhost': 'https://localhost/admin',
    'redirect-rebinding': 'https://rebind.attacker.invalid/admin',
    'redirect-mixed-dns': 'https://huggingface.co.attacker.invalid/admin',
    'redirect-nonstandard-port': 'https://huggingface.co:8443/admin',
  };
  let mode = 'redirect';
  const server = http.createServer((req, res) => {
    requests.push({method:req.method,url:req.url,auth:req.headers.authorization,range:req.headers.range});
    if (mode === 'headers-stall' && req.url.includes('/resolve/') && req.method === 'HEAD') {
      hangingResponses.add(res); res.once('close', () => hangingResponses.delete(res));
      return;
    }
    if (req.url.includes('/resolve/') && req.method === 'HEAD') {
      const location = hostileRedirects[mode] || 'https://us.aws.cdn.hf.co/blob';
      res.writeHead(mode === 'direct' ? 200 : 307, {'etag':etag,'x-linked-size':payload.length,...(mode === 'direct' ? {} : {location})});
      return res.end();
    }
    if (mode === 'oversized-stat' && req.url === '/blob' && req.method === 'HEAD') {
      res.writeHead(200, {'content-length':String(16 * 1024 ** 4 + 1)});
      return res.end();
    }
    if (mode === 'body-stall' && req.method === 'GET') {
      res.writeHead(200, {'content-length':payload.length}); res.flushHeaders();
      hangingResponses.add(res); res.once('close', () => hangingResponses.delete(res));
      return;
    }
    const offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
    if (req.headers.range && offset >= payload.length) {
      res.writeHead(416, { 'content-range': `bytes */${payload.length}` });
      return res.end();
    }
    const part = payload.subarray(offset);
    res.writeHead(offset ? 206 : 200, {'content-length':part.length,...(offset ? {'content-range':`bytes ${offset}-${payload.length-1}/${payload.length}`} : {})});
    res.end(part);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const parsed = new URL(url);
    if (!['huggingface.co', 'us.aws.cdn.hf.co'].includes(parsed.hostname)) throw new Error(`Test blocked unexpected outbound host: ${parsed.hostname}`);
    return originalFetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}`, options);
  };
  const base = {repoId:'review/model',revision:'a'.repeat(40),filePath:'weights.gguf',token:'test-token',approvedRoot:root};
  try {
    await t.test('resume verifies bytes and credentials stay on HuggingFace requests', async () => {
      const dest = hfDestination(root, base.repoId, base.filePath);
      // The unlimited rate callback keeps cancellation responsive even when a
      // fast loopback response delivers the entire payload in one network chunk.
      const first = await hfDownloadFile({...base,dest,maxBytes:32000,getRate:()=>-1});
      assert.equal(first.partial, true);
      const partialSize = fs.statSync(first.partPath).size;
      assert.ok(partialSize >= 32000 && partialSize < payload.length, 'resume must exercise an incomplete file');
      await hfDownloadFile({...base,dest});
      assert.equal(await sha256File(dest), etag);
      assert.ok(requests.some(r => r.range));
      assert.ok(requests.filter(r => r.url === '/blob').every(r => !r.auth));
      assert.ok(requests.filter(r => r.method === 'HEAD').every(r => r.auth === 'Bearer test-token'));
    });
    await t.test('a fully received partial handles an unsatisfied range and verifies a fresh response', async () => {
      const dest = path.join(root, 'complete-partial.gguf');
      const first = await hfDownloadFile({ ...base, dest, maxBytes: payload.length });
      assert.equal(first.partial, true);
      assert.equal(fs.statSync(first.partPath).size, payload.length);
      const before = requests.length;
      await hfDownloadFile({ ...base, dest });
      assert.equal(await sha256File(dest), etag);
      const gets = requests.slice(before).filter(request => request.method === 'GET');
      assert.deepEqual(gets.map(request => request.range), [`bytes=${payload.length}-`, undefined]);
      assert.equal(fs.existsSync(first.partPath), false);
    });
    await t.test('existing and raced final destinations are never overwritten and keep the verified partial', async () => {
      const existing = path.join(root, 'existing-final.gguf');
      const original = Buffer.from('independent completed file');
      fs.writeFileSync(existing, original);
      const before = requests.length;
      await assert.rejects(hfDownloadFile({ ...base, dest: existing }), /already exists/i);
      assert.deepEqual(fs.readFileSync(existing), original);
      assert.equal(requests.length, before, 'an existing destination fails before contacting HuggingFace');

      const raced = path.join(root, 'raced-final.gguf');
      let placed = false;
      await assert.rejects(hfDownloadFile({ ...base, dest: raced, onProgress: progress => {
        if (progress.phase === 'verifying' && !placed) { placed = true; fs.writeFileSync(raced, original); }
      } }), /appeared|already exists/i);
      assert.deepEqual(fs.readFileSync(raced), original, 'the raced destination remains authoritative');
      assert.equal(await sha256File(raced + '.frostpart'), etag, 'the verified partial remains retryable');
      assert.equal(fs.existsSync(raced + '.frostpart.json'), true);

      const portableAlias = path.join(root, 'Portable-Alias.gguf');
      fs.writeFileSync(portableAlias, original);
      const requestsBeforeAlias = requests.length;
      await assert.rejects(hfDownloadFile({ ...base, dest: path.join(root, 'portable-alias.gguf') }), /already exists|collide/i);
      assert.deepEqual(fs.readFileSync(portableAlias), original);
      assert.equal(requests.length, requestsBeforeAlias, 'a portable filesystem alias fails before contacting HuggingFace');
    });
    await t.test('invalid, foreign, and raced resume sidecars are preserved without clobbering partials', async () => {
      const invalid = path.join(root, 'invalid-sidecar.gguf');
      const partial = crypto.randomBytes(97), foreign = Buffer.from('{"owner":"another-process"}');
      fs.writeFileSync(invalid + '.frostpart', partial);
      fs.writeFileSync(invalid + '.frostpart.json', foreign);
      const before = requests.length;
      await assert.rejects(hfDownloadFile({ ...base, dest: invalid }), /sidecar is invalid.*preserved/i);
      assert.deepEqual(fs.readFileSync(invalid + '.frostpart'), partial);
      assert.deepEqual(fs.readFileSync(invalid + '.frostpart.json'), foreign);
      assert.equal(requests.length, before, 'invalid sidecars fail before a network request');

      const raced = path.join(root, 'raced-sidecar.gguf'), sidecar = raced + '.frostpart.json';
      const nativeLink = fs.promises.link;
      let inserted = false;
      fs.promises.link = async (source, target) => {
        if (target === sidecar && !inserted) { inserted = true; fs.writeFileSync(target, foreign); }
        return nativeLink.call(fs.promises, source, target);
      };
      try { await assert.rejects(hfDownloadFile({ ...base, dest: raced }), /sidecar appeared.*preserved/i); }
      finally { fs.promises.link = nativeLink; }
      assert.deepEqual(fs.readFileSync(sidecar), foreign);
      assert.equal(fs.existsSync(raced), false);
      assert.equal(fs.existsSync(raced + '.frostpart'), true, 'the partial path is retained after sidecar publication loses the race');
    });
    await t.test('a direct authenticated response keeps authorization', async () => {
      mode = 'direct';
      await hfDownloadFile({...base,dest:path.join(root,'direct.gguf')});
      assert.equal(requests.at(-1).auth, 'Bearer test-token');
      mode = 'redirect';
    });
    await t.test('a live cap change takes effect and cancellation is prompt', async () => {
      let rate = 1024;
      const controller = new AbortController();
      const started = Date.now();
      const pending = hfDownloadFile({...base,dest:path.join(root,'capped.gguf'),getRate:()=>rate,signal:controller.signal});
      await delay(150); rate = -1;
      await pending;
      assert.ok(Date.now() - started < 2500);
      const cancel = new AbortController();
      const stopped = hfDownloadFile({...base,dest:path.join(root,'cancelled.gguf'),getRate:()=>1,signal:cancel.signal});
      await delay(100); cancel.abort();
      await assert.rejects(stopped, {name:'AbortError'});
      assert.equal(fs.existsSync(path.join(root,'cancelled.gguf')), false);
    });
    await t.test('two HTTP pulls consume one shared download budget', async () => {
      const engine = new TorrentEngine({dht:false,tracker:false,lsd:false});
      engine.setLimits({down:64 * 1024});
      try {
        const start = Date.now();
        await Promise.all(['shared-a','shared-b'].map(name => hfDownloadFile({...base,dest:path.join(root,name),acquireBytes:(bytes,signal)=>engine.acquireDownloadBytes(bytes,signal)})));
        assert.ok(Date.now() - start >= 2500, 'two 128 KB files must share a 64 KB/s limit');
        engine.setLimits({down:1});
        const cancel = new AbortController();
        const pending = hfDownloadFile({...base,dest:path.join(root,'shared-cancel'),acquireBytes:(bytes,signal)=>engine.acquireDownloadBytes(bytes,signal),signal:cancel.signal});
        await delay(100); cancel.abort();
        await assert.rejects(pending, {name:'AbortError'});
      } finally { await engine.destroy(); }
    });
    await t.test('caller cancellation and a request-header deadline are combined', async () => {
      mode = 'headers-stall';
      const caller = new AbortController();
      const safety = setTimeout(() => caller.abort(new Error('test safety timeout')), 2000);
      try {
        await assert.rejects(
          hfDownloadFile({...base,dest:path.join(root,'header-stall.gguf'),signal:caller.signal,requestTimeoutMs:40}),
          /request timed out/i,
        );
      } finally { clearTimeout(safety); mode = 'redirect'; for (const response of hangingResponses) response.destroy(); }
    });
    await t.test('a response body that stops producing chunks hits the idle deadline', async () => {
      mode = 'body-stall';
      const caller = new AbortController();
      const safety = setTimeout(() => caller.abort(new Error('test safety timeout')), 2000);
      try {
        await assert.rejects(
          hfDownloadFile({...base,dest:path.join(root,'body-stall.gguf'),signal:caller.signal,idleTimeoutMs:40}),
          /download stalled/i,
        );
      } finally { clearTimeout(safety); mode = 'redirect'; for (const response of hangingResponses) response.destroy(); }
    });
    await t.test('redirects cannot select local, private, rebinding, or suffix-spoofed hosts', async () => {
      try {
        for (const hostileMode of Object.keys(hostileRedirects)) {
          mode = hostileMode;
          const before = requests.length;
          await assert.rejects(
            hfDownloadFile({...base,dest:path.join(root,`${hostileMode}.gguf`),requestTimeoutMs:100}),
            /untrusted download host/i,
          );
          assert.equal(requests.length, before + 1, `${hostileMode} must stop at the trusted first hop`);
          assert.match(requests.at(-1).url, /\/resolve\//);
        }
      } finally { mode = 'redirect'; }
    });
    await t.test('hfStatFile rejects a Content-Length beyond the download bound', async () => {
      mode = 'oversized-stat';
      try {
        await assert.rejects(hfStatFile(base), /invalid file size/i);
      } finally { mode = 'redirect'; }
    });
    await t.test('destinations must remain within the approved root', async () => {
      const outside = path.join(path.dirname(root), `fb-hf-outside-${crypto.randomUUID()}.gguf`);
      await assert.rejects(hfDownloadFile({...base,dest:outside}), /approved download folder/i);
      assert.equal(fs.existsSync(outside), false);
    });
    await t.test('linked destination folders cannot redirect a download', async t => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hf-linked-folder-'));
      const linked = path.join(root, `linked-${crypto.randomUUID()}`);
      try {
        try { fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`links unavailable: ${error.code}`); return; }
          throw error;
        }
        await assert.rejects(hfDownloadFile({...base,dest:path.join(linked,'escaped.gguf')}), /linked folder/i);
        assert.equal(fs.existsSync(path.join(outside,'escaped.gguf')), false);
      } finally { fs.rmSync(linked, {force:true}); fs.rmSync(outside, {recursive:true,force:true}); }
    });
    await t.test('partial and sidecar links are rejected without touching their targets', async t => {
      const victim = path.join(root, `victim-${crypto.randomUUID()}`);
      const original = crypto.randomBytes(64);
      fs.writeFileSync(victim, original);
      const createLink = target => {
        try { fs.symlinkSync(victim, target, 'file'); return true; }
        catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`links unavailable: ${error.code}`); return false; }
          throw error;
        }
      };
      const partDest = path.join(root, `part-link-${crypto.randomUUID()}.gguf`);
      if (!createLink(partDest + '.frostpart')) return;
      try {
        await assert.rejects(hfDownloadFile({...base,dest:partDest}), /regular, unlinked file/i);
        assert.deepEqual(fs.readFileSync(victim), original);
      } finally { fs.rmSync(partDest + '.frostpart', {force:true}); }
      const sidecarDest = path.join(root, `sidecar-link-${crypto.randomUUID()}.gguf`);
      if (!createLink(sidecarDest + '.frostpart.json')) return;
      try {
        await assert.rejects(hfDownloadFile({...base,dest:sidecarDest}), /regular, unlinked file/i);
        assert.deepEqual(fs.readFileSync(victim), original);
      } finally { fs.rmSync(sidecarDest + '.frostpart.json', {force:true}); fs.rmSync(victim, {force:true}); }
    });
    await t.test('hardlinked partials and sidecars are rejected without truncation', async t => {
      const victim = path.join(root, `hardlink-victim-${crypto.randomUUID()}`);
      const original = crypto.randomBytes(64);
      fs.writeFileSync(victim, original);
      const partDest = path.join(root, `part-hardlink-${crypto.randomUUID()}.gguf`);
      try { fs.linkSync(victim, partDest + '.frostpart'); }
      catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error.code)) { t.skip(`hardlinks unavailable: ${error.code}`); return; }
        throw error;
      }
      try {
        await assert.rejects(hfDownloadFile({...base,dest:partDest}), /regular, unlinked file/i);
        assert.deepEqual(fs.readFileSync(victim), original);
      } finally { fs.rmSync(partDest + '.frostpart', {force:true}); }
      const sidecarDest = path.join(root, `sidecar-hardlink-${crypto.randomUUID()}.gguf`);
      fs.linkSync(victim, sidecarDest + '.frostpart.json');
      try {
        await assert.rejects(hfDownloadFile({...base,dest:sidecarDest}), /regular, unlinked file/i);
        assert.deepEqual(fs.readFileSync(victim), original);
      } finally { fs.rmSync(sidecarDest + '.frostpart.json', {force:true}); fs.rmSync(victim, {force:true}); }
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const response of hangingResponses) response.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
