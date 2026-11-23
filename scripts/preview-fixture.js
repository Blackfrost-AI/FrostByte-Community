/** Development-only simulated state. Never connects, downloads, or writes credentials. */
import { identifyDevice } from '../src/shared/device-models.js';

const now = Date.now();
const GB = 1024 ** 3, MB = 1024 ** 2;

const TORRENTS = [
  { infoHash: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd', name: 'Gemma-3-27B-IT-Q4_0.gguf', length: 15.4 * GB,
    downloaded: 3.1 * GB, uploaded: 0, downloadSpeed: 0, uploadSpeed: 0,
    progress: 0.201, ratio: 0, timeRemaining: 0, done: false, seeding: false, paused: true, queued: true,
    numPeers: 0, ready: true, addedAt: Date.now() - 4e6, seededMs: 0,
    files: [{ name: 'Gemma-3-27B-IT-Q4_0.gguf', path: 'x', length: 15.4 * GB, progress: 0.2 }],
    peers: [], magnetURI: 'magnet:?xt=urn:btih:aa11bb22cc33dd44ee55ff6677889900aabbccdd' },
  { infoHash: '5f96d43576e3d386c9ba65b883210a393b68210e', name: 'Grok-1', length: 318 * GB,
    downloaded: 61.4 * GB, uploaded: 12.1 * GB, downloadSpeed: 24.6 * MB, uploadSpeed: 3.9 * MB,
    progress: 0.193, ratio: 0.197, timeRemaining: 106800000, done: false, seeding: false, paused: false,
    numPeers: 14, ready: true, files: [{ name: 'grok-1/tensor-00001.safetensors', path: 'grok-1/tensor-00001.safetensors', length: 4 * GB, progress: 1 }, { name: 'grok-1/tensor-00007.safetensors', path: 'grok-1/tensor-00007.safetensors', length: 4 * GB, progress: 0.4 }],
    peers: [{ addr: '203.0.113.44:51413', type: 'tcp' }, { addr: '198.51.100.9:6881', type: 'utp' }],
    magnetURI: 'magnet:?xt=urn:btih:5f96d43576e3d386c9ba65b883210a393b68210e' },

  { infoHash: '9c1b7f0a4d2e63581504ab9c7f3e2d1a8b6c5e40', name: 'Qwen3-30B-A3B-Q4_K_M.gguf', length: 18.2 * GB,
    downloaded: 18.2 * GB, uploaded: 341 * GB, downloadSpeed: 0, uploadSpeed: 11.4 * MB,
    progress: 1, ratio: 18.7, timeRemaining: 0, done: true, seeding: true, paused: false,
    numPeers: 9, ready: true,
    files: [{ name: 'Qwen3-30B-A3B-Q4_K_M.gguf', path: 'Qwen3-30B-A3B-Q4_K_M.gguf', length: 18.2 * GB, progress: 1 }],
    peers: [{ addr: '203.0.113.42:51413', type: 'utp' }, { addr: '203.0.113.77:51413', type: 'utp' }],
    magnetURI: 'magnet:?xt=urn:btih:9c1b7f0a4d2e63581504ab9c7f3e2d1a8b6c5e40' },

  { infoHash: '8d634925911a03f787d9f68ac075a9b24281573a', name: 'Safe-LLaMA-HF-v2 (4-04-23)', length: 96 * GB,
    downloaded: 96 * GB, uploaded: 47.2 * GB, downloadSpeed: 0, uploadSpeed: 2.1 * MB,
    progress: 1, ratio: 0.49, timeRemaining: 0, done: true, seeding: true, paused: false,
    numPeers: 3, ready: true,
    files: [{ name: 'Safe-LLaMA-HF-v2/model.safetensors', path: 'x', length: 96 * GB, progress: 1 }],
    peers: [{ addr: '192.0.2.88:6881', type: 'tcp' }],
    magnetURI: 'magnet:?xt=urn:btih:8d634925911a03f787d9f68ac075a9b24281573a' },
];

