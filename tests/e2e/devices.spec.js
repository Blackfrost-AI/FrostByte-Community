import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';
import { identifyDevice } from '../../src/shared/device-models.js';

let app, page, home, errors;
test.beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-devices-ui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false, confirmBigPull: false, confirmExitSeeding: false }));
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app); errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  const base = (await page.evaluate(() => window.frostbyte.getState())).data;
  const hardware = [identifyDevice({ platform: 'darwin', modelIdentifier: 'Mac16,10', chip: 'Apple M4', cpuCores: 10, gpus: [{ name: 'Apple M4', cores: 10 }], memoryBytes: 16 * 1024 ** 3, osVersion: '26.0' }),
    identifyDevice({ platform: 'darwin', modelIdentifier: 'Mac16,9', chip: 'Apple M4 Max', cpuCores: 16, gpus: [{ name: 'Apple M4 Max', cores: 40 }], memoryBytes: 64 * 1024 ** 3, osVersion: '26.0' }),
    identifyDevice({ platform: 'linux', vendor: 'NVIDIA', modelIdentifier: 'NVIDIA_DGX_Spark', chip: 'NVIDIA GB10 Grace', cpuCores: 20, memoryBytes: 128 * 1024 ** 3, osVersion: 'Linux' })];
  await app.evaluate(({ ipcMain }, { base, hardware }) => {
    const devices = ['mac-studio', 'dgx'].map((id, index) => ({ id, host: id, name: hardware[index + 1].name, connected: true, defaultDir: index ? '/home/tester/Models' : '/Volumes/Models', status: {
      hostname: id, hardware: hardware[index + 1], version: '0.2.0-beta.12', downloadDir: index ? '/home/tester/Models' : '/Volumes/Models',
      storage: [{ path: index ? '/home/tester/Models' : '/Volumes/Models', available: true, freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4 }], inventoryControls: true,
      inventory: [{ id: 'same-inventory', name: 'owner/model', repoId: 'owner/model', source: 'hf', kind: 'model', destination: index ? '/home/tester/Models' : '/Volumes/Models', path: '/models/owner/model', size: 1024, fileCount: 2, available: true, files: [] }],
      downloads: [1, 2].map(shard => ({ id: 'shard-' + shard, repoId: 'owner/model', revision: 'a'.repeat(40), filePath: `model-0000${shard}.safetensors`, destination: index ? '/home/tester/Models' : '/Volumes/Models', total: 1024 ** 3, downloaded: 256 * 1024 ** 2, status: 'active', speedBps: 1024 ** 2 })),
      torrents: [{ infoHash: 'b'.repeat(40), name: 'Shared torrent', ready: true, files: [], peers: [], length: 1024, progress: .25, paused: false, path: '/models', downloadSpeed: 10 }],
    } }));
    const fixture = globalThis.devicesFixture = { state: { ...base, localDevice: hardware[0], selectedDeviceId: 'mac-studio', devices, settings: { ...base.settings, sparkHost: 'mac-studio', sparkDownloadHost: 'mac-studio', sparkDownloadDir: '/Volumes/Models' } }, controls: [], downloads: [] };
    const ok = data => ({ ok: true, data });
    for (const name of ['app:state', 'devices:status', 'devices:select', 'devices:configure', 'devices:forget', 'spark:files', 'spark:control', 'spark:hf-download', 'hf:search', 'hf:model', 'item:sharing', 'spark:device-telemetry', 'spark:device-recipes']) ipcMain.removeHandler(name);
    ipcMain.handle('spark:device-telemetry', (_, id) => {
      (fixture.telemetryRequests ||= []).push(id);
      if (fixture.deferTelemetryId === id) return new Promise(resolve => { fixture.resolveTelemetry = data => resolve(ok(data)); });
      return fixture.telemetryError ? { ok: false, error: fixture.telemetryError } : ok(fixture.telemetryByDevice?.[id] || { schema: 1, collectedAt: new Date().toISOString(), load: [1.2, .8, .5], uptimeSeconds: 3661,
      memory: { totalBytes: 128 * 1024 ** 3, freeBytes: 64 * 1024 ** 3 }, storage: { totalBytes: 4 * 1024 ** 4, freeBytes: 2 * 1024 ** 4 },
      docker: { available: true, containers: [{ name: 'frostbyte-beta', state: 'running' }] } });
    });
    ipcMain.handle('spark:device-recipes', () => ok([{ id: 'old-model', title: 'Missing approved model', kind: 'docker', state: 'missing', available: false }]));
    ipcMain.handle('app:state', () => ok(fixture.state));
    ipcMain.handle('devices:status', () => ok(devices));
    ipcMain.handle('devices:select', (_, id) => { fixture.state.selectedDeviceId = id; fixture.state.settings.sparkHost = id; fixture.state.settings.sparkDownloadHost = id; fixture.state.settings.sparkDownloadDir = devices.find(d => d.id === id).defaultDir; return ok(fixture.state); });
    ipcMain.handle('devices:configure', (_, id, patch) => { Object.assign(devices.find(d => d.id === id), patch); return ok(fixture.state); });
    ipcMain.handle('devices:forget', (_, id) => { fixture.state.devices = fixture.state.devices.filter(d => d.id !== id); return ok(fixture.state); });
    ipcMain.handle('spark:files', () => ok({ entries: [], relative: '' }));
    ipcMain.handle('spark:control', (_, action, id, root, deviceId) => {
      fixture.controls.push({ action, id, root, deviceId }); const device = devices.find(d => d.id === deviceId);
      if (!device?.connected) return { ok: false, error: 'Device offline' };
      if (action === 'hf:pause') device.status.downloads.find(d => d.id === id).status = 'paused';
      if (action === 'torrent:pause') device.status.torrents[0].paused = true;
      return ok(true);
    });
    ipcMain.handle('spark:hf-download', (_, request) => { fixture.downloads.push(request); return ok(['queued']); });
    ipcMain.handle('hf:search', () => ok([{ id: 'owner/new-model', downloads: 1, likes: 0 }]));
    ipcMain.handle('hf:model', () => ok({ id: 'owner/new-model', sha: 'a'.repeat(40), files: [{ path: 'config.json', size: 128 }] }));
    ipcMain.handle('item:sharing', (_, request) => { fixture.controls.push(request); return ok({ state: fixture.state }); });
  }, { base, hardware });
  await page.reload(); await page.locator('#nav [data-tab="spark"]').click();
});
test.afterEach(async () => { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); expect(errors).toEqual([]); });

