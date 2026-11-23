/** Streaming SHA-256 for multi-GB weights: correct digest, bounded chunks,
 * cancellable, and never buffers the file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256File, HASH_CHUNK_BYTES } from '../src/main/file-hash.js';

test('small file digest matches crypto over the same bytes', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-hash-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'small.bin');
  const bytes = crypto.randomBytes(4096);
  await fsp.writeFile(file, bytes);
  assert.equal(await sha256File(file), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('empty file hashes to the SHA-256 of nothing', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-hash-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'empty.bin');
  await fsp.writeFile(file, '');
  assert.equal(await sha256File(file), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('80MB file: correct digest and no read chunk exceeds the fixed bound', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-hash-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'big.bin');
  const block = crypto.randomBytes(1024 * 1024);
  const expected = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'w');
  for (let i = 0; i < 80; i++) { fs.writeSync(fd, block); expected.update(block); }
  fs.closeSync(fd);
  // Instrument the stream factory to observe every emitted chunk size.
  let maxChunk = 0, requested = null;
  const real = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (p, options) => {
    requested = options?.highWaterMark;
    const stream = real(p, options);
    stream.on('data', c => { maxChunk = Math.max(maxChunk, c.length); });
    return stream;
  });
  assert.equal(await sha256File(file), expected.digest('hex'));
  assert.ok(requested > 0 && requested <= HASH_CHUNK_BYTES, 'explicit bounded highWaterMark');
  assert.ok(maxChunk > 0 && maxChunk <= HASH_CHUNK_BYTES, `max chunk ${maxChunk} within bound`);
});

test('aborting the signal rejects and does not resolve a digest', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-hash-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'abort.bin');
  await fsp.writeFile(file, crypto.randomBytes(8 * 1024 * 1024));
  const controller = new AbortController();
  const promise = sha256File(file, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise);
});

test('missing file rejects with the read error', async () => {
  await assert.rejects(sha256File(path.join(os.tmpdir(), 'fb-hash-missing-98765.bin')));
});
