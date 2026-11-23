/** Integrity service: cached per-model scans (format safety + optional upstream
 * anchor), compact summaries for the UI, and a share predicate that blocks ONLY
 * confirmed risky formats — unknown never blocks, never passes as safe. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IntegrityRegistry, integrityBlocksSharing, INTEGRITY_SHARE_BLOCKED } from '../src/main/integrity-service.js';

const SHA = 'a'.repeat(64);
const fakeStore = (initial = {}) => {
  const state = { ...initial };
  return { state, commits: 0, _commitStateFields(patch) { this.commits++; Object.assign(state, patch); } };
};
async function lib(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rows = [];
  for (const [rel, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), bytes);
    rows.push({ path: rel, size: bytes.length });
  }
  return { path: root, files: rows };
}
const counter = impl => { const fn = async (...args) => { fn.calls++; return impl(...args); }; fn.calls = 0; return fn; };
const safeAnalysis = async () => ({ verdict: 'safe-format', format: 'gguf', findings: [] });
const riskyAnalysis = async file => ({ verdict: 'risky-format', format: 'pickle', findings: [{ kind: 'import', detail: `Pickle imports os.system in ${path.basename(file)}` }] });

test('safe library scans to safe-format, no upstream, and caches by fingerprint', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('weights') });
  const analyze = counter(safeAnalysis);
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: analyze });
  const first = await registry.ensure('m1', { item });
  assert.equal(first.status, 'done');
  assert.equal(first.format.verdict, 'safe-format');
  assert.equal(first.upstream, null);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  const second = await registry.ensure('m1', { item });
  assert.equal(second, first); // same object: cache hit
  assert.equal(analyze.calls, 1);
  assert.equal(integrityBlocksSharing(first), false);
});

test('risky pickle blocks sharing with the typed message', async t => {
  const item = await lib(t, { 'evil.pkl': Buffer.from('x') });
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: riskyAnalysis });
  const result = await registry.ensure('m1', { item });
  assert.equal(result.format.verdict, 'risky-format');
  assert.deepEqual(result.format.risky, ['evil.pkl']);
  assert.equal(integrityBlocksSharing(result), true);
  assert.ok(INTEGRITY_SHARE_BLOCKED.length > 10);
});

test('mixed safe + unknown aggregates to unknown and does NOT block', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w'), 'notes.xyz': Buffer.from('n') });
  const registry = new IntegrityRegistry(fakeStore(), {
    analyzeFileSafety: async file => file.endsWith('.xyz') ? { verdict: 'unknown', format: 'unknown', findings: [] } : safeAnalysis(),
  });
  const result = await registry.ensure('m1', { item });
  assert.equal(result.format.verdict, 'unknown');
  assert.deepEqual(result.format.unknown, ['notes.xyz']);
  assert.equal(integrityBlocksSharing(result), false);
});

test('risky wins over unknown in aggregation', async t => {
  const item = await lib(t, { 'a.gguf': Buffer.from('w'), 'b.xyz': Buffer.from('n'), 'c.pkl': Buffer.from('p') });
  const registry = new IntegrityRegistry(fakeStore(), {
    analyzeFileSafety: async file => file.endsWith('.pkl') ? riskyAnalysis(file)
      : file.endsWith('.xyz') ? { verdict: 'unknown', format: 'unknown', findings: [] } : safeAnalysis(),
  });
  const result = await registry.ensure('m1', { item });
  assert.equal(result.format.verdict, 'risky-format');
});

test('empty file list is unknown, never safe', async t => {
  const item = await lib(t, {});
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: safeAnalysis });
  const result = await registry.ensure('m1', { item });
  assert.equal(result.format.verdict, 'unknown');
  assert.equal(integrityBlocksSharing(result), false);
});

test('file content change invalidates the cache and rescans', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('weights') });
  const analyze = counter(safeAnalysis);
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: analyze });
  await registry.ensure('m1', { item });
  await fs.writeFile(path.join(item.path, 'model.gguf'), Buffer.from('tampered!!'));
  item.files[0].size = 10;
  await registry.ensure('m1', { item });
  assert.equal(analyze.calls, 2);
});

test('upstream=true records the anchor verdict; repeat request reuses it', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  item.card = { source: 'https://huggingface.co/org/model' };
  const verify = counter(async () => ({ verdict: 'matches-upstream', compared: 1, missing: 0, mismatches: [] }));
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: safeAnalysis, verifyAgainstUpstream: verify });
  const first = await registry.ensure('m1', { item, upstream: true });
  assert.equal(first.upstream.verdict, 'matches-upstream');
  assert.equal(verify.calls, 1);
  const second = await registry.ensure('m1', { item, upstream: true });
  assert.equal(second, first);
  assert.equal(verify.calls, 1);
});

test('cached scan without anchor re-runs when upstream is requested', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  item.card = { source: 'https://huggingface.co/org/model' };
  const verify = counter(async () => ({ verdict: 'unknown', compared: 0, missing: 1, mismatches: [] }));
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: safeAnalysis, verifyAgainstUpstream: verify });
  await registry.ensure('m1', { item });
  const withAnchor = await registry.ensure('m1', { item, upstream: true });
  assert.equal(verify.calls, 1);
  assert.equal(withAnchor.upstream.verdict, 'unknown');
});

test('done results persist across registry instances; corrupt entries are discarded', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const store = fakeStore();
  const analyze = counter(safeAnalysis);
  const first = new IntegrityRegistry(store, { analyzeFileSafety: analyze });
  await first.ensure('m1', { item });
  const second = new IntegrityRegistry(store, { analyzeFileSafety: analyze });
  const reused = await second.ensure('m1', { item });
  assert.equal(reused.status, 'done');
  assert.equal(analyze.calls, 1); // loaded from persisted state, no rescan
  // Corrupt the persisted entry: verdict outside the enum must be discarded.
  store.state.aeonIntegrity.m1.format.verdict = 'totally-safe';
  const third = new IntegrityRegistry(store, { analyzeFileSafety: analyze });
  await third.ensure('m1', { item });
  assert.equal(analyze.calls, 2);
});

test('analyzer failure is a typed failed result, not a crash and not a block', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: async () => { throw new Error('EIO disk gone'); } });
  const result = await registry.ensure('m1', { item });
  assert.equal(result.status, 'failed');
  assert.ok(result.error.length <= 300);
  assert.equal(integrityBlocksSharing(result), false);
});

test('missing files fail the fingerprint step honestly', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  await fs.rm(path.join(item.path, 'model.gguf'));
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: safeAnalysis });
  const result = await registry.ensure('m1', { item });
  assert.equal(result.status, 'failed');
});

test('summary is compact: capped names, no findings, no paths outside names', async t => {
  const files = {};
  for (let i = 0; i < 60; i++) files[`evil${i}.pkl`] = Buffer.from('x');
  const item = await lib(t, files);
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: riskyAnalysis });
  await registry.ensure('m1', { item });
  const summary = registry.summary('m1');
  assert.equal(summary.status, 'done');
  assert.equal(summary.format, 'risky-format');
  assert.ok(summary.risky.length <= 50);
  assert.equal(Object.hasOwn(summary, 'findings'), false);
  assert.equal(registry.summary('missing-model'), null);
});

test('share predicate: only done + risky-format blocks; everything else passes', () => {
  assert.equal(integrityBlocksSharing(undefined), false);
  assert.equal(integrityBlocksSharing(null), false);
  assert.equal(integrityBlocksSharing({ status: 'failed', format: { verdict: 'risky-format' } }), false);
  assert.equal(integrityBlocksSharing({ status: 'done', format: { verdict: 'unknown' } }), false);
  assert.equal(integrityBlocksSharing({ status: 'done', format: { verdict: 'safe-format' } }), false);
  assert.equal(integrityBlocksSharing({ status: 'done', format: { verdict: 'risky-format' } }), true);
});

test('real analyzer end-to-end: GGUF safe, malicious pickle risky', async t => {
  // GGUF v3 header, 1 tensor, 0 KVs + padding.
  const head = Buffer.alloc(24); head.write('GGUF', 0, 'ascii'); head.writeUInt32LE(3, 4); head.writeBigUInt64LE(1n, 8); head.writeBigUInt64LE(0n, 16);
  const gguf = Buffer.concat([head, Buffer.alloc(64)]);
  // pickle: PROTO 2, GLOBAL os.system, SHORT_BINUNICODE cmd, REDUCE, STOP
  const evil = Buffer.concat([
    Buffer.from([0x80, 0x02]), Buffer.from('cos\nsystem\n', 'ascii'),
    Buffer.from([0x8c, 0x02]), Buffer.from('hi', 'ascii'), Buffer.from([0x52, 0x2e]),
  ]);
  const item = await lib(t, { 'model.gguf': gguf, 'evil.pkl': evil });
  const registry = new IntegrityRegistry(fakeStore()); // real analyzer + real fingerprint
  const result = await registry.ensure('m1', { item });
  assert.equal(result.status, 'done');
  assert.equal(result.format.verdict, 'risky-format');
  assert.deepEqual(result.format.risky, ['evil.pkl']);
  assert.equal(integrityBlocksSharing(result), true);
  const summary = registry.summary('m1');
  assert.equal(summary.format, 'risky-format');
  void SHA;
});

/* ------------------------------------- adversarial-review regressions */

