import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { acceptBetaTerms } from './consent-helper.js';
import { TorrentEngine } from '../../src/main/torrent.js';

let app, page, home, errors, destination, riskyRepo, safeRepo;
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click();

function gguf(bytes = 64) {
  const head = Buffer.alloc(24);
  head.write('GGUF', 0, 'ascii'); head.writeUInt32LE(3, 4);
  head.writeBigUInt64LE(1n, 8); head.writeBigUInt64LE(0n, 16);
  return Buffer.concat([head, Buffer.alloc(bytes)]);
}
function evilPickle() {
  return Buffer.concat([Buffer.from([0x80, 0x02]), Buffer.from('cos\nsystem\n', 'ascii'),
    Buffer.from([0x8c, 0x02]), Buffer.from('hi', 'ascii'), Buffer.from([0x52, 0x2e])]);
}
function hfRecord(repoId, filePath, bytes) {
  return { id: filePath, repoId, revision: 'a'.repeat(40), filePath, baseDir: destination,
    dest: path.join(destination, repoId, filePath), status: 'done', downloaded: bytes };
}

async function launch() {
  app = await electron.launch({ args: ['.', '--dev'], env: { ...process.env, FROSTBYTE_HOME: home,
    FROSTBYTE_TEST_DIRECT_PEERS: '1', FROSTBYTE_HF_PROBE: '', FROSTBYTE_TAB: '' } });
  page = await app.firstWindow(); await acceptBetaTerms(page, app);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }) => {
    const previous = dialog.showMessageBox;
    globalThis.integrityShareReviews = [];
    dialog.showMessageBox = async (window, options) => {
      if (options?.buttons?.includes('Share with peers')) {
        globalThis.integrityShareReviews.push(structuredClone(options));
        if (globalThis.approveNextShare) { globalThis.approveNextShare = false; return { response: 1 }; }
        return { response: 0 }; // decline by default: tests assert refusal, not seeding
      }
      return previous.call(dialog, window, options);
    };
  });
  await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
}

test.beforeEach(async () => {
  errors = [];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-integrity-ui-')));
  destination = path.join(home, 'downloads');
  riskyRepo = 'owner/Risky-fixture'; safeRepo = 'owner/Safe-fixture';
  for (const [repo, files] of [
    [riskyRepo, [['config.json', Buffer.from('{}\n')], ['evil.pkl', evilPickle()]]],
    [safeRepo, [['model.gguf', gguf()]]],
  ]) {
    fs.mkdirSync(path.join(destination, repo), { recursive: true });
    for (const [name, bytes] of files) fs.writeFileSync(path.join(destination, repo, name), bytes);
  }
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: destination,
    dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false, seedOnComplete: false }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    hfDownloads: [
      hfRecord(riskyRepo, 'config.json', 3), hfRecord(riskyRepo, 'evil.pkl', evilPickle().length),
      hfRecord(safeRepo, 'model.gguf', gguf().length),
    ],
  }));
  await launch();
});
test.afterEach(async () => { await app?.close(); app = null; fs.rmSync(home, { recursive: true, force: true }); expect(errors).toEqual([]); });

function card(repo) { return page.locator('.inventory-item').filter({ has: page.locator('h4', { hasText: repo }) }); }

