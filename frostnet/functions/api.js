import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson, validateRelease, FROSTNET_TERMS } from './release-manifest.js';
const digest = value => createHash('sha256').update(value).digest('hex');
const validId = value => /^[a-f0-9]{64}$/.test(value || '');
const problem = (status, message) => Object.assign(new Error(message), { status });

export function searchTokens(manifest) {
  const words = new Set([manifest.name, manifest.publisher, manifest.release, manifest.variant, ...`${manifest.name} ${manifest.release} ${manifest.variant}`.split(/\s+/)]);
  const tokens = new Set(); for (const word of words) for (let i = 1; i <= Math.min(word.length, 80); i++) tokens.add(word.slice(0, i).toLowerCase());
  return [...tokens].slice(0, 500);
}
export function createApi({ storage, tokenHash, namespace = 'blackfrost', now = Date.now }) {
  const authorize = req => {
    const match = /^Bearer (fn_[a-zA-Z0-9_-]{32,180})$/.exec(req.headers.authorization || '');
    const expected = tokenHash();
    if (!match || !/^[a-f0-9]{64}$/.test(expected || '') || !timingSafeEqual(Buffer.from(digest(match[1]), 'hex'), Buffer.from(expected, 'hex'))) throw problem(401, 'A Frostnet publishing token is required.');
    return namespace;
  };
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'https://frostnet.si'), route = url.pathname.replace(/\/$/, '');
      let result;
      if (req.method === 'GET' && route === '/v1/health') result = { service: 'Frostnet', version: 1, terms: FROSTNET_TERMS, metadata_only: true };
      else if (req.method === 'GET' && route === '/v1/account') result = { namespace: authorize(req), permissions: ['publish', 'withdraw'], terms: FROSTNET_TERMS };
      else if (req.method === 'GET' && route === '/v1/search') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase(); if (q.length > 80) throw problem(400, 'Search is limited to 80 characters.');
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 24)); const cursor = url.searchParams.get('cursor') || '';
        if (cursor && !validId(cursor)) throw problem(400, 'Invalid search cursor.');
        result = await storage.search({ q, limit: Math.floor(limit), cursor });
      } else if (req.method === 'GET' && route === '/v1/changes') {
        const cursor = url.searchParams.get('cursor') || '0'; if (!/^\d{1,16}$/.test(cursor)) throw problem(400, 'Invalid change cursor.');
        result = await storage.changes(cursor, 100);
      } else if (req.method === 'GET' && /^\/v1\/(releases|manifests|submissions)\/[a-f0-9]{64}$/.test(route)) {
        const [, , collection, id] = route.split('/');
        if (collection === 'submissions') authorize(req);
        result = await storage.get(collection, id); if (!result) throw problem(404, 'Not found.');
        if (collection === 'submissions' && result.publisher !== namespace) throw problem(404, 'Not found.');
      } else if (req.method === 'POST' && (route === '/v1/submissions' || /^\/v1\/releases\/[a-f0-9]{64}\/withdraw$/.test(route))) {
        const publisher = authorize(req), body = req.body;
        if (!body || Buffer.byteLength(JSON.stringify(body)) > 800000) throw problem(413, 'Submission metadata is too large.');
        if (!validId(body.idempotency_key) || !validId(body.digest)) throw problem(400, 'Invalid idempotency key or manifest digest.');
        if (body.terms !== FROSTNET_TERMS) throw problem(422, 'Review the current publishing terms.');
        const withdrawing = route.endsWith('/withdraw');
        let manifest;
        if (!withdrawing) {
          try { manifest = validateRelease(body.manifest); } catch (error) { throw problem(422, error.message); }
          if (manifest.publisher !== publisher) throw problem(403, 'This token cannot publish in that namespace.');
          if (digest(canonicalJson(manifest)) !== body.digest) throw problem(422, 'Manifest digest does not match.');
        } else if (route.split('/')[3] !== body.digest) throw problem(400, 'Withdrawal identity changed.');
        result = await storage.submit({ key: body.idempotency_key, digest: body.digest, manifest, publisher, withdrawing, now: now(), terms: FROSTNET_TERMS });
      } else throw problem(404, 'Unknown endpoint.');
      res.statusCode = 200; res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = [400, 401, 403, 404, 409, 413, 422, 429].includes(error.status) ? error.status : 503;
      if (res.statusCode === 503 || res.statusCode === 429) res.setHeader('Retry-After', '60');
      res.end(JSON.stringify({ error: res.statusCode === 503 ? 'Frostnet is temporarily unavailable. Retry with the same idempotency key.' : error.message }));
    }
  };
}

/** In-memory transactional fixture and local preview store; never used in production. */
export class MemoryDirectory {
  constructor(snapshot) { this.data = snapshot ? structuredClone(snapshot) : { releases: {}, manifests: {}, submissions: {}, identities: {}, changes: [], rates: {} }; }
  async get(collection, id) { return this.data[collection]?.[id] || null; }
  async search({ q, limit, cursor }) { const rows = Object.values(this.data.releases).filter(row => row.status === 'published' && row.digest > cursor && (!q || searchTokens(row.manifest).includes(q))).sort((a, b) => a.digest.localeCompare(b.digest)); const items = rows.slice(0, limit); return { items, cursor: rows.length > limit ? items.at(-1).digest : '' }; }
  async changes(cursor, limit) { const changes = this.data.changes.filter(row => row.sequence > Number(cursor)).slice(0, limit); return { changes, cursor: String(changes.at(-1)?.sequence || cursor) }; }
  async submit(request) {
    const { key, digest: id, manifest, publisher, withdrawing, now } = request;
    const existing = this.data.submissions[key]; if (existing) { if (existing.digest !== id || existing.status === 'withdrawn' !== withdrawing) throw problem(409, 'Idempotency key was reused for another operation.'); return existing; }
    const rateKey = publisher + ':' + Math.floor(now / 3600000); if ((this.data.rates[rateKey] || 0) >= 60) throw problem(429, 'Publisher hourly limit reached.');
    const previous = this.data.releases[id];
    if (withdrawing && (!previous || previous.manifest.publisher !== publisher)) throw problem(404, 'Release not found.');
    if (!withdrawing) {
      const identity = [publisher, manifest.release, manifest.variant].join('/');
      if (this.data.identities[identity] && this.data.identities[identity] !== id) throw problem(409, 'This release variant is immutable. Choose a new release ID for changed bytes or metadata.');
      if (previous?.status === 'withdrawn') throw problem(409, 'Withdrawn releases cannot be republished. Create a new release.');
      this.data.identities[identity] = id; this.data.manifests[id] = manifest;
    }
    const status = withdrawing ? 'withdrawn' : 'published', sequence = this.data.changes.length + 1;
    const release = { digest: id, manifest: manifest || previous.manifest, status, updated_at: new Date(now).toISOString(), availability: { status: 'unknown', observed_at: null } };
    this.data.releases[id] = release;
    this.data.changes.push({ sequence, digest: id, status, updated_at: release.updated_at });
    this.data.rates[rateKey] = (this.data.rates[rateKey] || 0) + 1;
    const receipt = { id: key, digest: id, publisher, status, withdrawal: true, terms: request.terms }; this.data.submissions[key] = receipt; return receipt;
  }
}
