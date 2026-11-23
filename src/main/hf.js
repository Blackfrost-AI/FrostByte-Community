/**
 * HuggingFace integration — search, metadata, auth, and resumable HTTP pulls.
 *
 * Why this lives next to the torrent engine: torrents are how peers share
 * what they already have; HF is where a lot of it comes from in the first
 * place — and the only way to get gated models, because a magnet link can't
 * carry your authorization. A pull from HF can then be shared onto the swarm
 * from My Library, which is the intended loop.
 *
 * Pure module: no Electron imports, so it runs and tests in plain Node.
 *
 * Wire facts this code depends on (verified against the live API):
 *   - GET /api/models?search=&limit=  → public search; `gated` field, license in tags
 *   - GET /api/models/{id}?blobs=true → siblings[] with size, plus `sha` (commit) and `gated`
 *   - GET /api/whoami-v2 + Bearer      → 401 for bad tokens, {name, auth.accessToken.role} for good ones
 *   - GET /{repo}/resolve/{rev}/{path} → 307 with a RELATIVE location; auth must ride the
 *     first hop only (the signed cache URL needs none); gated repos 401 without a token
 *   - x-linked-etag is the file identity we pin resumes to
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { filesystemPathKey, validatePortablePathSet, validatePortableRelativePath } from './portable-path.js';
import { verifyHfTransferAuthorization } from './hf-authorizations.js';

const HF = 'https://huggingface.co';
const activeDestinations = new Set();
const MAX_HF_JSON_BYTES = 8 * 1024 * 1024;
const MAX_HF_SEARCH_ROWS = 100;
const MAX_HF_MODEL_FILES = 5000;
const MAX_HF_FILE_BYTES = 16 * 1024 ** 4;
const HF_REQUEST_TIMEOUT_MS = 20_000;
const HF_DOWNLOAD_IDLE_TIMEOUT_MS = 45_000;
const MAX_HF_SIDECAR_BYTES = 64 * 1024;
// HuggingFace's published HTTPS download firewall allowlist, plus its legacy
// LFS and Xet bridge names. Keep this exact: accepting an arbitrary HTTPS host
// would let a hostile redirect choose a private literal or DNS-rebinding name.
const TRUSTED_HF_DOWNLOAD_HOSTS = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cdn-lfs-eu-1.hf.co',
  'cas-bridge.xethub.hf.co',
  'cas-server.xethub.hf.co',
  'cas-server.xethub-eu.hf.co',
  'transfer.xethub.hf.co',
  'transfer.xethub-eu.hf.co',
  'aws.cdn.hf.co',
  'us-east-1.aws.cdn.hf.co',
  'us-west-2.aws.cdn.hf.co',
  'eu-west-3.aws.cdn.hf.co',
  'ap-southeast-1.aws.cdn.hf.co',
  'us.aws.cdn.hf.co',
  'us.gcp.cdn.hf.co',
  'us-east1.us.gcp.cdn.hf.co',
  'us-central1.us.gcp.cdn.hf.co',
  'us-west4.us.gcp.cdn.hf.co',
  'europe-west4.us.gcp.cdn.hf.co',
  'asia-southeast1.us.gcp.cdn.hf.co',
]);
const NOFOLLOW = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
const CLOEXEC = fs.constants.O_CLOEXEC || 0;

function boundedString(value, max, fallback = '') {
  return typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : fallback;
}
function boundedNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : fallback;
}
function boundedArray(value, max, label) {
  if (!Array.isArray(value)) return [];
  if (value.length > max) throw new Error(`HuggingFace returned too many ${label}.`);
  return value;
}

export class HfAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HfAuthError';
    this.status = status; // 401 = no/invalid token, 403 = token fine, access not granted
  }
}

export class HfNotFoundError extends Error {
  constructor(message, status = 404) {
    super(message);
    this.name = 'HfNotFoundError';
    this.status = status;
  }
}

const enc = (p) => String(p ?? '').split('/').filter(Boolean).map(encodeURIComponent).join('/');

async function responseJson(response, maxBytes = MAX_HF_JSON_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      try { await response.body?.cancel(); } catch { /* iterator teardown closes it */ }
      throw new Error('HuggingFace returned an unexpectedly large response.');
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('HuggingFace returned an invalid response.'); }
}

function authHeaders(token) {
  if (!token) return {};
  if (typeof token !== 'string' || token.length > 4096 || /[\r\n\0]/.test(token)) {
    throw new Error('That HuggingFace token is invalid.');
  }
  return { Authorization: `Bearer ${token}` };
}

function safeHttpsUrl(value, base = HF) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !TRUSTED_HF_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error('HuggingFace returned an untrusted download host.');
  }
  return url;
}

async function fetchHttps(value, options = {}) {
  let url = safeHttpsUrl(value);
  let headers = { ...(options.headers || {}) };
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, { ...options, headers, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects >= 4) throw new Error('HuggingFace download redirected too many times.');
    const next = safeHttpsUrl(location, url);
    if (next.origin !== url.origin) {
      delete headers.Authorization; delete headers.authorization;
      delete headers.Cookie; delete headers.cookie;
    }
    url = next;
  }
}

function fileSize(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_HF_FILE_BYTES) throw new Error(`HuggingFace returned an invalid ${label}.`);
  return number;
}

function timeoutMs(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) throw new Error(`Invalid ${label} timeout.`);
  return value;
}

function requestSignal(signal, duration = HF_REQUEST_TIMEOUT_MS) {
  const deadline = AbortSignal.timeout(duration);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function fetchHeaders(value, { signal, requestTimeoutMs, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('HuggingFace request timed out.')), timeoutMs(requestTimeoutMs, HF_REQUEST_TIMEOUT_MS, 'request'));
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try { return await fetchHttps(value, { ...options, signal: combined }); }
  finally { clearTimeout(timer); }
}

/** Public, credential-free range fetch used by the paired HF piece scheduler.
 * Keep this narrow so hybrid downloads get the same exact-host, manual-redirect,
 * credential-stripping and response-header deadline as ordinary HF downloads. */
export async function hfFetchRange(value, { headers, token, signal, requestTimeoutMs } = {}) {
  const keys = headers && typeof headers === 'object' && !Array.isArray(headers) ? Object.keys(headers) : [];
  const range = keys.length === 1 ? headers[keys[0]] : '';
  if (keys.length !== 1 || keys[0].toLowerCase() !== 'range' || typeof range !== 'string'
      || range.length > 100 || !/^bytes=\d+-\d+$/.test(range)) {
    throw new Error('Invalid HuggingFace byte range.');
  }
  const url = safeHttpsUrl(value);
  return fetchHeaders(url, {
    headers: { Range: range, 'Accept-Encoding': 'identity', ...(url.origin === HF ? authHeaders(token) : {}) },
    signal,
    requestTimeoutMs,
  });
}