test('Scan control classifies formats, blocks risky sharing before any review, and never gates disable', async () => {
  await nav('library');
  await expect(card(riskyRepo)).toBeVisible();
  await expect(card(safeRepo)).toBeVisible();

  // Deterministic Scan control — no chat involved.
  await card(riskyRepo).locator('summary[aria-label^="Options"]').click();
  await card(riskyRepo).locator('[data-inventory-action="integrity"]').click();
  await expect(card(riskyRepo).locator('.inventory-origin.warn')).toContainText('Integrity: risky files', { timeout: 15000 });
  await expect(card(riskyRepo).locator('.inventory-origin.warn')).toContainText('sharing blocked');
  await card(riskyRepo).locator('summary[aria-label^="Options"]').click(); // close the menu

  await card(safeRepo).locator('summary[aria-label^="Options"]').click();
  await card(safeRepo).locator('[data-inventory-action="integrity"]').click();
  await expect(card(safeRepo).locator('.inventory-origin.ok')).toContainText('Integrity: safe formats', { timeout: 15000 });
  await card(safeRepo).locator('summary[aria-label^="Options"]').click(); // close the menu

  // Gate 2: enabling sharing on the risky item is refused before the share
  // review dialog ever opens, and the switch stays off.
  const riskyToggle = card(riskyRepo).getByRole('switch');
  await riskyToggle.click();
  await expect(card(riskyRepo).locator('.inventory-error[role="alert"]')).toContainText('risky format', { timeout: 15000 });
  await expect(riskyToggle).toHaveAttribute('aria-checked', 'false');
  expect(await app.evaluate(() => globalThis.integrityShareReviews.length)).toBe(0);

  // The safe item reaches the review dialog (declined here) — the gate passes it.
  await card(safeRepo).getByRole('switch').click();
  await expect.poll(() => app.evaluate(() => globalThis.integrityShareReviews.length)).toBe(1);

  // Results persist across reload without a rescan.
  await page.reload(); await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
  await nav('library');
  await expect(card(riskyRepo).locator('.inventory-origin.warn')).toContainText('Integrity: risky files');
  await expect(card(safeRepo).locator('.inventory-origin.ok')).toContainText('Integrity: safe formats');
  const state = await page.evaluate(async () => (await window.frostbyte.getState()).data);
  const riskyEntries = Object.entries(state.aeonIntegrity).filter(([, row]) => row.format === 'risky-format');
  const safeEntries = Object.entries(state.aeonIntegrity).filter(([, row]) => row.format === 'safe-format');
  // The verdict persists under the inventory id AND its canonical folder key
  // (the scan handler mirrors it so every gate sees the same confirmed bytes).
  expect(riskyEntries.map(([id]) => id).filter(id => id.startsWith('hf:'))).toHaveLength(1);
  expect(riskyEntries.map(([id]) => id).filter(id => id.startsWith('folder:'))).toHaveLength(1);
  expect(safeEntries).toHaveLength(1);
  expect(riskyEntries[0][1].risky).toContain('owner/Risky-fixture/evil.pkl');
});

test('IPFS pre-download review lists formats and warns about code-executing files before confirm', async () => {
  await nav('transfers');
  await page.locator('#btn-ipfs').click();
  await expect(page.locator('#modal')).toContainText('Download from IPFS');
  // Fixture the preview so the review UI is exercised without a live swarm.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ipfs:inspect');
    ipcMain.handle('ipfs:inspect', () => ({ ok: true, data: { id: 'preview-fixture', name: 'Fixture collection',
      files: [
        { path: 'model.gguf', size: 88, cid: 'bafyfixture1' },
        { path: 'weights.pkl', size: 42, cid: 'bafyfixture2' },
        { path: 'notes.xyz', size: 7, cid: 'bafyfixture3' },
      ] } }));
  });
  await page.locator('#ipfs-source').fill('ipfs://QmbsqVAgHZ7dJ4XZi9sZPSHmGkeMJfZ66JstsZaA1x4sM4');
  await page.locator('#ipfs-preview').click();
  await expect(page.locator('#ipfs-files label')).toHaveCount(3);
  await expect(page.locator('#ipfs-files .ipfs-format.ok')).toHaveCount(1);
  await expect(page.locator('#ipfs-files .ipfs-format.warn')).toHaveCount(1);
  await expect(page.locator('#ipfs-files .ipfs-format.neutral')).toHaveCount(1);
  await expect(page.locator('#ipfs-files label').filter({ hasText: 'model.gguf' })).toContainText('gguf · expected data-only');
  await expect(page.locator('#ipfs-files label').filter({ hasText: 'weights.pkl' })).toContainText('pickle · can run code');
  // All selected by default: the warning names the risky file and the consequence.
  await expect(page.locator('#ipfs-format-warning')).toBeVisible();
  await expect(page.locator('#ipfs-format-warning')).toContainText('weights.pkl');
  await expect(page.locator('#ipfs-format-warning')).toContainText('cannot be shared while risky');
  // Deselecting the pickle clears the warning; the user keeps the choice.
  await page.locator('[data-ipfs-file="weights.pkl"]').uncheck();
  await expect(page.locator('#ipfs-format-warning')).toBeHidden();
  // Nothing downloaded: review only.
  const state = await page.evaluate(async () => (await window.frostbyte.getState()).data);
  expect(state.ipfs.downloads).toEqual([]);
});

