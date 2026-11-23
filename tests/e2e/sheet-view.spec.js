import { test, expect, _electron as electron } from '@playwright/test';
import { acceptBetaTerms } from './consent-helper.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app, page, home, errors;
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click();

test.beforeEach(async () => {
  errors = [];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sheet-view-'));
  const destination = path.join(home, 'Downloads');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: destination, dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false, confirmBigPull: false }));
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await acceptBetaTerms(page, app);
  const base = (await page.evaluate(() => window.frostbyte.getState())).data;
  await app.evaluate(({ ipcMain }, base) => {
    const root = base.settings.downloadDir;
    const torrent = (infoHash, name, length, progress, extra = {}) => ({ infoHash, name, length, downloaded: Math.round(length * progress), progress, ready: true, paused: false, done: false, files: [{ name: name + '.bin', path: name + '.bin' }], downloadSpeed: 10, uploadSpeed: 0, numPeers: 1, path: root, ...extra });
    const item = (id, name, size) => ({ id, name, source: 'scan', kind: 'model', repoId: name, destination: root, path: root + '/' + name, directory: true, relative: name, files: [{ path: 'model.gguf' }], size, fileCount: 1, available: true });
    const fixture = globalThis.sheetFixture = { state: { ...base,
      torrents: [torrent('a'.repeat(40), 'Zebra archive', 300, .9), torrent('b'.repeat(40), 'Alpha notes', 100, .5), torrent('c'.repeat(40), 'Mango pack', 200, .25)],
      inventory: [...base.inventory, item('model-zeta', 'demo/Zeta-Model', 900), item('model-alpha', 'demo/Alpha-Model', 100), item('model-mid', 'demo/Mid-Model', 500)],
      ipfs: { ...(base.ipfs || {}), downloads: [{ id: 'ipfs-fixture', name: 'IPFS fixture model', status: 'active', total: 1000, downloaded: 400, speedBps: 2048, files: [{ path: 'model.gguf' }], dest: root + '/ipfs-fixture', folder: 'ipfs-fixture', source: 'QmFixture' }] },
    } };
    ipcMain.removeHandler('app:state');
    ipcMain.handle('app:state', () => ({ ok: true, data: fixture.state }));
  }, base);
  await page.reload();
  await nav('transfers');
  await expect(page.locator('#view-transfers')).toBeVisible();
  await expect(page.locator('#transfers .tor')).toHaveCount(3);
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('failure.png') });
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  expect(errors).toEqual([]);
});

test('cards are the default; sheet toggle renders one-line rows with a sticky header', async () => {
  await expect(page.locator('html')).not.toHaveAttribute('data-listview', 'sheet');
  await expect(page.locator('#transfers-sheet-head')).toBeHidden();
  await expect(page.locator('#transfers .tor [data-row-expand]').first()).toBeHidden();
  const cardHeight = await page.locator('#transfers .tor').first().evaluate(el => el.getBoundingClientRect().height);
  expect(cardHeight).toBeGreaterThan(60);

  await page.locator('#view-transfers [data-lv-switch]').click();
  await expect(page.locator('html')).toHaveAttribute('data-listview', 'sheet');
  await expect(page.locator('#transfers-sheet-head')).toBeVisible();
  await expect(page.locator('#transfers .tor [data-row-expand]').first()).toBeVisible();
  const rowHeight = await page.locator('#transfers .tor').first().evaluate(el => el.getBoundingClientRect().height);
  expect(rowHeight).toBeLessThan(40);
  // one line: name cell ellipsizes instead of wrapping
  const nameBox = await page.locator('#transfers .tor .cell-name').first().evaluate(el => el.getBoundingClientRect().height);
  expect(nameBox).toBeLessThan(32);
  await expect(page.locator('#transfers .tor .tor-status').first()).toBeVisible();
  await expect(page.locator('#transfers .tor .mini-bar').first()).toBeVisible();
  // card-only chrome is gone in sheet mode
  await expect(page.locator('#transfers .tor > .bar').first()).toBeHidden();
  await expect(page.locator('#transfers .tor [data-toggle-files]').first()).toBeHidden();
});

