/** User-initiated device discovery. No authentication, remote commands, or VPN mutation. */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { writeJson } from './store.js';

const exec = promisify(execFile);
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9_. -]{1,100}$/.test(value);
const idFor = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24);
const ipv4Number = value => net.isIP(value) === 4 ? value.split('.').reduce((n, byte) => ((n << 8) | Number(byte)) >>> 0, 0) : null;
const ipv4Text = value => [24,16,8,0].map(shift => (value >>> shift) & 255).join('.');
export function privateIpv4(value) {
  const n = ipv4Number(value);
  return n !== null && (n >>> 24 === 10 || n >>> 20 === 0xac1 || n >>> 16 === 0xc0a8);
}
export function lanRange(address, netmask) {
  if (!privateIpv4(address)) throw new Error('Discovery requires a private IPv4 network.');
  const mask = ipv4Number(netmask);
  if (mask === null || !/^1+0*$/.test(mask.toString(2).padStart(32, '0'))) throw new Error('Invalid network mask.');
  const prefix = mask.toString(2).replace(/0/g, '').length;
  if (prefix > 30) return { cidr: `${address}/32`, targets: [] };
  // Never expand a large LAN or VPN route: review at most this local /24.
  const scanPrefix = Math.max(24, prefix), scanMask = (0xffffffff << (32 - scanPrefix)) >>> 0;
  const first = (ipv4Number(address) & scanMask) >>> 0, last = first + 2 ** (32 - scanPrefix) - 1;
  const targets = [];
  for (let n = first + 1; n < last; n++) if (ipv4Text(n) !== address) targets.push(ipv4Text(n));
  return { cidr: `${ipv4Text(first)}/${scanPrefix}`, targets };
}

async function command(file, args) {
  const { stdout } = await exec(file, args, { encoding: 'utf8', timeout: 4000, maxBuffer: 128 * 1024, windowsHide: true });
  return stdout;
}

/** Only asks for interface names. Never invokes showconf, dump, or private-key. */
export async function wireguardInterfaces({ platform = process.platform, run = command, exists = fs.existsSync } = {}) {
  const candidates = platform === 'win32'
    ? [path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'WireGuard', 'wg.exe')]
    : ['/opt/homebrew/bin/wg', '/usr/local/bin/wg', '/usr/bin/wg', '/bin/wg'];
  let installed = false, unavailable = false;
  for (const file of candidates) {
    if (!exists(file)) continue;
    installed = true;
    try {
      const names = (await run(file, ['show', 'interfaces'])).trim().split(/\s+/).filter(safeName).slice(0,32);
      return { installed, names, unavailable: false };
    } catch { unavailable = true; }
  }
  if (platform === 'win32') {
    try {
      const root = process.env.SystemRoot || 'C:\\Windows';
      const output = await run(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', "Get-Service -Name 'WireGuardTunnel$*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name.Substring(16) }"]);
      const names = output.trim().split(/\r?\n/).filter(safeName).slice(0,32);
      if (names.length) return { installed: true, names, unavailable: false };
    } catch { /* No privilege escalation or configuration-file fallback. */ }
  }
  return { installed, names: [], unavailable };
}

/** Connect only to SSH and SMB. The SSH greeting is public, not an authentication attempt. */
export function probeDevice(address, { signal, localAddress, timeout = 900 } = {}) {
  const check = port => new Promise(resolve => {
    if (signal?.aborted) return resolve(null);
    let socket, settled = false, connected = false, banner = '';
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket?.destroy(); resolve(value); };
    const abort = () => finish(null);
    const timer = setTimeout(() => finish(connected ? { port } : null), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      socket = net.connect({ host: address, port, ...(localAddress ? { localAddress } : {}) });
      socket.once('connect', () => { connected = true; if (port === 445) finish({ port }); });
      socket.on('data', data => {
        banner += data.toString('utf8').slice(0, 256 - banner.length);
        if (banner.includes('\n') || banner.length >= 256) finish({ port, windows: /^SSH-2\.0-OpenSSH_for_Windows_/.test(banner) });
      });
      socket.once('end', () => finish(port === 22 ? { port } : null));
      socket.once('error', () => finish(null));
    } catch { finish(null); }
  });
  return Promise.all([check(22), check(445)]).then(ports => ({
    address, ssh: ports.some(item => item?.port === 22), smb: ports.some(item => item?.port === 445),
    platformHint: ports.some(item => item?.windows) ? 'windows' : 'unknown',
  }));
}

