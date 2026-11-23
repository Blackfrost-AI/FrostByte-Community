/** Exclusive owner of the pinned, hash-verified llama-server fallback runtime.
 *  Only FrostByte starts this process: fixed loopback argv, a random bearer
 *  credential held in main-process memory, bounded readiness, and teardown on
 *  stop/quit. Model files must come from a saved model-library location. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
/** Packaged apps read the reviewed manifest from Resources, never from an asar path. */
export function llamaManifestRoot(resourcesPath) {
  if (resourcesPath && fs.existsSync(path.join(resourcesPath, 'llama-runtime.json'))) return resourcesPath;
  return repoRoot;
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_FILES = 512;
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
export function isMachO(bytes) {
  return bytes.length >= 4 && MACHO_MAGICS.has(bytes.readUInt32BE(0));
}

export function llamaRuntimeManifest(root = repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, 'build/llama-runtime.json'), 'utf8'));
}

/** Verify the archive pin plus every extracted file before anything executes. */
export function verifyLlamaRuntime({ root = repoRoot, platform = `${process.platform}-${process.arch}`, resourcesPath } = {}) {
  const manifest = llamaRuntimeManifest(root);
  const entry = manifest.platforms[platform];
  if (!entry) return { available: false, reason: 'unsupported-platform' };
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'llama-runtime') : null,
    path.join(root, 'build/llama-runtime', platform),
  ].filter(Boolean);
  for (const directory of candidates) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
      if (receipt.archiveSha256 !== entry.archiveSha256 || receipt.tag !== manifest.tag) continue;
      // The afterPack hook re-signs Mach-O helpers and records their final
      // bytes. Overrides are honoured ONLY for Mach-O members: non-executable
      // files (licenses, manifests, data) stay pinned to the reviewed archive
      // hash, so a writable receipt cannot bless arbitrary replacement bytes.
      const finalHashes = receipt.finalFileSha256 && typeof receipt.finalFileSha256 === 'object' ? receipt.finalFileSha256 : {};
      const names = Object.keys(entry.files);
      const links = entry.links || {};
      if (names.length + Object.keys(links).length > MAX_FILES) continue;
      // The directory must contain exactly the reviewed inventory — no extras.
      const present = fs.readdirSync(directory).sort();
      const expected = [...names, ...Object.keys(links), 'runtime.json'].sort();
      if (present.length !== expected.length || present.some((name, index) => name !== expected[index])) continue;
      let total = 0;
      let ok = true;
      for (const name of names) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) { ok = false; break; }
        const stat = fs.lstatSync(path.join(directory, name));
        if (!stat.isFile()) { ok = false; break; }
        total += stat.size;
        if (total > MAX_RUNTIME_BYTES) { ok = false; break; }
        const bytes = fs.readFileSync(path.join(directory, name));
        const pinned = entry.files[name];
        if (sha256(bytes) === pinned) continue;
        // Only a re-signed Mach-O member may differ from the archive pin, and
        // only when the receipt records its exact final hash.
        const override = Object.hasOwn(finalHashes, name) ? finalHashes[name] : null;
        if (!isMachO(bytes) || typeof override !== 'string' || !/^[a-f0-9]{64}$/.test(override) || sha256(bytes) !== override) { ok = false; break; }
      }
      if (!ok) continue;
      // Symlinks must be exactly the pinned within-directory alias chains.
      for (const [name, targetName] of Object.entries(links)) {
        const stat = fs.lstatSync(path.join(directory, name));
        if (!stat.isSymbolicLink() || fs.readlinkSync(path.join(directory, name)) !== targetName) { ok = false; break; }
        if (!Object.hasOwn(entry.files, resolveAlias(links, name))) { ok = false; break; }
      }
      if (!ok) continue;
      const server = path.join(directory, entry.server);
      fs.accessSync(server, fs.constants.X_OK);
      return { available: true, directory, server, tag: manifest.tag };
    } catch { /* Missing or drifted runtime: fail closed, try the next candidate. */ }
  }
  return { available: false, reason: 'runtime-missing' };
}

