/**
 * Live verification of first-login profile provisioning (deployed hubApi).
 *
 * Unlike verify-live.mjs (which writes the user doc with admin creds), this
 * script creates a throwaway Firebase account and deliberately does NOT write
 * a Firestore user document. The first authenticated GET /v1/me must provision
 * a free profile server-side; before the ensureProfile change this returned 404.
 *
 *   node scripts/verify-provisioning-live.mjs
 *
 * Uses the active gcloud account for admin REST; the public web API key for the
 * first-party sign-in exchange. Cleans up the account + docs in `finally`.
 */

import { execFileSync } from 'node:child_process';

const PROJECT = 'blackfrost-ai-prod';
const DATABASE = 'blackfrost-hub';
const BASE = 'https://us-central1-blackfrost-ai-prod.cloudfunctions.net/hubApi';
// Public Firebase web API key (identifier, not a secret) — same as the site/app.
const API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDGQ6mJ9RQatE7fGPo43YSFXf9Rl1o8oAU';
const TEST_EMAIL = 'hub-provision-test@blackfrost-ai-prod.example.com';
const TEST_PASSWORD = `Vf-${Date.now()}-Aa9!`;

function accessToken() {
  return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
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
  try { json = JSON.parse(text); } catch { /* non-JSON is a finding */ }
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
  try { json = JSON.parse(text); } catch { /* non-JSON is a finding */ }
  return { status: response.status, json, text };
}

const docUrl = (collection, id) =>
  `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${collection}/${encodeURIComponent(id)}`;

async function readDoc(collection, id) {
  const result = await gcp(docUrl(collection, id));
  return result.status === 200 ? result.json : null;
}
async function deleteDoc(collection, id) {
  return gcp(docUrl(collection, id), { method: 'DELETE' });
}

async function main() {
  TOKEN = accessToken();
  let uid = '';
  const created = [];

  try {
    // Remove any prior throwaway account so we start genuinely fresh.
    const existing = await gcp(
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`,
      { method: 'POST', body: JSON.stringify({ email: [TEST_EMAIL] }) },
    );
    for (const user of existing.json?.users || []) {
      await gcp(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`, {
        method: 'POST', body: JSON.stringify({ localId: user.localId }),
      });
      await deleteDoc('users', user.localId);
    }

    // Create the Firebase identity ONLY — no Firestore user document.
    const signUp = await gcp(
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`,
      { method: 'POST', body: JSON.stringify({ email: TEST_EMAIL, emailVerified: true, password: TEST_PASSWORD }) },
    );
    uid = signUp.json?.localId || '';
    if (!uid) throw new Error(`Could not create test user: ${signUp.text}`);
    console.log(`\nFresh account uid: ${uid} (no Firestore doc written)\n`);

    // Confirm there really is no profile before the first call.
    const before = await readDoc('users', uid);
    record('no user doc exists before first call', null, before);

    // First-party sign-in → real Firebase ID token.
    const signIn = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, returnSecureToken: true }),
      },
    );
    const session = await signIn.json();
    if (!session.idToken) throw new Error(`Sign-in failed: ${JSON.stringify(session)}`);
    const idToken = session.idToken;

    // THE key assertion: first authenticated /v1/me provisions instead of 404.
    const me = await call('/v1/me', { token: idToken });
    record('first GET /v1/me is 200 (was 404 pre-fix)', 200, me.status, me.json?.error?.message || '');
    record('provisioned uid matches', uid, me.json?.uid);
    record('provisioned tier is free', 'free', me.json?.entitlement?.tier);
    record('provisioned email carried from token', TEST_EMAIL, me.json?.email);

    // The profile must now be durably stored with tier free.
    const after = await readDoc('users', uid);
    record('user doc now exists in Firestore', true, Boolean(after));
    record('stored tier is free', 'free', after?.fields?.tier?.stringValue);
    record('stored disabled is false', false, after?.fields?.disabled?.booleanValue);
    created.push(['users', uid]);

    // Idempotent: a second call must not 404 or change the tier.
    const me2 = await call('/v1/me', { token: idToken });
    record('second GET /v1/me is 200', 200, me2.status);
    record('second call still free', 'free', me2.json?.entitlement?.tier);

    // PATCH on the freshly provisioned profile works.
    const patch = await call('/v1/me', { token: idToken, method: 'PATCH', body: { displayName: 'Provisioned' } });
    record('PATCH /v1/me is 200', 200, patch.status);
    const patched = await readDoc('users', uid);
    record('displayName persisted', 'Provisioned', patched?.fields?.displayName?.stringValue);
    record('PATCH did not elevate tier', 'free', patched?.fields?.tier?.stringValue);

    // A client cannot self-grant a paid tier.
    const evil = await call('/v1/me', { token: idToken, method: 'PATCH', body: { tier: 'pro' } });
    record('client PATCH tier is rejected (400)', 400, evil.status);
  } finally {
    if (uid) {
      for (const [collection, id] of created) {
        try { await deleteDoc(collection, id); } catch { /* already gone */ }
      }
      try {
        await gcp(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`, {
          method: 'POST', body: JSON.stringify({ localId: uid }),
        });
      } catch { /* already gone */ }
      console.log(`\nCleaned up test account ${uid}.`);
    }
  }

  const failed = receipts.filter((entry) => !entry.pass);
  console.log(`\n${receipts.length - failed.length}/${receipts.length} checks passed.`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const failure of failed) console.log(`  - ${failure.name}: expected ${failure.expected}, got ${failure.actual}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Verification aborted:', error.message);
  process.exitCode = 1;
});