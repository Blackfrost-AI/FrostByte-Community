import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { TorrentEngine } from '../../src/main/torrent.js';
import { completionPathIdentity } from '../../src/main/managers.js';

let app, page, home, downloads, seed, server;
const state = () => page.evaluate(async () => (await window.frostbyte.getState()).data);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function launch() {
  app = await electron.launch({
    executablePath: process.env.FROSTBYTE_EXECUTABLE,
    args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.', '--dev'],
    env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TEST_DIRECT_PEERS: '1' },
    timeout: 30_000,
  });
  page = await app.firstWindow();
  if (!page.url().startsWith('frostbyte://app/')) {
    await expect.poll(() => app.windows().find(window => window.url().startsWith('frostbyte://app/'))?.url()).toBeTruthy();
    page = app.windows().find(window => window.url().startsWith('frostbyte://app/'));
  }
  await acceptBetaTerms(page, app);
  await app.evaluate(({ dialog }) => {
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      if (['Start this Hugging Face download?', 'Resume this Hugging Face download?'].includes(options?.message)) {
        return { response: 1 };
      }
      return previous.call(dialog, window, options);
    };
  });
  await page.waitForFunction(() => window.frostbyte && document.querySelector('#nav .nav.on'));
  if (process.env.FROSTBYTE_EXECUTABLE) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await page.evaluate(() => {
    window.inventoryFailureNotices = [];
    window.frostbyte.onNotice(notice => window.inventoryFailureNotices.push(notice));
  });
}

async function failRegistration(method) {
  // Load exactly the module used by the running app, including app.asar in
  // packaged runs. Only bookkeeping fails; IPC, transfers and file writes stay real.
  // Node's require(ESM) shares the loaded synchronous module; Playwright's eval
  // context does not supply a callback for a bare dynamic import expression.
  const appPath = await app.evaluate(({ app }) => app.getAppPath());
  const modulePath = path.join(appPath, 'src/main/inventory.js');
  await app.evaluate((_, { modulePath, method }) => {
    const require = process.getBuiltinModule('module').createRequire(modulePath);
    const { DownloadInventory } = require(modulePath);
    globalThis.inventoryFailureCalls = [];
    DownloadInventory.prototype[method] = function (record) {
      globalThis.inventoryFailureCalls.push({
        id: record.id, infoHash: record.infoHash, status: record.status,
        done: record.done, downloaded: record.downloaded, dest: record.dest,
      });
      throw new Error('Fixture inventory write failed');
    };
  }, { modulePath, method });
}

async function expectInventoryWarning() {
  await expect.poll(() => page.evaluate(() => window.inventoryFailureNotices.some(notice =>
    notice.level === 'warn' && /could not update inventory/.test(notice.message)
      && notice.message.includes('Fixture inventory write failed')))).toBe(true);
}

async function failStoreFlush(number) {
  await app.evaluate(({ app: electronApp }, failAt) => {
    const modulePath = process.getBuiltinModule('path').join(electronApp.getAppPath(), 'src/main/store.js');
    const require = process.getBuiltinModule('module').createRequire(modulePath);
    const { Store } = require(modulePath);
    const original = Store.prototype._flush;
    let calls = 0;
    Store.prototype._flush = function (...args) {
      calls++;
      if (calls === failAt) {
        Store.prototype._flush = original;
        throw new Error('Fixture state write failed');
      }
      return original.apply(this, args);
    };
  }, number);
}

async function failHfFlush(filePath, status) {
  await app.evaluate(({ app: electronApp }, expected) => {
    const modulePath = process.getBuiltinModule('path').join(electronApp.getAppPath(), 'src/main/store.js');
    const require = process.getBuiltinModule('module').createRequire(modulePath);
    const { Store } = require(modulePath);
    const original = Store.prototype._flush;
    Store.prototype._flush = function (...args) {
      if ((this.state.hfDownloads || []).some(record => record.filePath === expected.filePath && record.status === expected.status)) {
        Store.prototype._flush = original;
        throw new Error('Fixture final state write failed');
      }
      return original.apply(this, args);
    };
  }, { filePath, status });
}

