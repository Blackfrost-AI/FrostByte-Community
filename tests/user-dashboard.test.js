import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  accountInitials,
  formatTierBadge,
  userDashboardHtml,
} from '../src/renderer/user-dashboard.js';
import { createHubClient } from '../src/main/hub-client.js';
import {
  normalizeHubAccount,
  applyHubConfig,
  applyHubAccount,
  clearHubAccount,
  getHubAccount,
  shouldEvictStaleTenantSession,
} from '../src/main/hub-store.js';
import { Store } from '../src/main/store.js';
import { HUB_API_BASE } from '../src/main/hub-security.js';
import {
  createDesktopAuthRequest,
  parseDesktopAuthUrl,
  desktopAuthBrowserReview,
  desktopAuthExchangeReview,
} from '../src/main/desktop-auth.js';

test('User Dashboard escapes untrusted fields, renders local initials only, and preserves unmeasured — honesty', () => {
  assert.equal(accountInitials({ displayName: 'Craig Mac' }), 'CM');
  assert.equal(accountInitials({ email: 'alice@example.com' }), 'AE');
  assert.equal(accountInitials({}), 'FB');
  assert.deepEqual(formatTierBadge({ tier: 'pro', status: 'active' }), { label: 'PRO', cls: 'tier-pro' });

  const html = userDashboardHtml({
    state: {
      hubAccount: {
        signedIn: true,
        uid: 'u_1',
        email: 'craig+<script>alert(1)</script>@blackfrost.ai',
        displayName: 'Craig <img src=x onerror=alert(1)>',
        photoUrl: 'https://evil.example/track.png',
        origin: HUB_API_BASE,
      },
      hubEntitlement: { tier: 'pro', status: 'active' },
      hubConfig: { hubUrl: HUB_API_BASE, hasToken: true },
      localHardware: { name: 'Mac Studio', memoryBytes: 64 * 1024 ** 3 },
      inventory: [
        { id: 'm1', name: 'Qwen2.5-32B-GGUF', kind: 'model', size: 19_000_000_000 },
      ],
      torrents: [],
      downloads: [],
    },
    devices: [
      {
        id: 'spark-1',
        name: 'DGX Spark <svg onload=alert(1)>',
        host: '192.168.1.50',
        connected: true,
        hardware: { name: 'NVIDIA GB10', memoryBytes: 128 * 1024 ** 3 },
      },
    ],
    localTelemetry: {
      memory: { total: 64 * 1024 ** 3, available: 32 * 1024 ** 3 },
      storage: { total: 1024 ** 4, available: 500 * 1024 ** 3 },
    },
    sparkTelemetry: {
      cpu: { utilizationPercent: 18.4 },
      gpu: { utilizationPercent: null, temperatureC: 46, powerWatts: null },
      memory: { total: 128 * 1024 ** 3, available: 96 * 1024 ** 3 },
      docker: {
        available: true,
        containers: [
          {
            name: 'vllm-qwen<b>xss</b>',
            image: 'vllm/vllm-openai:latest',
            state: 'running',
            status: 'Up 2 hours',
          },
        ],
      },
      endpoint: { state: 'listening', port: 8000 },
    },
    sparkRecipes: [
      { id: 'r1', title: 'DeepSeek-R1-Distill-32B', state: 'running', kind: 'vLLM recipe' },
    ],
  });

  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('evil.example'));
  assert.ok(!html.includes('<svg onload=alert(1)>'));
  assert.ok(!html.includes('<b>xss</b>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('vllm-qwen&lt;b&gt;xss&lt;/b&gt;'));
  assert.ok(html.includes('DeepSeek-R1-Distill-32B'));
  assert.ok(html.includes('<strong>—</strong>'));
  assert.ok(!html.includes('bf-suite'));
  assert.ok(!html.includes('bf-rti'));
  assert.ok(!html.includes('bf-sidecar'));
  assert.ok(!html.includes('Steering'));
  assert.ok(!html.includes('Sidecar'));
});

test('FrostNet browser PKCE sign-in, /v1/me, /v1/me/entitlement, and Store session lifecycle work end to end', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hub-login-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const authReq = createDesktopAuthRequest();
  const browserReview = desktopAuthBrowserReview();
  assert.match(browserReview.detail, /https:\/\/frostbyte\.si\/desktop-auth/);
  const exchangeReview = desktopAuthExchangeReview({ state: authReq.state });
  assert.ok(exchangeReview.detail.includes(HUB_API_BASE));

  const code = 'd'.repeat(43);
  const parsedCallback = parseDesktopAuthUrl(`frostbyte://auth?code=${code}&state=${authReq.state}`);
  assert.deepEqual(parsedCallback, { code, state: authReq.state });

  // Stub fetcher simulating the live FrostNet Hub API (HUB_API_BASE).
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(init.headers?.Authorization, 'Bearer firebase-id-token-live');
    if (u.pathname.endsWith('/v1/me')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => '' },
        text: async () => JSON.stringify({
          uid: 'usr_craig',
          email: 'craig@blackfrost.ai',
          displayName: 'Craig Mac',
          emailVerified: true,
          tenantId: 'frostbyte-0ji2f',
          isAdmin: true,
          entitlement: { tier: 'pro', status: 'active' },
        }),
      };
    }
    if (u.pathname.endsWith('/v1/me/entitlement')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => '' },
        text: async () => JSON.stringify({ tier: 'pro', status: 'active' }),
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const authedClient = createHubClient({ hubUrl: HUB_API_BASE, token: 'firebase-id-token-live', fetcher });
  assert.equal(typeof authedClient.login, 'undefined');
  assert.equal(typeof authedClient.logout, 'undefined');

  const meRes = await authedClient.me();
  assert.equal(meRes.data.uid, 'usr_craig');
  assert.equal(meRes.data.entitlement.tier, 'pro');

  const entRes = await authedClient.entitlement();
  assert.equal(entRes.data.tier, 'pro');

  const store = new Store(path.join(tmpDir, 'desktop-store'));
  applyHubConfig(store, { hubUrl: HUB_API_BASE });
  store.setHubCredential({
    hubTokenEnc: Buffer.from('firebase-id-token-live').toString('base64'),
    hubTokenOrigin: HUB_API_BASE,
    hubTokenFingerprint: 'a'.repeat(64),
  });
  store.setHubRefreshCredential({ hubRefreshEnc: 'cmVmcmVzaF9ibG9i', hubRefreshOrigin: HUB_API_BASE });
  store.setHubTokenExpiry({ hubTokenExpiresAt: Date.now() + 3_600_000, hubTokenExpiryOrigin: HUB_API_BASE });
  const savedAcct = applyHubAccount(store, normalizeHubAccount({
    signedIn: true,
    ...meRes.data,
    origin: HUB_API_BASE,
    verifiedAt: Date.now(),
    desktopSessionId: 'dsess_live_1',
  }, HUB_API_BASE), HUB_API_BASE);
  assert.equal(savedAcct.signedIn, true);
  assert.equal(getHubAccount(store).displayName, 'Craig Mac');
  assert.equal(getHubAccount(store).desktopSessionId, 'dsess_live_1');
  assert.equal(store.getHubRefreshCredential().present, true);
  assert.ok(store.getHubTokenExpiry().expiresAt > 0);

  clearHubAccount(store);
  assert.equal(getHubAccount(store).signedIn, false);
  assert.equal(store.getHubRefreshCredential().present, false);
  assert.equal(store.getHubTokenExpiry().expiresAt, 0);
});

