/**
 * Frost/Byte torrent engine.
 *
 * Thin, testable wrapper over WebTorrent. Everything the app does with
 * peers goes through here: seeding a folder you already have, pulling a
 * model from someone else, and handing out magnet links so your box can
 * share what it's holding.
 *
 * Deliberately has no Electron imports so it can run in plain Node and be
 * tested headlessly (see scripts/test-engine.js).
 */
import WebTorrent from 'webtorrent';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { Address4, Address6 } from 'ip-address';
import { validContentKind } from '../shared/content-kind.js';
import createTorrent from 'create-torrent';
import { isJunk } from 'junk';
import parseTorrent, { toTorrentFile } from 'parse-torrent';
import SafeTorrentStore, {
  MAX_TORRENT_FILES,
  MAX_TORRENT_METADATA_BYTES,
  MAX_TORRENT_PATH_BYTES,
  MAX_TORRENT_PIECE_BYTES,
  MAX_TORRENT_TOTAL_PATH_BYTES,
  MAX_TORRENT_TOTAL_BYTES,
  validateLocalStorageRoot,
  validateTorrentFiles,
  validateTorrentLayout,
  validateTorrentMetadataBytes,
  validateTorrentPieceFanout,
} from './safe-torrent-store.js';
import { acquireTorrentDescriptor, MAX_TORRENT_OPEN_DESCRIPTORS } from './torrent-descriptor-budget.js';

const PEER_ADDRESS_GUARD = Symbol('frostbyte.peerAddressGuard');
const DHT_QUERY_GUARD = Symbol('frostbyte.dhtQueryGuard');
const PAIRED_DISCOVERY = Symbol('frostbyte.pairedDiscovery');
const CONN_POOL_DESTROY_GUARD = Symbol('frostbyte.connPoolDestroyGuard');
const DHT_BOOTSTRAP_HOSTS = new Set([
  'router.bittorrent.com',
  'router.utorrent.com',
  'dht.transmissionbt.com',
]);
const MAX_MAGNET_BYTES = 8 * 1024;
const MAX_SESSION_TEXT_BYTES = 1024;
const MAX_ENCODED_TORRENT_BYTES = Math.ceil(MAX_TORRENT_METADATA_BYTES / 3) * 4;
export const MAX_TORRENT_SHARE_BYTES = MAX_TORRENT_TOTAL_BYTES;
// A reviewed share holds one descriptor per file plus its root directory. The
// process-wide pool also covers every active download store.
export const MAX_REVIEWED_SHARE_FILES = Math.min(MAX_TORRENT_FILES, Math.max(0, MAX_TORRENT_OPEN_DESCRIPTORS - 1));
const MIN_SHARE_PIECE_BYTES = 16 * 1024;
const MAX_SHARE_PIECE_BYTES = MAX_TORRENT_PIECE_BYTES;
// These counters influence automatic stop-sharing decisions after a restart.
// Keep them well inside JavaScript's exact-integer range and reject edited or
// corrupted state before it reaches WebTorrent.
const MAX_SESSION_SEEDED_MS = 100 * 366 * 24 * 60 * 60 * 1000;
const MAX_SESSION_UPLOADED_BYTES = 1024 ** 5; // 1 PiB; saturation still exceeds any practical ratio goal.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const CLOEXEC = fs.constants.O_CLOEXEC || 0;
const DIRECTORY = fs.constants.O_DIRECTORY || 0;
const DESCRIPTOR_READ_BYTES = 1024 * 1024;
const SESSION_FIELDS = new Set([
  'infohash', 'magnet', 'name', 'path', 'paused', 'explicitShare',
  'inventoryId', 'hfSource', 'kind', 'completionHandled', 'addedAt',
  'torrentFile', 'selectedPaths', 'seededMs', 'uploadedBytes',
]);

function savedCounter(value, field, max) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`Saved torrent ${field} is invalid.`);
  }
  return value;
}

function runtimeCounter(value, max) {
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.floor(value)) : 0;
}

function addCounter(left, right, max) {
  return Math.min(max, runtimeCounter(left, max) + runtimeCounter(right, max));
}

// Torrent file identifiers cross the desktop/Spark boundary. Filesystem paths stay native.
export const torrentFileId = value => String(value).replaceAll('\\', '/');
function nativeTorrentFileId(value) {
  const text = String(value);
  if (path.sep !== '\\' && text.includes('\\')) throw new Error('Shared file names must be portable to Windows.');
  return text.split(path.sep).join('/');
}
/** WebTorrent 3's private flag still enables LAN announcements. HF swarms use
 * only authenticated paired-device addresses, with no discovery transports.
 * Keep this adapter covered when upgrading the locked WebTorrent dependency. */
export function usePairedDiscovery(torrent) {
  if (torrent.discovery) throw new Error('Configure paired discovery before starting the torrent.');
  torrent[PAIRED_DISCOVERY] = true;
  torrent._startDiscovery = () => {
    if (torrent.destroyed || torrent.discovery) return;
    torrent.discovery = { pairedOnly: true, complete() {}, destroy(callback) { callback?.(); } };
  };
}
export function normalizeTorrentSelection(selectedPaths) {
  if (selectedPaths == null) return null;
  if (!Array.isArray(selectedPaths) || !selectedPaths.length) throw new Error('Select at least one file.');
  if (selectedPaths.length > MAX_TORRENT_FILES) throw new Error(`Select no more than ${MAX_TORRENT_FILES} files.`);
  let totalBytes = 0;
  const normalized = selectedPaths.map(value => {
    if (typeof value !== 'string') throw new Error('Invalid selected torrent file.');
    const id = torrentFileId(value);
    if (/^[a-z]:/i.test(id) || id.includes('\0') || id.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Select a relative file from this torrent.');
    const bytes = Buffer.byteLength(id, 'utf8');
    if (bytes > MAX_TORRENT_PATH_BYTES) throw new Error(`A selected torrent path exceeds ${MAX_TORRENT_PATH_BYTES} bytes.`);
    totalBytes += bytes;
    if (totalBytes > MAX_TORRENT_TOTAL_PATH_BYTES) throw new Error('Selected torrent paths exceed the safe metadata limit.');
    return id;
  });
  return [...new Set(normalized)];
}

/** WebTorrent accepts hostnames and every numeric address class returned by a
 * tracker, DHT node, or PEX peer. Only pass literal, globally reachable
 * endpoints to its outgoing TCP/uTP connection queue. */
function parseNumericPeerEndpoint(peer) {
  if (typeof peer !== 'string' || peer.length > 320) return null;
  const match = /^\[([^\]]+)]:(\d+)$/.exec(peer) || /^(.+):(\d+)$/.exec(peer);
  if (!match || match[1].includes('%')) return null;
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const family = isIP(match[1]);
    if (!family) return null;
    const address = family === 6 ? new Address6(match[1]) : new Address4(match[1]);
    return { address, host: match[1], port };
  } catch {
    return null;
  }
}

export function isGloballyRoutablePeerEndpoint(peer) {
  return parseNumericPeerEndpoint(peer)?.address.isGlobal() === true;
}

function isPairedPeerEndpoint(peer, allowLoopback = false) {
  const endpoint = parseNumericPeerEndpoint(peer);
  if (!endpoint) return false;
  const address = endpoint.address;
  if (allowLoopback && address.isLoopback() && (address instanceof Address4 || !address.embeddedIPv4())) return true;
  // Authenticated companions may live on RFC1918/ULA networks, but pairing is
  // not authority to probe the desktop's loopback, link-local services, CGNAT,
  // or an embedded IPv4 target hidden in IPv6 mapped/NAT64 notation.
  if (address instanceof Address4) return address.isGlobal() || address.isPrivate();
  if (address.embeddedIPv4()) return false;
  return address.isGlobal() || address.isULA();
}

function guardTorrentPeerAddresses(torrent, allowPeerAddresses) {
  if (!torrent || torrent[PEER_ADDRESS_GUARD]) return torrent;
  const addPeer = torrent.addPeer;
  if (typeof addPeer !== 'function') throw new Error('WebTorrent torrent has no peer boundary.');
  torrent.addPeer = function guardedAddPeer(peer, source) {
    if (!allowPeerAddresses && typeof peer === 'string' && !isGloballyRoutablePeerEndpoint(peer)) {
      this.emit('blockedPeer', peer);
      return false;
    }
    return addPeer.call(this, peer, source);
  };
  Object.defineProperty(torrent, 'addPairedPeer', {
    configurable: false,
    enumerable: false,
    writable: false,
    value(peer) {
      if (!this[PAIRED_DISCOVERY] || !isPairedPeerEndpoint(peer, allowPeerAddresses === true)) {
        this.emit('blockedPeer', peer);
        return false;
      }
      return addPeer.call(this, peer, 'manual');
    },
  });
  Object.defineProperty(torrent, PEER_ADDRESS_GUARD, { value: true });
  return torrent;
}

/** Install before adding torrents. WebTorrent emits `add` synchronously and
 * starts parsed-torrent discovery in a later microtask. */
export function guardWebTorrentPeerAddresses(client, { allowPeerAddresses = false } = {}) {
  if (!client || typeof client.on !== 'function') throw new Error('WebTorrent client is required.');
  const guard = torrent => guardTorrentPeerAddresses(torrent, allowPeerAddresses === true);
  client.on('add', guard);
  for (const torrent of client.torrents ?? []) guard(torrent);
  return client;
}

/** k-rpc queries compact nodes directly over UDP, below Torrent.addPeer.
 * Guard that last outbound hop too; approved bootstrap DNS recurses through
 * this wrapper and the resolved numeric address is checked independently. */
