import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacity, downloadVolume, transferSummary, DeviceHistory, trafficChart, dashboardHtml } from '../src/renderer/device-dashboard.js';
import { localTelemetry } from '../src/main/local-telemetry.js';

test('capacity distinguishes missing, invalid and unavailable values from a genuinely full disk', () => {
  for (const value of [null, {}, { totalBytes: 10 }, { totalBytes: 10, freeBytes: -1 }, { totalBytes: 10, freeBytes: 11 }, { totalBytes: 10, freeBytes: NaN }, { totalBytes: 10, freeBytes: 2, available: false }]) assert.equal(capacity(value), null);
  assert.deepEqual(capacity({ totalBytes: 10, freeBytes: 0 }), { total: 10, free: 0, used: 10, percent: 100 });
});
test('transfer totals are device-scoped and exclude paused transfer rates', () => {
  const value = transferSummary({ torrents: [{ downloadSpeed: 3, uploadSpeed: 4, numPeers: 2, seeding: true }, { paused: true, downloadSpeed: 999, uploadSpeed: 999, numPeers: 9 }], downloads: [{ status: 'active', speedBps: 5 }, { status: 'paused', speedBps: 500 }], ipfs: { downloads: [{ status: 'active', speedBps: 2 }], stats: { uploadSpeed: 6 } } });
  assert.equal(value.down, 10); assert.equal(value.up, 10); assert.equal(value.peers, 2); assert.equal(value.seeding, 1); assert.equal(value.paused, 2);
  assert.equal(transferSummary({}), null); assert.equal(transferSummary({ torrents: [] }).down, 0);
});
test('history is bounded, isolated, throttled and preserves offline gaps', () => {
  const history = new DeviceHistory({ limit: 3, interval: 100, maxDevices: 2 });
  history.add('a', { down: 1, up: 2 }, 0); history.add('a', { down: 99 }, 10);
  assert.equal(history.get('a').length, 1);
  history.add('a', null, 100); history.add('a', { down: 4, up: 5 }, 200); history.add('a', { down: 6, up: 7 }, 300);
  assert.equal(history.get('a').length, 3); assert.equal(history.get('a')[0].down, null);
  history.add('b', { down: 20 }, 400); assert.equal(history.get('b')[0].down, 20);
  history.add('c', {}, 500); assert.equal(history.devices.size, 2); assert.equal(history.get('a').length, 0);
});
test('charts label units and gaps and never invent pre-session samples', () => {
  assert.match(trafficChart([]), /No live samples/);
  const html = trafficChart([{ time: 1000, down: 2, up: 1 }, { time: 2000, down: null, up: null }, { time: 3000, down: 3, up: 2 }]);
  assert.match(html, /bytes per second/); assert.match(html, /stroke-dasharray/); assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(html, /class="traffic-down" d="M[^L]+M/);
});
test('dashboard escapes remote labels and disables model changes offline', () => {
  const html = dashboardHtml({ device: { id: 'remote', connected: false, name: '<script>bad()</script>', host: '<host>', status: {} }, recipes: [{ id: 'test', title: '<recipe>', state: 'running' }], cpu: '<cpu>', gpu: '<gpu>' });
  assert.doesNotMatch(html, /<script>|NaN|Infinity/); assert.match(html, /&lt;script&gt;/); assert.match(html, /data-spark-model="test" disabled/); assert.match(html, /Charts are paused/); assert.match(html, /Not reported/);
});
const system = { hostname: () => 'local', arch: () => 'arm64', uptime: () => 900, platform: () => 'darwin', loadavg: () => [1, 2, 3], totalmem: () => 100, freemem: () => 25 };
test('resource tile uses the selected download destination, never an unrelated system volume', () => {
  const system = { path: '/', totalBytes: 100, freeBytes: 50 };
  const external = { path: '/mnt/models', totalBytes: 200, freeBytes: 20 };
  assert.equal(downloadVolume([system, external], '/mnt/models', system), external);
  assert.equal(downloadVolume([system], '/unmounted', system), null);
  assert.equal(downloadVolume([], '/', system), system);
});
test('local telemetry reads only the configured folder and tolerates unavailable disks', async () => {
  const paths = [];
  const good = await localTelemetry('/models', { system, now: () => 0, statfs: async path => { paths.push(path); return { bsize: 4, blocks: 50, bavail: 10 }; } });
  assert.deepEqual(paths, ['/models']); assert.equal(good.storage.totalBytes, 200); assert.equal(good.storage.freeBytes, 40); assert.deepEqual(good.load, [1, 2, 3]);
  const missing = await localTelemetry('/missing', { system, statfs: async () => { throw new Error('absent'); } });
  assert.deepEqual(missing.storage, { path: '/missing', available: false });
  const windows = await localTelemetry('', { system: { ...system, platform: () => 'win32' } });
  assert.deepEqual(windows.load, []); assert.equal(windows.storage, null);
});

test('live readings render measured values and an em dash for anything unmeasured', async () => {
  const { liveReadings } = await import('../src/renderer/device-dashboard.js');
  const html = liveReadings({ gpu: { name: 'NVIDIA GB10', temperatureC: 48, utilizationPercent: 91, powerWatts: 64.2 }, cpu: { utilizationPercent: 12 },
    network: { rxBytesPerSecond: 2048, txBytesPerSecond: 0 }, endpoint: { state: 'ready', port: 8910 } });
  for (const text of ['91%', '48 °C', '64.2 W', '12%', 'NVIDIA GB10', 'Ready · :8910', '0 B/s']) assert.ok(html.includes(text), text);
  const blank = liveReadings({ gpu: { temperatureC: null, utilizationPercent: null, powerWatts: null }, cpu: {}, network: {}, endpoint: {} });
  assert.equal((blank.match(/<strong>—<\/strong>/g) || []).length, 6);
  assert.ok(!/<strong>0(%| W| °C)/.test(blank));
  assert.ok(blank.includes('Not reported'));
  assert.ok(!liveReadings({ gpu: { name: '<img src=x onerror=1>' } }).includes('<img'));
});

test('outdated bridge shows an update prompt instead of silent dashes', async () => {
  const { liveReadings } = await import('../src/renderer/device-dashboard.js');
  assert.ok(liveReadings({ bridgeOutdated: true }).includes('Update companion'));
  assert.ok(!liveReadings({ bridgeOutdated: false }).includes('Update companion'));
});
