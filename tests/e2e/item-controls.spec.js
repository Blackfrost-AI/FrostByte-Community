import { exposeCompanionDevice } from './companion-fixture.js';
import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TorrentEngine } from '../../src/main/torrent.js';

let app, page, home, model, files, errors, peer;
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click();
const state = () => page.evaluate(async () => (await window.frostbyte.getState()).data);
async function launch() {
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.', '--dev'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TEST_DIRECT_PEERS: '1' } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }) => {
    const previous = dialog.showMessageBox;
    globalThis.itemShareReviews = [];
    globalThis.holdNextShareReview = false;
    globalThis.heldShareReview = null;
    globalThis.releaseShareReview = null;
    globalThis.holdDeleteReview = false;
    globalThis.heldDeleteReview = null;
    globalThis.releaseDeleteReview = null;
    dialog.showMessageBox = async (window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      if (options?.buttons?.includes('Share with peers')) {
        globalThis.itemShareReviews.push(structuredClone(options));
        if (globalThis.holdNextShareReview) {
          globalThis.holdNextShareReview = false;
          globalThis.heldShareReview = structuredClone(options);
          return new Promise(resolve => { globalThis.releaseShareReview = resolve; });
        }
        return { response: options.buttons.indexOf('Share with peers') };
      }
      if (globalThis.holdDeleteReview && options?.buttons?.includes('Delete downloaded files')) {
        globalThis.holdDeleteReview = false;
        globalThis.heldDeleteReview = structuredClone(options);
        return new Promise(resolve => { globalThis.releaseDeleteReview = resolve; });
      }
      if (options?.buttons?.includes('Start download')) return { response: options.buttons.indexOf('Start download') };
      return previous.call(dialog, window, options);
    };
  });
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
}
test.beforeEach(async () => {
  errors = []; home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-item-ui-')));
  const destination = path.join(home, 'downloads'); model = path.join(destination, 'owner', 'Bonsai-fixture');
  fs.mkdirSync(model, { recursive: true });
  files = [{ name: 'config.json', bytes: Buffer.from('{}\n') }, { name: 'model.safetensors', bytes: crypto.randomBytes(512 * 1024) }];
  for (const file of files) fs.writeFileSync(path.join(model, file.name), file.bytes);
  fs.writeFileSync(path.join(model, 'private-note.txt'), 'not part of downloaded model');
  fs.writeFileSync(path.join(destination, 'guide.pdf'), 'fixture document');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: destination, upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false, seedOnComplete: false, seedRatioStop: 0.001 }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    hfDownloads: files.map(file => ({ id: file.name, repoId: 'owner/Bonsai-fixture', revision: 'a'.repeat(40), filePath: file.name, baseDir: destination, dest: path.join(model, file.name), status: 'done', downloaded: file.bytes.length })),
    downloadedItems: [{ source: 'torrent', infoHash: 'b'.repeat(40), name: 'Installation guide', destination, relative: 'guide.pdf', files: [{ relative: 'guide.pdf', size: 16 }], updatedAt: 1 }],
  }));
  await launch();
});
test.afterEach(async () => { await app?.close(); app = null; await peer?.destroy(); peer = null; fs.rmSync(home, { recursive: true, force: true }); expect(errors).toEqual([]); });

test('My Models and Torrents separate content, preserve manual category choices across restart, and filter by device/type', async () => {
  await expect(page.locator('#nav [data-tab="library"]')).toContainText('My Models');
  await expect(page.locator('#nav [data-tab="catalog"]')).toContainText('Torrents');
  await nav('library'); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
  await expect(page.locator('#library-downloads')).toContainText('Bonsai-fixture');
  await nav('catalog'); await expect(page.locator('#torrents-inventory .inventory-item')).toHaveCount(1);
  await expect(page.locator('#torrents-inventory')).toContainText('Installation guide');
  await page.locator('#torrents-type').selectOption('Video'); await expect(page.locator('#empty-torrents')).toContainText('No matching');
  await page.locator('#torrents-type').selectOption('Documents'); await expect(page.locator('#torrents-inventory .inventory-item')).toHaveCount(1);
  const document = page.locator('#torrents-inventory .inventory-item');
  await document.locator('summary').click(); await document.getByRole('button', { name: 'Move to My Models' }).click();
  await expect(page.locator('#torrents-inventory .inventory-item')).toHaveCount(0);
  await nav('library'); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await expect(page.locator('#ct-library')).toHaveText('2'); await expect(page.locator('#ct-catalog')).toHaveText('0');
  await app.close(); app = null; await launch(); await nav('library');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await page.locator('#library-query').fill('installation'); await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
  const moved = page.locator('#library-downloads .inventory-item'); await moved.locator('summary').click(); await moved.getByRole('button', { name: 'Move to Torrents' }).click();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(0);
  expect(fs.readFileSync(path.join(home, 'downloads/guide.pdf'), 'utf8')).toBe('fixture document');
  await nav('catalog'); await page.locator('#torrents-device').selectOption('spark'); await expect(page.locator('#torrents-inventory .inventory-item')).toHaveCount(0);
  await page.locator('#torrents-device').selectOption('local'); await expect(page.locator('#torrents-inventory .inventory-item')).toHaveCount(1);
});