/** Follow a pinned alias chain to its reviewed regular file; bounded and cycle-safe. */
function resolveAlias(links, name) {
  const seen = new Set();
  let current = name;
  while (Object.hasOwn(links, current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    current = links[current];
  }
  return current;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ManagedLlamaRuntime {
  constructor({ verify = verifyLlamaRuntime, fetch: transport = fetch, modelLibrary = null, spawnProcess = spawn, portAllocator = freePort, readinessTimeoutMs = 120000, root = repoRoot, resourcesPath = null } = {}) {
    this.verify = verify; this.fetch = transport; this.modelLibrary = modelLibrary;
    this.spawnProcess = spawnProcess; this.portAllocator = portAllocator;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.manifestRoot = root;
    this.resourcesPath = resourcesPath;
    this.process = null; this.session = null; this.starting = null; this.keyFile = null;
    this.idleTimer = null; this.generation = 0; this.verifiedCache = null;
  }
  /** Full verification runs once, then only when the directory fingerprint
   *  changes — never re-hash hundreds of MB on every catalog poll. */
  verified() {
    try {
      const manifest = llamaRuntimeManifest(this.manifestRoot);
      const platform = `${process.platform}-${process.arch}`;
      const entry = manifest.platforms[platform];
      const directory = [
        this.resourcesPath ? path.join(this.resourcesPath, 'llama-runtime') : null,
        path.join(this.manifestRoot, 'build/llama-runtime', platform),
      ].filter(Boolean).find(candidate => {
        try { return Boolean(entry) && fs.statSync(path.join(candidate, 'runtime.json')).isFile(); } catch { return false; }
      });
      if (directory) {
        const fingerprint = fs.readdirSync(directory).map(name => {
          const stat = fs.lstatSync(path.join(directory, name));
          return `${name}:${stat.size}:${stat.mtimeMs}:${stat.mode}`;
        }).sort().join('|');
        if (this.verifiedCache?.directory === directory && this.verifiedCache.fingerprint === fingerprint) return this.verifiedCache.result;
        const result = this.verify();
        this.verifiedCache = result.available ? { directory, fingerprint, result } : null;
        return result;
      }
    } catch { /* fall through to a full verify */ }
    this.verifiedCache = null;
    return this.verify();
  }
  status() {
    const verified = this.verified();
    return { available: verified.available, running: Boolean(this.process), model: this.session?.name || null };
  }
  /** Saved GGUF models the managed runtime can load; filesystem names alone never grant a path. */
  loadableModels() {
    if (!this.modelLibrary) return [];
    const rows = typeof this.modelLibrary.list === 'function' ? this.modelLibrary.list() : [];
    const out = [];
    for (const row of rows) {
      if (row.device !== 'local' || row.available === false) continue;
      if (row.completeness && row.completeness.complete === false) continue;
      let entry;
      try { entry = this.modelLibrary.entry(row.id); } catch { continue; }
      const gguf = (entry.files || []).filter(file => /\.gguf$/i.test(file.relative));
      if (!gguf.length) continue;
      // Sharded weights load via their first shard; llama.cpp resolves siblings.
      const primary = gguf.find(file => !/-\d{5}-of-\d{5}\./i.test(file.relative)) || gguf.sort((a, b) => a.relative.localeCompare(b.relative))[0];
      const root = path.resolve(entry.root);
      const absolute = path.resolve(root, primary.relative);
      if (!absolute.startsWith(root + path.sep)) continue;
      out.push({ libraryId: entry.id, name: row.name, path: absolute });
    }
    return out.slice(0, 256);
  }
  resolveModel(name) {
    const matches = this.loadableModels().filter(model => model.name === name);
    if (matches.length !== 1) throw new Error('This model is not available.');
    const model = matches[0];
    // At load time the file must exist and its real path must stay inside the
    // library root — a symlink inside the root cannot smuggle an outside file.
    try {
      const entry = this.modelLibrary.entry(model.libraryId);
      const realRoot = fs.realpathSync(entry.root);
      const realFile = fs.realpathSync(model.path);
      if (!realFile.startsWith(realRoot + path.sep) || !fs.statSync(realFile).isFile()) throw new Error('outside root');
    } catch { throw new Error('This model is not available.'); }
    return model;
  }
  async ensureLoaded(name, { signal } = {}) {
    if (typeof name !== 'string' || !name || name.length > 240 || /[\x00-\x1f\x7f]/.test(name) || name.includes('..')) throw new Error('Choose a model.');
    if (this.session?.name === name && this.process) { this.touch(); return this.session; }
    // Serialize every start behind one promise chain: concurrent callers can
    // never run two _start bodies at once, so no child or key dir is orphaned.
    const previous = this.starting || Promise.resolve();
    const attempt = previous.catch(() => {}).then(async () => {
      if (this.session?.name === name && this.process) { this.touch(); return this.session; }
      return this._start(name, signal);
    });
    this.starting = attempt;
    try { return await attempt; } finally { if (this.starting === attempt) this.starting = null; }
  }
  async _start(name, signal) {
    // Detach our own attempt from the queue slot before stop() awaits it —
    // otherwise stop() would await the very promise that is running it.
    this.starting = null;
    await this.stop();
    const generation = ++this.generation;
    if (signal?.aborted) throw new Error('cancelled');
    const verified = this.verified();
    if (!verified.available) throw new Error('The managed llama.cpp runtime is not installed on this computer.');
    const model = this.resolveModel(name);
    const port = await this.portAllocator();
    const apiKey = randomBytes(32).toString('hex');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frostbyte-llama-'));
    const keyFile = path.join(dir, 'api.key');
    let child;
    try {
      await fsp.writeFile(keyFile, apiKey, { mode: 0o600, flag: 'wx' });
      if (generation !== this.generation || signal?.aborted) throw new Error('cancelled');
      const args = [
        '--model', model.path,
        '--host', '127.0.0.1', '--port', String(port),
        '--alias', name,
        '--api-key-file', keyFile,
        '--no-webui', '--ctx-size', '8192', '--n-gpu-layers', '99',
      ];
      child = this.spawnProcess(verified.server, args, { cwd: verified.directory, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir() } });
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    let stderrTail = '';
    child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });
    const exited = new Promise(resolve => child.once('exit', resolve));
    this.process = child; this.keyFile = keyFile;
    const session = { name, port, apiKey, modelPath: model.path, libraryId: model.libraryId };
    this.session = session;
    const cleanup = async () => {
      if (this.process === child) { this.process = null; this.session = null; }
      if (this.keyFile === keyFile) this.keyFile = null;
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    child.once('exit', () => { if (this.process === child) { this.process = null; this.session = null; } });
    try {
      const deadline = Date.now() + this.readinessTimeoutMs;
      let ready = false;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('cancelled');
        if (generation !== this.generation) throw new Error('cancelled');
        if (child.exitCode !== null) throw new Error(`llama-server exited during startup.${stderrTail ? ' ' + stderrTail.split('\n').filter(Boolean).slice(-2).join(' ') : ''}`);
        try {
          const response = await this.fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(1500), headers: { Authorization: `Bearer ${apiKey}` } });
          if (response.ok) { ready = true; break; }
        } catch { /* Not ready yet. */ }
        await Promise.race([sleep(250), exited]);
      }
      if (!ready) throw new Error('The managed llama.cpp runtime did not become ready in time.');
      this.touch();
      return session;
    } catch (error) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); killTimer.unref?.();
      await Promise.race([exited, sleep(4000)]);
      clearTimeout(killTimer);
      await cleanup();
      throw error;
    }
  }
  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.stop().catch(() => {}); }, 10 * 60 * 1000);
    this.idleTimer.unref?.();
  }
  async stop() {
    this.generation += 1;
    clearTimeout(this.idleTimer); this.idleTimer = null;
    // Wait for any in-flight start so shutdown cannot race a spawn that is
    // still between mkdtemp and exec. The start observes the bumped
    // generation and tears itself down; this call reaps whatever remains.
    const pending = this.starting;
    if (pending) await pending.catch(() => {});
    const child = this.process;
    this.process = null; this.session = null;
    const keyFile = this.keyFile; this.keyFile = null;
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); killTimer.unref?.();
      await Promise.race([exited, sleep(6000)]);
      clearTimeout(killTimer);
    }
    if (keyFile) await fsp.rm(path.dirname(keyFile), { recursive: true, force: true }).catch(() => {});
  }
}
