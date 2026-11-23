import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  verifySignature,
  computeSignature,
  mapStripeSubscription,
  tierFromSubscription,
} from '../src/billing.js';
import { fakeFetcher, PROVIDER_FIXTURES } from './harness.js';

const SECRET = 'whsec_testsecretvalue1234567890';

function sign(body, timestamp = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

test('a correctly signed payload verifies', () => {
  const body = '{"id":"evt_1"}';
  const timestamp = Math.floor(Date.now() / 1000);
  const result = verifySignature({ header: sign(body, timestamp), rawBody: body, secret: SECRET });

  assert.equal(result.ok, true);
  assert.equal(result.timestamp, timestamp);
});

test('a tampered body fails verification', () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const header = sign('{"id":"evt_1"}', timestamp);
  const result = verifySignature({ header, rawBody: '{"id":"evt_2"}', secret: SECRET });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('the wrong secret fails verification', () => {
  const body = '{"id":"evt_1"}';
  const timestamp = Math.floor(Date.now() / 1000);
  const result = verifySignature({
    header: sign(body, timestamp, 'whsec_othersecretvalue12345678'),
    rawBody: body,
    secret: SECRET,
  });

  assert.equal(result.ok, false);
});

test('a stale timestamp is rejected', () => {
  const body = '{"id":"evt_1"}';
  const old = Math.floor(Date.now() / 1000) - 10_000;
  const result = verifySignature({ header: sign(body, old), rawBody: body, secret: SECRET });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timestamp_out_of_tolerance');
});

test('a missing signature header is rejected', () => {
  assert.equal(verifySignature({ header: '', rawBody: '{}', secret: SECRET }).reason, 'missing_signature');
});

test('a missing secret is rejected', () => {
  assert.equal(verifySignature({ header: 't=1,v1=abc', rawBody: '{}', secret: '' }).reason, 'missing_secret');
});

test('multiple v1 signatures are accepted if one matches', () => {
  const body = '{"id":"evt_1"}';
  const timestamp = Math.floor(Date.now() / 1000);
  const valid = computeSignature(SECRET, timestamp, body);
  const header = `t=${timestamp},v1=${'0'.repeat(64)},v1=${valid}`;

  assert.equal(verifySignature({ header, rawBody: body, secret: SECRET }).ok, true);
});

test('mapStripeSubscription converts epoch seconds to ISO', () => {
  const record = mapStripeSubscription({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    current_period_end: 1_800_000_000,
    cancel_at_period_end: false,
    metadata: { tier: 'pro' },
    items: { data: [{ price: { id: 'price_pro' } }] },
  });

  assert.equal(record.tier, 'pro');
  assert.equal(record.status, 'active');
  assert.equal(record.currentPeriodEnd, new Date(1_800_000_000_000).toISOString());
  assert.equal(record.priceId, 'price_pro');
});

test('tier resolution prefers metadata over price id', () => {
  const tier = tierFromSubscription(
    { metadata: { tier: 'plus' }, items: { data: [{ price: { id: 'price_pro' } }] } },
    { price_pro: 'pro' },
  );
  assert.equal(tier, 'plus');
});

test('tier resolution falls back to the price map', () => {
  const tier = tierFromSubscription(
    { metadata: {}, items: { data: [{ price: { id: 'price_pro' } }] } },
    { price_pro: 'pro' },
  );
  assert.equal(tier, 'pro');
});

test('unknown price resolves to free, never upward', () => {
  const tier = tierFromSubscription(
    { metadata: {}, items: { data: [{ price: { id: 'price_mystery' } }] } },
    {},
  );
  assert.equal(tier, 'free');
});

test('an invalid metadata tier is ignored', () => {
  const tier = tierFromSubscription(
    { metadata: { tier: 'platinum' }, items: { data: [{ price: { id: 'price_plus' } }] } },
    { price_plus: 'plus' },
  );
  assert.equal(tier, 'plus');
});

test('the webhook is closed when no secret is configured', async () => {
  const original = process.env.STRIPE_HUB_WEBHOOK_SECRET;
  delete process.env.STRIPE_HUB_WEBHOOK_SECRET;

  try {
    const { handleStripeWebhook } = await import('../src/billing.js');
    await assert.rejects(
      () =>
        handleStripeWebhook({
          req: { headers: {}, rawBody: '{}' },
          store: { getUsage: async () => null },
        }),
      (error) => error.status === 503,
    );
  } finally {
    if (original !== undefined) process.env.STRIPE_HUB_WEBHOOK_SECRET = original;
  }
});

test('an unsigned webhook against a configured deployment is 401', async () => {
  process.env.STRIPE_HUB_WEBHOOK_SECRET = SECRET;
  try {
    const { handleStripeWebhook } = await import('../src/billing.js');
    const store = {
      getUsage: async () => null,
      incrementUsage: async () => ({}),
      setSubscription: async () => ({}),
      appendAudit: async () => {},
      recordStripeEvent: async () => {},
    };

    await assert.rejects(
      () => handleStripeWebhook({ req: { headers: {}, rawBody: '{"id":"evt_1"}' }, store }),
      (error) => error.status === 401,
    );
  } finally {
    delete process.env.STRIPE_HUB_WEBHOOK_SECRET;
  }
});

test('a signed subscription event mutates the subscription record', async () => {
  process.env.STRIPE_HUB_WEBHOOK_SECRET = SECRET;
  try {
    const { handleStripeWebhook } = await import('../src/billing.js');

    const writes = [];
    const store = {
      getUsage: async () => null,
      incrementUsage: async () => ({}),
      // First delivery for this user: nothing stored yet.
      getSubscription: async () => null,
      setSubscription: async (uid, record) => {
        writes.push({ uid, record });
        return record;
      },
      appendAudit: async () => {},
      recordStripeEvent: async () => {},
    };

    const body = JSON.stringify({
      id: 'evt_sub_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          current_period_end: 1_900_000_000,
          metadata: { uid: 'user_123', tier: 'pro' },
          items: { data: [{ price: { id: 'price_pro' } }] },
        },
      },
    });

    const result = await handleStripeWebhook({
      req: { headers: { 'stripe-signature': sign(body) }, rawBody: body },
      store,
    });

    assert.equal(result.ok, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].uid, 'user_123');
    assert.equal(writes[0].record.tier, 'pro');
  } finally {
    delete process.env.STRIPE_HUB_WEBHOOK_SECRET;
  }
});

