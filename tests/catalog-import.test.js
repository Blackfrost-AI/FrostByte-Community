import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fetchCatalogJson, isPublicCatalogAddress, persistCatalogImport, validateCatalogUrl } from '../src/main/catalog-import.js';

const profileRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-catalog-transaction-')));
process.env.FROSTBYTE_HOME = path.join(profileRoot, 'config');
const { Store } = await import('../src/main/store.js');
const { Catalog } = await import('../src/main/catalog.js');
after(() => fs.rmSync(profileRoot, { recursive: true, force: true }));

test('catalog URLs require credential-free HTTPS', () => {
  assert.equal(validateCatalogUrl('https://example.com/catalog.json').href, 'https://example.com/catalog.json');
  assert.throws(() => validateCatalogUrl('http://example.com/catalog.json'), /HTTPS/);
  assert.throws(() => validateCatalogUrl('https://user:secret@example.com/catalog.json'), /credentials/);
  assert.throws(() => validateCatalogUrl('not a url'), /valid HTTPS/);
});

test('catalog address policy rejects local, private, metadata, and special-use networks', () => {
  for (const address of [
    '0.0.0.0', '10.2.3.4', '100.64.1.1', '127.0.0.1', '169.254.169.254',
    '172.20.1.1', '192.168.1.2', '198.18.0.1', '224.0.0.1', '::', '::1',
    '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '100::1', 'fec0::1', '2001::1', '2002:7f00:1::', '64:ff9b::7f00:1',
  ]) assert.equal(isPublicCatalogAddress(address), false, address);
  assert.equal(isPublicCatalogAddress('8.8.8.8'), true);
  assert.equal(isPublicCatalogAddress('2606:4700:4700::1111'), true);
});

test('catalog fetch rejects mixed DNS answers before opening a connection', async () => {
  let resolutions = 0;
  await assert.rejects(fetchCatalogJson('https://catalog.example/models.json', {
    resolve: async () => {
      resolutions++;
      return [{ address: '203.0.114.10', family: 4 }, { address: '127.0.0.1', family: 4 }];
    },
  }), /cannot access this network address/);
  assert.equal(resolutions, 1);
});

test('catalog DNS resolution shares the bounded request deadline', async t => {
  let resolverTimer, resolverFinished = false;
  t.after(() => clearTimeout(resolverTimer));
  const started = Date.now();
  await assert.rejects(fetchCatalogJson('https://catalog.example/models.json', {
    // Real DNS holds an active request. A bare pending Promise cannot keep Node
    // alive while the production deadline is intentionally unreferenced.
    resolve: () => new Promise((_, reject) => {
      resolverTimer = setTimeout(() => {
        resolverFinished = true; reject(new Error('Fixture DNS exceeded its test budget.'));
      }, 2000);
    }), timeoutMs: 25,
  }), /resolve|timed out/i);
  assert.equal(resolverFinished, false, 'the request deadline must win over the stalled resolver');
  assert.ok(Date.now() - started < 1000);
});

test('catalog redirects cannot escape the exact reviewed public HTTPS URL', async t => {
  const reviewed = 'https://catalog.example/models.json';
  const unreviewed = 'https://cdn.example/other.json';
  const calls = [];
  let responseDestroyed = false;
  const originalRequest = https.request;
  t.after(() => { https.request = originalRequest; });

  https.request = (url, _options, onResponse) => {
    calls.push(url.href);
    const request = new EventEmitter();
    request.destroy = error => { if (error) request.emit('error', error); };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 302;
      response.headers = { location: unreviewed };
      response.destroy = () => { responseDestroyed = true; };
      queueMicrotask(() => onResponse(response));
    };
    return request;
  };

  await assert.rejects(fetchCatalogJson(reviewed, {
    resolve: async hostname => [{ address: hostname === 'catalog.example' ? '8.8.8.8' : '1.1.1.1', family: 4 }],
  }), /redirects are not allowed.*final HTTPS URL.*reviewed/i);
  assert.deepEqual(calls, [reviewed]);
  assert.equal(responseDestroyed, true);
});

