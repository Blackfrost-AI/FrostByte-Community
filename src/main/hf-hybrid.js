/** Public HF files + explicitly shared files on a paired Spark. No public discovery. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import createTorrent from 'create-torrent';
import parseTorrent from 'parse-torrent';
import WebConn from 'webtorrent/lib/webconn.js';
import {
  hfFetchRange, hfModelInfo, hfStatFile, validateHfFilePath, validateHfRepoId,
} from './hf.js';
import { usePairedDiscovery } from './torrent.js';
import SafeTorrentStore, { validateLocalStorageRoot } from './safe-torrent-store.js';

const active = new Set();
const LICENSES = new Set(['apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'cc0-1.0']);
const PIECE_LENGTH = 4 * 1024 * 1024;
const MAX_HYBRID_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ENCODED_METADATA_CHARS = Math.ceil(MAX_HYBRID_METADATA_BYTES / 3) * 4;
const MAX_SAVED_MANIFEST_BYTES = MAX_ENCODED_METADATA_CHARS + 4096;
const MAX_HF_FILE_BYTES = 16 * 1024 ** 4;
const MAX_HYBRID_COUNTER_BYTES = MAX_HF_FILE_BYTES * 4;
const MAX_PEERS = 8;
const NOFOLLOW = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
const CLOEXEC = fs.constants.O_CLOEXEC || 0;
const IDENTITY_FIELDS = new Set(['repoId', 'revision', 'filePath', 'size', 'sha256']);
const PLAN_FIELDS = new Set(['identity', 'metadata', 'peers']);
const SAVED_FIELDS = new Set(['schemaVersion', 'key', 'infoHash', 'metadata', 'hfBytes', 'peerBytes']);
const enc = value => value.split('/').map(encodeURIComponent).join('/');
const boundaryError = message => Object.assign(new Error(message), { code: 'FROSTBYTE_HYBRID_PATH_BOUNDARY' });

function plainRecord(value, allowed, required, label) {
  let keys;
  let descriptors;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (!value || typeof value !== 'object' || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) throw new Error();
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new Error(`${label} must be a plain object.`); }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key)) || keys.length > allowed.size) throw new Error(`${label} contains unsupported fields.`);
  for (const field of required) if (!keys.includes(field)) throw new Error(`${label} is missing ${field}.`);
  for (const key of keys) if (!Object.hasOwn(descriptors[key], 'value')) throw new Error(`${label} cannot contain accessors.`);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function plainArray(value, max, label) {
  let descriptors;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) throw new Error();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new Error(`${label} must be a bounded plain array.`); }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) throw new Error(`${label} contains unsupported fields.`);
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`${label} cannot contain holes or accessors.`);
    result.push(descriptor.value);
  }
  return result;
}

export function validateIdentity(value) {
  const identity = plainRecord(value, IDENTITY_FIELDS, IDENTITY_FIELDS, 'HF file identity');
  identity.repoId = validateHfRepoId(identity.repoId);
  identity.filePath = validateHfFilePath(identity.filePath);
  if (Buffer.byteLength(identity.filePath, 'utf8') > 4096 || Buffer.byteLength(path.basename(identity.filePath), 'utf8') > 1024) {
    throw new Error('Invalid HF file path.');
  }
  if (!/^[a-f0-9]{40}$/.test(identity.revision || '') || !/^[a-f0-9]{64}$/.test(identity.sha256 || '')
      || !Number.isSafeInteger(identity.size) || identity.size <= 0 || identity.size > MAX_HF_FILE_BYTES) throw new Error('Invalid HF file identity.');
  return identity;
}

export function identityKey(value) {
  const identity = validateIdentity(value);
  return crypto.createHash('sha256').update(JSON.stringify([
    identity.repoId, identity.revision, identity.filePath, identity.size, identity.sha256,
  ])).digest('hex');
}

export async function getHybridIdentity({ repoId, revision, filePath, token, signal }) {
  repoId = validateHfRepoId(repoId);
  filePath = validateHfFilePath(filePath);
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) return null;
  revision = revision.toLowerCase();
  const model = await hfModelInfo(repoId, { revision, token, signal });
  if (model.gated || model.private || !LICENSES.has(model.license)) return null;
  const file = model.files.find(row => row.path === filePath);
  if (!file) return null;
  const stat = await hfStatFile({ repoId, revision, filePath, token, signal });
  if (!/^[a-f0-9]{64}$/i.test(stat.etag || '') || !stat.size) return null;
  return validateIdentity({ repoId, revision, filePath, size: stat.size, sha256: stat.etag.toLowerCase() });
}

function sameObject(left, right) {
  if (!left || !right) return false;
  if (Number(left.ino) && Number(right.ino)) return left.dev === right.dev && left.ino === right.ino;
  return true;
}

function sameFileSnapshot(left, right) {
  return sameObject(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function validateRegularFile(stat, label, { links = 1 } = {}) {
  if (!stat?.isFile() || stat.isSymbolicLink?.() || stat.nlink !== links) throw boundaryError(`${label} must be a regular, single-link file.`);
  return stat;
}

async function openRegularFile(file, label) {
  const before = validateRegularFile(await fs.promises.lstat(file), label);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | NOFOLLOW | CLOEXEC);
  try {
    const opened = validateRegularFile(await handle.stat(), label);
    const linked = validateRegularFile(await fs.promises.lstat(file), label);
    if (!sameFileSnapshot(before, opened) || !sameFileSnapshot(opened, linked)) throw boundaryError(`${label} changed while it was opened.`);
    return { handle, identity: opened };
  } catch (error) { await handle.close(); throw error; }
}

async function hashHandle(handle, signal) {
  const hash = crypto.createHash('sha256');
  const stream = handle.createReadStream({ start: 0, autoClose: false, signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyOpenFile(handle, file, identity, label) {
  const opened = validateRegularFile(await handle.stat(), label);
  const linked = validateRegularFile(await fs.promises.lstat(file), label);
  if (!sameFileSnapshot(identity, opened) || !sameFileSnapshot(opened, linked)) throw boundaryError(`${label} changed while it was being used.`);
}

export async function createHybridManifest(file, value) {
  const identity = validateIdentity(value);
  if (Math.ceil(identity.size / PIECE_LENGTH) * 20 > MAX_HYBRID_METADATA_BYTES - 64 * 1024) throw new Error('This file needs more HF peer metadata than FrostByte can safely accept.');
  const { handle, identity: opened } = await openRegularFile(file, 'The shared HF file');
  try {
    if (opened.size !== identity.size || await hashHandle(handle) !== identity.sha256) throw new Error('The shared file does not match the pinned HuggingFace file.');
    await verifyOpenFile(handle, file, opened, 'The shared HF file');
    const metadata = await new Promise((resolve, reject) => createTorrent(file, {
      name: path.basename(identity.filePath), pieceLength: PIECE_LENGTH,
      private: true, announceList: [], urlList: [], creationDate: 0, createdBy: 'FrostByte HF v1',
    }, (error, result) => error ? reject(error) : resolve(Buffer.from(result))));
    await verifyOpenFile(handle, file, opened, 'The shared HF file');
    await validateHybridManifest(metadata, identity);
    return metadata;
  } finally { await handle.close(); }
}

export async function validateHybridManifest(metadata, value) {
  const identity = validateIdentity(value);
  if (!Buffer.isBuffer(metadata) || !metadata.length || metadata.length > MAX_HYBRID_METADATA_BYTES) throw new Error('Invalid HF peer manifest.');
  let parsed;
  try { parsed = await parseTorrent(metadata); } catch { throw new Error('Invalid HF peer manifest.'); }
  if (parsed.private !== true || parsed.files?.length !== 1
      || parsed.name !== path.basename(identity.filePath) || parsed.files[0].path !== path.basename(identity.filePath)
      || parsed.length !== identity.size || parsed.pieceLength !== PIECE_LENGTH
      || !Array.isArray(parsed.pieces) || parsed.pieces.length !== Math.ceil(identity.size / parsed.pieceLength)
      || !/^[a-f0-9]{40}$/.test(parsed.infoHash || '')) throw new Error('HF peer manifest does not match the selected file.');
  if (parsed.announce?.length || parsed.urlList?.length) throw new Error('HF peer manifests must use paired-device discovery only.');
  return parsed;
}

function decodeMetadata(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_ENCODED_METADATA_CHARS || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`${label} metadata is invalid or too large.`);
  const metadata = Buffer.from(value, 'base64');
  if (!metadata.length || metadata.length > MAX_HYBRID_METADATA_BYTES || metadata.toString('base64') !== value) throw new Error(`${label} metadata is not canonical base64.`);
  return metadata;
}

function validatePeers(value) {
  if (Array.isArray(value) && value.length > MAX_PEERS) throw new Error('HF peer plan contains too many device addresses.');
  const addresses = plainArray(value, MAX_PEERS, 'HF peer plan addresses');
  const peers = addresses.map(address => {
    if (typeof address !== 'string' || address.length > 64 || /[\0\r\n]/.test(address)) throw new Error('HF peer plan contains an invalid device address.');
    const match = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(address);
    const ipv6 = /^\[([a-fA-F0-9:.]+)]:(\d+)$/.exec(address);
    const host = match?.[1] || ipv6?.[1];
    const port = Number(match?.[2] || ipv6?.[2]);
    const family = net.isIP(host || '');
    if ((!match || family !== 4) && (!ipv6 || family !== 6)
      || !Number.isSafeInteger(port) || port <= 0 || port > 65535) {
      throw new Error('HF peer plan contains an invalid device address.');
    }
    if (family === 4) return `${host}:${port}`;
    // URL's parser gives one canonical bracketed rendering, so equivalent
    // expanded/compressed IPv6 addresses cannot bypass duplicate detection.
    return `${new URL(`http://[${host}]/`).hostname}:${port}`;
  });
  if (new Set(peers).size !== peers.length) throw new Error('HF peer plan repeats a device address.');
  return peers.sort();
}

function validatePlan(value, identity) {
  const plan = plainRecord(value, PLAN_FIELDS, PLAN_FIELDS, 'HF peer plan');
  const plannedIdentity = validateIdentity(plan.identity);
  if (identityKey(plannedIdentity) !== identityKey(identity)) throw new Error('The device returned a different HF file.');
  return { metadata: decodeMetadata(plan.metadata, 'HF peer plan'), peers: validatePeers(plan.peers) };
}

function peerApprovalRequest(identity, plan, parsed) {
  const metadataDigest = crypto.createHash('sha256').update(plan.metadata).digest('hex');
  const canonical = JSON.stringify([1, [identity.repoId, identity.revision, identity.filePath, identity.size, identity.sha256],
    parsed.infoHash, metadataDigest, plan.peers]);
  return { identity: structuredClone(identity), planDigest: crypto.createHash('sha256').update(canonical).digest('hex'),
    infoHash: parsed.infoHash, peers: [...plan.peers] };
}

function validateSaved(value, identity) {
  const saved = plainRecord(value, SAVED_FIELDS, SAVED_FIELDS, 'Saved HF partial manifest');
  if (saved.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(saved.key || '') || !/^[a-f0-9]{40}$/.test(saved.infoHash || '')) throw new Error('The saved HF partial manifest has an invalid identity.');
  for (const field of ['hfBytes', 'peerBytes']) {
    if (!Number.isSafeInteger(saved[field]) || saved[field] < 0 || saved[field] > MAX_HYBRID_COUNTER_BYTES) {
      throw new Error('The saved HF partial manifest has invalid counters.');
    }
  }
  if (saved.key !== identityKey(identity)) throw new Error('A different revision has a partial download in this destination. Choose another folder.');
  return { ...saved, metadataBytes: decodeMetadata(saved.metadata, 'Saved HF partial manifest') };
}

function beneath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeDirectory(target, label) {
  const linked = fs.lstatSync(target);
  const current = fs.statSync(target);
  if (linked.isSymbolicLink() || !linked.isDirectory() || !current.isDirectory() || fs.realpathSync(target) !== target) throw boundaryError(`${label} is linked or unavailable.`);
  return current;
}

function sameDirectory(target, identity, label) {
  const current = safeDirectory(target, label);
  if (!sameObject(identity, current)) throw boundaryError(`${label} changed during the download.`);
  return current;
}

function makeDirectory(target, label) {
  try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return safeDirectory(target, label);
}

function ensureAbsent(target, label) {
  try { fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw boundaryError(`${label} already exists. Choose another destination or remove it first.`);
}

function prepareBoundary(approvedRoot, requestedDest) {
  const requestedRoot = validateLocalStorageRoot(approvedRoot);
  if (typeof requestedDest !== 'string' || !requestedDest || requestedDest.length > 32_768 || /[\0\r\n]/.test(requestedDest) || !path.isAbsolute(requestedDest)) throw boundaryError('Choose a valid absolute destination for this HF file.');
  const dest = path.resolve(requestedDest);
  const relative = path.relative(requestedRoot, dest);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw boundaryError('HF hybrid downloads must stay inside the approved download folder.');
  const rootLink = fs.lstatSync(requestedRoot);
  if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) throw boundaryError('The approved download folder is linked or unavailable.');
  const root = fs.realpathSync(requestedRoot);
  const rootStat = safeDirectory(root, 'The approved download folder');
  const canonicalDest = path.resolve(root, relative);
  if (!beneath(root, canonicalDest)) throw boundaryError('HF hybrid download escaped its approved folder.');
  const parent = path.dirname(canonicalDest);
  let current = root;
  for (const component of path.relative(root, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    makeDirectory(current, 'The HF destination folder');
  }
  const parentStat = safeDirectory(parent, 'The HF destination folder');
  ensureAbsent(canonicalDest, 'The HF destination');
  const directory = `${canonicalDest}.frosthybrid`;
  const directoryStat = makeDirectory(directory, 'The HF partial folder');
  const dataDirectory = path.join(directory, 'data');
  const dataDirectoryStat = makeDirectory(dataDirectory, 'The HF partial data folder');
  const boundary = { root, rootStat, parent, parentStat, dest: canonicalDest, directory, directoryStat, dataDirectory, dataDirectoryStat };
  verifyBoundary(boundary);
  return boundary;
}

function verifyBoundary(boundary) {
  sameDirectory(boundary.root, boundary.rootStat, 'The approved download folder');
  sameDirectory(boundary.parent, boundary.parentStat, 'The HF destination folder');
  sameDirectory(boundary.directory, boundary.directoryStat, 'The HF partial folder');
  sameDirectory(boundary.dataDirectory, boundary.dataDirectoryStat, 'The HF partial data folder');
}

function verifyLayout(boundary, fileName, { allowMissingData = true } = {}) {
  verifyBoundary(boundary);
  const controlEntries = fs.readdirSync(boundary.directory).sort();
  if (controlEntries.some(name => !['data', 'manifest.json'].includes(name))) throw boundaryError('The HF partial folder contains unexpected files.');
  const dataEntries = fs.readdirSync(boundary.dataDirectory).sort();
  if (dataEntries.some(name => name !== fileName) || (!allowMissingData && dataEntries.length !== 1)) throw boundaryError('The HF partial data folder contains unexpected files.');
}

function optionalRegularFile(file, label) {
  try { return validateRegularFile(fs.lstatSync(file), label); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function readBoundedDescriptor(fd, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
    const bytes = fs.readSync(fd, chunk, 0, chunk.length, total);
    if (!bytes) break;
    chunks.push(chunk.subarray(0, bytes));
    total += bytes;
  }
  if (total > maxBytes) throw new Error('The saved HF partial manifest is too large.');
  return Buffer.concat(chunks, total).toString('utf8');
}

function readSavedManifest(file, boundary) {
  verifyBoundary(boundary);
  const before = optionalRegularFile(file, 'The saved HF partial manifest');
  if (!before) return null;
  if (before.size > MAX_SAVED_MANIFEST_BYTES) throw new Error('The saved HF partial manifest is too large.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | CLOEXEC);
  try {
    const opened = validateRegularFile(fs.fstatSync(fd), 'The saved HF partial manifest');
    const linked = validateRegularFile(fs.lstatSync(file), 'The saved HF partial manifest');
    if (!sameFileSnapshot(before, opened) || !sameFileSnapshot(opened, linked)) throw boundaryError('The saved HF partial manifest changed while it was opened.');
    verifyBoundary(boundary);
    const text = readBoundedDescriptor(fd, MAX_SAVED_MANIFEST_BYTES);
    const after = validateRegularFile(fs.fstatSync(fd), 'The saved HF partial manifest');
    const afterLink = validateRegularFile(fs.lstatSync(file), 'The saved HF partial manifest');
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, afterLink)) throw boundaryError('The saved HF partial manifest changed while it was read.');
    verifyBoundary(boundary);
    try { return { value: JSON.parse(text), identity: after }; } catch { throw new Error('The saved HF partial manifest is unreadable.'); }
  } finally { fs.closeSync(fd); }
}

function writeManifest(file, value, boundary, expected) {
  verifyBoundary(boundary);
  const current = optionalRegularFile(file, 'The saved HF partial manifest');
  if ((expected && (!current || !sameObject(expected, current))) || (!expected && current)) throw boundaryError('The saved HF partial manifest changed before it was saved.');
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_SAVED_MANIFEST_BYTES) throw new Error('The saved HF partial manifest is too large.');
  const temporary = path.join(boundary.directory, `.manifest-${process.pid}-${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | CLOEXEC, 0o600);
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    const opened = validateRegularFile(fs.fstatSync(fd), 'The temporary HF partial manifest');
    verifyBoundary(boundary);
    const beforeRename = optionalRegularFile(file, 'The saved HF partial manifest');
    if ((expected && (!beforeRename || !sameObject(expected, beforeRename))) || (!expected && beforeRename)) throw boundaryError('The saved HF partial manifest changed while it was saved.');
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const written = validateRegularFile(fs.lstatSync(file), 'The saved HF partial manifest');
    if (!sameObject(opened, written)) throw boundaryError('The saved HF partial manifest changed during finalization.');
    verifyBoundary(boundary);
    try {
      const directoryFd = fs.openSync(boundary.directory, fs.constants.O_RDONLY | CLOEXEC);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch { /* directory fsync is not available on every supported filesystem */ }
    return written;
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
}

