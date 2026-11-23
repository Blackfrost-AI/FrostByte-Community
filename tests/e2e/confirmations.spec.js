import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';

let app, page, home;
async function launch() {
  app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE,
    args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'],
    env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TAB: '', FROSTBYTE_HF_PROBE: '' },
  });
  page = await app.firstWindow();
  await acceptBetaTerms(page, app);
  await app.evaluate(({ dialog, clipboard }) => {
    globalThis.confirmationFixture = { reviews: [], responses: [], fetches: [], copies: [] };
    dialog.showMessageBox = async (_window, options) => {
      const fixture = globalThis.confirmationFixture;
      fixture.reviews.push(structuredClone(options));
      return fixture.responses.shift() || { response: 0 };
    };
    clipboard.writeText = async value => { globalThis.confirmationFixture.copies.push(value); };
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      globalThis.confirmationFixture.fetches.push(url.href);
      if (url.origin !== 'https://huggingface.co' || url.pathname !== '/api/models') {
        if (url.origin === 'https://huggingface.co' && url.pathname.startsWith('/api/models/fixture/model')) return new Response(JSON.stringify({
          id: 'fixture/model', sha: 'a'.repeat(40), siblings: [{ rfilename: 'config.json', size: 12 }], tags: [],
        }), { status: 200 });
        throw new Error('Unexpected fixture request');
      }
      return new Response(JSON.stringify([{ id: 'fixture/model', tags: ['license:mit'], downloads: 123 }]), { status: 200 });
    };
  });
}
const responses = values => app.evaluate((_electron, values) => { globalThis.confirmationFixture.responses = values; }, values);
const evidence = () => app.evaluate(() => globalThis.confirmationFixture);
async function search(query) {
  await page.locator('#nav [data-tab="hf"]').click();
  await page.locator('#hf-q').fill(query);
  await page.locator('#hf-go').click();
  await expect(page.locator('#hf-go')).toBeEnabled();
}
async function settings() {
  await page.locator('#nav [data-tab="settings"]').click();
  await page.locator('#settings-nav [data-sec="interface"]').click();
}

test.beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-confirmations-ui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'),
    dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false, autoCheckUpdates: false }));
  await launch();
});
test.afterEach(async () => { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); });

test('anonymous HF search and model details never prompt once the terms are accepted', async () => {
  await search('first model');
  await expect(page.locator('#grid-hf tbody tr')).toHaveCount(1);
  expect((await page.evaluate(() => window.frostbyte.hfModel('fixture/model'))).ok).toBe(true);
  const fixture = await evidence();
  expect(fixture.reviews).toHaveLength(0);
  expect(fixture.fetches.length).toBeGreaterThanOrEqual(2);
});

test('a remembered native choice survives restart and Settings restores prompts', async () => {
  await responses([{ response: 1, checkboxChecked: true }]);
  expect(await page.evaluate(() => window.frostbyte.copyText('first link'))).toBe(true);
  let fixture = await evidence();
  expect(fixture.reviews).toHaveLength(1);
  expect(fixture.reviews[0].checkboxLabel).toContain('Never show again');
  expect(fixture.reviews[0].checkboxChecked).toBe(false);
  expect(fixture.reviews[0].buttons).toContain('Details…');
  expect(fixture.reviews[0].defaultId).toBe(0);
  expect(await page.evaluate(() => window.frostbyte.copyText('second link'))).toBe(true);
  expect((await evidence()).reviews).toHaveLength(1);
  await settings();
  await expect(page.locator('#confirmations-status')).toHaveText('1 remembered choice.');

  await app.close(); await launch();
  expect(await page.evaluate(() => window.frostbyte.copyText('after restart'))).toBe(true);
  expect((await evidence()).reviews).toHaveLength(0);
  await settings();
  await page.locator('#reset-confirmations').click();
  await expect(page.locator('#confirmations-status')).toHaveText('No remembered confirmations.');
  await expect(page.locator('#reset-confirmations')).toBeDisabled();
  await responses([{ response: 0, checkboxChecked: false }]);
  expect(await page.evaluate(() => window.frostbyte.copyText('after reset'))).toBe(false);
  fixture = await evidence();
  expect(fixture.reviews).toHaveLength(1);
  expect(fixture.copies).not.toContain('after reset');
});

