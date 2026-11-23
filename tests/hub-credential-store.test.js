// Integration test for the FrostNet browser-session / Firebase → Store credential wiring.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hub-cred-')));
process.env.FROSTBYTE_HOME = path.join(root, 'config');
const { Store } = await import('../src/main/store.js');
const {
  applyHubConfig, applyHubAccount, clearHubAccount,
  getHubConfig, getHubAccount, getHubEntitlement,
  shouldEvictStaleTenantSession,
} = await import('../src/main/hub-store.js');
const { describeHubToken, normalizeSessionExpiry, HUB_API_BASE } = await import('../src/main/hub-security.js');

after(() => fs.rmSync(root, { recursive: true, force: true }));

const ORIGIN = HUB_API_BASE;
const LEGACY_HTTPS = 'https://hub.frostbyte.example';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function persistSession(store, { token, refreshToken, expiresAt }, origin) {
  const described = describeHubToken(token);
  store.setHubCredential({
    hubTokenEnc: b64(token),
    hubTokenOrigin: origin,
    hubTokenFingerprint: described.fingerprint,
  });
  store.setHubRefreshCredential({ hubRefreshEnc: b64(refreshToken), hubRefreshOrigin: origin });
  store.setHubTokenExpiry({
    hubTokenExpiresAt: Number.isSafeInteger(expiresAt) ? expiresAt : 0,
    hubTokenExpiryOrigin: origin,
  });
  return described;
}

test('setHubCredential exists and persists the full Firebase session contract against HUB_API_BASE', () => {
  const store = new Store();
  applyHubConfig(store, { hubUrl: ORIGIN });
  const session = { token: 'id-token-abc', refreshToken: 'refresh-token-xyz', expiresAt: Date.now() + 3_600_000 };

  assert.equal(typeof store.setHubCredential, 'function');
  const described = persistSession(store, session, ORIGIN);

  assert.match(described.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(store.state.hubTokenEnc, b64(session.token));
  assert.equal(store.state.hubTokenOrigin, ORIGIN);
  assert.equal(store.state.hubTokenFingerprint, described.fingerprint);
  assert.equal(store.getHubRefreshCredential().present, true);
  assert.equal(store.getHubRefreshCredential().enc, b64(session.refreshToken));
  assert.equal(store.getHubTokenExpiry().expiresAt, session.expiresAt);
  assert.equal(store.getHubTokenExpiry().origin, ORIGIN);
  assert.equal(getHubConfig(store).hasToken, true);
});

test('the persisted session + desktopSessionId survive a Store reload (including on fresh install before setHubConfig)', () => {
  const store = new Store();
  const session = { token: 'reload-id-token', refreshToken: 'reload-refresh', expiresAt: Date.now() + 3_600_000 };
  const described = persistSession(store, session, ORIGIN);
  applyHubAccount(store, {
    signedIn: true,
    uid: 'usr_1',
    email: 'a@b.co',
    displayName: 'A',
    origin: ORIGIN,
    verifiedAt: Date.now(),
    desktopSessionId: 'dsess_reload_123',
  }, ORIGIN);

  const reloaded = new Store();
  assert.equal(reloaded.state.hubTokenEnc, b64(session.token));
  assert.equal(reloaded.state.hubTokenOrigin, ORIGIN);
  assert.equal(reloaded.state.hubTokenFingerprint, described.fingerprint);
  assert.equal(reloaded.getHubRefreshCredential().present, true);
  assert.equal(reloaded.getHubRefreshCredential().enc, b64(session.refreshToken));
  assert.equal(reloaded.getHubTokenExpiry().expiresAt, session.expiresAt);
  assert.equal(getHubConfig(reloaded).hasToken, true);
  assert.equal(getHubAccount(reloaded).signedIn, true);
  assert.equal(getHubAccount(reloaded).desktopSessionId, 'dsess_reload_123');
});

test('setHubCredential rejects malformed ciphertext, fingerprint, trailing slash, and plain/loopback HTTP', () => {
  const store = new Store();
  const fp = crypto.createHash('sha256').update('t').digest('hex');
  const good = { hubTokenEnc: b64('token'), hubTokenOrigin: ORIGIN, hubTokenFingerprint: fp };

  assert.throws(() => store.setHubCredential({ ...good, hubTokenEnc: 'not*base64!' }), /invalid/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenEnc: 'abcde' }), /invalid/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenEnc: 'A'.repeat(65_540) }), /invalid/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenFingerprint: 'xyz' }), /fingerprint/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenOrigin: 'http://evil.example.com' }), /HTTPS|origin/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenOrigin: 'http://localhost:8787' }), /HTTPS|origin/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenOrigin: 'http://127.0.0.1:8787' }), /HTTPS|origin/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenOrigin: `${ORIGIN}/` }), /HTTPS|origin/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenOrigin: '' }), /origin/i);
  assert.throws(() => store.setHubCredential({ ...good, hubTokenEnc: '' }), /credential/i);
});

