import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyDevice, deviceArtwork } from '../src/shared/device-models.js';
import { boundedDeviceInfo, readDeviceInfo } from '../src/main/device-info.js';
import { DEVICE_PHOTOS } from '../src/shared/device-photos.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

test('Mac identifiers separate the small M4 mini, older mini, and Studio without guessing memory', () => {
  const input = { platform: 'darwin', chip: 'Apple M4', memoryBytes: 16 * 1024 ** 3 };
  assert.equal(identifyDevice({ ...input, modelIdentifier: 'Mac16,10' }).artwork, 'mac-mini-2024');
  assert.equal(identifyDevice({ ...input, modelIdentifier: 'Macmini9,1' }).artwork, 'mac-mini-unibody');
  const studio = identifyDevice({ ...input, modelIdentifier: 'Mac16,9', memoryBytes: 64 * 1024 ** 3 });
  assert.equal(studio.name, 'Mac Studio (2025)'); assert.equal(studio.memoryBytes, 64 * 1024 ** 3);
});
test('GB10 alone never labels an OEM or unknown enclosure as an NVIDIA DGX', () => {
  const known = identifyDevice({ platform: 'linux', vendor: 'NVIDIA', modelIdentifier: 'NVIDIA_DGX_Spark' });
  assert.equal(known.name, 'NVIDIA DGX Spark'); assert.equal(known.artworkMatch, 'exact');
  const oem = identifyDevice({ platform: 'linux', vendor: 'ASUS', reportedModel: 'ASUS Ascent GX10', chip: 'GB10' });
  assert.equal(oem.name, 'ASUS Ascent GX10'); assert.equal(oem.artwork, 'asus-gx10'); assert.equal(oem.artworkMatch, 'exact');
  assert.equal(identifyDevice({ platform: 'linux', vendor: 'Dell Inc.', modelIdentifier: 'Pro Max with GB10 FCM1253' }).artwork, 'dell-gb10');
  assert.equal(identifyDevice({ platform: 'linux', vendor: 'ASUS', reportedModel: 'Custom PC', chip: 'GB10' }).artwork, 'computer');
  assert.equal(identifyDevice({ platform: 'darwin', modelIdentifier: 'Mac99,9', chip: 'Apple M4' }).artworkMatch, 'unknown');
});
test('device details are allowlisted and artwork cannot be an external URL or path', () => {
  const value = identifyDevice({ platform: 'darwin', modelIdentifier: 'Mac16,10', serialNumber: 'secret-serial', uuid: 'secret-uuid', artwork: 'https://example.com/tracker', memoryBytes: Infinity });
  assert.equal(value.memoryBytes, 0); assert.doesNotMatch(JSON.stringify(value), /secret|tracker/);
  assert.equal(deviceArtwork(value, '../../private'), 'mac-mini-2024');
});
test('Mac hardware keeps GPU model/core counts and discards unrelated display metadata', async () => {
  const calls = [];
  const info = await readDeviceInfo({ platform: 'darwin', architecture: 'arm64', memoryBytes: 16 * 1024 ** 3, cpuCores: 10,
    run: async (file, args) => { calls.push([file, args]); return { stdout: args.includes('SPDisplaysDataType') ? JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M4', sppci_cores: '10', serialNumber: 'private', spdisplays_ndrvs: [{ serial: 'private-display' }] }] }) : args.includes('hw.model') ? 'Mac16,10\n' : args.includes('machdep.cpu.brand_string') ? 'Apple M4\n' : args.includes('hw.physicalcpu') ? '10\n' : '26.0\n' }; },
  });
  assert.equal(info.name, 'Mac mini (2024)'); assert.equal(info.chip, 'Apple M4'); assert.equal(info.cpuCores, 10);
  assert.equal(calls.length, 5);
  assert.deepEqual(info.gpus, [{ name: 'Apple M4', cores: 10, source: 'system' }]);
  assert.ok(calls.some(([, args]) => args.includes('SPDisplaysDataType') && args.includes('mini')));
  assert.doesNotMatch(JSON.stringify(info), /private|serial|ndrvs/);
});

test('Linux companions identify the host OS rather than the Docker base image', async () => {
  const files = { '/sys/class/dmi/id/sys_vendor': 'NVIDIA', '/sys/class/dmi/id/product_name': 'NVIDIA_DGX_Spark', '/etc/os-release': 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"' };
  const info = await readDeviceInfo({ platform: 'linux', architecture: 'arm64', env: { FROSTBYTE_HOST_OS: 'Ubuntu 24.04.4 LTS', FROSTBYTE_HOST_GPUS: '[{"name":"NVIDIA GB10","source":"system","uuid":"private"}]' }, read: async file => files[file] || '' });
  assert.equal(info.name, 'NVIDIA DGX Spark');
  assert.equal(info.osVersion, 'Ubuntu 24.04.4 LTS');
  assert.deepEqual(info.gpus, [{ name: 'NVIDIA GB10', cores: 0, source: 'system' }]);
});

test('Windows laptop and desktop cards retain the reported model and every reported GPU', async () => {
  for (const [systemType, chassis, artwork] of [[2, [10], 'pc-laptop'], [1, [3], 'pc-desktop'], [0, [31], 'pc-laptop']]) {
    const calls = [];
    const info = await readDeviceInfo({ platform: 'win32', run: async (file, args) => {
      calls.push([file, args]); return { stdout: JSON.stringify({ vendor: 'MSI', model: 'Creator 16 AI Studio', systemType, chassis,
        cpuCores: 16, gpus: [{ name: 'Intel Arc Graphics' }, { name: 'NVIDIA GeForce RTX 4090 Laptop GPU', serial: 'private', uuid: 'private' }, { name: 'USB 3.0 External Graphic Device' }] }) };
    } });
    assert.equal(info.name, 'Creator 16 AI Studio'); assert.equal(info.artwork, artwork);
    assert.deepEqual(info.gpus.map(gpu => gpu.name), ['Intel Arc Graphics', 'NVIDIA GeForce RTX 4090 Laptop GPU']);
    assert.equal(info.cpuCores, 16);
    assert.doesNotMatch(JSON.stringify(info), /private|serial|uuid/);
    assert.doesNotMatch(JSON.stringify(calls), /SerialNumber|IdentifyingNumber|UUID|Win32_ComputerSystemProduct/);
  }
});

test('failed or incomplete GPU collection stays honest and fixed GB10 facts have provenance', async () => {
  const failed = await readDeviceInfo({ platform: 'darwin', run: async () => { throw new Error('unavailable'); } });
  assert.deepEqual(failed.gpus, []);
  const known = identifyDevice({ platform: 'linux', vendor: 'NVIDIA', modelIdentifier: 'NVIDIA_DGX_Spark', chip: 'unknown' });
  assert.equal(known.gpus[0].source, 'model'); assert.equal(known.gpus[0].name, 'NVIDIA GB10 Blackwell');
  const bounded = identifyDevice({ gpus: Array.from({ length: 40 }, () => ({ name: 'G'.repeat(300), cores: Infinity, uuid: 'private' })) });
  assert.equal(bounded.gpus.length, 16); assert.equal(bounded.gpus[0].name.length, 160); assert.equal(bounded.gpus[0].cores, 0);
});

test('device discovery cannot hold application startup indefinitely', async () => {
  const fallback = { name: 'Local computer', artwork: 'computer' };
  const started = Date.now();
  const info = await boundedDeviceInfo({
    probe: () => new Promise(() => {}),
    fallback: () => fallback,
    timeoutMs: 15,
  });
  assert.equal(info, fallback);
  assert.ok(Date.now() - started < 500, 'the bounded probe returns its fallback promptly');
});

test('Linux physical cores deduplicate sibling threads within each CPU socket', async () => {
  const info = await readDeviceInfo({ platform: 'linux', logicalCpuCount: 8, env: {},
    read: async file => file.endsWith('/online') ? '0-7' : file.includes('/core_cpus_list') ? `${Number(file.match(/cpu(\d+)/)[1]) % 4},${Number(file.match(/cpu(\d+)/)[1]) % 4 + 4}` : '',
    run: async () => ({ stdout: '' }),
  });
  assert.equal(info.cpuCores, 4); assert.equal(info.logicalCpuCount, 8);
});

test('Spark ARM clusters count all 20 physical cores despite repeated core IDs', async () => {
  const info = await readDeviceInfo({ platform: 'linux', architecture: 'arm64', logicalCpuCount: 20, env: {},
    read: async file => file.endsWith('/online') ? '0-19' : file.includes('/thread_siblings_list') ? file.match(/cpu(\d+)/)[1] : '',
    run: async () => ({ stdout: '' }),
  });
  assert.equal(info.cpuCores, 20); assert.equal(info.logicalCpuCount, 20);
});

test('Incomplete Linux core topology does not present a partial count as the whole CPU', async () => {
  const info = await readDeviceInfo({ platform: 'linux', logicalCpuCount: 8, env: {},
    read: async file => file.endsWith('/online') ? '0-7' : file.includes('/cpu0/') ? '0,4' : '',
    run: async () => ({ stdout: '' }),
  });
  assert.equal(info.cpuCores, 0); assert.equal(info.logicalCpuCount, 8);
});

test('Mac Pro identifiers use stock enclosure photos without inferring tower versus rack', () => {
  assert.equal(identifyDevice({ platform: 'darwin', modelIdentifier: 'Mac14,8' }).artwork, 'mac-pro-tower');
  assert.equal(identifyDevice({ platform: 'darwin', modelIdentifier: 'MacPro6,1' }).artwork, 'mac-pro-2013');
  assert.equal(deviceArtwork({}, 'mac-pro-rack'), 'mac-pro-rack');
});

test('bundled photos are intact local assets with source provenance and valid display crops', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../assets/devices/sources.json', import.meta.url)));
  for (const [key, photo] of Object.entries(DEVICE_PHOTOS)) {
    assert.match(photo.file, /^[a-z0-9-]+\.(png|jpg|webp)$/);
    const bytes = fs.readFileSync(new URL('../assets/devices/' + photo.file, import.meta.url));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), manifest.images[key].sha256);
    assert.equal(photo.inset.length, 4); assert.ok(photo.inset.every(n => Number.isFinite(n) && n >= 0 && n < 100));
    assert.ok(photo.inset[0] + photo.inset[2] < 100 && photo.inset[1] + photo.inset[3] < 100);
    assert.match(manifest.images[key].source, /^https:\/\//);
  }
});
