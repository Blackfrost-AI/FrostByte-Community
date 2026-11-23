/**
 * Admin console API + gate tests (spec §5.1–§5.3, Gate 1).
 *
 * Hermetic: memory store, fake tenant Auth directory, fixed clock.
 * Covers every gate layer, every mutation route, audit logging, and the
 * moderation/provider settings that feed Discovery.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { harness, FIXED_NOW, TEST_TENANT_ID } from './harness.js';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/store/memory.js';
import { requireAdmin, ADMIN_STEP_UP_MAX_AGE_MS } from '../src/admin-auth.js';

const ADMIN_UID = 'user_123'; // harness default uid doubles as the admin
const TARGET_UID = 'target_user_1';

/** Fake tenant-scoped Firebase Auth directory. */
function fakeDirectory() {
  const users = new Map();
  const calls = [];
  return {
    calls,
    seed(uid, record) {
      users.set(uid, { uid, email: '', emailVerified: true, disabled: false, customClaims: {}, metadata: {}, ...record });
    },
    async getUser(uid) {
      if (!users.has(uid)) {
        const error = new Error('not found');
        error.code = 'auth/user-not-found';
        throw error;
      }
      return users.get(uid);
    },
    async getUserByEmail(email) {
      const found = [...users.values()].find((user) => user.email === email);
      if (!found) throw new Error('not found');
      return found;
    },
    async listUsers(maxResults = 100) {
      calls.push({ method: 'listUsers', maxResults });
      return { users: [...users.values()].slice(0, maxResults) };
    },
    async createUser(properties) {
      calls.push({ method: 'createUser', properties: { ...properties, password: '[REDACTED]' } });
      if ([...users.values()].some((user) => user.email === properties.email)) {
        const error = new Error('EMAIL_EXISTS');
        error.code = 'auth/email-already-exists';
        throw error;
      }
      const uid = `created_${users.size + 1}`;
      const record = {
        uid,
        email: properties.email,
        displayName: properties.displayName || '',
        emailVerified: Boolean(properties.emailVerified),
        disabled: Boolean(properties.disabled),
        tenantId: TEST_TENANT_ID,
        customClaims: {},
        metadata: { creationTime: 'Sun, 15 Nov 2026 01:00:00 GMT' },
      };
      users.set(uid, record);
      return record;
    },
    async updateUser(uid, properties) {
      calls.push({ method: 'updateUser', uid, properties });
      const user = users.get(uid) || { uid };
      Object.assign(user, properties);
      users.set(uid, user);
      return user;
    },
    async setCustomUserClaims(uid, claims) {
      calls.push({ method: 'setCustomUserClaims', uid, claims });
      const user = users.get(uid) || { uid };
      user.customClaims = claims;
      users.set(uid, user);
    },
    async revokeRefreshTokens(uid) {
      calls.push({ method: 'revokeRefreshTokens', uid });
    },
    async generatePasswordResetLink(email) {
      calls.push({ method: 'generatePasswordResetLink', email });
      return `https://reset.invalid/?oobCode=SECRET-${email}`;
    },
    async sendPasswordResetEmail(email) {
      calls.push({ method: 'sendPasswordResetEmail', email });
    },
  };
}

async function adminHarness({ tier, role = 'owner', adminStatus = 'active', routes = {}, tenantId = '' } = {}) {
  const directory = fakeDirectory();
  const h = await harness({ tier, routes, tenantId, appOptions: { adminDirectory: directory } });
  await h.store.setAdmin(ADMIN_UID, { role, status: adminStatus, email: 'admin@example.com' });
  directory.seed(ADMIN_UID, {
    email: 'admin@example.com',
    customClaims: { frostbyteAdmin: true },
    ...(tenantId ? { tenantId } : {}),
  });
  directory.seed(TARGET_UID, {
    email: 'target@example.com',
    ...(tenantId ? { tenantId } : {}),
  });
  await h.store.setUser(TARGET_UID, {
    uid: TARGET_UID,
    email: 'target@example.com',
    emailLower: 'target@example.com',
    tier: 'free',
    disabled: false,
    ...(tenantId ? { tenantId } : {}),
    createdAt: new Date(FIXED_NOW).toISOString(),
  });
  const admin = (path, options = {}) =>
    h.request({ token: 'admin-token', ...options, url: path });
  return { ...h, directory, admin };
}

