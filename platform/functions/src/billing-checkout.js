/**
 * Stripe Checkout + Billing Portal session creation.
 *
 * Calls the Stripe REST API directly rather than pulling in the SDK. The
 * webhook already verifies signatures by hand, so this keeps one dependency
 * surface and one obvious place where the request shape lives.
 *
 * Security notes:
 *
 * - The **price is resolved server-side** from a plan name. A client sends
 *   `{ plan: "plus" }`, never a price ID or an amount — otherwise a user could
 *   post a $0 price and grant themselves Pro.
 * - `client_reference_id` and `metadata.uid` are both set so the webhook can
 *   resolve the account regardless of which field it reads.
 * - The customer is looked up or created once and stored, so a user cannot
 *   accumulate duplicate Stripe customers by checking out twice.
 * - Inert without `STRIPE_SECRET_KEY`, mirroring the webhook's fail-closed
 *   behaviour: billing is 503 until configured rather than half-working.
 */

import { HubError, badRequest, unauthorized, unavailable } from './http.js';

const STRIPE_API = 'https://api.stripe.com/v1';

/** Plan name → env var holding the Stripe price ID. */
const PLAN_PRICE_ENV = {
  'plus:monthly': 'STRIPE_PRICE_PLUS_MONTHLY',
  'plus:yearly': 'STRIPE_PRICE_PLUS_YEARLY',
  'pro:monthly': 'STRIPE_PRICE_PRO_MONTHLY',
  'pro:yearly': 'STRIPE_PRICE_PRO_YEARLY',
};

const ALLOWED_INTERVALS = new Set(['monthly', 'yearly']);
const ALLOWED_PLANS = new Set(['plus', 'pro']);

function stripeKey(env = process.env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(key)) {
    throw unavailable('Billing is not configured on this deployment.');
  }
  return key;
}

/**
 * Resolve a plan+interval to a Stripe price ID.
 *
 * Fails closed: an unconfigured price is a 503, not a silent free upgrade.
 */
export function resolvePriceId(plan, interval, env = process.env) {
  if (!ALLOWED_PLANS.has(plan)) throw badRequest('Unknown plan.');
  if (!ALLOWED_INTERVALS.has(interval)) throw badRequest('Unknown billing interval.');

  const envName = PLAN_PRICE_ENV[`${plan}:${interval}`];
  const priceId = env[envName];
  if (!priceId || !/^price_[A-Za-z0-9]{8,}$/.test(priceId)) {
    throw unavailable(`No price configured for ${plan} ${interval}.`);
  }
  return priceId;
}

/**
 * URL-encode Stripe's nested form body: `a[b][c]=v`, arrays as `a[0][b]=v`.
 *
 * Stripe's API is form-encoded, not JSON, so nested objects and arrays need
 * bracket notation. Arrays must use index notation — a bare `String(array)`
 * would serialize as `[object Object]` and be rejected.
 */
function encodeForm(pairs, prefix = '', out = []) {
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item === undefined || item === null) return;
        if (typeof item === 'object') {
          encodeForm(item, `${name}[${index}]`, out);
        } else {
          out.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof value === 'object') {
      encodeForm(value, name, out);
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return out;
}

async function stripeRequest(path, body, { fetcher = fetch, env = process.env } = {}) {
  const response = await fetcher(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey(env)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encodeForm(body).join('&'),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HubError(502, 'stripe_bad_response', 'Stripe returned a non-JSON response.');
  }

  if (!response.ok) {
    // Surface Stripe's message server-side for operators, but do not leak
    // account or configuration detail to the client.
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: 'stripe_request_failed',
        path,
        status: response.status,
        type: parsed?.error?.type,
        detail: parsed?.error?.message,
      }),
    );
    throw new HubError(502, 'stripe_error', 'Could not reach the billing provider.');
  }

  return parsed;
}

/**
 * Find or create the Stripe customer for this account.
 *
 * Stored on the user record so repeat checkouts reuse one customer rather than
 * creating a new one each time (which would fragment billing history and make
 * the portal confusing).
 */
async function ensureCustomer({ store, uid, email, now, fetcher, env }) {
  const user = await store.getUser(uid);
  const existing = user?.stripeCustomerId;
  if (typeof existing === 'string' && existing.startsWith('cus_')) return existing;

  const customer = await stripeRequest(
    '/customers',
    {
      email: email || undefined,
      metadata: { uid },
      description: `FrostByte account ${uid}`,
    },
    { fetcher, env },
  );

  if (!customer?.id?.startsWith('cus_')) {
    throw new HubError(502, 'stripe_bad_response', 'Stripe did not return a customer id.');
  }

  // `setUser` replaces the record, so merge rather than overwrite — otherwise a
  // display name or locale set earlier would be silently dropped.
  if (user) {
    await store.updateUser(uid, { stripeCustomerId: customer.id });
  } else {
    await store.setUser(uid, { email: email || '', stripeCustomerId: customer.id });
  }

  return customer.id;
}

function siteUrl(env = process.env) {
  return env.SITE_URL || 'https://frostbyte.si';
}

/**
 * Create a Checkout Session for a subscription.
 *
 * @returns {Promise<{url: string, sessionId: string}>}
 */
export async function createCheckoutSession({
  store,
  identity,
  plan,
  interval = 'monthly',
  fetcher,
  now = () => Date.now(),
  env = process.env,
}) {
  if (!identity?.uid) throw unauthorized('Sign in to start a checkout.');

  const priceId = resolvePriceId(plan, interval, env);

  const customerId = await ensureCustomer({
    store,
    uid: identity.uid,
    email: identity.email,
    now,
    fetcher,
    env,
  });

  const session = await stripeRequest(
    '/checkout/sessions',
    {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl(env)}/dashboard?checkout=success`,
      cancel_url: `${siteUrl(env)}/pricing?checkout=cancelled`,
      // Both set deliberately: the webhook prefers metadata.uid but falls back
      // to client_reference_id, so a missing one still resolves the account.
      client_reference_id: identity.uid,
      metadata: { uid: identity.uid, plan, interval },
      subscription_data: { metadata: { uid: identity.uid, tier: plan } },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    },
    { fetcher, env },
  );

  if (typeof session?.url !== 'string' || !session.url.startsWith('https://')) {
    throw new HubError(502, 'stripe_bad_response', 'Stripe did not return a checkout URL.');
  }

  await store.appendAudit({ action: 'billing.checkout_created', uid: identity.uid, plan, interval });

  return { url: session.url, sessionId: session.id };
}

/**
 * Create a Billing Portal session so users can update payment method or cancel.
 */
export async function createPortalSession({
  store,
  identity,
  fetcher,
  now = () => Date.now(),
  env = process.env,
}) {
  if (!identity?.uid) throw unauthorized('Sign in to manage billing.');

  const customerId = await ensureCustomer({
    store,
    uid: identity.uid,
    email: identity.email,
    now,
    fetcher,
    env,
  });

  const session = await stripeRequest(
    '/billing_portal/sessions',
    { customer: customerId, return_url: `${siteUrl(env)}/account` },
    { fetcher, env },
  );

  if (typeof session?.url !== 'string' || !session.url.startsWith('https://')) {
    throw new HubError(502, 'stripe_bad_response', 'Stripe did not return a portal URL.');
  }

  return { url: session.url };
}

export { PLAN_PRICE_ENV, encodeForm };