test('same-size same-mtime rewrite invalidates the cache (content-anchored fingerprint)', async t => {
  const evil = Buffer.concat([
    Buffer.from([0x80, 0x02]), Buffer.from('cos\nsystem\n', 'ascii'),
    Buffer.from([0x8c, 0x02]), Buffer.from('id', 'ascii'),
    Buffer.from([0x52, 0x2e]),
  ]);
  // Benign empty-dict pickle padded with trailing zeros to the SAME length.
  const benign = Buffer.concat([Buffer.from([0x80, 0x02, 0x7d, 0x2e]), Buffer.alloc(evil.length - 4)]);
  const item = await lib(t, { 'evil.pkl': benign });
  const registry = new IntegrityRegistry(fakeStore()); // real analyzer + real fingerprint
  const first = await registry.ensure('m1', { item });
  assert.equal(first.status, 'done');
  assert.equal(first.format.verdict, 'safe-format');
  // In-place rewrite with identical size AND mtime: stat-keyed caching would
  // reuse the stale safe verdict; the content anchor must force a rescan.
  const target = path.join(item.path, 'evil.pkl');
  const stat = await fs.stat(target);
  await fs.writeFile(target, evil);
  await fs.utimes(target, stat.atime, stat.mtime);
  const second = await registry.ensure('m1', { item });
  assert.notEqual(second, first);
  assert.equal(second.format.verdict, 'risky-format');
  assert.equal(integrityBlocksSharing(second), true);
});

