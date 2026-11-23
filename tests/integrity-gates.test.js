/** Share-gate wiring for the integrity service: the resolver contract gates
 * rely on, the IPFS publish gate (gate 4), the IPC handler early refusal
 * (gate 5), the compact card summary, and the bounded folder walker. The
 * index.js gates (1–3) are exercised end-to-end by the E2E suite; here we test
 * every piece they compose, plus the real Kubo publish refusal. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntegrityRegistry, integrityBlocksSharing, INTEGRITY_SHARE_BLOCKED, listFolderFiles } from '../src/main/integrity-service.js';
import { integritySummary } from '../src/shared/aeon-integrity-status.js';
import { IpfsTransfers } from '../src/main/ipfs.js';
import { KuboRuntime } from '../src/main/ipfs-runtime.js';
import { registerIpfsHandlers } from '../src/main/ipfs-handlers.js';

const fakeStore = (initial = {}) => {
  const state = { ...initial };
  return { state, _commitStateFields(patch) { Object.assign(state, patch); } };
};
const safeAnalysis = async () => ({ verdict: 'safe-format', format: 'gguf', findings: [] });
const riskyAnalysis = async () => ({ verdict: 'risky-format', format: 'pickle', findings: [{ kind: 'import', detail: 'os.system' }] });
async function lib(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-gates-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rows = [];
  for (const [rel, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), bytes);
    rows.push({ path: rel, size: bytes.length });
  }
  return { path: root, files: rows };
}

/* ---------------------------------------------------- resolver contract */

test('resolver maps ids to items; unresolvable ids return null — never block, never pass', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const registry = new IntegrityRegistry(fakeStore(), {
    analyzeFileSafety: safeAnalysis,
    resolveItem: async id => id === 'known' ? item : null,
  });
  const result = await registry.ensure('known'); // gate-style call: no item
  assert.equal(result.status, 'done');
  assert.equal(result.format.verdict, 'safe-format');
  assert.equal(await registry.ensure('remote-device-row'), null);
  assert.equal(integrityBlocksSharing(null), false);
});

test('a throwing resolver is contained: null result, no crash at the gate', async () => {
  const registry = new IntegrityRegistry(fakeStore(), {
    analyzeFileSafety: safeAnalysis,
    resolveItem: async () => { throw new Error('inventory exploded'); },
  });
  assert.equal(await registry.ensure('anything'), null);
});

test('explicit item wins over the resolver; card is auto-read for anchoring', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w'), 'model-card.json': Buffer.from(JSON.stringify({ schema: 'aeon-model-card/2', source: 'https://huggingface.co/org/model' })) });
  let resolveCalls = 0;
  let seenCard = null;
  const registry = new IntegrityRegistry(fakeStore(), {
    analyzeFileSafety: safeAnalysis,
    resolveItem: async () => { resolveCalls++; return null; },
    verifyAgainstUpstream: async candidate => { seenCard = candidate.card; return { verdict: 'unknown', compared: 0, missing: 1, mismatches: [] }; },
  });
  const result = await registry.ensure('m1', { item, upstream: true });
  assert.equal(resolveCalls, 0);
  assert.equal(seenCard?.source, 'https://huggingface.co/org/model');
  assert.equal(result.upstream.verdict, 'unknown');
});

test('scannedAt is recorded and validated; snapshot returns compact summaries only', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const store = fakeStore();
  const registry = new IntegrityRegistry(store, { analyzeFileSafety: safeAnalysis });
  const before = Date.now();
  await registry.ensure('m1', { item });
  const snapshot = registry.snapshot();
  assert.deepEqual(Object.keys(snapshot), ['m1']);
  assert.equal(snapshot.m1.status, 'done');
  assert.ok(snapshot.m1.scannedAt >= before);
  assert.equal(Object.hasOwn(snapshot.m1, 'fingerprint'), false);
  assert.equal(Object.hasOwn(snapshot.m1, 'findings'), false);
  // Corrupt scannedAt: the persisted entry must be discarded on reload.
  store.state.aeonIntegrity.m1.scannedAt = 'yesterday';
  const reloaded = new IntegrityRegistry(store, { analyzeFileSafety: safeAnalysis });
  assert.equal(reloaded.get('m1'), null);
});

/* ------------------------------------------------------- folder walker */

test('listFolderFiles walks regular files with relative paths and sizes', async t => {
  const item = await lib(t, { 'a.gguf': Buffer.from('aa'), 'nested/b.bin': Buffer.from('bbb') });
  const files = await listFolderFiles(item.path);
  assert.deepEqual(files.sort((x, y) => x.path.localeCompare(y.path)), [
    { path: 'a.gguf', size: 2 }, { path: 'nested/b.bin', size: 3 },
  ]);
});

