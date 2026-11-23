/** Hold a completed download to the AEON origin statement inside its
 * model-card.json (AEON Model Share protocol, section 6). The statement names
 * plain file hashes, so the same check applies whether the bytes arrived over
 * IPFS or BitTorrent. Only the collection's own recorded files are read; the
 * folder is never enumerated and nothing is written.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compareToManifest, verifyOrigin } from '../shared/aeon-origin.js';
import { CARD_FILE, normalizeOriginResult } from '../shared/aeon-origin-status.js';

const MAX_CARD_BYTES = 1024 * 1024; // the Orb refuses a larger card
const HEX64 = /^[a-f0-9]{64}$/i;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Resolve one recorded file without following a link at any level. */
async function regular(root, relative) {
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index] || parts[index] === '.' || parts[index] === '..' || /[\\:]/.test(parts[index])) throw new Error('A recorded file path is not valid.');
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('A downloaded file is linked or is no longer a regular file.');
    if (index === parts.length - 1) return { target: current, stat };
  }
  throw new Error('A recorded file path is not valid.');
}

async function read(target, before, { limit, signal } = {}) {
  const handle = await fs.open(target, 'r');
  try {
    const held = await handle.stat();
    if (!same(before, held) || held.size !== before.size) throw new Error('A downloaded file changed while opening.');
    const hash = createHash('sha256'), chunks = [];
    if (held.size) for await (const chunk of handle.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); hash.update(chunk); if (limit) chunks.push(chunk); }
    const end = await handle.stat();
    if (end.size !== held.size || end.mtimeMs !== held.mtimeMs) throw new Error('A downloaded file changed while it was being checked.');
    return { sha256: hash.digest('hex'), bytes: limit ? Buffer.concat(chunks) : null };
  } finally { await handle.close(); }
}

function validFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('This download has no recorded files.');
  for (const file of files) if (typeof file?.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('This download has an invalid file record.');
  return files;
}

/** Cheap identity of the recorded files as they are on disk now. A stored
 * result is only reused while this is unchanged. */
export async function originFingerprint(root, files) {
  const hash = createHash('sha256');
  for (const file of [...validFiles(files)].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    const { stat } = await regular(root, file.path);
    hash.update(JSON.stringify([file.path, stat.size, stat.mtimeMs, stat.ino]) + '\n');
  }
  return hash.digest('hex');
}

/** Content-anchored fingerprint for integrity verdicts. Small files (≤64 MiB —
 * the pickle-family scan budget) are bound by their actual bytes, so a
 * same-size, same-mtime in-place rewrite cannot reuse a stale safe verdict.
 * Multi-GB weights stay stat-keyed: their bytes are bound by the upstream
 * anchor and torrent piece hashes, and hashing them at every gate would
 * re-read gigabytes. */
export async function integrityFingerprint(root, files, { signal, contentMaxBytes = 64 * 1024 * 1024 } = {}) {
  const hash = createHash('sha256');
  for (const file of [...validFiles(files)].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    signal?.throwIfAborted();
    const { target, stat } = await regular(root, file.path);
    const anchor = stat.size <= contentMaxBytes ? ['content', (await read(target, stat, { signal })).sha256] : ['stat', stat.size, stat.mtimeMs, stat.ino];
    hash.update(JSON.stringify([file.path, ...anchor]) + '\n');
  }
  return hash.digest('hex');
}

/**
 * `root` is the collection folder; `files` is its exact recorded file list
 * as `{ path, size }`, paths relative to `root` with forward slashes. `hashes`
 * may supply SHA-256 values the caller already computed from these files on
 * disk (the IPFS writer does); everything else is hashed here.
 *
 * Returns null when the folder holds no AEON model card. Otherwise:
 *   verified — the signature holds over exactly these files
 *   unsigned — an AEON card with no signature (the files still match its list)
 *   failed   — hidden files, a different file set, or a signature that does not hold
 * Read errors throw: a file that cannot be read is not evidence of tampering.
 */
