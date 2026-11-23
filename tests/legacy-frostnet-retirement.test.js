/**
 * P2.3 legacy FrostNet retirement — tooling tests.
 *
 * Unit: convertRecord refuses bad digest / bad signature / missing createdAt /
 * invalid manifest; preserves the ORIGINAL signature; chunking respects caps.
 * Integration: export → convert runs against a REAL local legacy hub
 * (hub/ is reference-only per ADR002 — used here as a local test target,
 * never deployed), including the frozen-mode probes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

import { createHubApp } from '../hub/src/app.js';
import { generateKeypair, signRecipePublish } from '../hub/src/crypto.js';
import { validateRecipe, canonicalDigest, recipeSigningBytes } from '../platform/functions/src/recipe-manifest.js';
import { FROSTNET_TERMS } from '../src/shared/release-manifest.js';
import {
  convertRecord, convertBundle, chunkRecords, verifyEd25519Independent,
} from '../scripts/lib/legacy-frostnet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeManifest(publisher, overrides = {}) {
  return validateRecipe({
    schema: 'frostbyte.recipe', version: 2, id: 'legacy-test-recipe', title: 'Legacy Test', kind: 'native',
    publisher, files: [{ path: 'r.json', size: 10, sha256: 'c'.repeat(64) }],
    license: { id: 'MIT', statement: 'MIT' }, createdAt: '2026-09-01T10:00:00.000Z', ...overrides,
  });
}

function signedRecord(keypair, manifest, overrides = {}) {
  const signature = signRecipePublish(manifest, keypair.privateKeyHex);
  return {
    id: manifest.id, manifest, digest: canonicalDigest(manifest), signature, legacySeq: 3, ...overrides,
  };
}

// ── Unit: conversion trust invariants ───────────────────────────────────────

test('convertRecord preserves the original key + signature and recomputes the digest', () => {
  const kp = generateKeypair();
  const manifest = makeManifest(kp.publicKeyHex);
  const record = signedRecord(kp, manifest);
  const result = convertRecord(record);
  assert.equal(result.ok, true);
  assert.equal(result.record.signature, record.signature); // never re-signed
  assert.equal(result.record.manifest.publisher, kp.publicKeyHex); // never re-keyed
  assert.equal(result.record.digest, canonicalDigest(manifest));
  assert.equal(result.record.legacySeq, 3);
  // The preserved signature still verifies over the converted canonical form.
  const bytes = recipeSigningBytes({ digest: result.record.digest, pubkey: kp.publicKeyHex, timestamp: manifest.createdAt });
  assert.equal(verifyEd25519Independent(bytes, result.record.signature, kp.publicKeyHex), true);
});

test('convertRecord refuses digest mismatch, forged signature, missing createdAt, invalid manifest', () => {
  const kp = generateKeypair();
  const other = generateKeypair();
  const manifest = makeManifest(kp.publicKeyHex);
  const good = signedRecord(kp, manifest);

  assert.equal(convertRecord({ ...good, digest: 'f'.repeat(64) }).code, 'digest_mismatch');

  // Signature from a DIFFERENT key over the same bytes → independent verify fails.
  const forgedSignature = signRecipePublish(manifest, other.privateKeyHex);
  assert.equal(convertRecord({ ...good, signature: forgedSignature }).code, 'signature_invalid');

  const noCreatedAt = makeManifest(kp.publicKeyHex, { id: 'no-created-at' });
  delete noCreatedAt.createdAt;
  assert.equal(convertRecord({ id: 'no-created-at', manifest: noCreatedAt, signature: good.signature }).code, 'created_at_required');

  assert.equal(convertRecord({ id: 'bad', manifest: { schema: 'nope' }, signature: good.signature }).code, 'manifest_invalid');
  assert.equal(convertRecord({ id: 'nosig', manifest }).code, 'signature_required');
});

test('convertBundle dedupes by digest and carries tombstones without importing them', () => {
  const kp = generateKeypair();
  const manifest = makeManifest(kp.publicKeyHex);
  const record = signedRecord(kp, manifest);
  const bundle = { recipes: [record, { ...record }], withdrawn: ['gone-recipe', 'gone-recipe'] };
  const { converted, refused, tombstones } = convertBundle(bundle);
  assert.equal(converted.length, 1);
  assert.equal(refused.length, 0);
  assert.deepEqual(tombstones, ['gone-recipe']);
});

test('chunkRecords respects the record cap and byte cap', () => {
  const kp = generateKeypair();
  const records = Array.from({ length: 450 }, (_, i) => signedRecord(kp, makeManifest(kp.publicKeyHex, { id: `r-${i}` })));
  const batches = chunkRecords(records, { maxRecords: 200, maxBytes: 6 * 1024 * 1024 });
  assert.deepEqual(batches.map((b) => b.length), [200, 200, 50]);
  const tiny = chunkRecords(records.slice(0, 6), { maxRecords: 200, maxBytes: 1 });
  assert.equal(tiny.length, 6); // byte cap forces one-per-batch
});

// ── Integration: export → convert against a real local legacy hub ──────────

async function seededHub({ frozen = false, dataDir } = {}) {
  const app = createHubApp({ port: 0, seed: false, frozen, ...(dataDir ? { dataDir } : {}) });
  await app.listen();
  const kp = generateKeypair();
  const manifests = [
    makeManifest(kp.publicKeyHex, { id: 'legacy-alpha', title: 'Legacy Alpha' }),
    makeManifest(kp.publicKeyHex, { id: 'legacy-beta', title: 'Legacy Beta' }),
  ];
  for (const manifest of manifests) {
    const signature = signRecipePublish(manifest, kp.privateKeyHex);
    const res = await fetch(`${app.origin}/v1/recipes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.auth.devToken}` },
      body: JSON.stringify({ manifest, signature, terms: FROSTNET_TERMS }),
    });
    assert.equal(res.status, 201, `seed publish failed: ${await res.text()}`);
  }
  return { app, kp, manifests };
}

test('export → convert pipeline against a live local legacy hub (real signatures survive)', async () => {
  const { app, kp, manifests } = await seededHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frostnet-retire-'));
  try {
    const exportPath = path.join(dir, 'export.json');
    const convertedPath = path.join(dir, 'converted.json');
    // Async exec: the legacy hub runs IN THIS PROCESS, so the event loop must
    // stay free to serve the child script's HTTP requests (execFileSync would
    // deadlock: child waits for a response the blocked parent cannot send).
    const exportOut = (await execFileAsync(process.execPath, [
      path.join(ROOT, 'scripts/legacy-frostnet-export.mjs'),
      '--base', app.origin, '--out', exportPath,
    ], { encoding: 'utf8', timeout: 60000 })).stdout;
    const exportReceipt = JSON.parse(exportOut);
    assert.equal(exportReceipt.ok, true);
    assert.equal(exportReceipt.counts.recipes, 2);
    assert.equal(exportReceipt.counts.events, 2);
    assert.ok(fs.existsSync(exportPath.replace(/\.json$/, '.receipt.json')));

    const exportBundle = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    assert.equal(exportBundle.recipes.length, 2);
    for (const recipe of exportBundle.recipes) {
      assert.ok(recipe.signature, 'export must carry the original signature');
      assert.ok(Number.isSafeInteger(recipe.legacySeq), 'export must carry the legacy change seq');
    }

    const convertOut = (await execFileAsync(process.execPath, [
      path.join(ROOT, 'scripts/legacy-frostnet-convert.mjs'),
      '--in', exportPath, '--out', convertedPath,
    ], { encoding: 'utf8', timeout: 60000 })).stdout;
    const convertReceipt = JSON.parse(convertOut);
    assert.equal(convertReceipt.ok, true);
    assert.equal(convertReceipt.counts.converted, 2);
    assert.equal(convertReceipt.counts.refused, 0);

    const converted = JSON.parse(fs.readFileSync(convertedPath, 'utf8'));
    assert.equal(converted.inputSha256, exportReceipt.sha256); // receipt chain binds the stages
    for (const record of converted.converted) {
      const original = manifests.find((m) => m.id === record.id);
      assert.ok(original);
      assert.equal(record.manifest.publisher, kp.publicKeyHex);
      const bytes = recipeSigningBytes({ digest: record.digest, pubkey: record.manifest.publisher, timestamp: record.manifest.createdAt });
      assert.equal(verifyEd25519Independent(bytes, record.signature, record.manifest.publisher), true);
    }
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('frozen legacy hub: writes 410 legacy_frozen, reads stay live; freeze script verifies', async () => {
  // Seed while live, then start the frozen instance over the SAME data dir —
  // the real retirement sequence (freeze is applied after content exists).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frostnet-freeze-'));
  const dataDir = path.join(dir, 'hub-data');
  const seeded = await seededHub({ dataDir });
  await seeded.app.close();
  const app = createHubApp({ port: 0, seed: false, frozen: true, dataDir });
  await app.listen();
  try {
    // Direct probes.
    const publish = await fetch(`${app.origin}/v1/recipes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(publish.status, 410);
    assert.equal((await publish.json()).error.code, 'legacy_frozen');
    const follow = await fetch(`${app.origin}/v1/follows/${'0'.repeat(64)}`, { method: 'POST', body: '{}' });
    assert.equal(follow.status, 410);
    const health = await fetch(`${app.origin}/v1/health`);
    assert.equal((await health.json()).frozen, true);
    const search = await fetch(`${app.origin}/v1/search?limit=1`);
    assert.equal(search.status, 200);

    // The freeze verification script must report verified:true.
    const outPath = path.join(dir, 'freeze.json');
    const out = (await execFileAsync(process.execPath, [
      path.join(ROOT, 'scripts/legacy-frostnet-freeze.mjs'),
      '--base', app.origin, '--out', outPath,
    ], { encoding: 'utf8', timeout: 60000 })).stdout;
    const receipt = JSON.parse(out);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.verified, true);
    const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.deepEqual(payload.checks, { healthFrozenFlag: true, readsLive: true, publishFrozen: true, followFrozen: true });
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unfrozen legacy hub: freeze verification FAILS honestly (exit 2, verified:false)', async () => {
  const { app } = await seededHub({ frozen: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frostnet-unfrozen-'));
  try {
    const outPath = path.join(dir, 'freeze.json');
    let exitCode = 0;
    let stdout = '';
    try {
      stdout = (await execFileAsync(process.execPath, [
        path.join(ROOT, 'scripts/legacy-frostnet-freeze.mjs'),
        '--base', app.origin, '--out', outPath,
      ], { encoding: 'utf8', timeout: 60000 })).stdout;
    } catch (error) {
      exitCode = error.code;
      stdout = error.stdout || '';
    }
    assert.equal(exitCode, 2);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.verified, false);
    const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(payload.checks.publishFrozen, false);
    assert.equal(payload.checks.readsLive, true);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});