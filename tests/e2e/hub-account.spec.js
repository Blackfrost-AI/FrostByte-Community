import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HUB_API_BASE } from '../../src/main/hub-security.js';

/**
 * P1 (ADR 003): real Electron gate for in-app account management.
 *
 * The deployed Firebase backend does not yet carry the identity routes, so
 * canonical HUB_API_BASE requests are routed to a local identity stub inside
 * main (same technique as dashboard-login.spec.js / hub-discover.spec.js).
 * The stub speaks the REAL contract from platform/functions/src/app.js:
 * handle reserve/release with grace, server-managed fields rejected, bio
 * validation, publisher challenge burn-then-verify semantics (shape only —
 * real Ed25519 crypto is covered by the platform unit tests).
 *
 * Sign-in uses the REAL web-aligned PKCE desktop-auth flow (stubbed exchange +
 * Identity Toolkit, exactly like dashboard-login.spec.js), so the session
 * credential is created by production code paths — never injected by hand.
 *
 * What this proves end-to-end: preload surface → main validation → native
 * review gate → session bearer → server-confirmed profile refresh → UI.
 */

let app, page, home, stub;
const errors = [];
const CANONICAL_ORIGIN = new URL(HUB_API_BASE).origin;

const applicationPage = async application => {
  let candidate = await application.firstWindow();
  if (!candidate.url().startsWith('frostbyte://app/')) {
    await expect.poll(() => application.windows().find(w => w.url().startsWith('frostbyte://app/'))?.url()).toBeTruthy();
    candidate = application.windows().find(w => w.url().startsWith('frostbyte://app/'));
  }
  return candidate;
};

