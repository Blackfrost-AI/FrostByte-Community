import { exposeCompanionDevice } from './companion-fixture.js';
import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app, page, home, errors;
const fingerprint = 'SHA256:exampleSparkFingerprintThatTheUserChecks';
const device = { hostname: 'new-spark', architecture: 'aarch64', home: '/home/alex' };
const requirements = { dockerInstalled: true, dockerAccess: true, agentInstalled: false, agentCompatible: false };
const review = { stage: 'review', sessionId: 'setup-session', device, downloadDir: '/home/alex/FrostByte', requirements };

async function responses(...values) { await app.evaluate((_, values) => { globalThis.onboarding.probes = values; }, values); }
async function credentials() {
  await page.locator('#spark-setup-host').fill('192.168.1.44');
  await page.locator('#spark-setup-user').fill('alex');
  await page.locator('#spark-setup-password').fill('temporary-test-password');
}
async function checkConnection() { await page.locator('#spark-setup-check').click(); }
async function snapshot(name) { fs.mkdirSync('test-results/screenshots', { recursive: true }); await page.screenshot({ path: `test-results/screenshots/${name}.png` }); }
async function folderFixtures() {
  await app.evaluate(({ ipcMain }) => {
    const data = globalThis.onboarding; data.folderRequests = []; data.fileRequests = []; data.storageRequests = [];
    for (const name of ['spark:folders', 'spark:storage-add', 'spark:files']) ipcMain.removeHandler(name);
    ipcMain.handle('spark:folders', (_, request) => {
      data.folderRequests.push(request);
      if (data.folderError) return { ok: false, error: 'Drive is not available. Connect it to Spark, then try again.' };
      const current = request.path || '/home/alex';
      return { ok: true, data: { path: current, parent: current === '/' ? null : current.slice(0, current.lastIndexOf('/')) || '/', shortcuts: [{ name: 'Home', path: '/home/alex' }, { name: 'External drives', path: '/media/alex' }], folders: current === '/media/alex' ? [{ name: 'Atlas', path: '/media/alex/Atlas' }] : current === '/home/alex' ? [{ name: 'FrostByte', path: '/home/alex/FrostByte' }] : [] } };
    });
    ipcMain.handle('spark:storage-add', (_, request) => {
      data.storageRequests.push(request);
      if (data.storageError) return { ok: false, error: 'Could not access that folder. Check the drive, then try again.' };
      const finish = () => {
        data.status.storageRoots = [data.status.downloadDir, request.downloadDir];
        data.status.storage = data.status.storageRoots.map(path => ({ path, freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4, available: true }));
        globalThis.updateCompanionFixture?.({ ok: true, data: { connected: true, status: data.status } });
        return { ok: true, data: { status: data.status, host: 'frostbyte-new-spark' } };
      };
      if (data.deferStorage) return new Promise(resolve => { data.resolveStorage = () => resolve(finish()); });
      return finish();
    });
    ipcMain.handle('spark:files', (_, relative, root) => { data.fileRequests.push({ relative, root }); return { ok: true, data: { entries: [{ name: 'config.json', relative: 'config.json', directory: false, size: 123 }], relative } }; });
  });
}
async function connectExisting() {
  await page.locator('[data-spark-mode="ssh"]').click();
  await page.locator('#spark-setup-host').fill('my-spark');
  await responses({ ok: true, data: { ...review, stage: 'ready', requirements: { ...requirements, agentInstalled: true, agentCompatible: true } } });
  await checkConnection(); await page.locator('#spark-setup-install').click();
  await expect(page.locator('#spark-content')).toBeVisible();
  // The connection fixture must mirror the real setup handler's saved host.
  await page.evaluate(() => window.frostbyte.setSettings({ sparkHost: 'existing-spark' }));
}
async function torrentDestination(enabled) {
  await page.locator('#nav [data-tab="transfers"]').click();
  await page.locator('#btn-add').click();
  const option = page.locator('#dl-target option[value="spark"]');
  await expect(option).toHaveJSProperty('disabled', !enabled);
  await page.keyboard.press('Escape');
  await page.locator('#nav [data-tab="spark"]').click();
}

