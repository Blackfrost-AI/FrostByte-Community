/**
 * Hub update feed — main-process fetch + bounds.
 *
 * The renderer never supplies the feed it is checked against; the main process
 * fetches it from the configured Hub and validates every entry, so a compromised
 * renderer cannot invent update nudges (or a clean bill of health).
 */
import { checkUpdates } from './hub-updates.js';

const MAX_FEED_ITEMS = 500;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/i;
const SEVERITIES = new Set(['info', 'recommended', 'security']);

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function severity(value) {
  return SEVERITIES.has(value) ? value : 'info';
}

/**
 * Validate a Hub update feed. Unknown shapes are dropped rather than trusted.
 * Returns null when the payload is not a feed at all — i.e. it carries none of
 * the recognized arrays. This is what stops a /v1/changes page (or any unrelated
 * payload) from being mistaken for a clean bill of health.
 */
export function normalizeUpdateFeed(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const recognized = ['engines', 'recipes', 'configs', 'containers'].some(key => Array.isArray(raw[key]));
  if (!recognized) return null;
  const out = { version: positiveInt(raw.version), engines: [], recipes: [], configs: [], containers: [] };
  if (Array.isArray(raw.engines)) {
    for (const item of raw.engines.slice(0, MAX_FEED_ITEMS)) {
      if (!item || typeof item !== 'object') continue;
      const name = text(item.name, 120);
      if (!name) continue;
      out.engines.push({
        name, version: text(item.version, 64), digest: DIGEST.test(item.digest || '') ? item.digest : '',
        severity: severity(item.severity), notes: text(item.notes, 1000),
      });
    }
  }
  if (Array.isArray(raw.containers)) {
    for (const item of raw.containers.slice(0, MAX_FEED_ITEMS)) {
      if (!item || typeof item !== 'object') continue;
      const name = text(item.name, 120);
      if (!name) continue;
      out.containers.push({
        name, tag: text(item.tag, 128), digest: DIGEST.test(item.digest || '') ? item.digest : '',
        severity: severity(item.severity), notes: text(item.notes, 1000),
      });
    }
  }
  if (Array.isArray(raw.recipes)) {
    for (const item of raw.recipes.slice(0, MAX_FEED_ITEMS)) {
      if (!item || typeof item !== 'object') continue;
      const id = text(item.id, 200);
      if (!id) continue;
      out.recipes.push({
        id, digest: DIGEST.test(item.digest || '') ? item.digest : '',
        severity: severity(item.severity), notes: text(item.notes, 1000),
      });
    }
  }
  if (Array.isArray(raw.configs)) {
    for (const item of raw.configs.slice(0, MAX_FEED_ITEMS)) {
      if (!item || typeof item !== 'object') continue;
      const repoId = text(item.repoId, 200);
      if (!repoId) continue;
      out.configs.push({
        repoId, revision: REVISION.test(item.revision || '') ? String(item.revision).toLowerCase() : '',
        severity: severity(item.severity), notes: text(item.notes, 1000),
      });
    }
  }
  return out;
}

/** Run the deterministic comparator against a main-owned feed. */
export function compareAgainstFeed({ installed, feed }) {
  const normalized = normalizeUpdateFeed(feed);
  if (!normalized) throw new Error('Hub returned an invalid update feed.');
  return { feedVersion: normalized.version, nudges: checkUpdates({ installed, feed: normalized }) };
}
