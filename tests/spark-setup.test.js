import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { generateSparkKeyPair } from '../src/main/spark.js';
import { SparkSetup, SPARK_PROBE_COMMAND, SPARK_FOLDERS_COMMAND, SPARK_PAIR_COMMAND } from '../src/main/spark-setup.js';
import { SPARK_RPC_COMMAND } from '../src/main/spark-pairing.js';
import { isCompanionCompatible, isCompanionCurrent } from '../src/shared/companion-protocol.js';
const device = { hostname: 'fixture-spark', architecture: 'aarch64', platform: 'linux', home: '/home/tester' };
const status = { version: '0.4.1', protocolVersion: 1, hostname: device.hostname, downloadDir: '/home/tester/FrostByte' };
function fixture(t, overrides = {}) {
  const calls = [], saved = [], progress = [];
  const setup = new SparkSetup({ bundleDir: '/bundled',
    expectedVersion: '0.4.1',
    inspect: async () => ({ hostKey: 'host-key', fingerprint: 'SHA256:fixture', hostKeyType: 'ssh-ed25519' }),
    execute: async (profile, command, options) => {
      calls.push({ profile, command, options });
      return { code: 0, stderr: '', stdout: JSON.stringify(command === SPARK_PROBE_COMMAND ? { device, downloadDir: status.downloadDir, requirements: { dockerInstalled: true, dockerAccess: true, agentInstalled: false, containerConflict: false, desktopSession: true } } : { ok: true }) };
    },
    request: async (profile, request) => { calls.push({ profile, request }); return status; },
    encryptKey: key => { assert.match(key, /BEGIN OPENSSH PRIVATE KEY/); return 'encrypted-fixture'; },
    saveConnection: (profile, host) => saved.push({ profile, host }),
    installer: async options => { calls.push({ installer: options }); return { status }; },
    onProgress: event => progress.push(event), ...overrides,
  });
  t.after(() => setup.shutdown());
  return { setup, calls, saved, progress };
}
const credentials = { mode: 'password', host: '192.0.2.2', username: 'tester', port: 22, password: 'fixture-secret' };
async function trusted(setup, binding) { return setup.probe({ ...credentials, trustFingerprint: 'SHA256:fixture' }, binding); }