test('a replayed event is a no-op', async () => {
  process.env.STRIPE_HUB_WEBHOOK_SECRET = SECRET;
  try {
    const { handleStripeWebhook } = await import('../src/billing.js');

    let writes = 0;
    const store = {
      getUsage: async () => ({ count: 1 }),
      incrementUsage: async () => ({}),
      setSubscription: async () => {
        writes += 1;
      },
      appendAudit: async () => {},
      recordStripeEvent: async () => {},
    };

    const body = JSON.stringify({
      id: 'evt_dup',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', metadata: { uid: 'u' } } },
    });

    const result = await handleStripeWebhook({
      req: { headers: { 'stripe-signature': sign(body) }, rawBody: body },
      store,
    });

    assert.equal(result.duplicate, true);
    assert.equal(writes, 0);
  } finally {
    delete process.env.STRIPE_HUB_WEBHOOK_SECRET;
  }
});

test('unrelated event types are acknowledged without mutation', async () => {
  process.env.STRIPE_HUB_WEBHOOK_SECRET = SECRET;
  try {
    const { handleStripeWebhook } = await import('../src/billing.js');
    const store = {
      getUsage: async () => null,
      incrementUsage: async () => ({}),
      setSubscription: async () => {
        throw new Error('should not write');
      },
      appendAudit: async () => {},
      recordStripeEvent: async () => {},
    };

    const body = JSON.stringify({ id: 'evt_other', type: 'charge.succeeded', data: { object: {} } });
    const result = await handleStripeWebhook({
      req: { headers: { 'stripe-signature': sign(body) }, rawBody: body },
      store,
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, null);
  } finally {
    delete process.env.STRIPE_HUB_WEBHOOK_SECRET;
  }
});

// Keep the unused import meaningful for future fixtures.
test('provider fixtures are available to billing tests', () => {
  assert.ok(PROVIDER_FIXTURES.huggingface.length > 0);
  assert.ok(typeof fakeFetcher === 'function');
  assert.ok(typeof createHmac === 'function');
});
// --- Out-of-order delivery -------------------------------------------------
//
// Stripe does not guarantee event ordering and retries on timeout. A delayed
// `deleted` describing an old period must not clobber a newer `created`, which
// would silently drop a paying user to free until their next event.

/** A store that records what the webhook writes. */
function orderingStore(initialSubscription = null) {
  const state = { subscription: initialSubscription, audit: [] };
  return {
    state,
    async getUsage() {
      return null; // no event claims: every delivery is "new"
    },
    async incrementUsage() {
      return {};
    },
    async getSubscription() {
      return state.subscription;
    },
    async setSubscription(uid, record) {
      state.subscription = record;
      return record;
    },
    async appendAudit(entry) {
      state.audit.push(entry);
    },
    async recordStripeEvent(entry) {
      state.events = state.events || [];
      state.events.push(entry);
      return entry;
    },
  };
}

function subscriptionBody({ id, type, tier, periodEndSeconds }) {
  return JSON.stringify({
    id,
    type,
    data: {
      object: {
        id: 'sub_1',
        object: 'subscription',
        customer: 'cus_1',
        status: type === 'customer.subscription.deleted' ? 'canceled' : 'active',
        client_reference_id: 'user_1',
        metadata: { uid: 'user_1', tier },
        cancel_at_period_end: false,
        current_period_end: periodEndSeconds,
        items: { data: [{ price: { id: 'price_x' } }] },
      },
    },
  });
}

test('a stale event does not clobber a newer subscription', async () => {
  process.env.STRIPE_HUB_WEBHOOK_SECRET = SECRET;
  try {
    const { handleStripeWebhook } = await import('../src/billing.js');
    const future = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const store = orderingStore({
      tier: 'pro',
      status: 'active',
      currentPeriodEnd: new Date(future * 1000).toISOString(),
    });

    // A `deleted` describing a period that ended a month ago — stale.
    const stale = subscriptionBody({
      id: 'evt_stale_1',
      type: 'customer.subscription.deleted',
      tier: 'pro',
      periodEndSeconds: future - 60 * 24 * 3600,
    });

    const result = await handleStripeWebhook({
      req: { headers: { 'stripe-signature': sign(stale) }, rawBody: stale },
      store,
    });

    assert.equal(result.stale, true);
    assert.equal(result.applied, null);
    // The newer record survived untouched.
    assert.equal(store.state.subscription.tier, 'pro');
    assert.equal(store.state.subscription.status, 'active');
    assert.ok(store.state.audit.some((e) => e.action === 'billing.stale_skipped'));
    // Billing audit entries carry the full operator-audit schema so the admin
    // console renders actor/target/reason instead of undefined fields.
    const entry = store.state.audit.find((e) => e.action === 'billing.stale_skipped');
    assert.equal(entry.actorUid, 'system');
    assert.equal(entry.targetType, 'billing');
    assert.equal(entry.targetId, 'user_1');
    assert.ok(typeof entry.reason === 'string' && entry.reason.length >= 8);
  } finally {
    delete process.env.STRIPE_HUB_WEBHOOK_SECRET;
  }
});

test('a current event is still applied', async () => {
  process.env.STRIPE_HUB_WEBHOOK_SECRET = SECRET;
  try {
    const { handleStripeWebhook } = await import('../src/billing.js');
    const past = Math.floor(Date.now() / 1000) - 24 * 3600;
    const future = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const store = orderingStore({
      tier: 'plus',
      status: 'active',
      currentPeriodEnd: new Date(past * 1000).toISOString(),
    });

    const fresh = subscriptionBody({
      id: 'evt_fresh_1',
      type: 'customer.subscription.updated',
      tier: 'pro',
      periodEndSeconds: future,
    });

    const result = await handleStripeWebhook({
      req: { headers: { 'stripe-signature': sign(fresh) }, rawBody: fresh },
      store,
    });

    assert.equal(result.applied, 'customer.subscription.updated');
    assert.equal(store.state.subscription.tier, 'pro');
  } finally {
    delete process.env.STRIPE_HUB_WEBHOOK_SECRET;
  }
});

test('equal period ends are applied, not treated as stale', async () => {
  process.env.STRIPE_HUB_WEBHOOK_SECRET = SECRET;
  try {
    const { handleStripeWebhook } = await import('../src/billing.js');
    const future = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const store = orderingStore({
      tier: 'plus',
      status: 'active',
      currentPeriodEnd: new Date(future * 1000).toISOString(),
    });

    // Same period, tier upgrade — the normal in-period updated event.
    const samePeriod = subscriptionBody({
      id: 'evt_same_1',
      type: 'customer.subscription.updated',
      tier: 'pro',
      periodEndSeconds: future,
    });

    const result = await handleStripeWebhook({
      req: { headers: { 'stripe-signature': sign(samePeriod) }, rawBody: samePeriod },
      store,
    });

    assert.equal(result.stale, undefined);
    assert.equal(store.state.subscription.tier, 'pro');
  } finally {
    delete process.env.STRIPE_HUB_WEBHOOK_SECRET;
  }
});
