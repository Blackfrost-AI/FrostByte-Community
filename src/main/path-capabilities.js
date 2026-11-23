import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_GRANTS = 64;
const GRANT_TTL_MS = 15 * 60 * 1000;

export class PathCapabilities {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.grants = new Map();
  }

  grant(value, purpose) {
    const target = normalize(value);
    if (!['save', 'completed', 'seed', 'torrent'].includes(purpose)) throw new Error('Invalid path permission.');
    this.prune();
    if (this.grants.size >= MAX_GRANTS) this.grants.delete(this.grants.keys().next().value);
    const capability = randomUUID();
    this.grants.set(capability, { target, purpose, expires: this.now() + GRANT_TTL_MS });
    return { path: target, capability, purpose };
  }

  consume(capability, value, purpose) {
    const target = this.verify(capability, value, purpose);
    this.grants.delete(String(capability || ''));
    return target;
  }

  /** Release an unused grant when the reviewed action is dismissed. */
  revoke(capability) {
    this.prune();
    return this.grants.delete(String(capability || ''));
  }

  verify(capability, value, purpose) {
    this.prune();
    const grant = this.grants.get(String(capability || ''));
    if (!grant || grant.purpose !== purpose || grant.target !== normalize(value)) throw new Error('Choose this file or folder again before using it.');
    return grant.target;
  }

  prune() {
    const now = this.now();
    for (const [id, grant] of this.grants) if (grant.expires <= now) this.grants.delete(id);
  }
}

function normalize(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 4096 || !path.isAbsolute(value)) throw new Error('Choose an absolute local path.');
  if (process.platform === 'win32' && /^(?:\\\\|\/\/)/.test(value)) throw new Error('Choose a file or folder on a local drive.');
  return path.resolve(value);
}