test('model switch uses real uploads, offers a magnet, avoids duplicates, and keeps Off and bytes across restart', async () => {
  await nav('library'); let card = page.locator('#library-downloads .inventory-item'), toggle = card.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); await expect(card.locator('.item-share-stats')).toBeHidden();
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true'); await expect(toggle).toBeEnabled();
  await expect(card.locator('.item-share-stats')).toBeVisible(); await expect(card.getByRole('button', { name: 'Copy magnet link' })).toBeEnabled();
  await expect(card).toHaveCount(1); await expect(page.locator('#ct-catalog')).toHaveText('1');
  const shared = (await state()).torrents.find(t => t.inventoryId);
  expect(shared.files.map(file => file.path).sort()).toEqual(['Bonsai-fixture/config.json', 'Bonsai-fixture/model.safetensors']);
  peer = new TorrentEngine({ dht: false, tracker: false, lsd: false, allowPeerAddresses: true }); peer.setDownloadPath(path.join(home, 'received'));
  await peer.add(shared.magnetURI + '&x.pe=127.0.0.1:' + (await state()).stats.port);
  await expect.poll(() => peer.list()[0]?.done).toBe(true);
  await expect.poll(async () => (await state()).torrents[0]?.uploaded).toBeGreaterThan(0);
  await expect(card.locator('[data-share-total]')).not.toHaveText('0 B uploaded');
  for (const file of files) expect(fs.readFileSync(path.join(home, 'received/Bonsai-fixture', file.name))).toEqual(file.bytes);
  expect(fs.existsSync(path.join(home, 'received/Bonsai-fixture/private-note.txt'))).toBe(false);
  await card.locator('summary').click(); const copy = card.getByRole('button', { name: 'Copy path', exact: true }); await copy.focus();
  await page.waitForTimeout(1800); await expect(copy).toBeFocused(); await expect(card.locator('details')).toHaveAttribute('open', '');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(card.locator('.item-share-stats')).toBeHidden();
  expect((await state()).torrents[0].paused).toBe(true);
  await app.close(); app = null; await launch(); await nav('library');
  card = page.locator('#library-downloads .inventory-item'); toggle = card.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await state()).torrents[0]?.done).toBe(true);
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect((await state()).torrents[0].infoHash).toBe(shared.infoHash);
  for (const file of files) expect(fs.readFileSync(path.join(model, file.name))).toEqual(file.bytes);
  await page.setViewportSize({ width: 980, height: 600 });
  expect(await page.locator('#view-library').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.locator('.statusbar').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.locator('#sb-sharing').evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(27);
  fs.mkdirSync('test-results/screenshots', { recursive: true }); await page.screenshot({ path: 'test-results/screenshots/my-models-sharing.png' });
});

