/**
 * P2.3 legacy FrostNet retirement — shared library for the migration tools.
 *
 * Pure functions + small IO helpers used by:
 *   scripts/legacy-frostnet-export.mjs   (enumerate, read-only)
 *   scripts/legacy-frostnet-convert.mjs  (re-validate + independent verify)
 *   scripts/legacy-frostnet-freeze.mjs   (verify the legacy write-freeze)
 *
 * Trust model (plans/2026-11-17-legacy-frostnet-retirement.md):
 *   - The ORIGINAL publisher key + signature are preserved end-to-end.
 *     Conversion NEVER re-signs or re-keys.
 *   - Every digest is recomputed from the manifest; stored claims are checked,
 *     never trusted.
 *   - Signatures are verified with an INDEPENDENT node:crypto Ed25519 verifier
 *     (not the hub's own crypto module) over recipeSigningBytes.
 *   - Every stage writes a local receipt: inputs hash, counts, refusals, timing.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateRecipe, canonicalDigest, canonicalJson, recipeSigningBytes,
} from '../../platform/functions/src/recipe-manifest.js';

// SPKI prefix for a raw 32-byte Ed25519 public key (same construction the
// platform verifier uses — kept local so this tool has no runtime coupling
// to the functions package beyond the pure manifest module).
const SPKI_ED25519_PREFIX = '302a300506032b6570032100';

export const DEFAULT_SOURCE = 'frostnet-si';

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Independent Ed25519 verification — node:crypto only, no hub code. */
export function verifyEd25519Independent(bytes, signatureB64, pubKeyHex) {
  try {
    if (!/^[a-f0-9]{64}$/.test(String(pubKeyHex || ''))) return false;
    const sigBuf = Buffer.from(String(signatureB64 || ''), 'base64');
    if (sigBuf.length !== 64) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from(SPKI_ED25519_PREFIX, 'hex'), Buffer.from(pubKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, bytes, publicKey, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Convert ONE legacy record {id, manifest, digest, signature, legacySeq} into
 * an import-ready record. Returns {ok:true, record} or {ok:false, id, code,
 * message}. Never throws for bad data — refusals are typed negative evidence.
 */
export function convertRecord(raw) {
  const id = String(raw?.id || raw?.manifest?.id || '');
  try {
    let manifest;
    try { manifest = validateRecipe(raw?.manifest); }
    catch (error) { return { ok: false, id, code: 'manifest_invalid', message: error.message }; }

    const rawCreatedAt = raw?.manifest?.createdAt;
    if (typeof rawCreatedAt !== 'string' || !rawCreatedAt.trim() || !Number.isFinite(Date.parse(rawCreatedAt))) {
      return { ok: false, id, code: 'created_at_required', message: 'manifest.createdAt is required and must be parseable.' };
    }
    if (manifest.createdAt !== rawCreatedAt) {
      return { ok: false, id, code: 'created_at_mismatch', message: 'createdAt was normalized — the stored signature would not verify.' };
    }

    const digest = canonicalDigest(manifest);
    if (raw?.digest !== undefined && raw.digest !== digest) {
      return { ok: false, id, code: 'digest_mismatch', message: `stored digest ${raw.digest} != recomputed ${digest}` };
    }

    const signature = typeof raw?.signature === 'string' ? raw.signature : '';
    if (!signature) return { ok: false, id, code: 'signature_required', message: 'No signature on the legacy record.' };
    const bytes = recipeSigningBytes({ digest, pubkey: manifest.publisher, timestamp: manifest.createdAt });
    if (!verifyEd25519Independent(bytes, signature, manifest.publisher)) {
      return { ok: false, id, code: 'signature_invalid', message: 'Independent Ed25519 verification failed.' };
    }

    // Canonical form is what gets imported; the ORIGINAL signature verifies
    // over it because the digest is recomputed identically server-side.
    return {
      ok: true,
      record: {
        id: manifest.id,
        manifest: JSON.parse(canonicalJson(manifest)),
        digest,
        signature,
        legacySeq: Number.isSafeInteger(raw?.legacySeq) ? raw.legacySeq : null,
      },
    };
  } catch (error) {
    return { ok: false, id, code: 'convert_error', message: error.message };
  }
}

/** Convert a whole export bundle → {converted, refused, tombstones}. */
export function convertBundle(bundle) {
  const converted = [];
  const refused = [];
  const seen = new Set();
  for (const raw of bundle?.recipes || []) {
    const result = convertRecord(raw);
    if (!result.ok) { refused.push({ id: result.id, code: result.code, message: result.message }); continue; }
    if (seen.has(result.record.digest)) continue; // dedupe by content, keep first
    seen.add(result.record.digest);
    converted.push(result.record);
  }
  // Withdrawn legacy ids are tombstones: carried for the operator's records,
  // NEVER imported (the new plane refuses withdrawn-id republication anyway).
  const tombstones = [...new Set((bundle?.withdrawn || []).map(String).filter(Boolean))];
  return { converted, refused, tombstones };
}

/** Chunk records into import batches (route cap: 200 records / 8 MiB body). */
export function chunkRecords(records, { maxRecords = 200, maxBytes = 6 * 1024 * 1024 } = {}) {
  const batches = [];
  let current = [];
  let currentBytes = 2; // JSON array brackets
  const flush = () => { if (current.length) { batches.push(current); current = []; currentBytes = 2; } };
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
    if (current.length >= maxRecords || (current.length && currentBytes + size > maxBytes)) flush();
    current.push(record);
    currentBytes += size;
  }
  flush();
  return batches;
}

/** Write a JSON artifact + a sibling receipt (hash of the exact bytes). */
export function writeArtifactWithReceipt(filePath, payload, { stage, extra = {} } = {}) {
  const text = JSON.stringify(payload, null, 2) + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
  const receipt = {
    stage,
    artifact: path.basename(filePath),
    sha256: sha256Hex(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    writtenAt: new Date().toISOString(),
    ...extra,
  };
  const receiptPath = filePath.replace(/\.json$/, '') + '.receipt.json';
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

/** GET JSON with a bounded timeout; throws with status on non-2xx. */
export async function getJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const error = new Error(`GET ${url} → ${res.status}: ${body?.error?.message || text.slice(0, 200)}`);
      error.status = res.status;
      error.body = body;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}