test('Details preserves the full copy value, Cancel remembers nothing, and approved copies stay quiet', async () => {
  const value = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=${'Long%20fixture'.repeat(30)}`;
  await responses([{ response: 2, checkboxChecked: true }, { response: 0, checkboxChecked: true }]);
  expect(await page.evaluate(value => window.frostbyte.copyText(value), value)).toBe(false);
  let fixture = await evidence();
  expect(fixture.reviews).toHaveLength(2);
  expect(fixture.reviews[0].detail.length).toBeLessThan(250);
  expect(fixture.reviews[1].detail).toBe(JSON.stringify(value));
  expect(fixture.reviews[1].checkboxChecked).toBe(true);
  expect(fixture.copies).toEqual([]);
  await settings();
  await expect(page.locator('#confirmations-status')).toHaveText('No remembered confirmations.');
  await responses([{ response: 1, checkboxChecked: true }]);
  expect(await page.evaluate(value => window.frostbyte.copyText(value), value)).toBe(true);
  expect(await page.evaluate(() => window.frostbyte.copyText('another link'))).toBe(true);
  fixture = await evidence();
  expect(fixture.reviews).toHaveLength(3);
  expect(fixture.copies).toEqual([value, 'another link']);
  await expect(page.locator('#confirmations-status')).toHaveText('1 remembered choice.');
});

test('renderer settings cannot grant permission or suppress system and privacy reviews', async () => {
  const forged = await page.evaluate(() => window.frostbyte.setSettings({ confirmations: { remembered: 99 }, skipConfirmations: true }));
  expect(forged.ok).toBe(false);
  expect((await page.evaluate(() => window.frostbyte.getState())).data.confirmations.remembered).toBe(0);
  const exposed = await page.evaluate(() => window.frostbyte.setSettings({ upnpEnabled: true }));
  expect(exposed.ok).toBe(true); expect(exposed.data.cancelled).toBe(true);
  const fixture = await evidence();
  expect(fixture.reviews).toHaveLength(1);
  expect(fixture.reviews[0].checkboxLabel).toBeUndefined();
  expect((await page.evaluate(() => window.frostbyte.getState())).data.settings.upnpEnabled).toBe(false);
});

test('refreshes and new actions during an intentional quit are rejected without error alerts', async () => {
  await page.evaluate(() => { window.quitNotices = []; window.frostbyte.onNotice(value => window.quitNotices.push(value)); });
  await app.evaluate(async ({ app }, loaderPath) => {
    const root = app.getAppPath();
    const require = process.getBuiltinModule('module').createRequire(root + '/src/main/index.js');
    const { IpfsTransfers } = await require(loaderPath)(root + '/src/main/ipfs.js');
    const close = IpfsTransfers.prototype.close;
    IpfsTransfers.prototype.close = async function () {
      await new Promise(resolve => { globalThis.finishQuitFixture = resolve; });
      return close.call(this);
    };
    app.quit();
  }, path.resolve('tests/e2e/load-main.cjs'));
  try {
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.finishQuitFixture))).toBe(true);
    const refreshed = await page.evaluate(() => window.frostbyte.getState());
    const changed = await page.evaluate(() => window.frostbyte.setSettings({ upnpEnabled: true }));
    expect(refreshed.ok).toBe(false); expect(refreshed.error).toContain('shutting down');
    expect(changed.ok).toBe(false); expect(changed.error).toContain('shutting down');
    expect(await page.evaluate(() => window.quitNotices)).toEqual([]);
    expect((await evidence()).reviews).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).upnpEnabled).toBe(false);
  } finally {
    await app.evaluate(() => { globalThis.finishQuitFixture?.(); }).catch(() => {});
  }
});