test('device management unwraps real IPC envelopes, marks missing recipes, and recovers from errors', async () => {
  await page.locator('[data-select-device="mac-studio"]').click();
  const panel = page.locator('#device-details');
  await expect(panel).toContainText('1h 1m');
  await expect(panel).toContainText('64.0 GB used of 128 GB');
  await expect(panel).toContainText('frostbyte-beta');
  await expect(panel.locator('[data-spark-model="old-model"]')).toBeDisabled();
  await expect(panel).not.toContainText('NaN');
  await app.evaluate(() => { globalThis.devicesFixture.telemetryError = 'Host service temporarily unavailable'; });
  await panel.getByRole('button', { name: 'Refresh system status' }).click();
  await expect(panel).toContainText('Host service temporarily unavailable');
  await expect(panel).not.toContainText('NaN');
  await app.evaluate(() => { globalThis.devicesFixture.telemetryError = ''; });
  await panel.getByRole('button', { name: 'Refresh system status' }).click();
  await expect(panel).toContainText('1h 1m');
  await expect(panel).not.toContainText('Host service temporarily unavailable');
});

test('Devices shows real Mac and DGX photos, CPU and GPU facts, and separate storage', async () => {
  await expect(page.locator('#nav [data-tab="spark"]')).toContainText('Devices');
  await expect(page.locator('.device-card')).toHaveCount(3);
  await expect(page.locator('[data-select-device="local"] img')).toHaveAttribute('src', /mac-mini-2024.png$/);
  await expect(page.locator('[data-select-device="mac-studio"] img')).toHaveAttribute('src', /mac-studio.png$/);
  await expect(page.locator('[data-select-device="dgx"] img')).toHaveAttribute('src', /dgx-spark.png$/);
  await expect(page.locator('[data-select-device="local"]')).toContainText('CPUApple M4 · 10 cores');
  await expect(page.locator('[data-select-device="local"]')).toContainText('GPUApple M4 · 10 cores');
  await expect(page.locator('[data-select-device="dgx"]')).toContainText('GPUNVIDIA GB10 Blackwell');
  expect(await page.locator('.device-card-image').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.evaluate(() => CSS.supports('object-view-box', 'inset(10%)'))).toBe(true);
  await page.waitForFunction(() => [...document.querySelectorAll('.device-card-image img')].every(img => img.complete && img.naturalWidth > 0));
  await expect(page.locator('#device-dashboard')).toBeHidden();
  await page.locator('[data-select-device="mac-studio"]').click();
  await expect(page.locator('#device-cards')).toBeHidden();
  await expect(page.locator('#device-dashboard')).toBeVisible();
  await expect(page.locator('#device-details')).toContainText('Mac16,9');
  await expect(page.locator('#device-details')).toContainText('64.0 GB');
  await expect(page.locator('#spark-download-destination')).toHaveValue('/Volumes/Models');
  await expect(page.locator('.dashboard-resources')).toContainText('1.0 TB available of 2.0 TB');
  await expect(page.locator('.dashboard-resources')).not.toContainText('2.0 TB available of 4.0 TB');
  await page.locator('#devices-back').click();
  await page.locator('[data-select-device="dgx"]').click();
  await expect(page.locator('#spark-download-destination')).toHaveValue('/home/tester/Models');
  await expect(page.locator('#device-details')).toContainText('NVIDIA_DGX_Spark');
  await page.locator('#devices-back').click();
  await page.locator('[data-select-device="local"]').click();
  await expect(page.locator('#device-details')).toContainText('Mac mini (2024)');
  await expect(page.locator('#spark-content')).toBeHidden();
  fs.mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/devices-overview.png' });
});