test('desktop UI/IPC contract: browser sign-in is wired and legacy password/localhost inputs are gone', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'src/renderer/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'src/renderer/app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(process.cwd(), 'src/preload/index.cjs'), 'utf8');
  const mainJs = fs.readFileSync(path.join(process.cwd(), 'src/main/index.js'), 'utf8');

  assert.ok(html.includes('id="btn-hub-browser-login"'));
  assert.ok(html.includes('Sign in with FrostNet'));
  for (const removedId of [
    'id="hub-login-email"',
    'id="hub-login-password"',
    'id="hub-signup-email"',
    'id="hub-signup-password"',
    'id="hub-url"',
    'id="btn-hub-save"',
  ]) {
    assert.ok(!html.includes(removedId), `removed element still in HTML: ${removedId}`);
  }
  assert.ok(!html.includes('localhost:8787'));

  assert.ok(preload.includes("hubSignInWithBrowser: () => invoke('hub:sign-in-with-browser')"));
  assert.ok(preload.includes("onHubAuthStatus: cb => listen('hub:auth-status', cb)"));
  for (const removedChannel of ['hub:login', 'hub:signup', 'hub:reset-password']) {
    assert.ok(!preload.includes(`'${removedChannel}'`), `removed channel in preload: ${removedChannel}`);
    assert.ok(!mainJs.includes(`handle('${removedChannel}'`), `removed handler in main: ${removedChannel}`);
  }
  assert.ok(mainJs.includes("The FrostByte Hub URL is managed by the application."), 'hub:set-config refuses hubUrl overrides');
  assert.ok(appJs.includes('api.hubSignInWithBrowser()'));
});

