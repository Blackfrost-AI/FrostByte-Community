#!/usr/bin/env node
/**
 * P2.3 stage 4 — VERIFY the legacy write-freeze (read-only probe).
 *
 * The freeze itself is a deployment configuration change: set
 * FROSTNET_FROZEN=1 in the legacy frostnet-si deployment and redeploy the
 * legacy app. This script does NOT flip the flag remotely (no such API
 * exists, by design) — it PROBES that the freeze took effect and records a
 * receipt:
 *   - POST /v1/recipes        → expect 410 legacy_frozen
 *   - POST /v1/follows/<key>  → expect 410 legacy_frozen
 *   - GET  /v1/health         → expect 200 with frozen:true
 *   - GET  /v1/search         → expect 200 (reads stay live)
 *
 * Run ONLY after the import is verified complete (operator decision). A
 * failed probe exits non-zero — an unverified freeze is not a freeze.
 *
 * Usage:
 *   node scripts/legacy-frostnet-freeze.mjs --base https://frostnet-si.web.app \
 *     --out research/legacy-frostnet-retirement/freeze-verification.json
 */
import path from 'node:path';
import { getJson, writeArtifactWithReceipt } from './lib/legacy-frostnet.mjs';

function parseArgs(argv) {
  const args = { base: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.base || !/^https?:\/\//.test(args.base)) throw new Error('--base <legacy hub URL> is required.');
  if (!args.out) throw new Error('--out <freeze-verification.json> is required.');
  args.base = args.base.replace(/\/+$/, '');
  return args;
}

async function probeWrite(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Deliberately minimal body: the freeze check must fire BEFORE auth or
    // body validation, so an unauthenticated probe is sufficient and safe.
    const res = await fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, code: body?.error?.code || null };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  const health = await getJson(`${args.base}/v1/health`);
  const search = await getJson(`${args.base}/v1/search?limit=1`);
  const publishProbe = await probeWrite(`${args.base}/v1/recipes`);
  const followProbe = await probeWrite(`${args.base}/v1/follows/${'0'.repeat(64)}`);

  const checks = {
    healthFrozenFlag: health?.frozen === true,
    readsLive: health?.ok === true && Array.isArray(search?.items),
    publishFrozen: publishProbe.status === 410 && publishProbe.code === 'legacy_frozen',
    followFrozen: followProbe.status === 410 && followProbe.code === 'legacy_frozen',
  };
  const verified = Object.values(checks).every(Boolean);
  const payload = {
    verified, startedAt, finishedAt: new Date().toISOString(),
    base: args.base, checks,
    observations: { health, publishProbe, followProbe, searchItemCount: search?.items?.length ?? null },
  };
  const receipt = writeArtifactWithReceipt(path.resolve(args.out), payload, {
    stage: 'freeze-verify',
    extra: { base: args.base, verified, checks },
  });
  console.log(JSON.stringify({ ok: verified, out: path.resolve(args.out), ...receipt }, null, 2));
  if (!verified) process.exit(2);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, stage: 'freeze-verify', error: error.message }));
  process.exit(1);
});