export function guardWebTorrentDhtQueries(client, { allowPeerAddresses = false } = {}) {
  const socket = client?.dht?._rpc?.socket;
  if (!socket || typeof socket.query !== 'function' || socket[DHT_QUERY_GUARD]) return client;
  const query = socket.query;
  socket.query = function guardedDhtQuery(peer, message, callback) {
    const host = typeof peer?.address === 'string' ? peer.address : peer?.host;
    const port = peer?.port;
    const family = typeof host === 'string' ? isIP(host) : 0;
    const endpoint = family === 6 ? `[${host}]:${port}` : `${host}:${port}`;
    const allowed = family
      ? (allowPeerAddresses === true
          ? Number.isSafeInteger(port) && port > 0 && port <= 65535
          : isGloballyRoutablePeerEndpoint(endpoint))
      : typeof host === 'string' && DHT_BOOTSTRAP_HOSTS.has(host) && Number.isSafeInteger(port) && port > 0 && port <= 65535;
    if (allowed) return query.call(this, peer, message, callback);
    const error = Object.assign(new Error('Blocked a non-public DHT query target.'), { code: 'FROSTBYTE_DHT_BOUNDARY' });
    if (typeof callback === 'function') queueMicrotask(() => callback(error, null, peer));
    return null;
  };
  Object.defineProperty(socket, DHT_QUERY_GUARD, { value: true });
  return client;
}

/** WebTorrent 3.0.21 passes one run-parallel task callback to both peer
 * servers. With uTP enabled, the second server can therefore finish the whole
 * client shutdown while torrent stores are still closing. Make that task
 * callback at-most-once so the other client tasks retain their shutdown
 * boundary even when TCP and uTP finish independently. */
function guardWebTorrentConnPoolDestroy(client) {
  const pool = client?._connPool;
  if (!pool || pool[CONN_POOL_DESTROY_GUARD]) return client;
  const destroy = pool.destroy;
  if (typeof destroy !== 'function') throw new Error('WebTorrent connection pool has no shutdown boundary.');
  pool.destroy = function destroyWithOneCompletion(callback) {
    if (typeof callback !== 'function') return destroy.call(this, callback);
    let completed = false;
    return destroy.call(this, (...args) => {
      if (completed) return;
      completed = true;
      callback(...args);
    });
  };
  Object.defineProperty(pool, CONN_POOL_DESTROY_GUARD, { value: true });
  return client;
}

function protectedStore(root, allowExisting = false, selectedPaths = null) {
  return {
    store: SafeTorrentStore,
    storeOpts: {
      approvedRoot: validateLocalStorageRoot(root),
      allowExisting: allowExisting === true,
      // Passed through to the store so layout limits are evaluated against the
      // files that will actually be transferred, not the whole torrent.
      ...(Array.isArray(selectedPaths) && selectedPaths.length ? { selectedPaths } : {}),
    },
  };
}

function rejectExistingTorrentTargets(root, files) {
  for (const file of files) {
    const target = path.resolve(root, file.path);
    try {
      fs.lstatSync(target);
      throw new Error('A torrent file already exists in this download folder. Move it or resume the saved transfer.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function validateShareRoot(input) {
  let stat;
  try { stat = fs.lstatSync(input); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Nothing at ${input}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('Symbolic links cannot be shared. Choose the actual file or folder instead.');
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('Only regular files and folders can be shared.');
  if (stat.isFile() && stat.nlink > 1) throw new Error('Hard-linked files cannot be shared. Choose an independent copy instead.');
  return stat;
}

function shareBoundaryError(message) {
  return Object.assign(new Error(message), { code: 'FROSTBYTE_SHARE_BOUNDARY' });
}

function sameFileObject(left, right) {
  if (!left || !right) return false;
  // Windows exposes stable file indexes as ino on supported local filesystems.
  // On filesystems without them, fail closed rather than inventing an identity
  // from a pathname or timestamp that an attacker can reproduce.
  if (Number(left.ino) && Number(right.ino)) return left.dev === right.dev && left.ino === right.ino;
  return false;
}

function beneath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function closeDescriptor(fd, permit = null) {
  if (fd === null || fd === undefined) { permit?.release(); return null; }
  try { fs.closeSync(fd); permit?.release(); return null; }
  catch (error) { return error; }
}

function lstatSharePath(target, missingMessage) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error.code === 'ENOENT') throw shareBoundaryError(missingMessage);
    throw error;
  }
}

function assertDirectoryPath(snapshot, rootReal) {
  const linked = lstatSharePath(snapshot.path, 'A shared folder disappeared while it was being reviewed.');
  if (linked.isSymbolicLink() || !linked.isDirectory() || !sameFileObject(snapshot, linked)) {
    throw shareBoundaryError('A shared folder changed while it was being reviewed. Refresh and try again.');
  }
  const actual = fs.realpathSync(snapshot.path);
  if (!beneath(rootReal, actual)) throw shareBoundaryError('A shared folder escaped the selected item.');
}

function reviewDirectory(directory, rootReal, { hold = false } = {}) {
  const linked = lstatSharePath(directory, 'A shared folder disappeared while it was being reviewed.');
  if (linked.isSymbolicLink()) throw shareBoundaryError('Symbolic links cannot be shared. Choose the actual file or folder instead.');
  if (!linked.isDirectory()) throw shareBoundaryError('Only regular files and folders can be shared.');
  const actual = fs.realpathSync(directory);
  if (!beneath(rootReal, actual)) throw shareBoundaryError('A shared folder escaped the selected item.');

  let fd = null;
  let permit = null;
  try {
    permit = acquireTorrentDescriptor();
    fd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC);
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(directory);
    if (!opened.isDirectory() || after.isSymbolicLink() || !after.isDirectory()
        || !sameFileObject(linked, opened) || !sameFileObject(opened, after)) {
      throw shareBoundaryError('A shared folder changed while it was being opened. Refresh and try again.');
    }
    const snapshot = {
      path: directory, realpath: actual, dev: opened.dev, ino: opened.ino,
      fd: hold ? fd : null, permit: hold ? permit : null,
    };
    if (!hold) {
      const closeError = closeDescriptor(fd, permit);
      fd = null;
      permit = null;
      if (closeError) throw closeError;
    }
    return snapshot;
  } catch (error) {
    const closeError = closeDescriptor(fd, permit);
    fd = null;
    permit = null;
    // Node cannot open directory handles on some Windows filesystems. Keep the
    // double-checked object identity there; file bytes are still opened through
    // their own non-following descriptors below.
    if (process.platform === 'win32' && ['EACCES', 'EISDIR', 'EPERM', 'EINVAL'].includes(error.code)) {
      const after = fs.lstatSync(directory);
      if (!after.isSymbolicLink() && after.isDirectory() && sameFileObject(linked, after)) {
        return { path: directory, realpath: actual, dev: after.dev, ino: after.ino, fd: null, permit: null };
      }
    }
    if (closeError) throw new AggregateError([error, closeError], 'A shared folder could not be reviewed or closed safely.');
    throw error;
  }
}

function reviewFile(target, rootReal, expectedSize, ancestors = []) {
  for (const ancestor of ancestors) assertDirectoryPath(ancestor, rootReal);
  const linked = lstatSharePath(target, 'A shared file is missing. Refresh before sharing.');
  if (linked.isSymbolicLink()) throw shareBoundaryError('Linked files cannot be shared. Choose the actual file instead.');
  if (!linked.isFile() || linked.nlink !== 1) throw shareBoundaryError('Hard-linked or special files cannot be shared. Choose an independent regular file.');
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || linked.size !== expectedSize)) {
    throw shareBoundaryError('A downloaded file is missing, linked, or changed. Refresh before sharing.');
  }
  const actual = fs.realpathSync(target);
  if (!beneath(rootReal, actual)) throw shareBoundaryError('Shared files must belong to this item.');

  let fd = null;
  let permit = null;
  try {
    permit = acquireTorrentDescriptor();
    fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW | CLOEXEC);
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(target);
    if (!opened.isFile() || opened.nlink !== 1 || after.isSymbolicLink() || !after.isFile() || after.nlink !== 1
        || !sameFileObject(linked, opened) || !sameFileObject(opened, after) || opened.size !== linked.size) {
      throw shareBoundaryError('A shared file changed while it was being opened. Refresh and try again.');
    }
    for (const ancestor of ancestors) assertDirectoryPath(ancestor, rootReal);
    return {
      sourcePath: target, realpath: actual, fd, permit, dev: opened.dev, ino: opened.ino,
      length: opened.size, ancestors: [...ancestors],
    };
  } catch (error) {
    const closeError = closeDescriptor(fd, permit);
    if (closeError) throw new AggregateError([error, closeError], 'A shared file could not be reviewed or closed safely.');
    throw error;
  }
}

function verifyReviewedFile(entry) {
  const opened = fs.fstatSync(entry.fd);
  if (!opened.isFile() || opened.nlink !== 1 || opened.size !== entry.length
      || (Number(entry.ino) && !sameFileObject(entry, opened))) {
    throw shareBoundaryError('A reviewed shared file changed. Stop sharing it and review the file again.');
  }
}

class ReviewedShareLease {
  constructor({ root, files, name, multiFile, expectedDataPath }) {
    this.root = root;
    this.files = files;
    this.name = name;
    this.multiFile = multiFile;
    this.expectedDataPath = expectedDataPath;
    this.closed = false;
    this.claimed = false;
    this.hashes = null;
    this.onClose = null;
  }

  summary() {
    return Object.freeze({ root: this.root.path, files: this.files.length, bytes: this.files.reduce((sum, file) => sum + file.length, 0) });
  }

  bindMetadata(parsed) {
    if (this.closed) throw shareBoundaryError('The reviewed share was closed before it could start.');
    const files = validateTorrentLayout(parsed);
    if (files.length !== this.files.length || files.some((file, index) => {
      const reviewed = this.files[index];
      return torrentFileId(file.path) !== reviewed.torrentPath || file.length !== reviewed.length;
    })) throw shareBoundaryError('Generated torrent metadata does not match the reviewed files.');
    this.hashes = [...parsed.pieces];
  }

  claim(files) {
    if (this.closed || this.claimed || !this.hashes) throw shareBoundaryError('The reviewed share descriptor lease is unavailable.');
    const described = validateTorrentFiles(files);
    if (described.length !== this.files.length || described.some((file, index) => {
      const reviewed = this.files[index];
      return torrentFileId(file.path) !== reviewed.torrentPath || file.length !== reviewed.length || file.offset !== reviewed.offset;
    })) throw shareBoundaryError('Torrent storage does not match the reviewed file descriptors.');
    this.claimed = true;
    return this.files;
  }

