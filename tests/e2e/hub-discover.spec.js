import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHubApp } from '../../hub/src/app.js';
import { HUB_API_BASE } from '../../src/main/hub-security.js';

/**
 * Real Electron gate for the FrostNet Hub trust boundaries.
 *
 * P0 split: the FrostNet view is now a coming-soon placeholder (covered by
 * frostnet-placeholder.spec.js); the duplicate search UI it used to carry is
 * gone, so the old search-flow tests retired with it. What stays here are the
 * security regressions, now exercised against the deployed-route health probe:
 *   - pinned production Hub URL, no localhost inputs or overrides
 *   - native review gate on the first public read, remembered per origin
 *   - renderer cannot grant Plus/Pro; update feed cannot be renderer-supplied
 *   - saved tokens pinned to the canonical origin, never exposed to renderer
 *   - bundle import records a digest locally without inventing a tier
 *
 * Canonical HUB_API_BASE requests in main are routed to the local Hub fixture
 * server so nothing leaves the machine while testing real network serialization.
 */

let app, page, home, hub;
const errors = [];
// The FrostNet nav carries aria-disabled="true" (coming-soon marker) but still
// opens the placeholder; force past Playwright's aria-disabled actionability check.
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click({ force: tab === 'discover' });
const settingsSection = name => page.locator(`#settings-nav .snav[data-sec="${name}"]`).click();
const CANONICAL_ORIGIN = new URL(HUB_API_BASE).origin;

const applicationPage = async application => {
  let candidate = await application.firstWindow();
  if (!candidate.url().startsWith('frostbyte://app/')) {
    await expect.poll(() => application.windows().find(w => w.url().startsWith('frostbyte://app/'))?.url()).toBeTruthy();
    candidate = application.windows().find(w => w.url().startsWith('frostbyte://app/'));
  }
  return candidate;
};

const stubDialogs = async (application, { connect = 1, saveToken = 1, rememberHub = false } = {}) => {
  await application.evaluate(({ dialog }, answers) => {
    globalThis.__hubDialogs = [];
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      const buttons = options?.buttons || [];
      const frame = { message: options?.message || '', detail: options?.detail || '', buttons: [...buttons] };
      globalThis.__hubDialogs.push(frame);
      const isSaveDialog = options?.message === 'Save this FrostByte session?' || options?.message === 'Save this Hub token?';
      const answerFor = isSaveDialog ? answers.saveToken : answers.connect;
      const expandIndex = buttons.indexOf('Details…');
      if (expandIndex !== -1) return { response: expandIndex, checkboxChecked: false };
      const isHubConnect = frame.message === 'Connect to FrostByte Hub?' || frame.message === 'Connect to this Hub?' || frame.message === 'Use your FrostByte account?' || frame.message === 'Use your Hub account?';
      if (isHubConnect) return { response: answerFor, checkboxChecked: Boolean(answers.rememberHub) };
      if (isSaveDialog) return { response: answerFor, checkboxChecked: false };
      return previous.call(dialog, window, options);
    };
  }, { connect, saveToken, rememberHub });
};
const shownDialogs = () => app.evaluate(() => globalThis.__hubDialogs || []);
const allDetails = async () => (await shownDialogs()).map(d => d.detail).join('\n---\n');

