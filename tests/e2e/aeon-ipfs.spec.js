import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';
import { KuboRuntime } from '../../src/main/ipfs-runtime.js';
import { identifyDevice } from '../../src/shared/device-models.js';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { originSigningBytes } from '../../src/shared/aeon-origin.js';
let app, page, home;
test.beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-aeon-ui-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false }));
  app = await electron.launch({ args: ['.', '--dev'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TEST_DIRECT_PEERS: '1' } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app);
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
});
test.afterEach(async () => { await app?.close(); await fs.rm(home, { recursive: true, force: true }); });

test('AEON Orbit is available without hardware and persists across reload', async () => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#nav [data-tab="settings"]').click();
  await page.locator('[data-sec="interface"]').click();
  for (const theme of ['aeon', 'frost', 'abyss', 'malachite']) {
    await page.locator('#set-theme').selectOption(theme);
    const mark = page.locator('.brand-icon:visible');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveClass(new RegExp(theme === 'aeon' ? 'brand-orb' : 'brand-frost'));
    expect(await mark.evaluate(async image => { await image.decode(); return image.naturalWidth > 0; })).toBe(true);
  }
  await page.locator('#set-theme').selectOption('aeon');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'aeon');
  expect(await page.evaluate(async () => {
    const faces = await Promise.all(['AeonDisplay', 'AeonMono'].map(family => document.fonts.load(`12px ${family}`)));
    return faces.every(loaded => loaded.length > 0 && loaded.every(face => face.status === 'loaded'));
  })).toBe(true);
  for (const size of [{ width: 980, height: 600 }, { width: 1400, height: 900 }]) {
    await page.setViewportSize(size);
    for (const tab of ['transfers', 'library', 'catalog', 'hf', 'spark', 'settings']) {
      await page.locator(`#nav [data-tab="${tab}"]`).click();
      await expect(page.locator(`#view-${tab}`)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await expect.poll(async () => (await page.evaluate(() => window.frostbyte.getState())).data.settings.theme).toBe('aeon');
  await page.reload(); await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'aeon');
  await page.locator('#nav [data-tab="spark"]').click();
  await expect(page.locator('#aeon-device-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('IPFS opens its own selective download review in the existing Transfers view', async () => {
  await page.locator('#nav [data-tab="transfers"]').click();
  await page.locator('#btn-ipfs').click();
  await expect(page.locator('#modal')).toContainText('Download from IPFS');
  await expect(page.locator('#modal-acts .primary')).toBeDisabled();
  await expect(page.locator('#ipfs-device')).toHaveValue('');
  await expect(page.locator('#ipfs-local-folder')).toContainText(path.join(home, 'downloads'));
  await expect(page.locator('#modal')).toContainText('Sharing starts off');
});

test('dropped IPFS links advance through review one at a time without starting a download', async () => {
  await app.evaluate(({ dialog }) => {
    const original = dialog.showMessageBox;
    dialog.showMessageBox = (win, options) => options.message === 'Look up this IPFS source?' ? Promise.resolve({ response: 0 }) : original(win, options);
  });
  const root = 'ipfs://QmbsqVAgHZ7dJ4XZi9sZPSHmGkeMJfZ66JstsZaA1x4sM4';
  await page.evaluate(root => {
    const data = new DataTransfer(); data.setData('text/uri-list', root + '\n' + root + '/config.json');
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
  }, root);
  await expect(page.locator('#ipfs-source')).toHaveValue(root);
  await expect(page.locator('#ipfs-message')).toHaveText('Preview cancelled.');
  await page.locator('#modal-acts').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#ipfs-source')).toHaveValue(root + '/config.json');
  await page.locator('#modal-acts').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#modal')).toBeHidden();
  const state = await page.evaluate(() => window.frostbyte.getState());
  expect(state.data.ipfs.downloads).toEqual([]);
});

test('AEON tools follow the selected connected Pi and stay hidden on the Mac', async () => {
  await page.locator('#nav [data-tab="settings"]').click();
  await page.locator('[data-sec="interface"]').click();
  await page.locator('#set-theme').selectOption('aeon');
  const hardware = identifyDevice({ platform: 'linux', architecture: 'arm64', reportedModel: 'Raspberry Pi 5 Model B Rev 1.0', cpuCores: 4, memoryBytes: 8 * 1024 ** 3 });
  await app.evaluate(({ ipcMain }, hardware) => {
    const existing = ipcMain._invokeHandlers.get('app:state');
    const pi = { id: 'aeon-test-pi', host: 'orb.local', name: 'AEON Orb', connected: true, defaultDir: '/models', status: { hardware, version: 'test', downloadDir: '/models', storage: [{ path: '/models', available: true }], torrents: [], downloads: [], inventory: [], aeon: { schema: 1, image: 'aeon-magick-orb', version: 'v116', port: 443, tools: ['models', 'devices', 'view'] } } };
    const fixtureState = async (event, ...args) => { const response = await existing(event, ...args); response.data.devices = [pi]; response.data.selectedDeviceId = pi.id; response.data.settings.sparkHost = pi.host; return response; };
    ipcMain.removeHandler('app:state'); ipcMain.handle('app:state', fixtureState);
    ipcMain.removeHandler('devices:select'); ipcMain.handle('devices:select', (event, id) => id === pi.id ? fixtureState(event) : { ok: false, error: 'Unknown fixture device' });
    ipcMain.removeHandler('devices:status'); ipcMain.handle('devices:status', () => ({ ok: true, data: [pi] }));
    ipcMain.removeHandler('spark:files'); ipcMain.handle('spark:files', () => ({ ok: true, data: { entries: [], relative: '' } }));
    ipcMain.removeHandler('spark:device-telemetry'); ipcMain.handle('spark:device-telemetry', () => ({ ok: true, data: { schema: 1, memory: { totalBytes: 8 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 }, docker: { available: false, containers: [] } } }));
    ipcMain.removeHandler('spark:device-recipes'); ipcMain.handle('spark:device-recipes', () => ({ ok: true, data: [] }));
  }, hardware);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await page.locator('#nav [data-tab="spark"]').click();
  await page.locator('[data-select-device="aeon-test-pi"]').click();
  await expect(page.locator('#aeon-device-panel')).toBeVisible();
  await expect(page.locator('#aeon-device-panel')).toContainText('Aether model library');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'test-results/aeon-orbit-devices.png' });
  await page.locator('#aeon-device-panel').scrollIntoViewIfNeeded();
  for (const tool of ['models', 'devices', 'view']) await expect(page.locator(`[data-aeon-tool="${tool}"]`)).toBeInViewport();
  expect(await page.locator('.aeon-device-tools').evaluate(panel => [...panel.querySelectorAll('button')].every(button => {
    const small = button.querySelector('small').getBoundingClientRect(), box = button.getBoundingClientRect();
    return small.top > box.top + 20 && small.bottom <= box.bottom && small.right <= box.right;
  }))).toBe(true);
  await page.screenshot({ path: 'test-results/aeon-orbit-tools.png' });
  await page.setViewportSize({ width: 980, height: 600 });
  await page.locator('#aeon-device-panel').scrollIntoViewIfNeeded();
  expect(await page.locator('.aeon-device-tools').evaluate(panel => [...panel.querySelectorAll('button')].every(button => {
    const box = button.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && button.scrollWidth <= button.clientWidth;
  }))).toBe(true);
  await page.screenshot({ path: 'test-results/aeon-orbit-tools-narrow.png' });
  await page.locator('#devices-back').click();
  await page.locator('[data-select-device="local"]').click();
  await expect(page.locator('#aeon-device-panel')).toBeHidden();
});

