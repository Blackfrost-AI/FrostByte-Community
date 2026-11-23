import test from 'node:test';
import assert from 'node:assert/strict';

import { discover, encodeCursor, decodeCursor, sanitizeQuery } from '../src/discovery.js';
import { fakeFetcher, PROVIDER_FIXTURES } from './harness.js';

// Cursors are HMAC-signed; the suite supplies its own key rather than reading
// Secret Manager.
process.env.HUB_CURSOR_SECRET ||= 'test-cursor-secret-value-at-least-32-chars-long';

const allRoutes = {
  'huggingface.co': PROVIDER_FIXTURES.huggingface,
  'localmaxxing.com': PROVIDER_FIXTURES.localmaxxing,
  'pirateface.co': PROVIDER_FIXTURES.pirateface,
};

test('free tier queries only huggingface', async () => {
  const fetcher = fakeFetcher(allRoutes);
  const result = await discover({ query: 'qwen', tier: 'free', fetcher });

  assert.equal(fetcher.calls.length, 1);
  assert.ok(fetcher.calls[0].includes('huggingface.co'));

  const skipped = result.providers.filter((report) => report.status === 'skipped');
  assert.deepEqual(skipped.map((report) => report.provider).sort(), ['localmaxxing', 'pirateface']);
  assert.equal(skipped[0].code, 'plan_required');
});

test('pro tier queries all three providers', async () => {
  const fetcher = fakeFetcher(allRoutes);
  const result = await discover({ query: 'qwen', tier: 'pro', fetcher });

  assert.equal(fetcher.calls.length, 3);
  assert.equal(result.providers.filter((report) => report.status === 'ok').length, 3);
});

test('results merge and deduplicate by id', async () => {
  const duplicate = { ...PROVIDER_FIXTURES.pirateface.models[0], id: 'Qwen/Qwen3-0.6B' };
  const fetcher = fakeFetcher({
    ...allRoutes,
    'pirateface.co': { models: [duplicate], nextCursor: null },
  });

  const result = await discover({ query: 'qwen', tier: 'pro', fetcher });
  const ids = result.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a failing provider degrades to a labelled partial result', async () => {
  const fetcher = fakeFetcher({
    'huggingface.co': PROVIDER_FIXTURES.huggingface,
    'localmaxxing.com': () => {
      throw new Error('boom');
    },
    'pirateface.co': PROVIDER_FIXTURES.pirateface,
  });

  const result = await discover({ query: 'qwen', tier: 'pro', fetcher });
  const failed = result.providers.find((report) => report.provider === 'localmaxxing');

  assert.equal(failed.status, 'error');
  assert.equal(result.items.length >= 2, true);
});

test('all providers failing raises a 502', async () => {
  const fetcher = fakeFetcher({
    'huggingface.co': () => {
      throw new Error('boom');
    },
  });

  await assert.rejects(
    () => discover({ query: 'qwen', tier: 'free', fetcher }),
    (error) => error.status === 502 && error.code === 'upstream_unavailable',
  );
});

test('an unknown provider is a 400', async () => {
  const fetcher = fakeFetcher(allRoutes);
  await assert.rejects(
    () => discover({ tier: 'pro', providers: 'huggingface,nope', fetcher }),
    (error) => error.status === 400,
  );
});

test('page size is clamped to the tier ceiling', async () => {
  const fetcher = fakeFetcher(allRoutes);
  const free = await discover({ tier: 'free', limit: 1000, fetcher });
  assert.equal(free.pageSize, 25);

  const pro = await discover({ tier: 'pro', limit: 1000, fetcher });
  assert.equal(pro.pageSize, 100);
});

test('items are sorted by downloads then likes', async () => {
  const fetcher = fakeFetcher({
    'huggingface.co': [
      { id: 'a/low', downloads: 1, likes: 0, tags: [] },
      { id: 'a/high', downloads: 999, likes: 0, tags: [] },
    ],
  });

  const result = await discover({ tier: 'free', fetcher });
  assert.deepEqual(result.items.map((item) => item.providerId), ['a/high', 'a/low']);
});

