import { exposeCompanionDevice } from './companion-fixture.js';
import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hfTransferId } from '../../src/main/hf.js';

let app, page, home, errors;
const internal = '/home/test/FrostByte';
const external = '/media/test/Atlas/Models';
const remoteItem = { id: 'hf-external', source: 'hf', name: 'owner/selected-model', repoId: 'owner/selected-model', path: `${external}/owner/selected-model`, destination: external, relative: 'owner/selected-model', browseRelative: 'owner/selected-model', directory: true, fileCount: 1, size: 123, available: true, missingFiles: 0, updatedAt: 1 };

async function launch() {
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
}
async function library() { await page.locator('#nav [data-tab="library"]').click(); }
async function installRemoteFixture({ online = true, inventory = [remoteItem], local = [], shared = [] } = {}) {
  const base = (await page.evaluate(() => window.frostbyte.getState())).data;
  await app.evaluate(({ ipcMain }, { base, online, inventory, local, shared, internal, external }) => {
    const status = { hostname: 'fixture-spark', architecture: 'arm64', version: '0.2.0-beta.4', downloadDir: internal, storageRoots: [internal, external], storage: [internal, external].map(path => ({ path, available: true, freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4 })), freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4, memoryBytes: 128 * 1024 ** 3, torrents: [], downloads: [], inventory };
    const data = globalThis.inventoryFixture = { online, status, requests: [], controls: [], fileError: false, forces: [], hf: null };
    for (const name of ['app:state', 'spark:status', 'spark:connect', 'spark:files', 'spark:control', 'hf:search', 'hf:model', 'spark:hf-download', 'library:reveal']) ipcMain.removeHandler(name);
    ipcMain.handle('app:state', () => ({ ok: true, data: { ...base, inventory: local, library: shared, settings: { ...base.settings, sparkHost: 'fixture-spark' }, sparkInventory: { host: 'fixture-spark', ...status } } }));
    ipcMain.handle('spark:status', (_, force) => { data.forces.push(force); return { ok: true, data: { connected: data.online, status, ...(data.online ? {} : { error: 'Spark is offline. Reconnect when available.' }) } }; });
    ipcMain.handle('spark:connect', () => { data.online = true; return { ok: true, data: status }; });
    ipcMain.handle('spark:files', (_, relative, root) => {
      data.requests.push({ relative, root });
      if (data.fileError) return { ok: false, error: 'Could not read this folder. Check its permissions on Spark.' };
      const entries = root === external && relative === 'owner/selected-model' ? [{ name: 'config.json', relative: 'owner/selected-model/config.json', directory: false, size: 123 }] : root === external && relative === '' ? [{ name: 'owner', relative: 'owner', directory: true }] : root === internal && relative === '' ? [{ name: 'update.zip', relative: 'update.zip', directory: false, size: 17 }] : [];
      return { ok: true, data: { entries, relative } };
    });
    ipcMain.handle('spark:control', (_, action, id) => { data.controls.push(action); if (action === 'hf:clear') status.downloads = []; if (action === 'hf:remove') status.downloads = status.downloads.filter(row => row.id !== id); return { ok: true, data: true }; });
    ipcMain.handle('library:reveal', (_, target) => { data.reveal = target; return { ok: true, data: true }; });
    ipcMain.handle('hf:search', () => ({ ok: true, data: [{ id: 'owner/selected-model', downloads: 1, likes: 0 }] }));
    ipcMain.handle('hf:model', () => ({ ok: true, data: { id: 'owner/selected-model', sha: 'a'.repeat(40), files: [{ path: 'config.json', size: 123 }, { path: 'model.safetensors', size: 1024 ** 3 }] } }));
    ipcMain.handle('spark:hf-download', (_, request) => {
      data.hf = request;
      status.downloads = request.files.map(file => ({ id: file.path, repoId: request.repoId, filePath: file.path, destination: request.destination, status: 'done', downloaded: file.size, total: file.size }));
      status.inventory = [{ id: 'hf-external', source: 'hf', name: request.repoId, repoId: request.repoId, path: request.destination + '/' + request.repoId, destination: request.destination, relative: request.repoId, browseRelative: request.repoId, directory: true, fileCount: request.files.length, size: request.files.reduce((sum, file) => sum + file.size, 0), available: true, missingFiles: 0, updatedAt: 1 }];
      return { ok: true, data: ['config.json'] };
    });
  }, { base, online, inventory, local, shared, internal, external });
  await exposeCompanionDevice(app);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
}

