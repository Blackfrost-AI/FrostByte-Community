import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { TorrentEngine } from '../../src/main/torrent.js';
import { sha256File } from '../../src/main/hf.js';

let app, page, seed, tracker, home, downloads, completed, remote, other, localFile, libraryHash;
const errors = [];
const snapshots = path.resolve('test-results/screenshots');
const state = async () => page.evaluate(async () => (await window.frostbyte.getState()).data);
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click();
const settings = async patch => {
  const result = await page.evaluate(p => window.frostbyte.setSettings(p), patch);
  expect(result.ok, result.error).toBe(true);
};
const selectPath = file => app.evaluate(({dialog}, chosen) => {
  dialog.showOpenDialog = async () => chosen ? {canceled:false,filePaths:[chosen]} : {canceled:true,filePaths:[]};
}, file);
async function launch() {
  app = await electron.launch({executablePath:process.env.FROSTBYTE_EXECUTABLE,args:process.env.FROSTBYTE_EXECUTABLE?[]:['.','--dev'],env:{...process.env,FROSTBYTE_HOME:home,FROSTBYTE_TEST_DIRECT_PEERS:'1'},timeout:30000});
  app.process().stdout.on('data', data => {
    for (const line of data.toString().split('\n')) if (line.startsWith('[notice:error]')) errors.push(line);
  });
  page = await app.firstWindow(); await acceptBetaTerms(page, app);
  await app.evaluate(({ dialog }) => {
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      if (['Start this Hugging Face download?',
        'Resume this Hugging Face download?', 'Save this torrent source?',
        'Find torrent peers?', 'Preview this torrent file?']
        .includes(options?.message) || /^Share .* with other peers\?$/.test(options?.message || '')) return { response: 1 };
      return previous.call(dialog, window, options);
    };
  });
  page.on('pageerror', err => errors.push(err.message));
  await page.waitForFunction(() => window.frostbyte && document.querySelector('#nav .nav.on'));
  if (process.env.FROSTBYTE_EXECUTABLE) expect(await app.evaluate(({app}) => app.isPackaged)).toBe(true);
  await page.emulateMedia({reducedMotion:'reduce'});
}
async function addCatalog(name, magnet) {
  await nav('catalog');
  if (!await page.locator('#saved-links').evaluate(el => el.open)) await page.locator('#saved-links > summary').click();
  await page.locator('#btn-newentry').click();
  await page.locator('#ce-name').fill(name);
  await page.locator('#ce-magnet').fill(magnet);
  await page.locator('#ce-format').fill('gguf');
  await page.locator('#modal').getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('#modal')).toBeHidden();
  await expect(page.locator('#grid-catalog tbody')).toContainText(name);
}

