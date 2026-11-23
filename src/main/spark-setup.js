/** First-use Spark pairing. Passwords exist only in short-lived setup sessions. */
import { randomUUID } from 'node:crypto';
import { sparkExecute, sparkRequest, inspectSparkHost, validateSparkHost, validateDirectProfile, generateSparkKeyPair } from './spark.js';
import { installSparkCompanion } from './spark-installer.js';
import { identifyDevice } from '../shared/device-models.js';
import { SPARK_PAIR_COMMAND } from './spark-pairing.js';
import { sanitizeSparkFolderListing, sanitizeSparkProbe } from './spark-schema.js';
import { isCompanionCompatible, isCompanionCurrent } from '../shared/companion-protocol.js';

export { SPARK_PAIR_COMMAND } from './spark-pairing.js';

const pythonCommand = script => `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(script).toString('base64')}"))'`;
export const SPARK_PROBE_COMMAND = pythonCommand(`
import os,sys,json,platform,shutil,subprocess
home=os.path.expanduser('~')
def run(args):
 try:
  r=subprocess.run(args,capture_output=True,text=True,timeout=15)
  return r.returncode,r.stdout
 except Exception: return 1,''
mac=sys.platform=='darwin'
installed=not mac and bool(shutil.which('docker'))
access=installed and run(['docker','info','--format','{{.ServerVersion}}'])[0]==0
agent=False
conflict=False
folder=os.path.join(home,'FrostByte')
if access:
 code,out=run(['docker','inspect','frostbyte-beta'])
 if code==0:
  container=json.loads(out)[0]
  agent=(container.get('Config',{}).get('Labels') or {}).get('ai.blackfrost.frostbyte')=='agent'
  conflict=not agent
  if agent:
   for env in container.get('Config',{}).get('Env',[]):
    if env.startswith('FROSTBYTE_DOWNLOAD_DIR='): folder=env.split('=',1)[1]
library=os.path.join(home,'model-lab','models')
hardware={'platform':sys.platform,'architecture':platform.machine(),'memoryBytes':int(run(['/usr/sbin/sysctl','-n','hw.memsize'])[1].strip() or '0') if mac else os.sysconf('SC_PAGE_SIZE')*os.sysconf('SC_PHYS_PAGES'),'cpuCores':os.cpu_count()}
if mac:
 hardware.update({'modelIdentifier':run(['/usr/sbin/sysctl','-n','hw.model'])[1].strip(),'chip':run(['/usr/sbin/sysctl','-n','machdep.cpu.brand_string'])[1].strip(),'osVersion':run(['/usr/bin/sw_vers','-productVersion'])[1].strip()})
 managed=os.path.join(home,'.local/share/frostbyte-beta/managed.json')
 if os.path.isfile(managed):
  with open(managed) as f: config=json.load(f)
  agent=config.get('owner')=='ai.blackfrost.frostbyte.companion'
  conflict=not agent
  if agent: folder=config['downloadDir']
else:
 for key,name in [('vendor','sys_vendor'),('modelIdentifier','product_name'),('reportedModel','product_name')]:
  try:
   with open('/sys/class/dmi/id/'+name) as f: hardware[key]=f.read(256).strip()
  except OSError: pass
desktop=not mac or run(['/bin/launchctl','print','gui/'+str(os.getuid())])[0]==0
print(json.dumps({'device':{'hostname':platform.node(),'architecture':platform.machine(),'platform':sys.platform,'home':home,'hardware':hardware},'downloadDir':folder,'frigidLibrary':library if os.path.isdir(library) else None,'requirements':{'dockerInstalled':installed,'dockerAccess':bool(access),'agentInstalled':agent,'containerConflict':conflict,'desktopSession':desktop}}))
`);
export const SPARK_FOLDERS_COMMAND = pythonCommand(`
import os,json,stat,sys
raw=sys.stdin.buffer.read(8193)
if len(raw)>8192: raise Exception('Folder request is too large')
try: r=json.loads(raw)
except Exception: raise Exception('Folder request is invalid')
if not isinstance(r,dict) or len(r)>4: raise Exception('Folder request is invalid')
home=os.path.realpath(os.path.expanduser('~'))
value=r.get('path') or home
if not isinstance(value,str) or len(value)>4096 or not os.path.isabs(value) or any(ord(c)<32 or ord(c)==127 for c in value): raise Exception('Choose an absolute folder on the device')
def directory(value):
 try: return stat.S_ISDIR(os.lstat(value).st_mode)
 except OSError: return False
def inside(root,value):
 try: return os.path.commonpath([root,value])==root
 except ValueError: return False
roots=[home]
for candidate in ['/Volumes','/media','/mnt','/run/media']:
 if directory(candidate):
  canonical=os.path.realpath(candidate)
  if directory(canonical) and canonical not in roots: roots.append(canonical)
current=os.path.realpath(value)
if len(current)>4096 or not directory(current): raise Exception('Folder is not available on the device')
available=[root for root in roots if inside(root,current)]
if not available: raise Exception('Choose a folder in your home directory or on a mounted storage drive')
boundary=max(available,key=len)
shortcuts=[]
for name,p in [('Home',home),('External drives','/Volumes'),('External drives','/media'),('Mounted storage','/mnt'),('Removable storage','/run/media')]:
 canonical=os.path.realpath(p)
 if directory(p) and directory(canonical): shortcuts.append({'name':name,'path':canonical})
folders=[]
try:
 with os.scandir(current) as entries:
  for entry in entries:
   try: is_directory=entry.is_dir(follow_symlinks=False)
   except OSError: is_directory=False
   if (is_directory and not entry.name.startswith('.') and len(entry.name)<=255
       and not any(ord(c)<32 or ord(c)==127 for c in entry.name)):
    child=os.path.join(current,entry.name)
    if len(child)<=4096 and inside(boundary,child): folders.append({'name':entry.name,'path':child})
   if len(folders)>=500: break
except OSError: raise Exception('Folder is not available on the device')
response=json.dumps({'path':current,'parent':current if current==boundary else os.path.dirname(current),'folders':sorted(folders,key=lambda x:x['name'].lower()),'shortcuts':shortcuts},separators=(',',':'))
if len(response.encode())>512*1024: raise Exception('Folder response is too large')
sys.stdout.write(response)
`);

