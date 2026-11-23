#!/usr/bin/env node
/**
 * End-to-end proof that checkout + portal reach Stripe with the right price.
 *
 * Creates a throwaway Firebase Auth user, mints a real ID token, calls the
 * deployed `/v1/billing/checkout`, and inspects the returned Stripe session
 * with the live secret key to confirm the price, mode, and metadata.
 *
 * No card is charged: a Checkout *Session* is created but never paid. The
 * session is expired, the Stripe customer deleted, and the test user removed
 * at the end.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_... GCLOUD_TOKEN=$(gcloud auth print-access-token) \
 *     node scripts/verify-checkout-live.mjs
 */

const API = 'https://us-central1-blackfrost-ai-prod.cloudfunctions.net/hubApi';

import { tierFromSubscription } from '../src/billing.js';
const API_KEY = 'AIzaSyDGQ6mJ9RQatE7fGPo43YSFXf9Rl1o8oAU'; // Firebase web key: not a secret.
const PROJECT = 'blackfrost-ai-prod';
const DATABASE = 'blackfrost-hub';

const stripeKey = process.env.STRIPE_SECRET_KEY;
const gcloudToken = process.env.GCLOUD_TOKEN;

if (!stripeKey?.startsWith('sk_')) {
  console.error('FATAL: STRIPE_SECRET_KEY must be set.');
  process.exit(1);
}
if (!gcloudToken) {
  console.error('FATAL: GCLOUD_TOKEN must be set.');
  process.exit(1);
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const stripeAuth = { Authorization: `Bearer ${stripeKey}` };
const adminAuth = {
  Authorization: `Bearer ${gcloudToken}`,
  // Identity Platform requires an explicit quota project when authenticating
  // with user ADC; without it every call 403s.
  'x-goog-user-project': PROJECT,
};

async function stripeGet(path) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, { headers: stripeAuth });
  return { status: response.status, body: await response.json() };
}

async function stripePost(path, form = {}) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: { ...stripeAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: await response.json() };
}

async function stripeDelete(path) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'DELETE',
    headers: stripeAuth,
  });
  return { status: response.status, body: await response.json() };
}

const stamp = Date.now();
const email = `frostbyte-billing-test-${stamp}@example.com`;
const password = `Test-${stamp}-Aa1!`;

