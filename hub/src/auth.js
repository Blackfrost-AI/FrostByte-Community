/**
 * Hub bearer authentication, session login, revocation, and tier resolution.
 *
 * Supports:
 * - Configured static bearer tokens (`HUB_TOKENS` JSON or `{ tokens }` map)
 * - Ephemeral random `devToken` when no static tokens are supplied (never accepts `Bearer x`)
 * - Signed expiring HS256 session JWTs minted by `POST /v1/auth/login`
 * - Bounded token revocation via `POST /v1/auth/logout`
 */

import crypto from 'node:crypto';
import { ENTITLEMENT_TIERS, PAID_TIERS } from '../../src/shared/hub-protocol.js';

const VALID_TIERS = new Set(ENTITLEMENT_TIERS);
const MAX_REVOKED = 4096;
const DEFAULT_SESSION_TTL_SEC = 24 * 60 * 60;

function sha256Buf(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return crypto.timingSafeEqual(sha256Buf(a), sha256Buf(b));
}

function tokenDigestHex(token) {
  return sha256Buf(token).toString('hex');
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function parseTokensEnv(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out = {};
    for (const [token, info] of Object.entries(parsed)) {
      if (typeof token !== 'string' || token.length < 4 || token.length > 4096) continue;
      if (typeof info === 'string') {
        const tier = VALID_TIERS.has(info) ? info : 'free';
        out[token] = { uid: `tok_${tokenDigestHex(token).slice(0, 12)}`, tier };
      } else if (info && typeof info === 'object') {
        const tier = VALID_TIERS.has(info.tier) ? info.tier : 'free';
        const uid = typeof info.uid === 'string' && info.uid.trim() ? info.uid.trim().slice(0, 128) : `tok_${tokenDigestHex(token).slice(0, 12)}`;
        out[token] = {
          uid,
          tier,
          email: typeof info.email === 'string' ? info.email.slice(0, 254) : '',
          displayName: typeof info.displayName === 'string' ? info.displayName.slice(0, 120) : uid,
          photoUrl: typeof info.photoUrl === 'string' && /^https:\/\//i.test(info.photoUrl) ? info.photoUrl.slice(0, 200) : null,
          createdAt: typeof info.createdAt === 'string' ? info.createdAt : '2026-01-01T00:00:00.000Z',
        };
      }
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export function entitlementForTier(rawTier, nowMs = Date.now()) {
  const tier = VALID_TIERS.has(rawTier) ? rawTier : 'free';
  const paid = PAID_TIERS.includes(tier);
  return {
    tier,
    status: paid ? 'active' : 'free',
    currentPeriodEnd: paid ? new Date(nowMs + 30 * 86400000).toISOString() : null,
    entitlements: { liveUpdates: paid, bundleSync: paid, publishing: true },
    source: 'server',
  };
}

export function signHs256Jwt(claims, secret) {
  if (!secret) throw new Error('Session signing secret is required.');
  const h64 = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const p64 = b64urlJson(claims);
  const sig = crypto.createHmac('sha256', secret).update(`${h64}.${p64}`).digest('base64url');
  return `${h64}.${p64}.${sig}`;
}

export function verifyHs256Jwt(token, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !p || p.length > 4096)) return null;
  const [h64, p64, s64] = parts;
  let header, payload, sig;
  try {
    header = JSON.parse(Buffer.from(h64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
    sig = Buffer.from(s64, 'base64url');
  } catch { return null; }
  if (!header || header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', secret).update(`${h64}.${p64}`).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec) return null;
  const tier = VALID_TIERS.has(payload.tier) ? payload.tier : 'free';
  return {
    uid: payload.sub,
    tier,
    email: typeof payload.email === 'string' && payload.email.length <= 254 ? payload.email : '',
    displayName: typeof payload.name === 'string' && payload.name.length <= 120 ? payload.name : payload.sub,
    photoUrl: typeof payload.picture === 'string' && /^https:\/\//i.test(payload.picture) && payload.picture.length <= 200
      ? payload.picture : null,
    createdAt: typeof payload.createdAt === 'string' && payload.createdAt.length <= 64 ? payload.createdAt : '2026-01-01T00:00:00.000Z',
    jti: typeof payload.jti === 'string' ? payload.jti : '',
  };
}

export function extractBearerToken(authHeader) {
  if (typeof authHeader !== 'string') return '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
  if (!m) return '';
  const token = m[1];
  if (!token || token.length < 4 || token.length > 8192) return '';
  return token;
}

function buildDirectory(accounts, { allowDefaultDev = false, devPassword = 'frostbyte-dev', devTier = 'pro' } = {}) {
  const entries = [];
  const pushAccount = raw => {
    if (!raw || typeof raw !== 'object') return;
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    const uid = typeof raw.uid === 'string' && raw.uid.trim() ? raw.uid.trim() : '';
    if (!email || !password || !uid) return;
    const tier = VALID_TIERS.has(raw.tier) ? raw.tier : 'free';
    entries.push({
      uid: uid.slice(0, 128),
      email: email.slice(0, 254),
      password,
      displayName: typeof raw.displayName === 'string' && raw.displayName.trim()
        ? raw.displayName.trim().slice(0, 120)
        : email.split('@')[0].slice(0, 80),
      tier,
      photoUrl: typeof raw.photoUrl === 'string' && /^https:\/\//i.test(raw.photoUrl) ? raw.photoUrl.slice(0, 200) : null,
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : '2026-01-01T00:00:00.000Z',
    });
  };
  if (Array.isArray(accounts)) accounts.forEach(pushAccount);
  if (allowDefaultDev && entries.length === 0 && typeof devPassword === 'string' && devPassword.length >= 6) {
    const primaryTier = VALID_TIERS.has(devTier) ? devTier : 'pro';
    pushAccount({ uid: 'dev', email: 'dev@blackfrostai.com', password: devPassword, displayName: 'Blackfrost Dev', tier: primaryTier });
    pushAccount({ uid: 'plus_user', email: 'plus@blackfrostai.com', password: devPassword, displayName: 'FrostByte Plus', tier: 'plus' });
    pushAccount({ uid: 'free_user', email: 'free@blackfrostai.com', password: devPassword, displayName: 'Community Member', tier: 'free' });
  }
  return entries;
}

export function createAuth(options = {}) {
  const explicitTokens = options.tokens && typeof options.tokens === 'object' ? options.tokens : null;
  const devTier = VALID_TIERS.has(options.devTier) ? options.devTier : 'pro';
  const devToken = explicitTokens ? null : `fbdev_${crypto.randomBytes(24).toString('hex')}`;
  const staticTokens = new Map();

  if (explicitTokens) {
    for (const [tok, info] of Object.entries(explicitTokens)) {
      if (typeof tok !== 'string' || tok.length < 4) continue;
      const tier = VALID_TIERS.has(info?.tier) ? info.tier : 'free';
      const uid = typeof info?.uid === 'string' && info.uid ? info.uid : 'user';
      staticTokens.set(tok, {
        uid,
        tier,
        email: typeof info?.email === 'string' && info.email ? info.email : `${uid}@hub.frostbyte`,
        displayName: typeof info?.displayName === 'string' && info.displayName ? info.displayName : uid,
        photoUrl: typeof info?.photoUrl === 'string' && /^https:\/\//i.test(info.photoUrl) ? info.photoUrl : null,
        createdAt: typeof info?.createdAt === 'string' && info.createdAt ? info.createdAt : '2026-01-01T00:00:00.000Z',
      });
    }
  } else if (devToken) {
    staticTokens.set(devToken, {
      uid: 'dev',
      tier: devTier,
      email: 'dev@local.frostbyte',
      displayName: 'Blackfrost Dev',
      photoUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }

  const allowDefaultDev = options.devMode != null ? Boolean(options.devMode) : !explicitTokens;
  const signingSecret = (typeof options.secret === 'string' && options.secret)
    || (allowDefaultDev || Array.isArray(options.accounts) ? crypto.randomBytes(32).toString('hex') : '');
  const directory = buildDirectory(options.accounts, {
    allowDefaultDev,
    devPassword: options.devPassword,
    devTier,
  });

  const revoked = new Map();

  function pruneRevoked(nowSec = Math.floor(Date.now() / 1000)) {
    for (const [digest, exp] of revoked) {
      if (exp <= nowSec) revoked.delete(digest);
    }
    while (revoked.size >= MAX_REVOKED) {
      const oldest = revoked.keys().next().value;
      if (!oldest) break;
      revoked.delete(oldest);
    }
  }

  function isRevoked(token, nowSec = Math.floor(Date.now() / 1000)) {
    const digest = tokenDigestHex(token);
    const exp = revoked.get(digest);
    if (!exp) return false;
    if (exp <= nowSec) {
      revoked.delete(digest);
      return false;
    }
    return true;
  }

  function resolve(authHeader, nowSec = Math.floor(Date.now() / 1000)) {
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    if (isRevoked(token, nowSec)) return null;

    for (const [knownToken, info] of staticTokens.entries()) {
      if (timingSafeStringEqual(knownToken, token)) {
        return { ...info };
      }
    }
    if (signingSecret) {
      return verifyHs256Jwt(token, signingSecret, nowSec);
    }
    return null;
  }

  function login({ email, password } = {}, nowSec = Math.floor(Date.now() / 1000)) {
    if (!signingSecret || directory.length === 0) {
      const err = new Error('Password sign-in is not configured on this Hub. Sign in with a personal access token instead.');
      err.status = 503;
      err.code = 'auth_not_configured';
      throw err;
    }
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const candidatePassword = typeof password === 'string' ? password : '';
    if (!normalizedEmail || normalizedEmail.length > 254 || !normalizedEmail.includes('@') || !candidatePassword || candidatePassword.length > 256) {
      const err = new Error('Enter a valid email address and password.');
      err.status = 400;
      err.code = 'bad_credentials';
      throw err;
    }
    let matched = null;
    for (const entry of directory) {
      const emailMatch = timingSafeStringEqual(entry.email, normalizedEmail);
      const passMatch = timingSafeStringEqual(entry.password, candidatePassword);
      if (emailMatch && passMatch) matched = entry;
    }
    if (!matched) {
      const err = new Error('Invalid email or password.');
      err.status = 401;
      err.code = 'invalid_credentials';
      throw err;
    }
    const ttl = Number.isInteger(options.sessionTtlSeconds) && options.sessionTtlSeconds > 0
      ? options.sessionTtlSeconds : DEFAULT_SESSION_TTL_SEC;
    const exp = nowSec + ttl;
    const jti = crypto.randomUUID();
    const token = signHs256Jwt({
      sub: matched.uid,
      tier: matched.tier,
      email: matched.email,
      name: matched.displayName,
      ...(matched.photoUrl ? { picture: matched.photoUrl } : {}),
      createdAt: matched.createdAt,
      jti,
      iat: nowSec,
      exp,
    }, signingSecret);
    const identity = {
      uid: matched.uid,
      tier: matched.tier,
      email: matched.email,
      displayName: matched.displayName,
      photoUrl: matched.photoUrl,
      createdAt: matched.createdAt,
      jti,
    };
    const entitlement = entitlementForTier(identity.tier, nowSec * 1000);
    return {
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
      user: {
        uid: identity.uid,
        email: identity.email,
        displayName: identity.displayName,
        photoUrl: identity.photoUrl,
        locale: 'en-US',
        timezone: 'UTC',
        preferences: {},
        createdAt: identity.createdAt,
      },
      entitlement,
    };
  }

  function revoke(authHeader, nowSec = Math.floor(Date.now() / 1000)) {
    const token = extractBearerToken(authHeader);
    if (!token) return false;
    pruneRevoked(nowSec);
    revoked.set(tokenDigestHex(token), nowSec + DEFAULT_SESSION_TTL_SEC * 7);
    return true;
  }

  function mePayload(identity, nowMs = Date.now()) {
    const entitlement = entitlementForTier(identity.tier, nowMs);
    // Flat shape matching platform/functions/src/app.js GET /v1/me.
    return {
      uid: identity.uid,
      email: identity.email || '',
      displayName: identity.displayName || identity.uid,
      photoUrl: identity.photoUrl || null,
      locale: 'en-US',
      timezone: 'UTC',
      preferences: {},
      createdAt: identity.createdAt || null,
      entitlement,
      orgs: [],
    };
  }

  return {
    devToken,
    resolve,
    login,
    revoke,
    mePayload,
    isPaid: identity => Boolean(identity && PAID_TIERS.includes(identity.tier)),
  };
}
