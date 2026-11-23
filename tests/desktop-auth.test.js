import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  HUB_API_BASE,
  DESKTOP_AUTH_CALLBACK,
  DESKTOP_AUTH_TTL_MS,
  createDesktopAuthRequest,
  validateDesktopSignInUrl,
  isDesktopAuthCandidate,
  parseDesktopAuthUrl,
  desktopAuthBrowserReview,
  desktopAuthExchangeReview,
} from '../src/main/desktop-auth.js';

test('createDesktopAuthRequest generates S256 PKCE verifier/challenge and pinned sign-in URL', () => {
  const now = 1_763_200_000_000;
  const req = createDesktopAuthRequest(now);
  assert.match(req.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(req.codeVerifier, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(req.state, req.codeVerifier);

  const expectedChallenge = crypto
    .createHash('sha256')
    .update(req.codeVerifier, 'ascii')
    .digest('base64url');
  assert.equal(req.codeChallenge, expectedChallenge);
  assert.equal(req.createdAt, now);
  assert.equal(req.expiresAt, now + DESKTOP_AUTH_TTL_MS);

  const validated = validateDesktopSignInUrl(req.url);
  assert.equal(validated.toString(), req.url);

  assert.equal(validated.origin, 'https://frostbyte.si');
  assert.equal(validated.pathname, '/desktop-auth');
  assert.equal(validated.searchParams.get('code_challenge'), expectedChallenge);
  assert.equal(validated.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(validated.searchParams.get('state'), req.state);
  assert.equal(validated.searchParams.size, 3);
  assert.equal(DESKTOP_AUTH_CALLBACK, 'frostbyte://auth');
});

test('validateDesktopSignInUrl rejects loopback, wrong host, plain HTTP, credentials, and extra params', () => {
  const valid = createDesktopAuthRequest().url;
  assert.equal(validateDesktopSignInUrl(valid).toString(), valid);
  assert.throws(() => validateDesktopSignInUrl(valid.replace('https://frostbyte.si', 'http://localhost:3000')), /FrostByte site/i);
  assert.throws(() => validateDesktopSignInUrl(valid.replace('https://frostbyte.si', 'https://evil.example')), /FrostByte site/i);
  assert.throws(() => validateDesktopSignInUrl(valid.replace('https://', 'https://user:pw@')), /Invalid FrostNet sign-in URL/i);
  assert.throws(() => validateDesktopSignInUrl(`${valid}#frag`), /Invalid FrostNet sign-in URL/i);
  assert.throws(() => validateDesktopSignInUrl(`${valid}&extra=1`), /parameter/i);
});

test('isDesktopAuthCandidate matches RFC 3986 case-insensitive scheme/host and rejects lookalikes', () => {
  assert.equal(isDesktopAuthCandidate('frostbyte://auth?code=abc&state=def'), true);
  assert.equal(isDesktopAuthCandidate('FROSTBYTE://AUTH?code=abc&state=def'), true);
  assert.equal(isDesktopAuthCandidate('FrostByte://Auth?code=abc&state=def'), true);
  assert.equal(isDesktopAuthCandidate('frostbyte://authority?code=abc&state=def'), false);
  assert.equal(isDesktopAuthCandidate('frostbyte://auth.example?code=abc&state=def'), false);
  assert.equal(isDesktopAuthCandidate('frostbyte://app/index.html'), false);
  assert.equal(isDesktopAuthCandidate('magnet:?xt=urn:btih:123'), false);
  assert.equal(isDesktopAuthCandidate(''), false);
  assert.equal(isDesktopAuthCandidate(null), false);
});

test('parseDesktopAuthUrl strictly accepts only frostbyte://auth?code=...&state=...', () => {
  const code = 'c'.repeat(43);
  const state = 's'.repeat(43);
  const parsed = parseDesktopAuthUrl(`frostbyte://auth?code=${code}&state=${state}`);
  assert.deepEqual(parsed, { code, state });
  assert.deepEqual(parseDesktopAuthUrl(`FROSTBYTE://AUTH?code=${code}&state=${state}`), { code, state });

  assert.throws(() => parseDesktopAuthUrl('https://frostbyte.si/auth?code=' + code + '&state=' + state), /Invalid FrostByte sign-in link/i);
  assert.throws(() => parseDesktopAuthUrl('frostbyte://other?code=' + code + '&state=' + state), /Invalid FrostByte sign-in link/i);
  assert.throws(() => parseDesktopAuthUrl('frostbyte://auth/subpath?code=' + code + '&state=' + state), /Invalid FrostByte sign-in link/i);
  assert.throws(() => parseDesktopAuthUrl('frostbyte://user@auth?code=' + code + '&state=' + state), /Invalid FrostByte sign-in link/i);
  assert.throws(() => parseDesktopAuthUrl(`frostbyte://auth?code=${code}&state=${state}&extra=1`), /parameter/i);
  assert.throws(() => parseDesktopAuthUrl(`frostbyte://auth?code=${code}&state=${state}#hash`), /Invalid FrostByte sign-in link/i);
  assert.throws(() => parseDesktopAuthUrl('frostbyte://auth?code=short&state=' + state), /code/i);
  assert.throws(() => parseDesktopAuthUrl('frostbyte://auth?code=' + code + '&state=short'), /state/i);
  assert.throws(() => parseDesktopAuthUrl(''), /Invalid/i);
  assert.throws(() => parseDesktopAuthUrl(null), /Invalid/i);
});

test('desktop auth native review specs pin production endpoints and never echo secrets', () => {
  const req = createDesktopAuthRequest();
  const browserReview = desktopAuthBrowserReview();
  assert.match(browserReview.detail, /https:\/\/frostbyte\.si\/desktop-auth/);
  assert.doesNotMatch(JSON.stringify(browserReview), new RegExp(req.codeVerifier));

  const exchangeReview = desktopAuthExchangeReview({ state: req.state });
  assert.ok(exchangeReview.detail.includes(HUB_API_BASE));
  assert.doesNotMatch(JSON.stringify(exchangeReview), new RegExp(req.codeVerifier));
  assert.throws(() => desktopAuthExchangeReview({ state: 'short' }), /state/i);
});