  verifyRoot() {
    if (this.closed) throw new Error('Storage is closed');
    if (this.root.fd !== null) {
      const opened = fs.fstatSync(this.root.fd);
      if (!opened.isDirectory() || (Number(this.root.ino) && !sameFileObject(this.root, opened))) {
        throw shareBoundaryError('The reviewed share root changed.');
      }
    }
  }

  verifyFile(entry) {
    this.verifyRoot();
    verifyReviewedFile(entry);
  }

  async read(entry, position, length) {
    this.verifyFile(entry);
    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = await new Promise((resolve, reject) => {
        fs.read(entry.fd, result, offset, length - offset, position + offset, (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
      });
      if (!read) throw shareBoundaryError('A reviewed shared file became shorter while it was being read.');
      offset += read;
    }
    this.verifyFile(entry);
    return result;
  }

  stream(entry) {
    const lease = this;
    const stream = Readable.from((async function* () {
      let position = 0;
      while (position < entry.length) {
        const length = Math.min(DESCRIPTOR_READ_BYTES, entry.length - position);
        yield await lease.read(entry, position, length);
        position += length;
      }
      lease.verifyFile(entry);
    })());
    stream.name = entry.torrentPath;
    return stream;
  }

  currentDataPath() {
    try {
      assertDirectoryPath(this.root, this.root.realpath);
      if (this.multiFile) return sameFileObject(this.root, fs.lstatSync(this.expectedDataPath)) ? this.expectedDataPath : null;
      const entry = this.files[0], linked = fs.lstatSync(entry.sourcePath);
      return !linked.isSymbolicLink() && linked.isFile() && linked.nlink === 1 && sameFileObject(entry, linked) ? this.expectedDataPath : null;
    } catch { return null; }
  }

  close(callback) {
    let error;
    try { this.closeNow(); } catch (caught) { error = caught; }
    queueMicrotask(() => callback?.(error));
  }

  closeNow() {
    if (this.closed) return;
    this.closed = true;
    const errors = [];
    for (const file of this.files) {
      const error = closeDescriptor(file.fd, file.permit);
      file.fd = null;
      file.permit = null;
      if (error) errors.push(error);
    }
    const rootError = closeDescriptor(this.root.fd, this.root.permit);
    this.root.fd = null;
    this.root.permit = null;
    if (rootError) errors.push(rootError);
    try { this.onClose?.(); } catch (error) { errors.push(error); }
    const error = errors.length > 1 ? new AggregateError(errors, 'Reviewed share descriptors could not all be closed.') : errors[0];
    if (error) throw error;
  }
}

class ReviewedDescriptorStore {
  constructor(chunkLength, opts = {}) {
    if (!Number.isSafeInteger(chunkLength) || chunkLength <= 0 || chunkLength > MAX_TORRENT_PIECE_BYTES) {
      throw shareBoundaryError('The reviewed share has an invalid piece size.');
    }
    this.chunkLength = chunkLength;
    this.lease = opts.reviewedShareLease;
    this.files = this.lease.claim(opts.files);
    this.length = this.files.reduce((sum, file) => sum + file.length, 0);
    if (opts.length !== this.length) throw shareBoundaryError('The reviewed share length changed.');
    this.lastChunkIndex = Math.ceil(this.length / this.chunkLength) - 1;
    this.lastChunkLength = (this.length % this.chunkLength) || this.chunkLength;
    this.closed = false;
    this.pending = new Map();
  }

  async _piece(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.lastChunkIndex) throw new Error('Invalid chunk index');
    const start = index * this.chunkLength;
    const length = index === this.lastChunkIndex ? this.lastChunkLength : this.chunkLength;
    const buffers = [];
    for (const file of this.files) {
      const from = Math.max(start, file.offset);
      const to = Math.min(start + length, file.offset + file.length);
      if (to > from) buffers.push(await this.lease.read(file, from - file.offset, to - from));
    }
    const piece = Buffer.concat(buffers);
    const expected = this.lease.hashes[index];
    if (piece.length !== length || crypto.createHash('sha1').update(piece).digest('hex') !== expected) {
      throw shareBoundaryError('A shared file changed after review. Stop sharing it and review the current bytes.');
    }
    return piece;
  }

  get(index, opts, callback) {
    if (typeof opts === 'function') return this.get(index, null, opts);
    if (this.closed) { queueMicrotask(() => callback(new Error('Storage is closed'))); return; }
    let pending = this.pending.get(index);
    if (!pending) {
      pending = this._piece(index).finally(() => this.pending.delete(index));
      this.pending.set(index, pending);
    }
    pending.then(piece => {
      const offset = opts?.offset ?? 0;
      const length = opts?.length ?? piece.length - offset;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > piece.length) {
        throw new Error('Invalid offset and/or length');
      }
      return piece.subarray(offset, offset + length);
    }).then(value => callback(null, value), callback);
  }

  put(_index, _value, callback) {
    queueMicrotask(() => callback?.(shareBoundaryError('Reviewed local shares are read-only.')));
  }

  close(callback) {
    if (this.closed) { queueMicrotask(() => callback?.()); return; }
    this.closed = true;
    this.lease.close(callback);
  }

  destroy(callback) { this.close(callback); }
}

function addShareBytes(total, length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('The selected share contains an invalid file size.');
  if (length > MAX_TORRENT_SHARE_BYTES - total) throw new Error('Shares larger than 1 TiB are not supported. Choose a smaller item.');
  return total + length;
}

function seedTrackers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('Choose no more than 8 approved trackers.');
  const result = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || entry.length > 2048 || /[\0\r\n]/.test(entry)) throw new Error('An approved tracker URL is invalid.');
    let url;
    try { url = new URL(entry); } catch { throw new Error('An approved tracker URL is invalid.'); }
    if (!['http:', 'https:', 'udp:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('An approved tracker URL is invalid.');
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

/** Avoid piece-length's 32-bit shift wrap while keeping hashing memory bounded. */
export function torrentSharePieceLength(totalBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_TORRENT_SHARE_BYTES) {
    throw new Error('Shares larger than 1 TiB are not supported. Choose a smaller item.');
  }
  const desired = Math.max(MIN_SHARE_PIECE_BYTES, Math.ceil(totalBytes / 1024));
  let pieceLength = MIN_SHARE_PIECE_BYTES;
  while (pieceLength < desired && pieceLength < MAX_SHARE_PIECE_BYTES) pieceLength *= 2;
  return Math.min(pieceLength, MAX_SHARE_PIECE_BYTES);
}

function portableSort(left, right) {
  return left.torrentPath < right.torrentPath ? -1 : left.torrentPath > right.torrentPath ? 1 : 0;
}

function reviewedAncestors(boundary, parent, directories) {
  const result = [directories.get(boundary)];
  const relative = path.relative(boundary, parent);
  let current = boundary;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    result.push(directories.get(current));
  }
  if (result.some(value => !value)) throw shareBoundaryError('A shared file has an unreviewed ancestor folder.');
  return result;
}

function finalizeReviewedLease(config) {
  config.files.sort(portableSort);
  let totalBytes = 0;
  for (const file of config.files) {
    file.offset = totalBytes;
    totalBytes = addShareBytes(totalBytes, file.length);
  }
  validateTorrentFiles(config.files.map(file => ({ path: file.torrentPath, length: file.length })));
  const lease = new ReviewedShareLease(config);
  lease.totalBytes = totalBytes;
  return lease;
}

function reviewOrdinaryShare(input) {
  const selected = path.resolve(input);
  const selectedStat = validateShareRoot(selected);
  const multiFile = selectedStat.isDirectory();
  const boundary = multiFile ? selected : path.dirname(selected);
  const rootReal = fs.realpathSync(boundary);
  let root = null;
  const openedFiles = [];
  try {
    root = reviewDirectory(boundary, rootReal, { hold: true });
    if (!multiFile) {
      const file = reviewFile(selected, rootReal, undefined, [root]);
      file.torrentPath = nativeTorrentFileId(path.basename(selected));
      file.metadataPath = file.torrentPath;
      openedFiles.push(file);
      assertDirectoryPath(root, rootReal);
      return finalizeReviewedLease({ root, files: openedFiles, name: file.torrentPath, multiFile: false, expectedDataPath: selected });
    }

    const rootName = nativeTorrentFileId(path.basename(selected));
    const directories = new Map([[selected, root]]);
    const pending = [{ target: selected, include: true }];
    let nodes = 0;
    while (pending.length) {
      const { target: current, include } = pending.pop();
      if (++nodes > MAX_TORRENT_FILES * 4) throw new Error('The selected share contains too many folders or files.');
      for (const name of fs.readdirSync(current).sort()) {
        if (++nodes > MAX_TORRENT_FILES * 4) throw new Error('The selected share contains too many folders or files.');
        const target = path.join(current, name);
        const linked = lstatSharePath(target, `Nothing at ${selected}`);
        if (linked.isSymbolicLink()) throw shareBoundaryError('Symbolic links cannot be shared. Choose the actual file or folder instead.');
        const childIncluded = include && name[0] !== '.' && !isJunk(name);
        if (linked.isDirectory()) {
          const snapshot = reviewDirectory(target, rootReal);
          directories.set(target, snapshot);
          pending.push({ target, include: childIncluded });
          continue;
        }
        if (!linked.isFile()) throw shareBoundaryError('Only regular files and folders can be shared.');
        if (linked.nlink !== 1) throw shareBoundaryError('Hard-linked files cannot be shared. Choose an independent copy instead.');
        if (!childIncluded) continue;
        if (openedFiles.length >= MAX_REVIEWED_SHARE_FILES) {
          throw new Error(`Share no more than ${MAX_REVIEWED_SHARE_FILES} files at once.`);
        }
        const file = reviewFile(target, rootReal, undefined, reviewedAncestors(selected, path.dirname(target), directories));
        const relative = nativeTorrentFileId(path.relative(selected, target));
        file.torrentPath = `${rootName}/${relative}`;
        file.metadataPath = relative;
        openedFiles.push(file);
      }
    }
    for (const directory of directories.values()) assertDirectoryPath(directory, rootReal);
    for (const file of openedFiles) verifyReviewedFile(file);
    return finalizeReviewedLease({ root, files: openedFiles, name: rootName, multiFile: true, expectedDataPath: selected });
  } catch (error) {
    const errors = [error];
    for (const file of openedFiles) {
      const closeError = closeDescriptor(file.fd, file.permit);
      file.fd = null;
      file.permit = null;
      if (closeError) errors.push(closeError);
    }
    const rootError = closeDescriptor(root?.fd, root?.permit);
    if (root) { root.fd = null; root.permit = null; }
    if (rootError) errors.push(rootError);
    if (errors.length > 1) throw new AggregateError(errors, 'The selected share could not be reviewed or closed safely.');
    throw error;
  }
}

