/**
 * Shared identity validation (ADR 003) — handles, bios, publisher pubkeys.
 *
 * Single source of truth for the account plane's human-readable fields. The
 * backend imports this module directly; the desktop/site mirror the same rules
 * client-side for instant feedback, but the server is always the authority.
 */

/** Reserved handle aliases: platform surfaces, auth paths, and impersonation bait. */
export const RESERVED_HANDLES = Object.freeze(new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'official',
  'frostbyte', 'frostnet', 'frostbyt3', 'blackfrost', 'staff', 'team', 'mod',
  'moderator', 'security', 'billing', 'api', 'www', 'mail', 'email', 'login',
  'logout', 'signin', 'signup', 'register', 'auth', 'account', 'accounts',
  'settings', 'profile', 'me', 'user', 'users', 'creator', 'creators',
  'search', 'discover', 'models', 'hub', 'null', 'undefined', 'anonymous',
  'everyone', 'all', 'home', 'about', 'terms', 'privacy', 'legal', 'status',
  'docs', 'blog', 'news', 'updates', 'announcements', 'feed', 'follows',
]));

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 24;
export const BIO_MAX = 280;
export const DISPLAY_NAME_MAX = 64;

/**
 * Normalize + validate a handle. Returns {ok:true, handle, handleLower} or
 * {ok:false, code, message}. Case is preserved for display; uniqueness is
 * always checked on handleLower.
 */
export function validateHandle(raw) {
  if (typeof raw !== 'string') return { ok: false, code: 'handle_invalid', message: 'Handle must be a string.' };
  const handle = raw.trim();
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    return { ok: false, code: 'handle_invalid', message: `Handle must be ${HANDLE_MIN}–${HANDLE_MAX} characters.` };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(handle)) {
    return { ok: false, code: 'handle_invalid', message: 'Handle may only contain letters, numbers, and underscores.' };
  }
  if (/^[_]|[_]$/.test(handle)) {
    return { ok: false, code: 'handle_invalid', message: 'Handle may not start or end with an underscore.' };
  }
  const handleLower = handle.toLowerCase();
  if (RESERVED_HANDLES.has(handleLower)) {
    return { ok: false, code: 'handle_reserved', message: 'That handle is reserved.' };
  }
  return { ok: true, handle, handleLower };
}

/** Validate an optional bio. Empty string clears it. */
export function validateBio(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, bio: '' };
  if (typeof raw !== 'string') return { ok: false, code: 'bio_invalid', message: 'Bio must be a string.' };
  const bio = raw.trim();
  if (bio.length > BIO_MAX) {
    return { ok: false, code: 'bio_invalid', message: `Bio must be at most ${BIO_MAX} characters.` };
  }
  // Control characters (except newline/tab) are never legitimate in a bio.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(bio)) {
    return { ok: false, code: 'bio_invalid', message: 'Bio contains invalid control characters.' };
  }
  return { ok: true, bio };
}

/** Validate a publisher pubkey: exactly 64 lowercase hex chars (Ed25519 raw). */
export function validatePubKey(raw) {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) {
    return { ok: false, code: 'pubkey_invalid', message: 'Publisher key must be 64 lowercase hex characters.' };
  }
  return { ok: true, pubKey: raw };
}

/** Validate a display name: optional, ≤64 chars, no control characters. */
export function validateDisplayName(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, displayName: '' };
  if (typeof raw !== 'string') return { ok: false, code: 'display_name_invalid', message: 'Display name must be a string.' };
  const displayName = raw.trim();
  if (displayName.length > DISPLAY_NAME_MAX) {
    return { ok: false, code: 'display_name_invalid', message: `Display name must be at most ${DISPLAY_NAME_MAX} characters.` };
  }
  if (/[\u0000-\u001F\u007F]/.test(displayName)) {
    return { ok: false, code: 'display_name_invalid', message: 'Display name contains invalid control characters.' };
  }
  return { ok: true, displayName };
}

/** Validate an optional profile photo URL: empty clears; otherwise HTTPS ≤200 chars. */
export function validatePhotoUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, photoUrl: '' };
  if (typeof raw !== 'string' || raw.length > 200) {
    return { ok: false, code: 'photo_url_invalid', message: 'Photo URL must be a string under 200 characters.' };
  }
  let url;
  try { url = new URL(raw); } catch {
    return { ok: false, code: 'photo_url_invalid', message: 'Photo URL must be a valid HTTPS URL.' };
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return { ok: false, code: 'photo_url_invalid', message: 'Photo URL must be a valid HTTPS URL.' };
  }
  return { ok: true, photoUrl: raw };
}

/**
 * Public creator projection (ADR 003 §Consequences). Only these fields ever
 * leave the account plane on public surfaces — never uid, email, tenant,
 * billing, or roles.
 */
export function publicCreatorProjection({ pubKey, user, binding, stats = {} }) {
  return {
    pubkey: pubKey,
    handle: user?.handle || '',
    displayName: user?.displayName || '',
    bio: user?.bio || '',
    photoUrl: user?.photoUrl || '',
    verified: Boolean(user && binding && !binding.unboundAt),
    boundAt: binding?.boundAt || null,
    stats: {
      recipes: Number(stats.recipes) || 0,
      models: Number(stats.models) || 0,
      followers: Number(stats.followers) || 0,
    },
  };
}
