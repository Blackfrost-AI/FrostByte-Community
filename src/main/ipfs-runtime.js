/** Private Kubo nodes. Download caches never serve blocks; the publisher only
 * contains explicitly shared CIDs. No arbitrary RPC is exposed through IPC. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const execute = promisify(execFile);
const hash = data => createHash('sha256').update(data).digest('hex');
const allowed = new Set(['id', 'version', 'add', 'files/stat', 'ls', 'cat', 'pin/add', 'pin/rm', 'pin/ls', 'dag/export', 'dag/import', 'repo/gc', 'stats/bw', 'swarm/peers', 'swarm/connect']);

export async function readPrivateJson(file, limit = 16 * 1024 * 1024, owned = true) {
  let handle;
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit || owned && typeof process.getuid === 'function' && before.uid !== process.getuid()) throw new Error('Invalid private IPFS state file.');
    handle = await fs.open(file, 'r');
    const held = await handle.stat();
    if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size) throw new Error('IPFS state changed while opening.');
    const bytes = Buffer.alloc(held.size + 1);
    let used = 0;
    while (used < bytes.length) { const r = await handle.read(bytes, used, bytes.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
    const after = await fs.lstat(file), end = await handle.stat();
    if (used !== held.size || end.mtimeMs !== held.mtimeMs || end.ctimeMs !== held.ctimeMs || after.dev !== held.dev || after.ino !== held.ino || after.isSymbolicLink()) throw new Error('IPFS state changed while reading.');
    return JSON.parse(bytes.subarray(0, used).toString());
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

export class KuboRuntime {
  constructor({ directory, binaryDirectory, publishing = false, isolated = false }) {
    Object.assign(this, { directory, binaryDirectory, publishing, isolated });
    this.binary = path.join(binaryDirectory, process.platform === 'win32' ? 'ipfs.exe' : 'ipfs');
    this.env = { ...process.env, IPFS_PATH: directory };
    this.secret = randomBytes(32).toString('hex');
    this.child = null; this.url = null; this.starting = null;
  }
  async verify() {
    const info = await readPrivateJson(path.join(this.binaryDirectory, 'runtime.json'), 4096, false);
    if (info?.version !== '0.43.0' || !/^[a-f0-9]{64}$/.test(info.binarySha256 || '')) throw new Error('IPFS support is missing. Build or install the FrostByte IPFS runtime.');
    if (hash(await fs.readFile(this.binary)) !== info.binarySha256) throw new Error('The IPFS runtime checksum changed. Reinstall FrostByte.');
  }
  async command(args, options = {}) {
    return execute(this.binary, args, { env: this.env, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options });
  }
  async ensure() {
    if (this.child && this.url) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async start() {
    await this.verify();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('IPFS state must be an owned private folder.');
    if (process.platform !== 'win32') await fs.chmod(this.directory, 0o700);
    let config = await readPrivateJson(path.join(this.directory, 'config'));
    if (!config) { await this.command(['init', '--profile=lowpower']); config = await readPrivateJson(path.join(this.directory, 'config')); }
    config.Addresses = { ...config.Addresses, API: '/ip4/127.0.0.1/tcp/0', Gateway: '', Swarm: this.isolated ? ['/ip4/127.0.0.1/tcp/0'] : ['/ip4/0.0.0.0/tcp/0', '/ip6/::/tcp/0'] };
    config.API = { HTTPHeaders: {}, Authorizations: { frostbyte: { AuthSecret: 'bearer:' + this.secret, AllowedPaths: [...allowed].map(p => '/api/v0/' + p) } } };
    config.Bitswap = { Libp2pEnabled: true, ServerEnabled: this.publishing };
    config.Provide = { ...config.Provide, Enabled: this.publishing && !this.isolated, Strategy: 'pinned' };
    config.Discovery = { MDNS: { Enabled: false } };
    config.AutoTLS = { Enabled: false };
    config.Swarm = { ...config.Swarm, DisableNatPortMap: true, RelayService: { Enabled: false } };
    config.Gateway = { ...config.Gateway, NoFetch: true, NoDNSLink: true };
    config.Routing = { Type: this.isolated ? 'none' : 'dhtclient' };
    if (this.isolated) { config.Bootstrap = []; config.AutoConf = { Enabled: false }; }
    await fs.writeFile(path.join(this.directory, 'config'), JSON.stringify(config, null, 2), { mode: 0o600 });
    // A previous crashed process cannot be adopted: fresh process + fresh RPC
    // secret must answer. Kubo itself enforces its repository lock.
    const child = this.child = spawn(this.binary, ['daemon', '--migrate=false'], { env: this.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', exited = false, failure;
    const capture = data => { log = (log + data.toString()).slice(-8192); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', error => { failure = error; exited = true; });
    child.once('exit', () => { exited = true; if (this.child === child) { this.child = null; this.url = null; } });
    try {
      for (let i = 0; i < 150; i++) {
        if (exited) throw failure || new Error('IPFS could not start: ' + log.replace(/bearer:[^\s"]+/g, '[redacted]').slice(-1200));
        try {
          const api = await fs.readFile(path.join(this.directory, 'api'), 'utf8');
          const match = /^\/ip4\/127\.0\.0\.1\/tcp\/([1-9][0-9]{0,4})\s*$/.exec(api);
          if (match && Number(match[1]) <= 65535) {
            this.url = `http://127.0.0.1:${match[1]}`;
            const version = await this.json('version', {}, { timeout: 500 });
            if (version.Version === '0.43.0') return;
          }
        } catch { this.url = null; }
        await delay(100);
      }
      throw new Error('IPFS startup timed out.');
    } catch (error) { await this.stop(); throw error; }
  }
  async request(command, params = {}, { signal, timeout = 60_000, body, headers = {} } = {}) {
    if (!allowed.has(command) || !this.url) throw new Error('IPFS operation is unavailable.');
    const url = new URL('/api/v0/' + command, this.url);
    for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { ...headers, Authorization: 'Bearer ' + this.secret }, signal: AbortSignal.any(signals), ...(body ? { body, duplex: 'half' } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`IPFS ${command} failed (HTTP ${response.status}). Check the CID and available peers.`);
    }
    return response;
  }
  async json(command, params, options) {
    const response = await this.request(command, params, options);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('IPFS metadata exceeds the limit.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async stop() {
    const child = this.child;
    this.url = null;
    if (!child) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); }
      else child.kill('SIGTERM');
    });
    if (this.child === child) this.child = null;
  }
}
