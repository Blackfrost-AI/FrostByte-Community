/**
 * Filesystem chunk store with an explicit destination boundary.
 *
 * WebTorrent learns file names only after magnet metadata arrives, so a
 * one-time check in the IPC handler cannot protect the eventual writes.  The
 * store is the last component before the filesystem.  It validates paths when
 * metadata creates the store, then validates again when each file is opened.
 * Open descriptors keep later reads/writes bound to the object that passed the
 * check instead of following a path that may have changed in the meantime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import FSChunkStore from 'fs-chunk-store';
import { filesystemPathKey, validatePortablePathSet, validatePortableRelativePath } from './portable-path.js';
import { acquireTorrentDescriptor, MAX_TORRENT_OPEN_DESCRIPTORS } from './torrent-descriptor-budget.js';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const CLOEXEC = fs.constants.O_CLOEXEC || 0;
export const MAX_TORRENT_FILES = 4096;
export const MAX_TORRENT_PATH_BYTES = 1024;
export const MAX_TORRENT_TOTAL_PATH_BYTES = 512 * 1024;
export const MAX_TORRENT_METADATA_BYTES = 8 * 1024 * 1024;
export const MAX_TORRENT_TOTAL_BYTES = 1024 ** 4; // 1 TiB
export const MAX_TORRENT_PIECES = 262_144;
export const MIN_TORRENT_PIECE_BYTES = 16 * 1024;
export const MAX_TORRENT_PIECE_BYTES = 16 * 1024 * 1024;
// The per-piece fanout is a *descriptor* bound, so it must be derived from the
// process's actual handle budget rather than hardcoded: a host with a low
// RLIMIT_NOFILE gets a correspondingly smaller allowance, and a single crafted
// piece can then never claim more than half the pool. The result is also capped
// by the budget itself, so a pathologically small limit can never yield an
// allowance larger than the pool it is spending from, and by the whole-torrent
// file ceiling, because a single piece can never span more files than a torrent
// is allowed to contain.
export const MAX_TORRENT_FILES_PER_PIECE = Math.min(
  Math.floor(MAX_TORRENT_FILES / 2),
  MAX_TORRENT_OPEN_DESCRIPTORS,
  Math.max(64, Math.floor(MAX_TORRENT_OPEN_DESCRIPTORS / 2)),
);

const asyncCallback = (callback, ...args) => queueMicrotask(() => callback?.(...args));
const boundaryError = message => Object.assign(new Error(message), { code: 'FROSTBYTE_STORAGE_BOUNDARY' });

/** Reject remote shares and Windows device namespaces before mkdir/realpath.
 * A saved transfer may outlive the UI validation that originally chose it. */
export function validateLocalStorageRoot(value) {
  if (typeof value !== 'string' || !value || value.length > 32_768 || /[\0\r\n]/.test(value)) {
    throw boundaryError('Choose a valid local download folder.');
  }
  if (/^[\\/]{2}/.test(value) || /^[\\/]\?\?[\\/]/.test(value)) {
    throw boundaryError('Choose a folder on a local drive, not a network or device path.');
  }
  if (!path.isAbsolute(value)) throw boundaryError('Choose an absolute download folder.');
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value)) {
    throw boundaryError('Choose a folder on a local drive.');
  }
  return path.resolve(value);
}

function isBeneath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sameObject(left, right) {
  // dev/ino are populated on supported Windows filesystems as well as Unix.
  // If a platform cannot provide them, the realpath and link checks remain.
  if (!left || !right) return false;
  if (Number(left.ino) && Number(right.ino)) return left.dev === right.dev && left.ino === right.ino;
  return true;
}