const CATALOG = [
  { id: 'grok-1', name: 'Grok-1', publisher: 'xai-org', params: '314B', quant: 'FP8', format: 'safetensors',
    sizeBytes: 318 * GB, license: 'Apache-2.0', infohash: '5f96d43576e3d386c9ba65b883210a393b68210e', tags: ['text', 'moe'],
    notes: 'Official magnet published by xAI on the model card.', source: 'starter', inClient: true, progress: 0.193, seeding: false, numPeers: 14 },
  { id: 'qwen3-30b-a3b', name: 'Qwen3-30B-A3B', publisher: 'Qwen', params: '30B', quant: 'Q4_K_M', format: 'gguf',
    sizeBytes: 18.2 * GB, license: 'Apache-2.0', infohash: '9c1b7f0a4d2e63581504ab9c7f3e2d1a8b6c5e40', tags: ['text', 'moe', 'gguf'],
    notes: 'MoE — runs dramatically faster than a dense model of similar size.', source: 'local', inClient: true, progress: 1, seeding: true, numPeers: 9 },
  { id: 'safe-llama-hf-v2', name: 'Safe-LLaMA-HF-v2', publisher: 'Neko-Institute-of-Science', params: '7-65B', quant: 'FP16',
    format: 'safetensors', sizeBytes: 96 * GB, license: 'check-model-card',
    infohash: '8d634925911a03f787d9f68ac075a9b24281573a', tags: ['text'],
    notes: 'Served from Internet Archive trackers.', source: 'starter', inClient: true, progress: 1, seeding: true, numPeers: 3 },
  { id: 'mistral-small-24b', name: 'Mistral-Small-24B-Instruct', publisher: 'Mistral', params: '24B', quant: 'Q5_K_M',
    format: 'gguf', sizeBytes: 17.1 * GB, license: 'Apache-2.0', infohash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d',
    tags: ['text', 'gguf'], notes: '', source: 'starter', numPeers: 6 },
  { id: 'llama-33-70b', name: 'Llama-3.3-70B-Instruct', publisher: 'Meta', params: '70B', quant: 'Q4_K_M',
    format: 'gguf', sizeBytes: 42.5 * GB, license: 'Llama-3.3', infohash: 'b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e',
    tags: ['text', 'gguf'], notes: 'Redistribution allowed with duties — display "Built with Llama".', source: 'starter', numPeers: 21 },
  { id: 'gemma-3-27b', name: 'Gemma-3-27B-IT', publisher: 'Google', params: '27B', quant: 'Q4_0', format: 'gguf',
    sizeBytes: 15.4 * GB, license: 'Gemma', infohash: 'c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f',
    tags: ['text', 'vision', 'gguf'], notes: 'Use restrictions must pass downstream.', source: 'starter', numPeers: 8 },
  { id: 'deepseek-coder-lora', name: 'DeepSeek-Coder-LoRA-16k', publisher: 'someone', params: '1.3B', quant: 'FP16',
    format: 'safetensors', sizeBytes: 240 * MB, license: 'MIT', infohash: 'd4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f70',
    tags: ['lora', 'code'], notes: 'A LoRA delta — 240 MB instead of a 14 GB base.', source: 'local', numPeers: 2 },
  { id: 'qwen3-vl-30b', name: 'Qwen3-VL-30B-A3B', publisher: 'Qwen', params: '30B', quant: 'FP8', format: 'safetensors',
    sizeBytes: 31.9 * GB, license: 'Apache-2.0', infohash: 'e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7081',
    tags: ['vision', 'moe'], notes: '', source: 'starter', numPeers: 5 },
];

