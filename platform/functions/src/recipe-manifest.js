/**
 * Recipe manifest v2 — schema, validator, canonical JSON, and ed25519 signing.
 * Pure module: no Electron, no FS, no network. Mirrors release-manifest.js style.
 *
 * Signing domain: `frostbyte-recipe/2\n<sha256(canonical)>\n<pubkey>\n<timestamp>`
 * Uses Node's crypto (ed25519 via SPKI/PKCS8) — same shape as src/main/publisher.js.
 */
import { createHash } from 'node:crypto';

export const RECIPE_SCHEMA = 'frostbyte.recipe';
export const RECIPE_VERSION = 2;
export const RECIPE_SIGN_DOMAIN = 'frostbyte-recipe/2';
export const RECIPE_ID_RE = /^[a-z0-9-]{1,64}$/;
export const RECIPE_KINDS = Object.freeze(['tmux', 'docker', 'compose', 'native']);
export const RECIPE_MAX_FILES = 5000;
export const RECIPE_MAX_TITLE = 120;
export const RECIPE_MAX_DESCRIPTION = 4000;

const fail = message => { throw new Error(message); };
const text = (value, max, label, optional = false) =>
  typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && (optional || value.trim())
    ? value
    : fail(`Invalid ${label}.`);
const slug = (value, label) =>
  RECIPE_ID_RE.test(value || '') ? value : fail(`Choose a lowercase ${label} using letters, numbers, or hyphens.`);
const hash = (value, length, label) =>
  new RegExp(`^[a-f0-9]{${length}}$`).test(value || '') ? value : fail(`Invalid ${label}.`);
const size = value => Number.isSafeInteger(value) && value >= 0 ? value : fail('Invalid file size.');

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function recipeSigningBytes({ digest, pubkey, timestamp }) {
  const ts = typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString();
  if (!/^[a-f0-9]{64}$/.test(digest || '')) fail('Invalid recipe digest for signing.');
  if (!/^[a-f0-9]{64}$/.test(pubkey || '')) fail('Invalid publisher pubkey for signing.');
  if (!Number.isFinite(Date.parse(ts))) fail('Invalid timestamp for signing.');
  return Buffer.from(`${RECIPE_SIGN_DOMAIN}\n${digest}\n${pubkey}\n${ts}`, 'utf8');
}

function validateEngine(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Invalid engine block.');
  const name = text(raw.name, 64, 'engine name');
  const version = text(raw.version, 64, 'engine version');
  const channel = raw.channel == null ? 'stable' : text(raw.channel, 32, 'engine channel', true) || 'stable';
  if (!['stable', 'beta', 'nightly', 'custom'].includes(channel) && !/^[a-z0-9._-]{1,32}$/.test(channel)) fail('Invalid engine channel.');
  return { name, version, channel };
}

function validateModelRef(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Invalid modelRef.');
  const repoId = /^[\w.-]+\/[\w.-]+$/.test(raw.repoId || '') ? raw.repoId : fail('Invalid model repoId.');
  const revision = raw.revision ? hash(raw.revision, 40, 'model revision') : '';
  const variant = raw.variant ? text(raw.variant, 64, 'model variant', true) : '';
  return { repoId, ...(revision ? { revision } : {}), ...(variant ? { variant } : {}) };
}

