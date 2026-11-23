import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * P0 product gate: nav honesty and the FrostNet coming-soon placeholder.
 *
 * The owner's gripe: "Models" should say Search, and FrostNet looked like a
 * duplicate search. It is now an explicitly inactive community-home
 * placeholder (updates, shared recipes, creators — arriving with the sharing
 * backend), and the HF browse tab is labelled Search. This spec locks that in
 * against the real renderer, with NO Hub fixture: the placeholder must not
 * need the network at all.
 */

let app, page, home;
const errors = [];
// The FrostNet nav carries aria-disabled="true" (honest coming-soon marker) but
// still opens the placeholder for real clicks; force past Playwright's
// actionability check, which treats aria-disabled as non-clickable.
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click({ force: tab === 'discover' });

const applicationPage = async application => {
  let candidate = await application.firstWindow();
  if (!candidate.url().startsWith('frostbyte://app/')) {
    await expect.poll(() => application.windows().find(w => w.url().startsWith('frostbyte://app/'))?.url()).toBeTruthy();
    candidate = application.windows().find(w => w.url().startsWith('frostbyte://app/'));
  }
  return candidate;
};

test.describe.serial('Nav honesty: Search label and FrostNet coming-soon placeholder', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-placeholder-'));
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
    page = await applicationPage(app);
    await acceptBetaTerms(page, app);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  });

  test.afterAll(async () => {
    await app?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test('the HF browse tab is labelled Search, not Models', async () => {
    const hfNav = page.locator('#nav [data-tab="hf"]');
    await expect(hfNav).toContainText('Search');
    expect((await hfNav.textContent()).replace(/[^\w ]/g, '').trim()).toBe('Search');
    // "My Models" is the library tab and stays; no nav item may be bare "Models".
    const labels = await page.locator('#nav .nav').allTextContents();
    expect(labels.map(t => t.replace(/[^\w ]/g, '').trim())).not.toContain('Models');
  });

  test('FrostNet nav is visibly marked coming soon and opens an inactive placeholder', async () => {
    const frostnetNav = page.locator('#nav [data-tab="discover"]');
    await expect(frostnetNav).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#ct-discover')).toHaveText('soon');

    await nav('discover');
    await expect(page.locator('#view-discover')).toBeVisible();
    // The P2 home replaced the P1 placeholder: it renders real sections and
    // degrades honestly when no Hub is reachable, rather than promising a
    // coming-soon page. Nav still carries the coming-soon marker.
    await expect(page.locator('#view-discover h2')).toHaveText('FrostNet');
    await expect(page.locator('#view-discover .fn-home')).toBeVisible();
    await expect(page.locator('#view-discover .fn-home-main')).toBeVisible();
    await expect(page.locator('#view-discover .fn-home-side')).toBeVisible();
  });

  test('the duplicate FrostNet search UI is gone', async () => {
    for (const selector of ['#hub-q', '#hub-go', '#grid-hub', '#empty-hub', '#hub-count', '#hub-filters', '#hub-detail', '#hub-pagination', '.hub-wrap', '.hub-searchbar']) {
      await expect(page.locator(selector)).toHaveCount(0);
    }
    // The placeholder view carries no search UI of its own.
    await expect(page.locator('#view-discover .hf-wrap')).toHaveCount(0);
    // The real Search view keeps its media grid plus the FrostNet recipe pane
    // (P2 share loop) — both live in #view-hf, never in the placeholder.
    await expect(page.locator('#view-hf .hf-wrap')).toHaveCount(2);
    await expect(page.locator('#fn-wrap')).toHaveCount(1);
  });

  test('Open Search routes to the Search tab', async () => {
    await nav('discover');
    await page.locator('#hub-coming-search').click();
    await expect(page.locator('#view-hf')).toBeVisible();
    await expect(page.locator('#nav [data-tab="hf"]')).toHaveClass(/on/);
    await expect(page.locator('#hf-q')).toBeVisible();
  });

  test('the dashboard FrostNet shortcut is honest about coming soon', async () => {
    await nav('dashboard');
    const card = page.locator('.home-shortcut-card[data-dash-tab="discover"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Coming soon');
    await expect(card).toContainText('FrostNet');
    expect(await card.textContent()).not.toContain('Browse FrostNet');
    await card.click();
    await expect(page.locator('#view-discover')).toBeVisible();
    await expect(page.locator('#view-discover .fn-home')).toBeVisible();
  });

  test('the placeholder raised no renderer errors and needed no Hub connection', async () => {
    expect(errors).toEqual([]);
    const cfg = await page.evaluate(() => window.frostbyte.hubConfig());
    expect(cfg.ok).toBe(true);
    expect(cfg.data.hasToken).toBe(false);
  });
});
