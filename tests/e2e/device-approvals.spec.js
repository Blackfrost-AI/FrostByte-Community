import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';

let app, page, home;
const deviceId = 'review-device';
const repoId = 'owner/model';
const revision = 'a'.repeat(40);
const remoteIds = ['b'.repeat(64), 'c'.repeat(64)];
const payload = 'test configuration\n';
const localRows = () => page.evaluate(async () => (await window.frostbyte.getState()).data.downloads);
const model = () => page.locator('#transfers .hfdl[data-device="local"][data-repo="owner/model"]');
const reviews = () => app.evaluate(() => globalThis.deviceApprovalFixture.reviews);

// Keep real IPC, approval, registry, queue, persistence and UI code. Replace only
// network transports and the companion installer, all inside this isolated profile.
test.beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-device-approvals-'));
  const downloadDir = path.join(home, 'downloads');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir, dhtEnabled: false,
    upnpEnabled: false, autoCheckUpdates: false, confirmExitSeeding: false }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    devices: [{ id: deviceId, host: 'fixture.invalid', name: 'Review device', generation: 'fixture-generation',
      profile: { mode: 'ssh', host: 'fixture.invalid' } }], selectedDeviceId: deviceId,
    hfDownloads: ['config.json', 'tokenizer.json', 'other.json'].map((filePath, index) => ({
      repoId: index === 2 ? 'owner/other' : repoId, revision, filePath, baseDir: downloadDir,
      status: 'paused', source: 'hf', total: Buffer.byteLength(payload), downloaded: 0,
    })),
  }));
  // resolveOpenSsh can use this inert placeholder on Windows images without the
  // optional client installed; the transport below intercepts it before spawn.
  fs.writeFileSync(path.join(home, 'ssh.exe'), '');
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE,
    args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'],
    env: { ...process.env, PATH: `${home}${path.delimiter}${process.env.PATH}`, FROSTBYTE_HOME: home, FROSTBYTE_HF_PROBE: '' },
  });
  page = await app.firstWindow();
  const appPath = await app.evaluate(({ app }) => app.getAppPath());
  await app.evaluate((_, { appPath, deviceId, repoId, revision, remoteIds, payload }) => {
    const module = process.getBuiltinModule('node:module');
    const require = module.createRequire(process.getBuiltinModule('node:path').join(appPath, 'package.json'));
    const { DeviceRegistry } = require('./src/main/devices.js');
    const { SparkSetup } = require('./src/main/spark-setup.js');
    const { Store } = require('./src/main/store.js');
    const { EventEmitter } = require('node:events');
    const { PassThrough, Writable } = require('node:stream');
    const child = require('node:child_process');
    const { dialog } = require('electron');
    const status = { hostname: 'fixture', version: '0.2.0-beta.15', downloadDir: '/models', storageRoots: ['/models'],
      storage: [{ path: '/models', available: true, freeBytes: 10000, totalBytes: 20000 }], inventoryControls: true,
      inventory: [{ id: 'model-item', name: repoId, repoId, source: 'hf', kind: 'model', path: '/models/owner/model',
        destination: '/models', relative: 'owner/model', directory: true, available: true, fileCount: 1, size: 12,
        files: [{ path: 'config.json', size: 12 }] }], torrents: [],
      downloads: remoteIds.map((id, index) => ({ id, repoId, revision, filePath: index ? 'tokenizer.json' : 'config.json',
        destination: '/models', dest: `/models/${repoId}/${index ? 'tokenizer.json' : 'config.json'}`,
        status: 'paused', total: 12, downloaded: 0, speedBps: 0, etaMs: 0 })),
    };
    const fixture = globalThis.deviceApprovalFixture = { status, requests: [], reviews: [], installs: [], fetches: [],
      response: 1, changeDuringReview: '', failCommit: false, failRemoteId: '' };
    const refresh = DeviceRegistry.prototype.refresh;
    DeviceRegistry.prototype.refresh = function (...args) { fixture.registry = this; return refresh.apply(this, args); };
    const spawn = child.spawn;
    child.spawn = (executable, ...args) => {
      if (!/\/ssh(?:\.exe)?$/i.test(String(executable).replaceAll('\\', '/'))) return spawn(executable, ...args);
      const invocation = Array.isArray(args[0]) ? args[0] : [];
      const process = new EventEmitter();
      process.stdout = new PassThrough(); process.stderr = new PassThrough();
      process.kill = () => { process.emit('close', 1); };
      let input = '';
      process.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk; done(); }, final(done) {
        done(); queueMicrotask(() => {
          // Studio resolves an already-approved SSH alias before model
          // discovery. Keep that read-only OpenSSH query inside the fixture;
          // companion RPC requests continue through the JSON stdin path below.
          if (invocation[0] === '-G') {
            process.stdout.end('host fixture.invalid\nhostname 10.0.0.99\nuser fixture\n');
            process.emit('close', 0); return;
          }
          if (invocation.at(-1) === 'ss -H -ltn' && input === '') {
            // The app also inspects socket metadata over this approved SSH
            // connection. This fixture has no serving model or extra ports.
            process.stdout.end(''); process.emit('close', 0); return;
          }
          const request = JSON.parse(input); fixture.requests.push(request);
          let data = true;
          if (request.action === 'status') data = structuredClone(status);
          else if (request.action === 'hf:resume') {
            if (request.id === fixture.failRemoteId) {
              process.stdout.end(JSON.stringify({ ok: false, error: 'Fixture connection interrupted' }));
              process.emit('close', 0); return;
            }
            status.downloads.find(row => row.id === request.id).status = 'queued';
          } else if (request.action === 'seed') data = { infoHash: 'd'.repeat(40), name: 'config.json' };
          else if (request.action !== 'inventory:sharing') {
            process.stdout.end(JSON.stringify({ ok: false, error: `Unexpected fixture action ${request.action}` }));
            process.emit('close', 0); return;
          }
          process.stdout.end(JSON.stringify({ ok: true, data })); process.emit('close', 0);
        });
      } });
      return process;
    };
    module.syncBuiltinESMExports();
    SparkSetup.prototype.addStorage = async function (_profile, options) {
      fixture.installs.push(options); return { deviceId, status: structuredClone(status) };
    };
    const flush = Store.prototype._flush;
    Store.prototype._flush = function () {
      fixture.store = this;
      if (fixture.failCommit && this.state.hfDownloads?.some(row => row.authorization && row.status === 'queued')) {
        throw new Error('Fixture group state write failed');
      }
      return flush.call(this);
    };
    dialog.showMessageBox = async (_window, options) => {
      if (options?.buttons?.includes('Details…')) return { response: options.buttons.indexOf('Details…') };
      fixture.reviews.push(structuredClone(options));
      const change = fixture.changeDuringReview; fixture.changeDuringReview = '';
      if (change === 'connection') fixture.registry.save(fixture.registry.record(deviceId).profile, 'fixture.invalid');
      if (change === 'manifest') status.downloads[0].total++;
      if (change === 'credential') { fixture.store.state.hfUser = 'Changed account'; fixture.store._flush(); }
      if (change === 'poll') await fixture.registry.refresh(deviceId, { force: true });
      return { response: fixture.response };
    };
    const bytes = Buffer.from(payload);
    const etag = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    globalThis.fetch = async input => {
      if (String(input) === 'http://10.0.0.99:8757/v1/info') {
        // This read-only, unauthenticated host probe is independent of HF
        // approval. No Frigid daemon is enrolled in the isolated test profile.
        return new Response(JSON.stringify({ error: 'Fixture management unavailable' }), { status: 503 });
      }
      if (String(input) === 'http://10.0.0.99:30000/v1/models') {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      fixture.fetches.push(String(input));
      if (!String(input).startsWith(`https://huggingface.co/${repoId}/resolve/${revision}/`)) throw new Error('Unexpected fixture HF request');
      return new Response(bytes, { status: 200, headers: { etag, 'content-length': String(bytes.length) } });
    };
  }, { appPath, deviceId, repoId, revision, remoteIds, payload });
  await acceptBetaTerms(page, app);
  await page.evaluate(() => window.frostbyte.deviceStatus(true));
  await app.evaluate(() => { const fixture = globalThis.deviceApprovalFixture; fixture.reviews = []; fixture.requests = []; });
  await page.locator('#nav [data-tab="transfers"]').click();
});

