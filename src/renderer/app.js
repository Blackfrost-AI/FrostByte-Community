/* ==========================================================================
   Frost/Byte — renderer
   Talks to main only through window.frostbyte (see src/preload/index.cjs).

   Transfers searches recorded downloads across local and connected devices.
   HuggingFace owns online model search; saved torrent links live in Torrents.
   ========================================================================== */

import { buildHfOptions, selectionSize, groupRepoFilesForBrowser } from './hf-options.js';
import { groupVariants, modelLifecycle } from './hf-variants.js';
import { serveOptions, SERVE_REGISTRY_SOURCES } from '../shared/serve-recipes.js';
import { parseHfReference } from '../shared/hf-reference.js';
import { detectHfFormats, HF_FORMAT_CHIPS } from '../shared/hf-formats.js';
import { renderMarkdown, isHfImageHost } from '../shared/markdown.js';
import { groupHfTransfers } from './transfer-groups.js';
import { matchesDownloadQuery } from './download-search.js';
import { contentKind, contentType } from '../shared/content-kind.js';
import { describeSelectionFootprint } from '../shared/torrent-footprint.js';
import { entryContainsCopy, entryIsHidden, hfGroupInventory } from '../shared/entry-identity.js';
import { deviceArtwork, DEVICE_ARTWORK } from '../shared/device-models.js';
import { DEVICE_PHOTOS } from '../shared/device-photos.js';
import { COMMUNITY_LINKS } from '../shared/community.js';
import { AEON_TOOLS, deviceAeonTools } from '../shared/aeon.js';
import { themeCredit } from '../shared/theme-credits.js';
import { initAssistant } from './assistant.js';
import { originSummary } from '../shared/aeon-origin-status.js';
import { integritySummary } from '../shared/aeon-integrity-status.js';
import { createIpfsUi, ipfsRows, ipfsInventory, isIpfsInput } from './ipfs-ui.js';
import { createFrostnet } from './frostnet.js';
import { bindLibraryTools } from './library-tools.js';
import { bindPublishing } from './publishing-ui.js';
import { bindNetworkDevices } from './network-devices.js';
import { DeviceHistory, transferSummary, dashboardHtml } from './device-dashboard.js';
import { accountInitials, formatTierBadge, userDashboardHtml } from './user-dashboard.js';
import { validateHandle, validateBio, validateDisplayName } from '../shared/identity-rules.js';
import { sameEntryCopy } from '../shared/entry-identity.js';
import { normalizeTheme } from '../shared/appearance.js';
import { renderJensenTributeCard } from './jensen-tribute.js';

const api = window.frostbyte;
let libraryTools;
let publishingUi;
let frostnetUi;

/* ------------------------------- formatting ------------------------------ */

function fmtBytes(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / 1024 ** i;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
function fmtSpeed(b) { return b > 0 ? `${fmtBytes(b)}/s` : '—'; }
function fmtEta(ms) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function fmtPct(p) { return `${Math.floor((p || 0) * 100)}%`; }
const finiteNumber = (value, fallback = 0) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bigPullBytes() {
  const st = state.settings ?? {};
  if (!st.confirmBigPull) return Infinity; // confirmations off: never ask
  const gb = Number(st.bigPullGB);
  return gb > 0 ? gb * 1024 ** 3 : Infinity;
}

const LICENSE_CLASS = (lic) => {
  const l = String(lic || '').toLowerCase();
  if (l.includes('apache') || l.includes('mit') || l.includes('bsd')) return 'permissive';
  if (l.includes('unclear') || !l) return '';
  return 'restrict';
};
const LICENSE_NOTE = (lic) => {
  const l = String(lic || '').toLowerCase();
  if (!l || l === 'unclear') return 'License unknown — check before you redistribute this to anyone.';
  if (LICENSE_CLASS(lic) === 'permissive') return 'Permissive license — generally fine to re-share. Keep the license text with it.';
  if (l.includes('llama')) return 'Meta community license: redistribution allowed with duties — display "Built with Llama", pass on the use policy.';
  if (l.includes('gemma')) return 'Gemma terms: use restrictions must pass downstream to whoever you share it with.';
  if (l.includes('check')) return 'The publisher did not state a license. Check the model card before re-sharing.';
  return 'This license has terms attached — read them before you redistribute.';
};

/* --------------------------------- state --------------------------------- */

// Product identity fallback for the short window before the first IPC state
// snapshot arrives. app.getVersion() is authoritative once state is available.
const PACKAGE_VERSION = '2.0.0';
let state = {
  version: PACKAGE_VERSION,
  torrents: [], catalog: [], library: [], inventory: [], settings: {},
  platform: 'darwin', stats: { dhtNodes: 0, port: null },
  downloads: [], hfToken: { present: false, needsReconnect: false, user: '', role: '' },
  publisher: { present: false, unlocked: false, pubKey: '', username: '', fingerprint: '' },
  edition: { id: 'community', name: 'Community Edition' },
};
let ipfsUi;
const ui = {
  tab: 'dashboard', transferQuery: '', libraryDevice: 'all', torrentsDevice: 'all', transferDevice: 'all',
  selId: null,        // saved-link details
};
let forcedBootTab = null;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const localDeviceLabel = () => state.platform === 'darwin' ? 'This Mac' : state.platform === 'win32' ? 'This PC' : 'This computer';

const store = {
  get(k, d) { try { const v = localStorage.getItem('fb:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fb:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/* --------------------------------- boot ---------------------------------- */

(async function boot() {
  applyDensity(store.get('density', 'cozy'));
  initAssistant();
  applyListView(store.get('listView', 'cards'), { render: false });
  // Restore appearance before a notice is shown; never bypass consent.
  applyTheme(store.get('theme', 'frost'), { persist: false });

  // Populate version-bearing UI before the consent dialog so first-run users
  // always see the packaged product version, even without a state snapshot.
  renderProductVersion(PACKAGE_VERSION);
  await ensureConsent();
  const res = await api.getState();
  if (res.ok) applyState(res.data, { render: false });

  // The packaged browser chrome (window/tab title) must match the edition the
  // binary was built for. main refuses any other value, so this only covers
  // renderer-owned chrome not exposed as state (e.g. devtools pages).
  document.title = state.edition?.displayName ?? 'Frost/Byte';
  document.body.dataset.platform = state.platform;
  document.body.dataset.edition = state.edition?.id ?? 'community';
  $('#omni-shortcut').textContent = state.platform === 'darwin' ? '⌘F' : 'Ctrl+F';
  applyTheme(store.get('theme', null) ?? state.settings?.theme ?? 'frost');

  ipfsUi = createIpfsUi({ api, getState: () => state, openModal, refresh, controlsChanged: () => renderTransfers(), toast, fmtBytes, fmtSpeed, goTransfers: () => { closeModal(); ui.transferDevice = 'all'; goTab('transfers'); } });
  frostnetUi = createFrostnet({ api, getState: () => state, esc, toast, fmtBytes, askModal, goTab });
  bindNav();
  bindDashboardView();
  bindOmni();
  bindTransfersView();
  bindLibraryView();
  bindSheetHeads();
  bindCatalogView();
  bindHfView();
  bindSparkView();
  bindSettingsView();
  bindNetworkDevices({ api: api.networkDevices, toast,
    goNetwork: () => { goTab('settings'); $('#settings-nav [data-sec="network"]').click(); },
    setup: async address => {
      await cancelSparkSetup({ keepOpen: true });
      Object.assign(sparkSetup, { mode: 'password', host: address, username: '', port: '22' });
      renderSparkSetup(); goTab('spark'); renderSpark(); $('#spark-setup-host')?.focus();
    },
  });
  bindPrivacy();
  bindDrawer();
  bindGlobalKeys();
  bindEvents();
  bindDrop();

  renderAll();
  const isReloadInSession = (() => {
    try {
      const seen = sessionStorage.getItem('fb:bootedSession') === '1';
      sessionStorage.setItem('fb:bootedSession', '1');
      return seen;
    } catch { return false; }
  })();
  goTab(forcedBootTab || (isReloadInSession ? store.get('lastTab', 'dashboard') : 'dashboard'));
  setInterval(pollState, 1500);
})();

function applyState(next, { render = true } = {}) {
  state = { ...state, ...next };
  syncSelectedDevice();
  if (render) {
    refreshLive();
    if (ui.tab === 'settings') renderPublisherSettings();
    if (ui.tab === 'hf') {
      renderPfDhtBanner();
      renderHfLifecycle();
    }
  }
  if (render && ui.tab === 'spark') renderSpark();
}

async function refresh() {
  const res = await api.getState();
  if (res.ok) applyState(res.data);
}

async function pollState() {
  const res = await api.getState();
  if (res.ok) applyState(res.data);
}

/* -------------------------------- themes --------------------------------- */

function applyTheme(theme, { persist = true } = {}) {
  const t = normalizeTheme(theme);
  document.documentElement.dataset.theme = t;
  if (persist) store.set('theme', t);
  // AEON Orb mark only in the aeon theme (see docs/AEON-THEME.md).
  const frost = document.querySelector('.brand-frost');
  const orb = document.querySelector('.brand-orb');
  const keys = document.querySelector('.brand-keys');
  const crystal = document.querySelector('.brand-blackfrost');
  const jensen = document.querySelector('.brand-jensen');
  const jensenTag = document.querySelector('.brand-jensen-tag');
  if (frost) frost.hidden = t === 'aeon' || t === 'u1tra_instinct' || t === 'blackfrost' || t === 'jensen';
  if (orb) orb.hidden = t !== 'aeon';
  if (keys) keys.hidden = t !== 'u1tra_instinct';
  if (crystal) crystal.toggleAttribute('hidden', t !== 'blackfrost');
  if (jensen) jensen.toggleAttribute('hidden', t !== 'jensen');
  if (jensenTag) jensenTag.hidden = t !== 'jensen';
  const tributeCard = $('#jensen-tribute-card');
  if (tributeCard) {
    const showTribute = t === 'jensen';
    tributeCard.hidden = !showTribute;
    if (showTribute) renderJensenTributeCard(tributeCard, { onSelectTab: nextTab => goTab(nextTab) });
  }
  renderThemeCredit(t);
}
// The credit names the theme's own contributor (or nothing for the stock themes).
function renderThemeCredit(theme) {
  const text = $('#theme-credit');
  if (!text) return;
  const credit = themeCredit(theme);
  text.hidden = !credit;
  text.textContent = credit ? `${credit.name} · ${credit.handle}` : '';
  text.dataset.url = credit ? credit.url : '';
  text.setAttribute('aria-label', credit ? `${credit.name} on X, opens in your browser` : '');
}
function applyDensity(d) {
  const v = ['comfortable', 'cozy', 'compact', 'ultra'].includes(d) ? d : 'cozy';
  if (v === 'cozy') delete document.documentElement.dataset.density;
  else document.documentElement.dataset.density = v;
  store.set('density', v);
  $$('.dens').forEach((b) => b.classList.toggle('on', b.dataset.d === v));
}

/* Sheet view — a one-line, dense list alternative to the transfer/inventory cards.
   Pure renderer state: markup is mode-agnostic (CSS flips layout via .lab/.ico spans
   and html[data-listview="sheet"]), so the cached renderers never strand a mode. */
const sheetSort = { key: '', dir: 1 };   // Transfers-only column sort; session-scoped by design.
function isSheet() { return document.documentElement.dataset.listview === 'sheet'; }
function applyListView(v, { render = true } = {}) {
  const value = v === 'sheet' ? 'sheet' : 'cards';
  if (value === 'sheet') document.documentElement.dataset.listview = 'sheet';
  else delete document.documentElement.dataset.listview;
  store.set('listView', value);
  $$('.lv').forEach((b) => { const on = b.dataset.lv === value; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  $$('[data-lv-switch]').forEach((b) => {
    b.textContent = value === 'sheet' ? '▤ Cards' : '☰ Sheet';
    b.setAttribute('aria-pressed', String(value === 'sheet'));
    b.title = value === 'sheet' ? 'Switch back to card view' : 'One-line sheet view — dense rows with sortable columns';
  });
  if (render) { renderTransfers(); renderLibrary(); renderTorrents(); }
  else {
    // Boot pass: markup renders later; just make sure no sheet header leaks in cards mode.
    for (const id of ['transfers-sheet-head', 'transfer-inventory-sheet-head', 'library-sheet-head', 'torrents-sheet-head']) $('#' + id).hidden = !isSheet();
  }
}
function sheetDevice(row) { return row.device === 'spark' ? remoteName(row.deviceId) : localDeviceLabel(); }
// Same precedence as the card's eta line, condensed to one word for the status column.
function torrentStatusWord(t) {
  return t.offline ? 'offline' : t.error ? 'error' : t.paused ? (t.queued ? 'queued' : 'paused')
    : t.done ? (t.partial ? 'complete' : 'seeding') : t.waitingForPeers ? 'waiting'
    : !t.ready ? 'metadata' : 'downloading';
}
function sortForSheet(rows, accessors) {
  if (!isSheet() || !sheetSort.key || !accessors[sheetSort.key]) return rows;
  const get = accessors[sheetSort.key], dir = sheetSort.dir;
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    const cmp = typeof x === 'string' || typeof y === 'string'
      ? String(x).localeCompare(String(y), undefined, { numeric: true })
      : (Number(x) || 0) - (Number(y) || 0);
    return cmp * dir || String(a.name || a.repoId || '').localeCompare(String(b.name || b.repoId || ''), undefined, { numeric: true });
  });
}
function syncSheetHead(head) {
  if (!head) return;
  head.querySelectorAll('[data-sort-key]').forEach((b) => {
    const active = b.dataset.sortKey === sheetSort.key;
    b.setAttribute('aria-pressed', String(active));
    const arrow = b.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (sheetSort.dir > 0 ? '▲' : '▼') : '';
  });
}

/* -------------------------------- rendering ------------------------------ */

function renderProductVersion(version) {
  const activeVersion = String(version || PACKAGE_VERSION).trim();
  const ver = $('#ver'); if (ver) ver.textContent = activeVersion;
  const welcomeVersionNumber = $('#welcome-version-number');
  if (welcomeVersionNumber) welcomeVersionNumber.textContent = activeVersion;
  const welcomeVersion = $('#welcome-version');
  if (welcomeVersion) welcomeVersion.textContent = `VERSION ${activeVersion}`;
  const aboutProductLine = $('#about-product-version-line');
  if (aboutProductLine) aboutProductLine.textContent = `FrostByte ${activeVersion} · Built for the swarm`;
  const privacyNote = $('#privacy-product-version-note');
  if (privacyNote) {
    privacyNote.textContent = `FrostByte ${activeVersion} does not collect analytics, diagnostics, or automatic feedback. There is no reporting switch to enable. Your library, settings, and device history stay on your devices.`;
  }
}

function renderAll() {
  renderAccountChrome();
  renderDashboard();
  renderTransfers();
  renderLibrary();
  renderTorrents();
  renderCatalog();
  renderSettings();
  refreshLive();
}

function findModel(id) { return (state.catalog ?? []).find((m) => m.id === id); }
function findTorrent(hash) { return (state.torrents ?? []).find((t) => t.infoHash === hash); }

function refreshLive() {
  const torrents = state.torrents ?? [];
  const totalDown = transferTorrents().reduce((a, t) => a + (!t.offline && !t.paused ? t.downloadSpeed || 0 : 0), 0)
    + hfTransfers().reduce((a, d) => a + (!d.offline && d.status === 'active' ? d.speedBps || 0 : 0), 0)
    + ipfsRows(state).reduce((a, d) => a + (!d.offline && d.status === 'active' ? d.speedBps || 0 : 0), 0);
  const peers = torrents.reduce((a, t) => a + (t.numPeers || 0), 0);
  const sharing = torrents.filter((t) => t.seeding).length;
  const upBytes = torrents.reduce((a, t) => a + (t.uploaded || 0), 0);
  const downBytes = torrents.reduce((a, t) => a + (t.downloaded || 0), 0);

  $('#stat-torrents').textContent = torrents.length;
  const ipfsUpload = (state.ipfs?.stats?.uploadSpeed || 0) + remoteDevices().reduce((n, device) => n + (device.connected ? device.status?.ipfs?.stats?.uploadSpeed || 0 : 0), 0);
  $('#stat-up').textContent = fmtSpeed(transferTorrents().reduce((a, t) => a + (!t.offline && !t.paused ? t.uploadSpeed || 0 : 0), 0) + ipfsUpload);
  $('#stat-down').textContent = fmtSpeed(totalDown);

  $('#box-sharing').textContent = `${sharing} item${sharing === 1 ? '' : 's'}`;
  $('#box-up').textContent = fmtBytes(upBytes);
  $('#box-down').textContent = fmtBytes(downBytes);
  $('#box-peers').textContent = peers;

  $('#sb-peers').textContent = `${peers} peer${peers === 1 ? '' : 's'}`;
  $('#sb-sharing').textContent = `${sharing} item${sharing === 1 ? '' : 's'}`;
  $('#sb-up').textContent = fmtBytes(upBytes);
  $('#sb-down').textContent = fmtBytes(downBytes);
  $('#sb-dir').textContent = state.settings?.downloadDir ?? '—';
  $('#sb-dir').title = state.settings?.downloadDir ?? '';

  // Live network facts. A dead DHT reads as a warning, not a crash.
  const dht = state.stats?.dhtNodes ?? 0;
  const sbDht = $('#sb-dht');
  if (sbDht) {
    sbDht.textContent = `${dht} node${dht === 1 ? '' : 's'}`;
    sbDht.style.color = dht > 0 ? 'var(--lime)' : 'var(--warn)';
  }
  const sbPort = $('#sb-port');
  if (sbPort) {
    sbPort.textContent = state.stats?.port ? `${state.stats.port} open` : 'closed';
    sbPort.style.color = state.stats?.port ? 'var(--lime)' : 'var(--warn)';
  }

  $('#ct-transfers').textContent = transferTorrents().length + groupHfTransfers(hfTransfers()).length + ipfsRows(state).filter(row => !row.cleared && !row.removed).length;
  $('#stat-torrents').textContent = $('#ct-transfers').textContent;
  updateLibraryCount();
  renderProductVersion(state.version || PACKAGE_VERSION);

  updateTurtle();
  updateConnectionFacts();

  // Only rebuild lists when something material changed — re-rendering on
  // every poll destroys hover states and text selection mid-interaction.
  if (signatureChanged()) {
    renderAccountChrome();
    if (ui.tab === 'dashboard') renderDashboard();
    if (ui.tab === 'transfers') renderTransfers();
    if (ui.tab === 'library') renderLibrary();
    if (ui.tab === 'catalog') { renderTorrents(); renderCatalog(); }
    if (ui.selId && !$('#drawer').hidden) renderDrawer();
  }
}

let _lastSig = '';
function signatureChanged() {
  const sig = JSON.stringify([
    (state.torrents ?? []).map((t) => [
      t.infoHash, t.done, t.paused, t.queued, t.numPeers, t.ready, t.waitingForPeers,
      Math.round((t.progress ?? 0) * 1000),
      Math.round((t.downloadSpeed ?? 0) / 1024),
      Math.round((t.uploadSpeed ?? 0) / 1024),
      Math.round(t.ratio * 100),
    ]),
    state.catalog, state.library, state.inventory, state.modelLibrary, state.sparkInventory, state.itemKinds, state.devices,
    state.hiddenItems, state.savedShareLinks,
    (state.ipfs?.downloads || []).map(row => [row.id, row.status, row.cleared, row.removed, row.sharing, row.available, row.error, row.downloaded, row.speedBps]),
    (state.downloads ?? []).map(d => [d.id, d.status, d.downloaded, d.speedBps, d.error]),
    sparkUi.transfers, sparkUi.connected, sparkUi.error, state.settings.sparkHost,
    state.hubAccount, state.hubEntitlement, state.hubConfig, state.hfToken,
  ]);
  if (sig === _lastSig) return false;
  _lastSig = sig;
  return true;
}

function updateTurtle() {
  const el = $('#turtle');
  if (!el) return;
  const on = !!state.rates?.alt;
  const mode = state.rates?.mode || (on ? 'alt' : 'normal');
  const cap = value => value > 0 ? `${Math.round(value / 1024)} KB/s` : 'Unlimited';
  const down = cap(state.rates?.down), up = cap(state.rates?.up);
  el.classList.toggle('on', on);
  el.textContent = `${on ? '🐢 ALT on' : down === 'Unlimited' && up === 'Unlimited' ? '∞ Unlimited' : '↕ Normal'}${mode === 'schedule' ? ' · Scheduled' : ''}`;
  el.setAttribute('aria-pressed', String(on));
  el.title = `This computer · ${mode} mode · Download: ${down} · Upload: ${up}. ${on ? 'Click to keep Normal limits on, including after restart.' : 'Click to review ALT limits.'}`;
  const effective = $('#effective-limits');
  if (effective) effective.textContent = `${mode === 'schedule' ? 'Scheduled · ' : ''}${on ? 'ALT active' : 'Normal active'} — ↓ ${down} · ↑ ${up}`;
  const altState = $('#alt-state'); if (altState) altState.hidden = !on;
  const capacity = $('#sharing-capacity');
  if (capacity && state.sharingCapacity) capacity.textContent = `File handles: ${state.sharingCapacity.inUse.toLocaleString()} / ${state.sharingCapacity.limit.toLocaleString()} in use. Capacity scales to your operating system; folders may use several handles. This is separate from bandwidth and item count.`;
}

function updateConnectionFacts() {
  const port = $('#con-port');
  if (port) port.textContent = state.stats?.port ? String(state.stats.port) : 'not listening';
  const up = $('#con-upnp');
  if (up) up.textContent = state.stats?.upnpCleanupPending
    ? `cleanup pending (${state.stats.upnpCleanupPending})`
    : state.stats?.upnpMapped ? `mapped (${state.stats.upnpMapped})` : 'not mapped';
}

// Preview harness + automation hooks (harmless in the real app).
window.__fbSelect = (id) => { goTab('catalog'); $('#saved-links').open = true; selectModel(id); };
window.__fbGoTab = (t) => { forcedBootTab = t; goTab(t); };
window.__fbHfSearch = (q) => { $('#hf-q').value = q; return hfDoSearch(); };
window.__fbHfSelect = (id) => hfSelect(id);

function selectModel(id) {
  ui.selId = id;
  $$('#grid-catalog tbody tr').forEach((tr) => tr.classList.toggle('selrow', tr.dataset.id === id));
  renderDrawer();
}

async function requestPull(model) {
  const source = model.magnet || model.infohash || model.torrent;
  if (!source) return;
  if ((model.sizeBytes || 0) >= bigPullBytes()) {
    const confirmed = await askLargeDownload(`Pull ${model.name}?`,
      `${fmtBytes(model.sizeBytes)} · ${state.settings?.downloadDir ?? 'Your download folder'}`, `Pull ${fmtBytes(model.sizeBytes)}`);
    if (!confirmed) return;
  }
  doPull(model);
}

async function doPull(model) {
  const live = findTorrent(model.infohash);
  if (live) {
    if (live.paused) { const r = await api.resume(live.infoHash); if (r.ok) applyState(r.data); else toast(r.error, 'error'); }
    closeDrawer(); clearDownloadSearch(); goTab('transfers'); return;
  }
  const source = model.magnet || model.infohash || model.torrent;
  toast(`Pulling ${model.name}…`);
  const res = await api.add(source);
  if (res.ok) {
    toast(`Started ${res.data.torrent.name}. ${res.data.torrent.numPeers} peer(s) so far.`);
    applyState(res.data.state);
    closeDrawer(); clearDownloadSearch();
    goTab('transfers');
  } else {
    toast(res.error, 'error');
  }
}

/* ============================ DRAWER (details) ============================ */

function renderDrawer() {
  const m = findModel(ui.selId);
  if (!m) return closeDrawer();
  const drawer = $('#drawer');
  const live = findTorrent(m.infohash);
  const hasSource = !!(m.magnet || m.infohash || m.torrent);

  drawer.innerHTML = `
    <div class="drawer-head">
      <div class="dt"><span>Details</span><button class="x" data-close title="Close (Esc)">✕</button></div>
      <h3>${esc(m.name)}</h3>
      <div class="dsub">${esc([m.params, m.quant, m.format].filter(Boolean).join(' · ') || '—')}</div>
    </div>
    <div class="drawer-body">
      ${live ? `
      <div class="dcard">
        <h4>In this client</h4>
        <div class="kv"><span class="k">State</span><span class="v ${live.seeding ? 'ok' : ''}">${live.seeding ? 'sharing' : live.paused ? 'paused' : live.done ? 'complete' : 'downloading'}</span></div>
        <div class="kv"><span class="k">Progress</span><span class="v">${fmtPct(live.progress)} of ${fmtBytes(live.length)}</span></div>
        <div class="kv"><span class="k">Speed</span><span class="v">↓ ${fmtSpeed(live.downloadSpeed)} · ↑ ${fmtSpeed(live.uploadSpeed)}</span></div>
        <div class="kv"><span class="k">Peers</span><span class="v">${live.numPeers}</span></div>
        <div class="kv"><span class="k">Ratio</span><span class="v">${(live.ratio || 0).toFixed(2)}</span></div>
      </div>` : ''}

      <div class="dcard">
        <h4>Model</h4>
        <div class="kv"><span class="k">Publisher</span><span class="v">${esc(m.publisher || '—')}</span></div>
        <div class="kv"><span class="k">Params</span><span class="v">${esc(m.params || '—')}</span></div>
        <div class="kv"><span class="k">Quant</span><span class="v">${esc(m.quant || '—')}</span></div>
        <div class="kv"><span class="k">Format</span><span class="v">${esc(m.format || '—')}</span></div>
        <div class="kv"><span class="k">Size</span><span class="v">${m.sizeBytes ? fmtBytes(m.sizeBytes) : 'unknown'}</span></div>
        <div class="kv"><span class="k">Tags</span><span class="v">${esc((m.tags ?? []).join(', ') || '—')}</span></div>
        ${m.notes ? `<div class="licnote">${esc(m.notes)}</div>` : ''}
      </div>

      <div class="dcard">
        <h4>License</h4>
        <div class="kv"><span class="k">Declared</span><span class="v ${LICENSE_CLASS(m.license) === 'permissive' ? 'ok' : LICENSE_CLASS(m.license) ? 'warn' : ''}">${esc(m.license || 'unclear')}</span></div>
        <div class="licnote ${LICENSE_CLASS(m.license) === 'permissive' ? '' : 'warn'}">${esc(LICENSE_NOTE(m.license))}</div>
      </div>

      <div class="dcard">
        <h4>On the wire</h4>
        <div class="kv"><span class="k">Infohash</span><span class="v" title="${esc(m.infohash || '')}">${esc(String(m.infohash || '—').slice(0, 18))}${m.infohash ? '…' : ''}</span></div>
        <div class="kv"><span class="k">Source</span><span class="v">${esc(m.source || 'local')}</span></div>
        <div class="kv"><span class="k">In swarm</span><span class="v">${m.inClient ? 'yes' : (m.numPeers ? `~${m.numPeers} peers` : 'unknown')}</span></div>
        ${hasSource ? `<div class="field" style="margin-top:9px"><textarea readonly style="width:100%;background:var(--abyss);border:1px solid var(--border);border-radius:4px;font-family:var(--mono);font-size:10px;padding:7px;color:var(--text-dim);min-height:56px" id="drawerMagnet">${esc(m.magnet || m.infohash || m.torrent)}</textarea></div>` : '<div class="licnote warn">No magnet link on this entry yet.</div>'}
      </div>
    </div>
    <div class="drawer-acts">
      ${m.seeding
        ? `<button class="btn" data-unseed>◼ Stop sharing</button>`
        : hasSource ? `<button class="btn primary" data-pull>⇅ ${live && !live.seeding && live.progress < 1 ? 'Continue' : 'Pull'}</button>` : ''}
      ${hasSource ? `<button class="btn" data-copy>⧉ Copy link</button>` : ''}
      <button class="btn" data-edit>✎ Edit</button>
      <span style="flex:1"></span>
      ${m.source === 'local' || m.source === 'user' ? `<button class="btn" data-del>Remove</button>` : ''}
    </div>`;

  drawer.hidden = false;
  drawer.querySelector('[data-close]').addEventListener('click', closeDrawer);
  drawer.querySelector('[data-pull]')?.addEventListener('click', () => { closeDrawer(); requestPull(m); });
  drawer.querySelector('[data-copy]')?.addEventListener('click', () => {
    copyLink(m.magnet || m.infohash || m.torrent || '');
  });
  drawer.querySelector('[data-edit]')?.addEventListener('click', () => openCatalogEntryDialog(m));
  drawer.querySelector('[data-del]')?.addEventListener('click', async () => {
    const r = await api.removeCatalogEntry(m.id);
    if (r.ok) { applyState(r.data); closeDrawer(); toast('Removed from your catalog.'); }
    else toast(r.error || 'Could not remove this saved entry.', 'error');
  });
  drawer.querySelector('[data-unseed]')?.addEventListener('click', async () => {
    const r = await api.unseed(m.infohash);
    if (r.ok) { applyState(r.data); closeDrawer(); toast(`Stopped sharing ${m.name}.`); }
  });
}

function closeDrawer() {
  ui.selId = null;
  const d = $('#drawer');
  d.hidden = true;
  d.innerHTML = '';
  $$('.selrow').forEach((tr) => tr.classList.remove('selrow'));
}

function bindDrawer() {
  document.addEventListener('click', (e) => {
    const d = $('#drawer');
    if (d.hidden) return;
    if (!d.contains(e.target) && !e.target.closest('tr[data-id]') && !e.target.closest('.ctxmenu') && !e.target.closest('.modal')) {
      closeDrawer();
    }
  });
}

/* ============================= CONTEXT MENU ============================== */

function openCtxMenu(x, y, m) {
  if (!m) return;
  const menu = $('#ctxmenu');
  const hasSource = !!(m.magnet || m.infohash || m.torrent);
  menu.innerHTML = `
    <div class="lbl">${esc(m.name.slice(0, 28))}${m.name.length > 28 ? '…' : ''}</div>
    ${m.seeding
      ? '<button data-c="unseed">◼ Stop sharing</button>'
      : hasSource ? '<button data-c="pull">⇅ Pull</button>' : ''}
    ${hasSource ? '<button data-c="copy">⧉ Copy magnet link</button>' : ''}
    <button data-c="details">☰ Details</button>
    <div class="sep"></div>
    <button data-c="edit">✎ Edit entry</button>
    ${m.source === 'local' || m.source === 'user' ? '<button data-c="del" class="danger">✕ Remove from catalog</button>' : ''}
  `;
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  menu.onclick = async (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    closeCtxMenu();
    const c = b.dataset.c;
    if (c === 'pull') requestPull(m);
    if (c === 'copy') await copyLink(m.magnet || m.infohash || m.torrent || '');
    if (c === 'details') { goTab('catalog'); selectModel(m.id); }
    if (c === 'edit') openCatalogEntryDialog(m);
    if (c === 'del') { const r2 = await api.removeCatalogEntry(m.id); if (r2.ok) { applyState(r2.data); toast('Removed.'); } else toast(r2.error || 'Could not remove this saved entry.', 'error'); }
    if (c === 'unseed') { const r2 = await api.unseed(m.infohash); if (r2.ok) { applyState(r2.data); toast(`Stopped sharing ${m.name}.`); } }
  };
}
function closeCtxMenu() { $('#ctxmenu').hidden = true; }
document.addEventListener('click', (e) => { if (!e.target.closest('.ctxmenu')) closeCtxMenu(); });
document.addEventListener('scroll', closeCtxMenu, true);

/* ============================== TRANSFERS ================================ */

const transferBusy = new Set();
function remoteDevices() {
  if (Array.isArray(state.devices)) return state.devices;
  if (!state.settings.sparkHost) return [];
  return [{ id: 'spark', host: state.settings.sparkHost, name: 'DGX Spark', connected: sparkUi.connected, error: sparkUi.error,
    status: { ...(state.sparkInventory?.host === state.settings.sparkHost ? state.sparkInventory : {}), ...(sparkUi.host === state.settings.sparkHost ? sparkUi.status : {}), ...(sparkUi.transfers?.host === state.settings.sparkHost ? sparkUi.transfers : {}) } }];
}
const selectedDeviceId = () => state.selectedDeviceId || (state.settings.sparkHost ? 'spark' : '');
const deviceById = id => remoteDevices().find(device => device.id === (id || selectedDeviceId()));
const remoteName = id => deviceById(id)?.label || deviceById(id)?.name || 'Remote device';
const deviceOnline = id => deviceById(id)?.connected === true;
const matchesDevice = (filter, row) => filter === 'all' || filter === row.device || filter === 'device:' + row.deviceId;
function deviceFilterOptions(select) {
  if (!select) return;
  const value = select.value;
  const html = `<option value="all">All devices</option><option value="local">${esc(localDeviceLabel())}</option><option value="spark">All remote devices</option>${remoteDevices().map(device => `<option value="device:${esc(device.id)}">${esc(device.label || device.name)}</option>`).join('')}`;
  if (select._devicesHtml !== html) { select.innerHTML = html; select._devicesHtml = html; select.value = value; }
}
function downloadDeviceOptions() {
  return `<option value="mac">${esc(localDeviceLabel())}</option>` + (remoteDevices().length ? remoteDevices().map(device => `<option value="${esc(device.id)}" ${device.connected ? '' : 'disabled'}>${esc(device.label || device.name)}${device.connected ? '' : ' · offline'}</option>`).join('') : '<option value="spark" disabled>Connect a device in Devices</option>');
}
function remoteRows(key) {
  return remoteDevices().flatMap(device => (Array.isArray(device.status?.[key]) ? device.status[key] : []).map(row => ({ ...row, device: 'spark', deviceId: device.id, deviceName: device.name, sparkHost: device.host, offline: !device.connected })));
}
function remoteTransfers() { return { host: state.settings.sparkHost, ...deviceById()?.status }; }
function transferTorrents() {
  return [...(state.torrents || []).map(t => ({ ...t, device: 'local' })), ...remoteRows('torrents').filter(t => !t.hfSource)];
}
function hfTransfers() {
  return [...(state.downloads || []).map(d => ({ ...d, device: 'local' })), ...remoteRows('downloads')].filter(d => d.status !== 'cancelled' && !d.removed);
}
const matchesTransferSearch = row => matchesDownloadQuery(row, ui.transferQuery, row.device === 'spark' ? remoteName(row.deviceId) : localDeviceLabel());
const visibleTransfer = row => matchesDevice(ui.transferDevice, row) && matchesTransferSearch(row);
// Filter after grouping, so a matching shard retains the full model's progress
// and Pause/Resume scope instead of silently dropping its other files.
const visibleHfGroups = () => groupHfTransfers(hfTransfers().filter(row => matchesDevice(ui.transferDevice, row))).filter(matchesTransferSearch);
const transferKey = (row, kind) => `${row.device}:${row.deviceId || row.sparkHost || ''}:${kind}:${row.id || row.infoHash}`;
function transferDestination(row, source) {
  const destination = row.dest || row.destination || row.path || row.baseDir || (row.device === 'spark' ? deviceById(row.deviceId)?.status?.downloadDir : state.settings.downloadDir) || '';
  return `<div class="transfer-destination"><span class="chip">${esc(row.device === 'spark' ? remoteName(row.deviceId) : localDeviceLabel())}</span><span>${source}</span><span class="mono" title="${esc(destination)}">${esc(destination)}</span></div>`;
}
async function controlTransfer(row, kind, action, options) {
  const key = transferKey(row, kind);
  if (transferBusy.has(key)) return;
  if (row.device === 'spark' && !deviceOnline(row.deviceId)) { toast('Reconnect to this device before changing its transfers.', 'warn'); return; }
  transferBusy.add(key); renderTransfers();
  try {
    const localActions = kind === 'hf' ? { pause: api.hfPause, resume: api.hfResume, cancel: api.hfCancel } : { pause: api.pause, resume: api.resume };
    const result = row.device === 'spark' ? await api.sparkControl(`${kind}:${action}`, row.id || row.infoHash, undefined, row.deviceId, options) : await localActions[action](row.id || row.infoHash);
    if (result.ok && result.data?.cancelled) return result;
    if (!result.ok) toast(result.error || 'Could not change this transfer.', 'error');
    if (row.device === 'spark') await refreshSpark(true); else await refresh();
    return result;
  } catch (error) { toast(error.message || 'Could not change this transfer.', 'error'); return { ok: false }; }
  finally { transferBusy.delete(key); renderTransfers(); }
}

function renderTransfers() {
  const opened = new Set($$('#transfers .tor.open').map(el => `${el.dataset.device}:${el.dataset.connection || ''}:${el.dataset.hash}`));
  const openedTorrentOptions = new Set($$('#transfers .tor .transfer-options[open]').map(el => {
    const card = el.closest('.tor');
    return `${card.dataset.device}:${card.dataset.connection || ''}:${card.dataset.hash}`;
  }));
  const expandedModels = new Set($$('#transfers .hfdl .hf-model-files[open]').map(el => el.closest('.hfdl').dataset.id));
  const openedModelOptions = new Set($$('#transfers .hfdl .transfer-options[open]').map(el => el.closest('.hfdl').dataset.id));
  let torrents = transferTorrents().filter(visibleTransfer).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;   // active first
    return (finiteNumber(b.downloadSpeed) + finiteNumber(b.uploadSpeed)) - (finiteNumber(a.downloadSpeed) + finiteNumber(a.uploadSpeed));
  });
  torrents = sortForSheet(torrents, { name: t => t.name || '', device: sheetDevice, size: t => t.length, progress: t => t.progress, status: torrentStatusWord });
  const wrap = $('#transfers');
  const groups = sortForSheet(visibleHfGroups(), { name: g => g.repoId || '', device: sheetDevice, size: g => g.sizeKnown ? g.total : 0, progress: g => g.progress, status: g => g.offline ? 'offline' : g.complete ? 'complete' : g.status || '' });
  const ipfsTransfers = sortForSheet(ipfsRows(state).filter(visibleTransfer).filter(row => !row.cleared),
    { name: r => r.name || '', device: r => r.deviceName || '', size: r => r.total, progress: r => r.total ? r.downloaded / r.total : r.status === 'done' ? 1 : 0, status: r => r.offline ? 'offline' : r.error ? 'error' : r.status || '' });
  $('#transfers-sheet-head').hidden = !(isSheet() && (torrents.length || groups.length || ipfsTransfers.length));
  syncSheetHead($('#transfers-sheet-head'));
  ipfsUi?.render(ipfsTransfers);
  const searching = Boolean(ui.transferQuery.trim());
  const inventory = searching ? downloadedInventory().filter(entry => !entry.pending && visibleTransfer(entry)
    && !torrents.some(t => t.device === entry.device && (t.deviceId || '') === (entry.deviceId || '')
      && (t.infoHash === (entry.infoHash || entry.infohash) || t.inventoryId === entry.id || sameItemPath(t.dataPath, entry.path, entry.device)))
    && !groups.some(group => group.device === entry.device && (group.deviceId || '') === (entry.deviceId || '') && sameItemPath(group.dest, entry.path, entry.device))
    && !ipfsTransfers.some(row => row.device === entry.device && row.deviceId === (entry.deviceId || '') && row.id === entry.id)) : [];
  deviceFilterOptions($('#transfers-device'));
  $('#transfers-device').value = ui.transferDevice;
  $('#transfers-spark-notice').hidden = !remoteDevices().some(device => !device.connected && matchesDevice(ui.transferDevice, { device: 'spark', deviceId: device.id }));
  $('#transfers-spark-message').textContent = sparkUi.busy ? 'Checking device transfers…' : 'A device is offline or unreachable. Progress is last known; downloads may continue on the device.';
  $('#transfers-refresh').disabled = sparkUi.busy;
  $('#empty-transfers').hidden = torrents.length > 0 || groups.length > 0 || ipfsTransfers.length > 0 || inventory.length > 0;
  $('#empty-transfers h3').textContent = searching ? 'No matching downloads' : 'Nothing moving';
  $('#empty-transfers p').textContent = searching ? 'Try a model name, file name or folder, or choose a different device.' : 'No transfers for the selected device. Choose a model in HuggingFace, or add a torrent.';
  $('#transfer-search-summary').hidden = !searching;
  $('#transfer-search-count').textContent = `${torrents.length + groups.length + ipfsTransfers.length} transfers · ${inventory.length} downloaded items · “${ui.transferQuery.trim()}”`;
  $('#btn-pauseall').textContent = searching ? 'Pause results' : 'Pause all';
  $('#btn-resumeall').textContent = searching ? 'Resume results' : 'Resume all';
  $('#transfer-inventory-results').hidden = !inventory.length;
  $('#transfer-inventory-sheet-head').hidden = !(isSheet() && inventory.length);
  renderInventoryInto($('#transfer-inventory'), inventory);

  wrap.innerHTML = torrents.map((t) => {
    const disabled = t.offline || transferBusy.has(transferKey(t, 'torrent')) ? 'disabled' : '';
    const files = Array.isArray(t.files) ? t.files : [], peers = Array.isArray(t.peers) ? t.peers : [];
    const progress = Math.min(1, Math.max(0, finiteNumber(t.progress)));
    const peerCount = Math.max(0, Math.floor(finiteNumber(t.numPeers)));
    const ratio = Math.max(0, finiteNumber(t.ratio));
    const pct = fmtPct(progress);
    const eta = t.offline ? 'Device offline · last known progress' : t.error ? esc(t.error) : t.paused ? (t.queued ? 'queued' : 'paused') : t.done ? (t.partial ? 'selected files complete' : 'seeding') : t.waitingForPeers ? 'Waiting for peers — retrying automatically' : !t.ready ? 'finding peers / metadata' : fmtEta(t.timeRemaining);
    const rate = t.offline || t.paused ? '—' : t.done
      ? `<span class="up">↑ ${fmtSpeed(t.uploadSpeed)}</span>`
      : `<span class="down">↓ ${fmtSpeed(t.downloadSpeed)}</span>`;
    const statusWord = torrentStatusWord(t);
    const rowOpen = opened.has(`${t.device}:${t.deviceId || ''}:${t.infoHash}`);
    return `
    <div class="tor ${t.seeding ? 'sharing' : ''} ${t.offline ? 'offline' : ''} ${opened.has(`${t.device}:${t.deviceId || ''}:${t.infoHash}`) ? 'open' : ''}" data-hash="${esc(t.infoHash)}" data-device="${t.device}" data-connection="${esc(t.deviceId || '')}">
      ${transferDestination(t, 'BitTorrent')}
      <div class="tor-top">
        <span class="sheet-cell cell-name"><button class="row-expand" data-row-expand aria-expanded="${rowOpen}" aria-label="Show details for ${esc(t.name)}">▸</button><span class="tor-name" title="${esc(t.name)}">${esc(t.name)}</span></span>
        <span class="sheet-cell cell-dev"><span class="chip" title="${esc(sheetDevice(t))}">${esc(sheetDevice(t))}</span></span>
        <span class="sheet-cell cell-size"><span class="tor-size">${fmtBytes(t.length)}</span></span>
        <span class="sheet-cell cell-progress"><span class="mini-bar ${t.paused ? 'paused' : ''} ${t.queued ? 'queued' : ''}"><i style="width:${Math.round(progress * 100)}%"></i></span><span class="tor-pct">${pct}</span></span>
        <span class="sheet-cell cell-status"><span class="tor-status ${statusWord}" title="${statusWord}">${statusWord}</span></span>
        <span class="sheet-cell cell-rate"><span class="tor-rate">${rate}</span></span>
        <span class="tor-acts sheet-cell cell-acts">
          <button class="btn sm" data-toggle-files>${files.length} file${files.length === 1 ? '' : 's'}</button>
          ${t.paused
            ? `<button class="btn sm" data-resume aria-label="Resume" ${disabled}><span class="lab">Resume</span><span class="ico" aria-hidden="true">▶</span></button>`
            : `<button class="btn sm" data-pause aria-label="Pause" ${disabled}><span class="lab">Pause</span><span class="ico" aria-hidden="true">⏸</span></button>`}
          ${t.magnetURI ? '<button class="btn sm" data-copy aria-label="Copy link"><span class="lab">Copy link</span><span class="ico" aria-hidden="true">⧉</span></button>' : ''}
          ${t.done && t.path && t.device === 'local' ? `<button class="btn sm" data-reveal aria-label="Show"><span class="lab">Show</span><span class="ico" aria-hidden="true">📂</span></button>` : ''}
          <details class="item-options transfer-options" ${openedTorrentOptions.has(`${t.device}:${t.deviceId || ''}:${t.infoHash}`) ? 'open' : ''}><summary class="btn sm" aria-label="Options for ${esc(t.name)}"><span class="lab">Options ▾</span><span class="ico" aria-hidden="true">⋯</span></summary><div class="item-options-menu">
            <button data-drop data-delete-files="false" ${disabled}>Remove transfer</button>
            ${t.device === 'local' || deviceById(t.deviceId)?.status?.capabilities?.torrentFileDeletion === true
              ? `<button class="danger" data-drop data-delete-files="true" ${disabled}>Delete transfer + files…</button>`
              : '<button class="danger" disabled title="Update this device companion to delete its downloaded files">Delete transfer + files… · update device</button>'}
          </div></details>
        </span>
      </div>
      <div class="bar ${t.paused ? 'paused' : ''} ${t.queued ? 'queued' : ''}"><i style="width:${Math.round(progress * 100)}%"></i></div>
      <div class="tor-meta">
        ${t.queued ? '<span class="chip queued">queued</span><span class="sep">·</span>' : ''}
        <span>${pct}</span><span class="sep">·</span>
        <span>${eta}</span><span class="sep">·</span>
        ${t.seeding && t.seededMs ? `<span>${fmtEta(t.seededMs)} seeded</span><span class="sep">·</span>` : ''}
        <span>${peerCount} peer${peerCount === 1 ? '' : 's'}</span><span class="sep">·</span>
        <span>ratio ${ratio.toFixed(2)}</span><span class="sep">·</span>
        <span class="mono" style="font-size:10px">${esc(String(t.infoHash).slice(0, 12))}…</span>
      </div>
      <div class="tor-files">
        ${files.slice(0, 40).map((f) => `
          <div class="frow">
            <span class="fname" title="${esc(f.path || f.name)}">${esc(f.name)}</span>
            <span class="fprog">${fmtBytes(f.length)}</span>
            <span class="fprog">${f.selected === false ? 'Skipped' : fmtPct(f.progress)}</span>
          </div>`).join('')}
        ${files.length > 40 ? `<div class="frow"><span class="fname">…and ${files.length - 40} more</span></div>` : ''}
        ${peers.length ? `<div class="frow" style="margin-top:6px"><span class="fname">${peers.slice(0, 12).map((p) => `<span class="peg">● ${esc(p.addr)}</span>`).join(' ')}</span></div>` : ''}
      </div>
    </div>`;
  }).join('');

  // HF cards go in AFTER the torrent innerHTML, or the assignment above
  // would wipe them out.
  renderHfDownloads(expandedModels, groups, openedModelOptions);

  wrap.querySelectorAll('.tor').forEach((el) => {
    const hash = el.dataset.hash;
    const t = torrents.find(row => row.infoHash === hash && row.device === el.dataset.device && (row.deviceId || '') === el.dataset.connection);
    el.querySelector('[data-toggle-files]')?.addEventListener('click', () => {
      el.classList.toggle('open');
      el.querySelector('[data-row-expand]')?.setAttribute('aria-expanded', String(el.classList.contains('open')));
    });
    el.querySelector('[data-row-expand]')?.addEventListener('click', () => {
      el.classList.toggle('open');
      el.querySelector('[data-row-expand]').setAttribute('aria-expanded', String(el.classList.contains('open')));
    });
    el.querySelector('[data-pause]')?.addEventListener('click', async () => {
      await controlTransfer(t, 'torrent', 'pause');
    });
    el.querySelector('[data-resume]')?.addEventListener('click', async () => {
      await controlTransfer(t, 'torrent', 'resume');
    });
    el.querySelectorAll('[data-drop]').forEach(button => button.addEventListener('click', async () => {
      const deleteFiles = button.dataset.deleteFiles === 'true';
      if (t.device === 'local') confirmRemove(hash, deleteFiles);
      else if (deleteFiles) await controlTransfer(t, 'torrent', 'remove', { deleteData: true });
      else if (await askModal('Remove this device transfer?', 'Downloaded files stay on the device.', { yes: 'Remove transfer' })) await controlTransfer(t, 'torrent', 'remove');
    }));
    el.querySelector('[data-copy]')?.addEventListener('click', () => {
      if (t?.magnetURI) copyLink(t.magnetURI);
    });
    el.querySelector('[data-reveal]')?.addEventListener('click', () => {
      if (t?.dataPath || t?.path) api.reveal(t.dataPath || t.path);
    });
  });
}

function announceSheetSort(text) {
  const live = $('#sheet-sort-announce');
  if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); }
}
function bindSheetHeads() {
  $('#transfers-sheet-head').addEventListener('click', event => {
    const button = event.target.closest('[data-sort-key]'); if (!button) return;
    const key = button.dataset.sortKey;
    if (sheetSort.key === key) {
      if (sheetSort.dir > 0) sheetSort.dir = -1;
      else { sheetSort.key = ''; sheetSort.dir = 1; }   // third click restores default order
    } else { sheetSort.key = key; sheetSort.dir = 1; }
    announceSheetSort(sheetSort.key ? `Transfers sorted by ${key}, ${sheetSort.dir > 0 ? 'ascending' : 'descending'}` : 'Transfers restored to default order');
    renderTransfers();
  });
  for (const prefix of ['library', 'torrents']) {
    $('#' + prefix + '-sheet-head').addEventListener('click', event => {
      const button = event.target.closest('[data-sort-key]'); if (!button) return;
      const select = $('#' + prefix + '-sort');
      select.value = select.value === button.dataset.sortKey ? 'recent' : button.dataset.sortKey;
      announceSheetSort(`${prefix === 'library' ? 'My Models' : 'Torrents'} sorted: ${select.options[select.selectedIndex]?.text || select.value}`);
      select.dispatchEvent(new Event('change'));
    });
  }
}
function bindTransfersView() {
  $('#btn-add').addEventListener('click', openAddDialog);
  $('#btn-ipfs').addEventListener('click', () => ipfsUi.open());
  $('#transfer-search-clear').addEventListener('click', () => { clearDownloadSearch(); $('#omni').focus(); });
  $('#transfer-inventory').addEventListener('click', handleInventoryAction);
  $('#transfers-device').addEventListener('change', event => { ui.transferDevice = event.target.value; renderTransfers(); });
  $('#transfers-refresh').addEventListener('click', () => refreshSpark(true));
  for (const action of ['pause', 'resume']) $('#btn-' + action + 'all').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    const torrents = transferTorrents().filter(visibleTransfer).filter(t => !t.offline && (action === 'pause' ? !t.paused && !t.done : t.paused));
    const groups = visibleHfGroups().filter(group => !group.offline);
    try {
      for (const t of torrents) {
        const result = await controlTransfer(t, 'torrent', action);
        if (result?.data?.cancelled || result?.ok === false) return;
      }
      for (const row of ipfsRows(state).filter(visibleTransfer).filter(r => !r.offline && !r.cleared && !r.removed && r.status !== 'done' && (action === 'pause' ? r.status === 'active' : r.status !== 'active'))) { if (!await ipfsUi.control(row, action)) return; }
      for (const group of groups) {
        const result = await controlHfGroup(group, action);
        if (result?.data?.cancelled || result?.ok === false) return;
      }
    } finally { button.disabled = false; }
  });
  $('#btn-openfolder').addEventListener('click', () => api.reveal(state.settings?.downloadDir ?? '.'));
}

function confirmRemove(hash, initialDeleteFiles = null) {
  const t = findTorrent(hash);
  if (initialDeleteFiles !== null) {
    void (async () => {
      try {
        const result = await api.remove(hash, initialDeleteFiles);
        if (!result.ok) throw new Error(result.error);
        if (result.data?.torrents?.some(item => item.infoHash === hash)) return;
        applyState(result.data);
        toast(initialDeleteFiles ? 'Transfer and downloaded files deleted.' : 'Transfer removed. Files kept.');
      } catch (problem) { toast(problem.message || 'Could not remove this transfer.', 'error'); }
    })();
    return;
  }
  const remove = async deleteData => {
    const error = $('#remove-error');
    error.hidden = true;
    try {
      const result = await api.remove(hash, deleteData);
      if (!result.ok) throw new Error(result.error);
      // Cancelling the native delete confirmation leaves the transfer present.
      if (result.data?.torrents?.some(item => item.infoHash === hash)) return;
      applyState(result.data); closeModal();
    } catch (problem) {
      error.textContent = problem.message || 'Could not remove this transfer. Try again.';
      error.hidden = false;
    }
  };
  openModal({
    title: `Remove ${t?.name ?? 'transfer'}?`,
    sub: 'You can keep the files on disk, or delete them too. Keeping them does not keep you serving — removing the torrent stops this box from sharing.',
    body: '<p id="remove-error" class="inventory-error" role="alert" hidden></p>',
    actions: [
      { label: 'Cancel', kind: 'btn' },
      { label: 'Keep files', kind: 'btn primary', onClick: () => remove(false) },
      { label: 'Delete files', kind: 'btn danger', onClick: () => remove(true) },
    ],
  });
}

/* =============================== LIBRARY ================================= */

function remoteInventory() { return remoteRows('inventory'); }
const inventoryBusy = new Set(), inventoryErrors = new Map();
const inventoryKey = entry => `${entry.device}:${entry.deviceId || ''}:${entry.id}`;
const sameItemPath = (a, b, device = 'local') => {
  const normalize = value => { const v = String(value || '').replaceAll('\\', '/').replace(/\/$/, ''); return device === 'local' && state.platform === 'win32' ? v.toLowerCase() : v; };
  return Boolean(a && b) && normalize(a) === normalize(b);
};
function downloadedInventory() {
  const entries = [...(state.inventory || []).map(entry => ({ ...entry, device: 'local', kind: state.itemKinds?.[entry.id] || contentKind(entry) })), ...remoteInventory().map(entry => ({ ...entry, device: 'spark', kind: contentKind(entry) }))];
  entries.push(...ipfsInventory(state));
  // Older manually shared folders retain a card even before their manifest migrates.
  for (const shared of state.library || []) {
    if (entries.some(entry => entry.device === 'local' && (entry.infoHash === shared.infohash || sameItemPath(entry.path, shared.path)))) continue;
    const live = findTorrent(shared.infohash), id = 'shared:' + shared.infohash;
    entries.push({ ...shared, id, infoHash: shared.infohash, device: 'local', source: 'torrent', kind: state.itemKinds?.[id] || contentKind({ ...shared, files: live?.files }), fileCount: live?.files?.length || 0, size: live?.length || 0, available: Boolean(live?.ready), directory: true });
  }
  for (const owner of [{ id: '', local: true }, ...remoteDevices()]) {
    const device = owner.local ? 'local' : 'spark', deviceId = owner.id;
    const torrents = owner.local ? state.torrents : owner.connected ? owner.status?.torrents : [];
    for (const torrent of torrents || []) {
      if (torrent.explicitShare || !torrent.infoHash || entries.some(entry => entry.device === device && (entry.deviceId || '') === deviceId && (entry.infoHash === torrent.infoHash || entry.infohash === torrent.infoHash || entry.id === torrent.inventoryId))) continue;
      entries.push({ id: 'transfer:' + torrent.infoHash, infoHash: torrent.infoHash, device, deviceId, source: 'torrent', kind: contentKind(torrent), name: torrent.name, path: torrent.dataPath || torrent.path, destination: torrent.destination || torrent.path, files: torrent.files, fileCount: (torrent.files || []).filter(file => file.selected !== false).length, size: torrent.length, available: true, pending: true, paused: torrent.paused, progress: torrent.progress, updatedAt: torrent.addedAt });
    }
  }
  for (const scanned of state.modelLibrary?.items || []) {
    const existing = entries.find(entry => entry.device === scanned.device && (entry.deviceId || '') === (scanned.deviceId || '')
      && (sameItemPath(entry.path, scanned.path, scanned.device) || entryContainsCopy(entry, scanned)));
    if (existing) {
      // Sharing adds an owned transfer identity, but must not undo the user's
      // category choice for this exact discovered model. Further category edits
      // keep that same identity; sharing/removal still use the owned item ID.
      if (sameItemPath(existing.path, scanned.path, scanned.device) && state.itemKinds?.[scanned.id]) {
        existing.kind = state.itemKinds[scanned.id];
        existing.categoryId = scanned.id;
      }
      continue;
    }
    entries.push({ ...scanned, kind: state.itemKinds?.[scanned.id] || 'model' });
  }
  return entries.filter(entry => !entryIsHidden(entry, state.hiddenItems)).map(entry => {
    const saved = (state.savedShareLinks || []).find(row => sameEntryCopy(row, entry));
    return saved ? { ...entry, magnet: saved.magnet, infoHash: entry.infoHash || saved.infohash } : entry;
  });
}
function updateLibraryCount() {
  const entries = downloadedInventory();
  $('#ct-library').textContent = entries.filter(entry => contentKind(entry) === 'model').length;
  $('#ct-catalog').textContent = entries.filter(entry => contentKind(entry) === 'torrent').length;
}
function inventorySharing(entry) {
  if (entry.source === 'ipfs') return { online: !entry.offline, capable: !entry.offline, on: !entry.offline && entry.sharing, live: [], protocol: 'ipfs' };
  const remote = entry.device === 'spark';
  const online = !remote || deviceOnline(entry.deviceId);
  const torrents = online ? (remote ? deviceById(entry.deviceId)?.status?.torrents : state.torrents) || [] : [];
  const live = torrents.filter(t => t.inventoryId === entry.id || t.infoHash === (entry.infoHash || entry.infohash) || (!t.inventoryId && sameItemPath(t.dataPath, entry.path, entry.device)));
  return { online, live, on: online && live.some(t => !t.paused && (t.done || t.explicitShare)), capable: !remote || entry.source === 'scan' || deviceById(entry.deviceId)?.status?.inventoryControls === true };
}
function inventoryMarkup(entry) {
  const remote = entry.device === 'spark', sharing = inventorySharing(entry), offline = !sharing.online;
  const missing = Number(entry.missingFiles) || 0, busy = inventoryBusy.has(inventoryKey(entry));
  const completeness = entry.completeness && !entry.completeness.complete ? entry.completeness.summary : '';
  const label = offline ? 'Device offline · last known files' : entry.pending ? entry.paused ? 'Download paused' : `Downloading · ${fmtPct(entry.progress)}` : missing ? `${missing} file${missing === 1 ? '' : 's'} missing` : entry.available === false ? entry.source === 'scan' ? 'Files unavailable' : 'Storage unavailable' : completeness ? `Incomplete · ${completeness}` : entry.source === 'scan' ? 'Found on disk' : 'Available';
  const count = Number(entry.fileCount) || 0, kind = contentKind(entry);
  const disabled = busy || offline || !sharing.capable || entry.pending || (!sharing.on && entry.available === false);
  const browseUnavailable = remote ? !offline && !sparkRootAvailable(entry.destination, entry.deviceId) : entry.available === false;
  const error = inventoryErrors.get(inventoryKey(entry));
  // AEON origin statement: IPFS collections carry their result; local torrent copies are keyed by item.
  const origin = originSummary(entry.source === 'ipfs' ? entry.origin : entry.device === 'local' ? state.aeonOrigins?.[entry.id] : null);
  // File-integrity result (format safety + optional HF anchor), keyed like origins.
  const integrity = integritySummary(entry.device === 'local' ? state.aeonIntegrity?.[entry.id] : null);
  const magnet = entry.source === 'ipfs' && entry.shareCid ? 'ipfs://' + entry.shareCid : sharing.live.find(t => t.magnetURI)?.magnetURI || entry.magnet;
  const sharingControl = entry.pending ? `<div class="item-sharing">${entry.paused ? 'Transfer paused' : 'Transfer active'}</div>` : `<div class="item-sharing"><span>Sharing</span><button class="share-switch" role="switch" aria-label="Sharing ${esc(entry.name)}" aria-checked="${sharing.on}" data-inventory-action="sharing" ${disabled ? 'disabled' : ''}><span class="share-track"><span></span></span><span>${busy ? 'Working…' : offline ? 'Offline' : sharing.on ? 'On' : 'Off'}</span></button></div>`;
  const canDelete = (!remote || sharing.online && deviceById(entry.deviceId)?.status?.capabilities?.inventoryFileDeletion) && !['ipfs', 'scan'].includes(entry.source) && !entry.pending && !entry.id.startsWith('shared:');
  const repairRepo = entry.source === 'hf' ? (entry.repoId || (/^[^/\s]+\/[^/\s]+$/.test(entry.name || '') ? entry.name : '')) : '';
  const repairBtn = repairRepo && (missing || completeness || entry.available === false) ? `<button class="btn sm" data-inventory-action="repair" data-repair-repo="${esc(repairRepo)}" data-repair-rev="${esc(entry.revision || 'main')}">Repair on HF</button>` : '';
  const removal = `<hr><button data-inventory-action="hide">Hide from library</button>${canDelete ? '<button class="danger" data-inventory-action="delete">Delete item + files…</button>' : ''}${magnet ? '<button data-inventory-action="magnet">Copy saved link</button>' : ''}${!remote && entry.source !== 'ipfs' && !entry.pending ? '<button data-inventory-action="publish">Prepare release…</button>' : ''}`;
  const browseLabel = entry.pending ? 'View transfer' : remote ? offline ? 'Connect to browse' : 'Browse files' : 'Show in Folder';
  const statusWord = offline ? 'offline' : entry.pending ? entry.paused ? 'paused' : 'downloading' : missing ? 'missing' : entry.available === false ? 'unavailable' : completeness ? 'incomplete' : entry.source === 'scan' ? 'on disk' : 'available';
  // Card mode keeps the original main/actions flex layout: .sheet-row, .sheet-detail
  // and .cell-share/.cell-acts are display:contents there, so children flow exactly as
  // before. Sheet mode turns .sheet-row into the one-line grid and reveals
  // .sheet-detail as a full-width expanded block under the row.
  return `<article class="inventory-item" data-inventory-id="${esc(entry.id)}" data-inventory-device="${entry.device}" data-inventory-connection="${esc(entry.deviceId || '')}"><div class="sheet-row"><div class="inventory-main"><div class="inventory-title sheet-cell cell-name"><button class="row-expand" data-inventory-action="expand" aria-expanded="false" aria-label="Show details for ${esc(entry.name || entry.repoId || entry.path)}">▸</button><h4>${esc(entry.name || entry.repoId || entry.path)}</h4><span class="chip card-status ${offline || missing || completeness || entry.available === false ? 'inventory-warning' : ''}">${esc(label)}</span></div><span class="sheet-cell cell-dev inv-dev"><span class="chip" title="${esc(remote ? remoteName(entry.deviceId) : localDeviceLabel())}">${esc(remote ? remoteName(entry.deviceId) : localDeviceLabel())}</span></span><span class="sheet-cell cell-size inv-size">${fmtBytes(entry.size)}</span><span class="sheet-cell cell-status"><span class="chip inv-status ${offline || missing || completeness || entry.available === false ? 'inventory-warning' : ''}" title="${esc(label)}">${esc(statusWord)}</span></span><div class="sheet-detail"><p class="inventory-meta">${esc(remote ? remoteName(entry.deviceId) : localDeviceLabel())} · ${entry.source === 'hf' ? 'HuggingFace' : entry.source === 'ipfs' ? 'IPFS' : contentType(entry)} · ${count} ${entry.pending ? 'selected' : entry.source === 'scan' ? 'discovered' : 'downloaded'} file${count === 1 ? '' : 's'} · ${fmtBytes(entry.size)}</p><p class="inventory-path" title="${esc(entry.path)}">${esc(entry.path)}</p>${origin ? `<p class="inventory-origin ${origin.tone}" title="${esc(origin.key)}"><strong>${esc(origin.label)}</strong> · ${esc(origin.detail)}</p>` : ''}${integrity ? `<p class="inventory-origin ${integrity.tone}"><strong>${esc(integrity.label)}</strong> · ${esc(integrity.detail)}</p>` : ''}${entry.error && !offline ? `<p class="inventory-error">${esc(entry.error)}</p>` : ''}<div class="item-share-stats" ${sharing.on ? '' : 'hidden'}><span data-share-up></span><span data-share-peers></span><span data-share-total></span><button class="hf-link" data-inventory-action="magnet" ${magnet ? '' : 'disabled'}>${entry.source === 'ipfs' ? 'Copy IPFS link' : 'Copy magnet link'}</button></div>${remote && sharing.online && !sharing.capable ? '<p class="hint item-control-hint">Run device setup and choose Update companion to enable sharing controls.</p>' : ''}${error ? `<p class="inventory-error" role="alert">${esc(error)}</p>` : ''}</div></div><div class="inventory-actions"><div class="sheet-cell cell-share">${sharingControl}</div><div class="sheet-cell cell-acts"><div class="item-buttons">${repairBtn}<button class="btn sm" data-inventory-action="browse" aria-label="${browseLabel}" ${browseUnavailable ? 'disabled' : ''}><span class="lab">${browseLabel}</span><span class="ico" aria-hidden="true">📂</span></button><details class="item-options"><summary class="btn sm" aria-label="Options for ${esc(entry.name)}"><span class="lab">Options ▾</span><span class="ico" aria-hidden="true">⋯</span></summary><div class="item-options-menu"><button data-inventory-action="copy">Copy path</button>${!remote && !entry.pending && entry.available !== false ? `<button data-inventory-action="integrity">${integrity ? 'Re-scan integrity' : 'Scan integrity'}</button>` : ''}<button data-inventory-action="kind" ${busy || offline || !sharing.capable || entry.pending ? 'disabled' : ''}>Move to ${kind === 'model' ? 'Torrents' : 'My Models'}</button>${removal}</div></details></div></div></div></div></article>`;
}
function renderInventoryInto(container, entries, empty = '') {
  if (!entries.length) {
    if (container.innerHTML !== empty) container.innerHTML = empty;
    libraryTools?.decorate();
    return;
  }
  const existing = new Map([...container.querySelectorAll(':scope > .inventory-item')].map(card => [card.dataset.inventoryDevice + ':' + (card.dataset.inventoryConnection || '') + ':' + card.dataset.inventoryId, card]));
  const keep = new Set();
  for (const entry of entries) {
    const key = inventoryKey(entry), html = inventoryMarkup(entry);
    let card = existing.get(key);
    if (!card || card._markup !== html) {
      const open = card?.querySelector('.item-options')?.open;
      const rowOpen = card?.classList.contains('open');
      // Focus may sit on a child span (.lab/.ico) of a control; resolve to the control.
      const active = card?.contains(document.activeElement) ? document.activeElement.closest('button,summary,[role="switch"],input') : null;
      const focused = active ? active.dataset.inventoryAction || (active.tagName === 'SUMMARY' ? 'options' : active.classList.contains('entry-select') ? 'select' : '') : '';
      const template = document.createElement('template'); template.innerHTML = html;
      const replacement = template.content.firstElementChild; replacement._markup = html;
      if (card) card.replaceWith(replacement); card = replacement;
      if (rowOpen) { card.classList.add('open'); card.querySelector('[data-inventory-action="expand"]')?.setAttribute('aria-expanded', 'true'); }
      if (open) card.querySelector('.item-options').open = true;
      if (focused) queueMicrotask(() => card.querySelector(focused === 'options' ? 'summary' : focused === 'select' ? '.entry-select' : `[data-inventory-action="${focused}"]`)?.focus({ preventScroll: true }));
    }
    // Existing cards stay in place while rates change, preserving menus and focus.
    const index = keep.size;
    if (container.children[index] !== card) container.insertBefore(card, container.children[index] || null);
    keep.add(card);
    const sharing = inventorySharing(entry), sum = field => sharing.live.reduce((n, t) => n + (Number(t[field]) || 0), 0);
    card.querySelector('[data-share-up]').textContent = `↑ ${fmtBytes(sum('uploadSpeed'))}/s`;
    card.querySelector('[data-share-peers]').textContent = `${sum('numPeers')} peers`;
    card.querySelector('[data-share-total]').textContent = `${fmtBytes(sum('uploaded'))} uploaded`;
    if (entry.source === 'ipfs') { card.querySelector('[data-share-up]').textContent = `IPFS node ↑ ${fmtSpeed(entry.nodeStats?.uploadSpeed)}`; card.querySelector('[data-share-peers]').textContent = `${entry.nodeStats?.peers || 0} node peers`; card.querySelector('[data-share-total]').textContent = 'Sharing this collection'; }
  }
  for (const child of [...container.children]) if (!keep.has(child)) child.remove();
  libraryTools?.decorate();
}
async function handleInventoryAction(event) {
  const button = event.target.closest('[data-inventory-action]');
  if (!button || button.disabled) return;
  const card = button.closest('[data-inventory-id]');
  const entry = downloadedInventory().find(item => item.device === card.dataset.inventoryDevice && item.id === card.dataset.inventoryId && (item.deviceId || '') === (card.dataset.inventoryConnection || ''));
  if (!entry) return;
  const action = button.dataset.inventoryAction;
  if (action === 'expand') {
    const open = card.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
    return;
  }
  if (action === 'repair') {
    const repoId = button.dataset.repairRepo;
    const rev = button.dataset.repairRev || 'main';
    if (repoId) {
      goTab('hf');
      try { await hfSelect(repoId, rev); }
      catch { toast('Could not load model details from Hugging Face.', 'error'); }
    }
    return;
  }
  if (action === 'publish') { publishingUi.prepare(entry); return; }
  if (action === 'integrity') {
    const key = inventoryKey(entry); if (inventoryBusy.has(key)) return; inventoryBusy.add(key);
    button.disabled = true;
    try {
      const result = await api.aeonIntegrityScan({ id: entry.id });
      if (!result.ok) toast(result.error, 'error');
      else {
        const summary = integritySummary(result.data?.integrity);
        toast(summary ? `${summary.label}: ${summary.detail}` : 'Integrity scan finished.', summary?.tone === 'warn' ? 'warn' : 'ok');
      }
      await refresh();
    } catch (error) { toast(error.message, 'error'); }
    finally { inventoryBusy.delete(key); renderLibrary(); renderTorrents(); renderSpark(); }
    return;
  }
  if (entry.source === 'ipfs' && ['sharing', 'kind', 'magnet'].includes(action)) {
    const key = inventoryKey(entry); if (inventoryBusy.has(key)) return; inventoryBusy.add(key);
    try {
      if (action === 'magnet') { if (await api.copyText('ipfs://' + entry.shareCid)) toast('IPFS link copied.'); return; }
      button.disabled = true;
      const options = { id: entry.id, deviceId: entry.deviceId || undefined };
      const result = action === 'sharing' ? await api.ipfsSharing({ ...options, enabled: !entry.sharing }) : await api.ipfsControl({ ...options, action: 'kind', kind: entry.kind === 'model' ? 'torrent' : 'model' });
      if (!result.ok) toast(result.error, 'error'); await refresh();
    } catch (error) { toast(error.message, 'error'); }
    finally {
      inventoryBusy.delete(key);
      renderLibrary(); renderTorrents(); renderSpark(); if (ui.tab === 'transfers') renderTransfers();
    }
    return;
  }
  if (action === 'copy' || action === 'magnet') {
    const value = action === 'copy' ? entry.path : inventorySharing(entry).live.find(t => t.magnetURI)?.magnetURI || entry.magnet;
    try { if (await api.copyText(value)) toast(action === 'copy' ? 'File location copied.' : 'Magnet link copied.'); }
    catch { toast('Could not copy. Try again.', 'error'); }
  } else if (action === 'sharing' || action === 'kind') {
    const key = inventoryKey(entry); if (inventoryBusy.has(key)) return;
    inventoryBusy.add(key); inventoryErrors.delete(key);
    const enabled = !inventorySharing(entry).on, kind = contentKind(entry) === 'model' ? 'torrent' : 'model';
    renderLibrary(); renderTorrents(); renderSpark(); if (ui.tab === 'transfers') renderTransfers();
    try {
      const request = { device: entry.device, deviceId: entry.deviceId, id: action === 'kind' ? entry.categoryId || entry.id : entry.id };
      const result = await (action === 'sharing' ? entry.source === 'scan' ? api.shareDiscoveredModel({ id: entry.id, enabled }) : api.setItemSharing({ ...request, enabled }) : api.setItemKind({ ...request, kind }));
      if (!result.ok) throw new Error(result.error);
      if (result.data.cancelled) return;
      if (result.data.status && (!result.data.deviceId || result.data.deviceId === selectedDeviceId())) { sparkUi.status = result.data.status; sparkUi.connected = true; sparkUi.host = state.settings.sparkHost; }
      applyState(result.data.state);
      toast(action === 'kind' ? `Moved to ${kind === 'model' ? 'My Models' : 'Torrents'}. Files stay in their current folder.` : enabled ? `Sharing ${entry.name}.` : `Sharing off. Files kept on ${entry.device === 'spark' ? remoteName(entry.deviceId) : 'this computer'}.`);
    } catch (error) { inventoryErrors.set(key, error.message || 'Could not update this item. Try again.'); }
    finally { inventoryBusy.delete(key); renderLibrary(); renderTorrents(); renderSpark(); if (ui.tab === 'transfers') renderTransfers(); }
  } else if (action === 'hide' || action === 'remove' || action === 'delete') {
    const key = inventoryKey(entry); if (inventoryBusy.has(key)) return;
    inventoryBusy.add(key); inventoryErrors.delete(key); renderLibrary(); renderTorrents(); if (ui.tab === 'transfers') renderTransfers();
    try {
      const request = { device: entry.device, deviceId: entry.deviceId, id: entry.id, deleteFiles: action === 'delete' };
      const result = action === 'hide' ? await api.hideItem(request) : await api.removeItem(request);
      if (!result.ok) throw new Error(result.error);
      if (!result.data.cancelled) { applyState(action === 'hide' ? result.data : result.data.state); toast(action === 'delete' ? 'Downloaded files deleted.' : 'Hidden. Files and sharing kept; restore from Hidden entries.'); }
    } catch (error) { inventoryErrors.set(key, error.message || 'Could not remove this item.'); }
    finally { inventoryBusy.delete(key); renderLibrary(); renderTorrents(); renderSpark(); if (ui.tab === 'transfers') renderTransfers(); }
  } else if (entry.pending) { clearDownloadSearch(); ui.transferDevice = entry.deviceId ? 'device:' + entry.deviceId : entry.device; goTab('transfers'); }
  else if (entry.device === 'local') await api.reveal(entry.path);
  else {
    if (entry.deviceId && entry.deviceId !== selectedDeviceId()) await selectRemoteDevice(entry.deviceId);
    devicesUi.local = false; devicesUi.page = 'detail';
    const relative = entry.browseRelative ?? (entry.directory === false ? (entry.relative || '').split('/').slice(0, -1).join('/') : entry.relative || '');
    sparkUi.pendingBrowse = { root: entry.destination, relative };
    $('#spark-files-section').open = true;
    if (sparkUi.connected) applySparkBrowse();
    goTab('spark');
    if (sparkUi.connected) { await refreshSparkFiles(); $('#spark-files-section').scrollIntoView({ block: 'start' }); }
    else $('#spark-connect').focus();
  }
}
function applySparkBrowse() {
  if (!sparkUi.pendingBrowse) return;
  sparkUi.root = sparkUi.pendingBrowse.root; sparkUi.relative = sparkUi.pendingBrowse.relative;
  sparkUi.pendingBrowse = null;
}
function renderOwnedView(kind) {
  const models = kind === 'model', prefix = models ? 'library' : 'torrents';
  const device = models ? ui.libraryDevice : ui.torrentsDevice;
  const query = $('#' + prefix + '-query').value.trim().toLowerCase(), sort = $('#' + prefix + '-sort').value;
  const type = models ? '' : $('#torrents-type').value;
  const entries = downloadedInventory().filter(entry => contentKind(entry) === kind && matchesDevice(device, entry) && (!query || `${entry.name} ${entry.path}`.toLowerCase().includes(query)) && (!type || contentType(entry) === type));
  entries.sort((a, b) => (sort === 'size' ? b.size - a.size : sort === 'device' ? String(a.device === 'spark' ? remoteName(a.deviceId) : localDeviceLabel()).localeCompare(String(b.device === 'spark' ? remoteName(b.deviceId) : localDeviceLabel()), undefined, { numeric: true }) : sort === 'recent' ? (b.updatedAt || 0) - (a.updatedAt || 0) : 0) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  deviceFilterOptions($('#' + prefix + '-device'));
  $('#' + prefix + '-device').value = device;
  $('#' + prefix + '-device option[value="local"]').textContent = localDeviceLabel();
  $('#' + prefix + '-summary').textContent = `${entries.length} ${models ? entries.length === 1 ? 'model' : 'models' : entries.length === 1 ? 'item' : 'items'}`;
  const message = $('#' + prefix + '-spark-message');
  message.hidden = !remoteDevices().some(item => !item.connected && matchesDevice(device, { device: 'spark', deviceId: item.id }));
  message.textContent = remoteInventory().length ? 'A device is offline. Last known files are shown; connect to check files or change sharing.' : 'Connect to your saved device to load its files.';
  const empty = $(models ? '#empty-downloads' : '#empty-torrents'); empty.hidden = entries.length > 0;
  empty.querySelector('h3').textContent = query || type ? 'No matching items' : models ? 'No models here yet' : 'No torrents here yet';
  const head = $('#' + prefix + '-sheet-head');
  head.hidden = !(isSheet() && entries.length);
  // The sort dropdown stays authoritative; header buttons just drive it (name A–Z /
  // largest first), so the arrow and the dropdown can never disagree.
  head.querySelectorAll('[data-sort-key]').forEach(b => {
    const active = (b.dataset.sortKey === 'name' && sort === 'name') || (b.dataset.sortKey === 'size' && sort === 'size') || (b.dataset.sortKey === 'device' && sort === 'device');
    b.setAttribute('aria-pressed', String(active));
    const arrow = b.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (b.dataset.sortKey === 'size' ? '▼' : '▲') : '';
  });
  renderInventoryInto($(models ? '#library-downloads' : '#torrents-inventory'), entries);
  updateLibraryCount();
}
function renderModelScan() {
  const scan = state.modelLibrary?.scan || { phase: 'idle', locations: [] };
  const running = ['scanning', 'cancelling'].includes(scan.phase);
  const button = $('#models-scan'), status = $('#models-scan-status');
  button.disabled = scan.phase === 'cancelling';
  button.textContent = scan.phase === 'cancelling' ? 'Stopping…' : running ? 'Stop scan' : 'Scan all saved directories';
  button.title = running ? 'Stop scanning; previously found models are kept.' : 'Find models in all saved local folders and device storage. Files stay in place; sharing is unchanged.';
  const locations = scan.locations || [];
  const finished = locations.filter(location => !['pending', 'scanning'].includes(location.status)).length;
  const warnings = locations.filter(location => ['unavailable', 'warning'].includes(location.status));
  const count = state.modelLibrary?.items?.length || 0;
  status.hidden = scan.phase === 'idle' && !scan.finishedAt;
  status.dataset.phase = scan.phase;
  status.textContent = scan.phase === 'cancelling' ? 'Stopping scan…' : running
    ? locations.length ? `Scanning · ${finished} of ${locations.length} directories checked` : 'Checking saved directories…'
    : scan.phase === 'error' ? `Scan could not finish: ${scan.message}` : scan.phase === 'cancelled' ? 'Scan stopped · previously found models kept'
    : scan.phase === 'complete' ? `Scan complete · ${count} model${count === 1 ? '' : 's'} indexed${warnings.length ? ` · ${warnings.length} location${warnings.length === 1 ? '' : 's'} unavailable or incomplete` : ''}`
    : `Last scanned ${new Date(scan.finishedAt).toLocaleString()}`;
  status.title = warnings.map(location => `${location.name}: ${location.root} — ${location.message}`).join('\n');
}
async function startModelScan() {
  $('#models-scan').disabled = true;
  try {
    const result = await (state.modelLibrary?.scan?.phase === 'scanning' ? api.cancelModelScan() : api.scanModels());
    if (!result.ok) throw new Error(result.error);
    state.modelLibrary = result.data;
  } catch (error) { toast(error.message || 'Could not start the model scan.', 'error'); }
  renderLibrary();
}
async function importModelFolder() {
  const button = $('#models-import');
  if (button) button.disabled = true;
  try {
    const result = await api.importModelFolder();
    if (!result.ok) throw new Error(result.error);
    if (result.data?.cancelled) return;
    if (result.data?.snapshot) state.modelLibrary = result.data.snapshot;
    toast(`Imported ${result.data.imported} model${result.data.imported === 1 ? '' : 's'} into My Models.`);
  } catch (error) { toast(error.message || 'Could not import that model folder.', 'error'); }
  finally {
    if (button) button.disabled = false;
    renderLibrary();
  }
}
function renderLibrary() { renderOwnedView('model'); renderModelScan(); }
function renderTorrents() { renderOwnedView('torrent'); }

async function shareFolder() {
  const p = await api.pickModelFolder();
  if (!p) return;
  toast('Hashing and starting to share…');
  const res = await api.shareFolder(p);
  if (res.ok && res.data.cancelled) return;
  if (res.ok) {
    applyState(res.data.state);
    const t = res.data.torrent;
    openModal({
      title: `Now sharing ${t.name}`,
      sub: 'This box keeps handing this out to anyone with the link, and comes back up sharing after a restart.',
      body: `<div class="field"><label>Magnet link</label><textarea readonly id="shareMagnet">${esc(t.magnetURI)}</textarea></div>`,
      actions: [
        { label: 'Copy link', kind: 'btn primary', onClick: () => copyLink(t.magnetURI) },
        { label: 'Done', kind: 'btn', onClick: closeModal },
      ],
    });
  } else {
    toast(res.error, 'error');
  }
}

function bindLibraryView() {
  libraryTools = bindLibraryTools({ api, getState: () => state, applyState, refresh, openModal, closeModal, toast });
  libraryTools.decorate();
  publishingUi = bindPublishing({ api, getState: () => state, refresh, openModal, closeModal, toast, fmtBytes });
  $('#models-scan').addEventListener('click', startModelScan);
  $('#models-import')?.addEventListener('click', importModelFolder);
  $('#btn-share2').addEventListener('click', shareFolder);
  $('#models-find').addEventListener('click', () => goTab('hf'));
  $('#torrents-share').addEventListener('click', shareFolder);
  for (const id of ['torrents-add', 'torrents-add-empty']) $('#' + id).addEventListener('click', () => openAddDialog());
  $('#torrents-device').addEventListener('change', event => { ui.torrentsDevice = event.target.value; renderTorrents(); });
  for (const id of ['library-query', 'library-sort', 'torrents-query', 'torrents-sort', 'torrents-type']) $('#' + id).addEventListener(id.endsWith('query') ? 'input' : 'change', () => { renderLibrary(); renderTorrents(); });
  $('#torrents-inventory').addEventListener('click', handleInventoryAction);
  $('#library-device').addEventListener('change', event => { ui.libraryDevice = event.target.value; renderLibrary(); });
  $('#library-downloads').addEventListener('click', handleInventoryAction);
}

/* --------------------------- HF HTTP downloads -------------------------- */

const hfGroupBusy = new Set();
const hfClearBusy = new Set();
async function controlHfGroup(group, action) {
  if (hfGroupBusy.has(group.id)) return;
  const files = group.files.filter(file => action === 'pause' ? ['active', 'queued'].includes(file.status)
    : action === 'cancel' ? ['active', 'queued', 'paused', 'error'].includes(file.status)
    : ['paused', 'error'].includes(file.status));
  if (!files.length) return;
  if (group.device === 'spark' && !deviceOnline(group.deviceId)) {
    toast('Reconnect to this device before changing its transfers.', 'warn'); return { ok: false };
  }
  hfGroupBusy.add(group.id); renderTransfers();
  try {
    if (action === 'resume') {
      const result = await api.hfResumeGroup({ ids: files.map(file => file.id), device: group.device,
        deviceId: group.device === 'spark' ? group.deviceId || selectedDeviceId() : undefined });
      if (result.ok && result.data?.cancelled) return result;
      if (!result.ok) toast(result.error || 'Could not resume this model.', 'error');
      if (group.device === 'spark') await refreshSpark(true); else await refresh();
      return result;
    }
    for (const file of files) {
      const result = await controlTransfer(file, 'hf', action);
      if (result?.data?.cancelled || result?.ok === false) return result;
    }
  } catch (error) { toast(error.message || 'Could not change this model.', 'error'); return { ok: false }; }
  finally { hfGroupBusy.delete(group.id); renderTransfers(); }
}
function hfFileControls(file, disabled) {
  return `${['active', 'queued'].includes(file.status) ? `<button class="btn sm" data-hf-pause ${disabled}>Pause</button>${file.device === 'local' ? `<button class="btn sm" data-cancel ${disabled}>Cancel</button>` : ''}` : ''}
    ${file.status === 'paused' ? `<button class="btn sm" data-hf-resume ${disabled}>Resume</button>` : ''}
    ${file.status === 'error' ? `<button class="btn sm" data-retry ${disabled}>Retry</button>` : ''}
    ${file.device === 'spark' && ['paused', 'error'].includes(file.status) ? `<button class="btn sm" data-hf-remove ${disabled}>Remove</button>` : ''}
    ${file.status === 'done' && file.device === 'local' ? '<button class="btn sm" data-reveal>Show</button><button class="btn sm" data-share>Share on swarm</button>' : ''}`;
}
function renderHfDownloads(expandedModels = new Set(), groups = visibleHfGroups(), openedOptions = new Set()) {
  $('#hf-dl-host')?.remove();
  if (!groups.length) return;
  const completed = device => groups.filter(group => group.device === device && group.complete);
  const clearDisabled = device => hfClearBusy.has(device) || !completed(device).length || (device === 'spark' && !completed(device).some(group => !group.offline)) ? 'disabled' : '';
  const host = document.createElement('div'); host.id = 'hf-dl-host';
  host.innerHTML = `<div class="viewhead hf-transfers-head"><h2>FROM HUGGINGFACE</h2><div class="headacts">
    ${groups.some(g => g.device === 'local') ? `<button class="btn sm" id="hf-clear" ${clearDisabled('local')}>Clear completed models · local</button>` : ''}
    ${groups.some(g => g.device === 'spark') ? `<button class="btn sm" id="spark-hf-clear" ${clearDisabled('spark')}>Clear completed models · devices</button>` : ''}
    </div></div><div id="hf-dl-list"></div>`;
  $('#transfers').prepend(host);
  $('#hf-dl-list').innerHTML = groups.map(group => {
    const pct = Math.floor(group.progress * 100);
    const busy = hfGroupBusy.has(group.id), disabled = group.offline || busy ? 'disabled' : '';
    const status = group.offline ? 'Device offline · last known progress' : group.complete ? 'Complete' : group.phase === 'verifying' ? 'Verifying file integrity' : group.status === 'active' ? 'Downloading' : group.status === 'queued' ? 'Queued' : group.status === 'paused' ? 'Paused' : 'Needs attention';
    const summary = `${group.counts.done} of ${group.files.length} files complete`;
    const groupOpen = expandedModels.has(group.id);
    const statusWord = group.offline ? 'offline' : group.complete ? 'complete' : group.phase === 'verifying' ? 'verifying' : group.status === 'active' ? 'downloading' : group.status || 'attention';
    return `<article class="hfdl hf-model ${group.status} ${group.offline ? 'offline' : ''} ${groupOpen ? 'open' : ''}" data-id="${esc(group.id)}" data-repo="${esc(group.repoId)}" data-device="${group.device}">
      ${transferDestination(group, group.hybrid ? 'HF + device' : 'HuggingFace')}
      <div class="tor-top">
        <span class="sheet-cell cell-name"><button class="row-expand" data-group-expand aria-expanded="${groupOpen}" aria-label="Show details for ${esc(group.repoId)}">▸</button><span class="tor-name" title="${esc(group.repoId)}">${esc(group.repoId)}</span></span>
        <span class="sheet-cell cell-dev"><span class="chip" title="${esc(sheetDevice(group))}">${esc(sheetDevice(group))}</span></span>
        <span class="sheet-cell cell-size"><span class="tor-size">${group.sizeKnown ? fmtBytes(group.total) : 'Calculating size…'}</span></span>
        <span class="sheet-cell cell-progress"><span class="mini-bar ${group.status === 'paused' || group.offline ? 'paused' : ''}"><i style="width:${pct}%"></i></span><span class="tor-pct">${pct}%</span></span>
        <span class="sheet-cell cell-status"><span class="tor-status ${esc(statusWord)}" title="${esc(status)}">${esc(statusWord)}</span></span>
        <span class="sheet-cell cell-rate"><span class="tor-rate">${group.status === 'active' && !group.offline ? `<span class="down">↓ ${fmtSpeed(group.speedBps)}</span>` : group.complete && !group.offline ? '<span class="ok">done</span>' : '—'}</span></span>
        <span class="tor-acts sheet-cell cell-acts">
          ${group.counts.active || group.counts.queued ? `<button class="btn sm" data-group-pause aria-label="Pause" ${disabled}><span class="lab">Pause</span><span class="ico" aria-hidden="true">⏸</span></button>` : ''}
          ${group.counts.paused || group.counts.error ? `<button class="btn sm" data-group-resume aria-label="${group.counts.paused ? 'Resume' : 'Retry'}" ${disabled}><span class="lab">${group.counts.paused ? 'Resume' : 'Retry'}</span><span class="ico" aria-hidden="true">▶</span></button>` : ''}
          ${group.complete ? '<button class="btn sm" data-model-library aria-label="My Models"><span class="lab">My Models</span><span class="ico" aria-hidden="true">▣</span></button>' : ''}
          <details class="item-options transfer-options" ${openedOptions.has(group.id) ? 'open' : ''}><summary class="btn sm" aria-label="Options for ${esc(group.repoId)}"><span class="lab">Options ▾</span><span class="ico" aria-hidden="true">⋯</span></summary><div class="item-options-menu">
            ${group.device === 'local' && (group.counts.active || group.counts.queued) ? `<button data-group-cancel ${disabled}>Cancel active files</button>` : ''}
            <button data-group-remove ${(group.counts.active || group.counts.queued || group.offline || busy) ? 'disabled' : ''}>Remove transfer</button>
            ${group.complete && group.device === 'local' ? `<button class="danger" data-group-delete ${busy ? 'disabled' : ''}>Delete model + files…</button>` : ''}
          </div></details>
        </span>
      </div>
      <div class="bar ${group.status === 'paused' || group.offline ? 'paused' : ''}" role="progressbar" aria-label="${esc(group.repoId)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
      <div class="tor-meta"><span>${pct}%</span><span class="sep">·</span><span>${fmtBytes(group.downloaded)} of ${group.sizeKnown ? fmtBytes(group.total) : 'unknown size'}</span><span class="sep">·</span>
        <span>${status}</span>${group.status === 'active' && !group.offline && !group.phase ? `<span>ETA ${fmtEta(group.etaMs)}</span>` : ''}<span class="sep">·</span><span>${summary}</span>
        ${group.counts.error ? `<span class="inventory-error">${group.counts.error} failed · expand files for details</span>` : ''}
        ${group.counts.paused && group.status !== 'paused' ? `<span>${group.counts.paused} paused</span>` : ''}
        ${group.hybrid ? `<span>HF ${fmtBytes(group.hfBytes)} · devices ${fmtBytes(group.peerBytes)} · Upload off</span>` : ''}
        ${group.sourceNotes.map(note => `<span>${esc(note)}</span>`).join('')}
        ${group.revision ? `<span class="mono">${esc(String(group.revision).slice(0, 10))}… pinned</span>` : ''}
      </div>
      <details class="hf-model-files" ${expandedModels.has(group.id) ? 'open' : ''}><summary>${group.files.length} file${group.files.length === 1 ? '' : 's'} · shards and supporting files</summary>
        ${group.files.map(file => {
          const locked = group.offline || busy || transferBusy.has(transferKey(file, 'hf')) ? 'disabled' : '';
          const progress = file.total ? Math.min(100, Math.floor((file.downloaded || 0) / file.total * 100)) : file.status === 'done' ? 100 : 0;
          return `<div class="hf-file" data-id="${esc(file.id)}"><span class="hf-file-name" title="${esc(file.filePath)}">${esc(file.filePath)}</span>
            <span class="hf-file-progress">${progress}% · ${esc(file.status)} · ${fmtBytes(file.downloaded || 0)}${file.total ? ' / ' + fmtBytes(file.total) : ''}</span>
            <span class="tor-acts">${hfFileControls(file, locked)}</span>${file.error ? `<p class="inventory-error">${esc(file.error)}</p>` : ''}</div>`;
        }).join('')}
      </details>
    </article>`;
  }).join('');
  host.querySelectorAll('[data-group-expand]').forEach(button => button.addEventListener('click', () => {
    const card = button.closest('.hfdl'), files = card.querySelector('.hf-model-files');
    const open = !files.open; files.open = open;
    button.setAttribute('aria-expanded', String(open));
  }));
  const groupFor = button => groups.find(group => group.id === button.closest('.hfdl').dataset.id);
  const recordFor = button => groupFor(button).files.find(file => file.id === button.closest('.hf-file').dataset.id);
  for (const action of ['pause', 'resume', 'cancel']) host.querySelectorAll(`[data-group-${action}]`).forEach(button => button.addEventListener('click', () => controlHfGroup(groupFor(button), action)));
  for (const [selector, action] of [['data-hf-pause', 'pause'], ['data-hf-resume', 'resume'], ['data-cancel', 'cancel'], ['data-retry', 'resume']]) {
    host.querySelectorAll(`[${selector}]`).forEach(button => button.addEventListener('click', () => controlTransfer(recordFor(button), 'hf', action)));
  }
  host.querySelectorAll('[data-hf-remove]').forEach(button => button.addEventListener('click', async () => {
    const file = recordFor(button);
    if (await askModal('Remove this device download?', 'Files already downloaded stay on the device.', { yes: 'Remove transfer' })) await controlTransfer(file, 'hf', 'remove');
  }));
  host.querySelectorAll('[data-group-remove]').forEach(button => button.addEventListener('click', async () => {
    const group = groupFor(button), ids = group.files.map(file => file.id);
    hfGroupBusy.add(group.id); renderTransfers();
    try {
      if (group.device === 'local') {
        const result = await api.hfRemove(ids);
        if (!result.ok) throw new Error(result.error);
        await refresh(); if (!result.data?.cancelled) toast('Transfer removed. Retained files are available in Hidden & retained entries.');
      } else {
        for (const file of group.files) {
          const result = await api.sparkControl('hf:remove', file.id, undefined, file.deviceId);
          if (!result.ok) throw new Error(result.error);
        }
        await refreshSpark(true); toast('Device transfer removed. Downloaded files kept.');
      }
    } catch (error) { toast(error.message || 'Could not remove this model transfer.', 'error'); }
    finally { hfGroupBusy.delete(group.id); renderTransfers(); }
  }));
  host.querySelectorAll('[data-group-delete]').forEach(button => button.addEventListener('click', async () => {
    const group = groupFor(button);
    const entry = hfGroupInventory(group, downloadedInventory());
    if (!entry) { toast('The completed model inventory is unavailable. Refresh and try again.', 'error'); return; }
    hfGroupBusy.add(group.id); renderTransfers();
    try {
      const result = await api.removeItem({ device: 'local', id: entry.id, deleteFiles: true, expectedFiles: group.files.map(file => ({ dest: file.dest, revision: file.revision })) });
      if (!result.ok) throw new Error(result.error);
      if (!result.data.cancelled) { applyState(result.data.state); toast('Model transfer and downloaded files deleted.'); }
    } catch (error) { toast(error.message || 'Could not delete this model.', 'error'); }
    finally { hfGroupBusy.delete(group.id); renderTransfers(); }
  }));
  host.querySelectorAll('[data-model-library]').forEach(button => button.addEventListener('click', () => { ui.libraryDevice = groupFor(button).device; goTab('library'); }));
  host.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', () => api.hfReveal(recordFor(button).dest)));
  host.querySelectorAll('[data-share]').forEach(button => button.addEventListener('click', () => shareHfFile(recordFor(button).id)));
  for (const [selector, device] of [['#hf-clear', 'local'], ['#spark-hf-clear', 'spark']]) {
    $(selector)?.addEventListener('click', async () => {
      if (hfClearBusy.has(device)) return;
      const files = completed(device).filter(group => !group.offline).flatMap(group => group.files);
      const ids = files.map(file => file.id);
      hfClearBusy.add(device); renderTransfers();
      try {
        if (device === 'local') {
          const result = await api.hfClearFinished(ids);
          if (!result.ok) toast(result.error, 'error');
          await refresh();
        } else {
          for (const file of files) {
            if (!deviceOnline(file.deviceId)) continue;
            const result = await api.sparkControl('hf:remove', file.id, undefined, file.deviceId);
            if (!result.ok) { toast(result.error, 'error'); break; }
          }
          await refreshSpark(true);
        }
      } catch (error) { toast(error.message || 'Could not clear completed models.', 'error'); }
      finally { hfClearBusy.delete(device); renderTransfers(); }
    });
  }
}

/** HF file landed — offer to hash it and start serving it to the swarm. */
async function shareHfFile(id) {
  const d = state.downloads.find((x) => x.id === id);
  if (!d) return;
  const okBtn = await askModal(`Share ${d.filePath} on the swarm?`,
    'This hashes the file locally and hands out a magnet link from this box — the intended loop: HF → here → peers.',
    { yes: 'Hash & share' });
  if (!okBtn) return;
  const r = await api.shareFolder(d.dest, d.filePath.split('/').pop());
  if (r.ok && r.data.cancelled) return;
  if (r.ok) {
    applyState(r.data.state);
    openModal({
      title: `Now sharing ${r.data.torrent.name}`,
      sub: 'Same as any shared file: this box keeps serving it, and comes back up sharing after a restart.',
      body: `<div class="field"><label>Magnet link</label><textarea readonly>${esc(r.data.torrent.magnetURI)}</textarea></div>`,
      actions: [
        { label: 'Copy link', kind: 'btn primary', onClick: () => copyLink(r.data.torrent.magnetURI) },
        { label: 'Done', kind: 'btn', onClick: closeModal },
      ],
    });
  } else toast(r.error, 'error');
}

/* =============================== CATALOG ================================= */

function renderCatalog() {
  const rows = state.catalog ?? [];
  const tb = $('#grid-catalog tbody');
  tb.innerHTML = rows.map((m) => `
    <tr data-id="${esc(m.id)}" class="${ui.selId === m.id ? 'selrow' : ''}">
      <td><span class="nm">${esc(m.name)}</span>${m.seeding ? ' <span class="chip mine">sharing</span>' : ''}</td>
      <td class="mono">${esc(m.params || '—')}</td>
      <td class="mono">${esc(m.quant || '—')}</td>
      <td class="mono">${m.sizeBytes ? fmtBytes(m.sizeBytes) : '—'}</td>
      <td><span class="chip lic ${LICENSE_CLASS(m.license)}">${esc(m.license || 'unclear')}</span></td>
      <td><span class="chip tag">${esc(m.source || 'local')}</span></td>
      <td class="mono" style="font-size:10px;color:var(--text-faint)">${esc(String(m.infohash || '').slice(0, 12) || '—')}</td>
      <td class="num">
        <button class="btn sm" data-edit="${esc(m.id)}">Edit</button>
        <button class="btn sm" data-del="${esc(m.id)}">Delete</button>
      </td>
    </tr>`).join('');

  tb.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await api.removeCatalogEntry(b.dataset.del);
    if (r.ok) { applyState(r.data); toast('Removed from your catalog.'); }
    else toast(r.error || 'Could not remove this saved link. Try again.', 'error');
  }));
  tb.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = findModel(b.dataset.edit);
    if (m) openCatalogEntryDialog(m);
  }));
  tb.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => {
    ui.selId = tr.dataset.id;
    $$('#grid-catalog tbody tr').forEach((o) => o.classList.toggle('selrow', o === tr));
    renderDrawer();
  }));
  libraryTools?.decorate();
}

function bindCatalogView() {
  $('#btn-newentry').addEventListener('click', () => openCatalogEntryDialog(null));
  $('#btn-import').addEventListener('click', () => {
    openModal({
      title: 'Import a catalog',
      sub: 'Paste the URL of a JSON catalog someone shared. Entries get merged with yours.',
      body: `<div class="field"><label>Catalog URL</label><input id="impUrl" placeholder="https://example.com/models.json" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'btn' },
        { label: 'Import', kind: 'btn primary', onClick: async () => {
          const url = $('#impUrl').value.trim();
          if (!url) return;
          const r = await api.importCatalogUrl(url);
          if (r.ok && !r.data?.cancelled) { applyState(r.data); toast('Catalog imported.'); closeModal(); }
          else if (!r.ok) toast(r.error, 'error');
        } },
      ],
    });
  });
}

function openCatalogEntryDialog(prefill) {
  const m = prefill ?? {};
  openModal({
    title: prefill ? 'Edit catalog entry' : 'New catalog entry',
    sub: 'A magnet link plus enough detail to decide whether it is worth pulling. Nothing is uploaded anywhere — this is your own list.',
    body: `
      <div class="grid2">
        <div class="field"><label>Name</label><input id="ce-name" value="${esc(m.name ?? '')}" placeholder="Qwen3-30B-A3B" /></div>
        <div class="field"><label>Publisher</label><input id="ce-pub" value="${esc(m.publisher ?? '')}" placeholder="Qwen" /></div>
        <div class="field"><label>Params</label><input id="ce-params" value="${esc(m.params ?? '')}" placeholder="30B" /></div>
        <div class="field"><label>Quant</label><input id="ce-quant" value="${esc(m.quant ?? '')}" placeholder="Q4_K_M" /></div>
        <div class="field"><label>Format</label><input id="ce-format" value="${esc(m.format ?? '')}" placeholder="gguf" /></div>
        <div class="field"><label>License</label><input id="ce-lic" value="${esc(m.license ?? '')}" placeholder="Apache-2.0" /></div>
      </div>
      <div class="field"><label>Magnet link or infohash</label><textarea id="ce-magnet" placeholder="magnet:?xt=urn:btih:…">${esc(m.magnet || m.infohash || '')}</textarea></div>
      <div class="field"><label>Tags (comma separated)</label><input id="ce-tags" value="${esc((m.tags ?? []).join(', '))}" placeholder="text, moe, gguf" /></div>
      <div class="field"><label>Notes</label><input id="ce-notes" value="${esc(m.notes ?? '')}" placeholder="Anything worth knowing before pulling 60 GB" /></div>`,
    actions: [
      { label: 'Cancel', kind: 'btn' },
      { label: 'Save', kind: 'btn primary', onClick: async () => {
        const magnet = $('#ce-magnet').value.trim();
        const entry = {
          ...m,
          id: m.id,
          name: $('#ce-name').value.trim(),
          publisher: $('#ce-pub').value.trim(),
          params: $('#ce-params').value.trim(),
          quant: $('#ce-quant').value.trim(),
          format: $('#ce-format').value.trim(),
          license: $('#ce-lic').value.trim() || 'unclear',
          magnet: magnet.startsWith('magnet:') ? magnet : '',
          infohash: magnet.startsWith('magnet:') ? '' : magnet,
          tags: $('#ce-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
          notes: $('#ce-notes').value.trim(),
          source: m.source && m.source !== 'starter' && m.source !== 'remote' ? m.source : 'local',
        };
        if (!entry.name) return toast('Give it a name.', 'error');
        if (!entry.magnet && !entry.infohash) return toast('Needs a magnet link or infohash.', 'error');
        const r = await api.addCatalogEntry(entry);
        if (!r.ok) toast(r.error, 'error');
        else if (!r.data.cancelled) { applyState(r.data); toast('Saved.'); closeModal(); }
      } },
    ],
  });
}

/* =============================== SETTINGS ================================ */

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
let settingsSection = 'connection';

function renderConfirmations() {
  const count = state.confirmations?.remembered || 0;
  $('#confirmations-status').textContent = count ? `${count} remembered choice${count === 1 ? '' : 's'}.` : 'No remembered confirmations.';
  $('#reset-confirmations').disabled = !count;
}

function renderUpdates() {
  const update = state.updates || {}, latest = update.latest?.version;
  const check = $('#updates-check'), download = $('#updates-download'), automatic = $('#set-auto-updates');
  $('#updates-version').textContent = `Installed: ${state.version || '—'} · Community${latest ? ' · Published: ' + latest : ''}`;
  $('#updates-status').textContent = ({ idle: 'Check for the latest published build.', checking: 'Checking for updates…', available: 'A new build is available.', current: 'You have the latest published build.', ahead: 'Your installed build is newer than the published build.', unsupported: 'No published update for this platform.', error: update.error })[update.status || 'idle'];
  $('#updates-checked').textContent = update.lastChecked ? 'Last checked: ' + new Date(update.lastChecked).toLocaleString() : 'Not checked yet.';
  check.hidden = false;
  check.disabled = update.status === 'checking';
  automatic.disabled = false;
  download.hidden = update.status !== 'available';
  $('#update-badge').hidden = update.status !== 'available';
  $('#updates-notes').textContent = update.latest?.notes || '';
}

function renderSettings() {
  renderUpdates();
  const st = state.settings ?? {};
  const num = (id, v) => { const el = $(id); if (el) el.value = v ?? 0; };
  const chk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  chk('#set-auto-updates', st.autoCheckUpdates);

  // connection
  chk('#set-upnp', st.upnpEnabled);
  chk('#set-dht', st.dhtEnabled);
  num('#set-maxconns', st.maxConns);
  const tr = $('#set-trackers'); if (tr && document.activeElement !== tr) tr.value = st.extraTrackers ?? '';
  updateConnectionFacts();

  // bandwidth
  num('#set-down', st.downLimitKBs);
  num('#set-up', st.upLimitKBs);
  num('#set-altdown', st.altDownKBs);
  num('#set-altup', st.altUpKBs);
  $('#set-bandwidth-mode').value = state.rates?.mode || st.bandwidthMode || 'normal';
  chk('#set-sched', (state.rates?.mode || st.bandwidthMode) === 'schedule' && st.schedEnabled);
  const from = $('#set-schedfrom'); if (from) from.value = st.schedFrom || '18:00';
  const to = $('#set-schedto'); if (to) to.value = st.schedTo || '08:00';
  renderDaypick(st.schedDays);
  const altState = $('#alt-state');
  if (altState) altState.hidden = !state.rates?.alt;

  // queueing & seeding
  num('#set-maxdl', st.maxActiveDownloads);
  num('#set-ratio', st.seedRatioStop);
  num('#set-seedmin', st.seedMinutesStop);
  chk('#set-seed', st.seedOnComplete);

  // folders
  const dir = $('#set-dir'); if (dir) dir.value = st.downloadDir ?? '';
  chk('#set-move', st.moveCompleted);
  const comp = $('#set-completed'); if (comp) comp.value = st.completedDir ?? '';
  const cat = $('#set-caturl'); if (cat && document.activeElement !== cat) cat.value = st.catalogUrl ?? '';

  // interface
  const themeSel = $('#set-theme'); if (themeSel) themeSel.value = store.get('theme', st.theme ?? 'frost');
  chk('#set-bigpull', st.confirmBigPull);
  num('#set-bigpull-gb', st.bigPullGB);
  chk('#set-confirmexit', st.confirmExitSeeding);
  chk('#set-cardimages', st.modelCardImages !== false);
  renderConfirmations();
  chk('#set-login', st.openAtLogin);
  const appdir = $('#set-appdir'); if (appdir) appdir.value = state.appDir ?? '';

  if (typeof renderPublisherSettings === 'function') renderPublisherSettings();

  const ts = $('#hftoken-status');
  if (ts) {
    const t = state.hfToken ?? {};
    ts.innerHTML = t.needsReconnect
      ? 'An older plaintext token was removed for safety. Add your token again to store it with operating-system encryption.'
      : t.present
      ? `Token saved for <b>${esc(t.user || 'unknown user')}</b>${t.role ? ` · role: ${esc(t.role)}` : ''}.`
      : 'No token set.';
  }

  const pl = state.platform === 'darwin' ? 'macOS' : state.platform === 'win32' ? 'Windows' : 'Linux';
  $('#about-line').textContent =
    `Frost/Byte ${state.version ?? ''} on ${pl}. Peer-to-peer sharing for open model weights. `
    + `Licensed by Blackfrost_AI; third-party licenses remain in effect. See Help → Licenses and Third-Party Notices. `
    + `No analytics, diagnostics, or automatic feedback collection. Transfers go directly to your chosen sources and peers.`;
}

function renderDaypick(days) {
  const wrap = $('#daypick');
  if (!wrap) return;
  const d = Array.isArray(days) && days.length === 7 ? days : [1, 1, 1, 1, 1, 1, 1];
  wrap.innerHTML = DAYS.map((label, i) =>
    `<button type="button" data-day="${i}" class="${d[i] ? 'on' : ''}" title="${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][i]}">${label}</button>`
  ).join('');
  wrap.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const cur = [...wrap.querySelectorAll('button')].map((x) => (x.classList.contains('on') ? 1 : 0));
    cur[+b.dataset.day] ^= 1;
    b.classList.toggle('on');
    await saveSettings({ schedDays: cur });
  }));
}

/** Persist a patch and let main apply what it can live. */
async function saveSettings(patch) {
  const r = await api.setSettings(patch);
  if (r.ok) applyState(r.data?.cancelled ? r.data.state : r.data);
  else {
    toast(r.error, 'error');
    const current = await api.getState();
    if (current.ok) applyState(current.data);
  }
  return r.ok && !r.data?.cancelled;
}

/** Number/time inputs save on change; a light debounce keeps typing smooth. */
function bindSettingInput(sel, key, { transform } = {}) {
  const el = $(sel);
  if (!el) return;
  let timer = null;
  const commit = () => { clearTimeout(timer); if (el.checkValidity()) return saveSettings({ [key]: transform ? transform(el.value) : el.value }); };
  el.addEventListener('change', commit);
  el.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.checkValidity?.()) commit(); }, 650);
  });
}

function bindSettingsView() {
  $$('[data-community]').forEach(link => {
    const url = COMMUNITY_LINKS[link.dataset.community];
    link.href = url;
    link.addEventListener('click', async event => {
      event.preventDefault();
      // Main reports handoff failures through the shared notice event.
      try { await api.openExternal(url); } catch (error) { toast(error.message, 'error'); }
    });
  });
  $$('.dens').forEach(button => button.addEventListener('click', () => applyDensity(button.dataset.d)));
  $$('.lv').forEach(button => button.addEventListener('click', () => applyListView(button.dataset.lv)));
  $$('[data-lv-switch]').forEach(button => button.addEventListener('click', () => applyListView(isSheet() ? 'cards' : 'sheet')));
  $('#set-auto-updates').addEventListener('change', event => saveSettings({ autoCheckUpdates: event.target.checked }));
  $('#updates-check').addEventListener('click', async () => { const result = await api.checkUpdates(); if (result.ok) { state.updates = result.data; renderUpdates(); } });
  $('#updates-download').addEventListener('click', () => api.downloadUpdate());
  api.onUpdates(value => { state.updates = value; renderUpdates(); });
  // section nav
  $$('#settings-nav .snav').forEach((b) => b.addEventListener('click', () => {
    if (settingsSection === 'publisher' && b.dataset.sec !== 'publisher') concealPublisher();
    settingsSection = b.dataset.sec;
    $$('#settings-nav .snav').forEach((o) => o.classList.toggle('on', o === b));
    $$('.ssec').forEach((sec) => { sec.hidden = sec.id !== 'sec-' + settingsSection; });
    if (settingsSection === 'hub') renderHubProfile();
  }));

  const n = (v) => Math.max(0, Number(v) || 0);

  // connection
  $('#set-upnp').addEventListener('change', (e) => saveSettings({ upnpEnabled: e.target.checked }));
  $('#set-dht').addEventListener('change', (e) => saveSettings({ dhtEnabled: e.target.checked }));
  bindSettingInput('#set-maxconns', 'maxConns', { transform: n });
  $('#set-trackers').addEventListener('change', (e) => saveSettings({ extraTrackers: e.target.value }));

  // bandwidth
  bindSettingInput('#set-down', 'downLimitKBs', { transform: n });
  bindSettingInput('#set-up', 'upLimitKBs', { transform: n });
  bindSettingInput('#set-altdown', 'altDownKBs', { transform: n });
  bindSettingInput('#set-altup', 'altUpKBs', { transform: n });
  $('#set-bandwidth-mode').addEventListener('change', e => saveSettings({ bandwidthMode: e.target.value, ...(e.target.value === 'schedule' ? { schedEnabled: true } : {}) }));
  $('#set-sched').addEventListener('change', e => saveSettings({ schedEnabled: e.target.checked, bandwidthMode: e.target.checked ? 'schedule' : 'normal' }));
  $('#set-unlimited').addEventListener('click', () => openModal({ title: 'Use unlimited sharing on this computer?',
    sub: 'Remove software bandwidth and download-queue caps, ignore ALT schedules, and disable automatic ratio/time stops. Completed downloads will keep sharing. Previously paused items stay paused; no new files are added to sharing.',
    body: '<p>Spark and other devices are unchanged. Your saved ALT values remain available if you explicitly select ALT again.</p>',
    actions: [{ label: 'Cancel', kind: 'btn' }, { label: 'Use unlimited sharing', kind: 'btn primary', onClick: async () => {
      if (await saveSettings({ bandwidthMode: 'normal', downLimitKBs: 0, upLimitKBs: 0, maxActiveDownloads: 0, seedRatioStop: 0, seedMinutesStop: 0, seedOnComplete: true })) {
        closeModal(); toast('Unlimited sharing enabled on this computer. Manually paused items stay paused.');
      }
    } }] }));
  bindSettingInput('#set-schedfrom', 'schedFrom');
  bindSettingInput('#set-schedto', 'schedTo');

  // queueing & seeding
  bindSettingInput('#set-maxdl', 'maxActiveDownloads', { transform: n });
  bindSettingInput('#set-ratio', 'seedRatioStop', { transform: (v) => Math.max(0, Number(v) || 0) });
  bindSettingInput('#set-seedmin', 'seedMinutesStop', { transform: n });
  $('#set-seed').addEventListener('change', async (e) => {
    if (await saveSettings({ seedOnComplete: e.target.checked })) {
      toast(e.target.checked
        ? 'Finished downloads will keep sharing.'
        : 'Finished downloads will stop sharing (already-finished ones are unaffected).');
    }
  });

  // folders
  $('#btn-changedir').addEventListener('click', async () => {
    const dir = await api.pickSaveDir();
    if (!dir) return;
    if (await saveSettings({ downloadDir: dir })) { $('#set-dir').value = dir; toast('Downloads now go to ' + dir); }
  });
  $('#btn-opendir').addEventListener('click', () => api.reveal(state.settings?.downloadDir ?? '.'));
  $('#set-move').addEventListener('change', (e) => saveSettings({ moveCompleted: e.target.checked }));
  $('#btn-changecompleted').addEventListener('click', async () => {
    const dir = await api.pickCompletedDir();
    if (dir && await saveSettings({ completedDir: dir, moveCompleted: true })) { $('#set-move').checked = true; $('#set-completed').value = dir; }
  });
  $('#btn-savecaturl').addEventListener('click', async () => {
    const url = $('#set-caturl').value.trim();
    if (!url) return;
    const r = await api.importCatalogUrl(url);
    if (r.ok && !r.data?.cancelled) { applyState(r.data); toast('Catalog loaded.'); } else if (!r.ok) toast(r.error, 'error');
  });

  // interface
  $('#theme-credit').onclick = event => { const url = event.currentTarget.dataset.url; if (url) api.openExternal(url).catch(() => toast('Could not open that link.', 'error')); };
  $('#ipfs-clear-cache').onclick = async event => { event.target.disabled = true; try { const result = await api.ipfsClearCache(); toast(result.ok ? 'Unneeded IPFS receive blocks cleared. Your files were kept.' : result.error, result.ok ? undefined : 'error'); } finally { event.target.disabled = false; } };
  // Only persist local appearance after the authoritative settings write has
  // succeeded. A failed write must not leave a different theme on next launch.
  const changeAppearance = async patch => {
    const controls = [$('#set-theme')];
    controls.forEach(control => { control.disabled = true; });
    try {
      if (await saveSettings(patch)) {
        if (patch.theme) applyTheme(state.settings.theme);
        renderSettings();
      }
    } catch (error) {
      toast(error.message || 'Could not save appearance.', 'error');
    } finally {
      controls.forEach(control => { control.disabled = false; });
      renderSettings();
    }
  };
  $('#set-theme').addEventListener('change', e => changeAppearance({ theme: e.target.value }));
  $('#set-bigpull').addEventListener('change', (e) => saveSettings({ confirmBigPull: e.target.checked }));
  $('#set-cardimages').addEventListener('change', (e) => saveSettings({ modelCardImages: e.target.checked }));
  bindSettingInput('#set-bigpull-gb', 'bigPullGB', { transform: n });
  $('#set-confirmexit').addEventListener('change', (e) => saveSettings({ confirmExitSeeding: e.target.checked }));
  api.onConfirmations(value => { state.confirmations = value; renderConfirmations(); });
  $('#reset-confirmations').addEventListener('click', async event => {
    event.target.disabled = true;
    try {
      const result = await api.resetConfirmations();
      if (result.ok) { state.confirmations = result.data; toast('Remembered choices reset. FrostByte will ask again.'); }
      else toast(result.error, 'error');
    } catch (error) { toast(error.message || 'Could not reset remembered choices.', 'error'); }
    finally { renderConfirmations(); }
  });
  $('#set-login').addEventListener('change', async (e) => {
    if (await saveSettings({ openAtLogin: e.target.checked })) {
      toast(e.target.checked ? 'Will start with the computer.' : 'Will not start with the computer.');
    }
  });
  $('#btn-openappdir').addEventListener('click', () => api.reveal(state.appDir ?? '.'));
  $('#btn-hftoken').addEventListener('click', async () => {
    const tok = $('#set-hftoken').value.trim();
    if (!tok) return toast('Paste a token first.', 'error');
    const r = await api.hfSetToken(tok);
    if (r.ok && !r.data.cancelled) {
      $('#set-hftoken').value = '';
      const st = await api.getState();
      if (st.ok) applyState(st.data);
      renderSettings();
      toast(`Token validated — signed in as ${r.data.user}.`);
    } else if (!r.ok) toast(r.error, 'error');
  });
  $('#btn-hfclear').addEventListener('click', async () => {
    const r = await api.hfSetToken('');
    if (r.ok && !r.data.cancelled) { await refresh(); renderSettings(); renderHfTokenState(); toast('Token removed.'); }
  });

  bindPublisherSettings();

  // status-bar turtle
  $('#turtle').addEventListener('click', async () => {
    const r = await api.toggleTurtle();
    if (r.ok) { applyState(r.data.state); updateTurtle(); }
    else toast(r.error, 'error');
  });
}


/* ============================== PUBLISHER ============================== */

let publisherRevealId = null;
let publisherRevealTimer = null;
let publisherGeneration = 0;
let publisherBusy = false;
let publisherNativeReview = false;

const publisherActive = () => ui.tab === 'settings' && settingsSection === 'publisher' && !document.hidden;
const publisherSecretFields = ['#pub-create-pass', '#pub-create-pass2', '#pub-import-mnemonic', '#pub-import-pass', '#pub-unlock-pass'];

function clearPublisherInputs() {
  for (const selector of publisherSecretFields) if ($(selector)) $(selector).value = '';
}

function renderPublisherSettings() {
  const p = state.publisher ?? {};
  const showing = !!publisherRevealId;
  const unavailable = p.available === false;
  const status = $('#publisher-status');
  if (status) status.textContent = p.invalid
    ? 'The saved identity cannot be read. Keep your recovery phrase before removing it to restore.'
    : unavailable ? 'Unlock your operating system key store to create or use a publisher identity.'
    : !p.present ? 'No publisher identity yet.'
    : `${p.username} · ${p.fingerprint} · ${p.backupRequired ? 'Backup required' : p.unlocked ? 'Unlocked for this session' : 'Locked'}`;
  if ($('#publisher-create-card')) $('#publisher-create-card').hidden = !!p.present || showing;
  if ($('#publisher-import-card')) $('#publisher-import-card').hidden = !!p.present || showing;
  if ($('#publisher-session-card')) $('#publisher-session-card').hidden = !p.present || showing;
  for (const id of ['btn-pub-create', 'btn-pub-import']) if ($('#' + id)) $('#' + id).disabled = publisherBusy || unavailable;
  if ($('#btn-pub-unlock')) $('#btn-pub-unlock').disabled = publisherBusy || unavailable || p.invalid || !p.present || p.backupRequired || p.unlocked;
  if ($('#btn-pub-lock')) $('#btn-pub-lock').disabled = publisherBusy || !p.unlocked;
  if ($('#btn-pub-export')) {
    $('#btn-pub-export').disabled = publisherBusy || unavailable || p.invalid || !p.present;
    $('#btn-pub-export').textContent = p.backupRequired ? 'Finish recovery backup' : 'Show recovery phrase';
  }
  if ($('#btn-pub-clear')) $('#btn-pub-clear').disabled = publisherBusy;
  if ($('#btn-pub-copy')) $('#btn-pub-copy').disabled = publisherBusy || !showing;
  if ($('#btn-pub-reveal-done')) $('#btn-pub-reveal-done').disabled = publisherBusy || !showing || !$('#pub-backup-ack')?.checked;
  if ($('#publisher-backup-note')) {
    $('#publisher-backup-note').hidden = !p.backupRequired;
    $('#publisher-backup-note').textContent = p.needsProtection
      ? 'Enter your password to protect this identity with this computer’s key store and confirm your recovery backup.'
      : 'Setup is saved, but backup is unfinished. Enter your password to show the phrase and finish your backup.';
  }
  // Keep the Hub profile card's binding state in step with lock/unlock.
  renderHubProfile();
}

function concealPublisher({ cancelPending = true } = {}) {
  if (cancelPending) publisherGeneration++;
  clearTimeout(publisherRevealTimer); publisherRevealTimer = null;
  const id = publisherRevealId; publisherRevealId = null;
  if ($('#pub-reveal-mnemonic')) $('#pub-reveal-mnemonic').value = '';
  if ($('#pub-backup-ack')) $('#pub-backup-ack').checked = false;
  if ($('#publisher-reveal-card')) $('#publisher-reveal-card').hidden = true;
  clearPublisherInputs();
  if (id) void api.publisherCloseReveal(id).catch(() => {});
  renderPublisherSettings();
}

function showPublisherRecovery(data) {
  publisherRevealId = data.revealId;
  $('#pub-reveal-mnemonic').value = data.mnemonic;
  $('#pub-backup-ack').checked = false;
  $('#publisher-reveal-card').hidden = false;
  clearTimeout(publisherRevealTimer);
  publisherRevealTimer = setTimeout(() => {
    concealPublisher();
    toast('Recovery phrase hidden. Enter your password to show it again.');
  }, Math.max(0, Math.min(60_000, data.expiresAt - Date.now())));
  renderPublisherSettings();
}

async function publisherAction(action, { reveal = false, nativeReview = false, message = '' } = {}) {
  if (publisherBusy) return;
  publisherBusy = true; publisherNativeReview = nativeReview;
  const generation = publisherGeneration;
  renderPublisherSettings();
  try {
    const result = await action();
    publisherNativeReview = false;
    clearPublisherInputs();
    if (!result.ok) return toast(result.error, 'error');
    if (result.data?.cancelled) return;
    const current = await api.getState();
    if (current.ok) applyState(current.data);
    if (generation !== publisherGeneration || !publisherActive()) {
      if (result.data?.revealId) await api.publisherCloseReveal(result.data.revealId);
      return;
    }
    if (reveal) showPublisherRecovery(result.data);
    else if (message) toast(message);
  } catch (error) { toast(error.message, 'error'); }
  finally {
    publisherBusy = false; publisherNativeReview = false;
    clearPublisherInputs(); renderPublisherSettings();
  }
}

function bindPublisherSettings() {
  $('#pub-backup-ack')?.addEventListener('change', renderPublisherSettings);
  $('#btn-pub-reveal-done')?.addEventListener('click', async () => {
    if (!$('#pub-backup-ack')?.checked || !publisherRevealId) return;
    const revealId = publisherRevealId;
    await publisherAction(async () => {
      const result = await api.publisherAcknowledgeBackup({ revealId });
      if (result.ok) concealPublisher({ cancelPending: false });
      return result;
    }, { message: 'Recovery backup confirmed.' });
  });
  $('#btn-pub-copy')?.addEventListener('click', async () => {
    const phrase = $('#pub-reveal-mnemonic')?.value;
    if (!publisherRevealId || !phrase) return;
    try { if (await api.copyText(phrase)) toast('Copied. Your clipboard may retain the phrase; clear it after saving your backup.'); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#btn-pub-create')?.addEventListener('click', async () => {
    const petname = $('#pub-create-name')?.value.trim() || '';
    const password = $('#pub-create-pass')?.value || '';
    if (password !== $('#pub-create-pass2')?.value) { clearPublisherInputs(); return toast('Passwords do not match.', 'error'); }
    await publisherAction(() => api.publisherCreate({ petname, password }), { reveal: true });
  });
  $('#btn-pub-import')?.addEventListener('click', async () => {
    const request = { mnemonic: $('#pub-import-mnemonic')?.value || '',
      petname: $('#pub-import-name')?.value.trim() || '', password: $('#pub-import-pass')?.value || '' };
    await publisherAction(() => api.publisherImport(request), { reveal: true });
  });
  $('#btn-pub-unlock')?.addEventListener('click', async () => {
    const password = $('#pub-unlock-pass')?.value || '';
    await publisherAction(() => api.publisherUnlock(password), { message: 'Publisher unlocked for this session.' });
  });
  $('#btn-pub-lock')?.addEventListener('click', async () => {
    concealPublisher();
    await publisherAction(() => api.publisherLock(), { message: 'Publisher locked.' });
  });
  $('#btn-pub-export')?.addEventListener('click', async () => {
    const password = $('#pub-unlock-pass')?.value || '';
    if (!password) return toast('Enter your password first.', 'error');
    await publisherAction(() => api.publisherExportMnemonic(password), { reveal: true, nativeReview: true });
  });
  $('#btn-pub-clear')?.addEventListener('click', async () => {
    await publisherAction(() => api.publisherClear(), { nativeReview: true, message: 'Publisher identity removed.' });
  });
  window.addEventListener('blur', () => concealPublisher({ cancelPending: !publisherNativeReview }));
  window.addEventListener('pagehide', () => concealPublisher());
  document.addEventListener('visibilitychange', () => { if (document.hidden) concealPublisher(); });
  renderPublisherSettings();
}

/* ============================== HUGGINGFACE ============================== */

let HF_EMPTY_DEFAULT = '';
let HF_THEAD_DEFAULT = '';
const PF_THEAD_HTML = '<tr><th data-k="name">Model</th><th data-k="seeds" class="num">Seeders</th><th data-k="size" class="num">Size</th><th>Revision</th><th>Infohash</th></tr>';
const PF_EMPTY_DEFAULT = '<h3>Search Pirate Face torrents</h3><p>Find open-model torrents indexed on pirateface.co, or pick a quick search chip above. Every magnet goes through FrostByte’s torrent review.</p>';
const hfUi = {
  provider: 'hf',     // 'hf' | 'pirateface' | 'frostnet' (note: hfUi.source is HF vs hybrid download mode)
  results: [],
  selected: null,     // model info for the detail panel
  revision: 'main', refs: null,
  selectedFiles: new Set(),
  fileFilter: '',
  fileKind: '', fileSort: 'name',
  options: [],
  customOpen: false,
  optionFilter: '',
  formatFilter: '',
  starting: false,
  target: 'mac',
  sortKey: null, sortDir: -1,
  hubSort: 'downloads', hubDirection: -1, cursor: null, query: '', searchOptions: {}, request: 0, searched: false,
  searching: false,
  pfResults: [],
  pfSearched: false,
  pfQuery: '',
  pfSortKey: 'seeds',
  pfSortDir: -1,
  pfSelected: null,
  pfSearchSeq: 0,
  pfDetailSeq: 0,
  pfSearching: false,
  hfFiltersWasOpen: false,
};

function fmtAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso ?? 0);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days < 1) return 'today';
  if (days < 30) return `${days} d`;
  if (days < 365) return `${Math.floor(days / 30)} mo`;
  return `${Math.floor(days / 365)} yr`;
}

function renderHfTokenState() {
  const el = $('#hf-tokenstate');
  if (!el) return;
  const t = state.hfToken ?? {};
  if (t.present) {
    el.textContent = `token: ${t.user || 'saved'}${t.role ? ` (${t.role})` : ''}`;
    el.className = 'hf-tokenstate ok';
  } else {
    el.textContent = t.needsReconnect ? 'reconnect token — old plaintext removed' : 'no token — gated models locked';
    el.className = 'hf-tokenstate warn';
  }
  el.hidden = hfUi.provider !== 'hf';
  if (hfUi.provider === 'hf' && hfUi.selected) renderHfDetail(); // refresh gated hint in the panel
}

function hfSearchOptions() {
  return { limit: 40, sort: hfUi.hubSort, direction: hfUi.hubDirection,
    author: $('#hf-author').value.trim(), pipeline_tag: $('#hf-task').value,
    format: $('#hf-search-format').value, library: $('#hf-library').value,
    license: $('#hf-license').value, language: $('#hf-language').value, gated: $('#hf-access-filter').value };
}

// Owner/name split so the owner reads like a byline, as on huggingface.co.
function hfRepoName(id) {
  const text = String(id || '');
  const slash = text.indexOf('/');
  return slash < 0 ? `<b>${esc(text)}</b>` : `<span class="owner">${esc(text.slice(0, slash))}/</span><b>${esc(text.slice(slash + 1))}</b>`;
}

// Deterministic owner monogram; no remote avatar fetch.
function hfAvatar(id) {
  const owner = String(id || '?').split('/')[0] || '?';
  let hash = 0;
  for (const ch of owner) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `<span class="hf-avatar" aria-hidden="true" style="--hue:${hash % 360}">${esc(owner.slice(0, 1).toUpperCase())}</span>`;
}

const hfCount = (n) => {
  const value = Number(n) || 0;
  return value >= 1e6 ? `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k` : String(value);
};

/** Weight-format badges (EXL3/NVFP4 highlighted). Detected from tags and repo name, so they are hints. */
function hfFormatBadges(model) {
  const formats = detectHfFormats(model);
  if (!formats.length) return '';
  return `<div class="hf-formats">${formats.map(f => `<span class="fmt${f.primary ? ' primary' : ''}" data-format="${esc(f.id)}">${esc(f.label)}</span>`).join('')}</div>`;
}

function hfRenderFormatChips() {
  const current = $('#hf-search-format').value;
  $('#hf-format-chips').innerHTML = [{ id: '', label: 'All formats', primary: false }, ...HF_FORMAT_CHIPS].map(chip =>
    `<button type="button" class="hf-chip${chip.primary ? ' primary' : ''}" data-format="${esc(chip.id)}" aria-pressed="${current === chip.id}">${esc(chip.label)}</button>`).join('');
}

async function hfDoSearch(more = false) {
  more = more === true;
  if (more && (hfUi.searching || !hfUi.cursor)) return;
  // A pasted huggingface.co link or org/name opens that model directly instead of searching for it.
  const reference = more ? null : parseHfReference($('#hf-q').value);
  if (reference) {
    ++hfUi.request;
    // Reset search UI state so an in-flight search's finally (now stale) cannot
    // leave "Searching…" stuck or Load-more disabled after we open the model.
    hfUi.searching = false;
    $('#hf-go').textContent = 'Search';
    $('#hf-more').disabled = false;
    $('#hf-more').textContent = 'Load more';
    return hfSelect(reference.repo, reference.revision || 'main');
  }
  const request = ++hfUi.request;
  const q = more ? hfUi.query : $('#hf-q').value.trim();
  const options = more ? { ...hfUi.searchOptions, cursor: hfUi.cursor } : hfSearchOptions();
  hfUi.searching = true;
  $('#hf-go').textContent = 'Searching…';
  $('#hf-more').disabled = true;
  $('#hf-more').textContent = more ? 'Loading…' : 'Load more';
  try {
    const r = await api.hfSearch(q, options);
    if (request !== hfUi.request) return;
    if (r.ok && r.data?.cancelled) return;
    if (r.ok) {
      const models = Array.isArray(r.data) ? r.data : r.data.models;
      hfUi.results = [...new Map([...(more ? hfUi.results : []), ...models].map(m => [m.id, m])).values()];
      hfUi.cursor = r.data.cursor || null;
      hfUi.query = q; hfUi.searchOptions = options; hfUi.searched = true;
      if (!more) {
        ++hfSelectionRequest;
        hfUi.sortKey = null;
        hfUi.selected = null;
        hfUi.selectedFiles.clear();
        $('#hf-detail').hidden = true;
        $('#grid-hf').closest('.gridwrap').scrollTop = 0;
      }
      renderHfResults();
    } else toast(r.error, 'error');
  } catch (error) { if (request === hfUi.request) toast(error.message, 'error');
  } finally {
    if (request === hfUi.request) {
      hfUi.searching = false;
      $('#hf-go').textContent = 'Search';
      $('#hf-more').disabled = false;
      $('#hf-more').textContent = 'Load more';
    }
  }
}

function renderHfResults() {
  const rows = [...hfUi.results].sort((a, b) => {
    let x = a[hfUi.sortKey], y = b[hfUi.sortKey];
    if (!hfUi.sortKey) return 0;
    if (['id', 'license', 'pipelineTag'].includes(hfUi.sortKey)) return hfUi.sortDir * String(x || '').localeCompare(String(y || ''));
    if (hfUi.sortKey === 'lastModified') { x = Date.parse(x) || 0; y = Date.parse(y) || 0; }
    return hfUi.sortDir * (Number(x || 0) - Number(y || 0));
  });
  $('#hf-count').textContent = `${rows.length} result${rows.length === 1 ? '' : 's'} loaded${hfUi.cursor ? ' · more available' : ''}`;
  $('#hf-pagination').hidden = !hfUi.cursor;
  $('#hf-sort-scope').textContent = hfUi.sortKey ? 'Column sort · loaded results only' : 'Sorted across the Hub';
  $$('#grid-hf th[data-k]').forEach(th => {
    const key = hfUi.sortKey || hfUi.hubSort;
    th.setAttribute('aria-sort', th.dataset.k === key ? ((hfUi.sortKey ? hfUi.sortDir : hfUi.hubDirection) === 1 ? 'ascending' : 'descending') : 'none');
  });
  const tb = $('#grid-hf tbody');
  tb.innerHTML = rows.map((m) => `
    <tr data-id="${esc(m.id)}" tabindex="0" aria-label="View ${esc(m.id)}" aria-expanded="${hfUi.selected?.id === m.id}" class="${hfUi.selected?.id === m.id ? 'selrow' : ''}">
      <td>
        <div class="hf-card">
          ${hfAvatar(m.id)}
          <div class="hf-card-body">
            <div class="mname">
              <span class="nm" title="${esc(m.id)}">${hfRepoName(m.id)}</span>
              ${m.gated === 'manual' ? '<span class="gatechip manual">gated·manual</span>'
                : m.gated === 'auto' ? '<span class="gatechip auto">gated·auto</span>' : ''}
            </div>
            ${hfFormatBadges(m)}
          </div>
        </div>
      </td>
      <td class="num mono">${hfCount(m.downloads)}</td>
      <td class="num mono">${hfCount(m.likes)}</td>
      <td><span class="chip lic ${LICENSE_CLASS(m.license)}">${esc(m.license || '—')}</span></td>
      <td><span class="chip tag">${esc(m.pipelineTag || '—')}</span></td>
      <td class="mono" title="${esc(m.lastModified)}" style="color:var(--text-dim)">${fmtAgo(m.lastModified)}</td>
    </tr>`).join('');
  const emptyHf = $('#empty-hf');
  emptyHf.hidden = rows.length > 0;
  if (!rows.length) {
    emptyHf.innerHTML = hfUi.searched
      ? `<h3>No matching models</h3><p>Try a shorter query or clear some filters.</p>`
      : HF_EMPTY_DEFAULT;
  }
  tb.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => hfSelect(tr.dataset.id));
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hfSelect(tr.dataset.id); }
    });
  });
}

let hfSelectionRequest = 0;
function hfDetailTitle(title) {
  return `<div class="hf-detail-title"><h3>${esc(title)}</h3><button class="btn sm hf-detail-close" data-hf-close aria-label="Close model details" title="Close model details (Esc)">✕</button></div>`;
}

function pfRowKey(m) {
  if (!m) return '';
  return m.infoHash ? `${m.repoId}#${m.infoHash}` : String(m.repoId || '');
}

function closeHfDetail() {
  const selectedId = hfUi.selected?.id;
  const pfSelectedKey = pfRowKey(hfUi.pfSelected?.summary);
  ++hfSelectionRequest;
  ++hfUi.pfDetailSeq;
  hfUi.selected = null;
  hfUi.pfSelected = null;
  hfUi.selectedFiles.clear();
  $('#hf-detail').hidden = true;
  $('#hf-detail').innerHTML = '';
  if (hfUi.provider === 'pirateface') {
    renderPfResults();
    if (pfSelectedKey) $(`#grid-hf tr[data-pf-key="${CSS.escape(pfSelectedKey)}"]`)?.focus({ preventScroll: true });
  } else {
    renderHfResults();
    if (selectedId) $(`#grid-hf tr[data-id="${CSS.escape(selectedId)}"]`)?.focus({ preventScroll: true });
  }
}

async function hfSelect(repoId, revision = 'main', refs = null) {
  if (hfUi.provider !== 'hf') return;
  const request = ++hfSelectionRequest;
  hfUi.selected = null;
  hfUi.fileFilter = '';
  hfUi.fileKind = ''; hfUi.fileSort = 'name';
  hfUi.optionFilter = '';
  hfUi.formatFilter = '';
  hfUi.customOpen = false;
  hfUi.revision = revision; hfUi.refs = refs;
  $('#hf-detail').hidden = false;
  $('#hf-detail').innerHTML = `${hfDetailTitle(repoId)}<p class="hf-selinfo">Loading files…</p>`;
  const r = await api.hfModel(repoId, revision);
  if (request !== hfSelectionRequest || hfUi.provider !== 'hf') return;
  if (r.ok && r.data?.cancelled) {
    $('#hf-detail').innerHTML = `${hfDetailTitle(repoId)}<p class="hf-selinfo">Authenticated request cancelled.</p>`;
    return;
  }
  if (!r.ok) { $('#hf-detail').innerHTML = `${hfDetailTitle(repoId)}<p class="hf-selinfo" style="color:var(--danger)">${esc(r.error)}</p>`; return; }
  hfUi.selected = r.data;
  hfUi.options = buildHfOptions(r.data.files);
  const available = hfUi.options.filter(option => !option.incomplete && !option.auxiliary);
  // A sole variant can be ready immediately. Multiple variants need an explicit choice.
  hfUi.selectedFiles = new Set(available.length === 1 ? available[0].paths : []);
  hfUi.customOpen = hfUi.options.length === 0;
  renderHfResults();
  renderHfDetail();
}

function hfSizeLabel(files) {
  const { bytes, unknown } = selectionSize(files);
  return unknown ? (bytes ? `${fmtBytes(bytes)} + unknown` : 'Size unavailable') : fmtBytes(bytes);
}

function hfChosenOption() {
  return hfUi.options.find(option => !option.incomplete && option.paths.length === hfUi.selectedFiles.size
    && option.paths.every(path => hfUi.selectedFiles.has(path)));
}

// ── Model card (README) ──────────────────────────────────────────────────────
// The card is rendered locally by src/shared/markdown.js into a fixed tag allowlist; nothing from the README runs.
// Images are fetched by the main process (HTTPS, public addresses only, size-capped) and shown via blob: URLs.
const hfCardCache = new Map();          // `${repo}@${revision}` -> Promise<{ok, data}>
const hfCardImageCache = new Map();     // url -> Promise<Blob|null>
let hfCardImageBytes = 0;
const HF_CARD_IMAGE_BUDGET = 96 * 1024 * 1024;
const hfCardImageQueue = [];
let hfCardImageActive = 0;

function showHfDetailPane(pane) {
  hfUi.detailTab = ['card', 'serve'].includes(pane) ? pane : 'download';
  for (const tab of document.querySelectorAll('#hf-detail [data-hf-pane]')) tab.setAttribute('aria-selected', String(tab.dataset.hfPane === hfUi.detailTab));
  for (const name of ['card', 'download', 'serve']) { const el = $(`#hf-pane-${name}`); if (el) el.hidden = hfUi.detailTab !== name; }
  if (hfUi.detailTab === 'card' && hfUi.selected) loadHfCard(hfUi.selected);
  if (hfUi.detailTab === 'serve') renderHfServe();
}

// Serve recipes come from the bundled vLLM/SGLang registry snapshot. Commands are only displayed for copying.
function hfServeResult() {
  const m = hfUi.selected;
  if (!m) return null;
  const spark = hfUi.target === 'spark';
  const saved = modelLifecycle(m.id, { inventory: downloadedInventory() }).saved
    .find(entry => spark ? entry.device === 'spark' && (!entry.deviceId || entry.deviceId === hfUi.deviceId) : entry.device !== 'spark');
  return { ...serveOptions(m, { target: spark ? 'spark' : 'local', localPath: saved?.path || '' }), savedPath: saved?.path || '', spark };
}
function renderHfServe() {
  const host = $('#hf-pane-serve');
  const result = hfServeResult();
  if (!host || !result) return;
  const where = result.spark ? remoteName(hfUi.deviceId) : localDeviceLabel();
  const src = SERVE_REGISTRY_SOURCES;
  const provenance = `<p class="hf-help hf-serve-source">Support list bundled from vLLM <code>${esc(src.vllm.commit.slice(0, 8))}</code> and SGLang <code>${esc(src.sglang.commit.slice(0, 8))}</code>. FrostByte doesn’t run these commands for you. Copy them to a terminal on the host.</p>`;
  const renderEngine = engine => `
    <section class="hf-serve-engine" data-serve-engine="${esc(engine.id)}">
      <header><b>${esc(engine.label)}</b><span class="hf-tag">${esc(engine.architecture)}</span><span class="hf-tag quant">${esc(engine.image)}</span></header>
      ${engine.notes.map(note => `<p class="hf-serve-note">${esc(note)}</p>`).join('')}
      <div class="hf-serve-step"><span>1 · ${engine.container ? 'Pull the image' : 'Install / Prepare'}</span><button class="hf-link" data-serve-copy="pull" data-engine="${esc(engine.id)}">Copy</button></div>
      <pre class="hf-serve-cmd">${esc(engine.pull)}</pre>
      <div class="hf-serve-step"><span>2 · Start the server</span><button class="hf-link" data-serve-copy="run" data-engine="${esc(engine.id)}">Copy</button></div>
      <pre class="hf-serve-cmd">${esc(engine.run)}</pre>
      <p class="hf-help">OpenAI-compatible API at <code>${esc(engine.endpoint)}</code>.${engine.container ? ` Stop it with <code>docker rm -f ${esc(engine.container)}</code>.` : ''}</p>
    </section>`;
  const altSection = result.alternatives?.length
    ? `<div class="hf-serve-alternatives"><h4>Local / quantized runners (${result.alternatives.map(a => esc(a.label)).join(', ')})</h4>${result.alternatives.map(renderEngine).join('')}</div>`
    : '';
  if (result.status !== 'supported') {
    host.innerHTML = `<div class="hf-serve-empty" data-serve-status="${esc(result.status)}"><b>${result.status === 'unknown' ? 'Serving support unknown' : 'Not servable with vLLM or SGLang'}</b><p>${esc(result.reason)}</p>${result.architectures.length ? `<p class="hf-help">Architecture: <code>${esc(result.architectures.join(', '))}</code></p>` : ''}</div>${altSection}${provenance}`;
  } else {
    host.innerHTML = `
      <p class="hf-help">Commands for <b>${esc(where)}</b>${result.savedPath ? ' using the saved copy on that device' : ', downloading weights into the Hugging Face cache on first start'}. Change the target under Download to switch device.</p>
      ${result.engines.map(renderEngine).join('')}
      ${altSection}
      ${provenance}`;
  }
  host.onclick = async event => {
    const button = event.target.closest('[data-serve-copy]');
    const res = hfServeResult();
    const allEngines = [...(res?.engines || []), ...(res?.alternatives || [])];
    const engine = button && allEngines.find(item => item.id === button.dataset.engine);
    if (!engine) return;
    try { if (await api.copyText(button.dataset.serveCopy === 'pull' ? engine.pull : engine.run)) toast('Command copied.'); } catch { toast('Could not copy. Try again.', 'error'); }
  };
}

function hfCardPage(m) {
  return 'https://huggingface.co/' + m.id.split('/').map(encodeURIComponent).join('/');
}

function cardImageBlob(url) {
  if (hfCardImageCache.has(url)) return hfCardImageCache.get(url);
  const pending = new Promise(resolve => { hfCardImageQueue.push({ url, resolve }); pumpCardImages(); });
  hfCardImageCache.set(url, pending);
  return pending;
}

function pumpCardImages() {
  while (hfCardImageActive < 4 && hfCardImageQueue.length) {
    const { url, resolve } = hfCardImageQueue.shift();
    hfCardImageActive++;
    api.hfCardImage(url).then(result => {
      if (!result?.ok || !result.data?.data) { hfCardImageCache.delete(url); resolve(null); return; }
      const blob = new Blob([result.data.data], { type: result.data.mime });
      hfCardImageBytes += blob.size;
      if (hfCardImageBytes > HF_CARD_IMAGE_BUDGET) { hfCardImageCache.clear(); hfCardImageBytes = blob.size; }
      hfCardImageCache.set(url, Promise.resolve(blob));
      resolve(blob);
    }, () => { hfCardImageCache.delete(url); resolve(null); }).finally(() => { hfCardImageActive--; pumpCardImages(); });
  }
}

async function showCardImage(slot, image) {
  slot.classList.add('loading');
  const blob = await cardImageBlob(image.url);
  if (!slot.isConnected) return;
  slot.classList.remove('loading');
  if (!blob) { slot.classList.add('failed'); slot.textContent = image.alt || 'Image unavailable'; slot.title = 'This image could not be loaded.'; return; }
  const img = document.createElement('img');
  const objectUrl = URL.createObjectURL(blob);
  img.alt = image.alt || '';
  img.decoding = 'async';
  img.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
  img.addEventListener('error', () => { URL.revokeObjectURL(objectUrl); slot.classList.add('failed'); slot.textContent = image.alt || 'Image unavailable'; }, { once: true });
  img.src = objectUrl;
  slot.textContent = '';
  slot.classList.add('loaded');
  slot.append(img);
}

function wireCardImages(host, images) {
  const enabled = state.settings?.modelCardImages !== false;
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const image = images[Number(entry.target.dataset.image)];
        if (image) showCardImage(entry.target, image);
      }
    }, { root: host.closest('.hf-detail-body') || null, rootMargin: '400px 0px' })
    : null;
  for (const slot of host.querySelectorAll('.md-img')) {
    const image = images[Number(slot.dataset.image)];
    if (!image) continue;
    let hostname = '';
    try { hostname = new URL(image.url).hostname; } catch { continue; }
    slot.title = image.alt ? `${image.alt} · ${hostname}` : hostname;
    if (!enabled) { slot.classList.add('off'); continue; }
    if (isHfImageHost(hostname)) {
      if (observer) observer.observe(slot); else showCardImage(slot, image);
      continue;
    }
    // Third-party host: loading it reveals your IP address to that site, so wait for a click.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-img-load';
    button.textContent = `Load image from ${hostname}`;
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); showCardImage(slot, image); }, { once: true });
    slot.classList.add('external');
    slot.textContent = image.alt ? `${image.alt} ` : '';
    slot.append(button);
  }
}

async function loadHfCard(m) {
  const host = $('#hf-pane-card');
  if (!host || !m) return;
  const revision = m.sha || hfUi.revision || 'main';
  const key = `${m.id}@${revision}`;
  if (host.dataset.loaded === key) return;
  host.dataset.loaded = key;
  host.innerHTML = '<p class="hf-selinfo">Loading model card…</p>';
  let pending = hfCardCache.get(key);
  if (!pending) {
    pending = api.hfReadme(m.id, revision);
    hfCardCache.set(key, pending);
    if (hfCardCache.size > 24) hfCardCache.delete(hfCardCache.keys().next().value);
  }
  const result = await pending;
  if (hfUi.selected !== m || !host.isConnected) return;
  const pageLink = '<button class="hf-link" data-card-page>Open on Hugging Face ↗</button>';
  if (!result?.ok) {
    hfCardCache.delete(key);
    host.dataset.loaded = '';
    host.innerHTML = `<div class="md-card-state"><p>Couldn’t load the model card: ${esc(result?.error || 'unknown error')}</p><button class="btn sm" data-card-retry>Try again</button> ${pageLink}</div>`;
  } else if (result.data?.restricted) {
    host.innerHTML = `<div class="md-card-state"><p>The publisher shows this model card only to accounts that have been granted access.</p>${pageLink}</div>`;
  } else if (!result.data?.text?.trim()) {
    host.innerHTML = `<div class="md-card-state"><p>This repository doesn’t have a model card yet.</p>${pageLink}</div>`;
  } else {
    const out = renderMarkdown(result.data.text, { repo: m.id, revision });
    const truncated = out.truncated || result.data.truncated;
    host.innerHTML = `<div class="md-card-bar"><span>Rendered on this computer from README.md · ${esc(String(revision).slice(0, 12))}</span>${pageLink}</div>`
      + (truncated ? '<p class="hf-help">This model card is very long. Only the first part is shown here.</p>' : '')
      + `<article class="md">${out.html}</article>`;
    wireCardImages(host, out.images);
  }
  host.querySelector('[data-card-retry]')?.addEventListener('click', () => loadHfCard(m));
  host.querySelector('[data-card-page]')?.addEventListener('click', () => api.openExternal(hfCardPage(m)));
}

function wireHfCardLinks() {
  const detail = $('#hf-detail');
  if (!detail || detail.dataset.cardLinks) return;
  detail.dataset.cardLinks = '1';
  detail.addEventListener('click', event => {
    const link = event.target.closest?.('a.md-link');
    if (!link || !detail.contains(link)) return;
    event.preventDefault();
    const href = link.dataset.href;
    if (href && /^https?:\/\//i.test(href)) api.openExternal(href);
  });
}

function renderHfDetail() {
  wireHfCardLinks();
  hfUi.deviceId ||= selectedDeviceId();
  hfUi.peerDeviceId ||= selectedDeviceId();
  if (!['card', 'serve'].includes(hfUi.detailTab)) hfUi.detailTab = 'download';
  hfUi.sparkDestination = sparkDownloadRoot(hfUi.sparkDestination, hfUi.deviceId);
  const m = hfUi.selected;
  const panel = $('#hf-detail');
  if (!m) { panel.hidden = true; return; }
  const formats = [...new Set(hfUi.options.map(option => option.format))];
  panel.innerHTML = `
    <div class="hf-head">
      <div class="hf-eyebrow">Download model</div>
      ${hfDetailTitle(m.id)}
      <div class="hf-meta">
        <span class="gatechip ${m.gated ? esc(m.gated) : 'open'}">${m.gated ? 'Access required' : 'Public model'}</span>
        <span>${esc(m.license || 'License unknown')}</span>
        <button class="hf-link" id="hf-source">Model page ↗</button>
        <button class="hf-link" id="hf-copy-link">Copy link</button>
        <button class="hf-link" id="hf-check-pf" type="button">Pirate Face torrent</button>
      </div>
      <div id="hf-lifecycle" class="hf-lifecycle" aria-live="polite"></div>
      ${(() => { const serve = hfServeResult(); return serve?.engines.length ? `<div class="hf-serve-buttons">${serve.engines.map(engine => `<button class="btn sm hf-serve-btn" data-serve-open="${esc(engine.id)}">Serve with ${esc(engine.label)}</button>`).join('')}</div>` : ''; })()}
      <div class="hf-revision">${hfUi.refs ? `<label>Version <select id="hf-revision" aria-label="Repository version">${hfUi.refs.map(ref => `<option value="${esc(ref.name)}" ${ref.name === hfUi.revision ? 'selected' : ''}>${esc(ref.name)} · ${esc(ref.type)}</option>`).join('')}</select></label>` : '<button class="hf-link" id="hf-revisions">Version: main ▾</button>'}<span title="Downloads stay pinned to this commit">${esc(m.sha?.slice(0, 8))}</span></div>
    </div>
    <div class="hf-detail-tabs" role="tablist" aria-label="Model details">
      <button class="hf-detail-tab" role="tab" id="hf-tab-download" data-hf-pane="download" aria-controls="hf-pane-download" aria-selected="${hfUi.detailTab === 'download'}">Download</button>
      <button class="hf-detail-tab" role="tab" id="hf-tab-card" data-hf-pane="card" aria-controls="hf-pane-card" aria-selected="${hfUi.detailTab === 'card'}">Model card</button>
      <button class="hf-detail-tab" role="tab" id="hf-tab-serve" data-hf-pane="serve" aria-controls="hf-pane-serve" aria-selected="${hfUi.detailTab === 'serve'}">Serve</button>
    </div>
    <div class="hf-detail-body">
      <div class="hf-pane md-card" id="hf-pane-card" role="tabpanel" aria-labelledby="hf-tab-card" ${hfUi.detailTab === 'card' ? '' : 'hidden'}></div>
      <div class="hf-pane" id="hf-pane-serve" role="tabpanel" aria-labelledby="hf-tab-serve" ${hfUi.detailTab === 'serve' ? '' : 'hidden'}></div>
      <div class="hf-pane" id="hf-pane-download" role="tabpanel" aria-labelledby="hf-tab-download" ${hfUi.detailTab === 'download' ? '' : 'hidden'}>
      ${m.gated ? `<div class="hf-access"><b>${state.hfToken?.present ? 'Check model access' : 'Connect your HuggingFace account'}</b>
        <p>${state.hfToken?.present ? 'Your account needs access granted by the publisher. You can check it on the model page.' : 'This publisher requires access. Add your token and accept the model terms on HuggingFace.'}</p>
        ${!state.hfToken?.present ? '<button class="btn sm" id="hf-connect">Add token</button>' : ''}</div>` : ''}
      <label class="download-target" ${hfUi.target === 'spark' ? 'hidden' : ''}>Download sources <select id="hf-download-sources" aria-label="Download sources"><option value="hf">HuggingFace only</option><option value="hybrid" ${!state.settings.sparkHost || m.gated ? 'disabled' : ''}>HF + ${esc(remoteName(hfUi.peerDeviceId))} (beta)</option></select></label>
      <p class="hf-help" id="hf-hybrid-help" hidden>Uses matching public files with Sharing on at your selected device. HF fills missing pieces. This download does not upload; enable Sharing after completion if wanted. Your device sees the requested file and your network address.</p>
      <div class="hf-section-heading"><h4>Choose your download</h4><span>${hfUi.options.length} option${hfUi.options.length === 1 ? '' : 's'}</span></div>
      <p class="hf-help">${hfUi.options.length ? 'Choose one version. Split weight files are included together.' : 'Choose the files you need from this repository below.'}</p>
      <button class="btn sm" id="hf-configs">Just configs &amp; tokenizer</button>
      ${hfUi.options.some(option => option.format === 'GGUF' && !option.auxiliary) ? '<p class="hf-help">GGUF versions offer different sizes and precision. Check your runner’s model support before choosing.</p>' : ''}
      ${formats.length > 1 || hfUi.options.length > 6 ? `<div class="hf-option-tools">
        ${hfUi.options.length > 6 ? '<label class="search"><span class="mag">⌕</span><input id="hf-option-filter" aria-label="Filter download options" placeholder="Find a version, e.g. Q4_K_M" /></label>' : ''}
        ${formats.length > 1 ? `<select id="hf-format" aria-label="Download format"><option value="">All formats</option>${formats.map(format => `<option>${esc(format)}</option>`).join('')}</select>` : ''}
      </div>` : ''}
      <div id="hf-options" class="hf-options" role="radiogroup" aria-label="Download version"></div>
      <details id="hf-custom" class="hf-custom" ${hfUi.customOpen ? 'open' : ''}>
        <summary>Customize files <span>${m.files.length} files in repository</span></summary>
        <p class="hf-help">Review what’s included or make your own selection.</p>
        <div class="hf-filetools">
          <label class="search"><span class="mag">⌕</span><input id="hf-ffilter" aria-label="Filter repository files" placeholder="Search filenames…" value="${esc(hfUi.fileFilter)}" /></label>
          <button class="hf-link" id="hf-pick-visible">Select shown</button>
          <button class="hf-link" id="hf-pick-none">Clear selection</button>
          <select id="hf-file-kind" aria-label="File type"><option value="">All file types</option><option value="config">Configs &amp; tokenizer</option><option value="weights">Weights</option><option value="docs">Documentation</option></select>
          <select id="hf-file-sort" aria-label="Sort repository files"><option value="name">Name A–Z</option><option value="small">Smallest first</option><option value="large">Largest first</option></select>
        </div>
        <div class="hf-file-count" id="hf-file-count"></div>
        <div class="hf-files" id="hf-files"></div>
      </details>
      </div>
    </div>
    <div class="hf-checkout">
      <div class="hf-checkout-top"><strong id="hf-choice-name"></strong><span id="hf-selinfo" aria-live="polite"></span></div>
      <label class="download-target">Download on <select id="hf-target" aria-label="HuggingFace download device">${downloadDeviceOptions()}</select></label>
      <label class="download-target spark-download-folder" ${hfUi.target === 'spark' ? '' : 'hidden'}>Folder on the device <select id="hf-spark-destination" aria-label="HuggingFace folder on the device">${sparkStorageOptions(hfUi.sparkDestination, hfUi.deviceId)}</select></label>
      <div class="hf-destination" ${hfUi.target === 'spark' ? 'hidden' : ''}><span>Save to</span><span title="${esc(state.settings?.downloadDir)}">${esc(state.settings?.downloadDir || 'Your download folder')}</span><button class="hf-link" id="hf-folder">Change</button></div>
      <button class="btn primary" id="hf-download"></button>
      <p class="hf-checkout-note">Resumable download from HuggingFace</p>
    </div>`;

  const hfPageUrl = 'https://huggingface.co/' + m.id.split('/').map(encodeURIComponent).join('/');
  $('#hf-source').addEventListener('click', () => api.openExternal(hfPageUrl));
  $('#hf-copy-link').addEventListener('click', async () => {
    try { if (await api.copyText(hfPageUrl)) toast('Model link copied.'); } catch { toast('Could not copy. Try again.', 'error'); }
  });
  $('#hf-check-pf')?.addEventListener('click', () => switchToPirateFaceForRepo(m.id));
  $('#hf-lifecycle').addEventListener('click', event => { const link = event.target.closest('[data-hf-goto]'); if (link) goTab(link.dataset.hfGoto === 'transfers' ? 'transfers' : 'library'); });
  renderHfLifecycle();
  $('#hf-target').value = hfUi.target === 'spark' ? hfUi.deviceId || selectedDeviceId() : 'mac';
  $('#hf-download-sources').value = hfUi.source === 'hybrid' && state.settings.sparkHost && !m.gated ? 'hybrid' : 'hf';
  $('#hf-hybrid-help').hidden = $('#hf-download-sources').value !== 'hybrid' || hfUi.target === 'spark';
  $('#hf-download-sources').addEventListener('change', event => { hfUi.source = event.target.value; $('#hf-hybrid-help').hidden = hfUi.source !== 'hybrid'; });
  $('#hf-target').addEventListener('change', e => { hfUi.target = e.target.value === 'mac' ? 'mac' : 'spark'; hfUi.deviceId = e.target.value === 'mac' ? selectedDeviceId() : e.target.value; hfUi.sparkDestination = sparkDownloadRoot('', hfUi.deviceId); renderHfDetail(); });
  $('#hf-spark-destination').addEventListener('change', e => { hfUi.sparkDestination = e.target.value; updateHfSelection(); });
  $('#hf-revisions')?.addEventListener('click', async e => {
    e.target.disabled = true;
    const result = await api.hfRefs(m.id);
    if (hfUi.selected !== m) return;
    if (result.ok && result.data?.cancelled) e.target.disabled = false;
    else if (result.ok) { hfUi.refs = result.data.length ? result.data : [{ name: hfUi.revision, type: 'Branch' }]; renderHfDetail(); }
    else { e.target.disabled = false; toast(result.error, 'error'); }
  });
  $('#hf-revision')?.addEventListener('change', e => hfSelect(m.id, e.target.value, hfUi.refs));
  $('#hf-connect')?.addEventListener('click', () => { goTab('settings'); $('#settings-nav [data-sec="hftoken"]').click(); $('#set-hftoken').focus(); });
  $('#hf-folder').addEventListener('click', async () => {
    const dir = await api.pickSaveDir();
    if (dir && await saveSettings({ downloadDir: dir }) && hfUi.selected?.id === m.id) renderHfDetail();
  });
  $('#hf-custom').addEventListener('toggle', e => { hfUi.customOpen = e.target.open; });
  for (const tab of panel.querySelectorAll('[data-hf-pane]')) tab.addEventListener('click', () => showHfDetailPane(tab.dataset.hfPane));
  if (hfUi.detailTab === 'card') loadHfCard(m);
  if (hfUi.detailTab === 'serve') renderHfServe();
  for (const button of panel.querySelectorAll('[data-serve-open]')) button.addEventListener('click', () => {
    showHfDetailPane('serve');
    $(`#hf-pane-serve [data-serve-engine="${button.dataset.serveOpen}"]`)?.scrollIntoView({ block: 'start' });
  });
  $('#hf-configs').addEventListener('click', () => {
    hfUi.selectedFiles = new Set(m.files.filter(f => hfFileKind(f.path) === 'config').map(f => f.path));
    hfUi.customOpen = true; hfUi.fileKind = 'config'; hfUi.fileFilter = '';
    $('#hf-custom').open = true; $('#hf-file-kind').value = 'config'; $('#hf-ffilter').value = '';
    renderHfFiles();
    $('#hf-custom').scrollIntoView({ block: 'nearest' });
  });
  $('#hf-file-kind').value = hfUi.fileKind;
  $('#hf-file-sort').value = hfUi.fileSort;
  $('#hf-file-kind').addEventListener('change', e => { hfUi.fileKind = e.target.value; renderHfFiles(); });
  $('#hf-file-sort').addEventListener('change', e => { hfUi.fileSort = e.target.value; renderHfFiles(); });
  $('#hf-ffilter').addEventListener('input', e => { hfUi.fileFilter = e.target.value; renderHfFiles(); });
  $('#hf-option-filter')?.addEventListener('input', e => { hfUi.optionFilter = e.target.value; renderHfOptions(); });
  $('#hf-format')?.addEventListener('change', e => { hfUi.formatFilter = e.target.value; renderHfOptions(); });
  if ($('#hf-option-filter')) $('#hf-option-filter').value = hfUi.optionFilter;
  if ($('#hf-format')) $('#hf-format').value = hfUi.formatFilter;
  $('#hf-pick-visible').addEventListener('click', () => {
    for (const file of hfVisibleFiles()) hfUi.selectedFiles.add(file.path);
    updateHfSelection();
  });
  $('#hf-pick-none').addEventListener('click', () => { hfUi.selectedFiles.clear(); updateHfSelection(); });
  $('#hf-download').addEventListener('click', () => hfStartDownload(m));
  renderHfOptions();
  renderHfFiles();
  updateHfSelection();
}

function renderHfOptions() {
  const options = hfUi.options.filter(option => (!hfUi.formatFilter || option.format === hfUi.formatFilter)
    && `${option.label} ${option.detail}`.toLowerCase().includes(hfUi.optionFilter.toLowerCase()));
  const groups = groupVariants(options, hfUi.selected || {}, { memoryBytes: hfTargetMemory() });
  const optionHtml = ({ option, quant, fit, recommended }) => {
    const bundleChip = !option.incomplete && !option.auxiliary
      ? `<span class="hf-tag bundle">${option.weightCount > 1 ? `All ${option.weightCount} shards` : 'Complete weights'}${option.supportCount ? ` + ${option.supportCount} config${option.supportCount === 1 ? '' : 's'}` : ''}</span>`
      : '';
    return `
    <label class="hf-option ${option.incomplete ? 'unavailable' : ''}">
      <input type="radio" name="hf-version" value="${esc(option.id)}" ${option.incomplete ? 'disabled' : ''} />
      <span class="hf-option-copy"><span class="hf-option-top"><strong>${esc(option.label)}</strong><span class="hf-option-size">${option.unknown ? (option.bytes ? fmtBytes(option.bytes) + ' + ?' : 'Size unknown') : fmtBytes(option.bytes)}</span></span>
        <span class="hf-option-chips">${quant && quant !== option.label ? `<span class="hf-tag quant">${esc(quant)}</span>` : ''}${recommended ? '<span class="hf-tag recommended">Recommended</span>' : ''}${bundleChip}${fit ? `<span class="hf-tag fit-${esc(fit.level)}">${esc(fit.text)}</span>` : ''}</span>
        <span class="hf-option-format">${esc(option.format)} · ${esc(option.description)}</span>
        <span class="hf-option-path" title="${esc(option.detail)}">${esc(option.detail)}</span>
      </span>
    </label>`;
  };
  $('#hf-options').innerHTML = groups.map(group => `
    <section class="hf-variant-group ${group.primary ? 'primary' : ''}" data-variant-group="${esc(group.id)}">
      <header class="hf-variant-head"><span class="fmt${group.primary ? ' primary' : ''}" data-format="${esc(group.id)}">${esc(group.label)}</span><span>${esc(group.blurb)}</span><span class="hf-variant-count">${group.items.length}</span></header>
      ${group.items.map(optionHtml).join('')}
    </section>`).join('') || (hfUi.options.length ? '<p class="hf-help">No versions match. Try another filter.</p>' : '');
  $('#hf-options').querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
    const option = hfUi.options.find(option => option.id === input.value);
    if (!option || option.incomplete) return;
    hfUi.selectedFiles = new Set(option.paths);
    updateHfSelection();
  }));
  updateHfSelection();
}

// Memory of the device the download targets, used only for a fit hint. Unknown memory means no hint.
function hfTargetMemory() {
  const hardware = hfUi.target === 'spark' ? deviceById(hfUi.deviceId)?.status?.hardware : state.localDevice;
  return Number(hardware?.memoryBytes) || 0;
}
function renderHfLifecycle() {
  if (hfUi.provider !== 'hf') return;
  const host = $('#hf-lifecycle');
  const m = hfUi.selected;
  if (!host || !m) return;
  const life = modelLifecycle(m.id, { transfers: hfTransfers(), inventory: downloadedInventory() });
  const where = row => row.device === 'spark' ? remoteName(row.deviceId) : localDeviceLabel();
  const parts = life.downloading.map(row => `<span class="hf-life-chip ${esc(row.status)}">${row.status === 'error' ? 'Download issue' : row.status === 'paused' ? 'Paused' : 'Downloading'} on ${esc(where(row))}${row.progress === null ? '' : ` · ${Math.floor(row.progress * 100)}%`}</span>`);
  const savedOn = [...new Set(life.saved.map(where))];
  if (savedOn.length) parts.push(`<span class="hf-life-chip saved">Saved on ${esc(savedOn.join(', '))}</span>`);
  host.hidden = !parts.length;
  host.innerHTML = parts.length ? `${parts.join('')}${life.saved.length ? '<button class="hf-link" data-hf-goto="library">Share from Library</button>' : ''}${life.downloading.length ? '<button class="hf-link" data-hf-goto="transfers">View transfers</button>' : ''}` : '';
  host.dataset.state = life.state;
}

function hfFileKind(name) {
  if (/\.(gguf|safetensors|bin|pt|pth|onnx|h5|msgpack)$/i.test(name)) return 'weights';
  if (/\.(md|rst|pdf)$/i.test(name) || /(^|\/)(license|notice)/i.test(name)) return 'docs';
  if (/\.(json|ya?ml|toml|ini|cfg|model|tiktoken|jinja|jinja2)$/i.test(name) || /(^|\/)(merges|vocab|tokenizer|special_tokens)[^/]*\.(txt|bpe)$/i.test(name)) return 'config';
  return 'other';
}
function hfVisibleFiles() {
  return hfUi.selected.files.filter(file => file.path.toLowerCase().includes(hfUi.fileFilter.toLowerCase()) && (!hfUi.fileKind || hfFileKind(file.path) === hfUi.fileKind))
    .sort((a, b) => hfUi.fileSort === 'name' ? a.path.localeCompare(b.path) : (hfUi.fileSort === 'small' ? 1 : -1) * (a.size - b.size) || a.path.localeCompare(b.path));
}

function renderHfFiles() {
  const files = hfVisibleFiles();
  const entries = groupRepoFilesForBrowser(files);
  const shardGroupCount = entries.filter(entry => entry.type === 'shard-group').length;
  $('#hf-file-count').textContent = `${files.length} of ${hfUi.selected.files.length} files shown${shardGroupCount ? ` (${shardGroupCount} split shard set${shardGroupCount === 1 ? '' : 's'} grouped)` : ''}`;
  const fileRowHtml = file => `
    <label class="hf-file">
      <input type="checkbox" data-f="${esc(file.path)}" />
      <span class="fname" title="${esc(file.path)}">${esc(file.path)}</span>
      <span class="fsize">${file.size ? fmtBytes(file.size) : 'Unknown'}</span>
    </label>`;
  $('#hf-files').innerHTML = entries.map(entry => {
    if (entry.type !== 'shard-group') return fileRowHtml(entry.file);
    const sizeText = entry.unknown ? (entry.bytes ? fmtBytes(entry.bytes) + ' + ?' : 'Size unknown') : fmtBytes(entry.bytes);
    return `
      <div class="hf-shard-group" data-shard-group="${esc(entry.id)}">
        <div class="hf-file hf-shard-head">
          <label class="hf-shard-toggle">
            <input type="checkbox" data-shard-all="${esc(entry.id)}" />
            <span class="fname" title="${esc(entry.stem)}">${esc(entry.stem)} · <strong>${entry.files.length} shards</strong></span>
          </label>
          <button type="button" class="hf-link hf-shard-expand" data-shard-expand="${esc(entry.id)}" aria-expanded="false">Show ${entry.files.length} shards ▾</button>
          <span class="fsize">${sizeText}</span>
        </div>
        <div class="hf-shard-parts" hidden>
          ${entry.files.map(fileRowHtml).join('')}
        </div>
      </div>`;
  }).join('') || '<p class="hf-help">No matching files. Try a shorter filename.</p>';
  $('#hf-files').querySelectorAll('[data-shard-expand]').forEach(btn => btn.addEventListener('click', () => {
    const group = btn.closest('[data-shard-group]');
    const parts = group?.querySelector('.hf-shard-parts');
    if (!parts) return;
    parts.hidden = !parts.hidden;
    const count = parts.querySelectorAll('input[data-f]').length;
    btn.textContent = `${parts.hidden ? 'Show' : 'Hide'} ${count} shards ${parts.hidden ? '▾' : '▴'}`;
    btn.setAttribute('aria-expanded', String(!parts.hidden));
  }));
  $('#hf-files').querySelectorAll('input[data-f]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) hfUi.selectedFiles.add(input.dataset.f);
    else hfUi.selectedFiles.delete(input.dataset.f);
    updateHfSelection();
  }));
  $('#hf-files').querySelectorAll('input[data-shard-all]').forEach(input => input.addEventListener('change', () => {
    const group = entries.find(entry => entry.type === 'shard-group' && entry.id === input.dataset.shardAll);
    if (!group) return;
    for (const path of group.paths) {
      if (input.checked) hfUi.selectedFiles.add(path);
      else hfUi.selectedFiles.delete(path);
    }
    updateHfSelection();
  }));
  updateHfSelection();
}

function updateHfSelection() {
  const m = hfUi.selected;
  if (!m || !$('#hf-download')) return;
  const files = m.files.filter(file => hfUi.selectedFiles.has(file.path));
  const chosen = hfChosenOption();
  $$('#hf-options input').forEach(input => {
    input.checked = input.value === chosen?.id;
    input.closest('.hf-option').classList.toggle('selected', input.checked);
  });
  $$('#hf-files input[data-f]').forEach(input => {
    input.checked = hfUi.selectedFiles.has(input.dataset.f);
    input.closest('.hf-file').classList.toggle('selected', input.checked);
  });
  $$('#hf-files input[data-shard-all]').forEach(input => {
    const container = input.closest('[data-shard-group]');
    const shardInputs = container ? [...container.querySelectorAll('input[data-f]')] : [];
    const checkedCount = shardInputs.filter(child => hfUi.selectedFiles.has(child.dataset.f)).length;
    input.checked = shardInputs.length > 0 && checkedCount === shardInputs.length;
    input.indeterminate = checkedCount > 0 && checkedCount < shardInputs.length;
    input.closest('.hf-file')?.classList.toggle('selected', input.checked);
  });
  $('#hf-choice-name').textContent = chosen?.label || (files.length ? 'Custom selection' : 'Choose a version above');
  $('#hf-selinfo').textContent = `${files.length} file${files.length === 1 ? '' : 's'} selected`;
  const button = $('#hf-download');
  const destinationUnavailable = hfUi.target === 'spark' && !sparkRootAvailable(hfUi.sparkDestination, hfUi.deviceId);
  button.disabled = !files.length || hfUi.starting || Boolean(m.gated && !state.hfToken?.present) || destinationUnavailable;
  button.textContent = hfUi.starting ? 'Starting download…' : destinationUnavailable ? 'Choose an available device folder' : files.length ? `Download · ${hfSizeLabel(files)}` : 'Select files to download';
}

async function hfStartDownload(m) {
  if (hfUi.starting || (m.gated && !state.hfToken?.present)) return;
  const sel = m.files.filter(file => hfUi.selectedFiles.has(file.path));
  if (!sel.length) return;
  hfUi.starting = true;
  updateHfSelection();
  try {
    const { bytes } = selectionSize(sel);
    const target = hfUi.target;
    const deviceId = hfUi.deviceId || selectedDeviceId();
    const destination = target === 'spark' ? hfUi.sparkDestination : undefined;
    if (target === 'spark' && !sparkRootAvailable(destination, deviceId)) { toast('Choose an available storage folder on the device.', 'warn'); return; }
    if (bytes >= bigPullBytes()) {
      const confirmed = await askLargeDownload(`Download ${sel.length} file${sel.length === 1 ? '' : 's'} from ${m.id}?`,
        `${hfSizeLabel(sel)} · ${target === 'spark' ? destination + ' on the device' : state.settings?.downloadDir ?? 'Your download folder'}`);
      if (!confirmed) return;
    }
    // A saved credential is useful for public files too: authenticated Hub
    // downloads receive the account's rate limits instead of anonymous ones.
    const payload = { repoId: m.id, revision: m.sha || 'main', files: sel, ...(target === 'spark' ? { destination, deviceId, requiresToken: Boolean(state.hfToken?.present) } : { source: $('#hf-download-sources').value, peerDeviceId: hfUi.peerDeviceId || selectedDeviceId() }) };
    const r = target === 'spark' ? await api.sparkHfDownload(payload) : await api.hfDownload(payload);
    if (r.ok && r.data?.cancelled) return;
    if (r.ok) {
      if (target === 'mac') state.downloads = r.data.downloads;
      else if (deviceId === selectedDeviceId()) { sparkUi.root = destination; sparkUi.relative = ''; }
      toast(`Downloading ${sel.length} file${sel.length === 1 ? '' : 's'}${target === 'spark' ? ' on the device' : ''} from ${m.id}.`);
      clearDownloadSearch(); ui.transferDevice = 'all'; goTab('transfers');
      if (target === 'spark') refreshSpark(true);
    } else toast(r.error, 'error');
  } catch (error) {
    toast(error.message || 'Could not start this download. Try again.', 'error');
  } finally {
    hfUi.starting = false;
    updateHfSelection();
  }
}

function renderPfDhtBanner() {
  const banner = $('#pf-dht-banner');
  if (!banner) return;
  const dhtOff = state.settings?.dhtEnabled === false;
  const hasTrackers = Boolean(String(state.settings?.extraTrackers ?? '').trim());
  banner.hidden = hfUi.provider !== 'pirateface' || !(dhtOff && !hasTrackers);
}

function updatePfQuickChipHighlight(queryText) {
  const clean = String(queryText ?? '').trim().toLowerCase();
  $$('#pf-browsebar [data-pf-quick]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.pfQuick.toLowerCase() === clean));
  });
}

function setModelsProvider(provider) {
  const next = provider === 'pirateface' ? 'pirateface' : provider === 'frostnet' ? 'frostnet' : 'hf';
  if (hfUi.provider === next) return;

  ++hfUi.request;
  ++hfUi.pfSearchSeq;
  hfUi.searching = false;
  hfUi.pfSearching = false;
  if (hfUi.provider === 'hf') {
    hfUi.hfFiltersWasOpen = !$('#hf-filters').hidden;
  }

  ++hfSelectionRequest;
  ++hfUi.pfDetailSeq;
  hfUi.selected = null;
  hfUi.pfSelected = null;
  hfUi.selectedFiles.clear();
  $('#hf-detail').hidden = true;
  $('#hf-detail').innerHTML = '';

  hfUi.provider = next;

  $$('#hf-provider-switch [data-hf-provider]').forEach(btn => {
    const active = btn.dataset.hfProvider === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  // Target the HF/PF pane by id — #fn-wrap also carries .hf-wrap, so a bare
  // class selector would stamp the provider attribute on the hidden FrostNet
  // pane instead (P2 regression caught by app.spec alignment checks).
  $('#hf-wrap')?.setAttribute('data-provider', next);

  const isPf = next === 'pirateface';
  const isFn = next === 'frostnet';
  $('#hf-browsebar').hidden = isPf || isFn;
  $('#hf-format-chips').hidden = isPf || isFn;
  $('#hf-filters').hidden = (isPf || isFn) ? true : !hfUi.hfFiltersWasOpen;
  $('#hf-filter-toggle').setAttribute('aria-expanded', String(!$('#hf-filters').hidden));
  $('#hf-tokenstate').hidden = isPf || isFn;
  $('#pf-browsebar').hidden = !isPf;
  $('#fn-browsebar').hidden = !isFn;
  // FrostNet has its own results pane; the shared HF/PF pane hides for it.
  const hfWrap = $('#view-hf .hf-wrap:not(#fn-wrap)');
  if (hfWrap) hfWrap.hidden = isFn;
  const fnWrap = $('#fn-wrap');
  if (fnWrap) fnWrap.hidden = !isFn;
  if (isPf || isFn) $('#hf-pagination').hidden = true;
  if (!isFn) { frostnetUi?.closeDetail(); frostnetUi?.closePublish(); }

  const qInput = $('#hf-q');
  if (isPf) {
    qInput.placeholder = 'Search Pirate Face model torrents — qwen3, mlx, gguf, gemma, deepseek…';
    qInput.value = hfUi.pfQuery;
    $('#hf-go').textContent = 'Search';
    $('#grid-hf thead').innerHTML = PF_THEAD_HTML;
    updatePfQuickChipHighlight(hfUi.pfQuery);
    renderPfDhtBanner();
    renderPfResults();
  } else if (isFn) {
    qInput.placeholder = 'Search FrostNet recipes — qwen3, Q4_K_M (exact case), gguf…';
    qInput.value = '';
    $('#hf-go').textContent = 'Search';
    frostnetUi?.render();
  } else {
    qInput.placeholder = 'Search models, or paste a huggingface.co link — qwen3, llama 3.3 exl3, nvidia/…-NVFP4';
    qInput.value = hfUi.query;
    $('#hf-go').textContent = 'Search';
    $('#grid-hf thead').innerHTML = HF_THEAD_DEFAULT;
    renderHfTokenState();
    renderHfResults();
  }
}

async function pfDoSearch(overrideQuery) {
  if (hfUi.provider !== 'pirateface') setModelsProvider('pirateface');
  if (overrideQuery !== undefined) {
    $('#hf-q').value = String(overrideQuery);
  }
  const q = $('#hf-q').value.trim();
  updatePfQuickChipHighlight(q);
  const seq = ++hfUi.pfSearchSeq;
  closeHfDetail();

  if (!q) {
    hfUi.pfQuery = '';
    hfUi.pfResults = [];
    hfUi.pfSearched = false;
    renderPfResults();
    return;
  }

  hfUi.pfSearching = true;
  $('#hf-go').textContent = 'Searching…';
  try {
    const r = await api.pirateFaceSearch(q, { limit: 60 });
    if (seq !== hfUi.pfSearchSeq || hfUi.provider !== 'pirateface') return;
    if (r.ok && (r.data?.cancelled || r.data?.aborted)) return;
    if (r.ok) {
      hfUi.pfResults = Array.isArray(r.data?.models) ? r.data.models : [];
      hfUi.pfQuery = r.data?.query || q;
      hfUi.pfSearched = true;
      $('#grid-hf').closest('.gridwrap').scrollTop = 0;
      renderPfResults();
    } else {
      toast(r.error || 'Pirate Face search failed.', 'error');
    }
  } catch (error) {
    if (seq === hfUi.pfSearchSeq && hfUi.provider === 'pirateface') {
      toast(error.message || 'Pirate Face search failed.', 'error');
    }
  } finally {
    if (seq === hfUi.pfSearchSeq && hfUi.provider === 'pirateface') {
      hfUi.pfSearching = false;
      $('#hf-go').textContent = 'Search';
    }
  }
}

function renderPfResults() {
  if (hfUi.provider !== 'pirateface') return;
  const tb = $('#grid-hf tbody');
  const empty = $('#empty-hf');
  $('#hf-pagination').hidden = true;
  $('#hf-count').textContent = `${hfUi.pfResults.length} torrent${hfUi.pfResults.length === 1 ? '' : 's'} loaded`;
  $('#hf-sort-scope').textContent = 'Community torrent index · pirateface.co';

  const note = $('#pf-provenance-note');
  if (note) {
    note.textContent = hfUi.pfSearched
      ? `${hfUi.pfResults.length} torrent${hfUi.pfResults.length === 1 ? '' : 's'} for "${hfUi.pfQuery}" · pirateface.co (index-reported seeders)`
      : 'External index · pirateface.co · Peer discovery uses local DHT & trackers';
  }

  $$('#grid-hf thead th[data-k]').forEach(th => {
    const active = th.dataset.k === hfUi.pfSortKey;
    th.classList.toggle('sorted', active);
    th.setAttribute('aria-sort', active ? (hfUi.pfSortDir === 1 ? 'ascending' : 'descending') : 'none');
  });

  if (!hfUi.pfResults.length) {
    tb.innerHTML = '';
    empty.innerHTML = hfUi.pfSearched
      ? '<h3>No Pirate Face torrents matched</h3><p>Try another model family, or switch to HuggingFace above to browse all upstream repositories.</p>'
      : PF_EMPTY_DEFAULT;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const sorted = [...hfUi.pfResults].sort((a, b) => {
    const dir = hfUi.pfSortDir || -1;
    if (hfUi.pfSortKey === 'name') return dir * String(a.repoId || '').localeCompare(String(b.repoId || ''));
    if (hfUi.pfSortKey === 'size') return dir * ((a.sizeBytes ?? -1) - (b.sizeBytes ?? -1));
    return dir * ((a.seeds ?? 0) - (b.seeds ?? 0));
  });

  const selectedKey = pfRowKey(hfUi.pfSelected?.summary);
  tb.innerHTML = sorted.map(m => {
    const key = pfRowKey(m);
    return `
    <tr class="${selectedKey === key ? 'selrow' : ''}" data-pf-id="${esc(m.repoId)}" data-pf-key="${esc(key)}" tabindex="0" aria-label="View ${esc(m.repoId)} on Pirate Face" aria-expanded="${selectedKey === key}">
      <td>
        <div class="hf-card">
          ${hfAvatar(m.repoId)}
          <div class="hf-card-body">
            <div class="mname">
              <span class="nm" title="${esc(m.repoId)}">${hfRepoName(m.repoId)}</span>
              <span class="gatechip open">torrent</span>
              ${m.exceedsOneTiB ? '<span class="gatechip manual">&gt; 1 TiB cap</span>' : ''}
            </div>
            ${hfFormatBadges({ id: m.repoId, tags: [] })}
          </div>
        </div>
      </td>
      <td class="num mono">${esc(String(m.seeds ?? 0))}</td>
      <td class="num mono">${esc(m.sizeLabel || '—')}</td>
      <td class="mono dim">${m.revision ? esc(m.revision.slice(0, 8)) : '—'}</td>
      <td class="mono dim">${m.infoHash ? `${esc(m.infoHash.slice(0, 12))}…` : '—'}</td>
    </tr>`;
  }).join('');

  tb.querySelectorAll('tr[data-pf-key]').forEach(tr => {
    const rowModel = sorted.find(item => pfRowKey(item) === tr.dataset.pfKey);
    if (!rowModel) return;
    const open = () => pfSelect(rowModel, tr);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

async function pfSelect(summaryRow, tr, { quant = '', acceptTerms = '' } = {}) {
  if (hfUi.provider !== 'pirateface') return;
  const seq = ++hfUi.pfDetailSeq;
  const rowKey = pfRowKey(summaryRow);
  $$('#grid-hf tbody tr').forEach(r => { r.classList.remove('selrow'); r.setAttribute('aria-expanded', 'false'); });
  if (tr) { tr.classList.add('selrow'); tr.setAttribute('aria-expanded', 'true'); tr.dataset.loading = '1'; }
  else {
    const matchTr = $(`#grid-hf tbody tr[data-pf-key="${CSS.escape(rowKey)}"]`) || $(`#grid-hf tbody tr[data-pf-id="${CSS.escape(summaryRow.repoId)}"]`);
    if (matchTr) { matchTr.classList.add('selrow'); matchTr.setAttribute('aria-expanded', 'true'); matchTr.dataset.loading = '1'; }
  }

  const prevDetail = hfUi.pfSelected?.summary?.repoId === summaryRow.repoId ? hfUi.pfSelected.detail : null;
  hfUi.pfSelected = {
    summary: summaryRow,
    detail: prevDetail,
    loading: true,
    error: '',
    requestedQuant: quant,
  };
  renderPfDetail();

  const existingLicense = prevDetail?.licenseNotice;
  try {
    const r = await api.pirateFaceTorrents(summaryRow.repoId, {
      quant,
      acceptTerms,
      termsName: existingLicense?.name || '',
      termsUrl: existingLicense?.termsUrl || '',
      policyUrl: existingLicense?.policyUrl || '',
    });
    if (seq !== hfUi.pfDetailSeq || hfUi.provider !== 'pirateface') return;
    if (r.ok && (r.data?.cancelled || r.data?.aborted)) {
      hfUi.pfSelected.loading = false;
      renderPfDetail();
      return;
    }
    if (!r.ok) {
      hfUi.pfSelected.loading = false;
      hfUi.pfSelected.error = r.error || 'Could not load Pirate Face torrent metadata.';
      renderPfDetail();
      return;
    }
    hfUi.pfSelected.loading = false;
    hfUi.pfSelected.error = '';
    hfUi.pfSelected.detail = r.data;
    renderPfDetail();
  } catch (error) {
    if (seq !== hfUi.pfDetailSeq || hfUi.provider !== 'pirateface') return;
    hfUi.pfSelected.loading = false;
    hfUi.pfSelected.error = error.message || 'Could not load Pirate Face torrent metadata.';
    renderPfDetail();
  } finally {
    $$('#grid-hf tbody tr[data-loading]').forEach(row => { delete row.dataset.loading; });
  }
}

async function switchToHfAndOpenModel(repoId) {
  setModelsProvider('hf');
  $('#hf-q').value = repoId;
  await hfDoSearch(false);
  if (hfUi.provider !== 'hf') return;
  await hfSelect(repoId);
}

async function switchToPirateFaceForRepo(repoId) {
  setModelsProvider('pirateface');
  await pfDoSearch(repoId);
  if (hfUi.provider !== 'pirateface') return;
  const found = hfUi.pfResults.find(item => item.repoId.toLowerCase() === repoId.toLowerCase()) || {
    id: repoId,
    repoId,
    author: repoId.split('/')[0] || '',
    name: repoId.split('/')[1] || repoId,
    sizeLabel: '',
    sizeBytes: null,
    exceedsOneTiB: false,
    seeds: 0,
    infoHash: '',
    revision: '',
    provenanceHosts: [],
    canonicalMagnet: '',
  };
  await pfSelect(found, null);
}

function renderPfDetail() {
  const pane = $('#hf-detail');
  if (hfUi.provider !== 'pirateface' || !hfUi.pfSelected) { pane.hidden = true; return; }
  pane.hidden = false;

  const { summary, detail, loading, error, requestedQuant } = hfUi.pfSelected;
  const repoId = detail?.repoId || summary.repoId;
  const seeders = detail ? detail.seeders : (summary.seeds ?? 0);
  const leechers = detail ? detail.leechers : null;
  const revision = detail?.revision || summary.revision || '';
  const termsRequired = Boolean(detail?.termsRequired);
  const quantMismatch = Boolean(requestedQuant && detail?.quant && requestedQuant !== detail.quant);
  const magnetBlocked = termsRequired || loading || Boolean(error) || quantMismatch;
  const activeMagnet = magnetBlocked
    ? ''
    : (detail ? detail.canonicalMagnet : summary.canonicalMagnet);
  const activeHash = magnetBlocked
    ? ''
    : (detail ? detail.infoHash : summary.infoHash);
  const exceedsOneTiB = Boolean(detail?.exceedsOneTiB || summary.exceedsOneTiB);
  const license = detail?.licenseNotice || null;
  const hosts = (detail?.provenanceHosts?.length ? detail.provenanceHosts : summary.provenanceHosts) || [];
  const quants = Array.isArray(detail?.quants) ? detail.quants : [];
  const files = Array.isArray(detail?.files) ? detail.files : [];
  const sizeText = detail?.totalBytes != null ? fmtBytes(detail.totalBytes) : (summary.sizeLabel || 'Size listed on inspect');

  const hfPageUrl = 'https://huggingface.co/' + repoId.split('/').map(encodeURIComponent).join('/');

  pane.innerHTML = `
    <div class="hf-head">
      <div class="hf-eyebrow">Pirate Face · Community torrent</div>
      ${hfDetailTitle(repoId)}
      <div class="hf-meta">
        <span class="gatechip ${termsRequired || license?.acceptFirst ? 'manual' : 'open'}">${termsRequired ? 'Terms acknowledgement required' : (license?.acceptFirst ? 'Upstream license terms' : 'Community torrent')}</span>
        <span>${esc(String(seeders))} seed${seeders === 1 ? '' : 's'} (index-reported)${leechers != null ? ` · ${esc(String(leechers))} leecher${leechers === 1 ? '' : 's'}` : ''}</span>
        <span>${esc(sizeText)}</span>
        <button class="hf-link" type="button" data-pf-act="hf-web">Model page ↗</button>
        <button class="hf-link" type="button" data-pf-act="open-hf">HuggingFace view</button>
      </div>
      ${revision ? `<div class="hf-revision"><span>Pinned HF commit</span><span class="mono" title="${esc(revision)}">${esc(revision.slice(0, 12))}</span></div>` : ''}
    </div>
    <div class="hf-detail-body">
      ${loading ? '<p class="hf-help">Loading torrent manifest and license metadata from pirateface.co…</p>' : ''}
      ${error ? `<div class="hf-access"><b>Could not load extended torrent record</b><p>${esc(error)}</p></div>` : ''}
      ${termsRequired && license ? `
        <div class="hf-access">
          <b>${esc(license.name || 'Upstream license terms apply')}</b>
          <p>${esc(license.notice)}</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin:6px 0">
            ${license.termsUrl ? `<button class="hf-link" type="button" data-pf-act="terms-url">License terms ↗</button>` : ''}
            ${license.policyUrl ? `<button class="hf-link" type="button" data-pf-act="policy-url">Acceptable use policy ↗</button>` : ''}
          </div>
          <button class="btn sm" type="button" data-pf-act="accept-terms">Review &amp; acknowledge terms…</button>
        </div>` : (license?.acceptFirst ? `
        <div class="hf-access">
          <b>${esc(license.name)}</b>
          <p>${esc(license.notice)}</p>
        </div>` : (license?.notice ? `<p class="hf-help">${esc(license.notice)}</p>` : ''))}
      ${exceedsOneTiB ? `
        <div class="hf-access">
          <b>Exceeds FrostByte’s 1 TiB torrent safety cap</b>
          <p>Whole-repository torrents above 1 TiB are rejected by FrostByte’s safe torrent store. Switch to a smaller quantization below or open HuggingFace view to download individual files over HTTPS.</p>
        </div>` : ''}
      ${quants.length > 1 ? `
        <div class="pf-quant-bar">
          <label for="pf-quant-select">Variant</label>
          <select id="pf-quant-select" data-pf-quant-select aria-label="Pirate Face quantization variant">
            ${quants.map(q => `<option value="${esc(q.id)}" ${q.id === detail.quant ? 'selected' : ''}>${esc(q.label)} (${esc(String(q.fileCount))} file${q.fileCount === 1 ? '' : 's'})</option>`).join('')}
          </select>
        </div>` : ''}
      <div class="hf-section-heading"><h4>Swarm &amp; Provenance</h4><span>DHT / tracker boundary</span></div>
      <dl class="pf-kv">
        <dt>Source index</dt><dd>https://pirateface.co</dd>
        <dt>Infohash (v1)</dt><dd>${activeHash ? esc(activeHash) : (termsRequired ? 'Withheld until terms acknowledged' : (loading ? 'Loading…' : 'Unavailable'))}</dd>
        <dt>HF revision</dt><dd>${revision ? esc(revision) : 'Not reported'}</dd>
        <dt>Listed endpoints</dt><dd>${hosts.length ? `${esc(hosts.join(', '))} (stripped by FrostByte)` : 'None'}</dd>
      </dl>
      <p class="hf-help">FrostByte strips third-party trackers and webseeds before preview or download. Peer discovery uses your local DHT and custom tracker settings, and your IP is visible to swarm peers.</p>
      ${files.length ? `
        <div class="hf-section-heading"><h4>Pinned File Manifest</h4><span>${esc(String(files.length))} file${files.length === 1 ? '' : 's'}</span></div>
        <div class="hf-files">
          ${files.slice(0, 200).map(f => `
            <div class="hf-file">
              <span class="hf-fname" title="${esc(f.path)}">${esc(f.path)}</span>
              ${f.size != null ? `<span class="hf-fsize">${esc(fmtBytes(f.size))}</span>` : ''}
              <span class="pf-sha" title="${f.sha256 ? `SHA-256: ${esc(f.sha256)}` : 'No LFS SHA-256 listed'}">${f.sha256 ? `sha256:${esc(f.sha256.slice(0, 10))}…` : 'git blob'}</span>
            </div>`).join('')}
          ${files.length > 200 ? `<p class="hf-help">Showing first 200 of ${esc(String(files.length))} files.</p>` : ''}
        </div>` : ''}
    </div>
    <div class="hf-checkout">
      <div class="hf-checkout-top">
        <strong>${esc(repoId.split('/')[1] || repoId)}</strong>
        <span>${activeMagnet ? 'Canonical btih magnet ready' : (termsRequired ? 'Acknowledge terms above' : (loading ? 'Checking record…' : 'No magnet available'))}</span>
      </div>
      <div class="pf-checkout-actions">
        <button class="btn primary" type="button" data-pf-act="inspect" ${!activeMagnet || exceedsOneTiB ? 'disabled' : ''}>Inspect &amp; Download Torrent…</button>
        <div style="display:flex;gap:8px">
          <button class="btn" style="flex:1" type="button" data-pf-act="copy-magnet" ${!activeMagnet ? 'disabled' : ''}>Copy magnet</button>
          <button class="btn" style="flex:1" type="button" data-pf-act="open-hf">Open in HuggingFace view</button>
        </div>
      </div>
      <p class="hf-checkout-note">Opens FrostByte’s reviewed torrent dialog — no auto-download or Catalog bypass</p>
    </div>`;

  pane.querySelector('[data-pf-act="hf-web"]')?.addEventListener('click', () => api.openExternal(hfPageUrl));
  pane.querySelector('[data-pf-act="terms-url"]')?.addEventListener('click', () => {
    if (license?.termsUrl) api.openExternal(license.termsUrl);
  });
  pane.querySelector('[data-pf-act="policy-url"]')?.addEventListener('click', () => {
    if (license?.policyUrl) api.openExternal(license.policyUrl);
  });
  pane.querySelectorAll('[data-pf-act="open-hf"]').forEach(btn => {
    btn.addEventListener('click', () => switchToHfAndOpenModel(repoId));
  });
  pane.querySelector('[data-pf-act="copy-magnet"]')?.addEventListener('click', async () => {
    if (!activeMagnet) return;
    try { if (await api.copyText(activeMagnet)) toast('Canonical magnet copied.'); } catch { toast('Could not copy magnet.', 'error'); }
  });
  pane.querySelector('[data-pf-act="inspect"]')?.addEventListener('click', () => {
    if (!activeMagnet || exceedsOneTiB) return;
    openAddDialog({ magnet: activeMagnet });
  });
  pane.querySelector('[data-pf-act="accept-terms"]')?.addEventListener('click', () => {
    if (!license?.id) return;
    pfSelect(summary, null, { quant: detail?.quant || '', acceptTerms: license.id });
  });
  pane.querySelector('[data-pf-quant-select]')?.addEventListener('change', e => {
    pfSelect(summary, null, { quant: e.target.value });
  });
}

function bindHfView() {
  HF_EMPTY_DEFAULT = $('#empty-hf').innerHTML;
  HF_THEAD_DEFAULT = $('#grid-hf thead').innerHTML;
  renderHfResults();
  frostnetUi?.wire();
  $('#hf-detail').addEventListener('click', e => {
    if (e.target.closest('[data-hf-close]')) closeHfDetail();
  });
  $('#hf-provider-switch')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-hf-provider]');
    if (btn) setModelsProvider(btn.dataset.hfProvider);
  });
  $('#pf-browsebar')?.addEventListener('click', e => {
    const chip = e.target.closest('[data-pf-quick]');
    if (chip) { pfDoSearch(chip.dataset.pfQuick); return; }
    if (e.target.closest('#pf-open-net-settings')) {
      goTab('settings');
      $('#settings-nav [data-sec="connection"]')?.click();
      $('#set-dht')?.focus();
    }
  });
  $('#hf-go').addEventListener('click', () => {
    if (hfUi.provider === 'pirateface') pfDoSearch();
    else if (hfUi.provider === 'frostnet') frostnetUi?.search();
    else hfDoSearch(false);
  });
  $('#hf-more').addEventListener('click', () => hfDoSearch(true));
  $('#hf-sort').addEventListener('change', e => {
    hfUi.hubSort = e.target.value; hfUi.hubDirection = -1;
    $('#hf-direction').textContent = '↓ Descending'; hfDoSearch();
  });
  $('#hf-direction').addEventListener('click', () => {
    hfUi.hubDirection *= -1;
    $('#hf-direction').textContent = hfUi.hubDirection === 1 ? '↑ Ascending' : '↓ Descending'; hfDoSearch();
  });
  let facetsLoaded = false;
  $('#hf-filter-toggle').addEventListener('click', async () => {
    const panel = $('#hf-filters'); panel.hidden = !panel.hidden;
    $('#hf-filter-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden || facetsLoaded) return;
    facetsLoaded = true;
    try {
      const r = await api.hfFacets();
      if (!r.ok) { facetsLoaded = false; return; }
      for (const [type, id] of Object.entries({ pipeline_tag: 'hf-task', library: 'hf-library', license: 'hf-license', language: 'hf-language' })) {
        const select = $('#' + id), value = select.value;
        select.innerHTML = select.options[0].outerHTML + r.data[type].map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('');
        select.value = value;
      }
    } catch { facetsLoaded = false; }
  });
  $('#hf-apply-filters').addEventListener('click', () => hfDoSearch());
  $('#hf-author').addEventListener('keydown', e => { if (e.key === 'Enter') hfDoSearch(); });
  $('#hf-reset-filters').addEventListener('click', () => {
    $$('#hf-filters input, #hf-filters select').forEach(el => { el.value = ''; }); hfRenderFormatChips(); hfDoSearch();
  });
  // Format chips are a one-click shortcut for the Format filter; the select stays the single source of truth.
  hfRenderFormatChips();
  $('#hf-format-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.hf-chip');
    if (!chip) return;
    $('#hf-search-format').value = chip.dataset.format;
    hfRenderFormatChips(); hfDoSearch();
  });
  $('#hf-search-format').addEventListener('change', hfRenderFormatChips);
  $('#hf-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (hfUi.provider === 'pirateface') pfDoSearch();
      else if (hfUi.provider === 'frostnet') frostnetUi?.search();
      else hfDoSearch(false);
    }
  });
  // Bound once here via delegation so swapping thead HTML between HuggingFace
  // and Pirate Face modes never drops or stacks sort listeners.
  $('#grid-hf thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]');
    if (!th) return;
    const k = th.dataset.k;
    if (hfUi.provider === 'pirateface') {
      if (hfUi.pfSortKey === k) hfUi.pfSortDir *= -1;
      else { hfUi.pfSortKey = k; hfUi.pfSortDir = k === 'name' ? 1 : -1; }
      renderPfResults();
      return;
    }
    if (['downloads', 'likes', 'lastModified'].includes(k)) {
      hfUi.hubDirection = !hfUi.sortKey && hfUi.hubSort === k ? -hfUi.hubDirection : -1;
      hfUi.hubSort = k;
      $('#hf-sort').value = k;
      $('#hf-direction').textContent = hfUi.hubDirection === 1 ? '↑ Ascending' : '↓ Descending';
      hfDoSearch(); return;
    }
    hfUi.sortDir = hfUi.sortKey === k ? -hfUi.sortDir : 1;
    hfUi.sortKey = k;
    renderHfResults();
  });
}

/* Devices keeps presentation separate from the saved connection used by jobs. */
const devicesUi = { local: false, page: 'overview', selecting: false, modelBusy: false, telemetry: new Map(), history: new DeviceHistory() };
const dashboardDevice = () => devicesUi.local || !selectedDeviceId()
  ? { id: 'local', name: state.localDevice?.name || localDeviceLabel(), version: state.version, connected: true, status: { hardware: state.localDevice } }
  : deviceById();
function telemetryFor(id) {
  if (!devicesUi.telemetry.has(id)) devicesUi.telemetry.set(id, { data: null, recipes: [], busy: false, error: '', checkedAt: 0 });
  return devicesUi.telemetry.get(id);
}
function syncSelectedDevice() {
  if (!Array.isArray(state.devices)) return;
  const device = deviceById();
  if (sparkUi.deviceId !== device?.id) {
    sparkUi.filesRequest++; sparkUi.entries = []; sparkUi.filesLoadedKey = ''; sparkUi.root = ''; sparkUi.relative = '';
    sparkUi.deviceId = device?.id;
  }
  Object.assign(sparkUi, { host: device?.host || '', status: device?.status || null, connected: device?.connected === true, error: device?.error || '',
    transfers: device ? { host: device.host, torrents: device.status?.torrents || [], downloads: device.status?.downloads || [] } : null });
}
async function selectRemoteDevice(id) {
  const response = await api.selectDevice(id);
  if (!response.ok) { toast(response.error, 'error'); return false; }
  devicesUi.local = false; devicesUi.page = 'detail'; applyState(response.data); sparkSetup.active = false;
  renderSparkSetup(); renderSpark();
  return true;
}
async function refreshDeviceManagement(device) {
  if (!device?.id || !device.connected) return;
  const cache = telemetryFor(device.id);
  if (cache.busy) return;
  cache.busy = true; cache.error = ''; cache.checkedAt = Date.now();
  renderDeviceCards();
  try {
    cache.data = device.id === 'local' ? await api.localDeviceTelemetry() : await api.sparkDeviceTelemetry(device.id);
    if (device.id !== 'local') {
      try { cache.recipes = await api.sparkDeviceRecipes(device.id); }
      catch { cache.recipes = []; }
    }
  } catch (error) {
      cache.recipes = [];
      cache.error = /Unsupported Spark action|unsupported/i.test(error.message || '')
        ? 'This device is running an older companion. Open Device options and update it, then refresh.'
        : error.message || 'Device telemetry is unavailable.';
  }
  finally {
    cache.busy = false;
    renderDeviceCards();
    if (ui.tab === 'dashboard') renderDashboard();
  }
}
async function openSparkModelControl(device, recipeId) {
  if (devicesUi.modelBusy) return;
  devicesUi.modelBusy = true; renderDeviceCards();
  try {
    const preflight = await api.sparkModelCheck(device.id, recipeId);
    if (preflight?.state !== 'ready') { toast(preflight?.message || 'This model recipe is not ready to start.', 'warn'); return; }
    const stopping = preflight.observedState === 'running';
    const result = await (stopping ? api.sparkModelStop(device.id, recipeId) : api.sparkModelStart(device.id, recipeId));
    if (!result?.cancelled) toast(result?.result?.message || 'Model request completed.', result?.result?.state === 'blocked' ? 'warn' : 'info');
  } catch (error) { toast(error.message || 'Model control failed.', 'error'); }
  finally { devicesUi.modelBusy = false; await refreshDeviceManagement(device); }
}
function devicePicture(hardware, selected) {
  const artwork = deviceArtwork(hardware, selected), photo = DEVICE_PHOTOS[artwork];
  if (photo) return `<img src="../../assets/devices/${photo.file}" alt="${esc(photo.label)} product photo" style="object-view-box:inset(${photo.inset.map(n => n + '%').join(' ')})" width="480" height="300" />`;
  return `<img src="../../assets/devices/${artwork}.svg" alt="${esc(hardware?.name || 'Device')} placeholder" width="480" height="300" />`;
}
function deviceCpu(hardware) {
  const count = hardware?.cpuCores ? hardware.cpuCores + ' cores' : hardware?.logicalCpuCount ? hardware.logicalCpuCount + ' threads' : '';
  return [hardware?.chip || 'Not reported', count].filter(Boolean).join(' · ');
}
function deviceGpu(hardware) {
  return hardware?.gpus?.length ? hardware.gpus.map(gpu => [gpu.name, gpu.cores ? gpu.cores + ' cores' : ''].filter(Boolean).join(' · ')).join(' + ') : 'Not reported';
}
function renderDeviceCards() {
  const container = $('#device-cards');
  if (!container) return;
  const local = { id: 'local', name: state.localDevice?.name || localDeviceLabel(), connected: true, status: { hardware: state.localDevice } };
  const html = [local, ...remoteDevices()].map(device => {
    const hardware = device.status?.hardware, isLocal = device.id === 'local';
    const chosen = isLocal ? devicesUi.local || !selectedDeviceId() : !devicesUi.local && device.id === selectedDeviceId();
    return `<button class="device-card ${chosen ? 'selected' : ''}" data-select-device="${esc(device.id)}" aria-pressed="${chosen}">
      <span class="device-card-status ${device.connected ? 'online' : ''}"><i></i>${isLocal ? localDeviceLabel() : device.connected ? 'Connected' : device.checking ? 'Connecting' : 'Offline'}</span>
      <span class="device-card-image">${devicePicture(hardware, device.artwork)}</span>
      <strong>${esc(device.name)}</strong>
      <span class="device-card-model">${esc([hardware?.name !== device.name ? hardware?.name : '', hardware?.modelIdentifier].filter(Boolean).join(' · ') || 'Model not reported')}</span>
      <span class="device-card-spec"><span class="device-spec-label">CPU</span><span>${esc(deviceCpu(hardware))}</span></span>
      <span class="device-card-spec"><span class="device-spec-label">GPU</span><span>${esc(deviceGpu(hardware))}</span></span>
      ${!isLocal ? `<span class="device-card-host">${esc(device.host)}</span>` : ''}
      <span class="device-card-foot">${hardware?.memoryBytes ? fmtBytes(hardware.memoryBytes) + ' memory' : isLocal ? 'Local downloads' : 'Remote downloads'}<span>Open dashboard →</span></span>
    </button>`;
  }).join('');
  if (container._html !== html) {
    const focus = container.contains(document.activeElement) ? document.activeElement.dataset.selectDevice : null;
    container.innerHTML = html; container._html = html;
    if (focus) [...container.querySelectorAll('[data-select-device]')].find(button => button.dataset.selectDevice === focus)?.focus({ preventScroll: true });
  }
  $('#devices-count').textContent = `${remoteDevices().length + 1} device${remoteDevices().length ? 's' : ''}`;
  const selected = dashboardDevice();
  if (!selected) devicesUi.page = 'overview';
  const detail = devicesUi.page === 'detail' && !sparkSetup.active;
  container.hidden = detail || sparkSetup.active;
  $('#devices-overview-head').hidden = detail;
  $('#devices-intro').hidden = detail || sparkSetup.active;
  $('#device-dashboard').hidden = !detail;
  if (!detail || !selected) return;
  const hardware = selected?.status?.hardware;
  const cache = telemetryFor(selected.id), isLocal = selected.id === 'local';
  const summary = transferSummary(isLocal ? state : selected.status);
  if (ui.tab === 'spark') devicesUi.history.add(selected.id, selected.connected ? summary : null);
  const storage = isLocal ? cache.data?.storage ? [cache.data.storage] : [] : selected.status?.storage || [];
  const detailsHtml = dashboardHtml({ device: selected, hardware, telemetry: cache.data, recipes: cache.recipes,
    telemetryError: cache.error, busy: cache.busy, modelBusy: devicesUi.modelBusy,
    rows: devicesUi.history.get(selected.id), summary, storage, picture: devicePicture(hardware, selected.artwork),
    cpu: deviceCpu(hardware), gpu: deviceGpu(hardware), downloadDir: isLocal ? state.settings.downloadDir : selected.defaultDir || selected.status?.downloadDir || '', localLabel: localDeviceLabel(),
    inventory: isLocal ? state.inventory || [] : selected.status?.inventory || [],
    width: $('#device-details .dashboard-traffic')?.clientWidth - 40 || Math.max(280, $('#device-details').clientWidth * .6 - 40) });
  const aeon = deviceAeonTools(selected);
  const panel = $('#aeon-device-panel');
  panel.hidden = !aeon || sparkSetup.active;
  const panelHtml = aeon ? `<span class="device-eyebrow">AEON ORBIT · ${esc(aeon.version)}</span><h3>Your Orb, connected.</h3><p class="hf-help">AEON tools for ${esc(selected.name || selected.host)}. Each opens on this device in your browser.</p><div class="aeon-device-tools">${aeon.tools.map(tool => `<button class="btn" data-aeon-tool="${tool}">${AEON_TOOLS[tool].label}<small>${AEON_TOOLS[tool].description}</small></button>`).join('')}</div>` : '';
  if (panel._html !== panelHtml) { panel.innerHTML = panelHtml; panel._html = panelHtml; }
  panel.onclick = async event => {
    const button = event.target.closest('[data-aeon-tool]'); if (!button || !aeon) return;
    button.disabled = true;
    try { const result = await api.aeonOpen({ deviceId: selected.id, tool: button.dataset.aeonTool }); if (!result.ok) toast(result.error, 'error'); }
    finally { button.disabled = false; }
  };
  if ($('#device-details')._html === detailsHtml) return;
  const oldFocus = $('#device-details').contains(document.activeElement) ? document.activeElement : null;
  const focusId = oldFocus?.id, focusView = oldFocus?.dataset.deviceView, focusRecipe = oldFocus?.dataset.sparkModel;
  $('#device-details').innerHTML = detailsHtml; $('#device-details')._html = detailsHtml;
  const restore = [...$('#device-details').querySelectorAll('button')].find(button => focusId ? button.id === focusId : focusView ? button.dataset.deviceView === focusView : focusRecipe ? button.dataset.sparkModel === focusRecipe : false);
  restore?.focus({ preventScroll: true });
  $('#device-options')?.addEventListener('click', () => openDeviceOptions(selected));
  $('#spark-management-refresh')?.addEventListener('click', () => refreshDeviceManagement(selected));
  $('#spark-management-refresh').disabled = cache.busy || !selected.connected;
  $('#device-details').querySelectorAll('[data-device-view]').forEach(button => button.addEventListener('click', () => {
    const tab = button.dataset.deviceView, filter = isLocal ? 'local' : 'device:' + selected.id;
    if (tab === 'transfers') ui.transferDevice = filter;
    else if (tab === 'library') ui.libraryDevice = filter;
    else ui.torrentsDevice = filter;
    goTab(tab);
  }));
  $('#device-details')?.querySelectorAll('[data-spark-model]').forEach(button => button.addEventListener('click', () => openSparkModelControl(selected, button.dataset.sparkModel)));
  $('#device-local-folder')?.addEventListener('click', async () => { const folder = await api.pickSaveDir(); if (folder) { await saveSettings({ downloadDir: folder }); renderSpark(); } });
  if (ui.tab === 'spark' && selected.connected && !cache.busy && !cache.checkedAt) void refreshDeviceManagement(selected);
}
function openDeviceOptions(device) {
  openModal({ title: 'Device options', sub: device.status?.hardware?.name || device.host,
    body: `<label class="spark-folder-label">Display name<input id="device-display-name" value="${esc(device.name)}" maxlength="80" /></label><label class="spark-folder-label">Device photo<select id="device-artwork"><option value="">Detect from model identifier</option>${DEVICE_ARTWORK.map(name => `<option value="${name}">${esc(DEVICE_PHOTOS[name]?.label || name.replaceAll('-', ' '))}</option>`).join('')}</select></label><p class="hf-help">This changes its name and picture on this computer. Hardware information still comes from the device.</p><button class="btn sm" id="device-update" ${device.connected ? '' : 'disabled'}>${device.managed ? 'Re-pair or update…' : 'Update companion…'}</button><button class="btn danger sm" id="device-forget">Forget connection…</button>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'btn primary', onClick: async () => {
      const result = await api.configureDevice(device.id, { name: $('#device-display-name').value, artwork: $('#device-artwork').value });
      if (!result.ok) { toast(result.error, 'error'); return; }
      applyState(result.data); closeModal(); renderSpark();
    } }], onMount: () => {
      $('#device-artwork').value = device.artwork || '';
      $('#device-update').onclick = async () => {
        closeModal();
        if (device.managed) {
          await beginSparkAdminSetup(device, 'Enter the device account password to update its companion. FrostByte never saves this password.', { type: 'update-device', deviceId: device.id });
          return;
        }
        if (!await askModal(`Update the companion on ${device.name}?`, `Install the companion bundled with FrostByte ${state.version}. It restarts briefly; existing jobs and files are kept.`, { yes: 'Update companion' })) return;
        sparkUi.storageBusy = true; renderSpark();
        openModal({ title: 'Updating companion', body: '<p id="spark-storage-progress" role="status">Preparing the update…</p>', actions: [] });
        try {
          const response = await api.updateDevice(device.id);
          if (!response.ok) throw new Error(response.error);
          if (response.data?.cancelled) return;
          await refresh(); toast('Companion updated.');
        } catch (error) { toast(error.message, 'error'); }
        finally { closeModal(); sparkUi.storageBusy = false; renderSpark(); }
      };
      $('#device-forget').onclick = async () => {
        closeModal();
        if (!await askModal(`Forget ${device.name}?`, device.managed ? 'FrostByte will first remove its dedicated access key from the device, then remove the saved connection here. The device must be online. Downloads and files stay on it.' : 'Removes this computer’s saved connection. Downloads and files stay on the device; its companion keeps running.', { yes: 'Remove access and forget' })) return;
        const response = await api.forgetDevice(device.id);
        if (response.ok) {
          if (!response.data?.cancelled) applyState(response.data?.state ?? response.data);
          renderSpark(); return;
        }
        if (!device.managed) { toast(response.error, 'error'); return; }
        const localOnly = await askModal(`Could not remove access from ${device.name}`, `${response.error} Keep this connection and retry when the device is online. If you forget it locally, its key remains authorized until you remove the FrostByte line from ~/.ssh/authorized_keys on that device.`, { yes: 'Forget locally anyway', no: 'Keep connection' });
        if (!localOnly) return;
        const forced = await api.forgetDeviceLocal(device.id);
        if (forced.ok && forced.data.forgotten) { applyState(forced.data.state); renderSpark(); toast('Connection forgotten locally. Remove its FrostByte key from the device manually.', 'warn'); }
        else if (forced.ok) applyState(forced.data.state);
        else toast(forced.error, 'error');
      };
    },
  });
}

/* =============================== DGX SPARK =============================== */
const sparkUi = { connected: false, host: '', status: null, transfers: null, error: '', relative: '', root: '', entries: [], filesLoadedKey: '', filesLoading: false, filesError: '', filesRequest: 0, pendingBrowse: null, busy: false, storageBusy: false, destinationBusy: false, destinationHost: '' };
const sparkFilesKey = () => JSON.stringify([sparkUi.host, sparkUi.root, sparkUi.relative]);
function sparkStorage(deviceId) {
  const status = deviceId ? deviceById(deviceId)?.status : sparkUi.status;
  if (!status) return [];
  const paths = status.storageRoots?.length ? status.storageRoots : [status.downloadDir];
  return paths.filter(Boolean).map(path => ({ path, available: true, ...(status.storage?.find(item => item.path === path) || {}), ...(!status.storage?.length && path === status.downloadDir ? { freeBytes: status.freeBytes, totalBytes: status.totalBytes } : {}) }));
}
function sparkRoot(value) {
  const roots = sparkStorage();
  return roots.some(root => root.path === value) ? value : roots.find(root => root.available)?.path || roots[0]?.path || '';
}
function sparkRootAvailable(value, deviceId) { return (deviceId ? deviceOnline(deviceId) : sparkUi.connected) && sparkStorage(deviceId).some(root => root.path === value && root.available); }
function sparkDownloadRoot(value = '', deviceId) {
  if (deviceId) return value || deviceById(deviceId)?.defaultDir || deviceById(deviceId)?.status?.downloadDir || '';
  // Keep an unavailable choice visible; never silently redirect a download to
  // another drive. Browsing uses its own root and does not change this choice.
  if (value) return value;
  if (state.settings.sparkDownloadHost === state.settings.sparkHost && state.settings.sparkDownloadDir) return state.settings.sparkDownloadDir;
  return sparkUi.status?.downloadDir || sparkRoot('');
}
function sparkStorageOptions(value, deviceId) {
  const roots = sparkStorage(deviceId);
  if (value && !roots.some(root => root.path === value)) roots.unshift({ path: value, available: false });
  return roots.map(root => `<option value="${esc(root.path)}" ${root.path === value ? 'selected' : ''} ${root.available ? '' : 'disabled'}>${esc(root.path)}${root.available ? '' : ' · unavailable'}</option>`).join('');
}
function fillSparkStorageSelect(select, value, deviceId) {
  const html = sparkStorageOptions(value, deviceId);
  if (select._optionsHtml !== html) { select.innerHTML = html; select._optionsHtml = html; }
  select.value = value;
}
async function chooseSparkDestination(destination, deviceId = selectedDeviceId()) {
  if (sparkUi.destinationBusy || !sparkRootAvailable(destination, deviceId)) return false;
  sparkUi.destinationBusy = true; renderSpark();
  try {
    if (Array.isArray(state.devices)) {
      const response = await api.configureDevice(deviceId, { defaultDir: destination });
      if (!response.ok) { toast(response.error, 'error'); return false; }
      applyState(response.data);
    } else if (!await saveSettings({ sparkDownloadHost: state.settings.sparkHost, sparkDownloadDir: destination })) return false;
    if (hfUi.deviceId === deviceId) hfUi.sparkDestination = destination;
    for (const selector of ['#hf-spark-destination', '#dl-spark-destination']) {
      const select = $(selector);
      const target = $(selector.startsWith('#hf') ? '#hf-target' : '#dl-target');
      if (select && target?.value === deviceId) { fillSparkStorageSelect(select, destination, deviceId); select.dispatchEvent(new Event('change')); }
    }
    return true;
  } finally { sparkUi.destinationBusy = false; renderSpark(); }
}
async function showSparkFolderBrowser(container, { sessionId, path, onChoose, deviceId = selectedDeviceId() }) {
  if (!container) return;
  const generation = (container.folderGeneration || 0) + 1; container.folderGeneration = generation;
  container.hidden = false; container.innerHTML = '<p class="hf-help" role="status">Loading folders on the device…</p>';
  const response = await api.sparkFolders({ ...(sessionId ? { sessionId } : { deviceId }), ...(path ? { path } : {}) });
  if (!container.isConnected || generation !== container.folderGeneration) return;
  if (!response.ok) {
    container.innerHTML = `<p class="spark-setup-error" role="alert">${esc(response.error)}</p><button class="btn sm" data-folder-retry>Try again</button>`;
    container.querySelector('[data-folder-retry]').onclick = () => showSparkFolderBrowser(container, { sessionId, path, onChoose, deviceId }); return;
  }
  const listing = response.data;
  container.innerHTML = `<div class="spark-folder-shortcuts">${(listing.shortcuts || []).map(item => `<button class="btn sm" data-folder-path="${esc(item.path)}">${esc(item.name)}</button>`).join('')}</div><div class="spark-folder-location"><button class="btn sm" data-folder-path="${esc(listing.parent || '')}" ${listing.parent ? '' : 'disabled'}>Up</button><code>${esc(listing.path)}</code></div><div class="spark-folder-list">${(listing.folders || []).map(folder => `<button class="spark-folder-row" data-folder-path="${esc(folder.path)}">▣ ${esc(folder.name)} <span>›</span></button>`).join('') || '<p class="hf-help">No subfolders here.</p>'}</div><div class="spark-folder-browser-actions"><button class="btn primary sm" data-folder-choose>Use this folder</button><button class="btn sm" data-folder-close>Close browser</button></div>`;
  container.querySelectorAll('[data-folder-path]').forEach(button => { button.onclick = () => showSparkFolderBrowser(container, { sessionId, path: button.dataset.folderPath, onChoose, deviceId }); });
  container.querySelector('[data-folder-choose]').onclick = () => { onChoose(listing.path); container.hidden = true; container.folderGeneration++; };
  container.querySelector('[data-folder-close]').onclick = () => { container.hidden = true; container.folderGeneration++; };
}
const sparkSetup = { stage: 'connection', active: false, mode: 'password', host: '', username: '', port: '22', result: null, credentials: null, intent: null, error: '', busy: false, generation: 0, progress: '' };
function updateSparkDestinations() {
  for (const selector of ['#hf-target', '#dl-target']) {
    const select = $(selector);
    if (!select) continue;
    const value = select.value;
    const missing = value && value !== 'mac' && !remoteDevices().some(device => device.id === value);
    const html = downloadDeviceOptions() + (missing ? `<option value="${esc(value)}" disabled>Previously selected device · unavailable</option>` : '');
    if (select._deviceOptions !== html) { select.innerHTML = html; select._deviceOptions = html; select.value = value; }
    // Keep an offline destination selected. Never redirect a queued choice to this computer.
    select.dispatchEvent(new Event('deviceavailability'));
  }
  if ($('#hf-download') && hfUi.selected) updateHfSelection();
}
function renderSparkSetup() {
  const root = $('#spark-setup');
  root.hidden = !sparkSetup.active;
  if (!sparkSetup.active) return;
  const result = sparkSetup.result || {}, device = result.device || {}, mac = device.platform === 'darwin';
  const step = ['connection', 'trust'].includes(sparkSetup.stage) ? 1 : ['review', 'ready', 'requirements'].includes(sparkSetup.stage) ? 2 : 3;
  const progress = `<ol class="spark-steps" aria-label="Setup progress"><li class="${step === 1 ? 'current' : 'complete'}">1. Connect</li><li class="${step === 2 ? 'current' : step > 2 ? 'complete' : ''}">2. Review</li><li class="${step === 3 ? 'current' : ''}">3. Ready to download</li></ol>`;
  const error = `<p class="spark-setup-error" id="spark-setup-error" role="alert" ${sparkSetup.error ? '' : 'hidden'}>${esc(sparkSetup.error)}</p>`;
  let body = '';
  if (sparkSetup.stage === 'connection') {
    const adminIntent = ['add-storage', 'update-device'].includes(sparkSetup.intent?.type);
    const adminDevice = adminIntent ? deviceById(sparkSetup.intent.deviceId) : null;
    const adminDeviceLabel = [...new Set([adminDevice?.name, adminDevice?.host].filter(Boolean))].join(' · ') || 'Saved device';
    const storageIntent = sparkSetup.intent?.type === 'add-storage';
    body = `<h3>${adminIntent ? storageIntent ? 'Authorize storage on this device' : 'Authorize this device update' : 'Add a Mac, DGX or Raspberry Pi'}</h3><p class="spark-intro">${adminIntent ? `Enter the saved device account password for this ${storageIntent ? 'storage change' : 'companion update'}.` : 'Connect over your local network. FrostByte will check your device and guide you through installing its companion service. Each device keeps its own download folder.'}</p>
      <form id="spark-setup-form">${adminIntent ? `<div class="spark-fingerprint"><span>Selected device</span><code>${esc(adminDeviceLabel)}</code></div>` : `<div class="spark-mode" role="group" aria-label="Connection method"><button type="button" class="btn ${sparkSetup.mode === 'password' ? 'on' : ''}" data-spark-mode="password" aria-pressed="${sparkSetup.mode === 'password'}">Device address + password</button><button type="button" class="btn ${sparkSetup.mode === 'ssh' ? 'on' : ''}" data-spark-mode="ssh" aria-pressed="${sparkSetup.mode === 'ssh'}">Saved SSH connection</button></div>`}
      <div class="spark-setup-fields">${adminIntent ? '' : `<label>${sparkSetup.mode === 'ssh' ? 'SSH alias or user@hostname' : 'Device hostname or IP address'}<input id="spark-setup-host" name="host" value="${esc(sparkSetup.host)}" placeholder="${sparkSetup.mode === 'ssh' ? 'Your SSH alias' : 'Your device’s hostname or IP address'}" autocomplete="off" spellcheck="false" required /></label>`}
      ${adminIntent ? `<label>Password<input id="spark-setup-password" name="password" type="password" autocomplete="off" required /></label><p class="hf-help">FrostByte checks the saved address and SSH identity in the background and never saves this password.</p>` : sparkSetup.mode === 'password' ? `<div class="spark-field-pair"><label>Username<input id="spark-setup-user" name="username" value="${esc(sparkSetup.username)}" placeholder="Your device login" autocomplete="off" spellcheck="false" required /></label><label>SSH port<input id="spark-setup-port" name="port" value="${esc(sparkSetup.port)}" type="number" min="1" max="65535" required /></label></div><label>Password<input id="spark-setup-password" name="password" type="password" autocomplete="off" required /></label><p class="hf-help">Use the account you sign in to on your device. Your password is used for this setup and is never saved.</p>` : '<p class="hf-help">Use a connection already configured on this computer. Its SSH key and connection settings are reused.</p>'}</div>
      ${adminIntent ? '' : '<details class="spark-help"><summary>Where do I find my device’s address?</summary><p>On your device, open its network settings and copy the hostname or local IP address. Keep both devices on the same network. On a Mac, enable System Settings → General → Sharing → Remote Login for your account. Keep the Mac awake and signed in. Python 3 is required on the remote device; Linux devices also need Docker.</p></details>'}${error}<div class="spark-setup-actions"><button class="btn primary" id="spark-setup-check" type="submit" ${sparkSetup.busy ? 'disabled' : ''}>${sparkSetup.busy ? 'Checking connection…' : 'Check connection'}</button>${sparkSetup.busy || state.settings.sparkHost ? '<button type="button" class="btn" data-spark-setup="cancel">Cancel</button>' : ''}</div></form>`;
  } else if (sparkSetup.stage === 'trust') {
    body = `<h3>Is this your device?</h3><p class="spark-intro">This computer has not trusted <strong>${esc(sparkSetup.host)}</strong> for this connection. Check its SSH fingerprint against the one on your device before continuing.</p><div class="spark-fingerprint"><span>${esc(result.hostKeyType || 'SSH')} fingerprint</span><code id="spark-fingerprint">${esc(result.fingerprint)}</code></div><details class="spark-help"><summary>How to check this fingerprint</summary><p>On the device, open Terminal and run <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>. If the key type above is RSA or ECDSA, use the matching host key file. Compare the full SHA256 fingerprint.</p></details>${error}<div class="spark-setup-actions"><button class="btn primary" id="spark-trust" data-spark-setup="trust" ${sparkSetup.busy ? 'disabled' : ''}>${sparkSetup.busy ? 'Checking device…' : 'Trust and continue'}</button><button class="btn" data-spark-setup="cancel">Cancel</button></div>`;
  } else if (sparkSetup.stage === 'requirements' && mac) {
    body = `<h3>One more step on this Mac</h3><p class="spark-intro">${esc(result.message)}</p>${error}<div class="spark-setup-actions"><button class="btn primary" data-spark-setup="retry">Check connection again</button><button class="btn" data-spark-setup="cancel">Cancel</button></div>`;
  } else if (sparkSetup.stage === 'requirements') {
    const requirements = result.requirements || {};
    body = `<h3>One more step on your device</h3><p class="spark-intro">Connected to ${esc(device.hostname || sparkSetup.host)}. ${esc(result.message || 'Your device needs Docker before FrostByte can run its companion.')}</p><ul class="spark-checks"><li>${requirements.dockerInstalled ? '✓ Docker is installed' : 'Docker needs to be installed'}</li><li>${requirements.dockerAccess ? '✓ Your account can use Docker' : 'Your account needs permission to use Docker'}</li></ul><p class="hf-help">Open Docker on your device and make sure it is running. If Docker is missing or your account cannot use it, finish the Docker setup for your device account, then check again. No Node.js, source checkout, or Frigid installation is required.</p>${error}<div class="spark-setup-actions"><button class="btn primary" data-spark-setup="retry">Check connection again</button><button class="btn" data-spark-setup="cancel">Cancel</button></div>`;
  } else if ((sparkSetup.stage === 'review' || sparkSetup.stage === 'ready') && sparkSetup.intent?.type === 'add-storage') {
    const ready = sparkSetup.stage === 'ready', updating = result.requirements?.agentInstalled;
    body = `<h3>${ready ? 'Add storage on this device' : updating ? 'Update the companion and add storage' : 'Set up the companion and add storage'}</h3><p class="spark-intro">${esc(device.hardware?.name || device.hostname || result.status?.hostname || sparkSetup.host)}${device.architecture ? ` · ${esc(device.architecture)}` : ''}</p>
      <div class="spark-install-summary"><strong>${ready ? 'The companion is ready to add this folder.' : 'FrostByte will prepare the companion and add this folder.'}</strong><p>The companion restarts briefly. Existing jobs and files are kept.</p></div>
      <div class="spark-fingerprint"><span>New download folder on the device</span><code>${esc(sparkSetup.intent.downloadDir)}</code></div>
      ${error}<div class="spark-setup-actions"><button class="btn primary" id="spark-setup-storage" data-spark-setup="add-storage">Add storage folder</button><button class="btn" data-spark-setup="cancel">Cancel</button></div>`;
  } else if (sparkSetup.stage === 'review' || sparkSetup.stage === 'ready') {
    const ready = sparkSetup.stage === 'ready', updating = result.requirements?.agentInstalled;
    body = `<h3>${ready ? 'Your device is ready' : updating ? 'Update the FrostByte companion' : 'Set up downloads on the device'}</h3><p class="spark-intro">${esc(device.hardware?.name || device.hostname || result.status?.hostname || sparkSetup.host)}${device.architecture ? ` · ${esc(device.architecture)}` : ''}</p>
      <div class="spark-install-summary"><strong>${ready ? 'A compatible FrostByte companion is already installed.' : 'FrostByte will install its companion on this device.'}</strong><p>${ready ? 'Connect to manage its transfers and use its existing download folder.' : 'The companion runs in the background so downloads continue when this computer disconnects. Your downloads stay in the folder you choose.'}</p></div>
      ${mac ? '<p class="hf-help">The Mac companion runs in your account while you are signed in and the Mac is awake. Setup adds a login service and a private Node runtime; Docker is not required.</p>' : ''}
      ${ready ? `<div class="spark-fingerprint"><span>Download folder on the device</span><code>${esc(result.status?.downloadDir || result.downloadDir)}</code></div>` : `<label class="spark-folder-label">Download folder on the device<input id="spark-setup-folder" value="${esc(result.downloadDir || '')}" spellcheck="false" placeholder="/home/your-user/FrostByte" /></label><button class="btn sm spark-browse-button" data-spark-setup="browse">Browse device folders…</button><div id="spark-setup-browser" class="spark-folder-browser" hidden></div><p class="hf-help">Choose internal storage or a mounted external drive. Browse to the drive, or enter its full folder path. FrostByte will create the final folder if needed.</p>${result.frigidLibrary ? `<label class="spark-shared-folder"><input id="spark-use-frigid" type="checkbox" />Use my existing Frigid library <span class="mono">${esc(result.frigidLibrary)}</span></label><p class="hf-help">Optional: let both apps use the same files. Frigid is not required to use FrostByte.</p>` : ''}`}
      ${error}<div class="spark-setup-actions">${ready ? '<button class="btn" data-spark-setup="review-update">Update companion…</button>' : ''}<button class="btn primary" id="spark-setup-install" data-spark-setup="${ready ? 'connect' : 'install'}">${ready ? 'Connect to device' : updating ? 'Update companion and connect' : 'Install companion and connect'}</button><button class="btn" data-spark-setup="cancel">Cancel</button></div>`;
  } else {
    body = `<h3>${sparkSetup.stage === 'connecting' ? 'Connecting to your device' : sparkSetup.stage === 'adding-storage' ? 'Adding storage on your device' : 'Setting up your device'}</h3><p class="spark-intro" id="spark-setup-progress" role="status">${esc(sparkSetup.progress || 'Preparing your device…')}</p><progress class="spark-progress" id="spark-setup-progress-bar" ${Number.isFinite(sparkSetup.percent) ? `value="${sparkSetup.percent}" max="100"` : ''} aria-label="device setup progress"></progress><p class="hf-help">Keep this computer connected until setup finishes.</p>${error}<div class="spark-setup-actions"><button class="btn" data-spark-setup="cancel">Cancel setup</button></div>`;
  }
  root.innerHTML = `<div class="spark-setup-card">${progress}${body}</div>`;
  if (sparkSetup.busy) root.querySelectorAll('input, [data-spark-mode]').forEach(input => { input.disabled = true; });
}
function captureSparkConnection() {
  if ($('#spark-setup-host')) sparkSetup.host = $('#spark-setup-host').value.trim();
  if ($('#spark-setup-user')) sparkSetup.username = $('#spark-setup-user').value.trim();
  if ($('#spark-setup-port')) sparkSetup.port = $('#spark-setup-port').value;
}
async function cancelSparkSetup({ keepOpen = false, preserveIntent = false } = {}) {
  const sessionId = sparkSetup.result?.sessionId;
  const intent = preserveIntent ? sparkSetup.intent : null;
  sparkSetup.generation++; sparkSetup.credentials = null; sparkSetup.result = null; sparkSetup.intent = intent; sparkSetup.error = ''; sparkSetup.busy = false; sparkSetup.stage = 'connection'; sparkSetup.active = keepOpen;
  if ($('#spark-setup-password')) $('#spark-setup-password').value = '';
  renderSparkSetup();
  if (sessionId) await api.sparkSetupCancel(sessionId);
}
async function beginSparkAdminSetup(device, reason, intent = null) {
  await cancelSparkSetup({ keepOpen: true });
  Object.assign(sparkSetup, { mode: 'password', host: '', username: '', port: '22', intent, error: reason || '' });
  devicesUi.local = false; sparkUi.error = '';
  renderSparkSetup(); renderSpark();
  requestAnimationFrame(() => $('#spark-setup-password')?.focus());
}
async function probeSparkSetup(trustFingerprint) {
  if (sparkSetup.busy) return;
  captureSparkConnection();
  const adminIntent = ['add-storage', 'update-device'].includes(sparkSetup.intent?.type);
  const credentials = trustFingerprint ? sparkSetup.credentials : adminIntent
    ? { mode: 'password', purpose: sparkSetup.intent.type, deviceId: sparkSetup.intent.deviceId, password: $('#spark-setup-password')?.value || '' }
    : { mode: sparkSetup.mode, host: sparkSetup.host, username: sparkSetup.username, port: Number(sparkSetup.port) || 22, ...(sparkSetup.mode === 'password' ? { password: $('#spark-setup-password')?.value || '' } : {}) };
  if (!credentials) { sparkSetup.stage = 'connection'; sparkSetup.error = 'Enter your connection details again to continue.'; renderSparkSetup(); return; }
  if (adminIntent ? (!credentials.deviceId || !credentials.password) : (!credentials.host || (credentials.mode === 'password' && (!credentials.username || !credentials.password)))) {
    sparkSetup.error = adminIntent ? 'Enter the device account password.' : 'Enter your device’s address, username, and password.'; renderSparkSetup(); return;
  }
  const generation = ++sparkSetup.generation;
  sparkSetup.credentials = credentials; sparkSetup.busy = true; sparkSetup.error = '';
  if ($('#spark-setup-password')) $('#spark-setup-password').value = '';
  renderSparkSetup();
  try {
    const response = await api.sparkSetupProbe({ ...credentials, ...(trustFingerprint ? { trustFingerprint } : {}) });
    if (generation !== sparkSetup.generation) { if (response.data?.sessionId) await api.sparkSetupCancel(response.data.sessionId); return; }
    if (!response.ok) throw new Error(response.error);
    if (response.data?.cancelled) { sparkSetup.credentials = null; sparkSetup.stage = 'connection'; return; }
    sparkSetup.result = response.data; sparkSetup.stage = response.data.stage;
    if (sparkSetup.intent?.type === 'update-device' && sparkSetup.stage === 'ready') {
      sparkSetup.stage = 'review'; sparkSetup.result.downloadDir = sparkSetup.result.status?.downloadDir || sparkSetup.result.downloadDir;
    }
    if (sparkSetup.stage !== 'trust') sparkSetup.credentials = null;
  } catch (error) {
    if (generation !== sparkSetup.generation) return;
    sparkSetup.credentials = null; sparkSetup.stage = 'connection'; sparkSetup.error = error.message || 'Could not connect. Check your device address and login, then try again.';
  } finally {
    if (generation === sparkSetup.generation) {
      sparkSetup.busy = false; renderSparkSetup();
      if (ui.tab === 'spark') $('#spark-trust, #spark-setup-install, #spark-setup-password, #spark-setup-check')?.focus();
    }
  }
}
async function finishSparkSetup(action) {
  if (sparkSetup.busy || !sparkSetup.result?.sessionId) return;
  const downloadDir = $('#spark-setup-folder')?.value.trim();
  if (action === 'install' && (!downloadDir?.startsWith('/') || downloadDir.includes('\0'))) { sparkSetup.error = 'Choose an absolute folder path on the device, starting with /.'; renderSparkSetup(); $('#spark-setup-folder')?.focus(); return; }
  const generation = ++sparkSetup.generation, previousStage = sparkSetup.stage;
  if (downloadDir) sparkSetup.result.downloadDir = downloadDir;
  sparkSetup.busy = true; sparkSetup.error = ''; sparkSetup.stage = action === 'install' ? 'installing' : 'connecting'; sparkSetup.progress = action === 'install' ? 'Preparing the companion…' : 'Checking the companion…'; sparkSetup.percent = undefined; renderSparkSetup();
  try {
    const sessionId = sparkSetup.result.sessionId;
    const response = await (action === 'install' ? api.sparkSetupInstall({ sessionId, downloadDir }) : api.sparkSetupConnect({ sessionId }));
    if (generation !== sparkSetup.generation) return;
    if (!response.ok) throw new Error(response.error);
    if (response.data?.cancelled) { sparkSetup.stage = previousStage; return; }
    state.settings.sparkHost = response.data.host;
    sparkUi.host = response.data.host; sparkUi.status = response.data.status; sparkUi.connected = true; sparkUi.error = ''; sparkUi.relative = '';
    await refresh();
    if (generation !== sparkSetup.generation) return;
    // Device notifications can arrive before the saved selected-device UUID.
    // Enter the dashboard only after that state refresh, so an intermediate
    // missing selection cannot send a successful pairing back to the overview.
    sparkSetup.active = false; devicesUi.local = false; devicesUi.page = 'detail'; sparkSetup.credentials = null; sparkSetup.result = null; sparkSetup.intent = null;
    syncSelectedDevice(); renderSparkSetup(); renderSpark(); await refreshSparkFiles();
    toast(`Connected to ${sparkUi.status.hostname}. Choose this device when downloading.`);
  } catch (error) {
    if (generation !== sparkSetup.generation) return;
    sparkSetup.stage = previousStage; sparkSetup.error = error.message || 'Setup did not finish. Check your connection and try again.';
  } finally {
    if (generation === sparkSetup.generation) { sparkSetup.busy = false; renderSparkSetup(); }
  }
}
async function finishSparkStorageSetup() {
  const intent = sparkSetup.intent;
  if (sparkSetup.busy || !sparkSetup.result?.sessionId || intent?.type !== 'add-storage') return;
  const { deviceId, downloadDir } = intent;
  if (typeof downloadDir !== 'string' || !downloadDir.startsWith('/') || downloadDir.includes('\0')) {
    sparkSetup.error = 'Choose an absolute folder path on the device, starting with /.'; renderSparkSetup(); return;
  }
  const generation = ++sparkSetup.generation, previousStage = sparkSetup.stage;
  const sessionId = sparkSetup.result.sessionId;
  sparkSetup.busy = true; sparkSetup.error = ''; sparkSetup.stage = 'adding-storage'; sparkSetup.progress = 'Adding the folder on the device…'; sparkSetup.percent = undefined; renderSparkSetup();
  let response;
  try {
    response = await api.sparkStorageAdd({ sessionId, deviceId, downloadDir });
    if (generation !== sparkSetup.generation) return;
    if (!response.ok) throw new Error(response.error);
    if (response.data?.cancelled) { sparkSetup.stage = previousStage; return; }
  } catch (error) {
    if (generation !== sparkSetup.generation) return;
    try { await api.sparkSetupCancel(sessionId); } catch { /* main also expires abandoned password sessions */ }
    if (generation !== sparkSetup.generation) return;
    sparkSetup.credentials = null; sparkSetup.result = null; sparkSetup.stage = 'connection';
    sparkSetup.error = `${error.message || 'Could not add the storage folder.'} Enter the device account password again to retry.`;
    return;
  } finally {
    if (generation === sparkSetup.generation) { sparkSetup.busy = false; renderSparkSetup(); }
  }
  if (Array.isArray(state.devices)) {
    state.devices = state.devices.map(device => device.id === deviceId ? { ...device, connected: true, error: '', status: response.data.status } : device);
    syncSelectedDevice();
  } else {
    sparkUi.host = response.data.host || state.settings.sparkHost; sparkUi.status = response.data.status; sparkUi.connected = true; sparkUi.error = '';
  }
  if (deviceId === selectedDeviceId()) { sparkUi.root = downloadDir; sparkUi.relative = ''; }
  sparkSetup.active = false; sparkSetup.credentials = null; sparkSetup.result = null; sparkSetup.intent = null;
  renderSparkSetup(); renderSpark();
  const selected = await chooseSparkDestination(downloadDir, deviceId);
  await refreshSparkFiles();
  toast(selected ? 'Folder selected for new device downloads.' : 'Folder added. Select it as your download destination when ready.');
}
function renderSpark() {
  renderDeviceCards();
  $('#dashboard-connection').hidden = devicesUi.local || !selectedDeviceId();
  if (sparkUi.connected && sparkUi.status && sparkUi.host === state.settings.sparkHost) {
    sparkUi.transfers = { host: sparkUi.host, torrents: sparkUi.status.torrents || [], downloads: sparkUi.status.downloads || [] };
  }
  $('#spark-refresh').disabled = !state.settings.sparkHost || sparkUi.storageBusy;
  $('#spark-setup-open').disabled = sparkUi.storageBusy || sparkUi.destinationBusy;
  $('#spark-host').disabled = sparkUi.storageBusy || sparkUi.destinationBusy;
  $('#spark-connect').disabled = sparkUi.storageBusy || sparkUi.destinationBusy || sparkUi.connecting;
  $('#spark-saved-connection').hidden = !state.settings.sparkHost || sparkSetup.active || devicesUi.local;
  $('#spark-content').hidden = !sparkUi.status || sparkSetup.active || devicesUi.local;
  $('#spark-stats').hidden = true;
  if (document.activeElement !== $('#spark-host')) $('#spark-host').value = state.settings.sparkHost || '';
  $('#spark-message').textContent = sparkUi.error || (sparkUi.connected ? `Connected to ${sparkUi.status.hostname} · downloads run on the device` : 'Connect your device to download and share files directly from it.');
  $('#spark-message').classList.toggle('error', Boolean(sparkUi.error));
  $('#spark-message').hidden = devicesUi.local || sparkSetup.active || !selectedDeviceId();
  for (const id of ['spark-storage-section', 'spark-files-section']) $('#' + id).hidden = !sparkUi.connected || !sparkUi.status;
  updateSparkDestinations();
  updateLibraryCount();
  if (ui.tab === 'library') renderLibrary();
  if (ui.tab === 'catalog') renderTorrents();
  refreshLive();
  if (!sparkUi.status) return;
  const status = sparkUi.status;
  $('#spark-stats').innerHTML = `<div><span>Device</span><strong>${esc(status.hostname)}</strong><small>${esc(status.architecture)} · ${esc(status.version)}</small></div><div><span>System memory</span><strong>${fmtBytes(status.memoryBytes)}</strong><small>Files stored on the device</small></div>`;
  sparkUi.root = sparkRoot(sparkUi.root || sparkDownloadRoot());
  fillSparkStorageSelect($('#spark-library-root'), sparkUi.root);
  const destination = sparkDownloadRoot(), selectedStorage = sparkStorage().find(root => root.path === destination);
  fillSparkStorageSelect($('#spark-download-destination'), destination);
  $('#spark-download-destination').disabled = sparkUi.storageBusy || sparkUi.destinationBusy || !sparkUi.connected;
  $('#spark-storage-summary').textContent = selectedStorage?.available ? Number.isFinite(selectedStorage.freeBytes) ? `${fmtBytes(selectedStorage.freeBytes)} free in the selected destination` : 'Selected for new downloads' : 'Selected folder unavailable. Connect the drive or choose another folder before downloading.';
  $('#spark-storage-summary').classList.toggle('unavailable', !selectedStorage?.available);
  $('#spark-storage-add').disabled = sparkUi.storageBusy || sparkUi.destinationBusy;
  $('#spark-path').textContent = sparkUi.root + (sparkUi.relative ? '/' + sparkUi.relative : '');
  $('#spark-up').disabled = !sparkUi.relative;
  const filesHtml = sparkUi.filesError ? `<p class="inventory-error">${esc(sparkUi.filesError)}</p><button class="btn sm" id="spark-files-retry">Try again</button>` : sparkUi.filesLoadedKey !== sparkFilesKey() ? '<p class="hf-help">Loading files…</p>' : sparkUi.entries.map(entry => `<div class="spark-file"><button class="hf-link" ${entry.directory ? `data-spark-dir="${esc(entry.relative)}"` : 'disabled'}>${entry.directory ? '▣' : '▤'} ${esc(entry.name)}</button><span>${entry.directory ? 'Folder' : fmtBytes(entry.size)}</span><button class="btn sm" data-spark-share="${esc(entry.relative)}">Share on swarm</button></div>`).join('') || '<p class="hf-help">No files in this folder yet.</p>';
  const files = $('#spark-files');
  files.setAttribute('aria-busy', String(sparkUi.filesLoading));
  // Background checks must not replace identical rows: that loses focus and
  // collapses a long folder while the request is still in flight.
  if (files._filesHtml !== filesHtml) { files.innerHTML = filesHtml; files._filesHtml = filesHtml; }
}
async function refreshSparkFiles() {
  sparkUi.root = sparkRoot(sparkUi.root || sparkDownloadRoot());
  const request = ++sparkUi.filesRequest;
  if (!sparkRootAvailable(sparkUi.root)) { sparkUi.entries = []; sparkUi.filesLoadedKey = ''; sparkUi.filesLoading = false; sparkUi.filesError = 'This storage folder is unavailable. Connect or mount the drive on the device, then refresh.'; renderSpark(); return; }
  const root = sparkUi.root, relative = sparkUi.relative;
  const location = sparkFilesKey();
  if (sparkUi.filesLoadedKey !== location) sparkUi.entries = [];
  sparkUi.filesError = ''; sparkUi.filesLoading = true; renderSpark();
  try {
    const result = await api.sparkFiles(relative, root, selectedDeviceId());
    if (request !== sparkUi.filesRequest || location !== sparkFilesKey()) return;
    if (result.ok) { sparkUi.entries = result.data.entries; sparkUi.filesLoadedKey = location; }
    else { sparkUi.entries = []; sparkUi.filesLoadedKey = ''; sparkUi.filesError = result.error || 'Could not load files from the device.'; }
  } catch (error) {
    if (request === sparkUi.filesRequest && location === sparkFilesKey()) { sparkUi.entries = []; sparkUi.filesLoadedKey = ''; sparkUi.filesError = error.message || 'Could not load files from the device.'; }
  } finally { if (request === sparkUi.filesRequest) { sparkUi.filesLoading = false; renderSpark(); } }
}
async function refreshSpark(force = false) {
  if (Array.isArray(state.devices) && api.deviceStatus) {
    if (sparkUi.devicesChecking) { if (force === true) sparkUi.devicesRefreshAgain = true; return; }
    sparkUi.devicesChecking = true;
    try {
      const response = await api.deviceStatus(force);
      if (response.ok) state.devices = response.data;
      syncSelectedDevice(); renderSpark();
      const selected = deviceById();
      if (ui.tab === 'spark' && devicesUi.page === 'detail' && !devicesUi.local && !sparkSetup.active && selected?.connected) void refreshDeviceManagement(selected);
      if (ui.tab === 'spark' && $('#spark-files-section').open && sparkUi.connected) await refreshSparkFiles();
    } finally {
      sparkUi.devicesChecking = false;
      if (sparkUi.devicesRefreshAgain) { sparkUi.devicesRefreshAgain = false; void refreshSpark(true); }
    }
    return;
  }
  if (sparkUi.busy || sparkUi.storageBusy) { if (force === true) sparkUi.refreshAgain = true; return; }
  sparkUi.busy = true;
  const host = state.settings.sparkHost;
  try {
    const result = await api.sparkStatus(force === true);
    if (host !== state.settings.sparkHost) return;
    if (result.ok && result.data.status) { sparkUi.status = result.data.status; sparkUi.host = state.settings.sparkHost; }
    if (result.ok && result.data.connected) {
      sparkUi.connected = true; sparkUi.host = state.settings.sparkHost; sparkUi.status = result.data.status; sparkUi.error = '';
      applySparkBrowse();
      if (ui.tab === 'spark' && $('#spark-files-section').open) await refreshSparkFiles();
    } else { sparkUi.connected = false; sparkUi.error = result.error || result.data?.error || ''; }
    renderSpark();
  } catch (error) {
    if (host === state.settings.sparkHost) { sparkUi.connected = false; sparkUi.error = error.message || 'Could not reach the device.'; renderSpark(); }
  } finally {
    sparkUi.busy = false;
    if (ui.tab === 'transfers') renderTransfers();
    if (sparkUi.refreshAgain) { sparkUi.refreshAgain = false; refreshSpark(true); }
  }
}
function openSparkStorageDialog() {
  if (sparkUi.storageBusy || !sparkUi.connected) return;
  const deviceId = selectedDeviceId();
  const device = deviceById(deviceId);
  let closed = false;
  openModal({
    title: 'Add a storage destination on the device',
    sub: 'Use internal storage or a mounted external drive as your new download destination.',
    body: `<label class="spark-folder-label">Folder on the device<input id="spark-storage-folder" placeholder="/media/your-user/drive/Models" spellcheck="false" /></label><button class="btn sm spark-browse-button" id="spark-storage-browse">Browse device folders…</button><div class="spark-folder-browser" id="spark-storage-browser" hidden></div><p class="hf-help">Connect and mount an external drive on the device first. Browse to it or enter its full folder path, including a new final folder if you want one.</p><div class="spark-install-summary"><strong>FrostByte will give its companion access to this folder.</strong><p>The companion restarts briefly. Existing jobs and files are kept. Gated HuggingFace jobs may need Resume after the restart.</p></div><p id="spark-storage-progress" class="hf-help" role="status" hidden></p><p id="spark-storage-error" class="spark-setup-error" role="alert" hidden></p>`,
    actions: [{ label: 'Cancel', kind: 'btn' }, { label: 'Add storage folder', kind: 'btn primary', onClick: async () => {
      const downloadDir = $('#spark-storage-folder').value.trim();
      const error = $('#spark-storage-error');
      if (!downloadDir.startsWith('/') || downloadDir.includes('\0')) { error.textContent = 'Choose a full folder path on the device, starting with /.'; error.hidden = false; return; }
      if (sparkStorage().some(root => root.path === downloadDir)) { error.textContent = 'This folder is already a storage destination.'; error.hidden = false; return; }
      if (device?.managed) {
        closeModal();
        await beginSparkAdminSetup(device, 'Enter the device account password to add the selected storage folder. FrostByte never saves this password.', { type: 'add-storage', deviceId, downloadDir });
        return;
      }
      error.hidden = true; sparkUi.storageBusy = true;
      $('#spark-storage-folder').disabled = true; $('#spark-storage-browse').disabled = true; $('#spark-storage-browser').hidden = true;
      $('#spark-storage-progress').textContent = 'Adding the folder on the device…'; $('#spark-storage-progress').hidden = false;
      $('#modal-acts button:not(.primary)').textContent = 'Close';
      renderSpark();
      try {
        const result = await api.sparkStorageAdd({ downloadDir, deviceId });
        if (!result.ok) throw new Error(result.error);
        if (result.data?.cancelled) {
          $('#spark-storage-progress').hidden = true; $('#spark-storage-folder').disabled = false; $('#spark-storage-browse').disabled = false;
          $('#modal-acts button:not(.primary)').textContent = 'Cancel';
          return;
        }
        if (Array.isArray(state.devices)) { state.devices = state.devices.map(device => device.id === deviceId ? { ...device, connected: true, error: '', status: result.data.status } : device); syncSelectedDevice(); }
        else { sparkUi.host = result.data.host || state.settings.sparkHost; sparkUi.status = result.data.status; sparkUi.connected = true; sparkUi.error = ''; }
        if (deviceId === selectedDeviceId()) { sparkUi.root = downloadDir; sparkUi.relative = ''; }
        const selected = await chooseSparkDestination(downloadDir, deviceId);
        if (!closed) closeModal();
        await refreshSparkFiles(); toast(selected ? 'Folder selected for new device downloads.' : 'Folder added. Select it as your download destination when ready.');
      } catch (problem) {
        if (closed) toast(problem.message || 'Could not add the storage folder. Try again.', 'error');
        else { error.textContent = problem.message || 'Could not add the storage folder. Try again.'; error.hidden = false; $('#spark-storage-progress').hidden = true; $('#spark-storage-folder').disabled = false; $('#spark-storage-browse').disabled = false; $('#modal-acts button:not(.primary)').textContent = 'Cancel'; }
      } finally { sparkUi.storageBusy = false; renderSpark(); }
    } }],
    onDismiss: () => { closed = true; },
    onMount: () => { $('#spark-storage-browse').onclick = () => showSparkFolderBrowser($('#spark-storage-browser'), { onChoose: path => { $('#spark-storage-folder').value = path; } }); },
  });
}
function bindSparkView() {
  sparkSetup.active = false;
  renderSparkSetup();
  $('#device-add').onclick = async () => { await cancelSparkSetup({ keepOpen: true }); renderSpark(); };
  $('#devices-back').onclick = () => {
    const id = dashboardDevice()?.id;
    devicesUi.page = 'overview'; renderSpark(); $('#view-spark').scrollTop = 0;
    [...$('#device-cards').querySelectorAll('button')].find(button => button.dataset.selectDevice === id)?.focus();
  };
  $('#device-cards').onclick = async event => {
    const id = event.target.closest('[data-select-device]')?.dataset.selectDevice;
    if (!id || sparkUi.storageBusy || sparkSetup.busy || devicesUi.selecting) return;
    devicesUi.selecting = true;
    try {
      if (sparkSetup.active) await cancelSparkSetup();
      sparkSetup.active = false; renderSparkSetup();
      if (id === 'local') { devicesUi.local = true; devicesUi.page = 'detail'; renderSpark(); }
      else if (await selectRemoteDevice(id)) void refreshSpark();
      if (devicesUi.page === 'detail') { $('#view-spark').scrollTop = 0; $('#devices-back').focus(); }
    } finally { devicesUi.selecting = false; }
  };
  api.onDevices?.(value => { state.devices = value; syncSelectedDevice(); renderSpark(); });
  $('#spark-setup-open').addEventListener('click', async () => { await cancelSparkSetup({ keepOpen: true }); sparkUi.error = ''; renderSpark(); $('#spark-setup-host')?.focus(); });
  $('#spark-setup').addEventListener('submit', e => { if (e.target.id === 'spark-setup-form') { e.preventDefault(); probeSparkSetup(); } });
  $('#spark-setup').addEventListener('change', e => {
    if (e.target.id === 'spark-use-frigid') $('#spark-setup-folder').value = e.target.checked ? sparkSetup.result.frigidLibrary : sparkSetup.result.downloadDir;
  });
  $('#spark-setup').addEventListener('input', e => {
    if (e.target.id === 'spark-setup-folder' && $('#spark-use-frigid')) $('#spark-use-frigid').checked = e.target.value.trim() === sparkSetup.result.frigidLibrary;
  });
  $('#spark-setup').addEventListener('click', async e => {
    const mode = e.target.closest('[data-spark-mode]');
    if (mode && !sparkSetup.busy) { captureSparkConnection(); sparkSetup.mode = mode.dataset.sparkMode; sparkSetup.credentials = null; sparkSetup.error = ''; renderSparkSetup(); return; }
    const action = e.target.closest('[data-spark-setup]')?.dataset.sparkSetup;
    if (!action) return;
    if (action === 'cancel') { await cancelSparkSetup(); renderSpark(); }
    else if (action === 'review-update') { sparkSetup.stage = 'review'; sparkSetup.result.downloadDir = sparkSetup.result.status?.downloadDir || sparkSetup.result.downloadDir; renderSparkSetup(); }
    else if (action === 'trust') await probeSparkSetup(sparkSetup.result?.fingerprint);
    else if (action === 'browse') await showSparkFolderBrowser($('#spark-setup-browser'), { sessionId: sparkSetup.result?.sessionId, onChoose: path => { $('#spark-setup-folder').value = path; $('#spark-setup-folder').dispatchEvent(new Event('input', { bubbles: true })); } });
    else if (action === 'retry') { await cancelSparkSetup({ keepOpen: true, preserveIntent: true }); $('#spark-setup-host')?.focus(); }
    else if (action === 'install' || action === 'connect') await finishSparkSetup(action);
    else if (action === 'add-storage') await finishSparkStorageSetup();
  });
  api.onSparkSetupProgress?.(event => {
    if (event.sessionId === 'storage') { if ($('#spark-storage-progress')) $('#spark-storage-progress').textContent = event.message || 'Adding the folder on the device…'; return; }
    if (!sparkSetup.active || !sparkSetup.busy || event.sessionId !== sparkSetup.result?.sessionId) return;
    sparkSetup.progress = event.message || 'Setting up your device…';
    sparkSetup.percent = Number.isFinite(event.percent) ? Math.min(100, Math.max(0, event.percent)) : undefined;
    if ($('#spark-setup-progress')) $('#spark-setup-progress').textContent = sparkSetup.progress;
    const progress = $('#spark-setup-progress-bar');
    if (progress) { if (Number.isFinite(sparkSetup.percent)) { progress.max = 100; progress.value = sparkSetup.percent; } else progress.removeAttribute('value'); }
  });
  $('#spark-connect').addEventListener('click', async () => {
    const host = $('#spark-host').value.trim(), button = $('#spark-connect');
    sparkUi.connecting = true; button.disabled = true; button.textContent = 'Connecting…';
    try {
      const result = await api.sparkConnect(host);
      if (result.ok) {
        if (result.data?.cancelled) return;
        state.settings.sparkHost = host; sparkUi.host = host; sparkUi.status = result.data; sparkUi.connected = true; sparkUi.error = ''; sparkUi.relative = '';
        if (Array.isArray(state.devices)) {
          const current = deviceById();
          if (current) {
            current.host = host;
            current.connected = true;
            current.error = '';
            current.status = result.data;
            const roots = result.data?.storageRoots?.length ? result.data.storageRoots : [result.data?.downloadDir].filter(Boolean);
            if (result.data?.downloadDir && (!current.defaultDir || !roots.includes(current.defaultDir))) {
              current.defaultDir = result.data.downloadDir;
            }
          }
          const devicesRes = await api.deviceStatus?.(false);
          if (devicesRes?.ok) { state.devices = devicesRes.data; syncSelectedDevice(); }
        }
        applySparkBrowse();
        sparkSetup.active = false; devicesUi.page = 'detail'; renderSparkSetup();
        await refreshSparkFiles();
      } else { sparkUi.connected = false; sparkUi.error = result.error; }
      renderSpark();
    } finally { sparkUi.connecting = false; button.disabled = false; button.textContent = 'Connect'; }
  });
  $('#spark-host').addEventListener('keydown', e => { if (e.key === 'Enter') $('#spark-connect').click(); });
  $('#spark-refresh').addEventListener('click', () => refreshSpark(true));
  $('#spark-open-library').addEventListener('click', () => { ui.libraryDevice = 'spark'; goTab('library'); });
  $('#spark-open-torrents').addEventListener('click', () => { ui.torrentsDevice = 'spark'; goTab('catalog'); });
  $('#spark-open-transfers').addEventListener('click', () => { ui.transferDevice = 'spark'; goTab('transfers'); });
  $('#spark-storage-add').addEventListener('click', openSparkStorageDialog);
  $('#spark-download-destination').addEventListener('change', async e => {
    if (await chooseSparkDestination(e.target.value)) toast('New device downloads will use this folder.');
  });
  $('#spark-library-root').addEventListener('change', e => { sparkUi.root = e.target.value; sparkUi.relative = ''; refreshSparkFiles(); });
  $('#spark-files-section').addEventListener('toggle', () => { if ($('#spark-files-section').open && sparkUi.connected) refreshSparkFiles(); });
  $('#spark-up').addEventListener('click', () => { sparkUi.relative = sparkUi.relative.split('/').slice(0, -1).join('/'); refreshSparkFiles(); });
  $('#spark-content').addEventListener('click', async e => {
    if (e.target.closest('#spark-files-retry')) { await refreshSparkFiles(); return; }
    const folder = e.target.closest('[data-spark-dir]');
    if (folder) { sparkUi.relative = folder.dataset.sparkDir; await refreshSparkFiles(); return; }
    const button = e.target.closest('[data-spark-action], [data-spark-share]');
    if (!button) return;
    const action = button.dataset.sparkAction || 'seed', id = button.dataset.id || button.dataset.sparkShare, deviceId = selectedDeviceId(), root = sparkUi.root;
    if (action === 'torrent:remove' && !await askModal('Remove this device transfer?', 'Downloaded files stay on the device.', { yes: 'Remove transfer' })) return;
    if (action === 'seed' && !await askModal('Share this from the device?', id, { yes: 'Share on swarm' })) return;
    button.disabled = true;
    try {
      const result = await api.sparkControl(action, id, root, deviceId);
      if (!result.ok) toast(result.error, 'error');
      else if (result.data?.cancelled) return;
      else if (action === 'seed') {
        try { if (await api.copyText(result.data.magnetURI)) toast('Sharing from the device. Magnet link copied.'); }
        catch { openModal({ title: 'Sharing from the device', sub: 'Copy this magnet link to share your files.', body: `<textarea id="spark-share-link" aria-label="Device magnet link" readonly>${esc(result.data.magnetURI)}</textarea>`, actions: [{ label: 'Done', kind: 'btn primary' }], onMount: () => { $('#spark-share-link').select(); } }); }
      }
      await refreshSpark();
    } finally { button.disabled = false; }
  });
  setInterval(() => { if (state.settings.sparkHost) refreshSpark(); }, 5000);
  setInterval(() => {
    if (ui.tab === 'spark' && devicesUi.page === 'detail' && !sparkSetup.active && dashboardDevice()?.id === 'local') void refreshDeviceManagement(dashboardDevice());
    if (ui.tab === 'dashboard') refreshDashboardTelemetry();
  }, 5000);
  if (state.settings.sparkHost) refreshSpark();
}


/* ================================ SHELL ================================== */

function bindNav() {
  $$('#nav .nav').forEach(n => {
    n.setAttribute('role', 'button'); n.tabIndex = 0;
    n.addEventListener('click', () => goTab(n.dataset.tab));
    n.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTab(n.dataset.tab); } });
  });
  bindHubView();
  bindHubSettings();
}

function goTab(tab) {
  if (ui.tab === 'settings' && tab !== 'settings') {
    concealPublisher();
    if ($('#set-hubtoken')) $('#set-hubtoken').value = '';
  }
  // Old installations can remember the retired Search tab; 'hub' aliases 'discover'.
  if (tab === 'search') tab = 'transfers';
  if (tab === 'hub') tab = 'discover';
  const tabs = ['dashboard', 'transfers', 'library', 'discover', 'catalog', 'hf', 'spark', 'settings'];
  if (!tabs.includes(tab)) tab = 'dashboard';
  ui.tab = tab;
  document.documentElement.dataset.activeTab = tab;
  store.set('lastTab', tab);
  $$('#nav .nav').forEach((n) => n.classList.toggle('on', n.dataset.tab === tab));
  for (const t of tabs) {
    const el = $('#view-' + t);
    if (el) el.hidden = t !== tab;
  }
  $('#omni').value = ui.transferQuery;
  if (tab !== 'catalog') closeDrawer();
  if (tab !== 'dashboard' && dashboardRemoteTimer) { clearTimeout(dashboardRemoteTimer); dashboardRemoteTimer = null; }
  if (tab === 'dashboard') { renderDashboard({ force: true }); refreshDashboardTelemetry({ immediate: false }); if (state.settings.sparkHost) refreshSpark(); }
  if (tab === 'transfers') { renderTransfers(); if (state.settings.sparkHost) refreshSpark(); }
  if (tab === 'library') { renderLibrary(); refresh(); if (state.settings.sparkHost) refreshSpark(true); }
  if (tab === 'catalog') { renderTorrents(); renderCatalog(); refresh(); if (state.settings.sparkHost) refreshSpark(true); }
  if (tab === 'hf') renderHfTokenState();
  if (tab === 'spark') { renderSpark(); if (state.settings.sparkHost) refreshSpark(); }
  if (tab === 'settings') renderSettings();
}

const isDownloadSource = value => isIpfsInput(value) || /^magnet:/i.test(value) || /^[a-fA-F0-9]{40}$/.test(value) || /^[a-z2-7]{32}$/i.test(value);
function searchDownloads(value) {
  ui.transferQuery = value;
  if (ui.tab !== 'transfers') { ui.transferDevice = 'all'; goTab('transfers'); }
  else renderTransfers();
}
function clearDownloadSearch() {
  ui.transferQuery = ''; $('#omni').value = ''; renderTransfers();
}
function bindOmni() {
  const omni = $('#omni');
  omni.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const value = omni.value.trim();
    if (isIpfsInput(value) || isDownloadSource(value)) { openAddDialog({ magnet: value }); clearDownloadSearch(); return; }
    searchDownloads(value);
  });
  omni.addEventListener('input', e => {
    if (!e.isComposing && ui.tab === 'transfers' && !isDownloadSource(omni.value.trim())) searchDownloads(omni.value);
  });
}

/* ------------------------- global keyboard model -------------------------- */

function bindGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    // Windows can deliver Ctrl+F to the page without invoking the native menu.
    const searchModifier = state.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (searchModifier && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && $('#modal').hidden) {
      e.preventDefault();
      goTab('transfers'); $('#omni').focus();
      return;
    }
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (!$('#ctxmenu').hidden) return closeCtxMenu();
      if (!$('#modal').hidden) return closeModal();
      if (!$('#drawer').hidden) return closeDrawer();
      if (document.activeElement === $('#omni') && ui.transferQuery) { e.preventDefault(); clearDownloadSearch(); return; }
      if (ui.tab === 'hf' && !$('#hf-detail').hidden) return closeHfDetail();
      return;
    }
    if (!$('#modal').hidden && e.key === 'Tab') {
      const focusable = [...$('#modal').querySelectorAll('button:not(:disabled), input, textarea, select')];
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      return;
    }
    if (inField || !$('#modal').hidden) return;

  });
}

function bindEvents() {
  api.onModelScan?.(value => {
    state.modelLibrary = value;
    updateLibraryCount();
    if (ui.tab === 'library') renderLibrary();
    if (ui.tab === 'catalog') renderTorrents();
  });
  api.onIpfsProgress?.(value => { state.ipfs = value; if (ui.tab === 'transfers') renderTransfers(); if (ui.tab === 'library') renderLibrary(); if (ui.tab === 'catalog') renderTorrents(); });
  api.onHfProgress?.(({ downloads, inventory }) => {
    state.downloads = downloads ?? [];
    if (Array.isArray(inventory)) { state.inventory = inventory; updateLibraryCount(); if (ui.tab === 'library') renderLibrary(); if (ui.tab === 'catalog') renderTorrents(); }
    if (ui.tab === 'transfers') renderTransfers();
  });
  api.onTorrent(({ event, torrent }) => {
    if (!torrent) return;
    if (event === 'removed') applyState({ torrents: state.torrents.filter(t => t.infoHash !== torrent.infoHash) });
    else applyState({ torrents: mergeTorrent(torrent) });
  });
  api.onNotice(({ level, message }) => toast(message, level));
  api.onMenuAction((action) => {
    if (action === 'feedback') openFeedback();
    if (action === 'privacy') { goTab('settings'); $('#settings-nav [data-sec="privacy"]').click(); }
    if (action === 'turtle') $('#turtle')?.click();
    if (action === 'add-source') openAddDialog();
    if (action === 'seed-folder') shareFolder();
    if (action === 'focus-search') {
      goTab('transfers'); $('#omni').focus();
    }
    if (action === 'tab-transfers') goTab('transfers');
    if (action === 'tab-library') goTab('library');
    if (action === 'tab-search') goTab('transfers');
    if (action === 'tab-catalog') goTab('catalog');
    if (action === 'about') { goTab('settings'); $('#settings-nav [data-sec="about"]').click(); }
  });
}

function mergeTorrent(t) {
  const list = [...(state.torrents ?? [])];
  const i = list.findIndex((x) => x.infoHash === t.infoHash);
  if (i >= 0) list[i] = t; else list.push(t);
  return list;
}

/* ================================ DIALOGS ================================ */

// Each launch-service request retains its main-process lease ID until the
// review is accepted or dismissed. Ordinary drag/drop entries have no lease.
const droppedSources = [];
let dropDialogOpen = false;
let launchSourceRequest = null;
let launchSourceWakePending = false;
function exactDownloadSource(value) {
  const original = String(value ?? '');
  const trimmed = original.trim();
  // Whitespace surrounding pasted magnets and hashes is formatting. For a
  // local path, it may be part of the selected filename and is capability-
  // bound, so preserve it byte-for-byte through preview and download.
  return /^magnet:/i.test(trimmed) || /^[a-f0-9]{40}$/i.test(trimmed) || /^[a-z2-7]{32}$/i.test(trimmed)
    ? trimmed : original;
}
function showNextDrop() {
  if (dropDialogOpen || !$('#modal').hidden) return;
  if (!droppedSources.length) { requestLaunchSource(); return; }
  const delivery = droppedSources.shift();
  dropDialogOpen = true;
  openAddDialog({ magnet: delivery.source }, () => {
    // Keep the modal gate closed while main releases the lease. If the ack is
    // interrupted, the next request deliberately receives the same source and
    // grant again instead of silently losing an OS launch request.
    Promise.resolve().then(() => delivery.id ? api.acknowledgeSource(delivery.id) : undefined)
      .catch(error => toast(error.message || 'Could not finish the launch review.', 'warn'))
      .finally(() => { dropDialogOpen = false; setTimeout(showNextDrop, 0); });
  });
}

function requestLaunchSource() {
  if (launchSourceRequest || dropDialogOpen || !$('#modal').hidden || droppedSources.length) return launchSourceRequest;
  launchSourceWakePending = false;
  launchSourceRequest = api.pendingSources().then(result => {
    if (result.ok && Array.isArray(result.data)) {
      for (const delivery of result.data) {
        if (delivery && typeof delivery === 'object' && typeof delivery.id === 'string'
          && typeof delivery.source === 'string' && droppedSources.length < 20) droppedSources.push(delivery);
      }
    }
  }).finally(() => {
    launchSourceRequest = null;
    if (droppedSources.length) showNextDrop();
    else if (launchSourceWakePending) queueMicrotask(requestLaunchSource);
  });
  return launchSourceRequest;
}

function bindDrop() {
  api.onSource(() => { launchSourceWakePending = true; requestLaunchSource(); });
  requestLaunchSource();
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay'; overlay.hidden = true;
  overlay.innerHTML = '<div><strong>Drop to review your download</strong><span>Torrent files, magnet links or IPFS links · choose files before downloading</span></div>';
  document.body.appendChild(overlay);
  let depth = 0;
  const external = e => e.dataTransfer && ['Files', 'text/uri-list', 'text/plain'].some(type => [...e.dataTransfer.types].includes(type));
  document.addEventListener('dragenter', e => { if (external(e)) { e.preventDefault(); depth++; overlay.hidden = false; } });
  document.addEventListener('dragover', e => { if (external(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', e => { if (external(e) && --depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener('blur', () => { depth = 0; overlay.hidden = true; });
  document.addEventListener('drop', async e => {
    e.preventDefault(); depth = 0; overlay.hidden = true;
    const sources = [], files = [...e.dataTransfer.files].slice(0, 20);
    for (const file of files) {
      if (!/\.torrent$/i.test(file.name.trim())) { toast(`Choose a .torrent file to download. ${file.name} is not torrent metadata.`, 'warn'); continue; }
      try {
        const filePath = await api.droppedFilePath(file);
        if (filePath) sources.push(filePath);
      } catch (error) { toast(error.message, 'warn'); }
    }
    if (!files.length) {
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      sources.push(...text.split(/\r?\n/).map(s => s.trim()).filter(isDownloadSource));
    }
    if (!sources.length && !files.length) toast('Drop a magnet link, an IPFS link or a .torrent file.', 'warn');
    droppedSources.push(...[...new Set(sources)].slice(0, Math.max(0, 20 - droppedSources.length))
      .map(source => ({ id: '', source })));
    showNextDrop();
  });
}

function openAddDialog(prefill, onDismiss) {
  if (isIpfsInput(prefill?.magnet)) { ipfsUi.open(prefill.magnet, '', onDismiss); return; }
  let preview = null, previewSource = '', selected = new Set(), filter = '', request = null, closed = false;
  let destination = state.settings.downloadDir, target = 'mac', deviceId = selectedDeviceId(), remoteDestination = sparkDownloadRoot('', deviceId);
  const cancelPreview = () => { if (request) api.cancelInspect(request); request = null; };
  const updateSummary = () => {
    if (!$('#dl-summary')) return;
    const files = preview?.files.filter(f => selected.has(f.path)) || [];
    $('#dl-summary').textContent = preview ? describeSelectionFootprint(preview, files, fmtBytes) : 'All files · size available after metadata arrives';
    $('#modal-acts button.primary').disabled = Boolean(preview && !files.length) || (target === 'spark' && !sparkRootAvailable(remoteDestination, deviceId));
    $('#modal-acts button.primary').textContent = preview ? 'Download selected' : 'Download all';
  };
  const renderFiles = () => {
    const files = preview?.files.filter(f => f.path.toLowerCase().includes(filter.toLowerCase())) || [];
    $('#dl-files').innerHTML = files.map(f => `<label class="hf-file"><input type="checkbox" data-torrent-file="${esc(f.path)}" ${selected.has(f.path) ? 'checked' : ''} /><span class="fname" title="${esc(f.path)}">${esc(f.path)}</span><span class="fsize">${fmtBytes(f.length)}</span></label>`).join('');
    $$('#dl-files input').forEach(input => input.addEventListener('change', () => {
      if (input.checked) selected.add(input.dataset.torrentFile); else selected.delete(input.dataset.torrentFile);
      updateSummary();
    }));
    updateSummary();
  };
  const inspect = async () => {
    cancelPreview(); preview = null; previewSource = ''; selected.clear();
    $('#dl-file-picker').hidden = true;
    const source = exactDownloadSource($('#dl-magnet').value);
    if (!source.trim()) { $('#dl-status').textContent = 'Add a source to see its files.'; updateSummary(); return; }
    const id = crypto.randomUUID(); request = id;
    $('#dl-status').textContent = /\.torrent$/i.test(source.trim()) ? 'Reading torrent…' : 'Finding the file list from peers… You can also download all files now.';
    updateSummary();
    try {
      const result = await api.inspectTorrent(source, id);
      if (closed || request !== id || exactDownloadSource($('#dl-magnet').value) !== source) return;
      if (result.ok && result.data.cancelled) { $('#dl-status').textContent = 'Preview cancelled. No peer discovery was started.'; return; }
      if (!result.ok || result.data.error) { $('#dl-status').textContent = result.error || result.data.error; return; }
      preview = result.data.preview; previewSource = source;
      selected = new Set(preview.files.map(f => f.path));
      $('#dl-status').textContent = preview.name;
      $('#dl-file-picker').hidden = false;
      renderFiles();
    } catch (error) { if (!closed && request === id) $('#dl-status').textContent = error.message; }
  };
  openModal({
    title: 'Add a download',
    sub: 'Models, configs, updates, archives — choose what you need. Downloads start when you confirm.',
    body: `<div class="field"><label for="dl-magnet">Magnet link, infohash, or torrent file</label><textarea id="dl-magnet" placeholder="Paste a magnet link, or drop a .torrent file…">${esc(prefill?.magnet ?? prefill?.infohash ?? '')}</textarea></div>
      <div class="dl-source-tools"><button class="btn sm" id="dl-ipfs">IPFS download…</button><button class="btn sm" id="dl-file">Choose a .torrent file…</button><button class="btn sm" id="dl-preview">Preview files</button></div>
      <p id="dl-status" class="hf-help" aria-live="polite">Add a source to see its files.</p>
      <div id="dl-file-picker" hidden><div class="dl-file-tools"><input id="dl-filter" aria-label="Filter torrent files" placeholder="Find a file…" /><button class="hf-link" id="dl-all">Select shown</button><button class="hf-link" id="dl-none">Clear</button></div><div id="dl-files" class="hf-files"></div><p class="hf-help">Downloads run in whole pieces, and one piece can span several files. When files are packed tightly together, picking one fetches all of them — the size above shows exactly what will land on disk.</p></div>
      <label class="download-target">Keep in <select id="dl-kind" aria-label="Download category"><option value="">Automatic — detect model files</option><option value="model">My Models</option><option value="torrent">Torrents</option></select></label>
      <label class="download-target">Download on <select id="dl-target" aria-label="Torrent download device">${downloadDeviceOptions()}</select></label>
      <label class="download-target spark-download-folder" id="dl-spark-folder" hidden>Folder on the device <select id="dl-spark-destination" aria-label="Torrent folder on the device">${sparkStorageOptions(remoteDestination)}</select></label>
      <div class="hf-destination" id="dl-mac-folder"><span>Save to</span><span id="dl-destination" title="${esc(destination)}">${esc(destination)}</span><button class="hf-link" id="dl-folder">Change</button></div>
      <strong id="dl-summary" aria-live="polite"></strong>`,
    actions: [
      { label: 'Cancel', kind: 'btn' },
      { label: 'Download all', kind: 'btn primary', onClick: async () => {
        const source = exactDownloadSource($('#dl-magnet').value);
        if (isIpfsInput(source)) { ipfsUi.open(source); return; }
        if (!source.trim()) return toast('Add a magnet link or a .torrent file first.', 'warn');
        // A changed source must never inherit the previous torrent's selections.
        const paths = preview && previewSource === source ? [...selected] : undefined;
        if (paths && !paths.length) return;
        if (target === 'spark' && !sparkRootAvailable(remoteDestination, deviceId)) return toast('Choose an available storage folder on the device.', 'warn');
        const result = await api.add(source, { kind: $('#dl-kind').value || undefined, destination: target === 'spark' ? remoteDestination : destination, target, deviceId: target === 'spark' ? deviceId : undefined, selectedPaths: paths && paths.length < preview.files.length ? paths : undefined });
        if (!result.ok) toast(result.error, 'error');
        else if (!result.data.cancelled) { if (result.data.remote) { sparkUi.root = remoteDestination; sparkUi.relative = ''; } applyState(result.data.state); closeModal(); clearDownloadSearch(); ui.transferDevice = 'all'; goTab('transfers'); if (result.data.remote) refreshSpark(); toast('Download added. Connecting to peers…'); }
      } },
    ],
    onDismiss: () => { closed = true; cancelPreview(); onDismiss?.(); },
    onMount: () => {
      $('#dl-magnet').focus();
      $('#dl-magnet').addEventListener('input', () => {
        cancelPreview(); preview = null; previewSource = ''; $('#dl-file-picker').hidden = true;
        $('#dl-status').textContent = 'Click Preview files to choose individual files.'; updateSummary();
      });
      $('#dl-target').addEventListener('deviceavailability', updateSummary);
      $('#dl-target').addEventListener('change', e => { target = e.target.value === 'mac' ? 'mac' : 'spark'; if (target === 'spark') { deviceId = e.target.value; remoteDestination = sparkDownloadRoot('', deviceId); fillSparkStorageSelect($('#dl-spark-destination'), remoteDestination, deviceId); } const dir = target === 'spark' ? remoteDestination : destination; $('#dl-destination').textContent = dir; $('#dl-destination').title = dir; $('#dl-mac-folder').hidden = target === 'spark'; $('#dl-spark-folder').hidden = target !== 'spark'; updateSummary(); });
      $('#dl-spark-destination').addEventListener('change', e => { remoteDestination = e.target.value; if (target === 'spark') { $('#dl-destination').textContent = remoteDestination; $('#dl-destination').title = remoteDestination; } updateSummary(); });
      $('#dl-preview').addEventListener('click', () => isIpfsInput($('#dl-magnet').value) ? ipfsUi.open($('#dl-magnet').value.trim()) : inspect());
      $('#dl-ipfs').onclick = () => ipfsUi.open(isIpfsInput($('#dl-magnet').value) ? $('#dl-magnet').value.trim() : '');
      $('#dl-file').addEventListener('click', async () => { const p = await api.pickTorrentFile(); if (p && !closed) { $('#dl-magnet').value = p; inspect(); } });
      $('#dl-folder').addEventListener('click', async () => { const p = await api.pickSaveDir(); if (p && !closed) { destination = p; $('#dl-destination').textContent = p; $('#dl-destination').title = p; } });
      $('#dl-filter').addEventListener('input', e => { filter = e.target.value; renderFiles(); });
      $('#dl-all').addEventListener('click', () => { preview.files.filter(f => f.path.toLowerCase().includes(filter.toLowerCase())).forEach(f => selected.add(f.path)); renderFiles(); });
      $('#dl-none').addEventListener('click', () => { selected.clear(); renderFiles(); });
      updateSummary();
      if ($('#dl-magnet').value.trim()) inspect();
    },
  });
}

let modalDismiss = null;
let modalFocus = null;
function openModal({ title, sub, body = '', actions = [], onMount, onDismiss }) {
  closeModal();
  modalFocus = document.activeElement;
  modalDismiss = onDismiss || null;
  const scrim = $('#modal');
  $('#modal-body').innerHTML = `
    <h3 id="modal-title">${esc(title)}</h3>
    ${sub ? `<p class="sub" id="modal-description">${esc(sub)}</p>` : ''}
    ${body}
    <div class="modal-acts" id="modal-acts"></div>`;
  $('#modal-body').setAttribute('aria-labelledby', 'modal-title');
  if (sub) $('#modal-body').setAttribute('aria-describedby', 'modal-description');
  else $('#modal-body').removeAttribute('aria-describedby');
  const acts = $('#modal-acts');
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = a.kind || 'btn';
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      if (!a.onClick) return closeModal();
      b.disabled = true;
      try { await a.onClick(); } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
    });
    acts.appendChild(b);
  });
  scrim.hidden = false;
  scrim.onclick = (e) => { if (e.target === scrim) closeModal(); };
  onMount?.();
  if (!scrim.contains(document.activeElement)) scrim.querySelector('input, textarea, button')?.focus();
}

/** Promise-based yes/no dialog. Resolves true on the primary button. */
function askModal(title, sub, { yes = 'Pull it', no = 'Cancel', rememberLabel, onRemember } = {}) {
  return new Promise((resolve) => {
    let dismissed = false;
    openModal({
      title, sub,
      body: rememberLabel ? `<label class="check"><input type="checkbox" id="modal-remember" /> ${esc(rememberLabel)}</label>` : '',
      onDismiss: () => { dismissed = true; resolve(false); },
      actions: [
        { label: no, kind: 'btn', onClick: () => { closeModal(); resolve(false); } },
        { label: yes, kind: 'btn primary', onClick: async () => {
          if (rememberLabel && $('#modal-remember')?.checked && !await onRemember()) return;
          if (dismissed) return;
          modalDismiss = null; closeModal(); resolve(true);
        } },
      ],
    });
  });
}

function askLargeDownload(title, sub, yes = 'Download') {
  return askModal(title, sub, { yes, rememberLabel: 'Never show again for large downloads',
    onRemember: () => saveSettings({ confirmBigPull: false }),
  });
}

function closeModal() {
  const dismissed = modalDismiss;
  modalDismiss = null;
  dismissed?.();
  modalFocus?.focus?.();
  modalFocus = null;
  $('#modal').hidden = true;
  $('#modal-body').innerHTML = '';
  setTimeout(showNextDrop, 0);
}

function toast(message, level = 'ok') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${level === 'error' ? 'error' : level === 'warn' ? 'warn' : ''}`;
  el.textContent = message;
  if (level === 'error') {
    const feedback = document.createElement('button'); feedback.className = 'hf-link'; feedback.textContent = 'Send feedback';
    feedback.addEventListener('click', () => openFeedback()); el.append(' ', feedback);
  }
  wrap.appendChild(el);
  while (wrap.children.length > 4) wrap.firstChild.remove();
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 200ms';
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

async function copyLink(value) {
  try { if (await api.copyText(/^[a-f0-9]{40}$/i.test(value) || /^[a-z2-7]{32}$/i.test(value) ? `magnet:?xt=urn:btih:${value}` : value)) toast('Magnet link copied.'); }
  catch { toast('Could not copy the link. Try again.', 'error'); }
}

async function ensureConsent() {
  const welcome = $('#welcome');
  welcome.addEventListener('cancel', event => event.preventDefault());
  $('#welcome-quit').onclick = () => api.quit();
  $('#welcome-feedback').onclick = async () => {
    try { const result = await api.openExternal(COMMUNITY_LINKS.feedback); if (!result.ok) throw new Error(result.error || 'Could not open GitHub.'); }
    catch (error) { $('#welcome-error').textContent = error.message; $('#welcome-error').hidden = false; }
  };
  const result = await api.getPrivacy();
  if (result.ok && !result.data.required) { $('.app').inert = false; return; }
  welcome.showModal();
  const documents = await api.legalDocuments();
  if (!result.ok || !documents.ok) {
    $('#welcome-status').textContent = 'Could not load the terms. Quit and reopen FrostByte to try again.';
    return new Promise(() => {});
  }
  const policy = result.data;
  $('#welcome-status').textContent = `${documents.data.changes} Review the terms below before starting. We ask again only when the terms or privacy notice change.`;
  $('#welcome-terms').textContent = documents.data.terms;
  $('#welcome-privacy').textContent = documents.data.privacy;
  $('#accept-terms').disabled = false;
  $('#welcome-continue').disabled = false;
  await new Promise(resolve => {
    $('#welcome-form').onsubmit = async event => {
      event.preventDefault();
      if (!$('#accept-terms').checked) return;
      const button = $('#welcome-continue'); button.disabled = true;
      const accepted = await api.acceptTerms({ termsVersion: policy.termsVersion, privacyVersion: policy.privacyVersion, accepted: true, diagnosticsEnabled: false });
      if (!accepted.ok || accepted.data?.cancelled) {
        $('#welcome-error').textContent = accepted.error || 'Acceptance was cancelled. Keep reviewing or quit FrostByte.'; $('#welcome-error').hidden = false; button.disabled = false; return;
      }
      welcome.close(); $('.app').inert = false; resolve();
    };
  });
}

// --- FrostNet (Hub): coming-soon placeholder + settings + entitlement (local-first, no background polling) ---
const hubState = { tier: 'free', hubUrl: '', follows: [] };
function renderHubTier() {
  // P0 honesty: the FrostNet view is a placeholder until the sharing backend
  // ships — no tier/browsing claims there. The settings tier note is honest:
  // Free uses Search (Hugging Face); offline is a bundle SEED, not browsing.
  // Update nudges surface only in Settings (paid tiers); the placeholder stays clean.
  const updatesNote = $('#hub-updates-note-settings'); if (updatesNote && hubState.updateNudges != null) updatesNote.textContent = hubState.updateNudges ? `${hubState.updateNudges} update(s) available — see Transfers.` : '';
  const ent = $('#hub-entitlement-note'); if (ent) ent.textContent = `Tier: ${hubState.tier} · ${hubState.tier === 'free' ? 'Free — Search (Hugging Face); FrostNet community home coming soon' : hubState.tier === 'offline' ? 'Offline — bundle seed recorded; offline browsing arrives with FrostNet' : hubState.tier === 'plus' ? 'Plus — live updates' : hubState.tier === 'pro' ? 'Pro — live updates and assist' : 'Unrecognized tier — treated as Free'}`;
  const followsEl = $('#hub-follows'); if (followsEl) followsEl.innerHTML = hubState.follows.length ? hubState.follows.map(k => `<span class="hub-badge">${esc(k.slice(0, 12))}…</span>`).join('') + ` <button class="hf-link" id="hub-clear-follows">Clear all</button>` : '<span class="hf-help">No follows</span>';
  // textContent below — no esc() needed (digests are hex64 anyway).
  const bundleText = hubState.bundleDigest ? `Bundle seed recorded: ${hubState.bundleDigest.slice(0, 16)}… — offline browsing arrives with FrostNet.` : 'No bundle imported. A bundle is a signed catalog seed for NAS/air-gap machines — importing it stores the seed reference; offline browsing arrives with FrostNet.';
  const bundleNote = $('#hub-bundle-note'); if (bundleNote) bundleNote.textContent = bundleText;
  const bundleNoteSettings = $('#hub-bundle-note-settings'); if (bundleNoteSettings) bundleNoteSettings.textContent = bundleText;
}
function bindHubView() {
  // FrostNet is a coming-soon placeholder (P0): no search UI and no hubSearch
  // call from this view. The community home arrives with the sharing backend.
  $('#hub-coming-search')?.addEventListener('click', () => goTab('hf'));
  $('#hub-bundle-import')?.addEventListener('click', () => {
    openModal({ title: 'Import bundle seed', sub: 'Record a signed bundle digest (hex64). This stores the seed reference only — offline browsing arrives with FrostNet.',
      body: '<div class="field"><label for="hub-bundle-digest">Bundle digest</label><input id="hub-bundle-digest" placeholder="64 hex characters" spellcheck="false" /></div>',
      actions: [{ label: 'Cancel' }, { label: 'Import', kind: 'btn primary', onClick: async () => {
        const digest = $('#hub-bundle-digest')?.value?.trim();
        if (!digest || !/^[a-f0-9]{64}$/i.test(digest)) return toast('Paste a 64-character bundle digest.', 'warn');
        const res = await api.hubBundleImport({ bundleDigest: digest.toLowerCase() }); if (!res.ok) toast(res.error || 'Bundle import failed.', 'error'); else { hubState.bundleDigest = digest.toLowerCase(); renderHubTier(); toast('Bundle seed recorded — offline browsing arrives with FrostNet.'); closeModal(); }
      } }],
    });
  });
}
async function bindHubSettings() {
  try {
    const cfg = await api.hubConfig(); if (cfg?.ok) { hubState.hubUrl = cfg.data?.hubUrl || ''; hubState.follows = cfg.data?.follows || []; hubState.bundleDigest = cfg.data?.bundleDigest || ''; hubState.hasToken = Boolean(cfg.data?.hasToken); renderHubTier(); const u = $('#set-huburl'); if (u) u.value = hubState.hubUrl; }
    const ent = await api.hubEntitlement(); if (ent?.ok) { hubState.tier = ent.data?.tier || 'free'; renderHubTier(); }
    const acct = await api.hubAccount?.(); if (acct?.ok && acct.data) { state.hubAccount = acct.data.account || state.hubAccount; state.hubEntitlement = acct.data.entitlement || state.hubEntitlement; renderAccountChrome(); renderDashboard(); }
  } catch {}
  $('#btn-hub-browser-login')?.addEventListener('click', async () => {
    const s = $('#hub-login-status');
    if (s) s.textContent = '';
    await performHubBrowserLogin({ statusEl: s });
  });
  $('#btn-hub-sync')?.addEventListener('click', () => { void syncHubAccount({ statusEl: $('#hub-login-status') }); });
  $('#btn-hub-handle-save')?.addEventListener('click', () => { void saveHubHandle(); });
  $('#btn-hub-handle-release')?.addEventListener('click', () => { void releaseHubHandle(); });
  $('#btn-hub-profile-save')?.addEventListener('click', () => { void saveHubProfile(); });
  $('#btn-hub-bind-publisher')?.addEventListener('click', () => { void bindPublisherToAccount(); });
  $('#btn-hub-logout')?.addEventListener('click', () => { void performHubLogout({ statusEl: $('#hub-login-status') }); });
  $('#btn-save-hubtoken')?.addEventListener('click', async () => {
    const tok = $('#set-hubtoken')?.value ?? ''; const s = $('#hub-token-status'); if (s) s.textContent = '';
    const res = await api.hubSetToken(tok); if (!res?.ok) { if (s) s.textContent = res?.error || 'Save failed.'; return; }
    if (s) s.textContent = res?.data?.hasToken ? 'Token saved.' : 'Cleared.'; $('#set-hubtoken').value = '';
    await refresh(); renderAccountChrome(); renderDashboard({ force: true });
  });
  $('#btn-clear-hubtoken')?.addEventListener('click', async () => {
    await api.hubSetToken(''); const s = $('#hub-token-status'); if (s) s.textContent = 'Cleared.';
    await refresh(); renderAccountChrome(); renderDashboard({ force: true });
  });
  $('#btn-hub-check')?.addEventListener('click', async () => {
    // Health probe, not search: /v1/search is not deployed, and probing it
    // reported a healthy Hub as "not reachable". /v1/health is deployed.
    const res = await api.hubHealth();
    const healthy = Boolean(res?.ok && res.data && (res.data.status === 'ok' || res.data.ok === true));
    toast(healthy ? 'Hub is reachable.' : (res?.error || 'Hub is not reachable.'), healthy ? 'ok' : 'warn');
  });
  $('#btn-hub-bundle-check')?.addEventListener('click', async () => {
    const res = await api.hubBundleLatest(); if (!res?.ok) return toast(res?.error || 'Bundle service is not available yet — it arrives with FrostNet.', 'warn'); toast(`Bundle: ${res.data?.digest?.slice(0, 12) || '—'} · ${new Date(res.data?.createdAt || Date.now()).toLocaleDateString()}`);
  });
  $('#btn-hub-offline')?.addEventListener('click', async () => {
    // Offline is a local mode, not a paid tier: it records the bundle-seed mode.
    // Browsing the bundle arrives with FrostNet. Plus/Pro can only be granted by the Hub.
    const res = await api.hubSetEntitlement({ tier: 'offline' });
    if (res?.ok) { hubState.tier = 'offline'; renderHubTier(); toast('Offline mode set — bundle seed only; offline browsing arrives with FrostNet.'); }
    else toast(res?.error || 'Offline mode is not available.', 'warn');
  });
  $('#btn-hub-follow')?.addEventListener('click', async () => {
    const pubkey = $('#set-hub-follow')?.value?.trim() ?? ''; if (!/^[a-f0-9]{64}$/i.test(pubkey)) return toast('Paste a 64-character creator key.', 'warn');
    const res = await api.hubFollow(pubkey); if (!res?.ok) return toast(res.error || 'Follow failed.', 'warn'); hubState.follows = res.data?.follows || []; renderHubTier(); $('#set-hub-follow').value = ''; toast('Following creator.');
  });
  document.addEventListener('click', async e => {
    if (e.target.closest('#hub-clear-follows')) { await api.hubSetConfig({ follows: [] }); hubState.follows = []; renderHubTier(); }
  });
  api.onHubUpdates?.((msg) => { if (msg?.tier) { hubState.tier = msg.tier; } if (Array.isArray(msg?.nudges)) { hubState.updateNudges = msg.nudges.length; } renderHubTier(); });
  api.onHubChanges?.((msg) => {
    if (msg?.follows) { hubState.follows = msg.follows; renderHubTier(); }
    if (msg?.bundleDigest) { hubState.bundleDigest = msg.bundleDigest; renderHubTier(); }
    if (Object.hasOwn(msg || {}, 'hasToken')) { hubState.hasToken = Boolean(msg.hasToken); renderHubTier(); }
    if (msg?.account) state.hubAccount = msg.account;
    if (msg?.entitlement) { state.hubEntitlement = msg.entitlement; hubState.tier = msg.entitlement.tier || 'free'; renderHubTier(); }
    renderAccountChrome();
    if (ui.tab === 'dashboard') renderDashboard();
  });
  api.onHubAuthStatus?.((msg) => {
    const s = $('#hub-login-status');
    if (s && msg?.message) s.textContent = msg.message;
    const ms = $('#modal-hub-status');
    if (ms && msg?.message) ms.textContent = msg.message;
    if (msg?.status === 'complete' && msg?.data) applyHubAuthComplete(msg.data);
    if (msg?.status === 'error') toast(msg.message || 'Browser sign-in failed.', 'error');
  });
}

/* ========================= USER DASHBOARD & ACCOUNT ===================== */

let dashboardRemoteTimer = null;
function refreshDashboardTelemetry({ immediate = true } = {}) {
  void refreshDeviceManagement({ id: 'local', connected: true });
  if (dashboardRemoteTimer) {
    clearTimeout(dashboardRemoteTimer);
    dashboardRemoteTimer = null;
  }
  const runRemote = () => {
    dashboardRemoteTimer = null;
    if (ui.tab !== 'dashboard') return;
    const primarySpark = remoteDevices().find(d => d.connected);
    if (primarySpark) void refreshDeviceManagement(primarySpark);
  };
  if (immediate) runRemote();
  else dashboardRemoteTimer = setTimeout(runRemote, 450);
}

function renderDashboard({ force = false } = {}) {
  const mount = $('#user-dashboard-mount');
  if (!mount) return;
  const active = document.activeElement;
  if (!force && active && mount.contains(active) && active.matches('input, select, textarea')) return;
  const focusedId = active && mount.contains(active) ? active.id : '';

  const localCache = telemetryFor('local');
  const remotes = remoteDevices();
  const primarySpark = remotes.find(d => d.connected) || remotes[0] || null;
  const sparkCache = primarySpark ? telemetryFor(primarySpark.id) : null;

  const html = userDashboardHtml({
    state,
    devices: remotes,
    localTelemetry: localCache?.data || null,
    sparkTelemetry: sparkCache?.data || null,
    sparkRecipes: sparkCache?.recipes || [],
    sparkBusy: Boolean(sparkCache?.busy),
    sparkError: sparkCache?.error || '',
  });

  if (mount._html === html) return;
  mount._html = html;
  mount.innerHTML = html;

  if (focusedId) {
    const nextFocus = document.getElementById(focusedId);
    if (nextFocus && typeof nextFocus.focus === 'function') nextFocus.focus({ preventScroll: true });
  }
}

function renderAccountChrome() {
  const acct = state.hubAccount || {};
  const ent = state.hubEntitlement || { tier: hubState.tier || 'free' };
  const cfg = state.hubConfig || { hubUrl: hubState.hubUrl || '', hasToken: Boolean(hubState.hasToken) };
  const tier = formatTierBadge(ent);

  const chip = $('#btn-account');
  const avatar = $('#top-account-avatar');
  const label = $('#top-account-label');
  const tierEl = $('#top-account-tier');

  if (chip && avatar && label && tierEl) {
    if (acct.signedIn) {
      avatar.textContent = accountInitials(acct);
      label.textContent = acct.handle ? '@' + acct.handle : (acct.displayName || acct.email || 'Signed in');
      tierEl.textContent = tier.label;
      tierEl.className = `account-chip-tier ${tier.cls}`;
      tierEl.hidden = false;
      chip.classList.add('signed-in');
    } else if (cfg.hasToken) {
      avatar.textContent = 'KEY';
      label.textContent = 'Hub token';
      tierEl.textContent = tier.label;
      tierEl.className = `account-chip-tier ${tier.cls}`;
      tierEl.hidden = false;
      chip.classList.remove('signed-in');
    } else {
      avatar.textContent = 'FB';
      label.textContent = 'Sign in';
      tierEl.hidden = true;
      chip.classList.remove('signed-in');
    }
  }

  const summary = $('#hub-account-summary');
  if (summary) {
    if (acct.signedIn) {
      const who = [acct.displayName, acct.email].filter(Boolean).join(' · ') || acct.uid;
      const roleNote = acct.isAdmin ? `Operator · ${tier.label} tier` : `${tier.label} tier`;
      const alias = acct.handle ? `@${acct.handle} · ` : '';
      summary.textContent = `Signed in as ${alias}${who} (${roleNote}${acct.origin ? ` on ${acct.origin}` : ''}). Session token is encrypted via OS keychain.`;
    } else if (cfg.hasToken) {
      summary.textContent = `A Hub bearer token is saved${cfg.hubUrl ? ` for ${cfg.hubUrl}` : ''}. Click Sync account to verify profile & tier.`;
    } else {
      summary.textContent = 'Not signed in. Local downloads, HuggingFace model fit checks, and peer sharing work without an account.';
    }
  }
  const logoutBtn = $('#btn-hub-logout');
  if (logoutBtn) logoutBtn.disabled = !acct.signedIn && !cfg.hasToken;
  const syncBtn = $('#btn-hub-sync');
  if (syncBtn) syncBtn.disabled = !acct.signedIn && !cfg.hasToken;
  const browserLoginBtn = $('#btn-hub-browser-login');
  if (browserLoginBtn) browserLoginBtn.disabled = acct.signedIn;
  renderHubProfile();
}

// ---- Public profile + publisher binding (ADR 003) ---------------------------
// The card is only visible for a verified session. Inputs are pre-filled from
// the server-confirmed account; every write round-trips the Hub before the UI
// claims success (main refreshes the cached account from GET /v1/me).

function renderHubProfile() {
  const card = $('#hub-profile-card');
  if (!card) return;
  const acct = state.hubAccount || {};
  const signedIn = Boolean(acct.signedIn);
  card.hidden = !signedIn;
  if (!signedIn) return;
  const handleInput = $('#set-hub-handle');
  const nameInput = $('#set-hub-displayname');
  const bioInput = $('#set-hub-bio');
  // Only pre-fill fields the user is not actively editing.
  if (handleInput && document.activeElement !== handleInput) handleInput.value = acct.handle || '';
  if (nameInput && document.activeElement !== nameInput) nameInput.value = acct.displayName || '';
  if (bioInput && document.activeElement !== bioInput) bioInput.value = acct.bio || '';
  const releaseBtn = $('#btn-hub-handle-release');
  if (releaseBtn) releaseBtn.disabled = !acct.handle;

  const pub = state.publisher ?? {};
  const note = $('#hub-publisher-binding-note');
  const bindBtn = $('#btn-hub-bind-publisher');
  const bound = Array.isArray(acct.publisherKeys) ? acct.publisherKeys.filter(k => k && !k.unboundAt) : [];
  const thisDeviceBound = pub.present && pub.pubKey && bound.some(k => k.pubKey === pub.pubKey);
  if (note) {
    note.textContent = !pub.present
      ? 'No publisher identity on this device yet. Create one under Settings → Publisher, then bind it here.'
      : pub.invalid ? 'The saved publisher identity cannot be read. Restore it under Settings → Publisher before binding.'
      : !pub.unlocked ? 'Your publisher identity is locked. Unlock it under Settings → Publisher, then bind it here.'
      : thisDeviceBound ? 'This device’s publisher key is bound to your account. Publications from it are attributed to you.'
      : 'Bind this device’s publisher key to prove ownership. The Hub issues a one-time challenge; signing happens on this device and the key never leaves it.';
  }
  if (bindBtn) {
    bindBtn.disabled = !pub.present || pub.invalid || !pub.unlocked || thisDeviceBound;
    bindBtn.textContent = thisDeviceBound ? 'Publisher key bound ✓' : 'Bind publisher key';
  }
  const list = $('#hub-bound-keys');
  if (list) {
    list.innerHTML = bound.length
      ? bound.map(k => `<div class="setting"><span class="hint" title="${esc(k.pubKey)}">${esc(String(k.pubKey).slice(0, 12))}… · bound ${esc(String(k.boundAt || '').slice(0, 10))}</span><button class="btn sm" data-unbind-key="${esc(k.pubKey)}">Unbind</button></div>`).join('')
      : '<p class="note">No publisher keys bound to this account yet.</p>';
    list.querySelectorAll('[data-unbind-key]').forEach(btn => {
      btn.addEventListener('click', () => { void unbindPublisherKey(btn.dataset.unbindKey); });
    });
  }
}

function applyProfileResult(res, statusEl) {
  if (res?.data?.account) state.hubAccount = res.data.account;
  if (res?.data?.entitlement) { state.hubEntitlement = res.data.entitlement; hubState.tier = res.data.entitlement.tier || 'free'; }
  renderAccountChrome();
  renderHubTier();
  renderDashboard({ force: true });
  if (statusEl) statusEl.textContent = 'Saved — confirmed by the Hub.';
}

async function saveHubHandle() {
  const statusEl = $('#hub-profile-status');
  const raw = $('#set-hub-handle')?.value ?? '';
  const check = validateHandle(raw);
  if (!check.ok) { if (statusEl) statusEl.textContent = check.message; return; }
  if (statusEl) statusEl.textContent = 'Reserving handle…';
  const res = await api.hubSetHandle(check.handle);
  if (!res?.ok) { if (statusEl) statusEl.textContent = res?.error || 'Could not save handle.'; return; }
  applyProfileResult(res, statusEl);
  toast(`Handle @${check.handle} reserved.`, 'ok');
}

async function releaseHubHandle() {
  const statusEl = $('#hub-profile-status');
  if (statusEl) statusEl.textContent = 'Releasing handle…';
  const res = await api.hubReleaseHandle();
  if (!res?.ok) { if (statusEl) statusEl.textContent = res?.error || 'Could not release handle.'; return; }
  applyProfileResult(res, statusEl);
  if (statusEl) statusEl.textContent = 'Handle released. It stays reserved for you for 30 days.';
}

async function saveHubProfile() {
  const statusEl = $('#hub-profile-status');
  const nameCheck = validateDisplayName($('#set-hub-displayname')?.value ?? '');
  if (!nameCheck.ok) { if (statusEl) statusEl.textContent = nameCheck.message; return; }
  const bioCheck = validateBio($('#set-hub-bio')?.value ?? '');
  if (!bioCheck.ok) { if (statusEl) statusEl.textContent = bioCheck.message; return; }
  if (statusEl) statusEl.textContent = 'Saving profile…';
  const res = await api.hubUpdateMe({ displayName: nameCheck.displayName, bio: bioCheck.bio });
  if (!res?.ok) { if (statusEl) statusEl.textContent = res?.error || 'Could not save profile.'; return; }
  applyProfileResult(res, statusEl);
  toast('Profile updated.', 'ok');
}

async function bindPublisherToAccount() {
  const statusEl = $('#hub-bind-status');
  if (statusEl) statusEl.textContent = 'Requesting challenge…';
  const res = await api.hubBindPublisher();
  if (!res?.ok) { if (statusEl) statusEl.textContent = res?.error || 'Could not bind publisher key.'; return; }
  applyProfileResult(res, null);
  if (statusEl) statusEl.textContent = 'Publisher key bound — signature verified by the Hub.';
  toast('Publisher key bound to your account.', 'ok');
}

async function unbindPublisherKey(pubKey) {
  const statusEl = $('#hub-bind-status');
  if (statusEl) statusEl.textContent = 'Unbinding…';
  const res = await api.hubUnbindPublisher(pubKey);
  if (!res?.ok) { if (statusEl) statusEl.textContent = res?.error || 'Could not unbind key.'; return; }
  applyProfileResult(res, null);
  if (statusEl) statusEl.textContent = 'Key unbound. Attribution history is preserved.';
}

async function performHubBrowserLogin({ statusEl } = {}) {
  if (statusEl) statusEl.textContent = 'Opening FrostByte sign-in…';
  try {
    const res = await api.hubSignInWithBrowser();
    if (!res?.ok) {
      const msg = res?.error || 'Browser sign-in could not be started.';
      if (statusEl) statusEl.textContent = msg;
      return { ok: false, error: msg };
    }
    if (res.data?.cancelled) {
      if (statusEl) statusEl.textContent = 'Sign-in cancelled.';
      return { ok: false, cancelled: true };
    }
    if (statusEl) statusEl.textContent = 'Complete sign-in in your browser…';
    toast('Complete sign-in in your browser, then return to FrostByte.', 'info');
    return { ok: true, data: res.data };
  } catch (err) {
    const msg = err?.message || 'Browser sign-in failed.';
    if (statusEl) statusEl.textContent = msg;
    return { ok: false, error: msg };
  }
}

function applyHubAuthComplete(data) {
  state.hubAccount = data?.account || state.hubAccount;
  if (data?.entitlement) {
    state.hubEntitlement = data.entitlement;
    hubState.tier = data.entitlement.tier || 'free';
  }
  hubState.hasToken = true;
  if ($('#modal-desktop-auth-form')) closeModal();
  renderAccountChrome();
  renderHubTier();
  renderDashboard({ force: true });
  const name = state.hubAccount?.displayName || state.hubAccount?.email || 'FrostByte';
  const statusEl = $('#hub-login-status');
  if (statusEl) statusEl.textContent = `Signed in as ${name}.`;
  toast(`Signed in to FrostByte as ${name}.`, 'ok');
}

async function syncHubAccount({ statusEl } = {}) {
  if (statusEl) statusEl.textContent = 'Syncing…';
  try {
    const res = await api.hubRefreshAccount();
    if (!res?.ok) {
      const msg = res?.error || 'Could not verify Hub account.';
      if (statusEl) statusEl.textContent = msg;
      toast(msg, 'warn');
      return false;
    }
    if (res.data?.cancelled) {
      if (statusEl) statusEl.textContent = 'Cancelled.';
      return false;
    }
    state.hubAccount = res.data?.account || state.hubAccount;
    if (res.data?.entitlement) {
      state.hubEntitlement = res.data.entitlement;
      hubState.tier = res.data.entitlement.tier || 'free';
    }
    await refresh();
    renderAccountChrome();
    renderHubTier();
    renderDashboard({ force: true });
    if (statusEl) statusEl.textContent = 'Synced.';
    toast('Hub account and entitlement synced.', 'ok');
    return true;
  } catch (err) {
    const msg = err?.message || 'Sync failed.';
    if (statusEl) statusEl.textContent = msg;
    toast(msg, 'warn');
    return false;
  }
}

async function performHubLogout({ statusEl } = {}) {
  if (statusEl) statusEl.textContent = 'Signing out…';
  try {
    const res = await api.hubLogout();
    if (!res?.ok) {
      const msg = res?.error || 'Sign-out failed.';
      if (statusEl) statusEl.textContent = msg;
      toast(msg, 'warn');
      return;
    }
    hubState.hasToken = false;
    hubState.tier = 'free';
    await refresh();
    renderAccountChrome();
    renderHubTier();
    renderDashboard({ force: true });
    if (statusEl) statusEl.textContent = 'Signed out.';
    toast('Signed out of FrostByte Hub.');
  } catch (err) {
    const msg = err?.message || 'Sign-out failed.';
    if (statusEl) statusEl.textContent = msg;
  }
}

function openAccountModal({ mode = 'login', prefill = null } = {}) {
  const acct = state.hubAccount || {};
  const ent = state.hubEntitlement || { tier: hubState.tier || 'free' };
  const cfg = state.hubConfig || {};
  const tier = formatTierBadge(ent);
  const currentHubUrl = cfg.hubUrl || hubState.hubUrl || '';
  const signup = mode === 'signup';

  if (acct.signedIn) {
    const adminPill = acct.isAdmin === true
      ? '<span class="home-tier-pill admin-pill" title="Owner/operator account">ADMIN</span>'
      : '';
    const actions = [
      { label: 'Close' },
      ...(acct.isAdmin === true
        ? [{
            label: 'Open Admin Console ↗',
            kind: 'btn primary',
            onClick: async () => {
              const result = await api.openExternal('https://frostbyte.si/admin').catch(() => ({ ok: false }));
              if (!result?.ok) toast(result?.error || 'Could not open the admin console.', 'error');
              else closeModal();
            },
          }]
        : []),
      { label: 'Hub Settings', kind: 'btn', onClick: () => { closeModal(); goTab('settings'); $('#settings-nav [data-sec="hub"]')?.click(); } },
      { label: 'Sync Entitlement', kind: 'btn', onClick: async () => { if (await syncHubAccount({ statusEl: $('#modal-hub-status') })) closeModal(); } },
      { label: 'Sign Out', kind: 'btn danger', onClick: async () => { await performHubLogout({ statusEl: $('#modal-hub-status') }); closeModal(); } },
    ];
    openModal({
      title: 'FrostByte Hub Account',
      sub: acct.isAdmin === true
        ? 'Operator account (Pro capabilities included). Manage customers, billing, and FrostNet in the web Admin Console.'
        : 'Your session token is stored locally in the OS keychain and never shared with peers.',
      body: `
        <div class="account-modal-summary">
          <div class="home-avatar lg" aria-hidden="true">${esc(accountInitials(acct))}</div>
          <div>
            <div class="home-account-row">
              <strong>${esc(acct.displayName || acct.email || acct.uid)}</strong>
              <span class="home-tier-pill ${tier.cls}">${esc(tier.label)}</span>
              ${adminPill}
            </div>
            <p class="hf-help">${esc(acct.email || 'No email reported')}${acct.emailVerified ? ' · Verified' : ''}</p>
            <p class="hf-help mono">${esc(acct.origin || currentHubUrl || 'FrostByte Hub')}</p>
          </div>
        </div>
        <p id="modal-hub-status" class="hf-help" role="status"></p>
      `,
      actions,
    });
    return;
  }

  if (cfg.hasToken || hubState.hasToken) {
    openModal({
      title: 'FrostByte API Token',
      sub: 'Personal bfk_ API credential encrypted in the OS keychain and pinned to the production FrostNet Hub.',
      body: `
        <div class="account-modal-summary">
          <div class="home-avatar lg" aria-hidden="true">KEY</div>
          <div>
            <div class="home-account-row">
              <strong>Personal API Token Saved</strong>
              <span class="home-tier-pill ${tier.cls}">${esc(tier.label)}</span>
            </div>
            <p class="hf-help">Sync your profile &amp; entitlement or clear the saved token.</p>
          </div>
        </div>
        <p id="modal-hub-status" class="hf-help" role="status"></p>
      `,
      actions: [
        { label: 'Close' },
        { label: 'Token Settings…', kind: 'btn', onClick: () => { closeModal(); goTab('settings'); $('#settings-nav [data-sec="hub"]')?.click(); } },
        { label: 'Verify Account', kind: 'btn', onClick: async () => { if (await syncHubAccount({ statusEl: $('#modal-hub-status') })) closeModal(); } },
        { label: 'Clear Token', kind: 'btn danger', onClick: async () => { await performHubLogout({ statusEl: $('#modal-hub-status') }); closeModal(); } },
      ],
    });
    return;
  }

  openModal({
    title: signup ? 'Create your FrostByte account on FrostNet' : 'Sign in with FrostNet',
    sub: 'Authenticate on frostbyte.si in your browser with email & password, account creation, password reset, or Google sign-in.',
    body: `
      <div class="account-modal-form" id="modal-desktop-auth-form">
        <p class="hf-help">FrostByte Desktop opens <strong>frostbyte.si</strong> in your system browser and receives a short-lived PKCE handoff over <code>frostbyte://auth</code>. Your password is never entered into or stored by the desktop app.</p>
        <p class="hf-help">Local downloads, HuggingFace model fit checks, DGX Spark pairing, and peer sharing always work without signing in.</p>
        <p id="modal-hub-error" class="inventory-error" role="alert" hidden></p>
        <p id="modal-hub-status" class="hf-help" role="status"></p>
      </div>
    `,
    actions: [
      { label: 'Cancel' },
      { label: 'Token / Advanced…', kind: 'btn', onClick: () => { closeModal(); goTab('settings'); $('#settings-nav [data-sec="hub"]')?.click(); setTimeout(() => $('#set-hubtoken')?.focus(), 60); } },
      {
        label: 'Sign in with FrostNet ↗',
        kind: 'btn primary',
        onClick: async () => {
          const errEl = $('#modal-hub-error');
          if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
          const res = await performHubBrowserLogin({ statusEl: $('#modal-hub-status') });
          if (!res?.ok && !res?.cancelled && errEl) {
            errEl.textContent = res?.error || 'Could not open browser sign-in.';
            errEl.hidden = false;
          }
        },
      },
    ],
  });
}

function bindDashboardView() {
  $('#btn-account')?.addEventListener('click', () => openAccountModal());

  const mount = $('#user-dashboard-mount');
  if (!mount) return;

  mount.addEventListener('click', e => {
    const tabBtn = e.target.closest('[data-dash-tab]');
    if (tabBtn) {
      goTab(tabBtn.dataset.dashTab);
      return;
    }

    const actionBtn = e.target.closest('[data-dash-action]');
    if (actionBtn) {
      const act = actionBtn.dataset.dashAction;
      if (act === 'add-source') openAddDialog();
      else if (act === 'open-signin' || act === 'open-account') openAccountModal();
      else if (act === 'open-admin-console') {
        // Exact-allowlisted handoff (src/main/external-links.js); the main
        // process re-validates the URL — the renderer cannot widen it.
        void api.openExternal('https://frostbyte.si/admin')
          .then(result => { if (!result.ok) toast(result.error || 'Could not open the admin console.', 'error'); })
          .catch(() => toast('Could not open the admin console.', 'error'));
      }
      else if (act === 'refresh-account') void syncHubAccount();
      else if (act === 'refresh-spark') {
        refreshDashboardTelemetry();
        renderDashboard({ force: true });
      }
      return;
    }
  });
}

async function refreshPrivacy() {
  const result = await api.getPrivacy();
  if (!result.ok) return toast(result.error, 'error');
  const value = result.data;
  $('#privacy-accepted').textContent = `Accepted ${value.termsVersion} on ${new Date(value.acceptedAt).toLocaleDateString()}. Your acceptance is stored on this computer.`;
  $('#diagnostics-status').textContent = `Data collection is disabled in FrostByte ${String(state.version || PACKAGE_VERSION).trim()}, including earlier diagnostics opt-ins.`;
  return value;
}
function bindPrivacy() {
  refreshPrivacy();
  $('#settings-nav [data-sec="privacy"]').addEventListener('click', refreshPrivacy);
  $('#btn-feedback').addEventListener('click', () => openFeedback());
  $('#btn-legal').addEventListener('click', async () => {
    const result = await api.legalDocuments();
    if (!result.ok) return toast(result.error, 'error');
    openModal({ title: 'Terms and privacy', body: `<details open><summary>Terms</summary><pre class="legal-document">${esc(result.data.terms)}</pre></details><details><summary>Privacy notice</summary><pre class="legal-document">${esc(result.data.privacy)}</pre></details>`, actions: [{ label: 'Close' }] });
  });
}
function openFeedback() {
  openModal({ title: 'Feedback on GitHub', sub: 'Your ideas help shape FrostByte. Sharing feedback is always your choice.',
    body: `<p class="feedback-note">This opens the official FrostByte GitHub issue page in your browser. FrostByte does not attach logs, device details, library contents, or a message. Nothing is submitted until you choose to post on GitHub.</p><p class="feedback-note">GitHub issues are public. Do not include private files, tokens, passwords, or other sensitive information. GitHub has its own account and privacy rules.</p><p id="feedback-error" class="inventory-error" role="alert" hidden></p>`,
    actions: [{ label: 'Cancel' }, { label: 'Open GitHub ↗', kind: 'btn primary', onClick: async () => {
      try { const result = await api.openExternal(COMMUNITY_LINKS.feedback); if (!result.ok) throw new Error(result.error || 'Could not open GitHub.'); closeModal(); }
      catch (error) { $('#feedback-error').textContent = error.message; $('#feedback-error').hidden = false; }
    } }] });
}