test('P0 nav honesty: Search label, FrostNet coming-soon placeholder, no duplicate search UI', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'src/renderer/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'src/renderer/app.js'), 'utf8');
  const dashboardJs = fs.readFileSync(path.join(process.cwd(), 'src/renderer/user-dashboard.js'), 'utf8');
  const preload = fs.readFileSync(path.join(process.cwd(), 'src/preload/index.cjs'), 'utf8');
  const mainJs = fs.readFileSync(path.join(process.cwd(), 'src/main/index.js'), 'utf8');
  const hubClientJs = fs.readFileSync(path.join(process.cwd(), 'src/main/hub-client.js'), 'utf8');
  const hubSecurityJs = fs.readFileSync(path.join(process.cwd(), 'src/main/hub-security.js'), 'utf8');

  // HF browse tab says Search; the tab id stays 'hf' so deep links survive.
  assert.match(html, /<div class="nav" data-tab="hf"><span class="ic">⇱<\/span>Search<\/div>/);
  assert.ok(!html.includes('</span>Models</div>'), 'no nav item may still be labelled Models');

  // FrostNet nav is marked inactive/coming-soon but opens a real home (P3 T6).
  assert.match(html, /data-tab="discover" aria-disabled="true"/);
  assert.ok(html.includes('id="ct-discover">soon<'));
  assert.ok(html.includes('id="view-discover"'), 'FrostNet view exists');
  assert.ok(html.includes('id="fn-home-recent"'), 'Recently shared section');
  assert.ok(html.includes('id="fn-home-creators"'), 'Creators section');
  assert.ok(html.includes('id="hub-coming-search"'));
  assert.ok(html.includes('Open Search'), 'home has Open Search button');

  // The duplicate search UI is gone from the FrostNet view.
  for (const removedId of ['id="hub-q"', 'id="hub-go"', 'id="grid-hub"', 'id="empty-hub"', 'id="hub-count"', 'id="hub-filters"', 'id="hub-detail"', 'id="hub-pagination"', 'class="hub-wrap"', 'class="hub-searchbar"']) {
    assert.ok(!html.includes(removedId), `duplicate search element still in HTML: ${removedId}`);
    assert.ok(!appJs.includes(removedId.replace('id="', "'#").replace('"', "'")), `dead selector still in app.js: ${removedId}`);
  }
  assert.ok(!appJs.includes('renderHubResults'), 'dead render function removed');
  assert.ok(!appJs.includes('runHubSearch'), 'dead search function removed');
  assert.ok(appJs.includes("$('#hub-coming-search')?.addEventListener('click', () => goTab('hf'))"));

  // Bundle import is honestly a seed record, in both the view and Settings.
  assert.ok(html.includes('Offline bundle seed'));
  assert.ok(html.includes('id="hub-bundle-note-settings"'));
  assert.ok(appJs.includes('offline browsing arrives with FrostNet'));

  // Dashboard shortcut no longer advertises working FrostNet browsing.
  assert.ok(!dashboardJs.includes('Browse FrostNet'));
  assert.ok(dashboardJs.includes('Coming soon'));

  // Check Hub probes the DEPLOYED /v1/health through the same review gate,
  // never the undeployed /v1/search.
  assert.ok(appJs.includes('const res = await api.hubHealth();'));
  assert.ok(!appJs.includes("api.hubSearch({ q: 'test'"), 'settings probe must not use search');
  assert.ok(preload.includes("hubHealth: () => invoke('hub:health')"));
  assert.ok(mainJs.includes("handle('hub:health'"));
  assert.ok(mainJs.includes("reviewHub(client, 'health')"));
  assert.ok(mainJs.includes('client.health()'));
  assert.ok(hubClientJs.includes("return request('/v1/health', { bearer: '' });"));
  assert.ok(hubSecurityJs.includes("health: 'Check whether FrostByte Hub is reachable'"));

  // Feed-injection defense is enforced in MAIN, not by the tier gate alone:
  // both update handlers must route through verifiedUpdateFeed, and the
  // preload must not forward a renderer-supplied feed argument.
  const checkUpdateHandler = mainJs.slice(mainJs.indexOf("handle('hub:check-update'"), mainJs.indexOf("handle('hub:config'"));
  assert.ok(checkUpdateHandler.includes('verifiedUpdateFeed(res?.data)'), 'hub:check-update must verify the fetched feed');
  assert.ok(!/handle\('hub:check-update', async \([^)]*feed/.test(mainJs), 'hub:check-update must not accept a feed argument');
  const updatesHandler = mainJs.slice(mainJs.indexOf("handle('hub:updates'"), mainJs.indexOf("handle('hub:check-update'"));
  assert.ok(updatesHandler.includes('verifiedUpdateFeed(res.data)'), 'hub:updates must verify the fetched feed');
  assert.ok(preload.includes('hubCheckUpdate: (installed) => invoke(\'hub:check-update\', { installed })'), 'preload must drop any second (feed) argument');
  // Direct hubSetConfig hubUrl injection is refused in main, not just setSettings.
  const setConfigHandler = mainJs.slice(mainJs.indexOf("handle('hub:set-config'"), mainJs.indexOf("handle('hub:set-config'") + 400);
  assert.ok(setConfigHandler.includes("Object.hasOwn(patch, 'hubUrl')") && setConfigHandler.includes('hub_bad_request'), 'hub:set-config must refuse hubUrl overrides');
});