test('real IPFS download reaches Transfers and My Models, and sharing can be switched off', async () => {
  const binaryDirectory = path.resolve(`build/ipfs-runtime/${process.platform}-${process.arch}`);
  const source = new KuboRuntime({ directory: path.join(home, 'fixture-node'), binaryDirectory, publishing: true, isolated: true });
  try {
    const fixture = path.join(home, 'fixture'); await fs.mkdir(fixture);
    await fs.writeFile(path.join(fixture, 'config.json'), '{"fixture":"electron-ipfs"}\n');
    await fs.writeFile(path.join(fixture, 'model.safetensors'), Buffer.alloc(256 * 1024, 7));
    // An Orb-style model card signed with the public test key from the shared protocol vectors.
    const vectors = JSON.parse(await fs.readFile(new URL('../fixtures/model-share-vectors.json', import.meta.url)));
    const manifest = [];
    for (const name of ['config.json', 'model.safetensors']) { const bytes = await fs.readFile(path.join(fixture, name)); manifest.push({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    const signer = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.keys.orb_secret, 'hex')]), format: 'der', type: 'pkcs8' });
    await fs.writeFile(path.join(fixture, 'model-card.json'), JSON.stringify({ schema: 'aeon-model-card/2', name: 'Fixture', source: '', verified: false, files: manifest,
      origin: { key: vectors.keys.orb_key, name: 'orb-one', signed_ms: 1760000000002, sig: sign(null, originSigningBytes({ name: 'Fixture', signedMs: 1760000000002, files: manifest }), signer).toString('base64') } }));
    await source.ensure(); await source.stop();
    const root = (await source.command(['add', '--offline', '-Qr', fixture])).stdout.trim(); await source.ensure();
    const address = (await source.json('id')).Addresses.find(a => a.startsWith('/ip4/127.0.0.1/'));
    await app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox;
      globalThis.ipfsNativeReviews = [];
      dialog.showMessageBox = async (win, options) => {
        if (['Look up this IPFS source?', 'Download these IPFS files?', 'Share this collection over IPFS?'].includes(options.message)) {
          globalThis.ipfsNativeReviews.push(options); return { response: 1 };
        }
        return original(win, options);
      };
    });
    await page.locator('#nav [data-tab="transfers"]').click();
    await page.locator('#btn-ipfs').click(); await page.locator('#ipfs-source').fill('ipfs://' + root);
    await page.locator('#ipfs-preview').click();
    // Join only the owned fixture peer. The source-tree app is in its existing
    // isolated-network test mode; no shipping endpoint or approval is bypassed.
    await expect.poll(async () => { try { await fs.access(path.join(home, 'ipfs/receive/api')); return true; } catch { return false; } }).toBe(true);
    const config = JSON.parse(await fs.readFile(path.join(home, 'ipfs/receive/config')));
    const apiAddress = (await fs.readFile(path.join(home, 'ipfs/receive/api'), 'utf8')).trim();
    const port = apiAddress.split('/').at(-1);
    const response = await fetch(`http://127.0.0.1:${port}/api/v0/swarm/connect?arg=${encodeURIComponent(address)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + config.API.Authorizations.frostbyte.AuthSecret.slice(7) } });
    expect(response.ok).toBe(true); await response.body.cancel();
    await expect(page.locator('#ipfs-files input')).toHaveCount(3);
    await page.locator('#ipfs-name').fill('Electron IPFS fixture'); await page.locator('#ipfs-kind').selectOption('model');
    await page.locator('#modal-acts .primary').click();
    await expect(page.locator('#modal')).toBeHidden();
    await expect(page.locator('.ipfs-transfer')).toContainText('Electron IPFS fixture');
    await expect(page.locator('.ipfs-transfer .chip.card-status')).toContainText('done');
    await page.locator('#nav [data-tab="library"]').click();
    const item = page.locator('.inventory-item').filter({ hasText: 'Electron IPFS fixture' });
    await expect(item).toBeVisible(); await expect(item).toContainText('3 downloaded files');
    await expect(item.locator('.inventory-origin')).toContainText('Origin verified');
    await expect(item.locator('.inventory-origin')).toContainText(`“orb-one” · key ${vectors.keys.orb_key.slice(0, 12)}…`);
    await expect(item.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await item.getByRole('switch').click();
    await expect(item.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(item).toContainText('Copy IPFS link');
    await item.getByRole('switch').click();
    await expect(item.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const state = await page.evaluate(() => window.frostbyte.getState());
    const job = state.data.ipfs.downloads[0];
    expect(await fs.readFile(path.join(job.dest, 'config.json'), 'utf8')).toBe('{"fixture":"electron-ipfs"}\n');
    const reviews = await app.evaluate(() => globalThis.ipfsNativeReviews);
    expect(reviews.map(r => r.message)).toEqual(['Look up this IPFS source?', 'Download these IPFS files?', 'Share this collection over IPFS?']);
  } finally { await source.stop(); }
});
