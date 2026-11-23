import { exposeCompanionDevice } from './companion-fixture.js';
import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TorrentEngine } from '../../src/main/torrent.js';
import { hfModelInfo, sha256File } from '../../src/main/hf.js';
import { sparkRequest } from '../../src/main/spark.js';

const launch = home => electron.launch({executablePath:process.env.FROSTBYTE_EXECUTABLE,args:process.env.FROSTBYTE_EXECUTABLE?[]:['.'],env:{...process.env,FROSTBYTE_HOME:home}});
const prepare=()=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'fb-spark-ui-'));fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({downloadDir:path.join(home,'downloads'),sparkHost:'spark',upnpEnabled:false,dhtEnabled:false,confirmExitSeeding:false,confirmBigPull:false}));return home;};

test('Spark connection and browsing stay in setup while remote downloads open Transfers', async () => {
  const home=prepare();let app;
  try {
    app=await launch(home);const page=await app.firstWindow(); await acceptBetaTerms(page, app);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>document.querySelector('#nav .nav.on'));
    await app.evaluate(({ipcMain})=>{
      const status={hostname:'test-spark',architecture:'arm64',version:'0.2.0-beta.1',downloadDir:'/home/test/FrostByte',freeBytes:1024**4,totalBytes:2*1024**4,memoryBytes:128*1024**3,torrents:[],downloads:[]};
      globalThis.sparkTest={status,add:null,hf:null,online:true};
      for(const name of ['spark:connect','spark:status','spark:files','torrent:inspect','torrent:add','hf:search','hf:model','spark:hf-download'])ipcMain.removeHandler(name);
      ipcMain.handle('spark:connect',()=>({ok:true,data:status}));
      ipcMain.handle('spark:status',()=>({ok:true,data:globalThis.sparkTest.online?{connected:true,status}:{connected:false,error:'Spark is offline. Reconnect when available.'}}));
      ipcMain.handle('spark:files',(_,relative)=>({ok:true,data:{entries:relative?[{name:'config.json',relative:'Model/config.json',size:123,directory:false}]:[{name:'Model',relative:'Model',directory:true}],relative}}));
      ipcMain.handle('torrent:inspect',()=>({ok:true,data:{preview:{name:'Update',files:[{path:'update.zip',length:123}]}}}));
      ipcMain.handle('torrent:add',(_,source,options)=>{globalThis.sparkTest.add={source,options};return {ok:true,data:{remote:true,state:{torrents:[],downloads:[]}}};});
      ipcMain.handle('hf:search',()=>({ok:true,data:[{id:'owner/model',downloads:2,likes:1}]}));
      ipcMain.handle('hf:model',()=>({ok:true,data:{id:'owner/model',sha:'a'.repeat(40),files:[{path:'config.json',size:123}]}}));
      ipcMain.handle('spark:hf-download',(_,request)=>{globalThis.sparkTest.hf=request;return {ok:true,data:['queued']};});
    });
    await exposeCompanionDevice(app);
    await page.reload();
    await page.locator('#nav [data-tab="spark"]').click();await page.locator('[data-select-device="spark"]').click();await page.locator('#spark-connect').click();
    await expect(page.locator('#spark-message')).toContainText('Connected to test-spark');
    await expect(page.locator('#spark-storage-summary')).toContainText('1.0 TB');
    if (!await page.locator('#spark-files-section').evaluate(section => section.open)) await page.locator('#spark-files-section > summary').click();
    await page.locator('[data-spark-dir="Model"]').click();
    await expect(page.locator('#spark-files')).toContainText('config.json');
    await page.locator('#spark-up').click();
    await page.locator('#nav [data-tab="transfers"]').click();await page.locator('#btn-add').click();
    await page.locator('#dl-magnet').fill('magnet:?xt=urn:btih:'+'a'.repeat(40));
    await page.locator('#dl-target').selectOption('spark');
    await expect(page.locator('#dl-destination')).toHaveText('/home/test/FrostByte');
    await page.locator('#modal-acts button.primary').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    await expect.poll(() => app.evaluate(() => globalThis.sparkTest.add?.options?.target)).toBe('spark');
    await page.locator('#nav [data-tab="hf"]').click();await page.locator('#hf-q').fill('model');await page.locator('#hf-go').click();
    await page.locator('#grid-hf tbody tr').click();await page.locator('#hf-target').selectOption('spark');
    await page.locator('#hf-configs').click();await page.locator('#hf-download').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    await expect.poll(() => app.evaluate(() => globalThis.sparkTest.hf)).toMatchObject({repoId:'owner/model',revision:'a'.repeat(40),files:[{path:'config.json',size:123}]});
    await app.evaluate(()=>{globalThis.sparkTest.online=false;});await page.locator('#nav [data-tab="spark"]').click();await page.locator('#spark-refresh').click();
    await expect(page.locator('#spark-message')).toContainText('Spark is offline');
    expect(errors).toEqual([]);
  } finally {await app?.close();fs.rmSync(home,{recursive:true,force:true});}
});

