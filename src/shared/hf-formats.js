// Weight-format detection for Hugging Face search results and model pages.
// EXL3 and NVFP4 are FrostByte's primary serving formats; everything else is still shown so users can find it.
// Detection reads only the repo id and Hub tags (no file listing), so it is a hint, never a guarantee.

const FORMATS = [
  { id: 'exl3', label: 'EXL3', primary: true, tags: ['exl3'], name: /(^|[-_.])exl3($|[-_.])/i },
  { id: 'nvfp4', label: 'NVFP4', primary: true, tags: ['nvfp4'], name: /(^|[-_.])nvfp4($|[-_.])/i },
  { id: 'exl2', label: 'EXL2', tags: ['exl2'], name: /(^|[-_.])exl2($|[-_.])/i },
  { id: 'mxfp4', label: 'MXFP4', tags: ['mxfp4'], name: /(^|[-_.])mxfp4($|[-_.])/i },
  { id: 'gguf', label: 'GGUF', tags: ['gguf'], name: /(^|[-_.])gguf($|[-_.])/i },
  { id: 'awq', label: 'AWQ', tags: ['awq'], name: /(^|[-_.])awq($|[-_.])/i },
  { id: 'gptq', label: 'GPTQ', tags: ['gptq'], name: /(^|[-_.])gptq($|[-_.])/i },
  { id: 'mlx', label: 'MLX', tags: ['mlx'], name: /^mlx-community\// },
  { id: 'safetensors', label: 'safetensors', tags: ['safetensors'], name: null },
];

const MAX_TAGS = 512;

export function detectHfFormats(model) {
  if (!model || typeof model !== 'object') return [];
  const id = typeof model.id === 'string' ? model.id.slice(0, 256) : '';
  const name = id.includes('/') ? id : '';
  const tags = new Set(Array.isArray(model.tags)
    ? model.tags.slice(0, MAX_TAGS).filter(tag => typeof tag === 'string').map(tag => tag.toLowerCase()) : []);
  return FORMATS
    .filter(format => format.tags.some(tag => tags.has(tag)) || (format.name && format.name.test(format.id === 'mlx' ? id : name.split('/')[1] || '')))
    .map(({ id: formatId, label, primary = false }) => ({ id: formatId, label, primary }));
}

/** Filter chips in display order; `filter` is the Hub tag sent as `filter=`. */
export const HF_FORMAT_CHIPS = FORMATS
  .filter(format => format.id !== 'safetensors')
  .map(({ id, label, primary = false }) => ({ id, label, primary, filter: id }));

const CHIP_FILTERS = new Map(HF_FORMAT_CHIPS.map(chip => [chip.id, chip.filter]));
export const formatSearchFilter = (id) => CHIP_FILTERS.get(id) || '';