function reviewInventoryShare(input, requestedFiles) {
  const selected = path.resolve(input);
  const selectedStat = validateShareRoot(selected);
  if (!Array.isArray(requestedFiles) || !requestedFiles.length) throw new Error('No downloaded files to share.');
  if (requestedFiles.length > MAX_TORRENT_FILES) throw new Error(`Share no more than ${MAX_TORRENT_FILES} downloaded files at once.`);
  if (requestedFiles.length > MAX_REVIEWED_SHARE_FILES) throw new Error(`Share no more than ${MAX_REVIEWED_SHARE_FILES} files at once.`);
  const boundary = selectedStat.isDirectory() ? selected : path.dirname(selected);
  const rootReal = fs.realpathSync(boundary);
  let root = null;
  const openedFiles = [];
  try {
    root = reviewDirectory(boundary, rootReal, { hold: true });
    const directories = new Map([[boundary, root]]);
    for (const requested of requestedFiles) {
      if (!requested || typeof requested !== 'object' || typeof requested.path !== 'string') {
        throw new Error('A downloaded file is missing, linked, or changed. Refresh before sharing.');
      }
      const target = path.resolve(requested.path);
      const relative = path.relative(selected, target);
      if (selectedStat.isFile()
        ? target !== selected
        : path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw shareBoundaryError('Shared files must belong to this item.');
      }
      let current = boundary;
      const parentRelative = path.relative(boundary, path.dirname(target));
      for (const part of parentRelative ? parentRelative.split(path.sep) : []) {
        current = path.join(current, part);
        if (!directories.has(current)) directories.set(current, reviewDirectory(current, rootReal));
      }
      const file = reviewFile(target, rootReal, requested.size, reviewedAncestors(boundary, path.dirname(target), directories));
      file.itemRelative = selectedStat.isDirectory() ? nativeTorrentFileId(relative) : nativeTorrentFileId(path.basename(target));
      openedFiles.push(file);
    }
    if (new Set(openedFiles.map(file => file.sourcePath)).size !== openedFiles.length) throw new Error('Duplicate shared file.');
    const multiFile = openedFiles.length > 1;
    const name = multiFile ? nativeTorrentFileId(path.basename(selected)) : nativeTorrentFileId(path.basename(openedFiles[0].sourcePath));
    for (const file of openedFiles) {
      file.metadataPath = multiFile ? file.itemRelative : name;
      file.torrentPath = multiFile ? `${name}/${file.itemRelative}` : name;
    }
    for (const directory of directories.values()) assertDirectoryPath(directory, rootReal);
    for (const file of openedFiles) verifyReviewedFile(file);
    return finalizeReviewedLease({
      root, files: openedFiles, name, multiFile,
      expectedDataPath: multiFile ? selected : openedFiles[0].sourcePath,
    });
  } catch (error) {
    const errors = [error];
    for (const file of openedFiles) {
      const closeError = closeDescriptor(file.fd, file.permit);
      file.fd = null;
      file.permit = null;
      if (closeError) errors.push(closeError);
    }
    const rootError = closeDescriptor(root?.fd, root?.permit);
    if (root) { root.fd = null; root.permit = null; }
    if (rootError) errors.push(rootError);
    if (errors.length > 1) throw new AggregateError(errors, 'The selected share could not be reviewed or closed safely.');
    throw error;
  }
}

async function rewriteGeneratedShare(metadata, lease) {
  const parsed = await parseTorrent(metadata);
  if (parsed.length !== lease.totalBytes) throw shareBoundaryError('Shared files changed while torrent metadata was being created. Refresh and try again.');
  parsed.info.name = Buffer.from(lease.name);
  if (lease.multiFile) {
    delete parsed.info.length;
    parsed.info.files = lease.files.map(file => ({
      length: file.length,
      path: file.metadataPath.split('/').map(component => Buffer.from(component)),
    }));
  } else {
    delete parsed.info.files;
    parsed.info.length = lease.files[0].length;
  }
  return toTorrentFile({ ...parsed, announce: parsed.announce, urlList: [] });
}

async function validateGeneratedShare(metadata, { pieceLength, totalBytes, exactBytes, announce }) {
  validateTorrentMetadataBytes(metadata);
  const parsed = await parseTorrent(metadata);
  const files = validateTorrentLayout(parsed);
  const describedBytes = files.reduce((total, file) => addShareBytes(total, file.length), 0);
  if (describedBytes !== parsed.length || describedBytes > totalBytes || (exactBytes && describedBytes !== totalBytes)) {
    throw new Error('Shared files changed while torrent metadata was being created. Refresh and try again.');
  }
  if (parsed.pieceLength !== pieceLength || !Array.isArray(parsed.pieces)
      || parsed.pieces.length !== Math.ceil(describedBytes / pieceLength)) {
    throw new Error('Generated torrent piece metadata is invalid.');
  }
  // Rebuild the non-info envelope so create-torrent can never inject its
  // legacy built-in trackers or a web seed. The info dictionary and hash stay
  // unchanged; only the explicit, locally-approved announce list survives.
  const clean = toTorrentFile({ ...parsed, announce, urlList: [] });
  validateTorrentMetadataBytes(clean);
  const verified = await parseTorrent(clean);
  if (verified.infoHash !== parsed.infoHash || verified.urlList.length
      || verified.announce.length !== announce.length || announce.some(value => !verified.announce.includes(value))) {
    throw new Error('Generated torrent discovery metadata is invalid.');
  }
  return clean;
}

function boundedSessionString(value, label, maxBytes = MAX_SESSION_TEXT_BYTES) {
  if (typeof value !== 'string' || !value || value.length > maxBytes || Buffer.byteLength(value, 'utf8') > maxBytes || /[\0\r\n]/.test(value)) {
    throw new Error(`Saved torrent ${label} is invalid or too large.`);
  }
  return value;
}

function decodeSavedTorrentFile(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ENCODED_TORRENT_BYTES ||
      value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new Error('Saved torrent metadata is invalid or too large.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Saved torrent metadata is not valid base64.');
  return validateTorrentMetadataBytes(bytes);
}

function sessionData(record) {
  let keys;
  let descriptors;
  try {
    const prototype = Object.getPrototypeOf(record);
    if (!record || typeof record !== 'object' || Array.isArray(record) || (prototype !== Object.prototype && prototype !== null)) throw new Error();
    keys = Reflect.ownKeys(record);
    descriptors = Object.getOwnPropertyDescriptors(record);
  } catch {
    throw new Error('Saved torrent record must be a plain object.');
  }
  if (keys.length > SESSION_FIELDS.size || keys.some(key => typeof key !== 'string' || !SESSION_FIELDS.has(key))) {
    throw new Error('Saved torrent record contains unsupported fields.');
  }
  for (const key of keys) {
    if (!Object.hasOwn(descriptors[key], 'value')) throw new Error('Saved torrent record cannot contain accessors.');
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

/** Validate persisted state completely before WebTorrent starts discovery or
 * the protected store creates the destination directory. */
export async function validateTorrentSessionRecord(input, { allowPeerAddresses = false } = {}) {
  const record = sessionData(input);
  const infohash = boundedSessionString(record.infohash, 'identity', 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infohash)) throw new Error('Saved torrent identity is invalid.');
  const destination = validateLocalStorageRoot(record.path);

  for (const field of ['paused', 'explicitShare', 'hfSource', 'completionHandled']) {
    if (record[field] !== undefined && typeof record[field] !== 'boolean') throw new Error(`Saved torrent ${field} must be true or false.`);
  }
  if (record.addedAt !== undefined && (!Number.isSafeInteger(record.addedAt) || record.addedAt < 0)) {
    throw new Error('Saved torrent addedAt is invalid.');
  }
  if (record.name !== undefined) boundedSessionString(record.name, 'name');
  if (record.inventoryId !== undefined) boundedSessionString(record.inventoryId, 'inventory ID');
  if (record.kind !== undefined && !validContentKind(record.kind)) throw new Error('Saved torrent content kind is invalid.');
  const selectedPaths = normalizeTorrentSelection(record.selectedPaths);
  const seededMs = savedCounter(record.seededMs, 'seeded time', MAX_SESSION_SEEDED_MS);
  const uploadedBytes = savedCounter(record.uploadedBytes, 'uploaded bytes', MAX_SESSION_UPLOADED_BYTES);

  let magnetSource = null;
  if (record.magnet !== undefined && record.magnet !== null) {
    const magnet = boundedSessionString(record.magnet, 'magnet', MAX_MAGNET_BYTES);
    if (!/^magnet:\?/i.test(magnet) || extractInfoHash(magnet) !== infohash) {
      throw new Error('Saved torrent magnet does not match its identity.');
    }
    magnetSource = await sanitizeTorrentDiscovery(magnet, { allowPeerAddresses });
  }

  let torrentSource = null;
  if (record.torrentFile !== undefined && record.torrentFile !== null) {
    torrentSource = await sanitizeTorrentDiscovery(decodeSavedTorrentFile(record.torrentFile), { allowPeerAddresses });
    const parsed = await parseTorrent(torrentSource);
    if (parsed.infoHash !== infohash) throw new Error('Saved torrent metadata does not match its identity.');
  }
  const source = torrentSource ?? magnetSource;
  if (!source) throw new Error('Saved torrent has no valid magnet or metadata.');

  return {
    infohash,
    source,
    path: destination,
    selectedPaths,
    paused: record.paused ?? false,
    explicitShare: record.explicitShare ?? false,
    inventoryId: record.inventoryId,
    hfSource: record.hfSource ?? false,
    kind: record.kind,
    completionHandled: record.completionHandled ?? false,
    addedAt: record.addedAt,
    seededMs,
    uploadedBytes,
  };
}

/** Strip tracker, web-seed, exact-source, and direct-peer endpoints supplied
 * by public torrent metadata. Discovery endpoints come only from local app
 * settings. Direct peers can be retained only by explicit test engines. */
export async function sanitizeTorrentDiscovery(source, { allowPeerAddresses = false } = {}) {
  const infoHash = extractInfoHash(source);
  if (typeof source === 'string' && infoHash) {
    const params = [`xt=urn:btih:${infoHash}`];
    if (/^magnet:/i.test(source)) {
      try {
        const supplied = new URL(source).searchParams;
        const name = supplied.get('dn');
        if (name && name.length <= 255 && !/[\0\r\n]/.test(name)) params.push(`dn=${encodeURIComponent(name)}`);
        if (allowPeerAddresses) {
          for (const peer of supplied.getAll('x.pe').slice(0, 16)) {
            const match = peer.match(/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):([1-9]\d{0,4})$/i);
            if (peer.length <= 300 && match && Number(match[1]) <= 65535) params.push(`x.pe=${peer}`);
          }
        }
      } catch { /* the infohash above is the only required magnet field */ }
    }
    return `magnet:?${params.join('&')}`;
  }
  const bytes = Buffer.isBuffer(source) || source instanceof Uint8Array ? Buffer.from(source) : null;
  if (!bytes) throw new Error('Choose a torrent or magnet link.');
  validateTorrentMetadataBytes(bytes);
  const parsed = await parseTorrent(bytes);
  validateTorrentLayout(parsed);
  return toTorrentFile({ ...parsed, announce: [], urlList: [] });
}

