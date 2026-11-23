import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import { SPARK_PAIR_COMMAND, SPARK_RPC_COMMAND, pairingIdentity } from './spark-pairing.js';
import { sanitizeSparkResponse } from './spark-schema.js';
import { SPARK_HOSTD_COMMAND } from './spark-hostd.js';
const { Client, utils } = ssh2;
const MAX_OUTPUT = 8 * 1024 ** 2;
const MAX_ERROR_OUTPUT = 1024 * 1024;
const MAX_INPUT = 12 * 1024 ** 2;
const restrictedPairings = new Map();

/** Reject malformed or mismatched generated keys before storing or enrolling them. */
export function generateSparkKeyPair(comment = '', generate = utils.generateKeyPairSync) {
  // ssh2 1.17 can drop a leading zero from an Ed25519 public key while converting
  // its encoding. Regenerate with the same CSPRNG; never patch key bytes or accept
  // an invalid key. This also checks the private/public pair before remote setup.
  const challenge = Buffer.from('FrostByte pairing key validation');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const keys = generate('ed25519', { comment });
      const privateKey = utils.parseKey(keys.private), publicKey = utils.parseKey(keys.public);
      if (privateKey?.type !== 'ssh-ed25519' || publicKey?.type !== 'ssh-ed25519' || !privateKey.isPrivateKey() || publicKey.isPrivateKey()
        || !privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) continue;
      const signature = privateKey.sign(challenge);
      if (Buffer.isBuffer(signature) && publicKey.verify(challenge, signature) === true) return keys;
    } catch { /* Discard this candidate without retaining or logging key material. */ }
  }
  throw new Error('Could not generate a valid device connection key. Try setup again.');
}

/** Recover the public half for early-beta saved app keys and reject mismatches. */
export function normalizeManagedSparkProfile(profile) {
  if (!profile || profile.mode === 'ssh' || typeof profile.privateKey !== 'string') return profile;
  const parsed = utils.parseKey(profile.privateKey);
  if (parsed instanceof Error || parsed.type !== 'ssh-ed25519' || !parsed.isPrivateKey()) throw new Error('The saved FrostByte device key is invalid. Pair this device again.');
  const publicBlob = parsed.getPublicSSH();
  if (typeof profile.publicKey === 'string') {
    const saved = utils.parseKey(profile.publicKey);
    if (saved instanceof Error || saved.type !== 'ssh-ed25519' || saved.isPrivateKey() || !saved.getPublicSSH().equals(publicBlob)) throw new Error('The saved FrostByte device key does not match its public key. Pair this device again.');
    return profile;
  }
  return { ...profile, publicKey: `ssh-ed25519 ${publicBlob.toString('base64')} frostbyte-migrated` };
}

/** Prefer the operating system's OpenSSH; PATH fallbacks must be absolute executable files. */
export function resolveOpenSsh({ platform = process.platform, env = process.env, isExecutable } = {}) {
  const windows = platform === 'win32', paths = windows ? path.win32 : path.posix;
  const environment = name => Object.entries(env).find(([key]) => windows ? key.toLowerCase() === name.toLowerCase() : key === name)?.[1];
  const candidates = [];
  if (windows) {
    const systemRoot = environment('SystemRoot') || environment('WINDIR');
    if (systemRoot && paths.isAbsolute(systemRoot)) candidates.push(paths.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe'));
  } else candidates.push('/usr/bin/ssh');
  for (const entry of String(environment('PATH') || '').split(windows ? ';' : ':')) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (paths.isAbsolute(directory)) candidates.push(paths.join(directory, windows ? 'ssh.exe' : 'ssh'));
  }
  const available = isExecutable || (candidate => {
    try { fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch { return false; }
  });
  for (const candidate of new Set(candidates)) if (available(candidate)) return candidate;
  throw new Error(windows
    ? 'Windows OpenSSH Client was not found. Enable it in Windows Optional Features, or connect using the device address and password.'
    : 'OpenSSH was not found. Install an SSH client, or connect using the device address and password.');
}

export function validateSparkHost(value) {
  const host = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_.@:-]{0,199}$/i.test(host)) throw new Error('Enter your device SSH alias or user@hostname.');
  return host;
}
export function validateDirectProfile(value) {
  const host = String(value.host || '').trim();
  const username = String(value.username || '').trim();
  const port = Number(value.port || 22);
  if (!/^[a-z0-9][a-z0-9.:-]{0,252}$/i.test(host)) throw new Error('Enter the device IP address or hostname.');
  if (!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(username)) throw new Error('Enter your account username on the device.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535.');
  return { host, username, port };
}
export const keyFingerprint = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
const abortError = () => new Error('Device setup cancelled.');
const connectError = error => {
  if (error.level === 'client-authentication') return new Error('Device sign-in failed. Check the account username and password, or use an existing SSH connection.');
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.code)) return new Error('Cannot reach the device over SSH. Check the address, network, and that SSH is enabled.');
  return error;
};

