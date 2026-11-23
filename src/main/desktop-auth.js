/**
 * Desktop browser-auth helpers — pure, no Electron imports.
 *
 * FrostByte desktop never accepts a password. It authenticates through the
 * production website in the system browser and receives only a short-lived
 * one-time code plus PKCE state through a strict custom URL.
 */

import { createHash, randomBytes } from 'node:crypto';

export const SITE_ORIGIN = 'https://frostbyte.si';
export const HUB_API_BASE = 'https://us-central1-blackfrost-ai-prod.cloudfunctions.net/hubApi';
export const DESKTOP_AUTH_PATH = '/desktop-auth';
export const DESKTOP_AUTH_URL = `${SITE_ORIGIN}${DESKTOP_AUTH_PATH}`;
export const DESKTOP_AUTH_DEEP_LINK_SCHEME = 'frostbyte';
export const DESKTOP_AUTH_DEEP_LINK_HOST = 'auth';
export const DESKTOP_AUTH_CALLBACK = `${DESKTOP_AUTH_DEEP_LINK_SCHEME}://${DESKTOP_AUTH_DEEP_LINK_HOST}`;
export const DESKTOP_AUTH_TTL_MS = 5 * 60 * 1000;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CONTROL_CHARS = /[\0-\x1f\x7f]/;

/** Validate a system-browser sign-in URL built by the main process. */
export function validateDesktopSignInUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || CONTROL_CHARS.test(value)) {
    throw new Error('Invalid FrostNet sign-in URL.');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid FrostNet sign-in URL.'); }
  if (url.protocol !== 'https:' || url.origin !== SITE_ORIGIN) throw new Error('FrostNet sign-in URL must use the FrostByte site.');
  if (url.pathname !== DESKTOP_AUTH_PATH && url.pathname !== '/signin' && url.pathname !== '/signup' && url.pathname !== '/reset-password') {
    throw new Error('FrostNet sign-in URL must use an approved FrostByte auth page.');
  }
  if (url.username || url.password || url.port || url.hash) throw new Error('Invalid FrostNet sign-in URL.');
  if (url.pathname === DESKTOP_AUTH_PATH) {
    for (const key of url.searchParams.keys()) {
      if (key !== 'state' && key !== 'code_challenge' && key !== 'code_challenge_method') {
        throw new Error('Unexpected FrostNet sign-in URL parameter.');
      }
    }
    const state = url.searchParams.get('state') || '';
    const challenge = url.searchParams.get('code_challenge') || '';
    const method = url.searchParams.get('code_challenge_method') || '';
    if (!BASE64URL.test(state) || state.length < 32 || state.length > 128) {
      throw new Error('Invalid FrostNet sign-in state.');
    }
    if (!BASE64URL.test(challenge) || challenge.length < 43 || challenge.length > 128) {
      throw new Error('Invalid FrostNet PKCE challenge.');
    }
    if (method !== 'S256') {
      throw new Error('Invalid FrostNet PKCE challenge method.');
    }
  }
  return url;
}

/** Generate a fresh main-process PKCE request. The verifier is never exposed. */
export function createDesktopAuthRequest(now = Date.now()) {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const url = new URL(DESKTOP_AUTH_URL);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return {
    state,
    codeVerifier,
    codeChallenge,
    url: url.toString(),
    createdAt: now,
    expiresAt: now + DESKTOP_AUTH_TTL_MS,
  };
}

/**
 * True only for a deep link whose RFC 3986 scheme is `frostbyte:` and host is
 * `auth` (case-insensitive), distinguishing OS sign-in handoffs from internal
 * `frostbyte://app/...` renderer URLs and lookalike prefixes (`frostbyte://authority`).
 */
export function isDesktopAuthCandidate(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || CONTROL_CHARS.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === `${DESKTOP_AUTH_DEEP_LINK_SCHEME}:`
      && url.hostname.toLowerCase() === DESKTOP_AUTH_DEEP_LINK_HOST;
  } catch {
    return false;
  }
}

/** Strictly parse `frostbyte://auth?code=...&state=...`. */
export function parseDesktopAuthUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || CONTROL_CHARS.test(value)) {
    throw new Error('Invalid FrostByte sign-in link.');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid FrostByte sign-in link.'); }
  if (url.protocol !== `${DESKTOP_AUTH_DEEP_LINK_SCHEME}:` || url.hostname.toLowerCase() !== DESKTOP_AUTH_DEEP_LINK_HOST) {
    throw new Error('Invalid FrostByte sign-in link.');
  }
  if (url.username || url.password || url.port || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Invalid FrostByte sign-in link.');
  }
  if (url.searchParams.size !== 2) throw new Error('Invalid FrostByte sign-in link parameters.');
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!BASE64URL.test(code) || code.length < 32 || code.length > 128) throw new Error('Invalid sign-in code.');
  if (!BASE64URL.test(state) || state.length < 32 || state.length > 128) throw new Error('Invalid sign-in state.');
  return { code, state };
}

/** Native review before opening the system browser. No credential is echoed. */
export function desktopAuthBrowserReview() {
  return {
    summary: `Open ${SITE_ORIGIN} in your browser to sign in to FrostByte.`,
    type: 'question',
    buttons: ['Cancel', 'Open browser'],
    defaultId: 0,
    cancelId: 0,
    message: 'Sign in through FrostByte?',
    detail: `FrostByte opens ${DESKTOP_AUTH_URL} in your system browser. Email/password, account creation, password reset, and Google sign-in all happen on the website. Your password is never entered in the desktop app. After sign-in, the browser passes a short-lived one-time code back to FrostByte; no password or long-lived token is placed in the link.`,
  };
}

function quote(value, max, label) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return JSON.stringify(value);
}

/** Native review before a one-time code is exchanged and the session saved. */
export function desktopAuthExchangeReview({ state }) {
  if (!BASE64URL.test(state || '') || state.length < 32 || state.length > 128) {
    throw new Error('Invalid sign-in state.');
  }
  return {
    summary: `Complete your FrostByte browser sign-in at ${HUB_API_BASE}.`,
    type: 'question',
    buttons: ['Cancel', 'Complete sign-in'],
    defaultId: 0,
    cancelId: 0,
    message: 'Complete FrostByte sign-in?',
    detail: `Hub API: ${quote(HUB_API_BASE, 2048, 'Hub API')}\nSign-in state: ${quote(state, 128, 'state')}\n\nFrostByte exchanges a one-time browser code for a session that is encrypted in your system keychain. The code cannot be reused.`,
  };
}

/** Validate a website-returned handoff code shape. */
export function validateDesktopAuthCode(code) {
  if (!BASE64URL.test(code || '') || code.length < 32 || code.length > 128) throw new Error('Invalid sign-in code.');
  return code;
}
