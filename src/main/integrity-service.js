/** Integrity service (Phase B): cached per-model scans combining the native
 * format-safety gate (Layer 2) with optional upstream hash anchoring (Layer 3).
 * Mirrors OriginRegistry: fingerprint-keyed cache, persisted via the store's
 * aeonIntegrity field, compact summaries for the renderer.
 *
 * Gate policy (owner-approved): a confirmed `risky-format` blocks sharing;
 * `unknown` and `safe-format` never block, and unknown is never shown as safe.
 * Scans are explicit (user-triggered); an absent result is not a scan failure.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeFileSafety as analyzeSafety } from './format-safety.js';
import { verifyAgainstUpstream as verifyUpstream } from './upstream-verify.js';
import { integrityFingerprint } from './aeon-origin-check.js';
import { CARD_FILE } from '../shared/aeon-origin-status.js';

export const INTEGRITY_SHARE_BLOCKED = 'FrostByte found a file in this model that can run code when loaded (risky format). Sharing is blocked until the risky files are removed.';
const MAX_LISTED = 20;
const MAX_NAME = 300;
const MAX_ERROR = 500;
const MAX_SCAN_FILES = 5000;
const VERDICTS = new Set(['safe-format', 'risky-format', 'unknown']);
const UPSTREAM_VERDICTS = new Set(['matches-upstream', 'differs', 'unknown']);

/** Share gate predicate — the ONLY blocking condition is a completed scan whose
 * aggregate format verdict is risky. Everything else (unscanned, failed,
 * unknown, safe) passes; the UI still shows the honest verdict. */
export function integrityBlocksSharing(result) {
  return result?.status === 'done' && result?.format?.verdict === 'risky-format';
}

function validResult(value) {
  if (!value || typeof value !== 'object') return false;
  if (!['done', 'failed'].includes(value.status)) return false;
  if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return false;
  if (value.scannedAt !== undefined && (!Number.isSafeInteger(value.scannedAt) || value.scannedAt < 0 || value.scannedAt > Date.now() + 60_000)) return false;
  if (value.status === 'failed') return typeof value.error === 'string' && value.error.length <= MAX_ERROR;
  if (!value.format || !VERDICTS.has(value.format.verdict)) return false;
  // A risky verdict with no named files is internally inconsistent — treat
  // the persisted record as corrupt rather than trusting it.
  if (value.format.verdict === 'risky-format' && (!Array.isArray(value.format.risky) || value.format.risky.length === 0)) return false;
  for (const key of ['risky', 'unknown']) {
    if (!Array.isArray(value.format[key]) || value.format[key].length > MAX_LISTED) return false;
    if (value.format[key].some(name => typeof name !== 'string' || name.length > MAX_NAME)) return false;
  }
  if (value.upstream !== null) {
    if (!value.upstream || !UPSTREAM_VERDICTS.has(value.upstream.verdict)) return false;
    if (!Number.isSafeInteger(value.upstream.compared) || value.upstream.compared < 0) return false;
    if (!Number.isSafeInteger(value.upstream.missing) || value.upstream.missing < 0) return false;
    if (!Array.isArray(value.upstream.mismatches) || value.upstream.mismatches.length > MAX_LISTED) return false;
    if (value.upstream.mismatches.some(name => typeof name !== 'string' || name.length > MAX_NAME)) return false;
    if (value.upstream.repoId !== undefined && (typeof value.upstream.repoId !== 'string' || value.upstream.repoId.length > 200)) return false;
  }
  return true;
}

export class IntegrityRegistry {
  #store; #cache = new Map(); #inflight = new Map();
  #analyze; #verify; #resolve;

  constructor(store, { analyzeFileSafety = analyzeSafety, verifyAgainstUpstream = verifyUpstream, resolveItem } = {}) {
    this.#store = store;
    this.#analyze = analyzeFileSafety;
    this.#verify = verifyAgainstUpstream;
    this.#resolve = resolveItem;
    const persisted = store?.state?.aeonIntegrity;
    if (persisted && typeof persisted === 'object' && !Array.isArray(persisted)) {
      for (const [id, result] of Object.entries(persisted)) {
        if (typeof id === 'string' && id !== '__proto__' && validResult(result)) this.#cache.set(id, result);
      }
    }
  }

