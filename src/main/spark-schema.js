import path from 'node:path';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = field => { throw new Error(`The device returned invalid status data (${field}). Update or pair the companion again.`); };

function boundedJson(root, { maxString = 65536 } = {}) {
  const seen = new WeakSet(), pending = [{ value: root, depth: 0, field: 'status' }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth, field } = pending.pop();
    if (++nodes > 100000 || depth > 10) invalid(field);
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') { if (value.length > maxString || value.includes('\0')) invalid(field); continue; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(field); continue; }
    if (!value || typeof value !== 'object' || seen.has(value)) invalid(field);
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 10000) invalid(field);
      for (let index = 0; index < value.length; index++) pending.push({ value: value[index], depth: depth + 1, field });
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid(field);
      const entries = Object.entries(value);
      if (entries.length > 64) invalid(field);
      for (const [key, child] of entries) pending.push({ value: child, depth: depth + 1, field: `${field}.${key}` });
    }
  }
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value;
}
function string(value, field, max = 4096, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(field);
  return value;
}
function absolute(value, field) {
  const result = string(value, field, 4096);
  if (!path.posix.isAbsolute(result) || path.posix.normalize(result) !== result) invalid(field);
  return result;
}
function relative(value, field, { empty = true } = {}) {
  const result = string(value, field, 4096);
  if ((!empty && !result) || path.posix.isAbsolute(result) || path.posix.normalize(result || '.') !== (result || '.')
    || result === '..' || result.startsWith('../') || result.includes('/../')) invalid(field);
  return result;
}
function number(value, field, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (nullable && value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) invalid(field);
  return value;
}
function boolean(value, field) {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}
function enumeration(value, field, values) {
  const result = string(value, field, 80);
  if (!values.includes(result)) invalid(field);
  return result;
}
function array(value, field, max, convert) {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value.map((item, index) => convert(item, `${field}[${index}]`));
}
function fields(value, field, schema) {
  const source = object(value, field), result = {};
  for (const [key, convert] of Object.entries(schema)) if (own(source, key)) result[key] = convert(source[key], `${field}.${key}`);
  return result;
}

const text = (max = 4096, options) => (value, field) => string(value, field, max, options);
const size = (value, field) => number(value, field, { integer: true });
const count = (value, field) => number(value, field, { integer: true, max: 1000000 });
const metric = (value, field) => number(value, field, { max: Number.MAX_VALUE, nullable: true });
const flag = (value, field) => boolean(value, field);
// A hardware reading: a bounded finite number, or null when the device did not measure it. Never coerced to 0.
const reading = (max) => (value, field) => value === null ? null : number(value, field, { max });
const location = (value, field) => absolute(value, field);

const fileSchema = (value, field) => fields(value, field, {
  name: text(1024), path: text(4096), length: size, size,
  selected: flag, progress: metric, revision: text(80),
  transfers: (value, field) => array(value, field, 256, (item, child) => string(item, child, 512)),
});

const inventorySchema = (value, field) => fields(value, field, {
  id: text(512), source: (value, field) => enumeration(value, field, ['hf', 'torrent']), kind: (value, field) => enumeration(value, field, ['model', 'torrent']),
  name: text(1024), repoId: text(512), infoHash: text(80), infohash: text(80), path: location, destination: location,
  relative: text(4096), browseRelative: text(4096), directory: flag, updatedAt: size, fileCount: count, size,
  available: flag, missingFiles: count, error: text(16384),
  files: (value, field) => array(value, field, 5000, fileSchema),
});

const torrentSchema = (value, field) => fields(value, field, {
  infoHash: text(80), magnetURI: text(32768), name: text(1024), length: size, downloaded: size, uploaded: size,
  downloadSpeed: metric, uploadSpeed: metric, progress: metric, ratio: metric, timeRemaining: metric,
  done: flag, partial: flag, seeding: flag, explicitShare: flag, hfSource: flag, paused: flag, queued: flag,
  numPeers: count, ready: flag, waitingForPeers: flag, inventoryId: text(512), kind: (value, field) => enumeration(value, field, ['model', 'torrent']),
  createdBy: text(4096, { nullable: true }), comment: text(16384, { nullable: true }), path: text(4096, { nullable: true }),
  dataPath: text(4096, { nullable: true }), destination: location, addedAt: size, seededMs: size,
  completionGeneration: count, error: text(16384),
  files: (value, field) => array(value, field, 5000, fileSchema),
  peers: (value, field) => array(value, field, 5000, (peer, child) => fields(peer, child, { addr: text(512), type: text(80) })),
});