function sameSnapshot(left, right) {
  return sameObject(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertNoPortableSiblingAlias(target, targetStat = null) {
  const parent = path.dirname(target), name = path.basename(target);
  let directory;
  try { directory = fs.opendirSync(parent); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (entry.name === name || filesystemPathKey(entry.name, 'portable') !== filesystemPathKey(name, 'portable')) continue;
      let alias;
      try { alias = fs.lstatSync(path.join(parent, entry.name)); }
      catch (error) { if (error.code === 'ENOENT') continue; else throw error; }
      // Default macOS volumes may return a decomposed spelling for the same
      // inode. Permit that representation, but never a second filesystem node.
      if (targetStat && sameObject(targetStat, alias)) continue;
      throw boundaryError('Torrent storage already contains a name that collides on a supported filesystem.');
    }
  } finally { directory.closeSync(); }
}

function initialFileState(root, relative, allowExisting, expectedLength = null) {
  const target = path.resolve(root, relative);
  if (!isBeneath(root, target)) throw boundaryError('Torrent metadata tried to write outside the selected download folder.');
  try {
    const linked = fs.lstatSync(target);
    if (linked.isSymbolicLink() || !linked.isFile() || linked.nlink > 1 || !isBeneath(root, fs.realpathSync(target))) {
      throw boundaryError('Torrent storage contains a linked or unsafe existing file.');
    }
    assertNoPortableSiblingAlias(target, linked);
    if (!allowExisting) throw boundaryError('A torrent file already exists in this download folder. Move it or resume the saved transfer.');
    // Resuming adopts an existing file as the baseline for piece writes. A
    // genuinely resumable file is a *prefix* of the declared payload, so it can
    // never be longer than the torrent says. A file that is larger is a
    // different file that merely shares the name; adopting it would overwrite
    // it in place, so it is refused as a collision instead.
    //
    // Do not tighten this to an equality check: a transfer interrupted mid-file
    // leaves a short file and a completed file is exactly the declared length,
    // so both must stay adoptable. Anything that cannot be verified is caught
    // later -- the resume path re-hashes every piece, so a same-or-shorter file
    // with wrong content is unverified and re-downloaded rather than trusted.
    if (Number.isSafeInteger(expectedLength) && expectedLength >= 0 && linked.size > expectedLength) {
      throw boundaryError('A different file already exists at a path this torrent wants to use. Move it out of the download folder, then resume.');
    }
    return linked;
  } catch (error) {
    if (error.code === 'ENOENT') { assertNoPortableSiblingAlias(target); return null; }
    throw error;
  }
}

function portableFileId(value, platform) {
  try {
    return validatePortableRelativePath(value, {
      platform, label: 'Torrent metadata file path', maxLength: MAX_TORRENT_PATH_BYTES, allowBackslash: true,
    });
  } catch (error) {
    throw boundaryError(`Torrent metadata contains an invalid file path. ${error.message}`);
  }
}

export function validateTorrentFiles(files, { platform = 'portable' } = {}) {
  if (!Array.isArray(files) || !files.length) throw boundaryError('Torrent metadata contains no files.');
  if (files.length > MAX_TORRENT_FILES) throw boundaryError(`Torrent metadata contains more than ${MAX_TORRENT_FILES} files.`);
  let pathBytes = 0, totalBytes = 0;
  const result = files.map(file => {
    // Keep the protocol-level path bound separate from per-component filesystem
    // checks so an oversized remote path gets the same deterministic error.
    if (typeof file?.path === 'string' && Buffer.byteLength(file.path.replaceAll('\\', '/'), 'utf8') > MAX_TORRENT_PATH_BYTES) {
      throw boundaryError(`A torrent file path exceeds ${MAX_TORRENT_PATH_BYTES} bytes.`);
    }
    const id = portableFileId(file?.path, platform);
    const bytes = Buffer.byteLength(id, 'utf8');
    if (bytes > MAX_TORRENT_PATH_BYTES) throw boundaryError(`A torrent file path exceeds ${MAX_TORRENT_PATH_BYTES} bytes.`);
    pathBytes += bytes;
    if (pathBytes > MAX_TORRENT_TOTAL_PATH_BYTES) throw boundaryError('Torrent file paths exceed the safe metadata limit.');
    if (!Number.isSafeInteger(file.length) || file.length < 0) throw boundaryError('Torrent metadata contains an invalid file size.');
    if (file.length > MAX_TORRENT_TOTAL_BYTES - totalBytes) throw boundaryError('Torrents larger than 1 TiB are not supported.');
    const offset = totalBytes;
    totalBytes += file.length;
    // The physical store layout is derived only from the validated lengths.
    // Never let a caller-supplied offset create a giant sparse chunkMap.
    return { path: id, length: file.length, offset };
  });
  try { validatePortablePathSet(result.map(file => file.path), { platform, label: 'Torrent metadata file paths' }); }
  catch (error) { throw boundaryError(error.message); }
  return result;
}

/**
 * Normalized paths the caller's selection covers, or null when no selection
 * was supplied — null means "the whole torrent is in scope", the fail-closed
 * default. A selection naming no known entry is treated as absent rather than
 * as an empty scope.
 */
export function selectedFileIds(files, selectedPaths) {
  if (!Array.isArray(selectedPaths) || !selectedPaths.length) return null;
  const wanted = new Set(selectedPaths.map(value => String(value).replaceAll('\\', '/')));
  if (!files.some(file => wanted.has(file.path))) return null;
  return wanted;
}

/** Files in `files` that the selection covers (all of them when unscoped). */
function selectedFiles(files, selectedIds) {
  return selectedIds ? files.filter(file => selectedIds.has(file.path)) : files;
}

/** Bound the number of file segments fs-chunk-store opens in parallel. */
export function validateTorrentPieceFanout(files, pieceLength, { selectedIds = null } = {}) {
  if (!Number.isSafeInteger(pieceLength) || pieceLength <= 0) {
    throw boundaryError('Torrent piece layout exceeds the safe storage limit.');
  }
  // fs-chunk-store opens one handle per file segment a piece spans. Only the
  // scope that will actually be fetched matters for the descriptor budget; the
  // files a selection leaves out are not requested as a transfer of their own.
  // They are not untouched, though: fs-chunk-store fans every fetched piece out
  // to *every* file that piece spans. When files are packed many-to-a-piece
  // that is all of them, so a selection narrows what is *reported*, not what is
  // written. See the internal shared-piece fan-out analysis (2026-10-31); the bound below
  // is a budget for the requested scope, not a guarantee about other files.
  const considered = selectedFiles(files, selectedIds);
  const changes = new Map();
  for (const file of considered) {
    if (!file.length) continue;
    const firstPiece = Math.floor(file.offset / pieceLength);
    const lastPiece = Math.floor((file.offset + file.length - 1) / pieceLength);
    changes.set(firstPiece, (changes.get(firstPiece) ?? 0) + 1);
    changes.set(lastPiece + 1, (changes.get(lastPiece + 1) ?? 0) - 1);
  }
  let active = 0;
  for (const piece of [...changes.keys()].sort((left, right) => left - right)) {
    active += changes.get(piece);
    // An end event can never precede the start it cancels; a negative running
    // total means the sweep itself is wrong, so fail closed rather than
    // silently under-count and let a violating layout through.
    if (active < 0) throw boundaryError('Torrent piece layout could not be validated.');
    if (active > MAX_TORRENT_FILES_PER_PIECE) {
      throw boundaryError(selectedIds
        ? `This torrent packs more than ${MAX_TORRENT_FILES_PER_PIECE} of the files you selected into a single piece. Select fewer files, or use a torrent whose pieces are stored per file.`
        : `This torrent packs more than ${MAX_TORRENT_FILES_PER_PIECE} files into a single piece, which is beyond the supported storage layout.`);
    }
  }
  return files;
}

/**
 * Bound the piece map before WebTorrent or fs-chunk-store expands it.
 *
 * The piece count and hash cross-check always describe the whole torrent: they
 * validate the metadata itself, which a selection cannot change.
 *
 * The per-piece fan-out is a runtime descriptor budget rather than a property
 * of the metadata, so it is scoped to the files a transfer will fetch. Pass
 * `selectedPaths` to scope it, or `checkFanout: false` for a metadata-only
 * preview that selects nothing.
 *
 * Callers that gate a transfer *before* WebTorrent begins verifying pieces (the
 * magnet-metadata guard in torrent.js) must keep the default `checkFanout: true`
 * so an over-budget torrent is stopped before hashing starts, not after.
 */
export function validateTorrentLayout(parsed, { platform = 'portable', selectedPaths = null, checkFanout = true } = {}) {
  const files = validateTorrentFiles(parsed?.files, { platform });
  const totalBytes = files.reduce((total, file) => total + file.length, 0);
  const pieceLength = parsed?.pieceLength;
  if (!Number.isSafeInteger(pieceLength) || pieceLength < MIN_TORRENT_PIECE_BYTES || pieceLength > MAX_TORRENT_PIECE_BYTES) {
    throw boundaryError(`Torrent pieces must be between ${MIN_TORRENT_PIECE_BYTES / 1024} KiB and ${MAX_TORRENT_PIECE_BYTES / 1024 ** 2} MiB.`);
  }
  const expectedPieces = Math.ceil(totalBytes / pieceLength);
  if (expectedPieces > MAX_TORRENT_PIECES) throw boundaryError(`Torrent metadata describes more than ${MAX_TORRENT_PIECES} pieces.`);
  if (checkFanout) {
    validateTorrentPieceFanout(files, pieceLength, { selectedIds: selectedFileIds(files, selectedPaths) });
  }
  const hashes = Array.isArray(parsed?._hashes) ? parsed._hashes : parsed?.pieces;
  if (!Array.isArray(hashes) || hashes.length !== expectedPieces
      || hashes.some(piece => !(typeof piece === 'string' && /^[a-f0-9]{40}$/iu.test(piece)))) {
    throw boundaryError('Torrent piece hashes do not match the described file size.');
  }
  return files;
}

export function validateTorrentMetadataBytes(value) {
  const bytes = value?.byteLength;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_TORRENT_METADATA_BYTES) {
    throw boundaryError('Torrent metadata is larger than 8 MB.');
  }
  return value;
}

