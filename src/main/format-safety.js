/** Deterministic format-safety gate (Layer 2). Pure local structural checks —
 * no definitions feed, no code execution, no Python. Verdicts are three-state:
 *   safe-format  — the container is a data-only format and its structure holds
 *   risky-format — a pickle-family stream imports code outside the allowlist
 *   unknown      — anything we could not fully validate (never collapsed to safe)
 * Reads are bounded: headers and opcode streams only, never whole multi-GB files.
 *
 * Deferred by design (recorded round-2 N10): the walk runs on the main process
 * within strict size/opcode budgets; offloading it to a worker is future work,
 * not a silent omission. Loader-mismatch scope (round-3 R4): structural-first
 * routing models the format's OWN reader (GGUF/safetensors readers do not
 * execute code); a valid GGUF fed to torch.load's legacy pickle fallback is
 * outside that model and is not claimed safe against it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { PICKLE_EXTENSIONS } from '../shared/format-hints.js';

export const MAX_PICKLE_SCAN_BYTES = 64 * 1024 * 1024;
// A torch checkpoint's opcode stream is small (the tensors live in separate
// zip entries). Refuse absurd opcode counts instead of looping for minutes.
const MAX_PICKLE_OPS = 2_000_000;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_HEADER_BYTES = 32 * 1024 * 1024;       // practical header ceiling; a 100MB JSON.parse would block the main process
const MAX_GGUF_META_BYTES = 64 * 1024 * 1024;    // KV walk budget
const MAX_GGUF_STRING = 8 * 1024 * 1024;
const MAX_COUNT = 1_000_000;
const MAX_FINDINGS = 20;
const MAX_STACK = 100_000;
const MAX_LINE = 1024 * 1024;
// A container of many tiny pickle streams is already hostile; cap both the
// stream count and the total inflated bytes so a zip bomb cannot allocate
// unbounded memory on the main process.
const MAX_ZIP_PICKLE_STREAMS = 64;

const PICKLE_EXT = new Set(PICKLE_EXTENSIONS);
const SAFETENSORS_DTYPES = new Set(['BOOL', 'U8', 'I8', 'F8_E4M3', 'F8_E5M2', 'F8_E8M0', 'I16', 'U16', 'F16', 'BF16', 'I32', 'U32', 'F32', 'F64', 'I64', 'U64']);

/** Imports that cannot run arbitrary code when reconstructed. Everything else
 * in a pickle is treated as code-execution risk (picklescan-style allowlist). */
const SAFE_GLOBALS = new Set([
  'collections.OrderedDict', 'collections.defaultdict', 'collections.Counter',
  '_codecs.encode',
  'builtins.set', 'builtins.frozenset', 'builtins.list', 'builtins.dict', 'builtins.tuple',
  'builtins.complex', 'builtins.slice', 'builtins.bytes', 'builtins.bytearray',
  'builtins.str', 'builtins.int', 'builtins.float', 'builtins.bool', 'builtins.object',
  'numpy.dtype', 'numpy.ndarray', 'numpy.scalar',
  'numpy.core.multiarray._reconstruct', 'numpy.core.multiarray.scalar',
  'numpy._core.multiarray._reconstruct', 'numpy._core.multiarray.scalar',
  'numpy.core.numeric._frombuffer', 'numpy._core.numeric._frombuffer',
  'torch._utils._rebuild_tensor', 'torch._utils._rebuild_tensor_v2',
  'torch._utils._rebuild_sparse_tensor', 'torch._utils._rebuild_qtensor',
  'torch._utils._rebuild_parameter', 'torch._utils._rebuild_parameter_with_state',
  'torch._utils._rebuild_meta_tensor_no_storage', 'torch._utils._rebuild_device_tensor_from_numpy',
  'torch._tensor._rebuild_from_type_v2',
]);
const TORCH_STORAGE = /^torch\.(?:[A-Za-z0-9_]*Storage|UntypedStorage|TypedStorage)$/;
const NUMPY_SCALAR = /^numpy\.(?:bool_|u?int(?:8|16|32|64)|float(?:16|32|64|128)|complex(?:64|128)|str_|bytes_|void|object_|datetime64|timedelta64)$/;
const safeGlobal = (mod, name) => {
  const full = `${mod}.${name}`;
  return SAFE_GLOBALS.has(full) || TORCH_STORAGE.test(full) || NUMPY_SCALAR.test(full);
};