test('a reviewed file deletion cannot remove a same-hash replacement created while the dialog is open', async () => {
  const inventoryId = (await state()).inventory.find(item => item.repoId === 'owner/Bonsai-fixture').id;
  const enabled = await page.evaluate(id => window.frostbyte.setItemSharing({ device: 'local', id, enabled: true }), inventoryId);
  expect(enabled.ok, enabled.error).toBe(true);
  const original = (await state()).torrents.find(item => item.inventoryId === inventoryId);
  expect(original?.infoHash).toMatch(/^[a-f0-9]{40}$/);
  expect((await page.evaluate(id => window.frostbyte.setItemSharing({ device: 'local', id, enabled: false }), inventoryId)).ok).toBe(true);

  await app.evaluate(() => { globalThis.holdDeleteReview = true; });
  const staleDelete = page.evaluate(hash => window.frostbyte.remove(hash, true), original.infoHash);
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldDeleteReview))).toBe(true);
  const review = await app.evaluate(() => globalThis.heldDeleteReview);
  expect(review.detail).toContain(JSON.stringify(original.infoHash));
  expect(review.detail).toContain(JSON.stringify(model));

  const removed = await page.evaluate(hash => window.frostbyte.remove(hash, false), original.infoHash);
  expect(removed.ok, removed.error).toBe(true);
  const replacement = await page.evaluate(id => window.frostbyte.setItemSharing({ device: 'local', id, enabled: true }), inventoryId);
  expect(replacement.ok, replacement.error).toBe(true);
  await app.evaluate(() => globalThis.releaseDeleteReview({ response: 1 }));
  const rejected = await staleDelete;
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toContain('transfer or downloaded path changed during review');
  const live = (await state()).torrents.filter(item => item.infoHash === original.infoHash);
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ paused: false, explicitShare: true, inventoryId });
  for (const file of files) expect(fs.readFileSync(path.join(model, file.name))).toEqual(file.bytes);
});

test('a stale sharing review cannot change a same-hash replacement transfer', async () => {
  const inventoryId = (await state()).inventory.find(item => item.repoId === 'owner/Bonsai-fixture').id;
  expect((await page.evaluate(id => window.frostbyte.setItemSharing({ device: 'local', id, enabled: true }), inventoryId)).ok).toBe(true);
  const original = (await state()).torrents.find(item => item.inventoryId === inventoryId);
  expect((await page.evaluate(id => window.frostbyte.setItemSharing({ device: 'local', id, enabled: false }), inventoryId)).ok).toBe(true);

  await app.evaluate(() => { globalThis.holdNextShareReview = true; });
  const staleEnable = page.evaluate(id => window.frostbyte.setItemSharing({ device: 'local', id, enabled: true }), inventoryId);
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldShareReview))).toBe(true);
  const review = await app.evaluate(() => globalThis.heldShareReview);
  expect(review.detail).toContain(JSON.stringify(model));
  expect(review.detail).toMatch(/SHA-256 approval binding: [a-f0-9]{64}/);

  expect((await page.evaluate(hash => window.frostbyte.remove(hash, false), original.infoHash)).ok).toBe(true);
  const replacement = await page.evaluate(({ model }) => window.frostbyte.shareFolder(model, 'Replacement share'), { model });
  expect(replacement.ok, replacement.error).toBe(true);
  expect(replacement.data.torrent.infoHash).toBe(original.infoHash);
  await app.evaluate(() => globalThis.releaseShareReview({ response: 1 }));
  const rejected = await staleEnable;
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toContain('transfer changed before this sharing choice');
  const live = (await state()).torrents.filter(item => item.infoHash === original.infoHash);
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ paused: false, explicitShare: true });
  for (const file of files) expect(fs.readFileSync(path.join(model, file.name))).toEqual(file.bytes);
});