const downloadSchema = (value, field) => fields(value, field, {
  id: text(512), repoId: text(512), revision: text(80), filePath: text(4096), destination: location, dest: location,
  total: size, downloaded: size, progress: metric, speedBps: metric, etaMs: metric, completedAt: size,
  status: (value, field) => enumeration(value, field, ['active', 'queued', 'paused', 'done', 'error', 'cancelled']),
  phase: (value, field) => enumeration(value, field, ['downloading', 'verifying']), removed: flag, error: text(16384),
});

const hardwareSchema = (value, field) => fields(value, field, {
  schemaVersion: count, platform: (value, field) => enumeration(value, field, ['darwin', 'linux', 'win32', 'unknown']), architecture: text(160),
  vendor: text(160), modelIdentifier: text(160), reportedModel: text(160), name: text(160), kind: text(80), chip: text(160),
  memoryBytes: size, cpuCores: count, logicalCpuCount: count, formFactor: (value, field) => enumeration(value, field, ['laptop', 'desktop']),
  osVersion: text(160), artwork: text(160), artworkMatch: text(80), source: text(2048),
  gpus: (value, field) => array(value, field, 16, (gpu, child) => fields(gpu, child, { name: text(160), cores: count, source: (value, field) => enumeration(value, field, ['model', 'system']) })),
});

const ipfsFileSchema = (value, field) => fields(value, field, { path: text(4096), cid: text(200), size, downloaded: size, done: flag, hash: text(64) });
const ipfsSchema = (value, field) => fields(value, field, {
  available: flag, error: text(4000),
  stats: (value, field) => fields(value, field, { uploadSpeed: metric, uploaded: size, peers: count }),
  downloads: (value, field) => array(value, field, 500, (row, field) => fields(row, field, {
    id: text(80), source: text(4096), name: text(255), folder: text(255), destination: location, dest: location,
    total: size, downloaded: size, speedBps: metric, updatedAt: size, available: flag, missingFiles: count, cleared: flag, removed: flag, sharing: flag, shareCid: text(200),
    kind: (value, field) => enumeration(value, field, ['model', 'torrent']),
    status: (value, field) => enumeration(value, field, ['active', 'queued', 'paused', 'done', 'error', 'cancelled']), error: text(4000),
    files: (value, field) => array(value, field, 5000, ipfsFileSchema),
  })),
});
const aeonSchema = (value, field) => fields(value, field, {
  schema: count, image: text(80), version: text(80), port: count,
  tools: (value, field) => array(value, field, 3, (item, field) => enumeration(item, field, ['models', 'devices', 'view'])),
});

// The companion reports only a health descriptor for the fixed model server.
// Keep URLs, credentials, headers, and other connection material out of saved
// device status; Studio combines this bounded port with the already-approved
// device address in main.
const endpointSchema = (value, field) => {
  if (value === null) return null;
  const source = object(value, field);
  return {
    port: number(source.port, `${field}.port`, { integer: true, min: 1, max: 65535 }),
    state: enumeration(source.state, `${field}.state`, ['ready', 'auth-required', 'not-ready', 'unreachable']),
    detail: string(source.detail, `${field}.detail`, 4096),
  };
};

/** Validate and copy only fields understood by the desktop before persistence or rendering. */
export function sanitizeSparkStatus(value) {
  boundedJson(value);
  return fields(value, 'status', {
    version: text(80), protocolVersion: count, hostname: text(255), architecture: text(160), downloadDir: location,
    storageRoots: (value, field) => array(value, field, 16, location),
    storage: (value, field) => array(value, field, 16, (root, child) => fields(root, child, { path: location, freeBytes: size, totalBytes: size, available: flag, error: text(16384) })),
    freeBytes: size, totalBytes: size, memoryBytes: size,
    hardware: hardwareSchema, aeon: aeonSchema, ipfs: ipfsSchema, endpoint: endpointSchema,
    capabilities: (value, field) => fields(value, field, { downloads: flag, sharing: flag, storage: flag, ipfs: flag,
      torrentFileDeletion: flag, inventoryFileDeletion: flag, assistant: (value, field) => number(value, field, { integer: true, min: 1, max: 100 }), runtime: (value, field) => enumeration(value, field, ['docker', 'mac-native']) }),
    inventoryControls: flag, hfHybrid: count,
    inventory: (value, field) => array(value, field, 5000, inventorySchema),
    torrents: (value, field) => array(value, field, 2000, torrentSchema),
    downloads: (value, field) => array(value, field, 5000, downloadSchema),
  });
}

const folderEntry = (value, field) => {
  const source = object(value, field);
  return {
    name: string(source.name, `${field}.name`, 1024),
    path: absolute(source.path, `${field}.path`),
  };
};

const browserFile = (value, field) => {
  const source = object(value, field);
  const result = {
    name: string(source.name, `${field}.name`, 1024),
    relative: relative(source.relative, `${field}.relative`, { empty: false }),
    directory: boolean(source.directory, `${field}.directory`),
    size: size(source.size, `${field}.size`),
  };
  if (own(source, 'modified')) result.modified = string(source.modified, `${field}.modified`, 100);
  return result;
};