function prepareOptions(chunkLength, opts) {
  let root;
  try {
    const requestedRoot = validateLocalStorageRoot(opts.approvedRoot);
    fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    const requestedStat = fs.lstatSync(requestedRoot);
    if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
      throw boundaryError('The selected download folder cannot be a symbolic link.');
    }
    root = fs.realpathSync(requestedRoot);
    const rootStat = fs.statSync(root);
    if (!rootStat.isDirectory()) throw boundaryError('The selected download folder is unavailable.');

    const files = validateTorrentFiles(opts.files);
    // A selection carried in from the picker is applied before the transfer
    // starts, so every layout check below sees only what will actually be
    // touched. Without a selection the whole torrent is in scope, which is the
    // original fail-closed behaviour.
    const selectedIds = selectedFileIds(files, opts.selectedPaths);
    const inScope = selectedFiles(files, selectedIds);
    const scopedBytes = inScope.reduce((total, file) => total + file.length, 0);
    if (!Number.isSafeInteger(chunkLength) || chunkLength <= 0 || chunkLength > MAX_TORRENT_PIECE_BYTES
        || Math.ceil(scopedBytes / chunkLength) > MAX_TORRENT_PIECES) {
      throw boundaryError('Torrent piece layout exceeds the safe storage limit.');
    }
    validateTorrentPieceFanout(files, chunkLength, { selectedIds });
    const allowExisting = opts.allowExisting === true;
    const initialFiles = files.map(file => initialFileState(root, file.path, allowExisting, file.length));
    return { chunkLength, options: { ...opts, path: root, files }, root, rootStat, initialFiles, allowExisting, error: null };
  } catch (error) {
    // FSChunkStore's constructor performs no I/O, but WebTorrent calls it from
    // an async event without awaiting the result.  Give it an inert in-bounds
    // layout and report the validation failure through normal store callbacks
    // instead of creating an unhandled rejection.
    const inertRoot = path.join(os.tmpdir(), 'frostbyte-invalid-torrent-store');
    const files = [{ path: 'invalid/0', length: 0, offset: 0 }];
    return {
      chunkLength: Number.isSafeInteger(chunkLength) && chunkLength > 0 && chunkLength <= MAX_TORRENT_PIECE_BYTES
        ? chunkLength : MIN_TORRENT_PIECE_BYTES,
      options: { ...opts, path: inertRoot, files, length: 0 },
      root: inertRoot,
      rootStat: null,
      initialFiles: [null],
      allowExisting: false,
      error: error?.code === 'FROSTBYTE_STORAGE_BOUNDARY' ? error : boundaryError(`The selected download folder is unsafe: ${error.message}`),
    };
  }
}

