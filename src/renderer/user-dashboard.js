/**
 * FrostByte User Dashboard (Home Screen)
 * Always-first screen providing:
 * - User greeting & FrostByte Hub Account status (CSP-safe local monogram avatar, tier pill, Sign-in / Sign-out)
 * - 1-click workflow shortcuts (Hardware-Fit Model Finder, Library, Transfers, Spark, FrostNet, Add Magnet/Torrent)
 * - Live Loaded & Running Models + Compute Telemetry across Paired Spark & Local Computer (honest em-dash for unmeasured metrics)
 */

import { bytes, capacity, downloadVolume, transferSummary } from './device-dashboard.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const finitePos = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const finiteAny = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

const ENDPOINT_LABELS = Object.freeze({
  ready: 'Ready',
  'auth-required': 'Ready · auth required',
  'not-ready': 'Starting / not ready',
  unreachable: 'Unreachable',
  unknown: 'Not reported',
});

export function accountInitials(account = {}) {
  const source = String(account?.handle || account?.displayName || account?.email || '').trim();
  if (!source) return 'FB';
  const parts = source.split(/[\s._@-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function formatTierBadge(entitlement = {}) {
  const tier = String(entitlement?.tier || 'free').toLowerCase();
  if (tier === 'pro') return { label: 'PRO', cls: 'tier-pro' };
  if (tier === 'plus') return { label: 'PLUS', cls: 'tier-plus' };
  if (tier === 'offline') return { label: 'OFFLINE', cls: 'tier-offline' };
  return { label: 'FREE', cls: 'tier-free' };
}

function compactMeter(label, capValue) {
  const c = capacity(capValue);
  if (!c) {
    return `<div class="home-meter"><div class="home-meter-top"><span>${esc(label)}</span><strong>—</strong></div><small>${capValue?.available === false ? 'Unavailable' : 'Not reported'}</small></div>`;
  }
  return `
    <div class="home-meter">
      <div class="home-meter-top"><span>${esc(label)}</span><strong>${c.percent.toFixed(0)}%</strong></div>
      <div class="resource-track" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.percent.toFixed(1)}">
        <span style="width:${c.percent.toFixed(2)}%"></span>
      </div>
      <small>${esc(bytes(c.used))} used of ${esc(bytes(c.total))} · ${esc(bytes(c.free))} free</small>
    </div>`;
}

function renderAccountCard({ hubAccount, hubEntitlement, hubConfig }) {
  const signedIn = Boolean(hubAccount?.signedIn);
  const hasToken = Boolean(hubConfig?.hasToken);
  const tier = formatTierBadge(hubEntitlement);

  if (signedIn) {
    const initials = accountInitials(hubAccount);
    const title = hubAccount.displayName || hubAccount.email || hubAccount.uid;
    const sub = hubAccount.handle
      ? '@' + hubAccount.handle + (hubAccount.email ? ' · ' + hubAccount.email : '')
      : hubAccount.email && hubAccount.email !== title ? hubAccount.email : (hubAccount.origin || hubConfig?.hubUrl || 'FrostByte Hub');
    const adminPill = hubAccount.isAdmin === true
      ? '<span class="home-tier-pill admin-pill" title="Owner/operator account">ADMIN</span>'
      : '';
    const adminAction = hubAccount.isAdmin === true
      ? '<button type="button" class="btn sm" data-dash-action="open-admin-console" title="Open the frostbyte.si admin console in your browser">Open Admin Console ↗</button>'
      : '';
    return `
      <div class="home-account-card signed-in" id="home-account-card">
        <div class="home-avatar" aria-hidden="true">${esc(initials)}</div>
        <div class="home-account-meta">
          <div class="home-account-row">
            <strong>${esc(title)}</strong>
            <span class="home-tier-pill ${tier.cls}">${esc(tier.label)}</span>
            ${adminPill}
          </div>
          <small>${esc(sub)}</small>
        </div>
        <div class="home-account-actions">
          <button type="button" class="btn sm" data-dash-action="refresh-account" title="Verify Hub account &amp; entitlement">Sync</button>
          <button type="button" class="btn sm" data-dash-action="open-account">Account</button>
          ${adminAction}
        </div>
      </div>`;
  }

  if (hasToken) {
    return `
      <div class="home-account-card token-only" id="home-account-card">
        <div class="home-avatar muted" aria-hidden="true">KEY</div>
        <div class="home-account-meta">
          <div class="home-account-row">
            <strong>Hub token saved</strong>
            <span class="home-tier-pill ${tier.cls}">${esc(tier.label)}</span>
          </div>
          <small>${esc(hubConfig?.hubUrl || 'Verify profile to display account details')}</small>
        </div>
        <div class="home-account-actions">
          <button type="button" class="btn sm primary" data-dash-action="refresh-account">Verify account</button>
          <button type="button" class="btn sm" data-dash-action="open-account">Manage</button>
        </div>
      </div>`;
  }

  return `
    <div class="home-account-card signed-out" id="home-account-card">
      <div class="home-avatar guest" aria-hidden="true">FB</div>
      <div class="home-account-meta">
        <div class="home-account-row">
          <strong>Local-First Mode</strong>
          <span class="home-tier-pill ${tier.cls}">${esc(tier.label)}</span>
        </div>
        <small>Downloads, HF fit checks, and LAN sharing work without an account.</small>
      </div>
      <div class="home-account-actions">
        <button type="button" class="btn sm primary" data-dash-action="open-signin" id="home-signin-btn">Sign in with FrostNet…</button>
      </div>
    </div>`;
}

function renderSparkRuntimeCard({ remoteDevice, sparkTelemetry, sparkRecipes = [], sparkBusy = false, sparkError = '' }) {
  if (!remoteDevice) {
    return `
      <article class="home-runtime-card" id="home-spark-card" aria-labelledby="home-spark-heading">
        <div class="home-runtime-head">
          <div>
            <span class="device-eyebrow">PAIRED AI COMPANION · SPARK / LINUX</span>
            <h3 id="home-spark-heading">No Remote GPU Node Paired</h3>
          </div>
          <span class="home-status-pill muted">Unpaired</span>
        </div>
        <p class="home-runtime-empty">Pair an NVIDIA DGX Spark or Linux GPU workstation over pinned SSH to monitor live GPU telemetry, loaded containers, and approved inference recipes directly from your Home screen.</p>
        <div class="home-runtime-foot">
          <span class="home-foot-hint">Zero-trust Unix socket over SSH</span>
          <button type="button" class="btn sm primary" data-dash-tab="spark">Pair Spark or Device →</button>
        </div>
      </article>`;
  }

  const online = Boolean(remoteDevice.connected);
  const t = sparkTelemetry || null;
  const gpu = t?.gpu || {};
  const endpoint = t?.endpoint || {};
  const containers = Array.isArray(t?.docker?.containers) ? t.docker.containers : [];
  const runningContainers = containers.filter(c => c.state === 'running');
  const activeRecipes = Array.isArray(sparkRecipes) ? sparkRecipes.filter(r => r.state === 'running' || r.active) : [];

  const gpuUtil = finitePos(gpu.utilizationPercent);
  const gpuTemp = finiteAny(gpu.temperatureC);
  const gpuPower = finitePos(gpu.powerWatts);
  const cpuUtil = finitePos(t?.cpu?.utilizationPercent);
  const endpointLabel = `${ENDPOINT_LABELS[endpoint.state] || ENDPOINT_LABELS.unknown}${Number.isInteger(endpoint.port) ? ` · :${endpoint.port}` : ''}`;

  const hwMem = (remoteDevice.hardware?.memoryBytes || remoteDevice.status?.hardware?.memoryBytes)
    ? bytes(remoteDevice.hardware?.memoryBytes || remoteDevice.status?.hardware?.memoryBytes)
    : null;
  const hwName = remoteDevice.hardware?.name || remoteDevice.status?.hardware?.name || 'Remote companion';
  const subTitle = [
    hwName,
    hwMem ? `${hwMem} RAM` : '',
    remoteDevice.host || '',
  ].filter(Boolean).join(' · ');

  let workloadsHtml = '';
  if (!online) {
    workloadsHtml = `<p class="home-workload-note">Device is offline (${esc(remoteDevice.error || 'not reachable')}). Live container and model runtime states pause until reconnected.</p>`;
  } else if (runningContainers.length || activeRecipes.length) {
    const items = [
      ...runningContainers.map(c => `
        <li class="home-workload-item">
          <span class="container-state running" aria-hidden="true"></span>
          <div class="home-workload-main">
            <strong>${esc(c.name || 'Inference container')}</strong>
            <small>${esc(c.image || c.status || 'Running container')}</small>
          </div>
          <span class="home-workload-tag running">Running</span>
        </li>`),
      ...activeRecipes
        .filter(r => !runningContainers.some(c => c.name && r.id && c.name.includes(r.id)))
        .map(r => `
        <li class="home-workload-item">
          <span class="container-state running" aria-hidden="true"></span>
          <div class="home-workload-main">
            <strong>${esc(r.title || r.id)}</strong>
            <small>${esc(r.kind || 'Approved recipe')}</small>
          </div>
          <span class="home-workload-tag running">${esc(r.state || 'running')}</span>
        </li>`),
    ];
    workloadsHtml = `<ul class="home-workload-list" aria-label="Running models and containers on ${esc(remoteDevice.name)}">${items.join('')}</ul>`;
  } else if (!t && sparkBusy) {
    workloadsHtml = `<p class="home-workload-note">Polling live workload &amp; GPU telemetry from ${esc(remoteDevice.name)}…</p>`;
  } else if (t) {
    const stoppedCount = containers.length;
    workloadsHtml = `<p class="home-workload-note">No running inference containers reported${stoppedCount ? ` (${stoppedCount} stopped container${stoppedCount === 1 ? '' : 's'} on host)` : ''}${sparkRecipes.length ? ` · ${sparkRecipes.length} approved recipe${sparkRecipes.length === 1 ? '' : 's'} ready to launch` : ''}.</p>`;
  } else {
    workloadsHtml = `<p class="home-workload-note">${esc(sparkError || 'Telemetry snapshot not yet collected. Click Refresh to query live Spark stats.')}</p>`;
  }

  return `
    <article class="home-runtime-card" id="home-spark-card" aria-labelledby="home-spark-heading">
      <div class="home-runtime-head">
        <div>
          <span class="device-eyebrow">SPARK &amp; REMOTE INFERENCE RUNTIME</span>
          <h3 id="home-spark-heading">${esc(remoteDevice.name || 'Paired Spark')}</h3>
          <p class="home-runtime-sub">${esc(subTitle)}</p>
        </div>
        <div class="home-runtime-head-right">
          <span class="home-status-pill ${online ? 'online' : 'offline'}">${online ? 'Connected' : 'Offline'}</span>
          <button type="button" class="btn sm" data-dash-action="refresh-spark" ${!online || sparkBusy ? 'disabled' : ''} title="Refresh live Spark telemetry">${sparkBusy ? '…' : '↻'}</button>
        </div>
      </div>

      <div class="home-stat-strip" aria-label="Spark live compute telemetry">
        <div class="home-stat-cell"><small>GPU load</small><strong>${gpuUtil === null ? '—' : `${gpuUtil.toFixed(0)}%`}</strong></div>
        <div class="home-stat-cell"><small>GPU temp</small><strong>${gpuTemp === null ? '—' : `${gpuTemp.toFixed(0)} °C`}</strong></div>
        <div class="home-stat-cell"><small>GPU power</small><strong>${gpuPower === null ? '—' : `${gpuPower.toFixed(1)} W`}</strong></div>
        <div class="home-stat-cell"><small>CPU load</small><strong>${cpuUtil === null ? '—' : `${cpuUtil.toFixed(0)}%`}</strong></div>
        <div class="home-stat-cell wide"><small>Inference endpoint</small><strong>${esc(t ? endpointLabel : '—')}</strong></div>
      </div>

      <div class="home-meters-row">
        ${compactMeter('System memory', t?.memory)}
      </div>

      <div class="home-workloads-box">
        <div class="home-workloads-head">
          <span>Loaded &amp; running workloads</span>
          <small>${online && t ? `${runningContainers.length} active container${runningContainers.length === 1 ? '' : 's'}` : 'Status'}</small>
        </div>
        ${workloadsHtml}
      </div>

      <div class="home-runtime-foot">
        <span class="home-foot-hint">${sparkRecipes.length ? `${sparkRecipes.length} approved model recipe${sparkRecipes.length === 1 ? '' : 's'}` : 'Manage containers, storage &amp; recipes'}</span>
        <button type="button" class="btn sm" data-dash-tab="spark">Open Spark Dashboard →</button>
      </div>
    </article>`;
}

function renderLocalRuntimeCard({ localDevice, localTelemetry, state, localModelCount = 0 }) {
  const hw = localDevice?.hardware || state?.localDevice || state?.localHardware || {};
  const hwTitle = hw.name || localDevice?.name || 'This Computer';
  const memLabel = hw.memoryBytes ? `${bytes(hw.memoryBytes)} unified/installed memory` : 'Memory not reported';
  const gpuLabel = Array.isArray(hw.gpus) && hw.gpus.length
    ? hw.gpus.map(g => g.model || g.name).filter(Boolean).join(', ')
    : '';
  const downloads = state?.downloads || state?.hfDownloads || [];
  const summary = transferSummary({
    torrents: state?.torrents || [],
    downloads,
    ipfs: state?.ipfs,
  });
  const selectedDisk = downloadVolume(
    localDevice?.storage || [],
    state?.settings?.downloadDir || '',
    localTelemetry?.storage,
  );
  const downStr = summary ? `${bytes(summary.down)}/s` : '—';
  const upStr = summary ? `${bytes(summary.up)}/s` : '—';
  const seedingCount = summary ? String(summary.seeding) : '—';
  const peersCount = summary ? String(summary.peers) : '—';

  return `
    <article class="home-runtime-card" id="home-local-card" aria-labelledby="home-local-heading">
      <div class="home-runtime-head">
        <div>
          <span class="device-eyebrow">THIS COMPUTER · LOCAL HOST &amp; SWARM</span>
          <h3 id="home-local-heading">${esc(hwTitle)}</h3>
          <p class="home-runtime-sub">${esc([gpuLabel, memLabel].filter(Boolean).join(' · '))}</p>
        </div>
        <span class="home-status-pill online">Local · Ready</span>
      </div>

      <div class="home-stat-strip" aria-label="Local transfer and swarm telemetry">
        <div class="home-stat-cell"><small>Swarm ↓</small><strong>${esc(downStr)}</strong></div>
        <div class="home-stat-cell"><small>Swarm ↑</small><strong>${esc(upStr)}</strong></div>
        <div class="home-stat-cell"><small>Peers</small><strong>${esc(peersCount)}</strong></div>
        <div class="home-stat-cell"><small>Seeding</small><strong>${esc(seedingCount)}</strong></div>
        <div class="home-stat-cell wide"><small>Models on disk</small><strong>${localModelCount} ready</strong></div>
      </div>

      <div class="home-meters-row two-col">
        ${compactMeter('Host memory', localTelemetry?.memory)}
        ${compactMeter('Download volume', selectedDisk)}
      </div>

      <div class="home-workloads-box">
        <div class="home-workloads-head">
          <span>Local model readiness &amp; fit profile</span>
          <small>${hw.memoryBytes ? `Fit target: ${esc(bytes(hw.memoryBytes))}` : 'Hardware profile'}</small>
        </div>
        <p class="home-workload-note">
          <strong>${localModelCount}</strong> verified model${localModelCount === 1 ? '' : 's'} stored locally.
          Local host process scanning is disabled by design — launch with 1-click serve commands from <em>My Models</em> or <em>HuggingFace</em>.
        </p>
      </div>

      <div class="home-runtime-foot">
        <span class="home-foot-hint">${state?.hfToken?.present ? `HF connected${state.hfToken.user ? ` (${esc(state.hfToken.user)})` : ''}` : 'HF public access active'}</span>
        <div class="home-foot-btns">
          <button type="button" class="btn sm" data-dash-tab="library">My Models →</button>
          <button type="button" class="btn sm primary" data-dash-tab="hf">Find Best-Fit Models →</button>
        </div>
      </div>
    </article>`;
}

export function userDashboardHtml({
  state = {},
  devices = [],
  localTelemetry = null,
  sparkTelemetry = null,
  sparkRecipes = [],
  sparkBusy = false,
  sparkError = '',
} = {}) {
  const rawDevices = devices.length ? devices : (Array.isArray(state?.devices) ? state.devices : []);
  const localDevice = rawDevices.find(d => d.id === 'local') || {
    id: 'local',
    name: state?.localDevice?.name || 'This computer',
    connected: true,
    hardware: state?.localDevice || state?.localHardware || {},
    storage: localTelemetry?.storage ? [localTelemetry.storage] : [],
  };
  const remoteDevices = rawDevices.filter(d => d.id !== 'local').map(d => ({
    ...d,
    hardware: d.hardware || d.status?.hardware || null,
    storage: d.storage || d.status?.storage || [],
    inventory: d.inventory || d.status?.inventory || [],
  }));
  const primarySpark = remoteDevices.find(d => d.connected) || remoteDevices[0] || null;

  const inventory = Array.isArray(state?.inventory) ? state.inventory : [];
  const localModels = inventory.filter(row => row.kind !== 'torrent' && row.available !== false);
  const sparkInventoryCount = remoteDevices.reduce(
    (sum, d) => sum + (Array.isArray(d.inventory) ? d.inventory.filter(r => r.kind !== 'torrent').length : 0),
    0,
  );
  const totalModels = localModels.length + sparkInventoryCount;

  const downloads = state?.downloads || state?.hfDownloads || [];
  const activeTorrents = (state?.torrents || []).filter(t => !t.paused && !t.done && t.progress < 1).length;
  const activeHf = downloads.filter(d => d.status === 'active' || d.status === 'queued').length;
  const activeTransfers = activeTorrents + activeHf;

  const fitMemoryBytes = primarySpark?.connected && primarySpark?.hardware?.memoryBytes
    ? primarySpark.hardware.memoryBytes
    : localDevice?.hardware?.memoryBytes;
  const fitTargetLabel = fitMemoryBytes
    ? `Matched to ${bytes(fitMemoryBytes)} RAM`
    : 'Hardware-matched quantizations';

  const hubAccount = state?.hubAccount || {};
  const hubEntitlement = state?.hubEntitlement || {};
  const hubConfig = state?.hubConfig || {};

  const greetingName = hubAccount?.signedIn && hubAccount.displayName
    ? `, ${hubAccount.displayName}`
    : '';

  return `
    <div class="home-shell" id="home-dashboard-root">
      <section class="home-hero" aria-labelledby="home-hero-title">
        <div class="home-hero-copy">
          <span class="device-eyebrow">FROSTBYTE COMMUNITY · OPEN-SOURCE AI WORKSPACE</span>
          <h1 id="home-hero-title">Welcome home${esc(greetingName)}</h1>
          <p class="home-hero-sub">Discover hardware-matched HuggingFace models, verify every weight shard by SHA-256, seed open-source releases across your swarm, and steer paired Spark runtimes.</p>
        </div>
        ${renderAccountCard({ hubAccount, hubEntitlement, hubConfig })}
      </section>

      <section class="home-shortcuts" aria-label="Quick navigation shortcuts">
        <button type="button" class="home-shortcut-card primary-card" data-dash-tab="hf">
          <div class="home-shortcut-top">
            <span class="home-shortcut-icon" aria-hidden="true">HF</span>
            <span class="home-shortcut-badge">${esc(fitTargetLabel)}</span>
          </div>
          <strong>Find Right-Sized Models</strong>
          <small>Browse HuggingFace with automatic memory-fit badges for this Mac &amp; Spark.</small>
        </button>

        <button type="button" class="home-shortcut-card" data-dash-tab="library">
          <div class="home-shortcut-top">
            <span class="home-shortcut-icon" aria-hidden="true">◈</span>
            <span class="home-shortcut-badge">${totalModels} stored</span>
          </div>
          <strong>My Models Library</strong>
          <small>Inspect verified local &amp; Spark models, copy serve commands, or seed to peers.</small>
        </button>

        <button type="button" class="home-shortcut-card" data-dash-tab="transfers">
          <div class="home-shortcut-top">
            <span class="home-shortcut-icon" aria-hidden="true">↓↑</span>
            <span class="home-shortcut-badge">${activeTransfers ? `${activeTransfers} active` : 'Idle · Ready'}</span>
          </div>
          <strong>Transfers &amp; Swarm</strong>
          <small>Resumable HuggingFace LFS pulls, hybrid P2P swarms, and BitTorrent transfers.</small>
        </button>

        <button type="button" class="home-shortcut-card" data-dash-tab="spark">
          <div class="home-shortcut-top">
            <span class="home-shortcut-icon" aria-hidden="true">⚡</span>
            <span class="home-shortcut-badge">${primarySpark ? (primarySpark.connected ? 'Connected' : 'Offline') : 'Pair node'}</span>
          </div>
          <strong>Spark &amp; Devices</strong>
          <small>${primarySpark ? `Manage ${esc(primarySpark.name)} storage, containers, and GPU charts.` : 'Pair an NVIDIA DGX Spark or Linux workstation over SSH.'}</small>
        </button>

        <button type="button" class="home-shortcut-card" data-dash-tab="discover">
          <div class="home-shortcut-top">
            <span class="home-shortcut-icon" aria-hidden="true">✦</span>
            <span class="home-shortcut-badge">Coming soon</span>
          </div>
          <strong>FrostNet</strong>
          <small>Community home — updates, shared recipes, and creators. In progress; use Search to find models today.</small>
        </button>

        <button type="button" class="home-shortcut-card" data-dash-action="add-source">
          <div class="home-shortcut-top">
            <span class="home-shortcut-icon" aria-hidden="true">＋</span>
            <span class="home-shortcut-badge">.torrent / magnet</span>
          </div>
          <strong>Add Magnet or Torrent</strong>
          <small>Paste a magnet URI, infohash, or .torrent file with selective file preview.</small>
        </button>
      </section>

      <section class="home-runtime-section" aria-labelledby="home-runtime-title">
        <div class="home-section-head">
          <div>
            <span class="device-eyebrow">LIVE COMPUTE &amp; MODEL TELEMETRY</span>
            <h2 id="home-runtime-title">Loaded Models &amp; Device Stats</h2>
          </div>
          <small class="home-honesty-note">Measured live readings · unmeasured sensors always show <code>—</code></small>
        </div>
        <div class="home-runtime-grid">
          ${renderSparkRuntimeCard({
            remoteDevice: primarySpark,
            sparkTelemetry,
            sparkRecipes,
            sparkBusy,
            sparkError,
          })}
          ${renderLocalRuntimeCard({
            localDevice,
            localTelemetry,
            state,
            localModelCount: localModels.length,
          })}
        </div>
      </section>
    </div>
  `;
}