test.beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-spark-onboarding-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), sparkHost: '', upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false }));
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app); errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await app.evaluate(({ ipcMain }) => {
    const status = { hostname: 'new-spark', architecture: 'aarch64', version: '0.2.0-beta.2', downloadDir: '/home/alex/FrostByte', freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4, memoryBytes: 128 * 1024 ** 3, torrents: [], downloads: [] };
    globalThis.onboarding = { status, probes: [], requests: [], installations: [], connections: [], cancelled: [], deferInstall: false, failInstall: false };
    for (const name of ['spark:setup-probe', 'spark:setup-install', 'spark:setup-connect', 'spark:setup-cancel', 'spark:status', 'spark:files']) ipcMain.removeHandler(name);
    ipcMain.handle('spark:setup-probe', (_, request) => { const data = globalThis.onboarding; data.requests.push(request); return data.probes.shift() || { ok: false, error: 'No fixture response available' }; });
    ipcMain.handle('spark:setup-install', (_, request) => {
      const data = globalThis.onboarding; data.installations.push(request);
      if (data.failInstall) return { ok: false, error: 'Connection interrupted. Check your network, then try again.' };
      if (data.deferInstall) return new Promise(resolve => { data.resolveInstall = resolve; });
      data.status.downloadDir = request.downloadDir;
      return { ok: true, data: { status: data.status, host: 'frostbyte-new-spark' } };
    });
    ipcMain.handle('spark:setup-connect', (_, request) => { const data = globalThis.onboarding; data.connections.push(request); return { ok: true, data: { status: data.status, host: 'existing-spark' } }; });
    ipcMain.handle('spark:setup-cancel', (_, id) => { globalThis.onboarding.cancelled.push(id); return { ok: true, data: true }; });
    ipcMain.handle('spark:status', () => ({ ok: true, data: { connected: true, status: globalThis.onboarding.status } }));
    ipcMain.handle('spark:files', () => ({ ok: true, data: { entries: [], relative: '' } }));
  });
  await exposeCompanionDevice(app);
  await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('#device-add').click();
});
test.afterEach(async () => { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); expect(errors).toEqual([]); });

test('a new user can inspect and cancel host trust without saving a password or enabling Spark downloads', async () => {
  await page.setViewportSize({ width: 980, height: 600 });
  await expect(page.locator('#spark-setup')).toContainText('Each device keeps its own download folder');
  await expect(page.locator('#spark-saved-connection')).toBeHidden();
  await expect(page.locator('#spark-setup-host')).toHaveValue('');
  expect(await page.locator('#spark-setup').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  fs.mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/spark-onboarding-connect.png' });
  await torrentDestination(false);
  await responses({ ok: true, data: { stage: 'trust', sessionId: 'trust-session', fingerprint, hostKeyType: 'ssh-ed25519' } });
  await credentials(); await checkConnection();
  await expect(page.locator('#spark-fingerprint')).toHaveText(fingerprint);
  expect(await app.evaluate(() => globalThis.onboarding.requests)).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('temporary-test-password');
  await page.locator('[data-spark-setup="cancel"]').click();
  if (!await page.locator('#spark-setup-password').isVisible()) await page.locator('#device-add').click();
  await expect(page.locator('#spark-setup-password')).toHaveValue('');
  await expect.poll(() => app.evaluate(() => globalThis.onboarding.cancelled)).toEqual(['trust-session']);
  expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).not.toContain('temporary-test-password');
  await torrentDestination(false);
});