test('listFolderFiles fails closed on symlinks, depth, and file-count limits', async t => {
  const item = await lib(t, { 'a.gguf': Buffer.from('a') });
  await fs.symlink(path.join(item.path, 'a.gguf'), path.join(item.path, 'link.gguf'));
  await assert.rejects(listFolderFiles(item.path), /symbolic link/);
  await fs.rm(path.join(item.path, 'link.gguf'));
  await assert.rejects(listFolderFiles(item.path, { maxFiles: 0 }), /too many files/);
  const deep = path.join(item.path, ...Array.from({ length: 4 }, (_, i) => `d${i}`));
  await fs.mkdir(deep, { recursive: true });
  await assert.rejects(listFolderFiles(item.path, { maxDepth: 2 }), /deeply nested/);
});

/* ------------------------------------------------------- card summary */

test('integritySummary: risky warns and says blocked; safe is ok; unknown never claims safe', () => {
  const risky = integritySummary({ status: 'done', format: 'risky-format', risky: ['evil.pkl'], unknown: [], upstream: null });
  assert.equal(risky.tone, 'warn');
  assert.match(risky.detail, /sharing blocked/);
  const safe = integritySummary({ status: 'done', format: 'safe-format', risky: [], unknown: [], upstream: { verdict: 'matches-upstream', compared: 3, missing: 0, mismatches: [] } });
  assert.equal(safe.tone, 'ok');
  assert.match(safe.detail, /matches Hugging Face/);
  assert.match(safe.detail, /3 files checked/);
  const unknown = integritySummary({ status: 'done', format: 'unknown', risky: [], unknown: ['weights.xyz'], upstream: null });
  assert.equal(unknown.tone, 'neutral');
  assert.doesNotMatch(unknown.detail, /safe/i);
  const differs = integritySummary({ status: 'done', format: 'safe-format', risky: [], unknown: [], upstream: { verdict: 'differs', compared: 2, missing: 0, mismatches: ['a.gguf'] } });
  assert.equal(differs.tone, 'warn');
  assert.match(differs.detail, /differs from Hugging Face/);
  const failed = integritySummary({ status: 'failed', error: 'EIO' });
  assert.equal(failed.tone, 'warn');
  assert.equal(integritySummary(null), null);
  assert.equal(integritySummary({ status: 'scanning' }), null);
  // Unknown format with a good anchor: honest neutral label — an upstream
  // match over unclassifiable files is not a green "safe" claim.
  const anchoredUnknown = integritySummary({ status: 'done', format: 'unknown', risky: [], unknown: ['x.xyz'], upstream: { verdict: 'matches-upstream', compared: 1, missing: 0, mismatches: [] } });
  assert.equal(anchoredUnknown.tone, 'neutral');
  assert.doesNotMatch(anchoredUnknown.detail, /safe/i);
  // Partial anchor coverage is disclosed beside the match.
  const partial = integritySummary({ status: 'done', format: 'safe-format', risky: [], unknown: [], upstream: { verdict: 'matches-upstream', compared: 3, missing: 2, mismatches: [] } });
  assert.equal(partial.tone, 'ok');
  assert.match(partial.detail, /2 files without an upstream hash/);
  // The repo the hashes came from is named.
  const repoNamed = integritySummary({ status: 'done', format: 'safe-format', risky: [], unknown: [], upstream: { verdict: 'matches-upstream', compared: 3, missing: 0, mismatches: [], repoId: 'org/model' } });
  assert.match(repoNamed.detail, /org\/model/);
});

/* ------------------------------------------- gate 5: IPC early refusal */

test('ipfs:sharing gate 5 throws the typed message for risky, passes unknown, and never gates disable', async t => {
  const id = 'ipfs:' + 'b'.repeat(64);
  const handlers = new Map();
  const calls = { sharing: 0, confirms: 0 };
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const row = { id, source: 'ipfs://Qm' + 'x'.repeat(44), destination: item.path, name: 'Model', files: [{ path: 'model.gguf', cid: 'bafy1', size: 1 }], origin: null };
  const local = { record: () => row, async sharing() { calls.sharing++; } };
  const integrity = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: riskyAnalysis });
  await integrity.ensure(id, { item });
  registerIpfsHandlers({
    handle: (channel, fn) => handlers.set(channel, fn),
    local, devices: {}, requestRemote: async () => { throw new Error('no remote'); },
    store: fakeStore(), pathCapabilities: {}, currentState: () => ({}),
    confirm: async () => { calls.confirms++; return true; },
    integrity,
  });
  await assert.rejects(handlers.get('ipfs:sharing')({ id, enabled: true }), err => err.message === INTEGRITY_SHARE_BLOCKED);
  assert.equal(calls.confirms, 0, 'refused before the review dialog');
  assert.equal(calls.sharing, 0);
  // Disable path: no integrity gate at all.
  await handlers.get('ipfs:sharing')({ id, enabled: false });
  assert.equal(calls.sharing, 1);
  assert.equal(calls.confirms, 0);
});

