import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app, page, home, errors;
const hash = 'a'.repeat(40);

test.beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-remove-errors-'));
  const downloads = path.join(home, 'downloads'); fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: downloads, upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false }));
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app); errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.frostbyte && document.querySelector('#nav .nav.on'));
  const base = await page.evaluate(async () => (await window.frostbyte.getState()).data);
  await app.evaluate(({ ipcMain }, { base, hash, downloads }) => {
    const torrent = { infoHash: hash, magnetURI: `magnet:?xt=urn:btih:${hash}`, name: 'Removal retry fixture', length: 1024,
      downloaded: 512, progress: 0.5, ratio: 0, paused: true, queued: false, done: false, seeding: false,
      numPeers: 0, ready: true, files: [], peers: [], path: downloads, dataPath: downloads + '/Removal retry fixture' };
    globalThis.removeFailureFixture = { calls: [], state: { ...base, torrents: [torrent] } };
    for (const channel of ['app:state', 'torrent:remove']) ipcMain.removeHandler(channel);
    ipcMain.handle('app:state', () => ({ ok: true, data: globalThis.removeFailureFixture.state }));
    ipcMain.handle('torrent:remove', (_, request) => {
      globalThis.removeFailureFixture.calls.push(request);
      return { ok: false, error: 'The transfer store is busy. Try removal again.' };
    });
  }, { base, hash, downloads });
  await page.reload(); await page.locator('#nav [data-tab="transfers"]').click();
});

test.afterEach(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

test('current Options removal controls surface failures and remain retryable', async () => {
  const row = page.locator(`.tor[data-hash="${hash}"]`);
  await expect(row).toBeVisible();
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'Remove transfer', exact: true }).click();
  await expect(page.locator('#toasts')).toContainText('transfer store is busy');
  await expect(row).toBeVisible();

  if (!await row.locator('details').evaluate(node => node.open)) await row.locator('summary').click();
  await row.getByRole('button', { name: 'Delete transfer + files…', exact: true }).click();
  await expect(page.locator('#toasts')).toContainText('Try removal again');
  if (!await row.locator('details').evaluate(node => node.open)) await row.locator('summary').click();
  await expect(row.getByRole('button', { name: 'Remove transfer', exact: true })).toBeEnabled();
  await row.getByRole('button', { name: 'Remove transfer', exact: true }).click();

  expect(await app.evaluate(() => globalThis.removeFailureFixture.calls)).toEqual([
    { infoHash: hash, deleteData: false },
    { infoHash: hash, deleteData: true },
    { infoHash: hash, deleteData: false },
  ]);
  await expect(row).toBeVisible();
});
