/**
 * Headless HF integration test — hits the real HuggingFace API (public
 * endpoints only; no token needed). Verifies the wire facts the module is
 * built on and the downloader's full/partial/resume paths.
 *
 * Run: npm run test:hf
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hfSearch, hfModelInfo, hfWhoami, hfDownloadFile, hfStatFile, sha256File, HfAuthError } from '../src/main/hf.js';
import crypto from 'node:crypto';

const cryptoHash = (u8) => crypto.createHash('sha256').update(u8).digest('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hf-'));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[  ok  ] ${name}`); }
  catch (e) { failed++; console.log(`[ FAIL ] ${name}\n        ${e.message}`); }
}

console.log('--- HuggingFace API (live, public) ---');

await test('search returns shaped results', async () => {
  const rows = await hfSearch('qwen3 gguf', { limit: 5 });
  assert.ok(Array.isArray(rows) && rows.length > 0, 'no results');
  const r = rows[0];
  assert.ok(r.id.includes('/'), 'id should be org/name');
  assert.equal(typeof r.downloads, 'number');
  assert.equal(typeof r.likes, 'number');
  assert.ok(r.license.length > 0, 'license parsed from tags');
});

await test('model info: pinned sha, gated flag, file sizes', async () => {
  const m = await hfModelInfo('Qwen/Qwen3-0.6B');
  assert.match(m.sha, /^[a-f0-9]{40}$/, 'commit sha for revision pinning');
  assert.equal(m.gated, false);
  const cfg = m.files.find((f) => f.path === 'config.json');
  assert.ok(cfg && cfg.size > 0, 'blobs=true carries sizes');
});

await test('stat file: etag + content-length', async () => {
  const s = await hfStatFile({ repoId: 'Qwen/Qwen3-0.6B', revision: 'main', filePath: 'config.json' });
  assert.ok(s.etag.length >= 8, 'etag present');
  assert.ok(s.size === 726 || s.size > 0, 'size present');
});

console.log('\n--- downloader ---');

await test('small file downloads intact (sha256 vs direct fetch)', async () => {
  const dest = path.join(tmp, 'qwen', 'config.json');
  const r = await hfDownloadFile({ repoId: 'Qwen/Qwen3-0.6B', filePath: 'config.json', dest, approvedRoot: tmp });
  assert.equal(r.partial, false);
  assert.equal(fs.existsSync(dest), true);
  assert.equal(fs.existsSync(dest + '.frostpart'), false, 'part file cleaned up');

  const direct = await (await fetch('https://huggingface.co/Qwen/Qwen3-0.6B/resolve/main/config.json')).arrayBuffer();
  assert.equal(
    await sha256File(dest),
    cryptoHash(new Uint8Array(direct)),
    'byte-for-byte identical to a direct fetch',
  );
});

await test('interrupted download resumes and finishes with identical bytes', async () => {
  const dest = path.join(tmp, 'resume', 'merges.txt'); // 1.6 MB — big enough to interrupt
  const info = await hfModelInfo('Qwen/Qwen3-0.6B');

  const ac = new AbortController();
  let sawProgress = false;
  // Take ~100 KB then abort.
  const r1 = await hfDownloadFile({
    repoId: 'Qwen/Qwen3-0.6B', filePath: 'merges.txt', dest, approvedRoot: tmp,
    signal: ac.signal, maxBytes: 100 * 1024,
    onProgress: () => { sawProgress = true; },
  }).catch((e) => { if (e.name !== 'AbortError') throw e; return { partial: true }; });
  assert.ok(r1.partial !== false || sawProgress, 'partial or progressing');
  assert.ok(fs.existsSync(dest + '.frostpart'), 'part file exists mid-download');
  assert.ok(fs.existsSync(dest + '.frostpart.json'), 'resume sidecar exists');

  const grew = fs.statSync(dest + '.frostpart').size;
  const r2 = await hfDownloadFile({ repoId: 'Qwen/Qwen3-0.6B', filePath: 'merges.txt', dest, approvedRoot: tmp });
  assert.equal(r2.partial, false, 'resumed download completes');

  const expected = info.files.find((f) => f.path === 'merges.txt').size;
  assert.equal(fs.statSync(dest).size, expected, 'final size matches listing');
  assert.ok(grew < expected, `resumed from ${grew} of ${expected}`);

  const direct = await (await fetch('https://huggingface.co/Qwen/Qwen3-0.6B/resolve/main/merges.txt')).arrayBuffer();
  assert.equal(await sha256File(dest), cryptoHash(new Uint8Array(direct)), 'resumed bytes identical');
});

await test('foreign resume metadata is preserved instead of overwritten', async () => {
  const dest = path.join(tmp, 'stale', 'config.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = Buffer.alloc(200, 1), sidecar = JSON.stringify({ etag: 'bogus-etag', total: 200 });
  fs.writeFileSync(dest + '.frostpart', part);
  fs.writeFileSync(dest + '.frostpart.json', sidecar);
  await assert.rejects(
    hfDownloadFile({ repoId: 'Qwen/Qwen3-0.6B', filePath: 'config.json', dest, approvedRoot: tmp }),
    /sidecar is invalid.*preserved/i,
  );
  assert.deepEqual(fs.readFileSync(dest + '.frostpart'), part);
  assert.equal(fs.readFileSync(dest + '.frostpart.json', 'utf8'), sidecar);
});

console.log('\n--- auth paths ---');

await test('gated file without token → HfAuthError 401', async () => {
  await assert.rejects(
    () => hfDownloadFile({ repoId: 'meta-llama/Llama-3.2-1B', filePath: 'config.json', dest: path.join(tmp, 'g.json'), approvedRoot: tmp }),
    (e) => e instanceof HfAuthError && e.status === 401,
  );
});

await test('invalid token → whoami says invalid, does not throw', async () => {
  const r = await hfWhoami('hf_invalid_token_for_tests');
  assert.equal(r.valid, false);
});

await test('gated repo metadata stays public', async () => {
  const m = await hfModelInfo('meta-llama/Llama-3.2-1B');
  assert.equal(m.gated, 'manual');
  assert.match(m.sha, /^[a-f0-9]{40}$/);
});

console.log(`\n${failed === 0 ? 'ALL HF TESTS PASSED' : `${failed} FAILED, ${passed} passed`}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
