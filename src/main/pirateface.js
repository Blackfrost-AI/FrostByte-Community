/**
 * Pirate Face public model-torrent discovery adapter.
 *
 * Pure Node module (no Electron imports) so parsing, magnet normalization,
 * infohash cross-checks, portable path validation, and license resolution are
 * directly unit-testable offline.
 *
 * Security invariants:
 * - Requests go only to https://pirateface.co with redirect: 'error' and
 *   credentials: 'omit'. No tokens or local inventory ever leave the machine.
 * - Trackers and webseeds in Pirate Face magnets are extracted strictly as
 *   inert display provenance; canonicalMagnet contains only xt=urn:btih:<hex40>
 *   and bounded dn=<repoId>, and downstream torrent:inspect / torrent:add still
 *   enforce sanitizeTorrentDiscovery + TorrentDiscoveryAuthorizations.
 * - Results are never written into Catalog.
 */
import { validateHfRepoId } from './hf.js';
import { extractInfoHash } from './torrent.js';
import { validatePortableRelativePath, validatePortablePathSet } from './portable-path.js';

export const PIRATEFACE_ORIGIN = 'https://pirateface.co';
export const MAX_PIRATEFACE_QUERY_CHARS = 200;
export const MAX_PIRATEFACE_MAGNET_BYTES = 8 * 1024;
export const MAX_PIRATEFACE_TEXT_BYTES = 512 * 1024;
export const MAX_PIRATEFACE_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_PIRATEFACE_ROWS = 100;
export const MAX_PIRATEFACE_FILES = 4096;
export const MAX_PIRATEFACE_QUANTS = 64;
export const ONE_TIB_BYTES = 1024 ** 4;

const REQUEST_TIMEOUT_MS = 15_000;
const LICENSE_CACHE_TTL_MS = 30 * 60 * 1000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const SAFE_HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,118}[a-z0-9])?$/i;
const QUANT_ID_RE = /^[A-Za-z0-9._+-]{1,80}$/;
const TERMS_ID_RE = /^[a-z0-9._-]{1,80}$/i;
const HEX_40_RE = /^[a-f0-9]{40}$/i;
const HEX_64_RE = /^[a-f0-9]{64}$/i;
const SEARCH_LINE_RE = /^(\S+)\s+(\d+(?:\.\d+)?\s*(?:[KMGT]i?B|B))\s+(\d+)\s+seeds?\s+(magnet:\?\S+)\s*$/i;
const WS_REVISION_RE = /^\/api\/ws\/[^/]+\/[^/]+\/([a-f0-9]{40})(?:\/|$)/i;

let licenseRegistryCache = { expiresAt: 0, registry: null };

export function resetPirateFaceLicenseCache() {
  licenseRegistryCache = { expiresAt: 0, registry: null };
}

function cleanBoundedText(value, maxLength = 240) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function cleanHttpsDisplayUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || CONTROL_CHARS.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function assertPirateFaceUrl(url) {
  if (!(url instanceof URL) || url.origin !== PIRATEFACE_ORIGIN || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Pirate Face requests may only target https://pirateface.co.');
  }
  return url;
}

function requestSignal(externalSignal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
}

async function readBoundedText(response, maxBytes, label) {
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength !== null && declaredLength !== undefined && declaredLength !== '') {
    const numeric = Number(declaredLength);
    if (Number.isFinite(numeric) && numeric > maxBytes) {
      throw new Error(`${label} exceeded the ${maxBytes}-byte safety limit.`);
    }
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
        total += bytes.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`${label} exceeded the ${maxBytes}-byte safety limit.`);
        }
        chunks.push(bytes);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`${label} exceeded the ${maxBytes}-byte safety limit.`);
    }
    return text;
  }
  throw new Error(`${label} returned an unreadable response body.`);
}

async function fetchPirateFace(url, {
  signal,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_PIRATEFACE_TEXT_BYTES,
  accept = 'text/plain',
  label = 'Pirate Face response',
} = {}) {
  assertPirateFaceUrl(url);
  if (typeof fetchImpl !== 'function') throw new Error('Network fetch is unavailable.');
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    headers: { Accept: accept },
    signal: requestSignal(signal),
  });
  if (!response || typeof response.status !== 'number') {
    throw new Error('Pirate Face returned an invalid response.');
  }
  const text = await readBoundedText(response, maxBytes, label);
  if (!response.ok) {
    if (response.status === 404) {
      const notFound = new Error('No Pirate Face torrent record was found for this repository.');
      notFound.statusCode = 404;
      throw notFound;
    }
    throw new Error(`Pirate Face returned HTTP ${response.status}.`);
  }
  return text;
}

