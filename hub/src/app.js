/**
 * FrostByte local Hub — real backend (replaces the earlier prototype).
 *
 * Honors the desktop client contracts in src/main/hub-client.js + src/shared/hub-protocol.js:
 *   - Content-addressed recipes: digest = sha256(canonicalJson(manifest)), always recomputed.
 *   - Publish requires a valid ed25519 signature (frostbyte-recipe/2) from manifest.publisher
 *     plus accepted terms; identity is the pubkey, authorization is a resolved bearer token.
 *   - Paid endpoints (/v1/updates, /v1/events/subscribe) require a resolved plus/pro token.
 *   - Update feed is signed (frostbyte-bundle/1) with the hub feed key; clients verify before
 *     emitting nudges. Feed shape: {version, engines, recipes, configs, containers, signature,
 *     feedPubKey}.
 *   - Every handler is wrapped: bad input returns a status-bearing JSON error, never a crash.
 *
 * Local-first: in-memory store with optional atomic JSON persistence (HUB_DATA_DIR). The
 * Prisma schema in hub/prisma is the production reference; this server does not require
 * Postgres. The deployed Firebase platform backend is separate and untouched.
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from './store.js';
import { createAuth, parseTokensEnv } from './auth.js';
import { createSearch, MODEL_CATALOG } from './search.js';
import { buildSeeds } from './seed.js';
import { loadOrCreateFeedKey, buildFeedBody, signFeed } from './feed.js';
import { verifyRecipePublish, generateKeypair, manifestDigest } from './crypto.js';
import { validateRecipe } from '../../src/shared/recipe-manifest.js';
import { FROSTNET_TERMS } from '../../src/shared/release-manifest.js';
import { encodeCursor, decodeCursor, PAGINATION } from '../../src/shared/hub-protocol.js';

const MAX_BODY = 64 * 1024;

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// Read a request body with an incremental cap — never accumulate past MAX_BODY.
function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        // Stop reading; the caller sends 413 and closes the connection cleanly.
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        reject(httpError(413, 'too_large', 'Payload too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', err => { if (!aborted) reject(err); });
  });
}

function parseAccountsEnv(raw) {
  if (!raw || typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function createHubApp({
  port = Number(process.env.HUB_PORT || 8787),
  dataDir = process.env.HUB_DATA_DIR || null,
  tokens = parseTokensEnv(process.env.HUB_TOKENS),
  devTier = process.env.HUB_DEV_TIER || 'pro',
  authSecret = process.env.HUB_AUTH_SECRET || process.env.HUB_SESSION_SECRET || '',
  devAuth,
  accounts = parseAccountsEnv(process.env.HUB_ACCOUNTS || process.env.HUB_ACCOUNTS_JSON),
  devPassword = process.env.HUB_DEV_PASSWORD,
  sessionTtlSeconds,
  corsOrigins = (process.env.HUB_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  seed = true,
  // Retirement freeze (P2.3): read-only legacy. Content writes (recipe publish,
  // follow/unfollow) return 410 legacy_frozen with a pointer to the new plane;
  // reads and auth/session routes stay live so existing clients and the
  // migration tool can keep enumerating. Set FROSTNET_FROZEN=1 in the legacy
  // deployment ONLY after the import is verified complete.
  frozen = process.env.FROSTNET_FROZEN === '1',
} = {}) {
  const store = createStore({ dataDir });
  const auth = createAuth({
    tokens,
    devTier,
    secret: authSecret,
    devMode: devAuth,
    accounts,
    devPassword,
    sessionTtlSeconds,
  });
  const search = createSearch({ store });
  const feedKey = loadOrCreateFeedKey(dataDir);

  // Stable dev publisher key so seed digests survive restarts (persisted alongside the store).
  if (seed && store.stats().recipes === 0) {
    const seedKey = loadSeedKey(dataDir);
    const { records } = buildSeeds(seedKey);
    for (const record of records) store.publish(record);
  }

  // Per-identity follow sets (local, in-memory).
  const follows = new Map(); // uid -> Set(pubkey)

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const headers = { Vary: 'Origin' };
    if (origin && corsOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, If-None-Match';
      headers['Access-Control-Allow-Methods'] = 'GET,POST,DELETE,OPTIONS';
    }
    return headers;
  }

  function send(res, status, body, extraHeaders = {}, req = null) {
    const headers = { 'Content-Type': 'application/json', ...(req ? corsHeaders(req) : {}), ...extraHeaders };
    if (body != null) {
      const text = JSON.stringify(body);
      res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    } else {
      res.writeHead(status, headers);
      res.end();
    }
  }

  function fail(res, req, err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    const code = err?.code || (status === 500 ? 'internal' : 'error');
    const message = status === 500 ? 'Internal Hub error.' : (err?.message || 'Request failed.');
    // On an oversized body the client may still be sending; signal close after responding.
    const extra = status === 413 ? { Connection: 'close' } : {};
    send(res, status, { error: { code, message } }, extra, req);
    if (status === 413) res.on('finish', () => req.destroy());
  }

  function requirePaid(req) {
    const identity = auth.resolve(req.headers.authorization);
    if (!identity) throw httpError(401, 'unauthorized', 'Sign in to the Hub to use live updates.');
    if (!auth.isPaid(identity)) throw httpError(403, 'upgrade_required', 'Plus or Pro is needed for live updates.');
    return identity;
  }

  function etagForDigest(digest) { return `"sha256:${digest}"`; }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        return res.end();
      }
      let url;
      try { url = new URL(req.url, 'http://localhost'); }
      catch { throw httpError(400, 'bad_request', 'Malformed request target.'); }
      const pathname = url.pathname;
      const q = Object.fromEntries(url.searchParams.entries());

      if (pathname === '/health' || pathname === '/v1/health') {
        return send(res, 200, { ok: true, store: store.mode, stats: store.stats(), frozen: frozen === true }, {}, req);
      }

      // Authenticated user profile + server-resolved entitlement (flat shape matching platform/functions).
      if (req.method === 'GET' && pathname === '/v1/me') {
        const identity = auth.resolve(req.headers.authorization);
        if (!identity) throw httpError(401, 'unauthorized', 'Sign in to view your Hub account.');
        return send(res, 200, auth.mePayload(identity), { 'Cache-Control': 'no-store' }, req);
      }

      // Session sign-in — strict 4 KB body cap, timing-safe check, returns signed session JWT + profile.
      if (req.method === 'POST' && pathname === '/v1/auth/login') {
        const body = await readBody(req, 4096);
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { throw httpError(400, 'bad_json', 'Invalid JSON.'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw httpError(400, 'bad_request', 'Login payload must be a JSON object.');
        }
        const session = auth.login({ email: parsed.email, password: parsed.password });
        return send(res, 200, session, { 'Cache-Control': 'no-store' }, req);
      }

      // Session sign-out — revokes bearer token immediately.
      if (req.method === 'POST' && pathname === '/v1/auth/logout') {
        const identity = auth.resolve(req.headers.authorization);
        if (!identity) throw httpError(401, 'unauthorized', 'Sign in before revoking a session.');
        auth.revoke(req.headers.authorization);
        return send(res, 200, { ok: true, revoked: true }, { 'Cache-Control': 'no-store' }, req);
      }

      // Search — unified models + recipes, protocol cursor.
      if (req.method === 'GET' && pathname === '/v1/search') {
        const limit = q.limit != null ? Number(q.limit) : PAGINATION.DEFAULT_LIMIT;
        if (q.limit != null && (!Number.isInteger(limit) || limit < 1)) throw httpError(400, 'bad_limit', 'Invalid limit.');
        const result = search({ q: q.q || q.query || '', cursor: q.cursor || null, limit, kind: q.kind, task: q.task, license: q.license, publisher: q.publisher });
        return send(res, 200, result, {}, req);
      }

      // Publish — verified signature + terms + schema. Identity = manifest.publisher.
      if (req.method === 'POST' && pathname === '/v1/recipes') {
        if (frozen) throw httpError(410, 'legacy_frozen', 'This legacy FrostNet hub is retired for writes. Publish on the new FrostNet plane in the FrostByte app.');
        const identity = auth.resolve(req.headers.authorization);
        if (!identity) throw httpError(401, 'unauthorized', 'Sign in to the Hub to publish.');
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { throw httpError(400, 'bad_json', 'Invalid JSON.'); }
        if (parsed.terms !== FROSTNET_TERMS) throw httpError(400, 'bad_terms', 'Publishing terms changed. Review and re-accept.');
        let manifest;
        try { manifest = validateRecipe(parsed.manifest); }
        catch (e) { throw httpError(400, 'bad_manifest', e.message || 'Invalid recipe manifest.'); }
        if (!verifyRecipePublish({ manifest, signature: parsed.signature })) {
          throw httpError(400, 'bad_signature', 'Recipe signature is missing or invalid.');
        }
        const { digest } = store.publish({ manifest, signature: parsed.signature, terms: parsed.terms });
        return send(res, 201, { ok: true, digest, status: 'published' }, {}, req);
      }

      // Manifest by digest — content-addressed, real digest binding.
      if (req.method === 'GET' && /^\/v1\/manifests\/[a-f0-9]{64}$/.test(pathname)) {
        const digest = pathname.split('/').pop();
        const record = store.byDigest(digest);
        if (!record) throw httpError(404, 'not_found', 'No manifest for that digest.');
        const etag = etagForDigest(digest);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, ...corsHeaders(req) }); return res.end(); }
        return send(res, 200, { digest, manifest: record.manifest, signature: record.signature }, { ETag: etag }, req);
      }

      // Recipe manifest alias /v1/recipes/{id}/manifest (must precede the bare-id route).
      if (req.method === 'GET' && /^\/v1\/recipes\/[^/]+\/manifest$/.test(pathname)) {
        const id = safeDecode(pathname.split('/')[3]);
        const found = store.recipeById(id);
        if (found) {
          const etag = etagForDigest(found.head.digest);
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, ...corsHeaders(req) }); return res.end(); }
          return send(res, 200, { digest: found.head.digest, manifest: found.manifest, signature: found.signature }, { ETag: etag }, req);
        }
        const model = catalogModelDetail(id);
        if (model) return send(res, 200, model, {}, req);
        throw httpError(404, 'not_found', 'Recipe is not listed.');
      }

      // Recipe by id, or a catalog model detail (HF repo) when the id is a known model.
      if (req.method === 'GET' && /^\/v1\/recipes\/[^/]+$/.test(pathname)) {
        const id = safeDecode(pathname.split('/').pop());
        const found = store.recipeById(id);
        if (found) {
          const etag = etagForDigest(found.head.digest);
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, ...corsHeaders(req) }); return res.end(); }
          return send(res, 200, {
            head: { id: found.head.id, currentVersion: found.head.currentVersion },
            digest: found.head.digest, manifest: found.manifest, signature: found.signature, status: 'published',
          }, { ETag: etag }, req);
        }
        const model = catalogModelDetail(id);
        if (model) return send(res, 200, { ...model, head: { id, currentVersion: 1 }, status: 'catalog' }, {}, req);
        throw httpError(404, 'not_found', 'Recipe is not listed.');
      }

      // Creator.
      if (req.method === 'GET' && /^\/v1\/creators\/[a-f0-9]{64}$/i.test(pathname)) {
        const pubkey = pathname.split('/').pop().toLowerCase();
        const found = store.creator(pubkey);
        if (!found) return send(res, 200, { creator: { pubkey, username: 'unknown', verified: false }, recipes: [] }, {}, req);
        return send(res, 200, { creator: found.creator, recipes: found.recipes, stats: { recipeCount: found.recipes.length } }, {}, req);
      }

      // Follow / unfollow (authenticated).
      if ((req.method === 'POST' || req.method === 'DELETE') && /^\/v1\/follows\/[a-f0-9]{64}$/i.test(pathname)) {
        if (frozen) throw httpError(410, 'legacy_frozen', 'This legacy FrostNet hub is retired for writes. Follow creators on the new FrostNet plane in the FrostByte app.');
        const identity = auth.resolve(req.headers.authorization);
        if (!identity) throw httpError(401, 'unauthorized', 'Sign in to the Hub to follow creators.');
        const pubkey = pathname.split('/').pop().toLowerCase();
        const set = follows.get(identity.uid) || new Set();
        if (req.method === 'POST') set.add(pubkey); else set.delete(pubkey);
        follows.set(identity.uid, set);
        return send(res, 200, { ok: true, follows: [...set] }, {}, req);
      }

      // Updates (Plus/Pro) — signed feed, correct shape.
      if (req.method === 'GET' && pathname === '/v1/updates') {
        requirePaid(req);
        const body = buildFeedBody(store);
        return send(res, 200, signFeed(body, feedKey), {}, req);
      }

      // Entitlement (authenticated) — server-resolved tier, never client-asserted.
      if (req.method === 'GET' && pathname === '/v1/me/entitlement') {
        const identity = auth.resolve(req.headers.authorization);
        if (!identity) throw httpError(401, 'unauthorized', 'Sign in to the Hub.');
        const tier = identity.tier;
        const paid = auth.isPaid(identity);
        return send(res, 200, {
          tier,
          status: paid ? 'active' : 'free',
          currentPeriodEnd: paid ? new Date(Date.now() + 30 * 86400000).toISOString() : null,
          entitlements: { liveUpdates: paid, bundleSync: paid, publishing: true },
          source: 'server',
        }, {}, req);
      }

      // Bundle latest / by digest. The bundle manifest is deterministic: its timestamp is
      // derived from the newest head update, NOT the clock, so the digest is stable and a
      // client can fetch /v1/bundle/{digest} and get the same content.
      function currentBundle() {
        const heads = store.headsList();
        const entries = heads.map(h => ({ id: h.id, digest: h.digest })).sort((a, b) => a.id.localeCompare(b.id));
        const newest = heads.reduce((acc, h) => (h.updatedAt > acc ? h.updatedAt : acc), '1970-01-01T00:00:00.000Z');
        const bundleManifest = { schema: 'frostbyte.bundle', version: 1, entries, createdAt: newest };
        return { digest: manifestDigest(bundleManifest), manifest: bundleManifest, entries };
      }
      if (req.method === 'GET' && pathname === '/v1/bundle/latest') {
        const bundle = currentBundle();
        const etag = etagForDigest(bundle.digest);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, ...corsHeaders(req) }); return res.end(); }
        return send(res, 200, bundle, { ETag: etag }, req);
      }
      if (req.method === 'GET' && /^\/v1\/bundle\/[a-f0-9]{64}$/.test(pathname)) {
        const digest = pathname.split('/').pop();
        const bundle = currentBundle();
        if (bundle.digest !== digest) throw httpError(404, 'not_found', 'No bundle for that digest.');
        return send(res, 200, bundle, {}, req);
      }

      // Changes (offline sync) — real change log from the store.
      if (req.method === 'GET' && pathname === '/v1/changes') {
        let afterSeq = 0;
        if (q.cursor) {
          const n = Number(q.cursor);
          if (!Number.isSafeInteger(n) || n < 0) throw httpError(400, 'bad_cursor', 'Invalid cursor.');
          afterSeq = n;
        }
        const limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(1, Number(q.limit) || PAGINATION.DEFAULT_LIMIT));
        return send(res, 200, store.changes({ afterSeq, limit }), {}, req);
      }

      // SSE live highway (Plus/Pro).
      if (req.method === 'GET' && pathname === '/v1/events/subscribe') {
        requirePaid(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...corsHeaders(req) });
        res.write(':ok\n\n');
        const t = setInterval(() => { try { res.write(':ping\n\n'); } catch { /* closed */ } }, 15000);
        req.on('close', () => clearInterval(t));
        return;
      }

      throw httpError(404, 'not_found', 'No route: ' + pathname);
    } catch (err) {
      fail(res, req, err);
    }
  });

  return {
    server,
    store,
    auth,
    feedPubKey: feedKey.publicKeyHex,
    listen() { return new Promise((resolve, reject) => { server.listen(port, '127.0.0.1', () => resolve(server)); server.on('error', reject); }); },
    close() { return new Promise((resolve) => server.close(resolve)); },
    get origin() {
      const address = server.address();
      const bound = address && typeof address === 'object' ? address.port : port;
      return `http://localhost:${bound}`;
    },
  };
}

