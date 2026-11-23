import test from 'node:test';
import assert from 'node:assert/strict';

import * as huggingface from '../src/providers/huggingface.js';
import * as localmaxxing from '../src/providers/localmaxxing.js';
import * as pirateface from '../src/providers/pirateface.js';
import { extractQuant, formatParams, normalizeModel } from '../src/providers/model.js';
import { fakeFetcher, PROVIDER_FIXTURES } from './harness.js';

test('huggingface normalizes a real record', async () => {
  const fetcher = fakeFetcher({ 'huggingface.co': PROVIDER_FIXTURES.huggingface });
  const result = await huggingface.search({ query: 'qwen3', limit: 20, fetcher });

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.provider, 'huggingface');
  assert.equal(item.providerId, 'Qwen/Qwen3-0.6B');
  assert.equal(item.id, 'huggingface:Qwen/Qwen3-0.6B');
  assert.equal(item.author, 'Qwen');
  assert.equal(item.downloads, 30073785);
  assert.equal(item.likes, 1826);
  assert.equal(item.task, 'text-generation');
  assert.equal(item.license, 'apache-2.0');
  assert.equal(item.urls.page, 'https://huggingface.co/Qwen/Qwen3-0.6B');
});

test('huggingface builds the expected query string', () => {
  const url = new URL(huggingface.buildUrl({ query: 'qwen 3', limit: 10, offset: 20, sort: 'likes' }));
  assert.equal(url.searchParams.get('search'), 'qwen 3');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('skip'), '20');
  assert.equal(url.searchParams.get('sort'), 'likes');
  assert.equal(url.searchParams.get('direction'), '-1');
});

test('huggingface rejects an unexpected envelope', async () => {
  const fetcher = fakeFetcher({ 'huggingface.co': { models: [] } });
  await assert.rejects(() => huggingface.search({ fetcher }), /unexpected envelope/);
});

test('localmaxxing parses tags from a JSON string', async () => {
  const fetcher = fakeFetcher({ 'localmaxxing.com': PROVIDER_FIXTURES.localmaxxing });
  const result = await localmaxxing.search({ query: 'qwen', fetcher });

  const item = result.items[0];
  assert.deepEqual(item.tags, ['ninfer', 'capy-flash', 'nvfp4']);
  assert.equal(item.author, 'Feyd89');
  assert.equal(item.meta.isMoE, true);
  assert.equal(item.meta.benchmarkRuns, 1);
  assert.equal(item.meta.baseModel, 'nvidia/Qwen3.8-Flash-Next-NVFP4');
});

test('localmaxxing converts params from billions to a raw count', async () => {
  const fetcher = fakeFetcher({ 'localmaxxing.com': PROVIDER_FIXTURES.localmaxxing });
  const result = await localmaxxing.search({ fetcher });
  assert.equal(result.items[0].parameterCount, 180_000_000_000);
  assert.equal(result.items[0].parameterLabel, '180B');
});

test('localmaxxing survives malformed tags without throwing', async () => {
  const fetcher = fakeFetcher({
    'localmaxxing.com': [{ id: 'x', hfId: 'a/b', tags: 'not json{{', params: 7 }],
  });
  const result = await localmaxxing.search({ fetcher });
  assert.deepEqual(result.items[0].tags, []);
});

test('pirateface uses the q parameter and returns a cursor', async () => {
  const fetcher = fakeFetcher({ 'pirateface.co': PROVIDER_FIXTURES.pirateface });
  const result = await pirateface.search({ query: 'qwen', limit: 5, fetcher });

  assert.equal(result.nextCursor, 'eyIkb3IiOlt7InRyZW5kaW5nU2NvcmUiOjU1fV19');
  assert.equal(fetcher.calls[0].includes('q=qwen'), true);
  assert.equal(fetcher.calls[0].includes('search='), false);
});

test('pirateface normalizes the model record', async () => {
  const fetcher = fakeFetcher({ 'pirateface.co': PROVIDER_FIXTURES.pirateface });
  const result = await pirateface.search({ fetcher });
  const item = result.items[0];

  assert.equal(item.providerId, 'Qwen/Qwen3.8-27B');
  assert.equal(item.parameterCount, 27781427952);
  assert.equal(item.parameterLabel, '27.8B');
  assert.equal(item.sizeBytes, 55562855904);
  assert.equal(item.meta.seeded, true);
  assert.equal(item.meta.seeders, 32);
});

test('pirateface rejects an unexpected envelope', async () => {
  const fetcher = fakeFetcher({ 'pirateface.co': [{ id: 'x' }] });
  await assert.rejects(() => pirateface.search({ fetcher }), /unexpected envelope/);
});

test('normalizeModel rejects an unknown provider', () => {
  assert.throws(() => normalizeModel({ provider: 'nope', providerId: 'x' }), /Unknown provider/);
});

test('normalizeModel requires a providerId', () => {
  assert.throws(() => normalizeModel({ provider: 'huggingface' }), /providerId/);
});

test('normalizeModel strips control characters', () => {
  const item = normalizeModel({
    provider: 'huggingface',
    providerId: 'a/b',
    name: 'bad\u0000name\u001f',
  });
  assert.equal(item.name, 'badname');
});

test('normalizeModel coerces negative counters to zero', () => {
  const item = normalizeModel({ provider: 'huggingface', providerId: 'a/b', downloads: -5, likes: 'x' });
  assert.equal(item.downloads, 0);
  assert.equal(item.likes, 0);
});

test('extractQuant preserves the exact token spelling', () => {
  assert.equal(extractQuant('Qwen3-8B-Q4_K_M-GGUF'), 'Q4_K_M');
  assert.equal(extractQuant('model-IQ2_XXS'), 'IQ2_XXS');
  assert.equal(extractQuant('Qwen3.8-Flash-Next-NVFP4'), 'NVFP4');
  assert.equal(extractQuant('plain-model'), '');
});

test('extractQuant does not lowercase', () => {
  assert.equal(extractQuant('x-Q4_K_M'), 'Q4_K_M');
  assert.notEqual(extractQuant('x-Q4_K_M'), 'q4_k_m');
});

test('formatParams renders human labels', () => {
  assert.equal(formatParams(27781427952), '27.8B');
  assert.equal(formatParams(180_000_000_000), '180B');
  assert.equal(formatParams(1_500_000), '1.5M');
  assert.equal(formatParams(0), '');
  assert.equal(formatParams(null), '');
});