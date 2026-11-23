import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRegistry } from '../src/main/devices.js';
import { groupHfTransfers } from '../src/renderer/transfer-groups.js';
import { sanitizeSparkFiles, sanitizeSparkFolderListing, sanitizeSparkProbe, sanitizeSparkResponse, sanitizeSparkStatus } from '../src/main/spark-schema.js';

function fixture(state = {}, settings = {}) {
  const store = { state: structuredClone(state), settings: { sparkHost: '', ...settings }, getSettings() { return { ...this.settings }; }, setSettings(patch) { Object.assign(this.settings, patch); }, _flush() {} };
  const calls = [], changes = [];
  const registry = new DeviceRegistry({ store, unlock: profile => profile.privateKeyEnc ? { ...profile, privateKey: 'unlocked' } : profile, request: async (profile, request) => { calls.push({ profile, request });
    return request.action === 'pairing:revoke' ? { revoked: true } : { hostname: profile.host, inventory: [], downloads: [] }; }, onChange: value => changes.push(value) });
  return { registry, store, calls, changes };
}
const status = name => ({ hostname: name, downloadDir: '/models', storageRoots: ['/models'], storage: [{ path: '/models', available: true }], inventory: [], downloads: [{ id: 'same-id', repoId: 'owner/model', token: 'never-render-this', status: 'active' }] });
test('device approval survives polling but rejects changed saved choices', async () => {
  const { registry } = fixture();
  const id = registry.save({ mode: 'ssh', host: 'fixture' }, 'fixture');
  const approval = registry.approvalSnapshot(id), original = registry.record(id);
  await registry.refresh(id);
  assert.notEqual(registry.record(id), original);
  assert.equal(registry.isApprovalCurrent(approval), true);
  await registry.remember(id, status('fixture'));
  assert.equal(registry.isApprovalCurrent(approval), true);
  registry.configure(id, { name: 'Updated name' });
  assert.equal(registry.isApprovalCurrent(approval), false);
  registry.configure(id, { name: '' });
  assert.equal(registry.isApprovalCurrent(approval), false, 'changing back cannot revive an old approval');
  const renamed = registry.approvalSnapshot(id);
  registry.configure(id, { defaultDir: '/models' });
  assert.equal(registry.isApprovalCurrent(renamed), false);
  const selected = registry.approvalSnapshot(id);
  registry.save({ mode: 'ssh', host: 'fixture', runtime: 'mac-native' }, 'fixture');
  assert.equal(registry.isApprovalCurrent(selected), false);
  const replacement = registry.approvalSnapshot(id);
  registry.forget(id);
  assert.equal(registry.isApprovalCurrent(replacement), false);
});
test('device key revocation survives concurrent status refresh and retains the reviewed connection', async () => {
  const { registry } = fixture();
  const id = registry.save({ mode: 'password', host: '192.0.2.8', username: 'alex', hostKey: 'pinned', privateKeyEnc: 'encrypted' }, 'fixture');
  const approval = registry.approvalSnapshot(id);
  registry.request = async (_profile, request) => {
    if (request.action === 'pairing:revoke') {
      await registry.remember(id, status('fixture'));
      return { revoked: true };
    }
    return status('fixture');
  };
  assert.deepEqual(await registry.revoke(id, approval), { managed: true, revoked: true });
  const beforeReplacement = registry.approvalSnapshot(id);
  registry.save({ ...registry.record(id).profile, privateKeyEnc: 'replacement' }, 'fixture');
  await assert.rejects(registry.revoke(id, beforeReplacement), /saved connection changed/);
});
test('legacy Spark migration preserves credentials, inventory and destination without exposing credentials', () => {
  const profile = { mode: 'password', host: '192.0.2.1', username: 'alex', port: 22, privateKeyEnc: 'encrypted-key', hostKey: 'trusted-key' };
  const { registry, store } = fixture({ sparkConnection: profile, sparkInventory: { host: 'alex@192.0.2.1', ...status('spark') } }, { sparkHost: 'alex@192.0.2.1', sparkDownloadHost: 'alex@192.0.2.1', sparkDownloadDir: '/models' });
  assert.equal(registry.selectedId, 'spark');
  assert.deepEqual(registry.profile(), { ...profile, privateKey: 'unlocked' });
  assert.equal(registry.list()[0].defaultDir, '/models');
  assert.equal(registry.list()[0].status.downloads.length, 1);
  assert.doesNotMatch(JSON.stringify(registry.list()), /encrypted-key|trusted-key|never-render-this/);
  new DeviceRegistry({ store, request: async () => {} });
  assert.equal(store.state.devices.length, 1);
});
test('two companions keep storage and status separate across selection and restart', async () => {
  const { registry, store, calls } = fixture();
  const mac = registry.save({ mode: 'ssh', host: 'my-mac', runtime: 'mac-native' }, 'my-mac');
  const dgx = registry.save({ mode: 'ssh', host: 'my-dgx', runtime: 'docker' }, 'my-dgx');
  await registry.remember(mac, status('mac')); await registry.remember(dgx, { ...status('dgx'), storage: [{ path: '/external', available: true }] });
  registry.configure(mac, { defaultDir: '/models', name: 'Studio' });
  registry.configure(dgx, { defaultDir: '/external' });
  registry.select(mac); await registry.refresh(dgx);
  assert.equal(calls.at(-1).profile.host, 'my-dgx');
  assert.equal(store.getSettings().sparkHost, 'my-mac');
  assert.equal(registry.list().find(d => d.id === mac).name, 'Studio');
  const restored = new DeviceRegistry({ store, request: async () => {} });
  assert.equal(restored.list().find(d => d.id === mac).defaultDir, '/models');
  assert.equal(restored.list().find(d => d.id === dgx).defaultDir, '/external');
  assert.ok(restored.list().every(d => !d.connected));
});
test('a forgotten device cannot write a delayed result into another connection', async () => {
  const { registry } = fixture();
  const old = registry.save({ mode: 'ssh', host: 'old' }, 'old');
  let finish; registry.request = () => new Promise(resolve => { finish = resolve; });
  const request = registry.refresh(old); registry.forget(old);
  const fresh = registry.save({ mode: 'ssh', host: 'new' }, 'new');
  finish(status('old')); await request;
  assert.equal(registry.list().length, 1); assert.equal(registry.selectedId, fresh);
  assert.equal(registry.list()[0].status.hostname, undefined);
  assert.throws(() => registry.profile(old), /no longer saved/);
});
test('an offline device retains its last known model without blocking another device', async () => {
  const { registry } = fixture();
  const a = registry.save({ mode: 'ssh', host: 'offline' }, 'offline'), b = registry.save({ mode: 'ssh', host: 'online' }, 'online');
  await registry.remember(a, { ...status('offline'), hardware: { platform: 'darwin', modelIdentifier: 'Mac16,10', chip: 'Apple M4', memoryBytes: 16 * 1024 ** 3 } });
  registry.request = async profile => { if (profile.host === 'offline') throw new Error('Connection timed out'); return status('online'); };
  await registry.refreshAll();
  const list = registry.list();
  assert.equal(list.find(d => d.id === a).status.hardware.artwork, 'mac-mini-2024');
  assert.equal(list.find(d => d.id === a).connected, false);
  assert.equal(list.find(d => d.id === b).connected, true);
  assert.throws(() => registry.configure(b, { defaultDir: '/missing' }), /available/);
  assert.throws(() => registry.configure(b, { artwork: 'https://example.com/image' }), /photo/);
});
test('identical model shards on two devices form separate model groups', () => {
  const row = { device: 'spark', sparkHost: 'same-alias', repoId: 'owner/model', revision: 'a'.repeat(40), destination: '/models', status: 'active', total: 100, downloaded: 20 };
  const groups = groupHfTransfers([{ ...row, id: 'shard1', deviceId: 'mac' }, { ...row, id: 'shard2', deviceId: 'mac' }, { ...row, id: 'shard1', deviceId: 'dgx' }]);
  assert.equal(groups.length, 2); assert.equal(groups[0].files.length, 2); assert.equal(groups[1].deviceId, 'dgx');
});
test('managed device revocation removes only its remote app key before local forget', async () => {
  const { registry, calls } = fixture();
  const id = registry.save({ mode: 'password', host: '192.0.2.8', username: 'alex', port: 22, hostKey: 'pinned',
    privateKey: 'unlocked', privateKeyEnc: 'encrypted' }, 'alex@192.0.2.8');
  assert.deepEqual(await registry.revoke(id), { managed: true, revoked: true });
  assert.deepEqual(calls.at(-1).request, { action: 'pairing:revoke' });
  assert.equal(registry.records.length, 1, 'the caller controls local deletion after confirmed revocation');
  registry.forget(id); assert.equal(registry.records.length, 0);
});
test('re-pairing commits the new profile before retiring the old managed key', async () => {
  const { registry, calls } = fixture();
  const old = { mode: 'password', host: '192.0.2.8', username: 'alex', port: 22, hostKey: 'pinned', privateKeyEnc: 'old-encrypted', publicKey: 'old-public' };
  const id = registry.save(old, 'alex@192.0.2.8');
  const replacement = { ...old, privateKeyEnc: 'new-encrypted', publicKey: 'new-public' };
  assert.equal(await registry.replace(replacement, 'alex@192.0.2.8'), id);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].request, { action: 'pairing:revoke' });
  assert.equal(calls[0].profile.privateKeyEnc, 'old-encrypted');
  assert.equal(registry.profile(id).privateKey, 'unlocked');
  assert.equal(registry.records[0].profile.privateKey, undefined);
  assert.equal(registry.records[0].profile.privateKeyEnc, 'new-encrypted');
  assert.equal(registry.records[0].retiredProfiles, undefined);
});