test('trusted password setup reviews the folder, reports progress, and enables destinations only after installation succeeds', async () => {
  await responses({ ok: true, data: { stage: 'trust', fingerprint, hostKeyType: 'ssh-ed25519' } }, { ok: true, data: { ...review, frigidLibrary: '/home/alex/Models' } });
  await credentials(); await checkConnection();
  await page.locator('#spark-trust').click();
  await expect(page.locator('#spark-setup-folder')).toHaveValue('/home/alex/FrostByte');
  await expect(page.locator('#spark-use-frigid')).not.toBeChecked();
  expect(await app.evaluate(() => globalThis.onboarding.requests[1].trustFingerprint)).toBe(fingerprint);
  await page.locator('#spark-use-frigid').check();
  await expect(page.locator('#spark-setup-folder')).toHaveValue('/home/alex/Models');
  await page.locator('#spark-setup-folder').fill('/home/alex/Downloads/Models');
  fs.mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/spark-onboarding-review.png' });
  await app.evaluate(() => { globalThis.onboarding.deferInstall = true; });
  await page.locator('#spark-setup-install').click();
  await expect.poll(() => app.evaluate(() => globalThis.onboarding.installations.length)).toBe(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('spark:setup-progress', { sessionId: 'setup-session', stage: 'download', message: 'Downloading companion image…', percent: 45 }));
  await expect(page.locator('#spark-setup-progress')).toHaveText('Downloading companion image…');
  await expect(page.locator('#spark-setup-progress-bar')).toHaveAttribute('value', '45');
  await torrentDestination(false);
  await app.evaluate(() => { const data = globalThis.onboarding; data.status.downloadDir = data.installations[0].downloadDir; data.resolveInstall({ ok: true, data: { status: data.status, host: 'frostbyte-new-spark' } }); });
  await expect(page.locator('#spark-message')).toContainText('Connected to new-spark');
  await expect(page.locator('#spark-content')).toBeVisible();
  await expect(page.locator('#spark-path')).toHaveText('/home/alex/Downloads/Models');
  await expect(page.locator('#spark-setup')).toBeHidden();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('temporary-test-password');
  await torrentDestination(true);
});

test('an existing companion connects through an SSH alias without reinstalling or requesting a password', async () => {
  await page.locator('[data-spark-mode="ssh"]').click();
  await expect(page.locator('#spark-setup-password')).toHaveCount(0);
  await page.locator('#spark-setup-host').fill('my-spark');
  await responses({ ok: true, data: { ...review, stage: 'ready', requirements: { ...requirements, agentInstalled: true, agentCompatible: true } } });
  await checkConnection();
  await expect(page.locator('#spark-setup')).toContainText('A compatible FrostByte companion is already installed');
  await expect(page.locator('#spark-setup-install')).toHaveText('Connect to device');
  await page.locator('#spark-setup-install').click();
  await expect(page.locator('#spark-content')).toBeVisible();
  expect(await app.evaluate(() => globalThis.onboarding.installations)).toEqual([]);
  expect(await app.evaluate(() => globalThis.onboarding.connections)).toEqual([{ sessionId: 'setup-session' }]);
  expect(await app.evaluate(() => globalThis.onboarding.requests[0])).toMatchObject({ mode: 'ssh', host: 'my-spark' });
  await torrentDestination(true);
});

test('first pairing opens its dashboard when a device event arrives before the selected-state refresh', async () => {
  await app.evaluate(({ ipcMain }) => {
    const state = ipcMain._invokeHandlers.get('app:state');
    const connect = ipcMain._invokeHandlers.get('spark:setup-connect');
    const data = globalThis.onboarding;
    const deviceId = 'newly-paired-device';
    const adapt = result => result.ok && result.data.devices.length ? { ...result, data: { ...result.data,
      selectedDeviceId: deviceId, devices: result.data.devices.map(device => ({ ...device, id: deviceId })) } } : result;
    ipcMain.removeHandler('spark:setup-connect');
    ipcMain.handle('spark:setup-connect', async (event, request) => {
      const result = await connect(event, request);
      data.holdSelectedState = true;
      return { ...result, data: { ...result.data, deviceId } };
    });
    ipcMain.removeHandler('app:state');
    ipcMain.handle('app:state', async event => {
      const result = adapt(await state(event));
      if (data.holdSelectedState && result.data.devices.length) {
        data.holdSelectedState = false;
        event.sender.send('devices:changed', result.data.devices);
        return new Promise(resolve => { data.releaseSelectedState = () => resolve(result); });
      }
      return result;
    });
  });
  await page.locator('[data-spark-mode="ssh"]').click();
  await page.locator('#spark-setup-host').fill('my-spark');
  await responses({ ok: true, data: { ...review, stage: 'ready', requirements: { ...requirements, agentInstalled: true, agentCompatible: true } } });
  await checkConnection();
  await page.locator('#spark-setup-install').click();
  // This DOM update proves the device notification was rendered while the
  // selected-state request remains pending, without an arbitrary timing sleep.
  await expect(page.locator('[data-select-device="newly-paired-device"]')).toHaveCount(1);
  await app.evaluate(() => globalThis.onboarding.releaseSelectedState());
  await expect(page.locator('#device-dashboard')).toBeVisible();
  await expect(page.locator('#spark-content')).toBeVisible();
  await expect(page.locator('#spark-setup')).toBeHidden();
});

