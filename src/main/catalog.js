/**
 * Model catalog.
 *
 * A catalog entry is just "how to find a model on the swarm": a magnet link
 * or infohash plus enough metadata to have an opinion about it before you
 * pull 60 GB. Nothing here hosts anything — every entry points at peers.
 *
 * Three sources, merged in this order (later wins on duplicate infohash):
 *   1. the bundled starter list  (catalog/starter.json)
 *   2. a remote list, if configured
 *   3. whatever the user has added or is seeding locally
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInfoHash } from './torrent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STARTER = path.resolve(here, '../../catalog/starter.json');
export const MAX_CATALOG_IMPORT_ENTRIES = 2000;
const MAX_USER_CATALOG_ENTRIES = 5000;

export class Catalog {
  constructor(store) {
    this.store = store; // { getUserCatalog(), setUserCatalog() }
    this._starter = [];
    this._remote = [];
    this.sanitizeSaved();
    this.loadStarter();
  }

  sanitizeSaved() {
    const raw = Array.isArray(this.store.getUserCatalog()) ? this.store.getUserCatalog() : [];
    const order = [], retained = new Set(), byId = new Map(), byKey = new Map();
    for (const entry of raw.slice(-MAX_USER_CATALOG_ENTRIES)) {
      try {
        const normalized = normalize(entry);
        for (const previous of [byId.get(normalized.id), byKey.get(key(normalized))]) if (previous) retained.delete(previous);
        byId.set(normalized.id, normalized); byKey.set(key(normalized), normalized);
        order.push(normalized); retained.add(normalized);
      } catch { /* malformed saved entries never reach the renderer */ }
    }
    const clean = order.filter(entry => retained.has(entry));
    if (JSON.stringify(clean) !== JSON.stringify(raw)) this.store.setUserCatalog(clean);
  }

  loadStarter() {
    try {
      const raw = JSON.parse(fs.readFileSync(STARTER, 'utf8'));
      this._starter = Array.isArray(raw.models) ? raw.models : [];
    } catch {
      this._starter = [];
    }
  }

  commit(list, hidden = this.store.state?.hiddenCatalog ?? []) {
    if (typeof this.store.setCatalogState === 'function') return this.store.setCatalogState(list, hidden);
    const previous = this.store.state?.hiddenCatalog;
    if (this.store.state) this.store.state.hiddenCatalog = hidden;
    try { return this.store.setUserCatalog(list); }
    catch (error) {
      if (this.store.state) this.store.state.hiddenCatalog = previous;
      throw error;
    }
  }

  /** Merge all sources into one de-duplicated list. */
  all() {
    const byHash = new Map();
    for (const m of this._starter) byHash.set(key(m), { ...m, source: 'starter' });
    for (const m of this._remote) byHash.set(key(m), { ...m, source: 'remote' });
    for (const m of this.store.getUserCatalog()) byHash.set(key(m), { ...m, source: m.source ?? 'local' });
    const hidden = this.store.state?.hiddenCatalog ?? [];
    return [...byHash.values()].filter(m => !hidden.includes(key(m)));
  }

  add(entry) {
    const e = normalize(entry);
    const list = this.store.getUserCatalog().filter((m) => key(m) !== key(e) && m.id !== e.id);
    if (list.length >= MAX_USER_CATALOG_ENTRIES) throw new Error(`The catalog can contain up to ${MAX_USER_CATALOG_ENTRIES} entries.`);
    const hidden = (this.store.state?.hiddenCatalog ?? []).filter(h => h !== key(e));
    list.push(e);
    this.commit(list, hidden);
    return e;
  }

  /** Validate and commit a remote import with one atomic state write. */
  addMany(entries) {
    if (!Array.isArray(entries)) throw new Error('That JSON has no "models" array.');
    if (entries.length > MAX_CATALOG_IMPORT_ENTRIES) throw new Error(`A catalog import can contain up to ${MAX_CATALOG_IMPORT_ENTRIES} entries.`);
    let list = this.store.getUserCatalog().slice();
    let hidden = [...(this.store.state?.hiddenCatalog ?? [])];
    const added = [];
    let skipped = 0;
    for (const entry of entries) {
      try {
        const normalized = normalize({ ...entry, source: 'remote' });
        list = list.filter(item => key(item) !== key(normalized) && item.id !== normalized.id);
        if (list.length >= MAX_USER_CATALOG_ENTRIES) throw new Error('catalog full');
        hidden = hidden.filter(value => value !== key(normalized));
        list.push(normalized);
        added.push(normalized);
      } catch { skipped++; }
    }
    // Invalid-only imports are a validation failure for the caller. Do not
    // run even an apparently no-op state commit: Store.setCatalogState also
    // normalizes legacy hidden entries, which would mutate catalog state
    // before persistCatalogImport reports the failure.
    if (added.length) this.commit(list, hidden);
    return { added, skipped };
  }

  remove(idOrHash) {
    const entry = this.all().find(m => m.id === idOrHash || key(m) === idOrHash);
    if (!entry) return false;
    const hidden = [...new Set([...(this.store.state?.hiddenCatalog ?? []), key(entry)])];
    this.commit(this.store.getUserCatalog().filter(m => key(m) !== key(entry)), hidden);
    return true;
  }

  /** Mark whether a catalog entry is present on disk / in the client. */
  annotate(entries, torrents) {
    const byHash = new Map();
    for (const t of torrents) byHash.set(String(t.infoHash).toLowerCase(), t);
    return entries.map((e) => {
      const live = byHash.get(key(e));
      return {
        ...e,
        inClient: !!live,
        progress: live?.progress ?? 0,
        seeding: live?.seeding ?? false,
        numPeers: live?.numPeers ?? 0,
        downloadSpeed: live?.downloadSpeed ?? 0,
        uploadSpeed: live?.uploadSpeed ?? 0,
      };
    });
  }

  search(entries, { q = '', types = [], onlyLocal = false, onlySeeding = false } = {}) {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (onlyLocal && !e.inClient) return false;
      if (onlySeeding && !e.seeding) return false;
      if (types.length && !types.some((t) => (e.tags ?? []).includes(t))) return false;
      if (!needle) return true;
      const hay = [
        e.name, e.publisher, e.notes, e.params, e.quant, e.format,
        ...(e.tags ?? []),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }
}

