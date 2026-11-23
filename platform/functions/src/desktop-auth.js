/**
 * Desktop browser-handoff authentication (RFC 8252 + RFC 7636 PKCE S256).
 *
 * The Electron desktop app never accepts or transmits a user password. Instead:
 *   1. Desktop generates `state` + PKCE `codeVerifier` / `codeChallenge` (S256)
 *      in main-process memory and opens `https://frostbyte.si/signin?next=/desktop-auth?...`.
 *   2. After the user authenticates in their system browser (email/password,
 *      account creation, password reset, or Google), the website calls
 *      `POST /v1/auth/desktop/authorize` with its live Firebase ID token.
 *      Only `SHA-256(code)` is persisted in Firestore (`desktopAuthCodes`),
 *      bound to `uid`, `tenantId`, `state`, and `codeChallenge` with a 180s TTL.
 *   3. The browser opens `frostbyte://auth?code=...&state=...`.
 *   4. Desktop calls `POST /v1/auth/desktop/exchange` with `{ code, state, codeVerifier }`.
 *      `consumeDesktopAuthCode` atomically burns the code on first lookup,
 *      verifies `state` and `BASE64URL(SHA256(codeVerifier)) === codeChallenge`
 *      in constant time, records a revocable `desktopSessions/{sessionId}`,
 *      and mints a tenant-bound Firebase custom token carrying
 *      `{ frostbyteDesktopSession: sessionId }`.
 *   5. Desktop exchanges that custom token via Identity Toolkit for a tenant-scoped
 *      ID token + refresh token stored in OS `safeStorage`. Signing out on desktop
 *      calls `POST /v1/auth/desktop/revoke`, revoking only that desktop device.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireIdentity } from './auth.js';
import { consume } from './rate-limit.js';
import { badRequest, forbidden, readJsonBody, unauthorized, unavailable } from './http.js';

export const DESKTOP_AUTH_CODE_TTL_MS = 180_000;

const STATE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pkceChallengeS256(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function clientIpKey(req) {
  const appEngineIp = typeof req?.headers?.['x-appengine-user-ip'] === 'string'
    ? req.headers['x-appengine-user-ip'].trim()
    : '';
  // On Cloud Functions v2 / Cloud Run direct endpoints, client-supplied
  // X-Forwarded-For entries appear on the left and Google's router appends the
  // immediate client IP as the rightmost hop. Read the rightmost non-empty hop
  // when x-appengine-user-ip is absent so a spoofed leading XFF entry cannot
  // evade the per-IP rate limit.
  const xffParts = typeof req?.headers?.['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const xffClient = xffParts[xffParts.length - 1] || '';
  const rawIp = appEngineIp || xffClient || req?.socket?.remoteAddress || 'unknown';
  return `ip:${sha256Hex(rawIp).slice(0, 24)}`;
}

export function createDesktopAuthRoutes({
  store,
  mintDesktopCustomToken,
  expectedTenantId = '',
  now = () => Date.now(),
}) {
  const mintToken = typeof mintDesktopCustomToken === 'function'
    ? mintDesktopCustomToken
    : async () => { throw unavailable('Desktop custom-token minting is not configured.'); };

  return {
    async authorize({ req, identity, readBody }) {
      const caller = requireIdentity(identity);
      if (caller.authType !== 'firebase') {
        throw forbidden('Desktop browser handoff requires an interactive web session.');
      }
      if (expectedTenantId && caller.tenantId !== expectedTenantId) {
        throw unauthorized('That credential does not belong to this Hub.');
      }
      await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });

      const body = (typeof readBody === 'function' ? await readBody() : await readJsonBody(req, 8 * 1024)) || {};
      const state = typeof body.state === 'string' ? body.state.trim() : '';
      const codeChallenge = typeof body.codeChallenge === 'string' ? body.codeChallenge.trim() : '';
      const codeChallengeMethod = typeof body.codeChallengeMethod === 'string' ? body.codeChallengeMethod.trim() : '';

      if (!STATE_RE.test(state)) {
        throw badRequest('state must be 32-128 URL-safe characters.');
      }
      if (!CHALLENGE_RE.test(codeChallenge)) {
        throw badRequest('codeChallenge must be a valid PKCE S256 challenge.');
      }
      if (codeChallengeMethod !== 'S256') {
        throw badRequest('codeChallengeMethod must be S256.');
      }

      const code = randomBytes(32).toString('base64url');
      const codeHash = sha256Hex(code);
      const nowMs = now();
      const createdAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + DESKTOP_AUTH_CODE_TTL_MS).toISOString();
      const tenantId = caller.tenantId || expectedTenantId || '';

      await store.createDesktopAuthCode({
        codeHash,
        uid: caller.uid,
        tenantId,
        codeChallenge,
        state,
        createdAt,
        expiresAt,
      });

      const redirectUri = `frostbyte://auth?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      return {
        code,
        state,
        redirectUri,
        expiresIn: Math.floor(DESKTOP_AUTH_CODE_TTL_MS / 1000),
      };
    },

    async exchange({ req, readBody }) {
      await consume({
        store,
        uid: clientIpKey(req),
        tier: 'free',
        bucket: 'desktopExchange',
        now,
      });

      const body = (typeof readBody === 'function' ? await readBody() : await readJsonBody(req, 8 * 1024)) || {};
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const state = typeof body.state === 'string' ? body.state.trim() : '';
      const codeVerifier = typeof body.codeVerifier === 'string' ? body.codeVerifier.trim() : '';

      if (!CODE_RE.test(code) || !STATE_RE.test(state) || !VERIFIER_RE.test(codeVerifier)) {
        throw badRequest('Invalid desktop authorization exchange payload.');
      }

      const nowMs = now();
      const codeHash = sha256Hex(code);
      const record = await store.consumeDesktopAuthCode(codeHash, { nowMs });
      if (!record) {
        throw unauthorized('That sign-in handoff expired or has already been used. Sign in again.');
      }

      const computedChallenge = pkceChallengeS256(codeVerifier);
      const stateMatches = safeEqualStrings(record.state, state);
      const pkceMatches = safeEqualStrings(record.codeChallenge, computedChallenge);
      if (!stateMatches || !pkceMatches) {
        throw unauthorized('Desktop PKCE verification failed. Sign in again.');
      }

      const tenantId = record.tenantId || expectedTenantId || '';
      if (expectedTenantId && tenantId !== expectedTenantId) {
        throw unauthorized('That credential does not belong to this Hub.');
      }

      const sessionId = randomBytes(24).toString('base64url');
      const userAgent = typeof req?.headers?.['user-agent'] === 'string'
        ? req.headers['user-agent'].slice(0, 200)
        : '';

      await store.createDesktopSession({
        sessionId,
        uid: record.uid,
        tenantId,
        userAgent,
        createdAt: new Date(nowMs).toISOString(),
      });

      const customToken = await mintToken({
        uid: record.uid,
        tenantId,
        sessionId,
      });

      await store.appendAudit({
        actorUid: record.uid,
        action: 'desktop_session.created',
        targetId: sessionId,
        metadata: { tenantId },
      });

      return {
        customToken,
        tenantId,
        sessionId,
      };
    },

    async revoke({ req, identity, readBody }) {
      const caller = requireIdentity(identity);
      if (caller.authType !== 'firebase') {
        throw forbidden('Desktop session revocation requires a Firebase user session.');
      }
      if (expectedTenantId && caller.tenantId !== expectedTenantId) {
        throw unauthorized('That credential does not belong to this Hub.');
      }
      await consume({ store, uid: caller.uid, tier: caller.tier, bucket: 'writes', now });

      const body = (typeof readBody === 'function' ? await readBody() : await readJsonBody(req, 8 * 1024)) || {};
      const rawSessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : (caller.desktopSessionId || '');

      if (!SESSION_ID_RE.test(rawSessionId)) {
        throw badRequest('A valid desktop sessionId is required.');
      }

      const result = await store.revokeDesktopSession(rawSessionId, {
        uid: caller.uid,
        nowMs: now(),
      });

      if (result.revoked) {
        await store.appendAudit({
          actorUid: caller.uid,
          action: 'desktop_session.revoked',
          targetId: rawSessionId,
          metadata: {},
        });
      }

      return {
        revoked: Boolean(result.revoked),
        sessionId: rawSessionId,
      };
    },
  };
}
