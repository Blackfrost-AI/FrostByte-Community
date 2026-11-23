#!/usr/bin/env node
/**
 * P2.3 stage 1 — ENUMERATE the legacy FrostNet hub (read-only).
 *
 * Walks /v1/changes (numeric cursor pagination) to collect every event, then
 * resolves the LIVE head set via /v1/bundle/latest (legacy published events
 * are digest-only: {seq, type, digest, publisher, at}) and fetches each
 * manifest + signature via /v1/recipes/:id. Writes a local export bundle +
 * receipt. NO writes anywhere — safe against production.
 *
 * Usage:
 *   node scripts/legacy-frostnet-export.mjs --base https://frostnet-si.web.app \
 *     --out .receipts/legacy-frostnet-retirement/export.json
 *
 * The legacy store only emits recipe.published events (no withdraw route
 * exists in the legacy codebase); withdrawn[] is therefore normally empty but
 * the shape is kept for forward-compatibility and explicit operator input.
 */
import path from 'node:path';
import { getJson, writeArtifactWithReceipt, DEFAULT_SOURCE } from './lib/legacy-frostnet.mjs';

function parseArgs(argv) {
  const args = { base: '', out: '', source: DEFAULT_SOURCE, limit: 100 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.base || !/^https?:\/\//.test(args.base)) throw new Error('--base <legacy hub URL> is required.');
  if (!args.out) throw new Error('--out <export.json> is required.');
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 500) throw new Error('--limit must be 1..500.');
  args.base = args.base.replace(/\/+$/, '');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  // 1. Health probe first — fail fast on an unreachable/misconfigured target.
  const health = await getJson(`${args.base}/v1/health`);
  if (!health?.ok) throw new Error('Legacy hub health check did not return ok:true.');

  // 2. Walk the change log to the end (numeric cursor, bounded pages).
  const events = [];
  let cursor = 0;
  for (;;) {
    const page = await getJson(`${args.base}/v1/changes?cursor=${cursor}&limit=${args.limit}`);
    const changes = Array.isArray(page?.changes) ? page.changes : [];
    events.push(...changes);
    if (!page?.nextCursor) break;
    const next = Number(page.nextCursor);
    if (!Number.isSafeInteger(next) || next <= cursor) throw new Error('Change cursor did not advance — refusing to loop.');
    cursor = next;
  }

  // 3. Resolve the live head set. Legacy published events carry digest only
  //    ({seq, type, digest, publisher, at}), so the authoritative id list is
  //    the bundle manifest (deterministic, content-addressed). A 404 on a
  //    head fetch is recorded as negative evidence, not fatal.
  const bundleLatest = await getJson(`${args.base}/v1/bundle/latest`);
  const entries = Array.isArray(bundleLatest?.manifest?.entries) ? bundleLatest.manifest.entries : [];
  const seqByDigest = new Map();
  for (const event of events) {
    if (event.type !== 'recipe.published' || !event.digest) continue;
    if (!seqByDigest.has(String(event.digest))) seqByDigest.set(String(event.digest), event.seq);
  }
  const recipes = [];
  const missing = [];
  for (const entry of entries) {
    const id = String(entry?.id || '');
    if (!id) continue;
    try {
      const found = await getJson(`${args.base}/v1/recipes/${encodeURIComponent(id)}`);
      if (found?.status === 'catalog') continue; // HF catalog pointers are not recipes
      if (entry.digest && found.digest !== entry.digest) {
        // The head moved between bundle and fetch — record the drift honestly.
        missing.push({ id, reason: 'head_drift', bundleDigest: entry.digest, fetchedDigest: found.digest });
      }
      recipes.push({
        id,
        head: found.head || null,
        manifest: found.manifest,
        digest: found.digest,
        signature: found.signature,
        legacySeq: seqByDigest.get(String(found.digest)) ?? null,
      });
    } catch (error) {
      if (error.status === 404) { missing.push({ id, reason: 'not_found' }); continue; }
      throw error;
    }
  }

  const withdrawn = [...new Set(events.filter((e) => e.type === 'recipe.withdrawn' && e.id).map((e) => String(e.id)))];
  const bundle = {
    exportedAt: startedAt,
    source: args.source,
    base: args.base,
    health,
    bundleDigest: bundleLatest?.digest || null,
    events,
    recipes,
    withdrawn,
    missing,
  };
  const receipt = writeArtifactWithReceipt(path.resolve(args.out), bundle, {
    stage: 'enumerate',
    extra: {
      base: args.base,
      counts: { events: events.length, recipes: recipes.length, withdrawn: withdrawn.length, missing: missing.length },
      startedAt,
      finishedAt: new Date().toISOString(),
    },
  });
  console.log(JSON.stringify({ ok: true, out: path.resolve(args.out), ...receipt }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, stage: 'enumerate', error: error.message }));
  process.exit(1);
});