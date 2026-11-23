import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { installSparkCompanion, configureSparkStorage, SPARK_INSTALL_COMMAND, validateSparkDownloadDir } from '../src/main/spark-installer.js';

const root = path.resolve(import.meta.dirname, '..');
const bundleDir = path.join(root, 'build/spark-companion');
execFileSync(process.execPath, [path.join(root, 'scripts/build-spark-bundle.js')]);
const manifest = JSON.parse(await fs.readFile(path.join(bundleDir, 'manifest.json'), 'utf8'));
const status = { version: manifest.version, hostname: 'test-spark', downloadDir: '/srv/models' };
const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' });

function stub(options = {}) {
  const calls = [];
  return { calls, execute: async (command, args) => {
    assert.equal(command, SPARK_INSTALL_COMMAND);
    const payload = JSON.parse(args.input);
    calls.push({ action: payload.action, signal: args.signal, payload });
    await options.visit?.(payload.action, args);
    return ok(payload.action === 'activate' ? { status } : true);
  } };
}

test('bundled setup uses fixed commands, integrity checked payload, and supplied directory as data', async () => {
  const remote = stub();
  const progress = [];
  const folder = '/srv/model files; $(do-not-run)';
  const result = await installSparkCompanion({ ...remote, bundleDir, downloadDir: folder, onProgress: event => progress.push(event.stage) });
  assert.deepEqual(result, { status });
  assert.deepEqual(remote.calls.map(call => call.action), ['prepare', 'build', 'activate', 'finalize']);
  assert.equal(remote.calls[0].payload.downloadDir, folder);
  assert.ok(remote.calls[0].payload.archive);
  assert.equal(remote.calls[1].payload.archive, undefined);
  assert.deepEqual(progress, ['preparing', 'building', 'activating', 'ready']);
});

test('installer rejects unbounded or non-canonical remote folders before execution', async () => {
  for (const downloadDir of ['/srv/../etc', '/srv/models\nother', '/' + 'x'.repeat(4096)]) {
    const remote = stub();
    await assert.rejects(installSparkCompanion({ ...remote, bundleDir, downloadDir }), /absolute download folder/);
    assert.equal(remote.calls.length, 0);
  }
});

test('Docker storage cannot shadow the app, state, or hardened temporary filesystem', async () => {
  for (const downloadDir of ['/', '/app', '/app/models', '/state', '/state/models', '/tmp', '/tmp/models']) {
    const remote = stub();
    await assert.rejects(installSparkCompanion({ ...remote, bundleDir, downloadDir }), /runtime folders/);
    assert.equal(remote.calls.length, 0);
  }
  assert.equal(validateSparkDownloadDir('/tmp/models', 'mac-native'), '/tmp/models');
});