test('ipfs:sharing without an integrity service behaves exactly as before', async () => {
  const id = 'ipfs:' + 'c'.repeat(64);
  const handlers = new Map();
  let shared = null;
  const row = { id, source: 'ipfs://Qm' + 'x'.repeat(44), destination: '/downloads', name: 'Model', files: [{ path: 'a.gguf', cid: 'bafy1', size: 1 }], origin: null };
  registerIpfsHandlers({
    handle: (channel, fn) => handlers.set(channel, fn),
    local: { record: () => row, async sharing(reqId, enabled) { shared = [reqId, enabled]; } },
    devices: {}, requestRemote: async () => { throw new Error('no remote'); },
    store: fakeStore(), pathCapabilities: {}, currentState: () => ({}),
    confirm: async () => true,
  });
  await handlers.get('ipfs:sharing')({ id, enabled: true });
  assert.deepEqual(shared, [id, true]);
});

/* ------------------------- gate 4: real Kubo publish refusal (skipped without runtime) */

const binaryDirectory = path.resolve(import.meta.dirname, '..', `build/ipfs-runtime/${process.platform}-${process.arch}`);
const runtimeAvailable = fsSync.existsSync(path.join(binaryDirectory, 'runtime.json'));

test('real Kubo: a risky-format collection is never published; a safe one shares', { skip: !runtimeAvailable, timeout: 120_000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-integrity-kubo-'));
  const source = new KuboRuntime({ directory: path.join(home, 'source'), binaryDirectory, publishing: true, isolated: true });
  const manager = new IpfsTransfers({ directory: path.join(home, 'managed'), binaryDirectory, isolated: true });
  manager.integrity = new IntegrityRegistry(fakeStore()); // real analyzer
  try {
    const fixture = path.join(home, 'fixture'), destination = path.join(home, 'downloads');
    await fs.mkdir(fixture, { recursive: true }); await fs.mkdir(destination);
    // GGUF v3 header so the real analyzer classifies it safe.
    const head = Buffer.alloc(24); head.write('GGUF', 0, 'ascii'); head.writeUInt32LE(3, 4); head.writeBigUInt64LE(1n, 8); head.writeBigUInt64LE(0n, 16);
    await fs.writeFile(path.join(fixture, 'model.gguf'), Buffer.concat([head, Buffer.alloc(64)]));
    // Malicious pickle: PROTO 2, GLOBAL os.system, REDUCE, STOP.
    await fs.writeFile(path.join(fixture, 'evil.pkl'), Buffer.concat([
      Buffer.from([0x80, 0x02]), Buffer.from('cos\nsystem\n', 'ascii'),
      Buffer.from([0x8c, 0x02]), Buffer.from('hi', 'ascii'), Buffer.from([0x52, 0x2e]),
    ]));
    await source.ensure(); await source.stop();
    const root = (await source.command(['add', '--offline', '-Qr', fixture])).stdout.trim();
    await source.ensure(); await manager.load(); await manager.reader.ensure();
    await manager.reader.json('swarm/connect', { arg: (await source.json('id')).Addresses.find(a => a.startsWith('/ip4/127.0.0.1/')) });
    const preview = await manager.inspect('ipfs://' + root);
    const id = await manager.add({ previewId: preview.id, selectedPaths: ['model.gguf', 'evil.pkl'], destination, name: 'Risky model', kind: 'model' });
    await manager.running.get(id);
    const job = manager.record(id); assert.equal(job.status, 'done', job.error);
    await assert.rejects(manager.sharing(id, true), err => err.message === INTEGRITY_SHARE_BLOCKED);
    assert.equal(job.sharing, false); assert.equal(job.shareCid, '');
    assert.equal(manager.publisher.child, null, 'the serving node was never started');
    // The same collection without the pickle shares normally.
    const cleanId = await manager.add({ previewId: (await manager.inspect('ipfs://' + root)).id, selectedPaths: ['model.gguf'], destination: await fs.mkdtemp(path.join(home, 'clean-')), name: 'Clean model', kind: 'model' });
    await manager.running.get(cleanId);
    await manager.sharing(cleanId, true);
    assert.equal(manager.record(cleanId).sharing, true);
    await manager.sharing(cleanId, false);
  } finally {
    await Promise.allSettled([manager.close(), source.stop()]);
    await fs.rm(home, { recursive: true, force: true });
  }
});
