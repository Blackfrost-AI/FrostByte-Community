import { expect } from '@playwright/test';

// Existing feature tests explicitly accept the UI in their isolated profiles.
// There is no environment flag that bypasses production consent.
export async function acceptBetaTerms(page, app) {
  await page.waitForFunction(() => window.frostbyte);
  const privacy = await page.evaluate(() => window.frostbyte.getPrivacy());
  expect(privacy.ok).toBe(true);
  if (!privacy.data.required) return;
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#welcome-diagnostics')).toHaveCount(0);
  if (!app) throw new Error('Electron app is required to approve the native consent review in tests.');
  await app.evaluate(({ dialog }) => {
    globalThis.__consentDialogPrevious = dialog.showMessageBox;
    dialog.showMessageBox = async (_window, options) => {
      if (options?.message !== 'Accept the FrostByte 1.0 terms and privacy notice?') return globalThis.__consentDialogPrevious.call(dialog, _window, options);
      globalThis.__consentNativeReview = structuredClone(options);
      return { response: 1 };
    };
  });
  try {
    await page.locator('#accept-terms').check();
    await page.locator('#welcome-continue').click();
    await expect(page.locator('#welcome')).not.toBeVisible();
  } finally {
    await app.evaluate(({ dialog }) => {
      if (globalThis.__consentDialogPrevious) dialog.showMessageBox = globalThis.__consentDialogPrevious;
      delete globalThis.__consentDialogPrevious;
    });
  }
}
