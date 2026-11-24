/** Headless Spark download service. Control is a private Unix socket over SSH. */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import parseTorrent from 'parse-torrent';
import { TorrentEngine, extractInfoHash, validateTorrentSessionRecord } from '../main/torrent.js';
import { MAX_TORRENT_METADATA_BYTES, validateTorrentFiles, validateTorrentLayout } from '../main/safe-torrent-store.js';
import { hfDownloadFile, hfDestination, hfDestinationPath, hfDestinationPathKeys, validateHfDownloadSelection, validateHfFilePath, validateHfRepoId } from '../main/hf.js';
import { filesystemPathKey } from '../main/portable-path.js';
import { getHybridIdentity, createHybridManifest, identityKey, validateIdentity } from '../main/hf-hybrid.js';
import { writeJson } from '../main/store.js';
import { contentKind, validContentKind } from '../shared/content-kind.js';
import { getDeviceInfo } from '../main/device-info.js';
import { IpfsTransfers } from '../main/ipfs.js';
import { DownloadInventory } from '../main/inventory.js';
import { inventoryProofText } from '../shared/inventory-proof.js';
import { readAeonCapabilities } from '../main/aeon-device.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sourceAgentTestModeEnabled } from './test-mode.js';
import { COMPANION_PROTOCOL_VERSION } from '../shared/companion-protocol.js';
import { assistantModels, assistantChatStart, assistantChatCancel, stopAssistantChats, assistantDeviceId } from './assistant.js';

const execFileAsync = promisify(execFile);

