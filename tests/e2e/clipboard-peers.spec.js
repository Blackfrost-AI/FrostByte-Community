import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';

let app, page, home;
const hash = '9876543210abcdef9876543210abcdef98765432';
const magnet = `magnet:?xt=urn:btih:${hash}&dn=Connection%20fixture`;
test.describe.serial('Native copy and quiet peer discovery', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-copy-peers-'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false }));
    app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TAB: '', FROSTBYTE_HF_PROBE: '' } });
    page = await app.firstWindow(); await acceptBetaTerms(page, app);
    await app.evaluate(({ dialog }) => {
      const previous = dialog.showMessageBox;
      dialog.showMessageBox = async (window, options) => [
        'Find torrent peers?',
        'Copy to clipboard?',
      ].includes(options?.message) ? { response: 1 } : previous.call(dialog, window, options);
    });
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
    await app.evaluate(async ({ app, clipboard, ClipboardItem }, loaderPath) => {
      const modulePath = app.getAppPath() + '/src/main/index.js';
      const require = process.getBuiltinModule('module').createRequire(modulePath);
      globalThis.copyMain = await require(loaderPath)(modulePath);
      globalThis.savedClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => {
        const contents = {}; for (const type of item.types) contents[type] = await item.getType(type); return new ClipboardItem(contents);
      }));
      globalThis.originalClipboardWrite = clipboard.writeText;
    }, path.resolve('tests/e2e/load-main.cjs'));
    await page.evaluate(() => { window.notices = []; window.frostbyte.onNotice(n => window.notices.push(n)); });
    const added = await page.evaluate(source => window.frostbyte.add(source), magnet);
    expect(added.ok).toBe(true);
    await page.locator('#nav [data-tab="transfers"]').click();
  });
  test.afterAll(async () => {
    if (app) await app.evaluate(async ({ clipboard }) => {
      if (globalThis.originalClipboardWrite) clipboard.writeText = globalThis.originalClipboardWrite;
      if (globalThis.savedClipboard?.length) await clipboard.write(globalThis.savedClipboard);
      else if (globalThis.savedClipboard) clipboard.clear();
    }).catch(() => {});
    await app?.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true });
  });
  test('Copy link writes the actual magnet to the operating system clipboard', async () => {
    const row = page.locator(`.tor[data-hash="${hash}"]`);
    await row.getByRole('button', { name: 'Copy link', exact: true }).click();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain(`xt=urn:btih:${hash}`);
    expect(copied).toMatch(/^magnet:\?/);
    await expect(page.locator('#toasts')).toContainText('Magnet link copied.');
  });
  test('a failed clipboard write shows an error and never claims success', async () => {
    await page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });
    await app.evaluate(({ clipboard }) => { clipboard.writeText = () => { throw new Error('Fixture clipboard unavailable'); }; });
    await page.locator(`.tor[data-hash="${hash}"]`).getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(page.locator('#toasts')).toContainText('Could not copy the link');
    await expect(page.locator('#toasts')).not.toContainText('Magnet link copied');
    await app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.originalClipboardWrite; });
  });
  test('repeated empty announces stay in the transfer row; a peer clears the waiting status', async () => {
    await page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });
    await app.evaluate(() => {
      const engine = globalThis.copyMain.engine, torrent = engine.client.torrents[0];
      globalThis.emptyAnnounces = 0; engine.on('no-peers', () => globalThis.emptyAnnounces++);
      for (let i = 0; i < 100; i++) torrent.emit('noPeers', i % 2 ? 'tracker' : 'dht');
    });
    await expect(page.locator(`.tor[data-hash="${hash}"]`)).toContainText('Waiting for peers — retrying automatically');
    expect(await app.evaluate(() => globalThis.emptyAnnounces)).toBe(1);
    expect(await page.evaluate(() => window.notices.some(n => /No peers answered/.test(n.message)))).toBe(false);
    await expect(page.locator('#toasts')).not.toContainText('No peers');
    await app.evaluate(() => globalThis.copyMain.engine.client.torrents[0].emit('wire'));
    await expect(page.locator(`.tor[data-hash="${hash}"]`)).not.toContainText('Waiting for peers');
  });
});