test('re-pairing never revokes the working key when the new profile cannot be flushed', async () => {
  const { registry, store, calls } = fixture();
  const old = { mode: 'password', host: '192.0.2.8', username: 'alex', port: 22, hostKey: 'pinned', privateKeyEnc: 'old-encrypted', publicKey: 'old-public' };
  const id = registry.save(old, 'alex@192.0.2.8');
  store._flush = () => { throw new Error('fixture state write failed'); };
  await assert.rejects(registry.replace({ ...old, privateKeyEnc: 'new-encrypted', publicKey: 'new-public' }, 'alex@192.0.2.8'), /state write failed/);
  assert.equal(calls.length, 0, 'the old remote key remains until the replacement is durable');
  assert.equal(registry.records[0].id, id);
  assert.equal(registry.records[0].profile.privateKeyEnc, 'old-encrypted');
});

test('failed post-commit revocation keeps the new key and retries its encrypted cleanup queue', async () => {
  const { registry, store } = fixture();
  const old = { mode: 'password', host: '192.0.2.8', username: 'alex', port: 22, hostKey: 'pinned', privateKeyEnc: 'old-encrypted', publicKey: 'old-public' };
  const id = registry.save(old, 'alex@192.0.2.8');
  let revokeAttempts = 0;
  registry.request = async profile => {
    revokeAttempts++;
    assert.equal(registry.records[0].profile.privateKeyEnc, 'new-encrypted', 'new profile is committed before cleanup starts');
    assert.equal(profile.privateKeyEnc, 'old-encrypted');
    throw new Error('device temporarily offline');
  };
  assert.equal(await registry.replace({ ...old, privateKeyEnc: 'new-encrypted', publicKey: 'new-public' }, 'alex@192.0.2.8'), id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(revokeAttempts, 1);
  assert.equal(registry.records[0].profile.privateKeyEnc, 'new-encrypted');
  assert.equal(registry.records[0].retiredProfiles.length, 1);

  const retried = new DeviceRegistry({ store, unlock: profile => ({ ...profile, privateKey: 'retired-unlocked' }),
    request: async profile => { revokeAttempts++; assert.equal(profile.privateKeyEnc, 'old-encrypted'); return { revoked: true }; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(revokeAttempts, 2);
  assert.equal(retried.records[0].profile.privateKeyEnc, 'new-encrypted');
  assert.equal(retried.records[0].retiredProfiles, undefined);
});

test('a cleanup flush failure cannot turn a committed replacement into a failed pairing', async () => {
  const { registry, store } = fixture();
  const old = { mode: 'password', host: '192.0.2.8', username: 'alex', port: 22, hostKey: 'pinned', privateKeyEnc: 'old-encrypted', publicKey: 'old-public' };
  const id = registry.save(old, 'alex@192.0.2.8');
  let flushes = 0;
  store._flush = () => { if (++flushes === 2) throw new Error('cleanup state write failed'); };
  registry.request = async () => ({ revoked: true });
  assert.equal(await registry.replace({ ...old, privateKeyEnc: 'new-encrypted', publicKey: 'new-public' }, 'alex@192.0.2.8'), id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushes, 2);
  assert.equal(registry.records[0].profile.privateKeyEnc, 'new-encrypted');
  assert.equal(registry.records[0].retiredProfiles.length, 1, 'cleanup remains retryable after its state write fails');
});

test('forgetting a re-paired device cannot discard an older authorized-key cleanup', async () => {
  const { registry } = fixture();
  const old = { mode: 'password', host: '192.0.2.8', username: 'alex', port: 22, hostKey: 'pinned', privateKeyEnc: 'old-encrypted', publicKey: 'old-public' };
  const id = registry.save(old, 'alex@192.0.2.8');
  registry.request = async () => { throw new Error('old key offline'); };
  await registry.replace({ ...old, privateKeyEnc: 'new-encrypted', publicKey: 'new-public' }, 'alex@192.0.2.8');
  await new Promise(resolve => setImmediate(resolve));

  const attempted = [];
  registry.request = async profile => {
    attempted.push(profile.privateKeyEnc);
    if (profile.privateKeyEnc === 'old-encrypted') throw new Error('old key still offline');
    return { revoked: true };
  };
  await assert.rejects(registry.revoke(id), /older FrostByte device key/i);
  assert.deepEqual(attempted, ['old-encrypted'], 'the current key stays usable while older cleanup is retryable');
  assert.equal(registry.records[0].retiredProfiles.length, 1);

  attempted.length = 0;
  registry.request = async profile => { attempted.push(profile.privateKeyEnc); return { revoked: true }; };
  assert.deepEqual(await registry.revoke(id), { managed: true, revoked: true });
  assert.deepEqual(attempted, ['old-encrypted', 'new-encrypted']);
  assert.equal(registry.records[0].retiredProfiles, undefined);
});

test('malformed saved devices and plaintext credentials are discarded before use', () => {
  const good = { id: 'good', host: 'safe-alias', profile: { mode: 'ssh', host: 'safe-alias' }, snapshot: { hostname: 'safe', inventory: [], downloads: [] } };
  const { registry, store } = fixture({ selectedDeviceId: 'bad', devices: [
    { id: 'bad', host: 'host;touch /tmp/pwn', profile: { mode: 'ssh', host: 'host;touch /tmp/pwn' } },
    { id: 'plaintext', host: '192.0.2.1', profile: { mode: 'password', host: '192.0.2.1', username: 'alex', hostKey: 'key', privateKey: 'secret' } },
    good,
    { ...good },
  ] });
  assert.deepEqual(registry.list().map(device => device.id), ['good']);
  assert.equal(store.state.selectedDeviceId, 'good');
  assert.doesNotMatch(JSON.stringify(store.state.devices), /secret|touch/);
});
test('user-managed SSH aliases are forgotten without attempting key revocation', async () => {
  const { registry, calls } = fixture();
  const id = registry.save({ mode: 'ssh', host: 'my-spark', runtime: 'docker' }, 'my-spark');
  assert.deepEqual(await registry.revoke(id), { managed: false, revoked: false });
  assert.equal(calls.length, 0);
});
test('failed device writes roll back records, selection, settings, snapshots, and notifications', async () => {
  const { registry, store, changes } = fixture();
  const first = registry.save({ mode: 'ssh', host: 'first' }, 'first');
  const second = registry.save({ mode: 'ssh', host: 'second' }, 'second');
  await registry.remember(first, status('first-snapshot'));
  await registry.remember(second, status('second-snapshot'));
  registry.select(first);
  const beforeState = structuredClone(store.state), beforeSettings = store.getSettings(), notifications = changes.length;
  const flush = store._flush;
  store._flush = () => { throw new Error('fixture state write failed'); };
  assert.throws(() => registry.save({ mode: 'ssh', host: 'third' }, 'third'), /state write failed/);
  assert.throws(() => registry.select(second), /state write failed/);
  assert.throws(() => registry.configure(second, { name: 'Rejected name' }), /state write failed/);
  assert.throws(() => registry.forget(first), /state write failed/);
  await assert.rejects(registry.remember(first, status('rejected-snapshot')), /state write failed/);
  assert.deepEqual(store.state, beforeState);
  assert.deepEqual(store.getSettings(), beforeSettings);
  assert.equal(registry.list().find(device => device.id === first).status.hostname, 'first-snapshot');
  assert.equal(changes.length, notifications);
  store._flush = flush;

  const setSettings = store.setSettings;
  store.setSettings = () => { throw new Error('fixture settings write failed'); };
  assert.throws(() => registry.select(second), /settings write failed/);
  assert.deepEqual(store.state, beforeState);
  assert.deepEqual(store.getSettings(), beforeSettings);
  assert.equal(changes.length, notifications);
  store.setSettings = setSettings;
});
test('failed startup device sanitation restores the exact loaded state', () => {
  const original = { selectedDeviceId: 'missing', devices: [
    { id: 'good', host: 'safe', profile: { mode: 'ssh', host: 'safe' } },
    { id: 'bad', host: 'bad;command', profile: { mode: 'ssh', host: 'bad;command' } },
  ], sparkConnection: { mode: 'ssh', host: 'legacy' } };
  const store = { state: structuredClone(original), getSettings: () => ({ sparkHost: '' }), _flush() { throw new Error('fixture state write failed'); } };
  assert.throws(() => new DeviceRegistry({ store, request: async () => {} }), /state write failed/);
  assert.deepEqual(store.state, original);
});
test('startup repairs compatibility settings from canonical device state after an interrupted selection', () => {
  const first = { id: 'first', host: 'first', profile: { mode: 'ssh', host: 'first' }, defaultDir: '/models' };
  const second = { id: 'second', host: 'second', profile: { mode: 'ssh', host: 'second' }, defaultDir: '/other' };
  const { registry, store } = fixture({ selectedDeviceId: first.id, devices: [first, second] }, {
    sparkHost: second.host, sparkDownloadHost: second.host, sparkDownloadDir: second.defaultDir,
  });
  assert.equal(registry.selectedId, first.id);
  assert.deepEqual(store.getSettings(), { sparkHost: first.host, sparkDownloadHost: first.host, sparkDownloadDir: first.defaultDir });
});
test('remote status is bounded, typed, and stripped to known nested fields', () => {
  const clean = sanitizeSparkStatus({ hostname: 'spark', protocolVersion: 1, downloadDir: '/models', secret: 'drop',
    capabilities: { downloads: true, torrentFileDeletion: true, runtime: 'docker', secret: 'drop' },
    endpoint: { port: 31000, state: 'ready', detail: 'GET /health returned HTTP 200.', url: 'http://unapproved.example/v1', token: 'drop' },
    torrents: [{ infoHash: 'a'.repeat(40),
    ratio: 1.5, numPeers: 2, completionGeneration: 4, files: [{ path: 'model.gguf', length: 3, token: 'drop' }], token: 'drop' }], downloads: [] });
  assert.equal(clean.secret, undefined); assert.equal(clean.protocolVersion, 1); assert.equal(clean.torrents[0].token, undefined); assert.equal(clean.torrents[0].files[0].token, undefined);
  assert.deepEqual(clean.capabilities, { downloads: true, torrentFileDeletion: true, runtime: 'docker' });
  assert.equal(clean.torrents[0].completionGeneration, 4);
  assert.deepEqual(clean.endpoint, { port: 31000, state: 'ready', detail: 'GET /health returned HTTP 200.' });
  assert.equal(clean.endpoint.url, undefined); assert.equal(clean.endpoint.token, undefined);
  assert.deepEqual(sanitizeSparkStatus({ endpoint: null }), { endpoint: null });
  assert.throws(() => sanitizeSparkStatus({ protocolVersion: '1' }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ endpoint: { url: 'http://unapproved.example/v1' } }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ endpoint: { port: '30000', state: 'ready', detail: '' } }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ endpoint: { port: 65536, state: 'ready', detail: '' } }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ endpoint: { port: 30000, state: 'invented', detail: '' } }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ endpoint: { port: 30000, state: 'ready\nspoofed', detail: '' } }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ torrents: [{ ratio: '<img src=x>', numPeers: 1 }] }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ capabilities: { torrentFileDeletion: 'yes' } }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ torrents: [{ completionGeneration: '4' }] }), /invalid status data/);
  assert.throws(() => sanitizeSparkStatus({ downloads: [{ status: 'active', error: 'x'.repeat(16385) }] }), /invalid status data/);
  let nested = {}; const root = nested; for (let index = 0; index < 12; index++) nested = nested.child = {};
  assert.throws(() => sanitizeSparkStatus(root), /invalid status data/);
});
test('remote file and folder browser responses are bounded and typed', () => {
  assert.deepEqual(sanitizeSparkFiles({ root: '/models', relative: '', truncated: false, secret: 'drop',
    entries: [{ name: 'weights.gguf', relative: 'owner/model/weights.gguf', directory: false, size: 12, modified: '2026-01-01T00:00:00.000Z', secret: 'drop' }] }), {
    root: '/models', relative: '', truncated: false,
    entries: [{ name: 'weights.gguf', relative: 'owner/model/weights.gguf', directory: false, size: 12, modified: '2026-01-01T00:00:00.000Z' }],
  });
  assert.throws(() => sanitizeSparkFiles({ root: '/models', relative: '', truncated: false, entries: 'not-an-array' }), /invalid status data/);
  assert.throws(() => sanitizeSparkFiles({ root: '/models', relative: '', truncated: false,
    entries: [{ name: 'escape', relative: '../outside', directory: true, size: 0 }] }), /invalid status data/);
  assert.deepEqual(sanitizeSparkFolderListing({ path: '/models', parent: '/', folders: [{ name: 'Owner', path: '/models/Owner', secret: true }], shortcuts: [] }), {
    path: '/models', parent: '/', folders: [{ name: 'Owner', path: '/models/Owner' }], shortcuts: [],
  });
  assert.throws(() => sanitizeSparkFolderListing({ path: '/models', parent: '/', folders: {}, shortcuts: [] }), /invalid status data/);
  assert.throws(() => sanitizeSparkFolderListing({ path: '/models', parent: '/', folders: Array.from({ length: 501 }, (_, i) => ({ name: String(i), path: `/models/${i}` })), shortcuts: [] }), /invalid status data/);
});