// ---- Gate layers -----------------------------------------------------------

test('admin gate: unauthenticated request is 401', async () => {
  const { admin } = await adminHarness();
  const res = await admin('/v1/admin/overview', { auth: false });
  assert.equal(res.statusCode, 401);
});

test('admin gate: bfk_ API key is refused even with the claim', async () => {
  const { store, request } = await adminHarness();
  const { plaintext, keyHash } = await import('../src/auth.js').then((m) => m.generateApiKey());
  await store.setApiKey(keyHash, { uid: ADMIN_UID, prefix: 'abcd1234', label: 'machine' });
  const res = await request({ url: '/v1/admin/overview', token: plaintext, headers: { authorization: `Bearer ${plaintext}` } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'admin_requires_interactive_session');
});

test('admin gate: unverified email is refused', async () => {
  const { admin } = await adminHarness();
  const res = await admin('/v1/admin/overview', { token: 'admin-token-unverified' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'admin_email_unverified');
});

test('admin gate: no frostbyteAdmin claim is refused', async () => {
  const { admin } = await adminHarness();
  const res = await admin('/v1/admin/overview', { token: 'valid-token' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'admin_forbidden');
});

test('admin gate: claim without active admins/{uid} record is refused', async () => {
  const { admin } = await adminHarness({ adminStatus: 'revoked' });
  const res = await admin('/v1/admin/overview');
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'admin_forbidden');
});

test('admin gate: stale auth_time blocks mutations but not reads', async () => {
  const { admin } = await adminHarness();
  const read = await admin('/v1/admin/overview', { token: 'admin-token-stale' });
  assert.equal(read.statusCode, 200);
  const write = await admin('/v1/admin/frostnet/moderation', {
    method: 'POST',
    token: 'admin-token-stale',
    body: { targetType: 'repo', targetValue: 'evil/model', reason: 'policy violation test' },
  });
  assert.equal(write.statusCode, 403);
  assert.equal(write.json().error.code, 'admin_reauth_required');
});

test('admin gate: requireAdmin unit checks — units, owner, missing record', async () => {
  const store = createMemoryStore({ now: () => FIXED_NOW });
  const now = () => FIXED_NOW;
  const base = { uid: 'a', authType: 'firebase', emailVerified: true, claims: { frostbyteAdmin: true } };

  // No record yet.
  await assert.rejects(() => requireAdmin(base, { store, now }), /Admin access denied/);

  await store.setAdmin('a', { role: 'admin', status: 'active' });
  const record = await requireAdmin(base, { store, now });
  assert.equal(record.role, 'admin');

  // Owner-only route refuses plain admins.
  await assert.rejects(() => requireAdmin(base, { store, now, requireOwner: true }), /Owner clearance/);

  // auth_time in SECONDS: exactly at the boundary passes, one second older fails.
  const freshSec = Math.floor((FIXED_NOW - ADMIN_STEP_UP_MAX_AGE_MS) / 1000) + 1;
  await requireAdmin({ ...base, authTimeSec: freshSec }, { store, now, requireFreshAuth: true });
  await assert.rejects(
    () => requireAdmin({ ...base, authTimeSec: freshSec - 2 }, { store, now, requireFreshAuth: true }),
    /re-enter your password/,
  );
  // Milliseconds accidentally passed as auth_time land far in the future and
  // read as fresh (the real verifier only ever issues seconds). Missing
  // auth_time fails closed.
  await requireAdmin({ ...base, authTimeSec: FIXED_NOW }, { store, now, requireFreshAuth: true });
  await assert.rejects(
    () => requireAdmin({ ...base, authTimeSec: 0 }, { store, now, requireFreshAuth: true }),
    /re-enter your password/,
  );
});

// ---- Session / overview ------------------------------------------------------

test('admin session reports role and step-up window', async () => {
  const { admin } = await adminHarness();
  const res = await admin('/v1/admin/session');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().admin.role, 'owner');
  assert.equal(res.json().admin.stepUpFresh, true);
  assert.ok(res.json().admin.stepUpValidUntil);
});

test('admin overview returns metrics, provider settings, and recent ledgers', async () => {
  const { admin, store } = await adminHarness();
  await store.setSubscription(TARGET_UID, {
    tier: 'pro', status: 'active', planKey: 'pro_monthly', stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1', currentPeriodEnd: FIXED_NOW + 86_400_000, cancelAtPeriodEnd: false,
    updatedAt: new Date(FIXED_NOW).toISOString(), lastEventId: 'evt_x', lastEventAt: FIXED_NOW,
  });
  const res = await admin('/v1/admin/overview');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().metrics.totalUsers, 2);
  assert.equal(res.json().metrics.activePaidSubscriptions, 1);
  assert.deepEqual(res.json().providerSettings.enabledProviders, ['huggingface', 'localmaxxing', 'pirateface']);
  assert.ok(Array.isArray(res.json().recentWebhookEvents));
  assert.ok(Array.isArray(res.json().recentAuditEntries));
});

