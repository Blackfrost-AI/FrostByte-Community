/** Device-scoped presentation and bounded, session-only chart observations. */
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const zero = value => number(value) ?? 0;
export function bytes(value) {
  if (number(value) === null) return 'Not reported';
  if (!value) return '0 B';
  const index = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
  const n = value / 1024 ** index;
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
}
const rate = value => number(value) === null ? '—' : `${bytes(value)}/s`;
export function capacity(value) {
  const total = number(value?.totalBytes), free = number(value?.freeBytes);
  if (value?.available === false || !total || free === null || free > total) return null;
  return { total, free, used: total - free, percent: (total - free) / total * 100 };
}
export function downloadVolume(storage, downloadDir, reported) {
  if (!downloadDir) return null;
  return storage.find(disk => disk.path === downloadDir) || (reported?.path === downloadDir ? reported : null);
}
export function transferSummary({ torrents, downloads, ipfs } = {}) {
  if (!Array.isArray(torrents) && !Array.isArray(downloads) && !Array.isArray(ipfs?.downloads)) return null;
  const ts = Array.isArray(torrents) ? torrents : [], hf = Array.isArray(downloads) ? downloads : [];
  const ips = (ipfs?.downloads || []).filter(item => !item.removed && !item.cleared);
  return {
    down: ts.reduce((n, t) => n + (t.paused ? 0 : zero(t.downloadSpeed)), 0)
      + [...hf, ...ips].reduce((n, row) => n + (row.status === 'active' ? zero(row.speedBps) : 0), 0),
    up: ts.reduce((n, t) => n + (t.paused ? 0 : zero(t.uploadSpeed)), 0) + zero(ipfs?.stats?.uploadSpeed),
    peers: ts.reduce((n, t) => n + (t.paused ? 0 : number(t.numPeers) ?? (Array.isArray(t.peers) ? t.peers.length : 0)), 0),
    seeding: ts.filter(t => !t.paused && (t.seeding || t.done || t.progress === 1)).length,
    queued: ts.filter(t => t.queued && !t.paused).length + [...hf, ...ips].filter(t => t.status === 'queued').length,
    paused: ts.filter(t => t.paused).length + [...hf, ...ips].filter(t => t.status === 'paused').length,
    total: ts.length + hf.length + ips.length,
    uploaded: ts.reduce((n, t) => n + zero(t.uploaded), 0),
  };
}
export class DeviceHistory {
  constructor({ limit = 120, interval = 1400, maxDevices = 17 } = {}) { Object.assign(this, { limit, interval, maxDevices }); this.devices = new Map(); }
  add(id, data, time = Date.now()) {
    if (!this.devices.has(id)) {
      if (this.devices.size >= this.maxDevices) this.devices.delete(this.devices.keys().next().value);
      this.devices.set(id, []);
    }
    const rows = this.devices.get(id), last = rows.at(-1);
    if (last && time - last.time < this.interval) return rows;
    rows.push({ time, down: number(data?.down), up: number(data?.up) });
    if (rows.length > this.limit) rows.splice(0, rows.length - this.limit);
    return rows;
  }
  get(id) { return this.devices.get(id) || []; }
}
export function trafficChart(rows, width = 640) {
  const w = Math.max(280, Math.min(1200, width)), h = 184, left = 66, right = w - 14, top = 18, bottom = 144;
  const observed = rows.filter(row => row.down !== null || row.up !== null);
  if (!observed.length) return '<div class="dashboard-chart-empty">No live samples yet.<small>Measurements appear when this device is connected.</small></div>';
  const max = Math.max(1, ...observed.flatMap(row => [row.down || 0, row.up || 0])) * 1.15;
  const start = rows[0].time, end = Math.max(start + 1000, rows.at(-1).time);
  const x = time => left + (time - start) / (end - start) * (right - left);
  const y = value => bottom - value / max * (bottom - top);
  const paths = ['down', 'up'].map(key => {
    let pen = false;
    const path = rows.map((row, index) => {
      if (row[key] === null) { pen = false; return ''; }
      if (index && row.time - rows[index - 1].time > 15000) pen = false;
      const point = `${pen ? 'L' : 'M'}${x(row.time).toFixed(2)},${y(row[key]).toFixed(2)}`; pen = true; return point;
    }).join(' ');
    const last = observed.at(-1);
    return `<path class="traffic-${key}" d="${path}" fill="none" stroke-width="2.5" ${key === 'up' ? 'stroke-dasharray="6 4"' : ''}/>${last[key] !== null ? `<circle class="traffic-${key}" cx="${x(last.time)}" cy="${y(last[key])}" r="3"/>` : ''}`;
  }).join('');
  const labels = [0, .5, 1].map(n => { const py = bottom - n * (bottom - top); return `<line x1="${left}" x2="${right}" y1="${py}" y2="${py}" class="chart-grid"/><text x="${left - 8}" y="${py + 4}" text-anchor="end">${esc(bytes(max * n))}</text>`; }).join('');
  const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `<svg class="traffic-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Transfer speed in bytes per second over time; solid download and dashed upload. ${observed.length} recorded samples."><title>Transfer speed · bytes per second</title>${labels}${paths}<text x="${left}" y="169">${esc(clock(start))}</text><text x="${right}" y="169" text-anchor="end">${esc(clock(end))}</text><text x="${left}" y="11">B/s</text></svg>`;
}
function meter(label, value, { memory = false, stale = false } = {}) {
  const c = capacity(value);
  return `<div class="resource-meter"><div><span>${esc(label)}</span><strong>${c ? `${c.percent.toFixed(0)}% used` : 'Not reported'}</strong></div>${c ? `<div class="resource-track" role="meter" aria-label="${esc(label)}${stale ? ', last known' : ''}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.percent.toFixed(1)}"><span style="width:${c.percent.toFixed(2)}%"></span></div><small>${memory ? `${bytes(c.used)} used of ${bytes(c.total)}` : `${bytes(c.free)} available of ${bytes(c.total)}`}</small>${memory ? '<small>Total minus free memory; not a memory-pressure reading.</small>' : ''}` : `<small>${value?.available === false ? 'Folder or drive unavailable' : 'This device has not supplied a valid reading.'}</small>`}</div>`;
}
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const ENDPOINT_LABELS = { ready: 'Ready', 'auth-required': 'Ready · auth required', 'not-ready': 'Starting / not ready', unreachable: 'Unreachable', unknown: 'Not reported' };
/** Live GPU/CPU/network/endpoint readings; anything the device did not measure renders as an em dash, never as zero. */
export function liveReadings(t, stale = false) {
  const show = (value, format) => value === null ? '—' : format(value);
  const gpu = t?.gpu || {}, net = t?.network || {}, endpoint = t?.endpoint || {};
  const rate = value => `${bytes(value)}/s`;
  const tiles = [
    ['GPU utilization', show(number(gpu.utilizationPercent), v => `${v.toFixed(0)}%`)],
    ['GPU temperature', show(finite(gpu.temperatureC), v => `${v.toFixed(0)} °C`)],
    ['GPU power', show(number(gpu.powerWatts), v => `${v.toFixed(1)} W`)],
    ['CPU utilization', show(number(t?.cpu?.utilizationPercent), v => `${v.toFixed(0)}%`)],
    ['Network ↓', show(number(net.rxBytesPerSecond), rate)],
    ['Network ↑', show(number(net.txBytesPerSecond), rate)],
    ['Inference endpoint', `${ENDPOINT_LABELS[endpoint.state] || ENDPOINT_LABELS.unknown}${Number.isInteger(endpoint.port) ? ` · :${endpoint.port}` : ''}`],
  ];
  const outdated = t?.bridgeOutdated === true
    ? '<p class="dashboard-notice" role="status">Live GPU, CPU and network readings need the updated device bridge. Open Device options and choose Update companion.</p>' : '';
  return `<div class="dashboard-live" aria-label="Live device readings${stale ? ', last known' : ''}">${outdated}${gpu.name ? `<p class="dashboard-muted">${esc(gpu.name)}</p>` : ''}${tiles.map(([label, value]) => `<div class="dashboard-live-tile"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('')}</div>`;
}
const blockHead = (number, title, detail = '') => `<header class="dashboard-block-head"><div><span class="device-eyebrow">${number}</span><h3>${title}</h3></div>${detail}</header>`;
export function dashboardHtml({ device, hardware = {}, telemetry, recipes = [], telemetryError = '', busy = false, modelBusy = false, rows = [], summary,
  storage = [], picture = '', cpu = '', gpu = '', downloadDir = '', localLabel = 'This computer', width = 640, inventory = [] }) {
  const local = device.id === 'local', online = device.connected, stale = !online || Boolean(telemetryError);
  const t = telemetry, missing = busy && !t ? 'Loading…' : 'Not reported';
  const selectedDisk = downloadVolume(storage, downloadDir, t?.storage);
  const uptime = number(t?.uptimeSeconds) !== null ? `${Math.floor(t.uptimeSeconds / 3600)}h ${Math.floor(t.uptimeSeconds % 3600 / 60)}m` : missing;
  const containers = t?.docker?.containers || [];
  const live = online ? summary : null;
  const metrics = [['↓', 'Download', rate(live?.down), 'HF, BitTorrent & IPFS'], ['↑', 'Upload', rate(live?.up), 'BitTorrent & IPFS'], ['⇄', 'Connected peers', live ? live.peers : '—', 'BitTorrent connections'], ['◉', 'Seeding', live ? live.seeding : '—', 'BitTorrent entries']];
  const status = online ? local ? 'Local · online' : 'Companion connected' : 'Offline · last known data';
  const time = t?.collectedAt && Number.isFinite(Date.parse(t.collectedAt)) ? new Date(t.collectedAt).toLocaleTimeString() : '';
  const models = inventory.filter(row => row.kind !== 'torrent').length, files = inventory.filter(row => row.kind === 'torrent').length;
  return `<div class="dashboard-hero"><div class="dashboard-portrait">${picture}</div><div class="dashboard-identity"><span class="device-eyebrow">DEVICE DASHBOARD</span><h2 id="device-dashboard-title">${esc(device.name)}</h2><p>${esc(hardware.name || localLabel)}${hardware.modelIdentifier ? ' · ' + esc(hardware.modelIdentifier) : ''}</p><span class="dashboard-status ${online ? 'online' : ''}">${esc(status)}</span><code>${esc(local ? localLabel : device.host)}</code></div><div class="dashboard-hero-actions">${!local ? '<button class="btn sm" id="device-options">Device options…</button>' : ''}<span>${local ? 'FrostByte' : 'Companion'} ${esc(local ? device.version : device.status?.version || 'version unavailable')}</span></div></div>
    ${!online ? `<p class="dashboard-notice" role="status">${esc(device.error || 'This device is not reachable.')} Charts are paused. Saved hardware and inventory are shown below.</p>` : ''}
    <div class="dashboard-metrics">${metrics.map(([icon, label, value, help]) => `<article class="dashboard-metric"><span class="metric-icon" aria-hidden="true">${icon}</span><span>${label}</span><strong>${esc(value)}</strong><small>${help}</small></article>`).join('')}</div>
    <div class="dashboard-grid">
      <section class="dashboard-block dashboard-traffic">${blockHead('01 / NETWORK', 'Transfer activity', `<span class="dashboard-live">${online ? 'Session history' : 'Paused'}</span>`)}<div class="traffic-legend"><span class="download-legend">Download</span><span class="upload-legend">Upload</span><small>Recent observations · no saved history</small></div>${trafficChart(rows, width)}<div class="dashboard-traffic-foot"><span>${summary?.total ?? '—'} transfer jobs</span><span>${summary?.paused ?? '—'} paused</span><span>${summary?.queued ?? '—'} queued</span><button class="btn sm" data-device-view="transfers">Open transfers →</button></div></section>
      <section class="dashboard-block dashboard-resources">${blockHead('02 / RESOURCES', 'Memory & storage', '<button class="btn sm" id="spark-management-refresh" aria-label="Refresh system status">↻ Refresh</button>')}<p class="dashboard-sample">${stale ? 'Last known measurements' : busy ? 'Refreshing…' : 'Latest system snapshot'}${time ? ' · ' + esc(time) : ''}</p>${meter('System memory', t?.memory, { memory: true, stale })}${meter('Download volume', selectedDisk, { stale })}<div class="dashboard-uptime"><span>System uptime</span><strong>${esc(uptime)}</strong></div>${telemetryError ? `<p class="dashboard-notice" role="status">${esc(telemetryError)}</p>` : ''}</section>
      <section class="dashboard-block dashboard-hardware">${blockHead('03 / HARDWARE', 'Compute profile')}<dl class="device-facts"><div><dt>CPU</dt><dd>${esc(cpu)}</dd></div><div><dt>GPU</dt><dd>${esc(gpu)}</dd>${hardware.gpus?.some(g => g.source === 'model') ? '<dd>From model specifications</dd>' : ''}</div><div><dt>Installed memory</dt><dd>${hardware.memoryBytes ? bytes(hardware.memoryBytes) : 'Not reported'}</dd></div><div><dt>Operating system</dt><dd>${esc([hardware.platform === 'darwin' ? 'macOS' : hardware.platform === 'win32' ? 'Windows' : hardware.platform, hardware.osVersion].filter(Boolean).join(' ') || 'Not reported')}</dd></div></dl><div class="dashboard-load"><span>System load <small>1 / 5 / 15 minute averages · not CPU %</small></span>${[1, 5, 15].map((minute, i) => { const value = number(t?.load?.[i]); return `<div><small>${minute}m</small><strong>${value === null ? '—' : value.toFixed(2)}</strong></div>`; }).join('')}</div>${liveReadings(t, stale)}</section>
      <section class="dashboard-block device-management">${blockHead('04 / WORKLOADS', 'Containers & models')}<div class="spark-container-list">${containers.length ? containers.map(c => `<div class="dashboard-container"><span class="container-state ${c.state === 'running' ? 'running' : ''}"></span><div><strong>${esc(c.name || 'Unnamed')}</strong><small>${esc(c.image || c.status || 'Container')}</small></div><span>${esc(c.state || 'Unknown')}</span></div>`).join('') : `<p class="dashboard-muted">${local ? 'Container management is available on compatible paired devices.' : online ? 'No container inventory reported.' : 'Container status is unavailable while offline.'}</p>`}</div><h4>Approved model recipes</h4>${recipes.length ? `<div class="dashboard-recipes">${recipes.map(recipe => `<button class="btn" data-spark-model="${esc(recipe.id)}" ${modelBusy || stale || recipe.available === false ? 'disabled' : ''}><span>${esc(recipe.title)}</span><small>${esc(recipe.kind)} · ${esc(recipe.state || 'unknown')}</small></button>`).join('')}</div>` : '<p class="dashboard-muted">No approved model recipes available. Unlisted containers cannot be started here.</p>'}<p class="dashboard-muted">Start and stop actions keep their confirmation review.</p></section>
      <section class="dashboard-block dashboard-storage">${blockHead('05 / LIBRARY', 'Storage & content', '<div class="dashboard-shortcuts"><button class="btn sm" data-device-view="library">My Models →</button><button class="btn sm" data-device-view="catalog">Torrents →</button></div>')}<p class="dashboard-muted">${models} model entries · ${files} file / torrent entries${!online ? ' · last known inventory' : ''}. Capacity is per volume; folders on the same disk are not added together.</p><div class="dashboard-volumes">${storage.length ? storage.map(disk => `<div><code>${esc(disk.path)}</code>${meter('Volume capacity', disk, { stale: !online })}</div>`).join('') : '<p class="dashboard-muted">No storage measurements reported yet.</p>'}</div>${local ? `<div class="device-local-folder"><span>Download folder</span><code>${esc(downloadDir)}</code><button class="btn sm" id="device-local-folder">Change folder…</button></div><p class="dashboard-muted">Local transfers run while FrostByte is open.</p>` : ''}</section>
    </div>`;
}
