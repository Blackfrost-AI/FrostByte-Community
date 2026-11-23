/** Layer 3 — anchor local model bytes to the publisher's HuggingFace hashes.
 * Three-state: matches-upstream / differs / unknown. Zero comparable files is
 * NEVER a match. Source identity comes from the AEON card, pinned to HF hosts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyAgainstUpstream, upstreamRepoFromSource } from '../src/main/upstream-verify.js';
import { HfNotFoundError, HfAuthError } from '../src/main/hf.js';

const SHA = 'a'.repeat(64);

async function library(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-upstream-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rows = [];
  for (const [rel, bytes] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
    rows.push({ relative: rel, size: bytes.length });
  }
  return { root, files: rows };
}
const item = (lib, card) => ({ path: lib.root, files: lib.files, card });
const card = source => ({ source });
const hashes = entries => async () => new Map(entries);

test('source identity: exact HF host and repo shape only', () => {
  assert.deepEqual(upstreamRepoFromSource('https://huggingface.co/org/model'), { repoId: 'org/model', revision: undefined });
  assert.deepEqual(upstreamRepoFromSource('https://huggingface.co/org/model/resolve/abc123/model.gguf'), { repoId: 'org/model', revision: 'abc123' });
  assert.equal(upstreamRepoFromSource('https://huggingface.co.evil.example/org/model'), null);
  assert.equal(upstreamRepoFromSource('https://evil.example/org/model'), null);
  assert.equal(upstreamRepoFromSource('http://huggingface.co/org/model'), null);
  assert.equal(upstreamRepoFromSource('https://huggingface.co/org/model/../../admin'), null);
  assert.equal(upstreamRepoFromSource('https://huggingface.co/onlyowner'), null);
  assert.equal(upstreamRepoFromSource('torrent:magnet'), null);
  assert.equal(upstreamRepoFromSource(''), null);
  assert.equal(upstreamRepoFromSource(undefined), null);
});

test('all comparable hashes match → matches-upstream with tallies', async t => {
  const lib = await library(t, { 'model.gguf': Buffer.from('weights'), 'config.json': Buffer.from('{}') });
  const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), {
    getUpstreamHashes: hashes([['model.gguf', SHA], ['config.json', null]]),
    sha256File: async () => SHA,
  });
  assert.deepEqual(result, { verdict: 'matches-upstream', compared: 1, missing: 1, mismatches: [], repoId: 'org/model' });
});

test('one mismatch → differs, naming the path', async t => {
  const lib = await library(t, { 'model.gguf': Buffer.from('weights'), 'other.gguf': Buffer.from('other') });
  const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), {
    getUpstreamHashes: hashes([['model.gguf', SHA], ['other.gguf', 'b'.repeat(64)]]),
    sha256File: async file => file.endsWith('other.gguf') ? 'c'.repeat(64) : SHA,
  });
  assert.equal(result.verdict, 'differs');
  assert.deepEqual(result.mismatches, ['other.gguf']);
  assert.equal(result.compared, 2);
});

test('nothing comparable → unknown, never matches-upstream', async t => {
  const lib = await library(t, { 'config.json': Buffer.from('{}') });
  const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), {
    getUpstreamHashes: hashes([['config.json', null]]),
    sha256File: async () => SHA,
  });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.compared, 0);
  assert.equal(result.missing, 1);
});

test('local files absent from the upstream map count as missing, not matches', async t => {
  const lib = await library(t, { 'extra.gguf': Buffer.from('x'), 'model.gguf': Buffer.from('w') });
  const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), {
    getUpstreamHashes: hashes([['model.gguf', SHA]]),
    sha256File: async () => SHA,
  });
  assert.equal(result.verdict, 'matches-upstream');
  assert.equal(result.compared, 1);
  assert.equal(result.missing, 1); // extra.gguf has no upstream anchor
  const onlyExtra = await verifyAgainstUpstream(item(await library(t, { 'extra.gguf': Buffer.from('x') }), card('https://huggingface.co/org/model')), {
    getUpstreamHashes: hashes([['model.gguf', SHA]]),
    sha256File: async () => SHA,
  });
  assert.equal(onlyExtra.verdict, 'unknown');
});

test('repo 404 or gated → unknown (typed errors are absorbed, not leaked)', async t => {
  const lib = await library(t, { 'model.gguf': Buffer.from('w') });
  for (const error of [new HfNotFoundError('gone', 404), new HfAuthError('gated', 403), new Error('offline')]) {
    const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), {
      getUpstreamHashes: async () => { throw error; },
      sha256File: async () => SHA,
    });
    assert.equal(result.verdict, 'unknown');
    assert.equal(result.compared, 0);
  }
});

test('no card / non-HF source → unknown without any network call', async t => {
  const lib = await library(t, { 'model.gguf': Buffer.from('w') });
  const getUpstreamHashes = async () => { throw new Error('must never run'); };
  for (const c of [undefined, card('torrent:abc'), card('https://evil.example/org/model')]) {
    const result = await verifyAgainstUpstream(item(lib, c), { getUpstreamHashes, sha256File: async () => SHA });
    assert.equal(result.verdict, 'unknown');
  }
});

test('a file that cannot be hashed locally is unknown overall, never a silent match', async t => {
  const lib = await library(t, { 'model.gguf': Buffer.from('w'), 'broken.gguf': Buffer.from('b') });
  const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), {
    getUpstreamHashes: hashes([['model.gguf', SHA], ['broken.gguf', SHA]]),
    sha256File: async file => { if (file.endsWith('broken.gguf')) throw new Error('EIO'); return SHA; },
  });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.compared, 1);
});

test('revision from a resolve URL is passed to the fetcher', async t => {
  const lib = await library(t, { 'model.gguf': Buffer.from('w') });
  let seen;
  const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model/resolve/abc123/model.gguf')), {
    getUpstreamHashes: async (repoId, options) => { seen = { repoId, revision: options.revision }; return new Map([['model.gguf', SHA]]); },
    sha256File: async () => SHA,
  });
  assert.deepEqual(seen, { repoId: 'org/model', revision: 'abc123' });
  assert.equal(result.verdict, 'matches-upstream');
});

test('end-to-end with real hashing: matching bytes pass, tampered bytes differ', async t => {
  const bytes = crypto.randomBytes(64 * 1024);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const lib = await library(t, { 'model.gguf': bytes });
  const ok = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), { getUpstreamHashes: hashes([['model.gguf', sha]]) });
  assert.equal(ok.verdict, 'matches-upstream');
  await fs.writeFile(path.join(lib.root, 'model.gguf'), Buffer.concat([bytes, Buffer.from('!')]));
  const bad = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), { getUpstreamHashes: hashes([['model.gguf', sha]]) });
  assert.equal(bad.verdict, 'differs');
  assert.deepEqual(bad.mismatches, ['model.gguf']);
});

test('mismatch list is bounded for hostile file counts', async t => {
  const files = {};
  for (let i = 0; i < 60; i++) files[`f${i}.gguf`] = Buffer.from('x');
  const lib = await library(t, files);
  const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), {
    getUpstreamHashes: hashes(Object.keys(files).map(p => [p, SHA])),
    sha256File: async () => 'd'.repeat(64),
  });
  assert.equal(result.verdict, 'differs');
  assert.ok(result.mismatches.length <= 50);
  assert.equal(result.compared, 60);
});

test('unknown anchor carries the repo identity for the UI', async t => {
  const lib = await library(t, { 'model.gguf': Buffer.from('weights') });
  const result = await verifyAgainstUpstream(item(lib, card('https://huggingface.co/org/model')), {
    getUpstreamHashes: hashes([['model.gguf', null]]),
    sha256File: async () => SHA,
  });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.repoId, 'org/model');
});