test.beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inventory-errors-')));
  downloads = path.join(home, 'downloads');
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    downloadDir: downloads, upnpEnabled: false, dhtEnabled: false,
    seedOnComplete: false, moveCompleted: false, confirmExitSeeding: false, confirmBigPull: false,
  }));
  await launch();
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    await info.attach('state', { body: JSON.stringify(await state(), null, 2), contentType: 'application/json' }).catch(() => {});
  }
  await app?.close().catch(() => {});
  await seed?.destroy();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (home) fs.rmSync(home, { recursive: true, force: true });
  app = page = seed = server = undefined;
});

test('HF completion stays successful and keeps verified bytes when inventory registration fails', async () => {
  const repoId = 'fixture/inventory-errors', revision = 'a'.repeat(40), filePath = 'config.json';
  const bytes = Buffer.from(JSON.stringify({ model_type: 'fixture', keep_download: true }) + '\n');
  const requests = [];
  server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.url !== `/${repoId}/resolve/${revision}/${filePath}`) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'content-length': bytes.length, etag: digest(bytes) });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.evaluate((_, origin) => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
      if (url.origin !== 'https://huggingface.co') throw new Error('Unexpected external fixture request');
      return nativeFetch(origin + url.pathname + url.search, options);
    };
  }, `http://127.0.0.1:${server.address().port}`);
  await failRegistration('registerHf');
  await page.locator('#nav [data-tab="transfers"]').click();
  const result = await page.evaluate(request => window.frostbyte.hfDownload(request), {
    repoId, revision, files: [{ path: filePath, size: bytes.length }],
  });
  expect(result.ok, result.error).toBe(true);
  const id = result.data.started[0], dest = path.join(downloads, repoId, filePath);
  await expect.poll(async () => {
    const record = (await state()).downloads.find(item => item.id === id);
    return record && { status: record.status, error: record.error };
  }).toEqual({ status: 'done', error: '' });
  expect((await state()).downloads.find(record => record.id === id)).toMatchObject({
    status: 'done', downloaded: bytes.length, total: bytes.length, error: '', dest,
  });
  expect(await app.evaluate(() => globalThis.inventoryFailureCalls)).toEqual([
    { id, infoHash: undefined, status: 'done', done: undefined, downloaded: bytes.length, dest },
  ]);
  await expectInventoryWarning();
  expect(requests.map(request => request.method)).toEqual(['HEAD', 'GET']);
  expect(digest(fs.readFileSync(dest))).toBe(digest(bytes));
  expect(fs.existsSync(dest + '.frostpart')).toBe(false);
  expect(fs.existsSync(dest + '.frostpart.json')).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads.find(record => record.id === id))
    .toMatchObject({ status: 'done', downloaded: bytes.length, error: '' });

  await app.close();
  await launch();
  expect((await state()).downloads.find(record => record.id === id)).toMatchObject({ status: 'done', downloaded: bytes.length, error: '' });
  expect(digest(fs.readFileSync(dest))).toBe(digest(bytes));
  expect(requests.map(request => request.method)).toEqual(['HEAD', 'GET']);
});