test('authentication, Docker requirements, and interrupted installation each offer a usable retry', async () => {
  await responses({ ok: false, error: 'Authentication failed. Check your Spark username and password.' });
  await credentials(); await checkConnection();
  await expect(page.locator('#spark-setup-error')).toContainText('Authentication failed');
  if (!await page.locator('#spark-setup-password').isVisible()) await page.locator('#device-add').click();
  await expect(page.locator('#spark-setup-password')).toHaveValue('');
  await responses({ ok: true, data: { ...review, stage: 'requirements', requirements: { ...requirements, dockerAccess: false }, message: 'Your account cannot use Docker yet.' } });
  await credentials(); await checkConnection();
  await expect(page.locator('#spark-setup')).toContainText('Your account needs permission to use Docker');
  await expect(page.locator('#spark-setup-install')).toHaveCount(0);
  await page.locator('[data-spark-setup="retry"]').click();
  await responses({ ok: true, data: review }); await credentials(); await checkConnection();
  await app.evaluate(() => { globalThis.onboarding.failInstall = true; });
  await page.locator('#spark-setup-install').click();
  await expect(page.locator('#spark-setup-error')).toContainText('Connection interrupted');
  await expect(page.locator('#spark-setup-install')).toBeEnabled();
  await app.evaluate(() => { globalThis.onboarding.failInstall = false; });
  await page.locator('#spark-setup-install').click();
  await expect(page.locator('#spark-message')).toContainText('Connected to new-spark');
});

test('cancelled installation ignores a late response and keeps remote destinations disabled', async () => {
  await responses({ ok: true, data: review }); await credentials(); await checkConnection();
  await app.evaluate(() => { globalThis.onboarding.deferInstall = true; });
  await page.locator('#spark-setup-install').click();
  await expect.poll(() => app.evaluate(() => globalThis.onboarding.installations.length)).toBe(1);
  await page.locator('[data-spark-setup="cancel"]').click();
  if (!await page.locator('#spark-setup-password').isVisible()) await page.locator('#device-add').click();
  await expect(page.locator('#spark-setup-password')).toHaveValue('');
  await app.evaluate(() => { const data = globalThis.onboarding; data.resolveInstall({ ok: true, data: { status: data.status, host: 'cancelled-spark' } }); });
  await expect(page.locator('#spark-content')).toBeHidden();
  expect(await app.evaluate(() => globalThis.onboarding.cancelled)).toEqual(['setup-session']);
  await torrentDestination(false);
});

test('setup browses a mounted external drive and installs into the folder the user chooses', async () => {
  await folderFixtures(); await responses({ ok: true, data: review }); await credentials(); await checkConnection();
  await page.locator('[data-spark-setup="browse"]').click();
  await page.locator('#spark-setup-browser [data-folder-path="/media/alex"]').click();
  await page.locator('#spark-setup-browser [data-folder-path="/media/alex/Atlas"]').click();
  await page.locator('#spark-setup-browser [data-folder-choose]').click();
  await expect(page.locator('#spark-setup-folder')).toHaveValue('/media/alex/Atlas');
  expect(await app.evaluate(() => globalThis.onboarding.folderRequests[0])).toEqual({ sessionId: 'setup-session' });
  await page.locator('#spark-setup-folder').fill('/media/alex/Atlas/Models');
  await page.locator('#spark-setup-install').click();
  await expect(page.locator('#spark-path')).toHaveText('/media/alex/Atlas/Models');
  expect(await app.evaluate(() => globalThis.onboarding.installations[0].downloadDir)).toBe('/media/alex/Atlas/Models');
});