function removeClientTorrent(client, infoHash) {
  return new Promise((resolve, reject) => {
    try {
      const result = client.remove(infoHash, { destroyStore: false }, error => error ? reject(error) : resolve());
      result?.catch?.(reject);
    } catch (error) { reject(error); }
  });
}

/** Reject incorrect HTTP ranges before they enter the piece store. */
class HfWebSeed extends WebConn {
  constructor(url, torrent, identity, signal, fetchImpl, token) {
    super(url, torrent);
    Object.assign(this, { identity, signal, fetchImpl, token });
    this.abort = new AbortController();
  }
  async httpRequest(index, offset, length, callback) {
    if (!this._torrent || this.destroyed) return callback(new Error('HF connection closed.'));
    if (![index, offset, length].every(Number.isSafeInteger) || index < 0 || offset < 0 || length <= 0 || length > PIECE_LENGTH) return callback(new Error('HF requested an invalid piece range.'));
    const start = index * this._torrent.pieceLength + offset;
    const end = start + length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end >= this.identity.size) return callback(new Error('HF requested a range outside the selected file.'));
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        headers: { Range: `bytes=${start}-${end}` },
        token: this.token,
        signal: AbortSignal.any([this.signal, this.abort.signal, AbortSignal.timeout(45_000)]),
      });
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      const contentLength = response.headers.get('content-length');
      if (response.status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== this.identity.size
          || (contentLength !== null && Number(contentLength) !== length)) throw new Error('HF returned an unexpected byte range.');
      if (!response.body) throw new Error('HF returned an empty byte range.');
      const chunks = [];
      let bytes = 0;
      for await (const value of response.body) {
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > length) throw new Error('HF range exceeded its expected size.');
        chunks.push(chunk);
      }
      if (bytes !== length) throw new Error('HF range was incomplete.');
      this.lastSuccess = Date.now();
      callback(null, Buffer.concat(chunks, bytes));
    } catch (error) {
      try { await response?.body?.cancel(); } catch {}
      callback(error);
    }
  }
  destroy() { this.abort?.abort(); super.destroy(); }
}

