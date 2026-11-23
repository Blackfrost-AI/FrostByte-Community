import { test, expect, _electron as electron } from '@playwright/test';
import { acceptBetaTerms } from './consent-helper.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app, page, home, errors;
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click();
const search = async text => { await page.locator('#omni').fill(text); await page.locator('#omni').press('Enter'); };

test.beforeEach(async () => {
  errors = [];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-download-search-'));
  const destination = path.join(home, 'Downloads'), repoId = 'demo/Kept-Model', filePath = 'nested/vocabulary.json';
  const dest = path.join(destination, repoId, filePath);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, '{}');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: destination, dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false, confirmBigPull: false }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ hfDownloads: [{ id: 'kept-config', repoId, revision: 'a'.repeat(40), filePath, dest, baseDir: destination, downloaded: 2, total: 2, status: 'done' }] }));
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await acceptBetaTerms(page, app);
  await nav('transfers');
  await expect(page.locator('#view-transfers')).toBeVisible();
  const base = (await page.evaluate(() => window.frostbyte.getState())).data;
  await app.evaluate(({ ipcMain }, base) => {
    const root = base.settings.downloadDir;
    const hf = (id, filePath, status, total, downloaded) => ({ id, repoId: 'demo/Atlas', revision: 'a'.repeat(40), filePath, baseDir: root, dest: root + '/demo/Atlas/' + filePath, status, total, downloaded, speedBps: status === 'active' ? 10 : 0 });
    const item = (id, name, destination, files) => ({ id, name, source: 'hf', kind: 'model', repoId: name, destination, path: destination + '/' + name, directory: true, relative: name, files, size: 2050, fileCount: files.length, available: true });
    const devices = ['studio', 'offline'].map((id, index) => ({ id, host: id + '-fixture', name: index ? 'Archive Mac' : 'Studio Spark', connected: !index, status: { hostname: id + '-fixture', downloadDir: '/Models', storage: [{ path: '/Models', available: true }], inventoryControls: true, torrents: [], downloads: [], inventory: [item('same-item-id', 'demo/Archived-Model', '/Models', [{ path: 'tokenizer.json' }])] } }));
    const fixture = globalThis.downloadSearchFixture = { hfCalls: 0, controls: [], state: { ...base, devices, selectedDeviceId: 'studio', settings: { ...base.settings, sparkHost: 'studio-fixture' },
      downloads: [hf('atlas-config', 'config.json', 'done', 2, 2), hf('atlas-first', 'model-00001.gguf', 'active', 1024, 512), hf('atlas-second', 'model-00002.gguf', 'queued', 1024, 0)],
      torrents: [{ infoHash: 'b'.repeat(40), name: 'Field notes', length: 100, downloaded: 50, progress: .5, ready: true, paused: false, done: false, files: [{ name: 'notes.txt', path: 'notes.txt' }], downloadSpeed: 10, uploadSpeed: 0, numPeers: 1, path: root }],
      inventory: [...base.inventory, item('atlas-inventory', 'demo/Atlas', root, [{ path: 'config.json' }, { path: 'model-00001.gguf' }, { path: 'model-00002.gguf' }])],
    } };
    for (const name of ['app:state', 'devices:status', 'spark:status', 'hf:search', 'hf:pause', 'hf:clear', 'item:kind']) ipcMain.removeHandler(name);
    ipcMain.handle('app:state', () => ({ ok: true, data: fixture.state }));
    ipcMain.handle('devices:status', () => ({ ok: true, data: devices }));
    ipcMain.handle('spark:status', () => ({ ok: true, data: { connected: true, status: devices[0].status } }));
    ipcMain.handle('hf:search', () => { fixture.hfCalls++; return { ok: true, data: [] }; });
    ipcMain.handle('hf:pause', (_, { id }) => { fixture.controls.push(id); fixture.state.downloads.find(row => row.id === id).status = 'paused'; return { ok: true, data: fixture.state }; });
    ipcMain.handle('hf:clear', (_, ids) => { fixture.state.downloads = fixture.state.downloads.filter(row => !ids.includes(row.id)); return { ok: true, data: fixture.state }; });
    ipcMain.handle('item:kind', (_, request) => { fixture.controls.push(request); devices.find(device => device.id === request.deviceId).status.inventory.find(entry => entry.id === request.id).kind = request.kind; return { ok: true, data: { state: fixture.state } }; });
  }, base);
  await page.reload(); await expect(page.locator('#view-transfers')).toBeVisible();
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('failure.png') });
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  expect(errors).toEqual([]);
});

