import test from 'node:test';
import assert from 'node:assert/strict';
import * as hubSecurity from '../src/main/hub-security.js';
import {
  HUB_API_BASE,
  validateHubBaseUrl,
  validateHubOrigin,
  bearerAllowed,
  describeHubToken,
  hubTokenGeneration,
  rendererEntitlementRequest,
  hubRequestReview,
  hubTokenSaveReview,
  HUB_REVIEW_ACTIONS,
  normalizeSessionExpiry,
  firebaseTokenTenant,
} from '../src/main/hub-security.js';
import { createHubClient } from '../src/main/hub-client.js';
import { normalizeUpdateFeed, compareAgainstFeed } from '../src/main/hub-update-feed.js';
import { normalizeHubConfig, applyHubConfig, getHubConfig } from '../src/main/hub-store.js';

const FINGERPRINT = 'a'.repeat(64);
const TOKEN = 'hub_'.padEnd(40, 'x');

test('Hub base URLs are strictly pinned to production HTTPS HUB_API_BASE (no loopback or foreign hosts)', () => {
  assert.equal(validateHubBaseUrl(HUB_API_BASE), HUB_API_BASE);
  assert.equal(validateHubBaseUrl(`${HUB_API_BASE}/`), HUB_API_BASE);
  assert.equal(validateHubOrigin(HUB_API_BASE), HUB_API_BASE);

  // Removed loopback and direct-password helpers are absent.
  assert.equal(typeof hubSecurity.isLoopbackHost, 'undefined');
  assert.equal(typeof hubSecurity.hubLoginReview, 'undefined');
  assert.equal(typeof hubSecurity.hubSignupReview, 'undefined');

  // Loopback HTTP, plain HTTP, foreign HTTPS, and wrong paths are rejected.
  assert.throws(() => validateHubBaseUrl('http://localhost:8787'), /HTTPS/);
  assert.throws(() => validateHubBaseUrl('http://127.0.0.1:8787'), /HTTPS/);
  assert.throws(() => validateHubBaseUrl('http://[::1]:8787'), /HTTPS/);
  assert.throws(() => validateHubBaseUrl('http://hub.example.org'), /HTTPS/);
  assert.throws(() => validateHubBaseUrl('https://hub.example.org'), /production FrostByte Hub API/i);
  assert.throws(() => validateHubBaseUrl('https://us-central1-blackfrost-ai-prod.cloudfunctions.net/other'), /production FrostByte Hub API/i);
  assert.throws(() => validateHubBaseUrl('https://user:pw@us-central1-blackfrost-ai-prod.cloudfunctions.net/api/api'), /credentials/);
  assert.throws(() => validateHubBaseUrl('file:///etc/passwd'), /HTTPS/);
  assert.throws(() => validateHubBaseUrl(''), /Invalid Hub URL/);
  assert.throws(() => validateHubBaseUrl(null), /Invalid Hub URL/);
  assert.throws(() => validateHubBaseUrl(`${HUB_API_BASE}\ninjected`), /Invalid Hub URL/);
  assert.throws(() => validateHubBaseUrl(`${HUB_API_BASE}/` + 'a'.repeat(3000)), /Invalid Hub URL/);
});

test('bearer credential travels only to HUB_API_BASE over HTTPS', async () => {
  assert.equal(bearerAllowed(HUB_API_BASE), true);
  assert.equal(bearerAllowed('http://localhost:8787'), false);
  assert.equal(bearerAllowed('http://127.0.0.1:8787'), false);
  assert.equal(bearerAllowed('https://hub.example.org'), false);
  assert.equal(bearerAllowed('http://hub.example.org'), false);

  const seen = [];
  const fetcher = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} });
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => JSON.stringify({ items: [] }) };
  };

  assert.throws(() => createHubClient({ hubUrl: 'http://hub.example.org', token: TOKEN, fetcher }), /HTTPS/);
  assert.throws(() => createHubClient({ hubUrl: 'http://localhost:8787', token: TOKEN, fetcher }), /HTTPS/);
  assert.throws(() => createHubClient({ hubUrl: 'https://hub.example.org', token: TOKEN, fetcher }), /production FrostByte Hub API/i);
  assert.equal(seen.length, 0);

  const prod = createHubClient({ hubUrl: HUB_API_BASE, token: TOKEN, fetcher });
  await prod.search({ q: 'llama' });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.startsWith(`${HUB_API_BASE}/v1/search?`));
  assert.equal(seen[0].headers.Authorization, 'Bearer ' + TOKEN);
});

test('default hub client binds strictly to HUB_API_BASE with zero network activity until invoked', async () => {
  const seen = [];
  const client = createHubClient({ fetcher: async (url) => { seen.push(String(url)); return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '{}' }; } });
  assert.equal(client.origin, HUB_API_BASE);
  assert.equal(seen.length, 0);
});