const finding = (kind, detail) => ({ kind, detail: String(detail).slice(0, 300) });
const result = (verdict, format, findings = []) => ({ verdict, format, findings: findings.slice(0, MAX_FINDINGS) });

/** Bounded positional reader over one open file. */
class Reader {
  constructor(handle, size) { this.handle = handle; this.size = size; }
  async at(pos, len) {
    if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(len) || len < 0 || pos < 0 || pos + len > this.size) throw new Error('out of bounds');
    if (len === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(len);
    const { bytesRead } = await this.handle.read(buffer, 0, len, pos);
    if (bytesRead !== len) throw new Error('short read');
    return buffer;
  }
}

/* --------------------------------------------------------------- safetensors */

async function checkSafetensors(reader) {
  if (reader.size < 8) return result('unknown', 'safetensors', [finding('structure', 'File is shorter than a safetensors header.')]);
  const head = await reader.at(0, 8);
  const headerLen = Number(head.readBigUInt64LE(0));
  if (!Number.isSafeInteger(headerLen) || headerLen > MAX_HEADER_BYTES || 8 + headerLen > reader.size) {
    return result('unknown', 'safetensors', [finding('structure', 'Implausible safetensors header length.')]);
  }
  let header;
  try { header = JSON.parse((await reader.at(8, headerLen)).toString('utf8')); }
  catch { return result('unknown', 'safetensors', [finding('structure', 'safetensors header is not valid JSON.')]); }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return result('unknown', 'safetensors', [finding('structure', 'safetensors header is not an object.')]);
  const dataBytes = reader.size - 8 - headerLen;
  const findings = [];
  for (const [name, tensor] of Object.entries(header)) {
    if (name === '__metadata__') {
      if (!tensor || typeof tensor !== 'object' || Array.isArray(tensor) || Object.values(tensor).some(v => typeof v !== 'string')) findings.push(finding('structure', '__metadata__ must map strings to strings.'));
      continue;
    }
    const offsets = tensor?.data_offsets;
    if (!tensor || typeof tensor !== 'object' || !SAFETENSORS_DTYPES.has(tensor.dtype)
      || !Array.isArray(tensor.shape) || tensor.shape.some(d => !Number.isSafeInteger(d) || d < 0)
      || !Array.isArray(offsets) || offsets.length !== 2
      || offsets.some(o => !Number.isSafeInteger(o) || o < 0)
      || offsets[0] > offsets[1] || offsets[1] > dataBytes) {
      findings.push(finding('structure', `Tensor "${name.slice(0, 80)}" has invalid dtype/shape or out-of-bounds offsets.`));
    }
  }
  return findings.length ? result('unknown', 'safetensors', findings) : result('safe-format', 'safetensors');
}

/* ---------------------------------------------------------------------- GGUF */

const GGUF_SCALAR_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

