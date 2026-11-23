#!/usr/bin/env node
/**
 * P2.3 stage 2 — CONVERT the legacy export into import-ready records.
 *
 * Re-validates every manifest (vendored platform validator), recomputes the
 * canonical digest, and verifies the ORIGINAL Ed25519 signature with an
 * independent node:crypto verifier. Refusals are typed negative evidence —
 * nothing is re-signed, re-keyed, or silently dropped.
 *
 * Usage:
 *   node scripts/legacy-frostnet-convert.mjs \
 *     --in research/legacy-frostnet-retirement/export.json \
 *     --out research/legacy-frostnet-retirement/converted.json
 *
 * Output: {converted[], refused[{id, code, message}], tombstones[]} + receipt.
 * The converted bundle is the ONLY input the admin import route accepts
 * (and the route re-verifies everything server-side regardless).
 */
import fs from 'node:fs';
import path from 'node:path';
import { convertBundle, writeArtifactWithReceipt, sha256Hex, DEFAULT_SOURCE } from './lib/legacy-frostnet.mjs';

function parseArgs(argv) {
  const args = { in: '', out: '', source: DEFAULT_SOURCE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') args.in = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--source') args.source = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.in || !args.out) throw new Error('--in <export.json> and --out <converted.json> are required.');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const inputText = fs.readFileSync(args.in, 'utf8');
  const bundle = JSON.parse(inputText);
  if (!Array.isArray(bundle?.recipes)) throw new Error('Input does not look like an export bundle (no recipes array).');

  const { converted, refused, tombstones } = convertBundle(bundle);
  const payload = {
    convertedAt: startedAt,
    source: bundle.source || args.source,
    inputSha256: sha256Hex(inputText),
    converted,
    refused,
    tombstones,
  };
  const receipt = writeArtifactWithReceipt(path.resolve(args.out), payload, {
    stage: 'convert',
    extra: {
      input: path.resolve(args.in),
      inputSha256: sha256Hex(inputText),
      counts: { input: bundle.recipes.length, converted: converted.length, refused: refused.length, tombstones: tombstones.length },
      startedAt,
      finishedAt: new Date().toISOString(),
    },
  });
  console.log(JSON.stringify({ ok: true, out: path.resolve(args.out), ...receipt }, null, 2));
  // Refusals are evidence, not failure — but a bundle where EVERYTHING was
  // refused must not look like a success.
  if (bundle.recipes.length > 0 && converted.length === 0) process.exitCode = 2;
}

try { main(); } catch (error) {
  console.error(JSON.stringify({ ok: false, stage: 'convert', error: error.message }));
  process.exit(1);
}