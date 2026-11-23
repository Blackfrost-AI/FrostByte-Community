import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import parseTorrent, { toTorrentFile } from 'parse-torrent';
import { TorrentEngine } from '../../src/main/torrent.js';

let app, page, home, seed, torrent, torrentFile, source, destination, tracker;
const errors = [];
const nav = tab => page.locator(`#nav [data-tab="${tab}"]`).click();
const state = () => page.evaluate(async () => (await window.frostbyte.getState()).data);
const applicationPage = async application => {
  let candidate = await application.firstWindow();
  if (!candidate.url().startsWith('frostbyte://app/')) {
    await expect.poll(() => application.windows().find(window => window.url().startsWith('frostbyte://app/'))?.url()).toBeTruthy();
    candidate = application.windows().find(window => window.url().startsWith('frostbyte://app/'));
  }
  return candidate;
};
const approvePeerReview = () => app.evaluate(({dialog})=>{
  const previous=dialog.showMessageBox;
  dialog.showMessageBox=async(window,options)=>options?.message==='Find torrent peers?'
    ? {response:1}:previous.call(dialog,window,options);
});
const textDrop = text => page.evaluate(value => {
  const dataTransfer = new DataTransfer(); dataTransfer.setData('text/uri-list',value);
  document.body.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer}));
  document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
},text);
const fileDrop = async file => {
  await page.evaluate(() => { const input=document.createElement('input');input.id='test-dropped-file';input.type='file';input.hidden=true;document.body.append(input); });
  await page.locator('#test-dropped-file').setInputFiles(file);
  await page.locator('#test-dropped-file').evaluate(input => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(input.files[0]);
    document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer})); input.remove();
  });
};

