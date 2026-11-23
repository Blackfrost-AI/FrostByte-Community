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
  app = await electron.launch({ args: ['.', '--dev'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TEST_DIRECT_PEERS: '1' } });
  page = await app.firstWindow();
  await acceptBetaTerms(page, app);
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await page.setViewportSize({ width: 1440, height: 960 });
}
test.beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-blackfrost-ui-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({
    downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false,
    autoCheckUpdates: false, confirmExitSeeding: false,
    // A legacy profile must get the new art without losing its saved preferences.
    blackfrostScene: 'blizzard', blackfrostSnow: true,
  }));
  await launch();
});
test.afterEach(async () => { await app?.close(); await fs.rm(home, { recursive: true, force: true }); });

test('Blackfrost uses the shared selector, unbranded artwork and bundled font; selection survives restart', async ({}, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const before = await settings();
  await appearance();
  await expect(page.locator('#sec-interface .card').first().locator('h4')).toHaveText('Appearance');
  expect(await page.locator('#set-theme option').evaluateAll(options => options.map(option => option.value)))
    .toEqual(['frost', 'abyss', 'malachite', 'aeon', 'u1tra_instinct', 'blackfrost', 'jensen']);
  await expect(page.locator('#set-theme option[value="blackfrost"]')).toHaveText('Blackfrost — frosted glass');
  await expect(page.locator('.blackfrost-showcase, .blackfrost-atmosphere, #use-blackfrost, #set-blackfrost-snow, [data-blackfrost-scene]')).toHaveCount(0);
  await expect(page.locator('#sec-interface')).not.toContainText('Tier 3');
  await page.locator('#set-theme').selectOption('blackfrost');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'blackfrost');
  await expect(page.locator('.brand-icon:visible')).toHaveClass(/brand-blackfrost/);
  expect(await page.evaluate(async () => {
    const faces = await document.fonts.load('750 24px BlackfrostUI');
    return faces.length > 0 && faces.every(face => face.status === 'loaded');
  })).toBe(true);
  expect(await page.locator('#sec-interface .card h4').first().evaluate(el => getComputedStyle(el).fontFamily)).toContain('BlackfrostUI');
  expect(await page.evaluate(async () => {
    const source = getComputedStyle(document.documentElement).getPropertyValue('--blackfrost-artwork').match(/url\(['"]?([^'")]+)['"]?\)/)[1];
    const image = new Image(); image.src = new URL(source, document.baseURI).href; await image.decode();
    return image.naturalWidth > 1000 && image.src.endsWith('/frozen-lake.png');
  })).toBe(true);
  await page.screenshot({ path: info.outputPath('blackfrost-clean-settings.png') });
  await app.close(); await launch(); await appearance();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'blackfrost');
  await expect(page.locator('#set-theme')).toHaveValue('blackfrost');
  const after = await settings();
  for (const key of Object.keys(before).filter(key => key !== 'theme')) expect(after[key]).toEqual(before[key]);
  expect(errors).toEqual([]);
});

test('glass preserves readability and honors Reduce Transparency without affecting other themes', async ({}, info) => {
  await appearance(); await page.locator('#set-theme').selectOption('blackfrost');
  for (const selector of ['#sec-interface .card:first-child', '.settings-nav']) {
    const material = await page.locator(selector).evaluate(el => {
      const style = getComputedStyle(el);
      return { backdrop: style.backdropFilter, opacity: style.opacity, filter: style.filter };
    });
    expect(material.backdrop).toMatch(/blur\(\d+px\)/);
    expect(material.opacity).toBe('1');
    expect(material.filter).toBe('none');
  }
  expect(await page.locator('.settings-body').evaluate(el => getComputedStyle(el).backgroundImage)).toContain('frozen-lake.png');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  for (const selector of ['#sec-interface .card:first-child', '.settings-nav']) {
    expect(await page.locator(selector).evaluate(el => [getComputedStyle(el).backdropFilter, getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage]))
      .toEqual(['none', 'rgb(16, 34, 49)', 'none']);
  }
  expect(await page.locator('.settings-body').evaluate(el => getComputedStyle(el).backgroundImage)).toBe('none');
  await page.screenshot({ path: info.outputPath('blackfrost-reduced-transparency.png') });
  await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#blackfrost-snow')).toHaveCount(0);
  await page.locator('#nav [data-tab="transfers"]').click();
  for (const selector of ['#view-transfers .transfer-content', '#grid-catalog']) {
    expect(await page.locator(selector).evaluate(el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backdropFilter]))
      .toEqual(['rgb(5, 11, 18)', 'none']);
  }
  await appearance(); await page.locator('#set-theme').selectOption('aeon');
  expect(await page.locator('#sec-interface .card').first().evaluate(el => getComputedStyle(el).backdropFilter)).toBe('none');
  expect(await page.locator('.settings-body').evaluate(el => getComputedStyle(el).backgroundImage)).not.toContain('frozen-lake.png');
});

