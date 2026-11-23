import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptBetaTerms } from './consent-helper.js';

let app, page, directory;
test.beforeEach(async () => {
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'fb-network-ui-'));
  fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({downloadDir:path.join(directory,'downloads'),dhtEnabled:false,upnpEnabled:false,confirmExitSeeding:false}));
  app=await electron.launch({args:['.'],env:{...process.env,FROSTBYTE_HOME:directory,FROSTBYTE_EDITION:'community'}});
  page=await app.firstWindow(); await acceptBetaTerms(page,app);
  await page.waitForFunction(()=>document.querySelector('#nav .nav.on'));
  await app.evaluate(({ipcMain})=>{
    globalThis.networkFixture={scans:[],inventory:0,overlays:[],scan:{phase:'idle',results:[]}};
    const f=globalThis.networkFixture;
    const data=()=>({candidates:[{id:'lan',name:'Ethernet',address:'10.0.0.9',cidr:'10.0.0.0/24',kind:'lan'},
      {id:'wg',name:'utun4',address:'10.80.10.10',kind:'wireguard',overlayId:'wg-overlay'}],overlays:f.overlays,
      wireguard:{installed:true,services:[{id:'wg-overlay',name:'utun4',active:true}]},scan:f.scan});
    for(const channel of ['inventory','scan','overlay','snapshot']) ipcMain.removeHandler('network-devices:'+channel);
    ipcMain.handle('network-devices:inventory',()=>{f.inventory++;return {ok:true,data:data()};});
    ipcMain.handle('network-devices:snapshot',()=>({ok:true,data:data()}));
    ipcMain.handle('network-devices:overlay',(_,id,enabled)=>{f.overlays=enabled?[{id,name:'utun4'}]:[];return {ok:true,data:data()};});
    ipcMain.handle('network-devices:scan',(_,request)=>{
      f.scans.push(request);
      if(request.host==='bad.local') return {ok:false,error:'That hostname does not resolve exclusively to private IPv4 addresses.'};
      f.scan={phase:'complete',checked:1,total:1,results:[{name:'desktop-128.local',address:'10.0.0.44',ssh:true,smb:true,platformHint:'windows'},
        {name:'NAS <untrusted>',address:'10.0.0.5',ssh:true,smb:true,platformHint:'unknown'}]};
      return {ok:true,data:data()};
    });
  });
  await page.locator('#nav [data-tab="spark"]').click(); await page.locator('#devices-discover').click();
});
test.afterEach(async()=>{await app?.close();fs.rmSync(directory,{recursive:true,force:true});});
test('discovery is opt-in, distinguishes Windows discovery from pairing, and prefills supported setup',async()=>{
  expect(await app.evaluate(()=>globalThis.networkFixture.inventory)).toBe(0);
  await expect(page.locator('#network-scan')).toBeDisabled();
  await page.locator('#network-refresh').click(); await expect(page.locator('#wireguard-status')).toContainText('1 WireGuard');
  await page.locator('#network-host').fill('desktop-128.local'); await page.locator('#network-scan').click();
  await expect(page.locator('#network-results')).toContainText('10.0.0.44');
  const windows=page.locator('.network-device').first(); await expect(windows).toContainText('Found, not paired');
  await expect(windows.getByRole('button',{name:'Set up companion'})).toHaveCount(0);
  await expect(page.locator('.network-device').nth(1)).toContainText('NAS <untrusted>');
  await page.getByRole('button',{name:'Set up companion',exact:true}).click();
  await expect(page.locator('#spark-setup-host')).toHaveValue('10.0.0.5');
  expect(await app.evaluate(()=>globalThis.networkFixture.scans)).toEqual([{networkId:'lan',host:'desktop-128.local'}]);
});
test('adding an existing overlay exposes exact-peer discovery and removing it removes the choice',async()=>{
  await page.locator('#network-refresh').click();
  await expect(page.locator('#network-interface option[value="wg"]')).toHaveCount(0);
  await page.getByRole('button',{name:'Add overlay',exact:true}).click();
  await page.locator('#network-interface').selectOption('wg');
  await expect(page.locator('#network-host')).toHaveAttribute('placeholder',/Required/);
  await expect(page.locator('#sec-network')).toContainText('not a torrent VPN binding or kill switch');
  await page.getByRole('button',{name:'Remove from FrostByte',exact:true}).click();
  await expect(page.locator('#network-interface option[value="wg"]')).toHaveCount(0);
});
test('discovery errors are visible and can be retried without fake results',async()=>{
  await page.locator('#network-refresh').click(); await page.locator('#network-host').fill('bad.local');
  await page.locator('#network-scan').click(); await expect(page.locator('#network-message')).toContainText('private IPv4');
  await expect(page.locator('.network-device')).toHaveCount(0);
  await page.locator('#network-host').fill('10.0.0.44');await page.locator('#network-scan').click();
  await expect(page.locator('.network-device')).toHaveCount(2);
});
