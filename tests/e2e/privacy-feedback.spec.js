import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { acceptBetaTerms } from './consent-helper.js';
import { COMMUNITY_LINKS } from '../../src/shared/community.js';

let app, page, home;
const errors = [];
const require = createRequire(import.meta.url);
const { version: PRODUCT_VERSION } = require('../../package.json');
async function launch() {
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_HF_PROBE: '', FROSTBYTE_TAB: '' } });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.frostbyte);
  await app.evaluate(async ({ app, dialog, shell }, loaderPath) => {
    const modulePath = app.getAppPath() + '/src/main/index.js';
    const require = process.getBuiltinModule('module').createRequire(modulePath);
    globalThis.privacyMain = await require(loaderPath)(modulePath);
    globalThis.reports = []; globalThis.externalLinks = [];
    dialog.showMessageBox = async () => ({ response: 1 });
    shell.openExternal = async url => { globalThis.externalLinks.push(url); };
    globalThis.privacyMain.privacy.send = async report => { globalThis.reports.push(structuredClone(report)); };
  }, path.resolve('tests/e2e/load-main.cjs'));
}
async function privacyTab() {
  await page.locator('#nav [data-tab="settings"]').click();
  await page.locator('#settings-nav [data-sec="privacy"]').click();
}
test.describe.serial(`FrostByte ${PRODUCT_VERSION} welcome, no collection, and GitHub feedback`, () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), `fb-v${PRODUCT_VERSION}-consent-e2e-`));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false }));
    await launch();
  });
  test.afterAll(async () => { await app?.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  test(`first launch explains v${PRODUCT_VERSION}, starts no engine before consent, and has no collection switch`, async ({}, testInfo) => {
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#welcome-title')).toContainText(`FrostByte ${PRODUCT_VERSION}`);
    await expect(page.locator('#welcome-version')).toHaveText(`VERSION ${PRODUCT_VERSION}`);
    await expect(page.locator('#welcome')).toContainText('No data collection.');
    await expect(page.locator('#welcome')).toContainText('Community source publication is in preparation');
    await expect(page.locator('#welcome')).toContainText('Blackfrost AI/SI');
    await expect(page.locator('#welcome-diagnostics')).toHaveCount(0);
    expect(await app.evaluate(() => Boolean(globalThis.privacyMain.engine))).toBe(false);
    await page.keyboard.press('Escape'); await expect(page.locator('#welcome')).toBeVisible();
    await page.locator('#welcome-continue').click(); await expect(page.locator('#welcome')).toBeVisible();
    const rejected = await page.evaluate(() => window.frostbyte.add('magnet:?xt=urn:btih:' + 'a'.repeat(40)));
    expect(rejected.ok).toBe(false);
    await page.locator('#welcome details').first().locator('summary').click();
    await expect(page.locator('#welcome-terms')).toContainText('Nothing in these terms');
    await page.locator('#welcome details').first().locator('summary').click();
    for (const size of [[980, 600], [1400, 1000]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), size);
      await page.locator('#welcome-continue').scrollIntoViewIfNeeded();
      expect(await page.locator('#welcome').evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await page.locator('#welcome').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`v${PRODUCT_VERSION}-welcome.png`) });
    expect(await app.evaluate(() => globalThis.externalLinks)).toEqual([]);
    await page.locator('#welcome-feedback').click();
    expect(await app.evaluate(() => globalThis.externalLinks)).toEqual([COMMUNITY_LINKS.feedback]);
    await expect(page.locator('#welcome')).toBeVisible();
    await acceptBetaTerms(page, app);
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
    expect(await app.evaluate(() => Boolean(globalThis.privacyMain.engine))).toBe(true);
    expect((await page.evaluate(() => window.frostbyte.getPrivacy())).data.diagnosticsEnabled).toBe(false);
  });
  test('acceptance survives relaunch; legacy diagnostics opt-in cannot send or lose settings', async () => {
    await app.close(); await launch(); await expect(page.locator('#welcome')).not.toBeVisible();
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
    await app.close();
    const file = path.join(home, 'privacy.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...saved, termsVersion: 'frostbyte-beta-2026-09-11-v2', diagnosticsEnabled: true }));
    await launch(); await expect(page.locator('#welcome')).toBeVisible();
    expect(await app.evaluate(() => Boolean(globalThis.privacyMain.engine))).toBe(false);
    await app.evaluate(async () => { const p = globalThis.privacyMain.privacy; p.record('app_start'); await p.flush(); });
    expect(await app.evaluate(() => globalThis.reports)).toEqual([]);
    await acceptBetaTerms(page, app); await privacyTab();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).downloadDir).toBe(path.join(home, 'downloads'));
  });
  test('collection cannot be enabled and old report endpoints fail closed', async () => {
    await expect(page.locator('#set-diagnostics')).toHaveCount(0);
    await expect(page.locator('#diagnostics-status')).toContainText('Data collection is disabled');
    const status = (await page.evaluate(() => window.frostbyte.getPrivacy())).data;
    const result = await page.evaluate(consentVersion => window.frostbyte.setDiagnostics({ enabled: true, consentVersion }), status.diagnosticsVersion);
    expect(result.ok).toBe(false);
    const feedback = await page.evaluate(() => window.frostbyte.prepareFeedback({ category: 'bug', message: 'Do not send this report.', attachDiagnostics: true }));
    expect(feedback.ok).toBe(false);
    await app.evaluate(async () => { const p = globalThis.privacyMain.privacy; await p.measure('hf', async () => 'private'); p.record('app_start'); await p.flush(); });
    expect(await app.evaluate(() => globalThis.reports)).toEqual([]);
    expect(await app.evaluate(() => globalThis.privacyMain.privacy.counters)).toEqual({});
  });
  test('feedback opens only the official GitHub page after choosing it, with no payload', async ({}, testInfo) => {
    await page.locator('#btn-feedback').click();
    await expect(page.locator('#modal')).toContainText('GitHub issues are public');
    expect(await app.evaluate(() => globalThis.externalLinks)).toEqual([]);
    await page.locator('#modal-acts button').filter({ hasText: 'Cancel' }).click();
    expect(await app.evaluate(() => globalThis.externalLinks)).toEqual([]);
    await app.evaluate(({ shell }) => { shell.openExternal = async () => { throw new Error('Browser unavailable'); }; });
    await page.locator('#btn-feedback').click();
    await page.locator('#modal-acts button.primary').click();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#feedback-error')).toBeVisible();
    expect(await app.evaluate(() => globalThis.externalLinks)).toEqual([]);
    await page.locator('#modal-acts button').filter({ hasText: 'Cancel' }).click();
    await app.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.externalLinks.push(url); }; });
    await page.locator('#btn-feedback').click();
    await page.screenshot({ path: testInfo.outputPath('v1-feedback.png') });
    await page.locator('#modal-acts button.primary').click();
    await expect(page.locator('#modal')).toBeHidden();
    expect(await app.evaluate(() => globalThis.externalLinks)).toEqual([COMMUNITY_LINKS.feedback]);
    expect(await app.evaluate(() => globalThis.reports)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