test('HF persistence failures never leave rejected or active work hidden in memory', async () => {
  const request = filePath => ({ repoId: 'fixture/persistence', revision: 'b'.repeat(40), files: [{ path: filePath, size: 64 }] });
  await app.evaluate(() => {
    globalThis.hfPersistenceFetches = 0;
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
      if (url.origin === 'https://huggingface.co') { globalThis.hfPersistenceFetches++; throw new Error('HF fixture must not reach the network'); }
      return nativeFetch(input, options);
    };
  });

  await failStoreFlush(1);
  const rejected = await page.evaluate(value => window.frostbyte.hfDownload(value), request('rejected.bin'));
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toContain('Fixture state write failed');
  expect((await state()).downloads).toEqual([]);

  await failStoreFlush(2);
  const accepted = await page.evaluate(value => window.frostbyte.hfDownload(value), request('worker.bin'));
  expect(accepted.ok, accepted.error).toBe(true);
  await expect.poll(async () => (await state()).downloads[0]?.status).toBe('error');
  expect((await state()).downloads[0].error).toContain('Could not save download state');
  expect(await app.evaluate(() => globalThis.hfPersistenceFetches)).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads[0].status).toBe('error');

  const workerId = accepted.data.started[0];
  await failStoreFlush(1);
  const rejectedClear = await page.evaluate(id => window.frostbyte.hfClearFinished([id]), workerId);
  expect(rejectedClear.ok).toBe(false);
  expect((await state()).downloads.find(record => record.id === workerId)?.status).toBe('error');
  const retriedClear = await page.evaluate(id => window.frostbyte.hfClearFinished([id]), workerId);
  expect(retriedClear.ok, retriedClear.error).toBe(true);
  expect((await state()).downloads.find(record => record.id === workerId)?.status).toBe('error');
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads.find(record => record.id === workerId)?.status).toBe('error');
});

test('restart preserves the original when a published completion destination was replaced', async () => {
  await app.close(); app = page = undefined;
  await new Promise(resolve => setTimeout(resolve, 500));
  const sourceRoot = path.join(home, 'completion-source');
  const destinationRoot = path.join(home, 'completion-destination');
  const source = path.join(sourceRoot, 'model.bin');
  const destination = path.join(destinationRoot, 'model.bin');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(destinationRoot);
  fs.writeFileSync(source, crypto.randomBytes(64 * 1024));

  const fixtureEngine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const torrent = await fixtureEngine.seed(source);
  const record = fixtureEngine.sessions()[0];
  await fixtureEngine.destroy();
  fs.writeFileSync(destination, 'old published inode');
  const destinationIdentity = completionPathIdentity(destination);
  fs.unlinkSync(destination);
  fs.writeFileSync(destination, 'unrelated replacement');
  const sourceIdentity = completionPathIdentity(source);

  const stateFile = path.join(home, 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.transfers = [{ ...record, path: destinationRoot, completionHandled: false }];
  saved.completionMoves = [{ infohash: torrent.infoHash, source, destination,
    sourceIdentity, destinationIdentity, phase: 'published' }];
  fs.writeFileSync(stateFile, JSON.stringify(saved));

  await launch();
  await expect.poll(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).completionMoves?.[0]).toMatchObject({
    phase: 'published', manualResolution: true,
  });
  expect(fs.readFileSync(source).length).toBe(64 * 1024);
  expect(fs.readFileSync(destination, 'utf8')).toBe('unrelated replacement');
  const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  expect(recovered.transfers[0].path).toBe(sourceRoot);
  expect(recovered.completionMoves[0].destinationIdentity).toEqual(destinationIdentity);
});