test('adding external storage reviews the restart, recovers from errors, and browses each registered root', async () => {
  await folderFixtures(); await connectExisting();
  await page.locator('#spark-storage-add').click();
  await expect(page.locator('#modal')).toContainText('Existing jobs and files are kept');
  await app.evaluate(() => { globalThis.onboarding.folderError = true; });
  await page.locator('#spark-storage-browse').click();
  await expect(page.locator('#spark-storage-browser')).toContainText('Drive is not available');
  await app.evaluate(() => { globalThis.onboarding.folderError = false; });
  await page.locator('[data-folder-retry]').click();
  await page.locator('#spark-storage-browser [data-folder-path="/media/alex"]').click();
  await snapshot('spark-storage-folder-browser');
  await page.locator('#spark-storage-browser [data-folder-path="/media/alex/Atlas"]').click();
  await page.locator('#spark-storage-browser [data-folder-choose]').click();
  await page.locator('#spark-storage-folder').fill('/media/alex/Atlas/Models');
  await app.evaluate(() => { globalThis.onboarding.storageError = true; });
  await page.locator('#modal-acts button.primary').click();
  await expect(page.locator('#spark-storage-error')).toContainText('Could not access that folder');
  await app.evaluate(() => { globalThis.onboarding.storageError = false; globalThis.onboarding.deferStorage = true; });
  await page.locator('#modal-acts button.primary').click();
  await expect.poll(() => app.evaluate(() => globalThis.onboarding.storageRequests.length)).toBe(2);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('spark:setup-progress', { sessionId: 'storage', stage: 'restart', message: 'Restarting the companion with the new folder…' }));
  await expect(page.locator('#spark-storage-progress')).toContainText('Restarting the companion');
  await app.evaluate(() => globalThis.onboarding.resolveStorage());
  await expect(page.locator('#modal')).toBeHidden();
  await expect(page.locator('#spark-download-destination')).toHaveValue('/media/alex/Atlas/Models');
  await expect(page.locator('#spark-storage-summary')).toContainText('free in the selected destination');
  await expect(page.locator('#spark-library-root')).toHaveValue('/media/alex/Atlas/Models');
  await snapshot('spark-storage-destinations');
  expect(await app.evaluate(() => globalThis.onboarding.status.downloadDir)).toBe('/home/alex/FrostByte');
  expect(await app.evaluate(() => globalThis.onboarding.fileRequests.at(-1))).toEqual({ relative: '', root: '/media/alex/Atlas/Models' });
  await page.locator('#spark-files-section > summary').click();
  await page.locator('#spark-library-root').selectOption('/home/alex/FrostByte');
  await expect.poll(() => app.evaluate(() => globalThis.onboarding.fileRequests.at(-1).root)).toBe('/home/alex/FrostByte');
});

