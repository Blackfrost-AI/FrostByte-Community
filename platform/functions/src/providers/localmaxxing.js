/**
 * LocalMaxxing model search adapter.
 *
 * Verified shape (2026-10-18): a bare JSON array.
 *   GET /api/models?limit=&skip=&search=
 *
 * Two quirks that must survive normalization:
 *  - `tags` arrives as a JSON-encoded *string*, not an array.
 *  - `params` is in **billions** (180 → 180B), unlike every other provider.
 */

import { fetchJson } from './fetch-json.js';
import { normalizeModel, formatParams } from './model.js';

export const name = 'localmaxxing';
const BASE = 'https://www.localmaxxing.com/api/models';
const MAX_LIMIT = 50;

export function buildUrl({ query = '', limit = 20, offset = 0 } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(clampLimit(limit)));
  if (offset > 0) params.set('skip', String(Math.floor(offset)));
  if (query) params.set('search', query);
  return `${BASE}?${params.toString()}`;
}

export async function search({ query, limit, offset, fetcher, timeoutMs } = {}) {
  const url = buildUrl({ query, limit, offset });
  const payload = await fetchJson({ url, fetcher, provider: name, timeoutMs });

  if (!Array.isArray(payload)) {
    throw new TypeError('LocalMaxxing returned an unexpected envelope.');
  }

  const items = payload
    .filter((entry) => entry && typeof entry === 'object' && (entry.hfId || entry.id))
    .map((entry) => {
      const providerId = String(entry.hfId || entry.id);
      // `params` is expressed in billions upstream.
      const parameterCount =
        typeof entry.params === 'number' && Number.isFinite(entry.params) && entry.params > 0
          ? Math.round(entry.params * 1e9)
          : null;

      return normalizeModel({
        provider: name,
        providerId,
        name: entry.displayName || providerId,
        author: entry.organization || (providerId.includes('/') ? providerId.split('/')[0] : ''),
        task: entry.pipelineTag || '',
        tags: parseTags(entry.tags),
        parameterCount,
        parameterLabel: parameterCount ? formatParams(parameterCount) : '',
        downloads: null,
        likes: null,
        urls: { page: `https://www.localmaxxing.com/models/${encodeURIComponent(entry.id || providerId)}` },
        meta: {
          family: typeof entry.family === 'string' ? entry.family : '',
          isMoE: entry.isMoE === true,
          benchmarkRuns: Number(entry._count?.benchmarkRuns) || 0,
          baseModel: typeof entry.baseModel?.hfId === 'string' ? entry.baseModel.hfId : '',
          medianTokS: Number(entry.speedStats?.medianTokS) || null,
          evalScore: Number.isFinite(entry.evalScore) ? entry.evalScore : null,
        },
      });
    });

  return {
    provider: name,
    items,
    nextOffset: items.length === clampLimit(limit) ? Math.floor(offset || 0) + items.length : null,
    total: null,
  };
}

/** LocalMaxxing ships tags as a JSON string. Parse defensively. */
function parseTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clampLimit(limit) {
  const value = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 20;
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}