  get(id) { return this.#cache.get(id) ?? null; }

  /** Copy a confirmed (done) verdict to sibling ids that name the same bytes
   * (e.g. scan: → shared: / inventory id). The restart re-seed gate is
   * cache-only under the shared: key, so a revocation scan recorded under a
   * discovered-model id must also be visible there. Returns the count copied. */
  mirror(sourceId, targetIds) {
    const source = this.get(sourceId);
    if (!source || source.status !== 'done' || !Array.isArray(targetIds)) return 0;
    let copied = 0;
    for (const id of targetIds) {
      if (typeof id !== 'string' || !id || id === '__proto__' || id === sourceId) continue;
      this.#persist(id, source);
      copied++;
    }
    return copied;
  }

  /** Compact summaries for every scanned id, for the renderer state snapshot. */
  snapshot() {
    const rows = Object.create(null);
    for (const id of this.#cache.keys()) { const summary = this.summary(id); if (summary) rows[id] = summary; }
    return rows;
  }

  /** Compact UI summary — verdicts and capped file names only, never findings
   * text or absolute paths. Null when the model has never been scanned. */
  summary(id) {
    const result = this.get(id);
    if (!result) return null;
    if (result.status === 'failed') return { status: 'failed', error: result.error };
    return {
      status: 'done',
      ...(result.scannedAt ? { scannedAt: result.scannedAt } : {}),
      format: result.format.verdict,
      risky: result.format.risky,
      unknown: result.format.unknown,
      upstream: result.upstream ? {
        verdict: result.upstream.verdict,
        compared: result.upstream.compared,
        missing: result.upstream.missing,
        mismatches: result.upstream.mismatches,
        ...(result.upstream.repoId ? { repoId: result.upstream.repoId } : {}),
      } : null,
    };
  }

  /** Ensure a scan exists for `item` ({path: root, files: [{path, size}], card}).
   * Cache hits require an unchanged fingerprint; requesting `upstream` on a
   * cached scan that has no anchor re-runs with anchoring enabled. */
  async ensure(id, { item, upstream = false, signal, force = false } = {}) {
    if (typeof id !== 'string' || !id || id === '__proto__') throw new Error('A model id is required.');
    if (!force) {
      const existing = this.#inflight.get(id);
      if (existing && (!upstream || existing.upstream)) return existing.promise;
      if (existing && upstream && !existing.upstream) {
        // A gate scan (no anchor) is in flight and this caller wants the
        // upstream anchor: chain a follow-up scan after it settles instead of
        // silently returning the unanchored result.
        const promise = existing.promise.catch(() => {}).then(() => this.#scan(id, item, true, signal, false))
          .finally(() => { if (this.#inflight.get(id)?.promise === promise) this.#inflight.delete(id); });
        this.#inflight.set(id, { promise, upstream: true });
        return promise;
      }
    }
    const promise = this.#scan(id, item, upstream, signal, force).finally(() => { if (this.#inflight.get(id)?.promise === promise) this.#inflight.delete(id); });
    this.#inflight.set(id, { promise, upstream });
    return promise;
  }

  async #scan(id, item, upstream, signal, force = false) {
    // Gates call ensure(id) without an item; the resolver maps inventory,
    // discovered-model, and IPFS ids to their local files. Unresolvable ids
    // (remote devices, vanished rows) return null — never a block, never a pass.
    if (!item && this.#resolve) { try { item = await this.#resolve(id); } catch { item = null; } }
    if (!item?.path) return null;
    const files = Array.isArray(item?.files) ? item.files : [];
    // Bounded work per scan: a hostile manifest must not queue unbounded I/O.
    if (files.length > MAX_SCAN_FILES) return this.#fail(id, null, new Error(`Too many files to scan (${files.length}); review this collection manually.`));
    // An empty library has nothing to vouch for: deterministic fingerprint,
    // verdict unknown (never safe). originFingerprint rejects empty lists.
    let fingerprint;
    try { fingerprint = files.length ? await integrityFingerprint(item.path, files, { signal }) : createHash('sha256').update('frostbyte-integrity-empty').digest('hex'); }
    catch (error) { return this.#fail(id, null, error); }
    const cached = this.#cache.get(id);
    if (!force && cached?.status === 'done' && cached.fingerprint === fingerprint && (!upstream || cached.upstream)) return cached;
    try {
      const risky = [], unknown = [];
      let sawSafe = false;
      for (const file of files) {
        const relative = typeof file?.path === 'string' ? file.path : '';
        if (!relative) continue;
        const analysis = await this.#analyze(`${item.path}/${relative}`);
        // Cap names at WRITE time to the same bound validResult enforces on
        // reload: a legal >300-char relative path must not produce a verdict
        // that is persisted but discarded on the next boot (which would let
        // the restart re-seed gate miss a confirmed-risky folder).
        const listed = relative.slice(0, MAX_NAME);
        if (analysis.verdict === 'risky-format') { if (risky.length < MAX_LISTED) risky.push(listed); }
        else if (analysis.verdict === 'safe-format') sawSafe = true;
        else if (unknown.length < MAX_LISTED) unknown.push(listed);
      }
      const verdict = risky.length ? 'risky-format' : (unknown.length || !sawSafe) ? 'unknown' : 'safe-format';
      let anchor = null;
      if (upstream) {
        const card = item.card ?? await readCard(item.path);
        const result = await this.#verify(
          { path: item.path, files: files.map(f => ({ relative: f.path ?? f.relative, size: f.size })), card },
          { signal },
        );
        anchor = {
          verdict: result.verdict,
          compared: result.compared,
          missing: result.missing,
          mismatches: (result.mismatches || []).slice(0, MAX_LISTED).map(name => String(name).slice(0, MAX_NAME)),
          ...(result.repoId ? { repoId: result.repoId } : {}),
        };
      }
      const result = { status: 'done', scannedAt: Date.now(), fingerprint, format: { verdict, risky, unknown }, upstream: anchor };
      this.#persist(id, result);
      return result;
    } catch (error) { return this.#fail(id, fingerprint, error); }
  }

  #fail(id, fingerprint, error) {
    const result = { status: 'failed', scannedAt: Date.now(), fingerprint: fingerprint ?? '0'.repeat(64), error: String(error?.message || error).slice(0, MAX_ERROR) };
    this.#persist(id, result);
    return result;
  }

  #persist(id, result) {
    this.#cache.set(id, result);
    const all = Object.fromEntries(this.#cache);
    try { this.#store?._commitStateFields({ aeonIntegrity: all }); }
    catch { /* cache still valid in memory; persistence retried on next scan */ }
  }
}

/** Bounded, symlink-free listing of regular files under `root`, as
 * {path: relative, size}. Used for plain shared folders that carry no recorded
 * manifest; oversized or exotic trees fail closed (the scan reports failed). */
export async function listFolderFiles(root, { maxFiles = 5000, maxDepth = 12 } = {}) {
  const out = [];
  const walk = async (dir, prefix, depth) => {
    if (depth > maxDepth) throw new Error('This folder is too deeply nested to scan.');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('This folder contains a symbolic link; review it before sharing.');
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel, depth + 1);
      else if (entry.isFile()) {
        if (out.length >= maxFiles) throw new Error('This folder has too many files to scan.');
        out.push({ path: rel, size: (await fs.stat(full)).size });
      }
    }
  };
  await walk(root, '', 0);
  return out;
}

/** The AEON card names the upstream source for anchoring. Bounded read; a
 * missing or malformed card simply means no anchor (unknown, never safe). */
async function readCard(root) {
  try {
    const handle = await fs.open(path.join(root, CARD_FILE), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) return null;
      const buffer = Buffer.alloc(stat.size);
      await handle.read(buffer, 0, stat.size, 0);
      const card = JSON.parse(buffer.toString('utf8'));
      return card && typeof card === 'object' && !Array.isArray(card) ? card : null;
    } finally { await handle.close().catch(() => {}); }
  } catch { return null; }
}