// ---- Users -------------------------------------------------------------------

test('admin users list searches by email and paginates', async () => {
  const { admin } = await adminHarness();
  const all = await admin('/v1/admin/users');
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().items.length, 2);
  const searched = await admin('/v1/admin/users?q=target@example.com');
  assert.equal(searched.json().items.length, 1);
  assert.equal(searched.json().items[0].uid, TARGET_UID);
  assert.equal(searched.json().items[0].entitlement.tier, 'free');
});

test('admin user detail never leaks key hashes', async () => {
  const { admin, store } = await adminHarness();
  await store.setApiKey('hash_secret_value', {
    uid: TARGET_UID, prefix: 'abcd1234', label: 'laptop', createdAt: new Date(FIXED_NOW).toISOString(),
  });
  const res = await admin(`/v1/admin/users/${TARGET_UID}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().profile.uid, TARGET_UID);
  assert.equal(res.json().apiKeys.length, 1);
  assert.equal(res.json().apiKeys[0].prefix, 'abcd1234');
  assert.ok(!JSON.stringify(res.json()).includes('hash_secret_value'));
});

test('admin user detail: unknown uid is 404', async () => {
  const { admin } = await adminHarness();
  const res = await admin('/v1/admin/users/nobody');
  assert.equal(res.statusCode, 404);
});

// ---- Entitlement overrides -----------------------------------------------------

test('entitlement override grants pro, then revokes', async () => {
  const { admin, store, request } = await adminHarness();
  const grant = await admin(`/v1/admin/users/${TARGET_UID}/entitlement-override`, {
    method: 'POST',
    body: { tier: 'pro', reason: 'comped for conference demo', expiresAt: null },
  });
  assert.equal(grant.statusCode, 200);
  assert.equal(grant.json().override.tier, 'pro');

  // The target's own /v1/me now resolves pro.
  await store.setAdmin(TARGET_UID, { role: 'admin', status: 'active' }); // not needed for me, but harmless
  const me = await request({ url: '/v1/me', token: 'valid-token' });
  assert.equal(me.statusCode, 200); // harness uid is ADMIN_UID; verify override via store instead
  const override = await store.getEntitlementOverride(TARGET_UID);
  assert.equal(override.tier, 'pro');

  const revoke = await admin(`/v1/admin/users/${TARGET_UID}/entitlement-override`, {
    method: 'POST',
    body: { tier: 'none', reason: 'demo concluded, restoring free' },
  });
  assert.equal(revoke.statusCode, 200);
  const after = await store.getEntitlementOverride(TARGET_UID);
  assert.ok(!after || after.status === 'revoked');
});

test('entitlement override rejects bad tier and past expiry', async () => {
  const { admin } = await adminHarness();
  const bad = await admin(`/v1/admin/users/${TARGET_UID}/entitlement-override`, {
    method: 'POST', body: { tier: 'enterprise', reason: 'testing validation path' },
  });
  assert.equal(bad.statusCode, 400);
  const past = await admin(`/v1/admin/users/${TARGET_UID}/entitlement-override`, {
    method: 'POST', body: { tier: 'pro', reason: 'testing validation path', expiresAt: '2020-01-01T00:00:00Z' },
  });
  assert.equal(past.statusCode, 400);
});

test('entitlement override requires an audit reason', async () => {
  const { admin } = await adminHarness();
  const res = await admin(`/v1/admin/users/${TARGET_UID}/entitlement-override`, {
    method: 'POST', body: { tier: 'pro' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'audit_reason_required');
});

// ---- Account status ------------------------------------------------------------

test('status change disables the auth user, revokes tokens and keys, audits', async () => {
  const { admin, store, directory } = await adminHarness();
  await store.setApiKey('hash_target_key', { uid: TARGET_UID, prefix: 'zzzz9999', label: 'old' });
  const res = await admin(`/v1/admin/users/${TARGET_UID}/status`, {
    method: 'POST',
    body: { disabled: true, revokeApiKeys: true, reason: 'abusive scraping behavior' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().revokedApiKeys, 1);
  assert.equal((await store.getUser(TARGET_UID)).disabled, true);
  assert.ok(directory.calls.some((call) => call.method === 'updateUser' && call.properties.disabled === true));
  assert.ok(directory.calls.some((call) => call.method === 'revokeRefreshTokens' && call.uid === TARGET_UID));
  const audit = await store.listAuditLog({ limit: 50 });
  assert.ok(audit.items.some((entry) => entry.action === 'user.status_change' && entry.targetId === TARGET_UID));
});

test('admin cannot disable themselves', async () => {
  const { admin } = await adminHarness();
  const res = await admin(`/v1/admin/users/${ADMIN_UID}/status`, {
    method: 'POST', body: { disabled: true, reason: 'self disable attempt' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'cannot_disable_self');
});

// ---- Password reset --------------------------------------------------------------

test('password reset dispatches via directory and never leaks the link', async () => {
  const { admin, directory } = await adminHarness();
  const res = await admin(`/v1/admin/users/${TARGET_UID}/reset-password`, {
    method: 'POST', body: { reason: 'user locked out, verified identity' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().sentTo, 'target@example.com');
  assert.ok(directory.calls.some((call) => call.method === 'sendPasswordResetEmail' && call.email === 'target@example.com'));
  assert.ok(!JSON.stringify(res.json()).includes('SECRET'));
});

test('password reset fails honestly when no email sender is configured', async () => {
  const directory = fakeDirectory();
  delete directory.sendPasswordResetEmail; // link-only directory: must NOT report "sent"
  const h = await harness({ routes: {}, appOptions: { adminDirectory: directory } });
  await h.store.setAdmin(ADMIN_UID, { role: 'owner', status: 'active', email: 'admin@example.com' });
  directory.seed(ADMIN_UID, { email: 'admin@example.com' });
  directory.seed(TARGET_UID, { email: 'target@example.com' });
  await h.store.setUser(TARGET_UID, { uid: TARGET_UID, email: 'target@example.com', tier: 'free' });
  const res = await h.request({
    token: 'admin-token',
    url: `/v1/admin/users/${TARGET_UID}/reset-password`,
    method: 'POST',
    body: { reason: 'user locked out, verified identity' },
  });
  assert.equal(res.statusCode, 409);
  assert.ok(!directory.calls.some((call) => call.method === 'generatePasswordResetLink'), 'no discarded link generated');
});

// ---- API key revocation ------------------------------------------------------------

test('admin revokes a user API key by prefix', async () => {
  const { admin, store } = await adminHarness();
  await store.setApiKey('hash_target_key', { uid: TARGET_UID, prefix: 'zzzz9999', label: 'old' });
  const res = await admin(`/v1/admin/users/${TARGET_UID}/api-keys/zzzz9999`, {
    method: 'DELETE', body: { reason: 'key reported leaked in public repo' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(await store.getApiKey('hash_target_key'), null);
});

// ---- Admin roles ---------------------------------------------------------------------

test('owner grants admin role: claim + record + revocation + audit', async () => {
  const { admin, store, directory } = await adminHarness();
  const res = await admin(`/v1/admin/users/${TARGET_UID}/admin-role`, {
    method: 'POST', body: { role: 'admin', reason: 'onboarding new support operator' },
  });
  assert.equal(res.statusCode, 200);
  const record = await store.getAdmin(TARGET_UID);
  assert.equal(record.role, 'admin');
  assert.equal(record.status, 'active');
  const claimsCall = directory.calls.find((call) => call.method === 'setCustomUserClaims' && call.uid === TARGET_UID);
  assert.equal(claimsCall.claims.frostbyteAdmin, true);
  assert.ok(directory.calls.some((call) => call.method === 'revokeRefreshTokens' && call.uid === TARGET_UID));
});

test('plain admin cannot grant roles (owner-only)', async () => {
  const { admin } = await adminHarness({ role: 'admin' });
  const res = await admin(`/v1/admin/users/${TARGET_UID}/admin-role`, {
    method: 'POST', body: { role: 'admin', reason: 'attempted privilege escalation' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'admin_owner_required');
});

test('owner cannot demote themselves', async () => {
  const { admin } = await adminHarness();
  const res = await admin(`/v1/admin/users/${ADMIN_UID}/admin-role`, {
    method: 'POST', body: { role: 'none', reason: 'self demotion attempt' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'cannot_demote_self');
});

// ---- FrostNet moderation ---------------------------------------------------------------

test('moderation block + remove round-trip with audit entries', async () => {
  const { admin, store } = await adminHarness();
  const add = await admin('/v1/admin/frostnet/moderation', {
    method: 'POST',
    body: { targetType: 'repo', targetValue: 'Evil/Model', reason: 'malware distribution confirmed' },
  });
  assert.equal(add.statusCode, 201);
  assert.equal(add.json().rule.targetValue, 'evil/model');

  const list = await admin('/v1/admin/frostnet/moderation');
  assert.equal(list.json().blocked.length, 1);

  const remove = await admin(`/v1/admin/frostnet/moderation/${add.json().rule.id}`, {
    method: 'DELETE', body: { reason: 'false positive, repo restored' },
  });
  assert.equal(remove.statusCode, 200);
  assert.equal((await store.listModerationRules()).length, 0);

  const audit = await store.listAuditLog({ limit: 50 });
  assert.ok(audit.items.some((entry) => entry.action === 'frostnet.block_add'));
  assert.ok(audit.items.some((entry) => entry.action === 'frostnet.block_remove'));
});

test('moderation validates repo and infohash targets', async () => {
  const { admin } = await adminHarness();
  const badRepo = await admin('/v1/admin/frostnet/moderation', {
    method: 'POST', body: { targetType: 'repo', targetValue: 'not a repo!!', reason: 'validation test case' },
  });
  assert.equal(badRepo.statusCode, 400);
  const badHash = await admin('/v1/admin/frostnet/moderation', {
    method: 'POST', body: { targetType: 'infohash', targetValue: 'xyz', reason: 'validation test case' },
  });
  assert.equal(badHash.statusCode, 400);
  const goodHash = await admin('/v1/admin/frostnet/moderation', {
    method: 'POST',
    body: { targetType: 'infohash', targetValue: 'A'.repeat(40), reason: 'confirmed malicious torrent' },
  });
  assert.equal(goodHash.statusCode, 201);
  assert.equal(goodHash.json().rule.targetValue, 'a'.repeat(40));
});

test('featured pin upsert + delete', async () => {
  const { admin, store } = await adminHarness();
  const add = await admin('/v1/admin/frostnet/featured', {
    method: 'POST',
    body: { provider: 'huggingface', providerId: 'Qwen/Qwen3-0.6B', badge: 'Staff pick', rank: 1, reason: 'editorial feature for launch' },
  });
  assert.equal(add.statusCode, 201);
  assert.equal(add.json().featured.badge, 'Staff pick');
  const remove = await admin(`/v1/admin/frostnet/featured/${add.json().featured.id}`, {
    method: 'DELETE', body: { reason: 'feature window ended' },
  });
  assert.equal(remove.statusCode, 200);
  assert.equal((await store.listFeaturedModels()).length, 0);
});

test('provider settings update rejects unknown providers and flushes cache', async () => {
  const { admin, store } = await adminHarness();
  await store.setCache('probe', { items: [] }, 60_000);
  const bad = await admin('/v1/admin/frostnet/providers', {
    method: 'POST', body: { enabledProviders: ['huggingface', 'napster'], reason: 'validation test case' },
  });
  assert.equal(bad.statusCode, 400);
  const good = await admin('/v1/admin/frostnet/providers', {
    method: 'POST',
    body: { enabledProviders: ['huggingface'], flushCache: true, reason: 'pirateface upstream outage' },
  });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json().providerConfig.enabledProviders, ['huggingface']);
  assert.equal(good.json().cacheFlushed, 1);
});

// ---- Ledgers ---------------------------------------------------------------------------

test('billing events and audit log endpoints paginate', async () => {
  const { admin, store } = await adminHarness();
  await store.recordStripeEvent({ eventId: 'evt_1', type: 'customer.subscription.created', uid: TARGET_UID, processedAt: new Date(FIXED_NOW).toISOString(), tier: 'pro', status: 'active' });
  const events = await admin('/v1/admin/billing/events');
  assert.equal(events.statusCode, 200);
  assert.equal(events.json().items.length, 1);
  const audit = await admin('/v1/admin/audit-log');
  assert.equal(audit.statusCode, 200);
  assert.ok(Array.isArray(audit.json().items));
});

// ---- Admin rate limit ---------------------------------------------------------------------

// ---- Operator Pro entitlement + customer directory & provisioning -----------------------

test('active admin resolves to pro entitlement (source=admin) with finite lease on /v1/me and API keys', async () => {
  const { admin, request } = await adminHarness();
  const meRes = await admin('/v1/me');
  assert.equal(meRes.statusCode, 200);
  const me = meRes.json();
  assert.equal(me.isAdmin, true);
  assert.equal(me.entitlement.tier, 'pro');
  assert.equal(me.entitlement.source, 'admin');
  assert.ok(Date.parse(me.entitlement.currentPeriodEnd) > FIXED_NOW);
  assert.equal(me.entitlement.capabilities.apiKeys, 20);

  // Admin can mint a bfk_ API key and use Pro capability, while bfk_ key still cannot hit /v1/admin/*
  const keyRes = await admin('/v1/api-keys', { method: 'POST', body: { label: 'operator-cli' } });
  assert.equal(keyRes.statusCode, 200);
  const rawKey = keyRes.json().key;
  const keyEnt = await request({ token: rawKey, url: '/v1/me/entitlement' });
  assert.equal(keyEnt.statusCode, 200);
  assert.equal(keyEnt.json().tier, 'pro');
  const blockedAdmin = await request({ token: rawKey, url: '/v1/admin/session' });
  assert.equal(blockedAdmin.statusCode, 403);
});

test('demoting an admin without paid plan revokes active API keys', async () => {
  const { admin, store } = await adminHarness();
  await admin(`/v1/admin/users/${TARGET_UID}/admin-role`, {
    method: 'POST',
    body: { role: 'admin', reason: 'grant temporary operator access' },
  });
  await store.setApiKey('hash_admin_only_key', { uid: TARGET_UID, prefix: 'abcd1234', label: 'ops' });

  const demote = await admin(`/v1/admin/users/${TARGET_UID}/admin-role`, {
    method: 'POST',
    body: { role: 'none', reason: 'temporary rotation ended' },
  });
  assert.equal(demote.statusCode, 200);
  assert.equal(demote.json().revokedApiKeys, 1);
  const keyAfter = await store.getApiKey('hash_admin_only_key');
  assert.ok(keyAfter.revokedAt, 'API key is soft-revoked with revokedAt timestamp');
});

test('Auth-only tenant customer is materialized with ISO createdAt and tenantId in admin users & overview', async () => {
  const { admin, store, directory } = await adminHarness({ tenantId: TEST_TENANT_ID });
  directory.seed('auth_only_customer', {
    email: 'newcustomer@example.com',
    displayName: 'New Customer',
    tenantId: TEST_TENANT_ID,
    metadata: { creationTime: 'Sun, 15 Nov 2026 02:30:00 GMT' },
  });

  const listRes = await admin('/v1/admin/users');
  assert.equal(listRes.statusCode, 200);
  const items = listRes.json().items;
  const synced = items.find((item) => item.uid === 'auth_only_customer');
  assert.ok(synced, 'Auth-only customer appears in /v1/admin/users');
  assert.equal(synced.email, 'newcustomer@example.com');
  assert.equal(synced.createdAt, '2026-11-15T02:30:00.000Z');
  assert.equal(synced.tenantId, TEST_TENANT_ID);

  const stored = await store.getUser('auth_only_customer');
  assert.equal(stored.createdAt, '2026-11-15T02:30:00.000Z');
  assert.equal(stored.tenantId, TEST_TENANT_ID);
});

test('POST /v1/admin/users provisions a customer, applies optional tier override, sends setup email, and audits', async () => {
  const { admin, store, directory } = await adminHarness({ tenantId: TEST_TENANT_ID });
  const createRes = await admin('/v1/admin/users', {
    method: 'POST',
    body: {
      email: 'VIP.Customer@Example.com',
      displayName: 'VIP Customer',
      tier: 'pro',
      sendSetupEmail: true,
      reason: 'Provisioned enterprise evaluation customer',
    },
  });
  assert.equal(createRes.statusCode, 201);
  const body = createRes.json();
  assert.equal(body.email, 'vip.customer@example.com');
  assert.equal(body.tier, 'pro');
  assert.equal(body.setupEmailSent, true);
  assert.equal('password' in body, false);

  const user = await store.getUser(body.uid);
  assert.equal(user.email, 'vip.customer@example.com');
  assert.equal(user.tenantId, TEST_TENANT_ID);
  assert.ok(user.createdAt.endsWith('Z'));

  const detail = await admin(`/v1/admin/users/${body.uid}`);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().entitlement.tier, 'pro');
  assert.equal(detail.json().entitlement.source, 'admin_override');

  assert.ok(directory.calls.some((call) => call.method === 'sendPasswordResetEmail' && call.email === 'vip.customer@example.com'));
  const audit = await store.listAuditLog({ limit: 10 });
  assert.ok(audit.items.some((entry) => entry.action === 'user.provisioned' && entry.targetId === body.uid));

  // Duplicate email returns 409 without clobbering existing user
  const dup = await admin('/v1/admin/users', {
    method: 'POST',
    body: {
      email: 'vip.customer@example.com',
      tier: 'free',
      reason: 'accidental duplicate click',
    },
  });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error.code, 'user_already_exists');
});

test('pre-tenant root-pool profiles missing tenantId are excluded from admin list/count and cannot be un-quarantined on GET', async () => {
  const { admin, store } = await adminHarness({ tenantId: TEST_TENANT_ID });
  // Seed a legacy root-pool profile missing tenantId (not in tenantAuth directory)
  await store.setUser('legacy_root_uid', {
    uid: 'legacy_root_uid',
    email: 'legacy@blackfrostai.com',
    emailLower: 'legacy@blackfrostai.com',
    disabled: true,
    createdAt: new Date(FIXED_NOW).toISOString(),
  });

  const list = await admin('/v1/admin/users');
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.some((u) => u.uid === 'legacy_root_uid'), false);

  const detail = await admin('/v1/admin/users/legacy_root_uid');
  assert.equal(detail.statusCode, 404);
  const untouched = await store.getUser('legacy_root_uid');
  assert.equal(untouched.tenantId, undefined);
});

test('admin bucket rate-limits after 60 requests per minute', async () => {
  const { admin } = await adminHarness();
  let last;
  for (let i = 0; i < 61; i += 1) {
    last = await admin('/v1/admin/session');
  }
  assert.equal(last.statusCode, 429);
  assert.equal(last.json().error.code, 'rate_limited');
});

// ---- ADR 003: operator handle moderation ------------------------------------

test('admin force-releases an abusive handle into the grace window', async () => {
  const { admin, store } = await adminHarness();
  await store.setHandle(TARGET_UID, 'abusive_squatter', { nowMs: FIXED_NOW });

  const res = await admin(`/v1/admin/users/${TARGET_UID}/handle/release`, {
    method: 'POST',
    body: { reason: 'impersonation of official staff account' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().released, 'abusive_squatter');

  const user = await store.getUser(TARGET_UID);
  assert.ok(!user.handle);
  assert.equal(await store.getHandle('abusive_squatter'), null);
  const grace = await store.getHandleHistory('abusive_squatter');
  assert.ok(grace && Date.parse(grace.releasedUntil) > FIXED_NOW);

  const audit = await store.listAuditLog({ limit: 10 });
  const entry = audit.items.find((e) => e.action === 'user.handle_force_release' && e.targetId === TARGET_UID);
  assert.ok(entry);
  assert.equal(entry.before.handle, 'abusive_squatter');
});

test('admin handle release requires a reason and an existing handle', async () => {
  const { admin, store } = await adminHarness();
  const noReason = await admin(`/v1/admin/users/${TARGET_UID}/handle/release`, {
    method: 'POST', body: {},
  });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.json().error.code, 'audit_reason_required');

  const noHandle = await admin(`/v1/admin/users/${TARGET_UID}/handle/release`, {
    method: 'POST', body: { reason: 'moderation review cleanup' },
  });
  assert.equal(noHandle.statusCode, 404);
  assert.equal(noHandle.json().error.code, 'no_handle');
});