test('refresh + expiry + hubConfig setters reject loopback HTTP and enforce pair invariants', () => {
  const store = new Store();
  assert.throws(() => store.setHubRefreshCredential({ hubRefreshEnc: b64('r'), hubRefreshOrigin: 'http://evil.example.com' }), /HTTPS|origin/i);
  assert.throws(() => store.setHubRefreshCredential({ hubRefreshEnc: b64('r'), hubRefreshOrigin: 'http://localhost:8787' }), /HTTPS|origin/i);
  assert.throws(() => store.setHubRefreshCredential({ hubRefreshEnc: b64('r'), hubRefreshOrigin: '' }), /origin/i);
  assert.throws(() => store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: ORIGIN }), /origin/i);
  assert.throws(() => store.setHubTokenExpiry({ hubTokenExpiresAt: Date.now() + 1000, hubTokenExpiryOrigin: 'http://evil.example.com' }), /HTTPS|origin/i);
  assert.throws(() => store.setHubTokenExpiry({ hubTokenExpiresAt: Date.now() + 1000, hubTokenExpiryOrigin: 'http://localhost:8787' }), /HTTPS|origin/i);
  assert.throws(() => store.setHubTokenExpiry({ hubTokenExpiresAt: -5, hubTokenExpiryOrigin: ORIGIN }), /expiry/i);
  assert.throws(() => store.setHubConfig({ hubUrl: 'http://localhost:8787' }), /HTTPS/i);
  assert.doesNotThrow(() => store.setHubConfig({ hubUrl: ORIGIN }));
  assert.equal(store.getHubConfig().hubUrl, ORIGIN);
});

test('applyHubConfig evicts legacy credentials from non-pinned origins while preserving HUB_API_BASE credentials', () => {
  const store = new Store();
  const fp = describeHubToken('legacy-tok').fingerprint;
  store.setHubCredential({ hubTokenEnc: b64('legacy-tok'), hubTokenOrigin: LEGACY_HTTPS, hubTokenFingerprint: fp });
  store.setHubRefreshCredential({ hubRefreshEnc: b64('legacy-ref'), hubRefreshOrigin: LEGACY_HTTPS });
  store.setHubTokenExpiry({ hubTokenExpiresAt: Date.now() + 3_600_000, hubTokenExpiryOrigin: LEGACY_HTTPS });
  store._commitStateFields({ hubAccount: { signedIn: true, uid: 'u', email: 'a@b.co', origin: LEGACY_HTTPS, verifiedAt: Date.now() } });
  assert.equal(getHubAccount(store).signedIn, false, 'mismatched credential origin is never treated as signed in');

  applyHubConfig(store, { hubUrl: ORIGIN });
  assert.equal(getHubConfig(store).hasToken, false);
  assert.equal(store.getHubRefreshCredential().present, false);
  assert.equal(store.getHubTokenExpiry().expiresAt, 0);
  assert.equal(getHubAccount(store).signedIn, false);
  assert.equal(getHubEntitlement(store).tier, 'free');
});

