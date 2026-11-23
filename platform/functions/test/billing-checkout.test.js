/**
 * Checkout and portal session creation.
 *
 * The critical property under test: **the client never supplies a price or an
 * amount.** It sends a plan name; the server maps that to a configured price.
 * If that ever regresses, a user could post a $0 price and grant themselves Pro.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePriceId, encodeForm, createCheckoutSession } from '../src/billing-checkout.js';
import { HubError } from '../src/http.js';

const ENV = {
  // A fake, obviously-not-live key. The module only checks the `sk_` prefix.
  STRIPE_SECRET_KEY: 'sk_test_fakefixturekey123',
  SITE_URL: 'https://frostbyte.si',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_plusmonthly123',
  STRIPE_PRICE_PLUS_YEARLY: 'price_plusyearly1234',
  STRIPE_PRICE_PRO_MONTHLY: 'price_promonthly1234',
  STRIPE_PRICE_PRO_YEARLY: 'price_proyearly12345',
};

function fakeStore(overrides = {}) {
  const users = new Map();
  const audit = [];
  return {
    users,
    audit,
    async getUser(uid) {
      return users.get(uid) || null;
    },
    async setUser(uid, record) {
      users.set(uid, { ...record, uid });
      return users.get(uid);
    },
    async updateUser(uid, patch) {
      const existing = users.get(uid);
      if (!existing) return null;
      users.set(uid, { ...existing, ...patch });
      return users.get(uid);
    },
    async appendAudit(entry) {
      audit.push(entry);
    },
    ...overrides,
  };
}

/** A fetcher that records calls and returns a canned Stripe response. */
function fakeFetcher(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  fn.calls = calls;
  return fn;
}

test('resolvePriceId maps plan and interval to configured price', () => {
  assert.equal(resolvePriceId('plus', 'monthly', ENV), 'price_plusmonthly123');
  assert.equal(resolvePriceId('plus', 'yearly', ENV), 'price_plusyearly1234');
  assert.equal(resolvePriceId('pro', 'monthly', ENV), 'price_promonthly1234');
});

test('resolvePriceId rejects an unknown plan', () => {
  assert.throws(() => resolvePriceId('enterprise', 'monthly', ENV), HubError);
});

test('resolvePriceId rejects an unknown interval', () => {
  assert.throws(() => resolvePriceId('plus', 'weekly', ENV), HubError);
});

test('resolvePriceId fails closed when the price is unset', () => {
  // A missing price must not silently fall back to a free tier.
  assert.throws(() => resolvePriceId('plus', 'monthly', {}), (err) => {
    assert.ok(err instanceof HubError);
    assert.equal(err.status, 503);
    return true;
  });
});

test('resolvePriceId rejects a malformed price id', () => {
  assert.throws(
    () => resolvePriceId('plus', 'monthly', { STRIPE_PRICE_PLUS_MONTHLY: 'not-a-price' }),
    HubError,
  );
});

test('encodeForm produces Stripe bracket notation', () => {
  const encoded = encodeForm({
    mode: 'subscription',
    line_items: [{ price: 'price_x', quantity: 1 }],
    metadata: { uid: 'u1' },
  }).join('&');

  assert.match(encoded, /mode=subscription/);
  // Arrays must use index notation. A bare String(array) serializes as
  // "[object Object]" and Stripe rejects it — this is the regression guard.
  assert.match(encoded, /line_items%5B0%5D%5Bprice%5D=price_x/);
  assert.match(encoded, /line_items%5B0%5D%5Bquantity%5D=1/);
  assert.doesNotMatch(encoded, /object Object/);
  assert.match(encoded, /metadata%5Buid%5D=u1/);
});

test('encodeForm encodes arrays of scalars with index notation', () => {
  const encoded = encodeForm({ payment_method_types: ['card', 'link'] }).join('&');
  assert.equal(
    encoded,
    'payment_method_types%5B0%5D=card&payment_method_types%5B1%5D=link',
  );
});

test('encodeForm escapes values that would break the form body', () => {
  const encoded = encodeForm({ a: 'x&b=c' }).join('&');
  assert.equal(encoded, 'a=x%26b%3Dc');
});