test('a user scan that confirms risky files revokes an already-live share', async () => {
  await nav('library');
  await expect(card(safeRepo)).toBeVisible();
  // Share the safe model for real: approve the review dialog this time.
  await app.evaluate(({ dialog }) => {
    const previous = dialog.showMessageBox;
    globalThis.approveNextShare = true;
    dialog.showMessageBox = async (window, options) => {
      if (options?.buttons?.includes('Share with peers') && globalThis.approveNextShare) {
        globalThis.approveNextShare = false;
        return { response: 1 }; // approve
      }
      return previous.call(dialog, window, options);
    };
  });
  const safeToggle = card(safeRepo).getByRole('switch');
  await safeToggle.click();
  await expect(safeToggle).toHaveAttribute('aria-checked', 'true', { timeout: 20000 });
  // The share is live in the engine (inventory ids are hashed; match by path).
  const sharedPath = path.join(destination, safeRepo);
  const liveShares = async () => {
    const state = await page.evaluate(async () => (await window.frostbyte.getState()).data);
    return (state.torrents || []).filter(t => t.explicitShare && !t.paused && (t.dataPath === sharedPath || t.path === sharedPath));
  };
  await expect.poll(async () => (await liveShares()).length > 0, { timeout: 20000 }).toBe(true);
  // Now rewrite the shared weights into a code-executing pickle on disk,
  // keeping the recorded size so the inventory row stays valid.
  const target = path.join(destination, safeRepo, 'model.gguf');
  const original = fs.statSync(target).size;
  const evil = evilPickle();
  const padded = evil.length <= original ? Buffer.concat([evil, Buffer.alloc(original - evil.length)]) : evil;
  fs.writeFileSync(target, padded);
  // Re-scan: the confirmed risky verdict must stop the live share.
  await card(safeRepo).locator('summary[aria-label^="Options"]').click();
  await card(safeRepo).locator('[data-inventory-action="integrity"]').click();
  await expect(card(safeRepo).locator('.inventory-origin.warn')).toContainText('Integrity: risky files', { timeout: 20000 });
  await expect(card(safeRepo).getByRole('switch')).toHaveAttribute('aria-checked', 'false', { timeout: 15000 });
  await expect.poll(async () => (await liveShares()).length, { timeout: 20000 }).toBe(0);
  // Files are kept — revocation stops sharing, it never deletes.
  expect(fs.existsSync(target)).toBe(true);
});

test('sharing an unrecorded folder with a risky file is refused before seeding', async () => {
  // A folder with no download record, no discovery entry, no library row —
  // the old code seeded it without any integrity scan.
  const loose = path.join(home, 'loose-weights');
  fs.mkdirSync(loose, { recursive: true });
  fs.writeFileSync(path.join(loose, 'model.gguf'), gguf());
  fs.writeFileSync(path.join(loose, 'payload.pkl'), evilPickle());
  // Grant the seed capability through the real picker (stubbed to this folder).
  await app.evaluate(({ dialog }, target) => {
    const previous = dialog.showOpenDialog;
    dialog.showOpenDialog = async (window, options) => {
      if (options?.title === 'Pick a model file or folder to share') return { canceled: false, filePaths: [target] };
      return previous.call(dialog, window, options);
    };
  }, loose);
  const result = await page.evaluate(async target => {
    await window.frostbyte.pickModelFolder();
    const response = await window.frostbyte.shareFolder(target, 'loose');
    return { ok: response.ok, message: response.error || '', data: response.data || null };
  }, loose);
  expect(result.ok, result.message).toBe(false);
  expect(result.message).toContain('risky');
  // Nothing was seeded: no live share for that path.
  const state = await page.evaluate(async () => (await window.frostbyte.getState()).data);
  expect((state.torrents || []).filter(t => (t.dataPath === loose || t.path === loose) && !t.paused)).toHaveLength(0);
});