/** Local identity-plane stub: the deployed contract, minimal state. */
function createIdentityStub() {
  const state = {
    profile: {
      uid: 'usr_e2e', email: 'e2e@example.com', displayName: 'E2E Crafter',
      photoUrl: '', handle: '', bio: '', locale: '', timezone: '',
      preferences: {}, createdAt: '2026-01-01T00:00:00.000Z',
      entitlement: { tier: 'free', status: 'active', source: 'server', features: [] },
      orgs: [],
    },
    handles: new Map(),
    grace: new Map(),
    keys: new Map(),
    challenges: new Map(),
    requests: [],
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub.local');
      const p = url.pathname;
      state.requests.push({ method: req.method, path: p, auth: req.headers.authorization || '' });
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const fail = (status, code, message) => send(status, { error: { code, message } });
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }

      if (req.method === 'GET' && p === '/v1/health') return send(200, { status: 'ok', version: 'stub' });
      if (req.method === 'GET' && p === '/v1/me') return send(200, state.profile);
      if (req.method === 'PATCH' && p === '/v1/me') {
        for (const key of Object.keys(body)) {
          if (!['displayName', 'photoUrl', 'locale', 'timezone', 'preferences', 'bio'].includes(key)) {
            return fail(400, key === 'handle' ? 'handle_route_required' : 'field_not_writable', `Field "${key}" is not client-writable.`);
          }
          if (key === 'bio' && typeof body.bio === 'string' && body.bio.length > 280) {
            return fail(400, 'bio_invalid', 'Bio must be at most 280 characters.');
          }
          state.profile[key] = body[key];
        }
        return send(200, { ok: true, updated: Object.keys(body) });
      }
      if (req.method === 'POST' && p === '/v1/me/handle') {
        const handle = String(body.handle || '').trim();
        const lower = handle.toLowerCase();
        if (!/^[a-zA-Z0-9_]{3,24}$/.test(handle)) return fail(400, 'handle_invalid', 'Invalid handle.');
        if (['admin', 'frostbyte', 'frostnet'].includes(lower)) return fail(400, 'handle_reserved', 'That handle is reserved.');
        const held = state.handles.get(lower);
        if (held && held !== state.profile.uid) return fail(409, 'handle_taken', 'That handle is already taken.');
        const graceUntil = state.grace.get(lower);
        if (graceUntil && graceUntil > Date.now() && state.profile.handle?.toLowerCase() !== lower) {
          return fail(409, 'handle_grace', 'Recently released.');
        }
        if (state.profile.handle) {
          state.handles.delete(state.profile.handle.toLowerCase());
          state.grace.set(state.profile.handle.toLowerCase(), Date.now() + 30 * 86400000);
        }
        state.profile.handle = handle;
        state.handles.set(lower, state.profile.uid);
        return send(200, { ok: true, handle, handleLower: lower });
      }
      if (req.method === 'DELETE' && p === '/v1/me/handle') {
        if (state.profile.handle) {
          const lower = state.profile.handle.toLowerCase();
          state.handles.delete(lower);
          state.grace.set(lower, Date.now() + 30 * 86400000);
          state.profile.handle = '';
        }
        return send(200, { ok: true, released: true });
      }
      if (req.method === 'GET' && p === '/v1/me/publisher-keys') {
        const keys = [...state.keys.values()].map(k => ({ pubKey: k.pubKey, boundAt: k.boundAt, unboundAt: k.unboundAt || null }));
        return send(200, { ok: true, keys });
      }
      if (req.method === 'POST' && p === '/v1/me/publisher-key/challenge') {
        const pubKey = String(body.pubKey || '');
        if (!/^[a-f0-9]{64}$/.test(pubKey)) return fail(400, 'pubkey_invalid', 'Invalid publisher key.');
        const challengeId = 'ch-' + Math.random().toString(36).slice(2);
        state.challenges.set(challengeId, { pubKey, nonce: 'ab'.repeat(32), used: false });
        return send(200, { ok: true, challengeId, nonce: 'ab'.repeat(32), expiresAt: new Date(Date.now() + 600000).toISOString() });
      }
      if (req.method === 'POST' && p === '/v1/me/publisher-key') {
        const ch = state.challenges.get(String(body.challengeId || ''));
        if (!ch || ch.used || ch.pubKey !== body.pubKey) return fail(400, 'challenge_invalid', 'Challenge missing or used.');
        ch.used = true; // burn-then-verify, like the real backend
        if (!/^[a-f0-9]{128}$/.test(String(body.signature || ''))) return fail(400, 'signature_invalid', 'Invalid signature.');
        state.keys.set(body.pubKey, { pubKey: body.pubKey, boundAt: new Date().toISOString(), unboundAt: null });
        return send(200, { ok: true, pubKey: body.pubKey, boundAt: state.keys.get(body.pubKey).boundAt });
      }
      const unbind = p.match(/^\/v1\/me\/publisher-key\/([a-f0-9]{64})$/);
      if (req.method === 'DELETE' && unbind) {
        const key = state.keys.get(unbind[1]);
        if (!key) return fail(403, 'not_owner', 'Not bound to your account.');
        key.unboundAt = new Date().toISOString();
        return send(200, { ok: true, unbound: true });
      }
      return fail(404, 'not_found', 'No such route.');
    });
  });
  return {
    state,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve())),
    get origin() { return `http://127.0.0.1:${server.address().port}`; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test.describe.serial('FrostNet: account management (ADR 003)', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-identity-'));
    fs.mkdirSync(path.join(home, 'downloads'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
      downloadDir: path.join(home, 'downloads'),
      upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false, confirmBigPull: false,
    }));
    stub = createIdentityStub();
    await stub.listen();
    app = await electron.launch({
      executablePath: process.env.FROSTBYTE_EXECUTABLE,
      args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.', '--dev'],
      env: { ...process.env, FROSTBYTE_HOME: home },
    });
    page = await applicationPage(app);
    page.on('pageerror', error => errors.push(error.message));
    await acceptBetaTerms(page, app);

    // Stub native review dialogs + safeStorage keychain + deterministic PKCE
    // browser/network handoff (same technique as dashboard-login.spec.js).
    await app.evaluate(async ({ dialog, safeStorage, shell }, { stubOrigin, canonicalHubBase }) => {
      const realFetch = globalThis.fetch;
      const stateStore = { openedUrls: [], lastState: '', lastChallenge: '', dialogs: [] };
      globalThis.__fbIdentityE2E = stateStore;

      const sha256Base64Url = async text => {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
        return Buffer.from(digest).toString('base64url');
      };

      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.getSelectedStorageBackend = () => 'test-keychain';
      safeStorage.encryptString = value => Buffer.from(value, 'utf8');
      safeStorage.decryptString = value => Buffer.from(value).toString('utf8');

      dialog.showMessageBox = async (_window, options) => {
        const buttons = options?.buttons || [];
        stateStore.dialogs.push({ message: options?.message || '', detail: options?.detail || '', buttons: [...buttons] });
        const expandIdx = buttons.indexOf('Details…');
        if (expandIdx >= 0) return { response: expandIdx };
        return { response: 1, checkboxChecked: true };
      };

      shell.openExternal = async targetUrl => {
        stateStore.openedUrls.push(targetUrl);
        const parsed = new URL(targetUrl);
        stateStore.lastState = parsed.searchParams.get('state') || '';
        stateStore.lastChallenge = parsed.searchParams.get('code_challenge') || '';
      };

      const mkJwt = claims => [
        Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify(claims)).toString('base64url'),
        'sig',
      ].join('.');

      globalThis.fetch = async (input, init = {}) => {
        const rawUrl = typeof input === 'string' ? input : input?.url || String(input);
        const parsed = new URL(rawUrl);

        if (rawUrl === `${canonicalHubBase}/v1/auth/desktop/exchange`) {
          const body = JSON.parse(String(init.body || '{}'));
          const challenge = await sha256Base64Url(body.codeVerifier);
          if (body.code !== 'pkce_one_time_code_abcdefghijklmnopqrstuvwxyz012345' || body.state !== stateStore.lastState || challenge !== stateStore.lastChallenge) {
            return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'PKCE mismatch' } }), {
              status: 401, headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({
            customToken: mkJwt({ uid: 'usr_e2e', claims: { frostbyteDesktopSession: 'dsess_e2e_0001' } }),
            sessionId: 'dsess_e2e_0001',
            tenantId: 'frostbyte-0ji2f',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        if (parsed.hostname === 'identitytoolkit.googleapis.com' && parsed.pathname.endsWith('/accounts:signInWithCustomToken')) {
          return new Response(JSON.stringify({
            kind: 'identitytoolkit#VerifyCustomTokenResponse',
            idToken: mkJwt({
              user_id: 'usr_e2e',
              email: 'e2e@example.com',
              name: 'E2E Crafter',
              firebase: { tenant: 'frostbyte-0ji2f', sign_in_provider: 'custom' },
            }),
            refreshToken: 'refresh_e2e_token_0001',
            expiresIn: '3600',
            isNewUser: false,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        if (rawUrl === `${canonicalHubBase}/v1/auth/desktop/revoke`) {
          return new Response(JSON.stringify({ revoked: true }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }

        if (rawUrl.startsWith(`${canonicalHubBase}/`)) {
          return realFetch(`${stubOrigin}${rawUrl.slice(canonicalHubBase.length)}`, init);
        }
        return realFetch(input, init);
      };
    }, { stubOrigin: stub.origin, canonicalHubBase: HUB_API_BASE });

    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));

    // Real PKCE sign-in through the production UI + deep-link handoff.
    await page.locator('#btn-account').click();
    await expect(page.locator('#modal-desktop-auth-form')).toBeVisible();
    await page.locator('#modal-acts .btn.primary').click();
    const openedUrl = await app.evaluate(() => globalThis.__fbIdentityE2E.openedUrls[0] || '');
    expect(openedUrl.startsWith('https://frostbyte.si/desktop-auth?')).toBe(true);
    const pkceState = new URL(openedUrl).searchParams.get('state');
    await app.evaluate(({ app: electronApp }, stateParam) => {
      electronApp.emit(
        'open-url',
        { preventDefault() {} },
        `frostbyte://auth?code=pkce_one_time_code_abcdefghijklmnopqrstuvwxyz012345&state=${encodeURIComponent(stateParam)}`,
      );
    }, pkceState);
    await expect(page.locator('#top-account-label')).toHaveText('E2E Crafter');
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    await stub?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test('the account-management IPC surface is exposed and guarded', async () => {
    const surface = await page.evaluate(() => ({
      updateMe: typeof window.frostbyte.hubUpdateMe,
      setHandle: typeof window.frostbyte.hubSetHandle,
      releaseHandle: typeof window.frostbyte.hubReleaseHandle,
      keys: typeof window.frostbyte.hubPublisherKeys,
      bind: typeof window.frostbyte.hubBindPublisher,
      unbind: typeof window.frostbyte.hubUnbindPublisher,
      byHandle: typeof window.frostbyte.hubCreatorByHandle,
    }));
    for (const [name, kind] of Object.entries(surface)) expect(kind, name).toBe('function');

    // Renderer cannot write server-managed fields or smuggle a handle via PATCH.
    const tierWrite = await page.evaluate(() => window.frostbyte.hubUpdateMe({ tier: 'pro' }));
    expect(tierWrite.ok).toBe(false);
    const handleSmuggle = await page.evaluate(() => window.frostbyte.hubUpdateMe({ handle: 'sneaky' }));
    expect(handleSmuggle.ok).toBe(false);
    // Invalid handle never leaves the device (main validates against shared rules).
    const badHandle = await page.evaluate(() => window.frostbyte.hubSetHandle('x'));
    expect(badHandle.ok).toBe(false);
    const reserved = await page.evaluate(() => window.frostbyte.hubSetHandle('admin'));
    expect(reserved.ok).toBe(false);
    expect(stub.state.requests.filter(r => r.path === '/v1/me/handle').length).toBe(0);
  });

  test('handle reserve → server-confirmed profile → release with grace', async () => {
    const saved = await page.evaluate(() => window.frostbyte.hubSetHandle('E2E_Crafter99'));
    expect(saved.ok).toBe(true);
    expect(saved.data.account.handle).toBe('E2E_Crafter99');
    expect(stub.state.profile.handle).toBe('E2E_Crafter99');
    // The mutation rode the session bearer through the native review gate.
    const post = stub.state.requests.find(r => r.method === 'POST' && r.path === '/v1/me/handle');
    expect(post.auth).toMatch(/^Bearer /);
    const dialogs = await app.evaluate(() => globalThis.__fbIdentityE2E.dialogs);
    expect(dialogs.some(d => d.message === 'Use your FrostByte account?')).toBe(true);

    const released = await page.evaluate(() => window.frostbyte.hubReleaseHandle());
    expect(released.ok).toBe(true);
    expect(released.data.account.handle).toBe('');
    expect(stub.state.grace.has('e2e_crafter99')).toBe(true);
  });

  test('bio + displayName round-trip the Hub and refresh the cached account', async () => {
    const res = await page.evaluate(() => window.frostbyte.hubUpdateMe({
      displayName: 'E2E Crafter Prime', bio: 'Making local models sing.',
    }));
    expect(res.ok).toBe(true);
    expect(res.data.account.displayName).toBe('E2E Crafter Prime');
    expect(res.data.account.bio).toBe('Making local models sing.');
    // Oversized bio is rejected in main before any network call.
    const before = stub.state.requests.length;
    const tooLong = await page.evaluate(() => window.frostbyte.hubUpdateMe({ bio: 'x'.repeat(281) }));
    expect(tooLong.ok).toBe(false);
    expect(stub.state.requests.length).toBe(before);
  });

  test('the Settings profile card renders the verified session and edits', async () => {
    await page.locator('#nav [data-tab="settings"]').click();
    await page.locator('#settings-nav [data-sec="hub"]').click();
    await expect(page.locator('#hub-profile-card')).toBeVisible();
    await expect(page.locator('#set-hub-handle')).toHaveValue('');
    await expect(page.locator('#set-hub-displayname')).toHaveValue('E2E Crafter Prime');
    await expect(page.locator('#set-hub-bio')).toHaveValue('Making local models sing.');

    // Edit through the real UI: type a handle, save, watch server confirmation.
    await page.locator('#set-hub-handle').fill('ui_crafter');
    await page.locator('#btn-hub-handle-save').click();
    await expect(page.locator('#hub-profile-status')).toContainText('confirmed by the Hub');
    expect(stub.state.profile.handle).toBe('ui_crafter');

    // Release button enables only when a handle exists.
    await expect(page.locator('#btn-hub-handle-release')).toBeEnabled();
    await page.locator('#btn-hub-handle-release').click();
    await expect(page.locator('#hub-profile-status')).toContainText('30 days');
    await expect(page.locator('#btn-hub-handle-release')).toBeDisabled();
  });

  test('publisher binding refuses without an unlocked identity; unbind is owner-gated', async () => {
    // No publisher identity exists in this fresh profile → main refuses before
    // any challenge request (the key never leaves the device).
    const bind = await page.evaluate(() => window.frostbyte.hubBindPublisher());
    expect(bind.ok).toBe(false);
    expect(stub.state.requests.filter(r => r.path === '/v1/me/publisher-key/challenge').length).toBe(0);

    // Unbind of a key not bound to this account is refused by the server.
    const unbind = await page.evaluate(() => window.frostbyte.hubUnbindPublisher('ab'.repeat(32)));
    expect(unbind.ok).toBe(false);

    const keys = await page.evaluate(() => window.frostbyte.hubPublisherKeys());
    expect(keys.ok).toBe(true);
    expect(keys.data.keys).toEqual([]);
  });

  test('no renderer page errors across the account-management flow', async () => {
    expect(errors).toEqual([]);
  });
});