/**
 * Pirate Face model search adapter.
 *
 * Verified shape (2026-10-18):
 *   GET /api/models?q=&limit=  →  { models: [...], nextCursor: "<opaque base64>" }
 *
 * The search parameter is `q`, not `search`. Only this provider has a real
 * cursor; it is passed through opaque and never decoded, because the encoding is
 * upstream's business and may change without notice.
 *
 * `/api/health`, `/api/search`, and `/api/torrents` all answer HTML — this
 * adapter only ever calls `/api/models`, which is genuinely JSON.
 */

import { fetchJson } from './fetch-json.js';
import { normalizeModel } from './model.js';

export const name = 'pirateface';
const BASE = 'https://pirateface.co/api/models';
const MAX_LIMIT = 50;

export function buildUrl({ query = '', limit = 20, cursor = '' } = {}) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('limit', String(clampLimit(limit)));
  if (cursor) params.set('cursor', String(cursor));
  return `${BASE}?${params.toString()}`;
}

export async function search({ query, limit, cursor, fetcher, timeoutMs } = {}) {
  const url = buildUrl({ query, limit, cursor });
  const payload = await fetchJson({ url, fetcher, provider: name, timeoutMs });

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.models)) {
    throw new TypeError('Pirate Face returned an unexpected envelope.');
  }

  const items = payload.models
    .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
    .map((entry) =>
      normalizeModel({
        provider: name,
        providerId: entry.id,
        name: entry.name || entry.id,
        author: entry.author || (entry.id.includes('/') ? entry.id.split('/')[0] : ''),
        task: entry.task || '',
        license: entry.license || '',
        parameterCount: entry.params,
        parameterLabel: entry.paramLabel || '',
        sizeBytes: entry.sizeBytes,
        downloads: entry.downloads,
        likes: entry.likes,
        infoHash: entry.infoHash || entry.infohash || '',
        urls: { page: `https://pirateface.co/models/${entry.id}` },
        meta: {
          format: entry.format || '',
          revision: entry.revision || '',
          seeded: entry.seeded === true,
          seeders: Number(entry.seed) || 0,
          leechers: Number(entry.leech) || 0,
          hfBacked: entry.hfBacked === true,
          origin: entry.origin || '',
        },
      }),
    );

  const nextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null;

  return { provider: name, items, nextCursor, total: null };
}

function clampLimit(limit) {
  const value = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 20;
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}