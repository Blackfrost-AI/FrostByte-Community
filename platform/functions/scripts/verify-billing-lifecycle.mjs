#!/usr/bin/env node
/**
 * Prove the Stripe webhook lifecycle against the DEPLOYED hubApi.
 *
 * Why this exists: the Stripe account is in live mode. Driving a real
 * subscription means charging a real card, which is the operator's call. This
 * script instead signs payloads with the live `whsec_` and posts them at the
 * real endpoint, so the production code path runs end to end —
 *
 *     HTTP -> signature verify -> event dedupe -> entitlement write -> Firestore
 *
 * — with zero money movement. It also proves the failure modes: a bad
 * signature must be rejected, and a replayed event must not double-apply.
 *
 * Usage:
 *   STRIPE_WEBHOOK_SECRET=whsec_... GCLOUD_TOKEN=$(gcloud auth print-access-token) \
 *     node scripts/verify-billing-lifecycle.mjs
 *
 * Cleans up after itself: the throwaway uid's subscription and usage docs are
 * deleted at the end.
 */

import { createHmac } from 'node:crypto';

const API = 'https://us-central1-blackfrost-ai-prod.cloudfunctions.net/hubApi';
const WEBHOOK = `${API}/v1/billing/webhook`;
const PROJECT = 'blackfrost-ai-prod';
const DATABASE = 'blackfrost-hub';
const FIREBASE_PROJECT = 'blackfrost-ai-prod';

const secret = process.env.STRIPE_WEBHOOK_SECRET;
const token = process.env.GCLOUD_TOKEN;
const uid = process.env.TEST_UID || `lifecycle-test-${Date.now()}`;

if (!secret || !secret.startsWith('whsec_')) {
  console.error('FATAL: STRIPE_WEBHOOK_SECRET must be set to a whsec_ value.');
  process.exit(1);
}
if (!token) {
  console.error('FATAL: GCLOUD_TOKEN must be set (gcloud auth print-access-token).');
  process.exit(1);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Build a Stripe-Signature header for a raw body. */
function sign(rawBody, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

async function postWebhook(rawBody, { signature, timestampSeconds } = {}) {
  const header = signature ?? sign(rawBody, timestampSeconds);
  const response = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: rawBody,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  return { status: response.status, body: parsed, text };
}

/** Minimal Stripe subscription event. */
function subscriptionEvent({ id, type, tier, status, customer, subscriptionId }) {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: subscriptionId,
        object: 'subscription',
        customer,
        status,
        client_reference_id: uid,
        metadata: { uid, tier, interval: 'monthly' },
        cancel_at_period_end: false,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        items: { data: [{ price: { id: 'price_test_placeholder' } }] },
      },
    },
  });
}

// --- Firestore REST helpers -------------------------------------------------

const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents`;
const authHeaders = { Authorization: `Bearer ${token}` };

async function fsGet(collection, docId) {
  const response = await fetch(`${FS}/${collection}/${encodeURIComponent(docId)}`, {
    headers: authHeaders,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore GET ${collection}/${docId} -> ${response.status}`);
  return response.json();
}

