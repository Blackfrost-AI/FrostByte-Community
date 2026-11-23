/** Metadata-only discovery. A scan never downloads, moves, loads, or shares files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkModelCompleteness } from '../shared/content-kind.js';

const posix = path.posix;
const MAX_MODELS = 5000;
const MAX_FILES = 40000;
const MAX_DIRECTORIES = 2000;
const MAX_DEPTH = 16;
const WEIGHT = /\.(?:gguf|ggml|safetensors|onnx|pt|pth|ckpt|tflite|mlmodel)$|^(?:pytorch_model|adapter_model|model)[^/]*\.bin$/i;
const CONFIG = /^(?:config|model_index|adapter_config|params)\.json$/i;
const skip = name => name.startsWith('.') || /(?:\.frostpart(?:\.json)?|\.partial|\.incomplete|\.tmp)$/i.test(name)
  || ['node_modules', '__pycache__', 'venv', 'env', 'blobs'].includes(name);
const digest = value => createHash('sha256').update(value).digest('hex');
const beneath = (root, value) => root === '' || value === root || value.startsWith(root + '/');
const clean = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const rel = value => clean(value) && !value.includes('\\') && !value.includes(':')
  && !posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const keyPath = (value, device) => device === 'local' && process.platform === 'win32' ? value.toLowerCase() : value;
const absolute = (root, relative, device) => (device === 'local' ? path : posix).resolve(root, relative);
export const modelLocationId = source => digest(`${source.deviceId || 'local'}\0${source.root}`);
const modelId = row => 'scan:' + digest(`${row.deviceId || 'local'}\0${keyPath(row.path, row.device)}`);

export function modelLocation({ root, device = 'local', deviceId = '', name = '', binding = '' }) {
  const paths = device === 'local' ? path : posix;
  if (!['local', 'spark'].includes(device) || !clean(root) || !paths.isAbsolute(root)
    || paths.resolve(root) === paths.parse(paths.resolve(root)).root || (device === 'local' && process.platform === 'win32' && /^(?:\\\\|\/\/|\\[?.]\\)/.test(root))
    || (device === 'spark' && (!clean(deviceId) || !deviceId))) throw new Error('Choose a saved model folder, not an entire drive.');
  return { root: paths.resolve(root), device, deviceId: device === 'local' ? '' : deviceId,
    name: clean(name) && name ? name : device === 'local' ? 'This computer' : 'Remote device', binding };
}

/** No symlink traversal, model execution, file-content reads, or unbounded walk. */
export async function localModelDirectory(root, relative, { signal } = {}) {
  signal?.throwIfAborted();
  if (relative && !rel(relative)) throw new Error('Invalid model folder.');
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('This model location is missing or is a symbolic link.');
  const realRoot = await fs.realpath(root);
  const target = path.resolve(root, relative);
  let current = root;
  for (const component of relative ? relative.split('/') : []) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A model folder is unavailable or linked.');
  }
  const realTarget = await fs.realpath(target);
  const within = path.relative(realRoot, realTarget);
  if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) throw new Error('A model folder moved outside its saved location.');
  const entries = [];
  let truncated = false;
  const directory = await fs.opendir(target);
  for await (const item of directory) {
    signal?.throwIfAborted();
    if (skip(item.name) || item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) continue;
    if (entries.length >= 1000) { truncated = true; break; }
    const stat = await fs.lstat(path.join(target, item.name));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
    entries.push({ name: item.name, relative: posix.join(relative, item.name), directory: stat.isDirectory(), size: stat.size });
  }
  if (await fs.realpath(target) !== realTarget || await fs.realpath(root) !== realRoot) throw new Error('A model folder changed while scanning.');
  return { root, relative, entries, truncated };
}

