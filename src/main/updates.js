import { EventEmitter } from 'node:events';

export const UPDATE_URL = 'https://blackfrostai.com/frostbyte/updates';
export const DOWNLOAD_URL = 'https://blackfrostai.com/frostbyte/downloads';
const DAY = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['beta', 'nightly']);
const channelValue = value => {
  const channel = String(value || 'beta').trim().toLowerCase();
  if (!CHANNELS.has(channel)) throw new Error('Unrecognized update channel.');
  return channel;
};
const versionParts = value => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(value || '');
  if (!match) throw new Error('Unrecognized release version.');
  if (match.slice(1).some(value => value !== undefined && !Number.isSafeInteger(Number(value)))) throw new Error('Release version is out of range.');
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])];
};
export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function validateRelease(value) {
  if (value?.schemaVersion !== 1 || value.channel !== 'beta') throw new Error('Unrecognized update information.');
  versionParts(value.version);
  if (!Array.isArray(value.platforms) || value.platforms.some(p => !['darwin-arm64', 'win32-x64', 'linux-x64'].includes(p))) throw new Error('Invalid update platforms.');
  return { version: value.version, platforms: [...value.platforms], notes: typeof value.notes === 'string' ? value.notes.slice(0, 4000) : '' };
}
export function downloadUrlForChannel(channel = 'beta') {
  return channelValue(channel) === 'beta' ? DOWNLOAD_URL : null;
}
/** Metadata only. Never downloads an installer, sends an invite, or changes the installed app. */
export class UpdateChecker extends EventEmitter {
  constructor({ version, channel = 'beta', platform = process.platform + '-' + process.arch, saved = {}, save = () => {}, fetchImpl = fetch, now = Date.now }) {
    super(); Object.assign(this, { version, channel: channelValue(channel), platform, save, fetchImpl, now });
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    const currentTime = this.now();
    const lastChecked = Number.isSafeInteger(saved.lastChecked) && saved.lastChecked >= 0 && saved.lastChecked <= currentTime ? saved.lastChecked : 0;
    this.state = { status: this.channel === 'beta' ? 'idle' : 'private', lastChecked: this.channel === 'beta' ? lastChecked : 0, latest: null, error: '' };
    try { if (this.channel === 'beta' && saved.latest) { this.state.latest = validateRelease({ schemaVersion: 1, channel: 'beta', ...saved.latest }); this.state.status = this.releaseStatus(this.state.latest); } } catch { /* invalid cached metadata is discarded */ }
  }
  releaseStatus(latest) {
    const comparison = compareVersions(this.version, latest.version);
    return !latest.platforms.includes(this.platform) ? 'unsupported' : comparison < 0 ? 'available' : comparison > 0 ? 'ahead' : 'current';
  }
  snapshot() { return { ...this.state, current: this.version, channel: this.channel }; }
  publish() {
    try { this.emit('change', this.snapshot()); }
    catch (error) { console.warn(`Could not publish update status: ${error.message}`); }
  }
  async check({ automatic = false } = {}) {
    if (this.channel !== 'beta') return this.snapshot();
    if (this.pending) return this.pending;
    const elapsed = this.now() - this.state.lastChecked;
    if (automatic && elapsed >= 0 && elapsed < DAY) return this.snapshot();
    const previous = { ...this.state, latest: this.state.latest && { ...this.state.latest } };
    this.state.status = 'checking'; this.state.error = ''; this.publish();
    this.pending = (async () => {
      let next;
      try {
        const response = await this.fetchImpl(UPDATE_URL, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Update service unavailable. Try again later.');
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 16000) throw new Error('Update response is too large.');
          chunks.push(chunk);
        }
        const latest = validateRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        next = { status: this.releaseStatus(latest), lastChecked: this.now(), latest, error: '' };
      } catch {
        next = { ...previous, status: 'error', lastChecked: this.now(),
          error: 'Could not check for updates. Check your connection and try again.' };
      }
      try { await this.save({ lastChecked: next.lastChecked, latest: next.latest }); }
      catch (error) {
        this.state = previous;
        this.publish();
        throw error;
      }
      this.state = next;
      this.publish(); return this.snapshot();
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}