export function normalizePirateFaceQuery(query) {
  const raw = String(query ?? '');
  if (CONTROL_CHARS.test(raw)) {
    throw new Error('Pirate Face search query contains invalid control characters.');
  }
  const tokens = raw.trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return { normalized: '', endpoint: '' };
  const normalized = tokens.join(' ');
  if (normalized.length > MAX_PIRATEFACE_QUERY_CHARS) {
    throw new Error(`Pirate Face search query must be ${MAX_PIRATEFACE_QUERY_CHARS} characters or fewer.`);
  }
  const encodedWords = tokens.map(token => encodeURIComponent(token)).join('+');
  const url = assertPirateFaceUrl(new URL(`/s/${encodedWords}`, PIRATEFACE_ORIGIN));
  return { normalized, endpoint: url.toString(), url };
}

export function pirateFaceTorrentsEndpoint(repoId, { quant = '', acceptTerms = '' } = {}) {
  const repo = validateHfRepoId(repoId);
  if (!repo.includes('/')) {
    throw new Error('Pirate Face repository ID must be in owner/name format.');
  }
  const url = new URL('/api/torrents', PIRATEFACE_ORIGIN);
  url.searchParams.set('repo', repo);
  if (quant !== undefined && quant !== null && quant !== '') {
    const q = String(quant).trim();
    if (!QUANT_ID_RE.test(q)) throw new Error('Invalid Pirate Face quantization identifier.');
    url.searchParams.set('quant', q);
  }
  if (acceptTerms !== undefined && acceptTerms !== null && acceptTerms !== '') {
    const terms = String(acceptTerms).trim();
    if (!TERMS_ID_RE.test(terms)) throw new Error('Invalid Pirate Face license terms identifier.');
    url.searchParams.set('accept_terms', terms);
  }
  return { repo, endpoint: url.toString(), url };
}

export function parseSizeEstimateBytes(sizeLabel) {
  if (typeof sizeLabel !== 'string') return null;
  const match = sizeLabel.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = match[2].toUpperCase();
  const power = unit === 'B' ? 0
    : unit === 'KB' || unit === 'KIB' ? 1
      : unit === 'MB' || unit === 'MIB' ? 2
        : unit === 'GB' || unit === 'GIB' ? 3
          : 4;
  return Math.round(amount * (1024 ** power));
}

export function buildCanonicalMagnet(infoHash, repoId) {
  const normalizedHash = extractInfoHash(`magnet:?xt=urn:btih:${String(infoHash ?? '').trim()}`);
  if (!normalizedHash) throw new Error('Invalid BitTorrent infohash.');
  const repo = validateHfRepoId(repoId);
  const magnet = `magnet:?xt=urn:btih:${normalizedHash}&dn=${encodeURIComponent(repo)}`;
  if (Buffer.byteLength(magnet, 'utf8') > MAX_PIRATEFACE_MAGNET_BYTES) {
    throw new Error('Magnet link exceeds the 8 KiB limit.');
  }
  return magnet;
}

export function extractMagnetProvenance(rawMagnet, repoId) {
  if (typeof rawMagnet !== 'string' || !rawMagnet.startsWith('magnet:?')) {
    throw new Error('Invalid magnet URI.');
  }
  if (CONTROL_CHARS.test(rawMagnet) || Buffer.byteLength(rawMagnet, 'utf8') > MAX_PIRATEFACE_MAGNET_BYTES) {
    throw new Error('Magnet link exceeds the 8 KiB safety limit.');
  }
  const infoHash = extractInfoHash(rawMagnet);
  if (!infoHash) throw new Error('Magnet link does not contain a valid v1 infohash.');

  const hosts = [];
  const seenHosts = new Set();
  let revision = '';
  const params = new URLSearchParams(rawMagnet.slice('magnet:?'.length));
  for (const [key, value] of params.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== 'tr' && lowerKey !== 'ws') continue;
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname.toLowerCase();
      if (SAFE_HOST_RE.test(hostname) && !seenHosts.has(hostname) && hosts.length < 6) {
        seenHosts.add(hostname);
        hosts.push(hostname);
      }
      if (!revision && lowerKey === 'ws' && parsed.origin === PIRATEFACE_ORIGIN) {
        const revMatch = parsed.pathname.match(WS_REVISION_RE);
        if (revMatch) revision = revMatch[1].toLowerCase();
      }
    } catch {
      // Ignore malformed third-party endpoint metadata; endpoints are never passed to WebTorrent.
    }
  }
  return {
    infoHash,
    canonicalMagnet: buildCanonicalMagnet(infoHash, repoId),
    revision,
    provenanceHosts: hosts,
  };
}