export function validateRecipe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Recipe must be an object.');
  if (raw.schema !== RECIPE_SCHEMA || raw.version !== RECIPE_VERSION) fail('Choose a FrostByte recipe manifest v2.');
  const id = slug(raw.id, 'recipe id');
  const title = text(raw.title, RECIPE_MAX_TITLE, 'recipe title');
  const kind = RECIPE_KINDS.includes(raw.kind) ? raw.kind : fail('Recipe kind must be tmux, docker, compose, or native.');
  const publisher = hash(raw.publisher, 64, 'publisher pubkey');

  // Portable file list — same rules as release-manifest (no FS access here).
  const files = Array.isArray(raw.files) ? raw.files : [];
  if (!files.length || files.length > RECIPE_MAX_FILES) fail('A recipe needs 1–5000 exact files.');
  let total = 0;
  const seen = new Set();
  const normalizedFiles = files.map(file => {
    const name = text(file.path, 1024, 'relative file path');
    if (/[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) {
      fail('Recipe paths must be portable relative file names.');
    }
    const key = name.normalize('NFD').toLowerCase();
    if (seen.has(key)) fail('Duplicate recipe paths.');
    seen.add(key);
    total += size(file.size);
    if (!Number.isSafeInteger(total)) fail('Recipe is too large.');
    return { path: name, size: file.size, sha256: hash(file.sha256, 64, 'file SHA-256') };
  });

  // Kind-specific fields
  let session = null, container = null, argv = null, image = null, imageDigest = '', composeFile = '';
  if (kind === 'tmux') {
    session = text(raw.session, 64, 'tmux session');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(session)) fail('Invalid tmux session name.');
    argv = Array.isArray(raw.argv) ? raw.argv : fail('tmux argv must be a list.');
    if (!argv.length || argv.length > 64) fail('tmux argv must have 1–64 items.');
    argv = argv.map(item => {
      if (typeof item !== 'string' || !item || item.includes('\n') || item.length > 4096) fail('Invalid tmux argv item.');
      return item;
    });
  } else if (kind === 'docker' || kind === 'compose') {
    container = text(raw.container, 64, 'container name');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(container)) fail('Invalid container name.');
    image = raw.image ? text(raw.image, 512, 'image', true) : '';
    imageDigest = raw.imageDigest ? hash(raw.imageDigest, 64, 'image digest') : '';
    if (kind === 'compose') {
      composeFile = raw.composeFile ? text(raw.composeFile, 256, 'compose file', true) : '';
    }
  } else if (kind === 'native') {
    // native: no extra required fields yet; reserved for systemd-like units
  }

  const description = raw.description ? text(raw.description, RECIPE_MAX_DESCRIPTION, 'recipe description', true) : '';
  const engine = validateEngine(raw.engine);
  const modelRef = validateModelRef(raw.modelRef);
  const healthPort = raw.healthPort == null ? null : (() => {
    const n = Number(raw.healthPort);
    if (!Number.isSafeInteger(n) || n < 1024 || n > 65535) fail('Invalid healthPort.');
    return n;
  })();
  const stopGraceSec = raw.stopGraceSec == null ? null : (() => {
    const n = Number(raw.stopGraceSec);
    if (!Number.isSafeInteger(n) || n < 1 || n > 120) fail('Invalid stopGraceSec.');
    return n;
  })();
  const license = raw.license ? { id: text(raw.license.id, 100, 'license'), statement: text(raw.license.statement || '', 2000, 'license statement', true) } : null;
  if (!license) fail('A recipe needs a license.');
  const createdAt = text(raw.createdAt || raw.verified_at || new Date().toISOString(), 40, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) fail('Invalid createdAt.');

  // Optional transport pointers (do not replace torrent.js validation)
  const torrent = raw.torrent ? {
    infohash_v1: hash(raw.torrent.infohash_v1, 40, 'torrent infohash'),
    metainfo_sha256: hash(raw.torrent.metainfo_sha256, 64, 'metainfo SHA-256'),
    piece_length: Number.isSafeInteger(raw.torrent.piece_length) && raw.torrent.piece_length >= 16384 && raw.torrent.piece_length <= 16 * 1024 * 1024 ? raw.torrent.piece_length : fail('Invalid torrent piece size.'),
  } : null;
  const cid = raw.cid ? text(raw.cid, 200, 'CID', true) : '';
  if (cid && !/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,199})$/.test(cid)) fail('Invalid CID.');

  const result = {
    schema: RECIPE_SCHEMA, version: RECIPE_VERSION, id, title, kind, publisher,
    files: normalizedFiles,
    ...(session ? { session } : {}),
    ...(argv ? { argv } : {}),
    ...(container ? { container } : {}),
    ...(image ? { image } : {}),
    ...(imageDigest ? { imageDigest } : {}),
    ...(composeFile ? { composeFile } : {}),
    ...(description ? { description } : {}),
    ...(engine ? { engine } : {}),
    ...(modelRef ? { modelRef } : {}),
    ...(healthPort != null ? { healthPort } : {}),
    ...(stopGraceSec != null ? { stopGraceSec } : {}),
    license,
    ...(torrent ? { torrent } : {}),
    ...(cid ? { cid } : {}),
    createdAt,
  };
  if (canonicalJson(result).length > 750000) fail('Recipe metadata exceeds the safe size limit.');
  return result;
}

// Verify an ed25519 signature over recipeSigningBytes. Pure — caller provides verify fn.
export function verifyRecipeSignature({ digest, pubkey, timestamp, signature, verify }) {
  if (typeof verify !== 'function') fail('A verifier function is required.');
  const bytes = recipeSigningBytes({ digest, pubkey, timestamp });
  const sigBuf = Buffer.from(String(signature || ''), 'base64');
  if (sigBuf.length !== 64) fail('Invalid signature length.');
  return verify(bytes, sigBuf, pubkey);
}