test('all themes remain available and failed saves leave appearance unchanged', async () => {
  await appearance();
  for (const theme of ['blackfrost', 'jensen', 'aeon', 'u1tra_instinct', 'frost', 'abyss', 'malachite']) {
    await page.locator('#set-theme').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect.poll(async () => (await settings()).theme).toBe(theme);
    await expect(page.locator('.brand-icon:visible')).toHaveCount(1);
  }
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('settings:set');
    ipcMain.handle('settings:set', () => ({ ok: false, error: 'Appearance fixture: disk is read-only.' }));
  });
  await page.locator('#set-theme').selectOption('blackfrost');
  await expect(page.locator('.toasts')).toContainText('read-only');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'malachite');
  await expect(page.locator('#set-theme')).toHaveValue('malachite');
  await expect(page.locator('#set-theme')).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fb:theme')))).toBe('malachite');
});

test('the appearance credit names the selected theme\u2019s own contributor and opens their profile', async ({}, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ shell }) => { globalThis.themeOpened = []; shell.openExternal = async url => { globalThis.themeOpened.push(url); }; });
  await appearance();
  const credit = page.locator('#theme-credit');
  const expected = {
    aeon: 'AEON Forge · @SpaceTimeViking',
    u1tra_instinct: 'keys 🧪 · @u1tra_instinct',
    blackfrost: 'Blackfrost AI · @blackfrost_ai',
  };
  for (const [theme, label] of Object.entries(expected)) {
    await page.locator('#set-theme').selectOption(theme);
    await expect(credit).toBeVisible();
    await expect(credit).toHaveText(label);
    expect(await credit.getAttribute('data-url')).toMatch(/^https:\/\/x\.com\//);
  }
  // Stock themes are nobody's; the credit must not linger from the previous theme.
  for (const theme of ['frost', 'abyss', 'malachite', 'jensen']) {
    await page.locator('#set-theme').selectOption(theme);
    await expect(credit).toBeHidden();
    await expect(credit).toHaveText('');
  }
  await page.locator('#set-theme').selectOption('u1tra_instinct');
  await credit.click();
  await expect.poll(() => app.evaluate(() => globalThis.themeOpened)).toEqual(['https://x.com/u1tra_instinct']);
  await page.locator('#set-theme').selectOption('aeon');
  await credit.click();
  await expect.poll(() => app.evaluate(() => globalThis.themeOpened)).toEqual(['https://x.com/u1tra_instinct', 'https://x.com/SpaceTimeViking']);
  await page.screenshot({ path: path.join(info.outputDir, 'theme-credit.png') });
  expect(errors).toEqual([]);
});

test('working views stay readable at minimum and wide sizes with every density', async ({}, info) => {
  await appearance(); await page.locator('#set-theme').selectOption('blackfrost');
  for (const size of [{ width: 980, height: 600 }, { width: 1440, height: 960 }]) {
    await page.setViewportSize(size);
    for (const tab of ['transfers', 'library', 'catalog', 'hf', 'spark', 'settings']) {
      await page.locator('#nav [data-tab="' + tab + '"]').click();
      await expect(page.locator('#view-' + tab)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await appearance();
    for (const density of ['comfortable', 'cozy', 'compact', 'ultra']) {
      await page.locator('.dens[data-d="' + density + '"]').click();
      await expect(page.locator('.dens[data-d="' + density + '"]')).toHaveClass(/on/);
      await page.locator('#nav [data-tab="library"]').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await appearance();
    }
    await page.locator('.dens[data-d="cozy"]').click();
    await page.locator('.settings-body').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('blackfrost-settings-' + size.width + '.png') });
  }
  await page.locator('#nav [data-tab="spark"]').click();
  await page.screenshot({ path: info.outputPath('blackfrost-devices.png') });
  await page.locator('#nav [data-tab="transfers"]').click();
  await page.screenshot({ path: info.outputPath('blackfrost-transfers.png') });
  await appearance(); await page.keyboard.press('Tab'); await page.locator('#set-theme').focus();
  expect(await page.locator('#set-theme').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
});

test('authoritative saved theme is restored when renderer storage is empty', async () => {
  await page.evaluate(async () => { await window.frostbyte.setSettings({ theme: 'blackfrost' }); localStorage.removeItem('fb:theme'); });
  await page.reload(); await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'blackfrost');
});