test.describe.serial('Drop review and Hub discovery', () => {
  test.beforeAll(async () => {
    home=fs.mkdtempSync(path.join(os.tmpdir(),'fb-drop-'));
    destination=path.join(home,'chosen-downloads');fs.mkdirSync(destination);
    source=path.join(home,'release');fs.mkdirSync(source);
    fs.writeFileSync(path.join(source,'config.json'),'{"updated":true}');
    fs.writeFileSync(path.join(source,'update.zip'),crypto.randomBytes(96*1024));
    fs.writeFileSync(path.join(source,'weights.gguf'),crypto.randomBytes(4*1024*1024));
    fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({downloadDir:path.join(home,'downloads'),upnpEnabled:false,dhtEnabled:false,confirmExitSeeding:false,confirmBigPull:false}));
    seed=new TorrentEngine({dht:false,tracker:false,lsd:false});torrent=await seed.seed(source);
    // A loopback tracker supplies the real seed to the isolated Electron client.
    tracker=http.createServer((req,res)=>{
      const peer=Buffer.from([127,0,0,1,(seed.port>>8)&255,seed.port&255]);
      res.end(Buffer.concat([Buffer.from('d8:intervali60e5:peers6:'),peer,Buffer.from('e')]));
    });
    await new Promise(resolve=>tracker.listen(0,'127.0.0.1',resolve));
    const trackerUrl=`http://127.0.0.1:${tracker.address().port}/announce`;
    fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({downloadDir:path.join(home,'downloads'),upnpEnabled:false,dhtEnabled:false,confirmExitSeeding:false,confirmBigPull:false,extraTrackers:trackerUrl}));
    const metadata=await parseTorrent(seed.client.torrents[0].torrentFile);
    metadata.announce=['http://169.254.169.254/latest/meta-data'];
    metadata.urlList=['http://127.0.0.1/private-web-seed'];
    torrentFile=path.join(home,'release.TORRENT');fs.writeFileSync(torrentFile,toTorrentFile(metadata));
    app=await electron.launch({executablePath:process.env.FROSTBYTE_EXECUTABLE,args:process.env.FROSTBYTE_EXECUTABLE?[]:['.','--dev'],env:{...process.env,FROSTBYTE_HOME:home,FROSTBYTE_TEST_DIRECT_PEERS:'1'}});
    page=await applicationPage(app); await acceptBetaTerms(page, app);page.on('pageerror',error=>errors.push(error.message));
    await approvePeerReview();
    await page.waitForFunction(()=>document.querySelector('#nav .nav.on'));
  });
  test.afterAll(async()=>{await app?.close();await seed?.destroy();if(tracker)await new Promise(resolve=>tracker.close(resolve));if(home)fs.rmSync(home,{recursive:true,force:true});});

  test('magnet drop and omnibar show review; Escape starts no transfer', async () => {
    const magnet=torrent.magnetURI+`&x.pe=127.0.0.1:${seed.port}`;
    await textDrop(magnet);
    await expect(page.locator('#modal h3')).toHaveText('Add a download');
    await expect(page.locator('#dl-files input')).toHaveCount(3);
    expect((await state()).torrents).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();
    await page.locator('#omni').fill(magnet);await page.locator('#omni').press('Enter');
    await expect(page.locator('#modal')).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await state()).torrents).toHaveLength(0);
  });

  test('a real disk torrent drop selects only a config and update, with a per-download destination', async () => {
    await app.evaluate(({dialog})=>{
      const previous=dialog.showMessageBox;
      dialog.showMessageBox=async(window,options)=> options?.message==='Preview this torrent file?'
        ? {response:1} : previous.call(dialog,window,options);
    });
    await fileDrop(torrentFile);
    await expect(page.locator('#dl-magnet')).toHaveValue(torrentFile);
    await expect(page.locator('#dl-files input')).toHaveCount(3);
    await page.locator('#dl-none').click();
    await expect(page.locator('#modal-acts button.primary')).toBeDisabled();
    await page.locator('[data-torrent-file="release/config.json"]').check();
    await page.locator('[data-torrent-file="release/update.zip"]').check();
    await page.locator('#dl-filter').fill('config');
    await expect(page.locator('#dl-files input')).toHaveCount(1);
    await expect(page.locator('#dl-summary')).toContainText('2 of 3 files');
    await app.evaluate(({dialog},p)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[p]});},destination);
    await page.locator('#dl-folder').click();
    await expect(page.locator('#dl-destination')).toHaveText(destination);
    fs.mkdirSync('test-results/screenshots',{recursive:true});
    await page.screenshot({path:'test-results/screenshots/torrent-review.png'});
    await page.locator('#modal-acts button.primary').click();
    await expect(page.locator('#modal')).toBeHidden();
    await expect.poll(async()=> (await state()).torrents.find(t=>t.infoHash===torrent.infoHash)?.done).toBe(true);
    await app.close();
    app=await electron.launch({executablePath:process.env.FROSTBYTE_EXECUTABLE,args:process.env.FROSTBYTE_EXECUTABLE?[]:['.','--dev'],env:{...process.env,FROSTBYTE_HOME:home,FROSTBYTE_TEST_DIRECT_PEERS:'1'}});
    page=await applicationPage(app); await acceptBetaTerms(page, app);page.on('pageerror',error=>errors.push(error.message));
    await approvePeerReview();
    await page.waitForFunction(()=>document.querySelector('#nav .nav.on'));
    // Hidden transfer cards intentionally stop rendering updates. Check the same
    // visible view a user would navigate to.
    await nav('transfers');
    const completedCard=page.locator(`#transfers .tor[data-hash="${torrent.infoHash}"]`);
    await expect(completedCard).toBeVisible();
    await expect.poll(async()=> (await state()).torrents.find(t=>t.infoHash===torrent.infoHash)?.done).toBe(true);
    const complete=(await state()).torrents.find(t=>t.infoHash===torrent.infoHash);
    expect(complete.partial).toBe(true);expect(complete.path).toBe(destination);
    expect(fs.readFileSync(path.join(destination,'release','config.json'))).toEqual(fs.readFileSync(path.join(source,'config.json')));
    expect(fs.readFileSync(path.join(destination,'release','update.zip'))).toEqual(fs.readFileSync(path.join(source,'update.zip')));
    await expect(completedCard).toContainText('selected files complete');
  });

  test('multiple links queue reviews and Finder launch leases survive a renderer reload until dismissal', async () => {
    const torrentCountBefore = (await state()).torrents.length;
    const a='magnet:?xt=urn:btih:'+'b'.repeat(40),b='magnet:?xt=urn:btih:'+'c'.repeat(40);
    await textDrop(a+'\n'+b);
    await expect(page.locator('#dl-magnet')).toHaveValue(a);await page.keyboard.press('Escape');
    await expect(page.locator('#dl-magnet')).toHaveValue(b);await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();
    await app.evaluate(({app},file)=>app.emit('open-file',{preventDefault(){}},file),torrentFile);
    await expect(page.locator('#dl-magnet')).toHaveValue(torrentFile);await page.keyboard.press('Escape');

    await app.evaluate(({app},values)=>{
      for(const value of values)app.emit('open-url',{preventDefault(){}},value);
    },['magnet:?dn=looks-like.torrent',`magnet:?xt=urn:btih:${'d'.repeat(40)}\t&dn=file.torrent`,`magnet:?xt=urn:btih:${'d'.repeat(40)}${' '.repeat(32769)}`]);
    await page.waitForTimeout(100);
    await expect(page.locator('#modal')).toBeHidden();

    await app.evaluate(({dialog})=>{
      globalThis.__launchSourceDialog=dialog.showMessageBox;
      dialog.showMessageBox=async(window,options)=>options?.message==='Find torrent peers?'
        ? {response:0}:globalThis.__launchSourceDialog.call(dialog,window,options);
    });
    const deceptive=`MAGNET:?xt=urn:btih:${'d'.repeat(40)}&dn=looks-like.torrent`;
    await app.evaluate(({app},value)=>app.emit('open-url',{preventDefault(){}},value),deceptive);
    await expect(page.locator('#dl-magnet')).toHaveValue(deceptive.replace(/^MAGNET:/,'magnet:'));
    await page.keyboard.press('Escape');
    await app.evaluate(({dialog})=>{dialog.showMessageBox=globalThis.__launchSourceDialog;delete globalThis.__launchSourceDialog;});

    const whitespaceTorrent=path.join(home,' release metadata.TORRENT ');
    fs.copyFileSync(torrentFile,whitespaceTorrent);
    await app.evaluate(({app},file)=>app.emit('open-file',{preventDefault(){}},file),whitespaceTorrent);
    await expect(page.locator('#dl-magnet')).toHaveValue(whitespaceTorrent);
    await expect(page.locator('#dl-files input')).toHaveCount(3);
    // Main retains the exact source/capability while this review is in flight,
    // so a renderer teardown cannot lose it or mint a replacement grant.
    await page.reload();
    await page.waitForFunction(()=>window.frostbyte && document.querySelector('#nav .nav.on'));
    await expect(page.locator('#dl-magnet')).toHaveValue(whitespaceTorrent);
    await expect(page.locator('#dl-files input')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();
    await page.waitForTimeout(100);
    await expect(page.locator('#modal')).toBeHidden();
    await page.reload();
    await page.waitForFunction(()=>window.frostbyte && document.querySelector('#nav .nav.on'));
    await expect(page.locator('#modal')).toBeHidden();
    expect((await state()).torrents).toHaveLength(torrentCountBefore);
  });

  test('Hub sorting, API filters, pagination, and stale searches behave correctly', async () => {
    await app.evaluate(({ipcMain})=>{
      globalThis.browseRequests=[];
      ipcMain.removeHandler('hf:search');ipcMain.removeHandler('hf:facets');
      ipcMain.handle('hf:facets',()=>({ok:true,data:{pipeline_tag:[{id:'text-generation',label:'Text Generation'}],library:[],license:[{id:'mit',label:'MIT'}],language:[]}}));
      ipcMain.handle('hf:search',async(_,q,options)=>{
        globalThis.browseRequests.push({q,options});
        if(q==='slow') await new Promise(r=>setTimeout(r,400));
        const models=(options.cursor?['owner/A','owner/C']:['owner/B','owner/A']).map((id,i)=>({id,downloads:i+1,likes:4,license:i?'apache-2.0':'mit',pipelineTag:'text-generation',lastModified:'2026-09-10T00:00:00Z'}));
        return {ok:true,data:{models:q==='slow'?[{...models[0],id:'stale/result'}]:models,cursor:options.cursor?null:'next-page'}};
      });
    });
    await nav('hf');await page.locator('#hf-q').fill('models');await page.locator('#hf-go').click();
    await expect(page.locator('#grid-hf tbody tr')).toHaveCount(2);
    await page.locator('#hf-sort').selectOption('lastModified');
    await expect.poll(()=>app.evaluate(()=>globalThis.browseRequests.at(-1).options.sort)).toBe('lastModified');
    await page.locator('#hf-filter-toggle').click();await page.locator('#hf-author').fill('owner');
    await page.locator('#hf-search-format').selectOption('gguf');await page.locator('#hf-license').selectOption('mit');
    await page.locator('#hf-access-filter').selectOption('false');await page.locator('#hf-apply-filters').click();
    await expect.poll(()=>app.evaluate(()=>globalThis.browseRequests.at(-1).options.author)).toBe('owner');
    await page.locator('#hf-more').click();
    await expect(page.locator('#grid-hf tbody tr')).toHaveCount(3);
    await expect(page.locator('#hf-more')).toBeHidden();
    expect(await app.evaluate(()=>globalThis.browseRequests.at(-1).options)).toMatchObject({cursor:'next-page',author:'owner',format:'gguf',license:'mit',gated:'false',sort:'lastModified'});
    await page.locator('#grid-hf th[data-k="id"]').click();
    await expect(page.locator('#grid-hf tbody tr').first()).toHaveAttribute('data-id','owner/A');
    await expect(page.locator('#hf-sort-scope')).toContainText('loaded results only');
    await page.locator('#hf-q').fill('slow');await page.locator('#hf-go').click();
    await page.locator('#hf-q').fill('fast');await page.locator('#hf-go').click();
    await expect(page.locator('#hf-go')).toHaveText('Search');
    await page.waitForTimeout(500);
    await expect(page.locator('#grid-hf tbody')).not.toContainText('stale/result');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(980,600));
    await page.screenshot({path:'test-results/screenshots/hf-discovery.png'});
  });

  test('configs-only and tagged revisions queue just selected files at the chosen commit', async () => {
    await app.evaluate(({ipcMain})=>{
      globalThis.configDownload=null;
      for(const name of ['hf:model','hf:refs','hf:download'])ipcMain.removeHandler(name);
      ipcMain.handle('hf:refs',()=>({ok:true,data:[{name:'main',type:'Branch'},{name:'v1.0',type:'Tag'}]}));
      ipcMain.handle('hf:model',(_,id,revision)=>({ok:true,data:{id,sha:(revision==='v1.0'?'b':'a').repeat(40),files:[{path:'weights.gguf',size:1000000},{path:'config.json',size:123},{path:'tokenizer.json',size:234},{path:'README.md',size:456}],license:'mit',gated:false}}));
      ipcMain.handle('hf:download',(_,request)=>{globalThis.configDownload=request;return {ok:true,data:{downloads:[]}};});
    });
    await page.locator('#hf-filter-toggle').click();
    await page.locator('#grid-hf tbody tr').first().click();
    await page.locator('#hf-revisions').click();
    await page.locator('#hf-revision').selectOption('v1.0');
    await expect(page.locator('.hf-revision')).toContainText('bbbbbbbb');
    await page.locator('#hf-configs').click();
    await expect(page.locator('#hf-selinfo')).toHaveText('2 files selected');
    await page.locator('#hf-file-sort').selectOption('large');
    await expect(page.locator('#hf-files .fname').first()).toHaveText('tokenizer.json');
    await page.locator('#hf-download').click();
    expect(await app.evaluate(()=>globalThis.configDownload)).toMatchObject({revision:'b'.repeat(40),files:[{path:'config.json',size:123},{path:'tokenizer.json',size:234}]});
    expect(errors).toEqual([]);
  });

  test('Pirate Face provider toggle searches torrents, inspects detail manifest, and hands canonical magnet to reviewed dialog', async () => {
    const infoHash = '4065fc6dc7f3fa8fd6fbcfcec1bcdecdbb98ba93';
    const commit = '8b5dadf2d9b842ef8f6a77e12aa90dc2a1f4ab12';
    const canonicalMagnet = `magnet:?xt=urn:btih:${infoHash}&dn=Qwen%2FQwen3-8B-MLX-4bit`;
    await app.evaluate(({ipcMain}, {infoHash: hash, commit: rev, canonicalMagnet: magnet}) => {
      globalThis.pfInspectMagnet = null;
      ipcMain.removeHandler('pirateface:search');
      ipcMain.removeHandler('pirateface:torrents');
      ipcMain.removeHandler('torrent:inspect');
      ipcMain.handle('pirateface:search', (_e, q) => ({
        ok: true,
        data: {
          query: q,
          endpoint: `https://pirateface.co/s/${encodeURIComponent(q)}`,
          models: [
            { id: 'Qwen/Qwen3-8B-MLX-4bit', repoId: 'Qwen/Qwen3-8B-MLX-4bit', author: 'Qwen', name: 'Qwen3-8B-MLX-4bit', sizeLabel: '4.3 GB', sizeBytes: 4617089843, exceedsOneTiB: false, seeds: 18, infoHash: hash, revision: rev, provenanceHosts: ['tracker.pirateface.co', 'pirateface.co'], canonicalMagnet: magnet },
            { id: 'Alibaba/Zvec-0.5B', repoId: 'Alibaba/Zvec-0.5B', author: 'Alibaba', name: 'Zvec-0.5B', sizeLabel: '900 MB', sizeBytes: 943718400, exceedsOneTiB: false, seeds: 4, infoHash: '7154ff8f845e5c219a0d5b5ed6c98988276511a3', revision: rev, provenanceHosts: ['tracker.pirateface.co'], canonicalMagnet: 'magnet:?xt=urn:btih:7154ff8f845e5c219a0d5b5ed6c98988276511a3&dn=Alibaba%2FZvec-0.5B' },
          ],
        },
      }));
      ipcMain.handle('pirateface:torrents', (_e, repoId) => ({
        ok: true,
        data: {
          repoId,
          endpoint: `https://pirateface.co/api/torrents?repo=${encodeURIComponent(repoId)}`,
          revision: rev,
          seeders: 18,
          leechers: 3,
          quant: 'full',
          quants: [{ id: 'full', label: 'full', fileCount: 2 }],
          files: [
            { path: 'config.json', size: 1024, sha256: '' },
            { path: 'model.safetensors', size: 4617088819, sha256: 'a'.repeat(64) },
          ],
          totalBytes: 4617089843,
          exceedsOneTiB: false,
          infoHash: hash,
          canonicalMagnet: magnet,
          provenanceHosts: ['tracker.pirateface.co', 'pirateface.co'],
          termsRequired: false,
          licenseNotice: { kind: 'known', id: 'apache-2.0', name: 'Apache 2.0', version: '', termsUrl: '', policyUrl: '', acceptFirst: false, notice: 'Open license.' },
        },
      }));
      ipcMain.handle('torrent:inspect', (_e, target) => {
        globalThis.pfInspectMagnet = target?.source ?? target;
        return { ok: true, data: { infoHash: hash, name: 'Qwen/Qwen3-8B-MLX-4bit', totalLength: 4617089843, pieceLength: 1048576, files: [{ index: 0, path: 'model.safetensors', length: 4617088819 }] } };
      });
    }, { infoHash, commit, canonicalMagnet });

    await nav('hf');
    await page.locator('#hf-provider-switch [data-hf-provider="pirateface"]').click();
    await expect(page.locator('#pf-browsebar')).toBeVisible();
    await expect(page.locator('#hf-browsebar')).toBeHidden();
    await expect(page.locator('#hf-format-chips')).toBeHidden();
    await expect(page.locator('#hf-tokenstate')).toBeHidden();

    await page.locator('#pf-browsebar [data-pf-quick="qwen3"]').click();
    await expect(page.locator('#grid-hf tbody tr[data-pf-id]')).toHaveCount(2);
    await expect(page.locator('#grid-hf tbody tr').first()).toHaveAttribute('data-pf-id', 'Qwen/Qwen3-8B-MLX-4bit');

    await page.locator('#grid-hf thead th[data-k="name"]').click();
    await expect(page.locator('#grid-hf tbody tr').first()).toHaveAttribute('data-pf-id', 'Alibaba/Zvec-0.5B');

    await page.locator('#grid-hf tbody tr[data-pf-id="Qwen/Qwen3-8B-MLX-4bit"]').click();
    await expect(page.locator('#hf-detail')).toContainText('Pirate Face · Community torrent');
    await expect(page.locator('#hf-detail')).toContainText('tracker.pirateface.co, pirateface.co (stripped by FrostByte)');
    await expect(page.locator('#hf-detail')).toContainText('sha256:aaaaaaaaaa…');

    await page.locator('#hf-detail [data-pf-act="inspect"]').click();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#dl-magnet')).toHaveValue(canonicalMagnet);
    expect(await app.evaluate(() => globalThis.pfInspectMagnet)).toBe(canonicalMagnet);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();

    await page.locator('#hf-provider-switch [data-hf-provider="hf"]').click();
    await expect(page.locator('#hf-browsebar')).toBeVisible();
    await expect(page.locator('#pf-browsebar')).toBeHidden();
    expect(errors).toEqual([]);
  });
});
