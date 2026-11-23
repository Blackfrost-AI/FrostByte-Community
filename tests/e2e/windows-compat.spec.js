import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import parseTorrent, { toTorrentFile } from 'parse-torrent';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packagedExecutable = process.env.FROSTBYTE_EXECUTABLE;
const argsFor = sources => packagedExecutable ? sources : [project, ...sources];
let app, page, home, downloads, destination, torrentFile, magnet, files, errors;
const secondProcesses = new Set();

async function state() {
  const result = await page.evaluate(() => window.frostbyte.getState());
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

async function launch(sources = []) {
  app = await electron.launch({
    executablePath: packagedExecutable,
    args: argsFor(sources),
    cwd: project,
    env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TAB: '', FROSTBYTE_HF_PROBE: '' },
    timeout: 30_000,
  });
  page = await app.firstWindow(); await acceptBetaTerms(page, app);
  await app.evaluate(({ dialog }) => {
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      if (['Start this Hugging Face download?'].includes(options?.message)) {
        return { response: 1 };
      }
      return previous.call(dialog, window, options);
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.frostbyte && document.querySelector('#nav .nav.on'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const current = await state();
  expect(current.platform).toBe('win32');
  expect(current.appDir).toBe(home);
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(path.join(home, 'electron'));
  if (packagedExecutable) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
}

async function expectNoTransfer() {
  const current = await state();
  expect(current.torrents).toEqual([]);
  expect(current.downloads).toEqual([]);
  expect(current.library).toEqual([]);
  expect(fs.readdirSync(downloads)).toEqual([]);
  expect(fs.readdirSync(destination)).toEqual([]);
}

async function expectReview(source, withFiles = false) {
  await expect(page.locator('#modal h3')).toHaveText('Add a download');
  await expect(page.locator('#dl-magnet')).toHaveValue(source);
  await expect(page.locator('#modal')).toContainText('Downloads start when you confirm.');
  if (withFiles) await expect(page.locator('#dl-files input')).toHaveCount(files.length);
  await expectNoTransfer();
}

async function cancelReview() {
  await page.locator('#modal-acts').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#modal')).toBeHidden();
  await expectNoTransfer();
}

// This is a real second Electron process, not an emitted event or an IPC mock.
// The same isolated profile exercises Electron's native single-instance lock.
async function secondLaunch(source, workingDirectory = project) {
  const executable = await app.evaluate(() => process.execPath);
  const child = spawn(executable, argsFor([source]), {
    cwd: workingDirectory,
    env: { ...process.env, FROSTBYTE_HOME: home, FROSTBYTE_TAB: '', FROSTBYTE_HF_PROBE: '' },
    stdio: 'ignore',
    windowsHide: true,
  });
  secondProcesses.add(child);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Second instance did not hand off and exit.')); }, 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`Second instance exited with code ${code}, signal ${signal}.`));
      });
    });
  } finally {
    secondProcesses.delete(child);
  }
}