test('every non-status companion response is action-typed before renderer handoff', () => {
  const hash = 'a'.repeat(40);
  assert.deepEqual(sanitizeSparkResponse('torrent:add', { infoHash: hash, name: 'model', secret: 'drop' }), { infoHash: hash, name: 'model' });
  assert.equal(sanitizeSparkResponse('inventory:sharing', true), true);
  assert.deepEqual(sanitizeSparkResponse('hf:add', ['b'.repeat(64)]), ['b'.repeat(64)]);
  assert.deepEqual(sanitizeSparkResponse('pairing:revoke', { revoked: true, privateKey: 'drop' }), { revoked: true });
  const identity = { repoId: 'owner/model', revision: 'c'.repeat(40), filePath: 'weights.gguf', size: 1, sha256: 'd'.repeat(64) };
  assert.deepEqual(sanitizeSparkResponse('hf:peer', { identity, metadata: 'YWJjZA==', peers: ['192.168.1.2:6881'], token: 'drop' }), {
    identity, metadata: 'YWJjZA==', peers: ['192.168.1.2:6881'],
  });
  assert.throws(() => sanitizeSparkResponse('torrent:add', { name: 'missing identity' }), /invalid status data/);
  assert.throws(() => sanitizeSparkResponse('torrent:remove', { ok: true }), /invalid status data/);
  assert.throws(() => sanitizeSparkResponse('hf:add', ['not-an-id']), /invalid status data/);
  assert.throws(() => sanitizeSparkResponse('unknown', {}), /invalid status data/);
});

