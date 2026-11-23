/** Inventory snapshots also keep older Spark companions usable during upgrades. */
import path from 'node:path';
import { createHash } from 'node:crypto';

const p = path.posix;
const inside = (root, target) => target === root || target.startsWith(root + '/');
const size = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const id = value => createHash('sha256').update(value).digest('hex');
const rootsOf = status => status.storageRoots || [status.downloadDir];
const owns = (status, root, target) => rootsOf(status).includes(root) && typeof root === 'string' && typeof target === 'string' && p.isAbsolute(target) && p.normalize(target) === target && inside(root, target);
const snapshot = status => Object.fromEntries(['version', 'hostname', 'architecture', 'hardware', 'capabilities', 'downloadDir', 'storageRoots', 'storage', 'freeBytes', 'totalBytes', 'memoryBytes', 'inventory', 'inventoryControls'].filter(key => status[key] !== undefined).map(key => [key, structuredClone(status[key])]));

function safeRoot(status, target) {
  if (typeof target !== 'string' || !p.isAbsolute(target) || p.normalize(target) !== target) return;
  return rootsOf(status).filter(root => typeof root === 'string' && inside(root, target)).sort((a, b) => b.length - a.length)[0];
}

function legacyEntries(status, previous) {
  const entries = new Map(previous.filter(entry => owns(status, entry.destination, entry.path)).map(entry => [entry.id, structuredClone(entry)]));
  for (const record of status.downloads || []) {
    if (record.status !== 'done' || typeof record.repoId !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(record.repoId) || record.repoId.split('/').some(part => ['.', '..'].includes(part))) continue;
    const root = record.destination || rootsOf(status).find(candidate => typeof record.filePath === 'string' && p.join(candidate, record.repoId, record.filePath) === record.dest) || status.downloadDir;
    const target = p.join(root, record.repoId);
    if (!owns(status, root, target) || typeof record.filePath !== 'string' || p.isAbsolute(record.filePath) || p.normalize(record.filePath) !== record.filePath) continue;
    const file = p.join(target, record.filePath);
    if (!inside(target, file) || file === target || (record.dest && record.dest !== file)) continue;
    const key = id(`hf\0${root}\0${record.repoId}`);
    const entry = entries.get(key) || { id: key, source: 'hf', name: record.repoId, repoId: record.repoId, path: target, destination: root, relative: p.relative(root, target), directory: true, browseRelative: p.relative(root, target), files: [], updatedAt: Date.now() };
    const old = entry.files.find(item => item.path === record.filePath);
    const transfer = record.id || `${record.revision}/${record.filePath}`;
    // Remember observed revisions so an older retained row cannot undo a newer
    // file after the newer row is cleared. New completions replace provenance.
    if (!old || !(old.transfers || []).includes(transfer)) {
      const file = { path: record.filePath, size: size(record.downloaded || record.total), revision: record.revision, transfers: [...(old?.transfers || []), transfer] };
      if (old) entry.files[entry.files.indexOf(old)] = file; else entry.files.push(file);
    }
    entries.set(key, entry);
  }
  for (const torrent of status.torrents || []) {
    if (!torrent.done || !torrent.infoHash) continue;
    const asset = torrent.dataPath || torrent.path;
    const root = owns(status, torrent.destination, asset) ? torrent.destination : safeRoot(status, asset);
    if (!root) continue;
    const files = (torrent.files || []).filter(file => file.selected !== false).map(file => ({ target: p.resolve(torrent.path || root, file.path), size: size(file.length) }));
    if (!files.length || files.some(file => !inside(asset, file.target))) continue;
    const directory = files.length !== 1 || files[0].target !== asset;
    const relative = p.relative(root, asset), key = id(`torrent\0${root}\0${torrent.infoHash}`);
    entries.set(key, { id: key, source: 'torrent', infohash: torrent.infoHash, name: torrent.name, path: asset, destination: root, relative, directory, browseRelative: directory ? relative : p.dirname(relative) === '.' ? '' : p.dirname(relative), files: files.map(file => ({ path: p.relative(asset, file.target), size: file.size })), updatedAt: Date.now() });
  }
  return [...entries.values()];
}