test('cursor round-trips offsets and provider cursors', () => {
  const bindings = { query: 'qwen', tier: 'pro', providers: ['huggingface', 'pirateface'] };
  const encoded = encodeCursor(
    { offsets: { huggingface: 40, localmaxxing: 0 }, cursors: { pirateface: 'abc123' } },
    bindings,
  );
  const decoded = decodeCursor(encoded, bindings);

  assert.deepEqual(decoded.offsets, { huggingface: 40 });
  assert.deepEqual(decoded.cursors, { pirateface: 'abc123' });
});

test('cursor is opaque base64url plus a signature, not readable JSON', () => {
  const encoded = encodeCursor({ offsets: { huggingface: 10 } }, { query: 'x', tier: 'free' });
  assert.equal(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(encoded), true);
  assert.equal(encoded.includes('{'), false);
});

test('a forged cursor without a valid signature is rejected', () => {
  const bindings = { query: 'qwen', tier: 'pro', providers: ['huggingface'] };
  const real = encodeCursor({ offsets: { huggingface: 40 } }, bindings);
  const [body] = real.split('.');
  const forgedBody = Buffer.from(
    JSON.stringify({ v: 1, o: { huggingface: 99999 }, c: {}, b: JSON.parse(Buffer.from(body, 'base64url').toString()).b }),
  ).toString('base64url');

  assert.throws(
    () => decodeCursor(`${forgedBody}.${'A'.repeat(43)}`, bindings),
    (error) => error.status === 400,
  );
});

test('a cursor is bound to its query', () => {
  const bindings = { query: 'qwen', tier: 'pro', providers: ['huggingface'] };
  const encoded = encodeCursor({ offsets: { huggingface: 20 } }, bindings);

  assert.throws(
    () => decodeCursor(encoded, { query: 'llama', tier: 'pro', providers: ['huggingface'] }),
    /does not match this query/,
  );
});

test('a cursor is bound to its tier', () => {
  const encoded = encodeCursor({ offsets: { huggingface: 20 } }, { query: 'q', tier: 'free', providers: ['huggingface'] });
  assert.throws(
    () => decodeCursor(encoded, { query: 'q', tier: 'pro', providers: ['huggingface'] }),
    /does not match this query/,
  );
});

test('a cursor cannot smuggle an unknown provider key', () => {
  const bindings = { query: 'q', tier: 'pro', providers: ['huggingface'] };
  const encoded = encodeCursor({ offsets: { huggingface: 5 }, cursors: {} }, bindings);
  const decoded = decodeCursor(encoded, bindings);
  assert.deepEqual(Object.keys(decoded.offsets), ['huggingface']);
});

test('a malformed cursor is a 400, not a crash', () => {
  for (const bad of ['!!!', 'eyJ2Ijo5OX0', 'a.b', `${'A'.repeat(10)}.${'B'.repeat(43)}`]) {
    assert.throws(() => decodeCursor(bad, { query: 'q', tier: 'free', providers: [] }), (error) => error.status === 400);
  }
});

test('an empty cursor is an empty state', () => {
  assert.deepEqual(decodeCursor(''), { offsets: {}, cursors: {} });
  assert.deepEqual(decodeCursor(undefined), { offsets: {}, cursors: {} });
});

test('sanitizeQuery bounds length and strips control characters', () => {
  assert.equal(sanitizeQuery('  qwen  '), 'qwen');
  assert.equal(sanitizeQuery('a\u0000b'), 'a b');
  assert.equal(sanitizeQuery('x'.repeat(500)).length, 200);
  assert.equal(sanitizeQuery(null), '');
});

test('an explicit provider subset is honoured', async () => {
  const fetcher = fakeFetcher(allRoutes);
  const result = await discover({ tier: 'pro', providers: 'pirateface', fetcher });

  assert.equal(fetcher.calls.length, 1);
  assert.ok(fetcher.calls[0].includes('pirateface.co'));
  assert.equal(result.providers.length, 1);
});

test('a free caller asking only for pirateface gets a skipped report, not an error', async () => {
  const fetcher = fakeFetcher(allRoutes);
  const result = await discover({ tier: 'free', providers: 'pirateface', fetcher });

  assert.equal(result.items.length, 0);
  assert.equal(result.providers[0].status, 'skipped');
  assert.equal(result.providers[0].code, 'plan_required');
});