test('sharing an unrecorded folder of safe formats still works', async () => {
  const loose = path.join(home, 'loose-safe');
  fs.mkdirSync(loose, { recursive: true });
  fs.writeFileSync(path.join(loose, 'model.gguf'), gguf());
  // Approve this one share review through the launch-time stub, and grant the
  // seed capability through the real picker (stubbed to this folder).
  await app.evaluate(({ dialog }, target) => {
    globalThis.approveNextShare = true;
    const previous = dialog.showOpenDialog;
    dialog.showOpenDialog = async (window, options) => {
      if (options?.title === 'Pick a model file or folder to share') return { canceled: false, filePaths: [target] };
      return previous.call(dialog, window, options);
    };
  }, loose);
  const result = await page.evaluate(async target => {
    await window.frostbyte.pickModelFolder();
    const response = await window.frostbyte.shareFolder(target, 'loose-safe');
    return { ok: response.ok, message: response.error || '', infohash: response.data?.torrent?.infoHash || null };
  }, loose);
  expect(result.ok, result.message).toBe(true);
  expect(result.infohash).toMatch(/^[a-f0-9]{40}$/);
  // A live, unpaused share for that folder now exists in the engine.
  await expect.poll(async () => {
    const state = await page.evaluate(async () => (await window.frostbyte.getState()).data);
    return (state.torrents || []).filter(t => (t.dataPath === loose || t.path === loose) && !t.paused).length;
  }, { timeout: 20000 }).toBeGreaterThan(0);
});

