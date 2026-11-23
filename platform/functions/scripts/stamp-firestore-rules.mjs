/**
 * Stamp the Firestore rules tenant placeholder (spec §2.2 File 3 note).
 *
 * Substitutes __FROSTBYTE_AUTH_TENANT_ID__ in platform/firestore.rules with the
 * validated FROSTBYTE_AUTH_TENANT_ID before `firebase deploy --only
 * firestore:rules`. Fails closed on a missing or malformed tenant id; refuses
 * to stamp an already-stamped file with a DIFFERENT tenant (pass --force to
 * re-stamp deliberately).
 *
 * Usage:
 *   FROSTBYTE_AUTH_TENANT_ID=<id> node scripts/stamp-firestore-rules.mjs [--dry-run] [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = '__FROSTBYTE_AUTH_TENANT_ID__';
const TENANT_RE = /^[A-Za-z0-9_-]{4,64}$/;

function fail(message) {
  console.error(message);
  process.exit(2);
}

export function stampRules({ source, tenantId, force = false }) {
  if (!TENANT_RE.test(tenantId)) {
    throw new Error(`Invalid tenant id "${tenantId}": must match /^[A-Za-z0-9_-]{4,64}$/.`);
  }
  if (source.includes(PLACEHOLDER)) {
    return { stamped: source.split(PLACEHOLDER).join(tenantId), changed: true, previousTenant: null };
  }
  // Already stamped: find the tenant currently embedded in the rules.
  const match = source.match(/firebase\.get\('tenant', ''\) == '([^']+)'/);
  const previousTenant = match ? match[1] : null;
  if (previousTenant === tenantId) return { stamped: source, changed: false, previousTenant };
  if (!force) {
    throw new Error(
      `Rules already stamped with tenant "${previousTenant ?? 'unknown'}"; refusing to overwrite with "${tenantId}" without --force.`,
    );
  }
  if (!previousTenant) throw new Error('Rules contain neither the placeholder nor a recognizable stamped tenant.');
  return {
    stamped: source.split(`'${previousTenant}'`).join(`'${tenantId}'`),
    changed: true,
    previousTenant,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const tenantId = (process.env.FROSTBYTE_AUTH_TENANT_ID || '').trim();
  if (!tenantId) fail('FROSTBYTE_AUTH_TENANT_ID is required.');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const rulesPath = path.resolve(here, '../../firestore.rules');
  const source = fs.readFileSync(rulesPath, 'utf8');

  let result;
  try {
    result = stampRules({ source, tenantId, force });
  } catch (error) {
    fail(error.message);
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, tenantId, changed: result.changed, previousTenant: result.previousTenant }));
    return;
  }
  if (result.changed) {
    fs.writeFileSync(rulesPath, result.stamped, 'utf8');
  }
  console.log(JSON.stringify({ ok: true, tenantId, changed: result.changed, rulesPath }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
