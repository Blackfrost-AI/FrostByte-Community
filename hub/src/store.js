// Local Hub store. Content-addressed recipes (digest = sha256(canonicalJson(manifest)))
// with an in-memory index and optional atomic JSON-file persistence. This is the local
// development backend; the Prisma schema in hub/prisma remains the production reference.
// Nothing here trusts a client-supplied digest — digests are always recomputed.
import fs from 'node:fs';
import path from 'node:path';
import { manifestDigest } from './crypto.js';
import { encodeCursor } from '../../src/shared/hub-protocol.js';

const MAX_RECIPES = 100000;

export function createStore({ dataDir = null } = {}) {
  const recipesByDigest = new Map();   // digest -> { digest, manifest, signature, publisher, terms, createdAt }
  const heads = new Map();             // recipe id -> { id, currentVersion, digest, publisher, license, updatedAt }
  const creators = new Map();          // pubkey -> { pubkey, username, verified }
  const events = [];                   // append-only change log
  let seq = 0;
  const file = dataDir ? path.join(dataDir, 'hub-store.json') : null;

  function persist() {
    if (!file) return;
    const snapshot = {
      recipes: [...recipesByDigest.values()],
      heads: [...heads.values()],
      creators: [...creators.values()],
      events: events.slice(-10000),
      seq,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(snapshot));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  function load() {
    if (!file || !fs.existsSync(file)) return;
    try {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const r of snapshot.recipes || []) recipesByDigest.set(r.digest, r);
      for (const h of snapshot.heads || []) heads.set(h.id, h);
      for (const c of snapshot.creators || []) creators.set(c.pubkey, c);
      events.push(...(snapshot.events || []));
      seq = Number(snapshot.seq) || 0;
    } catch {
      // A corrupt local store starts empty rather than crashing the daemon.
    }
  }
  load();

  function recordEvent(type, digest, publisher) {
    seq += 1;
    events.push({ seq, type, digest, publisher, at: new Date().toISOString() });
    if (events.length > 20000) events.splice(0, events.length - 10000);
  }

  return {
    get mode() { return file ? 'file' : 'memory'; },

    // Publish a verified recipe. The caller MUST have verified the signature already.
    // Digest is recomputed from the manifest; a client-supplied digest is never trusted.
    publish({ manifest, signature, terms }) {
      if (recipesByDigest.size >= MAX_RECIPES) {
        const err = new Error('The Hub recipe store is full.'); err.status = 507; throw err;
      }
      const digest = manifestDigest(manifest);
      const publisher = manifest.publisher;
      const now = new Date().toISOString();
      const existing = recipesByDigest.get(digest);
      if (!existing) {
        recipesByDigest.set(digest, { digest, manifest, signature, publisher, terms, createdAt: now });
        const head = heads.get(manifest.id);
        // v2 recipes carry a fixed schema version (2), not a content version. The store
        // assigns a monotonic revision per id; each new distinct digest advances the head.
        const revision = head ? Number(head.currentVersion) + 1 : 1;
        heads.set(manifest.id, {
          id: manifest.id, title: manifest.title || manifest.id, currentVersion: revision, digest,
          publisher, license: manifest.license?.id || 'unknown', task: manifest.task || null, updatedAt: now,
        });
        if (!creators.has(publisher)) {
          creators.set(publisher, { pubkey: publisher, username: manifest.author?.name || 'creator', verified: false });
        }
        recordEvent('recipe.published', digest, publisher);
        persist();
      }
      return { digest, head: heads.get(manifest.id) };
    },

    byDigest(digest) {
      return recipesByDigest.get(String(digest || '').toLowerCase()) || null;
    },

    head(id) {
      return heads.get(String(id || '')) || null;
    },

    headsList() {
      return [...heads.values()];
    },

    recipeById(id) {
      const head = heads.get(String(id || ''));
      if (!head) return null;
      const record = recipesByDigest.get(head.digest);
      if (!record) return null;
      return { head, manifest: record.manifest, signature: record.signature };
    },

    creator(pubkey) {
      const key = String(pubkey || '').toLowerCase();
      const creator = creators.get(key);
      if (!creator) return null;
      const recipes = [...heads.values()].filter(h => h.publisher === key);
      return { creator, recipes };
    },

    search({ q, cursor = null, limit = 50, kind, task, license, publisher } = {}) {
      // The local store holds recipes only. kind=model returns nothing (models live on HF);
      // kind=recipe (or unset) returns recipe heads.
      if (kind === 'model') return { items: [], nextCursor: null };
      let items = [...heads.values()];
      if (q) {
        const needle = String(q).toLowerCase();
        items = items.filter(h => String(h.id).toLowerCase().includes(needle) || String(h.title || '').toLowerCase().includes(needle));
      }
      if (task) items = items.filter(h => h.task === task);
      if (license) items = items.filter(h => h.license === license);
      if (publisher) items = items.filter(h => h.publisher === String(publisher).toLowerCase());
      items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const start = cursor && Number.isInteger(cursor.seq) ? cursor.seq : 0;
      const page = items.slice(start, start + limit);
      const nextSeq = start + page.length;
      const nextCursor = nextSeq < items.length ? encodeCursor({ seq: nextSeq }) : null;
      return {
        items: page.map(h => ({
          id: h.id, title: h.title || h.id, kind: 'recipe', publisher: h.publisher,
          license: h.license, digest: h.digest,
        })),
        nextCursor,
      };
    },

    changes({ afterSeq = 0, limit = 100 } = {}) {
      const page = events.filter(e => e.seq > afterSeq).slice(0, limit);
      const last = page.length ? page[page.length - 1].seq : afterSeq;
      return { changes: page, nextCursor: page.length === limit ? String(last) : null };
    },

    stats() {
      return { recipes: recipesByDigest.size, heads: heads.size, creators: creators.size, events: events.length };
    },
  };
}