test('clearHubAccount wipes all seven credential/account fields', () => {
  const store = new Store();
  applyHubConfig(store, { hubUrl: ORIGIN });
  persistSession(store, { token: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }, ORIGIN);
  applyHubAccount(store, { signedIn: true, uid: 'u', email: 'a@b.co', origin: ORIGIN, verifiedAt: Date.now(), desktopSessionId: 'ds_1' }, ORIGIN);

  clearHubAccount(store);
  assert.equal(store.state.hubTokenEnc, undefined);
  assert.equal(store.state.hubTokenOrigin, undefined);
  assert.equal(store.state.hubTokenFingerprint, undefined);
  assert.equal(store.getHubRefreshCredential().present, false);
  assert.equal(store.getHubTokenExpiry().expiresAt, 0);
  assert.equal(getHubAccount(store).signedIn, false);
  assert.equal(getHubAccount(store).desktopSessionId, '');
  assert.equal(getHubEntitlement(store).tier, 'free');
  assert.equal(getHubConfig(store).hasToken, false);
});

test('a manual token commit clears refresh + expiry without resurrection (M3)', () => {
  const store = new Store();
  applyHubConfig(store, { hubUrl: ORIGIN });
  persistSession(store, { token: 'firebase-id', refreshToken: 'firebase-refresh', expiresAt: Date.now() + 3_600_000 }, ORIGIN);

  const manual = describeHubToken('manual-opaque-token');
  store.setHubCredential({
    hubTokenEnc: b64('manual-opaque-token'),
    hubTokenOrigin: ORIGIN,
    hubTokenFingerprint: manual.fingerprint,
  });
  store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });
  store.setHubTokenExpiry({ hubTokenExpiresAt: 0, hubTokenExpiryOrigin: '' });

  assert.equal(store.state.hubTokenEnc, b64('manual-opaque-token'));
  assert.equal(store.getHubRefreshCredential().present, false);
  assert.equal(store.getHubTokenExpiry().expiresAt, 0);
  assert.equal(getHubConfig(store).hasToken, true);
});

test('ISO expiry and unknown expiry normalize safely on HUB_API_BASE without partial state', () => {
  const store = new Store();
  applyHubConfig(store, { hubUrl: ORIGIN });

  const token = 'session-jwt';
  const described = describeHubToken(token);
  store.setHubCredential({ hubTokenEnc: b64(token), hubTokenOrigin: ORIGIN, hubTokenFingerprint: described.fingerprint });
  store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });

  const isoExpiresAt = normalizeSessionExpiry(new Date(Date.now() + 3_600_000).toISOString());
  assert.ok(isoExpiresAt > 0);
  assert.doesNotThrow(() => store.setHubTokenExpiry({ hubTokenExpiresAt: isoExpiresAt, hubTokenExpiryOrigin: ORIGIN }));

  const unknownExpiresAt = normalizeSessionExpiry('not-a-date');
  assert.equal(unknownExpiresAt, 0);
  assert.doesNotThrow(() => store.setHubTokenExpiry({
    hubTokenExpiresAt: unknownExpiresAt,
    hubTokenExpiryOrigin: unknownExpiresAt ? ORIGIN : '',
  }));
  assert.throws(() => store.setHubTokenExpiry({ hubTokenExpiresAt: 0, hubTokenExpiryOrigin: ORIGIN }), /expiry origin requires an expiry/);

  applyHubAccount(store, {
    uid: 'usr_founder', email: 'alex@example.com', displayName: 'Alex',
    emailVerified: true, createdAt: 0, verifiedAt: Date.now(),
  }, ORIGIN);
  assert.equal(getHubConfig(store).hasToken, true);
  assert.equal(getHubAccount(store).signedIn, true);
  assert.equal(store.getHubTokenExpiry().expiresAt, 0);
});

const TENANT = 'frostbyte-abc123';

