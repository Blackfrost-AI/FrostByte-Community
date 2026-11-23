/**
 * CORS behaviour.
 *
 * These assert the contract a browser actually depends on: a preflight
 * succeeds, an allowlisted origin can read the response, and an unlisted
 * origin cannot. The last one matters most — a permissive bug here would let
 * any page on the internet read authenticated responses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { harness } from './harness.js';
import { parseAllowedOrigins } from '../src/cors.js';

const ORIGINS = 'https://frostbyte.si,https://www.frostbyte.si';

test('allowlisted origin is echoed on a normal request', async () => {
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    url: '/v1/health',
    auth: false,
    headers: { origin: 'https://frostbyte.si' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('access-control-allow-origin'), 'https://frostbyte.si');
});

test('www variant is also allowed', async () => {
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    url: '/v1/health',
    auth: false,
    headers: { origin: 'https://www.frostbyte.si' },
  });

  assert.equal(res.getHeader('access-control-allow-origin'), 'https://www.frostbyte.si');
});

test('unlisted origin gets no Access-Control-Allow-Origin', async () => {
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    url: '/v1/health',
    auth: false,
    headers: { origin: 'https://evil.example' },
  });

  // The request still succeeds server-side; the browser is what blocks the
  // read. What matters is that no ACAO header was issued for this origin.
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('access-control-allow-origin'), undefined);
});

test('a lookalike suffix origin is not allowed', async () => {
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    url: '/v1/health',
    auth: false,
    headers: { origin: 'https://evil-frostbyte.si' },
  });

  assert.equal(res.getHeader('access-control-allow-origin'), undefined);
});

test('preflight returns 204 with allowed methods and headers', async () => {
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    method: 'OPTIONS',
    url: '/v1/discovery/models',
    auth: false,
    headers: {
      origin: 'https://frostbyte.si',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.getHeader('access-control-allow-origin'), 'https://frostbyte.si');
  assert.match(res.getHeader('access-control-allow-methods'), /GET/);
  assert.match(res.getHeader('access-control-allow-headers'), /Authorization/i);
  assert.equal(res.body, '');
});

test('preflight never requires a token', async () => {
  // Browsers do not send credentials on a preflight. If this 401'd, every
  // cross-origin authenticated request would fail before it started.
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    method: 'OPTIONS',
    url: '/v1/me',
    auth: false,
    headers: { origin: 'https://frostbyte.si' },
  });

  assert.equal(res.statusCode, 204);
});

test('Vary: Origin is always present, even with no origin', async () => {
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const withOrigin = await request({
    url: '/v1/health',
    auth: false,
    headers: { origin: 'https://frostbyte.si' },
  });
  const withoutOrigin = await request({ url: '/v1/health', auth: false });

  assert.equal(withOrigin.getHeader('vary'), 'Origin');
  assert.equal(withoutOrigin.getHeader('vary'), 'Origin');
});

test('no Allow-Credentials header is issued', async () => {
  // Auth is a bearer header, not a cookie. Sending credentials mode would let
  // a browser attach cookies to these cross-origin calls for no benefit.
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    url: '/v1/health',
    auth: false,
    headers: { origin: 'https://frostbyte.si' },
  });

  assert.equal(res.getHeader('access-control-allow-credentials'), undefined);
});

test('error responses also carry CORS headers', async () => {
  // A 401 that the browser cannot read is indistinguishable from a network
  // failure, which makes client-side debugging miserable.
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    url: '/v1/me',
    auth: false,
    headers: { origin: 'https://frostbyte.si' },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.getHeader('access-control-allow-origin'), 'https://frostbyte.si');
});

test('unknown route 404 also carries CORS headers', async () => {
  const { request } = await harness({ appOptions: { allowedOrigins: ORIGINS } });

  const res = await request({
    url: '/v1/nope',
    auth: false,
    headers: { origin: 'https://frostbyte.si' },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.getHeader('access-control-allow-origin'), 'https://frostbyte.si');
});

test('empty allowlist allows nothing', async () => {
  const { request } = await harness({ appOptions: { allowedOrigins: '' } });

  const res = await request({
    url: '/v1/health',
    auth: false,
    headers: { origin: 'https://frostbyte.si' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('access-control-allow-origin'), undefined);
});

test('parseAllowedOrigins normalises and rejects junk', () => {
  const set = parseAllowedOrigins(
    ' HTTPS://FrostByte.si/ , https://www.frostbyte.si ,, not-a-url, *, ',
  );

  assert.ok(set.has('https://frostbyte.si'));
  assert.ok(set.has('https://www.frostbyte.si'));
  // A bare `*` has no scheme and is dropped rather than silently wildcarding.
  assert.equal(set.has('*'), false);
  assert.equal(set.has('not-a-url'), false);
  assert.equal(set.size, 2);
});

test('parseAllowedOrigins accepts an array', () => {
  const set = parseAllowedOrigins(['https://a.test', 'https://b.test']);
  assert.deepEqual([...set].sort(), ['https://a.test', 'https://b.test']);
});

test('parseAllowedOrigins handles null and undefined', () => {
  assert.equal(parseAllowedOrigins(null).size, 0);
  assert.equal(parseAllowedOrigins(undefined).size, 0);
});