test.beforeEach(() => {
  errors = [];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inventory-ui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), sparkHost: '', upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false, confirmBigPull: false }));
});
test.afterEach(async () => { await app?.close(); app = null; fs.rmSync(home, { recursive: true, force: true }); expect(errors).toEqual([]); });

test('existing completed local HF files migrate into My Models and survive clearing history and restart without sharing', async () => {
  const destination = path.join(home, 'downloads');
  const modelPath = path.join(destination, 'owner', 'config-only');
  fs.mkdirSync(modelPath, { recursive: true });
  const contents = '{"model_type":"fixture"}\n';
  fs.writeFileSync(path.join(modelPath, 'config.json'), contents);
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ hfDownloads: [{ id: 'old-config', repoId: 'owner/config-only', filePath: 'config.json', revision: 'a'.repeat(40), dest: path.join(modelPath, 'config.json'), baseDir: destination, status: 'done', downloaded: Buffer.byteLength(contents), total: Buffer.byteLength(contents), startedAt: 1 }] }));
  await launch(); await library();
  const card = page.locator('#library-downloads .inventory-item');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('owner/config-only');
  await expect(card).toContainText('1 downloaded file');
  await expect(card).toContainText('Available');
  await expect(page.locator('#ct-library')).toHaveText('1');
  await expect(page.locator('#box-sharing')).toHaveText('0 items');
  await expect(page.locator('#library .lib')).toHaveCount(0);
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('library:reveal'); ipcMain.handle('library:reveal', (_, target) => { globalThis.inventoryRevealed = target; return { ok: true, data: true }; }); });
  await card.getByRole('button', { name: 'Show in Folder' }).click();
  expect(await app.evaluate(() => globalThis.inventoryRevealed)).toBe(modelPath);
  await app.evaluate(({ clipboard, dialog }, expected) => {
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      if (options?.message === 'Copy to clipboard?' && options.detail === JSON.stringify(expected)) {
        globalThis.inventoryClipboardReview = options.detail;
        return { response: 1 };
      }
      return previous.call(dialog, window, options);
    };
    clipboard.writeText = value => { globalThis.inventoryCopiedPath = value; };
  }, modelPath);
  await card.locator('summary').click();
  await card.getByRole('button', { name: 'Copy path' }).click();
  expect(await app.evaluate(() => globalThis.inventoryClipboardReview)).toBe(JSON.stringify(modelPath));
  expect(await app.evaluate(() => globalThis.inventoryCopiedPath)).toBe(modelPath);
  await page.locator('#nav [data-tab="transfers"]').click();
  await page.locator('#hf-clear').click();
  await expect(page.locator('#hf-dl-host')).toHaveCount(0);
  await library(); await expect(card).toHaveCount(1);
  await app.close(); app = null;
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  expect(saved.hfDownloads).toEqual([]);
  expect(saved.downloadedItems).toHaveLength(1);
  await launch(); await library();
  await expect(page.locator('#library-downloads')).toContainText('owner/config-only');
  await expect(page.locator('#box-sharing')).toHaveText('0 items');
});

