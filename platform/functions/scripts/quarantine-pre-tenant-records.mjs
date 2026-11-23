/**
 * Quarantine pre-tenant records (spec §2.2 File 4).
 *
 * Scans `users` in the `blackfrost-hub` database for documents whose tenantId
 * differs from FROSTBYTE_AUTH_TENANT_ID (pre-tenant dev ghosts from the shared
 * root pool era).
 *
 *   --dry-run (default): prints count + UIDs; writes nothing.
 *   --apply: copies each pre-tenant users/{uid} doc and its apiKeys metadata
 *            into quarantinePreTenant/{uid}, stamps revokedAt on those keys,
 *            then deletes the stale users/{uid} doc.
 *
 * Usage:
 *   FROSTBYTE_AUTH_TENANT_ID=<id> node scripts/quarantine-pre-tenant-records.mjs [--apply]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HUB_DATABASE = 'blackfrost-hub';
const TENANT_RE = /^[A-Za-z0-9_-]{4,64}$/;

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** Pure selection logic — exported for unit tests. */
export function selectPreTenantUsers(users, tenantId) {
  return users.filter((user) => (user.tenantId || '') !== tenantId);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const tenantId = (process.env.FROSTBYTE_AUTH_TENANT_ID || '').trim();
  if (!TENANT_RE.test(tenantId)) fail('FROSTBYTE_AUTH_TENANT_ID must match /^[A-Za-z0-9_-]{4,64}$/.');

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'blackfrost-ai-prod' });
  const db = getFirestore(app, HUB_DATABASE);

  const snapshot = await db.collection('users').get();
  const users = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const stale = selectPreTenantUsers(users, tenantId);

  if (!apply) {
    console.log(JSON.stringify({
      dryRun: true,
      tenantId,
      scanned: users.length,
      preTenantCount: stale.length,
      uids: stale.map((user) => user.id),
    }));
    return;
  }

  const nowIso = new Date().toISOString();
  let quarantined = 0;
  for (const user of stale) {
    const keysSnapshot = await db.collection('apiKeys').where('uid', '==', user.id).get();
    const keys = keysSnapshot.docs.map((doc) => ({ keyHash: doc.id, ...doc.data() }));

    await db.collection('quarantinePreTenant').doc(user.id).set({
      uid: user.id,
      originalUser: user,
      apiKeys: keys.map((key) => ({ keyHash: key.keyHash, prefix: key.prefix || '', label: key.label || '', createdAt: key.createdAt || null })),
      quarantinedAt: nowIso,
      reason: 'pre-tenant root-pool record',
    });

    for (const key of keys) {
      await db.collection('apiKeys').doc(key.keyHash).set({ revokedAt: nowIso }, { merge: true });
    }
    await db.collection('users').doc(user.id).delete();
    quarantined += 1;
    console.log(`quarantined ${user.id} (${keys.length} keys revoked)`);
  }

  await db.collection('auditLog').add({
    actorUid: 'quarantine-script',
    actorEmail: '',
    action: 'tenant.quarantine_pre_tenant',
    targetType: 'system',
    targetId: 'blackfrost-hub',
    reason: `Quarantined ${quarantined} pre-tenant records for tenant ${tenantId}`,
    at: nowIso,
  });

  console.log(JSON.stringify({ ok: true, applied: true, tenantId, quarantined }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Quarantine failed:', error.message);
    process.exit(1);
  });
}