test('live DGX Spark receives a Mac torrent and a pinned HF config, then survives Mac restart', async () => {
  test.skip(!process.env.FROSTBYTE_TEST_SPARK,'Set FROSTBYTE_TEST_SPARK to run against your beta device.');
  test.setTimeout(120000);
  const host=process.env.FROSTBYTE_TEST_SPARK,home=prepare();
  const seed=new TorrentEngine({dht:false,tracker:false,lsd:false});
  const name=`frostbyte-beta-check-${crypto.randomBytes(5).toString('hex')}.txt`;
  const file=path.join(home,name);fs.writeFileSync(file,crypto.randomBytes(256*1024));
  let app,shared;
  const remoteStatus = await sparkRequest(host, {action:'status'});
  const remoteFile = (action, file) => execFileSync('/usr/bin/ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,"python3 -c 'import base64;exec(base64.b64decode(\"aW1wb3J0IGpzb24sc3lzLGhhc2hsaWIsb3M7IHI9anNvbi5sb2FkKHN5cy5zdGRpbik7IHA9clsicGF0aCJdOyBwcmludChoYXNobGliLnNoYTI1NihvcGVuKHAsInJiIikucmVhZCgpKS5oZXhkaWdlc3QoKSkgaWYgclsiYWN0aW9uIl09PSJoYXNoIiBlbHNlIG9zLnVubGluayhwKSBpZiBvcy5wYXRoLmlzZmlsZShwKSBlbHNlIE5vbmU=\"))'"], {input:JSON.stringify({action,path:path.posix.join(remoteStatus.downloadDir,file)}),encoding:'utf8'}).trim();
  try {
    shared=await seed.seed(file);
    app=await launch(home);let page=await app.firstWindow(); await acceptBetaTerms(page, app);await page.waitForFunction(()=>document.querySelector('#nav .nav.on'));
    await page.locator('#nav [data-tab="spark"]').click();await page.locator('[data-select-device="spark"]').click();await page.locator('#spark-host').fill(host);await page.locator('#spark-connect').click();
    await expect(page.locator('#spark-message')).toContainText(`Connected to ${remoteStatus.hostname}`);
    await page.locator('#nav [data-tab="transfers"]').click();await page.locator('#btn-add').click();
    await page.locator('#dl-magnet').fill(shared.magnetURI+`&x.pe=${process.env.FROSTBYTE_TEST_MAC_IP || '10.80.10.10'}:${seed.port}`);
    await page.locator('#dl-target').selectOption('spark');await page.locator('#modal-acts button.primary').click();
    await expect(page.locator('#view-transfers')).toBeVisible();
    await expect.poll(async()=> (await sparkRequest(host,{action:'status'})).torrents.find(t=>t.infoHash===shared.infoHash)?.done,{timeout:40000}).toBe(true);
    const digest=remoteFile('hash', name);
    expect(digest).toBe(await sha256File(file));
    await page.locator('#nav [data-tab="hf"]').click();await page.locator('#hf-q').fill('Qwen3-0.6B');await page.locator('#hf-go').click();
    await page.locator('#grid-hf tr[data-id="Qwen/Qwen3-0.6B"]').click();
    await page.locator('#hf-target').selectOption('spark');await page.locator('#hf-configs').click();
    await page.locator('#hf-pick-none').click();await page.locator('#hf-files input[data-f="config.json"]').check();
    await page.locator('#hf-download').click();
    await expect.poll(async()=> (await sparkRequest(host,{action:'status'})).downloads.find(d=>d.repoId==='Qwen/Qwen3-0.6B'&&d.filePath==='config.json')?.status).toBe('done');
    const metadata=await hfModelInfo('Qwen/Qwen3-0.6B');
    const expected=Buffer.from(await (await fetch(`https://huggingface.co/Qwen/Qwen3-0.6B/resolve/${metadata.sha}/config.json`)).arrayBuffer());
    const configDigest=remoteFile('hash', 'Qwen/Qwen3-0.6B/config.json');
    expect(configDigest).toBe(crypto.createHash('sha256').update(expected).digest('hex'));
    await app.close();app=await launch(home);page=await app.firstWindow(); await acceptBetaTerms(page, app);await page.waitForFunction(()=>document.querySelector('#nav .nav.on'));
    await page.locator('#nav [data-tab="spark"]').click();await page.locator('[data-select-device="spark"]').click();await page.locator('#spark-connect').click();
    await page.locator('#nav [data-tab="transfers"]').click();
    await expect(page.locator('#transfers')).toContainText(name);
    fs.mkdirSync('test-results/screenshots',{recursive:true});await page.screenshot({path:'test-results/screenshots/spark-live.png'});
  } finally {
    await app?.close();if(shared)await sparkRequest(host,{action:'torrent:remove',id:shared.infoHash});
    remoteFile('remove', name);
    await seed.destroy();fs.rmSync(home,{recursive:true,force:true});
  }
});