test('device display name and photo changes are saved from Device options', async () => {
  await page.locator('[data-select-device="mac-studio"]').click();
  await page.locator('#device-options').click();
  await page.locator('#device-display-name').fill('Studio seedbox');
  await page.locator('#device-artwork').selectOption('dgx-spark');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#modal')).toBeHidden();
  await expect(page.locator('#device-dashboard-title')).toHaveText('Studio seedbox');
  await page.locator('#devices-back').click();
  await expect(page.locator('[data-select-device="mac-studio"]')).toContainText('Studio seedbox');
  await expect(page.locator('[data-select-device="mac-studio"] img')).toHaveAttribute('src', /dgx-spark.png$/);
  expect(await app.evaluate(() => globalThis.devicesFixture.state.devices[0])).toMatchObject({ name: 'Studio seedbox', artwork: 'dgx-spark' });
});

test('identical remote model and torrent IDs stay separate and controls reach their owner', async () => {
  await page.locator('#nav [data-tab="transfers"]').click();
  const studio = page.locator('.hfdl').filter({ hasText: 'Mac Studio (2025)' }), dgx = page.locator('.hfdl').filter({ hasText: 'NVIDIA DGX Spark' });
  await expect(page.locator('.hfdl')).toHaveCount(2);
  await expect(studio.locator('.hf-model-files > summary')).toContainText('2 files');
  await dgx.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(dgx.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(studio.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.locator('.tor[data-connection="dgx"] [data-pause]').click();
  const controls = await app.evaluate(() => globalThis.devicesFixture.controls);
  expect(controls).toHaveLength(3); expect(controls.every(call => call.deviceId === 'dgx')).toBe(true);
  await page.locator('#nav [data-tab="library"]').click();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await page.locator('#library-device').selectOption('device:mac-studio');
  await expect(page.locator('#library-downloads .inventory-item[data-inventory-connection="dgx"]')).toHaveCount(0);
});

test('HF destination remains bound to the chosen Mac when the selected device changes', async () => {
  await page.locator('#nav [data-tab="hf"]').click();
  await page.locator('#hf-q').fill('new-model'); await page.locator('#hf-go').click();
  await page.locator('#grid-hf tbody tr').click();
  await page.locator('#hf-target').selectOption('mac-studio');
  await page.locator('#hf-configs').click();
  await page.evaluate(() => window.frostbyte.selectDevice('dgx'));
  await page.waitForTimeout(1800);
  await expect(page.locator('#hf-target')).toHaveValue('mac-studio');
  await page.locator('#hf-download').click();
  await expect(page.locator('#view-transfers')).toBeVisible();
  expect(await app.evaluate(() => globalThis.devicesFixture.downloads[0])).toMatchObject({ deviceId: 'mac-studio', destination: '/Volumes/Models', repoId: 'owner/new-model' });
  await app.evaluate(() => { globalThis.devicesFixture.state.devices[0].connected = false; });
  await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('[data-select-device="mac-studio"]').click(); await page.locator('#spark-refresh').click();
  await page.locator('#devices-back').click();
  await expect(page.locator('[data-select-device="mac-studio"]')).toContainText('Offline');
  await expect(page.locator('[data-select-device="mac-studio"] img')).toHaveAttribute('src', /mac-studio.png$/);
});

test('ASUS and Dell GB10 photos stay distinct and Windows shows its actual model and multiple GPUs', async () => {
  const variants = [identifyDevice({ platform: 'linux', vendor: 'ASUSTeK COMPUTER INC.', modelIdentifier: 'ASUS Ascent GX10', cpuCores: 20 }),
    identifyDevice({ platform: 'linux', vendor: 'Dell Inc.', modelIdentifier: 'Pro Max with GB10 FCM1253', cpuCores: 20 })];
  const windows = identifyDevice({ platform: 'win32', vendor: 'MSI', modelIdentifier: 'Creator 16 AI Studio', chip: 'Intel Core Ultra 9 185H', cpuCores: 22, formFactor: 'laptop', gpus: [{ name: 'Intel Arc Graphics' }, { name: 'NVIDIA GeForce RTX 4090 Laptop GPU' }] });
  await app.evaluate(({ BrowserWindow }, { variants, windows }) => {
    const fixture = globalThis.devicesFixture;
    fixture.state.localDevice = windows;
    variants.forEach((hardware, index) => fixture.state.devices.push({ id: 'oem-' + index, host: 'oem-' + index, name: hardware.name, connected: true, status: { hardware } }));
    BrowserWindow.getAllWindows()[0].setSize(1440, 950);
  }, { variants, windows });
  await page.reload(); await page.locator('#nav [data-tab="spark"]').click();
  await expect(page.locator('[data-select-device="oem-0"] img')).toHaveAttribute('src', /asus-gx10.png$/);
  await expect(page.locator('[data-select-device="oem-1"] img')).toHaveAttribute('src', /dell-gb10.png$/);
  await expect(page.locator('[data-select-device="local"] img')).toHaveAttribute('src', /pc-laptop.png$/);
  const local = page.locator('[data-select-device="local"]');
  await expect(local).toContainText('Creator 16 AI Studio');
  await expect(local).toContainText('Intel Core Ultra 9 185H');
  await expect(local).toContainText('Intel Arc Graphics + NVIDIA GeForce RTX 4090 Laptop GPU');
  await page.waitForFunction(() => [...document.querySelectorAll('.device-card-image img')].every(img => img.complete && img.naturalWidth > 0));
  fs.mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/devices-manufacturers.png' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 660));
  expect(await page.locator('#view-spark').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(local).toContainText('NVIDIA GeForce RTX 4090 Laptop GPU');
});

test('dashboard keyboard navigation, scoped shortcuts, live charts and offline state stay coherent', async () => {
  expect(await app.evaluate(() => globalThis.devicesFixture.telemetryRequests || [])).toEqual([]);
  const studioCard = page.locator('[data-select-device="mac-studio"]');
  await studioCard.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#device-dashboard')).toBeVisible();
  await expect(page.locator('#devices-back')).toBeFocused();
  await expect(page.locator('.traffic-chart')).toHaveAttribute('aria-label', /bytes per second/);
  await expect(page.locator('.dashboard-metric').first()).toContainText('2.0 MB/s');
  await page.locator('[data-device-view="transfers"]').click();
  await expect(page.locator('#transfers-device')).toHaveValue('device:mac-studio');
  await expect(page.locator('.hfdl')).toHaveCount(1);
  await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('[data-device-view="library"]').click();
  await expect(page.locator('#library-device')).toHaveValue('device:mac-studio');
  await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('#spark-management-refresh').focus();
  await page.waitForTimeout(1900);
  await expect(page.locator('#spark-management-refresh')).toBeFocused();
  await app.evaluate(() => { globalThis.devicesFixture.state.devices[0].connected = false; });
  await expect(page.locator('.dashboard-status')).toContainText('Offline');
  await expect(page.locator('.dashboard-notice').first()).toContainText('Charts are paused');
  await expect(page.locator('.dashboard-metric').first()).toContainText('—');
  await expect(page.locator('#spark-management-refresh')).toBeDisabled();
  await page.locator('#devices-back').click();
  await expect(studioCard).toBeFocused();
});

test('late telemetry stays with its originating device and dashboard adapts to a narrow window', async () => {
  await app.evaluate(() => { globalThis.devicesFixture.deferTelemetryId = 'mac-studio'; });
  await page.locator('[data-select-device="mac-studio"]').click();
  await expect.poll(() => app.evaluate(() => typeof globalThis.devicesFixture.resolveTelemetry)).toBe('function');
  await page.locator('#devices-back').click();
  await page.locator('[data-select-device="dgx"]').click();
  await expect(page.locator('#device-details')).toContainText('64.0 GB used of 128 GB');
  await app.evaluate(() => { globalThis.devicesFixture.resolveTelemetry({ schema: 1, memory: { totalBytes: 8 * 1024 ** 3, freeBytes: 0 }, docker: { containers: [{ name: 'studio-only', state: 'running' }] } }); });
  await page.waitForTimeout(300);
  await expect(page.locator('#device-details')).not.toContainText('studio-only');
  await expect(page.locator('#device-details')).toContainText('64.0 GB used of 128 GB');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  fs.mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/device-dashboard-spark.png' });
  await page.locator('#view-spark').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.screenshot({ path: 'test-results/screenshots/device-dashboard-spark-lower.png' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 660));
  expect(await page.locator('#view-spark').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.locator('#spark-storage-add')).toBeEnabled();
  await page.locator('#devices-back').click();
  await page.locator('[data-select-device="local"]').click();
  await expect(page.locator('#device-dashboard-title')).toHaveText('Mac mini (2024)');
  await expect(page.locator('#device-details')).not.toContainText('studio-only');
  await expect(page.locator('#dashboard-connection')).toBeHidden();
  await expect(page.locator('#device-local-folder')).toBeEnabled();
});
