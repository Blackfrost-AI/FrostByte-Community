import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ONE_TIB_BYTES,
  PIRATEFACE_ORIGIN,
  buildCanonicalMagnet,
  extractMagnetProvenance,
  normalizePirateFaceQuery,
  parsePirateFaceLicenseRegistry,
  parsePirateFaceSearchText,
  parseSizeEstimateBytes,
  pirateFaceRepoTorrents,
  pirateFaceSearch,
  pirateFaceTorrentsEndpoint,
  resetPirateFaceLicenseCache,
  resolvePirateFaceLicenseNotice,
} from '../src/main/pirateface.js';
import { ConfirmationService } from '../src/main/confirmations.js';
import { pirateFaceBrowseReview, pirateFaceTermsReview } from '../src/main/native-review.js';

const HASH_A = '4065fc6dc7f3fa8fd6fbcfcec1bcdecdbb98ba93';
const HASH_B = '7154ff8f845e5c219a0d5b5ed6c98988276511a3';
const COMMIT_A = '8b5dadf2d9b842ef8f6a77e12aa90dc2a1f4ab12';

test('extractMagnetProvenance and buildCanonicalMagnet strip third-party trackers and webseeds while extracting HF commit', () => {
  const rawMagnet = `magnet:?xt=urn:btih:${HASH_A.toUpperCase()}&dn=Qwen_Qwen3-8B-MLX-4bit&tr=http%3A%2F%2Ftracker.pirateface.co%3A6969%2Fannounce&ws=https%3A%2F%2Fpirateface.co%2Fapi%2Fws%2FQwen%2FQwen3-8B-MLX-4bit%2F${COMMIT_A}%2F`;
  const prov = extractMagnetProvenance(rawMagnet, 'Qwen/Qwen3-8B-MLX-4bit');
  assert.equal(prov.infoHash, HASH_A);
  assert.equal(prov.revision, COMMIT_A);
  assert.deepEqual(prov.provenanceHosts, ['tracker.pirateface.co', 'pirateface.co']);
  assert.equal(prov.canonicalMagnet, `magnet:?xt=urn:btih:${HASH_A}&dn=Qwen%2FQwen3-8B-MLX-4bit`);
  assert.doesNotMatch(prov.canonicalMagnet, /[?&](tr|ws)=/i);

  // Base32 32-char btih normalizes to 40-char lowercase hex
  assert.equal(buildCanonicalMagnet('A'.repeat(32), 'Qwen/Qwen3-8B'), `magnet:?xt=urn:btih:${'0'.repeat(40)}&dn=Qwen%2FQwen3-8B`);
  assert.throws(() => extractMagnetProvenance('magnet:?xt=urn:btmh:1220deadbeef', 'Qwen/Qwen3-8B'), /infohash/i);
  assert.throws(() => extractMagnetProvenance('https://pirateface.co/not-a-magnet', 'Qwen/Qwen3-8B'), /Invalid magnet/i);
});

