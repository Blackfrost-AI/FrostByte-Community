import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseIpfsSource, looksLikeIpfsSource } from '../shared/ipfs-source.js';

const MAX_SOURCE_INPUT = 32_768;
const MAX_MAGNET_INPUT = 8 * 1024;
const MAX_LOCAL_PATH = 4096;
const MAX_PENDING_SOURCES = 20;

function validBtihMagnet(value) {
  const raw = value.match(/(?:^|[?&])xt=urn:btih:([a-z0-9]+)(?:&|$)/i)?.[1];
  return !!raw && (/^[a-f0-9]{40}$/i.test(raw) || /^[a-z2-7]{32}$/i.test(raw));
}

/** Classify an OS launch request without creating any renderer path authority. */
export function normalizeLaunchSource(value, { cwd = process.cwd(), platform = process.platform } = {}) {
  if (typeof value !== 'string' || !value || value.length > MAX_SOURCE_INPUT || /[\0\r\n]/.test(value)) return null;
  const candidate = value.trim();
  if (!candidate) return null;

  if (looksLikeIpfsSource(candidate)) {
    try { return { kind: 'ipfs', value: parseIpfsSource(candidate).source }; }
    catch { return null; }
  }

  // A magnet display name is allowed to end in ".torrent". Classify the
  // scheme first so it can never be mistaken for a local file request.
  if (/^magnet:/i.test(candidate)) {
    const magnet = candidate.replace(/^magnet:/i, 'magnet:');
    if (magnet.length > MAX_MAGNET_INPUT || !/^magnet:\?/i.test(magnet)
      || /[\x00-\x1f\x7f]/.test(magnet) || !validBtihMagnet(magnet)) return null;
    return { kind: 'magnet', value: magnet };
  }

  if (!/\.torrent$/i.test(candidate)) return null;
  // Accept local/UNC paths, not a web URL whose path happens to end in
  // .torrent. Drive-letter paths remain valid on Windows.
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)
    && !(platform === 'win32' && /^[a-z]:[\\/]/i.test(candidate))) return null;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const target = paths.resolve(cwd, value);
  if (!target || target.length > MAX_LOCAL_PATH) return null;
  return { kind: 'torrent', value: target };
}

/**
 * Holds raw launch requests until the renderer asks for them. In particular,
 * queuing a .torrent path does not mint or evict a path capability.
 */
export class LaunchSourceQueue {
  constructor({ grantTorrent, releaseTorrent = () => {}, maxSources = MAX_PENDING_SOURCES,
    cwd = process.cwd(), platform = process.platform } = {}) {
    if (typeof grantTorrent !== 'function') throw new TypeError('A torrent path grant function is required.');
    if (typeof releaseTorrent !== 'function') throw new TypeError('A torrent path release function is required.');
    if (!Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > MAX_PENDING_SOURCES) {
      throw new TypeError(`The launch source queue must contain 1-${MAX_PENDING_SOURCES} items.`);
    }
    this.grantTorrent = grantTorrent;
    this.releaseTorrent = releaseTorrent;
    this.maxSources = maxSources;
    this.normalizeOptions = { cwd, platform };
    this.pending = [];
    this.inFlight = null;
  }

  capture(value) {
    return normalizeLaunchSource(value, this.normalizeOptions);
  }

  enqueue(source) {
    if (!source || !['magnet', 'torrent', 'ipfs'].includes(source.kind) || typeof source.value !== 'string'
      || this.size >= this.maxSources) return false;
    this.pending.push(source);
    return true;
  }

  deliver(source) {
    if (!source || typeof source.value !== 'string') throw new Error('Invalid launch source.');
    if (source.kind === 'magnet' || source.kind === 'ipfs') return source.value;
    if (source.kind === 'torrent') return this.grantTorrent(source.value);
    throw new Error('Invalid launch source.');
  }

  deliverNext() {
    // Keep one main-owned lease until the renderer explicitly finishes that
    // review. Concurrent IPC requests and renderer reloads get the same grant;
    // they cannot drain the queue or mint additional path authority.
    if (this.inFlight) return [structuredClone(this.inFlight)];
    while (this.pending.length) {
      const source = this.pending.shift();
      try {
        this.inFlight = { id: randomUUID(), source: this.deliver(source) };
        return [structuredClone(this.inFlight)];
      }
      catch { /* omit an invalidated path and try the next queued request */ }
    }
    return [];
  }

  acknowledge(id) {
    if (typeof id !== 'string' || !this.inFlight || id !== this.inFlight.id) {
      throw new Error('This launch source is no longer awaiting review.');
    }
    // A successful download has already consumed this one-time grant. A
    // dismissal revokes the still-unused grant before advancing the queue.
    this.releaseTorrent(this.inFlight.source);
    this.inFlight = null;
    return { acknowledged: true, pending: this.pending.length };
  }

  get size() { return this.pending.length + (this.inFlight ? 1 : 0); }
}

/** File/protocol associations supply review requests, never instructions to start a transfer. */
export function downloadSourcesFromArguments(argv, { isPackaged = true, cwd = process.cwd(), platform = process.platform } = {}) {
  const sources = [];
  for (const argument of argv.slice(isPackaged ? 1 : 2)) {
    if (typeof argument !== 'string' || argument.startsWith('-')) continue;
    const source = normalizeLaunchSource(argument, { cwd, platform })?.value;
    if (source && !sources.includes(source)) sources.push(source);
    if (sources.length === MAX_PENDING_SOURCES) break;
  }
  return sources;
}
