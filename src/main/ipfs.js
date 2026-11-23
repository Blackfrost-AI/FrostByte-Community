import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { KuboRuntime, readPrivateJson } from './ipfs-runtime.js';
import { parseIpfsSource } from '../shared/ipfs-source.js';
import { validatePortableRelativePath, validatePortablePathSet, filesystemPathKey } from './portable-path.js';
import { contentKind } from '../shared/content-kind.js';
import { writeJson } from './store.js';
import { checkOrigin } from './aeon-origin-check.js';
import { normalizeOriginResult, originBlocksSharing, ORIGIN_SHARE_BLOCKED } from '../shared/aeon-origin-status.js';
import { integrityBlocksSharing, INTEGRITY_SHARE_BLOCKED } from './integrity-service.js';

/** Import parameters fixed by the AEON Model Share protocol. Spelled out so
 * the same files produce the same CID on FrostByte and on an Orb, whatever
 * defaults a Kubo release ships. */
export const SHARE_IMPORT = Object.freeze({ 'cid-version': 1, 'raw-leaves': true, chunker: 'size-1048576', hash: 'sha2-256' });

const MAX_FILES = 5000, MAX_JOBS = 500, MAX_BYTES = 16 * 1024 ** 4;
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_BYTES;
const identity = stat => ({ dev: stat.dev, ino: stat.ino });
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const key = value => filesystemPathKey(value, 'portable');
const digest = value => createHash('sha256').update(value).digest('hex');
function relative(value) { return validatePortableRelativePath(value, { platform: 'portable', label: 'IPFS file' }); }
async function directory(target, expected) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || expected && !same(stat, expected) || await fs.realpath(target) !== target) throw new Error('The selected IPFS storage folder changed or is unavailable.');
  return identity(stat);
}
async function regular(target, expected, links = 1) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== links || expected && !same(stat, expected)) throw new Error('The IPFS file changed or is linked.');
  return stat;
}
async function fileHash(target, length, { signal, expected, links = 1 } = {}) {
  signal?.throwIfAborted();
  const before = await regular(target, expected, links), handle = await fs.open(target, 'r');
  try {
    const held = await handle.stat(); if (!same(before, held)) throw new Error('IPFS file changed while opening.');
    const hash = createHash('sha256');
    if (length !== 0) for await (const chunk of handle.createReadStream({ autoClose: false, ...(length === undefined ? {} : { start: 0, end: length - 1 }) })) { signal?.throwIfAborted(); hash.update(chunk); }
    const end = await regular(target, held, links);
    if (end.size !== held.size || end.mtimeMs !== held.mtimeMs || end.ctimeMs !== held.ctimeMs) throw new Error('IPFS file changed while verifying.');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
async function drainGc(response) {
  const decoder = new TextDecoder(); let pending = '';
  const check = text => { if (!text.trim()) return; const row = JSON.parse(text); if (row.Error) throw new Error('IPFS could not clear cached blocks. Sharing remains stopped.'); };
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) check(line);
    if (pending.length > 64 * 1024) throw new Error('Invalid IPFS cache response.');
  }
  check(pending + decoder.decode());
}
function normalizedJob(raw) {
  if (!raw || !/^ipfs:[a-f0-9]{64}$/.test(raw.id || '') || !path.isAbsolute(raw.destination || '') || path.resolve(raw.destination) !== raw.destination) throw new Error('Invalid saved IPFS job.');
  const source = parseIpfsSource(raw.source).source;
  const folder = relative(raw.folder); if (folder.includes('/')) throw new Error('Invalid IPFS folder.');
  if (typeof raw.name !== 'string' || raw.name.length > 255 || /[\x00-\x1f\x7f]/.test(raw.name)) throw new Error('Invalid IPFS name.');
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > MAX_FILES) throw new Error('Invalid IPFS file list.');
  const files = raw.files.map(file => {
    const name = relative(file.path), cid = parseIpfsSource(file.cid).cid;
    if (!integer(file.size) || !integer(file.downloaded || 0) || file.downloaded > file.size) throw new Error('Invalid IPFS file size.');
    return { path: name, cid, size: file.size, downloaded: file.downloaded || 0,
      checkpointBytes: file.downloaded || 0,
      done: file.done === true, hash: /^[a-f0-9]{64}$/.test(file.hash || '') ? file.hash : '',
      partialHash: /^[a-f0-9]{64}$/.test(file.partialHash || '') ? file.partialHash : '',
      identity: file.identity && { dev: file.identity.dev, ino: file.identity.ino } };
  });
  validatePortablePathSet(files.map(f => f.path), { platform: 'portable', artifactSuffixes: ['.frostipfs'] });
  const total = files.reduce((sum, f) => sum + f.size, 0); if (!integer(total)) throw new Error('IPFS download exceeds the size limit.');
  if (raw.id !== 'ipfs:' + digest(source + '\0' + key(raw.destination))) throw new Error('IPFS job identity does not match its destination.');
  return { id: raw.id, source, folder, name: raw.name, destination: raw.destination, files, total,
    status: ['done', 'error', 'cancelled'].includes(raw.status) ? raw.status : 'paused',
    kind: contentKind({ ...raw, files: files.map(f => ({ path: f.path })) }),
    error: '', cleared: raw.status === 'done' && raw.cleared === true, removed: raw.removed === true, updatedAt: integer(raw.updatedAt) ? raw.updatedAt : 0,
    rootIdentity: raw.rootIdentity, folderIdentity: raw.folderIdentity,
    sharing: false, shareCid: raw.shareCid ? parseIpfsSource(raw.shareCid).cid : '', origin: normalizeOriginResult(raw.origin) };
}