test('managed direct-profile Add storage resolves its saved address in main and never invokes the generic installer', async () => {
  await folderFixtures(); await connectExisting();
  await app.evaluate(() => globalThis.setCompanionManaged(true, 'alex@192.168.1.44'));
  await page.reload(); await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('[data-select-device="spark"]').click();
  const downloadDir = '/media/alex/Atlas/Managed Models';
  await page.locator('#spark-storage-add').click();
  await page.locator('#spark-storage-folder').fill(downloadDir);
  await page.locator('#modal-acts button.primary').click();
  await expect(page.locator('#spark-setup-password')).toBeVisible();
  await expect(page.locator('#spark-setup-host')).toHaveCount(0);
  await expect(page.locator('#spark-setup-user')).toHaveCount(0);
  await expect(page.locator('[data-spark-mode="ssh"]')).toHaveCount(0);
  await expect(page.locator('#spark-setup')).toContainText('alex@192.168.1.44');
  await expect(page.locator('#modal')).toBeHidden();
  await responses({ ok: true, data: { ...review, stage: 'ready', status: { hostname: 'new-spark', architecture: 'aarch64', version: '0.2.0-beta.2', downloadDir: '/home/alex/FrostByte' }, requirements: { ...requirements, agentInstalled: true, agentCompatible: true } } });
  await page.locator('#spark-setup-password').fill('temporary-test-password'); await checkConnection();
  await expect(page.locator('#spark-setup')).toContainText('Add storage on this device');
  await expect(page.locator('#spark-setup')).toContainText(downloadDir);
  await expect(page.locator('#spark-setup-install')).toHaveCount(0);
  expect(await app.evaluate(() => globalThis.onboarding.installations)).toEqual([]);
  expect(await app.evaluate(() => globalThis.onboarding.requests.at(-1))).toEqual({ mode: 'password', purpose: 'add-storage', deviceId: 'spark', password: 'temporary-test-password' });
  const connectionCount = await app.evaluate(() => globalThis.onboarding.connections.length);
  await app.evaluate(() => { globalThis.onboarding.storageError = true; });
  await page.locator('#spark-setup-storage').click();
  await expect(page.locator('#spark-setup-password')).toBeVisible();
  await expect(page.locator('#spark-setup-error')).toContainText('Could not access that folder');
  await expect.poll(() => app.evaluate(() => globalThis.onboarding.cancelled)).toContain('setup-session');
  await responses({ ok: true, data: { ...review, stage: 'ready', status: { hostname: 'new-spark', architecture: 'aarch64', version: '0.2.0-beta.2', downloadDir: '/home/alex/FrostByte' }, requirements: { ...requirements, agentInstalled: true, agentCompatible: true } } });
  await page.locator('#spark-setup-password').fill('temporary-test-password'); await checkConnection();
  await expect(page.locator('#spark-setup')).toContainText(downloadDir);
  await app.evaluate(() => { globalThis.onboarding.storageError = false; });
  await page.locator('#spark-setup-storage').click();
  await expect(page.locator('#spark-content')).toBeVisible();
  await expect(page.locator('#spark-download-destination')).toHaveValue(downloadDir);
  expect(await app.evaluate(() => globalThis.onboarding.storageRequests)).toEqual([
    { sessionId: 'setup-session', deviceId: 'spark', downloadDir },
    { sessionId: 'setup-session', deviceId: 'spark', downloadDir },
  ]);
  expect(await app.evaluate(() => globalThis.onboarding.installations)).toEqual([]);
  expect(await app.evaluate(() => globalThis.onboarding.connections.length)).toBe(connectionCount);
});

test('managed direct-profile update uses its main-side saved address and a purpose-bound password session', async () => {
  await connectExisting();
  await app.evaluate(() => globalThis.setCompanionManaged(true, 'alex@192.168.1.44'));
  await page.reload(); await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('[data-select-device="spark"]').click();
  await page.locator('#device-options').click();
  await page.locator('#device-update').click();
  await expect(page.locator('#spark-setup-password')).toBeVisible();
  await expect(page.locator('#spark-setup-host')).toHaveCount(0);
  await expect(page.locator('#spark-setup-user')).toHaveCount(0);
  await responses({ ok: true, data: { ...review, stage: 'ready', status: { ...review.status, hostname: 'new-spark', architecture: 'aarch64', version: '0.2.0-beta.2', downloadDir: '/home/alex/FrostByte' }, requirements: { ...requirements, agentInstalled: true, agentCompatible: true } } });
  await page.locator('#spark-setup-password').fill('temporary-update-password'); await checkConnection();
  await expect(page.locator('#spark-setup-install')).toHaveText('Update companion and connect');
  await expect(page.locator('#spark-setup-folder')).toHaveValue('/home/alex/FrostByte');
  expect(await app.evaluate(() => globalThis.onboarding.requests.at(-1))).toEqual({ mode: 'password', purpose: 'update-device', deviceId: 'spark', password: 'temporary-update-password' });
  await page.locator('#spark-setup-install').click();
  await expect(page.locator('#spark-content')).toBeVisible();
  expect(await app.evaluate(() => globalThis.onboarding.installations)).toEqual([{ sessionId: 'setup-session', downloadDir: '/home/alex/FrostByte' }]);
});