test.describe.serial('FrostNet: settings and trust boundaries', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hub-'));
    fs.mkdirSync(path.join(home, 'downloads'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
      downloadDir: path.join(home, 'downloads'),
      upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false, confirmBigPull: false,
    }));
    hub = createHubApp({ port: 0 });
    await hub.listen();
    app = await electron.launch({
      executablePath: process.env.FROSTBYTE_EXECUTABLE,
      args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.', '--dev'],
      env: { ...process.env, FROSTBYTE_HOME: home },
    });

    // Route canonical HUB_API_BASE calls in main process to the local Hub fixture server (no localhost setting in app).
    await app.evaluate((_electron, { fixtureOrigin, canonicalHubBase }) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const rawUrl = typeof input === 'string' ? input : input?.url || String(input);
        if (rawUrl.startsWith(`${canonicalHubBase}/`)) {
          return realFetch(`${fixtureOrigin}${rawUrl.slice(canonicalHubBase.length)}`, init);
        }
        if (rawUrl === canonicalHubBase) {
          return realFetch(fixtureOrigin, init);
        }
        return realFetch(input, init);
      };
    }, { fixtureOrigin: hub.origin, canonicalHubBase: HUB_API_BASE });

    page = await applicationPage(app);
    await acceptBetaTerms(page, app);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  });

  test.afterAll(async () => {
    await app?.close();
    await hub?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test('FrostNet defaults to the pinned production Hub URL and removes localhost URL inputs', async () => {
    await nav('discover');
    await expect(page.locator('#view-discover')).toBeVisible();

    await expect(page.locator('#set-huburl')).toHaveCount(0);
    await expect(page.locator('#btn-save-huburl')).toHaveCount(0);

    const cfg = await page.evaluate(() => window.frostbyte.hubConfig());
    expect(cfg.ok).toBe(true);
    expect(cfg.data.hubUrl).toBe(HUB_API_BASE);
    expect(cfg.data.hasToken).toBe(false);
    expect(errors).toEqual([]);
  });

  test('Check Hub probes the deployed health route through the native review gate, anonymously, and remembers the opt-in approval', async () => {
    // Approve WITH "remember" checked — memory is opt-in, never automatic.
    await stubDialogs(app, { rememberHub: true });
    await nav('settings');
    await settingsSection('hub');
    await page.locator('#btn-hub-check').click();

    const dialogs = await shownDialogs();
    expect(dialogs.map(d => d.message)).toContain('Connect to FrostByte Hub?');
    const reviewText = await allDetails();
    expect(reviewText).toContain(`Hub API: "${HUB_API_BASE}"`);
    expect(reviewText).toContain('Check whether FrostByte Hub is reachable');
    expect(reviewText).toContain('No credential is sent.');
    expect(reviewText).toContain('https://');

    const health = await page.evaluate(() => window.frostbyte.hubHealth());
    expect(health.ok).toBe(true);
    // Deployed hubApi answers {status:'ok',…}; the local fixture answers {ok:true,…}.
    expect(health.data.status === 'ok' || health.data.ok === true).toBe(true);

    // Second probe in the same session: remembered per origin, no re-prompt.
    const before = (await shownDialogs()).length;
    const again = await page.evaluate(() => window.frostbyte.hubHealth());
    expect(again.ok).toBe(true);
    expect((await shownDialogs()).length).toBe(before);

    const cfg = await page.evaluate(() => window.frostbyte.hubConfig());
    expect(cfg.data.hubUrl).toBe(HUB_API_BASE);
    expect(cfg.data.hasToken).toBe(false);
  });

  test('the renderer cannot grant Plus or Pro', async () => {
    const plus = await page.evaluate(() => window.frostbyte.hubSetEntitlement({ tier: 'plus' }));
    expect(plus.ok).toBe(false);
    expect(plus.error).toMatch(/granted by your Hub account/i);
    const pro = await page.evaluate(() => window.frostbyte.hubSetEntitlement({ tier: 'pro', status: 'active', source: 'server' }));
    expect(pro.ok).toBe(false);

    const ent = await page.evaluate(() => window.frostbyte.hubEntitlement());
    expect(ent.data.tier).toBe('free');

    const offline = await page.evaluate(() => window.frostbyte.hubSetEntitlement({ tier: 'offline' }));
    expect(offline.ok).toBe(true);
    expect(offline.data.source).toBe('bundle');
    await page.evaluate(() => window.frostbyte.hubSetEntitlement({ tier: 'free' }));
  });

  test('paid update checks are gated, and the feed is not renderer-supplied', async () => {
    const gated = await page.evaluate(() => window.frostbyte.hubCheckUpdate({
      installed: { engines: [{ name: 'llama.cpp', version: 'b1' }] },
    }));
    expect(gated.ok).toBe(false);
    expect(gated.code).toBe('hub_forbidden');
    const injected = await page.evaluate(() => window.frostbyte.hubCheckUpdate(
      { engines: [{ name: 'llama.cpp', version: 'b1' }] },
      { feed: { version: 1, engines: [{ name: 'evil-engine', version: 'v9' }] } },
    ));
    expect(injected.ok).toBe(false);
    expect(JSON.stringify(injected)).not.toContain('evil-engine');
  });

  test('legacy Hub URL and password IPC methods are absent from preload, and settings cannot override HUB_API_BASE', async () => {
    const surface = await page.evaluate(() => ({
      hubSetUrl: typeof window.frostbyte.hubSetUrl,
      hubLogin: typeof window.frostbyte.hubLogin,
      hubSignUp: typeof window.frostbyte.hubSignUp,
      hubResetPassword: typeof window.frostbyte.hubResetPassword,
      hubSignInWithBrowser: typeof window.frostbyte.hubSignInWithBrowser,
    }));
    expect(surface).toEqual({
      hubSetUrl: 'undefined',
      hubLogin: 'undefined',
      hubSignUp: 'undefined',
      hubResetPassword: 'undefined',
      hubSignInWithBrowser: 'function',
    });

    for (const candidate of [
      'http://127.0.0.1:8787',
      'http://localhost:8787',
      'http://hub.example.org',
      'https://hub.example.org',
    ]) {
      await page.evaluate(u => window.frostbyte.setSettings({ hubUrl: u }), candidate);
      const cfg = await page.evaluate(() => window.frostbyte.hubConfig());
      expect(cfg.data.hubUrl).toBe(HUB_API_BASE);
      // Direct hubSetConfig injection is refused in main, not just setSettings.
      const direct = await page.evaluate(u => window.frostbyte.hubSetConfig({ hubUrl: u }), candidate);
      expect(direct.ok).toBe(false);
      expect((await page.evaluate(() => window.frostbyte.hubConfig())).data.hubUrl).toBe(HUB_API_BASE);
    }
  });

  test('a saved API token is pinned to the canonical FrostNet origin and never exposed to the renderer', async () => {
    await stubDialogs(app, { saveToken: 1 });
    await nav('settings');
    await settingsSection('hub');
    await expect(page.locator('#btn-hub-browser-login')).toBeVisible();
    await page.locator('#set-hubtoken').fill('hub_test_token_value');
    await page.locator('#btn-save-hubtoken').click();
    await expect(page.locator('#hub-token-status')).not.toBeEmpty();
    const status = await page.locator('#hub-token-status').textContent();
    const withToken = await page.evaluate(() => window.frostbyte.hubConfig());
    expect(JSON.stringify(withToken)).not.toContain('hub_test_token_value');

    if (!withToken.data.hasToken) {
      expect(status).toMatch(/secure token storage is unavailable/i);
      test.skip(true, 'No OS keychain in this environment, so no token can be stored.');
      return;
    }
    expect(status).toBe('Token saved.');
    expect(withToken.data.tokenOrigin).toBe(HUB_API_BASE);

    // Attempting to inject a foreign HTTPS Hub URL via settings leaves canonical HUB_API_BASE intact.
    await page.evaluate(() => window.frostbyte.setSettings({ hubUrl: 'https://hub.example.org' }));
    const afterAttempt = await page.evaluate(() => window.frostbyte.hubConfig());
    expect(afterAttempt.data.hubUrl).toBe(HUB_API_BASE);
  });

  test('bundle import records the digest locally without inventing a tier', async () => {
    await nav('discover');
    await page.locator('#hub-bundle-import').click();
    const digest = 'a'.repeat(64);
    await page.locator('#hub-bundle-digest').fill(digest);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const cfg = await page.evaluate(() => window.frostbyte.hubConfig());
    expect(cfg.data.bundleDigest).toBe(digest);
    const ent = await page.evaluate(() => window.frostbyte.hubEntitlement());
    expect(ent.data.tier).toBe('free');
    const bad = await page.evaluate(() => window.frostbyte.hubBundleImport({ bundleDigest: 'nothex' }));
    expect(bad.ok).toBe(false);
    // The placeholder and Settings bundle notes both tell the seed-only truth.
    await expect(page.locator('#hub-bundle-note')).toContainText('Bundle seed recorded');
    await expect(page.locator('#hub-bundle-note')).toContainText('offline browsing arrives with FrostNet');
    await nav('settings');
    await settingsSection('hub');
    await expect(page.locator('#hub-bundle-note-settings')).toContainText('Bundle seed recorded');
  });

  test('no renderer errors were raised across the Hub flows', async () => {
    expect(errors).toEqual([]);
  });
});