function verifyRoot(root, expected) {
  if (!expected) throw boundaryError('The selected download folder is unsafe.');
  const current = fs.statSync(root);
  if (!current.isDirectory() || fs.realpathSync(root) !== root || !sameObject(current, expected)) {
    throw boundaryError('The selected download folder changed while the transfer was active.');
  }
}

function verifyParents(root, expectedRoot, filename, create) {
  verifyRoot(root, expectedRoot);
  const parent = path.dirname(filename);
  if (!isBeneath(root, filename) || !isBeneath(root, parent)) {
    throw boundaryError('Torrent metadata tried to write outside the selected download folder.');
  }
  const relative = path.relative(root, parent);
  let current = root;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      assertNoPortableSiblingAlias(current);
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isBeneath(root, fs.realpathSync(current))) {
      throw boundaryError('Torrent storage contains a linked or replaced directory.');
    }
    assertNoPortableSiblingAlias(current, stat);
  }
  verifyRoot(root, expectedRoot);
}

class SafeFile {
  constructor(store, filename, initialStat) {
    this.store = store;
    this.filename = filename;
    this.initialStat = initialStat;
    this.ownedStat = initialStat;
    this.readFd = null;
    this.writeFd = null;
    this.readPermit = null;
    this.writePermit = null;
    this.opening = { read: null, write: null };
  }