test('clearing completed local models preserves finished shards and progress through restart', async () => {
  const destination = path.join(home, 'downloads');
  const rows = [
    { id: 'completed-shard', repoId: 'owner/partial', filePath: 'part-1.safetensors', status: 'done', downloaded: 100 },
    { id: 'paused-shard', repoId: 'owner/partial', filePath: 'part-2.safetensors', status: 'paused', downloaded: 0 },
    { id: 'completed-model', repoId: 'owner/finished', filePath: 'config.json', status: 'done', downloaded: 100 },
  ].map(row => ({ ...row, total: 100, revision: 'a'.repeat(40), baseDir: destination, dest: path.join(destination, row.repoId, row.filePath), startedAt: 1 }));
  for (const row of rows.filter(row => row.status === 'done')) { fs.mkdirSync(path.dirname(row.dest), { recursive: true }); fs.writeFileSync(row.dest, Buffer.alloc(100)); }
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ hfDownloads: rows }));
  await launch(); await page.locator('#nav [data-tab="transfers"]').click();
  await expect(page.locator('#transfers .hfdl')).toHaveCount(2);
  await page.locator('#hf-clear').click();
  await expect(page.locator('#transfers .hfdl')).toHaveCount(1);
  await expect(page.locator('#transfers .hfdl')).toContainText('1 of 2 files complete');
  await expect(page.locator('#transfers .hfdl').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await expect(page.locator('#hf-clear')).toBeDisabled();
  await app.close(); app = null;
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  const expectedIds = rows.slice(0, 2).map(row => hfTransferId(row.repoId, row.revision, row.filePath, row.baseDir));
  expect(saved.hfDownloads.map(row => row.id)).toEqual(expectedIds);
  expect(saved.hfDownloads.some(row => row.repoId === 'owner/finished')).toBe(false);
  expect(fs.readFileSync(rows[2].dest)).toHaveLength(100);
  await launch(); await page.locator('#nav [data-tab="transfers"]').click();
  await expect(page.locator('#transfers .hfdl')).toContainText('1 of 2 files complete');
  await library(); await expect(page.locator('#library-downloads')).toContainText('owner/finished');
});

test('device filters and sidebar count include downloaded files, with external-root browsing and single-file parent navigation', async () => {
  await launch();
  const localPath = path.join(home, 'downloads', 'local.zip');
  const local = [{ id: 'local-torrent', source: 'torrent', infoHash: 'b'.repeat(40), name: 'Local archive', path: localPath, destination: path.dirname(localPath), relative: 'local.zip', directory: false, fileCount: 1, size: 17, available: true }];
  const single = { ...remoteItem, id: 'remote-single', source: 'torrent', name: 'Spark update', path: internal + '/update.zip', destination: internal, relative: 'update.zip', directory: false, browseRelative: '', size: 17 };
  await installRemoteFixture({ inventory: [remoteItem, single], local, shared: [{ infohash: 'b'.repeat(40), name: 'Shared local archive', path: localPath, magnet: 'magnet:?xt=urn:btih:' + 'b'.repeat(40) }] });
  await library();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
  await expect(page.locator('#ct-library')).toHaveText('1');
  await expect(page.locator('#ct-catalog')).toHaveText('2');
  await page.locator('#library-device').selectOption('local');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(0);
  await page.locator('#nav [data-tab="catalog"]').click();
  await expect(page.locator('#torrents-inventory .inventory-item')).toHaveCount(2);
  await page.locator('#torrents-device').selectOption('local');
  await expect(page.locator('#torrents-inventory .inventory-item')).toHaveCount(1);
  await library();
  await page.locator('#library-device').selectOption('spark');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
  await page.locator('#library-downloads [data-inventory-id="hf-external"]').getByRole('button', { name: 'Browse files' }).click();
  await expect(page.locator('#spark-library-root')).toHaveValue(external);
  await expect(page.locator('#spark-path')).toHaveText(remoteItem.path);
  await expect(page.locator('#spark-files')).toContainText('config.json');
  expect((await app.evaluate(() => globalThis.inventoryFixture.requests)).at(-1)).toEqual({ root: external, relative: 'owner/selected-model' });
  await page.locator('[data-device-view="catalog"]').click();
  await expect(page.locator('#torrents-device')).toHaveValue('device:spark');
  await page.locator('#torrents-inventory [data-inventory-id="remote-single"]').getByRole('button', { name: 'Browse files' }).click();
  await expect(page.locator('#spark-library-root')).toHaveValue(internal);
  await expect(page.locator('#spark-path')).toHaveText(internal);
  await expect(page.locator('#spark-files')).toContainText('update.zip');
  expect(await app.evaluate(() => globalThis.inventoryFixture.controls)).toEqual([]);
});

