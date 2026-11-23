/** Saved companion connections. Credentials stay in main; jobs retain their device ID. */
import { createHash, randomUUID } from 'node:crypto';
import { SparkInventoryCache } from './spark-inventory.js';
import { identifyDevice, DEVICE_ARTWORK } from '../shared/device-models.js';
import { sanitizeSparkStatus } from './spark-schema.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const connectionIdentity = profile => JSON.stringify([profile.mode, profile.host, profile.username, profile.port || 22]);
const text = (value, max, field, { empty = false } = {}) => {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid saved device ${field}.`);
  return value;
};
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function savedProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved device connection.');
  const runtime = value.runtime === undefined ? undefined : ['docker', 'mac-native'].includes(value.runtime) ? value.runtime : (() => { throw new Error('Invalid saved device runtime.'); })();
  if (value.mode === 'ssh') {
    const host = text(value.host, 200, 'SSH alias');
    if (!/^[a-z0-9][a-z0-9_.@:-]{0,199}$/i.test(host)) throw new Error('Invalid saved device SSH alias.');
    return { mode: 'ssh', host, ...(runtime ? { runtime } : {}) };
  }
  if (!['password', 'key'].includes(value.mode)) throw new Error('Invalid saved device connection mode.');
  const host = text(value.host, 253, 'host'), username = text(value.username, 64, 'username');
  const port = value.port ?? 22;
  if (!/^[a-z0-9][a-z0-9.:-]{0,252}$/i.test(host) || !/^[a-z_][a-z0-9_.-]{0,63}$/i.test(username) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid saved device address.');
  }
  const hostKey = text(value.hostKey, 16384, 'host key');
  const privateKeyEnc = text(value.privateKeyEnc, 131072, 'encrypted key');
  const publicKey = value.publicKey === undefined ? undefined : text(value.publicKey, 16384, 'public key');
  return { mode: value.mode, host, username, port, hostKey, privateKeyEnc,
    ...(publicKey ? { publicKey } : {}), ...(runtime ? { runtime } : {}) };
}
function savedRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved device.');
  const profile = savedProfile(value.profile);
  const id = text(value.id, 200, 'ID'), host = text(value.host, 255, 'label');
  const result = { id, host, profile };
  if (value.name !== undefined) result.name = text(value.name, 80, 'name', { empty: true }).trim();
  if (value.artwork !== undefined && value.artwork !== '') {
    if (!DEVICE_ARTWORK.includes(value.artwork)) throw new Error('Invalid saved device artwork.');
    result.artwork = value.artwork;
  }
  if (value.defaultDir !== undefined && value.defaultDir !== '') {
    const folder = text(value.defaultDir, 4096, 'folder');
    if (!folder.startsWith('/') || folder.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid saved device folder.');
    result.defaultDir = folder;
  }
  for (const field of ['createdAt', 'lastSeen']) {
    const valid = timestamp(value[field]);
    if (valid !== undefined) result[field] = valid;
  }
  if (typeof value.generation === 'string' && value.generation.length <= 200) result.generation = value.generation;
  if (Array.isArray(value.retiredProfiles)) {
    const retiredProfiles = [], seen = new Set();
    for (const candidate of value.retiredProfiles.slice(0, 8)) {
      try {
        const profile = savedProfile(candidate);
        if (profile.mode === 'ssh' || !profile.privateKeyEnc) continue;
        const key = JSON.stringify(profile);
        if (!seen.has(key)) { seen.add(key); retiredProfiles.push(profile); }
      } catch { /* malformed retired credentials are never used for SSH */ }
    }
    if (retiredProfiles.length) result.retiredProfiles = retiredProfiles;
  }
  try { if (value.snapshot) result.snapshot = publicStatus(value.snapshot); } catch { /* keep the connection; discard hostile or obsolete status */ }
  return result;
}
function publicStatus(status = {}) {
  const result = sanitizeSparkStatus(status);
  if (result.hardware) result.hardware = identifyDevice({ ...result.hardware, reportedModel: result.hardware.name || result.hardware.reportedModel });
  return result;
}

export class DeviceRegistry {
  constructor({ store, request, unlock = profile => profile, onChange = () => {} }) {
    Object.assign(this, { store, request, unlock, onChange });
    this.live = new Map(); this.caches = new Map(); this.pending = new Map(); this.revoking = new Map();
    const original = new Map(['devices', 'selectedDeviceId', 'sparkConnection', 'sparkInventory'].map(key => [key, {
      present: Object.hasOwn(store.state, key), value: store.state[key],
    }]));
    let migrated = false;
    if (!Array.isArray(store.state.devices)) {
      const host = store.getSettings().sparkHost;
      store.state.devices = host ? [{ id: 'spark', host, profile: clone(store.state.sparkConnection || { mode: 'ssh', host }),
        defaultDir: store.getSettings().sparkDownloadHost === host ? store.getSettings().sparkDownloadDir : '',
        snapshot: publicStatus(store.state.sparkInventory?.host === host ? store.state.sparkInventory : {}), createdAt: Date.now() }] : [];
      store.state.selectedDeviceId = host ? 'spark' : '';
      migrated = true;
    }
    const before = JSON.stringify(store.state.devices);
    const previousSelection = store.state.selectedDeviceId;
    const previousLegacy = JSON.stringify([store.state.sparkConnection, store.state.sparkInventory]);
    const records = [], ids = new Set(), identities = new Set();
    for (const candidate of store.state.devices.slice(0, 16)) {
      try {
        const record = savedRecord(candidate), identity = connectionIdentity(record.profile);
        if (ids.has(record.id) || identities.has(identity)) continue;
        ids.add(record.id); identities.add(identity); records.push(record);
      } catch { /* malformed saved connections are never used for SSH */ }
    }
    store.state.devices = records;
    if (!records.some(record => record.id === store.state.selectedDeviceId)) store.state.selectedDeviceId = records[0]?.id || '';
    const selected = records.find(record => record.id === store.state.selectedDeviceId);
    if (selected) {
      store.state.sparkConnection = clone(selected.profile);
      store.state.sparkInventory = { host: selected.host, ...clone(selected.snapshot || {}) };
    } else {
      delete store.state.sparkConnection; delete store.state.sparkInventory;
    }
    if (migrated || before !== JSON.stringify(records) || previousSelection !== store.state.selectedDeviceId
      || previousLegacy !== JSON.stringify([store.state.sparkConnection, store.state.sparkInventory])) {
      try { store._flush(); }
      catch (error) {
        for (const [key, prior] of original) {
          if (prior.present) store.state[key] = prior.value;
          else delete store.state[key];
        }
        throw error;
      }
    }
    // Device state is canonical. If the app stopped between the settings and
    // state commits, repair the older compatibility fields on the next launch.
    const expectedSettings = { sparkHost: selected?.host || '', sparkDownloadHost: selected?.host || '', sparkDownloadDir: selected?.defaultDir || '' };
    const currentSettings = store.getSettings();
    if (Object.entries(expectedSettings).some(([key, value]) => currentSettings[key] !== value)) {
      try { store.setSettings(expectedSettings); }
      catch (error) {
        // Keep this running process aligned with the durable canonical state;
        // the same repair is retried at the next launch.
        if (store.settings && typeof store.settings === 'object') Object.assign(store.settings, expectedSettings);
        console.warn(`Could not repair device compatibility settings: ${error.message}`);
      }
    }
    if (records.some(record => record.retiredProfiles?.length)) {
      queueMicrotask(() => { void this.retryRevocations(); });
    }
  }

  _commit(patch, settingsPatch) {
    const previous = new Map(Object.keys(patch).map(key => [key, {
      present: Object.hasOwn(this.store.state, key), value: this.store.state[key],
    }]));
    let previousSettings;
    if (settingsPatch) {
      const settings = this.store.getSettings();
      previousSettings = Object.fromEntries(Object.keys(settingsPatch).map(key => [key, settings[key]]));
      this.store.setSettings(settingsPatch);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete this.store.state[key];
      else this.store.state[key] = value;
    }
    try { this.store._flush(); }
    catch (error) {
      for (const [key, prior] of previous) {
        if (prior.present) this.store.state[key] = prior.value;
        else delete this.store.state[key];
      }
      if (previousSettings) {
        try { this.store.setSettings(previousSettings); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Could not save the device change or restore its previous settings. Restart FrostByte before changing devices again.');
        }
      }
      throw error;
    }
  }

  _selection(record, records = this.records) {
    this._commit({ devices: records, selectedDeviceId: record?.id || '',
      sparkConnection: record ? clone(record.profile) : undefined,
      sparkInventory: record ? { host: record.host, ...clone(record.snapshot || {}) } : undefined,
    }, { sparkHost: record?.host || '', sparkDownloadHost: record?.host || '', sparkDownloadDir: record?.defaultDir || '' });
  }

  _dropCache(id) {
    this.caches.get(id)?.invalidate();
    this.caches.delete(id);
  }

  _notify() {
    try { this.onChange(this.list()); }
    catch (error) { console.warn(`Could not publish the saved device change: ${error.message}`); }
  }
  get records() { return this.store.state.devices; }
  get selectedId() { return this.store.state.selectedDeviceId || ''; }
  record(id = this.selectedId) {
    const record = this.records.find(item => item.id === id);
    if (!record) throw new Error('This device is no longer saved. Select or connect a device.');
    return record;
  }
  /** Status snapshots are replaced after polling; approval belongs to the saved
   * connection and configured choices, not the transient record object. Keep
   * the complete credential/profile binding in main and out of public status. */
  approvalSnapshot(id = this.selectedId) {
    const record = this.record(id);
    const digest = createHash('sha256').update(JSON.stringify([
      record.id, record.generation, record.host, record.name, record.defaultDir, record.profile,
    ])).digest('hex');
    return Object.freeze({ id: record.id, digest });
  }
  isApprovalCurrent(approval) {
    if (!approval || typeof approval.id !== 'string' || typeof approval.digest !== 'string') return false;
    try { return this.approvalSnapshot(approval.id).digest === approval.digest; }
    catch { return false; }
  }
  profile(id) { return this.unlock(clone(this.record(id).profile)); }
  cache(id) {
    const record = this.record(id);
    if (!this.caches.has(record.id)) {
      let staged;
      const state = {};
      Object.defineProperty(state, 'sparkInventory', {
        get: () => (staged || record.snapshot) && { host: record.host, ...(staged || record.snapshot) },
        set: value => { staged = publicStatus(value); },
        configurable: true,
      });
      this.caches.set(record.id, new SparkInventoryCache({ state, getSettings: () => ({ sparkHost: record.host }), _flush() {} }));
    }
    return this.caches.get(record.id);
  }
  list() {
    return this.records.map(record => {
      const live = this.live.get(record.id);
      return { id: record.id, host: record.host, name: record.name || record.snapshot?.hardware?.name || record.snapshot?.hostname || record.host,
        label: record.name || [record.snapshot?.hardware?.name, record.host].filter(Boolean).join(' · '),
        artwork: record.artwork || '', defaultDir: record.defaultDir || record.snapshot?.downloadDir || '',
        managed: [record.profile?.privateKey, record.profile?.privateKeyEnc].some(value => typeof value === 'string' && value.length > 0),
        port: Number.isInteger(record.profile?.port) ? record.profile.port : 22,
        connected: live?.connected === true, error: live?.error || '', lastSeen: record.lastSeen || null,
        checking: this.pending.has(record.id), status: publicStatus(live?.status || record.snapshot) };
    });
  }
  connectionId(profile) {
    return this.records.find(item => connectionIdentity(item.profile) === connectionIdentity(profile))?.id || '';
  }
  async replace(profile, host) {
    const previousId = this.connectionId(profile);
    const previous = previousId ? this.records.find(record => record.id === previousId) : null;
    const retired = previous?.profile?.privateKeyEnc ? clone(previous.profile) : null;
    const id = this.save(profile, host, { retired });
    // The new connection is already durable. Cleanup cannot make setup report
    // failure and remove the newly installed key; unsuccessful cleanup remains
    // encrypted in the bounded queue for a later retry.
    void this.flushRevocations(id);
    return id;
  }
  save(profile, host, { retired = null } = {}) {
    profile = savedProfile(profile);
    host = text(host, 255, 'label');
    const previous = this.records.find(item => item.id === this.connectionId(profile));
    let record;
    if (!previous) {
      if (this.records.length >= 16) throw new Error('You can save up to 16 devices. Forget an unused connection before adding another.');
      record = { id: randomUUID(), host, profile: clone(profile), createdAt: Date.now() };
    } else {
      record = { ...previous, profile: clone(profile), host };
      if (previous.profile.hostKey !== profile.hostKey || previous.profile.runtime !== profile.runtime) delete record.snapshot;
    }
    if (retired && previous) {
      const candidates = [...(previous.retiredProfiles || []), savedProfile(retired)]
        .filter(candidate => candidate.mode !== 'ssh' && candidate.privateKeyEnc && candidate.privateKeyEnc !== profile.privateKeyEnc);
      const unique = [...new Map(candidates.map(candidate => [JSON.stringify(candidate), candidate])).values()];
      if (unique.length > 8) throw new Error('Finish removing an older FrostByte device key before pairing this device again.');
      if (unique.length) record.retiredProfiles = unique;
      else delete record.retiredProfiles;
    }
    record.generation = randomUUID();
    const records = previous ? this.records.map(item => item === previous ? record : item) : [...this.records, record];
    this._selection(record, records);
    if (previous) {
      this._dropCache(record.id);
      if (previous.profile.hostKey !== profile.hostKey || previous.profile.runtime !== profile.runtime) this.live.delete(record.id);
    }
    this._notify();
    return record.id;
  }
  flushRevocations(id) {
    if (this.revoking.has(id)) return this.revoking.get(id);
    const task = (async () => {
      while (true) {
        const record = this.records.find(item => item.id === id);
        const retired = record?.retiredProfiles?.[0];
        if (!retired) return { pending: record?.retiredProfiles?.length || 0 };
        const identity = JSON.stringify(retired);
        try {
          const profile = this.unlock(clone(retired));
          if (!profile.privateKey) throw new Error('The retired device key could not be unlocked.');
          const result = await this.request(profile, { action: 'pairing:revoke' });
          if (result?.revoked !== true) throw new Error('The device did not confirm removal of its retired FrostByte key.');
          const latest = this.records.find(item => item.id === id);
          if (!latest) return { pending: 0 };
          const remaining = (latest.retiredProfiles || []).filter(candidate => JSON.stringify(candidate) !== identity);
          const next = { ...latest };
          if (remaining.length) next.retiredProfiles = remaining;
          else delete next.retiredProfiles;
          this._commit({ devices: this.records.map(item => item === latest ? next : item) });
          this._notify();
        } catch (error) {
          console.warn(`Could not remove a retired FrostByte device key; cleanup will retry: ${error.message}`);
          return { pending: this.records.find(item => item.id === id)?.retiredProfiles?.length || 0 };
        }
      }
    })().finally(() => this.revoking.delete(id));
    this.revoking.set(id, task);
    return task;
  }
  async retryRevocations() {
    await Promise.allSettled(this.records.filter(record => record.retiredProfiles?.length).map(record => this.flushRevocations(record.id)));
  }
  select(id) {
    const record = this.record(id);
    // Preserve the beta.11 fields so an older installed beta can still connect.
    this._selection(record);
    this._notify();
    return id;
  }
  configure(id, { name, artwork, defaultDir } = {}) {
    const record = this.record(id);
    if (name !== undefined && (typeof name !== 'string' || name.length > 80 || /[\x00-\x1f]/.test(name))) throw new Error('Use a device name of 80 characters or fewer.');
    if (artwork !== undefined && artwork !== '' && !DEVICE_ARTWORK.includes(artwork)) throw new Error('Choose a supported device photo.');
    if (defaultDir !== undefined && !record.snapshot?.storage?.some(root => root.path === defaultDir && root.available)) throw new Error('Choose an available storage folder on this device.');
    const next = { ...record };
    if (name !== undefined) next.name = name.trim();
    if (artwork !== undefined) next.artwork = artwork;
    if (defaultDir !== undefined) next.defaultDir = defaultDir;
    // Changing a choice and then changing it back still invalidates an in-flight
    // approval. Photo-only edits do not alter any reviewed operation target.
    if (next.name !== record.name || next.defaultDir !== record.defaultDir) next.generation = randomUUID();
    const records = this.records.map(item => item === record ? next : item);
    if (id === this.selectedId) this._selection(next, records);
    else this._commit({ devices: records });
    this._dropCache(id);
    this._notify();
    return this.list();
  }
  forget(id) {
    const record = this.record(id);
    const records = this.records.filter(item => item !== record);
    if (id === this.selectedId) {
      this._selection(records[0], records);
    } else this._commit({ devices: records });
    this._dropCache(id); this.live.delete(id);
    this._notify();
    return this.list();
  }
  async revoke(id, approval = this.approvalSnapshot(id)) {
    // Re-pairing can leave older app keys queued for removal. Do not discard
    // their encrypted credentials after revoking only the newest key: once the
    // record is forgotten there would be no safe way to remove those older
    // authorized_keys entries automatically.
    const cleanup = await this.flushRevocations(id);
    if (cleanup.pending) throw new Error('An older FrostByte device key could not be removed. Keep this connection and retry removal when the device is reachable.');
    if (!this.isApprovalCurrent(approval)) throw new Error('The saved connection changed while its device key was being removed.');
    const profile = this.profile(id);
    if (!profile.privateKey) return { managed: false, revoked: false };
    const result = await this.request(profile, { action: 'pairing:revoke' });
    if (!this.isApprovalCurrent(approval)) throw new Error('The saved connection changed while its device key was being removed.');
    if (result?.revoked !== true) throw new Error('The device did not confirm removal of its FrostByte key.');
    return { managed: true, revoked: true };
  }
  async deviceTelemetry(id) {
    return this.request(this.profile(id), { action: 'device:telemetry' });
  }
  async deviceRecipes(id) {
    const result = await this.request(this.profile(id), { action: 'device:recipes' });
    return result;
  }
  async deviceControl(id, operation, recipeId) {
    return this.request(this.profile(id), { action: 'device:control', operation, recipeId });
  }

  async remember(id, status, { force = false } = {}) {
    const record = this.record(id), profile = this.profile(id);
    try {
      status = sanitizeSparkStatus(status);
      if (!status.hardware && record.snapshot?.hardware) status = { ...status, hardware: record.snapshot.hardware };
      const enriched = await this.cache(id).enrich(record.host, publicStatus(status), request => this.request(profile, request), { force });
      if (!this.records.includes(record)) throw new Error('This device was forgotten while checking it.');
      const next = { ...record, snapshot: publicStatus(enriched), lastSeen: Date.now() };
      const records = this.records.map(item => item === record ? next : item);
      this._commit({ devices: records,
        ...(id === this.selectedId ? { sparkConnection: clone(next.profile), sparkInventory: { host: next.host, ...clone(next.snapshot) } } : {}),
      });
      this._dropCache(id);
      this.live.set(id, { connected: true, status: enriched });
      this._notify();
      return enriched;
    } catch (error) {
      this._dropCache(id);
      throw error;
    }
  }
  refresh(id = this.selectedId, { force = false } = {}) {
    if (this.pending.has(id)) return this.pending.get(id);
    const record = this.record(id), generation = record.generation;
    const task = (async () => {
      try {
        const status = await this.request(this.profile(id), { action: 'status' });
        if (record.generation !== generation || !this.records.includes(record)) throw new Error('The saved connection changed. Refresh this device again.');
        return { connected: true, status: await this.remember(id, status, { force }) };
      } catch (error) {
        if (this.records.includes(record) && record.generation === generation) this.live.set(id, { connected: false, error: error.message, status: record.snapshot });
        return { connected: false, error: error.message, status: clone(record.snapshot) };
      } finally {
        this.pending.delete(id); this._notify();
      }
    })();
    this.pending.set(id, task);
    return task;
  }
  async refreshAll(options) {
    // Each response is pushed independently: an offline device does not delay healthy cards.
    await Promise.allSettled(this.records.map(record => this.refresh(record.id, options)));
    return this.list();
  }
}