/** Validate file-browser results before they cross from a companion to the renderer. */
export function sanitizeSparkFiles(value) {
  boundedJson(value);
  const source = object(value, 'files');
  return {
    root: absolute(source.root, 'files.root'),
    relative: relative(source.relative, 'files.relative'),
    truncated: boolean(source.truncated, 'files.truncated'),
    entries: array(source.entries, 'files.entries', 1000, browserFile),
  };
}

/** Validate folder-picker results from both temporary setup and paired connections. */
export function sanitizeSparkFolderListing(value) {
  boundedJson(value);
  const source = object(value, 'folders');
  return {
    path: absolute(source.path, 'folders.path'),
    parent: absolute(source.parent, 'folders.parent'),
    folders: array(source.folders, 'folders.folders', 500, folderEntry),
    shortcuts: array(source.shortcuts, 'folders.shortcuts', 16, folderEntry),
  };
}

/** Validate the unauthenticated setup probe before it reaches setup state or UI. */
export function sanitizeSparkProbe(value) {
  boundedJson(value);
  const source = object(value, 'setup probe');
  const rawDevice = object(source.device, 'setup probe.device');
  const rawRequirements = object(source.requirements, 'setup probe.requirements');
  const device = {
    hostname: string(rawDevice.hostname, 'setup probe.device.hostname', 255),
    architecture: string(rawDevice.architecture, 'setup probe.device.architecture', 160),
    platform: string(rawDevice.platform, 'setup probe.device.platform', 80),
    home: absolute(rawDevice.home, 'setup probe.device.home'),
  };
  if (own(rawDevice, 'hardware')) device.hardware = hardwareSchema(rawDevice.hardware, 'setup probe.device.hardware');
  const requirements = {};
  for (const field of ['dockerInstalled', 'dockerAccess', 'agentInstalled', 'containerConflict', 'desktopSession']) {
    requirements[field] = boolean(rawRequirements[field], `setup probe.requirements.${field}`);
  }
  const result = {
    device,
    downloadDir: absolute(source.downloadDir, 'setup probe.downloadDir'),
    requirements,
  };
  if (own(source, 'frigidLibrary')) result.frigidLibrary = source.frigidLibrary === null
    ? null : absolute(source.frigidLibrary, 'setup probe.frigidLibrary');
  return result;
}

const MAX_HYBRID_METADATA_CHARS = Math.ceil((4 * 1024 * 1024) / 3) * 4;
const controlActions = new Set([
  'torrent:pause', 'torrent:resume', 'torrent:remove',
  'inventory:kind', 'inventory:sharing', 'inventory:remove', 'ipfs:control', 'ipfs:sharing',
  'hf:pause', 'hf:resume', 'hf:clear', 'hf:remove', 'hf:restore',
]);

function sanitizeTorrentResult(value) {
  boundedJson(value);
  const result = torrentSchema(value, 'torrent result');
  if (!/^[a-f0-9]{40}$/i.test(result.infoHash || '')) invalid('torrent result.infoHash');
  result.infoHash = result.infoHash.toLowerCase();
  return result;
}

function sanitizeHybridPlan(value) {
  if (value === null) return null;
  boundedJson(value, { maxString: MAX_HYBRID_METADATA_CHARS });
  const source = object(value, 'HF peer plan');
  const identity = fields(source.identity, 'HF peer plan.identity', {
    repoId: text(200), revision: text(40), filePath: text(4096), size, sha256: text(64),
  });
  if (!identity.repoId || !identity.filePath || !/^[a-f0-9]{40}$/.test(identity.revision || '')
    || !/^[a-f0-9]{64}$/.test(identity.sha256 || '') || !Number.isSafeInteger(identity.size) || identity.size <= 0) {
    invalid('HF peer plan.identity');
  }
  const metadata = string(source.metadata, 'HF peer plan.metadata', MAX_HYBRID_METADATA_CHARS);
  if (!metadata || metadata.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(metadata)) invalid('HF peer plan.metadata');
  const peers = array(source.peers, 'HF peer plan.peers', 8, (peer, field) => string(peer, field, 64));
  return { identity, metadata, peers };
}

