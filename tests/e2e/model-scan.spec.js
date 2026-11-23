import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';

let app, page, home, pageErrors;
let mainErrors = '';
async function launch({ remote = false } = {}) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_HF_PROBE: '' } });
  app.process().stderr.on('data', chunk => { mainErrors += chunk.toString(); });
  page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  if (remote) await remoteFixture();
  await acceptBetaTerms(page, app);
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await page.locator('#nav [data-tab="library"]').click();
}
async function remoteFixture() {
  const appPath = await app.evaluate(({ app }) => app.getAppPath());
  await app.evaluate((_, appPath) => {
    const module = process.getBuiltinModule('module');
    const require = module.createRequire(process.getBuiltinModule('path').join(appPath, 'package.json'));
    const child = require('node:child_process'), { EventEmitter } = require('node:events'), { PassThrough, Writable } = require('node:stream');
    const { dialog } = require('electron');
    const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.FROSTBYTE_HOME, 'state.json'), 'utf8'));
    const fixture = globalThis.modelScanFixture = { requests: [], reviews: [], approve: false, offline: false, statuses: {},
      holdFiles: false, pendingFiles: [], cancelledFiles: 0 };
    for (const host of ['scan-a.invalid', 'scan-b.invalid']) {
      const roots = host === 'scan-a.invalid' ? ['/models', '/external/models'] : ['/models'];
      const previous = saved.devices?.find(device => device.host === host)?.snapshot;
      fixture.statuses[host] = { hostname: host, version: '0.5.0', downloadDir: '/models', storageRoots: roots,
        storage: roots.map(path => ({ path, available: true, freeBytes: 10000, totalBytes: 20000 })),
        inventoryControls: true, inventory: previous?.inventory || [], torrents: previous?.torrents || [], downloads: [] };
    }
    const spawn = child.spawn;
    child.spawn = (executable, ...args) => {
      if (!/\/ssh(?:\.exe)?$/i.test(String(executable).replaceAll('\\', '/'))) return spawn(executable, ...args);
      const invocation = args[0], host = invocation.find(value => fixture.statuses[value]) || 'scan-a.invalid';
      const process = new EventEmitter();
      process.stdout = new PassThrough(); process.stderr = new PassThrough();
      let input = '', closed = false, pendingFile = false;
      process.kill = () => {
        if (closed) return;
        closed = true;
        if (pendingFile) fixture.cancelledFiles++;
        process.stdout.end(); process.stderr.end(); process.emit('close', 1);
      };
      process.stdin = new Writable({ write(chunk, _, done) { input += chunk; done(); }, final(done) {
        done(); setTimeout(() => {
          if (closed) return;
          if (invocation[0] === '-G') { process.stdout.end(`hostname 127.0.0.1\nuser fixture\n`); process.emit('close', 0); return; }
          if (!input) { process.stdout.end(''); process.emit('close', 0); return; }
          const request = JSON.parse(input); fixture.requests.push({ host, ...request });
          if (request.action.startsWith('device:')) { process.stdout.end(JSON.stringify({ ok: false, error: 'Fixture companion does not support device management.' })); process.emit('close', 0); return; }
          const respond = () => {
            if (closed) return;
            if (fixture.offline) { process.stdout.end(JSON.stringify({ ok: false, error: 'Fixture device offline' })); process.emit('close', 0); return; }
            const status = fixture.statuses[host]; let data;
            if (request.action === 'status') data = structuredClone(status);
            else if (request.action === 'files') {
              const folder = request.relative || '';
              const entries = folder === '' ? request.root === '/external/models'
                ? [{ name: 'external.gguf', relative: 'external.gguf', directory: false, size: 50 }]
                : [{ name: 'Qwen', relative: 'Qwen', directory: true, size: 0 }]
                : ['config.json', 'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors'].map(name => ({ name, relative: `${folder}/${name}`, directory: false, size: 20 }));
              data = { root: request.root, relative: folder, entries, truncated: false };
            } else if (request.action === 'seed') {
              const infoHash = 'b'.repeat(40), target = request.root + '/' + request.relative;
              status.torrents = [{ infoHash, name: 'Qwen', path: request.root, dataPath: target, destination: request.root,
                done: true, ready: true, explicitShare: true, seeding: true, paused: false, magnetURI: 'magnet:?xt=urn:btih:' + infoHash, files: [] }];
              status.inventory = [{ id: 'fixture-seeded-model', source: 'torrent', kind: 'model', name: 'Qwen', path: target,
                destination: request.root, relative: request.relative, browseRelative: request.relative, directory: true,
                available: true, fileCount: 3, size: 60, infoHash, files: [] }];
              data = { infoHash, name: 'Qwen', magnetURI: status.torrents[0].magnetURI };
            } else if (request.action === 'inventory:sharing') { status.torrents.forEach(torrent => { torrent.paused = !request.enabled; }); data = true; }
            else throw new Error('Unexpected fixture RPC: ' + request.action);
            process.stdout.end(JSON.stringify({ ok: true, data })); process.emit('close', 0);
          };
          if (request.action === 'files' && fixture.holdFiles) {
            pendingFile = true; fixture.pendingFiles.push(respond);
          } else respond();
        }, 180);
      } });
      return process;
    };
    module.syncBuiltinESMExports();
    const review = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      if (options.buttons?.includes('Share with peers')) { fixture.reviews.push(options); return { response: fixture.approve ? 1 : 0 }; }
      return review.call(dialog, window, options);
    };
  }, appPath);
}
test.beforeEach(() => {
  pageErrors = [];
  mainErrors = '';
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-model-scan-ui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'),
    completedDir: path.join(home, 'completed'), dhtEnabled: false, upnpEnabled: false, autoCheckUpdates: false, confirmExitSeeding: false }));
  fs.mkdirSync(path.join(home, 'completed'));
});
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.error(mainErrors);
  await app?.close(); app = null;
  fs.rmSync(home, { recursive: true, force: true });
  expect(pageErrors).toEqual([]);
});

