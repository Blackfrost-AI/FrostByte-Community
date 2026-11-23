import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';
import { createPublisherAccount } from '../../src/main/publisher.js';

let app, page, home;
const password = 'publisher-ui-fixture-password';

async function launch() {
  app = await electron.launch({ args: ['.', '--dev'], env: { ...process.env,
    FROSTBYTE_HOME: home, FROSTBYTE_TEST_DIRECT_PEERS: '1', FROSTBYTE_TAB: '', FROSTBYTE_HF_PROBE: '' } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app);
  await app.evaluate(({ safeStorage, dialog }) => {
    // Linux CI has no desktop key ring. This adapter exists only in this test
    // process. macOS and Windows exercise their real Keychain/DPAPI backend.
    if (process.platform === 'linux') {
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.getSelectedStorageBackend = () => 'publisher-ui-fixture';
      safeStorage.encryptString = value => Buffer.from('publisher-ui-fixture:' + value);
      safeStorage.decryptString = value => {
        const raw = value.toString();
        if (!raw.startsWith('publisher-ui-fixture:')) throw new Error('fixture protection mismatch');
        return raw.slice('publisher-ui-fixture:'.length);
      };
    }
    globalThis.publisherApproval = true; globalThis.publisherReviews = [];
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (win, options) => {
      if (['Show your publisher recovery phrase?', 'Remove this publisher identity from FrostByte?'].includes(options.message)) {
        globalThis.publisherReviews.push(options.message);
        return { response: globalThis.publisherApproval ? 1 : 0 };
      }
      return previous(win, options);
    };
  });
  await page.locator('#nav [data-tab="settings"]').click();
  await page.locator('[data-sec="publisher"]').click();
  await expect(page.locator('#sec-publisher')).toBeVisible();
}

test.beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-publisher-ui-'));
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'),
    dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false }));
  await launch();
});
test.afterEach(async () => { await app?.close(); await fs.rm(home, { recursive: true, force: true }); });

async function create() {
  await page.locator('#pub-create-name').fill('Publisher fixture');
  await page.locator('#pub-create-pass').fill(password);
  await page.locator('#pub-create-pass2').fill(password);
  await page.locator('#btn-pub-create').click();
  await expect(page.locator('#publisher-reveal-card')).toBeVisible();
  return page.locator('#pub-reveal-mnemonic').inputValue();
}
async function showPhrase() {
  await page.locator('#pub-unlock-pass').fill(password);
  await page.locator('#btn-pub-export').click();
}
async function acknowledge() {
  await page.locator('#pub-backup-ack').check();
  await page.locator('#btn-pub-reveal-done').click();
  await expect(page.locator('#publisher-reveal-card')).toBeHidden();
}

test('native protected setup survives restart and requires backup before unlock', async () => {
  const phrase = await create();
  expect(phrase.split(' ')).toHaveLength(24);
  await expect(page.locator('#btn-pub-reveal-done')).toBeDisabled();
  await expect(page.locator('#pub-create-pass')).toHaveValue('');
  const disk = await fs.readFile(path.join(home, 'state.json'), 'utf8');
  const record = JSON.parse(disk).publisherAccount;
  expect(record.schema).toBe(2); expect(record.backupConfirmedAt).toBe(0);
  expect(disk.includes(phrase)).toBe(false); expect(disk.includes(password)).toBe(false);
  expect(record.encSecret).toBeUndefined(); expect(record.keyEnvelope).toBeTruthy();
  const publicState = (await page.evaluate(() => window.frostbyte.getState())).data.publisher;
  expect(publicState.keyEnvelope).toBeUndefined(); expect(publicState.backupRequired).toBe(true);
  await app.close(); app = null; await launch();
  await expect(page.locator('#publisher-backup-note')).toBeVisible();
  await expect(page.locator('#btn-pub-unlock')).toBeDisabled();
  await showPhrase(); await expect(page.locator('#publisher-reveal-card')).toBeVisible();
  expect(await page.locator('#pub-reveal-mnemonic').inputValue() === phrase).toBe(true);
  await acknowledge();
  await page.locator('#pub-unlock-pass').fill(password); await page.locator('#btn-pub-unlock').click();
  await expect(page.locator('#publisher-status')).toContainText('Unlocked for this session');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await expect(page.locator('#publisher-status')).toContainText('Locked');
  expect((await page.evaluate(() => window.frostbyte.getState())).data.inventory).toEqual([]);
});

