/**
 * Firestore security-rules verification.
 *
 * Proves the deployed `blackfrost-hub` ruleset behaves as documented by making
 * real unauthenticated and cross-user requests against the Firestore REST API.
 *
 * The critical property being tested: a client must NOT be able to write
 * `tier`, `subscriptions`, or `entitlements`. A rule mistake here is a free
 * upgrade for every user.
 */

import { execFileSync } from 'node:child_process';

const PROJECT = 'blackfrost-ai-prod';
const DATABASE = 'blackfrost-hub';
const API_KEY = process.env.FIREBASE_WEB_API_KEY || '';
const ACCOUNT = process.env.CLOUDSDK_CORE_ACCOUNT || '';
// FrostByte Identity Platform tenant (spec §2.2 File 3 note): the ruleset is
// tenant-scoped, so verification must sign in AGAINST THE TENANT and prove
// root-pool tokens are refused. Required — never verify against the root pool.
const TENANT_ID = (process.env.FROSTBYTE_AUTH_TENANT_ID || '').trim();

/** Firestore signals a rules denial as 403 and a missing credential as 401. */
const isDenied = (status) => status === 401 || status === 403;

const receipts = [];
function record(name, expected, actual, detail) {
  const pass = String(expected) === String(actual);
  receipts.push({ name, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (expected ${expected}, got ${actual})  ${detail || ''}`);
}

function recordDenied(name, status) {
  const pass = isDenied(status);
  receipts.push({ name, expected: '401/403', actual: status, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (expected 401/403, got ${status})`);
}

function accessToken() {
  const args = ['auth', 'print-access-token'];
  if (ACCOUNT) args.push(`--account=${ACCOUNT}`);
  return execFileSync('gcloud', args, { encoding: 'utf8' }).trim();
}

async function adminWrite(collection, id, fields) {
  const token = accessToken();
  return fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${collection}/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        'x-goog-user-project': PROJECT,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    },
  );
}

async function adminDelete(collection, id) {
  const token = accessToken();
  return fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${collection}/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT },
    },
  );
}

/** Read a document as an end user (rules apply). Omit idToken for anonymous. */
async function userRead(collection, id, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${collection}/${encodeURIComponent(id)}?key=${API_KEY}`;
  const response = await fetch(url, {
    headers: idToken ? { authorization: `Bearer ${idToken}` } : {},
  });
  return response.status;
}

/** Patch a document as an end user (rules apply). */
async function userWrite(collection, id, idToken, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${collection}/${encodeURIComponent(id)}?key=${API_KEY}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return response.status;
}

async function createUser(email, password, tenantId = '') {
  const token = accessToken();
  const created = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT, 'content-type': 'application/json' },
    body: JSON.stringify({ email, emailVerified: true, password, ...(tenantId ? { tenantId } : {}) }),
  });
  const body = await created.json();
  if (!body.localId) throw new Error(`User creation failed: ${JSON.stringify(body)}`);
  return body.localId;
}

async function signIn(email, password, tenantId = '') {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
        ...(tenantId ? { tenantId } : {}),
      }),
    },
  );
  const body = await response.json();
  if (!body.idToken) throw new Error(`Sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken;
}

async function deleteUser(uid, tenantId = '') {
  const token = accessToken();
  await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT, 'content-type': 'application/json' },
    body: JSON.stringify({ localId: uid, ...(tenantId ? { tenantId } : {}) }),
  });
}

