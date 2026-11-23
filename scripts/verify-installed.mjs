// Verify the *installed* FrostByte bundle, not the dev tree.
//
// Playwright's _electron.launch() does not work against a signed, packaged
// .app, so this drives the real bundle the way a user launches it: spawn the
// binary with --remote-debugging-port=0, read the DevTools endpoint off stdout,
// then attach over CDP.
//
// Usage:  node scripts/verify-installed.mjs [--app <path>] [--tier free]
// Exit 0 only when every assertion passes.
//
// Consent note: accepting the real terms raises a native modal (showReview),
// which cannot be driven over CDP by design. This probe therefore seeds
// privacy.json inside a throwaway $FROSTBYTE_HOME profile that is deleted on
// exit. It never touches the user's real profile or consent record.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivacyService } from '../src/main/privacy.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const APP = argOf('--app', '/Applications/FrostByte.app');
const BINARY = path.join(APP, 'Contents', 'MacOS', 'FrostByte');

if (!fs.existsSync(BINARY)) {
  console.error(`FAIL missing installed binary: ${BINARY}`);
  process.exit(1);
}

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  if (!ok) failures.push(name);
};

// realpath matters: on macOS os.tmpdir() lives under /var/folders, which is a
// symlink to /private/var. Electron resolves FROSTBYTE_HOME before deriving
// userData, so an unresolved profile path makes the seeded consent land
// somewhere the app never reads, and every IPC call then waits on a native
// consent modal that never appears.
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-installed-')));

// Seed consent for this throwaway profile only, through the same service the
// app uses, so the on-disk schema cannot drift from what the app expects.
const privacy = new PrivacyService({ directory: profile, version: expectedVersion });
{
  const s = privacy.status();
  privacy.accept({ accepted: true, diagnosticsEnabled: false, termsVersion: s.termsVersion, privacyVersion: s.privacyVersion });
}

