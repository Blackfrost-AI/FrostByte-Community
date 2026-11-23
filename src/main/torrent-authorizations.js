import { extractInfoHash } from './torrent.js';

/**
 * A short-lived, content-bound authorization created only after native review.
 * The infohash is the outbound discovery identity; magnet display names and
 * supplied tracker/peer parameters never become part of the authority.
 */
export class TorrentDiscoveryAuthorizations {
  constructor({ ttlMs = 5 * 60_000, max = 64, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60_000) throw new Error('Invalid torrent authorization lifetime.');
    if (!Number.isSafeInteger(max) || max < 1 || max > 1024) throw new Error('Invalid torrent authorization limit.');
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.entries = new Map();
  }

  identity(source) {
    const infoHash = extractInfoHash(source);
    if (!infoHash) throw new Error('A valid torrent content identity is required.');
    return infoHash;
  }

  key(source, action) {
    if (!['inspect', 'download'].includes(action)) throw new Error('Invalid torrent authorization action.');
    return `${action}\0${this.identity(source)}`;
  }

  prune(at = this.now()) {
    for (const [infoHash, expires] of this.entries) if (expires <= at) this.entries.delete(infoHash);
  }

  approve(source, action) {
    const infoHash = this.identity(source), key = this.key(infoHash, action);
    const at = this.now();
    this.prune(at);
    this.entries.delete(key);
    this.entries.set(key, at + this.ttlMs);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
    return infoHash;
  }

  has(source, action) {
    const key = this.key(source, action);
    this.prune();
    return this.entries.has(key);
  }

  consume(source, action) {
    const key = this.key(source, action);
    this.prune();
    return this.entries.delete(key);
  }

  clear() { this.entries.clear(); }
}
