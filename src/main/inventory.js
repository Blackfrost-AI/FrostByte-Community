/** Download ownership is independent of transfer history and the seeding registry. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { contentKind, checkModelCompleteness } from '../shared/content-kind.js';
import { filesystemPathKey } from './portable-path.js';

const MAX_FILES = 5000;
const MAX_ROWS = 5000;
const MAX_MANIFEST_PATH_BYTES = 512 * 1024;
const clean = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
function absolute(value) {
  if (!clean(value) || !path.isAbsolute(value)) throw new Error('Inventory requires an absolute download path.');
  if (process.platform === 'win32' && /^(?:\\\\|\/\/|\\[?.]\\)/.test(value)) throw new Error('Inventory requires a path on a local drive.');
  return path.resolve(value);
}
function relative(value, empty = false) {
  if (!clean(value)) throw new Error('Invalid recorded download file.');
  const result = value.replaceAll('\\', '/');
  if (empty && result === '') return result;
  if (result.includes(':') || result.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Recorded files must stay within their download folder.');
  return result;
}
function size(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid recorded download size.');
  return value;
}
function repo(value) {
  if (!clean(value) || !/^[\w.-]+(?:\/[\w.-]+)?$/.test(value)) throw new Error('Invalid recorded HuggingFace repository.');
  return relative(value);
}
const pathKey = value => filesystemPathKey(value, 'portable');
const hfId = asset => 'hf:' + createHash('sha256').update(pathKey(asset)).digest('hex');
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const sameObject = (left, right) => Boolean(left && right)
  && (Number(left.ino) && Number(right.ino)
    ? left.dev === right.dev && left.ino === right.ino
    : left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs);
const sameSnapshot = (left, right) => sameObject(left, right) && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });

function normalize(row) {
  if (!row || !['hf', 'torrent'].includes(row.source)) throw new Error('Invalid inventory source.');
  const destination = absolute(row.destination), asset = relative(row.relative, true);
  const assetPath = path.resolve(destination, asset);
  if (row.path !== undefined && absolute(row.path) !== assetPath) throw new Error('Recorded asset path does not match its download folder.');
  if (!Array.isArray(row.files) || !row.files.length || row.files.length > MAX_FILES) throw new Error('Invalid inventory file manifest.');
  const seen = new Set();
  let pathBytes = 0;
  const files = row.files.map(file => {
    const name = relative(file.relative);
    pathBytes += Buffer.byteLength(name, 'utf8');
    if (pathBytes > MAX_MANIFEST_PATH_BYTES) throw new Error('Recorded file names exceed the inventory limit.');
    if (asset && name !== asset && !name.startsWith(asset + '/')) throw new Error('Recorded file is outside its asset.');
    if (seen.has(pathKey(name))) throw new Error('Duplicate recorded file.');
    seen.add(pathKey(name));
    return { relative: name, size: size(file.size), updatedAt: timestamp(file.updatedAt),
      ...(typeof file.revision === 'string' && /^[a-f0-9]{40}$/i.test(file.revision) ? { revision: file.revision } : {}) };
  });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  size(total);
  const result = { source: row.source, destination, path: assetPath, relative: asset,
    name: clean(row.name) && row.name ? row.name.slice(0, 500) : path.basename(assetPath),
    directory: !(files.length === 1 && files[0].relative === asset), files,
    updatedAt: timestamp(row.updatedAt), shareable: row.shareable !== false && asset !== '', kind: contentKind(row) };
  if (row.source === 'hf') {
    result.repoId = repo(row.repoId);
    if (asset !== result.repoId) throw new Error('Recorded HF asset must match its repository.');
    result.id = hfId(assetPath);
  } else {
    if (typeof row.infoHash !== 'string' || !/^[a-f0-9]{40}$/i.test(row.infoHash)) throw new Error('Invalid recorded torrent identity.');
    result.infoHash = row.infoHash.toLowerCase();
    result.id = 'torrent:' + result.infoHash;
  }
  return result;
}

export class DownloadInventory {
  constructor(store, { now = Date.now, cacheMs = 2000 } = {}) {
    this.store = store;
    this.now = now;
    this.cacheMs = cacheMs;
    this.rows = [];
    const byId = new Map(), byPath = new Map();
    const saved = Array.isArray(store.state.downloadedItems) ? store.state.downloadedItems : [];
    for (const row of saved.slice(-MAX_ROWS)) {
      try {
        const clean = normalize(row);
        const priorId = byId.get(clean.id), priorPath = byPath.get(pathKey(clean.path));
        if (priorId) this.rows = this.rows.filter(item => item !== priorId);
        if (priorPath && priorPath !== priorId) this.rows = this.rows.filter(item => item !== priorPath);
        this.rows.push(clean); byId.set(clean.id, clean); byPath.set(pathKey(clean.path), clean);
      } catch { /* Invalid metadata is never used for filesystem access. */ }
    }
    if (JSON.stringify(saved) !== JSON.stringify(this.rows)) {
      const previous = store.state.downloadedItems;
      store.state.downloadedItems = structuredClone(this.rows);
      try { store._flush(); }
      catch (error) { store.state.downloadedItems = previous; throw error; }
    }
    this.cache = null;
  }

  _save() {
    const rows = this.rows.length > MAX_ROWS ? this.rows.slice(-MAX_ROWS) : this.rows;
    const previous = this.store.state.downloadedItems;
    this.store.state.downloadedItems = structuredClone(rows);
    try { this.store._flush(); }
    catch (error) { this.store.state.downloadedItems = previous; throw error; }
    this.rows = rows;
    this.cache = null;
  }

  /** One completed HF file; repositories accumulate only explicitly completed files. */
  registerHf(record) {
    const previous = this.rows;
    try {
      const result = this._hf(record);
      if (result) this._save();
      return result?.id ?? null;
    } catch (error) { this.rows = previous; throw error; }
  }

  _hf(record, protectedPaths = null) {
    if (record?.status !== 'done') return null;
    const repoId = repo(record.repoId), filePath = relative(record.filePath);
    const dest = absolute(record.dest);
    const fileRelative = repoId + '/' + filePath;
    let inferredRoot = dest;
    for (const unused of fileRelative.split('/')) { void unused; inferredRoot = path.dirname(inferredRoot); }
    const destination = absolute(record.baseDir ?? inferredRoot);
    if (path.resolve(destination, fileRelative) !== dest) throw new Error('Completed HF destination does not match its recorded repository/file.');
    if (protectedPaths?.has(pathKey(dest))) return null;
    const assetPath = path.resolve(destination, repoId), id = hfId(assetPath);
    const previous = this.rows.find(row => row.id === id);
    const updatedAt = protectedPaths ? timestamp(record.completedAt ?? record.updatedAt ?? record.startedAt) : this.now();
    const files = (previous?.files ?? []).filter(file => pathKey(file.relative) !== pathKey(fileRelative));
    files.push({ relative: fileRelative, size: size(record.downloaded ?? record.total), revision: record.revision, updatedAt });
    const result = normalize({ source: 'hf', repoId, name: repoId, relative: repoId, destination, files,
      updatedAt: Math.max(previous?.updatedAt ?? 0, updatedAt), shareable: true });
    this.rows = this.rows.filter(row => row.id !== id && pathKey(row.path) !== pathKey(result.path));
    this.rows.push(result);
    return result;
  }

  /** Startup migration is idempotent and cannot replace newer recorded provenance. */
  migrateHf(records = this.store.state.hfDownloads ?? []) {
    const previous = this.rows;
    const protectedPaths = new Set(this.rows.flatMap(row => row.files.map(file => pathKey(path.resolve(row.destination, file.relative)))));
    let added = 0, skipped = 0;
    const ordered = [...(Array.isArray(records) ? records : [])].sort((a, b) => timestamp(a?.completedAt ?? a?.updatedAt ?? a?.startedAt) - timestamp(b?.completedAt ?? b?.updatedAt ?? b?.startedAt));
    for (const record of ordered) {
      try { if (this._hf(record, protectedPaths)) added++; else skipped++; } catch { skipped++; }
    }
    try {
      if (added) this._save();
      return { added, skipped };
    } catch (error) { this.rows = previous; throw error; }
  }

  /** A re-registration after move updates the existing torrent's destination. */
  registerTorrent(record) {
    if (!record?.done || record.inventoryId) return null;
    if (!Array.isArray(record.files)) throw new Error('Completed torrent is missing its file manifest.');
    const files = record.files.filter(file => file.selected !== false).map(file => ({ relative: relative(file.path), size: size(file.length), updatedAt: this.now() }));
    const roots = new Set(files.map(file => file.relative.split('/')[0]));
    const asset = roots.size === 1 ? [...roots][0] : '';
    const result = normalize({ source: 'torrent', infoHash: record.infoHash, name: record.name,
      destination: record.path, relative: asset, files, updatedAt: this.now(), kind: contentKind(record),
      shareable: roots.size === 1 && (!record.partial || files.length === 1 && files[0].relative === asset) });
    const previous = this.rows;
    try {
      this.rows = this.rows.filter(row => row.id !== result.id && pathKey(row.path) !== pathKey(result.path));
      this.rows.push(result);
      this._save();
      return result.id;
    } catch (error) { this.rows = previous; throw error; }
  }

  shareManifest(id) {
    const entry = this.list({ refresh: true }).find(item => item.id === id);
    if (!entry?.available) throw new Error('These downloaded files are missing or unavailable.');
    const row = this.rows.find(item => item.id === id);
    if (!row.relative) throw new Error('Resume the original torrent to share this selection.');
    return { path: row.path, files: row.files.map(file => ({ path: path.resolve(row.destination, file.relative), size: file.size })) };
  }

  /** Stable ownership proof used across native remove/delete review. */
  identity(id) {
    const row = this.rows.find(item => item.id === id);
    if (!row) throw new Error('This downloaded item is no longer available. Refresh and try again.');
    return createHash('sha256').update(JSON.stringify(row)).digest('hex');
  }

  /** Remove only FrostByte's ownership record. Downloaded bytes stay in place. */
  forget(id, expectedIdentity = this.identity(id)) {
    if (this.identity(id) !== expectedIdentity) throw new Error('This downloaded item changed during review. Review it again.');
    const previous = this.rows;
    this.rows = this.rows.filter(item => item.id !== id);
    try { this._save(); }
    catch (error) { this.rows = previous; throw error; }
    return true;
  }

  /**
   * Delete only the exact regular files in the recorded manifest. Every parent
   * and file is checked before review and again immediately before unlinking;
   * directories are removed only when empty and never recursively.
   */
  deletionPlan(id) {
    const row = this.rows.find(item => item.id === id);
    if (!row) throw new Error('This downloaded item is no longer available. Refresh and try again.');
    const rootLink = fs.lstatSync(row.destination);
    if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) throw new Error('The download folder is unavailable or linked.');
    const realRoot = fs.realpathSync(row.destination);
    if (realRoot !== path.resolve(row.destination)) throw new Error('The download folder resolves somewhere else.');
    const rootStat = fs.statSync(realRoot);
    const files = row.files.map(file => {
      const finalTarget = path.resolve(realRoot, file.relative);
      let current = realRoot;
      for (const component of file.relative.split('/')) {
        current = path.join(current, component);
        let stat;
        try { stat = fs.lstatSync(current); }
        catch (error) {
          if (error.code === 'ENOENT') return { relative: file.relative, target: finalTarget, missing: true };
          throw error;
        }
        if (stat.isSymbolicLink()) throw new Error('A downloaded path was replaced by a symbolic link.');
        if (current !== finalTarget && !stat.isDirectory()) {
          throw new Error('A downloaded parent path is no longer a folder.');
        }
        if (current === finalTarget && (!stat.isFile() || stat.size !== file.size)) {
          throw new Error('A downloaded file is missing, changed, or no longer a regular file.');
        }
      }
      const relative = path.relative(realRoot, current);
      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
        throw new Error('A downloaded file no longer belongs to its download folder.');
      }
      return { relative: file.relative, target: finalTarget, expected: identity(fs.lstatSync(finalTarget)), missing: false };
    });
    return Object.freeze({ id, inventoryIdentity: this.identity(id), root: realRoot, rootIdentity: identity(rootStat), files });
  }

  deleteFiles(plan, { forget = true } = {}) {
    if (!plan || typeof plan !== 'object' || this.identity(plan.id) !== plan.inventoryIdentity) {
      throw new Error('This downloaded item changed during review. Review it again.');
    }
    const rootLink = fs.lstatSync(plan.root), rootStat = fs.statSync(plan.root);
    if (rootLink.isSymbolicLink() || !rootLink.isDirectory() || !sameObject(identity(rootStat), plan.rootIdentity)
      || fs.realpathSync(plan.root) !== plan.root) throw new Error('The download folder changed during review. Review it again.');
    for (const file of plan.files) {
      const target = path.resolve(plan.root, file.relative);
      if (target !== file.target) throw new Error('A downloaded path changed during review. Review it again.');
      let current = plan.root;
      const components = file.relative.split('/');
      for (let index = 0; index < components.length - 1; index++) {
        current = path.join(current, components[index]);
        let stat;
        try { stat = fs.lstatSync(current); }
        catch (error) { if (error.code === 'ENOENT' && file.missing) break; throw error; }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('A downloaded folder changed during review. Review it again.');
      }
      let stat;
      try { stat = fs.lstatSync(target); }
      catch (error) {
        if (error.code === 'ENOENT' && file.missing) continue;
        throw new Error('A downloaded file changed during review. Review it again.');
      }
      if (file.missing || stat.isSymbolicLink() || !stat.isFile() || !sameSnapshot(identity(stat), file.expected)) {
        throw new Error('A downloaded file changed during review. Review it again.');
      }
    }
    for (const file of plan.files) {
      if (file.missing) continue;
      const stat = fs.lstatSync(file.target);
      if (stat.isSymbolicLink() || !stat.isFile() || !sameSnapshot(identity(stat), file.expected)) {
        throw new Error('A downloaded file changed before it could be deleted.');
      }
      fs.unlinkSync(file.target);
    }
    const directories = [...new Set(plan.files.flatMap(file => {
      const result = [];
      for (let current = path.dirname(file.target); current !== plan.root && current.startsWith(plan.root + path.sep); current = path.dirname(current)) result.push(current);
      return result;
    }))].sort((left, right) => right.length - left.length);
    for (const directory of directories) {
      try {
        const stat = fs.lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('A downloaded folder changed before cleanup.');
        fs.rmdirSync(directory);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
    if (forget) this.forget(plan.id, plan.inventoryIdentity);
    return true;
  }

  /** Only lstat/realpath recorded paths; never enumerate folders or follow child links. */
  list({ refresh = false } = {}) {
    const now = this.now();
    if (!refresh && this.cache && now - this.cache.at >= 0 && now - this.cache.at < this.cacheMs) return structuredClone(this.cache.items);
    const checked = new Map();
    const lstat = target => {
      if (!checked.has(target)) {
        try { checked.set(target, fs.lstatSync(target)); } catch (error) { checked.set(target, error); }
      }
      const result = checked.get(target);
      if (result instanceof Error) throw result;
      if (result.isSymbolicLink()) throw new Error('A recorded download path is a symbolic link.');
      return result;
    };
    const items = this.rows.map(row => {
      let missingFiles = 0, error;
      let realRoot;
      try {
        if (!lstat(row.destination).isDirectory()) throw new Error('The download folder is unavailable.');
        realRoot = fs.realpathSync(row.destination);
      } catch { error = 'The download folder is missing, inaccessible, or a symbolic link.'; }
      for (const file of row.files) {
        try {
          if (!realRoot) throw new Error(error);
          let current = row.destination;
          const components = file.relative.split('/');
          for (let i = 0; i < components.length; i++) {
            current = path.join(current, components[i]);
            const stat = lstat(current);
            if (i < components.length - 1 && !stat.isDirectory()) throw new Error('A recorded download folder is unavailable.');
            if (i === components.length - 1 && (!stat.isFile() || stat.size !== file.size)) throw new Error('A recorded file is missing or its size has changed.');
          }
          const inside = path.relative(realRoot, fs.realpathSync(current));
          if (!inside || path.isAbsolute(inside) || inside === '..' || inside.startsWith('..' + path.sep)) throw new Error('A recorded file no longer belongs to its download folder.');
        } catch {
          missingFiles++;
          error ||= 'One or more recorded files are missing, changed, inaccessible, or symbolic links.';
        }
      }
      const { files, shareable, ...publicRow } = row;
      const fileNames = files.map(file => file.relative);
      const completeness = publicRow.kind === 'model' ? checkModelCompleteness(fileNames) : undefined;
      return { ...publicRow, fileCount: files.length, size: files.reduce((sum, file) => sum + file.size, 0),
        fileNames,
        ...(completeness ? { completeness } : {}),
        available: missingFiles === 0, missingFiles, shareable: shareable && missingFiles === 0,
        browseRelative: row.directory ? row.relative : path.posix.dirname(row.relative) === '.' ? '' : path.posix.dirname(row.relative),
        ...(error ? { error } : {}) };
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
    this.cache = { at: now, items };
    return structuredClone(items);
  }
}