  open(callback) {
    if (this.store.closed && this.readFd === null && this.writeFd === null) return asyncCallback(callback, new Error('Storage is closed'));
    asyncCallback(callback, null, this);
  }

  _ensure(create, callback) {
    const kind = create ? 'write' : 'read';
    const existing = create ? this.writeFd : (this.writeFd ?? this.readFd);
    if (existing !== null) return asyncCallback(callback, null, existing);
    if (this.opening[kind]) { this.opening[kind].push(callback); return; }
    this.opening[kind] = [callback];
    const finish = (error, fd = null, permit = null) => {
      const waiting = this.opening[kind];
      this.opening[kind] = null;
      if (!error) {
        if (create) { this.writeFd = fd; this.writePermit = permit; }
        else { this.readFd = fd; this.readPermit = permit; }
      }
      for (const done of waiting) asyncCallback(done, error, fd);
    };
    let fd;
    let permit = null;
    try {
      if (this.store.validationError) throw this.store.validationError;
      if (this.store.closed) throw new Error('Storage is closed');
      verifyParents(this.store.root, this.store.rootStat, this.filename, create);
      if (this.initialStat) {
        const current = fs.lstatSync(this.filename);
        if (!sameSnapshot(this.initialStat, current)) throw boundaryError('An existing torrent file changed before it could be opened.');
      }
      const flags = (create
        ? this.initialStat ? fs.constants.O_RDWR : fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        : fs.constants.O_RDONLY) | CLOEXEC | NOFOLLOW;
      permit = acquireTorrentDescriptor();
      fd = fs.openSync(this.filename, flags, 0o600);
      const opened = fs.fstatSync(fd);
      const linked = fs.lstatSync(this.filename);
      const actual = fs.realpathSync(this.filename);
      if (!opened.isFile() || linked.isSymbolicLink() || !sameObject(opened, linked) || !isBeneath(this.store.root, actual)) {
        throw boundaryError('Torrent storage changed while a file was being opened.');
      }
      if (opened.nlink > 1) throw boundaryError('Torrent storage cannot overwrite a hard-linked file.');
      assertNoPortableSiblingAlias(this.filename, linked);
      if (this.initialStat && !sameSnapshot(this.initialStat, opened)) {
        throw boundaryError('An existing torrent file changed while it was being opened.');
      }
      this.ownedStat = opened;
      verifyRoot(this.store.root, this.store.rootStat);
      finish(null, fd, permit);
    } catch (error) {
      let closeError = null;
      if (fd !== undefined) {
        try { fs.closeSync(fd); permit?.release(); }
        catch (caught) { closeError = caught; }
      } else permit?.release();
      if (closeError) error = new AggregateError([error, closeError], 'Torrent storage could not close a rejected file descriptor safely.');
      finish(error?.code === 'ELOOP' ? boundaryError('Torrent storage cannot follow symbolic links.')
        : error?.code === 'EEXIST' ? boundaryError('A file appeared in torrent storage before it could be created.') : error);
    }
  }

  read(offset, length, callback) {
    this._ensure(false, (error, fd) => {
      if (error) return callback(error);
      const output = Buffer.allocUnsafe(length);
      let read = 0;
      const next = () => fs.read(fd, output, read, length - read, offset + read, (error, count) => {
        if (error) return callback(error);
        if (!count) return callback(Object.assign(new Error(`No data at ${offset + read}`), { code: 'EIO' }));
        read += count;
        if (read === length) callback(null, output); else next();
      });
      if (!length) return asyncCallback(callback, null, output);
      next();
    });
  }