test.afterEach(async () => {
  await app?.evaluate(() => { globalThis.deviceApprovalFixture.failCommit = false; }).catch(() => {});
  await app?.close(); fs.rmSync(home, { recursive: true, force: true });
});

test('unchanged device resumes, shares files and inventory, and updates through real handlers', async () => {
  const resume = await page.evaluate(({ id, deviceId }) => window.frostbyte.sparkControl('hf:resume', id, undefined, deviceId), { id: remoteIds[0], deviceId });
  expect(resume.ok, resume.error).toBe(true);
  const share = await page.evaluate(deviceId => window.frostbyte.setItemSharing({ device: 'spark', deviceId, id: 'model-item', enabled: true }), deviceId);
  expect(share.ok, share.error).toBe(true);
  const seed = await page.evaluate(deviceId => window.frostbyte.sparkControl('seed', 'owner/model/config.json', '/models', deviceId), deviceId);
  expect(seed.ok, seed.error).toBe(true);
  await app.evaluate(() => { globalThis.deviceApprovalFixture.changeDuringReview = 'poll'; });
  const update = await page.evaluate(deviceId => window.frostbyte.updateDevice(deviceId), deviceId);
  expect(update.ok, update.error).toBe(true);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.installs)).toEqual([{ downloadDir: '/models' }]);
  const actions = await app.evaluate(() => globalThis.deviceApprovalFixture.requests.map(request => request.action));
  expect(actions.filter(action => action === 'hf:resume')).toHaveLength(1);
  expect(actions.filter(action => action === 'inventory:sharing')).toHaveLength(1);
  expect(actions.filter(action => action === 'seed')).toHaveLength(1);
});

