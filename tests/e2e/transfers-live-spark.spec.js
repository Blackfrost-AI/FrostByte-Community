import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';
import { groupHfTransfers } from '../../src/renderer/transfer-groups.js';
import { DEVICE_PHOTOS } from '../../src/shared/device-photos.js';

test('installed Transfers displays the paired Spark actual HF jobs without changing them', async () => {
  test.skip(!process.env.FROSTBYTE_VERIFY_SPARK, 'Set FROSTBYTE_VERIFY_SPARK for read-only verification of an existing companion.');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-transfers-live-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), sparkHost: process.env.FROSTBYTE_VERIFY_SPARK, dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false }));
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
    const page = await app.firstWindow(); await acceptBetaTerms(page, app);
    await page.locator('#nav [data-tab="transfers"]').click();
    const response = await page.evaluate(() => window.frostbyte.sparkStatus());
    expect(response.ok).toBe(true); expect(response.data.connected).toBe(true);
    const downloads = response.data.status.downloads.filter(row => row.status !== 'cancelled');
    expect(downloads.length).toBeGreaterThan(0);
    const groups = groupHfTransfers(downloads.map(row => ({ ...row, device: 'spark' })));
    await expect(page.locator('#transfers .hfdl[data-device="spark"]')).toHaveCount(groups.length);
    for (const group of groups) {
      const card = page.locator('#transfers .hfdl[data-device="spark"]').filter({ has: page.locator('.tor-name').filter({ hasText: group.repoId }) });
      await expect(card.first().locator('.hf-file')).toHaveCount(group.files.length);
      await expect(card.first().locator('details')).not.toHaveAttribute('open', '');
    }
    await expect(page.locator('#transfers-spark-notice')).toBeHidden();
    await expect(page.locator('#empty-transfers')).toBeHidden();
    await page.locator('#nav [data-tab="spark"]').click();
    await page.locator('[data-select-device]:not([data-select-device="local"])').first().click();
    await expect(page.locator('#nav [data-tab="spark"]')).toContainText('Devices');
    const hardware = response.data.status.hardware;
    expect(hardware.modelIdentifier).toBeTruthy();
    expect(hardware.memoryBytes).toBeGreaterThan(0);
    const photo = DEVICE_PHOTOS[hardware.artwork]?.file || hardware.artwork + '.svg';
    await expect(page.locator('[data-select-device="spark"] img')).toHaveAttribute('src', new RegExp(photo.replaceAll('.', '\\.') + '$'));
    await expect(page.locator('#device-details')).toContainText(hardware.modelIdentifier);
    await expect(page.locator('#device-details')).toContainText(hardware.chip);
    for (const gpu of hardware.gpus || []) await expect(page.locator('#device-details')).toContainText(gpu.name);
    await expect(page.locator('#spark-transfers-section')).toHaveCount(0);
    await page.locator('#spark-open-transfers').click();
    await expect(page.locator('#transfers-device')).toHaveValue('spark');
    await page.screenshot({ path: 'test-results/screenshots/transfers-live-spark.png' });
  } finally { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
