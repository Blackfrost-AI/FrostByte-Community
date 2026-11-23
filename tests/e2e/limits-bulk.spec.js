import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';
let app, page, home, downloads, files, errors;
const state = () => page.evaluate(async () => (await window.frostbyte.getState()).data);
async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_EDITION: 'community' } });
  page = await app.firstWindow(); errors = []; page.on('pageerror', e => errors.push(e.message)); await acceptBetaTerms(page, app);
  await approve(1); await page.locator('#nav [data-tab="library"]').click();
}
async function approve(response) { await app.evaluate(({ dialog }, response) => { dialog.showMessageBox = async () => ({ response }); }, response); }
async function selectAll(operation) {
  await page.locator('#view-library').getByRole('button', { name: 'Select visible', exact: true }).click();
  const bar = page.locator('[data-selection-kind="model"]');
  await expect(bar.locator('[data-selection-count]')).toHaveText('2 selected');
  await bar.getByRole('combobox').selectOption(operation); await bar.getByRole('button', { name: 'Apply to selected…' }).click();
}
test.beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-limits-bulk-'))); downloads = path.join(home, 'downloads');
  files = ['one', 'two'].map((name, i) => { const dest = path.join(downloads, 'owner', name, 'model.gguf'); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, `fixture ${i}`); return dest; });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: downloads, upnpEnabled: false, dhtEnabled: false, autoCheckUpdates: false, confirmExitSeeding: false }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ hfDownloads: files.map((dest, i) => ({ repoId: `owner/${i ? 'two' : 'one'}`, revision: 'a'.repeat(40), filePath: 'model.gguf', baseDir: downloads, dest, status: 'done', downloaded: 9, total: 9 })) }));
});
test.afterEach(async () => { await app?.close(); app = null; fs.rmSync(home, { recursive: true, force: true }); expect(errors || []).toEqual([]); });
test('normal unlimited mode survives schedule changes and restart; ALT activation is reviewed', async () => {
  const settingsPath = path.join(home, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsPath)), schedEnabled: true, schedFrom: '00:00', schedTo: '00:00' }));
  await launch(); await expect(page.locator('#turtle')).toContainText('ALT on');
  await page.locator('#turtle').click(); await expect(page.locator('#turtle')).toHaveText('∞ Unlimited');
  await page.evaluate(() => window.frostbyte.setSettings({ schedFrom: '01:00', schedTo: '01:00' }));
  await app.close(); await launch(); expect((await state()).rates).toMatchObject({ mode: 'normal', alt: false, down: -1, up: -1 });
  await approve(0); await page.locator('#turtle').click(); expect((await state()).rates.alt).toBe(false);
  await approve(1); await page.locator('#turtle').click(); await expect(page.locator('#turtle')).toContainText('ALT on');
  expect((await state()).rates.up).toBe(30 * 1024);
  await page.locator('#nav [data-tab="settings"]').click(); await page.locator('[data-sec="bandwidth"]').click();
  await expect(page.locator('#effective-limits')).toContainText('ALT active');
  await page.locator('#set-unlimited').click(); await page.locator('#modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await state()).rates.alt).toBe(true);
  await page.locator('#set-unlimited').click(); await page.locator('#modal').getByRole('button', { name: 'Use unlimited sharing', exact: true }).click();
  await expect(page.locator('#turtle')).toHaveText('∞ Unlimited');
  expect((await state()).settings).toMatchObject({ bandwidthMode: 'normal', maxActiveDownloads: 0, seedRatioStop: 0, seedMinutesStop: 0, seedOnComplete: true });
  expect((await state()).sharingCapacity.limit).toBeGreaterThanOrEqual(128);
});
test('bulk hide can be cancelled, keeps files, clears selection and restores listings', async ({}, testInfo) => {
  await launch(); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await approve(0); await selectAll('hide'); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await expect(page.locator('[data-selection-count]').first()).toHaveText('2 selected');
  await page.screenshot({ path: testInfo.outputPath('selected-models.png') });
  await approve(1); await page.locator('[data-selection-kind="model"] [data-apply-selection]').click();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(0); expect(files.every(file => fs.existsSync(file))).toBe(true);
  await expect(page.locator('[data-selection-count]').first()).toHaveText('0 selected');
  await page.locator('#view-library').getByRole('button', { name: 'Hidden & retained entries', exact: true }).click();
  await expect(page.locator('.recovery-list article')).toHaveCount(2); await page.locator('.recovery-list article').first().getByRole('button').click();
  await page.locator('#modal').getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
});
test('bulk sharing starts both copies; removal stops sharing, keeps files and survives restart', async () => {
  await launch(); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await selectAll('share'); await page.locator('#modal').getByRole('button', { name: 'Review selected copies' }).click();
  await expect.poll(async () => (await state()).torrents.filter(t => t.explicitShare && !t.paused).length).toBe(2);
  await expect(page.locator('[data-selection-count]').first()).toHaveText('0 selected');
  await selectAll('remove'); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(0);
  expect((await state()).torrents.every(t => t.paused)).toBe(true); expect(files.every(file => fs.existsSync(file))).toBe(true);
  await app.close(); await launch(); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(0);
  await expect.poll(async () => (await state()).torrents.length).toBe(2); expect((await state()).torrents.every(t => t.paused)).toBe(true);
});
test('bulk file deletion keeps cancellation and individual exact-copy reviews', async () => {
  await launch(); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await app.evaluate(({ dialog }) => { let count = 0; dialog.showMessageBox = async () => ({ response: count++ === 0 ? 1 : 0 }); });
  await selectAll('delete'); await page.locator('#modal').getByRole('button', { name: 'Review selected copies' }).click();
  await expect(page.locator('#modal-title')).toHaveText('Selected-item results');
  await expect(page.locator('#modal-description')).toContainText('1 completed · 1 not completed');
  expect(files.filter(file => fs.existsSync(file)).length).toBe(1);
  await page.locator('#modal').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('[data-selection-count]').first()).toHaveText('1 selected');
});
test('selection counts expose filtered-out copies and clear only the current content view', async () => {
  await launch(); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await page.locator('#view-library').getByRole('button', { name: 'Select visible', exact: true }).click();
  await page.locator('#library-query').fill('no-such-model');
  await expect(page.locator('[data-selection-count]').first()).toHaveText('2 selected · 2 outside current filter');
  await page.locator('#view-library').getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.locator('[data-selection-count]').first()).toHaveText('0 selected');
  await expect(page.locator('[data-selection-kind="model"] [data-apply-selection]')).toBeDisabled();
});