test('an independent published copy stays in manual resolution across restarts without completion errors', async () => {
  await app.close(); app = page = undefined;
  await new Promise(resolve => setTimeout(resolve, 500));
  const sourceRoot = path.join(home, 'manual-completion-source');
  const destinationRoot = path.join(home, 'manual-completion-destination');
  const source = path.join(sourceRoot, 'model.bin');
  const destination = path.join(destinationRoot, 'model.bin');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(destinationRoot);
  const bytes = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(source, bytes);

  const fixtureEngine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const torrent = await fixtureEngine.seed(source);
  const record = fixtureEngine.sessions()[0];
  await fixtureEngine.destroy();
  fs.copyFileSync(source, destination);
  const sourceIdentity = completionPathIdentity(source);
  const destinationIdentity = completionPathIdentity(destination);
  expect(destinationIdentity).not.toEqual(sourceIdentity);

  const settingsFile = path.join(home, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings,
    moveCompleted: true, completedDir: destinationRoot, seedOnComplete: true,
  }));
  const stateFile = path.join(home, 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.transfers = [{ ...record, path: destinationRoot, explicitShare: false, completionHandled: false }];
  saved.completionMoves = [{ infohash: torrent.infoHash, source, destination,
    sourceIdentity, destinationIdentity, phase: 'published' }];
  fs.writeFileSync(stateFile, JSON.stringify(saved));

  for (let launchNumber = 1; launchNumber <= 2; launchNumber++) {
    await launch();
    await expect(page.locator('#toasts .toast').filter({ hasText: 'needs review' }))
      .toHaveCount(launchNumber === 1 ? 1 : 0);
    await expect.poll(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).completionMoves?.[0]).toMatchObject({
      phase: 'published', manualResolution: true, source, destination,
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(recovered.transfers[0].path).toBe(sourceRoot);
    expect(recovered.completionMoves).toHaveLength(1);
    expect(fs.readFileSync(source)).toEqual(bytes);
    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(await page.evaluate(() => window.inventoryFailureNotices.some(notice =>
      /Could not finish|already exists at destination/i.test(notice.message)))).toBe(false);
    if (launchNumber === 1) {
      await app.close(); app = page = undefined;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
});

test('restart preserves a sole exact publishing hard link and promotes it to published', async () => {
  await app.close(); app = page = undefined;
  await new Promise(resolve => setTimeout(resolve, 500));
  const sourceRoot = path.join(home, 'sole-link-source');
  const destinationRoot = path.join(home, 'sole-link-destination');
  const source = path.join(sourceRoot, 'model.bin');
  const destination = path.join(destinationRoot, 'model.bin');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(destinationRoot);
  fs.writeFileSync(source, crypto.randomBytes(64 * 1024));

  const fixtureEngine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const torrent = await fixtureEngine.seed(source);
  const record = fixtureEngine.sessions()[0];
  await fixtureEngine.destroy();
  // Make the restored transfer incomplete so the normal done handler cannot
  // consume the recovery journal before the startup assertions run.
  const retained = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(source, retained);
  fs.linkSync(source, destination);
  const sourceIdentity = completionPathIdentity(source);
  const destinationIdentity = completionPathIdentity(destination);
  expect(destinationIdentity).toEqual(sourceIdentity);
  fs.unlinkSync(source);

  const stateFile = path.join(home, 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.transfers = [{ ...record, path: sourceRoot, explicitShare: false, completionHandled: false }];
  saved.completionMoves = [{ infohash: torrent.infoHash, source, destination,
    sourceIdentity, destinationIdentity, phase: 'publishing' }];
  fs.writeFileSync(stateFile, JSON.stringify(saved));

  await launch();
  await expect.poll(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).completionMoves?.[0]).toMatchObject({
    phase: 'published', destinationIdentity,
  });
  expect(fs.existsSync(source)).toBe(false);
  expect(fs.readFileSync(destination)).toEqual(retained);
  const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  expect(recovered.transfers[0].path).toBe(destinationRoot);
});

test('restart removes only the staging name that proves a published hard link', async () => {
  await app.close(); app = page = undefined;
  await new Promise(resolve => setTimeout(resolve, 500));
  const sourceRoot = path.join(home, 'staged-completion-source');
  const destinationRoot = path.join(home, 'staged-completion-destination');
  const source = path.join(sourceRoot, 'model.bin');
  const destination = path.join(destinationRoot, 'model.bin');
  // Persist the exact staging shape production accepts: a private UUID leaf
  // beside the eventual destination. An arbitrary path is intentionally
  // rejected during saved-state normalization and would not test recovery.
  const staging = path.join(destinationRoot, `.frostbyte-moving-${crypto.randomUUID()}`);
  fs.mkdirSync(sourceRoot); fs.mkdirSync(destinationRoot);
  const bytes = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(source, bytes);

  const fixtureEngine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const torrent = await fixtureEngine.seed(source);
  const record = fixtureEngine.sessions()[0];
  await fixtureEngine.destroy();
  fs.copyFileSync(source, staging);
  fs.linkSync(staging, destination);
  const sourceIdentity = completionPathIdentity(source);
  const stagingIdentity = completionPathIdentity(staging);
  const destinationIdentity = completionPathIdentity(destination);
  expect(stagingIdentity).toEqual(destinationIdentity);
  expect(sourceIdentity).not.toEqual(destinationIdentity);

  const stateFile = path.join(home, 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.transfers = [{ ...record, path: destinationRoot, completionHandled: false }];
  saved.completionMoves = [{ infohash: torrent.infoHash, source, destination, staging,
    sourceIdentity, stagingIdentity, destinationIdentity, phase: 'published' }];
  fs.writeFileSync(stateFile, JSON.stringify(saved));

  await launch();
  await expect.poll(() => fs.existsSync(staging)).toBe(false);
  expect(fs.readFileSync(source)).toEqual(bytes);
  expect(fs.readFileSync(destination)).toEqual(bytes);
  expect(fs.statSync(destination).nlink).toBe(1);
  const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  expect(recovered.transfers[0].path).toBe(destinationRoot);
  expect(recovered.completionMoves[0]).toMatchObject({ phase: 'published', destinationIdentity });
  expect(recovered.completionMoves[0].staging).toBeUndefined();
});

test('hard-link recovery journals destination proof before source cleanup and survives another restart', async () => {
  await app.close(); app = page = undefined;
  await new Promise(resolve => setTimeout(resolve, 500));
  const sourceRoot = path.join(home, 'direct-completion-source');
  const destinationRoot = path.join(home, 'direct-completion-destination');
  const source = path.join(sourceRoot, 'model.bin');
  const destination = path.join(destinationRoot, 'model.bin');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(destinationRoot);
  fs.writeFileSync(source, crypto.randomBytes(64 * 1024));

  const fixtureEngine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const torrent = await fixtureEngine.seed(source);
  const record = fixtureEngine.sessions()[0];
  await fixtureEngine.destroy();
  // Keep the recovered session incomplete so its normal done handler cannot
  // consume the crash journal before this test simulates the second crash.
  const bytes = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(source, bytes);
  fs.linkSync(source, destination);
  const sourceIdentity = completionPathIdentity(source);
  expect(completionPathIdentity(destination)).toEqual(sourceIdentity);

  const stateFile = path.join(home, 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.transfers = [{ ...record, path: sourceRoot, completionHandled: false }];
  saved.completionMoves = [{ infohash: torrent.infoHash, source, destination,
    sourceIdentity, phase: 'publishing' }];
  fs.writeFileSync(stateFile, JSON.stringify(saved));

  await launch();
  await expect.poll(() => fs.existsSync(source)).toBe(false);
  expect(fs.readFileSync(destination)).toEqual(bytes);
  const firstRecovery = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  expect(firstRecovery.completionMoves[0]).toMatchObject({
    phase: 'published', destinationIdentity: sourceIdentity,
  });
  expect(firstRecovery.transfers[0].path).toBe(destinationRoot);

  const crashed = app.process();
  await new Promise(resolve => { crashed.once('exit', resolve); crashed.kill('SIGKILL'); });
  app = page = undefined;
  await new Promise(resolve => setTimeout(resolve, 500));
  await launch();
  expect(fs.readFileSync(destination)).toEqual(bytes);
  const secondRecovery = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  expect(secondRecovery.completionMoves[0]).toMatchObject({
    phase: 'published', destinationIdentity: sourceIdentity,
  });
});

test('restart preserves unrelated children in an exact journaled publishing directory', async () => {
  await app.close(); app = page = undefined;
  await new Promise(resolve => setTimeout(resolve, 500));
  const sourceRoot = path.join(home, 'directory-completion-source');
  const destinationRoot = path.join(home, 'directory-completion-destination');
  const source = path.join(sourceRoot, 'model-directory');
  const destination = path.join(destinationRoot, 'model-directory');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  const bytes = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(path.join(source, 'nested', 'model.bin'), bytes);
  fs.writeFileSync(path.join(destination, 'keep-user-file.txt'), 'unrelated destination bytes');

  const fixtureEngine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const torrent = await fixtureEngine.seed(source);
  const record = fixtureEngine.sessions()[0];
  await fixtureEngine.destroy();
  const sourceIdentity = completionPathIdentity(source);
  const destinationIdentity = completionPathIdentity(destination);

  const stateFile = path.join(home, 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.transfers = [{ ...record, path: destinationRoot, completionHandled: false }];
  saved.completionMoves = [{ infohash: torrent.infoHash, source, destination,
    sourceIdentity, destinationIdentity, phase: 'publishing' }];
  fs.writeFileSync(stateFile, JSON.stringify(saved));

  await launch();
  await expect.poll(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).completionMoves?.[0]).toMatchObject({
    phase: 'publishing', manualResolution: true,
  });
  expect(fs.readFileSync(path.join(source, 'nested', 'model.bin'))).toEqual(bytes);
  expect(fs.readFileSync(path.join(destination, 'keep-user-file.txt'), 'utf8')).toBe('unrelated destination bytes');
  const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  expect(recovered.transfers[0].path).toBe(sourceRoot);
  expect(recovered.completionMoves[0].destinationIdentity).toEqual(destinationIdentity);
});

test('a failed live settings change rolls back before a later settings request can commit', async () => {
  await app.evaluate(({ app, dialog }) => {
    const modulePath = process.getBuiltinModule('path').join(app.getAppPath(), 'src/main/managers.js');
    const require = process.getBuiltinModule('module').createRequire(modulePath);
    const { UpnpManager } = require(modulePath);
    const { Store } = require(process.getBuiltinModule('path').join(app.getAppPath(), 'src/main/store.js'));
    const setSettings = Store.prototype.setSettings;
    Store.prototype.setSettings = function (...args) {
      globalThis.settingsTransactionStore = this;
      return setSettings.apply(this, args);
    };
    globalThis.settingsTransactionCalls = [];
    globalThis.releaseSettingsEnable = null;
    globalThis.simulateDeviceSettingsCommit = () => globalThis.settingsTransactionStore.setSettings({
      sparkHost: 'new-device', sparkDownloadHost: 'new-device', sparkDownloadDir: '/device/models',
    });
    UpnpManager.prototype.enable = function () {
      this.wanted = true;
      globalThis.settingsTransactionCalls.push('upnp:enable');
      return new Promise((resolve, reject) => {
        globalThis.releaseSettingsEnable = () => reject(new Error('Fixture UPnP apply failed'));
      });
    };
    UpnpManager.prototype.disable = async function () {
      this.wanted = false;
      globalThis.settingsTransactionCalls.push('upnp:disable');
    };
    app.setLoginItemSettings = ({ openAtLogin }) => {
      globalThis.settingsTransactionCalls.push(`login:${openAtLogin}`);
    };
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => options?.message === 'Allow these system and network changes?'
      ? { response: 1 } : previous.call(dialog, window, options);
  });

  const first = page.evaluate(() => window.frostbyte.setSettings({ openAtLogin: true, upnpEnabled: true }));
  await expect.poll(() => app.evaluate(() => typeof globalThis.releaseSettingsEnable === 'function')).toBe(true);
  await app.evaluate(() => globalThis.simulateDeviceSettingsCommit());
  const second = page.evaluate(() => window.frostbyte.setSettings({ theme: 'abyss' }));
  await app.evaluate(() => globalThis.releaseSettingsEnable());
  const rejected = await first;
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toContain('Fixture UPnP apply failed');
  const committed = await second;
  expect(committed.ok, committed.error).toBe(true);
  expect(committed.data.settings).toMatchObject({ openAtLogin: false, upnpEnabled: false, theme: 'abyss',
    sparkHost: 'new-device', sparkDownloadHost: 'new-device', sparkDownloadDir: '/device/models' });
  expect(await app.evaluate(() => globalThis.settingsTransactionCalls)).toEqual([
    'login:true', 'upnp:enable', 'login:false', 'upnp:disable',
  ]);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')))
    .toMatchObject({ openAtLogin: false, upnpEnabled: false, theme: 'abyss',
      sparkHost: 'new-device', sparkDownloadHost: 'new-device', sparkDownloadDir: '/device/models' });
});

test('a settings write and login-item rollback failure are both reported', async () => {
  await app.evaluate(({ app, dialog }) => {
    const modulePath = process.getBuiltinModule('path').join(app.getAppPath(), 'src/main/store.js');
    const require = process.getBuiltinModule('module').createRequire(modulePath);
    const { Store } = require(modulePath);
    const original = Store.prototype.setSettings;
    Store.prototype.setSettings = function (patch, ...args) {
      if (patch?.openAtLogin === true) {
        Store.prototype.setSettings = original;
        throw new Error('Fixture settings write failed');
      }
      return original.call(this, patch, ...args);
    };
    app.setLoginItemSettings = ({ openAtLogin }) => {
      if (openAtLogin === false) throw new Error('Fixture login rollback failed');
    };
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => options?.message === 'Allow these system and network changes?'
      ? { response: 1 } : previous.call(dialog, window, options);
  });

  const result = await page.evaluate(() => window.frostbyte.setSettings({ openAtLogin: true }));
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Could not save the settings or fully restore');
  expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).openAtLogin ?? false).toBe(false);
});

test('HF final writes retry truthfully while pause and queued cancel roll back on flush failure', async () => {
  const repoId = 'fixture/hf-settlement', revision = 'c'.repeat(40), payload = Buffer.alloc(64, 7);
  const requests = [];
  server = http.createServer((request, response) => {
    const filePath = decodeURIComponent(request.url.split('/').pop());
    requests.push({ method: request.method, filePath });
    response.writeHead(200, { 'content-length': payload.length, etag: digest(payload) });
    if (request.method === 'HEAD') { response.end(); return; }
    if (filePath === 'final.bin') { response.end(payload); return; }
    response.write(payload.subarray(0, 1)); // keep two workers occupied until Pause aborts them
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.evaluate((_, origin) => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
      if (url.origin !== 'https://huggingface.co') return nativeFetch(input, options);
      return nativeFetch(origin + url.pathname + url.search, options);
    };
  }, `http://127.0.0.1:${server.address().port}`);
  await page.locator('#nav [data-tab="transfers"]').click();

  await failHfFlush('final.bin', 'done');
  const finalResult = await page.evaluate(request => window.frostbyte.hfDownload(request), {
    repoId, revision, files: [{ path: 'final.bin', size: payload.length }],
  });
  expect(finalResult.ok, finalResult.error).toBe(true);
  const finalId = finalResult.data.started[0];
  await expect.poll(async () => (await state()).downloads.find(record => record.id === finalId)?.status).toBe('done');
  await expect(page.locator('.hf-file', { hasText: 'final.bin' }).locator('.hf-file-progress')).toContainText('done');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads
    .find(record => record.id === finalId)?.status).toBe('done');
  const finalRequests = requests.length;
  const duplicate = await page.evaluate(request => window.frostbyte.hfDownload(request), {
    repoId, revision, files: [{ path: 'final.bin', size: payload.length }],
  });
  expect(duplicate.ok, duplicate.error).toBe(true);
  expect(duplicate.data.started).toEqual([]);
  expect(requests).toHaveLength(finalRequests);

  const occupied = path.join(downloads, repoId, 'occupied.bin');
  fs.writeFileSync(occupied, 'existing independent file');
  const occupiedResult = await page.evaluate(request => window.frostbyte.hfDownload(request), {
    repoId, revision, files: [{ path: 'occupied.bin', size: payload.length }],
  });
  expect(occupiedResult.ok).toBe(false);
  expect(occupiedResult.error).toContain('already exists');
  expect(fs.readFileSync(occupied, 'utf8')).toBe('existing independent file');

  const held = await page.evaluate(request => window.frostbyte.hfDownload(request), {
    repoId, revision, files: ['hold-a.bin', 'hold-b.bin', 'hold-c.bin'].map(filePath => ({ path: filePath, size: payload.length })),
  });
  expect(held.ok, held.error).toBe(true);
  await expect.poll(async () => {
    const rows = (await state()).downloads.filter(record => held.data.started.includes(record.id));
    return { active: rows.filter(record => record.status === 'active').length, queued: rows.filter(record => record.status === 'queued').length };
  }).toEqual({ active: 2, queued: 1 });
  let rows = (await state()).downloads.filter(record => held.data.started.includes(record.id));
  const activeId = rows.find(record => record.status === 'active').id;
  const queuedId = rows.find(record => record.status === 'queued').id;

  await failStoreFlush(1);
  const rejectedCancel = await page.evaluate(id => window.frostbyte.hfCancel(id), queuedId);
  expect(rejectedCancel.ok).toBe(false);
  expect((await state()).downloads.find(record => record.id === queuedId)?.status).toBe('queued');
  const retriedCancel = await page.evaluate(id => window.frostbyte.hfCancel(id), queuedId);
  expect(retriedCancel.ok, retriedCancel.error).toBe(true);
  expect((await state()).downloads.find(record => record.id === queuedId)?.status).toBe('paused');
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads.find(record => record.id === queuedId)?.status).toBe('paused');

  await failStoreFlush(1);
  const rejectedPause = await page.evaluate(id => window.frostbyte.hfPause(id), activeId);
  expect(rejectedPause.ok).toBe(false);
  expect((await state()).downloads.find(record => record.id === activeId)?.status).toBe('active');
  const retriedPause = await page.evaluate(id => window.frostbyte.hfPause(id), activeId);
  expect(retriedPause.ok, retriedPause.error).toBe(true);
  await expect.poll(async () => (await state()).downloads.find(record => record.id === activeId)?.status).toBe('paused');

  rows = (await state()).downloads.filter(record => held.data.started.includes(record.id));
  for (const record of rows.filter(record => record.status === 'active')) {
    const result = await page.evaluate(id => window.frostbyte.hfPause(id), record.id);
    expect(result.ok, result.error).toBe(true);
  }
  await expect.poll(async () => (await state()).downloads
    .filter(record => held.data.started.includes(record.id) && record.id !== queuedId)
    .every(record => record.status === 'paused')).toBe(true);
  expect(requests.filter(request => request.filePath === 'final.bin').map(request => request.method)).toEqual(['HEAD', 'GET']);
});