/** request is the existing authenticated Spark request function; never a shell command. */
export class SparkInventoryCache {
  constructor(store) { this.store = store; this.lastCheck = null; this.pending = new Map(); this.generation = 0; }

  invalidate() {
    this.generation++; this.lastCheck = null;
    delete this.store.state.sparkInventory;
  }

  queue(host, run) {
    const generation = this.generation;
    const task = (this.pending.get(host) || Promise.resolve()).catch(() => {}).then(() => {
      if (generation !== this.generation) throw new Error('Spark connection changed. Refresh its inventory again.');
      return run(generation);
    });
    this.pending.set(host, task);
    task.finally(() => { if (this.pending.get(host) === task) this.pending.delete(host); }).catch(() => {});
    return task;
  }

  load(host, request, options) {
    return this.queue(host, async generation => this._enrich(host, await request({ action: 'status' }), request, options, generation));
  }

  cached(host) {
    const cache = this.store.state.sparkInventory;
    return cache?.host === host ? structuredClone(cache) : undefined;
  }

  enrich(host, status, request, options) {
    return this.queue(host, generation => this._enrich(host, status, request, options, generation));
  }

  async _enrich(host, status, request, { force = false } = {}, generation) {
    const previous = this.cached(host);
    let inventory;
    if (Array.isArray(status.inventory)) inventory = status.inventory;
    else {
      const sameDevice = previous?.hostname === status.hostname && previous?.downloadDir === status.downloadDir;
      inventory = legacyEntries(status, sameDevice ? previous.inventory || [] : []);
      const fingerprint = JSON.stringify([host, status.hostname, status.storage?.map(root => [root.path, root.available]), inventory.map(entry => [entry.id, entry.files])]);
      if (!force && this.lastCheck?.fingerprint === fingerprint && Date.now() - this.lastCheck.time < 30000) inventory = this.lastCheck.inventory;
      else {
        const listings = new Map();
        for (const entry of inventory) {
          let missingFiles = 0, error = '';
          if (status.storage?.find(root => root.path === entry.destination)?.available === false) error = 'Storage unavailable. Reconnect or mount this drive on Spark.';
          else for (const file of entry.files || []) {
            const target = file.path ? p.resolve(entry.path, file.path) : entry.path;
            if (!inside(entry.path, target) || !inside(entry.destination, target)) { error = 'Saved file path is unavailable.'; break; }
            const directory = p.relative(entry.destination, p.dirname(target)), key = `${entry.destination}\0${directory}`;
            if (!listings.has(key)) {
              // Bound work for old companions; newer companions validate their own inventory.
              if (listings.size >= 64) { error = 'Update the Spark companion to verify this larger library.'; break; }
              try { listings.set(key, await request({ action: 'files', root: entry.destination, relative: directory })); }
              catch (failure) { listings.set(key, { error: failure.message }); }
            }
            const listing = listings.get(key);
            if (listing.error) { error = listing.error; break; }
            const found = listing.entries?.find(item => item.relative === p.relative(entry.destination, target));
            if (!found && listing.truncated) { error = 'Update the Spark companion to verify this larger folder.'; break; }
            if (!found || found.directory || found.size !== file.size) missingFiles++;
          }
          Object.assign(entry, { fileCount: entry.files?.length || 0, size: (entry.files || []).reduce((total, file) => total + size(file.size), 0), missingFiles, available: !error && missingFiles === 0, error: error || (missingFiles ? `${missingFiles} downloaded file${missingFiles === 1 ? ' is' : 's are'} missing or changed.` : '') });
        }
        if (generation === this.generation) this.lastCheck = { fingerprint, inventory: structuredClone(inventory), time: Date.now() };
      }
    }
    const enriched = { ...status, inventory };
    if (generation !== this.generation) throw new Error('Spark connection changed. Refresh its inventory again.');
    const cache = { host, ...snapshot(enriched) };
    if (host === this.store.getSettings().sparkHost && JSON.stringify(cache) !== JSON.stringify(this.store.state.sparkInventory)) {
      this.store.state.sparkInventory = cache;
      this.store._flush();
    }
    return enriched;
  }
}
