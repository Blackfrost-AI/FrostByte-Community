/**
 * Unified discovery.
 *
 * Fans a single query out to every provider the caller's tier allows, in
 * parallel, with a per-provider failure that degrades to a labelled partial
 * result rather than a 500. If every provider fails the caller gets a 502.
 *
 * Cursors are opaque to clients, HMAC-signed, and bound to the query and tier
 * that produced them. Signing stops a client from minting arbitrary offsets or
 * recycling a cursor across queries (which would silently paginate the wrong
 * result set); binding means a cursor is only valid for the request shape that
 * earned it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import * as huggingface from './providers/huggingface.js';
import * as localmaxxing from './providers/localmaxxing.js';
import * as pirateface from './providers/pirateface.js';
import { PROVIDERS } from './providers/model.js';
import { allowsProvider, capabilitiesFor } from './entitlements.js';
import { badRequest, upstreamFailure } from './http.js';

export const ADAPTERS = Object.freeze({ huggingface, localmaxxing, pirateface });

/**
 * FrostNet moderation — applied POST-cache so a newly added block rule takes
 * effect on already-cached pages immediately (spec §5.4).
 *
 * Field matching is exact against the normalized model shape from
 * providers/model.js: { id, provider, providerId, name, author, infoHash }.
 * There is no `item.modelId`.
 *
 *  - `repo` rules match case-insensitively against item.providerId and
 *    `${item.provider}:${item.providerId}`; an `org/*` prefix rule matches
 *    providerId.startsWith('org/') OR author === 'org'.
 *  - `infohash` rules match the normalized 40-hex item.infoHash.
 *  - Featured entries annotate `featured: { badge, note, rank }` and sort ahead
 *    of non-featured items on 'downloads' and 'trending'.
 */
export function applyFrostNetModeration(items, { blockedRules = [], featuredEntries = [], sort = 'downloads', enabledProviders = null } = {}) {
  if (!Array.isArray(items)) return [];
  const blocks = Array.isArray(blockedRules) ? blockedRules : [];
  const featured = Array.isArray(featuredEntries) ? featuredEntries : [];
  const enabled = Array.isArray(enabledProviders) && enabledProviders.length > 0
    ? new Set(enabledProviders.map((entry) => String(entry).toLowerCase()))
    : null;

  const blockedRepos = [];
  const blockedOrgs = [];
  const blockedHashes = new Set();
  for (const rule of blocks) {
    const value = typeof rule?.targetValue === 'string' ? rule.targetValue.toLowerCase() : '';
    if (!value) continue;
    if (rule.targetType === 'infohash') blockedHashes.add(value);
    else if (rule.targetType === 'repo') {
      if (value.endsWith('/*')) blockedOrgs.push(value.slice(0, -2));
      else blockedRepos.push(value);
    }
  }

  const featuredByKey = new Map();
  for (const entry of featured) {
    if (!entry?.provider || !entry?.providerId) continue;
    featuredByKey.set(`${String(entry.provider).toLowerCase()}:${String(entry.providerId).toLowerCase()}`, {
      badge: typeof entry.badge === 'string' && entry.badge ? entry.badge : 'Featured',
      note: typeof entry.note === 'string' ? entry.note : '',
      rank: Number.isFinite(entry.rank) ? entry.rank : 50,
    });
  }

  const kept = [];
  for (const item of items) {
    const providerId = String(item.providerId || '').toLowerCase();
    const provider = String(item.provider || '').toLowerCase();
    const author = String(item.author || '').toLowerCase();
    const qualified = `${provider}:${providerId}`;
    const infoHash = typeof item.infoHash === 'string' ? item.infoHash.toLowerCase() : '';

    if (enabled && !enabled.has(provider)) continue;
    if (blockedRepos.includes(providerId) || blockedRepos.includes(qualified)) continue;
    if (infoHash && blockedHashes.has(infoHash)) continue;
    if (blockedOrgs.some((org) => providerId.startsWith(`${org}/`) || author === org)) continue;

    // Strip any stale annotation from a cached page before re-annotating, so
    // re-applying this function is idempotent and self-correcting.
    const { featured: _stale, ...base } = item;
    const pin = featuredByKey.get(qualified);
    kept.push(pin ? { ...base, featured: pin } : base);
  }

  if (featuredByKey.size > 0 && (sort === 'downloads' || sort === 'trending')) {
    // Featured first (by rank asc, then the normal ordering within each group).
    kept.sort((a, b) => {
      const aRank = a.featured ? a.featured.rank : Infinity;
      const bRank = b.featured ? b.featured.rank : Infinity;
      if (aRank !== bRank) return aRank - bRank;
      return compareModels(a, b);
    });
  }

  return kept;
}

const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Cursor signing key. Read from Secret Manager at runtime; the test suite sets
 * `HUB_CURSOR_SECRET` explicitly. When unset, cursors are still produced but
 * verification is impossible — so we fail closed instead of silently issuing
 * unverifiable tokens.
 */