/** Obtain only the public host key. Authentication is rejected before any credentials are sent. */
export function inspectSparkHost(profile, { signal, timeout = 15000 } = {}) {
  const address = validateDirectProfile(profile);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let keyInfo, settled = false;
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); client.destroy();
      if (keyInfo) resolve(keyInfo); else reject(error || new Error('The device did not provide its SSH identity.'));
    };
    const abort = () => { keyInfo = null; finish(abortError()); };
    const timer = setTimeout(() => finish(new Error('Timed out checking the device identity.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    client.on('error', error => finish(connectError(error)));
    client.on('close', () => finish());
    if (signal?.aborted) return abort();
    client.connect({ ...address, readyTimeout: timeout, hostVerifier: key => {
      keyInfo = { hostKey: key.toString('base64'), fingerprint: keyFingerprint(key), hostKeyType: utils.parseKey(key).type || 'SSH' };
      queueMicrotask(() => finish());
      return false;
    }, authHandler: () => false });
  });
}

/** Internal executor: callers supply fixed commands and put variable data on stdin. */
export function sparkExecute(profile, command, { input, signal, onOutput, timeout = 40000 } = {}) {
  const native = typeof profile === 'string' || profile?.mode === 'ssh';
  if (native) profile = { mode: 'ssh', host: validateSparkHost(typeof profile === 'string' ? profile : profile.host) };
  else validateDirectProfile(profile || {});
  if (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input) > MAX_INPUT)) throw new Error('The device request is too large.');
  const sshExecutable = native ? resolveOpenSsh() : undefined;
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, settled = false, child, client;
    const finish = (error, code = 0) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child?.kill(); client?.destroy(); reject(error); }
      else { client?.end(); resolve({ stdout, stderr, code }); }
    };
    const abort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error('Device operation timed out. Check the connection and try again.')), timeout);
    const output = (data, isError = false) => {
      if (isError) stderrBytes += data.length;
      else stdoutBytes += data.length;
      if (stdoutBytes > MAX_OUTPUT || stderrBytes > MAX_ERROR_OUTPUT) {
        finish(new Error('The device response is too large.'));
        return;
      }
      const text = data.toString();
      if (isError) stderr = (stderr + text).slice(-16000); else stdout += text;
      onOutput?.(text, isError ? 'stderr' : 'stdout');
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    if (native) {
      child = spawn(sshExecutable, ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '--', profile.host, command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.on('error', error => finish(error));
      child.stdout.on('data', data => output(data)); child.stderr.on('data', data => output(data, true));
      child.on('close', code => finish(null, code ?? 1));
      child.stdin.on('error', () => {}); child.stdin.end(input);
    } else {
      client = new Client();
      let hostRejected = false;
      client.on('error', error => finish(hostRejected ? new Error('The device SSH identity changed. Verify the device and set up the connection again.') : connectError(error)));
      client.on('close', () => { if (!settled) finish(new Error('The device SSH connection closed.')); });
      client.on('ready', () => client.exec(command, (error, stream) => {
        if (error) return finish(error);
        stream.on('data', data => output(data)); stream.stderr.on('data', data => output(data, true));
        stream.on('error', error => finish(error)); stream.on('close', code => finish(null, code ?? 1));
        stream.end(input);
      }));
      client.connect({ ...validateDirectProfile(profile), password: profile.password, privateKey: profile.privateKey,
        readyTimeout: Math.min(timeout, 20000), keepaliveInterval: 15000, keepaliveCountMax: 3,
        hostVerifier: key => {
          const expected = Buffer.from(profile.hostKey || '', 'base64');
          const valid = key.length === expected.length && timingSafeEqual(key, expected);
          hostRejected = !valid; return valid;
        },
      });
    }
  });
}

