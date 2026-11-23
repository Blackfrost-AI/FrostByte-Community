/**
 * Tiny JSON-file store for settings and the user's catalog.
 * No database, no schema migrations, no surprises — you can read it with cat.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { validContentKind } from '../shared/content-kind.js';
import { normalizePublisherRecord } from './publisher-record.js';
import { THEME_IDS, LEGACY_BLACKFROST_SCENE_IDS } from '../shared/appearance.js';

/**
 * Canonical Hub-URL check, self-contained so store.js stays free of hub-desktop
 * imports (it ships inside the reviewed Spark companion payload). HTTPS-only
 * (no loopback HTTP exemption), no credentials/query/fragment/trailing-slash,
 * default port omitted, clean path segments allowed (e.g. /api/api).
 */
function canonicalHubUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (url.port === '443') return null;
  if (url.pathname.includes('//') || url.pathname.split('/').some(seg => seg === '.' || seg === '..')) return null;
  const cleanPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${cleanPath}`;
}

function isCanonicalHubOrigin(value) {
  const canonical = canonicalHubUrl(value);
  return canonical !== null && canonical === value;
}

const STORE_PROFILE = 'frostbyte';

const APP_DIR =
  process.env.FROSTBYTE_HOME ||
  path.join(
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') :
    process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')) :
    (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')),
    STORE_PROFILE,
  );

const STATE_FILE = path.join(APP_DIR, 'state.json');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;

const DEFAULTS = {
  downloadDir: path.join(os.homedir(), 'FrostByte'),
  seedOnComplete: true,
  catalogUrl: '',
  theme: 'frost',
  // Legacy appearance values are retained, not used by the current theme.
  blackfrostSnow: true,
  blackfrostScene: 'glacier',
  sparkHost: '',
  sparkDownloadHost: '',
  sparkDownloadDir: '',

  /* connection */
  maxConns: 55,
  dhtEnabled: true,      // constructor-bound: changing needs a restart
  upnpEnabled: false,
  extraTrackers: '',     // one URL per line; appended to every pull

  /* bandwidth (KB/s, 0 = unlimited) */
  bandwidthMode: 'normal', // sticky choice; only schedule mode can switch automatically
  downLimitKBs: 0,
  upLimitKBs: 0,
  altDownKBs: 300,
  altUpKBs: 30,
  schedEnabled: false,
  schedFrom: '18:00',
  schedTo: '08:00',
  schedDays: [1, 1, 1, 1, 1, 1, 1], // Sun..Sat

  /* queueing */
  maxActiveDownloads: 0, // 0 = unlimited

  /* seeding goals (0 = never stop) */
  seedRatioStop: 0,
  seedMinutesStop: 0,

  /* folders */
  moveCompleted: false,
  completedDir: '',

  /* interface */
  confirmBigPull: true,
  modelCardImages: true,
  bigPullGB: 50,
  confirmExitSeeding: true,
  openAtLogin: false,
  autoCheckUpdates: false,
};

const STATE_DEFAULTS = {
  userCatalog: [], library: [], downloadedItems: [], transfers: [],
  hfDownloads: [], hiddenCatalog: [], completionMoves: [],
  hubEntitlement: { tier: 'free', status: 'inactive', source: 'local', fetchedAt: 0, currentPeriodEnd: null, entitlements: {} },
  hubConfig: { hubUrl: '', follows: [], bundleDigest: '' },
  hubAccount: { signedIn: false, uid: '', email: '', displayName: '', photoUrl: '', verifiedAt: 0, origin: '', tenantId: '', desktopSessionId: '' },
  hubUpdates: { fetchedAt: 0, nudges: [] },
};
// NOTE: hubRefreshEnc / hubRefreshOrigin (Firebase refresh token, encrypted via
// safeStorage, bound to its Hub origin) are intentionally NOT in STATE_DEFAULTS:
// the load-time normalizer resets non-object defaults, which would wipe these
// string fields. Like hfTokenEnc, they are managed solely by
// setHubRefreshCredential/getHubRefreshCredential and cleared on sign-out.
const STATE_ARRAY_LIMITS = {
  userCatalog: 5000, downloadedItems: 10_000,
  hfDownloads: 10_000, hiddenCatalog: 5000,
  completionMoves: 2000,
};
const MAX_SAVED_TORRENT_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ITEM_KINDS = 10_000;
const APPROVED_TRACKERS = new Set(['udp://tracker.opentrackr.org:1337/announce']);

/** Unsafe tracker endpoints exist only for source-tree Electron tests. A
 * packaged executable cannot make `process.defaultApp` true with argv/env. */
export function allowTestTrackerEndpoints({
  argv = process.argv,
  env = process.env,
  defaultApp = process.defaultApp,
  electronVersion = process.versions.electron,
} = {}) {
  return defaultApp === true && typeof electronVersion === 'string' && electronVersion.length > 0
    && Array.isArray(argv) && argv.includes('--dev') && env?.FROSTBYTE_TEST_DIRECT_PEERS === '1';
}

export function normalizeExtraTrackers(value, runtime) {
  if (typeof value !== 'string') throw new Error('Choose a tracker supported by this FrostByte release');
  const trackers = value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  const testOnly = allowTestTrackerEndpoints(runtime);
  if (trackers.length > 8 || trackers.some(item => item.length > 2048 || !['http:', 'https:', 'udp:', 'ws:', 'wss:'].includes(protocol(item)) || (!testOnly && !APPROVED_TRACKERS.has(item)))) {
    throw new Error('Choose a tracker supported by this FrostByte release');
  }
  return [...new Set(trackers)].join('\n');
}

function itemKindId(value) {
  return typeof value === 'string' && /^(?:(?:hf|scan):[a-f0-9]{64}|(?:torrent|shared):[a-f0-9]{40})$/i.test(value);
}

export function normalizeItemKinds(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  let retained = 0;
  for (const [id, kind] of Object.entries(value)) {
    if (retained >= MAX_ITEM_KINDS) break;
    if (itemKindId(id) && validContentKind(kind)) { result[id] = kind; retained++; }
  }
  return result;
}

function libraryEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved library item.');
  if (typeof value.path !== 'string' || value.path.length > 4096 || /[\0\r\n]/.test(value.path) || !path.isAbsolute(value.path)) throw new Error('Invalid saved library path.');
  if (process.platform === 'win32' && /^(?:\\\\|\/\/|\\[?.]\\)/.test(value.path)) throw new Error('Saved library items must use a local drive.');
  const infohash = typeof value.infohash === 'string' && /^[a-f0-9]{40}$/i.test(value.infohash) ? value.infohash.toLowerCase() : '';
  if (!infohash) throw new Error('Invalid saved library identity.');
  const magnetHash = typeof value.magnet === 'string' ? value.magnet.match(/(?:^|[?&])xt=urn:btih:([a-f0-9]{40})(?:&|$)/i)?.[1]?.toLowerCase() : undefined;
  if (magnetHash && magnetHash !== infohash) throw new Error('Saved library magnet does not match its identity.');
  const fallback = path.basename(value.path) || infohash;
  const name = typeof value.name === 'string' && value.name.length <= 500 && !/[\x00-\x1f\x7f]/.test(value.name) && value.name ? value.name : fallback;
  return { path: path.resolve(value.path), name, infohash, magnet: `magnet:?xt=urn:btih:${infohash}` };
}

function preservedPath(file, reason) {
  const stamp = Date.now();
  let target = `${file}.${reason}-${stamp}`;
  for (let suffix = 1; fs.existsSync(target); suffix++) target = `${file}.${reason}-${stamp}-${suffix}`;
  return target;
}

function backupContent(file, reason, content) {
  const target = preservedPath(file, reason);
  fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
  return target;
}

function savedFileIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameSavedFileIdentity(left, right) {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

function unsafeSavedFileStat(stat) {
  const oneLink = typeof stat.nlink === 'bigint' ? 1n : 1;
  const wrongOwner = typeof process.getuid === 'function'
    && BigInt(stat.uid) !== BigInt(process.getuid());
  return !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== oneLink || wrongOwner;
}

function savedFileChanged(file, cause) {
  const error = new Error(`Saved data path changed while ${path.basename(file)} was being opened.`, cause ? { cause } : undefined);
  error.code = 'FROSTBYTE_SAVED_FILE_CHANGED';
  return error;
}

function quarantineExact(file, reason, expectedIdentity) {
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (error) { throw savedFileChanged(file, error); }
  if (!sameSavedFileIdentity(savedFileIdentity(before), expectedIdentity)) throw savedFileChanged(file);
  const target = preservedPath(file, reason);
  fs.renameSync(file, target);
  let moved;
  try { moved = fs.lstatSync(target, { bigint: true }); }
  catch (error) { throw savedFileChanged(file, error); }
  if (!sameSavedFileIdentity(savedFileIdentity(moved), expectedIdentity)) {
    try { if (!fs.existsSync(file)) fs.renameSync(target, file); } catch { /* preserve both names when a racer occupies the original */ }
    throw savedFileChanged(file);
  }
  return target;
}

function sameSavedFileSnapshot(left, right) {
  return sameSavedFileIdentity(savedFileIdentity(left), savedFileIdentity(right))
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readBoundedDescriptor(fd, expectedBytes, file) {
  const expected = Number(expectedBytes);
  const body = Buffer.allocUnsafe(expected + 1);
  let offset = 0;
  while (offset < body.length) {
    const bytesRead = fs.readSync(fd, body, offset, body.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== expected) throw savedFileChanged(file);
  return body.subarray(0, offset);
}

/**
 * Validate, permission, and read one saved JSON file through the same held
 * descriptor. Path identities before and after open protect the Windows
 * fallback where O_NOFOLLOW is unavailable; the final checks also reject a
 * pathname or inode mutation during the read.
 */
function secureExistingFile(file, maxBytes) {
  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
    if (unsafeSavedFileStat(before)) {
      const target = quarantineExact(file, 'unsafe', savedFileIdentity(before));
      console.warn(`Unsafe settings path preserved at ${target}.`);
      return null;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const expectedIdentity = savedFileIdentity(before);
  const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow); }
    catch (error) {
      if (['ELOOP', 'EMLINK', 'ENOENT'].includes(error.code)) throw savedFileChanged(file, error);
      throw error;
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    let afterOpen;
    try { afterOpen = fs.lstatSync(file, { bigint: true }); }
    catch (error) { throw savedFileChanged(file, error); }
    if (unsafeSavedFileStat(opened) || unsafeSavedFileStat(afterOpen)
      || !sameSavedFileIdentity(savedFileIdentity(opened), expectedIdentity)
      || !sameSavedFileIdentity(savedFileIdentity(afterOpen), expectedIdentity)) {
      throw savedFileChanged(file);
    }

    if (process.platform !== 'win32') {
      try { fs.fchmodSync(fd, 0o600); }
      catch (error) { console.warn(`Could not secure ${file}: ${error.message}`); }
    }
    const beforeRead = fs.fstatSync(fd, { bigint: true });
    if (unsafeSavedFileStat(beforeRead)
      || !sameSavedFileIdentity(savedFileIdentity(beforeRead), expectedIdentity)) throw savedFileChanged(file);
    if (beforeRead.size > BigInt(maxBytes)) {
      const error = new SyntaxError(`${path.basename(file)} is too large`);
      error.savedFileIdentity = expectedIdentity;
      throw error;
    }

    const body = readBoundedDescriptor(fd, beforeRead.size, file);
    const afterRead = fs.fstatSync(fd, { bigint: true });
    let afterPath;
    try { afterPath = fs.lstatSync(file, { bigint: true }); }
    catch (error) { throw savedFileChanged(file, error); }
    if (unsafeSavedFileStat(afterRead) || unsafeSavedFileStat(afterPath)
      || !sameSavedFileSnapshot(beforeRead, afterRead)
      || !sameSavedFileIdentity(savedFileIdentity(afterPath), expectedIdentity)
      || afterPath.size !== afterRead.size || afterPath.mtimeNs !== afterRead.mtimeNs || afterPath.ctimeNs !== afterRead.ctimeNs) {
      throw savedFileChanged(file);
    }
    return { body, text: body.toString('utf8'), identity: expectedIdentity };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function settingValue(key, value) {
  if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`);
  const expected = DEFAULTS[key];
  if (Array.isArray(expected)) {
    if (!Array.isArray(value)) throw new Error(`Invalid value for ${key}`);
  } else if (typeof value !== typeof expected) throw new Error(`Invalid value for ${key}`);
  if (typeof value === 'string' && (value.includes('\0') || value.length > (key === 'extraTrackers' ? 65_536 : 4096))) throw new Error(`Invalid value for ${key}`);
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.ceil(value)))) throw new Error(`Invalid number for ${key}`);
  if (['maxConns', 'maxActiveDownloads'].includes(key) && !Number.isInteger(value)) throw new Error(`${key} must be a whole number`);
  if (key === 'maxConns' && value > 1000) throw new Error('Maximum connections must be 1000 or less');
  if (key === 'schedDays' && (value.length !== 7 || value.some(v => v !== 0 && v !== 1))) throw new Error('Choose seven schedule days');
  if (['schedFrom', 'schedTo'].includes(key) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Invalid schedule time');
  if (key === 'theme' && !THEME_IDS.includes(value)) throw new Error('Choose a supported theme');
  if (key === 'blackfrostScene' && !LEGACY_BLACKFROST_SCENE_IDS.includes(value)) throw new Error('Invalid legacy scene preference');
  if (key === 'bandwidthMode' && !['normal', 'alt', 'schedule'].includes(value)) throw new Error('Choose Normal, ALT, or Scheduled bandwidth.');
  if (key === 'catalogUrl' && value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Enter a valid HTTPS catalog URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Enter a public HTTPS catalog URL without credentials');
  }
  if (key === 'extraTrackers' && value) {
    return normalizeExtraTrackers(value);
  }
  if (key === 'downloadDir' && !path.isAbsolute(value)) throw new Error('Choose an absolute download folder');
  if (key === 'completedDir' && value && !path.isAbsolute(value)) throw new Error('Choose an absolute completed folder');
  if (process.platform === 'win32' && ['downloadDir', 'completedDir'].includes(key) && value && /^(?:\\\\|\/\/|\\[?.]\\)/.test(value)) throw new Error('Choose a folder on a local drive');
  if (key === 'sparkDownloadDir' && value && !value.startsWith('/')) throw new Error('Choose an absolute folder on Spark');
  return structuredClone(value);
}