test('a completed p2p download is integrity-gated before it keeps seeding: risky stops, safe continues', async () => {
  test.setTimeout(180_000);
  // Round-2 N9/N7: the completion gate must scan the actual finished bytes of
  // every download (not just explicit shares) before seeding continues.
  const riskySource = path.join(home, 'p2p-risky');
  const safeSource = path.join(home, 'p2p-safe');
  fs.mkdirSync(riskySource); fs.mkdirSync(safeSource);
  fs.writeFileSync(path.join(riskySource, 'config.json'), '{}\n');
  fs.writeFileSync(path.join(riskySource, 'evil.pkl'), evilPickle());
  fs.writeFileSync(path.join(safeSource, 'model.gguf'), gguf());
  const seedRisky = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const seedSafe = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  let tracker;
  try {
    const risky = await seedRisky.seed(riskySource);
    const safe = await seedSafe.seed(safeSource);
    // One loopback tracker hands both real seeds to the isolated client.
    const peer = engine => Buffer.from([127, 0, 0, 1, (engine.port >> 8) & 255, engine.port & 255]);
    const peers = Buffer.concat([peer(seedRisky), peer(seedSafe)]);
    tracker = http.createServer((req, res) => res.end(Buffer.concat([Buffer.from('d8:intervali60e5:peers12:'), peers, Buffer.from('e')])));
    await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve));
    const trackerUrl = `http://127.0.0.1:${tracker.address().port}/announce`;
    // Relaunch with seeding-after-completion ON so the gate is the only thing
    // that can stop the risky copy (the beforeEach default removes it instead).
    await app.close(); app = null;
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: destination,
      dhtEnabled: false, upnpEnabled: false, confirmExitSeeding: false, seedOnComplete: true, extraTrackers: trackerUrl }));
    await launch();
    await app.evaluate(({ dialog }) => {
      const previous = dialog.showMessageBox;
      dialog.showMessageBox = async (window, options) => options?.message === 'Find torrent peers?'
        ? { response: 1 } : previous.call(dialog, window, options);
    });
    const getState = () => page.evaluate(async () => (await window.frostbyte.getState()).data);
    const addAndWaitDone = async (seeded, engine) => {
      await page.locator('#omni').fill(seeded.magnetURI + `&x.pe=127.0.0.1:${engine.port}`);
      await page.locator('#omni').press('Enter');
      await expect(page.locator('#modal h3')).toHaveText('Add a download');
      await page.locator('#modal-acts button.primary').click();
      await expect(page.locator('#modal')).toBeHidden();
      await expect.poll(async () => (await getState()).torrents.find(t => t.infoHash === seeded.infoHash)?.done,
        { timeout: 60000 }).toBe(true);
    };
    await addAndWaitDone(risky, seedRisky);
    // The gate stops the risky share and keeps the files on disk.
    await expect.poll(async () => (await getState()).torrents.find(t => t.infoHash === risky.infoHash)?.paused,
      { timeout: 30000 }).toBe(true);
    expect(fs.existsSync(path.join(destination, 'p2p-risky', 'evil.pkl'))).toBe(true);
    expect(Object.values((await getState()).aeonIntegrity).some(row => row.format === 'risky-format')).toBe(true);
    // Control: a safe completion under the same settings keeps seeding.
    await addAndWaitDone(safe, seedSafe);
    await expect.poll(async () => Object.values((await getState()).aeonIntegrity).some(row => row.format === 'safe-format'),
      { timeout: 30000 }).toBe(true);
    const safeRow = (await getState()).torrents.find(t => t.infoHash === safe.infoHash);
    expect(safeRow.done).toBe(true);
    expect(safeRow.paused).toBe(false);
  } finally {
    await seedRisky.destroy().catch(() => {});
    await seedSafe.destroy().catch(() => {});
    if (tracker) await new Promise(resolve => tracker.close(resolve));
  }
});