const requestedHome = path.resolve(process.env.FROSTBYTE_AGENT_HOME || '/state');
const configuredDownloadDir = path.resolve(process.env.FROSTBYTE_DOWNLOAD_DIR || '/downloads');
const agentTestMode = sourceAgentTestModeEnabled();
fs.mkdirSync(requestedHome, { recursive: true, mode: 0o700 });
const requestedHomeStat = fs.lstatSync(requestedHome);
if (requestedHomeStat.isSymbolicLink()) throw new Error('Spark state folder cannot be a symbolic link.');
const home = fs.realpathSync(requestedHome);
const homeStat = fs.lstatSync(home);
const wrongHomeOwner = typeof process.getuid === 'function' && homeStat.uid !== process.getuid();
if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || fs.realpathSync(home) !== home || wrongHomeOwner) throw new Error('Spark state folder must be a private local directory owned by the service account.');
if (process.platform !== 'win32') fs.chmodSync(home, 0o700);
if (!process.env.FROSTBYTE_STORAGE_ROOTS) fs.mkdirSync(configuredDownloadDir, { recursive: true });
const downloadDir = process.env.FROSTBYTE_STORAGE_ROOTS ? configuredDownloadDir : fs.realpathSync(configuredDownloadDir);
const stateFile = path.join(home, 'agent.json');
const socketPath = path.join(home, 'control.sock');
const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const ipfsBinaryDirectory = fileURLToPath(new URL(`../../build/ipfs-runtime/${process.platform}-${process.arch}/`, import.meta.url));
const ipfs = new IpfsTransfers({ directory: path.join(home, 'ipfs'), binaryDirectory: ipfsBinaryDirectory, requireDestination: async value => requireStorage(value) });
await ipfs.load().catch(error => console.error('IPFS recovery:', error.message));
ipfs.on('failure', error => console.error('IPFS:', error.message));
const MAX_AGENT_STATE_BYTES = 64 * 1024 * 1024;
const MAX_SAVED_TORRENTS = 2000;
const MAX_SAVED_DOWNLOADS = 10_000;
const MAX_INVENTORY_ROWS = 5000;
const MAX_INVENTORY_FILES = 5000;
const MAX_INVENTORY_PATH_BYTES = 512 * 1024;
const MAX_INVENTORY_FILES_TOTAL = 25_000;
const MAX_INVENTORY_PATH_BYTES_TOTAL = 4 * 1024 * 1024;
const MAX_ITEM_KINDS = 10_000;
const MAX_STORAGE_ROOTS = 64;
const MAX_SAVED_TORRENT_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_SAVED_DOWNLOAD_PATH_BYTES = 8 * 1024 * 1024;
const MAX_HF_FILE_BYTES = 16 * 1024 ** 4;
const stateDefaults = () => ({ torrents: [], downloads: [], inventory: [], itemKinds: {}, storageIdentities: [] });
function preserveStateFile(reason) {
  let target = `${stateFile}.${reason}-${Date.now()}`;
  for (let suffix = 1; fs.existsSync(target); suffix++) target = `${stateFile}.${reason}-${Date.now()}-${suffix}`;
  fs.renameSync(stateFile, target);
  console.warn(`Unsafe or unreadable Spark state preserved at ${target}. Loading an empty transfer state.`);
}
function readAgentState() {
  let descriptor;
  try {
    const before = fs.lstatSync(stateFile);
    const wrongOwner = typeof process.getuid === 'function' && before.uid !== process.getuid();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || wrongOwner) {
      preserveStateFile('unsafe');
      return stateDefaults();
    }
    if (before.size > MAX_AGENT_STATE_BYTES) {
      preserveStateFile('oversized');
      return stateDefaults();
    }
    const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(stateFile, fs.constants.O_RDONLY | noFollow);
    const held = fs.fstatSync(descriptor), current = fs.lstatSync(stateFile);
    if (!held.isFile() || held.nlink > 1 || held.dev !== current.dev || held.ino !== current.ino || held.size > MAX_AGENT_STATE_BYTES) {
      throw Object.assign(new Error('Spark state changed while it was being opened.'), { unsafeState: true });
    }
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new SyntaxError('Spark state must be an object.');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return stateDefaults();
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} descriptor = undefined; }
    if (error instanceof SyntaxError || error.unsafeState) {
      preserveStateFile(error.unsafeState ? 'unsafe' : 'corrupt');
      return stateDefaults();
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
const saved = readAgentState();
const configuredRoots = JSON.parse(process.env.FROSTBYTE_STORAGE_ROOTS || JSON.stringify([downloadDir]));
if (!Array.isArray(configuredRoots) || !configuredRoots.length || configuredRoots.length > MAX_STORAGE_ROOTS || configuredRoots.some(root => typeof root !== 'string' || root.length > 4096 || !path.isAbsolute(root) || path.resolve(root) !== root)) throw new Error('Spark storage roots must be absolute, normalized paths.');
const storageRoots = [...new Set(configuredRoots)];
if (!storageRoots.includes(downloadDir)) throw new Error('The primary download folder must be a registered storage root.');
const configuredIdentities = JSON.parse(process.env.FROSTBYTE_STORAGE_IDENTITIES || '[]');
if (!Array.isArray(configuredIdentities) || configuredIdentities.length > MAX_STORAGE_ROOTS || configuredIdentities.some(identity => !identity || typeof identity !== 'object' || !storageRoots.includes(identity.path) || !/^[a-f0-9]{32}$/.test(identity.marker || ''))) throw new Error('Invalid Spark storage identities.');
function savedIdentity(root, value) {
  const identity = { path: root };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.path !== root) return identity;
  if (/^[a-f0-9]{32}$/.test(value.marker || '')) identity.marker = value.marker;
  if (Number.isSafeInteger(value.dev) && value.dev >= 0 && Number.isSafeInteger(value.ino) && value.ino >= 0) {
    identity.dev = value.dev; identity.ino = value.ino;
  }
  return identity;
}
const identities = new Map(storageRoots.map(root => {
  const configured = configuredIdentities.find(identity => identity.path === root);
  const previous = Array.isArray(saved.storageIdentities) ? saved.storageIdentities.slice(0, MAX_STORAGE_ROOTS).find(identity => identity?.path === root) : null;
  return [root, configured ? savedIdentity(root, configured) : savedIdentity(root, previous)];
}));
function readStorageMarker(marker) {
  let descriptor;
  try {
    const before = fs.lstatSync(marker);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || ![32, 33].includes(before.size)) {
      throw new Error('The storage identity file is not a bounded regular file.');
    }
    const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | noFollow);
    const held = fs.fstatSync(descriptor), current = fs.lstatSync(marker);
    if (!held.isFile() || held.nlink !== 1 || ![32, 33].includes(held.size)
      || held.dev !== current.dev || held.ino !== current.ino) throw new Error('The storage identity file changed while it was being opened.');
    const bytes = Buffer.alloc(held.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    if (offset !== bytes.length || !/^[a-f0-9]{32}\n?$/.test(bytes.toString('ascii'))) throw new Error('The storage identity file is invalid.');
    return bytes.subarray(0, 32).toString('ascii');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
function requireStorage(value = downloadDir) {
  if (typeof value !== 'string' || !storageRoots.includes(value)) throw new Error('Choose a registered Spark storage folder.');
  try {
    const stat = fs.statSync(value), identity = identities.get(value);
    if (!stat.isDirectory() || fs.realpathSync(value) !== value) throw new Error('Storage folder changed or is linked elsewhere.');
    if (identity.marker) {
      const marker = path.join(value, '.frostbyte-storage-id');
      if (readStorageMarker(marker) !== identity.marker) throw new Error('The registered drive is not mounted here.');
    }
    if (identity.dev !== undefined && (identity.dev !== stat.dev || identity.ino !== stat.ino)) throw new Error('The registered drive or folder changed.');
    identity.dev = stat.dev; identity.ino = stat.ino;
    fs.accessSync(value, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return value;
  } catch (error) { throw new Error(`Spark storage unavailable: ${value}. Reconnect the drive or register this folder again. ${error.message}`); }
}
const beneath = (root, target) => target === root || target.startsWith(root + path.sep);
function rootFor(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Saved download has no registered destination.');
  const root = storageRoots.filter(root => beneath(root, path.resolve(target))).sort((a, b) => b.length - a.length)[0];
  if (!root) throw new Error('Saved download destination is not registered on this Spark.');
  return root;
}
function safeTarget(root, target, { mustExist = false } = {}) {
  requireStorage(root);
  if (!beneath(root, path.resolve(target))) throw new Error('Choose a path inside the selected storage folder.');
  let probe = path.resolve(target);
  while (true) {
    try {
      if (fs.lstatSync(probe).isSymbolicLink() || !beneath(root, fs.realpathSync(probe))) throw new Error('Linked paths outside Spark storage are unavailable.');
      if (mustExist && probe !== path.resolve(target)) throw new Error('The selected file or folder is unavailable.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      probe = path.dirname(probe);
    }
  }
  return path.resolve(target);
}
for (const root of storageRoots) { try { requireStorage(root); } catch {} }
const engine = new TorrentEngine({ dht: !agentTestMode, tracker: agentTestMode ? false : {}, lsd: false, allowPeerAddresses: agentTestMode });
engine.setDownloadPath(downloadDir);
const downloads = new Map(), jobs = new Set(), deferredTorrents = new Map(), torrentErrors = new Map(), inventory = new Map();
const savedItemKinds = saved.itemKinds && typeof saved.itemKinds === 'object' && !Array.isArray(saved.itemKinds)
  ? Object.entries(saved.itemKinds).slice(-MAX_ITEM_KINDS).filter(([id, kind]) => /^[a-f0-9]{64}$/.test(id) && validContentKind(kind))
  : [];
const itemKinds = new Map(savedItemKinds);
const itemJobs = new Map();
const hybridManifests = new Map();
function itemJob(id, run) {
  const task = (itemJobs.get(id) || Promise.resolve()).catch(() => {}).then(run);
  itemJobs.set(id, task);
  task.finally(() => { if (itemJobs.get(id) === task) itemJobs.delete(id); }).catch(() => {});
  return task;
}
let stopping = false, active = 0, restoring = true;
let torrentTransactionDepth = 0, torrentPersistencePending = false;
let stateMutationTail = Promise.resolve();
const acceptedSockets = new Set(), runningSockets = new Set(), acceptedWork = new Set(), backgroundWork = new Set();
const publicDownload = ({ controller, token, storageError, ...record }) => record;
const inventoryId = (source, destination, key) => crypto.createHash('sha256').update(`${source}\0${destination}\0${key}`).digest('hex');
const inventoryProof = entry => crypto.createHash('sha256').update(inventoryProofText(entry)).digest('hex');
const entryRemovalIntents = new Map();
const validSize = value => Number.isSafeInteger(value) && value >= 0;
const boundedText = (value, max, fallback = '') => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : fallback;
function normalizeSavedDownload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved HuggingFace transfer.');
  const repoId = validateHfRepoId(value.repoId), filePath = validateHfFilePath(value.filePath);
  const revision = boundedText(value.revision, 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Saved HuggingFace transfer has no pinned revision.');
  const id = boundedText(value.id, 200);
  if (!id || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Saved HuggingFace transfer has no identity.');
  const statuses = new Set(['queued', 'active', 'paused', 'done', 'error']);
  if (!statuses.has(value.status)) throw new Error('Saved HuggingFace transfer has an invalid status.');
  const absolutePath = (candidate, label) => {
    if (typeof candidate !== 'string' || candidate.length > 4096 || candidate.includes('\0') || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) throw new Error(`Saved HuggingFace transfer has an invalid ${label}.`);
    if (process.platform === 'win32' && /^(?:\\\\|\/\/|\\[?.]\\)/.test(candidate)) throw new Error(`Saved HuggingFace transfer has an invalid ${label}.`);
    return candidate;
  };
  const destination = value.destination === undefined ? undefined : absolutePath(value.destination, 'destination');
  const dest = value.dest === undefined
    ? destination ? hfDestinationPath(destination, repoId, filePath) : undefined
    : absolutePath(value.dest, 'download path');
  if (!dest) throw new Error('Saved HuggingFace transfer has no download path.');
  const savedBytes = (bytes, label) => {
    if (bytes === undefined) return 0;
    if (!validSize(bytes) || bytes > MAX_HF_FILE_BYTES) throw new Error(`Saved HuggingFace ${label} is invalid.`);
    return bytes;
  };
  const total = savedBytes(value.total, 'file size');
  const downloaded = savedBytes(value.downloaded, 'download size');
  if (total && downloaded > total) throw new Error('Saved HuggingFace download exceeds its recorded size.');
  // A saved active row means the previous worker did not durably settle. Do
  // not silently repeat it after a crash; the person can explicitly resume.
  const status = value.status === 'active' ? 'paused' : value.status;
  return {
    id, repoId, revision, filePath, ...(destination ? { destination } : {}), dest,
    total, downloaded, progress: status === 'done' ? 1 : typeof value.progress === 'number' && Number.isFinite(value.progress) ? Math.max(0, Math.min(1, value.progress)) : 0,
    status, removed: value.removed === true, error: boundedText(value.error, 1000),
    ...(validSize(value.completedAt) ? { completedAt: value.completedAt } : {}),
  };
}
function downloadRoot(record) {
  if (record.destination) return record.destination;
  // A newly registered nested root must not change a legacy job's original base.
  const matches = storageRoots.filter(root => {
    try { return hfDestinationPath(root, record.repoId, record.filePath) === record.dest; } catch { return false; }
  });
  if (!matches.length) throw new Error('Saved download destination is not registered on this Spark.');
  return matches[0];
}
function inventoryFilePath(entry, file) {
  if (typeof entry.destination !== 'string' || entry.destination.length > 4096 || typeof entry.path !== 'string' || entry.path.length > 4096 || !storageRoots.includes(entry.destination) || !path.isAbsolute(entry.path) || path.resolve(entry.path) !== entry.path || !beneath(entry.destination, entry.path)) throw new Error('Invalid inventory destination.');
  if (typeof file.path !== 'string' || file.path.length > 4096 || !validSize(file.size)) throw new Error('Invalid inventory file.');
  if (!entry.directory) {
    if (file.path !== '') throw new Error('Invalid single-file inventory path.');
    return entry.path;
  }
  if (!file.path || path.isAbsolute(file.path) || file.path.includes('\\') || file.path.includes('\0') || file.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid inventory file path.');
  const target = path.resolve(entry.path, file.path);
  if (!beneath(entry.path, target)) throw new Error('Invalid inventory file path.');
  return target;
}
function rememberInventory(entry, files, replace = false) {
  if (!entry || typeof entry !== 'object' || !/^[a-f0-9]{64}$/.test(entry.id || '') || typeof entry.name !== 'string' || !entry.name || entry.name.length > 500 || /[\x00-\x1f\x7f]/.test(entry.name)) throw new Error('Invalid inventory item.');
  if (!Array.isArray(files) || !files.length || files.length > MAX_INVENTORY_FILES) throw new Error('Invalid inventory file manifest.');
  let manifestBytes = 0;
  for (const file of files) {
    manifestBytes += typeof file?.path === 'string' ? Buffer.byteLength(file.path, 'utf8') : 0;
    if (manifestBytes > MAX_INVENTORY_PATH_BYTES) throw new Error('Inventory file names exceed the safe metadata limit.');
  }
  const previous = inventory.get(entry.id), merged = new Map((previous?.files || []).map(file => [filesystemPathKey(file.path, 'portable'), file]));
  if (!previous && inventory.size >= MAX_INVENTORY_ROWS) throw new Error('Spark inventory has reached its safe item limit.');
  let changed = !previous;
  for (const file of files) {
    inventoryFilePath(entry, file);
    const fileKey = filesystemPathKey(file.path, 'portable');
    if (merged.has(fileKey) && !replace) continue;
    const old = merged.get(fileKey);
    if (!old || old.size !== file.size || old.revision !== file.revision || replace) {
      merged.set(fileKey, file); changed = true;
    }
  }
  if (merged.size > MAX_INVENTORY_FILES) throw new Error('Inventory file manifest exceeds the safe file limit.');
  let mergedBytes = 0, mergedSize = 0;
  for (const file of merged.values()) {
    mergedBytes += Buffer.byteLength(file.path, 'utf8'); mergedSize += file.size;
    if (mergedBytes > MAX_INVENTORY_PATH_BYTES || !Number.isSafeInteger(mergedSize)) throw new Error('Inventory manifest exceeds the safe metadata limit.');
  }
  let totalFiles = merged.size, totalPathBytes = mergedBytes;
  for (const savedEntry of inventory.values()) {
    if (savedEntry.id === entry.id) continue;
    totalFiles += savedEntry.files.length;
    for (const file of savedEntry.files) totalPathBytes += Buffer.byteLength(file.path, 'utf8');
    if (totalFiles > MAX_INVENTORY_FILES_TOTAL || totalPathBytes > MAX_INVENTORY_PATH_BYTES_TOTAL) throw new Error('Spark inventory has reached its safe metadata limit.');
  }
  if (!merged.size || !changed) return false;
  inventory.set(entry.id, { ...entry, updatedAt: replace ? Date.now() : previous?.updatedAt || entry.updatedAt || Date.now(), files: [...merged.values()] });
  return true;
}
function rememberHF(record, replace = false) {
  const destination = downloadRoot(record);
  if (!storageRoots.includes(destination)) throw new Error('Invalid inventory destination.');
  const expected = hfDestinationPath(destination, record.repoId, record.filePath);
  if (record.dest !== expected) throw new Error('Invalid inventory download path.');
  const asset = path.resolve(destination, record.repoId);
  const entry = { id: inventoryId('hf', destination, record.repoId), source: 'hf', name: record.repoId,
    repoId: record.repoId, path: asset, destination, relative: path.relative(destination, asset), directory: true,
    updatedAt: record.completedAt || 0 };
  let size = Math.max(validSize(record.downloaded) ? record.downloaded : 0, validSize(record.total) ? record.total : 0);
  if (!size) { try { safeTarget(destination, expected, { mustExist: true }); size = fs.statSync(expected).size; } catch {} }
  const file = { path: record.filePath, size };
  if (/^[a-f0-9]{40}$/i.test(record.revision || '')) file.revision = record.revision;
  return rememberInventory(entry, [file], replace);
}
function rememberTorrent(torrent, replace = false) {
  if (torrent.inventoryId) return false;
  if (!torrent.done || !torrent.ready || !/^[a-f0-9]{40}$/i.test(torrent.infoHash || '')) return false;
  const destination = rootFor(torrent.path), asset = torrent.dataPath || torrent.path;
  const selected = (torrent.files || []).filter(file => file.selected !== false);
  if (!selected.length) return false;
  const directory = selected.some(file => path.resolve(torrent.path, file.path) !== asset);
  const entry = { id: inventoryId('torrent', destination, torrent.infoHash), source: 'torrent', name: torrent.name,
    infoHash: torrent.infoHash, path: asset, destination, relative: path.relative(destination, asset), directory, kind: contentKind(torrent) };
  return rememberInventory(entry, selected.map(file => ({ path: directory ? path.relative(asset, path.resolve(torrent.path, file.path)) : '', size: file.length })), replace);
}
function syncInventory(records = [...downloads.values()]) {
  let changed = false;
  // Last completed writer wins when migrating old transfers with the same path.
  const latest = new Map();
  for (const record of records.filter(item => item.status === 'done').sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))) latest.set(filesystemPathKey(record.dest, 'portable'), record);
  for (const record of latest.values()) { try { changed = rememberHF(record) || changed; } catch {} }
  for (const torrent of engine.list()) { try { changed = rememberTorrent(torrent) || changed; } catch {} }
  return changed;
}
for (const entry of (Array.isArray(saved.inventory) ? saved.inventory.slice(-MAX_INVENTORY_ROWS) : [])) {
  try {
    if (!entry || typeof entry !== 'object' || !['hf', 'torrent'].includes(entry.source) || typeof entry.name !== 'string' || typeof entry.directory !== 'boolean' || !Array.isArray(entry.files) || !entry.files.length || entry.files.length > MAX_INVENTORY_FILES) continue;
    const key = entry.source === 'hf' ? entry.repoId : entry.infoHash;
    if (typeof key !== 'string' || entry.id !== inventoryId(entry.source, entry.destination, key)) continue;
    if (entry.source === 'hf' && (entry.path !== path.dirname(hfDestinationPath(entry.destination, entry.repoId, '__inventory__')) || !entry.directory)) continue;
    const clean = { id: entry.id, source: entry.source, name: entry.name, path: entry.path, destination: entry.destination,
      relative: path.relative(entry.destination, entry.path), directory: entry.directory, kind: contentKind(entry), updatedAt: validSize(entry.updatedAt) ? entry.updatedAt : 0 };
    if (entry.source === 'hf') clean.repoId = entry.repoId; else clean.infoHash = entry.infoHash;
    rememberInventory(clean, entry.files.map(file => ({ path: file.path, size: file.size, ...(/^[a-f0-9]{40}$/i.test(file.revision || '') ? { revision: file.revision } : {}) })));
  } catch { /* Invalid saved paths must never be followed outside registered storage. */ }
}
// Only finish metadata reconciliation after a saved files-complete checkpoint.
// Never repeat destructive work automatically after a crash.
for (const operation of (Array.isArray(saved.entryRemovals) ? saved.entryRemovals.slice(0, 500) : [])) {
  const entry = inventory.get(operation.id);
  if (!entry || operation.proof !== inventoryProof(entry) || !['prepared', 'files-complete'].includes(operation.phase)) continue;
  if (operation.phase === 'files-complete') {
    const ownedPaths = new Set(entry.files.map(file => inventoryFilePath(entry, file)));
    saved.downloads = (saved.downloads || []).filter(row => !ownedPaths.has(row.dest));
    saved.torrents = (saved.torrents || []).filter(row => row.inventoryId !== entry.id && row.infohash !== entry.infoHash && !(operation.hashes || []).includes(row.infohash));
    inventory.delete(entry.id);
  } else entryRemovalIntents.set(operation.id, operation);
}
function listInventory() {
  return [...inventory.values()].map(entry => {
    const result = { ...entry, kind: itemKinds.get(entry.id) || contentKind(entry), browseRelative: entry.directory ? entry.relative : path.dirname(entry.relative) === '.' ? '' : path.dirname(entry.relative),
      fileCount: entry.files.length, size: entry.files.reduce((sum, file) => sum + file.size, 0), available: true, missingFiles: 0 };
    try { requireStorage(entry.destination); }
    catch (error) { return { ...result, available: false, error: error.message }; }
    for (const file of entry.files) {
      try {
        const target = inventoryFilePath(entry, file);
        safeTarget(entry.destination, target, { mustExist: true });
        const stat = fs.statSync(target);
        if (!stat.isFile() || stat.size !== file.size) throw new Error('File missing or changed.');
      } catch { result.missingFiles++; }
    }
    if (result.missingFiles) { result.available = false; result.error = 'Some downloaded files are missing, changed, or unavailable.'; }
    return result;
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}
function persist(downloadRecords = downloads, { commitTorrentTransaction = false } = {}) {
  if (restoring) return;
  // Torrent mutations can synchronously emit WebTorrent events before the RPC
  // has durably committed. Defer every incidental writer until the mutation
  // either commits or rolls back, so no observer can publish intermediate
  // state while the controlling request is still unsettled.
  if (torrentTransactionDepth && !commitTorrentTransaction) {
    torrentPersistencePending = true;
    return false;
  }
  // WebTorrent exposes a small announce-only `torrentFile` envelope while a
  // magnet is still waiting for metadata. It has no `info` dictionary, so it
  // is neither valid torrent metadata nor safe persisted state. Keep the
  // validated magnet for recovery and persist metadata once the torrent is
  // ready. Records loaded from disk still go through the strict validator.
  const awaitingMetadata = new Set(engine.list().filter(torrent => !torrent.ready).map(torrent => torrent.infoHash));
  const liveSessions = engine.sessions().map(record => {
    if (!awaitingMetadata.has(record.infohash) || !record.torrentFile) return record;
    const magnetSession = { ...record };
    delete magnetSession.torrentFile;
    return magnetSession;
  });
  const torrents = [...liveSessions, ...deferredTorrents.values()].slice(-MAX_SAVED_TORRENTS).map(record => ({ ...record }));
  let metadataBytes = 0;
  for (const record of [...torrents].reverse()) {
    if (typeof record.torrentFile !== 'string') continue;
    const bytes = Buffer.byteLength(record.torrentFile, 'utf8');
    if (bytes > MAX_SAVED_TORRENT_METADATA_BYTES - metadataBytes) delete record.torrentFile;
    else metadataBytes += bytes;
  }
  writeJson(stateFile, {
    storageIdentities: [...identities.values()].slice(0, MAX_STORAGE_ROOTS),
    itemKinds: Object.fromEntries([...itemKinds].slice(-MAX_ITEM_KINDS)),
    inventory: [...inventory.values()].slice(-MAX_INVENTORY_ROWS),
    entryRemovals: [...entryRemovalIntents.values()],
    torrents,
    downloads: [...downloadRecords.values()].slice(-MAX_SAVED_DOWNLOADS).map(publicDownload),
  }, { maxBytes: MAX_AGENT_STATE_BYTES });
  return true;
}
function commitTorrentState() {
  // Fold synchronous WebTorrent events into the same durable publication as
  // the RPC result. A successful seed must not depend on a later timer to save
  // the inventory card created by its `seeding` event.
  syncInventory();
  const saved = persist(downloads, { commitTorrentTransaction: true });
  torrentPersistencePending = false;
  return saved;
}
for (const event of ['ready', 'updated', 'removed', 'done', 'seeding']) engine.on(event, () => {
  // The final shutdown snapshot is authoritative. Accepted mutations and HF
  // jobs publish explicitly before stop destroys the engine.
  if (stopping) return;
  if (torrentTransactionDepth) { torrentPersistencePending = true; return; }
  try { syncInventory(); persist(); }
  catch (error) { console.error('Torrent state:', error.message); }
});
engine.on('torrent-error', error => console.error('Torrent:', error.message));
engine.on('engine-error', error => console.error('Engine:', error.message));
engine.on('engine-warning', warning => console.error('Engine warning:', warning.message));
async function normalizeTorrentRecord(record) {
  const clean = await validateTorrentSessionRecord(record, { allowPeerAddresses: agentTestMode });
  const normalized = {
    infohash: clean.infohash, path: clean.path, paused: clean.paused,
    explicitShare: clean.explicitShare, completionHandled: clean.completionHandled,
  };
  if (clean.inventoryId) normalized.inventoryId = clean.inventoryId;
  if (clean.hfSource) normalized.hfSource = true;
  if (clean.kind) normalized.kind = clean.kind;
  if (clean.addedAt !== undefined) normalized.addedAt = clean.addedAt;
  normalized.seededMs = clean.seededMs;
  normalized.uploadedBytes = clean.uploadedBytes;
  if (clean.selectedPaths) normalized.selectedPaths = clean.selectedPaths;
  if (typeof clean.source === 'string') normalized.magnet = clean.source;
  else {
    normalized.magnet = `magnet:?xt=urn:btih:${clean.infohash}`;
    normalized.torrentFile = Buffer.from(clean.source).toString('base64');
  }
  return { clean, normalized };
}
async function validateTorrent(record) {
  let candidate = record;
  const liveInfoHash = record?.infoHash || record?.infohash;
  if (liveInfoHash) {
    const live = engine.list().find(item => item.infoHash === liveInfoHash);
    const session = live && engine.sessions().find(item => item.infohash === liveInfoHash);
    if (session) {
      candidate = session;
      if (!live.ready && session.torrentFile) {
        const magnetSession = { ...session };
        delete magnetSession.torrentFile;
        candidate = magnetSession;
      }
    }
  }
  if (record?.infoHash && !record.infohash && candidate === record) {
    throw new Error('Transfer session is unavailable.');
  }
  // Storage identity is the first runtime gate. A disconnected mount must be
  // reported and paused even if WebTorrent is still acquiring its metadata.
  // Once present, the complete session and every metadata path are validated.
  const root = rootFor(candidate?.path);
  safeTarget(root, candidate.path);
  const { clean, normalized } = await normalizeTorrentRecord(candidate);
  const files = typeof clean.source === 'string' ? [] : validateTorrentLayout(await parseTorrent(clean.source));
  for (const file of files) safeTarget(root, path.resolve(clean.path, file.path));
  return normalized;
}
const seenSavedTorrents = new Set();
for (const record of (Array.isArray(saved.torrents) ? saved.torrents.slice(-MAX_SAVED_TORRENTS) : [])) {
  let normalized;
  try {
    ({ normalized } = await normalizeTorrentRecord(record));
    if (seenSavedTorrents.has(normalized.infohash)) continue;
    seenSavedTorrents.add(normalized.infohash);
  } catch { continue; }
  try { await validateTorrent(normalized); await engine.restore(normalized); }
  catch (error) { deferredTorrents.set(normalized.infohash, { ...normalized, paused: true }); torrentErrors.set(normalized.infohash, boundedText(error.message, 1000, 'Saved transfer is unavailable.')); }
}
function validateDownload(record) {
  const root = downloadRoot(record);
  requireStorage(root);
  const expected = hfDestination(root, record.repoId, record.filePath);
  if (record.dest !== expected) throw new Error('Saved download path no longer matches its registered destination.');
  safeTarget(root, record.dest);
  return root;
}
function completedDownloadPresent(record) {
  try {
    const root = validateDownload(record);
    safeTarget(root, record.dest, { mustExist: true });
    const stat = fs.statSync(record.dest);
    const known = inventory.get(inventoryId('hf', root, record.repoId))?.files.find(file => file.path === record.filePath);
    return stat.isFile() && stat.size === Math.max(record.total || 0, record.downloaded || 0) && (!known?.revision || known.revision === record.revision);
  } catch { return false; }
}
function requireEmptyDownloadDestination(record) {
  safeTarget(downloadRoot(record), record.dest);
  try {
    fs.lstatSync(record.dest);
    throw new Error('A file already exists at this HuggingFace destination. Move or remove it before retrying.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// Migrate completed files before an unavailable drive changes a transfer's state.
const savedDownloadsByPath = new Map();
let savedDownloadPathBytes = 0;
for (const value of (Array.isArray(saved.downloads) ? saved.downloads.slice(-MAX_SAVED_DOWNLOADS).reverse() : [])) {
  try {
    if (value?.dest === undefined && value?.destination === undefined) value.dest = hfDestinationPath(downloadDir, value.repoId, value.filePath);
    const record = normalizeSavedDownload(value);
    const pathBytes = Buffer.byteLength(`${record.repoId}\0${record.filePath}\0${record.dest}\0${record.destination || ''}`, 'utf8');
    if (pathBytes > MAX_SAVED_DOWNLOAD_PATH_BYTES - savedDownloadPathBytes) continue;
    const key = filesystemPathKey(record.dest, 'portable');
    if (savedDownloadsByPath.has(key)) continue;
    savedDownloadsByPath.set(key, record); savedDownloadPathBytes += pathBytes;
  } catch { /* Invalid state is dropped before it can become a download or filesystem lookup. */ }
}
const savedDownloads = [...savedDownloadsByPath.values()].reverse();
syncInventory(savedDownloads);
for (const record of savedDownloads) {
  try {
    record.destination ||= downloadRoot(record);
    validateDownload(record);
    if (['active', 'queued'].includes(record.status)) record.status = 'queued';
  } catch (error) { record.status = 'error'; record.error = error.message; }
  downloads.set(record.id, record);
}
restoring = false;
persist();

function pump() {
  while (!stopping && active < 2) {
    const record = [...downloads.values()].find(item => item.status === 'queued');
    if (!record) break;
    let approvedRoot;
    try { approvedRoot = validateDownload(record); }
    catch (error) {
      record.status = 'error'; record.error = error.message;
      delete record.controller; delete record.token;
      try { persist(); } catch (persistError) { console.error('HF state:', persistError.message); }
      continue;
    }
    delete record.storageError;
    record.status = 'active'; record.controller = new AbortController();
    try { persist(); }
    catch (error) {
      record.status = 'error'; record.error = `Could not save download state: ${boundedText(error.message, 3900, 'state write failed')}`;
      delete record.controller; delete record.token;
      try { persist(); } catch { /* retain the terminal in-memory state until storage recovers */ }
      console.error('HF state:', error.message);
      continue;
    }
    active++;
    const job = hfDownloadFile({ repoId: record.repoId, revision: record.revision, filePath: record.filePath,
      dest: record.dest, approvedRoot, expectedSize: record.total > 0 ? record.total : undefined, token: record.token, signal: record.controller.signal,
      onProgress: progress => { validateDownload(record); Object.assign(record, progress); },
    }).then(result => {
      record.status = 'done'; record.progress = 1; record.downloaded = result.bytes; record.total = result.bytes;
      record.completedAt = Date.now(); rememberHF(record, true);
    }).catch(error => {
      record.status = record.controller.signal.aborted && !record.storageError ? 'paused' : 'error';
      record.error = record.status === 'error' ? record.storageError || error.message : '';
    }).finally(() => {
      active--; delete record.controller; delete record.token; jobs.delete(job);
      try { persist(); } catch (error) { console.error('HF state:', error.message); }
      pump();
    });
    jobs.add(job);
  }
}
pump();

function inside(relative = '', root = downloadDir) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Choose a folder within Spark downloads.');
  return safeTarget(root, path.resolve(root, relative), { mustExist: true });
}

function snapshotTorrentIntents() {
  const sessions = new Map(engine.sessions().map(record => [record.infohash, record]));
  return new Map(engine.list().map(torrent => [torrent.infoHash, {
    paused: torrent.paused,
    queued: torrent.queued,
    userPaused: sessions.get(torrent.infoHash)?.paused === true,
    explicitShare: torrent.explicitShare,
    inventoryId: torrent.inventoryId,
    hfSource: torrent.hfSource,
  }]));
}

function restoreInventory(snapshot) {
  inventory.clear();
  for (const [id, entry] of snapshot) inventory.set(id, entry);
}

function restoreMap(target, snapshot) {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

async function rollbackTorrentIntents(snapshot) {
  // A failed state write must not leave work running that the caller was told
  // did not start. Removing without destroyStore preserves every user file.
  const failures = [];
  for (const torrent of engine.list()) {
    if (snapshot.has(torrent.infoHash)) continue;
    try { await engine.remove(torrent.infoHash, false); }
    catch (removeError) {
      let paused = false;
      try { await engine.pause(torrent.infoHash); paused = true; }
      catch (pauseError) {
        const message = `Rejected transfer ${torrent.infoHash} could not be removed or paused during rollback and may still be active.`;
        torrentErrors.set(torrent.infoHash, message);
        failures.push(new AggregateError([removeError, pauseError], message));
      }
      if (paused) {
        const message = `Rejected transfer ${torrent.infoHash} could not be removed during rollback and remains paused.`;
        torrentErrors.set(torrent.infoHash, message);
        failures.push(new Error(`${message} ${removeError.message || removeError}`));
      }
    }
  }
  for (const [infoHash, previous] of snapshot) {
    try {
      const torrent = await engine.client.get(infoHash);
      if (!torrent) throw new Error(`Transfer ${infoHash} disappeared during rollback.`);
      const current = engine.list().find(value => value.infoHash === infoHash);
      if (current && current.paused === previous.paused && current.queued === previous.queued
          && engine.userPaused.has(infoHash) === previous.userPaused
          && current.explicitShare === previous.explicitShare && current.inventoryId === previous.inventoryId
          && current.hfSource === previous.hfSource) continue;
      torrent._explicitShare = previous.explicitShare;
      torrent._inventoryId = previous.inventoryId;
      torrent._hfSource = previous.hfSource;
      engine.userPaused.delete(infoHash);
      engine.autoQueued = engine.autoQueued.filter(value => value !== infoHash);
      if (previous.paused) {
        engine._pause(torrent);
        if (previous.userPaused) engine.userPaused.add(infoHash);
        else if (previous.queued) engine.autoQueued.push(infoHash);
      } else {
        await engine.resume(infoHash);
      }
    } catch (error) {
      torrentErrors.set(infoHash, `Transfer ${infoHash} could not be restored during rollback.`);
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'One or more torrent changes could not be fully rolled back.');
}

async function rollbackTorrentTransaction(torrents, inventorySnapshot) {
  const failures = [];
  try { await rollbackTorrentIntents(torrents); } catch (error) { failures.push(error); }
  try { restoreInventory(inventorySnapshot); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'The torrent transaction could not be fully rolled back.');
}

function nestedErrors(error) {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(nestedErrors)] : [error];
}

async function rejectTorrentTransaction(operationError, torrents, inventorySnapshot, restoreAdditional = () => {}) {
  const rollbackErrors = [];
  try { await rollbackTorrentTransaction(torrents, inventorySnapshot); }
  catch (error) { rollbackErrors.push(...nestedErrors(error)); }
  try { await restoreAdditional(); }
  catch (error) { rollbackErrors.push(...nestedErrors(error)); }
  if (rollbackErrors.length) {
    const detail = boundedText(rollbackErrors.map(error => error?.message || String(error)).join(' '), 1500, 'Inspect Spark status before retrying.');
    const failure = new AggregateError([operationError, ...rollbackErrors], `The transfer change failed and rollback was incomplete. ${detail} Inspect Spark status before retrying.`);
    failure.rollbackIncomplete = true;
    throw failure;
  }
  throw operationError;
}

async function dispatchAction(request, client) {
  switch (request.action) {
    case 'assistant:models': return assistantModels(assistantDeviceId());
    case 'assistant:chat:start': return assistantChatStart({ ...request, deviceId: assistantDeviceId() }, client);
    case 'assistant:chat:cancel': return assistantChatCancel(request.stream);
    case 'ipfs:inspect': return ipfs.inspect(request.source);
    case 'ipfs:add': return ipfs.add(request);
    case 'ipfs:control':
      if (request.operation === 'kind') {
        if (!validContentKind(request.kind)) throw new Error('Choose a download category.');
        ipfs.record(request.id).kind = request.kind; ipfs.persist();
      } else await ipfs.control(request.operation, request.id);
      return true;
    case 'ipfs:sharing': await ipfs.sharing(request.id, request.enabled); return true;
    case 'status': {
      if (!torrentTransactionDepth) {
        const inventoryChanged = syncInventory();
        if (inventoryChanged || torrentPersistencePending) {
          persist();
          torrentPersistencePending = false;
        }
      }
      const storage = storageRoots.map(root => {
        try { requireStorage(root); const disk = fs.statfsSync(root); return { path: root, freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize, available: true }; }
        catch (error) { return { path: root, freeBytes: 0, totalBytes: 0, available: false, error: error.message }; }
      });
      const disk = storage.find(item => item.path === downloadDir);
      const hardware = await getDeviceInfo();
      const aeon = await readAeonCapabilities(hardware);
      void ipfs.sampleStats(); void ipfs.sampleInventory();
      return { version, protocolVersion: COMPANION_PROTOCOL_VERSION, ipfs: ipfs.snapshot(), ...(aeon ? { aeon } : {}), hostname: process.env.FROSTBYTE_DEVICE || os.hostname(), architecture: os.arch(),
        hardware, capabilities: { downloads: true, sharing: true, storage: true, ipfs: fs.existsSync(path.join(ipfsBinaryDirectory, 'runtime.json')),
          torrentFileDeletion: true, inventoryFileDeletion: true, assistant: 1, runtime: process.platform === 'darwin' ? 'mac-native' : 'docker' },
        downloadDir, storageRoots, storage, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes,
        memoryBytes: os.totalmem(), uptime: process.uptime(), inventory: listInventory(), inventoryControls: true, hfHybrid: 1,
        torrents: [...engine.list().map(torrent => ({ ...torrent, destination: rootFor(torrent.path), error: torrentErrors.get(torrent.infoHash) || '' })), ...[...deferredTorrents.values()].map(record => ({ infoHash: record.infohash, name: record.name || record.infohash, path: record.path, destination: record.path, paused: true, done: false, ready: false, progress: 0, files: [], error: torrentErrors.get(record.infohash) }))], downloads: [...downloads.values()].map(publicDownload) };
    }
    case 'device:telemetry': {
      const hardware = await getDeviceInfo();
      const storage = storageRoots.map(root => {
        try { requireStorage(root); const disk = fs.statfsSync(root); return { path: root, freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize, available: true }; }
        catch (error) { return { path: root, freeBytes: 0, totalBytes: 0, available: false, error: error.message }; }
      });
      const disk = storage.find(item => item.path === downloadDir) || storage[0];
      let docker = [];
      try {
        const { stdout } = await execFileAsync('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 5000, maxBuffer: 1024 * 1024 });
        docker = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).slice(0, 64);
      } catch { /* Docker is optional; report the capability below. */ }
      return { schema: 1, collectedAt: new Date().toISOString(), hostname: process.env.FROSTBYTE_DEVICE || os.hostname(), architecture: os.arch(),
        uptimeSeconds: os.uptime(), load: os.loadavg(), memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
        storage: disk || null, docker: { available: docker.length > 0, containers: docker }, capabilities: { docker: docker.length > 0, gpu: false, power: false },
        companion: { downloads: downloads.size, torrents: engine.list().length } };
    }
    case 'device:recipes': {
      const recipes = Array.isArray(request.recipes) ? request.recipes : [];
      return { schema: 1, recipes: recipes.slice(0, 32).map(recipe => ({ id: String(recipe.id || ''), title: String(recipe.title || recipe.id || ''), kind: recipe.kind === 'tmux' ? 'tmux' : 'docker', state: 'unknown' })) };
    }
    case 'device:control': {
      if (!['check', 'start', 'stop'].includes(request.operation)) throw new Error('Unsupported Spark model operation.');
      if (typeof request.recipeId !== 'string' || !request.recipeId || request.recipeId.length > 128) throw new Error('A valid model recipe is required.');
      if (request.operation !== 'check') throw new Error('Model control is not installed on this Spark yet.');
      return { schema: 1, operation: request.operation, recipeId: request.recipeId, state: 'unsupported', message: 'Install the restricted FrostByte Spark host service before starting or stopping a model.' };
    }
    case 'files': {
      const root = requireStorage(request.root || downloadDir);
      const directory = inside(request.relative, root);
      const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && !/\.frostpart(?:\.json)?$/.test(entry.name) && !entry.isSymbolicLink());
      return { root, relative: path.relative(root, directory), truncated: entries.length > 1000,
        entries: entries.slice(0, 1000).map(entry => {
          const stat = fs.statSync(path.join(directory, entry.name));
          return { name: entry.name, relative: path.relative(root, path.join(directory, entry.name)), directory: entry.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() };
        }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
    }
    case 'torrent:add': {
      const hasMetadata = request.metadata !== undefined;
      if (!hasMetadata && !extractInfoHash(request.source)) throw new Error('Spark accepts a magnet, infohash, or uploaded torrent metadata.');
      if (hasMetadata && (typeof request.metadata !== 'string' || !request.metadata ||
          request.metadata.length > Math.ceil(MAX_TORRENT_METADATA_BYTES / 3) * 4 ||
          request.metadata.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(request.metadata))) {
        throw new Error('Torrent metadata is invalid or too large.');
      }
      const input = hasMetadata ? Buffer.from(request.metadata, 'base64') : request.source;
      if (hasMetadata && (input.length > MAX_TORRENT_METADATA_BYTES || input.toString('base64') !== request.metadata)) throw new Error('Torrent metadata is invalid or too large.');
      const destination = requireStorage(request.destination || downloadDir);
      const metadata = hasMetadata ? await parseTorrent(input) : null;
      if (metadata) for (const file of validateTorrentLayout(metadata)) safeTarget(destination, path.resolve(destination, file.path));
      const existing = engine.list().find(torrent => torrent.infoHash === (metadata?.infoHash || extractInfoHash(request.source)));
      if (existing && rootFor(existing.path) !== destination) throw new Error('This torrent is already downloading to another storage folder. Remove its transfer before choosing a different destination.');
      const priorTorrents = snapshotTorrentIntents(), priorInventory = new Map(inventory);
      try {
        const torrent = await engine.add(input, { path: destination, selectedPaths: request.selectedPaths, kind: request.kind });
        commitTorrentState(); return torrent;
      } catch (error) {
        await rejectTorrentTransaction(error, priorTorrents, priorInventory);
      }
    }
    case 'torrent:pause': {
      const priorTorrents = snapshotTorrentIntents(), priorInventory = new Map(inventory);
      const priorDeferred = new Map([...deferredTorrents].map(([id, record]) => [id, { ...record }]));
      try {
        if (deferredTorrents.has(request.id)) deferredTorrents.get(request.id).paused = true;
        else await engine.pause(request.id);
        commitTorrentState(); return true;
      } catch (error) {
        await rejectTorrentTransaction(error, priorTorrents, priorInventory, () => restoreMap(deferredTorrents, priorDeferred));
      }
    }
    case 'torrent:resume': {
      const record = deferredTorrents.get(request.id) || engine.sessions().find(item => item.infohash === request.id);
      if (!record) throw new Error('Download no longer exists.');
      await validateTorrent(record);
      const priorTorrents = snapshotTorrentIntents(), priorInventory = new Map(inventory);
      const priorDeferred = new Map([...deferredTorrents].map(([id, saved]) => [id, { ...saved }])), priorErrors = new Map(torrentErrors);
      try {
        if (deferredTorrents.has(request.id)) { await engine.restore({ ...record, paused: false }); deferredTorrents.delete(request.id); }
        else await engine.resume(request.id);
        torrentErrors.delete(request.id); commitTorrentState(); return true;
      } catch (error) {
        await rejectTorrentTransaction(error, priorTorrents, priorInventory, () => {
          restoreMap(deferredTorrents, priorDeferred);
          restoreMap(torrentErrors, priorErrors);
        });
      }
    }
    case 'torrent:remove': {
      const priorTorrents = snapshotTorrentIntents(), priorInventory = new Map(inventory);
      const priorDeferred = new Map([...deferredTorrents].map(([id, saved]) => [id, { ...saved }])), priorErrors = new Map(torrentErrors);
      const liveSession = engine.sessions().find(item => item.infohash === request.id);
      const restoreRecord = liveSession ? await validateTorrent(liveSession) : null;
      const deleteData = request.deleteData === true;
      if (request.deleteData !== undefined && typeof request.deleteData !== 'boolean') throw new Error('Choose whether downloaded files should be deleted.');
      if (deleteData) {
        const expected = request.expected;
        const keys = expected && typeof expected === 'object' && !Array.isArray(expected) ? Object.keys(expected) : [];
        if (keys.length !== 3 || !keys.every(key => ['infoHash', 'dataPath', 'sessionGeneration'].includes(key))
          || typeof expected.infoHash !== 'string' || expected.infoHash.toLowerCase() !== request.id
          || typeof expected.dataPath !== 'string' || !path.isAbsolute(expected.dataPath) || path.resolve(expected.dataPath) !== expected.dataPath
          || !Number.isSafeInteger(expected.sessionGeneration) || expected.sessionGeneration < 1) {
          throw new Error('The reviewed transfer deletion identity is invalid.');
        }
        const current = engine.transferIdentity(request.id);
        if (!current || current.infoHash !== expected.infoHash.toLowerCase() || current.dataPath !== expected.dataPath
          || current.sessionGeneration !== expected.sessionGeneration || !engine.isCurrentIdentity(current)) {
          throw new Error('The transfer or downloaded path changed after review. Review deletion again.');
        }
        rootFor(current.dataPath);
      }
      try {
        syncInventory(); deferredTorrents.delete(request.id); torrentErrors.delete(request.id);
        await engine.remove(request.id, deleteData);
        if (deleteData) {
          for (const [inventoryId, entry] of inventory) {
            if (String(entry.infoHash || '').toLowerCase() === request.id) inventory.delete(inventoryId);
          }
        }
        commitTorrentState(); return true;
      } catch (error) {
        let fallbackRecord = null;
        let restoreFailure = null;
        if (restoreRecord && !engine.list().some(torrent => torrent.infoHash === request.id)) {
          try { await engine.restore(restoreRecord); }
          catch (restoreError) {
            fallbackRecord = { ...restoreRecord, paused: true };
            restoreFailure = restoreError;
          }
        }
        await rejectTorrentTransaction(error, priorTorrents, priorInventory, () => {
          restoreMap(deferredTorrents, priorDeferred);
          restoreMap(torrentErrors, priorErrors);
          if (fallbackRecord) {
            deferredTorrents.set(request.id, fallbackRecord);
            torrentErrors.set(request.id, 'The transfer was safely paused after its state could not be restored in memory.');
          }
          if (restoreFailure) throw restoreFailure;
        });
      }
    }
    case 'inventory:remove': return itemJob(request.id, async () => {
      const entry = inventory.get(request.id);
      if (!entry || request.proof !== inventoryProof(entry)) throw new Error('The exact device copy changed. Review deletion again.');
      requireStorage(entry.destination);
      if ([...downloads.values()].some(row => row.status !== 'done' && beneath(entry.path, row.dest))) throw new Error('Finish or safely resolve retained downloads in this copy before deleting its files.');
      const localRow = { ...entry, files: entry.files.map(file => ({ relative: path.relative(entry.destination, inventoryFilePath(entry, file)).split(path.sep).join('/'), size: file.size, revision: file.revision })) };
      const owned = new DownloadInventory({ state: { downloadedItems: [localRow] }, _flush() {} });
      if (owned.rows.length !== 1) throw new Error('The device ownership manifest needs recovery.');
      const plan = owned.deletionPlan(owned.rows[0].id);
      const live = engine.list().filter(row => row.inventoryId === entry.id || row.infoHash === entry.infoHash || row.dataPath === entry.path);
      const operation = { id: entry.id, proof: inventoryProof(entry), phase: 'prepared', hashes: live.map(row => row.infoHash) };
      if (entryRemovalIntents.size >= 500 && !entryRemovalIntents.has(entry.id)) throw new Error('Resolve pending device removals first.');
      entryRemovalIntents.set(entry.id, operation); persist(downloads, { commitTorrentTransaction: true });
      for (const torrent of live) await engine.remove(torrent.infoHash, false);
      for (const [hash, record] of deferredTorrents) if (record.inventoryId === entry.id || hash === entry.infoHash) deferredTorrents.delete(hash);
      persist(downloads, { commitTorrentTransaction: true });
      requireStorage(entry.destination); owned.deleteFiles(plan, { forget: false });
      operation.phase = 'files-complete'; persist(downloads, { commitTorrentTransaction: true });
      const priorDownloads = new Map(downloads);
      const targets = new Set(entry.files.map(file => inventoryFilePath(entry, file)));
      for (const [id, record] of downloads) if (targets.has(record.dest)) downloads.delete(id);
      inventory.delete(entry.id); entryRemovalIntents.delete(entry.id);
      try { persist(downloads, { commitTorrentTransaction: true }); }
      catch (error) { inventory.set(entry.id, entry); entryRemovalIntents.set(entry.id, operation); downloads.clear(); for (const [id, row] of priorDownloads) downloads.set(id, row); throw new Error('Device files were deleted; metadata reconciliation needs retry: ' + error.message); }
      return true;
    });
    case 'inventory:kind': {
      if (!inventory.has(request.id)) throw new Error('This item is no longer in the inventory.');
      if (!validContentKind(request.kind)) throw new Error('Choose My Models or Torrents.');
      const hadKind = itemKinds.has(request.id), previousKind = itemKinds.get(request.id);
      itemKinds.set(request.id, request.kind);
      try { persist(); return true; }
      catch (error) {
        if (hadKind) itemKinds.set(request.id, previousKind); else itemKinds.delete(request.id);
        throw error;
      }
    }
    case 'inventory:sharing': return itemJob(request.id, async () => {
      if (typeof request.enabled !== 'boolean') throw new Error('Choose whether sharing is on or off.');
      const entry = inventory.get(request.id);
      if (!entry) throw new Error('This item is no longer in the inventory.');
      const live = engine.list().filter(torrent => torrent.inventoryId === entry.id || torrent.infoHash === entry.infoHash || (!torrent.inventoryId && torrent.dataPath === entry.path));
      const priorTorrents = snapshotTorrentIntents(), priorInventory = new Map(inventory);
      const priorDeferred = new Map([...deferredTorrents].map(([id, record]) => [id, record.paused]));
      try {
        if (!request.enabled) {
          for (const torrent of live) await engine.setSharing(torrent.infoHash, false);
          // Disconnected storage can defer a session; Off must remain sticky too.
          for (const record of deferredTorrents.values()) if (record.inventoryId === entry.id || record.infohash === entry.infoHash) record.paused = true;
        } else {
          const available = listInventory().find(item => item.id === entry.id);
          if (!available?.available) throw new Error(available?.error || 'Restore the missing files before sharing.');
          if ([...downloads.values()].some(record => ['active', 'queued'].includes(record.status) && beneath(entry.path, record.dest))) throw new Error('Finish downloads in this model before sharing it.');
          if (live.length) {
            for (const torrent of live) { await validateTorrent(torrent); await engine.setSharing(torrent.infoHash, true); }
          } else {
            if (entry.path === entry.destination) throw new Error('Resume the original torrent to share this file selection.');
            const files = entry.files.map(file => ({ path: inventoryFilePath(entry, file), size: file.size }));
            await engine.seed(entry.path, { files, inventoryId: entry.id });
          }
        }
        commitTorrentState(); return true;
      } catch (error) {
        await rejectTorrentTransaction(error, priorTorrents, priorInventory, () => {
          for (const [id, paused] of priorDeferred) if (deferredTorrents.has(id)) deferredTorrents.get(id).paused = paused;
        });
      }
    });
    case 'seed': {
      const target = inside(request.relative, request.root || downloadDir);
      if ([...downloads.values()].some(record => record.status !== 'done' && (record.dest === target || record.dest.startsWith(target + path.sep)))) throw new Error('Finish downloads in this folder before sharing it.');
      if (engine.list().some(torrent => !torrent.done && !torrent.explicitShare && torrent.dataPath && (torrent.dataPath === target || torrent.dataPath.startsWith(target + path.sep)))) throw new Error('Finish this download before sharing it.');
      const priorTorrents = snapshotTorrentIntents(), priorInventory = new Map(inventory);
      try {
        const torrent = await engine.seed(target);
        commitTorrentState(); return torrent;
      } catch (error) {
        await rejectTorrentTransaction(error, priorTorrents, priorInventory);
      }
    }
    case 'hf:peer': {
      const requested = validateIdentity(request.identity);
      const shared = entry => engine.list().some(t => t.seeding && (t.inventoryId === entry.id || t.infoHash === entry.infoHash || (!t.inventoryId && t.dataPath === entry.path)));
      // Only inspect inventory files already selected for sharing. Size/name
      // narrow the work; a full SHA-256 comparison establishes the identity.
      const candidates = [...inventory.values()].filter(shared).flatMap(entry => entry.files.filter(file => file.size === requested.size).map(file => ({ entry, file })))
        .sort((a, b) => Number(b.entry.repoId === requested.repoId) - Number(a.entry.repoId === requested.repoId) || Number(path.basename(b.file.path || b.entry.path) === path.basename(requested.filePath)) - Number(path.basename(a.file.path || a.entry.path) === path.basename(requested.filePath))).slice(0, 8);
      if (!candidates.length) return null;
      const identity = await getHybridIdentity(requested);
      if (!identity || identityKey(identity) !== identityKey(requested)) return null;
      const priorTorrents = snapshotTorrentIntents(), priorInventory = new Map(inventory);
      try {
        for (const { entry, file } of candidates) {
          const result = await itemJob(entry.id, async () => {
            const live = engine.list().filter(t => t.inventoryId === entry.id || (!t.inventoryId && t.dataPath === entry.path));
            if (!live.some(t => t.seeding)) return null; // lookup never opts the user into sharing
            const target = safeTarget(entry.destination, inventoryFilePath(entry, file), { mustExist: true });
            const stat = fs.statSync(target), stamp = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
            const key = identityKey(identity) + ':' + entry.id + ':' + file.path, previous = hybridManifests.get(key);
            let metadata;
            try { metadata = previous?.stamp === stamp ? previous.metadata : await createHybridManifest(target, identity); }
            catch (error) { if (error.message.includes('does not match')) return null; throw error; }
            hybridManifests.set(key, { stamp, metadata });
            // A renamed file needs a store mapping before it can join this swarm.
            // Keep the beta's zero-copy seeder restricted to the canonical basename.
            if (path.basename(target) !== path.basename(identity.filePath)) return null;
            const parsed = await parseTorrent(metadata), existing = await engine.client.get(parsed.infoHash);
            if (existing && (existing._inventoryId !== entry.id || existing.path !== path.dirname(target))) return null;
            const seeded = await engine.add(metadata, { path: path.dirname(target), inventoryId: entry.id, explicitShare: true, hfSource: true, allowExisting: true });
            const torrent = await engine.client.get(seeded.infoHash);
            torrent._hfSource = true;
            if (torrent.paused) await engine.resume(torrent.infoHash);
            const peers = Object.values(os.networkInterfaces()).flat().filter(address => address.family === 'IPv4' && !address.internal)
              .map(address => address.address + ':' + engine.port).slice(0, 8);
            commitTorrentState(); return { identity, metadata: metadata.toString('base64'), peers };
          });
          if (result) return result;
        }
        return null;
      } catch (error) {
        await rejectTorrentTransaction(error, priorTorrents, priorInventory);
      }
    }
    case 'hf:add': {
      if (!/^[a-f0-9]{40}$/i.test(request.revision || '')) throw new Error('Select a pinned HuggingFace version first.');
      if (!Array.isArray(request.files) || !request.files.length || request.files.length > 2000) throw new Error('Choose between 1 and 2000 files.');
      const destination = requireStorage(request.destination || downloadDir);
      validateHfDownloadSelection(request.repoId, request.files.map(file => file?.path));
      const records = request.files.map(file => {
        if (!file || typeof file !== 'object' || !validSize(file.size ?? 0) || (file.size ?? 0) > MAX_HF_FILE_BYTES) throw new Error('HuggingFace file size is invalid.');
        const dest = hfDestination(destination, request.repoId, file.path);
        safeTarget(destination, dest);
        const id = crypto.createHash('sha256').update(`${hfDestinationPathKeys(dest)[0]}\0${request.revision.toLowerCase()}`).digest('hex');
        return { ...normalizeSavedDownload({ id, repoId: request.repoId, revision: request.revision, filePath: file.path, destination, dest, total: file.size || 0, downloaded: 0, progress: 0, status: 'queued', error: '' }), token: request.token || undefined };
      });
      const futureIds = new Set([...downloads.keys(), ...records.map(record => record.id)]);
      const futurePathBytes = [...downloads.values(), ...records.filter(record => !downloads.has(record.id))]
        .reduce((sum, record) => sum + Buffer.byteLength(`${record.repoId}\0${record.filePath}\0${record.dest}\0${record.destination || ''}`, 'utf8'), 0);
      if (futureIds.size > MAX_SAVED_DOWNLOADS || futurePathBytes > MAX_SAVED_DOWNLOAD_PATH_BYTES) throw new Error('Spark has reached its safe saved download limit. Clear completed transfers before adding more.');
      for (const record of records) {
        const namespaceKeys = hfDestinationPathKeys(record.dest), namespace = new Set(namespaceKeys);
        for (const item of downloads.values()) {
          if (item.id === record.id) continue;
          const other = hfDestinationPathKeys(item.dest);
          if (!other.some(key => namespace.has(key))) continue;
          const sameFile = item.repoId === record.repoId && item.filePath === record.filePath && other[0] === namespaceKeys[0];
          if (sameFile && !['active', 'queued'].includes(item.status)) continue;
          throw new Error(sameFile
            ? 'Another version of this file is downloading. Wait for it to finish first.'
            : 'A selected HuggingFace file conflicts with another download filename.');
        }
      }
      const nextDownloads = new Map(downloads);
      for (const record of records) {
        const existing = nextDownloads.get(record.id);
        if (existing && (['active','queued'].includes(existing.status) || (existing.status === 'done' && completedDownloadPresent(existing)))) continue;
        requireEmptyDownloadDestination(record);
        nextDownloads.set(record.id, record);
      }
      // Persist the proposed queue before publishing it to the worker. If the
      // atomic state write fails, the rejected RPC leaves no hidden work behind.
      persist(nextDownloads);
      downloads.clear();
      for (const [id, record] of nextDownloads) downloads.set(id, record);
      pump(); return records.map(record => record.id);
    }
    case 'hf:pause': {
      const record = downloads.get(request.id); if (!record) throw new Error('Download no longer exists.');
      if (record.controller) {
        // A durable active row restores paused after a crash. Prove the state
        // file is writable before making the abort irreversible.
        persist(); record.controller.abort();
      } else if (record.status === 'queued') {
        record.status = 'paused';
        try { persist(); }
        catch (error) { record.status = 'queued'; throw error; }
        delete record.token;
      }
      return true;
    }
    case 'hf:resume': {
      const record = downloads.get(request.id); if (!record) throw new Error('Download no longer exists.');
      if (record.removed) throw new Error('Restore this retained transfer before resuming it.');
      validateDownload(record);
      if (!record.controller && ['paused','error'].includes(record.status)) {
        const previous = { status: record.status, error: record.error, token: record.token };
        record.status = 'queued'; record.error = ''; record.token = request.token || undefined;
        try { persist(); } catch (error) { Object.assign(record, previous); throw error; }
        pump();
      }
      return true;
    }
    case 'hf:clear': {
      syncInventory();
      const nextDownloads = new Map(downloads);
      for (const [id, record] of nextDownloads) if (record.status === 'done' && !record.controller) nextDownloads.delete(id);
      persist(nextDownloads);
      downloads.clear(); for (const [id, record] of nextDownloads) downloads.set(id, record);
      return true;
    }
    case 'hf:remove': {
      syncInventory();
      const record = downloads.get(request.id);
      if (record?.controller) throw new Error('Pause this download before removing it.');
      const nextDownloads = new Map(downloads); nextDownloads.delete(request.id);
      if (record && record.status !== 'done') nextDownloads.set(request.id, { ...record, status: 'paused', removed: true, token: undefined });
      persist(nextDownloads);
      downloads.clear(); for (const [id, item] of nextDownloads) downloads.set(id, item);
      return true;
    }
    case 'hf:restore': {
      const record = downloads.get(request.id); if (!record || !record.removed) throw new Error('Retained download not found.');
      record.removed = false; try { persist(); } catch (error) { record.removed = true; throw error; } return true;
    }
    default: throw new Error('Unsupported Spark action.');
  }
}

const STATE_MUTATION_ACTIONS = new Set([
  'torrent:add', 'torrent:pause', 'torrent:resume', 'torrent:remove',
  'inventory:kind', 'inventory:sharing', 'inventory:remove', 'seed', 'hf:peer',
  'hf:add', 'hf:pause', 'hf:resume', 'hf:clear', 'hf:remove', 'hf:restore',
  'device:control',
]);
const TORRENT_TRANSACTION_ACTIONS = new Set([
  'torrent:add', 'torrent:pause', 'torrent:resume', 'torrent:remove',
  'inventory:sharing', 'inventory:remove', 'seed', 'hf:peer',
]);

async function serializeStateMutation(work) {
  let release;
  const previous = stateMutationTail;
  stateMutationTail = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await work(); }
  finally { release(); }
}

async function dispatch(request, client) {
  if (stopping) throw new Error('Spark is shutting down and is not accepting new requests.');
  const work = async () => {
    const torrentTransaction = TORRENT_TRANSACTION_ACTIONS.has(request.action);
    if (torrentTransaction) torrentTransactionDepth++;
    try { return await dispatchAction(request, client); }
    catch (error) {
      // Even an atomic writer can report a post-publication durability error.
      // Re-publish the rolled-back snapshot after the handler has undone the
      // in-memory mutation, rather than trusting the previous file contents.
      if (torrentTransaction) torrentPersistencePending = true;
      throw error;
    }
    finally {
      if (torrentTransaction) {
        torrentTransactionDepth--;
        if (!torrentTransactionDepth && torrentPersistencePending) {
          try { syncInventory(); persist(); torrentPersistencePending = false; }
          catch (error) { console.error('Torrent state:', error.message); }
        }
      }
    }
  };
  return STATE_MUTATION_ACTIONS.has(request.action) ? serializeStateMutation(work) : work();
}

try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
function finishSocket(socket, result) {
  if (socket.destroyed) return Promise.resolve();
  let output;
  try { output = JSON.stringify(result) + '\n'; }
  catch { output = '{"ok":false,"error":"Spark could not encode the response."}\n'; }
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.off('close', done);
      resolve();
    };
    socket.once('close', done);
    try { socket.end(output, done); } catch { socket.destroy(); done(); }
  });
}

function trackWork(set, work, onError) {
  set.add(work);
  const settlement = work.then(
    () => set.delete(work),
    error => {
      set.delete(work);
      try { onError?.(error); } catch (reportError) { console.error('Spark work reporting:', reportError?.message || reportError); }
    },
  );
  settlement.catch(error => console.error('Spark work settlement:', error?.message || error));
  return work;
}

async function settleWork(set) {
  while (set.size) await Promise.allSettled([...set]);
}

// A client may half-close once its request line is sent; the 2.0.0 pairing
// helper installed on paired devices does. Keep the writable side open so the
// reply still reaches it.
const server = net.createServer({ allowHalfOpen: true }, socket => {
  acceptedSockets.add(socket);
  let input = '', handled = false, streaming = false;
  socket.setTimeout(30000, () => socket.destroy());
  socket.on('error', () => {});
  socket.once('close', () => { acceptedSockets.delete(socket); runningSockets.delete(socket); });
  // Nothing left to answer, or a chat whose peer went away: close, which also
  // cancels the generation below.
  socket.on('end', () => { if (!handled || streaming) socket.destroy(); });
  socket.on('data', chunk => {
    if (handled) return;
    input += chunk;
    if (input.length > 12 * 1024 ** 2) { socket.destroy(); return; }
    const end = input.indexOf('\n'); if (end === -1) return;
    handled = true;
    if (stopping) {
      void finishSocket(socket, { ok: false, error: 'Spark is shutting down and is not accepting new requests.' });
      return;
    }
    const requestWork = Promise.resolve().then(() => {
      const request = JSON.parse(input.slice(0, end));
      const action = request.action;
      if (action === 'assistant:chat:start') {
        streaming = true;
        // If the desktop disconnects mid-stream (Stop, quit, crash), abort the
        // companion-side generation instead of running it to completion.
        socket.once('close', () => { try { assistantChatCancel(request.stream); } catch { /* Stream already finished. */ } });
      }
      if (action === 'seed' || action === 'hf:peer' || action === 'ipfs:sharing' || action === 'assistant:chat:start' || action === 'inventory:sharing' && request.enabled === true) socket.setTimeout(30 * 60 * 1000);
      return dispatch(request, { write: frame => { try { socket.write(frame); } catch { try { assistantChatCancel(request.stream); } catch { /* already finished */ } } }, end: () => socket.end() }).then(
        data => action === 'assistant:chat:start' ? Promise.resolve() : finishSocket(socket, { ok: true, data }),
      );
    })
      .catch(error => finishSocket(socket, { ok: false, error: boundedText(error?.message, 4000, 'Spark request failed.') }));
    runningSockets.add(socket);
    trackWork(acceptedWork, requestWork, error => console.error('Spark request:', error?.message || error));
  });
});
const timer = setInterval(() => {
  try { persist(); torrentPersistencePending = false; } catch (error) { console.error('HF state:', error.message); }
}, 5000);
let checkingStorage = false;
async function checkActiveStorage() {
  if (checkingStorage || stopping || torrentTransactionDepth) return;
  checkingStorage = true;
  try {
    for (const record of downloads.values()) {
      if (!record.controller || record.controller.signal.aborted) continue;
      try { validateDownload(record); }
      catch (error) { record.storageError = error.message; record.controller.abort(); }
    }
    for (const torrent of engine.list()) {
      if (torrent.paused) continue;
      try { await validateTorrent(torrent); }
      catch (error) { torrentErrors.set(torrent.infoHash, error.message); await engine.pause(torrent.infoHash); }
    }
  } finally { checkingStorage = false; }
}
const storageTimer = setInterval(() => {
  const work = checkActiveStorage();
  trackWork(backgroundWork, work, error => console.error('Storage:', error.message));
}, 500);
let stopPromise;
function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  clearInterval(timer); clearInterval(storageTimer);
  const failures = [];
  let closeServer;
  const serverClosed = new Promise(resolve => { closeServer = resolve; });
  try {
    server.close(error => {
      if (error) failures.push(error);
      closeServer();
    });
  } catch (error) { failures.push(error); closeServer(); }
  // Connections that have not submitted a complete request must not keep the
  // Unix socket open or dispatch work after shutdown has begun.
  for (const socket of acceptedSockets) if (!runningSockets.has(socket)) socket.destroy();
  for (const record of downloads.values()) record.controller?.abort();
  void stopAssistantChats();
  stopPromise = (async () => {
    await settleWork(acceptedWork);
    await stateMutationTail;
    await settleWork(backgroundWork);
    const pendingJobs = await Promise.allSettled([...jobs, ...itemJobs.values()]);
    for (const result of pendingJobs) if (result.status === 'rejected') failures.push(result.reason);
    try { persist(); }
    catch (error) { failures.push(new Error(`Final Spark state could not be saved: ${error.message}`, { cause: error })); }
    try { await ipfs.close(); } catch (error) { failures.push(error); }
    try { await engine.destroy(); }
    catch (error) { failures.push(new Error(`Spark transfer engine could not stop cleanly: ${error.message}`, { cause: error })); }
    for (const socket of acceptedSockets) socket.destroy();
    await serverClosed;
    try { fs.unlinkSync(socketPath); }
    catch (error) { if (error.code !== 'ENOENT') failures.push(error); }
    for (const error of failures) console.error('Spark shutdown:', error?.message || error);
    return failures.length ? 1 : 0;
  })();
  return stopPromise;
}
let signalHandled = false;
function handleStopSignal() {
  if (signalHandled) return;
  signalHandled = true;
  // Docker grants this service 40 seconds for SIGTERM. Exit nonzero first if
  // accepted work or a dependency never settles, leaving the atomic state and
  // installer records for the next start instead of hanging indefinitely.
  const deadline = setTimeout(() => {
    console.error('Spark shutdown exceeded 35 seconds; exiting with recovery state retained.');
    process.exit(1);
  }, 35_000);
  void stop().then(
    code => { clearTimeout(deadline); process.exit(code); },
    error => { clearTimeout(deadline); console.error('Spark shutdown:', error?.message || error); process.exit(1); },
  );
}
process.on('SIGTERM', handleStopSignal); process.on('SIGINT', handleStopSignal);
// A caller can stop the service as soon as this socket appears. Finish the
// shutdown setup before publishing it, including both timer handles used by stop.
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
fs.chmodSync(socketPath, 0o600);
console.log('FrostByte Spark agent ready');