test('navigation, blur, and timeout clear recovery text without losing pending setup', async () => {
  await create();
  await page.locator('[data-sec="interface"]').click();
  await expect(page.locator('#pub-reveal-mnemonic')).toHaveValue('');
  await page.locator('[data-sec="publisher"]').click();
  await expect(page.locator('#publisher-backup-note')).toBeVisible();
  await showPhrase(); await expect(page.locator('#publisher-reveal-card')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('#pub-reveal-mnemonic')).toHaveValue('');
  await expect(page.locator('#publisher-reveal-card')).toBeHidden();
  await page.clock.install();
  await showPhrase(); await expect(page.locator('#publisher-reveal-card')).toBeVisible();
  await page.clock.fastForward(61_000);
  await expect(page.locator('#pub-reveal-mnemonic')).toHaveValue('');
  await expect(page.locator('#publisher-reveal-card')).toBeHidden();
  await expect(page.locator('#btn-pub-unlock')).toBeDisabled();
});

test('export and removal respect native cancellation and clear password inputs', async () => {
  await create(); await acknowledge();
  await app.evaluate(() => { globalThis.publisherApproval = false; });
  await showPhrase();
  await expect(page.locator('#pub-unlock-pass')).toHaveValue('');
  await expect(page.locator('#publisher-reveal-card')).toBeHidden();
  await page.locator('#btn-pub-clear').click();
  await expect(page.locator('#publisher-session-card')).toBeVisible();
  await app.evaluate(() => { globalThis.publisherApproval = true; });
  await page.locator('#btn-pub-clear').click();
  await expect(page.locator('#publisher-create-card')).toBeVisible();
  expect(JSON.parse(await fs.readFile(path.join(home, 'state.json'), 'utf8')).publisherAccount).toBeUndefined();
});

test('recovery phrase restores the same identity after explicit removal', async () => {
  const phrase = await create(); await acknowledge();
  const key = (await page.evaluate(() => window.frostbyte.getState())).data.publisher.pubKey;
  await page.locator('#btn-pub-clear').click(); await expect(page.locator('#publisher-import-card')).toBeVisible();
  await page.locator('#pub-import-mnemonic').fill(phrase);
  await page.locator('#pub-import-name').fill('Restored fixture');
  await page.locator('#pub-import-pass').fill(password);
  await page.locator('#btn-pub-import').click();
  await expect(page.locator('#publisher-reveal-card')).toBeVisible();
  await expect(page.locator('#pub-import-mnemonic')).toHaveValue('');
  await acknowledge();
  expect((await page.evaluate(() => window.frostbyte.getState())).data.publisher.pubKey).toBe(key);
});

test('legacy development identity gains OS protection through recovery', async () => {
  await app.close(); app = null;
  const legacy = createPublisherAccount({ petname: 'Legacy fixture', password });
  let state = {}; try { state = JSON.parse(await fs.readFile(path.join(home, 'state.json'), 'utf8')); } catch {}
  await fs.writeFile(path.join(home, 'state.json'), JSON.stringify({ ...state, publisherAccount: legacy.account }));
  await launch();
  await expect(page.locator('#publisher-backup-note')).toContainText('key store');
  await showPhrase(); await expect(page.locator('#publisher-reveal-card')).toBeVisible();
  expect(await page.locator('#pub-reveal-mnemonic').inputValue() === legacy.mnemonic).toBe(true);
  await acknowledge();
  const record = JSON.parse(await fs.readFile(path.join(home, 'state.json'), 'utf8')).publisherAccount;
  expect(record.schema).toBe(2); expect(record.pubKey).toBe(legacy.account.pubKey);
});

test('unavailable OS protection disables setup with an actionable state', async () => {
  await app.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = () => false; });
  await expect(page.locator('#publisher-status')).toContainText('operating system key store');
  await expect(page.locator('#btn-pub-create')).toBeDisabled();
  await expect(page.locator('#btn-pub-import')).toBeDisabled();
  expect((await page.evaluate(() => window.frostbyte.getState())).data.publisher.present).toBe(false);
});