async function main() {
  if (!API_KEY) throw new Error('FIREBASE_WEB_API_KEY is required.');
  if (!TENANT_ID) {
    throw new Error('FROSTBYTE_AUTH_TENANT_ID is required — rules verification must run against the FrostByte tenant, never the shared root pool.');
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(TENANT_ID)) throw new Error('Malformed FROSTBYTE_AUTH_TENANT_ID.');

  const stamp = Date.now();
  const ownerEmail = `rules-owner-${stamp}@blackfrost-ai-prod.example.com`;
  const otherEmail = `rules-other-${stamp}@blackfrost-ai-prod.example.com`;
  const rootEmail = `rules-root-${stamp}@blackfrost-ai-prod.example.com`;
  const password = `Rl-${stamp}-Aa9!`;

  let ownerUid = '';
  let otherUid = '';
  let rootUid = '';

  try {
    // Tenant users: the positive checks must use tenant-scoped tokens.
    ownerUid = await createUser(ownerEmail, password, TENANT_ID);
    otherUid = await createUser(otherEmail, password, TENANT_ID);
    const ownerToken = await signIn(ownerEmail, password, TENANT_ID);
    const otherToken = await signIn(otherEmail, password, TENANT_ID);
    // Root-pool user: exists to prove untenant tokens are refused by the rules.
    rootUid = await createUser(rootEmail, password);
    const rootToken = await signIn(rootEmail, password);

    // Seed server-owned documents as admin.
    await adminWrite('users', ownerUid, {
      uid: { stringValue: ownerUid },
      email: { stringValue: ownerEmail },
      tier: { stringValue: 'pro' },
    });
    await adminWrite('subscriptions', ownerUid, {
      uid: { stringValue: ownerUid },
      tier: { stringValue: 'pro' },
      status: { stringValue: 'active' },
      providerCustomerId: { stringValue: 'cus_secret_value' },
    });
    await adminWrite('entitlements', ownerUid, {
      uid: { stringValue: ownerUid },
      tier: { stringValue: 'pro' },
    });

    // --- Owner reads their own profile (tenant token) ----------------------
    record('tenant owner can read own user doc', 200, await userRead('users', ownerUid, ownerToken));

    // --- Root-pool (untenant) tokens are refused — the isolation property ---
    recordDenied('root-pool token cannot read a tenant user doc', await userRead('users', ownerUid, rootToken));
    recordDenied('root-pool token cannot read its own root user doc', await userRead('users', rootUid, rootToken));
    record(
      'root-pool token cannot write any user doc',
      403,
      await userWrite('users', ownerUid, rootToken, { tier: { stringValue: 'pro' } }),
    );
    recordDenied('root-pool token cannot read subscriptions', await userRead('subscriptions', ownerUid, rootToken));
    recordDenied('root-pool token cannot read entitlements', await userRead('entitlements', ownerUid, rootToken));

    // --- Cross-user reads are denied --------------------------------------
    record('other user cannot read owner user doc', 403, await userRead('users', ownerUid, otherToken));

    // --- Anonymous reads are denied ---------------------------------------
    recordDenied('anonymous cannot read user doc', await userRead('users', ownerUid, ''));

    // --- Client writes to users are denied entirely -----------------------
    record(
      'client cannot write own user doc',
      403,
      await userWrite('users', ownerUid, ownerToken, { tier: { stringValue: 'pro' } }),
    );

    // --- Subscription / entitlement are server-only -----------------------
    record('owner cannot read own subscription', 403, await userRead('subscriptions', ownerUid, ownerToken));
    record('owner cannot read own entitlement', 403, await userRead('entitlements', ownerUid, ownerToken));
    record(
      'client cannot write own subscription',
      403,
      await userWrite('subscriptions', ownerUid, ownerToken, { tier: { stringValue: 'pro' } }),
    );

    // --- Server-only collections are fully closed -------------------------
    for (const collection of ['apiKeys', 'usage', 'orgs', 'auditLog', 'discoveryCache']) {
      recordDenied(`anonymous cannot read ${collection}`, await userRead(collection, 'someDocId', ''));
      recordDenied(
        `client cannot write ${collection}`,
        await userWrite(collection, `rulesTest_${stamp}`, ownerToken, { x: { stringValue: '1' } }),
      );
    }
  } finally {
    for (const [collection, id] of [
      ['users', ownerUid],
      ['subscriptions', ownerUid],
      ['entitlements', ownerUid],
    ]) {
      if (id) {
        try {
          await adminDelete(collection, id);
        } catch {
          /* ignore */
        }
      }
    }
    if (ownerUid) await deleteUser(ownerUid, TENANT_ID).catch(() => {});
    if (otherUid) await deleteUser(otherUid, TENANT_ID).catch(() => {});
    if (rootUid) await deleteUser(rootUid).catch(() => {});
    console.log(`\nCleaned up rules-test accounts (tenant + root pool).`);
  }

  const failed = receipts.filter((entry) => !entry.pass);
  console.log(`\n${receipts.length - failed.length}/${receipts.length} rules checks passed.`);
  if (failed.length > 0) {
    for (const failure of failed) {
      console.log(`  - ${failure.name}: expected ${failure.expected}, got ${failure.actual}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Rules verification aborted:', error.message);
  process.exitCode = 1;
});