test('cancelled build leaves activation untouched and cleans staging', async () => {
  const controller = new AbortController();
  const remote = stub({ visit: action => { if (action === 'build') controller.abort(); } });
  await assert.rejects(installSparkCompanion({ ...remote, bundleDir, downloadDir: '/srv/models', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(remote.calls.map(call => call.action), ['prepare', 'build', 'cleanup']);
  assert.equal(remote.calls[1].signal, controller.signal);
  assert.equal(remote.calls[2].signal, undefined);
});

test('cancel during activation finishes the critical operation then restores the previous service', async () => {
  const controller = new AbortController();
  const remote = stub({ visit: action => { if (action === 'activate') controller.abort(); } });
  await assert.rejects(installSparkCompanion({ ...remote, bundleDir, downloadDir: '/srv/models', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(remote.calls.map(call => call.action), ['prepare', 'build', 'activate', 'rollback', 'cleanup']);
  for (const call of remote.calls.slice(2)) assert.equal(call.signal, undefined);
});

test('modified bundle is rejected before any remote command', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-bundle-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.cp(bundleDir, temporary, { recursive: true });
  await fs.appendFile(path.join(temporary, 'source.tar.gz'), 'changed');
  const remote = stub();
  await assert.rejects(installSparkCompanion({ ...remote, bundleDir: temporary, downloadDir: '/srv/models' }), /integrity/);
  assert.equal(remote.calls.length, 0);
});

test('remote installer state writes and activation lock do not follow links', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-spark-state-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const probe = String.raw`
import json,os,sys
from pathlib import Path
source=Path(sys.argv[1]).read_text()
namespace={}
exec(compile(source.split("\nif payload.get('action')",1)[0],sys.argv[1],'exec'),namespace)
root=Path(sys.argv[2])/'root'; root.mkdir()
namespace['ROOT']=root
victim=root/'outside-sentinel'; victim.write_text('do not replace')
target=root/'activation.json'
legacy=target.with_suffix('.tmp'); legacy.symlink_to(victim)
namespace['save_json'](target,{'phase':'prepared'})
assert json.loads(target.read_text())=={'phase':'prepared'}
assert legacy.is_symlink() and victim.read_text()=='do not replace'
assert target.stat().st_mode & 0o777 == 0o600
lock=root/'activation.lock'; lock.symlink_to(victim)
try:
    namespace['activation_lock'](wait=0)
except RuntimeError as error:
    assert 'activation lock' in str(error)
else:
    raise AssertionError('activation lock followed a symbolic link')
assert victim.read_text()=='do not replace'
lock.unlink()
with namespace['activation_lock'](wait=0): pass
os.link(lock,root/'activation.lock.alias')
try:
    namespace['activation_lock'](wait=0)
except RuntimeError as error:
    assert 'activation lock' in str(error)
else:
    raise AssertionError('activation lock accepted a multiply-linked file')
`;
  execFileSync('python3', ['-c', probe, path.join(root, 'build/spark-onboard.py'), temporary]);
});

// Runs the actual shipped Python installer, replacing only Docker and the host's identity.
// Filesystem staging, archive validation, snapshots, rollback and health parsing are real.
const harness = String.raw`
import base64,csv,fcntl,json,os,platform,subprocess,sys,time
from pathlib import Path
platform.system=lambda: 'Linux'
platform.machine=lambda: 'aarch64'
Path.home=classmethod(lambda cls: Path(os.environ['FROSTBYTE_INSTALL_TEST_HOME']))
home=Path.home()
dbfile=home/'docker.json'
def save_db(db):
    # Docker exposes completed operations, never a truncated daemon-state file.
    pending=dbfile.with_name(dbfile.name+'.'+str(os.getpid())+'.pending')
    serialized=json.dumps(db)
    with pending.open('w') as stream:
        if db.get('slowDbWrites'):
            midpoint=len(serialized)//2
            stream.write(serialized[:midpoint]); stream.flush()
            time.sleep(0.02)  # Exercise readers while the replacement is incomplete.
            stream.write(serialized[midpoint:])
        else:
            stream.write(serialized)
    os.replace(pending,dbfile)
def fake_run(args, input=None, text=None, capture_output=None, timeout=None, stdout=None, stderr=None):
    # Each fake Docker command is one transaction, including detached watchdog calls.
    with (home/'docker.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        return fake_run_locked(args)
def fake_run_locked(args):
    db=json.loads(dbfile.read_text())
    db.setdefault('commands',[]).append(args)
    out=''; err=''; code=0
    if args==['nvidia-smi','--query-gpu=name','--format=csv,noheader']: out='NVIDIA GB10\n'
    elif args[1]=='info': out='"aarch64"'
    elif args[1:3]==['container','inspect']:
        item=db['containers'].get(args[3])
        if item: out=json.dumps([item])
        else: code=1; err='Error: No such container: '+args[3]
    elif args[1]=='stop': db['containers'][args[-1]]['State']['Running']=False
    elif args[1]=='start': db['containers'][args[-1]]['State']['Running']=True
    elif args[1]=='rename': db['containers'][args[3]]=db['containers'].pop(args[2])
    elif args[1]=='rm':
        if db.get('failRemove'): code=1; err='Simulated backup cleanup failure'
        else: db['containers'].pop(args[2],None)
    elif args[1]=='run':
        env=[]; labels={}; mounts=[]
        for index,value in enumerate(args):
            if value=='--env': env.append(args[index+1])
            if value=='--label':
                key,val=args[index+1].split('=',1); labels[key]=val
            if value=='--mount':
                entry=dict(item.split('=',1) for item in next(csv.reader([args[index+1]])))
                mounts.append({'Source':entry['src'],'Destination':entry['dst']})
        db['containers']['frostbyte-beta']={'Id':'new-agent','Config':{'Labels':labels,'Env':env},'State':{'Running':True},'Mounts':mounts}
        # Simulate a new process changing persisted state before its health result.
        (home/'.local/share/frostbyte-beta/state/agent.json').write_text('{"newVersion":true}')
        if db.get('killDuringStart'):
            save_db(db); os.kill(os.getpid(),9)
        if db.get('failStart'): code=1; err='Simulated startup failure'
    elif args[1]=='exec':
        item=db['containers']['frostbyte-beta']; env=dict(value.split('=',1) for value in item['Config']['Env'])
        out=json.dumps({'ok':True,'data':{'version':item['Config']['Labels']['ai.blackfrost.frostbyte.version'],'downloadDir':env['FROSTBYTE_DOWNLOAD_DIR'],'hostname':'controlled-spark','storageRoots':json.loads(env.get('FROSTBYTE_STORAGE_ROOTS','[]')),'storage':[{'path':root,'available':True} for root in json.loads(env.get('FROSTBYTE_STORAGE_ROOTS','[]'))]}})
    elif args[1]=='build':
        db['runningWhileBuilding']=db['containers'].get('frostbyte-beta',{}).get('State',{}).get('Running',False)
        image=args[args.index('-t')+1]
        db.setdefault('images',{})[image]={'built':True}
    elif args[1:3]==['image','rm']:
        if db.get('failImageRemove'): code=1; err='Simulated image cleanup failure'
        else: db.setdefault('images',{}).pop(args[3],None)
    else: raise RuntimeError('Unexpected Docker operation: '+repr(args))
    save_db(db)
    return subprocess.CompletedProcess(args,code,out,err)
subprocess.run=fake_run
original_popen=subprocess.Popen
def fake_popen(args, **kwargs):
    # Keep the detached watchdog real, but give it the same controlled Docker implementation.
    if json.loads(dbfile.read_text()).get('disableWatchdog'): return None
    return original_popen([sys.executable,'-c',os.environ['FROSTBYTE_INSTALL_TEST_HARNESS'],args[-1]], **kwargs)
subprocess.Popen=fake_popen
payload=json.load(open(sys.argv[1])) if len(sys.argv)>1 else json.load(sys.stdin)
exec(compile(base64.b64decode(payload['installer']), 'frostbyte-onboard.py', 'exec'))
`;

async function controlled(t, { existing = true, unrelated = false, unlabelled = false, extraMount = false, legacyBind = false, failStart = false, failRemove = false, failImageRemove = false, killDuringStart = false, disableWatchdog = false, slowDbWrites = false } = {}) {
  // Docker mounts keep the host path as their destination. Linux /tmp is a
  // protected companion mount, so use an owned disposable account directory.
  const parent = process.platform === 'linux' ? os.homedir() : os.tmpdir();
  const home = await fs.realpath(await fs.mkdtemp(path.join(parent, '.fb-spark-install-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = path.join(home, '.local/share/frostbyte-beta/state');
  const downloadDir = path.join(home, 'models with spaces, punctuation');
  await fs.mkdir(state, { recursive: true });
  await fs.mkdir(downloadDir, { recursive: true });
  await fs.writeFile(path.join(downloadDir, 'keep-model.bin'), 'existing downloaded bytes');
  await fs.writeFile(path.join(state, 'agent.json'), '{"existingTransfer":true}');
  const unexpectedMount = path.join(home, 'unexpected writable mount');
  if (extraMount) await fs.mkdir(unexpectedMount);
  const old = { Id: unlabelled ? 'a'.repeat(64) : 'old-agent', Config: { Labels: unlabelled ? {} : { 'ai.blackfrost.frostbyte': unrelated ? 'different-app' : 'agent' },
    Image: 'frostbyte-agent:legacy', Cmd: ['node', 'src/agent/server.js'], Env: ['FROSTBYTE_DOWNLOAD_DIR=' + (legacyBind ? '/downloads' : downloadDir)] }, State: { Running: true }, Mounts: [
    { Source: state, Destination: '/state' },
    ...(legacyBind ? [{ Type: 'bind', Source: downloadDir, Destination: '/downloads', RW: true }] : []),
    ...(extraMount ? [{ Source: unexpectedMount, Destination: '/unexpected' }] : []),
  ] };
  const dbfile = path.join(home, 'docker.json');
  await fs.writeFile(dbfile, JSON.stringify({ containers: existing ? { 'frostbyte-beta': old } : {}, images: {}, failStart, failRemove, failImageRemove, killDuringStart, disableWatchdog, slowDbWrites }));
  const execute = (command, { input }) => new Promise((resolve, reject) => {
    assert.equal(command, SPARK_INSTALL_COMMAND);
    const child = spawn('python3', ['-c', harness], { env: { ...process.env, FROSTBYTE_INSTALL_TEST_HOME: home, FROSTBYTE_INSTALL_TEST_HARNESS: harness } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
  return { home, state, downloadDir, unexpectedMount, execute, db: async () => JSON.parse(await fs.readFile(dbfile, 'utf8')) };
}

async function callControlledInstaller(host, request) {
  const result = await host.execute(SPARK_INSTALL_COMMAND, { input: JSON.stringify(request) + '\n' });
  const response = JSON.parse(String(result.stdout).trim().split('\n').at(-1));
  if (result.code !== 0 || !response.ok) throw new Error(response.error || result.stderr || 'controlled installer failed');
  return response.data;
}

test('fake Docker publishes complete snapshots while a state replacement is still being written', async t => {
  const host = await controlled(t, { slowDbWrites: true });
  let finished = false, overlappingReads = 0;
  const installation = installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir }).finally(() => { finished = true; });
  const reader = (async () => {
    while (!finished) {
      if ((await fs.readdir(host.home)).some(name => /^docker\.json\.\d+\.pending$/.test(name))) {
        const snapshot = await host.db(); // Parse failures must remain visible, without retrying.
        assert.equal(typeof snapshot.containers, 'object');
        if (snapshot.commands) assert.ok(Array.isArray(snapshot.commands));
        overlappingReads++;
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  })();
  const results = await Promise.allSettled([installation, reader]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  assert.ok(overlappingReads > 0, 'read snapshots while the fake daemon had an incomplete replacement');
  assert.equal((await host.db()).containers['frostbyte-beta'].Id, 'new-agent');
});

test('actual remote installer builds while the old service runs and activates through its private socket', async t => {
  const host = await controlled(t);
  const result = await installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir });
  const db = await host.db();
  assert.equal(result.status.version, manifest.version);
  assert.equal(db.runningWhileBuilding, true);
  assert.deepEqual(Object.keys(db.containers), ['frostbyte-beta']);
  assert.equal(db.containers['frostbyte-beta'].Id, 'new-agent');
  assert.equal(await fs.readFile(path.join(host.downloadDir, 'keep-model.bin'), 'utf8'), 'existing downloaded bytes');
  assert.ok(db.commands.some(command => command.includes('/app/src/agent/client.js')));
  assert.ok(!db.commands.some(command => command.includes('-p') || command.includes('--publish')));
  assert.ok(!db.commands.some(command => command.includes('--gpus') || command.includes('--privileged')));
  assert.ok(db.containers['frostbyte-beta'].Config.Env.some(value => value.startsWith('FROSTBYTE_HOST_GPUS=') && value.includes('NVIDIA GB10')));
  assert.deepEqual(await fs.readdir(path.join(host.home, '.local/share/frostbyte-beta/install')), []);
});

test('post-commit backup housekeeping cannot report a healthy install as failed', async t => {
  const host = await controlled(t, { failRemove: true });
  const result = await installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir });
  const db = await host.db();
  assert.equal(result.status.version, manifest.version);
  assert.equal(db.containers['frostbyte-beta'].Id, 'new-agent');
  assert.ok(Object.values(db.containers).some(container => container.Id === 'old-agent'));
  assert.equal((await fs.readdir(path.join(host.home, '.local/share/frostbyte-beta/install'))).length, 1);
  db.failRemove = false;
  await fs.writeFile(path.join(host.home, 'docker.json'), JSON.stringify(db));
  await installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir });
  assert.deepEqual(await fs.readdir(path.join(host.home, '.local/share/frostbyte-beta/install')), []);
});

test('failed normal image cleanup preserves the stage identity for an exact retry', async t => {
  const host = await controlled(t, { failImageRemove: true });
  const [archive, installer] = await Promise.all([
    fs.readFile(path.join(bundleDir, manifest.archive)),
    fs.readFile(path.join(bundleDir, manifest.installer))
  ]);
  const sessionId = 'cleanup-retry-1';
  const common = { manifest, sessionId, downloadDir: host.downloadDir,
    addStorage: false, installer: installer.toString('base64') };
  await callControlledInstaller(host, { ...common, action: 'prepare', archive: archive.toString('base64') });
  await callControlledInstaller(host, { ...common, action: 'build' });
  const stage = path.join(host.home, '.local/share/frostbyte-beta/install', sessionId);
  const marker = JSON.parse(await fs.readFile(path.join(stage, 'stage.json'), 'utf8'));

  const failed = await host.execute(SPARK_INSTALL_COMMAND, { input: JSON.stringify({ ...common, action: 'cleanup' }) + '\n' });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /staging record was kept for a later cleanup retry/);
  assert.equal((await fs.stat(stage)).isDirectory(), true);
  assert.equal((await host.db()).images[marker.image].built, true);

  const db = await host.db();
  db.failImageRemove = false;
  await fs.writeFile(path.join(host.home, 'docker.json'), JSON.stringify(db));
  await callControlledInstaller(host, { ...common, action: 'cleanup' });
  await assert.rejects(fs.stat(stage), { code: 'ENOENT' });
  const cleaned = await host.db();
  assert.equal(cleaned.images[marker.image], undefined);
  const attempts = cleaned.commands.filter(args => args[1] === 'image' && args[2] === 'rm');
  assert.deepEqual(attempts.slice(-2), [
    ['docker', 'image', 'rm', marker.image],
    ['docker', 'image', 'rm', marker.image]
  ]);
});

test('next setup reclaims only a stale abandoned pre-activation stage and its exact session image', async t => {
  const host = await controlled(t);
  const [archive, installer] = await Promise.all([
    fs.readFile(path.join(bundleDir, manifest.archive)),
    fs.readFile(path.join(bundleDir, manifest.installer))
  ]);
  const abandonedSession = 'abandoned-build-1';
  const common = { manifest, sessionId: abandonedSession, downloadDir: host.downloadDir,
    addStorage: false, installer: installer.toString('base64') };
  await callControlledInstaller(host, { ...common, action: 'prepare', archive: archive.toString('base64') });
  await callControlledInstaller(host, { ...common, action: 'build' });

  const abandonedStage = path.join(host.home, '.local/share/frostbyte-beta/install', abandonedSession);
  const markerFile = path.join(abandonedStage, 'stage.json');
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  assert.equal(marker.lease.phase, 'built');
  assert.equal(marker.image, `frostbyte-agent:${manifest.version}-${abandonedSession}`);

  // An old timestamp cannot reclaim the stage while its recorded action
  // process is alive.
  marker.lease.pid = process.pid;
  marker.lease.updatedAt = Date.now() / 1000 - 2 * 60 * 60;
  await fs.writeFile(markerFile, JSON.stringify(marker));
  const activeSession = 'active-stage-check';
  const active = { ...common, sessionId: activeSession };
  await callControlledInstaller(host, { ...active, action: 'prepare', archive: archive.toString('base64') });
  assert.equal((await fs.stat(abandonedStage)).isDirectory(), true);
  await callControlledInstaller(host, { ...active, action: 'cleanup' });

  // A fresh lease protects the normal pause between build and activation
  // after the action process has exited.
  marker.lease.pid = 2147483647;
  marker.lease.updatedAt = Date.now() / 1000;
  await fs.writeFile(markerFile, JSON.stringify(marker));
  const recentSession = 'recent-stage-check';
  const recent = { ...common, sessionId: recentSession };
  await callControlledInstaller(host, { ...recent, action: 'prepare', archive: archive.toString('base64') });
  assert.equal((await fs.stat(abandonedStage)).isDirectory(), true);
  await callControlledInstaller(host, { ...recent, action: 'cleanup' });

  const victim = path.join(host.home, 'not-frostbyte-staging');
  await fs.mkdir(victim);
  await fs.writeFile(path.join(victim, 'sentinel'), 'keep');
  const unsafeStage = path.join(host.home, '.local/share/frostbyte-beta/install', 'symlink-stage-1');
  await fs.symlink(victim, unsafeStage);
  marker.lease.updatedAt = Date.now() / 1000 - 2 * 60 * 60;
  await fs.writeFile(markerFile, JSON.stringify(marker));
  let checkedRecovery = false;
  const resumed = async (command, options) => {
    const result = await host.execute(command, options);
    if (JSON.parse(options.input).action === 'prepare') {
      await assert.rejects(fs.stat(abandonedStage), { code: 'ENOENT' });
      assert.equal((await fs.lstat(unsafeStage)).isSymbolicLink(), true);
      assert.equal(await fs.readFile(path.join(victim, 'sentinel'), 'utf8'), 'keep');
      const db = await host.db();
      const removals = db.commands.filter(args => args[1] === 'image' && args[2] === 'rm');
      assert.deepEqual(removals.at(-1), ['docker', 'image', 'rm', marker.image]);
      assert.equal(db.images[marker.image], undefined);
      assert.equal(db.containers['frostbyte-beta'].Id, 'old-agent');
      assert.equal(db.containers['frostbyte-beta'].State.Running, true);
      checkedRecovery = true;
    }
    return result;
  };
  const result = await installSparkCompanion({ execute: resumed, bundleDir, downloadDir: host.downloadDir });
  assert.equal(checkedRecovery, true);
  assert.equal(result.status.version, manifest.version);
});

test('failed startup restores the previous container and its persisted state', async t => {
  const host = await controlled(t, { failStart: true });
  await assert.rejects(installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir }), /Simulated startup failure/);
  const db = await host.db();
  assert.deepEqual(Object.keys(db.containers), ['frostbyte-beta']);
  assert.equal(db.containers['frostbyte-beta'].Id, 'old-agent');
  assert.equal(db.containers['frostbyte-beta'].State.Running, true);
  assert.equal(await fs.readFile(path.join(host.state, 'agent.json'), 'utf8'), '{"existingTransfer":true}');
  assert.equal(await fs.readFile(path.join(host.downloadDir, 'keep-model.bin'), 'utf8'), 'existing downloaded bytes');
});

test('fresh installation works without any other companion application', async t => {
  const host = await controlled(t, { existing: false });
  const result = await installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir });
  assert.equal(result.status.hostname, 'controlled-spark');
  assert.equal((await host.db()).containers['frostbyte-beta'].State.Running, true);
});

test('upgrades discard writable mounts outside registered state and storage roots', async t => {
  const host = await controlled(t, { extraMount: true });
  await fs.writeFile(path.join(host.unexpectedMount, 'private.txt'), 'host-only bytes');
  await installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir });
  const container = (await host.db()).containers['frostbyte-beta'];
  assert.deepEqual(container.Mounts.map(item => item.Destination), ['/state', host.downloadDir]);
  assert.equal(await fs.readFile(path.join(host.unexpectedMount, 'private.txt'), 'utf8'), 'host-only bytes');
});

