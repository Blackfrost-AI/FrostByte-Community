import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHubApp } from '../../hub/src/app.js';
import { HUB_API_BASE } from '../../src/main/hub-security.js';

const applicationPage = async application => {
  let candidate = await application.firstWindow();
  if (!candidate.url().startsWith('frostbyte://app/')) {
    await expect.poll(() => application.windows().find(w => w.url().startsWith('frostbyte://app/'))?.url()).toBeTruthy();
    candidate = application.windows().find(w => w.url().startsWith('frostbyte://app/'));
  }
  return candidate;
};

test('First screen is User Dashboard (no steering/sidecar panels) and PKCE web sign-in + frostbyte://auth handoff updates header + dashboard', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-e2e-dashboard-'));
  const hubDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-e2e-hub-'));
  fs.mkdirSync(path.join(home, 'downloads'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    downloadDir: path.join(home, 'downloads'),
    upnpEnabled: false,
    dhtEnabled: false,
    confirmExitSeeding: false,
    confirmBigPull: false,
  }));

  const hub = createHubApp({
    port: 0,
    seed: false,
    dataDir: hubDataDir,
    accounts: [
      {
        uid: 'usr_founder',
        email: 'craig@blackfrost.ai',
        password: 'frostbyte-dev-password',
        displayName: 'Craig',
        tier: 'pro',
      },
    ],
  });
  const observedAuth = [];
  hub.server.on('request', req => {
    observedAuth.push({ url: req.url, hasAuth: Boolean(req.headers.authorization) });
  });
  await hub.listen();
  const hubOrigin = hub.origin;

  let app;
  try {
    app = await electron.launch({
      executablePath: process.env.FROSTBYTE_EXECUTABLE,
      args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.', '--dev'],
      env: { ...process.env, FROSTBYTE_HOME: home },
    });

    const page = await applicationPage(app);
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await acceptBetaTerms(page, app);

    // Stub native review dialogs + safeStorage keychain + deterministic PKCE browser/network handoff
    await app.evaluate(async ({ dialog, safeStorage, shell }, { fixtureOrigin, canonicalHubBase }) => {
      const realFetch = globalThis.fetch;
      const stateStore = { openedUrls: [], lastState: '', lastChallenge: '', revokedSessions: [] };
      globalThis.__fbDesktopAuthE2E = stateStore;

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
        const expandIdx = buttons.indexOf('Details…');
        if (expandIdx >= 0) return { response: expandIdx };
        return { response: 1 };
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
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({
            customToken: mkJwt({ uid: 'usr_founder', claims: { frostbyteDesktopSession: 'dsess_founder_0001' } }),
            sessionId: 'dsess_founder_0001',
            tenantId: 'frostbyte-0ji2f',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (parsed.hostname === 'identitytoolkit.googleapis.com' && parsed.pathname.endsWith('/accounts:signInWithCustomToken')) {
          return new Response(JSON.stringify({
            kind: 'identitytoolkit#VerifyCustomTokenResponse',
            idToken: mkJwt({
              user_id: 'usr_founder',
              email: 'craig@blackfrost.ai',
              name: 'Craig',
              firebase: { tenant: 'frostbyte-0ji2f', sign_in_provider: 'custom' },
            }),
            refreshToken: 'refresh_founder_e2e_token_0001',
            expiresIn: '3600',
            isNewUser: false,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (rawUrl === `${canonicalHubBase}/v1/me`) {
          // Forward to fixture so observedAuth records /v1/me with Authorization header, then return Craig's Pro profile.
          await realFetch(`${fixtureOrigin}/v1/me`, init).catch(() => {});
          return new Response(JSON.stringify({
            uid: 'usr_founder',
            email: 'craig@blackfrost.ai',
            emailVerified: true,
            displayName: 'Craig',
            entitlement: {
              tier: 'pro',
              source: 'admin',
              status: 'active',
              validUntil: '2027-01-01T00:00:00.000Z',
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (rawUrl === `${canonicalHubBase}/v1/auth/desktop/revoke`) {
          const body = JSON.parse(String(init.body || '{}'));
          stateStore.revokedSessions.push(body.sessionId);
          return new Response(JSON.stringify({ revoked: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (rawUrl.startsWith(`${canonicalHubBase}/`)) {
          return realFetch(`${fixtureOrigin}${rawUrl.slice(canonicalHubBase.length)}`, init);
        }

        return realFetch(input, init);
      };
    }, { fixtureOrigin: hubOrigin, canonicalHubBase: HUB_API_BASE });

    // 1. User Dashboard is ALWAYS the first screen on launch
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await expect(page.locator('#nav .nav.on')).toHaveAttribute('data-tab', 'dashboard');
    await expect(page.locator('#home-hero-title')).toContainText('Welcome home');

    // 2. Loaded Models & Device Stats panel is rendered
    await expect(page.locator('#home-runtime-title')).toContainText('Loaded Models & Device Stats');
    await expect(page.locator('#home-local-card')).toBeVisible();

    // 3. Steering & Sidecar control panels remain absent, AND no localhost/password login inputs exist
    await expect(page.locator('#bf-suite-heading')).toHaveCount(0);
    await expect(page.locator('#bf-rti-title')).toHaveCount(0);
    await expect(page.locator('#bf-sidecar-title')).toHaveCount(0);
    await expect(page.locator('#set-huburl')).toHaveCount(0);
    await expect(page.locator('#hub-login-email')).toHaveCount(0);
    await expect(page.locator('#hub-login-password')).toHaveCount(0);
    const scaffoldGone = await page.evaluate(() => typeof window.__frostbyteBlackfrost === 'undefined');
    expect(scaffoldGone).toBe(true);

    // 4. Click topbar Sign in button -> opens web-aligned FrostNet sign-in modal (no password or localhost fields)
    await expect(page.locator('#top-account-label')).toHaveText('Sign in');
    await page.locator('#btn-account').click();
    await expect(page.locator('#modal-desktop-auth-form')).toBeVisible();
    await expect(page.locator('#modal-hub-url')).toHaveCount(0);
    await expect(page.locator('#modal-hub-password')).toHaveCount(0);

    await page.locator('#modal-acts .btn.primary').click();

    const openedUrl = await app.evaluate(() => globalThis.__fbDesktopAuthE2E.openedUrls[0] || '');
    expect(openedUrl.startsWith('https://frostbyte.si/desktop-auth?')).toBe(true);
    const parsedBrowserUrl = new URL(openedUrl);
    expect(parsedBrowserUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const pkceState = parsedBrowserUrl.searchParams.get('state');
    expect(pkceState?.length).toBeGreaterThanOrEqual(32);

    // Deliver the OS deep link frostbyte://auth?code=...&state=... back into Electron main
    await app.evaluate(({ app: electronApp }, stateParam) => {
      electronApp.emit(
        'open-url',
        { preventDefault() {} },
        `frostbyte://auth?code=pkce_one_time_code_abcdefghijklmnopqrstuvwxyz012345&state=${encodeURIComponent(stateParam)}`,
      );
    }, pkceState);

    // 5. Header + Dashboard personalize immediately with Craig + PRO tier badge
    await expect(page.locator('#top-account-label')).toHaveText('Craig');
    await expect(page.locator('#top-account-tier')).toContainText(/pro/i);
    await expect(page.locator('#home-hero-title')).toContainText('Welcome home, Craig');
    await expect(page.locator('#home-account-card .home-tier-pill')).toContainText(/pro/i);

    // Public Hub search must never send the saved Bearer token
    const searchRes = await page.evaluate(() => window.frostbyte.hubSearch({ q: '' }));
    expect(searchRes.ok).toBe(true);
    const searchCalls = observedAuth.filter(r => r.url.startsWith('/v1/search'));
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.every(r => r.hasAuth === false)).toBe(true);

    // Authenticated account sync must send the saved Bearer token
    const syncRes = await page.evaluate(() => window.frostbyte.hubRefreshAccount());
    expect(syncRes.ok).toBe(true);
    const meCalls = observedAuth.filter(r => r.url === '/v1/me');
    expect(meCalls.length).toBeGreaterThan(0);
    expect(meCalls.every(r => r.hasAuth === true)).toBe(true);

    // 6. Verify Settings Hub Account section reflects signed-in identity and Sign out revokes desktop session
    await page.locator('#nav [data-tab="settings"]').click();
    await page.locator('#settings-nav [data-sec="hub"]').click();
    await expect(page.locator('#hub-account-summary')).toContainText('Craig');
    await page.locator('#btn-hub-logout').click();
    await expect(page.locator('#top-account-label')).toHaveText('Sign in');
    const revokedSessions = await app.evaluate(() => globalThis.__fbDesktopAuthE2E.revokedSessions);
    expect(revokedSessions).toEqual(['dsess_founder_0001']);

    expect(pageErrors).toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    await hub.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(hubDataDir, { recursive: true, force: true });
  }
});