export class NetworkDevices {
  constructor({ directory, interfaces = os.networkInterfaces, detectWireguard = wireguardInterfaces, probe = probeDevice,
    lookup = (host => dns.lookup(host, { family: 4, all: true })), confirm, onChange = () => {} } = {}) {
    Object.assign(this, { interfaces, detectWireguard, probe, lookup, confirm, onChange });
    this.file = path.join(directory, 'network-overlays.json');
    this.overlays = []; this.candidates = []; this.pending = null; this.reviewing = false;
    this.scan = { phase: 'idle', checked: 0, total: 0, results: [] };
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 32768
        && (typeof process.getuid !== 'function' || stat.uid === process.getuid())) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (saved.schema === 1 && Array.isArray(saved.overlays)) this.overlays = saved.overlays.filter(row => row && safeName(row.name) && row.id === idFor('wg', row.name)).slice(0,16).map(row => ({ id: row.id, name: row.name }));
      }
    } catch { /* Invalid saved names never authorize any network traffic. */ }
  }
  snapshot() { return structuredClone({ candidates: this.candidates, overlays: this.overlays, scan: this.scan }); }
  publish() { this.onChange(this.snapshot()); }
  async inventory() {
    const detected = await this.detectWireguard(), interfaces = this.interfaces();
    const rows = [], overlayNames = new Set(detected.names);
    for (const [name, entries] of Object.entries(interfaces)) {
      if (!safeName(name)) continue;
      for (const entry of entries || []) {
        if (entry.internal || !privateIpv4(entry.address)) continue;
        const wireguard = overlayNames.has(name);
        const tunnel = wireguard || /^(utun|tun|tap|wg|tailscale|zerotier|zt|ipsec|ppp)/i.test(name);
        let range;
        try { range = lanRange(entry.address, entry.netmask); } catch { continue; }
        rows.push({ id: idFor(name, entry.address, entry.netmask), name, address: entry.address, netmask: entry.netmask,
          kind: wireguard ? 'wireguard' : tunnel ? 'vpn' : 'lan', cidr: range.cidr,
          overlayId: wireguard ? idFor('wg', name) : null, scanAvailable: !tunnel && range.targets.length > 0 });
      }
    }
    this.candidates = rows.slice(0,64);
    this.wireguard = { installed: detected.installed, unavailable: detected.unavailable,
      services: detected.names.map(name => ({ name, id: idFor('wg', name), active: rows.some(row => row.name === name) })) };
    return { ...this.snapshot(), wireguard: this.wireguard };
  }
  async setOverlay(id, enabled) {
    if (typeof id !== 'string' || typeof enabled !== 'boolean' || this.reviewing) throw new Error('Invalid overlay choice.');
    this.reviewing = true;
    try {
      const inventory = await this.inventory(), service = inventory.wireguard.services.find(row => row.id === id);
      if (enabled && !service) throw new Error('Refresh WireGuard and choose a detected tunnel.');
      if (!enabled && !this.overlays.some(row => row.id === id)) throw new Error('That overlay is not saved.');
      if (enabled && this.overlays.some(row => row.id === id)) return inventory;
      if (enabled && this.overlays.length >= 16) throw new Error('Remove an overlay before adding another.');
      if (enabled && !await this.confirm({ message: 'Use this existing WireGuard overlay in FrostByte?',
        detail: `Tunnel: ${service.name}\n\nSave this tunnel as an optional device-discovery source. This does not start a tunnel, read private keys, change routes, or bind all torrent traffic to the VPN. Connections follow your operating system routes. Each network check and device pairing needs separate approval.`, action: 'Add overlay' })) return { ...inventory, cancelled: true };
      const next = enabled ? [...this.overlays, { id, name: service.name }] : this.overlays.filter(row => row.id !== id);
      writeJson(this.file, { schema: 1, overlays: next }, { maxBytes: 32768 });
      if (!enabled && this.scan.network?.overlayId === id) this.cancel();
      this.overlays = next; this.publish(); return { ...this.snapshot(), wireguard: this.wireguard };
    } finally { this.reviewing = false; }
  }
  async plan({ networkId, host = '' } = {}) {
    if (typeof networkId !== 'string' || typeof host !== 'string' || host.length > 253) throw new Error('Choose a network and a valid hostname.');
    await this.inventory();
    const network = this.candidates.find(row => row.id === networkId);
    if (!network) throw new Error('This network changed. Refresh the network list.');
    if (network.kind !== 'lan' && (network.kind !== 'wireguard' || !this.overlays.some(row => row.id === network.overlayId))) throw new Error('Add a detected WireGuard overlay before checking its devices.');
    let targets;
    host = host.trim();
    if (host) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host)) throw new Error('Enter a hostname or private IPv4 address, without a port or username.');
      if (net.isIP(host) && !privateIpv4(host)) throw new Error('Discovery only checks private IPv4 addresses.');
      targets = net.isIP(host) === 4 ? [host] : null;
    } else {
      if (!network.scanAvailable) throw new Error('Enter an exact private peer IP or hostname for WireGuard. Overlay subnets are never swept.');
      targets = lanRange(network.address, network.netmask).targets;
    }
    return { network, targets, host };
  }
  async resolveTargets({ network, targets, host }) {
    if (!targets) {
      let timer;
      const answers = await Promise.race([this.lookup(host), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Hostname lookup timed out. Try its private IP address.')), 4000); timer.unref?.(); })]).finally(() => clearTimeout(timer));
      if (!answers.length || answers.some(row => !privateIpv4(row.address))) throw new Error('That hostname does not resolve exclusively to private IPv4 addresses.');
      targets = [...new Set(answers.map(row => row.address))].slice(0,8);
    }
    if (network.kind === 'lan') {
      const mask = ipv4Number(network.netmask), base = (ipv4Number(network.address) & mask) >>> 0;
      if (targets.some(address => ((ipv4Number(address) & mask) >>> 0) !== base)) throw new Error('That device is outside the selected LAN. Choose its WireGuard overlay or the correct network.');
    }
    const local = new Set(Object.values(this.interfaces()).flat().map(row => row.address));
    targets = targets.filter(address => !local.has(address));
    if (!targets.length) throw new Error('No remote device addresses in this selection.');
    return targets;
  }
  async start(request) {
    if (this.pending || this.reviewing) throw new Error('A discovery or permission review is already in progress.');
    this.reviewing = true;
    const controller = new AbortController(); this.controller = controller;
    try {
      const plan = await this.plan(request);
      const allowed = await this.confirm({ message: 'Check devices on this network?',
        remember: { kind: 'network-discovery', scope: [plan.network.id, plan.network.kind, plan.host || plan.network.cidr, 'ssh22-smb445'], label: 'Remember for checks of this network selection' },
        detail: `${plan.network.name} · ${plan.network.address}\n${plan.host ? `${plan.host} (private IPv4 addresses only; hostname lookup uses your system resolver)` : `${plan.network.cidr} · ${plan.targets.length} addresses maximum`}\n\nFrostByte will check SSH (22) and file sharing (445), and may read the public SSH greeting. No logins, password attempts, file access, software installation, or seeding changes. Only scan networks you own or administer. ${plan.network.kind === 'wireguard' ? 'This uses the selected tunnel source address; operating-system routes must already reach the peer.' : ''}`, action: 'Scan network' });
      if (!allowed || controller.signal.aborted) return { cancelled: true, ...this.snapshot() };
      await this.inventory();
      if (!this.candidates.some(row => row.id === plan.network.id)) throw new Error('The network changed during review. Scan again.');
      plan.targets = await this.resolveTargets(plan);
      if (controller.signal.aborted) return { cancelled: true, ...this.snapshot() };
      this.scan = { id: randomUUID(), phase: 'scanning', checked: 0, total: plan.targets.length, network: plan.network, results: [] };
      this.publish();
      this.pending = this.run(plan, controller).finally(() => { this.pending = null; });
      return this.snapshot();
    } finally { this.reviewing = false; }
  }
  async run(plan, controller) {
    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted && cursor < plan.targets.length) {
        const current = this.interfaces()[plan.network.name] || [];
        if (!current.some(row => row.address === plan.network.address && row.netmask === plan.network.netmask)) { controller.abort(); break; }
        const address = plan.targets[cursor++];
        try {
          const device = await this.probe(address, { signal: controller.signal, localAddress: plan.network.address });
          if (!controller.signal.aborted && (device.ssh || device.smb)) this.scan.results.push({ ...device, name: plan.host || address, networkId: plan.network.id });
        } catch { /* A host disappearing does not discard other results. */ }
        this.scan.checked++; this.publish();
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(12, plan.targets.length) }, worker)); }
    finally { this.scan.phase = controller.signal.aborted ? 'cancelled' : 'complete'; this.scan.results.sort((a,b) => ipv4Number(a.address) - ipv4Number(b.address)); this.publish(); }
  }
  cancel() { this.controller?.abort(); return this.snapshot(); }
  async close() { this.cancel(); await this.pending; }
}

export function registerNetworkDevices({ handle, service }) {
  handle('network-devices:inventory', () => service.inventory(), { notifyErrors: false });
  handle('network-devices:snapshot', () => service.snapshot(), { notifyErrors: false });
  handle('network-devices:scan', request => service.start(request), { notifyErrors: false });
  handle('network-devices:cancel', () => service.cancel(), { notifyErrors: false });
  handle('network-devices:overlay', (id, enabled) => service.setOverlay(id, enabled), { notifyErrors: false });
}