test('an unrelated container using the same name is left untouched', async t => {
  const host = await controlled(t, { unrelated: true });
  await assert.rejects(installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir }), /Another application owns/);
  const db = await host.db();
  assert.equal(db.containers['frostbyte-beta'].Id, 'old-agent');
  assert.equal(db.containers['frostbyte-beta'].State.Running, true);
  assert.ok(!db.commands.some(command => ['build','stop','rename','rm','run'].includes(command[1])));
});

test('unlabelled legacy adoption requires the exact reviewed identity and retains rollback', async t => {
  const host = await controlled(t, { unlabelled: true, failStart: true });
  await assert.rejects(installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir }), /Another application owns/);
  await assert.rejects(installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir, adoptLegacyContainerId: 'b'.repeat(64) }), /Another application owns/);
  await assert.rejects(installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: host.downloadDir, adoptLegacyContainerId: 'a'.repeat(64) }), /Simulated startup failure/);
  const old = (await host.db()).containers['frostbyte-beta'];
  assert.equal(old.Id, 'a'.repeat(64)); assert.equal(old.State.Running, true);
  assert.equal(await fs.readFile(path.join(host.state, 'agent.json'), 'utf8'), '{"existingTransfer":true}');
});


test('adding storage retains primary downloads and existing mounts, and records durable drive markers', async t => {
  const host = await controlled(t);
  const extra = path.join(host.home, 'external mounted volume', 'models');
  const result = await configureSparkStorage({ execute: host.execute, bundleDir, downloadDir: extra });
  const container = (await host.db()).containers['frostbyte-beta'];
  const env = Object.fromEntries(container.Config.Env.map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  assert.equal(result.status.downloadDir, host.downloadDir);
  assert.equal(env.FROSTBYTE_DOWNLOAD_DIR, host.downloadDir);
  assert.deepEqual(JSON.parse(env.FROSTBYTE_STORAGE_ROOTS), [host.downloadDir, extra]);
  assert.deepEqual(container.Mounts.map(item => item.Destination), ['/state', host.downloadDir, extra]);
  const identities = JSON.parse(env.FROSTBYTE_STORAGE_IDENTITIES);
  assert.equal(identities.length, 2);
  for (const identity of identities) assert.equal((await fs.readFile(path.join(identity.path, '.frostbyte-storage-id'), 'utf8')).trim(), identity.marker);
  assert.equal(await fs.readFile(path.join(host.downloadDir, 'keep-model.bin'), 'utf8'), 'existing downloaded bytes');
});

test('adding external storage preserves a legacy /downloads bind without creating a host /downloads folder', async t => {
  const host = await controlled(t, { legacyBind: true, extraMount: true });
  const extra = path.join(host.home, 'second-model-drive');
  await configureSparkStorage({ execute: host.execute, bundleDir, downloadDir: extra });
  const current = (await host.db()).containers['frostbyte-beta'];
  assert.deepEqual(current.Mounts, [{ Source: host.state, Destination: '/state' },
    { Source: host.downloadDir, Destination: '/downloads' }, { Source: extra, Destination: extra }]);
  assert.equal(await fs.readFile(path.join(host.downloadDir, 'keep-model.bin'), 'utf8'), 'existing downloaded bytes');
  const env = Object.fromEntries(current.Config.Env.map(value => value.split(/=(.*)/s).slice(0, 2)));
  assert.equal(env.FROSTBYTE_DOWNLOAD_DIR, '/downloads');
  assert.deepEqual(JSON.parse(env.FROSTBYTE_STORAGE_ROOTS), ['/downloads', extra]);
  const marker = JSON.parse(env.FROSTBYTE_STORAGE_IDENTITIES).find(row => row.path === '/downloads');
  assert.equal((await fs.readFile(path.join(host.downloadDir, '.frostbyte-storage-id'), 'utf8')).trim(), marker.marker);
  // A second update must retain the same source, destination and identity.
  await installSparkCompanion({ execute: host.execute, bundleDir, downloadDir: '/downloads' });
  assert.deepEqual((await host.db()).containers['frostbyte-beta'].Mounts, current.Mounts);
});

test('disconnected registered storage refuses reconfiguration without recreating its missing folder', async t => {
  const host = await controlled(t);
  const extra = path.join(host.home, 'external drive', 'models');
  await configureSparkStorage({ execute: host.execute, bundleDir, downloadDir: extra });
  await fs.rm(extra, { recursive: true });
  const before = (await host.db()).commands.length;
  await assert.rejects(configureSparkStorage({ execute: host.execute, bundleDir, downloadDir: path.join(host.home, 'another drive') }), /Storage is unavailable/);
  const db = await host.db();
  assert.equal(db.containers['frostbyte-beta'].State.Running, true);
  assert.ok(!db.commands.slice(before).some(command => ['stop', 'rename', 'rm', 'run'].includes(command[1])));
  await assert.rejects(fs.stat(extra), { code: 'ENOENT' });
});

test('reconfiguration rejects an oversized registered storage marker without reading it', async t => {
  const host = await controlled(t);
  const extra = path.join(host.home, 'bounded marker drive', 'models');
  await configureSparkStorage({ execute: host.execute, bundleDir, downloadDir: extra });
  await fs.writeFile(path.join(extra, '.frostbyte-storage-id'), 'a'.repeat(1024 * 1024));
  const before = (await host.db()).commands.length;
  await assert.rejects(configureSparkStorage({ execute: host.execute, bundleDir,
    downloadDir: path.join(host.home, 'another bounded marker drive') }), /Storage is unavailable|storage identity file is invalid/i);
  const db = await host.db();
  assert.equal(db.containers['frostbyte-beta'].State.Running, true);
  assert.ok(!db.commands.slice(before).some(command => ['stop', 'rename', 'rm', 'run'].includes(command[1])));
});

test('lost activation response rolls back the actual remote swap on cleanup', async t => {
  const host = await controlled(t);
  const execute = async (command, options) => {
    const result = await host.execute(command, options);
    if (JSON.parse(options.input).action === 'activate') return { code: 1, stdout: '', stderr: 'Connection interrupted after activation' };
    return result;
  };
  await assert.rejects(installSparkCompanion({ execute, bundleDir, downloadDir: host.downloadDir }), /Connection interrupted/);
  const db = await host.db();
  assert.equal(db.containers['frostbyte-beta'].Id, 'old-agent');
  assert.equal(db.containers['frostbyte-beta'].State.Running, true);
  assert.equal(await fs.readFile(path.join(host.state, 'agent.json'), 'utf8'), '{"existingTransfer":true}');
});


test('detached watchdog restores the old service after activation loses every Mac connection', async t => {
  const host = await controlled(t);
  let disconnected = false;
  const execute = async (command, options) => {
    if (disconnected) throw new Error('Mac is offline');
    const result = await host.execute(command, options);
    const request = JSON.parse(options.input);
    if (request.action === 'activate') {
      assert.equal(result.code, 0);
      disconnected = true;
      const journalFile = path.join(host.home, '.local/share/frostbyte-beta/install', request.sessionId, 'activation.json');
      const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
      journal.recoverAfter = Date.now() / 1000 - 1;
      const replacement = journalFile + '.test-pending';
      await fs.writeFile(replacement, JSON.stringify(journal));
      await fs.rename(replacement, journalFile);
      throw new Error('Mac is offline');
    }
    return result;
  };
  await assert.rejects(installSparkCompanion({ execute, bundleDir, downloadDir: host.downloadDir }), /Mac is offline/);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const current = (await host.db()).containers['frostbyte-beta'];
    if (current?.Id === 'old-agent' && current.State.Running) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const db = await host.db();
  assert.equal(db.containers['frostbyte-beta'].Id, 'old-agent');
  assert.equal(db.containers['frostbyte-beta'].State.Running, true);
  assert.equal(await fs.readFile(path.join(host.state, 'agent.json'), 'utf8'), '{"existingTransfer":true}');
});


test('next setup recovers a process killed during activation before staging another update', async t => {
  const host = await controlled(t, { killDuringStart: true, disableWatchdog: true });
  let disconnected = false;
  const execute = async (command, options) => {
    if (disconnected) throw new Error('Mac connection lost');
    const result = await host.execute(command, options);
    if (JSON.parse(options.input).action === 'activate') disconnected = true;
    return result;
  };
  await assert.rejects(installSparkCompanion({ execute, bundleDir, downloadDir: host.downloadDir }), /activate/);
  const interrupted = await host.db();
  assert.ok(Object.values(interrupted.containers).some(container => container.Id === 'old-agent' && !container.State.Running));
  interrupted.killDuringStart = false; interrupted.disableWatchdog = false;
  const replacement = path.join(host.home, 'docker.json.test-pending');
  await fs.writeFile(replacement, JSON.stringify(interrupted));
  await fs.rename(replacement, path.join(host.home, 'docker.json'));
  let verifiedRecovery = false;
  const resumed = async (command, options) => {
    const result = await host.execute(command, options);
    if (JSON.parse(options.input).action === 'prepare') {
      const current = (await host.db()).containers['frostbyte-beta'];
      assert.equal(current.Id, 'old-agent'); assert.equal(current.State.Running, true);
      assert.equal(await fs.readFile(path.join(host.state, 'agent.json'), 'utf8'), '{"existingTransfer":true}');
      verifiedRecovery = true;
    }
    return result;
  };
  const result = await installSparkCompanion({ execute: resumed, bundleDir, downloadDir: host.downloadDir });
  assert.equal(verifiedRecovery, true);
  assert.equal(result.status.version, manifest.version);
});


test('a nested storage folder remains independently selectable beside its registered parent', async t => {
  const host = await controlled(t);
  const nested = path.join(host.downloadDir, 'Models');
  const result = await configureSparkStorage({ execute: host.execute, bundleDir, downloadDir: nested });
  const container = (await host.db()).containers['frostbyte-beta'];
  const env = Object.fromEntries(container.Config.Env.map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  assert.equal(result.status.downloadDir, host.downloadDir);
  assert.deepEqual(result.status.storageRoots, [host.downloadDir, nested]);
  assert.deepEqual(JSON.parse(env.FROSTBYTE_STORAGE_ROOTS), [host.downloadDir, nested]);
  assert.ok(container.Mounts.some(mount => mount.Source === nested && mount.Destination === nested));
  assert.ok(container.Mounts.some(mount => mount.Source === host.downloadDir && mount.Destination === host.downloadDir));
  const markers = JSON.parse(env.FROSTBYTE_STORAGE_IDENTITIES);
  assert.equal(markers.length, 2);
  assert.notEqual(markers[0].marker, markers[1].marker);
  assert.equal((await fs.readFile(path.join(nested, '.frostbyte-storage-id'), 'utf8')).trim(), markers[1].marker);
});