test('sheet mode persists across reload and settings switch returns to cards', async () => {
  await page.locator('#view-transfers [data-lv-switch]').click();
  await expect(page.locator('html')).toHaveAttribute('data-listview', 'sheet');
  await page.reload();
  await expect(page.locator('#view-transfers')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-listview', 'sheet');
  await expect(page.locator('#transfers-sheet-head')).toBeVisible();

  await nav('settings');
  await page.locator('#settings-nav [data-sec="interface"]').click();
  await page.locator('.lv[data-lv="cards"]').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-listview', 'sheet');
  await nav('transfers');
  await expect(page.locator('#transfers-sheet-head')).toBeHidden();
  await expect(page.locator('#transfers .tor > .bar').first()).toBeVisible();
});

test('row expander reveals torrent details and survives live re-renders', async () => {
  await page.locator('#view-transfers [data-lv-switch]').click();
  const row = page.locator('#transfers .tor').first();
  await expect(row.locator('.tor-files')).toBeHidden();
  await row.locator('[data-row-expand]').click();
  await expect(row).toHaveClass(/open/);
  await expect(row.locator('[data-row-expand]')).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('.tor-files')).toBeVisible();
  // renderTransfers rebuilds rows on every 1.5s state tick; expansion must persist
  await page.waitForTimeout(2000);
  await expect(row.locator('.tor-files')).toBeVisible();
  await row.locator('[data-row-expand]').click();
  await expect(row.locator('.tor-files')).toBeHidden();
});

test('sheet header sorts transfers by name, reverses, then restores default order', async () => {
  await page.locator('#view-transfers [data-lv-switch]').click();
  const names = () => page.locator('#transfers .tor .tor-name').allTextContents();
  const head = page.locator('#transfers-sheet-head [data-sort-key="name"]');
  await head.click();
  await expect(head).toHaveAttribute('aria-pressed', 'true');
  expect(await names()).toEqual(['Alpha notes', 'Mango pack', 'Zebra archive']);
  await head.click();
  expect(await names()).toEqual(['Zebra archive', 'Mango pack', 'Alpha notes']);
  await head.click();
  await expect(head).toHaveAttribute('aria-pressed', 'false');
  expect(await names()).toEqual(['Zebra archive', 'Alpha notes', 'Mango pack']); // speed-desc default
});

test('My Models sheet: dense inventory rows, expander details, header drives the sort dropdown', async () => {
  await nav('library');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(3);
  await page.locator('#view-library [data-lv-switch]').click();
  await expect(page.locator('#library-sheet-head')).toBeVisible();
  const row = page.locator('#library-downloads .inventory-item').first();
  const height = await row.evaluate(el => el.getBoundingClientRect().height);
  expect(height).toBeLessThan(40);
  await expect(row.locator('.inventory-path')).toBeHidden();
  await row.locator('[data-inventory-action="expand"]').click();
  await expect(row.locator('.inventory-path')).toBeVisible();
  await expect(row.locator('[data-inventory-action="expand"]')).toHaveAttribute('aria-expanded', 'true');

  await page.locator('#library-sheet-head [data-sort-key="size"]').click();
  await expect(page.locator('#library-sort')).toHaveValue('size');
  await expect(page.locator('#library-sheet-head [data-sort-key="size"]')).toHaveAttribute('aria-pressed', 'true');
  const sizes = await page.locator('#library-downloads .inventory-item .inv-size').allTextContents();
  expect(sizes[0]).toContain('900');
  await page.locator('#library-sheet-head [data-sort-key="size"]').click();
  await expect(page.locator('#library-sort')).toHaveValue('recent');
});