function cursorSecret() {
  const secret = process.env.HUB_CURSOR_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('HUB_CURSOR_SECRET is not configured.');
  }
  return secret;
}

/** Stable digest of the parts of a request a cursor is bound to. */
function bindContext({ query, tier, providers }) {
  return JSON.stringify([CURSOR_VERSION, query || '', tier || '', [...(providers || [])].sort()]);
}

/** Encode unified pagination state as a signed, URL-safe cursor. */
export function encodeCursor(state, bindings = {}) {
  const payload = {
    v: CURSOR_VERSION,
    o: Object.fromEntries(
      Object.entries(state.offsets || {}).filter(([, value]) => Number.isFinite(value) && value > 0),
    ),
    c: state.cursors || {},
    b: bindContext(bindings),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', cursorSecret()).update(body, 'utf8').digest('base64url');
  return `${body}.${signature}`;
}

/** Decode and verify a cursor, rejecting anything malformed or forged. */
export function decodeCursor(cursor, bindings = {}) {
  if (!cursor) return { offsets: {}, cursors: {} };
  if (typeof cursor !== 'string' || cursor.length > 8192) throw badRequest('Malformed cursor.');

  const separator = cursor.lastIndexOf('.');
  if (separator <= 0) throw badRequest('Malformed cursor.');
  const body = cursor.slice(0, separator);
  const signature = cursor.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) throw badRequest('Malformed cursor.');

  const expected = createHmac('sha256', cursorSecret()).update(body, 'utf8').digest('base64url');
  const givenBuffer = Buffer.from(signature, 'base64url');
  const expectedBuffer = Buffer.from(expected, 'base64url');
  if (givenBuffer.length !== expectedBuffer.length || !timingSafeEqual(givenBuffer, expectedBuffer)) {
    throw badRequest('Cursor signature is not valid.');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Malformed cursor.');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== CURSOR_VERSION) {
    throw badRequest('Unsupported cursor version.');
  }

  // A cursor is only valid for the request shape that produced it. Reusing one
  // across queries would silently paginate the wrong result set.
  if (bindings && Object.keys(bindings).length > 0 && parsed.b !== bindContext(bindings)) {
    throw badRequest('Cursor does not match this query.');
  }

  // Unknown keys mean the cursor was not minted by this service — reject rather
  // than silently dropping state, which would produce wrong pagination.
  const offsets = {};
  for (const [key, value] of Object.entries(parsed.o || {})) {
    if (!PROVIDERS.includes(key)) throw badRequest('Malformed cursor.');
    if (!Number.isFinite(value) || value < 0 || value > 100_000) throw badRequest('Malformed cursor.');
    offsets[key] = Math.floor(value);
  }
  const cursors = {};
  for (const [key, value] of Object.entries(parsed.c || {})) {
    if (!PROVIDERS.includes(key)) throw badRequest('Malformed cursor.');
    if (typeof value !== 'string' || value.length > 2048) throw badRequest('Malformed cursor.');
    cursors[key] = value;
  }
  return { offsets, cursors };
}

/**
 * Run a unified discovery query.
 *
 * @returns {Promise<{items: object[], nextCursor: string|null, providers: object[]}>}
 */