test('Spark item controls reflect real status, report failures, preserve menus during bandwidth updates, and disable when offline', async () => {
  const base = await state();
  await app.evaluate(({ ipcMain }, base) => {
    const root = '/media/test/Atlas/Models';
    const item = { id: 'spark-model', source: 'hf', kind: 'model', name: 'owner/remote-model', repoId: 'owner/remote-model', destination: root, path: root + '/owner/remote-model', relative: 'owner/remote-model', directory: true, fileCount: 2, size: 1048576, available: true };
    const status = { version: '0.2.0-beta.6', hostname: 'Fixture Spark', architecture: 'arm64', downloadDir: root, storageRoots: [root], storage: [{ path: root, available: true, freeBytes: 1024 ** 4 }], inventory: [item], inventoryControls: true, torrents: [], downloads: [] };
    const data = globalThis.itemSparkFixture = { online: true, fail: false, status, calls: [] };
    const current = () => ({ ...base, settings: { ...base.settings, sparkHost: 'fixture-spark' }, sparkInventory: { host: 'fixture-spark', ...status } });
    for (const name of ['app:state', 'spark:status', 'spark:files', 'item:sharing', 'item:kind']) ipcMain.removeHandler(name);
    ipcMain.handle('app:state', () => ({ ok: true, data: current() }));
    ipcMain.handle('spark:status', () => ({ ok: true, data: { connected: data.online, status, error: data.online ? '' : 'Spark is offline' } }));
    ipcMain.handle('spark:files', () => ({ ok: true, data: { entries: [] } }));
    ipcMain.handle('item:sharing', (_, request) => {
      data.calls.push(request);
      if (data.fail) return { ok: false, error: 'Storage disconnected. Reconnect the drive and try again.' };
      status.torrents = [{ inventoryId: item.id, infoHash: 'c'.repeat(40), name: 'remote-model', done: true, paused: !request.enabled, seeding: request.enabled, dataPath: item.path, path: root, files: [], uploaded: 512000, uploadSpeed: 65536, numPeers: 3, magnetURI: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) }];
      return { ok: true, data: { state: current(), status } };
    });
    ipcMain.handle('item:kind', (_, request) => { data.calls.push(request); item.kind = request.kind; return { ok: true, data: { state: current(), status } }; });
  }, base);
  await exposeCompanionDevice(app);
  await page.reload(); await nav('library'); await page.locator('#library-device').selectOption('spark');
  const card = page.locator('#library-downloads [data-inventory-id="spark-model"]'), toggle = card.getByRole('switch');
  await expect(toggle).toBeEnabled(); await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(card.locator('[data-share-up]')).toHaveText('↑ 64.0 KB/s');
  await expect(card.locator('[data-share-peers]')).toHaveText('3 peers');
  await card.locator('summary').click(); const copy = card.getByRole('button', { name: 'Copy path', exact: true }); await copy.focus();
  await copy.evaluate(el => { window.focusedShareOption = el; });
  await app.evaluate(() => { globalThis.itemSparkFixture.status.torrents[0].uploadSpeed = 131072; });
  await expect(card.locator('[data-share-up]')).toHaveText('↑ 128 KB/s');
  await expect(copy).toBeFocused(); expect(await copy.evaluate(el => el === window.focusedShareOption)).toBe(true);
  await app.evaluate(() => { globalThis.itemSparkFixture.fail = true; });
  await toggle.click(); await expect(card.getByRole('alert')).toContainText('Reconnect the drive');
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); await expect(toggle).toBeEnabled();
  await app.evaluate(() => { globalThis.itemSparkFixture.fail = false; });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false'); await expect(card.locator('.item-share-stats')).toBeHidden();
  await card.getByRole('button', { name: 'Move to Torrents' }).click();
  await expect(card).toHaveCount(0); await nav('catalog'); await page.locator('#torrents-device').selectOption('spark');
  const moved = page.locator('#torrents-inventory [data-inventory-id="spark-model"]'); await expect(moved).toBeVisible();
  await app.evaluate(() => { globalThis.itemSparkFixture.online = false; });
  await expect(moved).toContainText('Device offline'); await expect(moved.getByRole('switch')).toBeDisabled();
  expect((await app.evaluate(() => globalThis.itemSparkFixture.calls)).every(request => request.device === 'spark' && request.id === 'spark-model')).toBe(true);
});

test('active torrents show their transfer state without claiming that peer sharing is off', async () => {
  await nav('catalog'); await page.locator('#torrents-add').click();
  const hash = '9'.repeat(40);
  await page.locator('#dl-magnet').fill('magnet:?xt=urn:btih:' + hash);
  await page.locator('#dl-kind').selectOption('torrent');
  await page.locator('#modal-acts button.primary').click();
  await expect(page.locator('#view-transfers')).toBeVisible();
  await nav('catalog');
  const item = page.locator(`#torrents-inventory [data-inventory-id="transfer:${hash}"]`);
  await expect(item).toContainText('Transfer active');
  await expect(item.getByRole('switch')).toHaveCount(0);
  await item.getByRole('button', { name: 'View transfer' }).click();
  await page.locator(`.tor[data-hash="${hash}"]`).getByRole('button', { name: 'Pause', exact: true }).click();
  await nav('catalog'); await expect(item).toContainText('Transfer paused');
  await expect(item.getByRole('switch')).toHaveCount(0);
});