test.describe.serial('FrostByte desktop end to end', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(),'fb-e2e-'));
    downloads = path.join(home,'downloads'); completed = path.join(home,'completed');
    fs.mkdirSync(downloads); fs.mkdirSync(completed);
    fs.writeFileSync(path.join(home,'settings.json'), JSON.stringify({downloadDir:downloads,upnpEnabled:false,dhtEnabled:false,confirmExitSeeding:false,confirmBigPull:false}));
    localFile = path.join(home,'local-weights.gguf'); fs.writeFileSync(localFile, crypto.randomBytes(64*1024));
    const remoteFile = path.join(home,'remote-weights.gguf'); fs.writeFileSync(remoteFile, crypto.randomBytes(2*1024*1024));
    const otherFile = path.join(home,'other-weights.gguf'); fs.writeFileSync(otherFile, crypto.randomBytes(64*1024));
    seed = new TorrentEngine({dht:false,tracker:false,lsd:false});
    remote = await seed.seed(remoteFile); other = await seed.seed(otherFile);
    remote.magnetURI += `&x.pe=127.0.0.1:${seed.port}`;
    other.magnetURI += `&x.pe=127.0.0.1:${seed.port}`;
    // Catalog entries intentionally retain only the content identity. Supply
    // this isolated peer through the locally configured test tracker instead.
    tracker = http.createServer((_request, response) => {
      const peer = Buffer.from([127, 0, 0, 1, (seed.port >> 8) & 255, seed.port & 255]);
      response.end(Buffer.concat([Buffer.from('d8:intervali60e5:peers6:'), peer, Buffer.from('e')]));
    });
    await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve));
    const savedSettings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    savedSettings.extraTrackers = `http://127.0.0.1:${tracker.address().port}/announce`;
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(savedSettings));
    await launch();
  });
  test.afterAll(async () => {
    if (page && !page.isClosed()) {
      fs.mkdirSync(snapshots,{recursive:true});
      await page.screenshot({path:path.join(snapshots,'final.png')}).catch(()=>{});
    }
    await app?.close().catch(()=>{});
    await seed?.destroy();
    if (tracker) {
      tracker.closeAllConnections();
      await new Promise(resolve => tracker.close(resolve));
    }
    if (home) fs.rmSync(home,{recursive:true,force:true});
  });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) {
      await page.screenshot({path:info.outputPath('failure.png')});
      await info.attach('state',{body:JSON.stringify(await state(),null,2),contentType:'application/json'});
    }
  });

  test('boots every view, sandbox enabled, and Cancel/Escape dismiss dialogs', async () => {
    expect(page.url()).toBe('frostbyte://app/renderer/index.html');
    const forbiddenAsset = await page.evaluate(async () => {
      try {
        const response = await fetch('frostbyte://app/main/index.js');
        return { status: response.status, body: await response.text() };
      } catch { return { status: 0, body: '' }; }
    });
    expect(forbiddenAsset.status).not.toBe(200);
    expect(forbiddenAsset.body).not.toContain('ipcMain');
    for (const tab of ['transfers','library','catalog','hf','settings']) {
      await nav(tab); await expect(page.locator(`#view-${tab}`)).toBeVisible();
      expect(await page.locator('.view:visible').count()).toBe(1);
    }
    expect((await state()).catalog).toEqual([]);
    await expect(page.locator('.brand-icon:visible')).toHaveCount(1);
    expect(await page.locator('.brand-icon:visible').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await nav('settings');
    await page.locator('#settings-nav [data-sec="about"]').click();
    await expect(page.locator('.brand-about')).toBeVisible();
    expect(await page.locator('.brand-about').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await nav('transfers');
    await expect(page.locator('#empty-transfers')).toBeVisible();
    await expect(page.locator('#nav [data-tab="search"]')).toHaveCount(0);
    await nav('hf');
    await expect(page.locator('#empty-hf')).toBeVisible();
    await expect(page.locator('#empty-hf')).toContainText('Find a model');
    for (const [width,height] of [[980,600],[1400,900]]) {
      await app.evaluate(({BrowserWindow}, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width,height]);
      await expect.poll(() => page.evaluate(() => {
        const header=document.querySelector('#grid-hf thead').getBoundingClientRect();
        const view=document.querySelector('#hf-wrap').getBoundingClientRect();
        return Math.abs(header.right-view.right) + Math.abs(header.left-view.left);
      })).toBeLessThan(2);
    }
    fs.mkdirSync(snapshots,{recursive:true});
    await page.screenshot({path:path.join(snapshots,'hf-empty.png')});
    const prefs = await app.evaluate(({BrowserWindow}) => {
      const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {sandbox:p.sandbox,nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation};
    });
    expect(prefs).toEqual({sandbox:true,nodeIntegration:false,contextIsolation:true});
    const duplicates=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);});
    expect(duplicates).toEqual([]);
    await nav('transfers'); await page.locator('#btn-add').click();
    await page.locator('#modal').getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(page.locator('#modal')).toBeHidden();
    await page.locator('#btn-add').click(); await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('native folder selection, threshold controls, themes, and schedule toggle persist', async () => {
    await nav('settings');
    await page.locator('#settings-nav [data-sec="folders"]').click();
    await selectPath(downloads);
    await page.locator('#btn-changedir').click();
    await expect(page.locator('#set-dir')).toHaveValue(downloads);
    const unapproved = await page.evaluate(value => window.frostbyte.setSettings({ downloadDir: value }), path.join(home, 'not-picked'));
    expect(unapproved.ok).toBe(false);
    expect((await state()).settings.downloadDir).toBe(downloads);
    // The denied direct IPC call deliberately emits one security notice. It
    // is asserted above and is not an unexpected application error.
    errors.length = 0;
    await selectPath(completed); await page.locator('#btn-changecompleted').click();
    await expect(page.locator('#set-completed')).toHaveValue(completed);
    await expect(page.locator('#set-move')).toBeChecked();
    await page.locator('#settings-nav [data-sec="interface"]').click();
    await page.locator('#set-bigpull').check();
    await page.locator('#set-bigpull-gb').fill('70'); await page.locator('#set-bigpull-gb').blur();
    await expect.poll(async()=>(await state()).settings.bigPullGB).toBe(70);
    expect((await state()).settings.confirmBigPull).toBe(true);
    for (const theme of ['abyss','malachite','frost']) {
      await page.locator('#set-theme').selectOption(theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    }
    await settings({bandwidthMode:'schedule',schedEnabled:true,schedFrom:'00:00',schedTo:'00:00',schedDays:[1,1,1,1,1,1,1],altDownKBs:300});
    await expect.poll(async()=>(await state()).rates.alt).toBe(true);
    await page.locator('#turtle').click();
    await expect.poll(async()=>(await state()).rates.alt).toBe(false);
    await settings({schedEnabled:false,confirmBigPull:false});
    await selectPath(null); await nav('library'); await page.locator('#btn-share2').click();
    await expect(page.locator('#modal')).toBeHidden();
  });

  test('saved torrent links preserve editing, details and deletion; density remains configurable', async () => {
    await addCatalog('Review remote model',remote.magnetURI);
    await addCatalog('Review other model',other.magnetURI);
    const first=page.locator('#grid-catalog tr').filter({hasText:'Review remote model'});
    await first.getByRole('button',{name:'Edit',exact:true}).click();
    await expect(page.locator('#ce-magnet')).toHaveValue(`magnet:?xt=urn:btih:${remote.infoHash}`);
    await page.locator('#ce-name').fill('Review renamed model');
    await page.locator('#modal').getByRole('button',{name:'Save',exact:true}).click();
    await expect(page.locator('#grid-catalog tbody')).toContainText('Review renamed model');
    await expect(page.locator('#grid-catalog tbody')).not.toContainText('Review remote model');
    await nav('settings'); await page.locator('#settings-nav [data-sec="interface"]').click();
    await page.locator('[data-d="compact"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-density','compact');
    await nav('catalog');
    await page.locator('#grid-catalog tbody tr').filter({hasText:'Review renamed model'}).click();
    await expect(page.locator('#drawer')).toBeVisible(); await page.keyboard.press('Escape');
    await expect(page.locator('#drawer')).toBeHidden();
    await page.locator('#grid-catalog tr').filter({hasText:'Review other model'}).getByRole('button',{name:'Delete',exact:true}).click();
    await expect(page.locator('#grid-catalog tbody')).not.toContainText('Review other model');
  });

  test('magnet pull pauses, resumes, verifies bytes and moves only its model', async () => {
    fs.writeFileSync(path.join(downloads,'unrelated.txt'),'preserve this');
    await settings({downLimitKBs:128,moveCompleted:true,completedDir:completed,seedOnComplete:true});
    await nav('catalog');
    await page.locator('#grid-catalog tr').filter({hasText:'Review renamed model'}).click();
    await page.locator('#drawer [data-pull]').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    await expect.poll(async()=>(await state()).torrents.find(t=>t.infoHash===remote.infoHash)?.downloaded || 0).toBeGreaterThan(0);
    const row=page.locator(`.tor[data-hash="${remote.infoHash}"]`);
    await row.getByRole('button',{name:'Pause',exact:true}).click();
    await expect(row.getByRole('button',{name:'Resume',exact:true})).toBeVisible();
    await expect(row.locator('.tor-meta')).toContainText('paused');
    await settings({downLimitKBs:0});
    await row.getByRole('button',{name:'Resume',exact:true}).click();
    await expect.poll(async() => {
      const torrent = (await state()).torrents.find(t => t.infoHash === remote.infoHash);
      return { done: torrent?.done, dataPath: torrent?.dataPath, errors: [...errors] };
    }).toEqual({ done: true, dataPath: path.join(fs.realpathSync(completed),remote.name), errors: [] });
    expect(await sha256File(path.join(completed,remote.name))).toBe(await sha256File(path.join(home,remote.name)));
    expect(fs.readFileSync(path.join(downloads,'unrelated.txt'),'utf8')).toBe('preserve this');
    await row.locator('[data-toggle-files]').click();
    await expect(row).toHaveClass(/open/);
    await expect.poll(async()=>(await state()).torrents.find(t=>t.infoHash===remote.infoHash)?.seeding).toBe(true);
    await page.waitForTimeout(1600); await expect(row).toHaveClass(/open/);
    fs.mkdirSync(snapshots,{recursive:true}); await page.screenshot({path:path.join(snapshots,'transfers.png')});
  });

  test('native file sharing enters the library and stop-sharing updates immediately', async () => {
    await nav('library'); await selectPath(localFile); await page.locator('#btn-share2').click();
    await expect(page.locator('#modal')).toContainText('Now sharing local-weights.gguf');
    await page.locator('#modal').getByRole('button',{name:'Done',exact:true}).click();
    await expect(page.locator('#library-downloads')).toContainText('local-weights.gguf');
    libraryHash=(await state()).library.find(l=>l.path===localFile).infohash;
    const localCard = page.locator('#library-downloads .inventory-item').filter({hasText:'local-weights.gguf'});
    await localCard.getByRole('switch').click();
    await expect(localCard.getByRole('switch')).toHaveAttribute('aria-checked','false');
    expect(fs.existsSync(localFile)).toBe(true);
    await selectPath(localFile); await page.locator('#btn-share2').click();
    await expect(page.locator('#modal')).toContainText('Now sharing');
    await page.locator('#modal').getByRole('button',{name:'Done',exact:true}).click();
    await nav('transfers');
    await page.locator(`.tor[data-hash="${libraryHash}"]`).getByRole('button',{name:'Pause',exact:true}).click();
    await expect.poll(async()=>(await state()).torrents.find(t=>t.infoHash===libraryHash)?.paused).toBe(true);
  });

  test('live HuggingFace search, selective download and restart resume reach identical bytes', async () => {
    await nav('hf'); await page.locator('#hf-q').fill('Qwen3-0.6B'); await page.locator('#hf-go').click();
    await expect(page.locator('#grid-hf tr[data-id="Qwen/Qwen3-0.6B"]')).toBeVisible();
    await expect(page.locator('#hf-detail')).toBeHidden();
    const widths=await page.evaluate(() => ({table:document.querySelector('#grid-hf').getBoundingClientRect().width,view:document.querySelector('#hf-wrap .hf-results .gridwrap').clientWidth,results:document.querySelector('#hf-wrap .hf-results').getBoundingClientRect().width,wrapper:document.querySelector('#hf-wrap').getBoundingClientRect().width}));
    expect(Math.abs(widths.table-widths.view)).toBeLessThan(2);
    expect(Math.abs(widths.results-widths.wrapper)).toBeLessThan(2);
    await page.screenshot({path:path.join(snapshots,'hf-results.png')});
    await page.locator('#grid-hf tr[data-id="Qwen/Qwen3-0.6B"]').click();
    await expect(page.locator('#hf-detail')).toContainText('config.json');
    const layout=await page.evaluate(() => {
      const detail=document.querySelector('#hf-detail').getBoundingClientRect();
      const results=document.querySelector('#hf-wrap .hf-results').getBoundingClientRect();
      const view=document.querySelector('#hf-wrap').getBoundingClientRect();
      return {gap:Math.abs(results.right-detail.left),edge:Math.abs(detail.right-view.right),detailWidth:detail.width};
    });
    expect(layout.gap).toBeLessThan(2); expect(layout.edge).toBeLessThan(2); expect(layout.detailWidth).toBeGreaterThan(0);
    await page.screenshot({path:path.join(snapshots,'hf-detail.png')});
    await page.getByRole('button',{name:'Close model details',exact:true}).click();
    await expect(page.locator('#hf-detail')).toBeHidden();
    await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector('#hf-wrap').getBoundingClientRect().width-document.querySelector('#hf-wrap .hf-results').getBoundingClientRect().width))).toBeLessThan(2);
    await page.locator('#grid-hf tr[data-id="Qwen/Qwen3-0.6B"]').click();
    await expect(page.locator('#hf-detail')).toContainText('config.json');
    await page.keyboard.press('Escape');
    await expect(page.locator('#hf-detail')).toBeHidden();
    await page.locator('#grid-hf tr[data-id="Qwen/Qwen3-0.6B"]').click();
    await expect(page.locator('#hf-detail')).toContainText('config.json');
    await page.locator('#hf-custom summary').click();
    await page.locator('#hf-pick-none').click();
    await page.locator('#hf-detail input[data-f="config.json"]').check();
    await page.locator('#hf-download').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    await expect.poll(async()=>(await state()).downloads.find(d=>d.filePath==='config.json')?.status).toBe('done');
    const downloaded=(await state()).downloads.find(d=>d.filePath==='config.json');
    const direct=await fetch(`https://huggingface.co/Qwen/Qwen3-0.6B/resolve/${downloaded.revision}/config.json`);
    expect(direct.ok).toBe(true);
    expect(await sha256File(downloaded.dest)).toBe(crypto.createHash('sha256').update(Buffer.from(await direct.arrayBuffer())).digest('hex'));
    await settings({downLimitKBs:32});
    await nav('hf'); await page.locator('#hf-detail input[data-f="config.json"]').uncheck();
    await page.locator('#hf-detail input[data-f="merges.txt"]').check(); await page.locator('#hf-download').click();
    await expect.poll(async()=>(await state()).downloads.find(d=>d.filePath==='merges.txt')?.downloaded || 0).toBeGreaterThan(0);
    await expect(page.locator('#hf-clear')).toBeDisabled();
    await expect(page.locator('.hfdl[data-repo="Qwen/Qwen3-0.6B"]')).toHaveCount(1);
    await expect(page.locator('.hfdl[data-repo="Qwen/Qwen3-0.6B"]')).toContainText('1 of 2 files complete');
    expect((await state()).downloads.some(d=>d.filePath==='config.json' && d.status==='done')).toBe(true);
    await expect.poll(async()=>(await state()).downloads.some(d=>d.filePath==='merges.txt' && d.status==='active')).toBe(true);
    await app.close();
    const saved=JSON.parse(fs.readFileSync(path.join(home,'state.json')));
    expect(saved.hfDownloads.find(d=>d.filePath==='merges.txt').status).toBe('queued');
    expect(saved.transfers.find(t=>t.infohash===libraryHash).paused).toBe(true);
    const config=JSON.parse(fs.readFileSync(path.join(home,'settings.json'))); config.downLimitKBs=0;
    fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify(config));
    await launch();
    // Live HF throughput varies; integrity is still checked against the pinned provider bytes.
    await expect.poll(async()=>(await state()).downloads.find(d=>d.filePath==='merges.txt')?.status, { timeout: 45000 }).toBe('done');
    await expect.poll(async()=>(await state()).torrents.find(t=>t.infoHash===libraryHash)?.paused).toBe(true);
    const finished=(await state()).downloads.find(d=>d.filePath==='merges.txt');
    const response=await fetch(`https://huggingface.co/Qwen/Qwen3-0.6B/resolve/${finished.revision}/merges.txt`);
    expect(response.ok).toBe(true);
    expect(await sha256File(finished.dest)).toBe(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'));
  });

  test('HF to swarm sharing and transfer removal survive another restart', async () => {
    await nav('transfers');
    await page.locator('.hfdl').filter({hasText:'merges.txt'}).locator('.hf-model-files > summary').click();
    await page.locator('.hf-file').filter({hasText:'merges.txt'}).getByRole('button',{name:'Share on swarm'}).click();
    await page.locator('#modal').getByRole('button',{name:'Hash & share',exact:true}).click();
    await expect(page.locator('#modal')).toContainText('Now sharing merges.txt');
    await page.locator('#modal').getByRole('button',{name:'Done',exact:true}).click();
    await nav('catalog'); await expect(page.locator('#torrents-inventory')).toContainText('merges.txt');
    await nav('transfers');
    const row=page.locator(`.tor[data-hash="${libraryHash}"]`);
    await row.locator('summary[aria-label^="Options for "]').click();
    await row.getByRole('button',{name:'Remove transfer',exact:true}).click();
    await expect(row).toHaveCount(0);
    expect((await state()).library.some(l=>l.infohash===libraryHash)).toBe(false);
    await app.close(); await launch();
    expect((await state()).torrents.some(t=>t.infoHash===libraryHash)).toBe(false);
    expect(fs.existsSync(localFile)).toBe(true);
    await nav('catalog'); await expect(page.locator('#torrents-inventory')).toContainText('merges.txt');
    fs.mkdirSync(snapshots,{recursive:true}); await page.screenshot({path:path.join(snapshots,'library.png')});
    expect(errors).toEqual([]);
  });
  test('native .torrent picker and a magnet without peers stay manageable', async () => {
    const torrentPath=path.join(home,'other.torrent');
    fs.writeFileSync(torrentPath, Buffer.from((await seed.client.get(other.infoHash)).torrentFile));
    const ungranted = await page.evaluate(source => window.frostbyte.add(source), torrentPath);
    expect(ungranted.ok).toBe(false);
    expect(ungranted.error).toMatch(/Choose this file or folder again/);
    // The denied direct call is the behavior under test, not an unexpected
    // application failure for the remainder of this serial workflow.
    errors.length = 0;
    await nav('transfers'); await page.locator('#btn-add').click();
    await selectPath(torrentPath); await page.locator('#dl-file').click();
    await expect(page.locator('#dl-magnet')).toHaveValue(torrentPath);
    await page.locator('#modal').locator('#modal-acts button.primary').click();
    await expect(page.locator('#modal')).toBeHidden();
    await expect.poll(async()=>(await state()).torrents.some(t=>t.infoHash===other.infoHash)).toBe(true);
    const t=page.locator(`.tor[data-hash="${other.infoHash}"]`);
    await t.locator('summary[aria-label^="Options for "]').click();
    await t.getByRole('button',{name:'Remove transfer',exact:true}).click();
    await expect(t).toHaveCount(0);
    await nav('transfers'); await page.locator('#btn-add').click();
    const idleHash=crypto.randomBytes(20).toString('hex');
    await page.locator('#dl-magnet').fill('magnet:?xt=urn:btih:'+idleHash);
    await page.locator('#modal').locator('#modal-acts button.primary').click();
    await expect(page.locator('#modal')).toBeHidden();
    const idle=page.locator(`.tor[data-hash="${idleHash}"]`);
    await expect(idle).toContainText('finding peers / metadata');
    await idle.locator('summary[aria-label^="Options for "]').click();
    await idle.getByRole('button',{name:'Remove transfer',exact:true}).click();
    await expect(idle).toHaveCount(0);
    expect(errors).toEqual([]);
  });

});