test('My Models scans saved local directories with one compact control and retains discovery across restart', async ({}, testInfo) => {
  fs.mkdirSync(path.join(home, 'downloads'));
  fs.writeFileSync(path.join(home, 'downloads', 'existing.gguf'), 'fixture weights');
  const folder = path.join(home, 'completed', 'Qwen'); fs.mkdirSync(folder);
  for (const name of ['config.json', 'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']) fs.writeFileSync(path.join(folder, name), 'fixture');
  await launch();
  await page.locator('#models-scan').click();
  await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'complete');
  await expect(page.getByRole('button', { name: 'Scan all saved directories', exact: true })).toHaveCount(1);
  await expect(page.locator('.model-scan-panel')).toHaveCount(0);
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await expect(page.locator('#library-downloads')).toContainText('Found on disk');
  await expect(page.locator('#library-downloads .share-switch[aria-checked="true"]')).toHaveCount(0);
  expect((await page.evaluate(() => window.frostbyte.getState())).data.torrents).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('local-model-scan.png') });
  await app.close(); app = null;
  await launch();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await page.locator('#models-scan').click();
  await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'complete');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  expect(fs.readFileSync(path.join(home, 'downloads', 'existing.gguf'), 'utf8')).toBe('fixture weights');

  const card = page.locator('#library-downloads .inventory-item').filter({ has: page.getByRole('heading', { name: 'existing.gguf', exact: true }) });
  await card.getByLabel('Options for existing.gguf').click();
  await card.getByRole('button', { name: 'Move to Torrents', exact: true }).click();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(1);
  await page.locator('#nav [data-tab="catalog"]').click();
  const moved = page.locator('#torrents-inventory .inventory-item').filter({ has: page.getByRole('heading', { name: 'existing.gguf', exact: true }) });
  await moved.getByLabel('Options for existing.gguf').click();
  await moved.getByRole('button', { name: 'Move to My Models', exact: true }).click();
  await page.locator('#nav [data-tab="library"]').click();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  await app.evaluate(({ dialog }) => {
    globalThis.scanReviews = [];
    dialog.showMessageBox = async (_, options) => {
      globalThis.scanReviews.push(options);
      return { response: options.buttons?.includes('Share with peers') ? 1 : 0 };
    };
  });
  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByRole('switch')).toBeEnabled();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
  expect(await app.evaluate(() => globalThis.scanReviews.filter(review => review.buttons?.includes('Share with peers')).length)).toBe(1);
  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(card.getByRole('switch')).toBeEnabled();
  expect(fs.readFileSync(path.join(home, 'downloads', 'existing.gguf'), 'utf8')).toBe('fixture weights');
});

