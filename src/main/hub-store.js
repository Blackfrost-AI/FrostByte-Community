/**
 * Hub store helpers — normalize + persist Hub entitlements and bundle pointers.
 * Callers own `Store`; this module validates shapes and bounds before commit.
 */
import { ENTITLEMENT_TIERS } from '../shared/hub-protocol.js';
import { HUB_API_BASE, validateHubBaseUrl } from './hub-security.js';

const MAX_PUBKEY = 64;

export const EMPTY_HUB_ACCOUNT = Object.freeze({
  signedIn: false,
  uid: '',
  email: '',
  displayName: '',
  photoUrl: '',
  handle: '',
  bio: '',
  verifiedAt: 0,
  origin: '',
  tenantId: '',
  desktopSessionId: '',
  isAdmin: false,
});

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\0\r\n]/g, '').trim().slice(0, max);
}

export function normalizeHubAccount(raw, fallbackOrigin = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_HUB_ACCOUNT };
  const src = raw.user && typeof raw.user === 'object' && !Array.isArray(raw.user) ? raw.user : raw;
  if (src.signedIn === false) return { ...EMPTY_HUB_ACCOUNT };
  const uid = cleanText(src.uid || src.sub, 128);
  if (!uid) return { ...EMPTY_HUB_ACCOUNT };
  const email = cleanText(src.email, 254);
  const displayName = cleanText(src.displayName || src.name, 120) || (email ? email.split('@')[0].slice(0, 80) : uid);
  const rawPhoto = cleanText(src.photoUrl || src.picture, 200);
  const photoUrl = /^https:\/\//i.test(rawPhoto) ? rawPhoto : '';
  // ADR 003: reserved handle alias + bio. Shapes mirror shared/identity-rules.js;
  // anything malformed from the server is dropped, never rendered raw. Validate
  // the FULL string before any truncation so an overlong handle is rejected,
  // not silently shortened into a valid-looking alias.
  const rawHandle = typeof src.handle === 'string' ? src.handle.trim() : '';
  const handle = /^[a-zA-Z0-9_]{3,24}$/.test(rawHandle) ? rawHandle : '';
  const bio = typeof src.bio === 'string' ? src.bio.trim().slice(0, 280) : '';
  let origin = '';
  const candidateOrigin = cleanText(raw.origin || src.origin || fallbackOrigin, 2048);
  if (candidateOrigin) {
    try { origin = validateHubBaseUrl(candidateOrigin); } catch { origin = ''; }
  }
  const verifiedAt = Number.isFinite(raw.verifiedAt) ? raw.verifiedAt : (Number.isFinite(src.verifiedAt) ? src.verifiedAt : Date.now());
  // Tenant binding: the Identity Platform tenant id for production, or '' for
  // legacy/manual-token sessions that are evicted on startup.
  const rawTenant = cleanText(raw.tenantId ?? src.tenantId, 64);
  const tenantId = /^[A-Za-z0-9_-]{4,64}$/.test(rawTenant) ? rawTenant : '';
  const rawSessionId = cleanText(raw.desktopSessionId ?? src.desktopSessionId, 128);
  const desktopSessionId = /^[A-Za-z0-9_-]{8,128}$/.test(rawSessionId) ? rawSessionId : '';
  return {
    signedIn: true,
    uid,
    email,
    displayName,
    photoUrl,
    handle,
    bio,
    verifiedAt,
    origin,
    tenantId,
    desktopSessionId,
    isAdmin: Boolean(raw.isAdmin ?? src.isAdmin),
  };
}

function tier(value) {
  if (typeof value !== 'string') return 'free';
  const normalized = value.trim().toLowerCase();
  return ENTITLEMENT_TIERS.includes(normalized) ? normalized : 'free';
}

export function normalizeHubEntitlement(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid entitlement state.');
  const result = {
    tier: tier(raw.tier),
    status: typeof raw.status === 'string' ? raw.status.slice(0, 32) : 'inactive',
    source: typeof raw.source === 'string' ? raw.source.slice(0, 16) : 'local',
    fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
    currentPeriodEnd: raw.currentPeriodEnd != null ? String(raw.currentPeriodEnd).slice(0, 40) : null,
    entitlements: raw.entitlements && typeof raw.entitlements === 'object' && !Array.isArray(raw.entitlements)
      ? Object.fromEntries(Object.entries(raw.entitlements).slice(0, 32).map(([k, v]) => [String(k).slice(0, 64), v]))
      : {},
  };
  if (result.currentPeriodEnd && !Number.isFinite(Date.parse(result.currentPeriodEnd))) throw new Error('Invalid entitlement period end.');
  return result;
}

export function normalizeHubConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Hub config.');
  // Production builds pin one Hub API URL. Legacy editable hubUrl values are
  // ignored; callers always receive the pinned base.
  const out = { hubUrl: HUB_API_BASE };
  if (Object.hasOwn(raw, 'hubUrl') && raw.hubUrl != null && raw.hubUrl !== '' && raw.hubUrl !== HUB_API_BASE) {
    // Mark the legacy value changed so any token bound to it is dropped below.
    out.legacyHubUrlMismatch = true;
  }
  if (Object.hasOwn(raw, 'follows')) {
    if (!Array.isArray(raw.follows)) throw new Error('Hub follows must be a list.');
    const follows = [];
    const seen = new Set();
    for (const pubkey of raw.follows) {
      if (typeof pubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(pubkey)) throw new Error('Invalid follow pubkey.');
      const k = pubkey.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      follows.push(k);
      if (follows.length >= 256) break;
    }
    out.follows = follows;
  }
  if (Object.hasOwn(raw, 'bundleDigest')) {
    if (raw.bundleDigest != null && raw.bundleDigest !== '') {
      if (typeof raw.bundleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.bundleDigest)) throw new Error('Invalid bundle digest.');
      out.bundleDigest = raw.bundleDigest.toLowerCase();
    } else out.bundleDigest = '';
  }
  return out;
}