function key(m) {
  return extractInfoHash(m.infohash || m.magnet) || m.torrent || m.id;
}

export function normalizeCatalogEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('A catalog entry must be an object');
  const name = field(e.name, '', 200).trim();
  if (!name) throw new Error('A catalog entry needs a name');
  const magnet = field(e.magnet, '', 8192).trim();
  const suppliedHash = field(e.infohash, '', 128);
  if (magnet && !/^magnet:\?/i.test(magnet)) throw new Error('A catalog magnet link must use the magnet scheme');
  const magnetHash = magnet ? extractInfoHash(magnet) : null;
  const suppliedInfoHash = suppliedHash ? extractInfoHash(suppliedHash) : null;
  if (magnet && !magnetHash) throw new Error('A catalog entry has an invalid magnet link');
  if (suppliedHash && !suppliedInfoHash) throw new Error('A catalog entry has an invalid infohash');
  if (magnetHash && suppliedInfoHash && magnetHash !== suppliedInfoHash) throw new Error('A catalog magnet link does not match its infohash');
  const infohash = suppliedInfoHash || magnetHash;
  if (!infohash) {
    throw new Error('A catalog entry needs a valid magnet link or infohash');
  }
  const numericSize = Number(e.sizeBytes);
  return {
    id: field(e.id, '', 200) || `${slug(name)}-${infohash.slice(0, 8)}`,
    name,
    publisher: field(e.publisher, 'unknown', 200),
    params: field(e.params, '', 100),
    quant: field(e.quant, '', 100),
    format: field(e.format, '', 100),
    sizeBytes: Number.isSafeInteger(numericSize) && numericSize > 0 ? numericSize : 0,
    license: field(e.license, 'unclear', 200),
    // Catalog data is discovery metadata, so retain only the content identity.
    // Trackers, web seeds, direct peers, filesystem paths, and display text from
    // an imported row never become an automatic network or filesystem target.
    magnet: `magnet:?xt=urn:btih:${infohash}`,
    infohash,
    torrent: '',
    tags: Array.isArray(e.tags) ? [...new Set(e.tags.filter(t => typeof t === 'string').slice(0, 32).map(t => field(t, '', 64)).filter(Boolean))] : [],
    notes: field(e.notes, '', 4000),
    source: ['local', 'user', 'remote'].includes(e.source) ? e.source : 'local',
    addedAt: validDate(e.addedAt) ? e.addedAt : new Date().toISOString(),
    seededBy: field(e.seededBy, '', 200),
  };
}

const normalize = normalizeCatalogEntry;

function field(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) throw new Error('Catalog field is invalid or too long');
  return value;
}

function validDate(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

export { slug };
