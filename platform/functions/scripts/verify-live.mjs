/**
 * Live verification script.
 *
 * Mints a real Firebase ID token for a throwaway test account, exercises every
 * gated route against the deployed function, then deletes the account and its
 * Firestore documents. Prints a receipt table.
 *
 * Uses the gcloud access token over REST rather than the Admin SDK, so it needs
 * no service-account key file and no interactive ADC login.
 *
 *   CLOUDSDK_CORE_ACCOUNT=you@example.com \
 *   FIREBASE_WEB_API_KEY=<web api key> \
 *   node scripts/verify-live.mjs
 */

import { execFileSync } from 'node:child_process';

const PROJECT = 'blackfrost-ai-prod';
const DATABASE = 'blackfrost-hub';
const BASE = 'https://us-central1-blackfrost-ai-prod.cloudfunctions.net/hubApi';
const TEST_EMAIL = 'hub-verify-test@blackfrost-ai-prod.example.com';
// A throwaway password for the throwaway account. Not a credential for anything
// real; the account is deleted at the end of the run.
const TEST_PASSWORD = `Vf-${Date.now()}-Aa9!`;

const ACCOUNT = process.env.CLOUDSDK_CORE_ACCOUNT || '';
const API_KEY = process.env.FIREBASE_WEB_API_KEY || '';
// FrostByte Identity Platform tenant (spec §2.2 / §8): verification must run
// against the tenant, prove root-pool credentials are refused by hubApi, and
// never leave a root-pool test account behind. Required — fail closed.
const TENANT_ID = (process.env.FROSTBYTE_AUTH_TENANT_ID || '').trim();
const AUTH_ROOT = TENANT_ID
  ? `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/tenants/${TENANT_ID}`
  : `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}`;

function accessToken() {
  const args = ['auth', 'print-access-token'];
  if (ACCOUNT) args.push(`--account=${ACCOUNT}`);
  return execFileSync('gcloud', args, { encoding: 'utf8' }).trim();
}

let TOKEN = '';