test('parsePirateFaceSearchText parses /s/<q> lines, strips discovery endpoints, deduplicates, and flags >1 TiB models', () => {
  const text = [
    `Qwen/Qwen3-8B-MLX-4bit  4.3 GB  14 seeds  magnet:?xt=urn:btih:${HASH_A}&dn=Qwen3&tr=http%3A%2F%2Ftracker.pirateface.co%3A6969%2Fannounce&ws=https%3A%2F%2Fpirateface.co%2Fapi%2Fws%2FQwen%2FQwen3-8B-MLX-4bit%2F${COMMIT_A}%2F`,
    `deepseek-ai/DeepSeek-V3.2-Full  1.3 TB  1 seed  magnet:?xt=urn:btih:${HASH_B}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`,
    // Duplicate repoId + infohash ignored
    `Qwen/Qwen3-8B-MLX-4bit  4.3 GB  99 seeds  magnet:?xt=urn:btih:${HASH_A}`,
    // Malformed repoId and non-matching lines ignored
    `../evil/model  1.0 GB  3 seeds  magnet:?xt=urn:btih:${HASH_A}`,
    'No torrents match "nothing"',
  ].join('\n');

  const rows = parsePirateFaceSearchText(text, { limit: 10 });
  assert.equal(rows.length, 2);

  assert.equal(rows[0].repoId, 'Qwen/Qwen3-8B-MLX-4bit');
  assert.equal(rows[0].author, 'Qwen');
  assert.equal(rows[0].name, 'Qwen3-8B-MLX-4bit');
  assert.equal(rows[0].seeds, 14);
  assert.equal(rows[0].revision, COMMIT_A);
  assert.equal(rows[0].infoHash, HASH_A);
  assert.equal(rows[0].exceedsOneTiB, false);
  assert.deepEqual(rows[0].provenanceHosts, ['tracker.pirateface.co', 'pirateface.co']);
  assert.equal(rows[0].canonicalMagnet, `magnet:?xt=urn:btih:${HASH_A}&dn=Qwen%2FQwen3-8B-MLX-4bit`);

  assert.equal(rows[1].repoId, 'deepseek-ai/DeepSeek-V3.2-Full');
  assert.equal(rows[1].seeds, 1);
  assert.equal(rows[1].exceedsOneTiB, true);
  assert.ok(rows[1].sizeBytes > ONE_TIB_BYTES);
  assert.equal(parseSizeEstimateBytes('1024 GiB'), ONE_TIB_BYTES);
});

test('query/endpoint normalizers and prototype-safe license registry reject unsafe inputs', () => {
  const q = normalizePirateFaceQuery('  qwen3   mlx ');
  assert.equal(q.normalized, 'qwen3 mlx');
  assert.equal(q.endpoint, `${PIRATEFACE_ORIGIN}/s/qwen3+mlx`);
  assert.throws(() => normalizePirateFaceQuery('bad\x00query'), /control characters/i);
  assert.throws(() => normalizePirateFaceQuery('x'.repeat(201)), /200 characters/i);

  const ep = pirateFaceTorrentsEndpoint('Qwen/Qwen3-8B', { quant: 'Q4_K_M', acceptTerms: 'llama3.3' });
  assert.equal(ep.endpoint, `${PIRATEFACE_ORIGIN}/api/torrents?repo=Qwen%2FQwen3-8B&quant=Q4_K_M&accept_terms=llama3.3`);
  for (const invalidRepo of ['', 'only-owner', '../owner/model', 'owner/../model', 'a/b/c']) {
    assert.throws(() => pirateFaceTorrentsEndpoint(invalidRepo));
  }
  assert.throws(() => pirateFaceTorrentsEndpoint('Qwen/Qwen3-8B', { quant: 'bad quant!' }));
  assert.throws(() => pirateFaceTorrentsEndpoint('Qwen/Qwen3-8B', { acceptTerms: 'llama&inject=1' }));

  const registry = parsePirateFaceLicenseRegistry({
    licenses: [
      { id: 'apache-2.0', name: 'Apache 2.0', acceptFirst: false },
      { id: 'llama3.3', name: 'Llama 3.3 Community License', acceptFirst: true },
    ],
    repoLicenses: Object.assign(Object.create({ 'prototype/polluted': 'llama3.3' }), {
      'Qwen/Qwen3-8B': 'apache-2.0',
    }),
  });
  assert.equal(registry.byRepoLower.has('prototype/polluted'), false);
  const known = resolvePirateFaceLicenseNotice('Qwen/Qwen3-8B', null, registry);
  assert.equal(known.kind, 'known');
  assert.equal(known.acceptFirst, false);

  const terms = resolvePirateFaceLicenseNotice('meta-llama/Llama-3.3-70B-Instruct', {
    id: 'llama3.3',
    name: 'Llama 3.3 Community License',
    termsUrl: 'https://llama.meta.com/llama3_3/license/',
    policyUrl: 'javascript:alert(1)',
    notice: 'Review upstream terms.',
  }, registry);
  assert.equal(terms.kind, 'terms-required');
  assert.equal(terms.acceptFirst, true);
  assert.equal(terms.termsUrl, 'https://llama.meta.com/llama3_3/license/');
  assert.equal(terms.policyUrl, '');
});