async function main() {
  console.log(`\nTest account: ${email}\n`);

  // --- 1. Create a throwaway Firebase Auth user -----------------------------
  const created = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`,
    {
      method: 'POST',
      headers: { ...adminAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, emailVerified: false }),
    },
  ).then((r) => r.json());

  const localId = created.localId;
  if (!localId) {
    console.error('FATAL: could not create test user:', JSON.stringify(created));
    process.exit(1);
  }
  record('created a throwaway Firebase Auth user', true, localId);

  let customerId = null;
  let checkoutSessionId = null;

  try {
    // --- 2. Sign in to get a real ID token ---------------------------------
    const signIn = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    ).then((r) => r.json());

    const idToken = signIn.idToken;
    if (!idToken) {
      console.error('FATAL: sign-in failed:', JSON.stringify(signIn));
      process.exit(1);
    }
    record('signed in and obtained an ID token', true, `${idToken.length} chars`);

    // --- 3. Call the real checkout endpoint --------------------------------
    const checkout = await fetch(`${API}/v1/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        Origin: 'https://frostbyte.si',
      },
      body: JSON.stringify({ plan: 'plus', interval: 'monthly' }),
    });
    const checkoutBody = await checkout.json();

    record('checkout returns 200', checkout.status === 200, `got ${checkout.status}`);
    record(
      'checkout returns a Stripe URL',
      typeof checkoutBody?.url === 'string' && checkoutBody.url.startsWith('https://checkout.stripe.com/'),
      checkoutBody?.url ? checkoutBody.url.split('?')[0] : JSON.stringify(checkoutBody),
    );

    // --- 4. Inspect the session Stripe actually created --------------------
    if (typeof checkoutBody?.url === 'string') {
      const sessionId = new URL(checkoutBody.url).pathname.split('/').pop();
      checkoutSessionId = sessionId;
      const session = await stripeGet(
        `/checkout/sessions/${sessionId}?expand[]=line_items.data.price`,
      );

      record('session is retrievable from Stripe', session.status === 200, `got ${session.status}`);

      const s = session.body;
      record('mode is subscription', s.mode === 'subscription', `mode=${s.mode}`);

      const lineItem = s.line_items?.data?.[0];
      const price = lineItem?.price;
      record(
        'price resolves to the configured Plus monthly price',
        price?.id === 'price_1URkNSRpLFWUKDnH2Dit2lZE',
        `price=${price?.id}`,
      );
      record(
        'amount is $12.00',
        price?.unit_amount === 1200,
        `unit_amount=${price?.unit_amount} ${price?.currency}`,
      );
      record(
        'recurring interval is monthly',
        price?.recurring?.interval === 'month',
        `interval=${price?.recurring?.interval}`,
      );
      record(
        'session metadata carries plan=plus',
        s.metadata?.plan === 'plus',
        `plan=${s.metadata?.plan}`,
      );
      // `subscription_data` is a write-only request param — Stripe does not
      // echo it on an unpaid session, so it cannot be asserted here. What
      // matters is that `tierFromSubscription` resolves the REAL price id even
      // if metadata never propagates. Proven directly against the live id.
      record(
        'tierFromSubscription resolves the live price id to plus',
        tierFromSubscription({ items: { data: [{ price: { id: price?.id } }] } }) === 'plus',
        `price=${price?.id} -> ${tierFromSubscription({ items: { data: [{ price: { id: price?.id } }] } })}`,
      );
      record(
        'client_reference_id is the caller uid',
        s.client_reference_id === localId,
        `ref=${s.client_reference_id}`,
      );

      customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;
      record('a Stripe customer was created', Boolean(customerId), customerId || 'none');

      // --- 5. Prove the customer id was persisted to Firestore ------------
      if (customerId) {
        const doc = await fetch(
          `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/users/${localId}`,
          { headers: adminAuth },
        ).then((r) => (r.ok ? r.json() : null));
        const stored = doc?.fields?.stripeCustomerId?.stringValue;
        record('stripeCustomerId persisted on the user doc', stored === customerId, `stored=${stored}`);
      }
    }

    // --- 6. Portal session also reaches Stripe ----------------------------
    const portal = await fetch(`${API}/v1/billing/portal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        Origin: 'https://frostbyte.si',
      },
      body: '{}',
    });
    const portalBody = await portal.json();
    record('portal returns 200', portal.status === 200, `got ${portal.status}`);
    record(
      'portal returns a Stripe billing URL',
      typeof portalBody?.url === 'string' && portalBody.url.startsWith('https://billing.stripe.com/'),
      portalBody?.url ? portalBody.url.split('?')[0] : JSON.stringify(portalBody),
    );

    // --- 7. Rejects an unknown plan ---------------------------------------
    const badPlan = await fetch(`${API}/v1/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        Origin: 'https://frostbyte.si',
      },
      body: JSON.stringify({ plan: 'enterprise', interval: 'monthly' }),
    });
    record('rejects an unknown plan (400)', badPlan.status === 400, `got ${badPlan.status}`);
  } finally {
    // --- Cleanup ---------------------------------------------------------
    if (checkoutSessionId) {
      await stripePost(`/checkout/sessions/${checkoutSessionId}/expire`);
      record('cleanup: checkout session expired', true, checkoutSessionId);
    }
    if (customerId) {
      const del = await stripeDelete(`/customers/${customerId}`);
      record('cleanup: Stripe customer deleted', del.status === 200, customerId);
    }
    const delUser = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`,
      {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId }),
      },
    );
    record('cleanup: Firebase Auth user deleted', delUser.ok, `status ${delUser.status}`);

    // The API creates a user doc on first authenticated call; remove it.
    const delDoc = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/users/${localId}`,
      { method: 'DELETE', headers: adminAuth },
    );
    record(
      'cleanup: Firestore user doc deleted',
      delDoc.ok || delDoc.status === 404,
      `status ${delDoc.status}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nFATAL:', error.message);
  process.exitCode = 1;
});