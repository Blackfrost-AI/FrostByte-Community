import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * P2.2 product gate: the FrostNet recipe provider inside the Search view.
 *
 * The owner asked that FrostNet integrate with what users share. The Search
 * view now carries a third provider tab — FrostNet — backed by the signed
 * recipe plane (platform/functions). This spec locks the provider switch, the
 * recipe pane, the filter bar, and the publish entry point against the real
 * renderer. It uses NO Hub fixture: search must fail honestly when the Hub is
 * unreachable, and the publish gate must refuse without an unlocked identity.
 * The full publish→search→withdraw round-trip against the real backend is the
 * P2.4 emulator gate, not this UI spec.
 */

let app, page, home;
const errors = [];
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click({ force: tab === 'discover' });

const applicationPage = async application => {
  let candidate = await application.firstWindow();
  if (!candidate.url().startsWith('frostbyte://app/')) {
    await expect.poll(() => application.windows().find(w => w.url().startsWith('frostbyte://app/'))?.url()).toBeTruthy();
    candidate = application.windows().find(w => w.url().startsWith('frostbyte://app/'));
  }
  return candidate;
};

test.describe.serial('Search: FrostNet recipe provider', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-frostnet-search-'));
    fs.mkdirSync(path.join(home, 'downloads'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
      downloadDir: path.join(home, 'downloads'),
      upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false, confirmBigPull: false,
    }));
    app = await electron.launch({
      executablePath: process.env.FROSTBYTE_EXECUTABLE,
      args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.', '--dev'],
      env: { ...process.env, FROSTBYTE_HOME: home },
    });
    // The first public hub request opens a NATIVE review dialog (showReview).
    // Without this stub the dialog blocks the main process forever and every
    // search hangs at "Searching FrostNet…" — same seam hub-discover.spec.js
    // uses. Approving it records the per-origin consent, exactly like a user
    // clicking Connect once.
    await app.evaluate(async ({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      dialog.showErrorBox = () => {};
    });
    page = await app.firstWindow();
    await acceptBetaTerms(page, app);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  });

  test.afterAll(async () => {
    await app?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test('the Search view offers HuggingFace, FrostNet, and Pirate Face providers', async () => {
    await nav('hf');
    await expect(page.locator('#view-hf')).toBeVisible();
    const tabs = page.locator('#hf-provider-switch .hf-provider-btn');
    await expect(tabs).toHaveCount(3);
    await expect(page.locator('[data-hf-provider="hf"]')).toContainText('HuggingFace');
    await expect(page.locator('[data-hf-provider="frostnet"]')).toContainText('FrostNet');
    await expect(page.locator('[data-hf-provider="pirateface"]')).toContainText('Pirate Face');
    // HuggingFace is the default; the FrostNet pane and filter bar start hidden.
    await expect(page.locator('[data-hf-provider="hf"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#fn-wrap')).toBeHidden();
    await expect(page.locator('#fn-browsebar')).toBeHidden();
  });

  test('switching to FrostNet shows the recipe pane and filter bar, hides the HF grid', async () => {
    await page.locator('[data-hf-provider="frostnet"]').click();
    await expect(page.locator('[data-hf-provider="frostnet"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#fn-wrap')).toBeVisible();
    await expect(page.locator('#fn-browsebar')).toBeVisible();
    // The shared HF/PF results pane is hidden while FrostNet is active.
    await expect(page.locator('#view-hf .hf-wrap:not(#fn-wrap)')).toBeHidden();
    await expect(page.locator('#hf-browsebar')).toBeHidden();
    // Filter controls + publish entry point are present.
    await expect(page.locator('#fn-quant')).toBeVisible();
    await expect(page.locator('#fn-format')).toBeVisible();
    await expect(page.locator('#fn-kind')).toBeVisible();
    await expect(page.locator('#btn-fn-publish')).toBeVisible();
    await expect(page.locator('#grid-fn thead')).toContainText('Recipe');
    await expect(page.locator('#grid-fn thead')).toContainText('Publisher');
  });

  test('the FrostNet search box is shared and routes Enter to recipe search', async () => {
    const q = page.locator('#hf-q');
    await expect(q).toBeVisible();
    await expect(q).toHaveAttribute('placeholder', /FrostNet recipes/);
    await q.fill('qwen3');
    await q.press('Enter');
    // With no reachable Hub the search must resolve to an honest terminal
    // state — never a permanently stuck "Searching…" spinner, never a crash.
    // The hub client timeout is 15s, so allow up to 30s for the terminal state.
    const status = page.locator('#fn-status');
    await expect(status).toContainText(/unreachable|not configured|failed|No recipes matched/i, { timeout: 30_000 });
    await expect(status).not.toContainText('Searching FrostNet');
    await expect(status).not.toContainText('Loading more');
  });

  test('publish refuses without an unlocked publisher identity', async () => {
    await page.locator('#btn-fn-publish').click();
    // No identity exists in this fresh profile: the publish panel must NOT open.
    await expect(page.locator('#fn-publish')).toBeHidden();
    // A toast explains the gate (create/unlock identity or sign in). Target it
    // by text — the prior offline search may have left its own toast visible.
    await expect(page.locator('#toasts .toast', { hasText: /publisher identity|Sign in to your FrostByte|Bind this device/i }).first()).toBeVisible();
  });

  test('switching back to HuggingFace restores the media grid and hides FrostNet', async () => {
    await page.locator('[data-hf-provider="hf"]').click();
    await expect(page.locator('[data-hf-provider="hf"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#fn-wrap')).toBeHidden();
    await expect(page.locator('#fn-browsebar')).toBeHidden();
    await expect(page.locator('#view-hf .hf-wrap:not(#fn-wrap)')).toBeVisible();
    await expect(page.locator('#hf-browsebar')).toBeVisible();
  });

  test('the FrostNet provider raised no renderer errors', async () => {
    expect(errors).toEqual([]);
  });
});