  write(offset, data, callback) {
    this._ensure(true, (error, fd) => {
      if (error) return callback(error);
      let written = 0;
      const next = () => fs.write(fd, data, written, data.length - written, offset + written, (error, count) => {
        if (error) return callback(error);
        if (!count) return callback(Object.assign(new Error('Torrent storage write made no progress.'), { code: 'EIO' }));
        written += count;
        if (written === data.length) callback(null); else next();
      });
      if (!data.length) return asyncCallback(callback, null);
      next();
    });
  }

  close(callback) {
    const descriptors = [
      { fd: this.readFd, permit: this.readPermit },
      { fd: this.writeFd, permit: this.writePermit },
    ].filter(entry => entry.fd !== null);
    this.readFd = null;
    this.writeFd = null;
    this.readPermit = null;
    this.writePermit = null;
    if (!descriptors.length) return asyncCallback(callback, null);
    let remaining = descriptors.length;
    let firstError = null;
    for (const { fd, permit } of descriptors) fs.close(fd, error => {
      // A failed close has platform-specific ownership semantics. Retain its
      // permit forever rather than risk opening past the real process limit.
      if (!error) permit?.release();
      firstError ||= error;
      if (!--remaining) callback?.(firstError);
    });
  }
}

/** WebTorrent-compatible constructor. Always pass storeOpts.approvedRoot. */
export class SafeTorrentStore extends FSChunkStore {
  constructor(chunkLength, opts = {}) {
    const prepared = prepareOptions(chunkLength, opts);
    super(prepared.chunkLength, prepared.options);
    this.root = prepared.root;
    this.rootStat = prepared.rootStat;
    this.allowExisting = prepared.allowExisting;
    this.validationError = prepared.error;
    this.closed = false;
    this._safeFiles = [];

    if (!this.validationError) {
      const destinations = new Set();
      for (const file of this.files) {
        const key = filesystemPathKey(file.path, 'portable');
        if (!isBeneath(this.root, file.path) || destinations.has(key)) {
          this.validationError = boundaryError('Torrent metadata contains unsafe or colliding file paths.');
          break;
        }
        destinations.add(key);
      }
    }

    for (const [index, file] of this.files.entries()) {
      const safe = new SafeFile(this, file.path, prepared.initialFiles[index] ?? null);
      this._safeFiles.push(safe);
      file.open = callback => safe.open(callback);
    }
  }

  put(index, buffer, callback) {
    if (this.validationError) return asyncCallback(callback, this.validationError);
    return super.put(index, buffer, callback);
  }

  get(index, options, callback) {
    if (typeof options === 'function') callback = options;
    if (this.validationError) return asyncCallback(callback, this.validationError);
    return super.get(index, options, callback);
  }

  close(callback) {
    if (this.closed) return asyncCallback(callback, null);
    this.closed = true;
    let remaining = this._safeFiles.length;
    let firstError = null;
    if (!remaining) return asyncCallback(callback, null);
    for (const file of this._safeFiles) file.close(error => {
      firstError ||= error;
      if (!--remaining) callback?.(firstError);
    });
  }

  destroy(callback) {
    const finish = closeError => {
      if (closeError || this.validationError) return asyncCallback(callback, closeError || this.validationError);
      try {
        // Never use recursive removal for torrent-controlled paths.  Recheck
        // every parent, unlink regular files, then remove empty directories.
        for (const file of this._safeFiles) {
          if (!file.ownedStat) continue;
          try {
            verifyParents(this.root, this.rootStat, file.filename, false);
            const stat = fs.lstatSync(file.filename);
            if (stat.isDirectory()) throw boundaryError('Torrent data path was replaced by a directory.');
            if (!sameObject(file.ownedStat, stat)) throw boundaryError('Torrent data was replaced before it could be removed.');
            fs.unlinkSync(file.filename); // unlink removes a leaf symlink itself; it never follows it
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        const directories = [...new Set(this.files.flatMap(file => {
          const result = [];
          for (let current = path.dirname(file.path); current !== this.root && isBeneath(this.root, current); current = path.dirname(current)) result.push(current);
          return result;
        }))].sort((left, right) => right.length - left.length);
        for (const directory of directories) {
          try {
            verifyParents(this.root, this.rootStat, directory, false);
            const stat = fs.lstatSync(directory);
            if (stat.isSymbolicLink()) throw boundaryError('Torrent data directory was replaced by a link.');
            fs.rmdirSync(directory);
          } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
          }
        }
        callback?.(null);
      } catch (error) { callback?.(error); }
    };
    this.close(finish);
  }
}

export default SafeTorrentStore;