export function applyHubEntitlement(store, raw) {
  const normalized = normalizeHubEntitlement(raw);
  store._commitStateFields({ hubEntitlement: normalized });
  return normalized;
}

export function applyHubConfig(store, patch) {
  const normalized = normalizeHubConfig(patch);
  const current = store.state.hubConfig || {};
  const next = { ...current, ...normalized };
  if (!Array.isArray(next.follows)) next.follows = [];
  next.hubUrl = HUB_API_BASE;
  delete next.legacyHubUrlMismatch;
  if (typeof next.bundleDigest !== 'string') next.bundleDigest = '';
  // A token belongs to the origin it was saved for. Changing origins drops it and clears account state.
  const legacyMismatch = Boolean(normalized.legacyHubUrlMismatch);
  const tokenOriginMismatch = Boolean(store.state.hubTokenOrigin)
    && store.state.hubTokenOrigin !== HUB_API_BASE;
  store._commitStateFields((legacyMismatch || tokenOriginMismatch)
    ? {
      hubConfig: next,
      hubTokenEnc: undefined,
      hubTokenOrigin: undefined,
      hubTokenFingerprint: undefined,
      hubRefreshEnc: undefined,
      hubRefreshOrigin: undefined,
      hubTokenExpiresAt: undefined,
      hubTokenExpiryOrigin: undefined,
      hubAccount: { ...EMPTY_HUB_ACCOUNT },
      hubEntitlement: normalizeHubEntitlement({ tier: 'free', status: 'inactive', source: 'local', fetchedAt: 0 }),
    }
    : { hubConfig: next });
  return next;
}

export function applyHubAccount(store, raw, origin = '') {
  const normalized = normalizeHubAccount(raw, origin || store.state.hubConfig?.hubUrl || '');
  store._commitStateFields({ hubAccount: normalized });
  return normalized;
}

export function clearHubAccount(store) {
  const cleared = { ...EMPTY_HUB_ACCOUNT };
  const freeEnt = normalizeHubEntitlement({ tier: 'free', status: 'inactive', source: 'local', fetchedAt: 0 });
  store._commitStateFields({
    hubTokenEnc: undefined,
    hubTokenOrigin: undefined,
    hubTokenFingerprint: undefined,
    hubRefreshEnc: undefined,
    hubRefreshOrigin: undefined,
    hubTokenExpiresAt: undefined,
    hubTokenExpiryOrigin: undefined,
    hubAccount: cleared,
    hubEntitlement: freeEnt,
  });
  return { account: cleared, entitlement: freeEnt };
}

/**
 * Pure predicate for pre-tenant session eviction (spec §2.4). True when a
 * stamped tenant disagrees with the cached session's tenant binding. Exempt:
 * no tenant stamped / no origin and manual bfk_ token sessions (signedIn false
 * AND no stored refresh credential). Loopback Hubs are no longer supported.
 */
export function shouldEvictStaleTenantSession({ tenantId, origin, isLoopback, account, hasRefreshToken }) {
  if (!tenantId || !origin) return false;
  if (isLoopback) return true;
  const signedIn = Boolean(account?.signedIn);
  if (!signedIn && !hasRefreshToken) return false;
  return (account?.tenantId || '') !== tenantId;
}

export function getHubAccount(store) {
  const cfgUrl = typeof store.state.hubConfig?.hubUrl === 'string' ? store.state.hubConfig.hubUrl : '';
  const hasToken = Boolean(store.state.hubTokenEnc)
    && store.state.hubTokenOrigin === HUB_API_BASE
    && (!cfgUrl || cfgUrl === HUB_API_BASE);
  if (!hasToken) return { ...EMPTY_HUB_ACCOUNT };
  const normalized = normalizeHubAccount(store.state.hubAccount, HUB_API_BASE);
  if (!normalized.signedIn || (normalized.origin && normalized.origin !== HUB_API_BASE)) {
    return { ...EMPTY_HUB_ACCOUNT };
  }
  return normalized;
}

export function getHubEntitlement(store) {
  return normalizeHubEntitlement(store.state.hubEntitlement || { tier: 'free' });
}

export function getHubConfig(store) {
  const raw = store.state.hubConfig || {};
  const legacyHubUrl = typeof raw.hubUrl === 'string' ? raw.hubUrl : '';
  const hubUrl = HUB_API_BASE;
  const tokenOrigin = typeof store.state.hubTokenOrigin === 'string' ? store.state.hubTokenOrigin : '';
  return {
    hubUrl,
    follows: Array.isArray(raw.follows) ? raw.follows.filter(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) : [],
    bundleDigest: typeof raw.bundleDigest === 'string' && /^[a-f0-9]{64}$/.test(raw.bundleDigest) ? raw.bundleDigest : '',
    hasToken: Boolean(store.state.hubTokenEnc) && tokenOrigin === HUB_API_BASE && (!legacyHubUrl || legacyHubUrl === HUB_API_BASE),
    tokenOrigin,
  };
}
