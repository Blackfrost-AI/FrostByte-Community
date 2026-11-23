/**
 * Runtime managers — the uTorrent-grade behaviours, driven from settings.
 *
 *   RateManager     global up/down caps, alternative ("turtle") limits,
 *                   and a time-of-day schedule that flips them
 *   QueueManager    max active downloads; overflow is auto-paused as
 *                   "queued" and resumed FIFO as slots free up
 *   SeedGoalManager stop sharing at a ratio or seeding-time goal
 *   UpnpManager     map the listen port on the router so peers can reach us
 *   MoveOnComplete  relocate finished pulls to a "completed" folder
 *
 * Everything is plain logic over the engine + a settings object, so it can
 * be unit-tested without Electron.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ rates */

export class RateManager {
  constructor(engine, getSettings) {
    this.engine = engine;
    this.getSettings = getSettings;
  }

  get mode() {
    const s = this.getSettings();
    return s.bandwidthMode || (s.schedEnabled ? 'schedule' : 'normal');
  }

  /** True when alternative limits should be in force right now. */
  inAltMode(now = new Date()) {
    const s = this.getSettings();
    if (this.mode !== 'schedule') return this.mode === 'alt';
    if (!s.schedEnabled) return false;
    if (!this.schedDayActive(now, s)) return false;
    return this.inWindow(now, s.schedFrom, s.schedTo);
  }

  schedDayActive(now, s) {
    const days = Array.isArray(s.schedDays) && s.schedDays.length === 7 ? s.schedDays : [1, 1, 1, 1, 1, 1, 1];
    // An overnight window (22:00 → 06:00) belongs to the day it starts on,
    // which is how uTorrent users expect it to behave.
    let idx = now.getDay();
    const from = toMin(s.schedFrom);
    const to = toMin(s.schedTo);
    if (to < from && now.getHours() * 60 + now.getMinutes() < to) {
      idx = (idx + 6) % 7; // before dawn = tail of yesterday's window
    }
    return !!days[idx];
  }

  inWindow(now, fromS, toS) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const from = toMin(fromS);
    const to = toMin(toS);
    if (from === to) return true; // degenerate: always on
    return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to); // overnight wrap
  }

  /** Apply the current mode's caps to the engine. Returns what was applied. */
  apply() {
    const effective = this.snapshot();
    return { ...effective, ...this.engine.setLimits({ down: effective.down, up: effective.up }) };
  }

  snapshot() {
    const s = this.getSettings(), alt = this.inAltMode();
    return { mode: this.mode, alt, manualAlt: this.mode === 'schedule' ? null : alt,
      down: kbsDownToBytes(alt ? s.altDownKBs : s.downLimitKBs),
      up: kbsDownToBytes(alt ? s.altUpKBs : s.upLimitKBs) };
  }
}

function toMin(hhmm) {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2]));
}

/** KB/s setting → bytes/sec for the engine; 0/empty = unlimited (-1). */
function kbsDownToBytes(kbs) {
  const n = Number(kbs);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024) : -1;
}

/* ------------------------------------------------------------------ queue */

export class QueueManager {
  constructor(engine, getSettings) {
    this.engine = engine;
    this.getSettings = getSettings;
  }

  /** Enforce max-active-downloads. Called on a tick and after add/done/remove. */
  async enforce() {
    if (this._enforcing) return this._enforcing;
    this._enforcing = this._enforce();
    try { return await this._enforcing; } finally { this._enforcing = null; }
  }

  async _enforce() {
    const max = Number(this.getSettings().maxActiveDownloads);
    if (!(max > 0)) {
      // No limit configured: release anything the queue parked earlier.
      for (const h of [...this.engine.autoQueued]) await this.engine.resume(h);
      return { active: this.countActive(), queued: 0 };
    }

    const torrents = this.engine.list().filter((t) => !t.done && !t.explicitShare);
    const active = torrents.filter((t) => !t.paused);
    const queuedNow = torrents.filter((t) => t.queued);

    // Pause the newest-added overflow first (uTorrent queues the back of the line).
    if (active.length > max) {
      const overflow = active
        .slice()
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
        .slice(0, active.length - max);
      for (const t of overflow) await this.engine.pauseForQueue(t.infoHash);
    }

    // Resume queued torrents into free slots, oldest first.
    let slots = max - this.countActive();
    for (const t of queuedNow.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))) {
      if (slots <= 0) break;
      if (t.done) continue; // finished while queued; seed-goal logic owns it now
      await this.engine.resume(t.infoHash);
      slots--;
    }

    return { active: this.countActive(), queued: this.engine.autoQueued.length };
  }

  countActive() {
    return this.engine.list().filter((t) => !t.done && !t.paused && !t.explicitShare).length;
  }
}

/* ------------------------------------------------------------- seed goals */

export class SeedGoalManager {
  constructor(engine, getSettings, opts = {}) {
    this.engine = engine;
    this.getSettings = getSettings;
    // Library items are things the human explicitly put up for sharing;
    // seed goals only apply to things this box merely pulled.
    this.isLibraryHash = opts.isLibraryHash ?? (() => false);
    this.onStop = opts.onStop ?? (() => {});
  }

  /** Stop sharing pulled torrents that hit the ratio or time goal. */
  async enforce() {
    const s = this.getSettings();
    const ratioGoal = Number(s.seedRatioStop);
    const minutesGoal = Number(s.seedMinutesStop);
    if (!(ratioGoal > 0) && !(minutesGoal > 0)) return [];

    const stopped = [];
    for (const t of this.engine.list()) {
      if (!t.done || t.paused) continue;
      if (t.explicitShare || this.isLibraryHash(t.infoHash)) continue;
      const hitRatio = ratioGoal > 0 && t.ratio >= ratioGoal;
      const hitTime = minutesGoal > 0 && t.seededMs >= minutesGoal * 60_000;
      if (hitRatio || hitTime) {
        await this.engine.remove(t.infoHash, false); // keep the files
        this.engine.forget(t.infoHash);
        stopped.push(t.name);
        this.onStop(t, hitRatio ? 'ratio' : 'time');
      }
    }
    return stopped;
  }
}

/* -------------------------------------------------------------------- upnp */

export class UpnpManager {
  constructor(opts = {}) {
    this.NatAPI = opts.NatAPI; // injected so tests can pass a stub
    this.client = null;
    this.mappedPort = null;
    // `mappedProtocols` contains only mappings the router explicitly
    // confirmed. A request that throws may still have reached the router, so
    // retain it separately for cleanup without treating it as usable.
    this.mappedProtocols = new Set();
    this.uncertainProtocols = new Set();
    this.log = opts.log ?? (() => {});
  }