async function checkGguf(reader) {
  if (reader.size < 24) return result('unknown', 'gguf', [finding('structure', 'File is shorter than a GGUF header.')]);
  const head = await reader.at(0, 24);
  if (head.toString('ascii', 0, 4) !== 'GGUF') return result('unknown', 'gguf', [finding('structure', 'Missing GGUF magic.')]);
  const version = head.readUInt32LE(4);
  if (![1, 2, 3].includes(version)) return result('unknown', 'gguf', [finding('structure', `Unsupported GGUF version ${version}.`)]);
  const tensors = Number(head.readBigUInt64LE(8)), kvs = Number(head.readBigUInt64LE(16));
  if (!Number.isSafeInteger(tensors) || tensors > MAX_COUNT || !Number.isSafeInteger(kvs) || kvs > MAX_COUNT) {
    return result('unknown', 'gguf', [finding('structure', 'Implausible GGUF tensor/metadata counts.')]);
  }
  const wide = version >= 2; // v1 uses u32 string/array lengths
  let pos = 24;
  const len = async () => {
    if (pos + (wide ? 8 : 4) > 24 + MAX_GGUF_META_BYTES) throw new Error('metadata out of bounds');
    const bytes = await reader.at(pos, wide ? 8 : 4); pos += wide ? 8 : 4;
    const value = wide ? Number(bytes.readBigUInt64LE(0)) : bytes.readUInt32LE(0);
    if (!Number.isSafeInteger(value) || value > MAX_GGUF_STRING) throw new Error('string too long');
    return value;
  };
  const skip = async n => { if (pos + n > reader.size || pos + n > 24 + MAX_GGUF_META_BYTES) throw new Error('metadata out of bounds'); pos += n; };
  const value = async type => {
    if (type === 8) { const n = await len(); await skip(n); return; }
    if (type === 9) {
      const elem = (await reader.at(pos, 4)).readUInt32LE(0); pos += 4;
      const count = wide ? Number((await reader.at(pos, 8)).readBigUInt64LE(0)) : (await reader.at(pos, 4)).readUInt32LE(0);
      pos += wide ? 8 : 4;
      if (!Number.isSafeInteger(count) || count > MAX_COUNT) throw new Error('array too long');
      if (elem === 8) { for (let i = 0; i < count; i++) { const n = await len(); await skip(n); } return; }
      const width = GGUF_SCALAR_BYTES[elem];
      if (width === undefined) throw new Error('unknown array element type');
      await skip(count * width); return;
    }
    const width = GGUF_SCALAR_BYTES[type];
    if (width === undefined) throw new Error('unknown metadata type');
    await skip(width);
  };
  try {
    for (let i = 0; i < kvs; i++) {
      const keyLen = await len(); await skip(keyLen);
      const type = (await reader.at(pos, 4)).readUInt32LE(0); pos += 4;
      await value(type);
    }
  } catch (error) {
    return result('unknown', 'gguf', [finding('structure', `GGUF metadata walk failed: ${error.message}.`)]);
  }
  return result('safe-format', 'gguf');
}

/* -------------------------------------------------------------------- pickle */

/** One pickle stream as a bounded stack machine. Records every import; a
 * malformed stream is unknown, never safe. Returns {verdict, findings}. */