const LIBRARY = [
  { path: '/Volumes/models/Qwen3-30B-A3B-Q4_K_M.gguf', name: 'Qwen3-30B-A3B-Q4_K_M.gguf',
    infohash: '9c1b7f0a4d2e63581504ab9c7f3e2d1a8b6c5e40',
    magnet: 'magnet:?xt=urn:btih:9c1b7f0a4d2e63581504ab9c7f3e2d1a8b6c5e40&dn=Qwen3-30B-A3B-Q4_K_M.gguf' },
  { path: '/Volumes/models/Safe-LLaMA-HF-v2', name: 'Safe-LLaMA-HF-v2',
    infohash: '8d634925911a03f787d9f68ac075a9b24281573a',
    magnet: 'magnet:?xt=urn:btih:8d634925911a03f787d9f68ac075a9b24281573a&dn=Safe-LLaMA-HF-v2' },
];

const SETTINGS = {
  downloadDir: '/Volumes/models', seedOnComplete: true, catalogUrl: '', theme: 'frost',
  maxConns: 55, dhtEnabled: true, upnpEnabled: true, extraTrackers: 'udp://tracker.opentrackr.org:1337/announce',
  downLimitKBs: 0, upLimitKBs: 0, altDownKBs: 300, altUpKBs: 30,
  schedEnabled: true, schedFrom: '18:00', schedTo: '08:00', schedDays: [0,1,1,1,1,1,0],
  maxActiveDownloads: 4, seedRatioStop: 2, seedMinutesStop: 0,
  moveCompleted: false, completedDir: '',
  confirmBigPull: true, bigPullGB: 50, confirmExitSeeding: true, openAtLogin: false,
};
const STATE = { torrents: TORRENTS, catalog: CATALOG, library: LIBRARY, settings: SETTINGS,
  appDir: '~/Library/Application Support/frostbyte', platform: 'darwin', version: '0.1.0',
  stats: { dhtNodes: 137, port: 51444, upnpMapped: 51444, uptimeS: 4212 },
  rates: { alt: false, manualAlt: false },
  hfToken: { present: true, user: 'demo-user', role: 'read' },
  downloads: [
    { id: 'Qwen/Qwen3-8B/main/model-q4_k_m.gguf', repoId: 'Qwen/Qwen3-8B', revision: 'a1b2c3d4e5f6', filePath: 'model-q4_k_m.gguf',
      dest: '/Users/x/FrostByte/Qwen/Qwen3-8B/model-q4_k_m.gguf', total: 4926757888, downloaded: 2941000000, speedBps: 21400000, etaMs: 92000, status: 'active', error: '', startedAt: 1 },
    { id: 'Qwen/Qwen3-8B/main/tokenizer.json', repoId: 'Qwen/Qwen3-8B', revision: 'a1b2c3d4e5f6', filePath: 'tokenizer.json',
      dest: '/Users/x/FrostByte/Qwen/Qwen3-8B/tokenizer.json', total: 11324588, downloaded: 11324588, speedBps: 0, etaMs: 0, status: 'done', error: '', startedAt: 1 },
  ] };


