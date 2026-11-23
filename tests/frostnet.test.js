import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApi, MemoryDirectory } from '../frostnet/functions/api.js';
import { validateRelease, FROSTNET_TERMS } from '../src/shared/release-manifest.js';
import { manifestDigest } from '../src/main/publications.js';
const token = 'fn_' + 'fixture'.repeat(8), tokenHash = createHash('sha256').update(token).digest('hex');
const manifest = () => validateRelease({ schema: 'frostbyte.release', version: 1, publisher: 'blackfrost', release: 'tiny-v1', variant: 'gguf', name: 'Tiny Fixture', origin: 'original', files: [{ path: 'tiny.gguf', size: 4, sha256: 'a'.repeat(64) }], license: { id: 'MIT', statement: 'Original test bytes.' }, torrent: { infohash_v1: 'b'.repeat(40), metainfo_sha256: 'c'.repeat(64), piece_length: 16384 }, verified_at: '2026-10-10T00:00:00Z', redistribution_confirmed: true });
async function call(api, url, { method = 'GET', body, auth = false } = {}) {
  let output = ''; const res = { statusCode: 200, setHeader() {}, end(text) { output = text; } };
  await api({ url, method, body, headers: { ...(auth ? { authorization: 'Bearer ' + token } : {}) } }, res);
  return { status: res.statusCode, data: JSON.parse(output) };
}
test('directory submits, finds exact variants, serves immutable metadata, withdraws and restores from backup', async () => {
  const storage = new MemoryDirectory(), api = createApi({ storage, tokenHash: () => tokenHash });
  const value = manifest(), digest = manifestDigest(value), body = { idempotency_key: 'd'.repeat(64), digest, manifest: value, terms: FROSTNET_TERMS };
  assert.equal((await call(api, '/v1/submissions', { method: 'POST', body })).status, 401);
  assert.equal((await call(api, '/v1/submissions', { method: 'POST', body, auth: true })).data.status, 'published');
  assert.equal((await call(api, '/v1/submissions', { method: 'POST', body, auth: true })).data.status, 'published'); assert.equal(storage.data.changes.length, 1);
  const result = (await call(api, '/v1/search?q=tiny')).data; assert.equal(result.items.length, 1); assert.equal(result.items[0].availability.status, 'unknown');
  assert.deepEqual((await call(api, '/v1/manifests/' + digest)).data, value);
  const restored = new MemoryDirectory(JSON.parse(JSON.stringify(storage.data))), restoredApi = createApi({ storage: restored, tokenHash: () => tokenHash });
  assert.equal((await call(restoredApi, '/v1/search?q=gguf')).data.items.length, 1);
  const withdrawal = await call(restoredApi, '/v1/releases/' + digest + '/withdraw', { method: 'POST', body: { ...body, idempotency_key: 'e'.repeat(64) }, auth: true }); assert.equal(withdrawal.data.status, 'withdrawn');
  assert.equal((await call(restoredApi, '/v1/search')).data.items.length, 0); assert.equal((await call(restoredApi, '/v1/releases/' + digest)).data.status, 'withdrawn');
  assert.equal((await call(restoredApi, '/v1/changes?cursor=1')).data.changes[0].status, 'withdrawn');
});
test('API rejects credential scope, digest conflicts, changed immutable variants, invalid terms and path traversal', async () => {
  const storage = new MemoryDirectory(), api = createApi({ storage, tokenHash: () => tokenHash }); const value = manifest(), digest = manifestDigest(value);
  const submit = body => call(api, '/v1/submissions', { method: 'POST', auth: true, body });
  const body = { idempotency_key: 'd'.repeat(64), digest, manifest: value, terms: FROSTNET_TERMS };
  assert.equal((await submit({ ...body, terms: 'wrong' })).status, 422);
  assert.equal((await submit({ ...body, digest: 'f'.repeat(64) })).status, 422);
  assert.equal((await submit({ ...body, manifest: { ...value, publisher: 'someone-else' } })).status, 403);
  assert.equal((await submit({ ...body, manifest: { ...value, files: [{ ...value.files[0], path: '../secret' }] } })).status, 422);
  await submit(body); const changed = { ...value, name: 'Changed' }; assert.equal((await submit({ ...body, idempotency_key: 'f'.repeat(64), manifest: changed, digest: manifestDigest(changed) })).status, 409);
  assert.equal((await call(api, '/v1/search?cursor=../')).status, 400);
});