test('in-flight unanchored scan is upgraded when upstream is requested mid-flight', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  item.card = { source: 'https://huggingface.co/org/model' };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const analyze = counter(async () => { await gate; return safeAnalysis(); });
  const verify = counter(async () => ({ verdict: 'matches-upstream', compared: 1, missing: 0, mismatches: [], repoId: 'org/model' }));
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: analyze, verifyAgainstUpstream: verify });
  const unanchored = registry.ensure('m1', { item });                    // gate scan, no anchor
  const anchored = registry.ensure('m1', { item, upstream: true });      // must not settle unanchored
  release();
  const [a, b] = await Promise.all([unanchored, anchored]);
  assert.equal(a.upstream, null);
  assert.equal(b.upstream.verdict, 'matches-upstream');
  assert.equal(b.upstream.repoId, 'org/model');
  assert.equal(verify.calls, 1);
});

test('force re-scans even when the fingerprint is unchanged', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const analyze = counter(safeAnalysis);
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: analyze });
  await registry.ensure('m1', { item });
  await registry.ensure('m1', { item });
  assert.equal(analyze.calls, 1);
  await registry.ensure('m1', { item, force: true });
  assert.equal(analyze.calls, 2);
});

test('persisted hostile shapes are discarded: proto id, bad tallies, oversized repo, empty risky', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const base = { status: 'done', fingerprint: SHA, scannedAt: Date.now(), format: { verdict: 'safe-format', risky: [], unknown: [] }, upstream: null };
  const store = fakeStore({ aeonIntegrity: {
    good: base,
    __proto__: { ...base },
    badCompared: { ...base, upstream: { verdict: 'matches-upstream', compared: -1, missing: 0, mismatches: [] } },
    badMissing: { ...base, upstream: { verdict: 'unknown', compared: 0, missing: 'x', mismatches: [] } },
    badRepo: { ...base, upstream: { verdict: 'matches-upstream', compared: 1, missing: 0, mismatches: [], repoId: 'r'.repeat(300) } },
    badMismatch: { ...base, upstream: { verdict: 'differs', compared: 1, missing: 0, mismatches: [42] } },
    emptyRisky: { ...base, format: { verdict: 'risky-format', risky: [], unknown: [] } },
    futureScan: { ...base, scannedAt: Date.now() + 3_600_000 },
  } });
  const analyze = counter(safeAnalysis);
  const registry = new IntegrityRegistry(store, { analyzeFileSafety: analyze });
  for (const id of ['badCompared', 'badMissing', 'badRepo', 'badMismatch', 'emptyRisky', 'futureScan']) {
    assert.equal(registry.summary(id), null, `${id} must not load`);
  }
  assert.equal(registry.summary('__proto__'), null, 'prototype-pollution id must not load');
  assert.notEqual(registry.summary('good'), null);
  await assert.rejects(() => registry.ensure('__proto__', { item }), /model id/);
});

