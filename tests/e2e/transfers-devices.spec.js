import { exposeCompanionDevice } from './companion-fixture.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acceptBetaTerms } from './consent-helper.js';

let app, page, home, errors;
const root = '/media/test/Models';
const hfRow = { id: 'same-hf-id', repoId: 'owner/model', revision: 'a'.repeat(40), filePath: 'model.safetensors', destination: root, status: 'active', downloaded: 256 * 1024 ** 2, total: 1024 ** 3, speedBps: 8 * 1024 ** 2, etaMs: 96000 };
const torrent = { infoHash: 'b'.repeat(40), name: 'Model torrent', length: 1024, downloaded: 256, progress: .25, downloadSpeed: 64, uploadSpeed: 0, ready: true, done: false, paused: false, numPeers: 1, files: [], peers: [], path: root, dataPath: `${root}/Model torrent`, completionGeneration: 1, destination: root };

test.beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-transfers-devices-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false, confirmBigPull: false }));
  errors = [];
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  const base = (await page.evaluate(() => window.frostbyte.getState())).data;
  await app.evaluate(({ ipcMain }, { base, root, hfRow, torrent }) => {
    const status = { hostname: 'fixture-spark', version: '0.2.0-beta.6', architecture: 'arm64', downloadDir: root, storageRoots: [root], memoryBytes: 128 * 1024 ** 3, capabilities: { torrentFileDeletion: true, runtime: 'docker' }, inventory: [], downloads: [{ ...hfRow }], torrents: [{ ...torrent }, { ...torrent, infoHash: 'c'.repeat(40), hfSource: true }] };
    const fixture = globalThis.transfersFixture = { online: true, status, requests: [], controls: [], failAction: '', local: { ...base, hfToken: { present: true, needsReconnect: false, user: 'fixture', role: 'read' }, settings: { ...base.settings, sparkHost: 'fixture-spark' }, downloads: [{ ...hfRow, dest: '/local/Models/owner/model/model.safetensors' }], torrents: [{ ...torrent, path: '/local/Models' }] } };
    for (const name of ['app:state', 'spark:status', 'spark:files', 'spark:control', 'hf:pause', 'hf:resume', 'hf:resume-group', 'hf:clear', 'torrent:pause', 'torrent:resume', 'hf:search', 'hf:model', 'spark:hf-download']) ipcMain.removeHandler(name);
    ipcMain.handle('app:state', () => ({ ok: true, data: fixture.local }));
    ipcMain.handle('spark:status', () => { fixture.requests.push(Date.now()); return { ok: true, data: fixture.online ? { connected: true, status } : { connected: false, error: 'Spark unreachable', status: { hostname: status.hostname, downloadDir: root, inventory: [] } } }; });
    ipcMain.handle('spark:files', () => ({ ok: true, data: { entries: [], relative: '' } }));
    const control = (device, action, id, options) => {
      fixture.controls.push({ device, action, id, ...(options ? { options } : {}) });
      if (fixture.failAction === action) return { ok: false, error: 'Storage temporarily unavailable' };
      const data = device === 'spark' ? status : fixture.local;
      const [kind, verb] = action.split(':');
      if (kind === 'hf') {
        if (verb === 'clear') data.downloads = data.downloads.filter(row => !['done', 'error'].includes(row.status) || (id && !id.includes(row.id)));
        else if (verb === 'remove') data.downloads = data.downloads.filter(row => row.id !== id);
        else { const row = data.downloads.find(row => row.id === id); row.status = verb === 'pause' ? 'paused' : 'active'; }
      } else if (verb === 'remove') data.torrents = data.torrents.filter(row => row.infoHash !== id);
      else data.torrents.find(row => row.infoHash === id).paused = verb === 'pause';
      return { ok: true, data: true };
    };
    ipcMain.handle('spark:control', (_, action, id, _root, _deviceId, options) => control('spark', action, id, options));
    ipcMain.handle('hf:resume-group', (_, { ids, device }) => {
      for (const id of ids) {
        const result = control(device, 'hf:resume', id);
        if (!result.ok) return result;
      }
      return { ok: true, data: { cancelled: false, resumed: ids } };
    });
    for (const kind of ['hf', 'torrent']) for (const action of ['pause', 'resume']) ipcMain.handle(`${kind}:${action}`, (_, value) => control('local', `${kind}:${action}`, kind === 'hf' ? value.id : value));
    ipcMain.handle('hf:clear', (_, ids) => control('local', 'hf:clear', ids));
    ipcMain.handle('hf:search', () => ({ ok: true, data: [{ id: 'owner/new-model', downloads: 1, likes: 0 }] }));
    ipcMain.handle('hf:model', () => ({ ok: true, data: { id: 'owner/new-model', sha: 'a'.repeat(40), files: [{ path: 'config.json', size: 128 }] } }));
    ipcMain.handle('spark:hf-download', (_, request) => {
      fixture.hfRequest = request;
      status.downloads.push({ ...hfRow, id: 'new-config', repoId: request.repoId, filePath: 'config.json', status: 'queued', downloaded: 0, total: 128 });
      return { ok: true, data: ['new-config'] };
    });
  }, { base, root, hfRow, torrent });
  await exposeCompanionDevice(app);
  await page.reload();
  await page.locator('#nav [data-tab="transfers"]').click();
  await expect(page.locator('#transfers .hfdl[data-device="spark"]')).toHaveCount(1);
});

