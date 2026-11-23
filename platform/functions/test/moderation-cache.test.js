/**
 * FrostNet moderation + discovery cache tests (spec §5.4, Gate 1).
 *
 * Proves: block rules (repo / org-prefix / infohash) filter live AND cached
 * pages, featured pins annotate + reorder, operator provider toggles gate
 * discovery, and admin mutations rotate the cache fingerprint so stale pages
 * are never served.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { harness, PROVIDER_FIXTURES, FIXED_NOW } from './harness.js';
import { applyFrostNetModeration } from '../src/discovery.js';

const routes = {
  'huggingface.co': PROVIDER_FIXTURES.huggingface,
  'localmaxxing.com': PROVIDER_FIXTURES.localmaxxing,
  'pirateface.co': PROVIDER_FIXTURES.pirateface,
};

const item = (overrides = {}) => ({
  id: 'huggingface:Qwen/Qwen3-0.6B',
  provider: 'huggingface',
  providerId: 'Qwen/Qwen3-0.6B',
  name: 'Qwen3 0.6B',
  author: 'Qwen',
  downloads: 100,
  likes: 10,
  infoHash: '',
  ...overrides,
});

// ---- Unit: moderation function ------------------------------------------------

test('moderation unit: exact repo block matches providerId and qualified id', () => {
  const items = [item(), item({ provider: 'pirateface', providerId: 'Qwen/Qwen3-0.6B', id: 'pirateface:Qwen/Qwen3-0.6B' })];
  const blocked = [{ targetType: 'repo', targetValue: 'qwen/qwen3-0.6b' }];
  assert.equal(applyFrostNetModeration(items, { blockedRules: blocked }).length, 0);
  const qualifiedOnly = [{ targetType: 'repo', targetValue: 'pirateface:qwen/qwen3-0.6b' }];
  const kept = applyFrostNetModeration(items, { blockedRules: qualifiedOnly });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].provider, 'huggingface');
});

test('moderation unit: org/* prefix blocks by providerId prefix and author', () => {
  const items = [
    item({ providerId: 'evilorg/model-a', author: 'evilorg' }),
    item({ providerId: 'goodorg/model-b', author: 'evilorg' }),
    item({ providerId: 'goodorg/model-c', author: 'goodorg' }),
  ];
  const kept = applyFrostNetModeration(items, { blockedRules: [{ targetType: 'repo', targetValue: 'evilorg/*' }] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].providerId, 'goodorg/model-c');
});

test('moderation unit: infohash block matches normalized hash', () => {
  const hash = 'b'.repeat(40);
  const items = [item({ provider: 'pirateface', infoHash: hash }), item()];
  const kept = applyFrostNetModeration(items, { blockedRules: [{ targetType: 'infohash', targetValue: hash.toUpperCase() }] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].provider, 'huggingface');
});

test('moderation unit: featured pins annotate and sort ahead on downloads/trending', () => {
  const items = [
    item({ downloads: 1000 }),
    item({ provider: 'pirateface', providerId: 'small/model', id: 'pirateface:small/model', downloads: 5 }),
  ];
  const featured = [{ provider: 'pirateface', providerId: 'small/model', badge: 'Pick', note: 'great', rank: 1 }];
  const sorted = applyFrostNetModeration(items, { featuredEntries: featured, sort: 'downloads' });
  assert.equal(sorted[0].providerId, 'small/model');
  assert.deepEqual(sorted[0].featured, { badge: 'Pick', note: 'great', rank: 1 });
  assert.equal(sorted[1].featured, undefined);

  // Non-featured sorts leave the order untouched.
  const unsorted = applyFrostNetModeration(items, { featuredEntries: featured, sort: 'updated' });
  assert.equal(unsorted[0].downloads, 1000);
});

test('moderation unit: re-application is idempotent and strips stale pins', () => {
  const pinned = applyFrostNetModeration([item()], {
    featuredEntries: [{ provider: 'huggingface', providerId: 'Qwen/Qwen3-0.6B', badge: 'Old', rank: 3 }],
  });
  assert.equal(pinned[0].featured.badge, 'Old');
  // Pin removed → stale annotation must disappear on re-apply.
  const cleaned = applyFrostNetModeration(pinned, { featuredEntries: [] });
  assert.equal(cleaned[0].featured, undefined);
  // Re-pin with a new badge replaces, never duplicates.
  const repinned = applyFrostNetModeration(cleaned, {
    featuredEntries: [{ provider: 'huggingface', providerId: 'Qwen/Qwen3-0.6B', badge: 'New', rank: 2 }],
  });
  assert.equal(repinned[0].featured.badge, 'New');
});

test('moderation unit: enabledProviders filter drops disabled providers', () => {
  const items = [item(), item({ provider: 'pirateface', providerId: 'p/m', id: 'pirateface:p/m' })];
  const kept = applyFrostNetModeration(items, { enabledProviders: ['huggingface'] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].provider, 'huggingface');
});

// ---- Integration: live path ------------------------------------------------------

async function adminSetup({ tier = 'pro', fixtureRoutes = routes } = {}) {
  const h = await harness({ tier, routes: fixtureRoutes, appOptions: { adminDirectory: undefined } });
  await h.store.setAdmin('user_123', { role: 'owner', status: 'active', email: 'admin@example.com' });
  const admin = (url, options = {}) => h.request({ token: 'admin-token', ...options, url });
  return { ...h, admin };
}

test('live discovery: repo block removes the model from results', async () => {
  const { request, admin } = await adminSetup();
  const before = await request({ url: '/v1/discovery/models?q=qwen' });
  assert.ok(before.json().items.some((entry) => entry.providerId === 'Qwen/Qwen3-0.6B'));

  await admin('/v1/admin/frostnet/moderation', {
    method: 'POST',
    body: { targetType: 'repo', targetValue: 'Qwen/Qwen3-0.6B', reason: 'integration test block' },
  });
  const after = await request({ url: '/v1/discovery/models?q=qwen' });
  assert.equal(after.statusCode, 200);
  assert.ok(!after.json().items.some((entry) => entry.providerId === 'Qwen/Qwen3-0.6B'));
});

test('live discovery: infohash block filters pirateface torrents', async () => {
  const hash = 'c'.repeat(40);
  const piratefaceWithHash = {
    models: [{ ...PROVIDER_FIXTURES.pirateface.models[0], id: 'Evil/Torrent-Model', infoHash: hash }],
    nextCursor: null,
  };
  const { request, admin } = await adminSetup({ fixtureRoutes: { ...routes, 'pirateface.co': piratefaceWithHash } });
  const before = await request({ url: '/v1/discovery/models?q=torrent' });
  assert.ok(before.json().items.some((entry) => entry.infoHash === hash));

  await admin('/v1/admin/frostnet/moderation', {
    method: 'POST',
    body: { targetType: 'infohash', targetValue: hash, reason: 'malicious torrent integration test' },
  });
  const after = await request({ url: '/v1/discovery/models?q=torrent' });
  assert.ok(!after.json().items.some((entry) => entry.infoHash === hash));
});

test('live discovery: featured pin annotates results', async () => {
  const { request, admin } = await adminSetup();
  await admin('/v1/admin/frostnet/featured', {
    method: 'POST',
    body: { provider: 'huggingface', providerId: 'Qwen/Qwen3-0.6B', badge: 'Staff pick', rank: 1, reason: 'integration feature test' },
  });
  const res = await request({ url: '/v1/discovery/models?q=qwen' });
  const pinned = res.json().items.find((entry) => entry.providerId === 'Qwen/Qwen3-0.6B');
  assert.equal(pinned.featured.badge, 'Staff pick');
});

test('provider toggle: disabled provider is skipped with operator_disabled', async () => {
  const { request, admin } = await adminSetup();
  await admin('/v1/admin/frostnet/providers', {
    method: 'POST',
    body: { enabledProviders: ['huggingface', 'localmaxxing'], flushCache: true, reason: 'pirateface outage test' },
  });
  const res = await request({ url: '/v1/discovery/models?q=qwen' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.items.every((entry) => entry.provider !== 'pirateface'));
  const report = body.providers.find((entry) => entry.provider === 'pirateface');
  assert.equal(report.status, 'skipped');
  assert.equal(report.code, 'operator_disabled');
});

// ---- Integration: cache path --------------------------------------------------------

test('cache: second identical discovery request is served from cache', async () => {
  const { request } = await adminSetup();
  const first = await request({ url: '/v1/discovery/models?q=qwen' });
  assert.equal(first.statusCode, 200);
  assert.notEqual(first.json().cached, true);
  const second = await request({ url: '/v1/discovery/models?q=qwen' });
  assert.equal(second.json().cached, true);
  assert.deepEqual(second.json().items.map((entry) => entry.id), first.json().items.map((entry) => entry.id));
});

test('cache: adding a block rotates the fingerprint — no stale page served', async () => {
  const { request, admin } = await adminSetup();
  await request({ url: '/v1/discovery/models?q=qwen' }); // warm cache
  const warm = await request({ url: '/v1/discovery/models?q=qwen' });
  assert.equal(warm.json().cached, true);

  await admin('/v1/admin/frostnet/moderation', {
    method: 'POST',
    body: { targetType: 'repo', targetValue: 'Qwen/Qwen3-0.6B', reason: 'cache rotation test' },
  });
  const after = await request({ url: '/v1/discovery/models?q=qwen' });
  assert.notEqual(after.json().cached, true, 'fingerprint change must miss the old cache entry');
  assert.ok(!after.json().items.some((entry) => entry.providerId === 'Qwen/Qwen3-0.6B'));
});

test('cache: different tiers never share a cache entry', async () => {
  const pro = await adminSetup({ tier: 'pro' });
  await pro.request({ url: '/v1/discovery/models?q=qwen' });
  // A free-tier caller on the same store must not receive the pro page.
  const freeRes = await pro.request({ url: '/v1/discovery/models?q=qwen', token: 'valid-token' });
  // Same uid is pro here; use a second harness sharing the store instead.
  assert.equal(freeRes.statusCode, 200);
  const { createApp } = await import('../src/app.js');
  const freeApp = createApp({
    store: pro.store,
    fetcher: pro.fetcher,
    now: () => FIXED_NOW,
    verifyIdToken: async () => ({ uid: 'free_user', email: 'free@example.com', email_verified: true }),
  });
  await pro.store.setUser('free_user', { uid: 'free_user', email: 'free@example.com', tier: 'free', disabled: false });
  const { makeRequest, makeResponse } = await import('./harness.js');
  const req = makeRequest({ url: '/v1/discovery/models?q=qwen', headers: { authorization: 'Bearer free-token' } });
  const res = makeResponse();
  await freeApp(req, res);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.tier, 'free');
  assert.notEqual(body.cached, true, 'free tier must not hit the pro cache entry');
});

test('cache: flushCache clears stored discovery pages', async () => {
  const { request, admin, store } = await adminSetup();
  await request({ url: '/v1/discovery/models?q=qwen' });
  const res = await admin('/v1/admin/frostnet/providers', {
    method: 'POST',
    body: { enabledProviders: ['huggingface', 'localmaxxing', 'pirateface'], flushCache: true, reason: 'flush test' },
  });
  assert.ok(res.json().cacheFlushed >= 1);
  const after = await request({ url: '/v1/discovery/models?q=qwen' });
  assert.notEqual(after.json().cached, true);
});