async function fsDelete(collection, docId) {
  const response = await fetch(`${FS}/${collection}/${encodeURIComponent(docId)}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  return response.ok || response.status === 404;
}

/** Unwrap a Firestore REST value. */
function unwrap(value) {
  if (!value || typeof value !== 'object') return value;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('mapValue' in value) {
    const out = {};
    for (const [k, v] of Object.entries(value.mapValue.fields || {})) out[k] = unwrap(v);
    return out;
  }
  return value;
}

function fieldsOf(doc) {
  if (!doc?.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = unwrap(v);
  return out;
}

// --- The lifecycle ---------------------------------------------------------

async function main() {
  console.log(`\nTarget: ${WEBHOOK}`);
  console.log(`Test uid: ${uid}\n`);

  const customer = `cus_lifecycle_${Date.now()}`;
  const subscriptionId = `sub_lifecycle_${Date.now()}`;
  // Declared up front so cleanup can reference them regardless of how far we get.
  const createdId = `evt_created_${Date.now()}`;
  const updatedId = `evt_updated_${Date.now()}`;
  const deletedId = `evt_deleted_${Date.now()}`;

  // 0. Baseline: no subscription record should exist yet.
  const before = await fsGet('subscriptions', uid);
  record('baseline: no subscription record', before === null, before ? 'record already existed' : '');

  // 1. Bad signature must be rejected. This is the security-critical one:
  //    an unsigned or tampered body must never move an entitlement.
  {
    const body = subscriptionEvent({
      id: `evt_bad_${Date.now()}`,
      type: 'customer.subscription.created',
      tier: 'pro',
      status: 'active',
      customer,
      subscriptionId,
    });
    const response = await postWebhook(body, { signature: 't=1,v1=' + '0'.repeat(64) });
    record(
      'rejects a forged signature (401)',
      response.status === 401,
      `got ${response.status}`,
    );
    const stillNothing = await fsGet('subscriptions', uid);
    record(
      'forged event wrote nothing',
      stillNothing === null,
      stillNothing ? 'record appeared after forged event' : '',
    );
  }

  // 2. Missing signature header.
  {
    const body = subscriptionEvent({
      id: `evt_nosig_${Date.now()}`,
      type: 'customer.subscription.created',
      tier: 'pro',
      status: 'active',
      customer,
      subscriptionId,
    });
    const response = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    record('rejects a missing signature (401)', response.status === 401, `got ${response.status}`);
  }

  // 3. A correctly signed `created` event grants Plus.
  {
    const body = subscriptionEvent({
      id: createdId,
      type: 'customer.subscription.created',
      tier: 'plus',
      status: 'active',
      customer,
      subscriptionId,
    });
    const response = await postWebhook(body);
    record('applies a signed subscription.created (200)', response.status === 200, `got ${response.status}`);

    const doc = fieldsOf(await fsGet('subscriptions', uid));
    record(
      'persists tier=plus to Firestore',
      doc?.tier === 'plus',
      `stored tier=${JSON.stringify(doc?.tier)}`,
    );
    record(
      'persists status=active',
      doc?.status === 'active',
      `stored status=${JSON.stringify(doc?.status)}`,
    );
  }

  // 4. Replay the SAME event id — must be a no-op, not a double-apply.
  {
    const docBefore = fieldsOf(await fsGet('subscriptions', uid));
    const body = subscriptionEvent({
      id: createdId,
      type: 'customer.subscription.created',
      tier: 'plus',
      status: 'active',
      customer,
      subscriptionId,
    });
    const response = await postWebhook(body);
    record('replayed event returns 200', response.status === 200, `got ${response.status}`);
    record('replayed event is flagged duplicate', response.body?.duplicate === true, JSON.stringify(response.body));
    const docAfter = fieldsOf(await fsGet('subscriptions', uid));
    record(
      'replay did not change the record',
      docBefore?.updatedAt === docAfter?.updatedAt,
      docBefore?.updatedAt === docAfter?.updatedAt ? '' : 'updatedAt changed on replay',
    );
  }

  // 5. An `updated` event upgrades to Pro.
  {
    const body = subscriptionEvent({
      id: updatedId,
      type: 'customer.subscription.updated',
      tier: 'pro',
      status: 'active',
      customer,
      subscriptionId,
    });
    const response = await postWebhook(body);
    record('applies a signed subscription.updated (200)', response.status === 200, `got ${response.status}`);
    const doc = fieldsOf(await fsGet('subscriptions', uid));
    record('upgrades stored tier to pro', doc?.tier === 'pro', `stored tier=${JSON.stringify(doc?.tier)}`);
  }

  // 6. A `deleted` event drops to free.
  {
    const body = subscriptionEvent({
      id: deletedId,
      type: 'customer.subscription.deleted',
      tier: 'pro',
      status: 'canceled',
      customer,
      subscriptionId,
    });
    const response = await postWebhook(body);
    record('applies a signed subscription.deleted (200)', response.status === 200, `got ${response.status}`);
    const doc = fieldsOf(await fsGet('subscriptions', uid));
    record(
      'marks the subscription canceled',
      doc?.status === 'canceled',
      `stored status=${JSON.stringify(doc?.status)}`,
    );
  }

  // 7. A stale timestamp must be rejected (replay-window protection).
  {
    const body = subscriptionEvent({
      id: `evt_stale_${Date.now()}`,
      type: 'customer.subscription.updated',
      tier: 'pro',
      status: 'active',
      customer,
      subscriptionId,
    });
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const response = await postWebhook(body, { timestampSeconds: stale });
    record('rejects a stale timestamp (401)', response.status === 401, `got ${response.status}`);
  }

  // --- Cleanup ---
  //
  // Two kinds of debris: the subscription record, and the per-event claim docs
  // the webhook writes to `usage`. Claim doc ids are `stripeEvent:<eventId>:seen`
  // — note the `:seen` suffix, which is the day field.
  const cleanedSubscription = await fsDelete('subscriptions', uid);

  const eventIds = [createdId, updatedId, deletedId].filter(Boolean);
  let cleanedClaims = 0;
  for (const eventId of eventIds) {
    if (await fsDelete('usage', `stripeEvent:${eventId}:seen`)) cleanedClaims += 1;
  }
  record('cleanup: subscription record removed', cleanedSubscription);
  record(
    `cleanup: ${cleanedClaims}/${eventIds.length} event-claim docs removed`,
    cleanedClaims === eventIds.length,
    cleanedClaims === eventIds.length ? '' : 'leftover claim docs remain',
  );

  // --- Summary ---
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail || '(no detail)'}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nFATAL:', error.message);
  process.exitCode = 1;
});