test('snapshot rows use a null prototype and survive a __proto__ cache id', () => {
  const store = fakeStore();
  const registry = new IntegrityRegistry(store);
  // Drive a result in through the public path, then poison the persisted map
  // the way a hostile state file would, and reload.
  store.state.aeonIntegrity = {
    m1: { status: 'done', fingerprint: SHA, format: { verdict: 'safe-format', risky: [], unknown: [] }, upstream: null },
  };
  Object.defineProperty(store.state.aeonIntegrity, '__proto__', {
    value: { status: 'done', fingerprint: SHA, format: { verdict: 'risky-format', risky: ['x'], unknown: [] }, upstream: null },
    enumerable: true, configurable: true, writable: true,
  });
  const fresh = new IntegrityRegistry(store);
  const rows = fresh.snapshot();
  assert.equal(Object.getPrototypeOf(rows), null);
  assert.equal(rows.m1.status, 'done');
});

test('scan failure never blocks sharing and never claims safe', async t => {
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const registry = new IntegrityRegistry(fakeStore(), { analyzeFileSafety: async () => { throw new Error('boom'); } });
  const result = await registry.ensure('m1', { item });
  assert.equal(result.status, 'failed');
  assert.equal(integrityBlocksSharing(result), false);
  assert.equal(registry.summary('m1').format, undefined);
});

/* ----------------------------------------- round-2 regressions (N4/N5) */