/** Create metainfo without contacting peers or enabling sharing. Cancellation preserves bytes. */
export async function createShareMetadata(input, { files, signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const lease = files ? reviewInventoryShare(path.resolve(input), files) : reviewOrdinaryShare(path.resolve(input));
  let streams = [], abort;
  try {
    const options = { name: lease.name, announce: [], pieceLength: torrentSharePieceLength(lease.totalBytes), filterJunkFiles: false };
    validateTorrentPieceFanout(lease.files, options.pieceLength);
    let completed = 0;
    const pending = new Promise((resolve, reject) => {
      streams = lease.files.map(file => {
        const stream = Readable.from((async function* () { for await (const chunk of lease.stream(file)) { signal?.throwIfAborted(); completed += chunk.length; onProgress(completed, lease.totalBytes); yield chunk; } })());
        stream.name = file.torrentPath; return stream;
      });
      abort = () => { for (const stream of streams) stream.destroy(new Error('Link creation paused. Resume to recheck the files.')); reject(new Error('Link creation paused. Resume to recheck the files.')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      createTorrent(streams, options, (error, result) => error ? reject(error) : resolve(result));
    });
    const metadata = await validateGeneratedShare(await rewriteGeneratedShare(await pending, lease), { pieceLength: options.pieceLength, totalBytes: lease.totalBytes, exactBytes: true, announce: [] });
    signal?.throwIfAborted();
    const parsed = await parseTorrent(metadata); lease.bindMetadata(parsed);
    return { metadata, infohash: parsed.infoHash, name: parsed.name, sizeBytes: parsed.length, fileCount: parsed.files.length,
      magnet: `magnet:?xt=urn:btih:${parsed.infoHash}&dn=${encodeURIComponent(parsed.name)}` };
  } finally { signal?.removeEventListener('abort', abort); lease.closeNow(); }
}

/** Bind an immutable public manifest to the exact bytes of retained torrent metainfo. */
export async function verifyShareFiles(input, files, metadata, { signal, onProgress = () => {} } = {}) {
  const lease = reviewInventoryShare(path.resolve(input), files);
  try {
    validateTorrentMetadataBytes(metadata); const parsed = await parseTorrent(metadata); lease.bindMetadata(parsed);
    let piece = crypto.createHash('sha1'), pieceBytes = 0, pieceIndex = 0, completed = 0;
    const finishPiece = () => { if (piece.digest('hex') !== parsed.pieces[pieceIndex++]) throw new Error('Files no longer match this torrent. Create a new link and release for changed bytes.'); piece = crypto.createHash('sha1'); pieceBytes = 0; };
    const result = [];
    for (const file of lease.files) {
      const sha256 = crypto.createHash('sha256');
      for await (const chunk of lease.stream(file)) {
        signal?.throwIfAborted(); sha256.update(chunk);
        for (let offset = 0; offset < chunk.length;) { const length = Math.min(parsed.pieceLength - pieceBytes, chunk.length - offset); piece.update(chunk.subarray(offset, offset + length)); offset += length; pieceBytes += length; if (pieceBytes === parsed.pieceLength) finishPiece(); }
        completed += chunk.length; onProgress(completed, lease.totalBytes);
      }
      result.push({ path: file.torrentPath, size: file.length, sha256: sha256.digest('hex') });
    }
    if (pieceBytes) finishPiece(); if (pieceIndex !== parsed.pieces.length) throw new Error('Torrent file scope changed.');
    for (const file of lease.files) lease.verifyFile(file);
    if (!lease.currentDataPath()) throw new Error('The release copy moved during verification.');
    return { files: result, torrent: { infohash_v1: parsed.infoHash, metainfo_sha256: crypto.createHash('sha256').update(metadata).digest('hex'), piece_length: parsed.pieceLength } };
  } finally { lease.closeNow(); }
}

export class TorrentEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._allowPeerAddresses = opts.allowPeerAddresses === true;
    this.client = new WebTorrent({
      dht: opts.dht !== false,
      maxConns: opts.maxConns ?? 55,
      tracker: opts.tracker ?? {},
      lsd: false,
      utp: opts.utp !== false,
      webSeeds: false,
      natUpnp: false, natPmp: false, // the settings-aware manager owns mappings
    });
    guardWebTorrentConnPoolDestroy(this.client);
    guardWebTorrentPeerAddresses(this.client, { allowPeerAddresses: this._allowPeerAddresses });
    guardWebTorrentDhtQueries(this.client, { allowPeerAddresses: this._allowPeerAddresses });

    // The optional UDP listener can be denied on Windows even when the same
    // TCP port is usable. Track the actual uTP error dispatch, not merely an
    // errno: an unrelated storage EACCES must never become a transport warning.
    // ConnPool attaches this callback when its asynchronous TCP listen completes.
    const optionalUdpErrors = new Set();
    const pool = this.client._connPool;
    if (typeof pool?._onUTPError === 'function') {
      const onUTPError = pool._onUTPError;
      pool._onUTPError = (err) => {
        optionalUdpErrors.add(err);
        try { return onUTPError.call(pool, err); }
        finally { optionalUdpErrors.delete(err); }
      };
    }

    // Surfacing engine-level failures instead of swallowing them: a silently
    // dead DHT is the difference between "nobody has this" and "we're broken".
    this.client.on('error', (err) => {
      // WebTorrent keeps TCP alive when the optional uTP socket cannot bind.
      // Report that reduced transport accurately instead of a failed engine.
      if (optionalUdpErrors.has(err) && !this.client.destroyed && this.client.utp === false && this.client._connPool?.tcpServer?.listening) {
        this.emit('engine-warning', { message: 'The UDP peer listener is unavailable. Torrent transfers continue over TCP.' });
        return;
      }
      this.emit('engine-error', { message: String(err?.message ?? err) });
    });

    // Queue bookkeeping (see managers.js — the uTorrent-style download queue).
    this.userPaused = new Set();   // paused by the human: the queue must never resume these
    this.autoQueued = [];          // paused by the queue, in FIFO order: the queue may resume these
    this.addedAt = new Map();      // infoHash -> ms, for stable queue ordering
    this.doneAt = new Map();       // infoHash -> completion time in this process
    this.seededMs = new Map();     // infoHash -> elapsed time saved before this process
    this.uploadedBytes = new Map();// infoHash -> bytes uploaded before this process

    this._destroyed = false;
    this._pendingAdds = new Map();
    this._pendingSeeds = new Map();
    this._pendingRemovals = new Map();
    this._shareLeases = new Set();
    this._additionResults = new WeakMap();
    this._transferIdentityTokens = new WeakMap();
    this._sessionGeneration = 0;
    this._afterShareReview = typeof opts.afterShareReview === 'function' ? opts.afterShareReview : null;
    this._onTorrentDone = (t) => {
      if (t?.infoHash && !this.doneAt.has(t.infoHash)) this.doneAt.set(t.infoHash, Date.now());
    };
    this.client.on('torrent', (t) => {
      if (t?._hfHybrid) return;
      if (t?.infoHash && !this.addedAt.has(t.infoHash)) this.addedAt.set(t.infoHash, Date.now());
      if (t?.done) this._onTorrentDone(t);
      t?.on?.('done', () => this._onTorrentDone(t));
    });
  }

  get downloadPath() {
    return this._downloadPath;
  }

  setDownloadPath(dir) {
    this._downloadPath = dir;
  }

  /** Monotonic identity for the current in-memory torrent object. Completion
   * retry suppression uses it so removing and re-adding the same infohash is
   * always a fresh attempt. */
  completionGeneration(infoHash) {
    return this._find(infoHash)?._frostSessionGeneration ?? 0;
  }

  /** Every torrent this client knows about, in a UI-shaped form. */
  list() {
    return this.client.torrents.filter(t => !t._hfHybrid).map((t) => this._shape(t));
  }

  _trackShareLease(lease) {
    this._shareLeases ??= new Set();
    this._shareLeases.add(lease);
    lease.onClose = () => this._shareLeases.delete(lease);
    return lease;
  }

  _additionResult(torrent, { created = false, priorIntent = null } = {}) {
    const result = this._shape(torrent);
    this._additionResults ??= new WeakMap();
    this._additionResults.set(result, { torrent, created, priorIntent });
    return result;
  }

  async _destroyExactTorrent(torrent, destroyStore = false) {
    if (!torrent || torrent.destroyed) {
      torrent?._reviewedShareLease?.closeNow();
      return;
    }
    await new Promise((resolve, reject) => {
      try { torrent.destroy({ destroyStore }, error => error ? reject(error) : resolve()); }
      catch (error) { if (torrent.destroyed) resolve(); else reject(error); }
    });
    torrent._reviewedShareLease?.closeNow();
  }

  async _rollbackCreatedTorrent(torrent) {
    const infoHash = torrent?.infoHash;
    await this._destroyExactTorrent(torrent, false);
    if (infoHash && !this.client.torrents.some(current => current !== torrent && current.infoHash === infoHash)) this.forget(infoHash);
  }

  /** Undo only the live mutation represented by this exact add/seed result.
   * A newly-created torrent is closed; a deduplicated torrent is never removed;
   * a re-share restores the pre-existing pause/share/inventory intent. */
  async rollbackAddition(result) {
    const operation = result && typeof result === 'object' ? this._additionResults?.get(result) : null;
    if (!operation) return false;
    this._additionResults.delete(result);
    const { torrent, created, priorIntent } = operation;
    if (created) {
      await this._rollbackCreatedTorrent(torrent);
      return true;
    }
    if (priorIntent && !torrent.destroyed && this.client.torrents.includes(torrent)) {
      this._restoreIntent(torrent, priorIntent);
      return true;
    }
    return false;
  }

  /** Capture the exact live torrent object behind an irreversible review. */
  transferIdentity(infoHash) {
    const torrent = this._find(infoHash);
    if (!torrent || torrent.destroyed) return null;
    const token = Object.freeze({
      infoHash: torrent.infoHash,
      dataPath: torrentDataPath(torrent),
      sessionGeneration: torrent._frostSessionGeneration,
    });
    this._transferIdentityTokens ??= new WeakMap();
    this._transferIdentityTokens.set(token, torrent);
    return token;
  }

  isCurrentIdentity(token) {
    const torrent = token && typeof token === 'object' ? this._transferIdentityTokens?.get(token) : null;
    return !!torrent && !torrent.destroyed && this.client.torrents.includes(torrent)
      && this._find(token.infoHash) === torrent
      && torrent._frostSessionGeneration === token.sessionGeneration
      && torrentDataPath(torrent) === token.dataPath;
  }

  _shape(t) {
    const selected = t._selectedPaths ? (t.files || []).filter(f => t._selectedPaths.has(torrentFileId(f.path))) : null;
    const total = selected ? selected.reduce((n, f) => n + f.length, 0) : t.length || 0;
    const done = selected ? selected.reduce((n, f) => n + (f.done ? f.length : f.downloaded || 0), 0) : t.downloaded || 0;
    const complete = !!(t.done || t._selectionDone);
    // `t.done` describes the whole torrent. A transfer carrying a selection is
    // finished when its selected files are, and its completion comes from
    // _selectionDone instead; without this split a partial transfer would
    // report itself as a full seed.
    const selectionComplete = t._selectedPaths ? !!t._selectionDone : complete;
    const hash = t.infoHash;
    const queued = this.autoQueued.includes(hash);
    const uploaded = addCounter(this.uploadedBytes.get(hash), t.uploaded, MAX_SESSION_UPLOADED_BYTES);
    const elapsed = this.doneAt.has(hash) && complete ? Math.max(0, Date.now() - this.doneAt.get(hash)) : 0;
    const seededMs = addCounter(this.seededMs.get(hash), elapsed, MAX_SESSION_SEEDED_MS);
    return {
      infoHash: hash,
      magnetURI: t.magnetURI,
      name: t.name || hash?.slice(0, 12) || 'unknown',
      length: total,
      downloaded: done,
      uploaded,
      downloadSpeed: t.downloadSpeed || 0,
      uploadSpeed: t.uploadSpeed || 0,
      progress: selectionComplete ? 1 : total ? Math.min(1, done / total) : 0,
      ratio: done > 0 ? uploaded / done : 0,
      timeRemaining: selected ? (t.downloadSpeed ? (total - done) / t.downloadSpeed * 1000 : 0) : t.timeRemaining || 0,
      done: selectionComplete,
      partial: !!t._selectedPaths && selected.length < (t.files?.length || 0),
      seeding: !!t.done && !t.paused,
      explicitShare: !!t._explicitShare,
      inventoryId: t._inventoryId || undefined,
      hfSource: t._hfSource || undefined,
      kind: t._contentKind || undefined,
      paused: !!t.paused,
      // "Queued" means the download queue paused it to honor the max-active
      // setting; it will resume by itself when a slot frees. Distinct from a
      // user pause, which stays until the user says otherwise.
      queued,
      numPeers: t.numPeers || 0,
      ready: !!t.ready,
      completionHandled: !!t._completionHandled,
      completionGeneration: t._frostSessionGeneration ?? 0,
      waitingForPeers: !!t._discoveryIdle && !complete && !t.paused && !queued && !t.numPeers,
      files: (t.files || []).map((f) => ({
        name: f.name,
        path: torrentFileId(f.path),
        length: f.length,
        selected: !t._selectedPaths || t._selectedPaths.has(torrentFileId(f.path)),
        progress: f.done ? 1 : f.length ? Math.min(1, (f.downloaded || 0) / f.length) : 0,
      })),
      peers: [...(t._peers?.values() ?? [])].map((p) => ({
        addr: p.addr ?? 'unknown',
        type: p.type ?? '',
      })),
      createdBy: t.createdBy ?? null,
      comment: t.comment ?? null,
      path: t.path ?? null,
      dataPath: torrentDataPath(t),
      addedAt: this.addedAt.get(hash) ?? 0,
      seededMs,
    };
  }

  /**
   * Pull a model from the swarm.
   * Accepts a magnet URI, an infohash, or validated .torrent metadata bytes.
   */
  async add(source, opts = {}) {
    if (typeof source === 'string') {
      if (source.length > MAX_MAGNET_BYTES) throw new Error('Torrent magnet is too large.');
      source = source.trim().replace(/^magnet:/i, 'magnet:');
      if (!extractInfoHash(source)) throw new Error('Pass a magnet link, infohash, or validated torrent metadata.');
    }
    const selectedPaths = normalizeTorrentSelection(opts.selectedPaths);
    const key = extractInfoHash(source) || source;
    if (this._pendingAdds.has(key)) return this._pendingAdds.get(key);
    const existing = this._find(source);
    if (existing) return this._additionResult(existing);
    const pending = (async () => {
      const input = await sanitizeTorrentDiscovery(source, { allowPeerAddresses: this._allowPeerAddresses });
      const duplicate = await this.client.get(input);
      if (duplicate) return this._additionResult(duplicate);
      const destination = opts.path ?? this._downloadPath;
      if (opts.allowExisting !== true && (Buffer.isBuffer(input) || input instanceof Uint8Array)) {
        rejectExistingTorrentTargets(destination, (await parseTorrent(input)).files);
      }
      let t;
      try {
        t = this.client.add(input, {
          path: destination,
          ...protectedStore(destination, opts.allowExisting === true, selectedPaths),
          announce: opts.announce ?? [],
          // WebTorrent arms the whole torrent during _onMetadata, before it emits
          // `ready` and before the per-file select() calls below can run. Doing
          // the work up front means an unselected shard is never hashed, never
          // opened for read, and never scheduled -- which is both the correct
          // behaviour and the difference between starting and stalling on large
          // multi-shard model payloads.
          deselect: !!selectedPaths,
          ...(opts.hfSource ? { private: true } : {}),
        });
        if (opts.hfSource) usePairedDiscovery(t);
        t._selectedPaths = selectedPaths ? new Set(selectedPaths) : null;
        t._contentKind = validContentKind(opts.kind) ? opts.kind : undefined;
        t._inventoryId = opts.inventoryId;
        t._explicitShare = !!opts.explicitShare;
        t._hfSource = !!opts.hfSource;
        this._wire(t);
        await new Promise((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            t.off('infoHash', ready);
            t.off('error', fail);
            t.off('close', closed);
            this.client.off('error', clientFailed);
          };
          const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
          };
          const ready = () => settle(resolve);
          const fail = err => settle(reject, err instanceof Error ? err : new Error(String(err ?? 'Transfer failed to start.')));
          // A fatal WebTorrent listener/DHT error destroys torrents first, then
          // emits the useful client error in the same turn. Defer the generic
          // close failure so callers receive the original cause when available.
          const closed = () => queueMicrotask(() => fail(new Error('Transfer was removed before it could start.')));
          const clientFailed = err => { if (this.client.destroyed) fail(err); };
          t.once('infoHash', ready); t.once('error', fail); t.once('close', closed);
          this.client.on('error', clientFailed);
          if (t.destroyed || this.client.destroyed) closed();
          else if (t.infoHash) ready();
        });
        this.addedAt.set(t.infoHash, Date.now());
        if (opts.paused) await this.pause(t.infoHash);
        this.emit('updated', this._shape(t));
        return this._additionResult(t, { created: true });
      } catch (error) {
        if (t) {
          try { await this._rollbackCreatedTorrent(t); }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], 'The transfer failed and its created torrent could not be closed safely.'); }
        }
        throw error;
      }
    })();
    this._pendingAdds.set(key, pending);
    try { return await pending; } finally { this._pendingAdds.delete(key); }
  }

  async _awaitTorrentReady(torrent, label) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        torrent.off('ready', ready);
        torrent.off('error', fail);
        torrent.off('close', closed);
        this.client.off('error', clientFailed);
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const ready = () => settle(resolve);
      const fail = error => settle(reject, error instanceof Error ? error : new Error(String(error ?? `${label} failed to start.`)));
      const closed = () => queueMicrotask(() => fail(new Error(`${label} was removed before it could start.`)));
      const clientFailed = error => { if (this.client.destroyed) fail(error); };
      torrent.once('ready', ready);
      torrent.once('error', fail);
      torrent.once('close', closed);
      this.client.on('error', clientFailed);
      if (torrent.destroyed || this.client.destroyed) closed();
      else if (torrent.ready) queueMicrotask(ready);
    });
  }

  async _activateExistingShare(torrent, opts) {
    const priorIntent = this._intentSnapshot(torrent);
    await this._mutateIntent(torrent, () => {
      torrent._explicitShare = true;
      if (opts.inventoryId) torrent._inventoryId = opts.inventoryId;
      torrent.resume();
      for (const peer of torrent._resumePeers ?? []) torrent.addPeer(peer);
      torrent._resumePeers = [];
      this.userPaused.delete(torrent.infoHash);
      this.autoQueued = this.autoQueued.filter(hash => hash !== torrent.infoHash);
      this.emit('updated', this._shape(torrent));
      return true;
    });
    return this._additionResult(torrent, { priorIntent });
  }

  /**
   * Share something you already have. This is the always-on-box case: point
   * it at a directory of models and it starts handing them out.
   *
   * Returns the magnet link to give to other people.
   */
  async seed(inputPath, opts = {}) {
    const input = path.resolve(inputPath);
    // A prior stop-sharing operation may still be closing its store and
    // clearing bookkeeping for the same hash. Finish it before re-sharing.
    await this._pendingRemovals.get(input);
    if (this._pendingSeeds.has(input)) return this._pendingSeeds.get(input);
    const pending = (async () => {
      let lease;
      let createdTorrent;
      try {
        lease = this._trackShareLease(opts.files ? reviewInventoryShare(input, opts.files) : reviewOrdinaryShare(input));
        await this._afterShareReview?.(lease.summary());

        const expectedDataPath = lease.expectedDataPath;
        const existing = this.client.torrents.find(t => t.ready && (
          (opts.inventoryId && t._inventoryId === opts.inventoryId)
          || (torrentDataPath(t) === expectedDataPath && (!t._inventoryId || !opts.inventoryId || t._inventoryId === opts.inventoryId))
        ));
        if (existing) {
          lease.closeNow();
          if (!this._shape(existing).done) throw new Error('Finish downloading this item before sharing it.');
          return await this._activateExistingShare(existing, opts);
        }

        const seedOptions = {
          name: lease.name,
          announce: seedTrackers(opts.announce),
          pieceLength: torrentSharePieceLength(lease.totalBytes),
          filterJunkFiles: false,
        };
        validateTorrentFiles([{ path: seedOptions.name, length: 0 }]);
        validateTorrentPieceFanout(lease.files, seedOptions.pieceLength);
        let metadata = await new Promise((resolve, reject) => {
          const streams = lease.files.map(file => lease.stream(file));
          createTorrent(streams, seedOptions, (error, value) => error ? reject(error) : resolve(value));
        });
        metadata = await rewriteGeneratedShare(metadata, lease);
        metadata = await validateGeneratedShare(metadata, {
          pieceLength: seedOptions.pieceLength,
          totalBytes: lease.totalBytes,
          exactBytes: true,
          announce: seedOptions.announce,
        });
        const parsed = await parseTorrent(metadata);
        lease.bindMetadata(parsed);

        const duplicate = await this.client.get(metadata);
        if (duplicate) {
          lease.closeNow();
          if (torrentDataPath(duplicate) !== expectedDataPath
              || (opts.inventoryId && duplicate._inventoryId && duplicate._inventoryId !== opts.inventoryId)) {
            throw new Error('These identical files already have a torrent in another item. Use that item’s sharing switch.');
          }
          if (!this._shape(duplicate).done) throw new Error('Finish downloading this item before sharing it.');
          return await this._activateExistingShare(duplicate, opts);
        }
        if (this.client.destroyed) throw new Error('Torrent client stopped before sharing could start.');

        const seedRoot = path.dirname(expectedDataPath);
        createdTorrent = this.client.add(metadata, {
          path: seedRoot,
          store: ReviewedDescriptorStore,
          storeOpts: { reviewedShareLease: lease },
          skipVerify: true,
        });
        createdTorrent._reviewedShareLease = lease;
        createdTorrent._explicitShare = true;
        createdTorrent._inventoryId = opts.inventoryId;
        this._wire(createdTorrent);
        await this._awaitTorrentReady(createdTorrent, 'Share');
        if (createdTorrent.destroyed || this.client.destroyed) throw new Error('Share was removed before it could start.');
        const shaped = this._additionResult(createdTorrent, { created: true });
        this.emit('seeding', shaped);
        return shaped;
      } catch (error) {
        try {
          if (createdTorrent) await this._rollbackCreatedTorrent(createdTorrent);
          else lease?.closeNow();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'The share failed and its reviewed descriptors could not be closed safely.');
        }
        throw error;
      }
    })();
    this._pendingSeeds.set(input, pending);
    try { return await pending; } finally { this._pendingSeeds.delete(input); }
  }

  /** Reopen the original metadata after a move/restart, preserving its infohash. */
  async restore(record) {
    const clean = await validateTorrentSessionRecord(record, { allowPeerAddresses: this._allowPeerAddresses });
    const t = this.client.add(clean.source, {
      path: clean.path,
      ...protectedStore(clean.path, true, clean.selectedPaths),
      deselect: !!clean.selectedPaths,
    });
    if (clean.hfSource) usePairedDiscovery(t);
    t._selectedPaths = clean.selectedPaths ? new Set(clean.selectedPaths) : null;
    t._explicitShare = clean.explicitShare;
    t._inventoryId = clean.inventoryId;
    t._hfSource = clean.hfSource;
    t._contentKind = clean.kind;
    t._completionHandled = clean.completionHandled;
    const restoreAccounting = () => {
      this.seededMs.set(t.infoHash, clean.seededMs);
      this.uploadedBytes.set(t.infoHash, clean.uploadedBytes);
      // Offline time is not seeding time. Any synchronous complete signal from
      // WebTorrent starts this process's contribution at the restore boundary.
      if ((t.done || t._selectionDone) && !this.doneAt.has(t.infoHash)) this.doneAt.set(t.infoHash, Date.now());
    };
    if (t.infoHash) restoreAccounting();
    if (clean.paused) t.pause();
    this._wire(t);
    const mark = () => {
      restoreAccounting();
      this.addedAt.set(t.infoHash, clean.addedAt ?? Date.now());
      if (clean.paused) { this._pause(t); this.userPaused.add(t.infoHash); }
      this.emit('updated', this._shape(t));
    };
    t.once('infoHash', mark);
    if (t.infoHash) mark();
    return t;
  }

  sessions() {
    return this.client.torrents.filter(t => t.infoHash && !t._hfHybrid).map(t => {
      const shaped = this._shape(t);
      return {
        infohash: t.infoHash, magnet: t.magnetURI, name: t.name,
        path: t.path, paused: this.userPaused.has(t.infoHash),
        explicitShare: !!t._explicitShare,
        inventoryId: t._inventoryId || undefined,
        hfSource: t._hfSource || undefined,
        kind: t._contentKind || undefined,
        completionHandled: !!t._completionHandled,
        addedAt: this.addedAt.get(t.infoHash),
        seededMs: shaped.seededMs,
        uploadedBytes: shaped.uploaded,
        torrentFile: t.torrentFile ? Buffer.from(t.torrentFile).toString('base64') : null,
        selectedPaths: t._selectedPaths ? [...t._selectedPaths] : null,
      };
    });
  }

  _pause(t) {
    t.pause();
    // WebTorrent pause prevents new peers but leaves established wires alive.
    t._resumePeers = [...(t._peers?.values() ?? [])].map(p => p.addr).filter(Boolean);
    for (const wire of [...t.wires]) wire.destroy();
  }

  _intentSnapshot(t) {
    return {
      paused: !!t.paused,
      userPaused: this.userPaused.has(t.infoHash),
      autoQueued: [...this.autoQueued],
      resumePeers: [...(t._resumePeers ?? [])],
      peers: [...(t._peers?.values() ?? [])].map(peer => peer.addr).filter(Boolean),
      explicitShare: !!t._explicitShare,
      inventoryId: t._inventoryId,
    };
  }

  _restoreIntent(t, snapshot) {
    t._explicitShare = snapshot.explicitShare;
    t._inventoryId = snapshot.inventoryId;
    this.autoQueued = [...snapshot.autoQueued];
    if (snapshot.userPaused) this.userPaused.add(t.infoHash); else this.userPaused.delete(t.infoHash);
    if (snapshot.paused) {
      this._pause(t);
      t._resumePeers = [...snapshot.resumePeers];
      return;
    }
    t.resume();
    for (const peer of new Set([...snapshot.peers, ...snapshot.resumePeers])) t.addPeer(peer);
    t._resumePeers = [...snapshot.resumePeers];
  }

  async _mutateIntent(t, operation) {
    const snapshot = this._intentSnapshot(t);
    try { return await operation(); }
    catch (error) {
      try { this._restoreIntent(t, snapshot); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'The transfer change failed and its live state could not be restored. Restart FrostByte.'); }
      throw error;
    }
  }

  /** Apply the complete persisted user intent in one rollback-safe mutation. */
  async setSessionIntent(infoHash, { paused, explicitShare } = {}) {
    if (typeof paused !== 'boolean' || typeof explicitShare !== 'boolean') throw new Error('Invalid transfer intent.');
    const t = await this.client.get(infoHash);
    if (!t) return false;
    return this._mutateIntent(t, () => {
      t._explicitShare = explicitShare;
      if (paused) {
        this._pause(t);
        this.userPaused.add(infoHash);
      } else {
        t.resume();
        for (const peer of t._resumePeers ?? []) t.addPeer(peer);
        t._resumePeers = [];
        this.userPaused.delete(infoHash);
      }
      this.autoQueued = this.autoQueued.filter(hash => hash !== infoHash);
      this.emit('updated', this._shape(t));
      return true;
    });
  }

  /**
   * User pause: explicit, sticky. The queue manager must not resume these.
   */
  async pause(infoHash) {
    const t = await this.client.get(infoHash);
    if (!t) return false;
    return this.setSessionIntent(infoHash, { paused: true, explicitShare: !!t._explicitShare });
  }

  /**
   * Queue pause: system-initiated, resumable by the queue. Not sticky.
   */
  async pauseForQueue(infoHash) {
    const t = await this.client.get(infoHash);
    if (!t || this.userPaused.has(infoHash)) return false;
    return this._mutateIntent(t, () => {
      this._pause(t);
      if (!this.autoQueued.includes(infoHash)) this.autoQueued.push(infoHash);
      this.emit('updated', this._shape(t));
      return true;
    });
  }

  /** Resume clears both kinds of pause — the user clicked it. */
  async resume(infoHash) {
    const t = await this.client.get(infoHash);
    if (!t) return false;
    return this.setSessionIntent(infoHash, { paused: false, explicitShare: !!t._explicitShare });
  }

  /** An explicit sharing choice is sticky and is never a request to delete data. */
  async setSharing(infoHash, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Choose whether sharing is on or off.');
    const torrent = await this.client.get(infoHash);
    if (!torrent) throw new Error('This transfer is no longer available. Refresh and try again.');
    if (enabled && !this._shape(torrent).done) throw new Error('Finish downloading this item before turning sharing on.');
    const changed = await this.setSessionIntent(infoHash, {
      paused: !enabled, explicitShare: enabled ? true : !!torrent._explicitShare,
    });
    if (!changed) throw new Error('This transfer is no longer available. Refresh and try again.');
    return this._shape(torrent);
  }

  /** Persist that the app has already registered/moved this completion.
   * Restores retain the marker; a remove followed by a fresh add starts clean. */
  markCompletionHandled(infoHash) {
    const torrent = this._find(infoHash);
    if (!torrent) return false;
    torrent._completionHandled = true;
    const shaped = this._shape(torrent);
    this.emit('updated', shaped);
    return shaped;
  }

  async remove(infoHash, deleteData = false) {
    if (typeof deleteData !== 'boolean') throw new Error('Choose whether torrent files should be deleted.');
    const t = this._find(infoHash);
    if (!t) return false;
    const key = torrentDataPath(t) || infoHash;
    if (this._pendingRemovals.has(key)) return this._pendingRemovals.get(key);
    const pending = (async () => {
      // `destroyStore` is how we also delete the bytes from disk.
      await new Promise((resolve, reject) => {
        this.client.remove(infoHash, { destroyStore: deleteData }, err => err ? reject(err) : resolve()).catch(reject);
      });
      this.forget(infoHash);
      this.emit('removed', { infoHash });
      return true;
    })();
    this._pendingRemovals.set(key, pending);
    try { return await pending; } finally { this._pendingRemovals.delete(key); }
  }

  forget(infoHash) {
    this.userPaused.delete(infoHash);
    this.autoQueued = this.autoQueued.filter((h) => h !== infoHash);
    this.addedAt.delete(infoHash);
    this.doneAt.delete(infoHash);
    this.seededMs.delete(infoHash);
    this.uploadedBytes.delete(infoHash);
  }

  /* ---------------- bandwidth + connection controls (uTorrent-grade) ----- */

  /** Bytes/sec; -1 means unlimited. 0 is treated as unlimited too. */
  setLimits({ down = -1, up = -1 } = {}) {
    const d = Number(down) > 0 ? Math.round(Number(down)) : -1;
    const u = Number(up) > 0 ? Math.round(Number(up)) : -1;
    this.client.throttleDownload(d);
    this.client.throttleUpload(u);
    return { down: d, up: u };
  }

  /** HTTP pulls consume the same token bucket as peer traffic. Polling keeps
   * cancellation independent of the upstream stream's pending callbacks. */
  async acquireDownloadBytes(bytes, signal) {
    const group = this.client.throttleGroups.down;
    while (bytes > 0) {
      signal?.throwIfAborted();
      if (!group.getEnabled()) return;
      const size = Math.min(bytes, Math.max(1, group.getChunksize()));
      if (group.bucket.tryRemoveTokens(size)) { bytes -= size; continue; }
      await delay(25, undefined, { signal });
    }
  }

  setMaxConns(n) {
    const v = Number(n) > 0 ? Math.round(Number(n)) : 55;
    this.client.maxConns = v;
    return v;
  }

  get port() {
    try {
      return this.client.listening ? (this.client.address()?.port ?? null) : null;
    } catch {
      return null;
    }
  }

  get dhtNodeCount() {
    const n = this.client?.dht?.nodes;
    if (!n) return 0;
    if (typeof n.count === 'function') return n.count();
    if (n instanceof Map) return n.size;
    if (Array.isArray(n)) return n.length;
    return 0;
  }

  _find(source) {
    if (typeof source !== 'string') return null;
    const hash = extractInfoHash(source);
    if (!hash) return null;
    return this.client.torrents.find(
      (t) => t.infoHash === hash || t.infoHash?.toLowerCase() === hash.toLowerCase(),
    );
  }

  _wire(t) {
    if (t._frostWired) return;
    t._frostWired = true;
    if (!t._frostSessionGeneration) {
      this._sessionGeneration = Number.isSafeInteger(this._sessionGeneration) ? this._sessionGeneration + 1 : 1;
      t._frostSessionGeneration = this._sessionGeneration;
    }
    let lastProgress = 0;
    const report = () => {
      if (Date.now() - lastProgress < 200) return;
      lastProgress = Date.now();
      this.emit('progress', this._shape(t));
    };
    t.on('download', report);
    t.on('upload', report);
    // Magnets reveal their file list asynchronously. Stop the torrent during
    // the metadata event, before WebTorrent verifies pieces or emits ready, if
    // the list would overrun filesystem or UI safety limits.
    t.prependOnceListener('metadata', () => {
      try { validateTorrentMetadataBytes(t.torrentFile); validateTorrentLayout(t); }
      catch (error) {
        t.destroy();
        // Public destroy has no error argument. Emit after closing so callers
        // waiting for seed/add failure and the app notice path both receive it.
        t.emit('error', error);
      }
    });
    const finish = () => {
      if (t._frostComplete) return;
      t._frostComplete = true;
      this._onTorrentDone(t);
      const complete = this._shape(t);
      this.emit('progress', complete); // even short transfers get a final progress report
      this.emit('done', complete);
    };
    const checkSelection = () => {
      if (!t._selectedPaths || !t.ready || t.destroyed) return;
      const files = t.files.filter(f => t._selectedPaths.has(torrentFileId(f.path)));
      // A selected entry counts as finished once WebTorrent reports it done.
      // Empty entries never produce a `done` event, so they count immediately.
      if (files.length === t._selectedPaths.size && files.every(f => f.length === 0 || f.done)) {
        t._selectionDone = true;
        finish();
      }
    };
    t.on('done', finish);
    t.on('ready', () => {
      if (t._selectedPaths) {
        const files = t.files.filter(f => t._selectedPaths.has(torrentFileId(f.path)));
        if (files.length !== t._selectedPaths.size) {
          this._pause(t);
          this.userPaused.add(t.infoHash);
          this.emit('torrent-error', { infoHash: t.infoHash, message: 'The selected files do not match this torrent. Remove it and choose the files again.' });
        } else for (const file of files) {
          file.on('done', () => queueMicrotask(checkSelection));
          if (file.length) file.select();
        }
      }
      this.emit('ready', this._shape(t));
      checkSelection();
    });
    t.on('wire', () => { t._discoveryIdle = false; this.emit('peer', this._shape(t)); });
    t.on('noPeers', (announceType) => {
      if (t._discoveryIdle || t.numPeers || t.done || t.paused) return;
      t._discoveryIdle = true;
      this.emit('no-peers', { infoHash: t.infoHash, announceType });
      this.emit('progress', this._shape(t));
    });
    t.on('error', (err) => this.emit('torrent-error', { infoHash: t.infoHash, message: String(err?.message ?? err) }));
  }

  destroy() {
    if (this._destroyPromise) return this._destroyPromise;
    this._destroyed = true;
    this._destroyPromise = new Promise((resolve, reject) => {
      if (this.client.destroyed) { resolve(); return; }
      try { this.client.destroy(error => error ? reject(error) : resolve()); }
      catch (error) {
        if (this.client.destroyed || /already destroyed/i.test(error.message)) resolve();
        else reject(error);
      }
    }).finally(() => {
      const errors = [];
      for (const lease of this._shareLeases ?? []) {
        try { lease.closeNow(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Reviewed share descriptors could not all be closed.');
    });
    return this._destroyPromise;
  }
}

/** Pull a v1 infohash (hex-40 or base32-32) out of a magnet, or accept a bare hash. */
export function extractInfoHash(source) {
  if (typeof source !== 'string' || source.length > MAX_MAGNET_BYTES) return null;
  const value = source.trim();
  const raw = value.match(/(?:^|[?&])xt=urn:btih:([a-z0-9]+)(?:&|$)/i)?.[1] || value;
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase();
  if (!/^[a-z2-7]{32}$/i.test(raw)) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, acc = 0;
  const bytes = [];
  for (const char of raw.toUpperCase()) {
    acc = (acc << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 255); }
  }
  return Buffer.from(bytes).toString('hex');
}

/** The model's common root, never the shared download directory. */
export function torrentDataPath(t) {
  if (t?._reviewedShareLease) return t._reviewedShareLease.currentDataPath();
  if (!t.path || !t.files?.length) return null;
  const roots = new Set(t.files.map(f => String(f.path).split(/[\\/]/)[0]));
  if (roots.size !== 1) return null;
  const root = [...roots][0];
  if (!root || root === '.' || root === '..') return null;
  return path.join(t.path, root);
}

export function isMagnet(s) {
  return typeof s === 'string' && s.startsWith('magnet:');
}

/** One tracker URL per line → array. */
export function parseTrackerList(text) {
  return String(text ?? '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Human-readable size. Kept here so main and renderer agree on formatting. */
export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec) {
  if (!bytesPerSec) return '—';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(ms) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export { path };