test('torrent completion still stops sharing and retains files when inventory registration fails', async () => {
  const bytes = crypto.randomBytes(512 * 1024), source = path.join(home, 'release-update.bin');
  fs.writeFileSync(source, bytes);
  seed = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const shared = await seed.seed(source);
  // Supply the only peer explicitly, with no public trackers or DHT lookup.
  const magnet = `magnet:?xt=urn:btih:${shared.infoHash}&x.pe=127.0.0.1:${seed.port}`;
  await app.evaluate(({ dialog }) => {
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => options?.message === 'Find torrent peers?'
      ? { response: 1 } : previous.call(dialog, window, options);
  });
  await failRegistration('registerTorrent');
  expect((await state()).settings.seedOnComplete).toBe(false);
  const result = await page.evaluate(source => window.frostbyte.add(source), magnet);
  expect(result.ok, result.error).toBe(true);
  expect(result.data.torrent.infoHash).toBe(shared.infoHash);
  await expect.poll(() => app.evaluate(() => globalThis.inventoryFailureCalls.length)).toBe(1);
  expect(await app.evaluate(() => globalThis.inventoryFailureCalls[0])).toMatchObject({
    infoHash: shared.infoHash, done: true, downloaded: bytes.length,
  });
  await expectInventoryWarning();
  await expect.poll(async () => (await state()).torrents).toEqual([]);
  await expect.poll(() => page.evaluate(() => window.inventoryFailureNotices.some(notice =>
    /sharing stopped/.test(notice.message) && /Files kept/.test(notice.message)))).toBe(true);
  expect((await state()).library).toEqual([]);
  const dest = path.join(downloads, path.basename(source));
  expect(digest(fs.readFileSync(dest))).toBe(digest(bytes));
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).transfers).toEqual([]);
  await expect.poll(() => seed.client.torrents[0].wires.length).toBe(0);

  await app.close();
  await launch();
  expect((await state()).torrents).toEqual([]);
  expect((await state()).library).toEqual([]);
  expect(digest(fs.readFileSync(dest))).toBe(digest(bytes));
});