// N5: a risky file at a >300-char relative path is legal (depth ≤12). The
// write side must cap names so the persisted verdict survives validResult on
// reload — otherwise the restart re-seed gate sees nothing and re-seeds risky.
test('N5: risky verdict with a 305-char relative path persists AND reloads', async t => {
  const longName = 'd'.repeat(150) + '/' + 'e'.repeat(150) + '.pkl'; // 305 chars, components ≤255
  const item = await lib(t, { [longName]: Buffer.from('evil') });
  const store = fakeStore();
  const registry = new IntegrityRegistry(store, { analyzeFileSafety: riskyAnalysis });
  const result = await registry.ensure('m1', { item });
  assert.equal(result.format.verdict, 'risky-format');
  assert.ok(result.format.risky[0].length <= 300, 'written name must be capped');
  assert.equal(integrityBlocksSharing(result), true);
  const reloaded = new IntegrityRegistry(store, { analyzeFileSafety: riskyAnalysis });
  const cached = reloaded.get('m1');
  assert.ok(cached, 'persisted verdict must survive reload');
  assert.equal(cached.format.verdict, 'risky-format');
  assert.equal(integrityBlocksSharing(cached), true);
});

test('N5: unknown names and upstream mismatch names are capped at write time', async t => {
  const longName = 'd'.repeat(150) + '/' + 'y'.repeat(150) + '.xyz'; // 305 chars, components ≤255
  const item = await lib(t, { [longName]: Buffer.from('n') });
  item.card = { source: 'https://huggingface.co/org/model' };
  const store = fakeStore();
  const registry = new IntegrityRegistry(store, {
    analyzeFileSafety: async () => ({ verdict: 'unknown', format: 'unknown', findings: [] }),
    verifyAgainstUpstream: async () => ({ verdict: 'differs', compared: 1, missing: 0, mismatches: ['z'.repeat(400)], repoId: 'org/model' }),
  });
  const result = await registry.ensure('m1', { item, upstream: true });
  assert.ok(result.format.unknown[0].length <= 300);
  assert.ok(result.upstream.mismatches[0].length <= 300);
  const reloaded = new IntegrityRegistry(store, {});
  assert.ok(reloaded.get('m1'), 'verdict with long unknown/mismatch names must survive reload');
});

// N4: a confirmed verdict must be mirrorable to sibling ids (shared:, inventory
// id) so the cache-only restart re-seed gate blocks under the key it checks.
test('N4: mirror copies a confirmed verdict to sibling ids and persists', async t => {
  const item = await lib(t, { 'evil.pkl': Buffer.from('x') });
  const store = fakeStore();
  const registry = new IntegrityRegistry(store, { analyzeFileSafety: riskyAnalysis });
  const result = await registry.ensure('scan:abc', { item });
  registry.mirror('scan:abc', ['shared:abc', 'folder:deadbeef']);
  assert.equal(registry.get('shared:abc').format.verdict, 'risky-format');
  assert.equal(integrityBlocksSharing(registry.get('shared:abc')), true);
  assert.equal(registry.get('folder:deadbeef').format.verdict, 'risky-format');
  const reloaded = new IntegrityRegistry(store, {});
  assert.equal(integrityBlocksSharing(reloaded.get('shared:abc')), true, 'mirrored verdict must survive reload');
});

test('N4: mirror refuses failed/absent sources and unsafe ids', async t => {
  const store = fakeStore();
  const registry = new IntegrityRegistry(store, {});
  assert.equal(registry.mirror('missing', ['shared:x']), 0);
  const item = await lib(t, { 'model.gguf': Buffer.from('w') });
  const failing = new IntegrityRegistry(store, { analyzeFileSafety: async () => { throw new Error('boom'); } });
  await failing.ensure('m1', { item });
  assert.equal(failing.get('m1').status, 'failed');
  assert.equal(failing.mirror('m1', ['shared:x']), 0, 'failed scans are not confirmed verdicts');
  const ok = new IntegrityRegistry(store, { analyzeFileSafety: riskyAnalysis });
  await ok.ensure('m2', { item });
  assert.equal(ok.mirror('m2', ['__proto__', '', 'm2']), 0);
  assert.equal(ok.get('__proto__'), null);
});
