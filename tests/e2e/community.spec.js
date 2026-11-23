import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acceptBetaTerms } from './consent-helper.js';

test('About and Help open official community destinations without leaving the app', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-community-ui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false }));
  let app;
  try {
    // This spec exercises the retail build. Setting the env explicitly keeps the
    // launch independent of any frostbyteEdition left in package.json, and keeps a
    // source-mode launch (`args: ['.']` → defaultApp) resolving to community.
    app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_EDITION: 'community' } });
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // FrostByte ships one edition. The retired Founders surfaces must be absent
    // from the markup entirely, not merely hidden.
    await expect(page.locator('body')).toHaveAttribute('data-edition', 'community');
    await expect(page.locator('.edition-badge')).toHaveCount(0);
    await expect(page.locator('#nav [data-tab="workspace"]')).toHaveCount(0);
    // Observe the actual main-process shell handoff without opening a browser or sending email.
    await app.evaluate(({ app, shell }) => {
      app.communityOpened = [];
      shell.openExternal = async url => { app.communityOpened.push(url); };
    });
    await expect(page.locator('#welcome')).toBeVisible();
    await app.evaluate(async ({ Menu }) => {
      const help = Menu.getApplicationMenu().items.find(item => item.label === 'Help');
      await help.submenu.items.find(item => item.label === 'Email support@blackfrostai.com').click();
    });
    expect(await app.evaluate(({ app }) => app.communityOpened)).toEqual(['mailto:support@blackfrostai.com']);
    await expect(page.locator('#welcome')).toBeVisible();
    await acceptBetaTerms(page, app);
    await page.locator('#nav [data-tab="settings"]').click();
    await page.locator('#settings-nav [data-sec="about"]').click();
    await expect(page.locator('#sec-about')).toBeVisible();
    const destinations = {
      app: 'https://github.com/Blackfrost-AI/FrostByte-App',
      github: 'https://github.com/Blackfrost-AI',
      x: 'https://x.com/blackfrost_ai',
      support: 'mailto:support@blackfrostai.com',
    };
    for (const [key, url] of Object.entries(destinations)) {
      // The FrostNet home repeats these destinations; assert the About copy.
      const link = page.locator(`#sec-about [data-community="${key}"]`);
      await expect(link).toHaveAttribute('href', url);
      await link.focus(); await link.press('Enter');
      await expect.poll(() => app.evaluate(({ app }) => app.communityOpened.at(-1))).toBe(url);
      await expect(page.locator('#sec-about')).toBeVisible();
    }
    await app.evaluate(async ({ app, Menu }) => {
      app.communityOpened = [];
      const help = Menu.getApplicationMenu().items.find(item => item.label === 'Help');
      for (const label of ['FrostByte on GitHub', 'Follow Blackfrost_AI on GitHub', 'Follow @blackfrost_ai on X', 'Email support@blackfrostai.com']) {
        await help.submenu.items.find(item => item.label === label).click();
      }
    });
    expect(await app.evaluate(({ app }) => app.communityOpened)).toEqual(Object.values(destinations));
    await page.locator('#settings-nav [data-sec="connection"]').click();
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'Help').submenu.items.find(item => item.label === 'About FrostByte').click());
    await expect(page.locator('#sec-about')).toBeVisible();
    for (const [width, height] of [[980, 600], [1400, 900]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.settings-body').scrollWidth <= document.querySelector('.settings-body').clientWidth)).toBe(true);
      await page.locator('#sec-about [data-community="support"]').scrollIntoViewIfNeeded();
      await expect(page.locator('#sec-about [data-community="support"]')).toBeVisible();
    }
    fs.mkdirSync('test-results/screenshots', { recursive: true });
    await page.screenshot({ path: 'test-results/screenshots/community-support.png' });
    expect(errors).toEqual([]);
  } finally { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('support email is narrowly allowed and shell failures are reported', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-support-ui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false }));
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_EDITION: 'community' } });
    const page = await app.firstWindow();
    await expect(page.locator('body')).toHaveAttribute('data-edition', 'community'); await acceptBetaTerms(page, app);
    await app.evaluate(({ app, shell }) => {
      app.communityOpened = [];
      shell.openExternal = async url => { app.communityOpened.push(url); throw new Error('No email app is configured.'); };
    });
    for (const url of ['mailto:someone@example.com', 'mailto:support@blackfrostai.com?body=unreviewed', 'file:///tmp/example.txt']) {
      const result = await page.evaluate(url => window.frostbyte.openExternal(url), url);
      expect(result.ok).toBe(false);
    }
    expect(await app.evaluate(({ app }) => app.communityOpened)).toEqual([]);
    await page.locator('#nav [data-tab="settings"]').click();
    await page.locator('#settings-nav [data-sec="about"]').click();
    await page.locator('#sec-about [data-community="support"]').click();
    const error = page.locator('.toast').filter({ hasText: 'No email app is configured.' });
    await expect(error).toHaveCount(1);
    await expect(error).toBeVisible();
    await expect(page.locator('#sec-about')).toBeVisible();
  } finally { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
