import test from 'node:test';
import assert from 'node:assert/strict';
import { SparkDeviceManager } from '../src/main/spark-device-manager.js';
import { sanitizeSparkResponse } from '../src/main/spark-schema.js';

const telemetry = { schema: 1, collectedAt: new Date().toISOString(), hostname: 'spark', architecture: 'arm64', uptimeSeconds: 12, load: [1, 2, 3], memory: { totalBytes: 10, freeBytes: 4 }, storage: { path: '/home', totalBytes: 20, freeBytes: 8, available: true }, docker: { available: true, containers: [{ Names: 'model', State: 'running', Image: 'model:latest' }] }, capabilities: { docker: true, gpu: true } };

function manager(response) {
  const profile = { host: 'spark', username: 'user' };
  return new SparkDeviceManager({ devices: {
    profile: () => profile,
    approvalSnapshot: () => ({ id: 'one', digest: 'same' }),
    isApprovalCurrent: () => true,
    request: async (_profile, payload) => response(payload),
  } });
}

test('normalizes bounded Spark telemetry', async () => {
  const result = await manager(async () => sanitizeSparkResponse('device:telemetry', telemetry)).status('one');
  assert.equal(result.schema, 1);
  assert.equal(result.docker.containers[0].name, 'model');
  assert.equal(result.capabilities.power, false);
});

test('device responses are allowlisted without dropping supported management actions', async () => {
  const parsed = sanitizeSparkResponse('device:telemetry', { ...telemetry, token: 'never-export-this' });
  assert.equal(parsed.token, undefined);
  assert.throws(() => sanitizeSparkResponse('device:telemetry', { ...telemetry, uptimeSeconds: NaN }), /invalid status/);
  assert.throws(() => sanitizeSparkResponse('device:recipes', { schema: 1, recipes: [{ id: '../anything' }] }), /invalid status/);
  const recipe = sanitizeSparkResponse('device:recipes', { schema: 1, recipes: [{ id: 'old-model', title: 'Old model', kind: 'docker', state: 'missing', available: false }] });
  assert.equal((await manager(async () => recipe).recipes('one'))[0].available, false);
});

test('mutations carry the exact review and reject mismatched operation replies', async () => {
  const calls = [];
  const device = manager(async payload => { calls.push(payload); return { schema: 1, recipeId: 'demo', operation: payload.operation, state: 'running' }; });
  await assert.rejects(device.control('one', 'start', 'demo'), /Review this exact/);
  await device.control('one', 'start', 'demo', 'a'.repeat(64));
  assert.equal(calls[0].reviewDigest, 'a'.repeat(64));
  await assert.rejects(manager(async () => ({ schema: 1, recipeId: 'demo', operation: 'stop' })).control('one', 'check', 'demo'), /invalid model control/);
});

test('rejects invalid telemetry schema', async () => {
  await assert.rejects(manager(async () => ({ schema: 2 })).status('one'), /invalid device telemetry/);
});

test('validates recipe IDs and control response identity', async () => {
  const device = manager(async payload => payload.action === 'device:recipes'
    ? { schema: 1, recipes: [{ id: 'demo', title: 'Demo', kind: 'docker' }] }
    : { schema: 1, recipeId: 'demo', state: 'ready' });
  assert.equal((await device.recipes('one'))[0].id, 'demo');
  await assert.rejects(device.control('one', 'start', 'bad id'), /Invalid Spark model recipe/);
});

test('passes measured GPU/CPU/network/endpoint readings and keeps missing ones null, never zero', async () => {
  const live = { ...telemetry, cpu: { utilizationPercent: 37.5 }, gpu: { name: 'NVIDIA GB10', temperatureC: 48, utilizationPercent: 91, powerWatts: 64.2 },
    network: { rxBytesPerSecond: 1200, txBytesPerSecond: 0 }, endpoint: { state: 'ready', port: 8910 } };
  const full = await manager(async () => sanitizeSparkResponse('device:telemetry', live)).status('one');
  assert.deepEqual(full.telemetry?.gpu ?? full.gpu, { name: 'NVIDIA GB10', temperatureC: 48, utilizationPercent: 91, powerWatts: 64.2 });
  const missing = { ...telemetry, cpu: { utilizationPercent: null }, gpu: { name: '', temperatureC: null, utilizationPercent: null, powerWatts: null },
    network: { rxBytesPerSecond: null, txBytesPerSecond: null }, endpoint: { state: 'unknown', port: null } };
  const empty = await manager(async () => sanitizeSparkResponse('device:telemetry', missing)).status('one');
  const t = empty.telemetry ?? empty;
  assert.equal(t.gpu.utilizationPercent, null); assert.equal(t.gpu.powerWatts, null); assert.equal(t.cpu.utilizationPercent, null);
  assert.equal(t.network.rxBytesPerSecond, null); assert.equal(t.endpoint.state, 'unknown');
  const legacy = await manager(async () => sanitizeSparkResponse('device:telemetry', telemetry)).status('one');
  const l = legacy.telemetry ?? legacy;
  assert.equal(l.gpu.temperatureC, null); assert.equal(l.network.txBytesPerSecond, null); assert.equal(l.endpoint.port, null);
});

test('schema rejects out-of-range or non-numeric hardware readings', () => {
  for (const bad of [{ gpu: { utilizationPercent: 150 } }, { gpu: { powerWatts: -1 } }, { gpu: { temperatureC: 900 } }, { cpu: { utilizationPercent: '50' } },
    { network: { rxBytesPerSecond: NaN } }, { endpoint: { state: 'pwned' } }, { endpoint: { port: 70000 } }]) {
    assert.throws(() => sanitizeSparkResponse('device:telemetry', { ...telemetry, ...bad }), Error, JSON.stringify(bad));
  }
});

test('flags a paired helper from an older build so the UI can ask for a companion update', async () => {
  const { SPARK_BRIDGE_REVISION } = await import('../src/main/spark-hostd.js');
  assert.ok(Number.isSafeInteger(SPARK_BRIDGE_REVISION) && SPARK_BRIDGE_REVISION >= 2);
  const stale = await manager(async () => sanitizeSparkResponse('device:telemetry', telemetry)).status('one');
  assert.equal((stale.telemetry ?? stale).bridgeOutdated, true);
  const fresh = await manager(async () => sanitizeSparkResponse('device:telemetry', { ...telemetry, bridgeRevision: SPARK_BRIDGE_REVISION })).status('one');
  assert.equal((fresh.telemetry ?? fresh).bridgeOutdated, false);
  assert.throws(() => sanitizeSparkResponse('device:telemetry', { ...telemetry, bridgeRevision: 'x' }));
});