test('bulk device removal stops the exact reviewed copy and hides it without requesting deletion', async () => {
  const result = await page.evaluate(deviceId => window.frostbyte.batchItems('remove', [{ device: 'spark', deviceId, id: 'model-item' }]), deviceId);
  expect(result.ok, result.error).toBe(true); expect(result.data.results).toMatchObject([{ ok: true }]);
  const mutations = await app.evaluate(() => globalThis.deviceApprovalFixture.requests.filter(r => r.action !== 'status'));
  expect(mutations).toEqual([{ action: 'inventory:sharing', id: 'model-item', enabled: false }]);
  expect(result.data.state.hiddenItems).toMatchObject([{ device: 'spark', deviceId, id: 'model-item', path: '/models/owner/model' }]);
});

test('bulk removal refuses a replacement device after the native review', async () => {
  await app.evaluate(() => { globalThis.deviceApprovalFixture.changeDuringReview = 'connection'; });
  const result = await page.evaluate(deviceId => window.frostbyte.batchItems('remove', [{ device: 'spark', deviceId, id: 'model-item' }]), deviceId);
  expect(result.ok, result.error).toBe(true); expect(result.data.results[0].ok).toBe(false);
  expect(result.data.results[0].error).toMatch(/changed during review/);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.requests.some(r => r.action === 'inventory:sharing'))).toBe(false);
  expect(result.data.state.hiddenItems).toEqual([]);
});

for (const action of ['resume', 'sharing', 'update']) test(`a replaced connection still cancels the reviewed ${action}`, async () => {
  await app.evaluate(() => { globalThis.deviceApprovalFixture.changeDuringReview = 'connection'; });
  const result = await page.evaluate(({ action, deviceId, id }) => action === 'resume'
    ? window.frostbyte.sparkControl('hf:resume', id, undefined, deviceId)
    : action === 'sharing' ? window.frostbyte.setItemSharing({ device: 'spark', deviceId, id: 'model-item', enabled: true })
      : window.frostbyte.updateDevice(deviceId), { action, deviceId, id: remoteIds[0] });
  expect(result.ok).toBe(false); expect(result.error).toMatch(/device.*changed/i);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.requests.every(request => ['status', 'device:telemetry', 'device:recipes'].includes(request.action)))).toBe(true);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.installs)).toEqual([]);
});

test('Cancel dismisses the whole model resume and Resume All stops after the first cancelled group', async () => {
  await app.evaluate(() => { globalThis.deviceApprovalFixture.response = 0; });
  await model().locator('[data-group-resume]').click();
  await expect.poll(async () => (await reviews()).length).toBe(1);
  await expect(model().locator('[data-group-resume]')).toBeEnabled();
  expect((await localRows()).every(row => row.status === 'paused')).toBe(true);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.fetches)).toEqual([]);
  await page.locator('#transfers-device').selectOption('local');
  await page.locator('#btn-resumeall').click();
  await expect.poll(async () => (await reviews()).length).toBe(2);
  await expect(page.locator('#btn-resumeall')).toBeEnabled();
  expect((await localRows()).every(row => row.status === 'paused')).toBe(true);
});