test('My Models scans every saved device root, requires share approval, deduplicates shares, and keeps offline results', async ({}, testInfo) => {
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ devices: ['a', 'b'].map(letter => ({ id: 'scan-' + letter,
    name: 'Spark ' + letter.toUpperCase(), host: 'scan-' + letter + '.invalid', generation: 'fixture-' + letter,
    profile: { mode: 'ssh', host: 'scan-' + letter + '.invalid' } })), selectedDeviceId: 'scan-a' }));
  await launch({ remote: true });
  await page.locator('#models-scan').click();
  await expect(page.locator('#models-scan')).toHaveText('Stop scan');
  await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'complete');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(3);
  expect((await page.evaluate(() => window.frostbyte.getState())).data.modelLibrary.scan.locations.map(location => location.root)).toContain('/external/models');
  expect(await app.evaluate(() => globalThis.modelScanFixture.requests.every(request => ['status', 'files'].includes(request.action) || request.action.startsWith('device:')))).toBe(true);
  const card = page.locator('#library-downloads .inventory-item[data-inventory-connection="scan-a"]').filter({ has: page.getByRole('heading', { name: 'Qwen', exact: true }) });
  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(card.getByRole('switch')).toBeEnabled();
  expect(await app.evaluate(() => globalThis.modelScanFixture.requests.filter(request => request.action === 'seed').length)).toBe(0);
  await app.evaluate(() => { globalThis.modelScanFixture.approve = true; });
  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByRole('switch')).toBeEnabled();
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(3);
  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(card.getByRole('switch')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('spark-model-scan.png') });
  await app.evaluate(() => { globalThis.modelScanFixture.offline = true; });
  await page.locator('#models-scan').click();
  await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'complete');
  await expect(page.locator('#models-scan-status')).toContainText('unavailable');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(3);
  await expect(page.locator('#library-downloads .share-switch:enabled')).toHaveCount(0);
});

test('the single scan button can stop and restart a scan', async () => {
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ devices: [{ id: 'scan-a', name: 'Spark A',
    host: 'scan-a.invalid', generation: 'fixture-a', profile: { mode: 'ssh', host: 'scan-a.invalid' } }], selectedDeviceId: 'scan-a' }));
  await launch({ remote: true });
  // Hold an actual directory RPC until the UI cancels it. A fixed transport
  // delay can finish before Playwright's second click on a busy native runner.
  await app.evaluate(() => { globalThis.modelScanFixture.holdFiles = true; });
  await page.locator('#models-scan').click();
  await expect.poll(() => app.evaluate(() => globalThis.modelScanFixture.pendingFiles.length)).toBeGreaterThan(0);
  await expect(page.locator('#models-scan')).toHaveText('Stop scan');
  await page.locator('#models-scan').click();
  await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'cancelled');
  expect(await app.evaluate(() => globalThis.modelScanFixture.cancelledFiles)).toBeGreaterThan(0);
  await expect(page.locator('#models-scan')).toHaveText('Scan all saved directories');
  await app.evaluate(() => {
    globalThis.modelScanFixture.holdFiles = false;
    globalThis.modelScanFixture.pendingFiles.splice(0).forEach(respond => respond());
  });
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(0);
  await page.locator('#models-scan').click();
  await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'complete');
  await expect(page.locator('#library-downloads .inventory-item')).toHaveCount(2);
});

for (const remote of [false, true]) test(`a ${remote ? 'device' : 'local'} discovered model keeps its chosen category when shared and after restart`, async () => {
  const name = remote ? 'Qwen' : 'existing.gguf';
  if (remote) {
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ devices: [{ id: 'scan-a', name: 'Spark A',
      host: 'scan-a.invalid', generation: 'fixture-a', profile: { mode: 'ssh', host: 'scan-a.invalid' } }], selectedDeviceId: 'scan-a' }));
  } else {
    fs.mkdirSync(path.join(home, 'downloads'));
    fs.writeFileSync(path.join(home, 'downloads', name), 'category fixture weights');
  }
  await launch({ remote });
  await page.locator('#models-scan').click();
  await expect(page.locator('#models-scan-status')).toHaveAttribute('data-phase', 'complete');
  const model = page.locator('#library-downloads .inventory-item').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await model.getByLabel(`Options for ${name}`).click();
  await model.getByRole('button', { name: 'Move to Torrents', exact: true }).click();
  await page.locator('#nav [data-tab="catalog"]').click();
  const moved = page.locator('#torrents-inventory .inventory-item').filter({ has: page.getByRole('heading', { name, exact: true }) });
  if (remote) await app.evaluate(() => { globalThis.modelScanFixture.approve = true; });
  else await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (_, options) => ({ response: options.buttons?.includes('Share with peers') ? 1 : 0 }); });
  await moved.getByRole('switch').click();
  await expect(moved.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(moved.getByRole('switch')).toBeEnabled();
  await moved.getByRole('switch').click();
  await expect(moved.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(moved.getByRole('switch')).toBeEnabled();
  await app.close(); app = null;
  await launch({ remote });
  await page.locator('#nav [data-tab="catalog"]').click();
  const restored = page.locator('#torrents-inventory .inventory-item').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(restored).toBeVisible();
  await restored.getByLabel(`Options for ${name}`).click();
  await restored.getByRole('button', { name: 'Move to My Models', exact: true }).click();
  await page.locator('#nav [data-tab="library"]').click();
  await expect(page.locator('#library-downloads .inventory-item').filter({ has: page.getByRole('heading', { name, exact: true }) })).toBeVisible();
});