test('density scales sheet rows; ultra stays one line', async () => {
  await page.locator('#view-transfers [data-lv-switch]').click();
  await nav('settings');
  await page.locator('#settings-nav [data-sec="interface"]').click();
  await page.locator('.dens[data-d="ultra"]').click();
  await nav('transfers');
  const height = await page.locator('#transfers .tor').first().evaluate(el => el.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(24);
  await nav('settings');
  await page.locator('#settings-nav [data-sec="interface"]').click();
  await page.locator('.dens[data-d="comfortable"]').click();
  await nav('transfers');
  const comfy = await page.locator('#transfers .tor').first().evaluate(el => el.getBoundingClientRect().height);
  expect(comfy).toBeGreaterThan(height);
  expect(comfy).toBeLessThan(44);
});

test('card mode keeps torrent and IPFS action groups as real flex boxes (C1)', async () => {
  // .cell-acts{display:contents} must NOT clobber .tor-acts / .ipfs-transfer-actions.
  const torActs = page.locator('#transfers .tor .tor-acts').first();
  expect(await torActs.evaluate(el => getComputedStyle(el).display)).toBe('flex');
  expect(await torActs.evaluate(el => getComputedStyle(el).gap)).toBe('6px');
  const ipfsActs = page.locator('#ipfs-transfers .ipfs-transfer .ipfs-transfer-actions').first();
  await expect(ipfsActs).toBeVisible();
  expect(await ipfsActs.evaluate(el => getComputedStyle(el).display)).toBe('flex');
  expect(await ipfsActs.evaluate(el => getComputedStyle(el).gap)).toBe('8px');
});

test('card mode keeps the IPFS progress bar and hides sheet-only size/rate cells (C2/C3)', async () => {
  const card = page.locator('#ipfs-transfers .ipfs-transfer').first();
  await expect(card).toBeVisible();
  const progress = card.locator('.cell-progress progress');
  await expect(progress).toBeVisible();
  expect(await progress.evaluate(el => getComputedStyle(el).display)).toBe('block');
  expect(await card.locator('.cell-size').evaluate(el => getComputedStyle(el).display)).toBe('none');
  expect(await card.locator('.cell-rate').evaluate(el => getComputedStyle(el).display)).toBe('none');
});

test('sheet inventory expander detail spans the full row width, not the name column (S1)', async () => {
  await nav('library');
  await page.locator('#view-library [data-lv-switch]').click();
  const row = page.locator('#library-downloads .inventory-item').first();
  await row.locator('[data-inventory-action="expand"]').click();
  await expect(row).toHaveClass(/open/);
  const detail = row.locator('.sheet-detail');
  await expect(detail).toBeVisible();
  const detailWidth = await detail.evaluate(el => el.getBoundingClientRect().width);
  const rowWidth = await row.evaluate(el => el.getBoundingClientRect().width);
  // detail must span (nearly) the whole row, not collapse into the ~180px name column
  expect(detailWidth).toBeGreaterThan(rowWidth * 0.8);
  // and the collapsed row stays one line
  const height = await row.evaluate(el => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(30); // expanded adds detail height
  await row.locator('[data-inventory-action="expand"]').click();
  const collapsed = await row.evaluate(el => el.getBoundingClientRect().height);
  expect(collapsed).toBeLessThan(40);
});

test('sheet headers align with their rows across transfers and inventories (S2/S3)', async () => {
  await page.locator('#view-transfers [data-lv-switch]').click();
  const leftOf = sel => page.locator(sel).first().evaluate(el => el.getBoundingClientRect().left);
  // transfers head vs tor row vs IPFS row: name-cell left edges must match
  const headLeft = await leftOf('#transfers-sheet-head .cell-name');
  const torLeft = await leftOf('#transfers .tor .cell-name');
  const ipfsLeft = await leftOf('#ipfs-transfers .ipfs-transfer .cell-name');
  expect(Math.abs(headLeft - torLeft)).toBeLessThanOrEqual(2);
  expect(Math.abs(headLeft - ipfsLeft)).toBeLessThanOrEqual(2);
  // inventory head vs inventory row
  await nav('library');
  const invHeadLeft = await leftOf('#library-sheet-head .cell-name');
  const invRowLeft = await leftOf('#library-downloads .inventory-item .cell-name');
  expect(Math.abs(invHeadLeft - invRowLeft)).toBeLessThanOrEqual(2);
});