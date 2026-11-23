/** Content categories describe the files, independently of their transport. */
export const validContentKind = value => value === 'model' || value === 'torrent';
export function contentKind(entry) {
  if (validContentKind(entry?.kind)) return entry.kind;
  if (entry?.source === 'hf') return 'model';
  const names = [entry?.name, entry?.path, entry?.relative, ...(entry?.files || []).filter(file => file.selected !== false).map(file => file.relative || file.path || file.name)];
  return names.some(name => /\.(?:gguf|ggml|safetensors|onnx|pt|pth|ckpt|tflite|mlmodel|mlpackage)(?:$|\/)/i.test(name || '') || /(?:^|[/\\])(?:pytorch_model|adapter_model|model)[^/\\]*\.bin$/i.test(name || '')) ? 'model' : 'torrent';
}
export function contentType(entry) {
  if (contentKind(entry) === 'model') return 'Model';
  const names = [entry?.path, entry?.name, ...(entry?.files || []).map(file => file.relative || file.path || file.name)].join('\n');
  if (/\.(?:mp4|mkv|mov|avi|webm|m4v)(?:$|\n)/i.test(names)) return 'Video';
  if (/\.(?:pdf|docx?|xlsx?|pptx?|epub|txt|md)(?:$|\n)/i.test(names)) return 'Documents';
  if (/\.(?:exe|msi|dmg|pkg|app|iso|deb|rpm|appimage)(?:$|\n)/i.test(names)) return 'Software';
  if (/\.(?:mp3|flac|wav|m4a|ogg)(?:$|\n)/i.test(names)) return 'Audio';
  if (/\.(?:zip|7z|rar|tar|gz|bz2|xz)(?:$|\n)/i.test(names)) return 'Archive';
  return 'Files';
}

const SHARD_CHECK_RE = /^(.*)-(\d{5})-of-(\d{5})\.(gguf|safetensors|bin|pt|pth|onnx)$/i;
const PART_CHECK_RE = /^(.*)\.(gguf|safetensors|bin|pt|pth|onnx)\.part(\d+)of(\d+)$/i;

export function checkModelCompleteness(fileNames = []) {
  const names = (fileNames || []).map(item => typeof item === 'string' ? item : (item?.relative || item?.path || item?.name || '')).filter(Boolean);
  if (!names.length) return { complete: true, missingShards: 0, missingConfig: false, issues: [], summary: '' };
  const baseNames = names.map(name => String(name).replaceAll('\\', '/').split('/').pop());
  const shardGroups = new Map();
  let hasNonGgufWeights = false;
  let hasGgufWeights = false;
  for (const name of names) {
    const normalized = String(name).replaceAll('\\', '/');
    const base = normalized.split('/').pop();
    if (/\.(safetensors|pt|pth|onnx)$/i.test(base) || /^(?:pytorch_model|adapter_model|model)[^/]*\.bin$/i.test(base)) {
      hasNonGgufWeights = true;
    }
    if (/\.gguf$/i.test(base) || /\.gguf\.part\d+of\d+$/i.test(base)) {
      hasGgufWeights = true;
    }
    const std = normalized.match(SHARD_CHECK_RE);
    if (std) {
      const key = `${std[4].toLowerCase()}:${std[1].toLowerCase()}:${Number(std[3])}`;
      if (!shardGroups.has(key)) shardGroups.set(key, { stem: std[1], ext: std[4], total: Number(std[3]), parts: new Set() });
      shardGroups.get(key).parts.add(Number(std[2]));
      continue;
    }
    const part = normalized.match(PART_CHECK_RE);
    if (part) {
      const key = `${part[2].toLowerCase()}:${part[1].toLowerCase()}:${Number(part[4])}`;
      if (!shardGroups.has(key)) shardGroups.set(key, { stem: part[1], ext: part[2], total: Number(part[4]), parts: new Set() });
      shardGroups.get(key).parts.add(Number(part[3]));
    }
  }
  let missingShards = 0;
  for (const group of shardGroups.values()) {
    for (let i = 1; i <= group.total; i++) {
      if (!group.parts.has(i)) missingShards++;
    }
  }
  const hasConfig = baseNames.some(base => /^(config|params|adapter_config|model_index)\.json$/i.test(base));
  const missingConfig = hasNonGgufWeights && !hasGgufWeights && !hasConfig && (shardGroups.size > 0 || names.length > 1);
  const issues = [];
  if (missingShards > 0) issues.push(`${missingShards} shard${missingShards === 1 ? '' : 's'} missing`);
  if (missingConfig) issues.push('config.json missing');
  return {
    complete: missingShards === 0 && !missingConfig,
    missingShards,
    missingConfig,
    issues,
    summary: issues.join(' · '),
  };
}