test('cached offline inventory stays visible after renderer restart and reconnects to the selected external folder; listing errors have retry', async () => {
  await launch(); await installRemoteFixture({ online: false }); await library();
  await expect(page.locator('#library-downloads')).toContainText('Device offline · last known files');
  await expect(page.locator('#ct-library')).toHaveText('1');
  await page.reload();
  await expect(page.locator('#library-downloads')).toContainText('owner/selected-model');
  await expect(page.locator('#library-downloads')).toContainText('Device offline');
  await page.locator('#library-downloads').getByRole('button', { name: 'Connect to browse' }).click();
  await expect(page.locator('#spark-inventory')).toHaveCount(0);
  await expect(page.locator('#spark-message')).toContainText('offline');
  await expect(page.locator('#spark-files-section')).toBeHidden();
  await page.locator('#spark-connect').click();
  await expect(page.locator('#spark-library-root')).toHaveValue(external);
  await expect(page.locator('#spark-files')).toContainText('config.json');
  await app.evaluate(() => { globalThis.inventoryFixture.fileError = true; });
  await page.locator('#spark-refresh').click();
  await expect(page.locator('#spark-files')).toContainText('Check its permissions on Spark');
  await expect(page.locator('#spark-files')).not.toContainText('No files');
  expect((await app.evaluate(() => globalThis.inventoryFixture.forces)).at(-1)).toBe(true);
  await app.evaluate(() => { globalThis.inventoryFixture.fileError = false; });
  await page.locator('#spark-files-retry').click();
  await expect(page.locator('#spark-files')).toContainText('config.json');
});