test('the unauthenticated setup probe is copied through an exact bounded schema', () => {
  const probe = sanitizeSparkProbe({
    device: { hostname: 'spark', architecture: 'aarch64', platform: 'linux', home: '/home/alex', secret: 'drop', hardware: { vendor: 'NVIDIA', token: 'drop' } },
    downloadDir: '/home/alex/FrostByte', frigidLibrary: null,
    requirements: { dockerInstalled: true, dockerAccess: true, agentInstalled: false, containerConflict: false, desktopSession: true, secret: 'drop' },
    password: 'drop',
  });
  assert.deepEqual(probe, {
    device: { hostname: 'spark', architecture: 'aarch64', platform: 'linux', home: '/home/alex', hardware: { vendor: 'NVIDIA' } },
    downloadDir: '/home/alex/FrostByte', frigidLibrary: null,
    requirements: { dockerInstalled: true, dockerAccess: true, agentInstalled: false, containerConflict: false, desktopSession: true },
  });
  assert.throws(() => sanitizeSparkProbe({ device: { hostname: 'spark' }, downloadDir: '/models', requirements: {} }), /invalid status data/);
  assert.throws(() => sanitizeSparkProbe({ device: { hostname: 'spark', architecture: 'x64', platform: 'linux', home: '../../etc' }, downloadDir: '/models', requirements: { dockerInstalled: true, dockerAccess: true, agentInstalled: false, containerConflict: false, desktopSession: true } }), /invalid status data/);
});