const expectedSetupCancellation = (error, signal) => signal?.aborted && (
  error?.name === 'AbortError'
  || /^cancelled$/i.test(String(error?.message || ''))
  || /^Device setup cancelled\.?$/i.test(String(error?.message || ''))
);
export class SparkSetup {
  constructor({ bundleDir, encryptKey, saveConnection, onProgress = () => {}, execute = sparkExecute, request = sparkRequest, inspect = inspectSparkHost, installer = installSparkCompanion, generateKeyPair = generateSparkKeyPair, expectedVersion = '', requireCurrent = false, sessionMs = 10 * 60 * 1000 }) {
    Object.assign(this, { bundleDir, encryptKey, saveConnection, onProgress, execute, request, inspect, installer, generateKeyPair, expectedVersion, requireCurrent, sessionMs });
    this.sessions = new Map(); this.pending = new Set(); this.probeOperation = null;
    this.reaper = setInterval(() => { for (const [id, session] of this.sessions) if (!session.busy && Date.now() > session.expires) this.cancel(id); }, Math.min(sessionMs, 30000));
    this.reaper.unref();
  }
  accepts(status) {
    return isCompanionCompatible(status) && (!this.requireCurrent || isCompanionCurrent(status, this.expectedVersion));
  }
  probe(input = {}, binding = {}) {
    if (this.probeOperation) return Promise.reject(new Error('Another device setup is running. Finish or cancel it first.'));
    const operation = { controller: new AbortController(), task: null };
    // Reserve the probe slot before starting any asynchronous host inspection.
    // A second renderer request can therefore never cancel the first probe and
    // then receive a second session while the first call returns a dead ID.
    this.probeOperation = operation;
    operation.task = this._probe(input, binding, operation.controller).finally(() => {
      if (this.probeOperation === operation) this.probeOperation = null;
    });
    return operation.task;
  }
  async _probe(input = {}, binding = {}, probeController) {
    const purpose = ['add-storage', 'update-device'].includes(binding?.purpose) ? binding.purpose : '';
    const deviceId = purpose && typeof binding.deviceId === 'string' && binding.deviceId ? binding.deviceId : '';
    if (binding?.purpose !== undefined && (!purpose || !deviceId)) throw new Error('Invalid device setup purpose.');
    if ([...this.sessions.values()].some(session => session.busy)) throw new Error('Another device setup is running. Finish or cancel it first.');
    for (const id of this.sessions.keys()) await this.cancel(id);
    let profile;
    if (input.mode === 'ssh') profile = { mode: 'ssh', host: validateSparkHost(input.host) };
    else if (input.mode === 'password') {
      const address = validateDirectProfile(input);
      if (typeof input.password !== 'string' || !input.password || input.password.length > 4096) throw new Error('Enter your account password on the device.');
      const identity = await this.inspect(address, { signal: probeController.signal });
      probeController.signal.throwIfAborted();
      if (!input.trustFingerprint || input.trustFingerprint !== identity.fingerprint) return { stage: 'trust', fingerprint: identity.fingerprint, hostKeyType: identity.hostKeyType };
      profile = { mode: 'password', ...address, hostKey: identity.hostKey, password: input.password };
    } else throw new Error('Choose a device connection method.');
    probeController.signal.throwIfAborted();
    const session = { id: randomUUID(), profile, controller: probeController, expires: Date.now() + this.sessionMs, busy: false,
      ...(purpose ? { purpose, deviceId } : {}) };
    this.sessions.set(session.id, session);
    try {
      const result = await this.execute(profile, SPARK_PROBE_COMMAND, { signal: session.controller.signal });
      if (session.controller.signal.aborted) throw new Error('Device setup cancelled.');
      if (result.code) throw new Error(profile.mode === 'ssh'
        ? 'Could not check the device. Make sure this SSH connection works on your computer and Python 3 is installed on the device. You can also use device address + password setup.'
        : 'Connected over SSH, but could not check the device. Python 3 is required on the device.');
      let info;
      try { info = sanitizeSparkProbe(JSON.parse(result.stdout)); } catch { throw new Error('The device returned an unreadable check.'); }
      const requirements = info.requirements;
      const mac = info.device?.platform === 'darwin';
      const supported = ['linux', 'darwin'].includes(info.device?.platform) && ['aarch64', 'arm64', 'x86_64', 'x64'].includes(info.device.architecture);
      if (info.device?.hardware) info.device.hardware = identifyDevice(info.device.hardware);
      profile.runtime = mac ? 'mac-native' : 'docker';
      let status;
      if (requirements.agentInstalled) {
        try { status = await this.request(profile, { action: 'status' }, { signal: session.controller.signal }); } catch { /* offer repair */ }
      }
      session.controller.signal.throwIfAborted();
      requirements.agentCompatible = isCompanionCompatible(status);
      requirements.agentCurrent = isCompanionCurrent(status, this.expectedVersion);
      let message;
      if (!supported) message = 'This beta supports Apple silicon and Intel Macs, and Linux ARM64 or x64 devices with Docker.';
      else if (requirements.containerConflict) message = 'A different container is using the name frostbyte-beta. Rename that container before setup.';
      else if (mac && requirements.desktopSession === false) message = 'Sign in to this Mac’s desktop with the SSH account, then check again.';
      else if (!mac && !requirements.dockerInstalled) message = 'Docker must be installed on the device before continuing.';
      else if (!mac && !requirements.dockerAccess) message = 'Start Docker and give this device account permission to use it, then try again.';
      session.info = info; session.status = status; session.allowed = !message;
      session.stage = message ? 'requirements' : this.accepts(status) ? 'ready' : 'review';
      return { ...info, status, sessionId: session.id, stage: session.stage, message };
    } catch (error) { await this.cancel(session.id); throw error; }
  }
  getSession(id) {
    const session = this.sessions.get(id);
    if (!session || session.controller.signal.aborted || (!session.busy && Date.now() > session.expires)) throw new Error('This setup session expired. Enter your device connection details again.');
    return session;
  }
  async run(id, downloadDir, install) {
    const session = this.getSession(id);
    if (session.busy || [...this.sessions.values()].some(value => value.busy)) throw new Error('Device setup is already running.');
    if (session.purpose === 'add-storage' || session.purpose === 'update-device' && !install) {
      throw new Error(`This authorization can only be used for its selected ${session.purpose === 'add-storage' ? 'storage change' : 'device update'}.`);
    }
    if (!session.allowed) throw new Error('Complete the device requirements and check the connection again.');
    if (!install && !this.accepts(session.status)) throw new Error('Install the current companion before connecting.');
    session.busy = true;
    const task = this.finishSetup(session, downloadDir, install).finally(() => {
      session.busy = false; session.expires = Date.now() + this.sessionMs; this.pending.delete(task);
      if (session.controller.signal.aborted) { session.profile = null; this.sessions.delete(id); }
    });
    session.task = task; this.pending.add(task); return task;
  }
  async finishSetup(session, downloadDir, install) {
    const { profile, controller, id: sessionId } = session;
    const signal = controller.signal;
    const progress = (stage, message) => this.onProgress({ sessionId, stage, message });
    // Do not bind the session signal implicitly: installer rollback must survive cancellation.
    const execute = (command, options) => this.execute(profile, command, { timeout: 25 * 60 * 1000, ...options });
    let pairing, added = false, saved = false;
    try {
      if (profile.mode !== 'ssh') {
        const keys = this.generateKeyPair(`frostbyte-${sessionId}`);
        const encrypted = this.encryptKey(keys.private); // fail before any remote mutation if secure storage is unavailable
        pairing = { privateKey: keys.private, publicKey: keys.public.trim(), encrypted };
      }
      if (install) await this.installer({ execute, bundleDir: this.bundleDir, downloadDir, sessionId, signal, runtime: profile.runtime,
        onProgress: event => this.onProgress({ ...event, sessionId }) });
      if (signal.aborted) throw new Error('Device setup cancelled.');
      progress('connecting', 'Checking the companion and securing your connection…');
      let connection = profile;
      if (pairing) {
        added = true; // also clean up if the add response is lost
        const result = await execute(SPARK_PAIR_COMMAND, { input: JSON.stringify({ action: 'add', publicKey: pairing.publicKey }), signal });
        if (result.code) throw new Error('Could not add this computer’s dedicated SSH key. Check ownership and permissions of the device account’s .ssh folder.');
        connection = { ...profile, password: undefined, privateKey: pairing.privateKey, publicKey: pairing.publicKey };
      }
      const status = await this.request(connection, { action: 'status' }, { signal });
      if (!status.hardware && session.info?.device?.hardware) status.hardware = session.info.device.hardware;
      if (!this.accepts(status)) throw new Error('The device companion is not compatible with this edition. Run setup again to update it.');
      if (signal.aborted) throw new Error('Device setup cancelled.');
      const host = profile.mode === 'ssh' ? profile.host : `${profile.username}@${profile.host}${profile.port === 22 ? '' : ':' + profile.port}`;
      const stored = profile.mode === 'ssh' ? profile : { mode: 'password', runtime: profile.runtime, host: profile.host, username: profile.username, port: profile.port, hostKey: profile.hostKey, privateKeyEnc: pairing.encrypted, publicKey: pairing.publicKey };
      const deviceId = await this.saveConnection(stored, host);
      saved = true; session.profile = null; this.sessions.delete(sessionId);
      progress('ready', 'Device is connected. Downloads can continue while this computer is closed.');
      return { status, host, deviceId };
    } finally {
      if (added && !saved) {
        try { await execute(SPARK_PAIR_COMMAND, { input: JSON.stringify({ action: 'remove', publicKey: pairing.publicKey }), timeout: 15000 }); }
        catch { /* connection may be offline; this unused app key is never persisted */ }
      }
      if (pairing) pairing.privateKey = null;
    }
  }
  install({ sessionId, downloadDir }) { return this.run(sessionId, downloadDir, true); }
  connect({ sessionId }) { return this.run(sessionId, undefined, false); }
  async folders({ sessionId, path } = {}, savedProfile) {
    if (path !== undefined && (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path))) throw new Error('Choose an absolute folder on the device.');
    const profile = sessionId ? this.getSession(sessionId).profile : savedProfile;
    if (!profile) throw new Error('Connect to a device before browsing folders.');
    if (!sessionId && profile.privateKey) return sanitizeSparkFolderListing(await this.request(profile, { action: 'host:folders', path }));
    const result = await this.execute(profile, SPARK_FOLDERS_COMMAND, { input: JSON.stringify({ path }) });
    if (result.code) throw new Error('This folder is unavailable or your device account cannot open it. Choose another folder.');
    try { return sanitizeSparkFolderListing(JSON.parse(result.stdout)); } catch { throw new Error('Could not read the device folder list.'); }
  }
  runStorage(session, { downloadDir } = {}, host, progressSessionId = session.id) {
    const { id, profile, controller } = session;
    const task = (async () => {
      await this.installer({ execute: (command, options) => this.execute(profile, command, { timeout: 25 * 60 * 1000, ...options }),
        bundleDir: this.bundleDir, downloadDir, sessionId: randomUUID(), addStorage: true, signal: controller.signal, runtime: profile.runtime,
        onProgress: event => this.onProgress({ ...event, sessionId: progressSessionId }) });
      const status = await this.request(profile, { action: 'status' });
      return { status, host };
    })().finally(() => {
      if (profile && Object.hasOwn(profile, 'password')) profile.password = undefined;
      session.busy = false; session.profile = null; this.sessions.delete(id); this.pending.delete(task);
    });
    session.task = task; this.pending.add(task); return task;
  }
  async addStorage(profile, { downloadDir } = {}, host) {
    if ([...this.sessions.values()].some(session => session.busy)) throw new Error('Another device setup is running. Finish or cancel it first.');
    if (profile?.privateKey && !profile.password) throw new Error('Enter the device account password in Add device to update the companion or add storage. The dedicated FrostByte key can control downloads only.');
    const id = 'storage', controller = new AbortController();
    const session = { id, profile, controller, busy: true, expires: Date.now() + this.sessionMs };
    this.sessions.set(id, session);
    return this.runStorage(session, { downloadDir }, host);
  }
  async addStorageFromSession(sessionId, deviceId, savedProfile, { downloadDir } = {}, host) {
    const session = this.getSession(sessionId), profile = session.profile;
    if (session.busy || [...this.sessions.values()].some(value => value.busy)) throw new Error('Another device setup is running. Finish or cancel it first.');
    if (!session.allowed || !['review', 'ready'].includes(session.stage)) throw new Error('Complete the device requirements and check the connection again.');
    const savedDirect = savedProfile && ['password', 'key'].includes(savedProfile.mode);
    if (session.purpose !== 'add-storage' || session.deviceId !== deviceId
      || !savedDirect || profile?.mode !== 'password' || !profile.password
      || profile.host !== savedProfile.host || profile.username !== savedProfile.username
      || (profile.port || 22) !== (savedProfile.port || 22) || profile.hostKey !== savedProfile.hostKey) {
      throw new Error('This setup session does not match the selected device. Enter that device account password again.');
    }
    session.busy = true;
    return this.runStorage(session, { downloadDir }, host, sessionId);
  }
  async cancel(id) {
    const session = this.sessions.get(id);
    if (!session) return true;
    session.controller.abort();
    let failure;
    if (session.busy) {
      try { await session.task; }
      catch (error) { if (!expectedSetupCancellation(error, session.controller.signal)) failure = error; }
    }
    session.profile = null; this.sessions.delete(id);
    if (failure) throw failure;
    return true;
  }
  async shutdown() {
    clearInterval(this.reaper);
    const probe = this.probeOperation;
    probe?.controller.abort();
    const cancelled = await Promise.allSettled([...this.sessions.keys()].map(id => this.cancel(id)));
    const drained = await Promise.allSettled([...this.pending]);
    const probeDrained = probe?.task ? await Promise.allSettled([probe.task]) : [];
    const failures = [...cancelled, ...drained, ...probeDrained]
      .filter(result => result.status === 'rejected')
      .filter(result => !probeDrained.includes(result)
        || !expectedSetupCancellation(result.reason, probe.controller.signal))
      .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    if (failures.length) throw new AggregateError(failures, 'One or more device setup operations could not be cleaned up.');
  }
}