test('a folder that changes while the share review is open is refused after approval (TOCTOU)', async () => {
  // Round-2 N8: the decision must rest on the bytes present AFTER approval,
  // never on the pre-dialog scan. One stub applies the current mutation at
  // the moment the user approves.
  await app.evaluate(({ dialog }) => {
    const previousOpen = dialog.showOpenDialog;
    dialog.showOpenDialog = async (window, options) => options?.title === 'Pick a model file or folder to share'
      ? { canceled: false, filePaths: [globalThis.toctouTarget] } : previousOpen.call(dialog, window, options);
    const previousBox = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      if (options?.buttons?.includes('Share with peers')) {
        globalThis.integrityShareReviews.push(structuredClone(options));
        // Hold the review open until the test process has mutated the folder,
        // then approve — the post-dialog recheck sees the changed bytes.
        while (!globalThis.toctouMutationApplied) await new Promise(resolve => setTimeout(resolve, 25));
        return { response: options.buttons.indexOf('Share with peers') };
      }
      return previousBox.call(dialog, window, options);
    };
  });
  const shareWithMutation = async (folder, mutation) => {
    await app.evaluate((_electron, setup) => {
      globalThis.toctouTarget = setup.target;
      globalThis.toctouMutationApplied = false;
    }, { target: folder });
    let settled = null;
    // Count reviews already recorded by earlier phases: the mutation must
    // land while THIS phase's review is open, after its pre-dialog scan.
    const baseline = await app.evaluate(() => globalThis.integrityShareReviews.length);
    const pending = page.evaluate(async target => {
      await window.frostbyte.pickModelFolder();
      const response = await window.frostbyte.shareFolder(target, 'toctou');
      return { ok: response.ok, message: response.error || '' };
    }, folder).then(result => { settled = result; return result; }, error => { settled = { thrown: String(error) }; throw error; });
    // Wait until this phase's share review is actually open, then mutate.
    // A risky target may legitimately be refused BEFORE any review opens —
    // that early refusal is a valid outcome, not a fixture error.
    await expect.poll(async () => {
      if (settled) return Number.MAX_SAFE_INTEGER;
      return app.evaluate(() => globalThis.integrityShareReviews.length);
    }, { timeout: 15000 }).toBeGreaterThan(baseline);
    if (settled) return settled;
    if (mutation) {
      fs.writeFileSync(mutation.file, mutation.bytes);
      if (mutation.mtimeMs) fs.utimesSync(mutation.file, mutation.mtimeMs / 1000, mutation.mtimeMs / 1000);
    }
    await app.evaluate(() => { globalThis.toctouMutationApplied = true; });
    return pending;
  };
  const expectNoLiveShare = async folder => {
    const state = await page.evaluate(async () => (await window.frostbyte.getState()).data);
    expect((state.torrents || []).filter(t => (t.dataPath === folder || t.path === folder) && !t.paused)).toHaveLength(0);
  };

  // Phase 1: a code-executing pickle is ADDED while the review is open.
  // The pre-dialog scan saw only safe weights; the post-approval recheck
  // must refuse the changed folder instead of seeding the approved decision.
  const riskyFolder = path.join(home, 'toctou-risky');
  fs.mkdirSync(riskyFolder);
  fs.writeFileSync(path.join(riskyFolder, 'model.gguf'), gguf());
  const riskyResult = await shareWithMutation(riskyFolder,
    { file: path.join(riskyFolder, 'evil.pkl'), bytes: evilPickle() });
  expect(riskyResult.ok, riskyResult.message).toBe(false);
  expect(riskyResult.message).toContain('changed while the share review');
  await expectNoLiveShare(riskyFolder);

  // Phase 2: same-size content swap stays safe-format but changes the
  // fingerprint — the approved decision no longer describes these bytes.
  const changedFolder = path.join(home, 'toctou-changed');
  fs.mkdirSync(changedFolder);
  fs.writeFileSync(path.join(changedFolder, 'model.gguf'), gguf());
  const altered = gguf(); altered[altered.length - 1] ^= 0xff;
  const changedResult = await shareWithMutation(changedFolder,
    { file: path.join(changedFolder, 'model.gguf'), bytes: altered });
  expect(changedResult.ok, changedResult.message).toBe(false);
  expect(changedResult.message).toContain('changed while the share review');
  await expectNoLiveShare(changedFolder);

  // Phase 3: a single FILE share (not a folder) must survive the post-dialog
  // recheck — listFolderFiles only walks directories, so the recheck has to
  // re-read the file itself instead of failing with ENOTDIR.
  const singleFile = path.join(home, 'toctou-single.gguf');
  fs.writeFileSync(singleFile, gguf());
  const singleResult = await shareWithMutation(singleFile, null);
  expect(singleResult.ok, singleResult.message).toBe(true);
  await expect.poll(async () => {
    const state = await page.evaluate(async () => (await window.frostbyte.getState()).data);
    return (state.torrents || []).filter(t => (t.dataPath === singleFile || t.path === singleFile) && !t.paused).length;
  }, { timeout: 20000 }).toBeGreaterThan(0);

  // Phase 4: a risky single FILE is refused BEFORE any review opens — the
  // pre-dialog scan must actually analyze the file's bytes, not fingerprint
  // an empty collection and wave it through.
  const riskyFile = path.join(home, 'toctou-risky.pkl');
  fs.writeFileSync(riskyFile, evilPickle());
  const riskyFileResult = await shareWithMutation(riskyFile, null);
  expect(riskyFileResult.ok, riskyFileResult.message).toBe(false);
  expect(riskyFileResult.message).toContain('risky');
  await expectNoLiveShare(riskyFile);

  // Phase 5: a safe single file whose bytes are swapped for a pickle WHILE
  // the review is open must be refused by the post-approval recheck.
  const swappedFile = path.join(home, 'toctou-swap.gguf');
  fs.writeFileSync(swappedFile, gguf());
  const swapResult = await shareWithMutation(swappedFile, { file: swappedFile, bytes: evilPickle() });
  expect(swapResult.ok, swapResult.message).toBe(false);
  expect(swapResult.message).toContain('changed while the share review');
  await expectNoLiveShare(swappedFile);
});

