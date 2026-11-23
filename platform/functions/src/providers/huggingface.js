/**
 * Hugging Face model search adapter.
 *
 * Verified shape (2026-10-18): a bare JSON array, no envelope, no cursor.
 *   GET /api/models?search=&limit=&sort=downloads&direction=-1
 * Pagination is offset-based via `skip`.
 */

import { fetchJson } from './fetch-json.js';
import { normalizeModel, formatParams } from './model.js';

export const name = 'huggingface';
const BASE = 'https://huggingface.co/api/models';
const MAX_LIMIT = 50;

const SORTS = Object.freeze({
  downloads: 'downloads',
  likes: 'likes',
  lastModified: 'lastModified',
  createdAt: 'createdAt',
  trendingScore: 'trendingScore',
});

export function buildUrl({ query = '', limit = 20, offset = 0, sort = 'downloads' } = {}) {
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  params.set('limit', String(clampLimit(limit)));
  if (offset > 0) params.set('skip', String(Math.floor(offset)));
  const sortKey = SORTS[sort] || SORTS.downloads;
  params.set('sort', sortKey);
  params.set('direction', '-1');
  params.set('full', 'false');
  return `${BASE}?${params.toString()}`;
}

export async function search({ query, limit, offset, sort, fetcher, timeoutMs } = {}) {
  const url = buildUrl({ query, limit, offset, sort });
  const payload = await fetchJson({ url, fetcher, provider: name, timeoutMs });

  if (!Array.isArray(payload)) {
    throw new TypeError('Hugging Face returned an unexpected envelope.');
  }

  const items = payload
    .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
    .map((entry) =>
      normalizeModel({
        provider: name,
        providerId: entry.id,
        name: entry.id,
        author: entry.id.includes('/') ? entry.id.split('/')[0] : '',
        task: entry.pipeline_tag || '',
        license: Array.isArray(entry.tags)
          ? entry.tags.find((tag) => typeof tag === 'string' && /^(?:apache|mit|cc|llama|gemma|openrail|bsd|gpl|other)/i.test(tag)) || ''
          : '',
        tags: entry.tags,
        downloads: entry.downloads,
        likes: entry.likes,
        updatedAt: entry.lastModified || entry.createdAt,
        urls: { page: `https://huggingface.co/${entry.id}` },
        meta: {
          gated: entry.gated === true || entry.gated === 'auto' || entry.gated === 'manual',
          private: entry.private === true,
          library: entry.library_name || '',
        },
      }),
    );

  return {
    provider: name,
    items,
    // HF has no cursor. We hand back the next offset; the unified layer encodes
    // it into an opaque cursor so clients never depend on the provider's scheme.
    nextOffset: items.length === clampLimit(limit) ? Math.floor(offset || 0) + items.length : null,
    total: null,
  };
}

function clampLimit(limit) {
  const value = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 20;
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}

export { formatParams };