export function parsePirateFaceSearchText(text, { limit = 50 } = {}) {
  const maxRows = Math.max(1, Math.min(MAX_PIRATEFACE_ROWS, Number(limit) || 50));
  const lines = String(text ?? '').split(/\r?\n/u);
  const models = [];
  const seen = new Set();

  for (const rawLine of lines) {
    if (models.length >= maxRows) break;
    const line = rawLine.trim();
    if (!line || /^no torrents match\b/i.test(line)) continue;
    const match = line.match(SEARCH_LINE_RE);
    if (!match) continue;
    const [, rawRepo, rawSize, rawSeeds, rawMagnet] = match;
    let repoId;
    try {
      repoId = validateHfRepoId(rawRepo);
    } catch {
      continue;
    }
    const seeds = Number.parseInt(rawSeeds, 10);
    if (!Number.isSafeInteger(seeds) || seeds < 0) continue;

    let provenance;
    try {
      provenance = extractMagnetProvenance(rawMagnet, repoId);
    } catch {
      continue;
    }
    const dedupeKey = `${repoId.toLowerCase()}:${provenance.infoHash}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const [author, name] = repoId.split('/');
    const sizeLabel = rawSize.replace(/\s+/gu, ' ').trim();
    const sizeBytes = parseSizeEstimateBytes(sizeLabel);
    models.push({
      id: repoId,
      repoId,
      author,
      name,
      sizeLabel,
      sizeBytes,
      exceedsOneTiB: typeof sizeBytes === 'number' && sizeBytes > ONE_TIB_BYTES,
      seeds,
      infoHash: provenance.infoHash,
      revision: provenance.revision,
      provenanceHosts: provenance.provenanceHosts,
      canonicalMagnet: provenance.canonicalMagnet,
    });
  }
  return models;
}

export function parsePirateFaceLicenseRegistry(raw) {
  const byId = new Map();
  const byRepoLower = new Map();
  if (!raw || typeof raw !== 'object') return { byId, byRepoLower };

  if (Array.isArray(raw.licenses)) {
    for (const item of raw.licenses.slice(0, 512)) {
      if (!item || typeof item !== 'object') continue;
      const id = cleanBoundedText(item.id, 80).toLowerCase();
      if (!id || !TERMS_ID_RE.test(id)) continue;
      const record = {
        id,
        label: cleanBoundedText(item.label || item.name || id, 120),
        name: cleanBoundedText(item.name || item.label || id, 160),
        acceptFirst: Boolean(item.acceptFirst),
        requiredFile: cleanBoundedText(item.requiredFile || '', 120),
      };
      byId.set(id, record);
      if (Array.isArray(item.hfNames)) {
        for (const alias of item.hfNames.slice(0, 16)) {
          const cleanAlias = cleanBoundedText(alias, 80).toLowerCase();
          if (cleanAlias && TERMS_ID_RE.test(cleanAlias) && !byId.has(cleanAlias)) {
            byId.set(cleanAlias, record);
          }
        }
      }
    }
  }

  if (Array.isArray(raw.repoLicenses)) {
    for (const entry of raw.repoLicenses.slice(0, 4096)) {
      if (!entry || typeof entry !== 'object') continue;
      let repoId;
      try {
        repoId = validateHfRepoId(entry.repoId);
      } catch {
        continue;
      }
      const licId = cleanBoundedText(entry.license, 80).toLowerCase();
      if (!licId || !TERMS_ID_RE.test(licId)) continue;
      byRepoLower.set(repoId.toLowerCase(), licId);
    }
  } else if (raw.repoLicenses && typeof raw.repoLicenses === 'object') {
    for (const key of Object.keys(raw.repoLicenses).slice(0, 4096)) {
      if (!Object.hasOwn(raw.repoLicenses, key)) continue;
      let repoId;
      try {
        repoId = validateHfRepoId(key);
      } catch {
        continue;
      }
      const licId = cleanBoundedText(raw.repoLicenses[key], 80).toLowerCase();
      if (!licId || !TERMS_ID_RE.test(licId)) continue;
      byRepoLower.set(repoId.toLowerCase(), licId);
    }
  }

  return { byId, byRepoLower };
}

function normalizeTermsObject(rawTerms) {
  if (!rawTerms || typeof rawTerms !== 'object' || Array.isArray(rawTerms)) return null;
  const id = cleanBoundedText(rawTerms.id, 80).toLowerCase();
  if (!id || !TERMS_ID_RE.test(id)) return null;
  return {
    id,
    name: cleanBoundedText(rawTerms.name || id, 160),
    version: cleanBoundedText(rawTerms.version || '', 64),
    termsUrl: cleanHttpsDisplayUrl(rawTerms.termsUrl),
    policyUrl: cleanHttpsDisplayUrl(rawTerms.policyUrl),
    notice: cleanBoundedText(rawTerms.notice || '', 400),
  };
}

const FAMILY_ACCEPT_FIRST_HINTS = [
  { prefix: 'google/gemma', id: 'gemma', name: 'Gemma Terms of Use' },
  { prefix: 'meta-llama/llama', id: 'llama3.3', name: 'Llama Community License' },
  { prefix: 'liquidai/lfm', id: 'lfm1.0', name: 'LFM Open License' },
];

export function resolvePirateFaceLicenseNotice(repoId, rawTerms, registry) {
  const repo = validateHfRepoId(repoId);
  const repoLower = repo.toLowerCase();
  const terms = normalizeTermsObject(rawTerms);
  if (terms) {
    return {
      kind: 'terms-required',
      id: terms.id,
      name: terms.name,
      version: terms.version,
      termsUrl: terms.termsUrl,
      policyUrl: terms.policyUrl,
      acceptFirst: true,
      notice: terms.notice || `${terms.name} applies to this repository. Review upstream license terms before downloading.`,
    };
  }

  const mappedLicenseId = registry?.byRepoLower instanceof Map ? registry.byRepoLower.get(repoLower) : undefined;
  if (mappedLicenseId) {
    const entry = registry.byId instanceof Map ? registry.byId.get(mappedLicenseId) : undefined;
    if (entry?.acceptFirst) {
      return {
        kind: 'accept-first',
        id: entry.id,
        name: entry.name,
        version: '',
        termsUrl: '',
        policyUrl: '',
        acceptFirst: true,
        notice: `${entry.name} requires reviewing license terms. Community torrents do not bypass upstream gated-repo approval.`,
      };
    }
    return {
      kind: 'known',
      id: entry?.id || mappedLicenseId,
      name: entry?.name || mappedLicenseId,
      version: '',
      termsUrl: '',
      policyUrl: '',
      acceptFirst: false,
      notice: `Listed license: ${entry?.name || mappedLicenseId}. Verify the upstream model card for full terms.`,
    };
  }

  for (const hint of FAMILY_ACCEPT_FIRST_HINTS) {
    if (repoLower.startsWith(hint.prefix)) {
      return {
        kind: 'accept-first',
        id: hint.id,
        name: hint.name,
        version: '',
        termsUrl: '',
        policyUrl: '',
        acceptFirst: true,
        notice: `${hint.name} may apply to ${repo}. Review upstream terms on Hugging Face; community torrents are not a gate bypass.`,
      };
    }
  }

  return {
    kind: 'verify-upstream',
    id: '',
    name: 'Check upstream model card',
    version: '',
    termsUrl: '',
    policyUrl: '',
    acceptFirst: false,
    notice: 'Verify license and usage terms on Hugging Face before downloading or sharing.',
  };
}

function deriveQuantLabel(quantId, files) {
  if (Array.isArray(files) && files.length) {
    const paths = files
      .map(f => (f && typeof f.path === 'string' ? f.path : ''))
      .filter(Boolean);
    const firstSlash = paths[0]?.indexOf('/') ?? -1;
    if (firstSlash > 0) {
      const folder = paths[0].slice(0, firstSlash);
      if (paths.every(p => p.startsWith(`${folder}/`))) {
        return cleanBoundedText(folder, 80);
      }
    }
    const primaryWeight = paths.find(p => /\.(?:gguf|safetensors|mlx|bin)$/i.test(p) && !/-0000\d+-of-/i.test(p))
      || paths.find(p => /\.(?:gguf|safetensors|mlx|bin)$/i.test(p))
      || paths[0];
    if (primaryWeight) {
      const base = primaryWeight.split('/').pop();
      return cleanBoundedText(base, 80);
    }
  }
  return cleanBoundedText(quantId, 40) || 'default';
}

function normalizeTorrentFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) return { files: [], totalBytes: null };
  if (rawFiles.length > MAX_PIRATEFACE_FILES) {
    throw new Error(`Pirate Face file manifest exceeds the ${MAX_PIRATEFACE_FILES}-file safety limit.`);
  }
  const normalized = [];
  const pathsForSet = [];
  let summedBytes = 0;
  let hasAnySize = false;

  for (const item of rawFiles) {
    if (!item || typeof item !== 'object') continue;
    const relPath = validatePortableRelativePath(item.path, { label: 'Pirate Face file path' });
    const rawSha = typeof item.sha256 === 'string' ? item.sha256.trim() : '';
    const sha256 = rawSha && HEX_64_RE.test(rawSha) ? rawSha.toLowerCase() : '';
    let size = null;
    if (item.size !== undefined && item.size !== null) {
      if (!Number.isSafeInteger(item.size) || item.size < 0) {
        throw new Error('Pirate Face file manifest contains an invalid file size.');
      }
      size = item.size;
      summedBytes += size;
      hasAnySize = true;
    }
    pathsForSet.push(relPath);
    normalized.push({ path: relPath, sha256, size });
  }
  if (pathsForSet.length) {
    validatePortablePathSet(pathsForSet, { label: 'Pirate Face file path' });
  }
  return { files: normalized, totalBytes: hasAnySize ? summedBytes : null };
}

export async function pirateFaceLicenses({ signal, fetchImpl = globalThis.fetch, force = false } = {}) {
  const now = Date.now();
  if (!force && licenseRegistryCache.registry && licenseRegistryCache.expiresAt > now) {
    return licenseRegistryCache.registry;
  }
  const url = assertPirateFaceUrl(new URL('/api/licenses', PIRATEFACE_ORIGIN));
  const body = await fetchPirateFace(url, {
    signal,
    fetchImpl,
    maxBytes: MAX_PIRATEFACE_JSON_BYTES,
    accept: 'application/json',
    label: 'Pirate Face license registry',
  });
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Pirate Face returned invalid license JSON.');
  }
  const registry = parsePirateFaceLicenseRegistry(parsed);
  licenseRegistryCache = {
    expiresAt: now + LICENSE_CACHE_TTL_MS,
    registry,
  };
  return registry;
}

export async function pirateFaceSearch(query, { limit = 50, signal, fetchImpl = globalThis.fetch } = {}) {
  const { normalized, endpoint, url } = normalizePirateFaceQuery(query);
  if (!normalized) {
    return { query: '', endpoint: '', models: [], source: 'pirateface' };
  }
  const body = await fetchPirateFace(url, {
    signal,
    fetchImpl,
    maxBytes: MAX_PIRATEFACE_TEXT_BYTES,
    accept: 'text/plain',
    label: 'Pirate Face search results',
  });
  const models = parsePirateFaceSearchText(body, { limit });
  return {
    query: normalized,
    endpoint,
    models,
    source: 'pirateface',
  };
}

export async function pirateFaceRepoTorrents(repoId, {
  quant = '',
  acceptTerms = '',
  signal,
  fetchImpl = globalThis.fetch,
  includeLicenses = true,
} = {}) {
  const { repo, endpoint, url } = pirateFaceTorrentsEndpoint(repoId, { quant, acceptTerms });
  const body = await fetchPirateFace(url, {
    signal,
    fetchImpl,
    maxBytes: MAX_PIRATEFACE_JSON_BYTES,
    accept: 'application/json',
    label: 'Pirate Face repository torrent metadata',
  });
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('Pirate Face returned invalid torrent metadata JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Pirate Face returned malformed torrent metadata.');
  }
  if (data.repoId !== undefined && data.repoId !== null) {
    const returnedRepo = validateHfRepoId(data.repoId);
    if (returnedRepo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error('Pirate Face returned metadata for a different repository.');
    }
  }

  const revision = typeof data.revision === 'string' && HEX_40_RE.test(data.revision.trim())
    ? data.revision.trim().toLowerCase()
    : '';
  const seeders = Number.isSafeInteger(data.seeders) && data.seeders >= 0 ? data.seeders : 0;
  const leechers = Number.isSafeInteger(data.leechers) && data.leechers >= 0 ? data.leechers : 0;

  const rawInfoHash = typeof (data.infohash ?? data.info_hash) === 'string'
    ? String(data.infohash ?? data.info_hash).trim()
    : '';
  const fieldHash = rawInfoHash ? extractInfoHash(`magnet:?xt=urn:btih:${rawInfoHash}`) : null;
  if (rawInfoHash && !fieldHash) {
    throw new Error('Pirate Face returned an invalid torrent infohash.');
  }

  let magnetProvenance = null;
  if (typeof data.magnet === 'string' && data.magnet.trim()) {
    magnetProvenance = extractMagnetProvenance(data.magnet.trim(), repo);
  }
  if (fieldHash && magnetProvenance && fieldHash !== magnetProvenance.infoHash) {
    throw new Error('Pirate Face returned mismatched torrent infohashes.');
  }

  const activeQuant = typeof data.quant === 'string' && QUANT_ID_RE.test(data.quant.trim())
    ? data.quant.trim()
    : '';
  const quants = [];
  let matchedQuantFiles = null;
  if (Array.isArray(data.quants)) {
    for (const q of data.quants.slice(0, MAX_PIRATEFACE_QUANTS)) {
      if (!q || typeof q !== 'object') continue;
      const qId = typeof q.quant === 'string' && QUANT_ID_RE.test(q.quant.trim()) ? q.quant.trim() : '';
      if (!qId) continue;
      const qRev = typeof q.revision === 'string' && HEX_40_RE.test(q.revision.trim())
        ? q.revision.trim().toLowerCase()
        : '';
      const qFilesRaw = Array.isArray(q.files) ? q.files : [];
      if (qId === activeQuant && !Array.isArray(data.files)) {
        matchedQuantFiles = qFilesRaw;
      }
      quants.push({
        id: qId,
        label: cleanBoundedText(q.label || q.name || deriveQuantLabel(qId, qFilesRaw), 80),
        revision: qRev,
        fileCount: Math.min(MAX_PIRATEFACE_FILES, qFilesRaw.length),
      });
    }
  }

  const { files, totalBytes } = normalizeTorrentFiles(Array.isArray(data.files) ? data.files : matchedQuantFiles);
  const reportedTotal = Number.isSafeInteger(data.totalBytes) && data.totalBytes >= 0 ? data.totalBytes : 0;
  const maxObservedBytes = Math.max(reportedTotal, totalBytes ?? 0);

  let registry = null;
  if (includeLicenses) {
    try {
      registry = await pirateFaceLicenses({ signal, fetchImpl });
    } catch {
      registry = null;
    }
  }

  const licenseNotice = resolvePirateFaceLicenseNotice(repo, data.terms, registry);
  const acceptedTermsMatch = Boolean(
    acceptTerms
    && licenseNotice.kind === 'terms-required'
    && acceptTerms.trim().toLowerCase() === licenseNotice.id.toLowerCase(),
  );
  const termsRequired = licenseNotice.kind === 'terms-required' && !acceptedTermsMatch;

  const resolvedHash = termsRequired ? '' : (magnetProvenance?.infoHash || fieldHash || '');
  const canonicalMagnet = resolvedHash ? buildCanonicalMagnet(resolvedHash, repo) : '';

  return {
    repoId: repo,
    endpoint,
    revision: revision || magnetProvenance?.revision || '',
    seeders,
    leechers,
    hf: Boolean(data.hf),
    quant: activeQuant,
    quants,
    files,
    totalBytes,
    exceedsOneTiB: maxObservedBytes > ONE_TIB_BYTES,
    infoHash: resolvedHash,
    canonicalMagnet,
    provenanceHosts: magnetProvenance?.provenanceHosts || [],
    termsRequired,
    licenseNotice,
    apiMessage: cleanBoundedText(data.error || '', 280),
  };
}