test('a failed catalog URL write restores the exact durable catalog snapshot', () => {
  const store = new Store();
  store.setCatalogState([], []);
  store.setSettings({ catalogUrl: 'https://old.example/catalog.json' });
  const catalog = new Catalog(store);
  catalog.add({ name: 'Existing', infohash: 'a'.repeat(40) });
  store.setCatalogState(store.getUserCatalog(), ['b'.repeat(40)]);
  const before = {
    userCatalog: structuredClone(store.state.userCatalog),
    hiddenCatalog: structuredClone(store.state.hiddenCatalog),
  };
  const setSettings = store.setSettings;
  store.setSettings = () => { throw new Error('Fixture settings write failed'); };
  try {
    assert.throws(() => persistCatalogImport({
      catalog, store, catalogUrl: 'https://new.example/catalog.json',
      entries: [{ name: 'Imported', infohash: 'c'.repeat(40) }],
    }), /Fixture settings write failed/);
  } finally { store.setSettings = setSettings; }

  assert.deepEqual({ userCatalog: store.state.userCatalog, hiddenCatalog: store.state.hiddenCatalog }, before);
  const savedState = JSON.parse(fs.readFileSync(path.join(store.appDir, 'state.json'), 'utf8'));
  assert.deepEqual({ userCatalog: savedState.userCatalog, hiddenCatalog: savedState.hiddenCatalog }, before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.appDir, 'settings.json'), 'utf8')).catalogUrl,
    'https://old.example/catalog.json');
});

test('an all-invalid import leaves legacy hidden catalog state byte-for-byte unchanged', () => {
  const store = new Store();
  store.setCatalogState([], []);
  store.setSettings({ catalogUrl: 'https://old.example/catalog.json' });
  const catalog = new Catalog(store);
  catalog.add({ name: 'Existing', infohash: 'e'.repeat(40) });
  const legacyHidden = ['A'.repeat(40), 'A'.repeat(40), 'B'.repeat(40)];
  store.state.hiddenCatalog = structuredClone(legacyHidden);
  store._flush();

  const stateFile = path.join(store.appDir, 'state.json');
  const beforeMemory = {
    userCatalog: structuredClone(store.state.userCatalog),
    hiddenCatalog: structuredClone(store.state.hiddenCatalog),
  };
  const beforeDurable = fs.readFileSync(stateFile, 'utf8');
  assert.throws(() => persistCatalogImport({
    catalog, store, catalogUrl: 'https://new.example/catalog.json',
    entries: [null, { name: 'Missing identity' }, { name: 'Bad hash', infohash: 'not-a-hash' }],
  }), /no valid model entries/);

  assert.deepEqual({
    userCatalog: store.state.userCatalog,
    hiddenCatalog: store.state.hiddenCatalog,
  }, beforeMemory);
  assert.deepEqual(store.state.hiddenCatalog, legacyHidden);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeDurable);
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.appDir, 'settings.json'), 'utf8')).catalogUrl,
    'https://old.example/catalog.json');
});

test('a failed exact rollback reports the imported durable outcome as successful with a warning result', () => {
  const store = new Store();
  store.setCatalogState([], []);
  store.setSettings({ catalogUrl: 'https://old.example/catalog.json' });
  const catalog = new Catalog(store);
  const setSettings = store.setSettings;
  const setCatalogState = store.setCatalogState.bind(store);
  let catalogWrites = 0;
  store.setSettings = () => { throw new Error('Fixture settings write failed'); };
  store.setCatalogState = (...args) => {
    catalogWrites++;
    if (catalogWrites === 2) throw new Error('Fixture rollback write failed');
    return setCatalogState(...args);
  };

  let result;
  try {
    result = persistCatalogImport({
      catalog, store, catalogUrl: 'https://new.example/catalog.json',
      entries: [{ name: 'Durable import', infohash: 'd'.repeat(40) }],
    });
  } finally {
    store.setSettings = setSettings;
    store.setCatalogState = setCatalogState;
  }

  assert.equal(result.settingsSaved, false);
  assert.match(result.settingsError.message, /settings write failed/);
  assert.match(result.rollbackError.message, /rollback write failed/);
  assert.equal(catalogWrites, 2, 'one catalog commit and one bounded rollback are attempted');
  assert.equal(store.state.userCatalog.some(entry => entry.infohash === 'd'.repeat(40)), true);
  const savedState = JSON.parse(fs.readFileSync(path.join(store.appDir, 'state.json'), 'utf8'));
  assert.equal(savedState.userCatalog.some(entry => entry.infohash === 'd'.repeat(40)), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.appDir, 'settings.json'), 'utf8')).catalogUrl,
    'https://old.example/catalog.json');
});