function protocol(value) {
  try { return new URL(value).protocol; } catch { return ''; }
}

function readSettings() {
  let loaded;
  try {
    loaded = secureExistingFile(SETTINGS_FILE, MAX_SETTINGS_BYTES);
    if (!loaded) return structuredClone(DEFAULTS);
    const saved = JSON.parse(loaded.text);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new SyntaxError('Expected an object');
    const settings = structuredClone(DEFAULTS);
    const invalid = [];
    for (const [key, value] of Object.entries(saved)) {
      try { settings[key] = settingValue(key, value); }
      catch { invalid.push(key); }
    }
    // Preserve an explicitly configured legacy schedule, but never resurrect
    // a session-only ALT override. New manual choices survive restarts.
    if (!Object.hasOwn(saved, 'bandwidthMode') && settings.schedEnabled) settings.bandwidthMode = 'schedule';
    if (invalid.length) {
      const preserved = backupContent(SETTINGS_FILE, 'invalid', loaded.body);
      console.warn(`Invalid settings (${invalid.join(', ')}) preserved at ${preserved}. Safe values were loaded.`);
      writeJson(SETTINGS_FILE, settings);
    }
    return settings;
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(DEFAULTS);
    if (!(err instanceof SyntaxError)) throw err;
    const identity = loaded?.identity ?? err.savedFileIdentity;
    if (!identity) throw err;
    const preserved = quarantineExact(SETTINGS_FILE, 'corrupt', identity);
    console.warn(`Unreadable JSON preserved at ${preserved}. Loading defaults.`);
    const defaults = structuredClone(DEFAULTS);
    writeJson(SETTINGS_FILE, defaults);
    return defaults;
  }
}

