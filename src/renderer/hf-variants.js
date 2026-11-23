// Pure helpers for the Hugging Face model page: group download options into weight-format families, label quants,
// give conservative memory-fit hints, and work out whether this model is already downloading or saved.
// No DOM, no IPC — unit-tested in tests/hf-variants.test.js.
import { detectHfFormats } from '../shared/hf-formats.js';

const FAMILIES = {
  exl3: { label: 'EXL3', primary: true, order: 0, blurb: 'ExLlamaV3 quant · primary FrostByte serving format' },
  nvfp4: { label: 'NVFP4', primary: true, order: 1, blurb: 'NVIDIA FP4 · primary format for Blackwell / DGX Spark' },
  exl2: { label: 'EXL2', order: 2, blurb: 'ExLlamaV2 quant' },
  mxfp4: { label: 'MXFP4', order: 3, blurb: 'Microscaling FP4' },
  awq: { label: 'AWQ', order: 4, blurb: 'Activation-aware 4-bit quant' },
  gptq: { label: 'GPTQ', order: 5, blurb: 'GPTQ quant' },
  mlx: { label: 'MLX', order: 6, blurb: 'Apple MLX weights' },
  gguf: { label: 'GGUF', order: 7, blurb: 'llama.cpp / Ollama / LM Studio' },
  safetensors: { label: 'Safetensors', order: 8, blurb: 'Full weights for vLLM, SGLang and Transformers' },
  pytorch: { label: 'PyTorch', order: 9, blurb: 'Legacy .bin weights' },
  companion: { label: 'Companion files', order: 10, blurb: 'Download alongside a matching model' },
  incomplete: { label: 'Incomplete uploads', order: 11, blurb: 'Some split parts are missing from this repository' },
};
const REPO_FAMILIES = ['exl3', 'nvfp4', 'exl2', 'mxfp4', 'awq', 'gptq', 'mlx'];
const BPW = /(?:^|[^\d.])(\d{1,2}(?:\.\d{1,2})?)\s*bpw\b/i;
const GGUF_QUANT = /(?:^|[.\-_])((?:IQ|TQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32|MXFP4)(?=$|[.\-_])/i;
// Quant-family token as a path segment or delimited name part (folder-scoped detection).
const FAMILY_TOKEN = /(?:^|[\/.\-_])(exl3|nvfp4|exl2|mxfp4|awq|gptq|mlx)(?=$|[\/.\-_])/i;

export function variantFamily(option, repo = {}) {
  const make = id => ({ id, ...FAMILIES[id] });
  if (option?.incomplete) return make('incomplete');
  if (option?.auxiliary) return make('companion');
  if (option?.format === 'GGUF') return make('gguf');
  if (option?.format === 'PyTorch') return make('pytorch');
  const detail = String(option?.detail || '');
  // 1) The option's own path is the strongest signal: a BPW folder or a quant-family
  //    segment classifies this variant even when the repo ships several formats.
  if (BPW.test(detail)) return make('exl3');
  const fromPath = detail.match(FAMILY_TOKEN);
  if (fromPath) return make(fromPath[1].toLowerCase());
  // 2) Repo-level fallback only when unambiguous. A repo named for a quant family is
  //    that family; otherwise a single quant tag with no original-safetensors tag.
  //    Mixed repos (quant subfolders + fp16 root weights) must not stamp the root
  //    full-precision option with a quant family, so ambiguity resolves to safetensors.
  const repoFormats = new Set(detectHfFormats(repo).map(format => format.id));
  const repoName = String(repo?.id || '').split('/')[1] || '';
  const fromName = repoName.match(FAMILY_TOKEN);
  if (fromName) return make(fromName[1].toLowerCase());
  const repoQuant = REPO_FAMILIES.filter(id => repoFormats.has(id));
  if (repoQuant.length === 1 && !repoFormats.has('safetensors')) return make(repoQuant[0]);
  return make('safetensors');
}

export function quantLabel(option, repo = {}) {
  const detail = String(option?.detail || '');
  if (option?.format === 'GGUF') {
    const match = (detail.split('/').pop() || '').replace(/\.gguf$/i, '').match(GGUF_QUANT) || String(option.label || '').match(GGUF_QUANT);
    return match ? match[1].toUpperCase() : '';
  }
  const bpw = detail.match(BPW) || String(repo?.id || '').match(BPW);
  if (bpw) return `${bpw[1]} bpw`;
  const family = variantFamily(option, repo).id;
  return ['nvfp4', 'mxfp4', 'awq', 'gptq'].includes(family) ? FAMILIES[family].label : '';
}

// Runtime needs headroom beyond the weights (KV cache, activations, OS). These ratios are a hint, not a promise.
export function fitHint(bytes, memoryBytes) {
  const size = Number(bytes); const memory = Number(memoryBytes);
  if (!(size > 0) || !(memory > 0)) return null;
  if (size * 1.2 <= memory * 0.85) return { level: 'fits', text: 'Fits in memory' };
  if (size * 1.05 <= memory * 0.95) return { level: 'tight', text: 'Tight fit · little room for context' };
  return { level: 'too-large', text: 'Larger than device memory' };
}

export function groupVariants(options, repo = {}, { memoryBytes } = {}) {
  const groups = new Map();
  for (const option of options || []) {
    const family = variantFamily(option, repo);
    if (!groups.has(family.id)) groups.set(family.id, { ...family, items: [] });
    groups.get(family.id).items.push({
      option, quant: quantLabel(option, repo), fit: fitHint(option.unknown ? 0 : option.bytes, memoryBytes), recommended: false,
    });
  }
  const ordered = [...groups.values()].sort((a, b) => a.order - b.order);
  for (const group of ordered) {
    if (group.id === 'companion' || group.id === 'incomplete') continue;
    const sized = group.items.filter(item => !item.option.unknown && item.option.bytes > 0);
    let pick;
    if (Number(memoryBytes) > 0) {
      const fitting = sized.filter(item => item.fit?.level === 'fits');
      pick = fitting.sort((a, b) => b.option.bytes - a.option.bytes)[0];
    } else {
      pick = [...sized].sort((a, b) => a.option.bytes - b.option.bytes)[0];
    }
    if (pick) pick.recommended = true;
  }
  return ordered;
}

const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const num = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

export function modelLifecycle(repoId, { transfers = [], inventory = [] } = {}) {
  if (!repoId) return { state: 'none', downloading: [], saved: [] };
  const groups = new Map();
  for (const row of transfers || []) {
    if (!row || !sameRepo(row.repoId, repoId) || row.status === 'cancelled') continue;
    const key = JSON.stringify([row.device || 'local', row.deviceId || row.sparkHost || '', row.destination || '']);
    if (!groups.has(key)) groups.set(key, { device: row.device || 'local', deviceId: row.deviceId, deviceName: row.deviceName, files: [] });
    groups.get(key).files.push(row);
  }
  const downloading = [];
  for (const group of groups.values()) {
    if (group.files.every(file => file.status === 'done')) continue;
    const total = group.files.reduce((sum, file) => sum + num(file.total), 0);
    const downloaded = group.files.reduce((sum, file) => sum + Math.min(num(file.downloaded), num(file.total) || num(file.downloaded)), 0);
    const status = ['active', 'queued', 'error', 'paused'].find(s => group.files.some(file => file.status === s)) || 'queued';
    downloading.push({ device: group.device, deviceId: group.deviceId, deviceName: group.deviceName, status, downloaded, total,
      progress: total > 0 ? Math.min(1, downloaded / total) : null, files: group.files.length });
  }
  const saved = (inventory || []).filter(entry => entry?.source === 'hf' && sameRepo(entry.repoId, repoId));
  return { state: downloading.length ? 'downloading' : saved.length ? 'saved' : 'none', downloading, saved };
}
