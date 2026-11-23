import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NetworkDevices, lanRange, privateIpv4, wireguardInterfaces } from '../src/main/network-devices.js';

const interfaces = () => ({ en0: [{ address: '10.0.0.9', netmask: '255.255.255.0', internal: false }],
  utun4: [{ address: '10.80.10.10', netmask: '255.255.255.255', internal: false }],
  utun5: [{ address: '10.90.0.1', netmask: '255.255.255.0', internal: false }],
  lo0: [{ address: '127.0.0.1', internal: true }], public: [{ address: '8.8.8.8', netmask: '255.255.255.0' }] });
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-network-'));
  const calls = [], approvals = [], lookups = [];
  const service = new NetworkDevices({ directory, interfaces, detectWireguard: async () => ({ installed: true, names: ['utun4'] }),
    confirm: async review => { approvals.push(review); return true; },
    lookup: async host => { lookups.push(host); return [{ address: '10.0.0.44' }]; },
    probe: async (address, options) => { calls.push({ address, options }); return { address, ssh: address.endsWith('.44'), smb: false, platformHint: 'windows' }; }, ...overrides });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, directory, calls, approvals, lookups };
}
test('ranges are private, bounded to a /24, and exclude network/broadcast/local addresses', () => {
  for (const ip of ['10.0.0.1','172.16.0.1','172.31.255.1','192.168.1.2']) assert.equal(privateIpv4(ip), true);
  for (const ip of ['127.0.0.1','8.8.8.8','169.254.1.1','172.32.0.1','0.0.0.0','::1','010.1.1.1']) assert.equal(privateIpv4(ip), false);
  const result = lanRange('10.0.5.9','255.0.0.0');
  assert.equal(result.cidr, '10.0.5.0/24'); assert.equal(result.targets.length,253);
  assert.ok(!result.targets.includes('10.0.5.9')); assert.ok(!result.targets.includes('10.0.5.255'));
  assert.equal(lanRange('10.0.0.9','255.255.255.255').targets.length,0);
  assert.throws(() => lanRange('10.0.0.9','255.0.255.0'));
});
test('WireGuard discovery requests only interface names; permission failures do not read configurations', async () => {
  const calls=[];
  const found=await wireguardInterfaces({platform:'darwin',exists:()=>true,run:async(file,args)=>{calls.push(args);return 'utun4\n';}});
  assert.deepEqual(found.names,['utun4']); assert.deepEqual(calls,[['show','interfaces']]);
  const denied=await wireguardInterfaces({platform:'linux',exists:()=>true,run:async()=>{throw new Error('permission denied');}});
  assert.equal(denied.unavailable,true); assert.deepEqual(denied.names,[]);
});
test('inventory is local only and does not confuse arbitrary utun interfaces with WireGuard', async t => {
  const {service,calls,lookups}=fixture(t); const state=await service.inventory();
  assert.deepEqual(calls,[]); assert.deepEqual(lookups,[]);
  assert.deepEqual(state.candidates.map(row=>row.kind),['lan','wireguard','vpn']);
  assert.equal(state.candidates[1].scanAvailable,false);
  assert.deepEqual(service.overlays,[]);
});
test('declining approval performs neither hostname resolution nor device probes', async t => {
  const {service,calls,lookups}=fixture(t,{confirm:async()=>false});
  const networkId=(await service.inventory()).candidates[0].id;
  assert.equal((await service.start({networkId,host:'desktop-128.local'})).cancelled,true);
  assert.deepEqual(calls,[]); assert.deepEqual(lookups,[]);
});
test('exact hostname checks are pinned to private answers and return untrusted Windows candidates', async t => {
  const {service,calls,approvals}=fixture(t); const networkId=(await service.inventory()).candidates[0].id;
  await service.start({networkId,host:'desktop-128.local'}); await service.pending;
  assert.deepEqual(calls.map(row=>row.address),['10.0.0.44']);
  assert.equal(calls[0].options.localAddress,'10.0.0.9');
  assert.equal(service.scan.results[0].platformHint,'windows');
  assert.equal(service.scan.phase,'complete'); assert.equal(approvals[0].remember.kind,'network-discovery');
  assert.equal(approvals[0].remember.scope[2],'desktop-128.local');
});
test('public DNS answers, mixed answers and off-LAN addresses fail closed', async t => {
  for(const answers of [[{address:'8.8.8.8'}],[{address:'10.0.0.44'},{address:'1.1.1.1'}],[{address:'10.80.10.13'}]]) {
    const {service,calls}=fixture(t,{lookup:async()=>answers});const networkId=(await service.inventory()).candidates[0].id;
    await assert.rejects(service.start({networkId,host:'untrusted.local'})); assert.deepEqual(calls,[]);
  }
});
test('network changes during review abort the scan', async t => {
  let current=interfaces();
  const {service,calls}=fixture(t,{interfaces:()=>current,confirm:async()=>{current={};return true;}});
  const networkId=(await service.inventory()).candidates[0].id;
  await assert.rejects(service.start({networkId}),/network changed/i); assert.deepEqual(calls,[]);
});
test('WireGuard overlay saves only its name; exact peer checks require opt-in and no subnet sweep', async t => {
  const {service,directory,calls}=fixture(t); const inventory=await service.inventory(), tunnel=inventory.candidates[1];
  await assert.rejects(service.start({networkId:tunnel.id,host:'10.80.10.13'}),/Add a detected/);
  await service.setOverlay(tunnel.overlayId,true);
  const saved=JSON.parse(fs.readFileSync(path.join(directory,'network-overlays.json'),'utf8'));
  assert.deepEqual(Object.keys(saved.overlays[0]).sort(),['id','name']);
  await assert.rejects(service.start({networkId:tunnel.id}),/exact private peer/);
  await service.start({networkId:tunnel.id,host:'10.80.10.13'}); await service.pending;
  assert.equal(calls[0].options.localAddress,'10.80.10.10');
  await service.setOverlay(tunnel.overlayId,false); assert.deepEqual(service.overlays,[]);
});
test('cancelling a scan stops new work and allows a later scan', async t => {
  let started=0;
  const {service}=fixture(t,{probe:async(address,{signal})=>{started++; await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {address,ssh:true};}});
  const networkId=(await service.inventory()).candidates[0].id;
  await service.start({networkId});
  await assert.rejects(service.start({networkId}),/already/);
  service.cancel(); await service.pending;
  assert.equal(service.scan.phase,'cancelled'); assert.ok(started<=12); assert.equal(service.scan.results.length,0);
});
test('source wiring preserves native consent and v1 has no beta splash branding', () => {
  const main=fs.readFileSync(new URL('../src/main/index.js',import.meta.url),'utf8');
  const markup=fs.readFileSync(new URL('../src/renderer/index.html',import.meta.url),'utf8');
  assert.match(main,/registerNetworkDevices\(\{ handle, service: networkDevices \}\)/);
  assert.match(main,/buttons: \['Cancel', action\], defaultId: 0, cancelId: 0/);
  assert.doesNotMatch(markup,/PRIVATE BETA|Devices <span class="chip">Beta/);
  assert.doesNotMatch(markup,/id="(?:welcome-diagnostics|set-diagnostics|feedback-diagnostics)"/);
  assert.match(markup,/No data collection/);
  assert.match(markup,/id="accept-terms"/);
  // Release-intent check: this must ship as a real, non-beta semver release.
  // Deliberately not pinned to one literal so a version bump does not require
  // editing a test; the 1.0 floor is what the assertion is actually guarding.
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number(version.split('.')[0]) >= 1, `expected a 1.x+ release, got ${version}`);
});