export async function checkOrigin(root, files, { hashes, signal, now = Date.now } = {}) {
  if (!validFiles(files).some(file => file.path === CARD_FILE)) return null;
  const located = await regular(root, CARD_FILE);
  if (located.stat.size > MAX_CARD_BYTES) throw new Error('model-card.json is implausibly large.');
  const stored = await read(located.target, located.stat, { limit: MAX_CARD_BYTES, signal });
  if (hashes?.has(CARD_FILE) && hashes.get(CARD_FILE) !== stored.sha256) throw new Error('model-card.json changed after it was downloaded.');
  let card;
  try { card = JSON.parse(stored.bytes.toString('utf8')); } catch { return null; }
  const origin = card && typeof card === 'object' && !Array.isArray(card) && card.origin && typeof card.origin === 'object' ? card.origin : null;
  if (!card || typeof card !== 'object' || Array.isArray(card) || !origin && !(typeof card.schema === 'string' && card.schema.startsWith('aeon-model-card/'))) return null;

  const fingerprint = await originFingerprint(root, files);
  const result = fields => normalizeOriginResult({ ...fields, fingerprint, checkedAt: now() });
  const failed = (reason, name = '') => result({ status: 'failed', reason, path: name });

  // Protocol step 1: nothing in a model is hidden. Links and special files
  // are refused while reading, below.
  const hidden = files.find(file => file.path.split('/').some(part => part.startsWith('.')));
  if (hidden) return failed('hidden', hidden.path);

  // Step 2: the files as they are on disk, except the card itself.
  const actual = [];
  for (const file of files) {
    if (file.path === CARD_FILE) continue;
    signal?.throwIfAborted();
    const { target, stat } = await regular(root, file.path);
    const known = hashes?.get(file.path);
    if (known !== undefined && (!HEX64.test(known) || stat.size !== file.size)) throw new Error('A downloaded file changed after it was verified.');
    actual.push({ path: file.path, size: stat.size, sha256: (known ?? (await read(target, stat, { signal })).sha256).toLowerCase() });
  }
  const signed = typeof origin?.sig === 'string' && origin.sig !== '';

  if (Array.isArray(card.files)) {
    const manifest = [];
    for (const file of card.files) {
      if (typeof file?.path !== 'string' || !file.path || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !HEX64.test(file.sha256)) return failed('manifest');
      manifest.push({ path: file.path, size: file.size, sha256: file.sha256.toLowerCase() });
    }
    const compared = compareToManifest(actual, manifest);
    if (!compared.ok) {
      const listed = manifest.some(file => file.path === compared.mismatch), present = actual.some(file => file.path === compared.mismatch);
      return failed(listed && present ? 'changed' : listed ? 'missing' : 'extra', compared.mismatch);
    }
    if (!signed) return result({ status: 'unsigned' });
    // Step 3: a signature that is present must hold over exactly this manifest.
    const credit = verifyOrigin({ ...card, files: manifest });
    return credit.ok ? result({ status: 'verified', signer: credit.signer.toLowerCase(), identity: credit.identity.toLowerCase(), name: credit.name }) : failed('signature');
  }
  // A signature needs a manifest to cover. An older card without one promises
  // only its primary file's hash.
  if (signed) return failed('signature');
  if (typeof card.file === 'string' && card.file && typeof card.sha256 === 'string' && HEX64.test(card.sha256)) {
    const primary = actual.find(file => file.path === card.file);
    if (!primary) return failed('missing', card.file);
    if (primary.sha256 !== card.sha256.toLowerCase()) return failed('changed', card.file);
  }
  return result({ status: 'unsigned' });
}

/** A `frostbyte.release` lists a folder copy as `<folder>/<file>`. The origin
 * manifest and an IPFS directory list the same files without that folder. */
export function collectionFiles(files) {
  const first = files[0]?.path.split('/')[0];
  const nested = files.length > 0 && files.every(file => file.path.startsWith(first + '/'));
  return files.map(file => ({ ...file, path: nested ? file.path.slice(first.length + 1) : file.path }));
}

/** Origin results for torrent-backed library copies, keyed by inventory id.
 * IPFS collections keep their result on the transfer record instead. */
export class OriginRegistry {
  constructor({ store, inventory }) { this.store = store; this.inventory = inventory; this.pending = new Map(); }
  get(id) { return normalizeOriginResult(this.store.state.aeonOrigins?.[id]); }
  snapshot() {
    const rows = {};
    for (const row of this.inventory.rows) { const result = this.get(row.id); if (result) rows[row.id] = result; }
    return rows;
  }
  /** The folder and exact recorded files of a multi-file torrent copy. */
  collection(id) {
    const row = this.inventory.rows.find(item => item.id === id);
    if (!row || row.source !== 'torrent' || !row.directory || !row.relative) return null;
    const files = row.files.map(file => ({ path: file.relative.slice(row.relative.length + 1), size: file.size }));
    return files.some(file => file.path === CARD_FILE) ? { root: row.path, files } : null;
  }
  save(id, result) {
    const kept = this.snapshot(); delete kept[id];
    if (result) kept[id] = result;
    this.store._commitStateFields({ aeonOrigins: kept });
  }
  /** Null when the copy holds no AEON card. A stored result is reused only
   * while the files it covered are unchanged on disk. */
  ensure(id, options) {
    if (!this.pending.has(id)) this.pending.set(id, this.check(id, options).finally(() => this.pending.delete(id)));
    return this.pending.get(id);
  }
  async check(id, { signal } = {}) {
    const copy = this.collection(id);
    if (!copy) { if (this.store.state.aeonOrigins?.[id]) this.save(id, null); return null; }
    const stored = this.get(id);
    if (stored?.fingerprint && stored.fingerprint === await originFingerprint(copy.root, copy.files)) return stored;
    const result = await checkOrigin(copy.root, copy.files, { signal });
    this.save(id, result);
    return result;
  }
}