test('hub token shape is bounded and fingerprinted', () => {
  const described = describeHubToken(TOKEN);
  assert.equal(described.byteLength, TOKEN.length);
  assert.match(described.fingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => describeHubToken(''), /invalid/);
  assert.throws(() => describeHubToken('has space'), /invalid/);
  assert.throws(() => describeHubToken('line\nbreak'), /invalid/);
  assert.throws(() => describeHubToken('a'.repeat(5000)), /invalid/);
  assert.throws(() => describeHubToken(null), /invalid/);
});

test('token generation is bound to HUB_API_BASE', () => {
  const gen = hubTokenGeneration(HUB_API_BASE, FINGERPRINT);
  assert.match(gen, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => hubTokenGeneration('https://other.example.org', FINGERPRINT), /production FrostByte Hub API/i);
  assert.throws(() => hubTokenGeneration(HUB_API_BASE, 'nope'), /fingerprint/);
});

test('renderer cannot grant Plus or Pro', () => {
  assert.equal(rendererEntitlementRequest({ tier: 'free' }).tier, 'free');
  assert.equal(rendererEntitlementRequest({ tier: 'offline' }).tier, 'offline');
  assert.throws(() => rendererEntitlementRequest({ tier: 'plus' }), /granted by your Hub account/);
  assert.throws(() => rendererEntitlementRequest({ tier: 'pro' }), /granted by your Hub account/);
  assert.throws(() => rendererEntitlementRequest({ tier: 'PRO' }), /granted by your Hub account/);
  assert.throws(() => rendererEntitlementRequest({ tier: 'admin' }), /granted by your Hub account/);
  assert.throws(() => rendererEntitlementRequest({}), /granted by your Hub account/);
  assert.throws(() => rendererEntitlementRequest(null), () => true);
  const forged = rendererEntitlementRequest({ tier: 'offline', entitlements: { liveUpdates: true }, source: 'server' });
  assert.deepEqual(forged.entitlements, {});
  assert.equal(forged.source, 'bundle');
});

test('hub request review scopes remembered approval to HUB_API_BASE', () => {
  const anon = hubRequestReview({ origin: HUB_API_BASE, action: 'search' });
  assert.deepEqual(anon.remember.scope, [HUB_API_BASE]);
  assert.equal(anon.remember.kind, 'hub-public-browse');
  assert.match(anon.detail, /No credential is sent/);

  const authed = hubRequestReview({
    origin: HUB_API_BASE,
    action: 'updates',
    authenticated: true,
    tokenGeneration: hubTokenGeneration(HUB_API_BASE, FINGERPRINT),
  });
  assert.equal(authed.remember.kind, 'hub-account-browse');
  assert.equal(authed.remember.scope.length, 2);
  assert.match(authed.detail, /Bearer credential/);
  assert.doesNotMatch(JSON.stringify(authed), new RegExp(TOKEN));

  assert.throws(() => hubRequestReview({ origin: 'http://localhost:8787', action: 'search' }), /HTTPS/);
  assert.throws(() => hubRequestReview({ origin: 'https://hub.example.org', action: 'search' }), /production FrostByte Hub API/i);
  assert.throws(() => hubRequestReview({ origin: HUB_API_BASE, action: 'delete-everything' }), /action/);
  assert.throws(() => hubRequestReview({ origin: `${HUB_API_BASE}/`, action: 'search' }), /normalized/);
  assert.throws(() => hubRequestReview({ origin: HUB_API_BASE, action: 'updates', authenticated: true }), /generation/);
  assert.ok(HUB_REVIEW_ACTIONS.includes('search') && HUB_REVIEW_ACTIONS.includes('updates'));
});

test('hub token save review never echoes the token', () => {
  const described = describeHubToken(TOKEN);
  const review = hubTokenSaveReview({ origin: HUB_API_BASE, ...described });
  assert.equal(review.message, 'Save this FrostByte session?');
  assert.match(review.detail, /fingerprint/);
  assert.doesNotMatch(JSON.stringify(review), new RegExp(TOKEN.slice(0, 12)));
  assert.throws(() => hubTokenSaveReview({ origin: 'http://localhost:8787', ...described }), /HTTPS/);
  assert.throws(() => hubTokenSaveReview({ origin: 'https://hub.example.org', ...described }), /production FrostByte Hub API/i);
});

test('hub config pins HUB_API_BASE and drops tokens bound to legacy origins', () => {
  assert.equal(normalizeHubConfig({ hubUrl: 'https://hub.example.org/v1' }).hubUrl, HUB_API_BASE);
  assert.equal(normalizeHubConfig({ hubUrl: 'http://localhost:8787' }).legacyHubUrlMismatch, true);
  assert.equal(normalizeHubConfig({ hubUrl: '' }).hubUrl, HUB_API_BASE);

  const commits = [];
  const store = {
    state: {
      hubConfig: { hubUrl: 'http://localhost:8787' },
      hubTokenEnc: 'cipher',
      hubTokenOrigin: 'http://localhost:8787',
      hubTokenFingerprint: FINGERPRINT,
    },
    _commitStateFields(fields) { commits.push(fields); Object.assign(this.state, fields); },
  };
  const next = applyHubConfig(store, { hubUrl: HUB_API_BASE });
  assert.equal(next.hubUrl, HUB_API_BASE);
  assert.equal(store.state.hubTokenEnc, undefined);
  assert.equal(store.state.hubTokenOrigin, undefined);
  assert.equal(commits.length, 1);

  const keep = {
    state: { hubConfig: { hubUrl: HUB_API_BASE }, hubTokenEnc: 'cipher', hubTokenOrigin: HUB_API_BASE },
    _commitStateFields(f) { Object.assign(this.state, f); },
  };
  applyHubConfig(keep, { hubUrl: HUB_API_BASE });
  assert.equal(keep.state.hubTokenEnc, 'cipher');
  assert.equal(getHubConfig(keep).hasToken, true);
});