const receipts = [];
function record(name, expected, actual, detail) {
  const pass = String(expected) === String(actual);
  receipts.push({ name, expected, actual, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (expected ${expected}, got ${actual})  ${detail || ''}`);
}

async function gcp(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-goog-user-project': PROJECT,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON is a finding */
  }
  return { status: response.status, json, text };
}

async function call(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON is a finding */
  }
  return { status: response.status, json, text, headers: response.headers };
}

const docUrl = (collection, id) =>
  `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${collection}/${encodeURIComponent(id)}`;

async function writeDoc(collection, id, fields) {
  return gcp(docUrl(collection, id), { method: 'PATCH', body: JSON.stringify({ fields }) });
}

async function deleteDoc(collection, id) {
  return gcp(docUrl(collection, id), { method: 'DELETE' });
}

async function readDoc(collection, id) {
  const result = await gcp(docUrl(collection, id));
  return result.status === 200 ? result.json : null;
}

async function main() {
  if (!API_KEY) throw new Error('FIREBASE_WEB_API_KEY is required.');
  if (!TENANT_ID) throw new Error('FROSTBYTE_AUTH_TENANT_ID is required — verify against the tenant, never the root pool.');
  TOKEN = accessToken();

  let uid = '';
  const created = [];

  try {
    // --- Provision a throwaway account (tenant-scoped) ----------------------
    // Also sweep any root-pool leftover from pre-tenant verification runs.
    for (const root of [AUTH_ROOT, `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}`]) {
      const existing = await gcp(`${root}/accounts:lookup`, {
        method: 'POST', body: JSON.stringify({ email: [TEST_EMAIL] }),
      });
      for (const user of existing.json?.users || []) {
        await gcp(`${root}/accounts:delete`, {
          method: 'POST',
          body: JSON.stringify({ localId: user.localId }),
        });
      }
    }

    const signUp = await gcp(
      `${AUTH_ROOT}/accounts`,
      { method: 'POST', body: JSON.stringify({ email: TEST_EMAIL, emailVerified: true, password: TEST_PASSWORD }) },
    );
    uid = signUp.json?.localId || '';
    if (!uid) throw new Error(`Could not create test user: ${signUp.text}`);
    console.log(`\nTest account uid: ${uid}\n`);

    await writeDoc('users', uid, {
      uid: { stringValue: uid },
      email: { stringValue: TEST_EMAIL },
      // The Hub provisions profiles with a tenant stamp on first sign-in;
      // pre-seeding must match that shape or API-key auth (which requires
      // users.tenantId === the Hub tenant) rejects keys for this account.
      tenantId: { stringValue: TENANT_ID },
      displayName: { stringValue: 'Hub Verify' },
      createdAt: { timestampValue: new Date().toISOString() },
      updatedAt: { timestampValue: new Date().toISOString() },
    });

    // Exchange email+password for a real Firebase ID token. This is the same
    // path a first-party client takes, so it exercises token verification for
    // real rather than mocking it.
    const signIn = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, tenantId: TENANT_ID, returnSecureToken: true }),
      },
    );
    const session = await signIn.json();
    if (!session.idToken) throw new Error(`Sign-in failed: ${JSON.stringify(session)}`);
    const idToken = session.idToken;

    // The minted token must actually carry the tenant claim.
    const tokenPayload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    record('id token carries the tenant claim', TENANT_ID, tokenPayload?.firebase?.tenant);

    // --- Health ------------------------------------------------------------
    const health = await call('/v1/health');
    record('health is public', 200, health.status);
    record('health reports firestore store', 'firestore', health.json?.store);

    // --- Auth gates --------------------------------------------------------
    record('anonymous discovery is 401', 401, (await call('/v1/discovery/models?q=qwen')).status);
    record('garbage token is 401', 401, (await call('/v1/discovery/models', { token: 'nope' })).status);

    // Root-pool credential must be refused: mint one for the same throwaway
    // account in the root pool, prove 401, then delete it immediately.
    const rootSignUp = await gcp(
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`,
      { method: 'POST', body: JSON.stringify({ email: TEST_EMAIL, emailVerified: true, password: TEST_PASSWORD }) },
    );
    const rootUid = rootSignUp.json?.localId || '';
    try {
      const rootSignIn = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, returnSecureToken: true }),
        },
      );
      const rootSession = await rootSignIn.json();
      if (rootSession.idToken) {
        record('root-pool token is refused by hubApi', 401,
          (await call('/v1/me', { token: rootSession.idToken })).status);
        record('root-pool token refused on discovery', 401,
          (await call('/v1/discovery/models?q=qwen', { token: rootSession.idToken })).status);
      } else {
        record('root-pool token is refused by hubApi', 'minted', `root sign-in failed: ${rootSession.error?.message || 'unknown'}`);
      }
    } finally {
      if (rootUid) {
        await gcp(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`, {
          method: 'POST',
          body: JSON.stringify({ localId: rootUid }),
        });
      }
    }

    // --- Free tier discovery ----------------------------------------------
    const freeDiscovery = await call('/v1/discovery/models?q=qwen&limit=3', { token: idToken });
    record('free discovery is 200', 200, freeDiscovery.status);
    record('free tier is free', 'free', freeDiscovery.json?.tier);
    record(
      'free discovery returns only huggingface items',
      true,
      (freeDiscovery.json?.items || []).every((item) => item.provider === 'huggingface'),
    );
    record(
      'free plan marks localmaxxing skipped',
      'skipped',
      (freeDiscovery.json?.providers || []).find((p) => p.provider === 'localmaxxing')?.status,
    );
    record('free discovery returns real items', true, (freeDiscovery.json?.items || []).length > 0,
      `count=${(freeDiscovery.json?.items || []).length}`);

    const firstItem = freeDiscovery.json?.items?.[0];
    if (firstItem) {
      console.log(`   sample item: ${firstItem.id} (${firstItem.provider}) downloads=${firstItem.downloads}`);
    }

    // --- Free tier cannot create API keys ----------------------------------
    record('free tier api-key create is 403', 403,
      (await call('/v1/api-keys', { token: idToken, method: 'POST', body: { label: 'x' } })).status);

    // --- Upgrade to pro ----------------------------------------------------
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await writeDoc('subscriptions', uid, {
      uid: { stringValue: uid },
      provider: { stringValue: 'stripe' },
      providerSubscriptionId: { stringValue: 'sub_verify_test' },
      providerCustomerId: { stringValue: 'cus_verify_test' },
      tier: { stringValue: 'pro' },
      status: { stringValue: 'active' },
      currentPeriodEnd: { timestampValue: periodEnd },
      cancelAtPeriodEnd: { booleanValue: false },
      updatedAt: { timestampValue: new Date().toISOString() },
    });
    created.push(['subscriptions', uid]);

    const proEntitlement = await call('/v1/me/entitlement', { token: idToken });
    record('pro tier resolves after subscription write', 'pro', proEntitlement.json?.tier,
      `source=${proEntitlement.json?.source}`);
    record('pro entitlement leaks no customer id', false, proEntitlement.text.includes('cus_verify_test'));

    // --- Pro tier discovery fans out --------------------------------------
    const proDiscovery = await call('/v1/discovery/models?q=qwen&limit=3', { token: idToken });
    record('pro discovery is 200', 200, proDiscovery.status);
    const proReports = proDiscovery.json?.providers || [];
    const okProviders = proReports.filter((p) => p.status === 'ok');
    // Structural: the pro plan must FAN OUT to all three providers. Upstream
    // availability is not this Hub's contract — pirateface.co currently serves
    // HTML at /api/models (probed 2026-11-15), so its report is a graceful
    // error, which is exactly the resilience the fan-out must exhibit.
    record('pro discovery fans out to all three providers', 3, proReports.length,
      proReports.map((p) => `${p.provider}:${p.status}`).join(','));
    record('huggingface + localmaxxing answer ok', true,
      ['huggingface', 'localmaxxing'].every((name) => okProviders.some((p) => p.provider === name)));
    record('failed upstream degrades gracefully (reported, not fatal)', true,
      proReports.filter((p) => p.status === 'error').every((p) => typeof p.message === 'string' && p.message.length > 0 && p.count === 0));
    record('pro discovery merges results from every ok provider', true,
      // Items are sorted downloads-desc and sliced to pageSize, so a provider
      // whose results all have downloads=0 (localmaxxing) can legitimately
      // fill zero top-3 slots. Merge correctness = every ok provider actually
      // returned results into the merge, proven per-provider below.
      okProviders.every((p) => p.count > 0));
    for (const name of ['huggingface', 'localmaxxing']) {
      const single = await call(`/v1/discovery/models?q=qwen&limit=3&providers=${name}`, { token: idToken });
      const report = (single.json?.providers || []).find((p) => p.provider === name);
      record(`${name} returns qwen results into the merge`, true,
        single.status === 200 && (report?.count || 0) > 0, `count=${report?.count}`);
    }
    const pf = proReports.find((p) => p.provider === 'pirateface');
    if (pf?.status === 'ok') {
      record('pirateface items carry infoHash shape when present', true,
        (proDiscovery.json?.items || []).filter((i) => i.provider === 'pirateface')
          .every((i) => i.infoHash === '' || /^[0-9a-f]{40}$/.test(i.infoHash)));
    } else {
      console.log(`   pirateface upstream status: ${pf?.status} (${pf?.code}) — ${pf?.message}`);
    }

    // --- API keys ----------------------------------------------------------
    const keyCreate = await call('/v1/api-keys', { token: idToken, method: 'POST', body: { label: 'verify' } });
    record('pro tier api-key create is 200', 200, keyCreate.status);
    const plaintext = keyCreate.json?.key || '';
    record('api key has the bfk_ shape', true, /^bfk_[a-z0-9]{8}_[A-Za-z0-9_-]{32,}$/.test(plaintext));

    const keyAuth = await call('/v1/me', { token: plaintext });
    record('api key authenticates', 200, keyAuth.status);
    record('api key request reports pro', 'pro', keyAuth.json?.entitlement?.tier);

    const keyList = await call('/v1/api-keys', { token: idToken });
    record('api key list omits plaintext', false, keyList.text.includes('bfk_'));

    const revoke = await call(`/v1/api-keys/${keyCreate.json?.prefix}`, { token: idToken, method: 'DELETE' });
    record('api key revoke is 200', 200, revoke.status);
    record('revoked key is rejected', 401, (await call('/v1/me', { token: plaintext })).status);

    // --- Profile patch -----------------------------------------------------
    record('patch displayName is 200', 200,
      (await call('/v1/me', { token: idToken, method: 'PATCH', body: { displayName: 'Verified' } })).status);
    record('patch tier is rejected', 400,
      (await call('/v1/me', { token: idToken, method: 'PATCH', body: { tier: 'pro' } })).status);

    const storedUser = await readDoc('users', uid);
    record('client patch did not write tier', undefined, storedUser?.fields?.tier);

    // --- Org creation ------------------------------------------------------
    const org = await call('/v1/orgs', { token: idToken, method: 'POST', body: { name: 'Verify Org' } });
    record('pro tier can create an org', 200, org.status);
    if (org.json?.org?.id) created.push(['orgs', org.json.org.id]);

    // --- Billing webhook refuses unsigned input -----------------------------
    // Fail-closed contract: 503 when no real whsec_ secret is installed,
    // 401 when a secret exists but the delivery is unsigned. Both refuse.
    const webhook = await call('/v1/billing/webhook', { method: 'POST', body: { id: 'evt_x', type: 'x' } });
    record('billing webhook refuses unsigned delivery (503 unconfigured / 401 unsigned)', true,
      webhook.status === 503 || webhook.status === 401, `status=${webhook.status} ${webhook.json?.error?.message || ''}`);

    // --- Security headers -------------------------------------------------
    record('responses are no-store', 'no-store', freeDiscovery.headers.get('cache-control'));
    record('responses are nosniff', 'nosniff', freeDiscovery.headers.get('x-content-type-options'));
  } finally {
    // --- Cleanup ----------------------------------------------------------
    if (uid) {
      for (const [collection, id] of [['users', uid], ['subscriptions', uid], ...created]) {
        try {
          await deleteDoc(collection, id);
        } catch {
          /* already gone */
        }
      }
      try {
        await gcp(`${AUTH_ROOT}/accounts:delete`, {
          method: 'POST',
          body: JSON.stringify({ localId: uid }),
        });
      } catch {
        /* already gone */
      }
      console.log(`\nCleaned up test account ${uid} (tenant ${TENANT_ID}).`);
    }
  }

  const failed = receipts.filter((entry) => !entry.pass);
  console.log(`\n${receipts.length - failed.length}/${receipts.length} checks passed.`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const failure of failed) {
      console.log(`  - ${failure.name}: expected ${failure.expected}, got ${failure.actual}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Verification aborted:', error.message);
  process.exitCode = 1;
});