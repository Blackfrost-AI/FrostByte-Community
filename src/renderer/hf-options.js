// Build explicit download choices from repository metadata. Each choice contains
// one weight variant; split weights stay together and alternate formats stay out.
const basename = path => path.split('/').at(-1);
const dirname = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
const isSupport = path => /\.(json|model|txt|tiktoken|jinja|jinja2|py|yaml|yml|msgpack)$/i.test(path)
  || /^(readme|license|notice|\.gitattributes)(\.|$)/i.test(basename(path));

const SHARD_PATTERNS = [
  // Standard HF split layout. Accept 1–5 digit part/total counts (e.g. model-1-of-3,
  // model-0001-of-0008, model-00001-of-00002) so non-5-digit splits are grouped and
  // completeness-checked instead of being offered as independent "complete" weights.
  /^(.*)-(\d{1,5})-of-(\d{1,5})\.(gguf|safetensors|bin|pt|pth|onnx)$/i,
  /^(.*)\.(gguf|safetensors|bin|pt|pth|onnx)\.part(\d+)of(\d+)$/i,
];

export function parseShardFile(filePath) {
  const path = String(filePath || '');
  const std = path.match(SHARD_PATTERNS[0]);
  if (std) {
    return {
      stem: std[1],
      extension: std[4].toLowerCase(),
      part: Number(std[2]),
      total: Number(std[3]),
      key: `${std[4].toLowerCase()}:${std[1]}`,
    };
  }
  const part = path.match(SHARD_PATTERNS[1]);
  if (part) {
    return {
      stem: part[1],
      extension: part[2].toLowerCase(),
      part: Number(part[3]),
      total: Number(part[4]),
      key: `${part[2].toLowerCase()}:${part[1]}`,
    };
  }
  return null;
}

export function selectionSize(files) {
  return {
    bytes: files.reduce((sum, file) => sum + (Number(file.size) > 0 ? Number(file.size) : 0), 0),
    unknown: files.filter(file => !(Number(file.size) > 0)).length,
  };
}

export function groupRepoFilesForBrowser(files = []) {
  const shardMap = new Map();
  const entries = [];
  for (const file of files) {
    const shard = parseShardFile(file?.path);
    if (!shard) {
      entries.push({ type: 'file', file });
      continue;
    }
    if (!shardMap.has(shard.key)) {
      const group = {
        type: 'shard-group',
        id: shard.key,
        stem: shard.stem,
        extension: shard.extension,
        total: shard.total,
        files: [],
      };
      shardMap.set(shard.key, group);
      entries.push(group);
    }
    shardMap.get(shard.key).files.push(file);
  }
  return entries.map(entry => {
    if (entry.type !== 'shard-group') return entry;
    if (entry.files.length <= 1) return { type: 'file', file: entry.files[0] };
    return {
      ...entry,
      ...selectionSize(entry.files),
      paths: entry.files.map(file => file.path),
    };
  });
}

export function buildHfOptions(files) {
  const groups = new Map();
  for (const file of files) {
    const shard = parseShardFile(file.path);
    const extension = shard?.extension || file.path.match(/\.(gguf|safetensors|bin)$/i)?.[1].toLowerCase();
    // .bin also contains tokenizers and training state. Only recognize named
    // PyTorch model weights; other files remain available in Customize files.
    if (!extension || !['gguf', 'safetensors', 'bin'].includes(extension) || (extension === 'bin' && !/^pytorch_model(?:-\d+-of-\d+)?\.bin$/i.test(basename(file.path)))) continue;
    if (/^(optimizer|training_args|scheduler)(\.|_)/i.test(basename(file.path))) continue;
    const stem = shard ? shard.stem : file.path.slice(0, -(extension.length + 1));
    const key = `${extension}:${stem}`;
    if (!groups.has(key)) groups.set(key, { id: key, stem, extension, weights: [], parts: [], totals: [] });
    const group = groups.get(key);
    group.weights.push(file);
    if (shard) { group.parts.push(shard.part); group.totals.push(shard.total); }
  }

  // Merge single-shard or folder-grouped safetensors checkpoints when a subfolder contains multiple non-numbered weight files (e.g. EXL2/EXL3/MLX)
  const options = [...groups.values()].map(group => {
    const { id, stem, extension, weights, parts, totals } = group;
    const directory = dirname(stem);
    const expected = Math.max(0, ...totals);
    const incomplete = expected > 0 && (totals.some(total => total !== expected)
      || parts.length !== weights.length || new Set(parts).size !== expected
      || parts.some(part => part < 1 || part > expected));
    const support = files.filter(file => {
      if (!isSupport(file.path)) return false;
      const parent = dirname(file.path);
      // Ancestor metadata and same-folder support belong to this variant.
      if (parent !== directory && !(directory && directory.startsWith(parent))) return false;
      if (/\.(safetensors|bin)\.index\.json$/i.test(file.path)) return file.path === `${stem}.${extension}.index.json`;
      if (extension === 'gguf') return /^(readme|license|notice)(\.|$)/i.test(basename(file.path));
      return !/(^|\/)(optimizer|scheduler|training_args|trainer_state)(\.|_)/i.test(file.path);
    });
    const weightPaths = weights.map(file => file.path);
    const supportPaths = support.map(file => file.path);
    const paths = [...new Set([...weightPaths, ...supportPaths])];
    const quant = basename(stem).match(/(?:^|[.\-_])((?:IQ|TQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32|MXFP4)(?=$|[.\-])/i)?.[1].toUpperCase();
    const cleanDir = directory ? directory.slice(0, -1) : '';
    const dirQuant = cleanDir.match(/(?:^|[\/.\-_])((?:IQ|TQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32|MXFP4)(?=$|[\/.\-_])/i)?.[1].toUpperCase();
    const effectiveQuant = quant || dirQuant;
    const auxiliary = extension === 'gguf' && /mmproj|projector/i.test(basename(stem));
    return {
      id, paths, weightPaths, supportPaths,
      weightCount: weights.length,
      supportCount: support.length,
      shardCount: expected || weights.length,
      incomplete, auxiliary,
      format: extension === 'gguf' ? 'GGUF' : extension === 'safetensors' ? 'Safetensors' : 'PyTorch',
      label: extension === 'gguf' ? (auxiliary ? `Vision projector${effectiveQuant ? ` · ${effectiveQuant}` : ''}` : effectiveQuant || basename(stem))
        : `${extension === 'safetensors' ? 'Safetensors' : 'PyTorch'}${directory || !['model', 'pytorch_model'].includes(basename(stem)) ? ` · ${stem}` : ''}`,
      detail: expected ? `${stem} (${expected} parts)` : weights[0].path,
      description: incomplete ? `Incomplete split: ${new Set(parts).size} of ${expected} parts available`
        : auxiliary ? 'Companion file for a matching vision model'
        : extension === 'gguf' ? `${weights.length > 1 ? `All ${weights.length} parts included` : 'Single weight file'}${support.length ? ' · includes model notes' : ''}`
        : `${weights.length} weight file${weights.length === 1 ? '' : 's'} + ${support.length} supporting file${support.length === 1 ? '' : 's'}`,
      ...selectionSize(files.filter(file => paths.includes(file.path))),
    };
  });
  const rank = { GGUF: 0, Safetensors: 1, PyTorch: 2 };
  return options.sort((a, b) => Number(a.incomplete) - Number(b.incomplete)
    || Number(a.auxiliary) - Number(b.auxiliary)
    || rank[a.format] - rank[b.format] || Number(a.unknown > 0) - Number(b.unknown > 0)
    || a.bytes - b.bytes || a.detail.localeCompare(b.detail));
}