/** Validate and copy every companion reply before it reaches state or the renderer. */
export function sanitizeSparkResponse(action, data) {
  if (action === 'assistant:models') {
    const list = array(data?.models, 'assistant models', 1024, (item, field) => fields(item, field, {
      id: (value, child) => { const valueText = text(40)(value, child); if (!/^m_[a-f0-9]{32}$/.test(valueText)) invalid(child); return valueText; },
      name: text(240), deviceId: text(100),
      provider: (value, child) => enumeration(value, child, ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'sglang']),
      state: (value, child) => enumeration(value, child, ['ready', 'loading', 'available', 'offline', 'incompatible']),
      contextChars: (value, child) => number(value, child, { integer: true, min: 1, max: 10000000 }),
      capabilities: (value, child) => array(value, child, 1, (entry, nested) => enumeration(entry, nested, ['chat'])),
    }));
    return { models: list, runtimes: [] };
  }
  if (action === 'assistant:chat:cancel') return { cancelled: data?.cancelled === true };
  if (action === 'status') return sanitizeSparkStatus(data);
  if (action === 'device:telemetry' || action === 'device:recipes' || action === 'device:control') {
    boundedJson(data);
    const source = object(data, action);
    if (source.schema !== 1) invalid(`${action}.schema`);
    const recipeId = (value, field) => {
      const id = string(value, field, 128);
      if (!/^[A-Za-z0-9._-]+$/.test(id)) invalid(field);
      return id;
    };
    if (action === 'device:control') return { schema: 1, ...fields(source, action, {
      operation: (value, field) => enumeration(value, field, ['check', 'start', 'stop']), recipeId,
      state: text(80), observedState: text(80), message: text(1000), reviewDigest: text(64),
    }) };
    if (action === 'device:recipes') return { schema: 1, recipes: array(source.recipes, 'device recipes', 32,
      (value, field) => fields(value, field, { id: recipeId, title: text(160),
        kind: (v, f) => enumeration(v, f, ['docker', 'tmux']), state: text(40), available: flag })) };
    return { schema: 1, ...fields(source, action, {
      collectedAt: text(80), hostname: text(255), architecture: text(80),
      uptimeSeconds: (value, field) => value === null ? null : number(value, field),
      load: (value, field) => array(value, field, 3, metric),
      memory: (value, field) => fields(value, field, { totalBytes: size, freeBytes: size }),
      storage: (value, field) => value === null ? null : fields(value, field, { path: location, totalBytes: size, freeBytes: size, available: flag }),
      docker: (value, field) => fields(value, field, { available: flag, containers: (rows, f) => array(rows, f, 64,
        (row, child) => fields(row, child, { name: text(255), state: text(80), status: text(255), image: text(512), Names: text(255), State: text(80), Status: text(255), Image: text(512) })) }),
      bridgeRevision: (value, field) => number(value, field, { integer: true, min: 1, max: 1000 }),
      cpu: (value, field) => fields(value, field, { utilizationPercent: reading(100) }),
      gpu: (value, field) => fields(value, field, { name: text(128),
        temperatureC: (v, f) => v === null ? null : number(v, f, { min: -50, max: 200 }),
        utilizationPercent: reading(100), powerWatts: reading(5000) }),
      network: (value, field) => fields(value, field, { rxBytesPerSecond: reading(1e15), txBytesPerSecond: reading(1e15) }),
      endpoint: (value, field) => fields(value, field, {
        state: (v, f) => enumeration(v, f, ['ready', 'auth-required', 'not-ready', 'unreachable', 'unknown']),
        port: (v, f) => v === null ? null : number(v, f, { integer: true, min: 1, max: 65535 }) }),
      capabilities: (value, field) => fields(value, field, { docker: flag, gpu: flag, power: flag }),
    }) };
  }
  if (action === 'ipfs:add') {
    if (typeof data !== 'string' || !/^ipfs:[a-f0-9]{64}$/.test(data)) invalid('IPFS transfer ID');
    return data;
  }
  if (action === 'ipfs:inspect') {
    boundedJson(data);
    return fields(data, 'IPFS preview', { id: text(80), source: text(4096), name: text(255), total: size, expires: size,
      files: (value, field) => array(value, field, 5000, ipfsFileSchema) });
  }
  if (action === 'files') return sanitizeSparkFiles(data);
  if (action === 'host:folders') return sanitizeSparkFolderListing(data);
  if (action === 'torrent:add' || action === 'seed') return sanitizeTorrentResult(data);
  if (action === 'hf:peer') return sanitizeHybridPlan(data);
  if (action === 'hf:add') {
    boundedJson(data);
    return array(data, 'HF download result', 2000, (id, field) => {
      const result = string(id, field, 64);
      if (!/^[a-f0-9]{64}$/.test(result)) invalid(field);
      return result;
    });
  }
  if (controlActions.has(action)) {
    if (data !== true) invalid(`${action} result`);
    return true;
  }
  if (action === 'pairing:ping' || action === 'pairing:revoke') {
    boundedJson(data);
    const field = action === 'pairing:ping' ? 'restricted' : 'revoked';
    const source = object(data, `${action} result`);
    if (source[field] !== true) invalid(`${action} result.${field}`);
    return { [field]: true };
  }
  invalid('response action');
}