test.describe('Windows desktop compatibility', () => {
  test.skip(process.platform !== 'win32', 'Requires real Windows Electron; do not spoof the renderer platform.');

  test.beforeEach(async () => {
    app = page = undefined;
    errors = [];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'FrostByte Windows review '));
    downloads = path.join(home, 'Default downloads');
    destination = path.join(home, 'Chosen model files');
    fs.mkdirSync(downloads);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
      downloadDir: downloads, sparkHost: '', catalogUrl: '', extraTrackers: '',
      upnpEnabled: false, dhtEnabled: false, openAtLogin: false,
      confirmExitSeeding: false, confirmBigPull: false,
    }));

    // Self-made metadata only: no tracker, web seed, peer, or content download.
    // Private mode also prevents discovery if someone later extends this fixture.
    const entries = [
      { name: 'config.json', bytes: Buffer.from('{"fixture":"windows-review"}\n') },
      { name: 'update.txt', bytes: Buffer.from('A local review fixture, not an executable update.\n') },
      { name: 'weights.gguf', bytes: Buffer.from('Not model weights. Harmless review test data.\n') },
    ];
    const metadata = toTorrentFile({
      info: {
        name: 'Windows review files', private: 1, 'piece length': 16_384,
        pieces: crypto.createHash('sha1').update(Buffer.concat(entries.map(file => file.bytes))).digest(),
        files: entries.map(file => ({ length: file.bytes.length, path: [file.name] })),
      },
      announce: [], urlList: [],
    });
    const parsed = await parseTorrent(metadata);
    expect(parsed.private).toBe(true);
    expect(parsed.announce).toEqual([]);
    expect(parsed.urlList).toEqual([]);
    files = parsed.files;
    const sources = path.join(home, 'Incoming torrent files');
    fs.mkdirSync(sources);
    torrentFile = path.join(sources, 'A config and update.TORRENT');
    fs.writeFileSync(torrentFile, metadata);
    // The automatic preview has DHT disabled and no trackers or direct peers.
    // We cancel it while metadata is unavailable, without ever pressing Download.
    magnet = `magnet:?xt=urn:btih:${parsed.infoHash}&dn=Windows%20review%20files`;
  });

  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      await page.screenshot({ path: info.outputPath('windows-review-failure.png') }).catch(() => {});
    }
    for (const child of secondProcesses) child.kill();
    secondProcesses.clear();
    try { await app?.close(); }
    finally { if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    expect(errors).toEqual([]);
  });

  test('uses This PC and a working Ctrl+F shortcut in an isolated profile', async () => {
    await launch();
    await expect(page.locator('#omni-shortcut')).toHaveText('Ctrl+F');
    // Navigate before focusing a Transfers control.
    await page.locator('#nav [data-tab="transfers"]').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    // Keep the select closed: an open native dropdown captures accelerators.
    // Focus another control so the shortcut must actually move focus to search.
    await page.locator('#transfers-device').focus();
    await expect(page.locator('#transfers-device')).toBeFocused();
    // Playwright's CDP keyboard dispatch bypasses Electron's native menu
    // accelerators on Windows. Send native Electron input to the focused
    // window so this checks the advertised Ctrl+F shortcut itself.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isFocused())).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.sendInputEvent({type:'keyDown',keyCode:'F',modifiers:['control']});
      contents.sendInputEvent({type:'keyUp',keyCode:'F',modifiers:['control']});
    });
    await expect(page.locator('#omni')).toBeFocused();
    await page.locator('#btn-add').click();
    await expect(page.locator('#dl-target option[value="mac"]')).toHaveText('This PC');
    await expect(page.locator('#dl-target option[value="spark"]')).toHaveJSProperty('disabled', true);
    await cancelReview();
  });

  test('startup torrent paths with spaces open review and preserve file and folder choices before confirmation', async () => {
    await launch([torrentFile]);
    await expectReview(torrentFile, true);
    await expect(page.locator('#dl-destination')).toHaveText(downloads);
    await page.locator('#dl-none').click();
    await expect(page.locator('#modal-acts button.primary')).toBeDisabled();
    await page.locator('#dl-filter').fill('config.json');
    await expect(page.locator('#dl-files input')).toHaveCount(1);
    await page.locator('#dl-files input').check();
    await page.locator('#dl-filter').fill('update.txt');
    await page.locator('#dl-files input').check();

    // Only the native chooser is substituted, as in the existing desktop specs.
    // The review state and main-process source inspection remain real.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, destination);
    await page.locator('#dl-folder').click();
    await expect(page.locator('#dl-destination')).toHaveText(destination);
    await page.locator('#dl-filter').fill('');
    await expect(page.locator('#dl-files input:checked')).toHaveCount(2);
    const selected = await page.locator('#dl-files input:checked').evaluateAll(inputs => inputs.map(input => input.dataset.torrentFile));
    expect(selected).toEqual(files.filter(file => /(?:config\.json|update\.txt)$/.test(file.path)).map(file => file.path.replaceAll('\\', '/')));
    await expect(page.locator('#dl-summary')).toContainText('2 of 3 files');
    await expect(page.locator('#modal-acts button.primary')).toBeEnabled();
    expect((await state()).settings.downloadDir).toBe(downloads);
    await expectNoTransfer();
    await cancelReview();
  });

  test('startup magnet arguments open a cancellable review without starting a transfer', async () => {
    await launch([magnet]);
    await expectReview(magnet);
    await expect(page.locator('#dl-file-picker')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();
    await expectNoTransfer();
  });

  test('a second process restores the existing window and reviews torrent and magnet arguments', async () => {
    await launch();
    const originalWindow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);

    // Use a relative .torrent path to also cover Explorer's launch directory.
    for (const source of [path.relative(home, torrentFile), magnet]) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
      await secondLaunch(source, home);
      await expectReview(source === magnet ? magnet : torrentFile, source !== magnet);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        // Windows can deny foreground activation even after win.focus() is
        // requested. The reliable application contract is that the original
        // window is made visible and restored for the handed-off review.
        return windows.length === 1 && windows[0].isVisible() && !windows[0].isMinimized();
      })).toBe(true);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)).toBe(originalWindow);
      await cancelReview();
    }
  });

  test('case-variant inventory paths retain their exact sharing manifest', async () => {
    const inventoryRoot = path.join(home, 'Inventory files');
    const model = path.join(inventoryRoot, 'owner', 'CaseModel');
    fs.mkdirSync(model, { recursive: true });
    const reviewed = Buffer.from('{"reviewed":true}\n');
    fs.writeFileSync(path.join(model, 'config.json'), reviewed);
    fs.writeFileSync(path.join(model, 'private-note.txt'), 'must not be shared');
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
      downloadedItems: [{
        source: 'hf', repoId: 'owner/CaseModel', name: 'owner/CaseModel',
        destination: inventoryRoot, relative: 'owner/CaseModel',
        files: [{ relative: 'owner/CaseModel/config.json', size: reviewed.length, revision: 'a'.repeat(40), updatedAt: 1 }],
        updatedAt: 1, shareable: true,
      }],
    }));
    await launch();
    await app.evaluate(({ dialog }) => {
      const previous = dialog.showMessageBox;
      dialog.showMessageBox = async (window, options) => options?.buttons?.includes('Share with peers')
        ? { response: options.buttons.indexOf('Share with peers') }
        : previous.call(dialog, window, options);
    });

    // NTFS resolves this spelling to the same object, but JavaScript string
    // equality does not. The main process must retain the inventory manifest.
    const caseVariant = model.toUpperCase();
    const result = await page.evaluate(value => window.frostbyte.shareFolder(value, 'Case model'), caseVariant);
    expect(result.ok, result.error).toBe(true);
    const shared = (await state()).torrents.find(item => item.inventoryId);
    expect(shared.inventoryId).toMatch(/^hf:/);
    expect(shared.files.map(file => file.path)).toEqual(['config.json']);
    expect(shared.files.some(file => /private-note/i.test(file.path))).toBe(false);
  });

  test('optional live HuggingFace search downloads one verified config and preserves it after relaunch', async () => {
    test.skip(process.env.FROSTBYTE_LIVE_HF !== '1', 'Set FROSTBYTE_LIVE_HF=1 for the native Windows release smoke test.');
    test.setTimeout(120_000);
    const repoId = 'Qwen/Qwen3-0.6B';
    await launch();
    await page.locator('#nav [data-tab="hf"]').click();
    await page.locator('#hf-q').fill(repoId);
    await page.locator('#hf-go').click();
    const result = page.locator(`#grid-hf tr[data-id="${repoId}"]`);
    await expect(result).toBeVisible({ timeout: 30_000 });
    await result.click();
    await expect(page.locator('#hf-custom')).toBeVisible({ timeout: 30_000 });
    if (!await page.locator('#hf-custom').evaluate(element => element.open)) await page.locator('#hf-custom summary').click();
    await page.locator('#hf-pick-none').click();
    await page.locator('#hf-files input[data-f="config.json"]').check();
    await expect(page.locator('#hf-selinfo')).toHaveText('1 file selected');
    await expect(page.locator('#hf-target option[value="mac"]')).toHaveText('This PC');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, destination);
    await page.locator('#hf-folder').click();
    await expect.poll(async () => (await state()).settings.downloadDir).toBe(destination);
    await expect(page.locator('#hf-files input:checked')).toHaveCount(1);
    await expect(page.locator('#hf-files input[data-f="config.json"]')).toBeChecked();
    const displayedCommit = (await page.locator('.hf-revision span[title]').textContent()).trim();
    expect(displayedCommit).toMatch(/^[a-f0-9]{8}$/i);
    await page.locator('#hf-download').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    await expect.poll(async () => (await state()).downloads.find(item => item.repoId === repoId && item.filePath === 'config.json')?.status, { timeout: 45_000 }).toBe('done');
    const completedState = await state();
    expect(completedState.torrents).toEqual([]);
    expect(completedState.downloads).toHaveLength(1);
    const downloaded = completedState.downloads[0];
    expect(downloaded.revision).toMatch(/^[a-f0-9]{40}$/i);
    expect(downloaded.revision.slice(0, 8)).toBe(displayedCommit);
    expect(downloaded.dest).toBe(path.join(destination, 'Qwen', 'Qwen3-0.6B', 'config.json'));
    const bytes = fs.readFileSync(downloaded.dest);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(64 * 1024);
    expect(fs.readdirSync(path.dirname(downloaded.dest))).toEqual(['config.json']);
    expect(fs.readdirSync(downloads)).toEqual([]);

    // Validate the exact commit's published blob identity, without downloading
    // another copy or trusting only the app's completion label.
    const metadataResponse = await fetch(`https://huggingface.co/api/models/${repoId}/revision/${downloaded.revision}?blobs=true`, { signal: AbortSignal.timeout(20_000) });
    expect(metadataResponse.ok).toBe(true);
    const metadata = await metadataResponse.json();
    expect(metadata.sha).toBe(downloaded.revision);
    const publishedFile = metadata.siblings.find(file => file.rfilename === 'config.json');
    expect(publishedFile.size).toBe(bytes.length);
    expect(publishedFile.blobId).toMatch(/^[a-f0-9]{40}$/i);
    const blobHash = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    expect(blobHash).toBe(publishedFile.blobId.toLowerCase());
    const config = JSON.parse(bytes.toString('utf8'));
    expect(config.model_type).toBe('qwen3');
    expect(config.architectures).toContain('Qwen3ForCausalLM');
    expect(config.hidden_size).toBeGreaterThan(0);
    expect(config.num_hidden_layers).toBeGreaterThan(0);

    await app.close();
    await launch();
    const restored = await state();
    expect(restored.downloads).toHaveLength(1);
    expect(restored.downloads[0]).toMatchObject({
      id: downloaded.id, repoId, filePath: 'config.json', revision: downloaded.revision,
      dest: downloaded.dest, status: 'done', downloaded: bytes.length,
    });
    expect(restored.settings.downloadDir).toBe(destination);
    expect(restored.torrents).toEqual([]);
    expect(fs.readFileSync(downloaded.dest)).toEqual(bytes);
    await page.locator('#nav [data-tab="transfers"]').click();
    await expect(page.locator('#view-transfers')).toContainText('config.json');
    fs.mkdirSync(path.join(project, 'test-results', 'screenshots'), { recursive: true });
    await page.screenshot({ path: path.join(project, 'test-results', 'screenshots', 'windows-hf-complete.png') });
  });
});
