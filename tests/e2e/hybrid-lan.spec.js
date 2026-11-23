/** Opt-in, real Windows -> paired Spark -> public HF integration. The temporary
 * SSH key is restricted by Spark to an isolated companion's control socket. */
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';
import { sha256File } from '../../src/main/hf.js';

test('physical Windows app downloads from HF plus its paired Spark and retains inventory', async () => {
  test.skip(process.platform !== 'win32' || !process.env.FROSTBYTE_LAN_PLAN, 'Requires the explicitly configured physical LAN test');
  test.setTimeout(45 * 60 * 1000);
  const plan = JSON.parse(fs.readFileSync(process.env.FROSTBYTE_LAN_PLAN, 'utf8'));
  const identity = plan.large.identity;
  const home = path.join(plan.destination, 'desktop-profile'), downloads = path.join(home, 'downloads');
  if (fs.existsSync(home)) throw new Error('Use a fresh physical app test profile.');
  fs.mkdirSync(home, { recursive: true });
  const settings = { downloadDir: downloads, dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false, autoCheckUpdates: false };
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  let app, page;
  const launch = async () => {
    app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
    page = await app.firstWindow(); await acceptBetaTerms(page, app);
    await app.evaluate(({ dialog }) => {
      const previous = dialog.showMessageBox;
      dialog.showMessageBox = async (window, options) => {
        if (['Start this Hugging Face download?',
          'Let this paired device direct peer connections?'].includes(options?.message)) return { response: 1 };
        return previous.call(dialog, window, options);
      };
    });
  };
  try {
    await launch();
    const privateKeyEnc = await app.evaluate(({ safeStorage }, file) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage unavailable');
      return safeStorage.encryptString(process.getBuiltinModule('fs').readFileSync(file, 'utf8')).toString('base64');
    }, path.join(plan.destination, 'ssh', 'id_ed25519'));
    await app.close(); app = null;
    const statePath = path.join(home, 'state.json'), saved = JSON.parse(fs.readFileSync(statePath));
    const { hostKey } = JSON.parse(fs.readFileSync(process.env.FROSTBYTE_LAN_HOST));
    saved.sparkConnection = { mode: 'key', host: '10.0.0.31', username: 'blackfrost_ai', port: 22, hostKey, privateKeyEnc };
    fs.writeFileSync(statePath, JSON.stringify(saved));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ ...settings, sparkHost: '10.0.0.31' }));
    await launch();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('#nav [data-tab="spark"]').click();
    await expect(page.locator('#spark-message')).toContainText('Connected to', { timeout: 30000 });
    await page.locator('#nav [data-tab="hf"]').click();
    await page.locator('#hf-q').fill(identity.repoId); await page.locator('#hf-go').click();
    await page.locator(`#grid-hf tr[data-id="${identity.repoId}"]`).click();
    await expect(page.locator('#hf-detail h3')).toHaveText(identity.repoId);
    if (!await page.locator('#hf-custom').evaluate(el => el.open)) await page.locator('#hf-custom summary').click();
    await page.locator('#hf-pick-none').click();
    await page.locator(`#hf-files input[data-f="${identity.filePath}"]`).check();
    await page.locator('#hf-download-sources').selectOption('hybrid');
    await expect(page.locator('#hf-hybrid-help')).toBeVisible();
    if (process.env.FROSTBYTE_LAN_WAIT_FOR_BASELINE === '1') await expect.poll(() => fs.existsSync(path.join(plan.destination, 'baseline-result.json')), { timeout: 25 * 60 * 1000, intervals: [5000] }).toBe(true);
    const transferStarted = Date.now();
    await page.locator('#hf-download').click();
    await expect(page.locator('#hf-dl-list .hfdl')).toBeVisible();
    await expect(page.locator('#hf-dl-list')).toContainText('HF + connected Spark', { timeout: 120000 });
    fs.mkdirSync(path.join(plan.destination, 'screenshots'), { recursive: true });
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.frostbyte.getState());
      const row = state.data.downloads.find(d => d.repoId === identity.repoId);
      if (row?.status === 'error') throw new Error(row.error);
      return row?.hfBytes > 0 && row?.peerBytes > 0;
    }, { timeout: 180000, intervals: [1000] }).toBe(true);
    await page.screenshot({ path: path.join(plan.destination, 'screenshots', 'windows-live-hybrid.png') });
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.frostbyte.getState());
      const row = state.data.downloads.find(d => d.repoId === identity.repoId);
      if (row?.status === 'error') throw new Error(row.error);
      return row?.status;
    }, { timeout: 15 * 60 * 1000, intervals: [2000] }).toBe('done');
    const state = (await page.evaluate(() => window.frostbyte.getState())).data;
    const row = state.downloads.find(d => d.repoId === identity.repoId);
    expect(row.peerBytes).toBeGreaterThan(0); expect(row.hfBytes).toBeGreaterThan(0);
    expect(await sha256File(row.dest)).toBe(identity.sha256);
    expect(state.inventory.filter(item => item.repoId === identity.repoId)).toHaveLength(1);
    expect(state.torrents).toHaveLength(0);
    await page.locator('#nav [data-tab="library"]').click();
    await page.locator('#library-device').selectOption('local');
    await expect(page.locator('#library-downloads')).toContainText(identity.repoId);
    await expect(page.locator('#library-downloads [role="switch"]')).toHaveAttribute('aria-checked', 'false');
    await page.screenshot({ path: path.join(plan.destination, 'screenshots', 'windows-hybrid-inventory.png') });
    expect(errors).toEqual([]);
    fs.writeFileSync(path.join(plan.destination, 'desktop-result.json'), JSON.stringify({ completed: true, packaged: !!process.env.FROSTBYTE_EXECUTABLE, version: state.version, seconds: (Date.now() - transferStarted) / 1000, sha256: identity.sha256, bytes: row.downloaded, hfBytes: row.hfBytes, peerBytes: row.peerBytes, inventoryItems: 1 }, null, 2));
    await app.close(); app = null;
    await launch();
    const restored = (await page.evaluate(() => window.frostbyte.getState())).data;
    expect(restored.inventory.filter(item => item.repoId === identity.repoId)).toHaveLength(1);
  } finally { await app?.close(); }
});