export async function discover({
  query = '',
  tier = 'free',
  providers,
  limit = DEFAULT_LIMIT,
  cursor = '',
  sort = 'downloads',
  fetcher,
  timeoutMs,
  now = Date.now,
  store = null,
} = {}) {
  const capabilities = capabilitiesFor(tier);
  const pageSize = clampLimit(limit, capabilities.maxResultsPerPage);

  // Operator provider toggles (systemConfig/frostnet) intersect the plan
  // allowlist. `store` stays optional so pure discovery tests run unchanged.
  let enabledProviders = null;
  let blockedRules = [];
  let featuredEntries = [];
  if (store && typeof store.getFrostNetConfig === 'function') {
    const [config, rules, pins] = await Promise.all([
      store.getFrostNetConfig(),
      typeof store.listModerationRules === 'function' ? store.listModerationRules() : [],
      typeof store.listFeaturedModels === 'function' ? store.listFeaturedModels() : [],
    ]);
    if (Array.isArray(config?.enabledProviders) && config.enabledProviders.length > 0) {
      enabledProviders = config.enabledProviders.map((entry) => String(entry).toLowerCase());
    }
    blockedRules = Array.isArray(rules) ? rules : [];
    featuredEntries = Array.isArray(pins) ? pins : [];
  }

  const requested = normalizeProviders(providers);
  const planAllowed = requested.filter((provider) => allowsProvider(tier, provider));
  const allowed = enabledProviders ? planAllowed.filter((provider) => enabledProviders.includes(provider)) : planAllowed;
  const skipped = requested.filter((provider) => !allowed.includes(provider));

  const cleanQuery = sanitizeQuery(query);
  const { offsets, cursors } = decodeCursor(cursor, {
    query: cleanQuery,
    tier,
    providers: allowed,
  });

  const settled = await Promise.all(
    allowed.map(async (provider) => {
      const adapter = ADAPTERS[provider];
      try {
        const result = await adapter.search({
          query: cleanQuery,
          limit: pageSize,
          offset: offsets[provider] || 0,
          cursor: cursors[provider] || '',
          sort,
          fetcher,
          timeoutMs,
        });
        return { provider, ok: true, result };
      } catch (error) {
        return { provider, ok: false, error };
      }
    }),
  );

  const items = [];
  const seen = new Set();
  const providerReports = [];
  const nextOffsets = {};
  const nextCursors = {};

  for (const outcome of settled) {
    if (!outcome.ok) {
      providerReports.push({
        provider: outcome.provider,
        status: 'error',
        code: outcome.error?.retryable === false ? 'unavailable' : 'upstream_error',
        // The message is our own text from fetch-json, never a raw upstream
        // body, so it is safe to surface.
        message: outcome.error?.message || 'Provider failed.',
        count: 0,
      });
      continue;
    }

    const { provider, result } = outcome;
    let added = 0;
    for (const item of result.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
      added += 1;
    }

    if (Number.isFinite(result.nextOffset)) nextOffsets[provider] = result.nextOffset;
    if (result.nextCursor) nextCursors[provider] = result.nextCursor;

    providerReports.push({ provider, status: 'ok', count: added, code: null, message: null });
  }

  for (const provider of skipped) {
    const operatorDisabled = planAllowed.includes(provider);
    providerReports.push({
      provider,
      status: 'skipped',
      code: operatorDisabled ? 'operator_disabled' : 'plan_required',
      message: operatorDisabled
        ? `The ${provider} index is temporarily disabled by the FrostNet operators.`
        : `The ${provider} index requires a higher plan.`,
      count: 0,
    });
  }

  // Stable ordering: downloads desc, then likes desc, then name asc. Providers
  // return incomparable orderings, so sorting happens once, here.
  items.sort(compareModels);

  // Live-path moderation. The cache path in app.js applies the same function
  // again after reading, so cached pages can never bypass a fresh block.
  const moderated = applyFrostNetModeration(items, { blockedRules, featuredEntries, sort });
  items.length = 0;
  items.push(...moderated);

  const anySucceeded = providerReports.some((report) => report.status === 'ok');
  const hasMore = Object.keys(nextOffsets).length > 0 || Object.keys(nextCursors).length > 0;

  if (!anySucceeded && providerReports.length > 0 && skipped.length !== providerReports.length) {
    const failures = providerReports.filter((report) => report.status === 'error');
    throw upstreamFailure(
      failures.length === 1
        ? `${failures[0].provider} is unavailable right now.`
        : 'All discovery providers are unavailable right now.',
    );
  }

  return {
    query: cleanQuery,
    tier,
    items: items.slice(0, pageSize),
    pageSize,
    nextCursor: hasMore
      ? encodeCursor({ offsets: nextOffsets, cursors: nextCursors }, { query: cleanQuery, tier, providers: allowed })
      : null,
    providers: providerReports,
    generatedAt: new Date(typeof now === 'function' ? now() : now).toISOString(),
  };
}

function compareModels(a, b) {
  if (b.downloads !== a.downloads) return b.downloads - a.downloads;
  if (b.likes !== a.likes) return b.likes - a.likes;
  return a.name.localeCompare(b.name);
}

function normalizeProviders(requested) {
  // When the caller names no providers, enumerate *all* of them so the response
  // can explain which ones the caller's plan excludes. The plan filter below
  // decides what actually runs.
  if (requested === undefined || requested === null || requested === '') return [...PROVIDERS];
  const list = Array.isArray(requested) ? requested : String(requested).split(',');
  const cleaned = [];
  for (const entry of list) {
    const provider = String(entry).trim().toLowerCase();
    if (!provider) continue;
    if (!PROVIDERS.includes(provider)) throw badRequest(`Unknown provider: ${provider}`);
    if (!cleaned.includes(provider)) cleaned.push(provider);
  }
  if (cleaned.length === 0) throw badRequest('No providers requested.');
  if (cleaned.length > PROVIDERS.length) throw badRequest('Too many providers requested.');
  return cleaned;
}

function clampLimit(limit, maxFromPlan) {
  const raw = Number(limit);
  const ceiling = Math.min(MAX_LIMIT, Number.isFinite(maxFromPlan) ? maxFromPlan : DEFAULT_LIMIT);
  if (!Number.isFinite(raw) || raw <= 0) return Math.min(DEFAULT_LIMIT, ceiling);
  return Math.min(Math.floor(raw), ceiling);
}

/** Bound and clean a search string. Never interpolated into a URL unencoded. */
export function sanitizeQuery(query) {
  if (typeof query !== 'string') return '';
  return query.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
}

export { DEFAULT_LIMIT, MAX_LIMIT };