async function openCompletedFile(file, boundary, expectedSize) {
  verifyBoundary(boundary);
  const opened = await openRegularFile(file, 'The completed HF partial file');
  if (opened.identity.size !== expectedSize) {
    await opened.handle.close();
    throw new Error('The completed HF partial file has the wrong size.');
  }
  verifyBoundary(boundary);
  return opened;
}

async function publishCompleted(file, dest, opened, boundary) {
  await verifyOpenFile(opened.handle, file, opened.identity, 'The completed HF partial file');
  verifyBoundary(boundary);
  ensureAbsent(dest, 'The HF destination');
  let linked = false;
  let sourceRemoved = false;
  try {
    fs.linkSync(file, dest); // atomic no-replace publication: EEXIST preserves the partial
    linked = true;
    const published = validateRegularFile(fs.lstatSync(dest), 'The completed HF file', { links: 2 });
    if (!sameObject(opened.identity, published) || published.size !== opened.identity.size) throw boundaryError('The completed HF file changed during publication.');
    verifyBoundary(boundary);
    fs.unlinkSync(file);
    sourceRemoved = true;
    const final = validateRegularFile(fs.lstatSync(dest), 'The completed HF file');
    const held = validateRegularFile(await opened.handle.stat(), 'The completed HF file');
    if (!sameObject(opened.identity, final) || !sameObject(held, final) || final.size !== opened.identity.size) throw boundaryError('The completed HF file changed during finalization.');
    verifyBoundary(boundary);
  } catch (error) {
    if (linked && !sourceRemoved) {
      try { const current = fs.lstatSync(dest); if (sameObject(opened.identity, current)) fs.unlinkSync(dest); } catch {}
    }
    throw error;
  }
}

