import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acceptBetaTerms } from './consent-helper.js';

test('update settings persist, checks display results, and release downloads keep website access', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-updates-ui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false }));
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_EDITION: 'community' } });
    const page = await app.firstWindow(); await acceptBetaTerms(page, app);
    await page.locator('#nav [data-tab="settings"]').click();
    await page.locator('#settings-nav [data-sec="updates"]').click();
    await expect(page.locator('#set-auto-updates')).not.toBeChecked();
    await expect(page.locator('#updates-download')).toBeHidden();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('updates:check');
      ipcMain.handle('updates:check', () => ({ ok: true, data: { status: 'available', lastChecked: Date.now(), latest: { version: '1.0.1', notes: 'Verified test release.' } } }));
    });
    await page.locator('#updates-check').click();
    await expect(page.locator('#updates-status')).toHaveText('A new build is available.');
    await expect(page.locator('#updates-notes')).toHaveText('Verified test release.');
    await expect(page.locator('#updates-download')).toBeVisible();
    await page.locator('#set-auto-updates').check();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'))).autoCheckUpdates).toBe(true);
    await page.locator('#set-auto-updates').uncheck();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'))).autoCheckUpdates).toBe(false);
    fs.mkdirSync('test-results/screenshots', { recursive: true });
    await page.screenshot({ path: 'test-results/screenshots/updates-settings.png' });
  } finally { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