test('checkout sends a plan name, never a client-supplied price', async () => {
  const store = fakeStore();
  const fetcher = fakeFetcher([
    { body: { id: 'cus_abc12345' } },
    { body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/x' } },
  ]);

  const result = await createCheckoutSession({
    store,
    identity: { uid: 'u1', email: 'a@b.test' },
    plan: 'plus',
    interval: 'monthly',
    fetcher,
    env: ENV,
  });

  assert.equal(result.url, 'https://checkout.stripe.com/x');

  const sessionCall = fetcher.calls.at(-1);
  const body = decodeURIComponent(sessionCall.body);
  // The price comes from config, not from the caller.
  assert.match(body, /line_items\[0\]\[price\]=price_plusmonthly123/);
  assert.match(body, /line_items\[0\]\[quantity\]=1/);
  assert.match(body, /client_reference_id=u1/);
  assert.match(body, /metadata\[uid\]=u1/);
  assert.match(body, /mode=subscription/);
  // Guard the binding: the session must not be a one-off payment.
  assert.doesNotMatch(body, /mode=payment/);
});

test('checkout reuses an existing Stripe customer', async () => {
  const store = fakeStore();
  store.users.set('u1', { uid: 'u1', stripeCustomerId: 'cus_existing1' });

  const fetcher = fakeFetcher([{ body: { id: 'cs_test_2', url: 'https://checkout.stripe.com/y' } }]);

  await createCheckoutSession({
    store,
    identity: { uid: 'u1', email: 'a@b.test' },
    plan: 'pro',
    interval: 'monthly',
    fetcher,
    env: ENV,
  });

  // Exactly one call: the session. No customer creation.
  assert.equal(fetcher.calls.length, 1);
  assert.match(fetcher.calls[0].url, /checkout\/sessions/);
});

test('checkout creates a customer once and persists the id', async () => {
  const store = fakeStore();
  const fetcher = fakeFetcher([
    { body: { id: 'cus_new12345' } },
    { body: { id: 'cs_test_3', url: 'https://checkout.stripe.com/z' } },
  ]);

  await createCheckoutSession({
    store,
    identity: { uid: 'u1', email: 'a@b.test' },
    plan: 'plus',
    interval: 'monthly',
    fetcher,
    env: ENV,
  });

  assert.equal(store.users.get('u1').stripeCustomerId, 'cus_new12345');
});

test('checkout rejects an unauthenticated caller', async () => {
  await assert.rejects(
    () =>
      createCheckoutSession({
        store: fakeStore(),
        identity: null,
        plan: 'plus',
        fetcher: fakeFetcher([]),
        env: ENV,
      }),
    (err) => {
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test('checkout surfaces a Stripe failure without leaking detail', async () => {
  const store = fakeStore();
  store.users.set('u1', { uid: 'u1', stripeCustomerId: 'cus_existing1' });

  const fetcher = fakeFetcher([
    {
      ok: false,
      status: 400,
      body: { error: { type: 'invalid_request_error', message: 'internal detail here' } },
    },
  ]);

  await assert.rejects(
    () =>
      createCheckoutSession({
        store,
        identity: { uid: 'u1', email: 'a@b.test' },
        plan: 'plus',
        fetcher,
        env: ENV,
      }),
    (err) => {
      assert.equal(err.status, 502);
      // The client-facing message must not echo Stripe's internals.
      assert.doesNotMatch(err.message, /internal detail here/);
      return true;
    },
  );
});

test('checkout rejects a session with a non-https url', async () => {
  const store = fakeStore();
  store.users.set('u1', { uid: 'u1', stripeCustomerId: 'cus_existing1' });

  const fetcher = fakeFetcher([{ body: { id: 'cs_1', url: 'javascript:alert(1)' } }]);

  await assert.rejects(
    () =>
      createCheckoutSession({
        store,
        identity: { uid: 'u1', email: 'a@b.test' },
        plan: 'plus',
        fetcher,
        env: ENV,
      }),
    HubError,
  );
});