test.afterEach(async () => { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); expect(errors).toEqual([]); });
const hf = device => page.locator(`#transfers .hfdl[data-device="${device}"][data-repo="owner/model"]`);

test('Transfers combines devices, updates Spark progress in place, and directs controls to the correct device', async () => {
  await expect(page.locator('#ct-transfers')).toHaveText('4'); // Internal HF peer source is excluded.
  await expect(page.locator('#transfers .tor')).toHaveCount(2);
  await expect(hf('spark')).toContainText('DGX Spark');
  await expect(hf('spark')).toContainText('256 MB of 1.0 GB');
  await expect(hf('spark')).toContainText('8.0 MB/s');
  await expect(hf('spark')).toContainText('ETA 1m 36s');
  await expect(hf('spark')).toContainText(root);
  await expect(page.locator('#empty-transfers')).toBeHidden();
  await app.evaluate(() => { globalThis.transfersFixture.status.downloads[0].downloaded = 512 * 1024 ** 2; });
  await expect(hf('spark').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await hf('spark').getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(hf('spark').getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(hf('local').getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await hf('spark').getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(hf('spark').getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.locator('#transfers-device').selectOption('spark');
  await expect(hf('local')).toHaveCount(0);
  await page.locator('#btn-pauseall').click();
  await expect(hf('spark').getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  const controls = await app.evaluate(() => globalThis.transfersFixture.controls);
  expect(controls.every(row => row.device === 'spark')).toBe(true);
  expect(controls).toContainEqual({ device: 'spark', action: 'torrent:pause', id: torrent.infoHash });
  await page.locator('#transfers-device').selectOption('local');
  await page.locator('#btn-pauseall').click();
  await expect(hf('local').getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await page.locator('#btn-resumeall').click();
  await expect(hf('local').getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.locator('#transfers-device').selectOption('all');
  await page.setViewportSize({ width: 980, height: 600 });
  expect(await page.locator('#view-transfers').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/screenshots/transfers-devices.png' });
});

test('torrent Options exposes both lifecycle choices on an updated device', async () => {
  const card = page.locator(`#transfers .tor[data-device="spark"][data-hash="${torrent.infoHash}"]`);
  const options = card.locator('.transfer-options');
  await options.locator('summary[aria-label="Options for Model torrent"]').click();
  await expect(card.getByRole('button', { name: 'Remove transfer', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Delete transfer + files…', exact: true })).toBeEnabled();
  await page.waitForTimeout(1800);
  await expect(options).toHaveAttribute('open', '');
});

test('offline Spark keeps last known rows, disables remote actions, and recovers without visiting the Spark page', async () => {
  await app.evaluate(() => { globalThis.transfersFixture.online = false; });
  await expect(page.locator('#transfers-spark-notice')).toBeVisible();
  await expect(hf('spark')).toContainText('Device offline · last known progress');
  await expect(hf('spark').getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  await expect(hf('spark').locator('.tor-rate')).toHaveText('—');
  await expect(hf('local').getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await expect(page.locator('#ct-transfers')).toHaveText('4');
  await app.evaluate(() => { globalThis.transfersFixture.online = true; globalThis.transfersFixture.failAction = 'hf:pause'; });
  await expect(hf('spark').getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await hf('spark').getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#toasts')).toContainText('Storage temporarily unavailable');
  await expect(hf('spark').getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await app.evaluate(() => { globalThis.transfersFixture.failAction = ''; globalThis.transfersFixture.status.downloads[0].status = 'done'; });
  await expect(hf('spark')).toHaveClass(/done/);
  await page.locator('#spark-hf-clear').click();
  await expect(hf('spark')).toHaveCount(0);
  await expect(hf('local')).toHaveCount(1);
});

test('one model groups its shards and config, preserves expanded details, and pauses only unfinished files', async () => {
  await app.evaluate(() => {
    const fixture = globalThis.transfersFixture, first = fixture.status.downloads[0];
    fixture.status.downloads.push({ ...first, id: 'second-shard', filePath: 'model-00002.safetensors', status: 'queued', downloaded: 0 });
    fixture.status.downloads.push({ ...first, id: 'completed-file', filePath: 'tokenizer.json', status: 'done', downloaded: first.total });
  });
  const model = hf('spark');
  const files = model.locator('.hf-model-files');
  await expect(files.locator('summary')).toContainText('3 files');
  await expect(page.locator('#ct-transfers')).toHaveText('4');
  await expect(model).toContainText('1 of 3 files complete');
  await expect(model.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '41');
  await expect(files).not.toHaveAttribute('open', '');
  await files.locator('summary').click();
  await expect(model.locator('.hf-file')).toHaveCount(3);
  await app.evaluate(() => { globalThis.transfersFixture.status.downloads[0].downloaded = 512 * 1024 ** 2; });
  await expect(model.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await expect(files).toHaveAttribute('open', '');
  await model.locator('[data-group-pause]').click();
  await expect(model.locator('[data-group-resume]')).toBeEnabled();
  expect((await app.evaluate(() => globalThis.transfersFixture.status.downloads)).map(file => file.status)).toEqual(['paused', 'paused', 'done']);
  await model.locator('[data-group-resume]').click();
  await expect(model.locator('[data-group-pause]')).toBeEnabled();
  expect((await app.evaluate(() => globalThis.transfersFixture.status.downloads)).map(file => file.status)).toEqual(['active', 'active', 'done']);
  const controls = await app.evaluate(() => globalThis.transfersFixture.controls);
  expect(controls.map(row => row.id)).toEqual(['same-hf-id', 'second-shard', 'same-hf-id', 'second-shard']);
  await files.locator('summary').click();
  await expect(files).not.toHaveAttribute('open', '');
  await page.screenshot({ path: 'test-results/screenshots/transfers-grouped-model.png' });
});

test('clearing completed Spark models preserves completed shards in an unfinished model', async () => {
  await app.evaluate(() => {
    const rows = globalThis.transfersFixture.status.downloads, first = rows[0];
    rows.push({ ...first, id: 'finished-shard', filePath: 'model-00002.safetensors', status: 'done', downloaded: first.total });
    rows.push({ ...first, id: 'finished-model', repoId: 'owner/finished', status: 'done', downloaded: first.total });
  });
  await expect(page.locator('#transfers .hfdl[data-device="spark"]')).toHaveCount(2);
  await page.locator('#spark-hf-clear').click();
  await expect(page.locator('#transfers .hfdl[data-device="spark"]')).toHaveCount(1);
  await expect(hf('spark')).toContainText('1 of 2 files complete');
  await expect(hf('spark').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62');
  await expect(page.locator('#spark-hf-clear')).toBeDisabled();
  expect(await app.evaluate(() => globalThis.transfersFixture.controls)).toEqual([{ device: 'spark', action: 'hf:remove', id: 'finished-model' }]);
  expect((await app.evaluate(() => globalThis.transfersFixture.status.downloads)).map(row => row.id)).toEqual(['same-hf-id', 'finished-shard']);
});

test('starting an HF download on Spark opens Transfers, and Spark setup has no duplicate progress list', async () => {
  await page.locator('#nav [data-tab="hf"]').click();
  await page.locator('#hf-q').fill('new-model'); await page.locator('#hf-go').click();
  await page.locator('#grid-hf tbody tr').click(); await page.locator('#hf-target').selectOption('spark');
  await page.locator('#hf-configs').click(); await page.locator('#hf-download').click();
  await expect(page.locator('#view-transfers')).toBeVisible();
  await expect(page.locator('#transfers .hfdl[data-repo="owner/new-model"]')).toContainText('owner/new-model');
  expect(await app.evaluate(() => globalThis.transfersFixture.hfRequest.destination)).toBe(root);
  expect(await app.evaluate(() => globalThis.transfersFixture.hfRequest.requiresToken)).toBe(true);
  await page.locator('#nav [data-tab="spark"]').click();
  await expect(page.locator('#spark-transfers-section')).toHaveCount(0);
  await expect(page.locator('#spark-content .hfdl, #spark-content .spark-transfer')).toHaveCount(0);
  await page.locator('#spark-open-transfers').click();
  await expect(page.locator('#view-transfers')).toBeVisible();
  await expect(page.locator('#transfers-device')).toHaveValue('spark');
  await expect(hf('local')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#transfers .hfdl[data-repo="owner/new-model"]')).toBeVisible();
});