function readJson(file, fallback) {
  let loaded;
  try {
    loaded = secureExistingFile(file, MAX_STATE_BYTES);
    if (!loaded) return structuredClone(fallback);
    const saved = JSON.parse(loaded.text);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new SyntaxError('Expected an object');
    return { ...structuredClone(fallback), ...saved };
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    if (!(err instanceof SyntaxError)) throw err;
    const identity = loaded?.identity ?? err.savedFileIdentity;
    if (!identity) throw err;
    const preserved = quarantineExact(file, 'corrupt', identity);
    console.warn(`Unreadable JSON preserved at ${preserved}. Loading defaults.`);
    const clean = structuredClone(fallback);
    writeJson(file, clean, { maxBytes: MAX_STATE_BYTES });
    return clean;
  }
}

export function writeJson(file, data, { maxBytes = Infinity } = {}) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(body) > maxBytes) throw new Error(`Refusing to write oversized ${path.basename(file)}.`);
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
  const fd = fs.openSync(temporary, flags, 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temporary, file);
    try {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch { /* directory fsync is unavailable on Windows and some filesystems */ }
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export class Store {
  constructor() {
    fs.mkdirSync(APP_DIR, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(APP_DIR, 0o700); } catch { /* retain access on unusual filesystems */ }
    }
    this.settings = readSettings();
    this.state = readJson(STATE_FILE, STATE_DEFAULTS);
    // Normalize per default shape: array keys are culled and capped; object keys
    // (Hub entitlement/config/updates) must never be forced to arrays.
    for (const key of Object.keys(STATE_DEFAULTS)) {
      const fallback = STATE_DEFAULTS[key];
      if (Array.isArray(fallback)) {
        if (!Array.isArray(this.state[key])) this.state[key] = [];
        else if (this.state[key].length > STATE_ARRAY_LIMITS[key]) this.state[key] = this.state[key].slice(-STATE_ARRAY_LIMITS[key]);
      } else if (!this.state[key] || typeof this.state[key] !== 'object' || Array.isArray(this.state[key])) {
        this.state[key] = structuredClone(fallback);
      }
    }
    const library = [];
    const seenLibrary = new Set();
    for (const entry of this.state.library) {
      try {
        const clean = libraryEntry(entry), key = process.platform === 'win32' ? clean.path.toLowerCase() : clean.path;
        if (seenLibrary.has(key)) continue;
        seenLibrary.add(key); library.push(clean);
      } catch { /* malformed saved paths never reach filesystem operations */ }
    }
    this.state.library = library;
    this.state.itemKinds = normalizeItemKinds(this.state.itemKinds);
    this.state.hiddenCatalog = this.state.hiddenCatalog.filter(value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value));
    fs.mkdirSync(this.settings.downloadDir, { recursive: true });
    // Create the config dir up front so "open storage location" works on a
    // fresh install, before anything has been written.
    if (!fs.existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, this.settings);
  }

  get appDir() { return APP_DIR; }

  getSettings() { return structuredClone(this.settings); }

  getItemKinds() { return structuredClone(normalizeItemKinds(this.state.itemKinds)); }

  getHubEntitlement() {
    const raw = this.state.hubEntitlement || { tier: 'free' };
    const tier = typeof raw.tier === 'string' ? raw.tier : 'free';
    return { tier: ['free', 'plus', 'pro', 'offline'].includes(tier) ? tier : 'free', status: typeof raw.status === 'string' ? raw.status : 'inactive', fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0, currentPeriodEnd: raw.currentPeriodEnd ?? null, entitlements: raw.entitlements ?? {}, source: raw.source ?? 'local' };
  }

  setHubEntitlement(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Entitlement state is invalid.');
    const normalized = { tier: String(value.tier || 'free'), status: String(value.status || 'inactive').slice(0, 32), fetchedAt: Number.isFinite(value.fetchedAt) ? value.fetchedAt : Date.now(), currentPeriodEnd: value.currentPeriodEnd ?? null, entitlements: value.entitlements && typeof value.entitlements === 'object' ? value.entitlements : {}, source: String(value.source || 'local').slice(0, 16) };
    if (!['free', 'plus', 'pro', 'offline'].includes(normalized.tier)) throw new Error('Unknown entitlement tier.');
    this._commitStateFields({ hubEntitlement: normalized });
    return this.getHubEntitlement();
  }

  getHubConfig() {
    const raw = this.state.hubConfig || { hubUrl: '', follows: [], bundleDigest: '' };
    return { hubUrl: typeof raw.hubUrl === 'string' ? raw.hubUrl : '', follows: Array.isArray(raw.follows) ? raw.follows.filter(v => typeof v === 'string') : [], bundleDigest: typeof raw.bundleDigest === 'string' ? raw.bundleDigest : '' };
  }

  setHubConfig(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Hub config is invalid.');
    const current = this.getHubConfig();
    const next = { ...current };
    if (Object.hasOwn(patch, 'hubUrl')) {
      if (patch.hubUrl == null || patch.hubUrl === '') next.hubUrl = '';
      else {
        const canonical = canonicalHubUrl(typeof patch.hubUrl === 'string' ? patch.hubUrl.trim().replace(/\/+$/, '') : '');
        if (!canonical) throw new Error('Hub URL must be canonical HTTPS without embedded credentials.');
        next.hubUrl = canonical;
      }
    }
    if (Object.hasOwn(patch, 'follows')) {
      if (!Array.isArray(patch.follows)) throw new Error('Hub follows must be a list.');
      const follows = [];
      const seen = new Set();
      for (const v of patch.follows) {
        if (typeof v !== 'string' || !/^[a-f0-9]{64}$/i.test(v)) throw new Error('Invalid follow pubkey.');
        const k = v.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); follows.push(k);
      }
      next.follows = follows.slice(0, 256);
    }
    if (Object.hasOwn(patch, 'bundleDigest')) {
      if (patch.bundleDigest == null || patch.bundleDigest === '') next.bundleDigest = '';
      else {
        if (typeof patch.bundleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(patch.bundleDigest)) throw new Error('Invalid bundle digest.');
        next.bundleDigest = patch.bundleDigest.toLowerCase();
      }
    }
    this._commitStateFields({ hubConfig: next });
    return this.getHubConfig();
  }

  getHubUpdates() { return this.state.hubUpdates || { fetchedAt: 0, nudges: [] }; }

  setHubUpdates(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hub updates are invalid.');
    const next = { fetchedAt: Number.isFinite(value.fetchedAt) ? value.fetchedAt : 0, nudges: Array.isArray(value.nudges) ? value.nudges.slice(0, 100) : [] };
    this._commitStateFields({ hubUpdates: next });
    return this.getHubUpdates();
  }

  _commitStateFields(patch) {
    const previous = new Map(Object.keys(patch).map(key => [key, {
      present: Object.hasOwn(this.state, key), value: this.state[key],
    }]));
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete this.state[key];
      else this.state[key] = value;
    }
    try { this._flush(); }
    catch (error) {
      for (const [key, prior] of previous) {
        if (prior.present) this.state[key] = prior.value;
        else delete this.state[key];
      }
      throw error;
    }
  }

  setItemKinds(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid item categories.');
    const additions = Object.entries(patch);
    if (additions.some(([id, kind]) => !itemKindId(id) || !validContentKind(kind))) throw new Error('Invalid item category.');
    const next = { ...normalizeItemKinds(this.state.itemKinds), ...Object.fromEntries(additions) };
    if (Object.keys(next).length > MAX_ITEM_KINDS) throw new Error('Too many saved item categories.');
    this._commitStateFields({ itemKinds: next });
    return this.getItemKinds();
  }

  setSettings(patch) {
    const next = { ...this.settings };
    for (const [key, value] of Object.entries(patch ?? {})) {
      next[key] = settingValue(key, value);
    }
    if (patch.downloadDir) fs.mkdirSync(next.downloadDir, { recursive: true });
    writeJson(SETTINGS_FILE, next);
    this.settings = next;
    return this.getSettings();
  }

  getUserCatalog() { return this.state.userCatalog ?? []; }
  setUserCatalog(list) {
    if (!Array.isArray(list)) throw new Error('Catalog state must be a list.');
    const next = structuredClone(list.slice(-STATE_ARRAY_LIMITS.userCatalog));
    this._commitStateFields({ userCatalog: next });
    return structuredClone(next);
  }

  setCatalogState(list, hiddenCatalog) {
    if (!Array.isArray(list) || !Array.isArray(hiddenCatalog)
      || hiddenCatalog.some(value => typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value))) {
      throw new Error('Catalog state is invalid.');
    }
    const userCatalog = structuredClone(list.slice(-STATE_ARRAY_LIMITS.userCatalog));
    const hidden = [...new Set(hiddenCatalog.map(value => value.toLowerCase()))].slice(-STATE_ARRAY_LIMITS.hiddenCatalog);
    this._commitStateFields({ userCatalog, hiddenCatalog: hidden });
    return structuredClone(userCatalog);
  }

  setUpdateCheck(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Update state is invalid.');
    const next = structuredClone(value);
    this._commitStateFields({ updateCheck: next });
    return structuredClone(next);
  }

  setHfCredentialState(value) {
    const keys = ['hfTokenEnc', 'hfTokenPlain', 'hfTokenMigrationRequired', 'hfUser', 'hfRole'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || keys.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !keys.includes(key))) throw new Error('HuggingFace credential state is invalid.');
    const { hfTokenEnc, hfTokenPlain, hfTokenMigrationRequired, hfUser, hfRole } = value;
    if (typeof hfTokenEnc !== 'string' || hfTokenEnc.length > 65_536
      || (hfTokenEnc && (hfTokenEnc.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(hfTokenEnc)))) {
      throw new Error('Encrypted HuggingFace credential state is invalid.');
    }
    if (hfTokenPlain !== undefined && hfTokenPlain !== '') throw new Error('FrostByte cannot save a plaintext HuggingFace token.');
    if (typeof hfTokenMigrationRequired !== 'boolean'
      || typeof hfUser !== 'string' || hfUser.length > 200 || /[\x00-\x1f\x7f]/.test(hfUser)
      || typeof hfRole !== 'string' || hfRole.length > 100 || /[\x00-\x1f\x7f]/.test(hfRole)
      || (hfTokenMigrationRequired && hfTokenEnc)
      || ((!hfTokenEnc || hfTokenMigrationRequired) && (hfUser || hfRole))) {
      throw new Error('HuggingFace credential metadata is invalid.');
    }
    this._commitStateFields({ hfTokenEnc, hfTokenPlain, hfTokenMigrationRequired, hfUser, hfRole });
    return { present: !!hfTokenEnc, needsReconnect: hfTokenMigrationRequired, user: hfUser, role: hfRole };
  }

  /**
   * Persist the Hub Bearer credential (encrypted Firebase ID token) bound to a
   * Hub origin, with its SHA-256 fingerprint for approval scoping. Mirrors
   * setHubRefreshCredential: only ciphertext is accepted, never plaintext. Pass
   * an empty enc to clear. The origin must be a validated HTTPS Hub origin.
   */
  setHubCredential({ hubTokenEnc, hubTokenOrigin, hubTokenFingerprint } = {}) {
    if (typeof hubTokenEnc !== 'string' || hubTokenEnc.length > 65_536
      || (hubTokenEnc && (hubTokenEnc.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(hubTokenEnc)))) {
      throw new Error('Encrypted Hub credential is invalid.');
    }
    if (typeof hubTokenOrigin !== 'string' || hubTokenOrigin.length > 2048) {
      throw new Error('Hub credential origin is invalid.');
    }
    if (hubTokenOrigin && !isCanonicalHubOrigin(hubTokenOrigin)) {
      throw new Error('Hub credential origin must be a canonical HTTPS Hub URL.');
    }
    if (typeof hubTokenFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(hubTokenFingerprint)) {
      throw new Error('Hub credential fingerprint is invalid.');
    }
    if (hubTokenEnc && !hubTokenOrigin) throw new Error('A Hub credential must be bound to an origin.');
    if (!hubTokenEnc && hubTokenOrigin) throw new Error('A Hub credential origin requires a credential.');
    this._commitStateFields({ hubTokenEnc, hubTokenOrigin, hubTokenFingerprint });
    return { present: !!hubTokenEnc, origin: hubTokenOrigin, fingerprint: hubTokenFingerprint };
  }

  /**
   * Persist the Firebase refresh token (encrypted) bound to a Hub origin.
   * Mirrors setHfCredentialState: only ciphertext is accepted, never plaintext.
   * Pass an empty enc to clear. The origin must be a validated HTTPS Hub origin.
   */
  setHubRefreshCredential({ hubRefreshEnc, hubRefreshOrigin } = {}) {
    if (typeof hubRefreshEnc !== 'string' || hubRefreshEnc.length > 65_536
      || (hubRefreshEnc && (hubRefreshEnc.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(hubRefreshEnc)))) {
      throw new Error('Encrypted Hub refresh credential is invalid.');
    }
    if (typeof hubRefreshOrigin !== 'string' || hubRefreshOrigin.length > 2048) {
      throw new Error('Hub refresh origin is invalid.');
    }
    if (hubRefreshOrigin && !isCanonicalHubOrigin(hubRefreshOrigin)) {
      throw new Error('Hub refresh origin must be a canonical HTTPS Hub URL.');
    }
    if (hubRefreshEnc && !hubRefreshOrigin) throw new Error('A Hub refresh credential must be bound to an origin.');
    if (!hubRefreshEnc && hubRefreshOrigin) throw new Error('A Hub refresh origin requires a credential.');
    this._commitStateFields({ hubRefreshEnc, hubRefreshOrigin });
    return { present: !!hubRefreshEnc, origin: hubRefreshOrigin };
  }

  getHubRefreshCredential() {
    const enc = typeof this.state.hubRefreshEnc === 'string' ? this.state.hubRefreshEnc : '';
    const origin = typeof this.state.hubRefreshOrigin === 'string' ? this.state.hubRefreshOrigin : '';
    if (!enc || !origin) return { present: false, enc: '', origin: '' };
    return { present: true, enc, origin };
  }

  /**
   * Persist the Firebase ID-token expiry (epoch ms) bound to a Hub origin, so a
   * restored session can be refreshed proactively before it lapses. Like the
   * refresh credential, this is a non-secret scalar managed outside STATE_DEFAULTS
   * (the load normalizer would otherwise reset it). Pass 0 to clear.
   */
  setHubTokenExpiry({ hubTokenExpiresAt, hubTokenExpiryOrigin } = {}) {
    const expiresAt = Number(hubTokenExpiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 8.64e15) {
      throw new Error('Hub token expiry is invalid.');
    }
    if (typeof hubTokenExpiryOrigin !== 'string' || hubTokenExpiryOrigin.length > 2048) {
      throw new Error('Hub token expiry origin is invalid.');
    }
    if (hubTokenExpiryOrigin && !isCanonicalHubOrigin(hubTokenExpiryOrigin)) {
      throw new Error('Hub token expiry origin must be a canonical HTTPS Hub URL.');
    }
    if (expiresAt && !hubTokenExpiryOrigin) throw new Error('A Hub token expiry must be bound to an origin.');
    if (!expiresAt && hubTokenExpiryOrigin) throw new Error('A Hub token expiry origin requires an expiry.');
    this._commitStateFields({ hubTokenExpiresAt: expiresAt, hubTokenExpiryOrigin });
    return { expiresAt, origin: hubTokenExpiryOrigin };
  }

  getHubTokenExpiry() {
    const expiresAt = Number(this.state.hubTokenExpiresAt);
    const origin = typeof this.state.hubTokenExpiryOrigin === 'string' ? this.state.hubTokenExpiryOrigin : '';
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !origin) return { expiresAt: 0, origin: '' };
    return { expiresAt, origin };
  }

  /**
   * Things this box is holding on disk, so they survive a restart.
   * This is the always-on-box case: it should come back up seeding.
   */
  getLibrary() { return this.state.library ?? []; }

  addToLibrary(entry) {
    entry = libraryEntry(entry);
    // Active sharing intent must not silently evict older items. The atomic
    // state-size budget still rejects an oversized save without losing data.
    const list = this.getLibrary().filter((x) => x.path !== entry.path);
    list.push(entry);
    this._commitStateFields({ library: list });
    return structuredClone(list);
  }

  removeFromLibrary(p) {
    const next = this.getLibrary().filter((x) => x.path !== p);
    this._commitStateFields({ library: next });
    return structuredClone(next);
  }

  setPublisherAccount(value) {
    const account = normalizePublisherRecord(value);
    this._commitStateFields({ publisherAccount: account ?? undefined });
    return account;
  }

  getPublisherAccount() {
    return normalizePublisherRecord(this.state.publisherAccount);
  }

  removeFromLibraryByHash(infohash) {
    const next = this.getLibrary().filter((x) => x.infohash !== infohash);
    this._commitStateFields({ library: next });
    return structuredClone(next);
  }

  _flush() {
    const persisted = structuredClone(this.state);
    const capped = new Set();
    for (const [key, limit] of Object.entries(STATE_ARRAY_LIMITS)) {
      if (Array.isArray(persisted[key]) && persisted[key].length > limit) {
        persisted[key] = persisted[key].slice(-limit);
        capped.add(key);
      }
    }
    persisted.itemKinds = normalizeItemKinds(persisted.itemKinds);
    // A magnet can recover metadata; retain a bounded recent subset so valid
    // large torrents cannot make the next launch quarantine all app state.
    let metadataBytes = 0;
    let strippedMetadata = false;
    for (const record of [...(persisted.transfers ?? [])].reverse()) {
      if (typeof record?.torrentFile !== 'string') continue;
      const bytes = Buffer.byteLength(record.torrentFile);
      if (bytes > MAX_SAVED_TORRENT_METADATA_BYTES - metadataBytes) { delete record.torrentFile; strippedMetadata = true; }
      else metadataBytes += bytes;
    }
    writeJson(STATE_FILE, persisted, { maxBytes: MAX_STATE_BYTES });
    for (const key of capped) this.state[key] = persisted[key];
    if (strippedMetadata) this.state.transfers = persisted.transfers;
    this.state.itemKinds = persisted.itemKinds;
  }
}