test('unknown device asks for trust without executing authenticated commands or retaining password', async t => {
  const { setup, calls, saved } = fixture(t);
  const result = await setup.probe(credentials);
  assert.equal(result.stage, 'trust'); assert.equal(calls.length, 0); assert.equal(setup.sessions.size, 0); assert.equal(saved.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|host-key/);
});
test('fresh setup installs chosen external folder, verifies dedicated key, saves only encrypted credentials', async t => {
  const { setup, calls, saved } = fixture(t);
  const probe = await trusted(setup);
  assert.equal(probe.stage, 'review'); assert.doesNotMatch(JSON.stringify(probe), /fixture-secret/);
  const result = await setup.install({ sessionId: probe.sessionId, downloadDir: '/media/tester/External Models' });
  assert.equal(calls.find(call => call.installer).installer.downloadDir, '/media/tester/External Models');
  const verify = calls.find(call => call.request?.action === 'status');
  assert.equal(verify.profile.password, undefined); assert.match(verify.profile.privateKey, /OPENSSH PRIVATE KEY/);
  assert.equal(saved[0].profile.privateKeyEnc, 'encrypted-fixture'); assert.equal(result.host, 'tester@192.0.2.2');
  assert.doesNotMatch(JSON.stringify(saved), /fixture-secret|BEGIN OPENSSH/); assert.equal(setup.sessions.size, 0);
});
test('secure storage failure occurs before install or authorized_keys mutation', async t => {
  const { setup, calls, saved } = fixture(t, { encryptKey: () => { throw new Error('Keychain unavailable'); } });
  const probe = await trusted(setup);
  await assert.rejects(setup.install({ sessionId: probe.sessionId, downloadDir: '/models' }), /Keychain/);
  assert.equal(calls.length, 1); assert.equal(saved.length, 0);
});
test('key generation failure occurs before encryption, installation, or enrollment and remains retryable', async t => {
  let encrypted = false;
  const { setup, calls, saved } = fixture(t, {
    generateKeyPair: () => { throw new Error('Could not generate a valid Spark connection key. Try setup again.'); },
    encryptKey: () => { encrypted = true; return 'unused'; },
  });
  const probe = await trusted(setup);
  await assert.rejects(setup.install({ sessionId: probe.sessionId, downloadDir: '/models' }), /valid Spark connection key/);
  assert.equal(encrypted, false); assert.equal(calls.length, 1); assert.equal(saved.length, 0);
  assert.equal(setup.sessions.size, 1); assert.equal(setup.getSession(probe.sessionId).busy, false);
});
test('failed key verification removes only the newly added app key and retains retry session', async t => {
  const { setup, calls, saved } = fixture(t, { request: async () => { throw new Error('key login rejected'); } });
  const probe = await trusted(setup);
  await assert.rejects(setup.install({ sessionId: probe.sessionId, downloadDir: '/models' }), /key login/);
  const pairing = calls.filter(call => call.command === SPARK_PAIR_COMMAND).map(call => JSON.parse(call.options.input));
  assert.deepEqual(pairing.map(call => call.action), ['add', 'remove']); assert.equal(pairing[0].publicKey, pairing[1].publicKey);
  assert.equal(saved.length, 0); assert.equal(setup.sessions.size, 1);
});
test('existing SSH connection is stored without generating a password/key or reinstalling', async t => {
  const { setup, calls, saved } = fixture(t, { execute: async () => ({ code: 0, stdout: JSON.stringify({ device, downloadDir: '/models', requirements: { dockerInstalled: true, dockerAccess: true, agentInstalled: true, containerConflict: false, desktopSession: true } }) }), encryptKey: () => { throw new Error('must not encrypt'); } });
  const probe = await setup.probe({ mode: 'ssh', host: 'my-spark' });
  assert.equal(probe.stage, 'ready');
  await setup.connect({ sessionId: probe.sessionId });
  assert.deepEqual(saved, [{ profile: { mode: 'ssh', host: 'my-spark', runtime: 'docker' }, host: 'my-spark' }]); assert.ok(!calls.some(call => call.installer));
});
test('companion compatibility follows its protocol instead of the app release number', () => {
  assert.equal(isCompanionCompatible({ version: '12.7.3', protocolVersion: 1 }), true);
  assert.equal(isCompanionCompatible({ version: '0.4.0', protocolVersion: 2 }), false);
  assert.equal(isCompanionCompatible({ version: '0.5.0' }), false);
  assert.equal(isCompanionCompatible({ version: '0.3.1-forged/extra' }), false);
  assert.equal(isCompanionCompatible({ version: '0.3.1' }), true, 'the installed pre-protocol companion remains upgradeable');
  assert.equal(isCompanionCompatible({ version: '0.2.0-beta.16' }), true, 'early beta companions remain upgradeable');
  assert.equal(isCompanionCurrent({ version: '0.4.1' }, '0.4.1'), false, 'a same-version pre-protocol build is still updated');
  assert.equal(isCompanionCurrent({ version: '0.4.1', protocolVersion: 1 }, '0.4.1'), true);
});
test('a version-locked companion setup accepts its current protocol companion', async t => {
  const { setup, saved } = fixture(t, {
    requireCurrent: true,
    execute: async () => ({ code: 0, stdout: JSON.stringify({ device, downloadDir: '/models', requirements: {
      dockerInstalled: true, dockerAccess: true, agentInstalled: true, containerConflict: false, desktopSession: true,
    } }) }),
  });
  const probe = await setup.probe({ mode: 'ssh', host: 'my-spark' });
  assert.equal(probe.stage, 'ready');
  assert.equal(probe.requirements.agentCompatible, true);
  assert.equal(probe.requirements.agentCurrent, true);
  await setup.connect({ sessionId: probe.sessionId });
  assert.equal(saved.length, 1);
});
test('a version-locked companion setup updates a compatible older companion before saving the device', async t => {
  let checks = 0;
  const { setup, saved, calls } = fixture(t, {
    requireCurrent: true,
    execute: async () => ({ code: 0, stdout: JSON.stringify({ device, downloadDir: '/models', requirements: {
      dockerInstalled: true, dockerAccess: true, agentInstalled: true, containerConflict: false, desktopSession: true,
    } }) }),
    request: async () => ++checks === 1
      ? { version: '0.4.0', hostname: device.hostname, downloadDir: '/models' }
      : status,
  });
  const probe = await setup.probe({ mode: 'ssh', host: 'my-spark' });
  assert.equal(probe.stage, 'review');
  assert.equal(probe.requirements.agentCompatible, true);
  assert.equal(probe.requirements.agentCurrent, false);
  await assert.rejects(setup.connect({ sessionId: probe.sessionId }), /current companion/);
  await setup.install({ sessionId: probe.sessionId, downloadDir: '/models' });
  assert.ok(calls.some(call => call.installer));
  assert.equal(saved.length, 1);
});
test('a version-locked companion setup refuses to save when an update did not install the bundled version', async t => {
  let checks = 0;
  const { setup, saved } = fixture(t, {
    requireCurrent: true,
    execute: async () => ({ code: 0, stdout: JSON.stringify({ device, downloadDir: '/models', requirements: {
      dockerInstalled: true, dockerAccess: true, agentInstalled: true, containerConflict: false, desktopSession: true,
    } }) }),
    request: async () => ++checks === 1
      ? { version: '0.4.0', hostname: device.hostname, downloadDir: '/models' }
      : { ...status, version: '0.4.2' },
  });
  const probe = await setup.probe({ mode: 'ssh', host: 'my-spark' });
  await assert.rejects(setup.install({ sessionId: probe.sessionId, downloadDir: '/models' }), /not compatible with this edition/);
  assert.equal(saved.length, 0);
});
test('concurrent probes cannot invalidate the session returned by the first request', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { setup } = fixture(t, { execute: async () => {
    entered(); await held;
    return { code: 0, stdout: JSON.stringify({ device, downloadDir: '/models', requirements: {
      dockerInstalled: true, dockerAccess: true, agentInstalled: false, containerConflict: false, desktopSession: true,
    } }) };
  } });
  const first = setup.probe({ mode: 'ssh', host: 'first-spark' });
  await started;
  await assert.rejects(setup.probe({ mode: 'ssh', host: 'second-spark' }), /Another device setup is running/);
  release();
  const result = await first;
  assert.equal(setup.getSession(result.sessionId).profile.host, 'first-spark');
  assert.equal(setup.sessions.size, 1);
});
test('shutdown cannot let a late probe status response return a deleted session', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { setup } = fixture(t, {
    execute: async () => ({ code: 0, stdout: JSON.stringify({ device, downloadDir: '/models', requirements: {
      dockerInstalled: true, dockerAccess: true, agentInstalled: true, containerConflict: false, desktopSession: true,
    } }) }),
    request: async () => { entered(); await held; return status; },
  });
  const probing = setup.probe({ mode: 'ssh', host: 'first-spark' });
  await started;
  const shutdown = setup.shutdown();
  release();
  await assert.rejects(probing, /abort/i);
  await shutdown;
  assert.equal(setup.sessions.size, 0);
});
test('missing Docker and unsupported device cannot install', async t => {
  const { setup, calls } = fixture(t, { execute: async () => ({ code: 0, stdout: JSON.stringify({ device: { ...device, architecture: 'x86_64' }, downloadDir: '/models', requirements: { dockerInstalled: false, dockerAccess: false, agentInstalled: false, containerConflict: false, desktopSession: true } }) }) });
  const probe = await trusted(setup); assert.equal(probe.stage, 'requirements');
  await assert.rejects(setup.install({ sessionId: probe.sessionId, downloadDir: '/models' }), /requirements/);
  assert.ok(!calls.some(call => call.installer));
});
test('cancelled install waits for rollback and does not save connection', async t => {
  let entered, done;
  const started = new Promise(resolve => { entered = resolve; });
  const rolledBack = new Promise(resolve => { done = resolve; });
  const { setup, saved } = fixture(t, { installer: async ({ signal, execute }) => {
    entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await execute('rollback', {}); done(); throw new Error('cancelled');
  }, execute: async (profile, command, options) => {
    if (command === 'rollback') { assert.equal(options.signal, undefined); return { code: 0, stdout: '{}' }; }
    return { code: 0, stdout: JSON.stringify({ device, downloadDir: '/models', requirements: { dockerInstalled: true, dockerAccess: true, agentInstalled: false, containerConflict: false, desktopSession: true } }) };
  } });
  const probe = await trusted(setup), run = setup.install({ sessionId: probe.sessionId, downloadDir: '/models' });
  await started; const cancelled = setup.cancel(probe.sessionId);
  await assert.rejects(run, /cancelled/); await cancelled; await rolledBack;
  assert.equal(saved.length, 0); assert.equal(setup.sessions.size, 0);
});
test('shutdown reports a busy setup whose remote rollback fails', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { setup } = fixture(t, { installer: async ({ signal }) => {
    entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('Device setup cancelled. The previous service could not be restored automatically: rollback failed');
  } });
  const probe = await trusted(setup);
  const run = setup.install({ sessionId: probe.sessionId, downloadDir: '/models' });
  const runFailure = assert.rejects(run, /rollback failed/);
  await started;
  await assert.rejects(setup.shutdown(), error => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.message, /could not be cleaned up/i);
    assert.match(error.errors[0].message, /rollback failed/);
    return true;
  });
  await runFailure;
  assert.equal(setup.sessions.size, 0);
  assert.equal(setup.pending.size, 0);
});
test('expired setup refuses actions and drops credentials', async t => {
  const { setup } = fixture(t); const probe = await trusted(setup);
  setup.sessions.get(probe.sessionId).expires = 0;
  await assert.rejects(setup.connect({ sessionId: probe.sessionId }), /expired/);
  await setup.cancel(probe.sessionId); assert.equal(setup.sessions.size, 0);
});
test('adding storage uses existing authentication and retains selected path as data', async t => {
  const { setup, calls } = fixture(t);
  await setup.addStorage({ mode: 'ssh', host: 'my-spark' }, { downloadDir: '/media/Models with spaces' }, 'my-spark');
  const options = calls.find(call => call.installer).installer;
  assert.equal(options.addStorage, true); assert.equal(options.downloadDir, '/media/Models with spaces');
});
test('managed storage consumes only a matching approved password session and uses the storage installer path', async t => {
  const { setup, calls, saved } = fixture(t);
  const probe = await trusted(setup, { purpose: 'add-storage', deviceId: 'device-a' });
  const paired = { mode: 'password', host: credentials.host, username: credentials.username, port: credentials.port,
    hostKey: 'host-key', privateKey: 'dedicated-app-key' };
  await assert.rejects(setup.install({ sessionId: probe.sessionId, downloadDir: '/media/Models' }), /only be used.*storage/i);
  await assert.rejects(setup.addStorageFromSession(probe.sessionId, 'device-b', paired, { downloadDir: '/media/Models' }, 'fixture'), /does not match/);
  await assert.rejects(setup.addStorageFromSession(probe.sessionId, 'device-a', { ...paired, host: '192.0.2.99' }, { downloadDir: '/media/Models' }, 'fixture'), /does not match/);
  assert.equal(calls.some(call => call.installer), false, 'a session for another saved device cannot mutate storage');
  await setup.addStorageFromSession(probe.sessionId, 'device-a', paired, { downloadDir: '/media/Models with spaces' }, 'fixture');
  const options = calls.find(call => call.installer).installer;
  assert.equal(options.addStorage, true); assert.equal(options.downloadDir, '/media/Models with spaces');
  assert.equal(saved.length, 0, 'the password profile is never persisted');
  assert.equal(setup.sessions.size, 0, 'the password session is consumed after the storage attempt');
  assert.doesNotMatch(JSON.stringify(calls), /fixture-secret/);
});
test('managed update authorization is device-bound and cannot be downgraded to connect-only', async t => {
  const { setup, calls, saved } = fixture(t);
  const probe = await trusted(setup, { purpose: 'update-device', deviceId: 'device-a' });
  await assert.rejects(setup.connect({ sessionId: probe.sessionId }), /only be used.*device update/i);
  await setup.install({ sessionId: probe.sessionId, downloadDir: '/home/tester/FrostByte' });
  const install = calls.find(call => call.installer)?.installer;
  assert.equal(install.downloadDir, '/home/tester/FrostByte');
  assert.equal(install.addStorage, undefined);
  assert.equal(saved.length, 1);
});
test('folder browsing rejects malformed remote listings for setup and paired devices', async t => {
  const { setup } = fixture(t);
  const probe = await trusted(setup);
  setup.execute = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ path: '/models', parent: '/', folders: 'wrong', shortcuts: [] }) });
  await assert.rejects(setup.folders({ sessionId: probe.sessionId, path: '/models' }), /Could not read the device folder list/);
  setup.request = async () => ({ path: '/models', parent: '/', folders: [{ name: 'ok', path: '/models/ok' }], shortcuts: {} });
  await assert.rejects(setup.folders({ path: '/models' }, { mode: 'password', privateKey: 'paired' }), /invalid status data/);
});
test('setup folder browser stays within the account home and mounted storage roots', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'fb-folders-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'Models'));
  await fs.symlink('/etc', path.join(home, 'escape'));
  const run = requested => spawnSync('/bin/sh', ['-c', SPARK_FOLDERS_COMMAND], {
    input: JSON.stringify({ path: requested }), env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  const listed = run(home);
  assert.equal(listed.status, 0, listed.stderr);
  const data = JSON.parse(listed.stdout);
  assert.equal(data.path, home);
  assert.equal(data.parent, home);
  assert.ok(data.folders.some(entry => entry.name === 'Models'));
  assert.ok(!data.folders.some(entry => entry.name === 'escape'), 'folder discovery must not list directory links');
  assert.notEqual(run('/etc').status, 0, 'setup credentials cannot browse arbitrary system folders');
  assert.notEqual(run(path.join(home, 'escape')).status, 0, 'a link cannot escape the account home');
  const mountedRoot = ['/Volumes', '/media', '/mnt', '/run/media'].find(candidate => data.shortcuts.some(entry => entry.path === candidate));
  assert.ok(mountedRoot, 'the test host exposes a supported mounted-storage root');
  assert.equal(run(mountedRoot).status, 0, 'mounted storage remains selectable');
  assert.notEqual(run(home + '/bad\u007fpath').status, 0, 'control characters are rejected remotely');
});
test('app-managed keys cannot run companion installers or storage changes', async t => {
  const { setup, calls } = fixture(t);
  await assert.rejects(setup.addStorage({ mode: 'password', host: '192.0.2.4', username: 'tester', port: 22,
    privateKey: 'private', publicKey: 'ssh-ed25519 AAAAfixture' }, { downloadDir: '/models' }, 'tester@192.0.2.4'), /password.*dedicated FrostByte key/i);
  assert.equal(calls.length, 0);
});
test('pairing key updates are atomic across write, fsync, replace, and path races', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'fb-pair-atomic-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const ssh = path.join(home, '.ssh'); await fs.mkdir(ssh);
  const file = path.join(ssh, 'authorized_keys');
  const unrelated = Buffer.from('# existing account keys\r\nssh-ed25519 AAAAexisting user-key keep-this-comment\r\n');
  await fs.writeFile(file, unrelated);
  const publicKey = generateSparkKeyPair('frostbyte-atomic-test').public.trim();
  const normal = action => spawnSync('/bin/sh', ['-c', SPARK_PAIR_COMMAND], {
    input: JSON.stringify({ action, publicKey }), env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  const sentinel = path.join(home, 'lock-sentinel'); await fs.writeFile(sentinel, 'unchanged');
  const lockFile = path.join(ssh, '.frostbyte-authorized-keys.lock'); await fs.symlink(sentinel, lockFile);
  assert.notEqual(normal('add').status, 0, 'a linked pairing lock must be rejected');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  assert.ok((await fs.readFile(file)).equals(unrelated));
  await fs.unlink(lockFile);
  assert.equal(normal('add').status, 0);
  const lockAlias = path.join(ssh, '.frostbyte-authorized-keys.lock.alias'); await fs.link(lockFile, lockAlias);
  assert.notEqual(normal('remove').status, 0, 'a multiply linked pairing lock must be rejected');
  await fs.unlink(lockAlias);
  const installed = await fs.readFile(file);
  assert.ok(installed.subarray(0, unrelated.length).equals(unrelated), 'unrelated bytes survive publication exactly');
  const helperName = installed.toString().match(/(bridge-[a-f0-9]{24}\.py)/)[1];
  const helper = path.join(ssh, 'frostbyte', helperName);
  const commandSource = Buffer.from(SPARK_PAIR_COMMAND.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1], 'base64');
  const faultHarness = String.raw`
import base64,os,sys
source=base64.b64decode(sys.argv[1]); mode=sys.argv[2]; seen=[False]
real_write=os.write; real_fsync=os.fsync; real_replace=os.replace
if mode=='write':
 def broken_write(fd,data):
  if not seen[0]:
   seen[0]=True; real_write(fd,data[:max(1,len(data)//2)]); raise OSError('injected write failure')
  return real_write(fd,data)
 os.write=broken_write
elif mode=='fsync':
 def broken_fsync(fd):
  if not seen[0]: seen[0]=True; raise OSError('injected fsync failure')
  return real_fsync(fd)
 os.fsync=broken_fsync
elif mode=='replace':
 def broken_replace(*args,**kwargs):
  if not seen[0]: seen[0]=True; raise OSError('injected replace failure')
  return real_replace(*args,**kwargs)
 os.replace=broken_replace
elif mode=='race':
 def racing_fsync(fd):
  result=real_fsync(fd)
  if not seen[0]:
   seen[0]=True
   with open(os.path.expanduser('~/.ssh/authorized_keys'),'ab') as changed: changed.write(b'# concurrent change\n'); changed.flush(); real_fsync(changed.fileno())
  return result
 os.fsync=racing_fsync
exec(compile(source,'frostbyte-pairing-fixture.py','exec'))
`;
  const injected = (source, request, mode) => spawnSync('python3', ['-c', faultHarness, source.toString('base64'), mode], {
    input: JSON.stringify(request), env: { ...process.env, HOME: home, SSH_ORIGINAL_COMMAND: SPARK_RPC_COMMAND }, encoding: 'utf8',
  });
  for (const mode of ['write', 'fsync', 'replace', 'race']) {
    await fs.writeFile(file, installed);
    const failed = injected(commandSource, { action: 'remove', publicKey }, mode);
    assert.notEqual(failed.status, 0, `pair command ${mode} failure must be reported`);
    const expected = mode === 'race' ? Buffer.concat([installed, Buffer.from('# concurrent change\n')]) : installed;
    assert.ok((await fs.readFile(file)).equals(expected), `pair command ${mode} failure must not publish its candidate`);
  }
  const helperSource = await fs.readFile(helper);
  for (const mode of ['write', 'fsync', 'replace', 'race']) {
    await fs.writeFile(file, installed);
    const failed = injected(helperSource, { action: 'pairing:revoke' }, mode);
    assert.notEqual(failed.status, 0, `bridge revoke ${mode} failure must be reported`);
    const expected = mode === 'race' ? Buffer.concat([installed, Buffer.from('# concurrent change\n')]) : installed;
    assert.ok((await fs.readFile(file)).equals(expected), `bridge revoke ${mode} failure must not publish its candidate`);
  }
  await fs.writeFile(file, installed);
  const revoked = spawnSync('python3', [helper], { input: JSON.stringify({ action: 'pairing:revoke' }),
    env: { ...process.env, HOME: home, SSH_ORIGINAL_COMMAND: SPARK_RPC_COMMAND }, encoding: 'utf8' });
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.ok((await fs.readFile(file)).equals(unrelated), 'successful revoke preserves every unrelated byte');
  assert.deepEqual((await fs.readdir(ssh)).filter(name => name.startsWith('.authorized_keys.frostbyte-')), []);
});
test('shipped pairing helper preserves existing keys and safely removes its own key', async t => {
  // Keep the companion socket below macOS's short AF_UNIX path limit.
  const home = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'fb-pair-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.ssh'));
  const file = path.join(home, '.ssh/authorized_keys');
  await fs.writeFile(file, '# existing account keys\nssh-ed25519 AAAAexisting user-key');
  const publicKey = generateSparkKeyPair('frostbyte-test').public.trim();
  const run = action => spawnSync('/bin/sh', ['-c', SPARK_PAIR_COMMAND], { input: JSON.stringify({ action, publicKey }), env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(run('add').status, 0); assert.equal(run('add').status, 0);
  let paired = await fs.readFile(file, 'utf8'); assert.equal(paired.split(publicKey).length, 2);
  assert.match(paired, /restrict,command="cd && exec python3 \.ssh\/frostbyte\/bridge-[a-f0-9]{24}\.py" ssh-ed25519 /);
  const helperName = paired.match(/\.ssh\/frostbyte\/(bridge-[a-f0-9]{24}\.py)/)[1];
  const helper = path.join(home, '.ssh/frostbyte', helperName);
  assert.equal((await fs.stat(helper)).mode & 0o777, 0o600);
  const bridge = (request, original = SPARK_RPC_COMMAND) => spawnSync('python3', [helper], { cwd: home, input: JSON.stringify(request),
    env: { ...process.env, HOME: home, SSH_ORIGINAL_COMMAND: original }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(bridge({ action: 'pairing:ping' }).stdout), { ok: true, data: { restricted: true } });
  assert.deepEqual(JSON.parse(bridge({ action: 'pairing:ping' }, 'docker exec -i frostbyte-beta node /app/src/agent/client.js').stdout), { ok: true, data: { restricted: true } }, 'older desktop releases retain bounded companion access');
  assert.notEqual(bridge({ action: 'pairing:ping' }, 'id').status, 0, 'arbitrary original commands must be rejected');
  await fs.mkdir(path.join(home, 'Models')); await fs.mkdir(path.join(home, 'Outside')); await fs.symlink(path.join(home, 'Outside'), path.join(home, 'Models link'));
  const listed = JSON.parse(bridge({ action: 'host:folders', path: home }).stdout).data;
  assert.ok(listed.folders.some(entry => entry.name === 'Models'));
  assert.ok(!listed.folders.some(entry => entry.name === 'Models link'), 'folder discovery must not follow directory links');
  assert.equal(listed.parent, home, 'folder discovery cannot navigate above an approved root');
  assert.notEqual(bridge({ action: 'host:folders', path: '/etc' }).status, 0, 'the restricted key cannot browse arbitrary account-readable system folders');
  const state = path.join(home, '.local/share/frostbyte-beta/state'); await fs.mkdir(state, { recursive: true });
  const socket = path.join(state, 'control.sock');
  const server = spawn('python3', ['-c', `import json,os,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o600);s.listen(1);print('ready',flush=True)
c,_=s.accept();raw=b''
while b'\\n' not in raw: raw+=c.recv(65536)
request=json.loads(raw);c.sendall((json.dumps({'ok':True,'data':{'hostname':'socket-fixture','action':request['action']}})+'\\n').encode());c.close();s.close()`, socket], { stdio: ['ignore', 'pipe', 'pipe'] });
  const serverClosed = once(server, 'close'); t.after(() => server.kill()); await once(server.stdout, 'data');
  assert.deepEqual(JSON.parse(bridge({ action: 'status' }).stdout).data, { hostname: 'socket-fixture', action: 'status' });
  await serverClosed;
  // Upgrade the exact beta.11-beta.15 legacy line without duplicating the key.
  await fs.writeFile(file, '# existing account keys\nssh-ed25519 AAAAexisting user-key\nrestrict ' + publicKey + '\n');
  assert.equal(run('migrate').status, 0);
  paired = await fs.readFile(file, 'utf8'); assert.match(paired, /restrict,command=/); assert.equal(paired.split(publicKey).length, 2);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const revoked = bridge({ action: 'pairing:revoke' });
  assert.equal(revoked.status, 0); assert.deepEqual(JSON.parse(revoked.stdout), { ok: true, data: { revoked: true } });
  assert.equal((await fs.readFile(file, 'utf8')).trim(), '# existing account keys\nssh-ed25519 AAAAexisting user-key');
  await assert.rejects(fs.stat(helper), { code: 'ENOENT' });
  assert.equal(run('add').status, 0); assert.equal(run('remove').status, 0);
  await fs.unlink(file); const outside = path.join(home, 'authorized-keys-target'); await fs.writeFile(outside, 'unchanged'); await fs.symlink(outside, file);
  assert.notEqual(run('add').status, 0); assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged');
});
test('shipped pairing helper relays the reply of the real companion', { timeout: 60000 }, async t => {
  // Keep the companion socket below macOS's short AF_UNIX path limit.
  const home = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'fb-pair-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.ssh'));
  const file = path.join(home, '.ssh/authorized_keys');
  await fs.writeFile(file, '');
  const publicKey = generateSparkKeyPair('frostbyte-test').public.trim();
  const added = spawnSync('/bin/sh', ['-c', SPARK_PAIR_COMMAND], { input: JSON.stringify({ action: 'add', publicKey }), env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  const helper = path.join(home, '.ssh/frostbyte', (await fs.readFile(file, 'utf8')).match(/\.ssh\/frostbyte\/(bridge-[a-f0-9]{24}\.py)/)[1]);
  const companion = spawn(process.execPath, [fileURLToPath(new URL('../src/agent/server.js', import.meta.url))], {
    env: { ...process.env, FROSTBYTE_AGENT_HOME: path.join(home, '.local/share/frostbyte-beta/state'), FROSTBYTE_DOWNLOAD_DIR: path.join(home, 'models'), FROSTBYTE_AGENT_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (companion.exitCode !== null || companion.signalCode !== null) return;
    const closed = once(companion, 'exit'); companion.kill('SIGTERM'); await closed;
  });
  let ready = '', log = '';
  companion.stderr.on('data', chunk => { log += chunk; });
  await new Promise((resolve, reject) => {
    companion.once('exit', code => reject(new Error(`Companion exited with ${code}: ${log}`)));
    companion.stdout.on('data', chunk => { ready += chunk; if (ready.includes('agent ready')) resolve(); });
  });
  // `status` awaits real I/O in the companion, so its reply arrives after the helper has sent the whole request.
  const reply = spawnSync('python3', [helper], { cwd: home, input: JSON.stringify({ action: 'status' }),
    env: { ...process.env, HOME: home, SSH_ORIGINAL_COMMAND: SPARK_RPC_COMMAND }, encoding: 'utf8', timeout: 30000 });
  assert.equal(reply.status, 0, reply.stderr);
  const result = JSON.parse(reply.stdout);
  assert.equal(result.ok, true);
  assert.equal(typeof result.data.protocolVersion, 'number');
});