test('a Hub update feed is validated before it can nudge anyone', () => {
  assert.equal(normalizeUpdateFeed(null), null);
  assert.equal(normalizeUpdateFeed([]), null);
  const feed = normalizeUpdateFeed({
    version: 4,
    engines: [{ name: 'llama.cpp', version: 'b5000', severity: 'security', digest: 'b'.repeat(64) }, { name: '' }, 'junk'],
    containers: [{ name: 'frostbyte/engine', tag: '2026.10', severity: 'urgent' }],
    recipes: [{ id: 'ctf/llama-3.1-8b', digest: 'c'.repeat(64) }, { digest: 'no-id' }],
    configs: [{ repoId: 'meta-llama/Llama-3.1-8B', revision: 'D'.repeat(40) }],
  });
  assert.equal(feed.version, 4);
  assert.equal(feed.engines.length, 1);
  assert.equal(feed.engines[0].severity, 'security');
  assert.equal(feed.containers[0].severity, 'info', 'unknown severity is not trusted');
  assert.equal(feed.recipes.length, 1);
  assert.equal(feed.configs[0].revision, 'd'.repeat(40));
  assert.throws(() => compareAgainstFeed({ installed: {}, feed: 'nope' }), /invalid update feed/);
});

test('rendered update nudges come from the local inventory, not the feed', () => {
  const feed = normalizeUpdateFeed({ version: 1, engines: [{ name: 'llama.cpp', version: 'b6000', severity: 'recommended' }] });
  const result = compareAgainstFeed({ installed: { engines: [{ name: 'llama.cpp', version: 'b5000' }] }, feed });
  assert.equal(result.feedVersion, 1);
  assert.ok(Array.isArray(result.nudges));
});

test('normalizeSessionExpiry normalizes epoch-ms and ISO expiries alike', () => {
  const ms = Date.now() + 3_600_000;
  assert.equal(normalizeSessionExpiry(ms), ms);
  assert.equal(normalizeSessionExpiry(new Date(ms).toISOString()), ms);
  assert.equal(normalizeSessionExpiry(undefined), 0);
  assert.equal(normalizeSessionExpiry(null), 0);
  assert.equal(normalizeSessionExpiry(''), 0);
  assert.equal(normalizeSessionExpiry('not-a-date'), 0);
  assert.equal(normalizeSessionExpiry(0), 0);
  assert.equal(normalizeSessionExpiry(-5), 0);
  assert.equal(normalizeSessionExpiry(1.5), 0);
});

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`;

test('firebaseTokenTenant decodes a valid firebase.tenant claim', () => {
  assert.equal(firebaseTokenTenant(jwt({ firebase: { tenant: 'frostbyte-ab12c' }, sub: 'uid' })), 'frostbyte-ab12c');
  assert.equal(firebaseTokenTenant(jwt({ firebase: { tenant: 'a' } })), 'a');
  assert.equal(firebaseTokenTenant(jwt({ firebase: { tenant: 'A_1-b'.padEnd(64, 'x') } })), 'A_1-b'.padEnd(64, 'x'));
});

test('firebaseTokenTenant yields empty string for root-pool and malformed tokens', () => {
  assert.equal(firebaseTokenTenant(jwt({ sub: 'uid', firebase: { sign_in_provider: 'password' } })), '');
  assert.equal(firebaseTokenTenant(jwt({ sub: 'uid' })), '');
  assert.equal(firebaseTokenTenant(jwt({ firebase: { tenant: 42 } })), '');
  assert.equal(firebaseTokenTenant(jwt({ firebase: { tenant: 'x'.repeat(65) } })), '');
  assert.equal(firebaseTokenTenant(jwt({ firebase: { tenant: 'bad tenant!' } })), '');
  assert.equal(firebaseTokenTenant(jwt({ firebase: { tenant: 'evil/tenant' } })), '');
  assert.equal(firebaseTokenTenant('bfk_manual_api_key'), '');
  assert.equal(firebaseTokenTenant('not-a-jwt'), '');
  assert.equal(firebaseTokenTenant('a.%%%.c'), '');
  assert.equal(firebaseTokenTenant(''), '');
  assert.equal(firebaseTokenTenant(null), '');
  assert.equal(firebaseTokenTenant(undefined), '');
  assert.equal(firebaseTokenTenant(`h.${Buffer.from('not json').toString('base64url')}.s`), '');
});