function walkPickle(bytes) {
  const findings = [];
  let risky = false;
  const stack = [], marks = [], memo = new Map();
  let pos = 0, stopped = false;
  const OPAQUE = { opaque: true };
  const push = value => { if (stack.length >= MAX_STACK) throw new Error('stack overflow'); stack.push(value); };
  const pop = () => { if (!stack.length) throw new Error('stack underflow'); return stack.pop(); };
  const popMark = () => {
    if (!marks.length) throw new Error('missing mark');
    const depth = marks.pop();
    const items = stack.splice(depth);
    return items;
  };
  const line = () => {
    const end = bytes.indexOf(0x0a, pos);
    if (end < 0 || end - pos > MAX_LINE) throw new Error('unterminated line');
    const text = bytes.toString('utf8', pos, end); pos = end + 1; return text;
  };
  const take = n => { if (pos + n > bytes.length) throw new Error('truncated operand'); const b = bytes.subarray(pos, pos + n); pos += n; return b; };
  const u8 = () => take(1)[0];
  const u32 = () => take(4).readUInt32LE(0);
  const u64 = () => { const v = Number(take(8).readBigUInt64LE(0)); if (!Number.isSafeInteger(v)) throw new Error('length too large'); return v; };
  const str = n => { if (n > bytes.length - pos) throw new Error('truncated string'); const s = bytes.toString('utf8', pos, pos + n); pos += n; return { str: s }; };
  const record = (mod, name) => {
    if (!safeGlobal(mod, name)) { risky = true; findings.push(finding('import', `Pickle imports ${mod}.${name} — code can run when this file is loaded.`)); }
    return { global: `${mod}.${name}` };
  };
  // CPython keys MEMOIZE by len(memo) — explicit PUT entries count too. One
  // shared rule (memo.size) keeps scanner memo identical to loader memo even
  // when PUT and MEMOIZE are interleaved; a private counter desyncs them and
  // can resolve STACK_GLOBAL to an allowlisted name the loader never sees.
  const memoize = index => { if (memo.size >= MAX_STACK) throw new Error('memo overflow'); memo.set(index, stack[stack.length - 1] ?? OPAQUE); };
  // CPython parses PUT/GET line operands with int(), which also accepts '1_0',
  // unicode digits and a leading '+'. Number() parses those differently (NaN),
  // desyncing our memo from the loader's. Only canonical ASCII decimal is
  // tracked; anything else fails closed (unknown) instead of guessing.
  const decIndex = text => {
    if (!/^[0-9]+$/.test(text)) throw new Error('non-canonical memo index operand');
    const v = Number(text);
    if (!Number.isSafeInteger(v)) throw new Error('memo index too large');
    return v;
  };

  let ops = 0;
  while (pos < bytes.length) {
    if (++ops > MAX_PICKLE_OPS) throw new Error('too many opcodes');
    const op = bytes[pos++];
    switch (op) {
      case 0x28: if (marks.length >= MAX_STACK) throw new Error('mark overflow'); marks.push(stack.length); break; // (
      case 0x2e: stopped = true; break;                               // .
      case 0x30: pop(); break;                                        // 0
      case 0x31: popMark(); break;                                    // 1
      case 0x32: { if (!stack.length) throw new Error('stack underflow'); push(stack[stack.length - 1]); break; } // 2 DUP
      case 0x46: line(); push(OPAQUE); break;                         // F
      case 0x49: line(); push(OPAQUE); break;                         // I
      case 0x4a: take(4); push(OPAQUE); break;                        // J
      case 0x4b: u8(); push(OPAQUE); break;                           // K
      case 0x4c: line(); push(OPAQUE); break;                         // L
      case 0x4e: push(OPAQUE); break;                                 // N
      case 0x50: line(); push(OPAQUE); break;                         // P
      case 0x51: pop(); push(OPAQUE); break;                          // Q
      case 0x52: pop(); pop(); push(OPAQUE); break;                   // R
      case 0x53: push({ str: line() }); break;                        // S
      case 0x54: push(str(u32())); break;                             // T
      case 0x55: push(str(u8())); break;                              // U
      case 0x56: push({ str: line() }); break;                        // V
      case 0x58: push(str(u32())); break;                             // X
      case 0x61: pop(); break;                                        // a
      case 0x62: pop(); break;                                        // b
      case 0x63: { const mod = line(), name = line(); push(record(mod, name)); break; } // c
      case 0x64: popMark(); push(OPAQUE); break;                      // d
      case 0x7d: push(OPAQUE); break;                                 // }
      case 0x65: popMark(); break;                                    // e
      case 0x67: { const v = memo.get(decIndex(line())); if (v === undefined) throw new Error('missing memo'); push(v); break; } // g
      case 0x68: { const v = memo.get(u8()); if (v === undefined) throw new Error('missing memo'); push(v); break; }          // h
      case 0x69: { const mod = line(), name = line(); popMark(); push(record(mod, name)); break; } // i
      case 0x6a: { const v = memo.get(u32()); if (v === undefined) throw new Error('missing memo'); push(v); break; }        // j
      case 0x6c: popMark(); push(OPAQUE); break;                      // l
      case 0x5d: push(OPAQUE); break;                                 // ]
      case 0x6f: { const items = popMark(); if (!items.length) throw new Error('OBJ without callable'); push(OPAQUE); break; } // o
      case 0x70: memoize(decIndex(line())); break;                    // p
      case 0x71: memoize(u8()); break;                                // q
      case 0x72: memoize(u32()); break;                               // r
      case 0x73: pop(); pop(); break;                                 // s
      case 0x74: popMark(); push(OPAQUE); break;                      // t
      case 0x29: push(OPAQUE); break;                                 // )
      case 0x75: popMark(); break;                                    // u
      case 0x47: take(8); push(OPAQUE); break;                        // G
      case 0x80: { const v = u8(); if (v > 5) throw new Error('unsupported protocol'); break; } // PROTO
      case 0x81: pop(); pop(); push(OPAQUE); break;                   // NEWOBJ
      case 0x85: pop(); push(OPAQUE); break;                          // TUPLE1
      case 0x86: pop(); pop(); push(OPAQUE); break;                   // TUPLE2
      case 0x87: pop(); pop(); pop(); push(OPAQUE); break;            // TUPLE3
      case 0x88: case 0x89: push(OPAQUE); break;                      // NEWTRUE/FALSE
      case 0x8a: take(u8()); push(OPAQUE); break;                     // LONG1
      case 0x8b: take(u32()); push(OPAQUE); break;                    // LONG4
      case 0x8c: push(str(u8())); break;                              // SHORT_BINUNICODE
      case 0x8d: push(str(u64())); break;                             // BINUNICODE8
      case 0x42: take(u32()); push(OPAQUE); break;                    // B BINBYTES
      case 0x43: take(u8()); push(OPAQUE); break;                     // C SHORT_BINBYTES
      case 0x8e: take(u64()); push(OPAQUE); break;                    // BINBYTES8
      case 0x8f: push(OPAQUE); break;                                 // EMPTY_SET
      case 0x90: popMark(); break;                                    // ADDITEMS
      case 0x91: popMark(); push(OPAQUE); break;                      // FROZENSET
      case 0x92: pop(); pop(); pop(); push(OPAQUE); break;            // NEWOBJ_EX
      case 0x93: {                                                    // STACK_GLOBAL
        const name = pop(), mod = pop();
        if (typeof name?.str !== 'string' || typeof mod?.str !== 'string') throw new Error('STACK_GLOBAL without string operands');
        push(record(mod.str, name.str)); break;
      }
      case 0x94: memoize(memo.size); break;                           // MEMOIZE
      case 0x95: take(8); break;                                      // FRAME
      case 0x96: take(u64()); push(OPAQUE); break;                    // BYTEARRAY8
      case 0x97: push(OPAQUE); break;                                 // NEXT_BUFFER
      case 0x98: break;                                               // READONLY_BUFFER
      default: throw new Error(`unknown opcode 0x${op.toString(16)} at ${pos - 1}`);
    }
    if (stopped) break;
  }
  if (!stopped) return { verdict: 'unknown', findings: [...findings, finding('structure', 'Pickle stream has no STOP opcode.')] };
  // Trailing non-zero bytes can be a second pickle stream (or padding around
  // one). torch.load reads a single stream, but we refuse to call a file safe
  // while unscanned executable-looking bytes remain: re-walk the remainder.
  if (pos < bytes.length) {
    const tail = bytes.subarray(pos);
    if (tail.some(b => b !== 0)) {
      findings.push(finding('structure', 'Extra data after the pickle STOP opcode.'));
      const rest = walkPickle(tail);
      findings.push(...rest.findings);
      if (risky || rest.verdict === 'risky-format') return { verdict: 'risky-format', findings };
      return { verdict: 'unknown', findings };
    }
  }
  if (risky) return { verdict: 'risky-format', findings };
  if (findings.length) return { verdict: 'unknown', findings };
  return { verdict: 'safe-format', findings };
}

