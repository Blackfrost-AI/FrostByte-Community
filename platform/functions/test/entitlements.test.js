import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveEntitlement,
  capabilitiesFor,
  allowsProvider,
  publicEntitlement,
  tierAtLeast,
  GRACE_MS,
} from '../src/entitlements.js';
import { subscriptionFixture, FIXED_NOW } from './harness.js';

test('no subscription resolves to free', () => {
  const result = resolveEntitlement(null, FIXED_NOW);
  assert.equal(result.tier, 'free');
  assert.equal(result.status, 'inactive');
  assert.equal(result.source, 'none');
});

test('active plus subscription grants plus', () => {
  const result = resolveEntitlement(subscriptionFixture('plus'), FIXED_NOW);
  assert.equal(result.tier, 'plus');
  assert.equal(result.source, 'subscription');
});

test('active pro subscription grants pro', () => {
  assert.equal(resolveEntitlement(subscriptionFixture('pro'), FIXED_NOW).tier, 'pro');
});

test('trialing grants the tier', () => {
  const sub = subscriptionFixture('plus', { status: 'trialing' });
  assert.equal(resolveEntitlement(sub, FIXED_NOW).tier, 'plus');
});

test('past_due still grants inside the period', () => {
  const sub = subscriptionFixture('pro', { status: 'past_due' });
  assert.equal(resolveEntitlement(sub, FIXED_NOW).tier, 'pro');
});

test('revoked status drops to free immediately', () => {
  const sub = subscriptionFixture('pro', { status: 'revoked' });
  const result = resolveEntitlement(sub, FIXED_NOW);
  assert.equal(result.tier, 'free');
});

test('unpaid status drops to free immediately', () => {
  const sub = subscriptionFixture('pro', { status: 'unpaid' });
  assert.equal(resolveEntitlement(sub, FIXED_NOW).tier, 'free');
});

test('canceled keeps the tier until the period ends', () => {
  const sub = subscriptionFixture('plus', { status: 'canceled' });
  assert.equal(resolveEntitlement(sub, FIXED_NOW).tier, 'plus');
});

test('canceled drops to free after period end plus grace', () => {
  const sub = subscriptionFixture('plus', { status: 'canceled' });
  const afterGrace = FIXED_NOW + 20 * 24 * 60 * 60 * 1000 + GRACE_MS + 1000;
  assert.equal(resolveEntitlement(sub, afterGrace).tier, 'free');
});

test('grace window reports source=grace', () => {
  const sub = subscriptionFixture('plus', { status: 'canceled' });
  const inGrace = FIXED_NOW + 20 * 24 * 60 * 60 * 1000 + 1000;
  const result = resolveEntitlement(sub, inGrace);
  assert.equal(result.tier, 'plus');
  assert.equal(result.source, 'grace');
});

test('unknown tier fails closed to free', () => {
  const sub = subscriptionFixture('platinum');
  assert.equal(resolveEntitlement(sub, FIXED_NOW).tier, 'free');
});

test('paid tier with no period end fails closed', () => {
  const sub = subscriptionFixture('pro', { currentPeriodEnd: null });
  assert.equal(resolveEntitlement(sub, FIXED_NOW).tier, 'free');
});

test('malformed subscription object fails closed', () => {
  assert.equal(resolveEntitlement('nonsense', FIXED_NOW).tier, 'free');
  assert.equal(resolveEntitlement(42, FIXED_NOW).tier, 'free');
  assert.equal(resolveEntitlement([], FIXED_NOW).tier, 'free');
});

test('Firestore Timestamp-shaped period end is accepted', () => {
  const sub = subscriptionFixture('plus', {
    currentPeriodEnd: { seconds: Math.floor((FIXED_NOW + 86_400_000) / 1000) },
  });
  assert.equal(resolveEntitlement(sub, FIXED_NOW).tier, 'plus');
});

test('free tier sees only huggingface', () => {
  const caps = capabilitiesFor('free');
  assert.deepEqual([...caps.discoveryProviders], ['huggingface']);
  assert.equal(allowsProvider('free', 'localmaxxing'), false);
  assert.equal(allowsProvider('free', 'pirateface'), false);
});

test('plus and pro see all three providers', () => {
  for (const tier of ['plus', 'pro']) {
    const caps = capabilitiesFor(tier);
    assert.deepEqual([...caps.discoveryProviders].sort(), ['huggingface', 'localmaxxing', 'pirateface']);
  }
});

test('page size ceilings widen with tier', () => {
  assert.ok(capabilitiesFor('free').maxResultsPerPage < capabilitiesFor('plus').maxResultsPerPage);
  assert.ok(capabilitiesFor('plus').maxResultsPerPage < capabilitiesFor('pro').maxResultsPerPage);
});

test('api key allowance is zero on free and positive on paid', () => {
  assert.equal(capabilitiesFor('free').apiKeys, 0);
  assert.ok(capabilitiesFor('plus').apiKeys > 0);
  assert.ok(capabilitiesFor('pro').apiKeys > capabilitiesFor('plus').apiKeys);
});

test('unknown tier falls back to free capabilities', () => {
  assert.deepEqual(capabilitiesFor('nonsense'), capabilitiesFor('free'));
});

test('tierAtLeast ranks correctly', () => {
  assert.equal(tierAtLeast('pro', 'plus'), true);
  assert.equal(tierAtLeast('plus', 'pro'), false);
  assert.equal(tierAtLeast('plus', 'plus'), true);
  assert.equal(tierAtLeast('free', 'plus'), false);
});

test('publicEntitlement leaks no billing identifiers', () => {
  const resolved = resolveEntitlement(subscriptionFixture('pro'), FIXED_NOW);
  const view = publicEntitlement(resolved);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('cus_test'), false);
  assert.equal(serialized.includes('sub_test'), false);
  assert.equal(view.tier, 'pro');
});