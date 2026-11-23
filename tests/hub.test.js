import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubClient, hubOrigin } from '../src/main/hub-client.js';
import { createEntitlementCache, gate } from '../src/main/hub-entitlements.js';
import { checkUpdates, compareVersions } from '../src/main/hub-updates.js';
import { validateRecipe, canonicalJson } from '../src/shared/recipe-manifest.js';
import { encodeCursor, decodeCursor, tierAtLeast, normalizeSearchQuery, etagForDigest, digestFromEtag } from '../src/shared/hub-protocol.js';
import { normalizeHubConfig, normalizeHubEntitlement } from '../src/main/hub-store.js';
import { hubManifestDigest, validateHubPublishPayload } from '../src/main/hub-publishing.js';
import { HUB_API_BASE } from '../src/main/hub-security.js';

test('hub-client: search + etag + bounded URL + auth header', async () => {
  let lastUrl = '', lastHeaders = null;
  const fetcher = async (url, opts) => {
    lastUrl = url; lastHeaders = opts.headers;
    return { ok: true, status: 200, headers: { get: () => '"sha256:' + 'a'.repeat(64) + '"' }, text: async () => JSON.stringify({ items: [] }) };
  };
  const hub = createHubClient({ hubUrl: HUB_API_BASE, token: 't1', fetcher });
  assert.equal(hub.origin, HUB_API_BASE);
  const res = await hub.search({ q: 'Qwen/Qwen3-32B Q4_K_M', limit: 10 });
  assert.equal(res.status, 200);
  assert.match(lastUrl, /q=/);
  assert.equal(lastHeaders.Authorization, 'Bearer t1');
  assert.equal(typeof hub.login, 'undefined');
});

test('hub-client: health probes the deployed public route without a bearer', async () => {
  let lastUrl = '', lastHeaders = null;
  const fetcher = async (url, opts) => {
    lastUrl = url; lastHeaders = opts.headers;
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => JSON.stringify({ status: 'ok', service: 'frostbyte-hub' }) };
  };
  const hub = createHubClient({ hubUrl: HUB_API_BASE, token: 't1', fetcher });
  const res = await hub.health();
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'ok');
  assert.equal(lastUrl, `${HUB_API_BASE}/v1/health`);
  assert.equal(lastHeaders.Authorization, undefined, 'health is anonymous even when a token exists');
});

test('hub-client: rejects unapproved URLs, loopback HTTP, and invalid digest', async () => {
  const hub = createHubClient({ hubUrl: HUB_API_BASE, fetcher: async () => ({ ok: true, status: 200, headers: { get: () => '' }, text: async () => '{}' }) });
  assert.throws(() => hub.manifestByDigest('bad'), /Invalid manifest digest/);
  assert.throws(() => hubOrigin('https://user:pass@evil/x'), /credentials/);
  assert.throws(() => hubOrigin('https://hub.example'), /production FrostByte Hub API/i);
  assert.throws(() => hubOrigin('http://localhost:8787'), /HTTPS/);
});

test('entitlements: cache tier + grace + gates', () => {
  const now = Date.now();
  const cache = createEntitlementCache({ now: () => now });
  assert.equal(cache.tier(), 'free');
  assert.equal(cache.allows('plus'), false);
  cache.set({ tier: 'pro', status: 'active', fetchedAt: now, source: 'hub', currentPeriodEnd: new Date(now + 86400000).toISOString() });
  assert.equal(cache.allows('plus'), true);
  assert.equal(gate({ tier: 'pro', required: 'plus' }), true);
  assert.equal(gate({ tier: 'plus', required: 'pro' }), false);
});

test('hub-updates: engine + recipe nudges', () => {
  const installed = { engines: [{ name: 'vllm', version: '0.6.3', digest: 'a'.repeat(64) }], recipes: [{ id: 'r1', digest: 'b'.repeat(64) }] };
  const feed = { engines: [{ name: 'vllm', version: '0.6.4', digest: 'c'.repeat(64), severity: 'security', notes: 'CVE' }], recipes: [{ id: 'r1', digest: 'd'.repeat(64) }] };
  const nudges = checkUpdates({ installed, feed });
  assert.equal(nudges.length, 2);
  assert.equal(nudges[0].kind, 'engine');
  assert.equal(compareVersions('0.6.4', '0.6.3') > 0, true);
});

test('recipe-manifest: validate + canonical + digest', () => {
  const raw = {
    schema: 'frostbyte.recipe', version: 2, id: 'qwen3-32b-vllm', title: 'Qwen3 32B vLLM',
    kind: 'docker', publisher: 'a'.repeat(64), container: 'frostbyte-vllm', image: 'ghcr.io/x', imageDigest: 'b'.repeat(64),
    files: [{ path: 'config.json', size: 10, sha256: 'c'.repeat(64) }],
    license: { id: 'apache-2.0', statement: 'ok' }, createdAt: new Date().toISOString(),
  };
  const v = validateRecipe(raw);
  assert.equal(v.id, 'qwen3-32b-vllm');
  const j = canonicalJson(v);
  assert.match(j, /frostbyte\.recipe/);
  const digest = hubManifestDigest(v);
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test('hub-protocol: cursor + etag + query preservation', () => {
  const c = encodeCursor({ seq: 42, id: 'x' });
  const d = decodeCursor(c);
  assert.equal(d.seq, 42);
  assert.throws(() => decodeCursor('!!!'), /Invalid cursor/);
  assert.equal(tierAtLeast('pro', 'plus'), true);
  assert.equal(tierAtLeast('free', 'plus'), false);
  assert.equal(normalizeSearchQuery('  Q4_K_M  '), 'Q4_K_M');
  const etag = etagForDigest('a'.repeat(64));
  assert.equal(digestFromEtag(etag), 'a'.repeat(64));
});

test('hub-store: normalize + publish payload', () => {
  const cfg = normalizeHubConfig({ hubUrl: 'https://hub.example/path?x=1', follows: ['a'.repeat(64), 'A'.repeat(64)] });
  assert.equal(cfg.hubUrl, HUB_API_BASE);
  assert.equal(cfg.legacyHubUrlMismatch, true);
  assert.equal(cfg.follows.length, 1);
  assert.throws(() => normalizeHubConfig({ follows: ['bad'] }), /Invalid follow/);
  const ent = normalizeHubEntitlement({ tier: 'Plus', status: 'active', fetchedAt: Date.now() });
  assert.equal(ent.tier, 'plus');

  const raw = {
    schema: 'frostbyte.recipe', version: 2, id: 'r1', title: 'R', kind: 'tmux',
    publisher: 'a'.repeat(64), session: 's1', argv: ['echo hi'],
    files: [{ path: 'a.txt', size: 1, sha256: 'b'.repeat(64) }],
    license: { id: 'apache-2.0', statement: 'ok' }, createdAt: new Date().toISOString(),
  };
  const v = validateRecipe(raw);
  const payload = validateHubPublishPayload({ manifest: v, terms: '2026-10-10-v1' });
  assert.match(payload.computedDigest, /^[a-f0-9]{64}$/);
});