  async enable(port) {
    if (!this.NatAPI || !port) return false;
    this.wanted = true;
    if (this.pending) return this.pending;
    if (this.mappedPort === port && this.mappedProtocols.has('TCP')) return true;
    if (Date.now() < (this.retryAt || 0)) return false;
    this.pending = (async () => {
      if (this.client) await this.destroyClient();
      try {
        const c = this.client = new this.NatAPI({ upnpPermanentFallback: true });
        let tcpMapped;
        try { tcpMapped = await c.map({ publicPort: port, privatePort: port, protocol: 'TCP' }); }
        catch (error) {
          // A lost response can leave a real router rule. Retain it as an
          // uncertain mapping until an explicit unmap confirms cleanup.
          this.mappedPort = port;
          this.uncertainProtocols.add('TCP');
          throw error;
        }
        if (tcpMapped !== true) {
          throw new Error('The router did not create a TCP mapping.');
        }
        // A permanent-fallback TCP mapping is live at this point. Keep that
        // fact visible until an explicit unmap confirms its removal.
        this.mappedProtocols.add('TCP');
        this.mappedPort = port;
        let udpMapped;
        try { udpMapped = await c.map({ publicPort: port, privatePort: port, protocol: 'UDP' }); }
        catch (error) {
          this.uncertainProtocols.add('UDP');
          throw error;
        }
        if (udpMapped === true) this.mappedProtocols.add('UDP');
        else this.log(`Port ${port} has no UDP router mapping; TCP peer connections remain available.`, 'warn');
        if (!this.wanted) { await this.destroyClient(); return false; }
        this.log(`Port ${port} mapped on the router via UPnP/NAT-PMP.`);
        return true;
      } catch (err) {
        this.retryAt = Date.now() + 60_000;
        this.log(`UPnP mapping failed (${err?.message ?? err}). Peers may need manual port forwarding.`, 'warn');
        try { await this.destroyClient(); }
        catch (cleanupError) {
          throw new AggregateError([err, cleanupError], 'UPnP setup failed and the router mapping could not be confirmed removed.');
        }
        return false;
      }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async disable() {
    this.wanted = false;
    try { await this.pending; } catch { /* retry retained client below */ }
    if (this.client) await this.destroyClient();
  }

  status() {
    const port = this.mappedPort;
    const confirmedTcp = !!port && this.mappedProtocols.has('TCP');
    // A retained uncertain request, or a confirmed mapping whose disable has
    // not completed, is cleanup work. Keep it visible without calling it a
    // confirmed externally reachable TCP mapping.
    const cleanupPending = !!port && (this.uncertainProtocols.size > 0
      || (!this.wanted && this.mappedProtocols.size > 0));
    return {
      mappedPort: confirmedTcp ? port : null,
      cleanupPendingPort: cleanupPending ? port : null,
    };
  }

  async destroyClient() {
    const c = this.client;
    if (!c) {
      this.mappedPort = null;
      this.mappedProtocols.clear();
      this.uncertainProtocols.clear();
      return true;
    }
    const port = this.mappedPort;
    const possiblyMappedProtocols = new Set([...this.mappedProtocols, ...this.uncertainProtocols]);
    for (const protocol of possiblyMappedProtocols) {
      let removed;
      try { removed = await c.unmap({ publicPort: port, privatePort: port, protocol }); }
      catch (error) {
        this.log(`Could not remove the ${protocol} router mapping (${error?.message ?? error}). FrostByte will keep it visible and retry.`, 'error');
        throw error;
      }
      if (removed !== true) {
        const error = new Error(`The router did not confirm removal of the ${protocol} mapping.`);
        this.log(`${error.message} FrostByte will keep it visible and retry.`, 'error');
        throw error;
      }
      this.mappedProtocols.delete(protocol);
      this.uncertainProtocols.delete(protocol);
    }
    this.mappedPort = null;
    try { await c.destroy(); }
    catch (error) { this.log(`Router client cleanup failed after its mappings were removed (${error?.message ?? error}).`, 'warn'); }
    if (this.client === c) {
      this.client = null;
    }
    return true;
  }
}

/* --------------------------------------------------------- move on finish */

export function sameLocalPath(left, right, { platform = process.platform } = {}) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => {
    const resolved = paths.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function identityFromStat(stat) {
  const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : '';
  return type ? { type, dev: String(stat.dev), ino: String(stat.ino) } : null;
}

function manifestIdentity(entry) {
  if (!entry || !['file', 'directory'].includes(entry.type)) return null;
  return { type: entry.type, dev: String(entry.dev), ino: String(entry.ino) };
}

function safeManifestEntries(manifest, rootIdentity) {
  if (!(manifest instanceof Map)) return null;
  const root = manifest.get('');
  if (!sameCompletionIdentity(manifestIdentity(root), rootIdentity)) return null;
  const entries = [];
  for (const [relative, entry] of manifest) {
    if (!relative) continue;
    if (typeof relative !== 'string' || path.isAbsolute(relative)
      || path.normalize(relative) !== relative
      || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
    const identity = manifestIdentity(entry);
    if (!identity) return null;
    entries.push({ relative, identity });
  }
  return entries;
}

function restoreClaimSync(value, quarantine) {
  try {
    if (!fs.existsSync(value) && fs.existsSync(quarantine)) fs.renameSync(quarantine, value);
  } catch { /* preserve the claimed path at its unpredictable sibling name */ }
}

async function restoreClaim(value, quarantine) {
  try {
    if (!fs.existsSync(value) && fs.existsSync(quarantine)) await fs.promises.rename(quarantine, value);
  } catch { /* preserve the claimed path at its unpredictable sibling name */ }
}

function removeClaimedDirectorySync(value, quarantine, expected, manifest) {
  const entries = safeManifestEntries(manifest, expected);
  // A root inode says nothing about the identities now stored beneath it. If
  // no leaf manifest exists (notably after restart), only an empty reservation
  // can be removed automatically.
  if (entries) {
    const leaves = entries.filter(entry => entry.identity.type === 'file')
      .sort((left, right) => right.relative.length - left.relative.length);
    for (const entry of leaves) {
      const target = path.join(quarantine, entry.relative);
      try {
        if (sameCompletionIdentity(completionPathIdentity(target), entry.identity)) fs.unlinkSync(target);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const directories = entries.filter(entry => entry.identity.type === 'directory')
      .sort((left, right) => right.relative.split(path.sep).length - left.relative.split(path.sep).length
        || right.relative.length - left.relative.length);
    for (const entry of directories) {
      const target = path.join(quarantine, entry.relative);
      try {
        if (sameCompletionIdentity(completionPathIdentity(target), entry.identity)) fs.rmdirSync(target);
      } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
  }
  try { fs.rmdirSync(quarantine); return true; }
  catch (error) {
    restoreClaimSync(value, quarantine);
    if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
    throw error;
  }
}

async function removeClaimedDirectory(value, quarantine, expected, manifest) {
  const entries = safeManifestEntries(manifest, expected);
  if (entries) {
    const leaves = entries.filter(entry => entry.identity.type === 'file')
      .sort((left, right) => right.relative.length - left.relative.length);
    for (const entry of leaves) {
      const target = path.join(quarantine, entry.relative);
      try {
        if (sameCompletionIdentity(completionPathIdentity(target), entry.identity)) await fs.promises.unlink(target);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const directories = entries.filter(entry => entry.identity.type === 'directory')
      .sort((left, right) => right.relative.split(path.sep).length - left.relative.split(path.sep).length
        || right.relative.length - left.relative.length);
    for (const entry of directories) {
      const target = path.join(quarantine, entry.relative);
      try {
        if (sameCompletionIdentity(completionPathIdentity(target), entry.identity)) await fs.promises.rmdir(target);
      } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
  }
  try { await fs.promises.rmdir(quarantine); return true; }
  catch (error) {
    await restoreClaim(value, quarantine);
    if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
    throw error;
  }
}

export function completionPathIdentity(value) {
  return identityFromStat(fs.lstatSync(value, { bigint: true }));
}

export function sameCompletionIdentity(left, right) {
  return !!left && !!right && left.type === right.type && left.dev === right.dev && left.ino === right.ino;
}

/** A pathname alone is never proof that an interrupted publication completed. */
export function completionRecoveryDisposition(move, { sourceState, destinationState, recoveredPublishedFile = false }) {
  const exactDestination = move?.phase === 'published'
    && destinationState?.state === 'present'
    && sameCompletionIdentity(destinationState.identity, move.destinationIdentity);
  // When both independent paths still exist, inode identity alone cannot prove
  // that the destination's bytes/tree stayed unchanged after the crash. Keep
  // the original and require a later retry instead of deleting the last known
  // pre-publication path. A currently linked file is the sole deletion proof.
  const recoverSource = !recoveredPublishedFile && sourceState?.state === 'present'
    && (!move?.sourceIdentity || sameCompletionIdentity(sourceState.identity, move.sourceIdentity));
  const published = recoveredPublishedFile || (!recoverSource && exactDestination);
  return { published, recoverSource, recoveryRequired: !published && !recoverSource };
}

function openOwnedPathSync(value, expected) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(value, fs.constants.O_RDONLY | noFollow);
  try {
    if (!sameCompletionIdentity(identityFromStat(fs.fstatSync(descriptor, { bigint: true })), expected)) {
      fs.closeSync(descriptor);
      return null;
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

async function openOwnedPath(value, expected) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const handle = await fs.promises.open(value, fs.constants.O_RDONLY | noFollow);
  try {
    if (!sameCompletionIdentity(identityFromStat(await handle.stat({ bigint: true })), expected)) {
      await handle.close();
      return null;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Claim an exact inode at an unpredictable sibling name before removal. Files
 * can then be unlinked directly. Directories are emptied only through a
 * caller-supplied per-entry identity manifest; without one, only an already
 * empty reservation is removed.
 */
export function removeOwnedCompletionPathSync(value, expected, manifest = null, { beforeRemove = () => {} } = {}) {
  if (!sameCompletionIdentity(completionPathIdentity(value), expected)) return false;
  // Windows does not consistently allow an open directory handle to be
  // renamed. Its identity is checked before and after the claim instead.
  const handle = process.platform === 'win32' ? undefined : openOwnedPathSync(value, expected);
  if (handle === null) return false;
  const quarantine = path.join(path.dirname(value), `.frostbyte-cleanup-${randomUUID()}`);
  let claimed = false;
  try {
    fs.renameSync(value, quarantine);
    claimed = sameCompletionIdentity(completionPathIdentity(quarantine), expected)
      && (handle === undefined || sameCompletionIdentity(identityFromStat(fs.fstatSync(handle, { bigint: true })), expected));
    if (!claimed) {
      try { if (!fs.existsSync(value)) fs.renameSync(quarantine, value); } catch { /* preserve the unrecognized path */ }
      return false;
    }
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  if (!claimed) return false;
  try {
    beforeRemove();
    if (expected.type === 'directory') return removeClaimedDirectorySync(value, quarantine, expected, manifest);
    fs.unlinkSync(quarantine);
  }
  catch (error) {
    restoreClaimSync(value, quarantine);
    throw error;
  }
  return true;
}

export async function removeOwnedCompletionPath(value, expected, manifest = null, { beforeRemove = () => {} } = {}) {
  if (!sameCompletionIdentity(completionPathIdentity(value), expected)) return false;
  const handle = process.platform === 'win32' ? undefined : await openOwnedPath(value, expected);
  if (handle === null) return false;
  const quarantine = path.join(path.dirname(value), `.frostbyte-cleanup-${randomUUID()}`);
  let claimed = false;
  try {
    await fs.promises.rename(value, quarantine);
    claimed = sameCompletionIdentity(completionPathIdentity(quarantine), expected)
      && (handle === undefined || sameCompletionIdentity(identityFromStat(await handle.stat({ bigint: true })), expected));
    if (!claimed) {
      try { if (!fs.existsSync(value)) await fs.promises.rename(quarantine, value); } catch { /* preserve the unrecognized path */ }
      return false;
    }
  } finally {
    if (handle !== undefined) await handle.close();
  }
  if (!claimed) return false;
  try {
    // The caller can bind cleanup to another exact filesystem object after
    // this source has been claimed at an unpredictable sibling path. If that
    // guard fails, restore the claim instead of deleting the last known copy.
    beforeRemove();
    if (expected.type === 'directory') return await removeClaimedDirectory(value, quarantine, expected, manifest);
    await fs.promises.unlink(quarantine);
  }
  catch (error) {
    await restoreClaim(value, quarantine);
    throw error;
  }
  return true;
}

function beneath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function verifiedExistingPath(value, { directory = false, label = 'path' } = {}) {
  const logical = path.resolve(value);
  const first = fs.lstatSync(logical);
  if (first.isSymbolicLink() || directory && !first.isDirectory()
    || !directory && !first.isFile() && !first.isDirectory()) {
    throw new Error(`The ${label} is linked or unavailable.`);
  }
  const resolved = path.resolve(fs.realpathSync(logical));
  const current = fs.lstatSync(resolved);
  const expected = identityFromStat(first);
  if (current.isSymbolicLink() || directory && !current.isDirectory()
    || !directory && !current.isFile() && !current.isDirectory()
    || !sameCompletionIdentity(identityFromStat(current), expected)
    || !sameLocalPath(fs.realpathSync(resolved), resolved)) {
    throw new Error(`The ${label} changed while it was being reviewed.`);
  }
  // A stable alias in an ancestor (for example macOS /var -> /private/var)
  // is safe once all subsequent work uses the canonical path. Recheck the
  // alias before returning so a mutable ancestor cannot redirect the review.
  const rebound = fs.lstatSync(logical);
  if (rebound.isSymbolicLink()
    || !sameCompletionIdentity(identityFromStat(rebound), expected)
    || !sameLocalPath(fs.realpathSync(logical), resolved)) {
    throw new Error(`The ${label} changed while it was being reviewed.`);
  }
  return { resolved, stat: current, identity: expected };
}

function verifiedDirectoryAncestor(value, { allowAlias = false } = {}) {
  const logical = path.resolve(value);
  const first = fs.lstatSync(logical);
  if (!first.isSymbolicLink()) return verifiedExistingPath(logical, { directory: true, label: 'completed folder' });
  if (!allowAlias) throw new Error('The selected completed folder is linked.');
  const resolved = path.resolve(fs.realpathSync(logical));
  const target = fs.lstatSync(resolved);
  const aliasIdentity = { dev: String(first.dev), ino: String(first.ino) };
  if (!target.isDirectory() || target.isSymbolicLink() || !sameLocalPath(fs.realpathSync(resolved), resolved)) {
    throw new Error('The completed folder alias is unavailable.');
  }
  const rebound = fs.lstatSync(logical);
  if (!rebound.isSymbolicLink() || String(rebound.dev) !== aliasIdentity.dev || String(rebound.ino) !== aliasIdentity.ino
    || !sameLocalPath(fs.realpathSync(logical), resolved)) {
    throw new Error('The completed folder alias changed while it was being reviewed.');
  }
  return { resolved, stat: target, identity: identityFromStat(target), aliasIdentity };
}

function verifiedDirectory(value, { forbiddenRoot = '' } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('Choose a local completed folder.');
  if (process.platform === 'win32' && /^(?:\\\\|\/\/|\\[?.]\\)/.test(value)) throw new Error('Choose a completed folder on a local drive.');
  const logical = path.resolve(value);
  let existing = logical;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('The completed folder is unavailable.');
    existing = parent;
  }
  let ancestor;
  try { ancestor = verifiedDirectoryAncestor(existing, { allowAlias: existing !== logical }); }
  catch { throw new Error('The completed folder is linked or unavailable. Choose it again.'); }
  const suffix = path.relative(existing, logical);
  const resolved = path.resolve(ancestor.resolved, suffix);
  if (!beneath(ancestor.resolved, resolved)) throw new Error('The completed folder is unavailable.');
  if (forbiddenRoot && beneath(forbiddenRoot, resolved)) {
    throw new Error('The completed folder cannot be inside the downloaded item.');
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  let destination, rebound;
  try {
    destination = verifiedExistingPath(resolved, { directory: true, label: 'completed folder' });
    rebound = verifiedExistingPath(logical, { directory: true, label: 'completed folder' });
  } catch { throw new Error('The completed folder is linked or unavailable. Choose it again.'); }
  let ancestorRebound;
  try { ancestorRebound = verifiedDirectoryAncestor(existing, { allowAlias: existing !== logical }); }
  catch { throw new Error('The completed folder changed while it was being reviewed.'); }
  if (!sameLocalPath(destination.resolved, resolved)
    || !sameLocalPath(rebound.resolved, resolved)
    || !sameCompletionIdentity(destination.identity, rebound.identity)
    || !sameCompletionIdentity(ancestor.identity, ancestorRebound.identity)
    || (ancestor.aliasIdentity && (ancestor.aliasIdentity.dev !== ancestorRebound.aliasIdentity?.dev
      || ancestor.aliasIdentity.ino !== ancestorRebound.aliasIdentity?.ino))) {
    throw new Error('The completed folder changed while it was being reviewed.');
  }
  return destination;
}

/** Canonical, inode-bound paths for a completion journal. Stable ancestor
 * aliases are accepted, while a selected/source leaf symlink is rejected. */
export function prepareCompletionMove(torrentPath, destDir) {
  const source = verifiedExistingPath(torrentPath, { label: 'completed download path' });
  const destination = verifiedDirectory(destDir, { forbiddenRoot: source.resolved });
  return {
    source: source.resolved,
    sourceIdentity: source.identity,
    destinationRoot: destination.resolved,
    destinationIdentity: destination.identity,
  };
}

function verifyTree(root, { maxEntries = 10000, allowHardlinks = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const pending = [resolvedRoot];
  const manifest = new Map();
  let entries = 0;
  while (pending.length) {
    const current = pending.pop();
    if (++entries > maxEntries) throw new Error('The completed item contains too many filesystem entries to move safely.');
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Linked files cannot be moved as a completed download.');
    if (!beneath(resolvedRoot, fs.realpathSync(current))) throw new Error('A completed file points outside its download folder.');
    const relative = path.relative(resolvedRoot, current);
    if (stat.isDirectory()) {
      manifest.set(relative, { type: 'directory', dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    } else if (stat.isFile()) {
      if (!allowHardlinks && stat.nlink > 1) throw new Error('Hardlinked files cannot be moved as a completed download.');
      manifest.set(relative, { type: 'file', size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    } else throw new Error('A completed download contains an unsupported filesystem object.');
  }
  return manifest;
}

function assertSourceUnchanged(before, after, { publicationLinks = false } = {}) {
  if (before.size !== after.size) throw new Error('The completed download changed while it was being copied.');
  for (const [relative, first] of before) {
    const second = after.get(relative);
    if (!second || first.type !== second.type || first.size !== second.size || first.dev !== second.dev || first.ino !== second.ino || first.mtimeMs !== second.mtimeMs
      || (!publicationLinks || first.type !== 'file') && first.ctimeMs !== second.ctimeMs) {
      throw new Error('The completed download changed while it was being copied.');
    }
  }
}

function publicationSourceAvailable(before, after) {
  if (before.size !== after.size) return false;
  for (const [relative, first] of before) {
    const second = after.get(relative);
    if (!second || first.type !== second.type || first.dev !== second.dev || first.ino !== second.ino
      || first.type === 'file' && first.size !== second.size) return false;
  }
  return true;
}

function assertCopyMatches(source, copy) {
  if (source.size !== copy.size) throw new Error('The completed copy does not match the downloaded files.');
  for (const [relative, original] of source) {
    const copied = copy.get(relative);
    if (!copied || original.type !== copied.type || original.size !== copied.size) throw new Error('The completed copy does not match the downloaded files.');
  }
}

function assertPublishedLinks(source, published) {
  assertCopyMatches(source, published);
  for (const [relative, original] of source) {
    if (original.type !== 'file') continue;
    const linked = published.get(relative);
    if (!linked || original.dev !== linked.dev || original.ino !== linked.ino) {
      throw new Error('The published completed files are not the verified download.');
    }
  }
}

// On filesystems without hardlinks (exFAT/FAT32, many network mounts) publication
// is an independent copy, not a shared inode. Content + shape equality is the
// proof there; byte equality is verified separately through O_NOFOLLOW descriptors.
function assertPublishedCopy(source, published) {
  assertCopyMatches(source, published);
}

// link() fails with EXDEV across volumes (the destination filesystem still
// supports hardlinks, so publication goes through the byte-verified staging
// path) and with EPERM/ENOTSUP/ENOSYS/EOPNOTSUPP on filesystems that do not
// support hardlinks at all (exFAT/FAT32, many network mounts) — those publish by
// an independent, byte-verified copy.
const NO_HARDLINK_CODES = ['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP'];
function isNoHardlinkError(err) {
  return NO_HARDLINK_CODES.includes(err?.code);
}
function isCopyPublicationError(err) {
  return err?.code === 'EXDEV' || isNoHardlinkError(err);
}

function assertPublishedSourceFilesUnchanged(before, after) {
  for (const [relative, first] of before) {
    const second = after.get(relative);
    if (!second || first.type !== second.type || first.dev !== second.dev || first.ino !== second.ino
      || first.type === 'file' && (first.size !== second.size || first.mtimeMs !== second.mtimeMs || first.ctimeMs !== second.ctimeMs)) {
      throw new Error('The completed download changed after it was published.');
    }
  }
}

function assertDescriptorSnapshot(stat, expected) {
  const identity = identityFromStat(stat);
  if (!sameCompletionIdentity(identity, manifestIdentity(expected))
    || expected.type !== 'file' || stat.size !== expected.size
    || stat.mtimeMs !== expected.mtimeMs || stat.ctimeMs !== expected.ctimeMs) {
    throw new Error('The completed copy changed while its contents were being verified.');
  }
}

async function closeComparedHandles(handles, error = null) {
  const failures = error ? [error] : [];
  for (const handle of handles) {
    try { await handle?.close(); } catch (closeError) { failures.push(closeError); }
  }
  if (failures.length > 1) throw new AggregateError(failures, 'Completed-file verification could not close every descriptor.');
  if (failures.length) throw failures[0];
}

/** Compare independent copies through O_NOFOLLOW descriptors, not path reads. */
async function compareTreeContents(sourceRoot, copyRoot, source, copy) {
  assertCopyMatches(source, copy);
  const digests = new Map();
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const blockBytes = 1024 * 1024;
  for (const [relative, expectedSource] of source) {
    if (expectedSource.type !== 'file') continue;
    const expectedCopy = copy.get(relative);
    let sourceHandle = null, copyHandle = null, failure = null;
    try {
      sourceHandle = await fs.promises.open(path.join(sourceRoot, relative), flags);
      copyHandle = await fs.promises.open(path.join(copyRoot, relative), flags);
      assertDescriptorSnapshot(await sourceHandle.stat(), expectedSource);
      assertDescriptorSnapshot(await copyHandle.stat(), expectedCopy);
      const digest = createHash('sha256');
      for (let offset = 0; offset < expectedSource.size;) {
        const length = Math.min(blockBytes, expectedSource.size - offset);
        const left = Buffer.allocUnsafe(length), right = Buffer.allocUnsafe(length);
        const [leftRead, rightRead] = await Promise.all([
          sourceHandle.read(left, 0, length, offset),
          copyHandle.read(right, 0, length, offset),
        ]);
        if (leftRead.bytesRead !== length || rightRead.bytesRead !== length || !left.equals(right)) {
          throw new Error('The completed copy contents do not match the downloaded files.');
        }
        digest.update(left);
        offset += length;
      }
      assertDescriptorSnapshot(await sourceHandle.stat(), expectedSource);
      assertDescriptorSnapshot(await copyHandle.stat(), expectedCopy);
      digests.set(relative, digest.digest('hex'));
    } catch (error) { failure = error; }
    await closeComparedHandles([sourceHandle, copyHandle], failure);
  }
  return digests;
}

async function verifyTreeDigests(root, snapshot, digests) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  for (const [relative, expectedDigest] of digests) {
    const expected = snapshot.get(relative);
    let handle = null, failure = null;
    try {
      handle = await fs.promises.open(path.join(root, relative), flags);
      assertDescriptorSnapshot(await handle.stat(), expected);
      const digest = createHash('sha256');
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) digest.update(chunk);
      assertDescriptorSnapshot(await handle.stat(), expected);
      if (digest.digest('hex') !== expectedDigest) {
        throw new Error('The published completed files do not match the verified copy.');
      }
    } catch (error) { failure = error; }
    await closeComparedHandles([handle], failure);
  }
}

async function syncPublishedPath(value, expected) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle = null;
  let failure = null;
  try {
    handle = await fs.promises.open(value, flags);
    const before = await handle.stat();
    if (!sameCompletionIdentity(identityFromStat(before), manifestIdentity(expected))
      || expected.type === 'file' && before.size !== expected.size) {
      throw new Error('The completed publication changed before it became durable.');
    }
    await handle.sync();
    const after = await handle.stat();
    if (!sameCompletionIdentity(identityFromStat(after), manifestIdentity(expected))
      || expected.type === 'file' && after.size !== expected.size) {
      throw new Error('The completed publication changed while it became durable.');
    }
  } catch (error) { failure = error; }
  await closeComparedHandles([handle], failure);
}

async function syncPublishedTree(destination, snapshot) {
  // Flush file contents/inodes first, directory entries from leaves to root,
  // and finally the completed folder that owns the newly published name. The
  // durable journal is written only after this ordering succeeds.
  for (const [relative, entry] of snapshot) {
    if (entry.type === 'file') await syncPublishedPath(path.join(destination, relative), entry);
  }
  // libuv/Node does not expose CreateFileW(FILE_FLAG_BACKUP_SEMANTICS), so a
  // directory cannot be portably opened and flushed on Windows. File data is
  // still flushed there and the complete tree is identity-revalidated below.
  if (process.platform === 'win32') return;
  const directories = [...snapshot.entries()].filter(([, entry]) => entry.type === 'directory')
    .sort(([left], [right]) => right.split(path.sep).length - left.split(path.sep).length
      || right.length - left.length);
  for (const [relative, entry] of directories) await syncPublishedPath(path.join(destination, relative), entry);
  const parent = path.dirname(destination);
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error('The completed folder changed before publication became durable.');
  }
  await syncPublishedPath(parent, manifestEntryFromStat(parentStat));
}

function assertDirectoryIdentity(directory, expected) {
  const current = fs.lstatSync(directory);
  if (current.isSymbolicLink() || !current.isDirectory()
    || !sameCompletionIdentity(identityFromStat(current), expected)
    || !sameLocalPath(fs.realpathSync(directory), directory)) {
    throw new Error('The completed folder changed while the download was moving.');
  }
}

function assertMissing(value, message = 'A file appeared at the completed destination while the download was moving.') {
  try { fs.lstatSync(value); throw new Error(message); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function manifestEntryFromStat(stat) {
  const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : '';
  if (!type) throw new Error('The completion staging path contains an unsupported filesystem object.');
  return {
    type, dev: stat.dev, ino: stat.ino,
    ...(type === 'file' ? { size: stat.size } : {}),
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  };
}

async function reserveStaging(temporary, rootType) {
  assertMissing(temporary, 'The completion staging path already exists.');
  let handle = null;
  let identity = null;
  try {
    if (rootType === 'file') {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0);
      handle = await fs.promises.open(temporary, flags, 0o600);
      const stat = await handle.stat();
      identity = identityFromStat(stat);
      return { handle, identity, rootEntry: manifestEntryFromStat(stat) };
    }
    await fs.promises.mkdir(temporary, { recursive: false, mode: 0o700 });
    const stat = fs.lstatSync(temporary);
    identity = identityFromStat(stat);
    // Holding the directory descriptor pins the reserved inode across every
    // awaited copy step on POSIX. Windows rechecks the exact path identity.
    if (process.platform !== 'win32') handle = await openOwnedPath(temporary, identity);
    if (process.platform !== 'win32' && !handle) throw new Error('The completion staging path changed after it was reserved.');
    return { handle, identity, rootEntry: manifestEntryFromStat(stat) };
  } catch (error) {
    try { await handle?.close(); } catch (closeError) { error.closeError = closeError; }
    let current = null;
    try { current = completionPathIdentity(temporary); } catch { /* nothing owned remains at the path */ }
    if (identity && sameCompletionIdentity(current, identity)) {
      try {
        if (rootType === 'directory') await fs.promises.rmdir(temporary);
        else await fs.promises.unlink(temporary);
      } catch (cleanupError) { error.cleanupError ||= cleanupError; }
    }
    throw error;
  }
}

async function assertStagingReservation(temporary, reservation) {
  let pathnameIdentity = null;
  try { pathnameIdentity = completionPathIdentity(temporary); } catch { /* handled below */ }
  if (!sameCompletionIdentity(pathnameIdentity, reservation.identity)) {
    throw new Error('The completion staging path changed while files were copying.');
  }
  if (reservation.handle) {
    const descriptorIdentity = identityFromStat(await reservation.handle.stat());
    if (!sameCompletionIdentity(descriptorIdentity, reservation.identity)) {
      throw new Error('The completion staging path changed while files were copying.');
    }
  }
}

function assertOwnedStagingDirectory(temporary, relative, manifest) {
  const expected = manifestIdentity(manifest.get(relative));
  let current = null;
  try { current = completionPathIdentity(path.join(temporary, relative)); } catch { /* handled below */ }
  if (!expected || expected.type !== 'directory' || !sameCompletionIdentity(current, expected)) {
    throw new Error('The completion staging directory changed while files were copying.');
  }
}

function parentRelative(relative) {
  const parent = path.dirname(relative);
  return parent === '.' ? '' : parent;
}

function assertEmptyOwnedDestination(stat, identity, expectedSize = 0) {
  if (!stat.isFile() || !sameCompletionIdentity(identityFromStat(stat), identity)
    || stat.nlink !== 1 || stat.size !== expectedSize) {
    throw new Error('The completion staging file changed while files were copying.');
  }
}

async function copyReviewedFile(source, destinationHandle, sourceEntry, destinationIdentity) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let sourceHandle = null;
  let failure = null;
  try {
    sourceHandle = await fs.promises.open(source, flags);
    assertDescriptorSnapshot(await sourceHandle.stat(), sourceEntry);
    assertEmptyOwnedDestination(await destinationHandle.stat(), destinationIdentity);
    const blockBytes = 1024 * 1024;
    for (let offset = 0; offset < sourceEntry.size;) {
      assertDescriptorSnapshot(await sourceHandle.stat(), sourceEntry);
      assertEmptyOwnedDestination(await destinationHandle.stat(), destinationIdentity, offset);
      const length = Math.min(blockBytes, sourceEntry.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const read = await sourceHandle.read(buffer, 0, length, offset);
      if (read.bytesRead !== length) throw new Error('The completed download changed while it was being copied.');
      let written = 0;
      while (written < length) {
        const result = await destinationHandle.write(buffer, written, length - written, offset + written);
        if (!result.bytesWritten) throw new Error('The completion staging file could not be written completely.');
        written += result.bytesWritten;
      }
      offset += length;
    }
    await destinationHandle.sync();
    assertDescriptorSnapshot(await sourceHandle.stat(), sourceEntry);
    assertEmptyOwnedDestination(await destinationHandle.stat(), destinationIdentity, sourceEntry.size);
  } catch (error) { failure = error; }
  await closeComparedHandles([sourceHandle], failure);
}

async function copyIntoStaging(source, temporary, rootType, reservation, sourceSnapshot, stagingManifest) {
  await assertStagingReservation(temporary, reservation);
  if (rootType === 'file') {
    await copyReviewedFile(source, reservation.handle, sourceSnapshot.get(''), reservation.identity);
    await assertStagingReservation(temporary, reservation);
    stagingManifest.set('', manifestEntryFromStat(await reservation.handle.stat()));
    return;
  }

  const entries = [...sourceSnapshot.entries()].filter(([relative]) => relative);
  const directories = entries.filter(([, item]) => item.type === 'directory')
    .sort(([left], [right]) => left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
  for (const [relative] of directories) {
    await assertStagingReservation(temporary, reservation);
    assertOwnedStagingDirectory(temporary, parentRelative(relative), stagingManifest);
    const target = path.join(temporary, relative);
    await fs.promises.mkdir(target, { recursive: false, mode: 0o700 });
    stagingManifest.set(relative, manifestEntryFromStat(fs.lstatSync(target)));
    await assertStagingReservation(temporary, reservation);
    assertOwnedStagingDirectory(temporary, relative, stagingManifest);
  }
  for (const [relative, item] of entries) {
    if (item.type !== 'file') continue;
    await assertStagingReservation(temporary, reservation);
    const parent = parentRelative(relative);
    assertOwnedStagingDirectory(temporary, parent, stagingManifest);
    const target = path.join(temporary, relative);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0);
    let destinationHandle = null;
    let failure = null;
    try {
      destinationHandle = await fs.promises.open(target, flags, 0o600);
      const stat = await destinationHandle.stat();
      const destinationIdentity = identityFromStat(stat);
      stagingManifest.set(relative, manifestEntryFromStat(stat));
      await assertStagingReservation(temporary, reservation);
      assertOwnedStagingDirectory(temporary, parent, stagingManifest);
      await copyReviewedFile(path.join(source, relative), destinationHandle, item, destinationIdentity);
      stagingManifest.set(relative, manifestEntryFromStat(await destinationHandle.stat()));
      await assertStagingReservation(temporary, reservation);
      assertOwnedStagingDirectory(temporary, parent, stagingManifest);
    } catch (error) { failure = error; }
    await closeComparedHandles([destinationHandle], failure);
  }
}

// Populate a reserved destination directory with hardlinks, falling back to an
// independent byte-verified copy on filesystems without hardlink support. Returns
// true when any file had to be copied (the whole tree then publishes by copy).
// Entries already present in ownedManifest (e.g. a probe link) are skipped.
async function populateReservedDirectory(source, destination, snapshot, onCreated, ownedManifest) {
  const entries = [...snapshot.entries()].filter(([relative]) => relative);
  const directories = entries.filter(([, item]) => item.type === 'directory')
    .sort(([left], [right]) => left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
  for (const [relative] of directories) {
    if (ownedManifest?.has(relative)) continue;
    const target = path.join(destination, relative);
    await fs.promises.mkdir(target, { recursive: false, mode: 0o700 });
    onCreated(relative, fs.lstatSync(target));
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  let copyMode = false;
  for (const [relative, item] of entries) {
    if (item.type !== 'file' || ownedManifest?.has(relative)) continue;
    const target = path.join(destination, relative);
    if (!copyMode) {
      try {
        await fs.promises.link(path.join(source, relative), target);
        onCreated(relative, fs.lstatSync(target));
        continue;
      } catch (err) {
        if (!isNoHardlinkError(err)) throw err;
        copyMode = true;
      }
    }
    let handle = null;
    let failure = null;
    try {
      handle = await fs.promises.open(target, flags, 0o600);
      const identity = identityFromStat(await handle.stat());
      await copyReviewedFile(path.join(source, relative), handle, item, identity);
      onCreated(relative, fs.lstatSync(target));
    } catch (error) { failure = error; }
    await closeComparedHandles([handle], failure);
  }
  return copyMode;
}

async function publishNoClobber(source, destination, snapshot, {
  beforePublish, onDestinationCreated, afterPublish, onDestinationRemoved,
  assertDestinationRoot = () => {}, verifyPublished = () => {}, rollbackSourceAvailable = () => false,
  staging, stagingIdentity,
}) {
  const rootType = snapshot.get('')?.type;
  let destinationIdentity = null;
  let ownedManifest = null;
  // Publication is a hardlink when the filesystem supports it, otherwise an
  // independent byte-verified copy (exFAT/FAT32, many network mounts). The mode
  // is decided by the first link() result and applies to the whole tree.
  let copyMode = false;
  let copyDigests = null;
  const assertPublished = (before, after) => (copyMode ? assertPublishedCopy(before, after) : assertPublishedLinks(before, after));
  const verifyPublishedBytes = async (publishedSnapshot) => {
    if (!copyMode) return;
    if (!copyDigests) copyDigests = await compareTreeContents(source, destination, snapshot, publishedSnapshot);
    else await verifyTreeDigests(destination, publishedSnapshot, copyDigests);
  };
  await beforePublish({ staging, stagingIdentity, destination });
  try {
    assertDestinationRoot();
    assertMissing(destination);
    if (rootType === 'file') {
      try {
        await fs.promises.link(source, destination);
        destinationIdentity = completionPathIdentity(destination);
      } catch (err) {
        if (!isNoHardlinkError(err)) throw err;
        copyMode = true;
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
        const handle = await fs.promises.open(destination, flags, 0o600);
        try {
          destinationIdentity = identityFromStat(await handle.stat());
          await copyReviewedFile(source, handle, snapshot.get(''), destinationIdentity);
        } finally { await handle.close(); }
      }
    } else {
      await fs.promises.mkdir(destination, { recursive: false, mode: 0o700 });
      destinationIdentity = completionPathIdentity(destination);
    }
    const destinationRootStat = fs.lstatSync(destination);
    ownedManifest = new Map([['', {
      type: rootType, dev: destinationRootStat.dev, ino: destinationRootStat.ino,
      ...(rootType === 'file' ? { size: destinationRootStat.size } : {}),
      mtimeMs: destinationRootStat.mtimeMs, ctimeMs: destinationRootStat.ctimeMs,
    }]]);
    await onDestinationCreated({ staging, stagingIdentity, destination, destinationIdentity });
    assertDestinationRoot();
    if (!sameCompletionIdentity(completionPathIdentity(destination), destinationIdentity)) {
      throw new Error('The completed destination changed after it was reserved.');
    }
    if (rootType === 'directory') {
      const onCreated = (relative, stat) => {
        const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : '';
        if (!type) throw new Error('The completed destination contains an unsupported filesystem object.');
        ownedManifest.set(relative, { type, dev: stat.dev, ino: stat.ino,
          ...(type === 'file' ? { size: stat.size } : {}), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      };
      // populateReservedDirectory hardlinks each file and switches the whole tree
      // to an independent byte-verified copy if the filesystem rejects hardlinks.
      if (await populateReservedDirectory(source, destination, snapshot, onCreated, ownedManifest)) copyMode = true;
    }
    const sourceAfterPublish = verifyTree(source, { allowHardlinks: true });
    assertSourceUnchanged(snapshot, sourceAfterPublish, { publicationLinks: !copyMode });
    const publishedSnapshot = verifyTree(destination, { allowHardlinks: true });
    assertPublished(snapshot, publishedSnapshot);
    await verifyPublishedBytes(publishedSnapshot);
    if (!sameCompletionIdentity(completionPathIdentity(destination), destinationIdentity)) {
      throw new Error('The completed destination changed while files were publishing.');
    }
    await verifyPublished({ destination, destinationIdentity, publishedSnapshot, sourceAfterPublish });
    await syncPublishedTree(destination, publishedSnapshot);
    assertDestinationRoot();
    if (!sameCompletionIdentity(completionPathIdentity(destination), destinationIdentity)) {
      throw new Error('The completed destination changed before it became durable.');
    }
    const durablePublishedSnapshot = verifyTree(destination, { allowHardlinks: true });
    assertPublished(sourceAfterPublish, durablePublishedSnapshot);
    await verifyPublishedBytes(durablePublishedSnapshot);
    await afterPublish({ staging, stagingIdentity, destination, destinationIdentity });
    // A durable-journal callback can wait on disk I/O. Revalidate the pinned
    // root, exact publication inode, tree shape, and (for copied data) bytes
    // after it returns, before the original is eligible for deletion.
    assertDestinationRoot();
    if (!sameCompletionIdentity(completionPathIdentity(destination), destinationIdentity)) {
      throw new Error('The completed destination changed after it was recorded.');
    }
    const finalSourceSnapshot = verifyTree(source, { allowHardlinks: true });
    assertPublishedSourceFilesUnchanged(sourceAfterPublish, finalSourceSnapshot);
    const finalPublishedSnapshot = verifyTree(destination, { allowHardlinks: true });
    assertPublished(sourceAfterPublish, finalPublishedSnapshot);
    await verifyPublishedBytes(finalPublishedSnapshot);
    await verifyPublished({ destination, destinationIdentity, publishedSnapshot: finalPublishedSnapshot,
      sourceAfterPublish });
    return { destinationIdentity, sourceAfterPublish, publishedSnapshot: finalPublishedSnapshot, copyMode };
  } catch (error) {
    if (destinationIdentity) {
      // The destination may now be the last link to downloaded bytes. Roll it
      // back only while the complete publication source still exists at every
      // reviewed inode; otherwise preserve the destination for recovery.
      const sourceRemainsAvailable = () => {
        try {
          const currentSource = verifyTree(source, { allowHardlinks: true });
          if (publicationSourceAvailable(snapshot, currentSource)) return true;
        } catch { /* try the independent rollback source */ }
        try { return rollbackSourceAvailable() === true; }
        catch { return false; }
      };
      const sourceRemainsExact = sourceRemainsAvailable();
      if (!sourceRemainsExact) error.completionRecoveryRequired = true;
      else {
        try {
          const removed = removeOwnedCompletionPathSync(destination, destinationIdentity, ownedManifest, {
            beforeRemove: () => {
              if (!sourceRemainsAvailable()) {
                throw new Error('The publication source changed before destination rollback.');
              }
            },
          });
          if (removed) await onDestinationRemoved({ destination, destinationIdentity });
          else error.completionRecoveryRequired = true;
        } catch (cleanupError) {
          error.completionRecoveryRequired = true;
          error.cleanupError = cleanupError;
        }
      }
    }
    throw error;
  }
}

export async function moveCompleted(torrentPath, destDir, {
  stagingPath,
  expectedSourceIdentity,
  expectedDestinationIdentity,
  afterStage = () => {},
  beforePublish = () => {},
  onDestinationCreated = () => {},
  afterPublish = () => {},
  onDestinationRemoved = () => {},
} = {}) {
  if (!torrentPath || !destDir) return { moved: false, reason: 'nothing to move' };
  let prepared;
  try { prepared = prepareCompletionMove(torrentPath, destDir); }
  catch (error) { if (error.code === 'ENOENT') return { moved: false, reason: 'source missing' }; throw error; }
  const src = prepared.source;
  if (expectedSourceIdentity && !sameCompletionIdentity(prepared.sourceIdentity, expectedSourceIdentity)) {
    throw new Error('The completed download changed before it could be moved.');
  }
  if (expectedDestinationIdentity && !sameCompletionIdentity(prepared.destinationIdentity, expectedDestinationIdentity)) {
    throw new Error('The completed folder changed before the download could be moved.');
  }
  const sourceSnapshot = verifyTree(src);
  const sourceIdentity = prepared.sourceIdentity;
  if (!sameCompletionIdentity(manifestIdentity(sourceSnapshot.get('')), sourceIdentity)
    || !sameCompletionIdentity(completionPathIdentity(src), sourceIdentity)) {
    throw new Error('The completed download changed while it was being reviewed.');
  }
  const rootType = sourceSnapshot.get('')?.type;
  const destinationRoot = prepared.destinationRoot;
  if (sameLocalPath(path.dirname(src), destinationRoot)) {
    return { moved: false, reason: 'already in completed folder', dest: src };
  }
  const dest = path.join(destinationRoot, path.basename(src));
  const relative = path.relative(path.resolve(src), destinationRoot);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) return { moved: false, reason: 'destination is inside source' };
  try { fs.lstatSync(dest); return { moved: false, reason: 'already exists at destination', dest }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const publicationGuard = destinationIdentity => {
    try {
      assertDirectoryIdentity(destinationRoot, prepared.destinationIdentity);
      if (!sameCompletionIdentity(completionPathIdentity(dest), destinationIdentity)) {
        throw new Error('The completed destination changed before source cleanup.');
      }
    } catch (error) {
      error.completionRecoveryRequired = true;
      throw error;
    }
  };
  const cleanupPublishedSource = (value, identity, manifest, destinationIdentity, verifyDestination = () => {}) => {
    try {
      return removeOwnedCompletionPathSync(value, identity, manifest, {
        beforeRemove: () => {
          publicationGuard(destinationIdentity);
          try { verifyDestination(); }
          catch (error) {
            error.completionRecoveryRequired = true;
            throw error;
          }
        },
      })
        ? '' : 'The original path changed before it could be cleaned up.';
    } catch (error) {
      if (error.completionRecoveryRequired) throw error;
      return error.message;
    }
  };
  try {
    assertDirectoryIdentity(destinationRoot, prepared.destinationIdentity);
    const published = await publishNoClobber(src, dest, sourceSnapshot, {
      beforePublish, onDestinationCreated, afterPublish, onDestinationRemoved,
      assertDestinationRoot: () => assertDirectoryIdentity(destinationRoot, prepared.destinationIdentity),
      staging: stagingPath ? path.resolve(stagingPath) : undefined, stagingIdentity: undefined,
    });
    publicationGuard(published.destinationIdentity);
    const assertCleanupPublished = (before, after) => (published.copyMode ? assertPublishedCopy(before, after) : assertPublishedLinks(before, after));
    const cleanupDestinationSnapshot = verifyTree(dest, { allowHardlinks: true });
    assertSourceUnchanged(published.publishedSnapshot, cleanupDestinationSnapshot);
    assertCleanupPublished(published.sourceAfterPublish, cleanupDestinationSnapshot);
    // A copy destination is an independent object, so prove its bytes match the
    // source before the source becomes eligible for deletion. A hardlink shares
    // the source inode, so identity (checked above) already proves byte equality.
    if (published.copyMode) await compareTreeContents(src, dest, published.sourceAfterPublish, cleanupDestinationSnapshot);
    const cleanupWarning = cleanupPublishedSource(src, sourceIdentity, published.sourceAfterPublish, published.destinationIdentity, () => {
      const liveDestination = verifyTree(dest, { allowHardlinks: true });
      // Claiming the other hard-link name changes file ctime on POSIX.
      assertSourceUnchanged(cleanupDestinationSnapshot, liveDestination, { publicationLinks: !published.copyMode });
      assertCleanupPublished(published.sourceAfterPublish, liveDestination);
    });
    return { moved: true, dest, ...(cleanupWarning ? { cleanupWarning } : {}) };
  } catch (err) {
    if (!isCopyPublicationError(err) || err.completionRecoveryRequired) throw err;
    // Cross-volume: build an owned staging tree first, then reserve the exact
    // destination and populate it with exclusive links and directories.
    assertDirectoryIdentity(destinationRoot, prepared.destinationIdentity);
    const temporary = stagingPath ? path.resolve(stagingPath) : path.join(destinationRoot, `.frostbyte-moving-${randomUUID()}`);
    if (!sameLocalPath(path.dirname(temporary), destinationRoot)
      || !/^\.frostbyte-moving-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(path.basename(temporary))) {
      throw new Error('The completion staging path is invalid.');
    }
    let stagingIdentity = null;
    let stagingCleanupManifest = null;
    let reservation = null;
    try {
      reservation = await reserveStaging(temporary, rootType);
      stagingIdentity = reservation.identity;
      // Record each exact inode as soon as it is created so a partial copy can
      // remove only FrostByte-owned entries. The root entry is present before
      // any callback or child creation.
      stagingCleanupManifest = new Map([['', reservation.rootEntry]]);
      let stagingFailure = null;
      try {
        await afterStage({ staging: temporary, stagingIdentity, destination: dest, sourceIdentity });
        await copyIntoStaging(src, temporary, rootType, reservation, sourceSnapshot, stagingCleanupManifest);
      } catch (error) { stagingFailure = error; }
      const reservationHandle = reservation.handle;
      reservation.handle = null;
      await closeComparedHandles([reservationHandle], stagingFailure);
      const sourceAfterCopy = verifyTree(src);
      assertSourceUnchanged(sourceSnapshot, sourceAfterCopy);
      const copiedSnapshot = verifyTree(temporary);
      // The snapshot is the exact live-cleanup authority even when the later
      // byte comparison fails. A directory is never recursively removed from
      // its root identity alone.
      stagingCleanupManifest = copiedSnapshot;
      assertCopyMatches(sourceSnapshot, copiedSnapshot);
      const copiedDigests = await compareTreeContents(src, temporary, sourceSnapshot, copiedSnapshot);
      if (!beneath(destinationRoot, fs.realpathSync(temporary))) throw new Error('The completed folder changed while the download was copying.');
      assertDirectoryIdentity(destinationRoot, prepared.destinationIdentity);
      assertMissing(dest, 'A file appeared at the completed destination while the download was copying.');
      const published = await publishNoClobber(temporary, dest, copiedSnapshot, {
        beforePublish, onDestinationCreated, afterPublish, onDestinationRemoved,
        assertDestinationRoot: () => assertDirectoryIdentity(destinationRoot, prepared.destinationIdentity),
        rollbackSourceAvailable: () => {
          const currentSource = verifyTree(src);
          assertSourceUnchanged(sourceSnapshot, currentSource);
          return true;
        },
        verifyPublished: async ({ destination: publishedDestination, publishedSnapshot }) => {
          await verifyTreeDigests(publishedDestination, publishedSnapshot, copiedDigests);
        },
        staging: temporary, stagingIdentity,
      });
      publicationGuard(published.destinationIdentity);
      const warnings = [];
      const assertStagingPublished = (before, after) => (published.copyMode ? assertPublishedCopy(before, after) : assertPublishedLinks(before, after));
      // Remove the independent original while the verified publication still
      // exists. Its claim cannot alter destination metadata, so a strict
      // synchronous recheck catches any last-moment destination mutation.
      const beforeSourceCleanup = verifyTree(dest, { allowHardlinks: true });
      assertSourceUnchanged(published.publishedSnapshot, beforeSourceCleanup);
      assertStagingPublished(published.sourceAfterPublish, beforeSourceCleanup);
      const sourceBeforeCleanup = verifyTree(src);
      assertSourceUnchanged(sourceSnapshot, sourceBeforeCleanup);
      const sourceWarning = cleanupPublishedSource(src, sourceIdentity, sourceBeforeCleanup, published.destinationIdentity, () => {
        const liveDestination = verifyTree(dest, { allowHardlinks: true });
        assertSourceUnchanged(beforeSourceCleanup, liveDestination);
        assertStagingPublished(published.sourceAfterPublish, liveDestination);
      });
      if (sourceWarning) warnings.push(`source cleanup: ${sourceWarning}`);

      const beforeStagingCleanup = verifyTree(dest, { allowHardlinks: true });
      assertSourceUnchanged(beforeSourceCleanup, beforeStagingCleanup);
      assertStagingPublished(published.sourceAfterPublish, beforeStagingCleanup);
      const stagingWarning = cleanupPublishedSource(temporary, stagingIdentity, published.sourceAfterPublish, published.destinationIdentity, () => {
        const liveDestination = verifyTree(dest, { allowHardlinks: true });
        // Renaming the staging hard-link changes file ctime; exact inode, tree,
        // size and mtime still prevent a replaced publication from authorizing
        // deletion of the last staging link. A copy publication has independent
        // inodes, so ctime is compared normally there.
        assertSourceUnchanged(beforeStagingCleanup, liveDestination, { publicationLinks: !published.copyMode });
        assertStagingPublished(published.sourceAfterPublish, liveDestination);
      });
      if (stagingWarning) warnings.push(`staging cleanup: ${stagingWarning}`);
      else stagingIdentity = null;
      return { moved: true, dest, ...(warnings.length ? { cleanupWarning: warnings.join(' ') } : {}) };
    } catch (error) {
      if (reservation?.handle) {
        const reservationHandle = reservation.handle;
        reservation.handle = null;
        try { await reservationHandle.close(); }
        catch (closeError) { error.closeError ||= closeError; }
      }
      if (stagingIdentity && !error.completionRecoveryRequired) {
        const originalSourceIsExact = () => {
          try {
            const currentSource = verifyTree(src);
            assertSourceUnchanged(sourceSnapshot, currentSource);
            return true;
          } catch { return false; }
        };
        const originalSourceRemainsExact = originalSourceIsExact();
        if (!originalSourceRemainsExact) error.completionRecoveryRequired = true;
        else {
          try {
            const removed = removeOwnedCompletionPathSync(temporary, stagingIdentity, stagingCleanupManifest, {
              beforeRemove: () => {
                if (!originalSourceIsExact()) {
                  throw new Error('The original completed files changed before staging rollback.');
                }
              },
            });
            if (!removed) error.completionRecoveryRequired = true;
          } catch (cleanupError) {
            error.completionRecoveryRequired = true;
            error.cleanupError ||= cleanupError;
          }
        }
      }
      throw error;
    }
  }
}

/* ------------------------------------------------------------------- tick */

/**
 * One place that runs the whole feedback loop, on an interval. Returns a
 * summary so the caller can decide whether to push state to the UI.
 */
export async function tick({ engine, rates, queue, goals }) {
  const rateInfo = rates.apply();
  const queueInfo = await queue.enforce();
  const stopped = await goals.enforce();
  return { rateInfo, queueInfo, stopped };
}