test('tenant: stamped account + credentials survive a genuine Store reload', () => {
  const store = new Store();
  applyHubConfig(store, { hubUrl: ORIGIN });
  persistSession(store, { token: 'tenant-id-token', refreshToken: 'tenant-refresh', expiresAt: Date.now() + 3_600_000 }, ORIGIN);
  applyHubAccount(store, {
    uid: 'usr_tenant', email: 'user@example.com', displayName: 'Tenant User',
    emailVerified: true, createdAt: 0, verifiedAt: Date.now(),
    tenantId: TENANT, isAdmin: false, desktopSessionId: 'dsess_tenant_1',
  }, ORIGIN);

  const reloaded = new Store();
  const acct = getHubAccount(reloaded);
  assert.equal(acct.signedIn, true);
  assert.equal(acct.tenantId, TENANT);
  assert.equal(acct.desktopSessionId, 'dsess_tenant_1');
  assert.equal(reloaded.getHubRefreshCredential().present, true);
  assert.equal(reloaded.getHubTokenExpiry().origin, ORIGIN);
  assert.equal(shouldEvictStaleTenantSession({
    tenantId: TENANT, origin: ORIGIN, isLoopback: false, account: acct, hasRefreshToken: true,
  }), false);
});

test('tenant: eviction clears credentials + account and the cleared state survives reload', () => {
  const store = new Store();
  applyHubConfig(store, { hubUrl: ORIGIN });
  persistSession(store, { token: 'stale-root-token', refreshToken: 'stale-root-refresh', expiresAt: Date.now() + 3_600_000 }, ORIGIN);
  applyHubAccount(store, {
    uid: 'usr_root', email: 'root@example.com', displayName: 'Root User',
    emailVerified: true, createdAt: 0, verifiedAt: Date.now(),
    tenantId: '', isAdmin: false,
  }, ORIGIN);

  const acct = getHubAccount(store);
  assert.equal(shouldEvictStaleTenantSession({
    tenantId: TENANT, origin: ORIGIN, isLoopback: false, account: acct, hasRefreshToken: true,
  }), true);

  clearHubAccount(store);
  store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });

  assert.equal(getHubAccount(store).signedIn, false);
  assert.equal(getHubConfig(store).hasToken, false);
  assert.equal(store.getHubRefreshCredential().present, false);

  const reloaded = new Store();
  assert.equal(getHubAccount(reloaded).signedIn, false);
  assert.equal(getHubConfig(reloaded).hasToken, false);
  assert.equal(reloaded.getHubRefreshCredential().present, false);
  assert.equal(shouldEvictStaleTenantSession({
    tenantId: TENANT, origin: ORIGIN, isLoopback: false, account: getHubAccount(reloaded), hasRefreshToken: false,
  }), false);
});

test('tenant: eviction predicate evicts non-pinned/loopback origins and foreign tenants, exempts unstamped builds', () => {
  const LOOPBACK = 'http://127.0.0.1:8787';
  const loopbackAccount = {
    signedIn: true, origin: LOOPBACK, tenantId: TENANT, email: 'local@example.com',
  };
  assert.equal(shouldEvictStaleTenantSession({
    tenantId: TENANT, origin: LOOPBACK, isLoopback: true, account: loopbackAccount, hasRefreshToken: false,
  }), true);
  assert.equal(shouldEvictStaleTenantSession({
    tenantId: '', origin: ORIGIN, isLoopback: false, account: { signedIn: true, origin: ORIGIN, tenantId: 'other-tenant' }, hasRefreshToken: true,
  }), false);
  assert.equal(shouldEvictStaleTenantSession({
    tenantId: TENANT, origin: ORIGIN, isLoopback: false, account: { signedIn: true, origin: ORIGIN, tenantId: 'other-tenant' }, hasRefreshToken: true,
  }), true);
  assert.equal(shouldEvictStaleTenantSession({
    tenantId: TENANT, origin: ORIGIN, isLoopback: false, account: { signedIn: false, tenantId: '' }, hasRefreshToken: true,
  }), true);
  assert.equal(shouldEvictStaleTenantSession({
    tenantId: TENANT, origin: '', isLoopback: false, account: { signedIn: true, tenantId: '' }, hasRefreshToken: true,
  }), false);
});
