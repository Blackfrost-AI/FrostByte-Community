import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';

let app, page, home;
const settings = () => page.evaluate(async () => (await window.frostbyte.getState()).data.settings);

async function appearance() {
  await page.locator('#nav [data-tab="settings"]').click();
  await page.locator('#settings-nav [data-sec="interface"]').click();
}

async function launch() {
  app = await electron.launch({
    args: ['.', '--dev'],
    env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TEST_DIRECT_PEERS: '1' },
  });
  page = await app.firstWindow();
  await acceptBetaTerms(page, app);
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await page.setViewportSize({ width: 1440, height: 960 });
}

test.beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-jensen-ui-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({
    downloadDir: path.join(home, 'downloads'),
    dhtEnabled: false,
    upnpEnabled: false,
    autoCheckUpdates: false,
    confirmExitSeeding: false,
  }));
  await launch();
});

test.afterEach(async () => {
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
});

test('Founders Leather (jensen) scopes tribute card, loads SpaceGrotesk + CC portraits, filters 2021-2026 timeline, and rotates 8 per-tab innovation backdrops', async ({}, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await appearance();
  await expect(page.locator('#sec-interface .card').first().locator('h4')).toHaveText('Appearance');
  await expect(page.locator('#set-theme option[value="jensen"]')).toHaveText('Founders Leather — Jensen tribute');

  // Tribute card must stay hidden on non-Jensen themes
  await page.locator('#set-theme').selectOption('frost');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'frost');
  await expect(page.locator('#jensen-tribute-card')).toBeHidden();
  await expect(page.locator('.brand-jensen-tag')).toBeHidden();

  // Activate Founders Leather
  await page.locator('#set-theme').selectOption('jensen');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'jensen');
  await expect(page.locator('.brand-icon:visible')).toHaveClass(/brand-jensen/);
  await expect(page.locator('.brand-jensen-tag')).toBeVisible();
  await expect(page.locator('.brand-jensen-tag')).toHaveText('Jensen is NVIDIA');
  await expect(page.locator('#jensen-tribute-card')).toBeVisible();
  await expect(page.locator('#theme-credit')).toBeHidden();

  // Community rights disclaimer is prominent and the NVIDIA × Jensen lockup renders
  const rights = page.locator('#jensen-tribute-card .jensen-rights-notice');
  await expect(rights).toBeVisible();
  await expect(rights).toContainText('Community creation — we do not own these rights.');
  await expect(rights).toContainText('NVIDIA Corporation');
  await expect(page.locator('#jensen-tribute-card .jensen-lockup-tag')).toHaveText('To us, Jensen is NVIDIA');
  const brandSystem = await page.evaluate(() => ({
    primaryBg: getComputedStyle(document.querySelector('#set-theme')).getPropertyValue('background-color'),
    scrollbar: getComputedStyle(document.body).scrollbarColor,
    logoFilter: getComputedStyle(document.querySelector('.jensen-nvidia-logo')).filter,
  }));
  expect(brandSystem.scrollbar).not.toBe('auto');
  expect(brandSystem.logoFilter).toContain('invert(1)');

  // Bundled SpaceGroteskUI font loads cleanly
  expect(await page.evaluate(async () => {
    const faces = await document.fonts.load('700 22px SpaceGroteskUI');
    return faces.length > 0 && faces.every(face => face.status === 'loaded');
  })).toBe(true);
  expect(await page.locator('#jensen-tribute-card h4').first().evaluate(el => getComputedStyle(el).fontFamily)).toContain('SpaceGroteskUI');

  // All 3 portraits + signature SVG decode locally without remote requests
  const decodedPortraits = await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('#jensen-tribute-card img')];
    const results = [];
    for (const img of imgs) {
      const probe = new Image();
      probe.src = img.src;
      await probe.decode();
      results.push({ src: img.getAttribute('src'), width: probe.naturalWidth, height: probe.naturalHeight });
    }
    return results;
  });
  expect(decodedPortraits).toHaveLength(5); // 3 portraits + signature + NVIDIA logo
  for (const item of decodedPortraits) {
    expect(item.src).not.toMatch(/^https?:\/\//i);
    expect(item.width).toBeGreaterThan(0);
    expect(item.height).toBeGreaterThan(0);
  }

  // Interactive 2021-2026 timeline filtering + keyboard arrow navigation
  const visibleYears = () => page.locator('#jensen-tribute-card [data-milestone-year]:visible')
    .evaluateAll(nodes => nodes.map(n => n.dataset.milestoneYear));

  expect(await visibleYears()).toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);
  const chip2024 = page.locator('#jensen-tribute-card [data-jensen-year="2024"]');
  await chip2024.click();
  expect(await visibleYears()).toEqual(['2024']);
  await expect(chip2024).toHaveAttribute('aria-selected', 'true');

  await chip2024.focus();
  await page.keyboard.press('ArrowRight');
  expect(await visibleYears()).toEqual(['2025']);
  await expect(page.locator('#jensen-tribute-card [data-jensen-year="2025"]')).toHaveAttribute('aria-selected', 'true');

  await page.locator('#jensen-tribute-card [data-jensen-year="all"]').click();
  expect(await visibleYears()).toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);

  await page.locator('#jensen-tribute-card').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: info.outputPath('jensen-tribute-settings.png') });
  if (process.env.FROSTBYTE_QA_OUTPUT) {
    await fs.mkdir(process.env.FROSTBYTE_QA_OUTPUT, { recursive: true });
    await page.screenshot({ path: path.join(process.env.FROSTBYTE_QA_OUTPUT, 'qa-jensen-tribute.png') });
  }

  // Verify all 8 tabs rotate distinct NVIDIA/Jensen innovation SVG backdrops with zero horizontal overflow
  const tabs = ['dashboard', 'discover', 'transfers', 'library', 'catalog', 'hf', 'spark', 'settings'];
  const backdrops = new Set();
  for (const tab of tabs) {
    // FrostNet nav is aria-disabled (coming-soon placeholder) but still switches
    // views on a real click; force past Playwright's actionability check.
    await page.locator(`#nav [data-tab="${tab}"]`).click({ force: tab === 'discover' });
    await expect(page.locator('html')).toHaveAttribute('data-active-tab', tab);
    const decoded = await page.evaluate(async () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--jensen-tab-backdrop').trim();
      const match = raw.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (!match) return null;
      const probe = new Image();
      probe.src = new URL(match[1], document.baseURI).href;
      await probe.decode();
      return { url: probe.src, width: probe.naturalWidth, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(decoded).not.toBeNull();
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.overflow).toBe(false);
    backdrops.add(decoded.url);
    if (tab === 'dashboard') {
      await page.screenshot({ path: info.outputPath('jensen-dashboard.png') });
      if (process.env.FROSTBYTE_QA_OUTPUT) {
        await page.screenshot({ path: path.join(process.env.FROSTBYTE_QA_OUTPUT, 'qa-jensen-dashboard.png') });
      }
    }
  }
  expect(backdrops.size).toBe(8);

  // Verify hero title retains 20px mixed-case styling (not crushed by .card h4)
  const titleStyle = await page.locator('#jensen-tribute-card .jensen-tribute-title').evaluate(el => ({
    fontSize: getComputedStyle(el).fontSize,
    textTransform: getComputedStyle(el).textTransform,
  }));
  expect(titleStyle).toEqual({ fontSize: '20px', textTransform: 'none' });

  // Accessibility: Reduce Transparency strips decorative leather grain and SVG backdrop
  expect(await page.locator('.main').evaluate(el => getComputedStyle(el).backgroundImage)).not.toBe('none');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  for (const selector of ['.app', '.main', '.settings-body', '#jensen-tribute-card']) {
    expect(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundImage)).toBe('none');
  }
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await cdp.detach();

  // Selection survives app restart
  await app.close();
  await launch();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'jensen');
  expect((await settings()).theme).toBe('jensen');
  await appearance();
  await expect(page.locator('#jensen-tribute-card')).toBeVisible();
  expect(errors).toEqual([]);
});
