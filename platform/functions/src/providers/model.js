/**
 * The normalized discovery record.
 *
 * Three upstreams with three different envelopes, three different param names
 * for search, and three different units for `params` all collapse into this.
 * The shape is deliberately small: it carries what the discovery UI renders and
 * what an install decision needs, and nothing else.
 *
 * Quant tokens are preserved verbatim (see docs/hub-api.md) — never normalised,
 * never lowercased, never "cleaned". `Q4_K_M` and `q4_k_m` are different
 * history in this ecosystem.
 */

export const PROVIDERS = Object.freeze(['huggingface', 'localmaxxing', 'pirateface']);

const QUANT_PATTERN =
  /(?:^|[-_.])((?:I?Q\d+(?:_[A-Z0-9]+)*)|(?:BF16|FP16|FP8|FP32|F16|F32|MXFP4|NVFP4|AWQ|GPTQ|EXL2|GGUF))(?=$|[-_.])/i;

/**
 * Build a normalized record. Every adapter funnels through here so field
 * coercion (and its failure modes) exist in exactly one place.
 */
export function normalizeModel(input) {
  const provider = String(input.provider || '');
  const providerId = String(input.providerId || '');
  if (!PROVIDERS.includes(provider)) throw new TypeError(`Unknown provider: ${provider}`);
  if (!providerId) throw new TypeError('normalizeModel requires a providerId');

  const id = `${provider}:${providerId}`;
  const tags = toStringArray(input.tags);

  return {
    id,
    provider,
    providerId,
    name: cleanString(input.name) || providerId,
    author: cleanString(input.author) || '',
    summary: cleanString(input.summary) || '',
    task: cleanString(input.task) || '',
    license: cleanString(input.license) || '',
    parameterCount: toPositiveInt(input.parameterCount),
    parameterLabel: cleanString(input.parameterLabel) || '',
    sizeBytes: toPositiveInt(input.sizeBytes),
    downloads: toNonNegativeInt(input.downloads),
    likes: toNonNegativeInt(input.likes),
    tags,
    quant: cleanString(input.quant) || extractQuant(providerId) || extractQuant(input.name),
    // Torrent infohash (pirateface only, usually empty). Lowercase 40-hex or ''.
    // Moderation rules match on this field, so it is normalized here once.
    infoHash: normalizeInfoHash(input.infoHash || input.meta?.infoHash || ''),
    updatedAt: toIsoOrNull(input.updatedAt),
    urls: {
      page: cleanString(input.urls?.page) || '',
      files: cleanString(input.urls?.files) || '',
    },
    // Everything below is provider-specific passthrough that the UI may render
    // but must never branch on for security decisions.
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  };
}

/**
 * Extract a quantization token from a name, preserving its exact spelling.
 * Returns '' when the name carries no recognizable quant token.
 */
export function extractQuant(name) {
  if (typeof name !== 'string' || name === '') return '';
  const match = QUANT_PATTERN.exec(name);
  return match ? match[1] : '';
}

function normalizeInfoHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{40}$/.test(value)) return '';
  return value.toLowerCase();
}

function cleanString(value) {
  if (typeof value !== 'string') return '';
  // Strip control characters; keep everything else byte-for-byte.
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 512);
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const cleaned = cleanString(entry);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= 64) break;
  }
  return out;
}

function toPositiveInt(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

function toNonNegativeInt(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Human label for a raw parameter count, e.g. 27781427952 → "27.8B". */
export function formatParams(count) {
  if (!Number.isFinite(count) || count <= 0) return '';
  if (count >= 1e12) return `${(count / 1e12).toFixed(1).replace(/\.0$/, '')}T`;
  if (count >= 1e9) return `${(count / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(count);
}