test('hub account carries tenantId + isAdmin + desktopSessionId and rejects malformed values', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-tenant-store-'));
  try {
    const store = new Store(path.join(tmpDir, 'store'));
    const prod = applyHubAccount(store, normalizeHubAccount({
      signedIn: true,
      uid: 'u1',
      email: 'a@example.com',
      tenantId: 'frostbyte-ab12cd',
      isAdmin: true,
      desktopSessionId: 'dsess_abc_123',
    }, HUB_API_BASE), HUB_API_BASE);
    assert.equal(prod.tenantId, 'frostbyte-ab12cd');
    assert.equal(prod.isAdmin, true);
    assert.equal(prod.desktopSessionId, 'dsess_abc_123');

    const weird = normalizeHubAccount({
      signedIn: true,
      uid: 'u3',
      tenantId: 'bad tenant!',
      desktopSessionId: 'bad session id with spaces!',
    });
    assert.equal(weird.tenantId, '');
    assert.equal(weird.desktopSessionId, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stale pre-tenant and non-pinned/loopback sessions are evicted; manual-token and matching-tenant sessions are kept', () => {
  const base = {
    tenantId: 'frostbyte-ab12cd',
    origin: HUB_API_BASE,
    isLoopback: false,
    hasRefreshToken: true,
    account: { signedIn: true, origin: HUB_API_BASE, tenantId: '' },
  };
  assert.equal(shouldEvictStaleTenantSession(base), true, 'root-pool ghost is evicted');
  assert.equal(shouldEvictStaleTenantSession({ ...base, account: { signedIn: true, origin: HUB_API_BASE, tenantId: 'frostbyte-ab12cd' } }), false, 'matching tenant kept');
  assert.equal(shouldEvictStaleTenantSession({ ...base, origin: 'http://127.0.0.1:8787', isLoopback: true }), true, 'legacy loopback Hub is evicted');
  assert.equal(shouldEvictStaleTenantSession({ ...base, origin: 'https://hub.frostbyte.si' }), true, 'non-pinned origin is evicted');
  assert.equal(shouldEvictStaleTenantSession({ ...base, tenantId: '' }), false, 'unstamped builds exempt');
  assert.equal(shouldEvictStaleTenantSession({ ...base, origin: '' }), false, 'no origin exempt');
  assert.equal(
    shouldEvictStaleTenantSession({ ...base, hasRefreshToken: false, account: { signedIn: false, tenantId: '' } }),
    false,
    'manual bfk_ token session (no Firebase account, no refresh credential) exempt',
  );
  assert.equal(
    shouldEvictStaleTenantSession({ ...base, hasRefreshToken: false, account: { signedIn: true, origin: HUB_API_BASE, tenantId: 'other-tenant-1' } }),
    true,
    'foreign-tenant account still evicted even without a refresh credential',
  );
});

test('dashboard: admin touchpoint renders only for isAdmin, exact handoff URL, non-admins see nothing', () => {
  const baseState = {
    hubEntitlement: { tier: 'pro', status: 'active' },
    hubConfig: { hubUrl: HUB_API_BASE, hasToken: true },
    inventory: [], torrents: [], downloads: [],
  };
  const adminHtml = userDashboardHtml({
    state: { ...baseState, hubAccount: { signedIn: true, uid: 'a', email: 'inbox@example.com', isAdmin: true } },
    devices: [],
  });
  assert.ok(adminHtml.includes('data-dash-action="open-admin-console"'));
  assert.ok(adminHtml.includes('ADMIN'));

  const userHtml = userDashboardHtml({
    state: { ...baseState, hubAccount: { signedIn: true, uid: 'u', email: 'user@example.com' } },
    devices: [],
  });
  assert.ok(!userHtml.includes('open-admin-console'));
  assert.ok(!userHtml.includes('ADMIN'));

  const appSource = fs.readFileSync(path.join(process.cwd(), 'src/renderer/app.js'), 'utf8');
  assert.ok(appSource.includes("api.openExternal('https://frostbyte.si/admin')"));
});

test('F1: ensureHubIdToken returns the REAL tenant on every path; restore never fallback-labels', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main/index.js'), 'utf8');

  assert.ok(/import \{[\s\S]*?firebaseTokenTenant,[\s\S]*?\} from '\.\/hub-security\.js';/.test(source), 'decoder imported from hub-security.js');
  assert.ok(!source.includes('function firebaseTokenTenant('), 'no local decoder copy in index.js');

  const fnStart = source.indexOf('async function ensureHubIdToken()');
  assert.ok(fnStart > 0, 'ensureHubIdToken located');
  const afterFn = source.slice(fnStart + 10);
  const nextDecl = afterFn.search(/\n(?:async )?function |\nhandle\(|\nipcMain\./);
  const fn = nextDecl > 0 ? afterFn.slice(0, nextDecl) : afterFn;
  const returns = fn.match(/return \{[\s\S]*?\};/g) || [];
  assert.equal(returns.length, 3, `expected 3 token-object return paths, found ${returns.length}`);
  for (const ret of returns) {
    assert.ok(ret.includes('tenantId:'), `return path missing tenantId: ${ret.slice(0, 80)}`);
  }

  assert.ok(fn.includes("if (FIREBASE_CONFIG.tenantId && (session.tenantId || '') !== FIREBASE_CONFIG.tenantId)"), 'mismatch guard present');
  assert.ok(fn.includes('clearHubAccount(store)'), 'mismatch evicts the account');
  assert.ok(fn.includes("store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' })"), 'mismatch clears the refresh credential');
  const guardAt = fn.indexOf("if (FIREBASE_CONFIG.tenantId && (session.tenantId || '') !== FIREBASE_CONFIG.tenantId)");
  const guardBody = fn.slice(guardAt, fn.indexOf('throw refuse', guardAt));
  assert.ok(guardBody.includes('if (hubRefreshToken(origin) === refreshToken)'), 'R1 credential-identity check wraps the eviction');

  assert.ok(!source.includes("tenantId: session.tenantId || FIREBASE_CONFIG.tenantId || ''"), 'restore/sign-in fallback labeling removed');
  assert.ok(!source.includes("tenantId: res.data.tenantId || getHubAccountStore(store).tenantId || FIREBASE_CONFIG.tenantId || ''"), 'refresh-account fallback labeling removed');
  assert.ok(source.includes("tenantId: session.tenantId || ''"), 'real-tenant-only labeling in place');
});

test('F2/R2: every authenticated Hub surface evicts stale-tenant sessions first', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main/index.js'), 'utf8');
  for (const channel of ['hub:refresh-account', 'hub:updates', 'hub:check-update']) {
    const handlerStart = source.indexOf(`handle('${channel}'`);
    assert.ok(handlerStart > 0, `${channel} handler located`);
    const handlerHead = source.slice(handlerStart, handlerStart + 700);
    const evictAt = handlerHead.indexOf('evictStaleTenantHubSession();');
    const clientAt = handlerHead.indexOf('hubClient({ authenticated: true })');
    assert.ok(evictAt > 0, `${channel}: eviction hook present`);
    assert.ok(clientAt > evictAt, `${channel}: eviction runs BEFORE the authenticated client is built`);
  }

  const authSource = fs.readFileSync(path.join(process.cwd(), 'src/main/firebase-auth.js'), 'utf8');
  assert.ok(authSource.includes("'TENANT_MISMATCH'"), 'TENANT_MISMATCH is a dead-session code');
  assert.ok(
    authSource.includes("if (tenantId && (isStructuredJwt || typeof data.tenant_id === 'string' || jwtClaims.tenant) && responseTenant !== tenantId)"),
    'refresh refuses foreign and root-pool tenants',
  );
});