/** Existing companion file-listing RPCs work without installing a new service. */
export async function scanModelLocation(source, readDirectory, { signal, onProgress = () => {}, limits = {} } = {}) {
  source = modelLocation(source);
  const files = [], queue = [''], warnings = new Set();
  const maximumFiles = limits.files ?? MAX_FILES, maximumDirectories = limits.directories ?? MAX_DIRECTORIES;
  const maximumDepth = limits.depth ?? MAX_DEPTH;
  let directories = 0;
  const report = () => onProgress({ directories, files: files.length });
  while (queue.length) {
    signal?.throwIfAborted();
    if (directories >= maximumDirectories || files.length >= maximumFiles) { warnings.add('Scan limit reached. Add a more specific model location to scan the remaining folders.'); break; }
    const relative = queue.shift();
    let listing;
    try { listing = await readDirectory(source, relative, { signal }); }
    catch (error) {
      signal?.throwIfAborted();
      if (!relative) throw error;
      warnings.add(`Could not read ${relative}: ${String(error.message || error).slice(0, 250)}`);
      continue;
    }
    if (listing.root !== source.root || listing.relative !== relative || !Array.isArray(listing.entries) || listing.entries.length > 1000) throw new Error('The device returned a different or invalid model folder.');
    directories++;
    if (listing.truncated) warnings.add(`Only part of ${relative || source.root} could be listed. Use a smaller saved location.`);
    const seen = new Set();
    for (const entry of listing.entries) {
      if (!clean(entry.name) || !entry.name || entry.name.includes('/') || entry.name.includes('\\') || !rel(entry.relative)
        || entry.relative !== posix.join(relative, entry.name) || typeof entry.directory !== 'boolean'
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || seen.has(entry.name)) throw new Error('The device returned an invalid model file entry.');
      seen.add(entry.name);
      if (skip(entry.name)) continue;
      if (entry.directory) {
        if (entry.relative.split('/').length <= maximumDepth && queue.length + directories < maximumDirectories) queue.push(entry.relative);
        else warnings.add('Scan depth or folder limit reached. Add a more specific model location.');
      } else if (files.length < maximumFiles) files.push({ relative: entry.relative, size: entry.size });
      else warnings.add('File limit reached. Add a more specific model location.');
    }
    report();
  }
  const configs = new Set(files.filter(file => CONFIG.test(posix.basename(file.relative))).map(file => posix.dirname(file.relative)));
  const rootShards = files.some(file => posix.dirname(file.relative) === '.' && (/-\d{5}-of-\d{5}\./i.test(file.relative) || /\.part\d+of\d+$/i.test(file.relative)));
  const candidates = new Map();
  for (const file of files) {
    const name = posix.basename(file.relative);
    if (!WEIGHT.test(name) || file.size === 0) continue;
    const parent = posix.dirname(file.relative);
    const standalone = /\.(?:gguf|ggml|onnx|tflite|mlmodel)$/i.test(name) && !/-\d{5}-of-\d{5}\./i.test(name) && !/\.part\d+of\d+$/i.test(name);
    let relative = file.relative, directory = false;
    if (!standalone) {
      let folder = parent;
      while (folder !== '.' && !configs.has(folder)) folder = posix.dirname(folder);
      folder = configs.has(folder) ? folder : parent;
      if (folder !== '.') { relative = folder; directory = true; }
      // A specifically saved model folder may itself contain its config and
      // shards. A bare weights file in a storage root stays a single-file item.
      else if (configs.has('.') || rootShards) { relative = ''; directory = true; }
    }
    const candidate = { ...source, source: 'scan', relative, directory, path: absolute(source.root, relative, source.device) };
    candidates.set(relative, candidate);
  }
  // Index ancestry once instead of comparing every file with every model.
  // Large GGUF libraries stay linear in the number of files and path depth.
  const parentCandidate = (relative, map) => {
    if (!relative) return null;
    let folder = posix.dirname(relative);
    while (folder !== '.') {
      if (map.get(folder)?.directory) return map.get(folder);
      folder = posix.dirname(folder);
    }
    return map.get('') || null;
  };
  const selected = new Map([...candidates].filter(([relative]) => !parentCandidate(relative, candidates)));
  const manifests = new Map();
  for (const file of files) {
    const candidate = selected.get(file.relative) || parentCandidate(file.relative, selected);
    if (!candidate) continue;
    if (!manifests.has(candidate.relative)) manifests.set(candidate.relative, []);
    manifests.get(candidate.relative).push(file);
  }
  const rows = [];
  for (const candidate of selected.values()) {
    const manifest = manifests.get(candidate.relative) || [];
    if (!manifest.length) continue;
    const bytes = manifest.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(bytes) || manifest.length > 5000) { warnings.add(`Model ${candidate.relative} exceeds the safe inventory limit.`); continue; }
    rows.push({ ...candidate, id: modelId(candidate), locationId: modelLocationId(source), name: posix.basename(candidate.relative || source.root),
      deviceName: source.name, kind: 'model', destination: source.root, browseRelative: candidate.directory ? candidate.relative : posix.dirname(candidate.relative) === '.' ? '' : posix.dirname(candidate.relative),
      files: manifest, fileCount: manifest.length, size: bytes, available: true, updatedAt: Date.now() });
  }
  if (rows.length > MAX_MODELS) warnings.add('Model limit reached. Use more specific saved model directories.');
  return { rows: rows.slice(0, MAX_MODELS), directories, files: files.length,
    warnings: [...warnings].slice(0, 20), complete: warnings.size === 0 && rows.length <= MAX_MODELS };
}