export function createPreviewApi(version, theme) {
  STATE.version = version;
  STATE.settings.theme = theme;
  STATE.inventory = [];
  STATE.ipfs = { downloads: [], shares: [] };
  STATE.hfToken = { present: false, user: '', role: '' };
  STATE.localDevice = identifyDevice({ platform: 'darwin', modelIdentifier: 'Mac16,10', chip: 'Apple M4', cpuCores: 10, memoryBytes: 24 * GB, gpus: [{ name: 'Apple M4', cores: 10 }] });
  const pi = { id: 'preview-orb', host: 'orb.example.test', name: 'AEON Orb (preview)', connected: true, defaultDir: '/models', status: {
    hardware: identifyDevice({ platform: 'linux', architecture: 'arm64', reportedModel: 'Raspberry Pi 5 Model B Rev 1.0', chip: 'Broadcom BCM2712', cpuCores: 4, memoryBytes: 8 * GB }),
    version, hostname: 'orb.example.test', downloadDir: '/models', storage: [{ path: '/models', available: true, freeBytes: 120 * GB }], torrents: [], downloads: [], inventory: [],
    aeon: { schema: 1, image: 'aeon-magick-orb', version: 'preview', port: 443, tools: ['models', 'devices', 'view'] },
  } };
  STATE.devices = [pi]; STATE.selectedDeviceId = pi.id; STATE.settings.sparkHost = pi.host;
  const ok = data => ({ ok: true, data: structuredClone(data) });
  const unsupported = async () => ({ ok: false, error: 'Preview only — this action is available in the desktop app. Nothing was started or sent.' });
  const api = {
    getState: async () => ok(STATE),
    getPrivacy: async () => ok({ required: false, termsVersion: 'simulated preview', acceptedAt: now, diagnosticsEnabled: false }),
    pendingSources: async () => ok([]),
    deviceStatus: async () => ok(STATE.devices),
    selectDevice: async id => { STATE.selectedDeviceId = id; return ok(STATE); },
    setSettings: async patch => { Object.assign(STATE.settings, patch); return ok(STATE); },
    copyText: async () => false,
    pickSaveDir: async () => null, pickTorrentFile: async () => null,
    pickModelFolder: async () => null, pickCompletedDir: async () => null,
    hfFacets: async () => ok({ pipeline_tag: [{ id: 'text-generation', label: 'Text generation' }], library: [], license: [], language: [] }),
    hfRefs: async () => ok({ branches: [{ name: 'main' }], tags: [] }),
  hfSearch: async (q) => ({ ok: true, data: [
    { id: 'Qwen/Qwen3-8B', gated: false, downloads: 4210000, likes: 912, license: 'apache-2.0', pipelineTag: 'text-generation', lastModified: '2026-08-14T00:00:00Z', tags: [] },
    { id: 'meta-llama/Llama-3.2-1B', gated: 'manual', downloads: 980000, likes: 640, license: 'llama-3.2', pipelineTag: 'text-generation', lastModified: '2026-07-02T00:00:00Z', tags: [] },
    { id: 'google/gemma-3-4b-it', gated: 'auto', downloads: 640000, likes: 388, license: 'gemma', pipelineTag: 'text-generation', lastModified: '2026-08-30T00:00:00Z', tags: [] },
    { id: 'unsloth/Qwen3-8B-GGUF', gated: false, downloads: 310000, likes: 201, license: 'apache-2.0', pipelineTag: 'text-generation', lastModified: '2026-09-01T00:00:00Z', tags: [] },
  ] }),
  hfModel: async (id) => ({ ok: true, data: id.includes('llama')
    ? { id, sha: '4e20de362430e2e7be38a6b3ac2b04b84c9e5b0f', gated: 'manual', license: 'llama-3.2', pipelineTag: 'text-generation', lastModified: '2026-07-02T00:00:00Z', downloads: 980000, likes: 640,
        files: [ { path: '.gitattributes', size: 1580 }, { path: 'LICENSE.txt', size: 20933 }, { path: 'README.md', size: 18422 }, { path: 'config.json', size: 913 }, { path: 'model.safetensors', size: 2471647592 }, { path: 'model.safetensors.index.json', size: 26153 }, { path: 'tokenizer.json', size: 8735469 }, { path: 'tokenizer_config.json', size: 7584 } ] }
    : { id, sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d', gated: false, license: 'apache-2.0', pipelineTag: 'text-generation', lastModified: '2026-08-14T00:00:00Z', downloads: 4210000, likes: 912,
        files: [ { path: '.gitattributes', size: 1575 }, { path: 'README.md', size: 12012 }, { path: 'config.json', size: 820 }, { path: 'model-q4_k_m.gguf', size: 4926757888 }, { path: 'model-q8_0.gguf', size: 8721647592 }, { path: 'model.safetensors', size: 16420751872 }, { path: 'tokenizer.json', size: 11324588 } ] } }),

  };
  // Unsupported operations fail visibly. Event subscriptions remain local no-ops.
  return new Proxy(api, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => () => {};
    return unsupported;
  } });
}