test('old Search navigation migrates to Transfers, and top-bar searches never query HuggingFace', async () => {
  await expect(page.locator('#nav [data-tab="search"], #view-search')).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('fb:lastTab', JSON.stringify('search')));
  await page.reload(); await expect(page.locator('#nav [data-tab="transfers"]')).toHaveClass(/on/);
  await nav('hf'); await page.locator('#hf-q').fill('public model'); await page.locator('#hf-go').click();
  await expect.poll(() => app.evaluate(() => globalThis.downloadSearchFixture.hfCalls)).toBe(1);
  await search('Kept-Model');
  await expect(page.locator('#view-transfers')).toBeVisible();
  await expect(page.locator('#transfer-inventory .inventory-item')).toHaveCount(1);
  await expect(page.locator('#transfer-inventory')).toContainText('demo/Kept-Model');
  expect(await app.evaluate(() => globalThis.downloadSearchFixture.hfCalls)).toBe(1);
});

test('completed file names and offline device inventory remain searchable, with device-scoped item controls', async () => {
  await search('VOCABULARY json');
  await expect(page.locator('#transfer-inventory .inventory-item')).toHaveCount(1);
  await expect(page.locator('#transfer-inventory')).toContainText('Kept-Model');
  await search('archived'); await expect(page.locator('#transfer-inventory .inventory-item')).toHaveCount(2);
  const offline = page.locator('#transfer-inventory [data-inventory-connection="offline"]');
  await expect(offline).toContainText('Device offline'); await expect(offline.getByRole('switch')).toBeDisabled();
  await page.locator('#transfers-device').selectOption('device:studio');
  const online = page.locator('#transfer-inventory [data-inventory-connection="studio"]');
  await expect(page.locator('#transfer-inventory .inventory-item')).toHaveCount(1);
  await online.locator('summary').click(); await online.getByRole('button', { name: 'Move to Torrents', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.downloadSearchFixture.controls)).toEqual([{ device: 'spark', deviceId: 'studio', id: 'same-item-id', kind: 'torrent' }]);
});

test('a shard match keeps the whole model and bulk controls affect only matching transfers', async () => {
  await search('Atlas model-00001');
  const model = page.locator('.hf-model');
  await expect(model).toHaveCount(1); await expect(page.locator('#transfers .tor')).toHaveCount(0);
  await expect(model).toContainText('1 of 3 files complete');
  await expect(model.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  await page.locator('#btn-pauseall').click();
  await expect.poll(() => app.evaluate(() => globalThis.downloadSearchFixture.controls)).toEqual(['atlas-first', 'atlas-second']);
  await expect(model).toContainText('Paused');
  await expect(model.locator('.hf-model-files summary')).toContainText('3 files');
  expect(await app.evaluate(() => globalThis.downloadSearchFixture.state.torrents[0].paused)).toBe(false);
});

test('clearing finished transfers reveals one retained inventory result; empty results and clearing work at minimum window size', async () => {
  await app.evaluate(() => { for (const row of globalThis.downloadSearchFixture.state.downloads) { row.status = 'done'; row.downloaded = row.total; } });
  await search('Atlas'); await expect(page.locator('.hf-model')).toContainText('Complete');
  await expect(page.locator('#transfer-inventory .inventory-item')).toHaveCount(0);
  await page.locator('#hf-clear').click();
  await expect(page.locator('.hf-model')).toHaveCount(0);
  await expect(page.locator('#transfer-inventory .inventory-item')).toHaveCount(1);
  await search('no such download'); await expect(page.locator('#empty-transfers')).toContainText('No matching downloads');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 600));
  await expect(page.locator('#transfer-search-clear')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#transfer-search-clear').click();
  await expect(page.locator('#omni')).toHaveValue(''); await expect(page.locator('#transfer-search-summary')).toBeHidden();
  await expect(page.locator('#transfers .tor')).toHaveCount(1);
  await search('   '); await expect(page.locator('#empty-transfers')).toBeHidden();
});