function parseSparkResult({ stdout, stderr, code }) {
  if (code) throw new Error(stderr.trim() || 'Cannot contact the companion. Open Devices to check the installation.');
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('The device returned an unreadable response. Check the companion version.'); }
  if (!result?.ok) throw new Error(typeof result?.error === 'string' && result.error.length <= 4096 ? result.error : 'Device operation failed.');
  return result.data;
}

async function restrictedRpc(profile, request, options = {}) {
  return parseSparkResult(await sparkExecute(profile, SPARK_RPC_COMMAND, { ...options, input: encodeSparkRequest(request) }));
}

function encodeSparkRequest(request) {
  let body;
  try { body = JSON.stringify(request); } catch { throw new Error('Invalid companion request.'); }
  if (!body || Buffer.byteLength(body) + 1 > MAX_INPUT) throw new Error('The device request is too large.');
  return body + '\n';
}

/** Upgrade beta.11-beta.15 app keys before using them for another operation. */
async function ensureRestrictedPairing(profile, options = {}) {
  const identity = pairingIdentity(profile);
  if (!identity) return false;
  if (!restrictedPairings.has(identity)) {
    const task = (async () => {
      try {
        const ping = sanitizeSparkResponse('pairing:ping', await restrictedRpc(profile, { action: 'pairing:ping' }, { signal: options.signal, timeout: 20000 }));
        if (ping?.restricted === true) return true;
      } catch { /* A legacy unrestricted key cannot run the RPC marker yet. */ }
      const migrated = await sparkExecute(profile, SPARK_PAIR_COMMAND, {
        signal: options.signal, timeout: 20000,
        input: JSON.stringify({ action: 'migrate', publicKey: profile.publicKey }) + '\n',
      });
      if (migrated.code) throw new Error(migrated.stderr.trim() || 'Could not restrict the legacy FrostByte device key. Pair this device again.');
      const ping = sanitizeSparkResponse('pairing:ping', await restrictedRpc(profile, { action: 'pairing:ping' }, { signal: options.signal, timeout: 20000 }));
      if (ping?.restricted !== true) throw new Error('The device did not confirm its restricted FrostByte key. Pair this device again.');
      return true;
    })();
    restrictedPairings.set(identity, task);
    task.catch(() => { if (restrictedPairings.get(identity) === task) restrictedPairings.delete(identity); });
  }
  await restrictedPairings.get(identity);
  return true;
}

export async function sparkRequest(profile, request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') throw new Error('Invalid companion request.');
  profile = normalizeManagedSparkProfile(profile);
  // Hashing model weights can take minutes. Model lifecycle requests also need
  // enough time for hostd's bounded Docker operation; status reads stay short.
  const sharing = request.action === 'ipfs:sharing' || request.action === 'seed' || request.action === 'hf:peer' || (request.action === 'inventory:sharing' && request.enabled === true);
  const requestTimeout = sharing || request.action === 'assistant:chat:start' ? { timeout: 30 * 60 * 1000 } : request.action === 'device:control' ? { timeout: 90_000 } : {};
  const managed = await ensureRestrictedPairing(profile, options);
  if (managed) {
    try {
      const data = await restrictedRpc(profile, request, { ...requestTimeout, ...options });
      if (request.action === 'assistant:chat:start') {
        if (data.code || data.stderr) throw new Error('The device could not start this chat. Update its companion.');
        return data;
      }
      return sanitizeSparkResponse(request.action, data);
    }
    finally { if (request.action === 'pairing:revoke') restrictedPairings.delete(pairingIdentity(profile)); }
  }
  const deviceManagement = ['device:telemetry', 'device:recipes', 'device:control'].includes(request.action) && profile?.runtime !== 'mac-native';
  const command = deviceManagement ? SPARK_HOSTD_COMMAND : (profile?.runtime === 'mac-native'
    ? 'FROSTBYTE_AGENT_HOME="$HOME/.local/share/frostbyte-beta/state" "$HOME/.local/share/frostbyte-beta/current/runtime/bin/node" "$HOME/.local/share/frostbyte-beta/current/src/agent/client.js"'
    : 'docker exec -i frostbyte-beta node /app/src/agent/client.js') + (sharing ? ' --wait-for-sharing' : '');
  if (request.action === 'assistant:chat:start') return sparkExecute(profile, command, { ...requestTimeout, ...options, input: encodeSparkRequest(request) });
  const data = parseSparkResult(await sparkExecute(profile, command, { ...requestTimeout, ...options, input: encodeSparkRequest(request) }));
  return sanitizeSparkResponse(request.action, data);
}
