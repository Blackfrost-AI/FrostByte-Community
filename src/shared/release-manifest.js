export const RELEASE_SCHEMA = 'frostbyte.release';
export const FROSTNET_TERMS = '2026-10-10-v1';
const fail = message => { throw new Error(message); };
const text = (value, max, label, optional = false) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && (optional || value.trim()) ? value : fail(`Invalid ${label}.`);
const slug = (value, label) => /^[a-z0-9][a-z0-9._-]{0,95}$/.test(value || '') ? value : fail(`Choose a lowercase ${label} using letters, numbers, dots or hyphens.`);
const hash = (value, length, label) => new RegExp(`^[a-f0-9]{${length}}$`).test(value || '') ? value : fail(`Invalid ${label}.`);
const size = value => Number.isSafeInteger(value) && value >= 0 ? value : fail('Invalid file size.');
function publicUrl(value) {
  if (!value) return '';
  const url = new URL(text(value, 2048, 'evidence URL'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('Evidence URLs must be public HTTPS URLs without credentials or query parameters.');
  return url.href;
}
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function validateRelease(raw) {
  if (raw?.schema !== RELEASE_SCHEMA || raw.version !== 1) fail('Choose a FrostByte release manifest v1.');
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > 5000) fail('A release needs 1–5000 exact files.');
  let total = 0; const seen = new Set();
  const files = raw.files.map(file => {
    const name = text(file.path, 1024, 'relative file path');
    if (/[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) fail('Release paths must be portable relative file names.');
    const key = name.normalize('NFD').toLowerCase(); if (seen.has(key)) fail('Duplicate release paths.'); seen.add(key);
    total += size(file.size); if (!Number.isSafeInteger(total)) fail('Release is too large.');
    return { path: name, size: file.size, sha256: hash(file.sha256, 64, 'file SHA-256') };
  });
  for (const name of seen) { const parts = name.split('/'); parts.pop(); while (parts.length) { if (seen.has(parts.join('/'))) fail('File and directory paths overlap.'); parts.pop(); } }
  const upstream = raw.upstream === null || raw.upstream === undefined ? null : {
    repo: /^[\w.-]+\/[\w.-]+$/.test(raw.upstream.repo || '') ? raw.upstream.repo : fail('Invalid upstream repository.'),
    revision: hash(raw.upstream.revision, 40, 'pinned upstream revision'),
  };
  if (!['original', 'derived'].includes(raw.origin) || raw.origin === 'derived' && !upstream) fail('Derived releases need a pinned upstream source.');
  const torrent = raw.torrent ? { infohash_v1: hash(raw.torrent.infohash_v1, 40, 'torrent infohash'),
    metainfo_sha256: hash(raw.torrent.metainfo_sha256, 64, 'metainfo SHA-256'),
    piece_length: Number.isSafeInteger(raw.torrent.piece_length) && raw.torrent.piece_length >= 16384 && raw.torrent.piece_length <= 16 * 1024 * 1024 ? raw.torrent.piece_length : fail('Invalid torrent piece size.') } : null;
  const cid = raw.cid ? text(raw.cid, 200, 'CID') : '';
  if (cid && !/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,199})$/.test(cid)) fail('Invalid CID.');
  if (!torrent && !cid) fail('A release needs a verified torrent identity or CID.');
  if (raw.redistribution_confirmed !== true) fail('Confirm that redistribution is permitted before publishing.');
  const date = text(raw.verified_at, 40, 'verification time'); if (!Number.isFinite(Date.parse(date))) fail('Invalid verification time.');
  const result = { schema: RELEASE_SCHEMA, version: 1, publisher: slug(raw.publisher, 'publisher namespace'), release: slug(raw.release, 'release ID'), variant: slug(raw.variant, 'variant ID'),
    name: text(raw.name, 200, 'release name'), description: text(raw.description || '', 4000, 'description', true), origin: raw.origin,
    files, upstream, license: { id: text(raw.license?.id, 100, 'license'), evidence_url: publicUrl(raw.license?.evidence_url), statement: text(raw.license?.statement, 2000, 'license evidence statement') },
    torrent, cid, verified_at: date, verification: torrent ? 'local-sha256-and-torrent-pieces' : 'local-sha256', redistribution_confirmed: true };
  if (canonicalJson(result).length > 750000) fail('Release metadata exceeds the safe size limit.');
  return result;
}