test('a user scan under a discovered-model id revokes the live share and blocks re-seeding after restart', async () => {
  test.setTimeout(120_000);
  // Round-2 N4: scan: ids cannot be resolved by localItem(); revocation must
  // key off the model's path, and the verdict must mirror to the shared: id
  // the cache-only launch gate checks.
  await nav('library');
  await expect(card(safeRepo)).toBeVisible();
  await page.evaluate(async () => { await window.frostbyte.scanModels(); });
  const getState = () => page.evaluate(async () => (await window.frostbyte.getState()).data);
  await expect.poll(async () => (await getState()).modelLibrary.scan.phase, { timeout: 30000 }).toBe('complete');
  const folderPath = path.join(destination, safeRepo);
  const discovered = (await getState()).modelLibrary.items.find(item => item.id.startsWith('scan:')
    && item.device === 'local' && (item.path === folderPath || item.path === path.join(folderPath, 'model.gguf')));
  expect(discovered, 'discovery should find the safe fixture model').toBeTruthy();
  // Share it live through the library path (creates the shared: library row).
  await app.evaluate(() => { globalThis.approveNextShare = true; });
  const share = await page.evaluate(async target => {
    const response = await window.frostbyte.shareFolder(target, 'revoked-model');
    return { ok: response.ok, message: response.error || '', infohash: response.data?.torrent?.infoHash || null };
  }, folderPath);
  expect(share.ok, share.message).toBe(true);
  const liveShares = async () => {
    const state = await getState();
    return (state.torrents || []).filter(t => !t.paused && (t.path === folderPath || t.dataPath === folderPath));
  };
  await expect.poll(async () => (await liveShares()).length, { timeout: 20000 }).toBeGreaterThan(0);
  // Rewrite the shared weights into a code-executing pickle, keeping size.
  const target = path.join(folderPath, 'model.gguf');
  const original = fs.statSync(target).size;
  const evil = evilPickle();
  fs.writeFileSync(target, evil.length <= original ? Buffer.concat([evil, Buffer.alloc(original - evil.length)]) : evil);
  // Scan under the DISCOVERED id — not the inventory id.
  const scan = await page.evaluate(async id => {
    const response = await window.frostbyte.aeonIntegrityScan({ id });
    return { ok: response.ok, message: response.error || '', format: response.data?.integrity?.format || null };
  }, discovered.id);
  expect(scan.ok, scan.message).toBe(true);
  expect(scan.format).toBe('risky-format');
  await expect.poll(async () => (await liveShares()).length, { timeout: 20000 }).toBe(0);
  const after = await getState();
  expect(after.aeonIntegrity['shared:' + share.infohash]?.format).toBe('risky-format');
  // Restart with the transfer record gone but the library row kept: only the
  // cache-only launch gate stands between the risky folder and a fresh seed.
  await app.close(); app = null;
  const stateFile = path.join(home, 'state.json');
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  persisted.transfers = (persisted.transfers || []).filter(t => t.infohash !== share.infohash);
  fs.writeFileSync(stateFile, JSON.stringify(persisted));
  await launch();
  await page.waitForTimeout(2500); // let the launch re-seed loop run
  const restarted = await getState();
  expect((restarted.library || []).some(item => item.infohash === share.infohash)).toBe(true);
  expect((restarted.torrents || []).filter(t => t.path === folderPath || t.dataPath === folderPath)).toHaveLength(0);
});