/** Torch >= 1.6 saves a zip archive whose code lives in data.pkl. Walk every
 * pickle entry; stored and deflate entries only, everything else is unknown. */
function zipPickleStreams(bytes) {
  const streams = [];
  let pos = 0, entries = 0, totalInflated = 0;
  const addStream = buf => {
    if (streams.length >= MAX_ZIP_PICKLE_STREAMS) throw new Error('too many pickle streams in zip');
    totalInflated += buf.length;
    if (totalInflated > MAX_PICKLE_SCAN_BYTES) throw new Error('zip pickle streams exceed the scan budget');
    streams.push(buf);
  };
  // Pass 1: walk local headers, recording each entry's facts by offset. We do
  // NOT select streams here — Python's zipfile picks entries by the CENTRAL
  // DIRECTORY (names, sizes, offsets), so the CD is the source of truth.
  const locals = new Map();
  while (pos + 30 <= bytes.length && bytes.readUInt32LE(pos) === 0x04034b50) {
    if (++entries > MAX_ZIP_ENTRIES) throw new Error('too many zip entries');
    const flags = bytes.readUInt16LE(pos + 6), method = bytes.readUInt16LE(pos + 8);
    const csize = bytes.readUInt32LE(pos + 18), usize = bytes.readUInt32LE(pos + 22);
    const nameLen = bytes.readUInt16LE(pos + 26), extraLen = bytes.readUInt16LE(pos + 28);
    if (flags & 1) throw new Error('encrypted zip entry');
    if (flags & 8) throw new Error('zip data descriptor not supported');
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('zip64 not supported');
    const name = bytes.toString('utf8', pos + 30, pos + 30 + nameLen);
    const dataStart = pos + 30 + nameLen + extraLen;
    if (dataStart + csize > bytes.length) throw new Error('truncated zip entry');
    locals.set(pos, { flags, method, csize, usize, name, dataStart });
    pos = dataStart + csize;
  }
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > bytes.length) {
    if (entries > 0) throw new Error('zip end-of-central-directory missing');
    return streams;
  }
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) throw new Error('multi-disk zip not supported');
  const total = bytes.readUInt16LE(eocd + 10);
  if (bytes.readUInt16LE(eocd + 8) !== total) throw new Error('zip disk entry count disagrees');
  if (eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length) throw new Error('trailing bytes after zip end-of-central-directory');
  // Pass 2: every CD entry must claim exactly one walked local header, with
  // matching flags/method/sizes/name. Streams are selected by the CD name and
  // read with CD sizes — exactly what zipfile hands the unpickler. Any
  // disagreement (shrunk local sizes, renamed entries, duplicate offsets,
  // hidden entries, junk around the CD) means the listing is not trustworthy.
  let cd = bytes.readUInt32LE(eocd + 16), cdCount = 0;
  const claimed = new Set();
  while (cd + 46 <= eocd && bytes.readUInt32LE(cd) === 0x02014b50) {
    if (++cdCount > MAX_ZIP_ENTRIES) throw new Error('too many zip entries');
    const flags = bytes.readUInt16LE(cd + 8), method = bytes.readUInt16LE(cd + 10);
    const csize = bytes.readUInt32LE(cd + 20), usize = bytes.readUInt32LE(cd + 24);
    const nameLen = bytes.readUInt16LE(cd + 28), extraLen = bytes.readUInt16LE(cd + 30), commentLen = bytes.readUInt16LE(cd + 32);
    const localOffset = bytes.readUInt32LE(cd + 42);
    const name = bytes.toString('utf8', cd + 46, cd + 46 + nameLen);
    const local = locals.get(localOffset);
    if (!local || claimed.has(localOffset)) throw new Error('zip central directory claims an unknown or duplicate local entry');
    claimed.add(localOffset);
    if (local.flags !== flags || local.method !== method || local.csize !== csize || local.usize !== usize || local.name !== name) {
      throw new Error('zip central directory disagrees with local header');
    }
    if (/\.pkl$/i.test(name)) {
      if (method === 0) addStream(bytes.subarray(local.dataStart, local.dataStart + csize));
      else if (method === 8) addStream(zlib.inflateRawSync(bytes.subarray(local.dataStart, local.dataStart + csize), { maxOutputLength: MAX_PICKLE_SCAN_BYTES - totalInflated + 1 }));
      else throw new Error(`unsupported zip compression ${method}`);
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  if (cd !== eocd) throw new Error('zip central directory does not end at EOCD');
  if (cdCount !== total || cdCount !== entries) throw new Error('zip central directory disagrees with local entries');
  return streams;
}

async function checkPickleFamily(reader, { extensionRoute = false } = {}) {
  // The extension is a routing hint, not proof. Sniff the magic so a renamed
  // pickle is still walked and a renamed data file is not misreported.
  const head = await reader.at(0, Math.min(4, reader.size));
  const looksZip = head.length >= 4 && head.readUInt32LE(0) === 0x04034b50;
  const looksPickle = head.length >= 2 && head[0] === 0x80 && head[1] <= 5;
  // Protocol-0/1 pickles are ASCII with no PROTO byte. A pickle-family
  // extension is authority enough to attempt the walk (it fails closed on
  // garbage); without that hint we stay unknown to avoid text-file noise.
  if (!looksZip && !looksPickle && !extensionRoute) return result('unknown', 'pickle', [finding('structure', 'File does not look like a pickle or torch zip; renamed or unsupported container.')]);
  if (reader.size > MAX_PICKLE_SCAN_BYTES) {
    return result('unknown', 'pickle', [finding('size', `Pickle-family file is too large to scan (${reader.size} bytes > ${MAX_PICKLE_SCAN_BYTES} cap).`)]);
  }
  const bytes = await reader.at(0, reader.size);
  let streams;
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    try { streams = zipPickleStreams(bytes); }
    catch (error) { return result('unknown', 'pickle', [finding('structure', `Zip container could not be inspected: ${error.message}.`)]); }
    if (!streams.length) return result('unknown', 'pickle', [finding('structure', 'Zip container holds no pickle stream to inspect.')]);
  } else streams = [bytes];
  const findings = [];
  let verdict = 'safe-format';
  for (const stream of streams) {
    let walked;
    try { walked = walkPickle(stream); }
    catch (error) { walked = { verdict: 'unknown', findings: [finding('structure', `Pickle walk failed: ${error.message}.`)] }; }
    findings.push(...walked.findings);
    if (walked.verdict === 'risky-format') verdict = 'risky-format';
    else if (walked.verdict === 'unknown' && verdict === 'safe-format') verdict = 'unknown';
  }
  return result(verdict, 'pickle', findings);
}