export class IpfsTransfers extends EventEmitter {
  constructor({ directory: home, binaryDirectory, isolated = false, requireDestination = async value => value }) {
    super(); this.home = home; this.stateFile = path.join(home, 'transfers.json');
    this.reader = new KuboRuntime({ directory: path.join(home, 'receive'), binaryDirectory, isolated });
    this.publisher = new KuboRuntime({ directory: path.join(home, 'publish'), binaryDirectory, isolated });
    this.jobs = new Map(); this.previews = new Map(); this.running = new Map(); this.inspections = new Map(); this.requireDestination = requireDestination;
    // Assigned by the app after construction; null in standalone/test use.
    this.integrity = null;
    this.shareTail = Promise.resolve(); this.stopping = false; this.stats = { uploadSpeed: 0, uploaded: 0, peers: 0 }; this.polling = false;
  }
  async load() {
    try {
    const data = await readPrivateJson(this.stateFile);
    if (data !== null && (!Array.isArray(data) || data.length > MAX_JOBS)) throw new Error('Invalid saved IPFS transfer state.');
    for (const raw of data || []) { const job = normalizedJob(raw); this.jobs.set(job.id, job); }
    // Restored shares require an explicit On action. No cached block is served
    // merely because a previous process or image left it behind.
    } catch (error) { this.loadError = 'IPFS transfer state needs recovery: ' + error.message; throw error; }
  }
  persist() {
    // Other jobs can persist while this one is writing. Only serialize a
    // byte count whose prefix checksum has completed, never live progress
    // paired with an older checksum. Uncheckpointed bytes remain recoverable
    // from Kubo's block cache after an abrupt process exit.
    const rows = [...this.jobs.values()].map(({ controller, speedBps, ...job }) => ({ ...job,
      files: job.files.map(({ checkpointBytes, ...file }) => ({ ...file, downloaded: checkpointBytes ?? file.downloaded })) }));
    if (Buffer.byteLength(JSON.stringify(rows)) > 16 * 1024 * 1024) throw new Error('IPFS transfer records exceed the storage limit.');
    if (this.loadError) throw new Error(this.loadError);
    writeJson(this.stateFile, rows, { maxBytes: 16 * 1024 * 1024 });
    this.emit('change', this.snapshot());
  }
  snapshot() {
    return { available: !this.loadError, error: this.loadError || '', downloads: [...this.jobs.values()].map(job => ({ ...job, controller: undefined,
      dest: path.join(job.destination, job.folder), downloaded: job.files.reduce((sum, f) => sum + f.downloaded, 0),
      sharing: job.sharing === true && this.publisher.publishing && !!this.publisher.url,
      speedBps: job.speedBps || 0 })), stats: { ...this.stats, ...(!this.publisher.publishing || !this.publisher.url ? { uploadSpeed: 0, peers: 0 } : {}) } };
  }
  inspect(source) {
    if (this.loadError) return Promise.reject(new Error(this.loadError));
    if (this.stopping) return Promise.reject(new Error('IPFS is stopping.'));
    const controller = new AbortController();
    const work = this.inspectSource(source, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
    this.inspections.set(controller, work);
    return work.finally(() => this.inspections.delete(controller));
  }
  async inspectSource(source, signal) {
    const parsed = parseIpfsSource(source); await this.reader.ensure();
    const root = await this.reader.json('files/stat', { arg: parsed.argument }, { signal });
    const files = [], visited = new Set(); let pathBytes = 0;
    const visit = async (cid, filePath, stat, depth = 0) => {
      if (depth > 24 || visited.size > MAX_FILES || files.length >= MAX_FILES) throw new Error('This IPFS collection is too large or deeply nested. Choose a smaller folder.');
      if (stat.Type === 'file' || stat.Type === 'raw') {
        relative(filePath); if (!integer(stat.Size)) throw new Error('Invalid IPFS file size.');
        pathBytes += Buffer.byteLength(filePath); if (pathBytes > 512 * 1024) throw new Error('IPFS file names exceed the limit.');
        files.push({ path: filePath, size: stat.Size, cid: parseIpfsSource(cid).cid }); return;
      }
      if (stat.Type !== 'directory') throw new Error('Only ordinary files and folders can be downloaded from IPFS.');
      const seen = `${cid}\0${filePath}`; if (visited.has(seen)) throw new Error('Repeated IPFS directory.'); visited.add(seen);
      const listing = await this.reader.json('ls', { arg: cid, 'resolve-type': true, size: true }, { signal });
      const links = listing.Objects?.[0]?.Links;
      if (!Array.isArray(links) || links.length > MAX_FILES - files.length) throw new Error('IPFS directory exceeds the file limit.');
      for (const link of links) {
        const name = filePath ? filePath + '/' + link.Name : link.Name;
        relative(name);
        const child = link.Type === 2 ? { Type: 'file', Size: link.Size } : link.Type === 1 ? { Type: 'directory' } : await this.reader.json('files/stat', { arg: '/ipfs/' + parseIpfsSource(link.Hash).cid }, { signal });
        await visit(link.Hash, name, child, depth + 1);
      }
    };
    const name = parsed.path.split('/').pop() || parsed.cid.slice(0, 18);
    await visit(root.Hash, root.Type === 'directory' ? '' : name, root);
    if (!files.length) throw new Error('This IPFS folder contains no downloadable files.');
    validatePortablePathSet(files.map(f => f.path), { platform: 'portable', artifactSuffixes: ['.frostipfs'] });
    const total = files.reduce((n, f) => n + f.size, 0); if (!integer(total)) throw new Error('IPFS selection exceeds the size limit.');
    const preview = { id: randomUUID(), source: parsed.source, name, files, total, expires: Date.now() + 10 * 60_000 };
    for (const [id, old] of this.previews) if (old.expires < Date.now()) this.previews.delete(id);
    while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(preview.id, preview); return structuredClone(preview);
  }
  selection({ previewId, selectedPaths, name }) {
    const preview = this.previews.get(previewId);
    if (!preview || preview.expires < Date.now()) throw new Error('Preview this IPFS source again before downloading.');
    const paths = selectedPaths ?? preview.files.map(f => f.path);
    if (!Array.isArray(paths) || !paths.length || paths.length > preview.files.length || new Set(paths).size !== paths.length) throw new Error('Choose the IPFS files to download.');
    const files = paths.map(p => { const file = preview.files.find(f => f.path === p); if (!file) throw new Error('The IPFS file selection changed.'); return { ...file }; });
    const label = name?.trim() || preview.name;
    if (label.includes('/') || label.length > 120) throw new Error('Choose a short folder name without slashes.'); relative(label);
    return { previewId, source: preview.source, name: label, files, total: files.reduce((n, f) => n + f.size, 0) };
  }
  async add(request) {
    if (this.loadError) throw new Error(this.loadError);
    if (this.stopping) throw new Error('IPFS is stopping.');
    const selected = this.selection(request), approved = await this.requireDestination(request.destination);
    if (!path.isAbsolute(approved) || path.resolve(approved) !== approved) throw new Error('Choose an absolute IPFS destination.');
    const rootLink = await fs.lstat(approved);
    if (!rootLink.isDirectory() || rootLink.isSymbolicLink()) throw new Error('Choose an available, unlinked IPFS folder.');
    const destination = await fs.realpath(approved);
    const rootIdentity = await directory(destination), id = 'ipfs:' + digest(selected.source + '\0' + key(destination));
    if (this.jobs.has(id)) {
      const previous = this.jobs.get(id);
      if (!previous.removed || JSON.stringify(previous.files.map(f => [f.path, f.cid, f.size]).sort()) !== JSON.stringify(selected.files.map(f => [f.path, f.cid, f.size]).sort())) throw new Error('This IPFS source already has a transfer or retained files here. Restore its transfer or choose another folder for a different selection.');
      await this.checkFolders(previous, previous.files[0].path);
      await this.control('restore', id);
      if (previous.status !== 'done') this.start(previous);
      return id;
    }
    if (this.jobs.size >= MAX_JOBS) throw new Error('The IPFS transfer history is full.');
    const disk = await fs.statfs(destination);
    const cacheDisk = await fs.statfs(this.home);
    const needed = selected.total + 128 * 1024 * 1024;
    const sharedDisk = disk.type === cacheDisk.type && rootIdentity.dev === (await fs.stat(this.home)).dev;
    if (disk.bavail * disk.bsize < needed * (sharedDisk ? 2 : 1) || cacheDisk.bavail * cacheDisk.bsize < needed) throw new Error('Not enough space for the selected files and the IPFS block cache. Choose another drive or clear the cache.');
    const folder = `${selected.name} (${id.slice(-10)})`; relative(folder);
    await directory(destination, rootIdentity);
    await fs.mkdir(path.join(destination, folder), { mode: 0o700 }); // exclusive; existing data is never replaced
    const folderIdentity = await directory(path.join(destination, folder));
    const job = { id, source: selected.source, name: selected.name, folder, destination, rootIdentity, folderIdentity,
      files: selected.files.map(f => ({ ...f, downloaded: 0, checkpointBytes: 0, done: false, hash: '', partialHash: '' })),
      total: selected.total, kind: contentKind({ kind: request.kind, files: selected.files }),
      status: 'paused', error: '', sharing: false, shareCid: '', origin: null, updatedAt: Date.now(), cleared: false };
    this.jobs.set(id, job);
    try { this.persist(); } catch (error) { this.jobs.delete(id); throw error; }
    this.previews.delete(request.previewId); this.start(job); return id;
  }
  record(id) { const job = this.jobs.get(id); if (!job) throw new Error('This IPFS transfer no longer exists.'); return job; }
  async checkFolders(job, filePath) {
    await this.requireDestination(job.destination); await directory(job.destination, job.rootIdentity);
    const base = path.join(job.destination, job.folder); await directory(base, job.folderIdentity);
    let current = base;
    for (const part of filePath.split('/').slice(0, -1)) {
      current = path.join(current, part);
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await directory(current);
    }
    return path.join(base, filePath);
  }
  start(job) {
    if (this.running.has(job.id) || this.stopping) throw new Error('This IPFS transfer is already changing.');
    job.controller = new AbortController(); job.status = 'active'; job.error = ''; job.cleared = false;
    this.persist();
    const work = this.download(job).catch(error => {
      if (job.status === 'active') { job.status = job.controller.signal.aborted ? 'paused' : 'error'; job.error = job.controller.signal.aborted ? '' : error.message; }
    }).finally(() => { delete job.controller; job.speedBps = 0; this.running.delete(job.id); job.updatedAt = Date.now(); this.persist(); });
    this.running.set(job.id, work); work.catch(error => this.emit('failure', error));
  }
  async download(job) {
    await this.reader.ensure();
    for (const file of job.files) {
      const signal = job.controller.signal; signal.throwIfAborted();
      const target = await this.checkFolders(job, file.path), part = target + '.frostipfs';
      if (file.done) { if (await fileHash(target, undefined, { signal }) !== file.hash) throw new Error('A completed IPFS file changed. Your file was preserved.'); continue; }
      if (await this.recoverPublication(job, file, target, part, signal)) continue;
      let before;
      try { before = await regular(part, file.identity); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (before && (!file.identity || before.size < file.downloaded || !file.partialHash || await fileHash(part, file.downloaded) !== file.partialHash)) throw new Error('The partial IPFS file changed. It was preserved.');
      if (!before && file.downloaded) throw new Error('The partial IPFS file is missing.');
      const handle = await fs.open(part, before ? 'r+' : 'wx', 0o600);
      try {
        const held = await handle.stat(); await regular(part, held); if (before && !same(before, held)) throw new Error('The partial IPFS file changed while opening.');
        file.identity = identity(held);
        if (before && before.size > file.downloaded) await handle.truncate(file.downloaded);
        if (!before) file.partialHash = digest('');
        this.persist();
        let start = Date.now(), recent = 0;
        if (file.downloaded < file.size) {
          const response = await this.reader.request('cat', { arg: file.cid, offset: file.downloaded, length: file.size - file.downloaded }, { signal, timeout: 24 * 60 * 60_000 });
          const stream = response.body.getReader();
          try {
            for (;;) {
              let timer;
              const next = await Promise.race([stream.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IPFS peers stopped responding. Resume to retry.')), 60_000); })]).finally(() => clearTimeout(timer));
              if (next.done) break;
              signal.throwIfAborted(); const chunk = next.value;
              if (file.downloaded + chunk.length > file.size) throw new Error('IPFS returned more bytes than the verified file size.');
              await this.checkFolders(job, file.path); await regular(part, held);
              let used = 0;
              while (used < chunk.length) { const { bytesWritten } = await handle.write(chunk, used, chunk.length - used, file.downloaded); if (!bytesWritten) throw new Error('Could not write the IPFS file.'); used += bytesWritten; file.downloaded += bytesWritten; }
              recent += chunk.length;
              if (Date.now() - start >= 500) { job.speedBps = recent * 1000 / (Date.now() - start); recent = 0; start = Date.now(); this.emit('change', this.snapshot()); }
            }
          } finally { await stream.cancel().catch(() => {}); }
        }
        if (file.downloaded !== file.size) throw new Error('IPFS returned an incomplete file. Resume to retry.');
        await handle.sync(); await this.checkFolders(job, file.path); await regular(part, held);
      } finally {
        await handle.close();
        file.partialHash = await fileHash(part);
        file.checkpointBytes = file.downloaded;
        this.persist();
      }
      job.controller.signal.throwIfAborted();
      await this.checkFolders(job, file.path); await regular(part, file.identity);
      await fs.link(part, target); // atomic no-replace publication
      const published = await fs.lstat(target), original = await fs.lstat(part);
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 2 || !same(published, file.identity) || !same(original, file.identity) || original.isSymbolicLink()) throw new Error('The IPFS destination changed during publication. Files were preserved.');
      await fs.unlink(part); await regular(target, file.identity);
      file.done = true; file.hash = file.partialHash; file.partialHash = ''; delete file.identity;
      this.persist();
    }
    // Every file above was hashed from disk in this run. A read error here
    // leaves the result open; enabling sharing checks again and fails closed.
    try { job.origin = await this.checkOrigin(job, job.controller.signal); } catch { job.origin = null; job.controller.signal.throwIfAborted(); }
    job.status = 'done'; job.updatedAt = Date.now();
  }
  /** Hold the completed files to the AEON origin statement in their model card, if any. */
  async checkOrigin(job, signal) {
    await this.checkFolders(job, job.files[0].path);
    return checkOrigin(path.join(job.destination, job.folder), job.files.map(file => ({ path: file.path, size: file.size })),
      { hashes: new Map(job.files.map(file => [file.path, file.hash])), signal });
  }
  /** The CID these exact files are being shared under, or '' when they are not shared here. */
  sharedCid(files) {
    const list = rows => rows.map(file => `${file.sha256} ${file.size} ${file.path}`).sort().join('\n');
    const wanted = list(files);
    for (const job of this.jobs.values()) {
      if (job.sharing === true && job.shareCid && this.publisher.publishing && this.publisher.url && list(job.files.map(file => ({ ...file, sha256: file.hash }))) === wanted) return job.shareCid;
    }
    return '';
  }
  async recoverPublication(job, file, target, part, signal) {
    let published;
    try { published = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    // The saved full-file checkpoint and inode identify our interrupted
    // no-replace publication. Never adopt an unrelated existing file.
    const conflict = () => new Error('A file already exists at the IPFS destination. It was preserved.');
    if (!file.identity || file.downloaded !== file.size || !file.partialHash || !published.isFile()
      || published.isSymbolicLink() || !same(published, file.identity) || published.size !== file.size || ![1, 2].includes(published.nlink)) throw conflict();
    let original;
    try { original = await fs.lstat(part); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (published.nlink === 2 ? !original || !original.isFile() || original.isSymbolicLink() || !same(original, file.identity) || original.nlink !== 2 : !!original) throw conflict();
    if (await fileHash(target, undefined, { signal, expected: file.identity, links: published.nlink }) !== file.partialHash) throw conflict();
    await this.checkFolders(job, file.path);
    await regular(target, file.identity, published.nlink);
    if (original) { await regular(part, file.identity, 2); await fs.unlink(part); }
    await regular(target, file.identity);
    file.done = true; file.hash = file.partialHash; file.partialHash = ''; delete file.identity;
    this.persist(); return true;
  }
  async control(action, id) {
    if (this.stopping || this.loadError) throw new Error(this.loadError || 'IPFS is stopping.');
    const job = this.record(id);
    if (action === 'pause' || action === 'cancel') {
      if (job.status === 'done') return;
      job.status = action === 'cancel' ? 'cancelled' : 'paused'; job.controller?.abort();
      await this.running.get(id); this.persist(); return;
    }
    if (action === 'resume') {
      if (job.status === 'done' || this.running.has(id)) return;
      await this.checkFolders(job, job.files[0].path); this.start(job); return;
    }
    if (action === 'clear' && !this.running.has(id) && job.status === 'done') { const previous = job.cleared; job.cleared = true; try { this.persist(); } catch (error) { job.cleared = previous; throw error; } return; }
    if (['remove', 'restore'].includes(action) && !this.running.has(id)) {
      if (job.sharing) await this.sharing(id, false);
      const previous = { removed: job.removed, cleared: job.cleared };
      job.removed = action === 'remove'; job.cleared = false;
      try { this.persist(); } catch (error) { Object.assign(job, previous); throw error; } return;
    }
    throw new Error('Unsupported IPFS transfer action.');
  }
  sharing(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Choose an IPFS sharing state.');
    const work = this.shareTail.then(() => this.changeSharing(id, enabled));
    this.shareTail = work.catch(() => {}); return work;
  }
  async changeSharing(id, enabled) {
    if (this.stopping || this.loadError) throw new Error(this.loadError || 'IPFS is stopping.');
    this.shareController = new AbortController();
    const signal = this.shareController.signal;
    const job = this.record(id);
    if (job.status !== 'done') throw new Error('Finish this IPFS download before sharing.');
    if (enabled) {
      // A copy that fails its origin statement is never published. Checked
      // before the serving node is touched, so other shares stay online.
      job.origin = await this.checkOrigin(job, signal); this.persist();
      if (originBlocksSharing(job.origin)) throw new Error(ORIGIN_SHARE_BLOCKED);
      // File-integrity gate: scan the exact finished collection before the
      // serving node is touched. A risky format is never published.
      if (this.integrity && integrityBlocksSharing(await this.integrity.ensure(id, {
        item: { path: path.join(job.destination, job.folder), files: job.files.map(file => ({ path: file.path, size: file.size })) },
        signal,
      }))) throw new Error(INTEGRITY_SHARE_BLOCKED);
    }
    // Take the serving node offline before altering its allowed content set.
    await this.publisher.stop(); this.publisher.publishing = false; this.stats.uploadSpeed = 0;
    if (!enabled) { job.sharing = false; this.persist(); }
    try {
      await this.publisher.ensure();
      if (enabled) {
        const boundary = 'frostbyte-' + randomUUID();
        const files = job.files;
        const self = this;
        async function* body() {
          for (const file of files) {
            signal.throwIfAborted();
            const target = await self.checkFolders(job, file.path);
            if (await fileHash(target, undefined, { signal }) !== file.hash) throw new Error('An IPFS file changed. Download it again before sharing.');
            const stat = await regular(target), handle = await fs.open(target, 'r');
            try {
              if (!same(stat, await handle.stat())) throw new Error('The shared file changed while opening.');
              yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(file.path)}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
              const sum = createHash('sha256');
              for await (const chunk of handle.createReadStream({ autoClose: false })) { signal.throwIfAborted(); sum.update(chunk); yield chunk; }
              if (sum.digest('hex') !== file.hash) throw new Error('The shared file changed during import.');
              yield Buffer.from('\r\n');
            } finally { await handle.close(); }
          }
          yield Buffer.from(`--${boundary}--\r\n`);
        }
        const response = await this.publisher.request('add', { pin: true, 'wrap-with-directory': true, ...SHARE_IMPORT, progress: false }, { signal, body: body(), headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary }, timeout: 24 * 60 * 60_000 });
        let text = '';
        for await (const chunk of response.body) { text += Buffer.from(chunk).toString(); if (text.length > 4 * 1024 * 1024) throw new Error('IPFS publish response exceeds the limit.'); }
        const rows = text.trim().split('\n').map(line => JSON.parse(line));
        job.shareCid = parseIpfsSource(rows.at(-1)?.Hash).cid;
      }
      job.sharing = enabled;
      const permitted = new Set([...this.jobs.values()].filter(j => j.sharing).map(j => j.shareCid));
      const pins = await this.publisher.json('pin/ls', { type: 'recursive' });
      for (const cid of Object.keys(pins.Keys || {})) if (!permitted.has(cid)) await this.publisher.json('pin/rm', { arg: cid });
      if (enabled) await this.publisher.json('pin/add', { arg: job.shareCid });
      const gc = await this.publisher.request('repo/gc', {}, { signal, timeout: 30 * 60_000 });
      await drainGc(gc);
      this.persist(); await this.publisher.stop();
      if (permitted.size && !this.stopping) { this.publisher.publishing = true; await this.publisher.ensure(); }
    } catch (error) { job.sharing = false; await this.publisher.stop(); this.publisher.publishing = false; this.persist(); throw error; }
    this.emit('change', this.snapshot());
  }
  async clearCache() {
    if (this.stopping || this.loadError) throw new Error(this.loadError || 'IPFS is stopping.');
    if (this.running.size) throw new Error('Pause IPFS downloads before clearing their block cache.');
    await this.reader.ensure(); const result = await this.reader.request('repo/gc', {}, { timeout: 30 * 60_000 });
    await drainGc(result);
  }
  async sampleInventory() {
    if (this.checkingInventory || this.stopping) return;
    this.checkingInventory = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.status !== 'done') continue;
        try {
          await this.requireDestination(job.destination); await directory(job.destination, job.rootIdentity);
          await directory(path.join(job.destination, job.folder), job.folderIdentity);
          let missing = 0;
          for (const file of job.files) { try { const stat = await regular(path.join(job.destination, job.folder, file.path)); if (stat.size !== file.size) missing++; } catch { missing++; } }
          job.available = missing === 0; job.missingFiles = missing;
        } catch { job.available = false; job.missingFiles = job.files.length; }
      }
    } finally { this.checkingInventory = false; }
  }
  async sampleStats() {
    if (!this.publisher.url || !this.publisher.publishing || this.polling) return;
    this.polling = true;
    try { const [bw, peers] = await Promise.all([this.publisher.json('stats/bw', {}, { timeout: 2000 }), this.publisher.json('swarm/peers', {}, { timeout: 2000 })]); this.stats = { uploadSpeed: Math.max(0, bw.RateOut || 0), uploaded: Math.max(0, bw.TotalOut || 0), peers: peers.Peers?.length || 0 }; }
    catch { this.stats.uploadSpeed = 0; } finally { this.polling = false; }
  }
  async close() {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.shareController?.abort();
    for (const controller of this.inspections.keys()) controller.abort();
    for (const job of this.jobs.values()) job.controller?.abort();
    this.closing = (async () => {
      await Promise.allSettled([...this.running.values(), ...this.inspections.values()]); await this.shareTail;
      await Promise.all([this.reader.stop(), this.publisher.stop()]); if (!this.loadError) this.persist();
    })();
    return this.closing;
  }
}