test('HF and torrent downloads choose internal or external storage per request and unavailable drives are disabled', async () => {
  await folderFixtures();
  await app.evaluate(({ ipcMain }) => {
    const data = globalThis.onboarding;
    data.status.storageRoots = ['/home/alex/FrostByte', '/media/alex/Atlas/Models', '/media/alex/Offline/Models'];
    data.status.storage = data.status.storageRoots.map((path, index) => ({ path, freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4, available: index !== 2 }));
    for (const name of ['torrent:add', 'torrent:inspect', 'hf:search', 'hf:model', 'spark:hf-download', 'spark:control']) ipcMain.removeHandler(name);
    ipcMain.handle('torrent:inspect', () => ({ ok: true, data: { preview: { name: 'Config update', files: [{ path: 'update.zip', length: 123 }] } } }));
    data.torrentRequests = []; data.hfRequests = [];
    ipcMain.handle('torrent:add', (_, source, options) => { data.torrent = { source, options }; data.torrentRequests.push(data.torrent); return { ok: true, data: { remote: true, state: { torrents: [], downloads: [] } } }; });
    ipcMain.handle('hf:search', () => ({ ok: true, data: [{ id: 'owner/model', downloads: 2, likes: 1 }] }));
    ipcMain.handle('hf:model', () => ({ ok: true, data: { id: 'owner/model', sha: 'a'.repeat(40), files: [{ path: 'config.json', size: 123 }] } }));
    ipcMain.handle('spark:hf-download', (_, request) => { data.hf = request; data.hfRequests.push(request); return { ok: true, data: ['queued'] }; });
    ipcMain.handle('spark:control', (_, action, id, root) => { data.control = { action, id, root }; return { ok: true, data: { magnetURI: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) } }; });
  });
  await connectExisting();
  await expect(page.locator('#spark-inventory')).toHaveCount(0);
  await expect(page.locator('#spark-download-destination')).toHaveValue('/home/alex/FrostByte');
  await page.locator('#spark-download-destination').selectOption('/media/alex/Atlas/Models');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'))).sparkDownloadDir).toBe('/media/alex/Atlas/Models');
  await page.reload(); await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('[data-select-device="spark"]').click();
  await expect(page.locator('#spark-download-destination')).toHaveValue('/media/alex/Atlas/Models');
  expect(await page.locator('#spark-download-destination').evaluate(select => select.selectedOptions.length)).toBe(1);
  await expect(page.locator('#spark-files-section')).not.toHaveAttribute('open', '');
  await page.locator('#spark-files-section > summary').click();
  await page.locator('#spark-library-root').selectOption('/home/alex/FrostByte');
  await expect(page.locator('#spark-download-destination')).toHaveValue('/media/alex/Atlas/Models');
  expect(await app.evaluate(() => globalThis.onboarding.torrentRequests.length + globalThis.onboarding.hfRequests.length)).toBe(0);
  await page.locator('#spark-library-root').selectOption('/media/alex/Atlas/Models');
  await app.evaluate(({ clipboard, dialog }) => {
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      if (options?.message === 'Copy to clipboard?') {
        globalThis.onboarding.clipboardReview = structuredClone(options);
        return { response: 1 };
      }
      return previous.call(dialog, window, options);
    };
    clipboard.writeText = () => { throw new Error('Clipboard access unavailable'); };
  });
  await page.locator('[data-spark-share="config.json"]').click(); await page.locator('#modal-acts button.primary').click();
  await expect.poll(() => app.evaluate(() => globalThis.onboarding.control?.root)).toBe('/media/alex/Atlas/Models');
  await expect(page.locator('#spark-share-link')).toHaveValue('magnet:?xt=urn:btih:' + 'a'.repeat(40)); await page.locator('#modal-acts button.primary').click();
  expect(await app.evaluate(() => globalThis.onboarding.clipboardReview.detail)).toBe(JSON.stringify('magnet:?xt=urn:btih:' + 'a'.repeat(40)));
  await page.locator('#nav [data-tab="transfers"]').click(); await page.locator('#btn-add').click();
  await page.locator('#dl-magnet').fill('magnet:?xt=urn:btih:' + 'a'.repeat(40));
  await page.locator('#dl-target').selectOption('spark');
  await expect(page.locator('#dl-spark-destination')).toHaveValue('/media/alex/Atlas/Models');
  await expect(page.locator('#dl-spark-destination option[value="/media/alex/Offline/Models"]')).toHaveJSProperty('disabled', true);
  await page.locator('#dl-spark-destination').selectOption('/media/alex/Atlas/Models');
  await page.locator('#modal-acts button.primary').click();
  await expect(page.locator('#view-transfers')).toBeVisible();
  expect(await app.evaluate(() => globalThis.onboarding.torrent.options.destination)).toBe('/media/alex/Atlas/Models');
  expect(await app.evaluate(() => globalThis.onboarding.torrentRequests.length)).toBe(1);
  await page.locator('#nav [data-tab="hf"]').click(); await page.locator('#hf-q').fill('model'); await page.locator('#hf-go').click();
  await page.locator('#grid-hf tbody tr').click(); await page.locator('#hf-target').selectOption('spark'); await page.locator('#hf-configs').click();
  await expect(page.locator('#hf-spark-destination option[value="/media/alex/Offline/Models"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#hf-spark-destination')).toHaveValue('/media/alex/Atlas/Models');
  await snapshot('spark-hf-destination-picker');
  await page.locator('#hf-spark-destination').selectOption('/home/alex/FrostByte'); await page.locator('#hf-download').click();
  await expect(page.locator('#view-transfers')).toBeVisible();
  expect(await app.evaluate(() => globalThis.onboarding.hf.destination)).toBe('/home/alex/FrostByte');
  await page.locator('#nav [data-tab="hf"]').click(); await page.locator('#hf-spark-destination').selectOption('/media/alex/Atlas/Models'); await page.locator('#hf-download').click();
  await expect.poll(() => app.evaluate(() => globalThis.onboarding.hf.destination)).toBe('/media/alex/Atlas/Models');
  expect(await app.evaluate(() => globalThis.onboarding.hfRequests.map(request => request.destination))).toEqual(['/home/alex/FrostByte', '/media/alex/Atlas/Models']);
  await app.evaluate(() => { globalThis.onboarding.status.storage[1].available = false; });
  await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('#spark-refresh').click();
  await expect(page.locator('#spark-download-destination')).toHaveValue('/media/alex/Atlas/Models');
  await expect(page.locator('#spark-storage-summary')).toContainText('Selected folder unavailable');
  await page.locator('#nav [data-tab="hf"]').click();
  await expect(page.locator('#hf-spark-destination')).toHaveValue('/media/alex/Atlas/Models');
  await expect(page.locator('#hf-download')).toBeDisabled();
  expect(await app.evaluate(() => globalThis.onboarding.hfRequests.length)).toBe(2);
});

test('an existing companion can be updated from setup while keeping its chosen storage folder', async () => {
  await page.locator('[data-spark-mode="ssh"]').click();
  await page.locator('#spark-setup-host').fill('my-spark');
  const downloadDir = '/media/alex/Atlas/Models';
  await responses({ ok: true, data: { ...review, downloadDir, stage: 'ready', status: { downloadDir }, requirements: { ...requirements, agentInstalled: true, agentCompatible: true } } });
  await checkConnection();
  await page.locator('[data-spark-setup="review-update"]').click();
  await expect(page.locator('#spark-setup')).toContainText('Update the FrostByte companion');
  await expect(page.locator('#spark-setup-folder')).toHaveValue(downloadDir);
  await expect(page.locator('#spark-setup-install')).toHaveText('Update companion and connect');
  expect(await app.evaluate(() => globalThis.onboarding.installations)).toEqual([]);
  await page.locator('#spark-setup-install').click();
  await expect(page.locator('#spark-content')).toBeVisible();
  expect(await app.evaluate(() => globalThis.onboarding.installations)).toEqual([{ sessionId: 'setup-session', downloadDir }]);
});