test('pirateFaceSearch and pirateFaceRepoTorrents enforce origin pinning, redirect:error, credentials:omit, manifest safety, and terms gating', async () => {
  resetPirateFaceLicenseCache();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url === `${PIRATEFACE_ORIGIN}/s/qwen3`) {
      return new Response(
        `Qwen/Qwen3-8B  4.3 GB  12 seeds  magnet:?xt=urn:btih:${HASH_A}&tr=http%3A%2F%2Ftracker.pirateface.co%3A6969%2Fannounce\n`,
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    if (url === `${PIRATEFACE_ORIGIN}/api/licenses`) {
      return new Response(
        JSON.stringify({
          licenses: [{ id: 'apache-2.0', name: 'Apache 2.0', acceptFirst: false }],
          repoLicenses: [{ repoId: 'Qwen/Qwen3-8B', license: 'apache-2.0' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === `${PIRATEFACE_ORIGIN}/api/torrents?repo=Qwen%2FQwen3-8B&quant=Q4_K_M`) {
      return new Response(
        JSON.stringify({
          repoId: 'Qwen/Qwen3-8B',
          revision: COMMIT_A,
          seeders: 12,
          leechers: 2,
          quant: 'Q4_K_M',
          infohash: HASH_B,
          magnet: `magnet:?xt=urn:btih:${HASH_B}&tr=http%3A%2F%2Ftracker.pirateface.co%3A6969%2Fannounce`,
          quants: [
            { quant: 'full', files: [{ path: 'model.safetensors', size: 8000 }] },
            { quant: 'Q4_K_M', files: [{ path: 'Qwen3-8B-Q4_K_M.gguf', size: 4096 }] },
          ],
          files: [{ path: 'Qwen3-8B-Q4_K_M.gguf', size: 4096, sha256: 'A'.repeat(64) }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith(`${PIRATEFACE_ORIGIN}/api/torrents?repo=meta-llama%2FLlama-3.3-70B-Instruct`)) {
      const hasTerms = url.includes('accept_terms=llama3.3');
      return new Response(
        JSON.stringify({
          repoId: 'meta-llama/Llama-3.3-70B-Instruct',
          seeders: 5,
          leechers: 0,
          magnet: hasTerms ? `magnet:?xt=urn:btih:${HASH_A}` : '',
          terms: {
            id: 'llama3.3',
            name: 'Llama 3.3 Community License',
            termsUrl: 'https://llama.meta.com/llama3_3/license/',
            notice: 'Must acknowledge terms.',
          },
          files: [{ path: 'model.safetensors', size: 1024 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  };

  const searchRes = await pirateFaceSearch('qwen3', { fetchImpl });
  assert.equal(searchRes.models.length, 1);
  assert.equal(searchRes.models[0].infoHash, HASH_A);

  const detail = await pirateFaceRepoTorrents('Qwen/Qwen3-8B', { quant: 'Q4_K_M', fetchImpl });
  assert.equal(detail.quant, 'Q4_K_M');
  assert.equal(detail.infoHash, HASH_B);
  assert.equal(detail.canonicalMagnet, `magnet:?xt=urn:btih:${HASH_B}&dn=Qwen%2FQwen3-8B`);
  assert.equal(detail.totalBytes, 4096);
  assert.equal(detail.files[0].sha256, 'a'.repeat(64));
  assert.equal(detail.licenseNotice.name, 'Apache 2.0');

  // Terms-gated repo withholds magnet until acceptTerms matches
  const gated = await pirateFaceRepoTorrents('meta-llama/Llama-3.3-70B-Instruct', { fetchImpl });
  assert.equal(gated.termsRequired, true);
  assert.equal(gated.canonicalMagnet, '');
  assert.equal(gated.infoHash, '');

  const unlocked = await pirateFaceRepoTorrents('meta-llama/Llama-3.3-70B-Instruct', { acceptTerms: 'llama3.3', fetchImpl });
  assert.equal(unlocked.termsRequired, false);
  assert.equal(unlocked.infoHash, HASH_A);
  assert.equal(unlocked.canonicalMagnet, `magnet:?xt=urn:btih:${HASH_A}&dn=meta-llama%2FLlama-3.3-70B-Instruct`);

  // Cached license registry fetched once across all 3 calls
  assert.equal(seen.filter(item => item.url === `${PIRATEFACE_ORIGIN}/api/licenses`).length, 1);
  for (const req of seen) {
    assert.equal(new URL(req.url).origin, PIRATEFACE_ORIGIN);
    assert.equal(req.init.redirect, 'error');
    assert.equal(req.init.credentials, 'omit');
  }

  // Mismatched infohash, path traversal, case-colliding paths, and oversized bodies fail closed
  await assert.rejects(() => pirateFaceRepoTorrents('Qwen/Qwen3-8B', {
    includeLicenses: false,
    fetchImpl: async () => new Response(JSON.stringify({
      repoId: 'Qwen/Qwen3-8B',
      infohash: HASH_A,
      magnet: `magnet:?xt=urn:btih:${HASH_B}`,
    }), { status: 200 }),
  }), /mismatched/i);

  for (const badFiles of [
    [{ path: '../escape.gguf', size: 10 }],
    [{ path: '/etc/passwd', size: 10 }],
    [{ path: 'Model.gguf', size: 10 }, { path: 'model.gguf', size: 10 }],
  ]) {
    await assert.rejects(() => pirateFaceRepoTorrents('Qwen/Qwen3-8B', {
      includeLicenses: false,
      fetchImpl: async () => new Response(JSON.stringify({
        repoId: 'Qwen/Qwen3-8B',
        magnet: `magnet:?xt=urn:btih:${HASH_A}`,
        files: badFiles,
      }), { status: 200 }),
    }), /invalid name|portable|escapes|collid|unsafe|absolute|relative/i);
  }

  await assert.rejects(() => pirateFaceSearch('huge', {
    fetchImpl: async () => new Response('x'.repeat(600 * 1024), { status: 200 }),
  }), /exceeded .* safety limit/i);
});

test('Pirate Face native browse review remembers only https://pirateface.co, while terms review never offers persistence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pf-confirm-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const responses = [
    { response: 1, checkboxChecked: true },
    { response: 1, checkboxChecked: true },
    { response: 0, checkboxChecked: true },
  ];
  const service = new ConfirmationService({
    directory,
    showMessageBox: async (_win, options) => {
      calls.push(structuredClone(options));
      return responses.shift();
    },
  });

  const browse1 = pirateFaceBrowseReview({ endpoint: 'https://pirateface.co/s/qwen3', target: 'qwen3' });
  assert.equal(browse1.defaultId, 0);
  assert.equal(browse1.cancelId, 0);
  assert.throws(() => pirateFaceBrowseReview({ endpoint: 'https://evil.example/s/qwen3', target: 'qwen3' }), /pirateface\.co/i);

  assert.equal((await service.show(null, browse1)).response, 1);
  // Subsequent Pirate Face lookup reuses remembered origin permission without prompting again
  const browse2 = pirateFaceBrowseReview({ endpoint: 'https://pirateface.co/api/torrents?repo=Qwen%2FQwen3-8B', target: 'Qwen/Qwen3-8B' });
  assert.equal((await service.show(null, browse2)).response, 1);
  assert.equal(calls.length, 1);

  // Terms review is non-rememberable and prompts every time
  const terms = pirateFaceTermsReview({
    repoId: 'meta-llama/Llama-3.3-70B-Instruct',
    endpoint: 'https://pirateface.co/api/torrents?repo=meta-llama%2FLlama-3.3-70B-Instruct&accept_terms=llama3.3',
    termsId: 'llama3.3',
    termsName: 'Llama 3.3 Community License',
    termsUrl: 'https://llama.meta.com/llama3_3/license/',
  });
  assert.equal(terms.remember, undefined);
  assert.equal((await service.show(null, terms)).response, 1);
  assert.equal((await service.show(null, terms)).response, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].checkboxLabel, undefined);
});