/** Credential-free range fetch retained for callers that deliberately require
 * a public-only request. Authenticated hybrid transfers use hfFetchRange. */
export async function hfFetchPublicRange(value, options = {}) {
  return hfFetchRange(value, { ...options, token: undefined });
}

async function fetchOnceHeaders(value, { signal, requestTimeoutMs, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('HuggingFace request timed out.')), timeoutMs(requestTimeoutMs, HF_REQUEST_TIMEOUT_MS, 'request'));
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try { return await fetch(safeHttpsUrl(value), { ...options, redirect: 'manual', signal: combined }); }
  finally { clearTimeout(timer); }
}

function beneath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sameObject(left, right) {
  if (!left || !right) return false;
  if (Number(left.ino) && Number(right.ino)) return left.dev === right.dev && left.ino === right.ino;
  return true;
}

async function assertPortableEntries(parent, names) {
  const expected = new Map();
  for (const name of names) {
    let identity = null;
    try { identity = await fs.promises.lstat(path.join(parent, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    expected.set(filesystemPathKey(name, 'portable'), { name, identity });
  }
  let directory;
  try { directory = await fs.promises.opendir(parent); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  try {
    for await (const entry of directory) {
      const match = expected.get(filesystemPathKey(entry.name, 'portable'));
      if (!match || entry.name === match.name) continue;
      let alias;
      try { alias = await fs.promises.lstat(path.join(parent, entry.name)); }
      catch (error) { if (error.code === 'ENOENT') continue; else throw error; }
      if (match.identity && sameObject(match.identity, alias)) continue;
      throw pathBoundaryError('The HuggingFace destination contains names that collide on a supported filesystem.');
    }
  } finally { await directory.close().catch(() => {}); }
}

function pathBoundaryError(message) {
  return Object.assign(new Error(message), { code: 'FROSTBYTE_HF_PATH_BOUNDARY' });
}

function validateRegularFile(stat, label, { links = 1 } = {}) {
  const wrongLinks = links === 1 ? stat?.nlink > 1 : stat?.nlink !== links;
  if (!stat?.isFile() || stat.isSymbolicLink?.() || wrongLinks) throw pathBoundaryError(`${label} must be a regular, unlinked file.`);
  return stat;
}

async function optionalSafeFile(target, label) {
  try { return validateRegularFile(await fs.promises.lstat(target), label); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function prepareDownloadBoundary(approvedRoot, requestedDest) {
  if (typeof approvedRoot !== 'string' || !path.isAbsolute(approvedRoot) || approvedRoot.includes('\0')) {
    throw pathBoundaryError('Choose an approved absolute download folder.');
  }
  const requestedRoot = path.resolve(approvedRoot);
  const dest = path.resolve(requestedDest);
  const relative = path.relative(requestedRoot, dest);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw pathBoundaryError('HuggingFace downloads must stay inside the approved download folder.');
  }
  try {
    const portableRelative = relative.split(path.sep).join('/');
    validatePortableRelativePath(portableRelative, { platform: 'portable', label: 'HuggingFace destination path' });
    validatePortablePathSet([portableRelative], {
      platform: 'portable', label: 'HuggingFace destination path', artifactSuffixes: ['.frostpart', '.frostpart.json'],
    });
  } catch (error) { throw pathBoundaryError(error.message); }
  const rootLink = await fs.promises.lstat(requestedRoot);
  if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) throw pathBoundaryError('The approved download folder is linked or unavailable.');
  const root = await fs.promises.realpath(requestedRoot);
  const rootStat = await fs.promises.stat(root);
  if (!rootStat.isDirectory()) throw pathBoundaryError('The approved download folder is unavailable.');
  const canonicalDest = path.resolve(root, relative);
  if (!beneath(root, canonicalDest)) throw pathBoundaryError('HuggingFace download escaped its approved folder.');
  return { root, rootStat, dest: canonicalDest, requestedDest: dest, parent: path.dirname(canonicalDest), parentStat: null,
    namespaceNames: ['', '.frostpart', '.frostpart.json'].map(suffix => path.basename(canonicalDest) + suffix) };
}

async function verifyRoot(boundary) {
  const linked = await fs.promises.lstat(boundary.root);
  const current = await fs.promises.stat(boundary.root);
  if (linked.isSymbolicLink() || !linked.isDirectory() || !current.isDirectory()
      || !sameObject(current, boundary.rootStat) || await fs.promises.realpath(boundary.root) !== boundary.root) {
    throw pathBoundaryError('The approved download folder changed during the download.');
  }
}

async function prepareDownloadDirectories(boundary) {
  await verifyRoot(boundary);
  const relative = path.relative(boundary.root, boundary.parent);
  let current = boundary.root;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    let linked;
    try { linked = await fs.promises.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await assertPortableEntries(path.dirname(current), [path.basename(current)]);
      try { await fs.promises.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      linked = await fs.promises.lstat(current);
    }
    if (linked.isSymbolicLink() || !linked.isDirectory() || await fs.promises.realpath(current) !== current) {
      throw pathBoundaryError('The HuggingFace destination contains a linked folder.');
    }
    await assertPortableEntries(path.dirname(current), [path.basename(current)]);
  }
  await verifyRoot(boundary);
  boundary.parentStat = await fs.promises.stat(boundary.parent);
  await assertPortableEntries(boundary.parent, boundary.namespaceNames);
  return boundary;
}

async function verifyParent(boundary) {
  await verifyRoot(boundary);
  const linked = await fs.promises.lstat(boundary.parent);
  const current = await fs.promises.stat(boundary.parent);
  if (linked.isSymbolicLink() || !linked.isDirectory() || !current.isDirectory()
      || !sameObject(current, boundary.parentStat) || await fs.promises.realpath(boundary.parent) !== boundary.parent) {
    throw pathBoundaryError('The HuggingFace destination folder changed during the download.');
  }
  await assertPortableEntries(boundary.parent, boundary.namespaceNames);
}

async function readSidecar(target, boundary) {
  const before = await optionalSafeFile(target, 'The HuggingFace resume sidecar');
  if (!before) return null;
  if (before.size > MAX_HF_SIDECAR_BYTES) throw pathBoundaryError('The HuggingFace resume sidecar is unexpectedly large.');
  await verifyParent(boundary);
  const handle = await fs.promises.open(target, fs.constants.O_RDONLY | NOFOLLOW | CLOEXEC);
  try {
    const opened = validateRegularFile(await handle.stat(), 'The HuggingFace resume sidecar');
    const linked = validateRegularFile(await fs.promises.lstat(target), 'The HuggingFace resume sidecar');
    if (!sameObject(before, opened) || !sameObject(opened, linked)) throw pathBoundaryError('The HuggingFace resume sidecar changed while it was opened.');
    if (opened.size > MAX_HF_SIDECAR_BYTES) throw pathBoundaryError('The HuggingFace resume sidecar is unexpectedly large.');
    await verifyParent(boundary);
    const chunks = [];
    let position = 0;
    while (position <= MAX_HF_SIDECAR_BYTES) {
      const buffer = Buffer.alloc(Math.min(8192, MAX_HF_SIDECAR_BYTES + 1 - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position > MAX_HF_SIDECAR_BYTES) throw pathBoundaryError('The HuggingFace resume sidecar is unexpectedly large.');
    const after = validateRegularFile(await handle.stat(), 'The HuggingFace resume sidecar');
    const afterLink = validateRegularFile(await fs.promises.lstat(target), 'The HuggingFace resume sidecar');
    if (!sameObject(opened, after) || !sameObject(after, afterLink)) throw pathBoundaryError('The HuggingFace resume sidecar changed while it was read.');
    await verifyParent(boundary);
    return { text: Buffer.concat(chunks, position).toString('utf8'), identity: after };
  } finally { await handle.close(); }
}

function parseSidecar(saved) {
  let value;
  try { value = JSON.parse(saved.text); }
  catch { throw pathBoundaryError('The HuggingFace resume sidecar is invalid and was preserved.'); }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || keys.length !== 5 || keys.some(key => !['repoId', 'revision', 'filePath', 'etag', 'total'].includes(key))
      || typeof value.etag !== 'string' || value.etag.length > 200) {
    throw pathBoundaryError('The HuggingFace resume sidecar is invalid and was preserved.');
  }
  try {
    value.repoId = validateHfRepoId(value.repoId);
    value.filePath = validateHfFilePath(value.filePath);
    if (typeof value.revision !== 'string' || !value.revision || value.revision.length > 200 || value.revision.includes('\0')) throw new Error();
    value.total = fileSize(value.total, 'resume size');
  } catch { throw pathBoundaryError('The HuggingFace resume sidecar is invalid and was preserved.'); }
  return value;
}

async function writeSidecar(target, value, boundary, existing) {
  if (existing) {
    const current = await optionalSafeFile(target, 'The HuggingFace resume sidecar');
    if (!sameObject(existing, current)) throw pathBoundaryError('The HuggingFace resume sidecar changed before the download resumed.');
    await verifyParent(boundary);
    return current;
  }
  await verifyParent(boundary);
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_HF_SIDECAR_BYTES) throw pathBoundaryError('The HuggingFace resume sidecar is unexpectedly large.');
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle, opened;
  let linked = false;
  try {
    handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | CLOEXEC, 0o600);
    opened = validateRegularFile(await handle.stat(), 'The temporary HuggingFace resume sidecar');
    await verifyParent(boundary);
    await handle.writeFile(body);
    await handle.sync();
    const completed = validateRegularFile(await handle.stat(), 'The temporary HuggingFace resume sidecar');
    if (!sameObject(opened, completed) || completed.size !== Buffer.byteLength(body)) {
      throw pathBoundaryError('The temporary HuggingFace resume sidecar changed while it was saved.');
    }
    opened = completed;
    await verifyParent(boundary);
    await fs.promises.link(temporary, target); // atomic no-replace publication
    linked = true;
    const written = validateRegularFile(await fs.promises.lstat(target), 'The HuggingFace resume sidecar', { links: 2 });
    const held = validateRegularFile(await handle.stat(), 'The temporary HuggingFace resume sidecar', { links: 2 });
    if (!sameObject(opened, written) || !sameObject(held, written) || written.size !== opened.size) throw pathBoundaryError('The HuggingFace resume sidecar changed while it was saved.');
    await verifyParent(boundary);
    await fs.promises.unlink(temporary);
    const final = validateRegularFile(await fs.promises.lstat(target), 'The HuggingFace resume sidecar');
    const finalHeld = validateRegularFile(await handle.stat(), 'The HuggingFace resume sidecar');
    if (!sameObject(opened, final) || !sameObject(finalHeld, final) || final.size !== opened.size) throw pathBoundaryError('The HuggingFace resume sidecar changed during publication.');
    await handle.close(); handle = null;
    await verifyParent(boundary);
    return final;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (linked) {
      try {
        const current = await fs.promises.lstat(target);
        if (sameObject(opened, current)) await fs.promises.unlink(target);
      } catch { /* keep any independently-created sidecar */ }
    }
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    if (error.code === 'EEXIST') throw pathBoundaryError('A HuggingFace resume sidecar appeared during setup and was preserved.');
    throw error;
  }
}

async function openPart(target, before, startAt, boundary) {
  await verifyParent(boundary);
  const create = !before;
  const flags = fs.constants.O_RDWR | NOFOLLOW | CLOEXEC | (create ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
  const handle = await fs.promises.open(target, flags, 0o600);
  try {
    const opened = validateRegularFile(await handle.stat(), 'The HuggingFace partial download');
    const linked = validateRegularFile(await fs.promises.lstat(target), 'The HuggingFace partial download');
    if ((before && !sameObject(before, opened)) || !sameObject(opened, linked)) throw pathBoundaryError('The HuggingFace partial download changed while it was opened.');
    await verifyParent(boundary);
    if (startAt && opened.size !== startAt) throw pathBoundaryError('The HuggingFace partial download changed before it could resume.');
    return { handle, identity: opened };
  } catch (error) { await handle.close(); throw error; }
}

async function verifyOpenPart(handle, target, identity, boundary) {
  const opened = validateRegularFile(await handle.stat(), 'The HuggingFace partial download');
  const linked = validateRegularFile(await fs.promises.lstat(target), 'The HuggingFace partial download');
  if (!sameObject(identity, opened) || !sameObject(opened, linked)) throw pathBoundaryError('The HuggingFace partial download changed during the download.');
  await verifyParent(boundary);
}

async function publishPart(part, dest, handle, identity, expectedSize, boundary) {
  await verifyOpenPart(handle, part, identity, boundary);
  const heldBefore = validateRegularFile(await handle.stat(), 'The completed HuggingFace partial download');
  if (heldBefore.size !== expectedSize) throw pathBoundaryError('The completed HuggingFace partial download has the wrong size.');
  if (await optionalSafeFile(dest, 'The HuggingFace destination')) {
    throw pathBoundaryError('A file already exists at the HuggingFace destination. The verified partial was preserved.');
  }
  await verifyParent(boundary);
  let linked = false;
  let sourceRemoved = false;
  try {
    await fs.promises.link(part, dest); // atomic no-replace publication
    linked = true;
    const published = validateRegularFile(await fs.promises.lstat(dest), 'The completed HuggingFace file', { links: 2 });
    const held = validateRegularFile(await handle.stat(), 'The completed HuggingFace file', { links: 2 });
    if (!sameObject(identity, published) || !sameObject(held, published) || published.size !== expectedSize) {
      throw pathBoundaryError('The completed HuggingFace file changed during publication.');
    }
    await verifyParent(boundary);
    await fs.promises.unlink(part);
    sourceRemoved = true;
    const final = validateRegularFile(await fs.promises.lstat(dest), 'The completed HuggingFace file');
    const finalHeld = validateRegularFile(await handle.stat(), 'The completed HuggingFace file');
    if (!sameObject(identity, final) || !sameObject(finalHeld, final) || final.size !== expectedSize) {
      throw pathBoundaryError('The completed HuggingFace file changed during finalization.');
    }
    await verifyParent(boundary);
  } catch (error) {
    if (linked && !sourceRemoved) {
      try {
        const current = await fs.promises.lstat(dest);
        if (sameObject(identity, current)) await fs.promises.unlink(dest);
      } catch { /* preserve an independently-created destination */ }
    }
    if (error.code === 'EEXIST') throw pathBoundaryError('A file appeared at the HuggingFace destination. The verified partial was preserved.');
    throw error;
  }
}

function nextWithIdleTimeout(iterator, duration, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('HuggingFace download stalled. Retry to resume.')), duration);
    timer.unref?.();
    const aborted = () => finish(reject, signal.reason ?? Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    iterator.next().then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function* idleChunks(body, duration, signal) {
  const reader = body.getReader();
  let complete = false;
  try {
    while (true) {
      const next = await nextWithIdleTimeout({ next: () => reader.read() }, duration, signal);
      if (next.done) { complete = true; return; }
      yield next.value;
    }
  } finally {
    if (!complete) await reader.cancel('HuggingFace download stopped.').catch(() => {});
    reader.releaseLock();
  }
}

async function hashOpenFile(handle, algorithm, prefix, signal) {
  const hash = crypto.createHash(algorithm);
  if (prefix) hash.update(prefix);
  const stream = handle.createReadStream({ start: 0, autoClose: false, signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function jsonFetch(url, { token, signal, notFoundMessage } = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...authHeaders(token) },
    signal: requestSignal(signal),
    // Hub API endpoints return JSON directly. Following an unexpected redirect
    // would turn remote metadata into an arbitrary network request and could
    // carry a token to a destination outside this trust boundary.
    redirect: 'error',
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new HfAuthError('HuggingFace rejected the request — check your token and model access.', res.status);
    if (res.status === 404 && notFoundMessage) throw new HfNotFoundError(notFoundMessage, 404);
    throw new Error(`HuggingFace API ${res.status} for ${url}`);
  }
  return responseJson(res);
}

function licenseFromTags(tags = []) {
  if (!Array.isArray(tags)) return '';
  const t = tags.find((x) => typeof x === 'string' && x.startsWith('license:'));
  return t ? boundedString(t.slice('license:'.length), 200) : '';
}

/* --------------------------------------------------------------- public API */

const SEARCH_SORTS = new Set(['downloads', 'likes', 'lastModified', 'createdAt', 'trendingScore']);
function searchRow(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Invalid HuggingFace model row.');
  const id = validateHfRepoId(r.id);
  const tags = boundedArray(r.tags, 200, 'model tags').filter(t => typeof t === 'string' && t.length <= 200 && !t.includes('\0'));
  return {
    id,
    author: id.split('/')[0],
    gated: r.gated === true || r.gated === 'auto' ? 'auto' : r.gated === 'manual' ? 'manual' : false,
    downloads: boundedNumber(r.downloads),
    likes: boundedNumber(r.likes),
    license: licenseFromTags(tags),
    pipelineTag: boundedString(r.pipeline_tag, 200),
    lastModified: boundedString(r.lastModified, 100),
    createdAt: boundedString(r.createdAt, 100),
    trendingScore: boundedNumber(r.trendingScore),
    tags: tags.filter(t => !t.includes(':')).slice(0, 100),
  };
}

/** A page of public Hub results. Only accept cursors, never arbitrary next-page URLs. */
export function hfBrowseRequest(q, options = {}) {
  const requestedLimit = Math.min(MAX_HF_SEARCH_ROWS, Math.max(1, Number(options.limit) || 40));
  const params = new URLSearchParams({
    limit: String(requestedLimit),
    sort: SEARCH_SORTS.has(options.sort) ? options.sort : 'downloads',
    direction: options.direction === 1 ? '1' : '-1',
  });
  if (q) params.set('search', String(q).slice(0, 500));
  for (const key of ['author', 'pipeline_tag']) if (options[key]) params.set(key, String(options[key]).slice(0, 200));
  for (const key of ['library', 'language', 'format']) if (options[key]) params.append('filter', String(options[key]).slice(0, 100));
  if (options.license) params.append('filter', `license:${String(options.license).slice(0, 100)}`);
  if (options.gated === 'false' || options.gated === 'true') params.set('gated', options.gated);
  if (options.cursor) params.set('cursor', String(options.cursor).slice(0, 8000));
  for (const field of ['downloads', 'likes', 'lastModified', 'createdAt', 'gated', 'tags', 'pipeline_tag', 'trendingScore']) params.append('expand', field);
  return { url: `${HF}/api/models?${params}`, query: q ? String(q).slice(0, 500) : '', requestedLimit };
}

export async function hfBrowse(q, options = {}) {
  const request = hfBrowseRequest(q, options);
  const res = await fetch(request.url, {
    headers: { Accept: 'application/json' }, signal: requestSignal(options.signal), redirect: 'error',
  });
  if (!res.ok) throw new Error(res.status === 429 ? 'HuggingFace is rate limiting search. Wait a moment and try again.' : `HuggingFace search failed (${res.status}). Try again.`);
  const rows = await responseJson(res);
  if (!Array.isArray(rows)) throw new Error('HuggingFace returned an unexpected search response.');
  const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  const nextUrl = next ? new URL(next, HF) : null;
  const cursor = nextUrl?.origin === HF && nextUrl.pathname === '/api/models' ? nextUrl.searchParams.get('cursor') : null;
  const models = [];
  for (const row of rows.slice(0, request.requestedLimit)) {
    try { models.push(searchRow(row)); } catch { /* malformed remote rows do not reach the renderer */ }
  }
  return { models, cursor };
}

export async function hfSearch(q, options = {}) {
  return (await hfBrowse(q, options)).models;
}

let facetsCache;
export async function hfFacets() {
  if (facetsCache && facetsCache.expires > Date.now()) return facetsCache.value;
  const value = {};
  await Promise.all(['pipeline_tag', 'library', 'license', 'language'].map(async type => {
    const data = await jsonFetch(`${HF}/api/models-tags-by-type?type=${type}`);
    const rows = boundedArray(data?.[type], 1000, `${type} facets`);
    value[type] = rows.flatMap(row => {
      const id = boundedString(row?.id, 200), label = boundedString(row?.label, 200);
      return id && label ? [{ id, label }] : [];
    }).sort((a, b) => a.label.localeCompare(b.label));
  }));
  facetsCache = { value, expires: Date.now() + 3600_000 };
  return value;
}

export async function hfRefs(repoId, { token, signal } = {}) {
  repoId = validateHfRepoId(repoId);
  const data = await jsonFetch(`${HF}/api/models/${enc(repoId)}/refs`, { token, signal });
  const rows = [];
  for (const [values, type] of [[data?.branches, 'Branch'], [data?.tags, 'Tag']]) {
    for (const ref of boundedArray(values, 1000, `${type.toLowerCase()} refs`)) {
      const name = boundedString(ref?.name, 200);
      if (name) rows.push({ name, type });
    }
  }
  return rows.slice(0, 1000);
}

export const MAX_HF_README_BYTES = 768 * 1024;

/**
 * Fetch a model card (README.md) anonymously, pinned to a commit or ref. Uses the trusted-host redirect guard and a
 * byte cap. A repository without a README returns an empty card, not an error. The text is returned raw; the renderer
 * turns it into safe HTML with src/shared/markdown.js.
 */
export async function hfReadme(repoId, { revision = 'main', signal } = {}) {
  repoId = validateHfRepoId(repoId);
  if (typeof revision !== 'string' || !revision || revision.length > 200 || /[\0\r\n]/.test(revision)) throw new Error('Invalid repository version.');
  const url = `${HF}/${enc(repoId)}/resolve/${encodeURIComponent(revision)}/README.md`;
  const response = await fetchHttps(url, { headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' }, signal: requestSignal(signal) });
  if (response.status === 404) { await response.body?.cancel(); return { text: '', missing: true, truncated: false }; }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return { text: '', restricted: true, truncated: false }; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HuggingFace returned HTTP ${response.status} for the model card.`); }
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  for await (const chunk of response.body ?? []) {
    const remaining = MAX_HF_README_BYTES - bytes;
    if (chunk.length > remaining) {
      chunks.push(Buffer.from(chunk).subarray(0, remaining));
      truncated = true;
      try { await response.body?.cancel(); } catch { /* iterator teardown closes it */ }
      break;
    }
    chunks.push(Buffer.from(chunk));
    bytes += chunk.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

export async function hfModelInfo(repoId, { token, signal, revision } = {}) {
  repoId = validateHfRepoId(repoId);
  if (revision !== undefined && (typeof revision !== 'string' || !revision || revision.length > 200 || /[\0\r\n]/.test(revision))) throw new Error('Invalid repository version.');
  const url = `${HF}/api/models/${enc(repoId)}${revision ? `/revision/${encodeURIComponent(revision)}` : ''}?blobs=true`;
  const d = await jsonFetch(url, { token, signal, notFoundMessage: 'That HuggingFace repository or version no longer exists.' });
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('HuggingFace returned invalid model information.');
  const files = [];
  const seen = new Set();
  for (const sibling of boundedArray(d.siblings, MAX_HF_MODEL_FILES, 'model files')) {
    try {
      const filePath = validateHfFilePath(sibling?.rfilename);
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const sha256 = /^[a-f0-9]{64}$/i.test(sibling?.lfs?.sha256 || '') ? sibling.lfs.sha256.toLowerCase() : null;
      files.push({ path: filePath, size: boundedNumber(sibling?.size), sha256 });
    } catch { /* skip malformed file rows */ }
  }
  return {
    id: repoId,
    sha: /^[a-f0-9]{40}$/i.test(d.sha || '') ? d.sha.toLowerCase() : '',
    gated: d.gated === true || d.gated === 'auto' ? 'auto' : d.gated === 'manual' ? 'manual' : false,
    private: !!d.private,
    license: licenseFromTags(d.tags),
    pipelineTag: boundedString(d.pipeline_tag, 200),
    // Used only to match bundled serving-support data; never executed or rendered as HTML.
    architectures: (Array.isArray(d.config?.architectures) ? d.config.architectures : [])
      .slice(0, 8).filter(arch => typeof arch === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(arch)),
    modelType: /^[A-Za-z0-9_-]{1,100}$/.test(d.config?.model_type || '') ? d.config.model_type : '',
    tags: (Array.isArray(d.tags) ? d.tags : []).slice(0, 256).filter(tag => typeof tag === 'string' && tag.length <= 200),
    lastModified: boundedString(d.lastModified, 100),
    downloads: boundedNumber(d.downloads),
    likes: boundedNumber(d.likes),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/**
 * Upstream hash anchor for the integrity gate: Map<repo-relative path, sha256|null>
 * for one repo version. sha256 comes from the Hub's LFS metadata; files the Hub
 * exposes without an LFS hash (plain git blobs) map to null — the caller must
 * treat those as "not comparable", never as a match. Typed errors: HfNotFoundError
 * for a vanished repo/version, HfAuthError for gated/private access.
 */
export async function getUpstreamHashes(repoId, { revision, token, signal } = {}) {
  const info = await hfModelInfo(repoId, { token, signal, revision });
  return new Map(info.files.map(file => [file.path, file.sha256]));
}

/** Validate a token. Returns {valid, user, role} — never throws for bad tokens. */
export async function hfWhoami(token, { signal } = {}) {
  try {
    const d = await jsonFetch(`${HF}/api/whoami-v2`, { token, signal });
    return { valid: true, user: boundedString(d?.name, 200), role: boundedString(d?.auth?.accessToken?.role, 100) };
  } catch (err) {
    if (err instanceof HfAuthError && err.status === 401) return { valid: false, user: '', role: '' };
    throw err;
  }
}

/* ------------------------------------------------------------- downloading */

function partFile(dest) { return dest + '.frostpart'; }
function metaFile(dest) { return dest + '.frostpart.json'; }

/**
 * Resolve a file URL to its (possibly relative) redirect target, carrying auth
 * on the first hop only. Returns {url, etag, status}.
 */
async function resolveFile({ repoId, revision, filePath, token, signal, requestTimeoutMs }) {
  const first = `${HF}/${enc(repoId)}/resolve/${encodeURIComponent(revision)}/${enc(filePath)}`;
  const res = await fetchOnceHeaders(first, {
    method: 'HEAD',
    headers: { 'Accept-Encoding': 'identity', ...authHeaders(token) },
    redirect: 'manual',
    signal,
    requestTimeoutMs,
  });

  if (res.status === 401 || res.status === 403) {
    throw new HfAuthError(
      res.status === 401
        ? 'This model is gated — a HuggingFace token is required.'
        : 'Your token is valid, but access to this gated model has not been granted to it.',
      res.status,
    );
  }
  if (res.status === 404) throw new Error(`Not found on HuggingFace: ${filePath}`);
  if (res.status !== 200 && res.status !== 206 && res.status !== 302 && res.status !== 307 && res.status !== 308) {
    throw new Error(`HuggingFace returned ${res.status} for ${filePath}`);
  }

  const loc = res.headers.get('location');
  const url = loc ? safeHttpsUrl(loc, HF).href : first;
  const etag = (res.headers.get('x-linked-etag') || res.headers.get('etag') || '').replace(/"/g, '');
  const rawSize = res.headers.get('x-linked-size') ?? (res.status === 200 ? res.headers.get('content-length') : null);
  const size = rawSize === null ? null : fileSize(rawSize, 'file size');
  return {
    url, etag, size,
    headers: { 'Accept-Encoding': 'identity', ...(new URL(url).origin === HF ? authHeaders(token) : {}) },
    status: res.status,
  };
}

/**
 * Resumable streaming download of one repo file.
 *
 * - Writes to `<dest>.frostpart` + a JSON sidecar, then publishes with an
 *   atomic no-replace hard link.
 * - Resume only continues when the sidecar's etag matches the pinned bytes;
 *   foreign or stale partial state is preserved for explicit recovery.
 * - getRate() is polled per chunk for bandwidth caps (bytes/sec, -1 = ∞).
 */
export async function hfDownloadFile(options) {
  validateHfRepoId(options.repoId);
  validateHfFilePath(options.filePath);
  const requestedDest = path.resolve(options.dest);
  const prepared = await prepareDownloadBoundary(options.approvedRoot, requestedDest);
  const activeKeys = ['', '.frostpart', '.frostpart.json'].map(suffix => filesystemPathKey(prepared.dest + suffix, 'portable'));
  if (activeKeys.some(key => activeDestinations.has(key))) throw new Error('This file conflicts with another active HuggingFace download.');
  for (const key of activeKeys) activeDestinations.add(key);
  try {
    const boundary = await prepareDownloadDirectories(prepared);
    return await downloadFile({ ...options, dest: boundary.dest, requestedDest, boundary });
  } finally {
    for (const key of activeKeys) activeDestinations.delete(key);
  }
}

async function downloadFile({
  repoId, revision = 'main', filePath, dest, requestedDest, boundary, token,
  onProgress, getRate, signal, maxBytes, acquireBytes, expectedSize, expectedSha256,
  requestTimeoutMs, idleTimeoutMs,
}) {
  signal?.throwIfAborted();
  repoId = validateHfRepoId(repoId);
  filePath = validateHfFilePath(filePath);
  if (typeof revision !== 'string' || !revision || revision.length > 200 || revision.includes('\0')) throw new Error('Invalid HuggingFace revision');
  requestTimeoutMs = timeoutMs(requestTimeoutMs, HF_REQUEST_TIMEOUT_MS, 'request');
  idleTimeoutMs = timeoutMs(idleTimeoutMs, HF_DOWNLOAD_IDLE_TIMEOUT_MS, 'idle');
  const part = partFile(dest), sidecar = metaFile(dest);
  const partBefore = await optionalSafeFile(part, 'The HuggingFace partial download');
  const destinationBefore = await optionalSafeFile(dest, 'The HuggingFace destination');
  if (destinationBefore) throw pathBoundaryError('A file already exists at the HuggingFace destination. Move or remove it before downloading.');
  let meta, savedSidecar;
  const savedMeta = await readSidecar(sidecar, boundary);
  if (savedMeta !== null) { meta = parseSidecar(savedMeta); savedSidecar = savedMeta.identity; }
  if (meta && !partBefore) throw pathBoundaryError('The HuggingFace resume sidecar has no matching partial and was preserved.');
  if (partBefore && !meta) throw pathBoundaryError('The HuggingFace partial has no valid resume sidecar and was preserved.');
  if (meta && (meta.repoId !== repoId || meta.revision !== revision || meta.filePath !== filePath)) {
    throw pathBoundaryError('The HuggingFace resume sidecar belongs to a different download and was preserved.');
  }
  const resolved = await resolveFile({ repoId, revision, filePath, token, signal, requestTimeoutMs });
  const { url, etag } = resolved;
  const expected = expectedSize === undefined ? resolved.size : fileSize(expectedSize, 'expected file size');
  if (expected !== null && resolved.size !== null && expected !== resolved.size) throw new Error('HuggingFace file size changed before download. Refresh the model and try again.');
  let startAt = 0;
  if (meta) {
    if (meta.etag !== etag) throw pathBoundaryError('The HuggingFace resume sidecar no longer matches this pinned file and was preserved.');
    startAt = partBefore.size;
  }
  const headers = { ...resolved.headers };
  if (startAt) headers.Range = `bytes=${startAt}-`;
  let res = await fetchHeaders(url, { headers, signal, requestTimeoutMs });
  if (res.status === 416 && startAt) {
    // A complete part or an invalid range must still be verified by a full response.
    await res.body?.cancel();
    startAt = 0;
    res = await fetchHeaders(url, { headers: resolved.headers, signal, requestTimeoutMs });
  }
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403) throw new HfAuthError('The download link expired or was refused.', res.status);
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  if (res.status !== 206) startAt = 0;
  const range = res.status === 206 ? res.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/) : null;
  let rangeStart, rangeEnd, rangeTotal, responseLength;
  try {
    rangeStart = range ? fileSize(range[1], 'download range') : null;
    rangeEnd = range ? fileSize(range[2], 'download range') : null;
    rangeTotal = range ? fileSize(range[3], 'download size') : null;
    const contentLength = res.headers.get('content-length');
    responseLength = contentLength === null ? null : fileSize(contentLength, 'download size');
  } catch (error) {
    await res.body?.cancel();
    throw error;
  }
  if (res.status === 206 && (!range || rangeStart !== startAt || rangeEnd < rangeStart || rangeEnd >= rangeTotal)) {
    await res.body?.cancel();
    throw new Error('The server returned an inconsistent download range. Retry the file.');
  }
  if (range && responseLength !== null && responseLength !== rangeEnd - rangeStart + 1) {
    await res.body?.cancel();
    throw new Error('The server returned an inconsistent download length. Retry the file.');
  }
  const total = range ? rangeTotal
    : responseLength !== null ? responseLength
      : expected;
  if (total === null || total === undefined) {
    await res.body?.cancel();
    throw new Error('HuggingFace did not provide a bounded file size.');
  }
  if (expected !== null && expected !== undefined && total !== expected) {
    await res.body?.cancel();
    throw new Error('HuggingFace file size changed during download. Refresh the model and try again.');
  }
  if (meta && meta.total !== total) {
    await res.body?.cancel();
    throw pathBoundaryError('The HuggingFace resume sidecar has a different file size and was preserved.');
  }
  if (startAt > total) {
    await res.body?.cancel();
    throw new Error('Saved partial data is larger than the expected file. Remove it and retry.');
  }
  if (!res.body) throw new Error('Empty response body from HuggingFace');
  try {
    const space = await fs.promises.statfs(path.dirname(dest));
    const available = BigInt(space.bavail) * BigInt(space.bsize);
    if (BigInt(Math.max(0, total - startAt)) > available) throw new Error('There is not enough free space for this HuggingFace file.');
  } catch (error) {
    if (/not enough free space/.test(error.message)) {
      await res.body.cancel().catch(() => {});
      throw error;
    }
    // Some network filesystems do not expose statfs; the byte bound still applies.
  }
  let opened;
  try { opened = await openPart(part, partBefore, startAt, boundary); }
  catch (error) { await res.body.cancel().catch(() => {}); throw error; }
  const { handle: file, identity: partIdentity } = opened;
  let downloaded = startAt, lastReport = 0;
  const started = Date.now();
  const partialStop = new Error('Test download byte limit reached');
  let partial = false, writing = Promise.resolve();
  let sidecarIdentity;
  try {
    // Save the byte identity before changing the partial file, then revalidate the
    // held descriptor and path before the first truncate or write.
    sidecarIdentity = await writeSidecar(sidecar, { repoId, revision, filePath, etag, total }, boundary, savedSidecar);
    await verifyOpenPart(file, part, partIdentity, boundary);
    if (!startAt) await file.truncate(0);
    await verifyOpenPart(file, part, partIdentity, boundary);
    const sink = new Writable({
      write(value, _encoding, callback) {
        writing = (async () => {
          // Limit memory and keep a changing standalone cap responsive to cancellation.
          const chunkSize = getRate ? 16 * 1024 : 256 * 1024;
          for (let i = 0; i < value.length; i += chunkSize) {
            const chunk = value.subarray(i, i + chunkSize);
            if (downloaded + chunk.length > total) throw new Error('HuggingFace sent more data than the declared file size.');
            await acquireBytes?.(chunk.length, signal);
            let remaining = chunk.length;
            while (getRate && remaining > 0) {
              signal?.throwIfAborted();
              const rate = Number(getRate());
              if (!(rate > 0)) break;
              const ms = Math.min(100, remaining / rate * 1000);
              await delay(ms, undefined, { signal });
              remaining -= rate * ms / 1000;
            }
            signal?.throwIfAborted();
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, downloaded + offset);
              if (!bytesWritten) throw new Error('Could not write downloaded bytes');
              offset += bytesWritten;
            }
            downloaded += chunk.length;
            const now = Date.now();
            if (now - lastReport >= 150) {
              lastReport = now;
              const speedBps = (downloaded - startAt) / Math.max(0.25, (now - started) / 1000);
              onProgress?.({ downloaded, total, speedBps, etaMs: speedBps ? Math.max(0, total - downloaded) / speedBps * 1000 : 0 });
            }
            if (maxBytes && downloaded - startAt >= maxBytes) throw partialStop;
          }
        })();
        writing.then(() => callback(), callback);
      },
    });
    try {
      await pipeline(idleChunks(res.body, idleTimeoutMs, signal), sink, { signal });
      if (downloaded !== total) throw new Error(`Incomplete download: ${downloaded} of ${total} bytes. Retry to resume.`);
      await file.sync();
    } catch (err) {
      if (err === partialStop) partial = true;
      else throw err;
    }
    if (partial) return { path: requestedDest, bytes: downloaded, partial: true, partPath: partFile(requestedDest) };
    signal?.throwIfAborted();
    onProgress?.({ downloaded, total: downloaded, speedBps: 0, etaMs: 0, phase: 'verifying' });
    // HF LFS etags are SHA-256; Git-backed files use a blob SHA-1. Check both
    // against the descriptor we wrote, rather than reopening an attacker-swappable path.
    // When the CDN ETag is absent or weak, fall back to the LFS SHA-256 pinned in
    // model metadata (A5) so verification is never silently skipped.
    const pinnedSha256 = /^[a-f0-9]{64}$/i.test(expectedSha256 || '') ? String(expectedSha256).toLowerCase() : null;
    if (/^[a-f0-9]{64}$/i.test(etag)) {
      if (await hashOpenFile(file, 'sha256', '', signal) !== etag.toLowerCase()) throw new Error('Downloaded file failed its SHA-256 integrity check. Retry the file.');
    } else if (/^[a-f0-9]{40}$/i.test(etag)) {
      if (await hashOpenFile(file, 'sha1', `blob ${downloaded}\0`, signal) !== etag.toLowerCase()) throw new Error('Downloaded file failed its Git blob integrity check. Retry the file.');
    } else if (pinnedSha256) {
      if (await hashOpenFile(file, 'sha256', '', signal) !== pinnedSha256) throw new Error('Downloaded file failed its pinned SHA-256 integrity check. Retry the file.');
    }
    signal?.throwIfAborted();
    await verifyOpenPart(file, part, partIdentity, boundary);
    await publishPart(part, dest, file, partIdentity, downloaded, boundary);
    const sidecarNow = await optionalSafeFile(sidecar, 'The HuggingFace resume sidecar');
    if (!sameObject(sidecarIdentity, sidecarNow)) throw pathBoundaryError('The HuggingFace resume sidecar changed during the download.');
    await fs.promises.unlink(sidecar);
    await verifyParent(boundary);
    onProgress?.({ downloaded, total: downloaded, speedBps: 0, etaMs: 0 });
    return { path: requestedDest, bytes: downloaded, partial: false };
  } finally {
    await res.body?.cancel().catch(() => {});
    await writing.catch(() => {});
    await file.close().catch(() => {});
  }
}

/** Pure path resolution also permits a selected drive or share root on Windows. */
export function validateHfRepoId(value, platform = 'portable') {
  const parts = typeof value === 'string' ? value.split('/') : [];
  if (typeof value !== 'string' || value.length > 200 || parts.length > 2 || parts.some(part => !part || part === '.' || part === '..' || !/^[\w.-]+$/.test(part))) throw new Error('Invalid HuggingFace repository ID');
  try { validatePortableRelativePath(value, { platform, label: 'HuggingFace repository ID', maxLength: 200 }); }
  catch (error) { throw new Error(`Invalid HuggingFace repository ID. ${error.message}`); }
  return value;
}

export function validateHfFilePath(value, platform = 'portable') {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || value.includes('\0') || value.includes(':') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid repository file path');
  }
  try { validatePortableRelativePath(value, { platform, label: 'HuggingFace repository file path' }); }
  catch (error) { throw new Error(`Invalid repository file path. ${error.message}`); }
  return value;
}

export function hfDestinationPath(base, repoId, filePath, paths = path, platform = paths === path.win32 ? 'win32' : 'portable') {
  validateHfRepoId(repoId, platform);
  validateHfFilePath(filePath, platform);
  try {
    validatePortablePathSet([`${repoId}/${filePath}`], {
      platform, label: 'HuggingFace repository file path', artifactSuffixes: ['.frostpart', '.frostpart.json'],
    });
  } catch (error) { throw new Error(`Invalid repository file path. ${error.message}`); }
  const root = paths.resolve(base);
  const dest = paths.resolve(root, repoId, filePath);
  const relative = paths.relative(root, dest);
  if (!relative || paths.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + paths.sep)) throw new Error('File must stay inside the download folder');
  return dest;
}

/** Validate a batch before any queue record or destination directory exists. */
export function validateHfDownloadSelection(repoId, filePaths, { platform = 'portable' } = {}) {
  validateHfRepoId(repoId, platform);
  if (!Array.isArray(filePaths) || !filePaths.length) throw new Error('No HuggingFace files were selected.');
  const clean = filePaths.map(filePath => validateHfFilePath(filePath, platform));
  try {
    validatePortablePathSet(clean.map(filePath => `${repoId}/${filePath}`), {
      platform, label: 'Selected HuggingFace file paths', artifactSuffixes: ['.frostpart', '.frostpart.json'],
    });
  } catch (error) { throw new Error(`Selected HuggingFace files are unsafe. ${error.message}`); }
  return clean;
}

/** Final, partial, and sidecar names all belong to one download namespace. */
export function hfDestinationPathKeys(dest, { platform = 'portable' } = {}) {
  return ['', '.frostpart', '.frostpart.json'].map(suffix => filesystemPathKey(dest + suffix, platform));
}

export function hfDownloadPathKeys(base, repoId, filePath, { platform = 'portable', paths = path } = {}) {
  const dest = hfDestinationPath(base, repoId, filePath, paths, platform);
  return hfDestinationPathKeys(dest, { platform });
}

/** Resolve a repo-relative destination without accepting absolute, parent, or symlink paths. */
export function hfDestination(base, repoId, filePath) {
  const root = path.resolve(base);
  const dest = hfDestinationPath(root, repoId, filePath);
  // Existing symlink components cannot redirect a repo download outside its root.
  let current = root;
  for (const component of path.relative(root, dest).split(path.sep)) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Choose a download location without symbolic links'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  for (const suffix of ['.frostpart', '.frostpart.json']) {
    try { if (fs.lstatSync(dest + suffix).isSymbolicLink()) throw new Error('Partial download must be a regular file'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return dest;
}

/** A transfer is resumable only in the exact destination where its partial lives. */
export function hfTransferId(repoId, revision, filePath, baseDir, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  const destination = hfDestinationPath(baseDir, repoId, filePath, paths, platform);
  const location = crypto.createHash('sha256').update(filesystemPathKey(destination, platform)).digest('hex').slice(0, 16);
  return `${filesystemPathKey(repoId, platform)}/${String(revision).toLowerCase()}/${filesystemPathKey(filePath, platform)}#${location}`;
}

export function normalizeHfTransferRecord(value, { forRestore = false, defaultPeerDeviceId = '' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved HuggingFace transfer.');
  const repoId = validateHfRepoId(value.repoId);
  const revision = boundedString(value.revision, 40);
  if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error('Saved HuggingFace transfer has no pinned revision.');
  const filePath = validateHfFilePath(value.filePath);
  if (typeof value.baseDir !== 'string' || value.baseDir.length > 4096 || value.baseDir.includes('\0') || !path.isAbsolute(value.baseDir)) throw new Error('Saved HuggingFace transfer has an invalid destination.');
  const baseDir = path.resolve(value.baseDir), dest = hfDestination(baseDir, repoId, filePath);
  const source = value.source === 'hybrid' ? 'hybrid' : 'hf';
  const statuses = new Set(['queued', 'active', 'paused', 'done', 'error', 'cancelled']);
  if (!statuses.has(value.status)) throw new Error('Saved HuggingFace transfer has an invalid status.');
  const total = fileSize(value.total ?? 0, 'saved file size');
  const downloaded = fileSize(value.downloaded ?? 0, 'saved download size');
  if (total && downloaded > total) throw new Error('Saved HuggingFace progress exceeds its file size.');
  let status = value.status;
  if (forRestore) {
    if (value.cancelled === true || status === 'cancelled') status = 'cancelled';
    else if (value.pauseRequested === true || status === 'active') status = 'paused';
  }
  const result = {
    id: hfTransferId(repoId, revision, filePath, baseDir), repoId, revision: revision.toLowerCase(), filePath,
    baseDir, dest, source, total, downloaded,
    status,
    error: boundedString(value.error, 4000), startedAt: boundedNumber(value.startedAt),
    speedBps: forRestore ? 0 : boundedNumber(value.speedBps), etaMs: forRestore ? 0 : boundedNumber(value.etaMs),
  };
  if (value.authorization !== undefined) {
    result.authorization = verifyHfTransferAuthorization(result, value.authorization);
  }
  if (source === 'hybrid') {
    const peerDeviceId = boundedString(value.peerDeviceId || defaultPeerDeviceId, 200);
    if (!peerDeviceId) throw new Error('Saved hybrid transfer has no paired device.');
    result.peerDeviceId = peerDeviceId;
  }
  for (const key of ['phase', 'sourceMode', 'sourceNote']) {
    const text = boundedString(value[key], key === 'sourceNote' ? 1000 : 100);
    if (text) result[key] = text;
  }
  for (const key of ['hfBytes', 'peerBytes', 'resumedBytes', 'completedAt']) {
    if (value[key] !== undefined) result[key] = boundedNumber(value[key]);
  }
  if (value.pauseRequested === true) result.pauseRequested = true;
  if (value.cancelled === true) result.cancelled = true;
  return result;
}

/** Peek at a file's etag/size without downloading it. */
export async function hfStatFile({ repoId, revision = 'main', filePath, token, signal }) {
  const { url, etag, headers } = await resolveFile({ repoId, revision, filePath, token, signal });
  const head = await fetchHeaders(url, { method: 'HEAD', headers, signal });
  if (!head.ok) throw new Error(`Could not inspect file: HTTP ${head.status}`);
  try {
    const rawSize = head.headers.get('content-length');
    return { etag, size: rawSize === null ? 0 : fileSize(rawSize, 'file size') };
  } finally { await head.body?.cancel().catch(() => {}); }
}

export function sha256File(p, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(p, { signal });
    stream.on('data', (c) => h.update(c));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });
}