/** A single WebTorrent scheduler owns each partial file. Metadata comes only
 * through authenticated Spark control, or a previously saved manifest. */
export async function downloadHybrid({ identity: identityValue, plan: planValue, dest: requestedDest, approvedRoot,
  client, signal, token, onProgress = () => {}, fetchImpl = hfFetchRange,
  idleTimeout = 120_000, checkpointMs = 5000, approvePeers }) {
  const identity = validateIdentity(identityValue);
  if (!signal || typeof signal.throwIfAborted !== 'function') throw new Error('HF hybrid download requires a cancellation signal.');
  if (!client || typeof client.add !== 'function' || typeof client.get !== 'function') throw new Error('HF hybrid download requires a torrent client.');
  if (typeof fetchImpl !== 'function' || typeof onProgress !== 'function') throw new Error('HF hybrid download callbacks are invalid.');
  if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 100 || idleTimeout > 10 * 60_000
      || !Number.isSafeInteger(checkpointMs) || checkpointMs < 50 || checkpointMs > 60_000) throw new Error('HF hybrid download timing is invalid.');
  signal.throwIfAborted();
  const planned = planValue === null || planValue === undefined ? null : validatePlan(planValue, identity);
  const plannedParsed = planned ? await validateHybridManifest(planned.metadata, identity) : null;
  if (planned?.peers.length) {
    if (typeof approvePeers !== 'function') throw new Error('HF device peer connections require explicit approval.');
    const approved = await approvePeers(peerApprovalRequest(identity, planned, plannedParsed));
    if (approved !== true) throw new Error('HF device peer connections were not approved.');
    signal.throwIfAborted();
  }
  const boundary = prepareBoundary(approvedRoot, requestedDest);
  const dest = boundary.dest;
  const activeKey = process.platform === 'win32' ? dest.toLowerCase() : dest;
  ensureAbsent(dest, 'The HF destination');
  if (active.has(activeKey)) throw new Error('This file is already downloading.');
  active.add(activeKey);
  const key = identityKey(identity);
  const fileName = path.basename(identity.filePath);
  const file = path.join(boundary.dataDirectory, fileName);
  const manifestFile = path.join(boundary.directory, 'manifest.json');
  let torrent;
  let timer;
  let webSeed;
  let checkpoint;
  let manifestIdentity;
  let lastBytes = -1;
  let lastActivity = Date.now();
  let slowTailSince = 0;
  let tailHandoff = 0;
  let hfBytes = 0;
  let peerBytes = 0;
  let initialBytes = 0;
  try {
    verifyLayout(boundary, fileName);
    const savedRead = readSavedManifest(manifestFile, boundary);
    const saved = savedRead ? validateSaved(savedRead.value, identity) : null;
    manifestIdentity = savedRead?.identity;
    if (!saved && !planned) throw new Error('No verified HF peer manifest is available for this download.');
    if (!saved && optionalRegularFile(file, 'The HF partial data file')) throw boundaryError('HF partial data has no verified resume manifest.');
    const savedParsed = saved ? await validateHybridManifest(saved.metadataBytes, identity) : null;
    if (savedParsed && saved.infoHash !== savedParsed.infoHash) throw new Error('The saved HF partial manifest has the wrong torrent identity.');
    if (savedParsed && plannedParsed && savedParsed.infoHash !== plannedParsed.infoHash) throw new Error('The HF peer manifest changed.');
    const parsed = plannedParsed || savedParsed;
    const metadata = planned?.metadata || saved.metadataBytes;
    const peerAddresses = planned?.peers || [];
    if (await client.get(parsed.infoHash)) throw new Error('This exact file already has an active transfer.');
    hfBytes = saved?.hfBytes || 0;
    peerBytes = saved?.peerBytes || 0;
    checkpoint = () => {
      manifestIdentity = writeManifest(manifestFile, {
        schemaVersion: 1, key, infoHash: parsed.infoHash, metadata: metadata.toString('base64'), hfBytes, peerBytes,
      }, boundary, manifestIdentity);
    };
    checkpoint();
    verifyLayout(boundary, fileName);
    torrent = client.add(metadata, {
      path: boundary.dataDirectory, store: SafeTorrentStore, storeOpts: { approvedRoot: boundary.dataDirectory, allowExisting: !!saved },
      private: true, announce: [], urlList: [], uploads: false, strategy: 'rarest', maxWebConns: 2,
    });
    usePairedDiscovery(torrent);
    torrent._hfHybrid = true;
    torrent.on('wire', wire => {
      wire.unchoke = () => {};
      wire.piece = () => {};
      wire.choke();
      wire.on('download', bytes => {
        if (!Number.isSafeInteger(bytes) || bytes < 0) return;
        if (wire.type === 'webSeed') hfBytes = Math.min(MAX_HYBRID_COUNTER_BYTES, hfBytes + bytes);
        else peerBytes = Math.min(MAX_HYBRID_COUNTER_BYTES, peerBytes + bytes);
      });
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        torrent.off('error', fail);
        torrent.off('close', closed);
        client.off?.('error', fail);
        client.off?.('close', closed);
        callback(value);
      };
      const abort = () => finish(reject, signal.reason || Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }));
      const fail = error => finish(reject, error);
      const closed = () => finish(reject, new Error('The torrent client closed before the HF download was ready.'));
      signal.addEventListener('abort', abort, { once: true });
      torrent.once('error', fail);
      torrent.once('close', closed);
      client.once?.('error', fail);
      client.once?.('close', closed);
      torrent.once('ready', () => finish(resolve));
      if (signal.aborted) abort();
      else if (torrent.destroyed || client.destroyed) closed();
    });
    initialBytes = torrent.downloaded;
    const report = phase => onProgress({
      phase, downloaded: torrent.downloaded, total: identity.size, speedBps: torrent.downloadSpeed,
      etaMs: torrent.timeRemaining || 0, hfBytes, peerBytes,
      peerCount: torrent.wires.filter(wire => wire.type !== 'webSeed' && !wire.destroyed).length,
      resumedBytes: initialBytes, sourceMode: 'hybrid',
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearInterval(timer);
        signal.removeEventListener('abort', abort);
        torrent.off('error', fail);
        torrent.off('close', closed);
        torrent.off('done', done);
        client.off?.('error', fail);
        client.off?.('close', closed);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const abort = () => finish(reject, signal.reason || Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }));
      const fail = error => finish(reject, error);
      const closed = () => finish(reject, new Error('The torrent client closed during the HF download.'));
      const done = () => { try { checkpoint(); finish(resolve); } catch (error) { finish(reject, error); } };
      signal.addEventListener('abort', abort, { once: true });
      torrent.once('error', fail);
      torrent.once('close', closed);
      torrent.once('done', done);
      client.once?.('error', fail);
      client.once?.('close', closed);
      let lastCheckpoint = Date.now();
      timer = setInterval(() => {
        try {
          if (torrent.downloaded !== lastBytes) { lastBytes = torrent.downloaded; lastActivity = Date.now(); }
          const remaining = identity.size - torrent.downloaded;
          const slowTail = remaining > 0 && remaining <= torrent.pieceLength * 2 && torrent.downloadSpeed < 256 * 1024;
          if (!slowTail) slowTailSince = 0;
          else if (!slowTailSince) slowTailSince = Date.now();
          if (!tailHandoff && slowTailSince && Date.now() - slowTailSince >= 8000 && webSeed?.lastSuccess > Date.now() - 60_000) {
            tailHandoff = Date.now();
            for (const wire of [...torrent.wires]) if (wire.type !== 'webSeed') torrent.removePeer(`${wire.remoteAddress}:${wire.remotePort}`);
          }
          if (tailHandoff > 0 && Date.now() - tailHandoff >= 15_000) {
            for (const address of peerAddresses) torrent.addPairedPeer(address);
            tailHandoff = -1;
          }
          if (Date.now() - lastActivity > idleTimeout) throw new Error('HF and Spark stopped responding. Resume when the connection returns.');
          if (Date.now() - lastCheckpoint >= checkpointMs) { checkpoint(); lastCheckpoint = Date.now(); }
          report('downloading');
        } catch (error) { finish(reject, error); }
      }, 500);
      timer.unref();
      torrent._hybridCleanup = cleanup;
      if (signal.aborted) abort();
      else if (torrent.destroyed || client.destroyed) closed();
      else if (torrent.done) done();
      else {
        for (const address of peerAddresses) torrent.addPairedPeer(address);
        const url = `https://huggingface.co/${enc(identity.repoId)}/resolve/${identity.revision}/${enc(identity.filePath)}`;
        webSeed = new HfWebSeed(url, torrent, identity, signal, fetchImpl, token);
        torrent.addWebSeed(webSeed);
      }
    });
    torrent._hybridCleanup?.();
    onProgress({ phase: 'verifying', downloaded: identity.size, total: identity.size, speedBps: 0,
      hfBytes, peerBytes, resumedBytes: initialBytes, sourceMode: 'hybrid' });
    await removeClientTorrent(client, torrent.infoHash);
    torrent = null;
    signal.throwIfAborted();
    verifyLayout(boundary, fileName, { allowMissingData: false });
    const opened = await openCompletedFile(file, boundary, identity.size);
    try {
      if (await hashHandle(opened.handle, signal) !== identity.sha256) throw new Error('Downloaded bytes do not match HuggingFace. The file was not added to My Models.');
      signal.throwIfAborted();
      await publishCompleted(file, dest, opened, boundary);
    } finally { await opened.handle.close(); }
    const currentManifest = optionalRegularFile(manifestFile, 'The saved HF partial manifest');
    if (!manifestIdentity || !currentManifest || !sameObject(manifestIdentity, currentManifest)) throw boundaryError('The saved HF partial manifest changed before cleanup.');
    verifyBoundary(boundary);
    fs.unlinkSync(manifestFile);
    fs.rmdirSync(boundary.dataDirectory);
    fs.rmdirSync(boundary.directory);
    sameDirectory(boundary.parent, boundary.parentStat, 'The HF destination folder');
    checkpoint = null;
    return { bytes: identity.size, hfBytes, peerBytes, resumedBytes: initialBytes, sourceMode: 'hybrid' };
  } finally {
    clearInterval(timer);
    webSeed?.destroy();
    try {
      if (torrent) {
        try { checkpoint?.(); }
        finally {
          torrent._hybridCleanup?.();
          if (await client.get(torrent.infoHash)) await removeClientTorrent(client, torrent.infoHash);
        }
      }
    } finally { active.delete(activeKey); }
  }
}
