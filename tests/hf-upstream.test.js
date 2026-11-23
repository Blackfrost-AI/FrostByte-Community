/** Upstream hash fetcher: path → sha256|null from the Hub, typed errors for
 * missing/gated repos, and the same fetch hardening as the rest of hf.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getUpstreamHashes, HfAuthError, HfNotFoundError } from '../src/main/hf.js';

const SHA = 'a'.repeat(64);
const withFetch = async (impl, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
};

test('LFS files map to sha256, non-LFS files map to null, revision is pinned', async () => {
  const urls = [];
  await withFetch(async (url, options) => {
    urls.push({ url: new URL(url), options });
    return new Response(JSON.stringify({
      sha: 'b'.repeat(40),
      siblings: [
        { rfilename: 'model.gguf', size: 10, lfs: { sha256: SHA.toUpperCase() } },
        { rfilename: 'config.json', size: 12 },
        { rfilename: 'sub/weights.safetensors', size: 20, lfs: { sha256: 'c'.repeat(64) } },
      ],
    }));
  }, async () => {
    const map = await getUpstreamHashes('owner/model', { revision: 'abc123' });
    assert.ok(map instanceof Map);
    assert.equal(map.get('model.gguf'), SHA); // normalized lowercase
    assert.equal(map.get('config.json'), null);
    assert.equal(map.get('sub/weights.safetensors'), 'c'.repeat(64));
    assert.equal(map.size, 3);
    assert.equal(urls[0].url.pathname, '/api/models/owner/model/revision/abc123');
    assert.equal(urls[0].url.searchParams.get('blobs'), 'true');
    assert.equal(urls[0].options.redirect, 'error'); // no token-bearing redirects
  });
});

test('malformed lfs values become null, hostile paths are dropped', async () => {
  await withFetch(async () => new Response(JSON.stringify({
    siblings: [
      { rfilename: 'a.gguf', lfs: { sha256: 'not-a-hash' } },
      { rfilename: 'b.gguf', lfs: { sha256: 42 } },
      { rfilename: '../escape.gguf', lfs: { sha256: SHA } },
      { rfilename: 'ok.gguf', lfs: { sha256: SHA } },
    ],
  })), async () => {
    const map = await getUpstreamHashes('owner/model');
    assert.equal(map.get('a.gguf'), null);
    assert.equal(map.get('b.gguf'), null);
    assert.equal(map.has('../escape.gguf'), false);
    assert.equal(map.get('ok.gguf'), SHA);
    assert.equal(map.size, 3);
  });
});

test('404 repo throws typed HfNotFoundError', async () => {
  await withFetch(async () => new Response('', { status: 404 }), async () => {
    await assert.rejects(getUpstreamHashes('owner/missing'), err => err instanceof HfNotFoundError && err.status === 404);
  });
});

test('gated/private repos throw typed HfAuthError with the status', async () => {
  for (const status of [401, 403]) {
    await withFetch(async () => new Response('', { status }), async () => {
      await assert.rejects(getUpstreamHashes('owner/gated'), err => err instanceof HfAuthError && err.status === status);
    });
  }
});

test('invalid repo ids are rejected before any network call', async () => {
  await withFetch(async () => { throw new Error('must never run'); }, async () => {
    await assert.rejects(getUpstreamHashes('../admin'), /repository/i);
    await assert.rejects(getUpstreamHashes('owner/model', { revision: 'bad\nrev' }), /version/i);
  });
});

test('token is sent as bearer auth only to the pinned Hub API URL', async () => {
  await withFetch(async (url, options) => {
    assert.equal(new URL(url).hostname, 'huggingface.co');
    assert.equal(options.headers.Authorization, 'Bearer hf_test_token');
    return new Response(JSON.stringify({ siblings: [] }));
  }, async () => {
    const map = await getUpstreamHashes('owner/model', { token: 'hf_test_token' });
    assert.equal(map.size, 0);
  });
});