/* ------------------------------------------------------------------- routing */

/** Analyze one file on disk. Never throws for unreadable/odd files — those are
 * `unknown` with an honest finding. Multi-GB weights are never buffered. */
export async function analyzeFileSafety(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  const extFormat = ext === '.safetensors' ? 'safetensors' : ext === '.gguf' ? 'gguf' : PICKLE_EXT.has(ext) ? 'pickle' : 'unknown';
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return result('unknown', extFormat, [finding('structure', 'Not a regular file.')]);
    const reader = new Reader(handle, stat.size);
    // Content sniff before routing: a pickle renamed .gguf/.safetensors (or
    // given an unknown extension) must still be walked. Leading 0x80 PROTO or
    // a local-file zip magic routes to the pickle-family check regardless of
    // the filename; everything else keeps its extension route.
    const head = await reader.at(0, Math.min(4, reader.size));
    const looksZip = head.length >= 4 && head.readUInt32LE(0) === 0x04034b50;
    const looksPickle = head.length >= 2 && head[0] === 0x80 && head[1] <= 5;
    // Data-only formats get their structural check FIRST: a legitimate small
    // safetensors whose header-length low byte is 0x80 must not be mistaken
    // for a PROTO opcode. Only a failed structural check falls back to the
    // content sniff, so a pickle renamed .safetensors/.gguf is still walked.
    if (extFormat === 'safetensors' || extFormat === 'gguf') {
      const structural = extFormat === 'safetensors' ? await checkSafetensors(reader) : await checkGguf(reader);
      if (structural.verdict !== 'unknown') return structural;
      if (looksZip || looksPickle) return await checkPickleFamily(reader);
      return structural;
    }
    if (looksZip || looksPickle) return await checkPickleFamily(reader, { extensionRoute: extFormat === 'pickle' });
    if (extFormat === 'pickle') return await checkPickleFamily(reader, { extensionRoute: true });
    return result('unknown', 'unknown', [finding('structure', `No structural check exists for "${ext || 'extensionless'}" files.`)]);
  } catch (error) {
    return result('unknown', extFormat, [finding('read', `File could not be read: ${error.code || error.message}.`)]);
  } finally { await handle?.close().catch(() => {}); }
}