test('a selected HF config appears in grouped Spark inventory, survives transfer clearing, and is reachable from My Models', async () => {
  await launch(); await installRemoteFixture({ inventory: [] });
  await page.locator('#nav [data-tab="spark"]').click();
  await expect(page.locator('#spark-message')).toContainText('Connected to fixture-spark');
  await page.locator('#nav [data-tab="hf"]').click(); await page.locator('#hf-q').fill('selected-model'); await page.locator('#hf-go').click();
  await page.locator('#grid-hf tbody tr').click();
  await page.locator('#hf-target').selectOption('spark');
  await page.locator('#hf-spark-destination').selectOption(external);
  await page.locator('#hf-configs').click();
  await page.locator('#hf-pick-none').click(); await page.locator('#hf-files input[data-f="config.json"]').check();
  await page.locator('#hf-download').click();
  await expect(page.locator('#view-transfers')).toBeVisible();
  await expect(page.locator('#transfers .hfdl[data-device="spark"]')).toContainText(external);
  await expect(page.locator('#spark-inventory')).toHaveCount(0);
  await library();
  await expect(page.locator('#library-downloads')).toContainText('1 downloaded file');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
  expect(await app.evaluate(() => globalThis.inventoryFixture.hf)).toMatchObject({ revision: 'a'.repeat(40), destination: external, files: [{ path: 'config.json', size: 123 }] });
  await page.locator('#nav [data-tab="transfers"]').click();
  await page.locator('#spark-hf-clear').click();
  await expect(page.locator('#transfers .hfdl[data-device="spark"]')).toHaveCount(0);
  await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('#spark-open-library').click();
  await expect(page.locator('#library-device')).toHaveValue('spark');
  await expect(page.locator('#library-downloads')).toContainText('1 downloaded file');
  await page.locator('#library-downloads').getByRole('button', { name: 'Browse files' }).click();
  await expect(page.locator('#spark-files')).toContainText('config.json');
  await page.setViewportSize({ width: 980, height: 600 });
  await library();
  await expect(page.locator('#library-downloads .inventory-item')).toBeVisible();
  expect(await page.locator('#view-library').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  fs.mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/spark-inventory-library.png' });
});

test('delayed background folder refresh preserves rows, focus and scroll; navigation never shows the previous folder', async () => {
  await launch(); await installRemoteFixture();
  await app.evaluate(({ ipcMain }, { internal, external }) => {
    const data = globalThis.inventoryFixture;
    data.pendingFiles = []; data.delayFiles = false;
    ipcMain.removeHandler('spark:files');
    ipcMain.handle('spark:files', (_, relative, root) => {
      const entries = root === internal && relative === '' ? Array.from({ length: 300 }, (_, index) => {
        const name = `folder-${String(index).padStart(3, '0')}`;
        return { name, relative: name, directory: true };
      }) : root === external && relative === '' ? [{ name: 'External folder', relative: 'external-folder', directory: true }] : [{ name: 'config.json', relative: 'external-folder/config.json', directory: false, size: 123 }];
      const response = { ok: true, data: { entries, relative } };
      if (data.delayFiles) return new Promise(resolve => data.pendingFiles.push({ relative, root, finish: () => resolve(response) }));
      return response;
    });
  }, { internal, external });
  await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('[data-select-device="spark"]').click();
  await page.locator('#spark-files-section > summary').click();
  await expect(page.locator('#spark-files .spark-file')).toHaveCount(300);
  const focused = page.locator('[data-spark-dir="folder-120"]');
  await focused.scrollIntoViewIfNeeded(); await focused.focus();
  const before = await focused.evaluate(button => {
    window.inventoryFocusedRow = button;
    const scroller = document.querySelector('#view-spark');
    return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
  });
  expect(before.scrollTop).toBeGreaterThan(0);
  await app.evaluate(() => { globalThis.inventoryFixture.delayFiles = true; });
  // Wait for the real five-second background poll, without moving focus to Refresh.
  await expect.poll(() => app.evaluate(() => globalThis.inventoryFixture.pendingFiles.length)).toBe(1);
  await expect(page.locator('#spark-files')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#spark-files .spark-file')).toHaveCount(300);
  await expect(page.locator('#spark-files')).not.toContainText('Loading files');
  await expect(focused).toBeFocused();
  const position = () => page.locator('#view-spark').evaluate(scroller => ({ scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, sameNode: window.inventoryFocusedRow === document.activeElement }));
  expect(await position()).toEqual({ ...before, sameNode: true });
  await app.evaluate(() => { const data = globalThis.inventoryFixture; data.delayFiles = false; data.pendingFiles.splice(0).forEach(request => request.finish()); });
  await expect(page.locator('#spark-files')).toHaveAttribute('aria-busy', 'false');
  await expect(focused).toBeFocused();
  expect(await position()).toEqual({ ...before, sameNode: true });

  await app.evaluate(() => { globalThis.inventoryFixture.delayFiles = true; });
  await page.locator('#spark-library-root').selectOption(external);
  await expect(page.locator('#spark-files')).toContainText('Loading files');
  await expect(page.locator('#spark-files .spark-file')).toHaveCount(0);
  await expect(page.locator('#spark-files')).not.toContainText('folder-120');
  expect(await app.evaluate(() => globalThis.inventoryFixture.pendingFiles.map(({ relative, root }) => ({ relative, root })))).toEqual([{ root: external, relative: '' }]);
  await app.evaluate(() => { const data = globalThis.inventoryFixture; data.delayFiles = false; data.pendingFiles.splice(0).forEach(request => request.finish()); });
  await expect(page.locator('#spark-files')).toContainText('External folder');
  await app.evaluate(() => { globalThis.inventoryFixture.delayFiles = true; });
  await page.locator('[data-spark-dir="external-folder"]').click();
  await expect(page.locator('#spark-files')).toContainText('Loading files');
  await expect(page.locator('#spark-files')).not.toContainText('External folder');
  await app.evaluate(() => { const data = globalThis.inventoryFixture; data.delayFiles = false; data.pendingFiles.splice(0).forEach(request => request.finish()); });
  await expect(page.locator('#spark-files')).toContainText('config.json');
  await expect(page.locator('#spark-path')).toHaveText(external + '/external-folder');
});