function savedRow(value) {
  const source = modelLocation({ ...value, name: value.deviceName || value.name });
  if (!(rel(value.relative) || value.relative === '' && value.directory === true) || !Array.isArray(value.files) || !value.files.length || value.files.length > 5000) throw new Error('Invalid saved model.');
  const target = absolute(source.root, value.relative, source.device);
  const files = value.files.map(file => {
    if (!rel(file.relative) || !(value.directory ? beneath(value.relative, file.relative) : value.relative === file.relative)
      || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid saved model manifest.');
    return { relative: file.relative, size: file.size };
  });
  const size = files.reduce((total, file) => total + file.size, 0);
  if (!Number.isSafeInteger(size)) throw new Error('Invalid saved model size.');
  const row = { ...source, source: 'scan', relative: value.relative, directory: value.directory === true, path: target,
    name: posix.basename(value.relative || source.root), deviceName: source.name, destination: source.root,
    browseRelative: value.directory ? value.relative : posix.dirname(value.relative) === '.' ? '' : posix.dirname(value.relative),
    files, fileCount: files.length, size, kind: 'model', available: value.available !== false,
    updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : 0,
    error: clean(value.error) ? value.error : '' };
  return { ...row, id: modelId(row), locationId: modelLocationId(source) };
}

export class ModelLibrary {
  constructor({ store, sources, readDirectory, isCurrent = () => true, onChange = () => {} }) {
    this.store = store; this.sources = sources; this.readDirectory = readDirectory; this.isCurrent = isCurrent; this.onChange = onChange;
    this.rows = [];
    for (const row of (Array.isArray(store.state.modelLibrary?.rows) ? store.state.modelLibrary.rows : []).slice(-MAX_MODELS)) {
      try { this.rows.push(savedRow(row)); } catch { /* Invalid saved metadata grants no path authority. */ }
    }
    this.progress = { phase: 'idle', locations: [], finishedAt: store.state.modelLibrary?.finishedAt || null };
    this.controller = null;
    this.pushTimer = null;
    this.lastPush = 0;
  }
  list() {
    const current = new Map();
    return this.rows.filter(row => {
      const key = `${row.locationId}\0${row.binding || ''}`;
      if (!current.has(key)) current.set(key, this.isCurrent(row));
      return current.get(key);
      }).map(({ files, binding, ...row }) => ({
      ...structuredClone(row),
      completeness: checkModelCompleteness(files),
      }));
  }
  snapshot() { return { items: this.list(), scan: structuredClone(this.progress) }; }
  changed() {
    if (this.controller && Date.now() - this.lastPush < 120) {
      if (!this.pushTimer) {
        this.pushTimer = setTimeout(() => { this.pushTimer = null; this.changed(); }, 120);
        this.pushTimer.unref?.();
      }
      return;
    }
    clearTimeout(this.pushTimer); this.pushTimer = null; this.lastPush = Date.now();
    this.onChange(this.snapshot());
  }
  entry(id) {
    const row = this.rows.find(row => row.id === id && this.isCurrent(row));
    if (!row) throw new Error('This model location is no longer saved. Scan your locations again.');
    return structuredClone(row);
  }
  async importLocalFolder(folderPath, { name = 'This computer' } = {}) {
    const source = modelLocation({ root: folderPath, device: 'local', name });
    const result = await scanModelLocation(source, this.readDirectory);
    if (!result.rows.length) {
      throw new Error('No model weights (.gguf, .safetensors, .bin, .pt, .onnx) were found in that folder.');
    }
    const locId = modelLocationId(source);
    const remaining = this.rows.filter(row => row.locationId !== locId);
    const merged = new Map([...remaining, ...result.rows].map(row => [row.id, row]));
    this._save([...merged.values()]);
    this.progress = {
      ...this.progress,
      phase: 'complete',
      finishedAt: Date.now(),
      message: `Imported ${result.rows.length} model${result.rows.length === 1 ? '' : 's'} from ${path.basename(source.root)}.`,
    };
    this.changed();
    return { imported: result.rows.length, snapshot: this.snapshot() };
  }
  async localManifest(id) {
    const entry = this.entry(id);
    if (entry.device !== 'local' || !entry.available) throw new Error('Scan this available local model before sharing it.');
    const listings = new Map();
    for (const file of entry.files) {
      const parent = posix.dirname(file.relative) === '.' ? '' : posix.dirname(file.relative);
      if (!listings.has(parent)) listings.set(parent, await localModelDirectory(entry.root, parent));
      const current = listings.get(parent).entries.find(item => item.relative === file.relative);
      if (!current || current.directory || current.size !== file.size) throw new Error('Model files changed or are unavailable. Scan the location again before sharing.');
    }
    if (!this.isCurrent(entry) || JSON.stringify(this.entry(id)) !== JSON.stringify(entry)) throw new Error('The model location changed. Scan again before sharing.');
    return { path: entry.path, files: entry.files.map(file => ({ path: path.resolve(entry.root, file.relative), size: file.size })) };
  }
  _save(rows = this.rows) {
    if (rows.length > MAX_MODELS || Buffer.byteLength(JSON.stringify(rows)) > 12 * 1024 * 1024) throw new Error('The model library is full. Use more specific saved locations.');
    const next = { schemaVersion: 1, rows, finishedAt: this.progress.finishedAt };
    this.store._commitStateFields({ modelLibrary: next });
    this.rows = rows;
  }
  start() {
    if (this.controller) return this.snapshot();
    const controller = this.controller = new AbortController();
    this.progress = { phase: 'scanning', startedAt: Date.now(), finishedAt: null, locations: [], message: 'Checking saved model locations…' };
    this.changed();
    this.pending = this._run(controller).catch(error => {
      this.progress.message = String(error.message || error);
      this.progress.phase = controller.signal.aborted ? 'cancelled' : 'error';
    }).finally(() => { this.controller = null; this.changed(); });
    return this.snapshot();
  }
  cancel() {
    if (this.controller) {
      this.progress.phase = 'cancelling';
      this.controller.abort(new Error('Scan stopped. Previously saved models were kept.'));
      this.changed();
    }
    return this.snapshot();
  }
  async _run(controller) {
    const sources = await this.sources({ signal: controller.signal });
    controller.signal.throwIfAborted();
    this.progress.locations = sources.map(source => ({ ...source, id: modelLocationId(source), status: 'pending', directories: 0, files: 0, models: 0, message: '' })).map(({ binding, ...source }) => source);
    const queue = sources.map((source, index) => ({ source, report: this.progress.locations[index] }));
    const worker = async () => {
      while (queue.length) {
        controller.signal.throwIfAborted();
        const { source, report } = queue.shift();
        report.status = 'scanning'; this.changed();
        try {
          if (source.error) throw new Error(source.error);
          const result = await scanModelLocation(source, this.readDirectory, { signal: controller.signal,
            onProgress: value => { Object.assign(report, value); this.changed(); } });
          controller.signal.throwIfAborted();
          if (!this.isCurrent(source)) throw new Error('The saved connection or model location changed during scanning. Scan again.');
          const found = new Map(result.rows.map(row => [row.id, row]));
          const remaining = this.rows.filter(row => row.locationId !== report.id);
          const previous = this.rows.filter(row => row.locationId === report.id && !found.has(row.id));
          const retained = result.complete ? previous.map(row => ({ ...row, available: false, error: 'Not found in the latest scan. Files were not deleted by FrostByte.' })) : previous;
          const merged = new Map([...remaining, ...retained, ...result.rows].map(row => [row.id, row]));
          this._save([...merged.values()]);
          Object.assign(report, { status: result.complete ? 'complete' : 'warning', directories: result.directories, files: result.files, models: result.rows.length,
            message: result.warnings.join(' ') });
        } catch (error) {
          controller.signal.throwIfAborted();
          report.status = 'unavailable'; report.message = String(error.message || error).slice(0, 1500);
        }
        this.changed();
      }
    };
    await Promise.allSettled([worker(), worker()]);
    controller.signal.throwIfAborted();
    this.progress.phase = 'complete'; this.progress.finishedAt = Date.now();
    this.progress.message = this.progress.locations.some(location => ['unavailable', 'warning'].includes(location.status))
      ? 'Scan finished with some locations unavailable or incomplete. Previously found models were kept.' : 'Scan complete. Files stayed in place; sharing is unchanged.';
    this._save();
  }
}