test('F1/F3: the eviction hook heals legacy Hub URLs and composes the reload-tested Store contract', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main/index.js'), 'utf8');
  const start = source.indexOf('function evictStaleTenantHubSession()');
  assert.ok(start > 0, 'hook located');
  const after = source.slice(start + 10);
  const end = after.search(/\n(?:async )?function /);
  const hook = end > 0 ? after.slice(0, end) : after;

  assert.ok(hook.includes('if (rawCfgUrl && rawCfgUrl !== HUB_API_BASE)'), 'legacy/loopback Hub URLs healed to HUB_API_BASE');
  assert.ok(hook.includes('if (!FIREBASE_CONFIG.tenantId) return false;'), 'unstamped builds exempt');
  assert.ok(!hook.includes('isLoopbackHost'), 'no loopback exemption remains');
  assert.ok(hook.includes('shouldEvictStaleTenantSession({'), 'uses the shared predicate');
  assert.ok(hook.includes('tenantId: FIREBASE_CONFIG.tenantId'), 'build tenant input');
  assert.ok(hook.includes('hasRefreshToken: present'), 'refresh-credential presence input');
  assert.ok(hook.includes('clearHubAccount(store);'), 'atomic credential/account clear');
  assert.ok(hook.includes("store.setHubRefreshCredential({ hubRefreshEnc: '', hubRefreshOrigin: '' });"), 'refresh credential re-clear');
});
