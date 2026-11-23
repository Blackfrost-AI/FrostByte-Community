import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acceptBetaTerms } from './consent-helper.js';
let app, page, home, rootA, rootB, errors;
async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_EDITION: 'community' } });
  page = await app.firstWindow(); errors = []; page.on('pageerror', error => errors.push(error.message)); await acceptBetaTerms(page, app);
  await app.evaluate(({ dialog }, home) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    dialog.showSaveDialog = async options => ({ canceled: false, filePath: process.getBuiltinModule('path').join(home, options.defaultPath) });
  }, home);
  await page.locator('#nav [data-tab="library"]').click();
}
test.beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lifecycle-ui-'))); rootA = path.join(home, 'driveA'); rootB = path.join(home, 'driveB');
  for (const root of [rootA, rootB]) fs.mkdirSync(path.join(root, 'owner/model'), { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: rootA, completedDir: rootB, upnpEnabled: false, dhtEnabled: false, autoCheckUpdates: false, confirmExitSeeding: false }));
});
test.afterEach(async () => { await app?.close(); app = null; fs.rmSync(home, { recursive: true, force: true }); expect(errors || []).toEqual([]); });
test('delete copy B reconciles HF history; hide survives restart/rescan and restores explicitly', async () => {
  const revision = 'a'.repeat(40), records = [rootA, rootB].map(baseDir => { const dest = path.join(baseDir, 'owner/model/model.gguf'); fs.writeFileSync(dest, 'model bytes'); return { repoId: 'owner/model', revision, filePath: 'model.gguf', baseDir, dest, status: 'done', total: 11, downloaded: 11 }; });
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ hfDownloads: records }));
  await launch(); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  const b = page.locator('#library-downloads .inventory-item').filter({ hasText: path.join(rootB, 'owner/model') });
  await b.locator('summary').click(); await b.getByRole('button', { name: 'Delete item + files…' }).click();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
  expect(fs.existsSync(records[1].dest)).toBe(false); expect(fs.readFileSync(records[0].dest, 'utf8')).toBe('model bytes');
  const current = (await page.evaluate(() => window.frostbyte.getState())).data; expect(current.downloads.length).toBe(1); expect(current.inventory.length).toBe(1);
  const a = page.locator('#library-downloads .inventory-item'); await a.locator('summary').click(); await a.getByRole('button', { name: 'Hide from library' }).click(); await expect(a).toHaveCount(0);
  await app.close(); await launch(); await page.locator('#models-scan').click(); await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'complete'); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hidden & retained entries', exact: true }).first().click();
  await page.locator('.recovery-list article').filter({ hasText: path.join(rootA, 'owner/model') }).getByRole('button', { name: 'Restore listing' }).click();
  await page.locator('#modal').getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
});
test('create link without seeding, bulk CSV/JSON export and verify a release draft through the UI', async ({}, testInfo) => {
  const model = path.join(rootA, 'original.gguf'); fs.writeFileSync(model, 'original Blackfrost QA bytes');
  await launch(); await page.locator('#models-scan').click(); await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'complete');
  const card = page.locator('#library-downloads .inventory-item').filter({ hasText: 'original.gguf' }); await card.getByRole('checkbox').check();
  await page.locator('#view-library').getByRole('button', { name: 'Export links…', exact: true }).click(); await expect(page.locator('#export-summary')).toContainText('1 without torrent links');
  await page.getByRole('button', { name: 'Create missing local links…' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.frostbyte.getState())).data.linkJobs[0]?.status).toBe('done');
  expect((await page.evaluate(() => window.frostbyte.getState())).data.torrents).toEqual([]);
  await expect(page.locator('#modal')).toBeHidden();
  await page.locator('#view-library').getByRole('button', { name: 'Export links…', exact: true }).click(); await expect(page.locator('#export-summary')).toContainText('1 distinct magnets');
  await page.locator('#modal').getByRole('button', { name: 'CSV + JSON', exact: true }).click();
  await expect.poll(() => fs.existsSync(path.join(home, 'frostbyte-links.json'))).toBe(true);
  const csv = fs.readFileSync(path.join(home, 'frostbyte-links.csv'), 'utf8'), bundle = JSON.parse(fs.readFileSync(path.join(home, 'frostbyte-links.json'), 'utf8'));
  expect(bundle.links.length).toBe(1); expect(csv).toContain(bundle.links[0].infohash_v1); expect(csv).not.toContain(home); expect(bundle.links[0].sharing_state).toBe('off');
  await card.locator('summary').click(); await card.getByRole('button', { name: 'Prepare release…' }).click();
  await page.locator('#release-id').fill('original-v1'); await page.locator('#release-variant').fill('gguf'); await page.locator('#release-license').fill('MIT'); await page.locator('#release-statement').fill('Owner-created local QA bytes.'); await page.locator('#release-rights').check();
  await page.getByRole('button', { name: 'Verify & preview' }).click(); await expect(page.locator('.release-file-list article')).toHaveCount(1);
  const result = (await page.evaluate(() => window.frostbyte.getState())).data;
  expect(result.publishing.releases[0].manifest.files[0].sha256).toHaveLength(64); expect(result.publishing.jobs).toEqual([]); expect(result.torrents).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('verified-release.png') });
});
test('a stationary library immediately reflects hide and restore without restart or scan activity', async () => {
  const dest = path.join(rootA, 'owner/model/stationary.gguf'); fs.writeFileSync(dest, 'fixture');
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ hfDownloads: [{ repoId: 'owner/model', revision: 'a'.repeat(40), filePath: 'stationary.gguf', baseDir: rootA, dest, status: 'done', downloaded: 7, total: 7 }] }));
  await launch(); const card = page.locator('#library-downloads .inventory-item'); await expect(card).toHaveCount(1);
  // Settle startup polls so no unrelated inventory event can mask a missing
  // hiddenItems dependency in the renderer's material-change signature.
  await page.waitForTimeout(2000);
  await card.locator('summary').click(); await card.getByRole('button', { name: 'Hide from library', exact: true }).click(); await expect(card).toHaveCount(0);
  await page.locator('#view-library').getByRole('button', { name: 'Hidden & retained entries', exact: true }).click();
  await page.locator('.recovery-list').getByRole('button', { name: 'Restore listing', exact: true }).click();
  await expect(page.locator('.recovery-list')).toContainText('No hidden entries or retained jobs.');
  await page.locator('#modal').getByRole('button', { name: 'Done', exact: true }).click(); await expect(card).toHaveCount(1, { timeout: 3000 });
});
test('Windows scanned descendants collapse into their owned model without hiding siblings or another device', async () => {
  await launch();
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('app:state');
    ipcMain.removeHandler('app:state');
    ipcMain.handle('app:state', async event => {
      const result = await original(event);
      const owned = { id: 'owned', source: 'hf', kind: 'model', repoId: 'owner/model', name: 'Owned local model',
        path: 'C:\\Models\\Owner\\Model', directory: true, available: true, files: [], size: 5 };
      const scan = { id: 'scan:child', source: 'scan', kind: 'model', device: 'local',
        name: 'Duplicate scanned child', path: 'c:/models/owner/model/model.gguf', available: true, size: 5 };
      return { ...result, data: { ...result.data, platform: 'win32', inventory: [owned], library: [], torrents: [],
        devices: [{ id: 'desktop-a', name: 'Desktop A', host: 'desktop-a', connected: false, status: { inventory: [{ ...owned, name: 'Owned remote model' }] } },
          { id: 'desktop-b', name: 'Desktop B', host: 'desktop-b', connected: false, status: { inventory: [] } }],
        modelLibrary: { ...result.data.modelLibrary, items: [scan,
          { ...scan, id: 'scan:sibling', name: 'Sibling model', path: 'C:\\Models\\Owner\\Model-extra\\other.gguf' },
          { ...scan, id: 'scan:remote-a', device: 'spark', deviceId: 'desktop-a', name: 'Duplicate remote child' },
          { ...scan, id: 'scan:remote-b', device: 'spark', deviceId: 'desktop-b', name: 'Other device copy' }] } } };
    });
  });
  await page.reload(); await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await page.locator('#nav [data-tab="library"]').click();
  const cards = page.locator('#library-downloads .inventory-item');
  await expect(cards).toHaveCount(4);
  for (const name of ['Owned local model', 'Owned remote model', 'Sibling model', 'Other device copy']) {
    await expect(cards.filter({ hasText: name })).toHaveCount(1);
  }
  await expect(page.locator('#library-downloads')).not.toContainText('Duplicate scanned child');
  await expect(page.locator('#library-downloads')).not.toContainText('Duplicate remote child');
});