test('one model approval resumes all local files with verified bytes and preserves other models', async () => {
  await model().locator('[data-group-resume]').click();
  await expect.poll(async () => (await localRows()).filter(row => row.repoId === repoId).every(row => row.status === 'done')).toBe(true);
  const prompts = await reviews(); expect(prompts).toHaveLength(1); expect(prompts[0].detail).toContain('Files: 2');
  for (const file of ['config.json', 'tokenizer.json']) expect(fs.readFileSync(path.join(home, 'downloads', repoId, file), 'utf8')).toBe(payload);
  expect((await localRows()).find(row => row.repoId === 'owner/other').status).toBe('paused');
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'state.json'))).hfDownloads.filter(row => row.repoId === repoId);
  expect(new Set(saved.map(row => row.authorization.requestDigest)).size).toBe(1);
  expect(saved.every(row => row.authorization.fileCount === 2)).toBe(true);
});

test('failed group persistence keeps every selected file paused and makes no HF request', async () => {
  const ids = (await localRows()).filter(row => row.repoId === repoId).map(row => row.id);
  await app.evaluate(() => { globalThis.deviceApprovalFixture.failCommit = true; });
  const result = await page.evaluate(ids => window.frostbyte.hfResumeGroup({ ids, device: 'local' }), ids);
  expect(result.ok).toBe(false); expect(result.error).toContain('Fixture group state write failed');
  expect((await localRows()).every(row => row.status === 'paused')).toBe(true);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.fetches)).toEqual([]);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'))).hfDownloads.every(row => row.status === 'paused')).toBe(true);
});

test('a device model resumes once per file under one approval and Cancel queues nothing', async () => {
  await app.evaluate(() => { globalThis.deviceApprovalFixture.response = 0; });
  const cancel = await page.evaluate(({ ids, deviceId }) => window.frostbyte.hfResumeGroup({ ids, device: 'spark', deviceId }), { ids: remoteIds, deviceId });
  expect(cancel.data.cancelled).toBe(true); expect(await reviews()).toHaveLength(1);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.requests.every(request => ['status', 'device:telemetry', 'device:recipes'].includes(request.action)))).toBe(true);
  await app.evaluate(() => { const fixture = globalThis.deviceApprovalFixture; fixture.response = 1; fixture.reviews = []; });
  const resume = await page.evaluate(({ ids, deviceId }) => window.frostbyte.hfResumeGroup({ ids, device: 'spark', deviceId }), { ids: remoteIds, deviceId });
  expect(resume.ok, resume.error).toBe(true); expect(resume.data.resumed).toEqual(remoteIds);
  const prompts = await reviews(); expect(prompts).toHaveLength(1); expect(prompts[0].detail).toContain('Files: 2');
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.requests.filter(request => request.action === 'hf:resume').map(request => request.id))).toEqual(remoteIds);
});

test('changed manifest or credential invalidates a grouped resume before any work is queued', async () => {
  await app.evaluate(() => { globalThis.deviceApprovalFixture.changeDuringReview = 'manifest'; });
  const remote = await page.evaluate(({ ids, deviceId }) => window.frostbyte.hfResumeGroup({ ids, device: 'spark', deviceId }), { ids: remoteIds, deviceId });
  expect(remote.ok).toBe(false); expect(remote.error).toMatch(/download changed/);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.requests.every(request => ['status', 'device:telemetry', 'device:recipes'].includes(request.action)))).toBe(true);
  const ids = (await localRows()).filter(row => row.repoId === repoId).map(row => row.id);
  await app.evaluate(() => { globalThis.deviceApprovalFixture.changeDuringReview = 'credential'; });
  const local = await page.evaluate(ids => window.frostbyte.hfResumeGroup({ ids, device: 'local' }), ids);
  expect(local.ok).toBe(false); expect(local.error).toMatch(/credential changed/);
  expect((await localRows()).every(row => row.status === 'paused')).toBe(true);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.fetches)).toEqual([]);
});

test('interrupted device group reports accepted files and does not retry or hide partial success', async () => {
  await app.evaluate((_, id) => { globalThis.deviceApprovalFixture.failRemoteId = id; }, remoteIds[1]);
  const result = await page.evaluate(({ ids, deviceId }) => window.frostbyte.hfResumeGroup({ ids, device: 'spark', deviceId }), { ids: remoteIds, deviceId });
  expect(result.ok).toBe(false); expect(result.error).toContain('Resumed 1 of 2 files');
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.status.downloads.map(row => row.status))).toEqual(['queued', 'paused']);
  expect(await app.evaluate(() => globalThis.deviceApprovalFixture.requests.filter(request => request.action === 'hf:resume').map(request => request.id))).toEqual(remoteIds);
});