function safeDecode(segment) {
  try { return decodeURIComponent(segment); }
  catch { throw httpError(400, 'bad_request', 'Malformed path segment.'); }
}

// Catalog models are index pointers at public HuggingFace repos, not hosted weight
// manifests. Their detail describes the repo and routes the user to the real HF file
// picker (the normal download review applies there). We never fabricate file sizes or
// hashes the hub does not have — the single row states plainly that the file list is
// fetched from HuggingFace at the pinned revision.
function catalogModelDetail(id) {
  const entry = MODEL_CATALOG.find(m => m.id === id);
  if (!entry) return null;
  return {
    digest: manifestDigest({ kind: 'model', id: entry.id, revision: 'main' }),
    manifest: {
      kind: 'model',
      id: entry.id,
      title: entry.title,
      task: entry.task,
      license: entry.license,
      models: [{ repoId: entry.id, revision: 'main' }],
      files: [{ path: `${entry.id} — open in the Hugging Face tab to browse and verify the actual files`, size: 0, sha256: '' }],
    },
  };
}

// Dedicated seed publisher key (separate from the feed key) persisted 0600.
function loadSeedKey(dataDir) {
  if (!dataDir) return generateKeypair();
  const file = path.join(dataDir, 'seed-key.json');
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (/^[a-f0-9]{64}$/.test(saved.publicKeyHex) && /^[a-f0-9]{64}$/.test(saved.privateKeyHex)) return saved;
    }
  } catch { /* regenerate */ }
  const key = generateKeypair();
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(key)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return key;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createHubApp();
  app.listen().then(() => {
    console.log(`FrostByte local Hub listening on ${app.origin} (store: ${app.store.mode})`);
    if (app.auth.devToken) console.log(`Dev token (plus/pro): ${app.auth.devToken}`);
    console.log(`Feed public key: ${app.feedPubKey}`);
  }).catch(err => { console.error('Hub failed to start:', err.message); process.exit(1); });
}