const child = spawn(BINARY, ['--remote-debugging-port=0'], {
  cwd: process.cwd(),
  env: { ...process.env, FROSTBYTE_HOME: profile, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Hard ceiling: a blocked native modal must never wedge this probe.
const hardStop = setTimeout(() => {
  console.error('FAIL hard-timeout (90s)');
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(2);
}, 90000);
hardStop.unref();

let buf = '';
const endpointPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no devtools endpoint within 60s')), 60000);
  const onData = (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
});
child.on('exit', (code, sig) => {
  if (code !== 0 && code !== null) console.error(`FAIL app exited early code=${code} sig=${sig}`);
});

try {
  const endpoint = await endpointPromise;
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const deadline = Date.now() + 20000;
  let page;
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('frostbyte://app/'));
    if (!page) await new Promise(r => setTimeout(r, 100));
  }
  if (!page) throw new Error('renderer never opened on frostbyte://app/');

  check('renderer on frostbyte://app/', page.url().startsWith('frostbyte://app/'), page.url());
  await page.locator('#home-hero-title').waitFor({ state: 'visible', timeout: 10000 });

  // Boot-state assertions must run before any navigation.
  const boot = await page.evaluate(() => ({
    activeTab: document.querySelector('#nav .nav.on')?.dataset?.tab || '',
    dashboardVisible: Boolean(document.querySelector('#view-dashboard') && !document.querySelector('#view-dashboard').hidden),
  }));

  // Open FrostNet so the community home is actually mounted for the probe.
  await page.evaluate(() => document.querySelector('#nav [data-tab="discover"]')?.click());
  await page.locator('#view-discover .fn-home').waitFor({ state: 'visible' });

  const ui = await page.evaluate(() => ({
    welcomeVersion: document.querySelector('#welcome-version')?.textContent?.trim() || '',
    welcomeVersionNumber: document.querySelector('#welcome-version-number')?.textContent?.trim() || '',
    updatesVersion: document.querySelector('#updates-version')?.textContent?.trim() || '',
    sidebarVersion: document.querySelector('#ver')?.textContent?.trim() || '',
    aboutProductLine: document.querySelector('#about-product-version-line')?.textContent?.trim() || '',
    privacyNote: document.querySelector('#privacy-product-version-note')?.textContent?.trim() || '',
    bridge: typeof window.frostbyte === 'object' && window.frostbyte !== null,
    entitlementApi: typeof window.frostbyte?.hubEntitlement === 'function',
    hubHealthApi: typeof window.frostbyte?.hubHealth === 'function',
    // P1 (ADR 003): in-app account management surface.
    accountMgmtApi: ['hubUpdateMe', 'hubSetHandle', 'hubReleaseHandle', 'hubPublisherKeys', 'hubBindPublisher', 'hubUnbindPublisher', 'hubCreatorByHandle']
      .every(name => typeof window.frostbyte?.[name] === 'function'),
    hubBrowserAuthApi: typeof window.frostbyte?.hubSignInWithBrowser === 'function',
    legacyDesktopAuthRemoved: typeof window.frostbyte?.hubLogin === 'undefined'
      && typeof window.frostbyte?.hubSetUrl === 'undefined'
      && !document.querySelector('#set-huburl')
      && !document.querySelector('#hub-login-password'),
    tabs: Array.from(document.querySelectorAll('#nav [data-tab]')).map(b => b.dataset.tab),
    activeTab: document.querySelector('#nav .nav.on')?.dataset?.tab || '',
    dashboardVisible: Boolean(document.querySelector('#view-dashboard')),
    steeringPanelsRemoved: !document.querySelector('#bf-suite-heading')
      && !document.querySelector('#bf-rti-title')
      && !document.querySelector('#bf-sidecar-title'),
    accountButton: Boolean(document.querySelector('#btn-account')),
    discoverView: Boolean(document.querySelector('#view-discover')),
    // Regression guard: the Search media grid must mount exactly once.
    // The FrostNet recipe pane (#fn-wrap) is a second .hf-wrap inside the Search
    // view; count only the Hugging Face media grid.
    mediaGrids: document.querySelectorAll('.hf-wrap:not(#fn-wrap)').length,
    // P0 honesty: FrostNet is a coming-soon placeholder, not a second search.
    // textContent includes the icon glyph — strip non-word chars before comparing.
    searchTabLabel: (document.querySelector('#nav [data-tab="hf"]')?.textContent || '').replace(/[^\w ]/g, '').trim(),
    bareModelsNav: [...document.querySelectorAll('#nav .nav')].some(n => (n.textContent || '').replace(/[^\w ]/g, '').trim() === 'Models'),
    frostnetNavDisabled: document.querySelector('#nav [data-tab="discover"]')?.getAttribute('aria-disabled') === 'true',
    frostnetSoonBadge: document.querySelector('#ct-discover')?.textContent?.trim() || '',
    // P2 replaced the coming-soon placeholder with the live community home.
    frostnetHome: Boolean(document.querySelector('#view-discover:not([hidden]) .fn-home .fn-home-main'))
      && Boolean(document.querySelector('#view-discover .fn-home-side')),
    frostnetOpenSearch: Boolean(document.querySelector('#view-discover #hub-coming-search')),
    frostnetSearchUiRemoved: ['#hub-q', '#hub-go', '#grid-hub', '#empty-hub', '#hub-count', '#hub-filters',
      '#hub-detail', '#hub-pagination', '.hub-wrap', '.hub-searchbar'].every(s => !document.querySelector(s)),
    title: document.title,
  }));

  check('preload bridge exposed', ui.bridge);
  check('hubEntitlement IPC exposed', ui.entitlementApi);
  // Presence only: route correctness (/v1/health, anonymous, review-gated) is
  // locked by tests/hub.test.js + the source-contract unit test, not by CDP.
  check('hubHealth IPC exposed', ui.hubHealthApi);
  check('account management IPC exposed (ADR 003)', ui.accountMgmtApi);
  check('hubSignInWithBrowser PKCE IPC exposed', ui.hubBrowserAuthApi);
  check('legacy password/localhost Hub plumbing removed', ui.legacyDesktopAuthRemoved, ui);
  check('dashboard is first nav tab and active on boot', ui.tabs[0] === 'dashboard' && boot.activeTab === 'dashboard', { ...ui, boot });
  check('dashboard view visible on boot with account button', boot.dashboardVisible && ui.accountButton, boot);
  check('steering/sidecar panels removed from dashboard', ui.steeringPanelsRemoved, ui);
  check('discover tab present', ui.tabs.includes('discover'), ui.tabs);
  check('discover view mounted', ui.discoverView);
  check('media grid mounts exactly once', ui.mediaGrids === 1, ui.mediaGrids);
  check('hf nav tab is labelled Search', ui.searchTabLabel === 'Search' && !ui.bareModelsNav, ui);
  check('FrostNet nav marked coming soon', ui.frostnetNavDisabled && ui.frostnetSoonBadge === 'soon', ui);
  check('FrostNet community home shown, duplicate search UI removed', ui.frostnetHome && ui.frostnetOpenSearch && ui.frostnetSearchUiRemoved, ui);

  const terms = await page.evaluate(async () => {
    const s = await window.frostbyte.getPrivacy();
    return s?.data ?? s;
  });
  check('seeded consent recognized', terms?.required === false, {
    required: terms?.required, acceptedAt: terms?.acceptedAt,
  });

  const ent = await page.evaluate(async () => {
    try {
      const r = await Promise.race([
        window.frostbyte.hubEntitlement(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('hubEntitlement timeout 20s')), 20000)),
      ]);
      return r?.data ?? r;
    } catch (e) { return { threw: String(e?.message ?? e) }; }
  });
  console.log('ENT ' + JSON.stringify(ent));
  // An unsubscribed install must resolve to the free/offline tier. Plus/Pro is
  // only ever server-granted, so a fresh profile can never claim more.
  check('entitlement resolves without error', !ent?.threw, ent?.threw);
  check('unsubscribed install is free tier', ent?.tier === 'free', ent?.tier);
  check('unsubscribed install has no grants', Object.keys(ent?.entitlements ?? {}).length === 0);

  // Read the version from the renderer's own bundle rather than app:state.
  // currentState() builds the full catalog, devices, studio and IPFS
  // snapshots; it is a heavy call to make just to read a version, and it
  // exceeds the probe budget on a cold profile.
  const state = await page.evaluate(async () => {
    try {
      const r = await Promise.race([
        window.frostbyte.getState(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getState timeout 20s')), 20000)),
      ]);
      const d = r?.data ?? r;
      return { version: d?.version, edition: d?.edition?.id ?? d?.edition };
    } catch (e) { return { threw: String(e?.message ?? e) }; }
  });
  console.log('INFO ' + JSON.stringify(state));
  check('app reports its version', Boolean(state?.version), state?.version);
  check(`app reports active package version ${expectedVersion}`, state?.version === expectedVersion, state?.version);
  check('app reports community edition', state?.edition === 'community', state?.edition);
  check('welcome version is runtime-derived', ui.welcomeVersion === `VERSION ${expectedVersion}`, ui.welcomeVersion);
  check('welcome title is runtime-derived', ui.welcomeVersionNumber === expectedVersion, ui.welcomeVersionNumber);
  check('sidebar and settings Updates versions match',
    ui.sidebarVersion === expectedVersion && ui.updatesVersion.startsWith(`Installed: ${expectedVersion}`),
    { sidebar: ui.sidebarVersion, updates: ui.updatesVersion });
  check('About and privacy notes use the active runtime version',
    ui.aboutProductLine === `FrostByte ${expectedVersion} · Built for the swarm` &&
      ui.privacyNote.startsWith(`FrostByte ${expectedVersion} does not collect`),
    { about: ui.aboutProductLine, privacy: ui.privacyNote.slice(0, 80) });

  // Appearance credit is per-theme: each contributor theme names its own author, stock themes name nobody.
  const credit = await page.evaluate(async () => {
    document.querySelector('#nav [data-tab="settings"]').click();
    await new Promise(resolve => setTimeout(resolve, 600));
    const select = document.querySelector('#set-theme');
    const text = document.querySelector('#theme-credit');
    if (!select || !text) return { missing: true };
    const read = async theme => {
      select.value = theme;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      // changeAppearance saves over IPC then re-renders; wait for the credit to settle on this theme.
      for (let i = 0; i < 60; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const label = text.textContent.trim();
        const expected = { aeon: '@SpaceTimeViking', u1tra_instinct: '@u1tra_instinct', blackfrost: '@blackfrost_ai' }[theme];
        if (expected ? label.includes(expected) : (text.hidden && label === '')) break;
      }
      return { hidden: text.hidden, label: text.textContent.trim(), url: text.dataset.url || '' };
    };
    const out = {};
    for (const theme of [...select.options].map(option => option.value)) out[theme] = await read(theme);
    return out;
  });
  check('appearance credit element present', !credit.missing, credit.missing);
  if (!credit.missing) {
    check('credit names AEON for aeon', credit.aeon?.label === 'AEON Forge · @SpaceTimeViking' && credit.aeon?.url === 'https://x.com/SpaceTimeViking', credit.aeon);
    check('credit names keys for u1tra_instinct', credit.u1tra_instinct?.label === 'keys 🧪 · @u1tra_instinct' && credit.u1tra_instinct?.url === 'https://x.com/u1tra_instinct', credit.u1tra_instinct);
    check('credit names Blackfrost AI for blackfrost', credit.blackfrost?.label === 'Blackfrost AI · @blackfrost_ai' && credit.blackfrost?.url === 'https://x.com/blackfrost_ai', credit.blackfrost);
    const stock = Object.entries(credit).filter(([theme]) => !['aeon', 'u1tra_instinct', 'blackfrost'].includes(theme));
    check('stock themes credit nobody', stock.every(([, value]) => value.hidden && value.label === ''), stock.map(([theme, value]) => `${theme}:${value.label}`));
    await page.locator('#settings-nav [data-sec="interface"]').click();
    const priorTheme = await page.locator('#set-theme').inputValue();
    await page.locator('#set-theme').selectOption('frost');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'frost');
    const hiddenOnFrost = await page.evaluate(() => document.getElementById('jensen-tribute-card')?.hidden === true);
    await page.locator('#set-theme').selectOption('jensen');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'jensen' && document.getElementById('jensen-tribute-card')?.hidden === false);
    const jensenTributeCheck = await page.evaluate(() => {
      const rights = document.querySelector('#jensen-tribute-card .jensen-rights-notice');
      const rightsOk = !!rights && rights.textContent.includes('Community creation — we do not own these rights.');
      const lockupTag = document.querySelector('#jensen-tribute-card .jensen-lockup-tag')?.textContent.trim();
      const logo = document.querySelector('#jensen-tribute-card .jensen-nvidia-logo');
      const logoOk = !!logo && getComputedStyle(logo).filter.includes('invert(1)');
      const milestones = document.querySelectorAll('#jensen-tribute-card [data-milestone-year]').length;
      const backdrops = new Set();
      for (const tab of ['dashboard', 'discover', 'transfers', 'library', 'catalog', 'hf', 'spark', 'settings']) {
        document.querySelector(`#nav [data-tab="${tab}"]`)?.click();
        backdrops.add(getComputedStyle(document.documentElement).getPropertyValue('--jensen-tab-backdrop').trim());
      }
      document.querySelector('#nav [data-tab="settings"]')?.click();
      document.querySelector('#settings-nav [data-sec="interface"]')?.click();
      return { rightsOk, lockupTag, logoOk, milestones, backdropCount: backdrops.size };
    });
    await page.locator('#set-theme').selectOption(priorTheme);
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, priorTheme);
    check('Founders Leather (jensen) scopes tribute card to jensen and rotates 8 per-tab innovation backdrops',
      hiddenOnFrost && jensenTributeCheck.milestones === 6 && jensenTributeCheck.backdropCount === 8,
      { hiddenOnFrost, ...jensenTributeCheck });
    check('Founders Leather shows NVIDIA lockup and community rights disclaimer',
      jensenTributeCheck.rightsOk && jensenTributeCheck.lockupTag === 'To us, Jensen is NVIDIA' && jensenTributeCheck.logoOk,
      jensenTributeCheck);
  }

  const pfUi = await page.evaluate(() => {
    document.querySelector('#nav [data-tab="hf"]')?.click();
    const bridgeOk = typeof window.frostbyte?.pirateFaceSearch === 'function'
      && typeof window.frostbyte?.pirateFaceTorrents === 'function';
    document.querySelector('#hf-provider-switch [data-hf-provider="pirateface"]')?.click();
    const pfBrowseVisible = document.getElementById('pf-browsebar')?.hidden === false;
    const hfBrowseHidden = document.getElementById('hf-browsebar')?.hidden === true;
    const quickChips = [...document.querySelectorAll('#pf-browsebar [data-pf-quick]')].map(b => b.dataset.pfQuick);
    document.querySelector('#hf-provider-switch [data-hf-provider="hf"]')?.click();
    const restoredHf = document.getElementById('hf-browsebar')?.hidden === false
      && document.getElementById('pf-browsebar')?.hidden === true;
    return { bridgeOk, pfBrowseVisible, hfBrowseHidden, quickChips, restoredHf };
  });
  check('Pirate Face discovery provider wired in Models tab',
    pfUi.bridgeOk && pfUi.pfBrowseVisible && pfUi.hfBrowseHidden && pfUi.quickChips.length >= 4 && pfUi.restoredHf,
    pfUi);

  // Opt-in live Models-tab probe against the real Hugging Face Hub (network). FB_VERIFY_HF=<owner/repo>.
  const hfRepo = process.env.FB_VERIFY_HF;
  if (hfRepo) {
    await page.locator('.nav[data-tab="hf"]').click();
    await page.locator('#hf-q').fill(`https://huggingface.co/${hfRepo}`);
    await page.locator('#hf-go').click();
    let hf = {};
    try {
      await page.locator('#hf-detail h3').filter({ hasText: hfRepo }).waitFor({ timeout: 45000 });
      await page.locator('#hf-options .hf-variant-group').first().waitFor({ timeout: 45000 });
      hf = await page.evaluate(() => ({
        groups: [...document.querySelectorAll('#hf-options .hf-variant-group')].map(g => g.dataset.variantGroup),
        options: document.querySelectorAll('#hf-options .hf-option').length,
        serveButtons: [...document.querySelectorAll('#hf-detail [data-serve-open]')].map(b => b.textContent.trim()),
        tabs: [...document.querySelectorAll('#hf-detail [data-hf-pane]')].map(t => t.dataset.hfPane),
      }));
      await page.locator('#hf-tab-serve').click();
      hf.serve = await page.evaluate(() => ({
        engines: [...document.querySelectorAll('#hf-pane-serve [data-serve-engine]')].map(e => e.dataset.serveEngine),
        status: document.querySelector('#hf-pane-serve [data-serve-status]')?.dataset.serveStatus || 'supported',
        run: document.querySelector('#hf-pane-serve [data-serve-engine="vllm"] pre:nth-of-type(2)')?.textContent || '',
      }));
      await page.locator('#hf-tab-card').click();
      await page.waitForTimeout(4000);
      hf.card = await page.evaluate(() => (document.querySelector('#hf-pane-card')?.textContent || '').trim().length);
      if (process.env.FB_VERIFY_SHOT) await page.screenshot({ path: process.env.FB_VERIFY_SHOT });
    } catch (e) { hf.threw = String(e?.message ?? e); }
    console.log('HF ' + JSON.stringify(hf));
    check('HF link opens model page', !hf.threw, hf.threw);
    check('HF versions grouped by format', (hf.groups || []).length > 0 && hf.options > 0, hf.groups);
    check('HF page has Download/Model card/Serve tabs', JSON.stringify(hf.tabs) === '["download","card","serve"]', hf.tabs);
    check('HF serve recipes rendered', (hf.serve?.engines || []).length > 0 || ['unsupported', 'unknown'].includes(hf.serve?.status), hf.serve);
    if (process.env.FB_VERIFY_HF_EXPECT_SERVE) {
      check('HF vLLM and SGLang buttons offered', JSON.stringify(hf.serveButtons) === '["Serve with vLLM","Serve with SGLang"]', hf.serveButtons);
      check('HF vLLM command names the repo', hf.serve?.run?.includes(`vllm serve ${hfRepo}`), hf.serve?.run?.slice(0, 200));
    }
    check('HF model card rendered locally', hf.card > 200, hf.card);
  }

  await browser.close();
} catch (err) {
  check('probe completed', false, err.message);
  if (buf) console.error('OUTPUT_TAIL ' + buf.slice(-1200));
} finally {
  clearTimeout(hardStop);
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1500));
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  fs.rmSync(profile, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nRESULT FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nRESULT PASS');
