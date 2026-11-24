import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { inspectSparkHost, keyFingerprint, sparkExecute, sparkRequest, generateSparkKeyPair } from '../src/main/spark.js';
import { SPARK_PAIR_COMMAND, SPARK_RPC_COMMAND } from '../src/main/spark-pairing.js';
import { RemoteChatStream } from '../src/main/assistant-remote.js';

const { Server, utils } = ssh2;
const command = 'frostbyte-fixture-json';
const username = 'frostbyte-test';
const password = crypto.randomBytes(24).toString('hex');

test('generated Spark keys discard malformed and mismatched candidates before returning a usable pair', () => {
  const valid = generateSparkKeyPair(), other = generateSparkKeyPair();
  const candidates = [{ private: 'malformed', public: 'malformed' }, { private: valid.private, public: other.public },
    { private: valid.private, public: valid.private }, valid];
  let attempts = 0;
  const result = generateSparkKeyPair('frostbyte-fixture', (type, options) => {
    assert.equal(type, 'ed25519'); assert.equal(options.comment, 'frostbyte-fixture');
    return candidates[attempts++];
  });
  assert.equal(attempts, 4);
  // Compare identities without including private material in an assertion diff.
  assert.equal(result === valid, true);
  const challenge = crypto.randomBytes(32);
  assert.equal(utils.parseKey(result.public).verify(challenge, utils.parseKey(result.private).sign(challenge)), true);
});

test('Spark key generation has a bounded failure without exposing candidate material', () => {
  let attempts = 0;
  assert.throws(() => generateSparkKeyPair('', () => {
    attempts++; return { private: 'sensitive-invalid-candidate', public: 'invalid' };
  }), error => error.message === 'Could not generate a valid device connection key. Try setup again.');
  assert.equal(attempts, 5);
});

test('Spark transport refuses oversized input before opening a connection', () => {
  assert.throws(() => sparkExecute({ mode: 'password', host: '127.0.0.1', username, port: 22 }, command, {
    input: 'x'.repeat(12 * 1024 ** 2 + 1),
  }), /request is too large/);
});

async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('SSH fixture did not reach the expected state.');
    await delay(10);
  }
}

/** An isolated, loopback-only SSH server; never invokes a shell or reads user SSH files. */
async function fixture(t, { hold = false, privateKeyOnly = false, exitCode = 0, sharingRpc = false, responseDelayMs = 0, managedRpc = false, legacyRpc = false } = {}) {
  const hostKeys = generateSparkKeyPair();
  const userKeys = generateSparkKeyPair();
  const hostKey = utils.parseKey(hostKeys.private).getPublicSSH();
  const allowedKey = utils.parseKey(userKeys.public);
  const connections = new Set();
  const authentication = [];
  const executed = [];
  let closed = 0, restricted = !legacyRpc;
  const server = new Server({ hostKeys: [hostKeys.private] }, client => {
    connections.add(client);
    // Host inspection and rejected pins intentionally close during the handshake.
    client.on('error', () => {});
    client.on('close', () => { connections.delete(client); closed++; });
    client.on('authentication', ctx => {
      authentication.push({ method: ctx.method, username: ctx.username });
      if (ctx.username !== username) return ctx.reject(['password', 'publickey']);
      if (!privateKeyOnly && ctx.method === 'password' && ctx.password === password) return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.algo === allowedKey.type
        && ctx.key.data.equals(allowedKey.getPublicSSH())
        && (!ctx.signature || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
      ctx.reject(privateKeyOnly ? ['publickey'] : ['password', 'publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (acceptExec, reject, info) => {
        const expectedCommand = sharingRpc ? 'docker exec -i frostbyte-beta node /app/src/agent/client.js --wait-for-sharing' : command;
        if (managedRpc ? ![SPARK_RPC_COMMAND, SPARK_PAIR_COMMAND].includes(info.command) : info.command !== expectedCommand) return reject();
        const stream = acceptExec();
        const record = { command: info.command, input: '' };
        executed.push(record);
        stream.on('error', () => {});
        stream.on('data', chunk => { record.input += chunk; });
        stream.on('end', async () => {
          if (hold) return;
          if (responseDelayMs) await delay(responseDelayMs);
          const request = managedRpc ? JSON.parse(record.input) : null;
          if (request?.action === 'assistant:chat:start' && record.command === SPARK_RPC_COMMAND && restricted) {
            // Like the pairing helper: bare NDJSON frames as they arrive, nothing on stderr.
            const frames = [{ type: 'delta', text: 'Hel' }, { type: 'delta', text: 'lo' }, { type: 'done' }];
            frames.forEach((frame, index) => stream.write(JSON.stringify({ stream: request.stream, seq: index + 1, ...frame }) + '\n'));
            stream.exit(0); stream.end();
            return;
          }
          stream.stderr.write('fixture progress\n');
          let response, code = exitCode;
          if (managedRpc) {
            if (record.command === SPARK_RPC_COMMAND && !restricted) {
              stream.stderr.write('command not found\n'); code = 127;
            } else if (record.command === SPARK_PAIR_COMMAND) {
              assert.equal(request.action, 'migrate');
              assert.equal(utils.parseKey(request.publicKey).getPublicSSH().equals(utils.parseKey(userKeys.public).getPublicSSH()), true);
              restricted = true; response = { ok: true };
            } else if (request.action === 'pairing:ping') response = { ok: true, data: { restricted: true } };
            else if (request.action === 'pairing:revoke') response = { ok: true, data: { revoked: true } };
            else if (request.action === 'status') response = { ok: true, data: { version: '0.2.0-beta.15', hostname: 'managed-fixture', downloadDir: '/models', torrents: [], downloads: [] } };
            else throw new Error('Unexpected managed RPC action.');
          } else response = sharingRpc ? { ok: true, data: true } : { command: record.command, input: record.input };
          if (response) stream.write(JSON.stringify(response) + '\n');
          stream.exit(code);
          stream.end();
        });
      });
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const connection of connections) connection.end();
    for (const connection of connections) connection._sock?.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    address: { host: '127.0.0.1', username, port: server.address().port },
    profile: { mode: 'password', host: '127.0.0.1', username, port: server.address().port, hostKey: hostKey.toString('base64'), password },
    hostKey, userKeys, authentication, executed, connections,
    get closed() { return closed; },
    get restricted() { return restricted; },
  };
}

test('Spark fingerprint uses the OpenSSH SHA256 format without padding', () => {
  const key = utils.parseKey(generateSparkKeyPair().private).getPublicSSH();
  const expected = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  assert.equal(keyFingerprint(key), expected);
  assert.match(keyFingerprint(key), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test('first connection inspects the host key without any authentication attempt', { timeout: 10000 }, async t => {
  const ssh = await fixture(t);
  const info = await inspectSparkHost(ssh.address);
  assert.equal(info.hostKey, ssh.hostKey.toString('base64'));
  assert.equal(info.fingerprint, keyFingerprint(ssh.hostKey));
  assert.equal(info.hostKeyType, 'ssh-ed25519');
  await waitFor(() => ssh.closed > 0);
  assert.deepEqual(ssh.authentication, [], 'inspection must not transmit credentials or try anonymous authentication');
  assert.deepEqual(ssh.executed, []);
});

test('a pinned password connection preserves command arguments and JSON stdin', { timeout: 10000 }, async t => {
  const ssh = await fixture(t);
  const input = JSON.stringify({ action: 'status', name: 'models/config.json', label: 'spaces, "quotes", $literal' }) + '\n';
  const output = [];
  const result = await sparkExecute(ssh.profile, command, { input, timeout: 5000, onOutput: chunk => output.push(chunk) });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { command, input });
  assert.equal(result.stderr, 'fixture progress\n');
  assert.ok(output.length > 0, 'installer progress reaches the caller');
  assert.ok(ssh.authentication.some(attempt => attempt.method === 'password' && attempt.username === username));
  assert.deepEqual(ssh.executed, [{ command, input }]);
  await waitFor(() => ssh.connections.size === 0);
});

test('a changed host key is rejected before authentication or command execution', { timeout: 10000 }, async t => {
  const ssh = await fixture(t);
  const otherKey = utils.parseKey(generateSparkKeyPair().private).getPublicSSH().toString('base64');
  await assert.rejects(sparkExecute({ ...ssh.profile, hostKey: otherKey }, command, { input: '{}\n', timeout: 5000 }), /host|identity|key|fingerprint/i);
  await waitFor(() => ssh.closed > 0);
  assert.deepEqual(ssh.authentication, [], 'changed identity must be rejected before sending credentials');
  assert.deepEqual(ssh.executed, []);
});

test('an incorrect password fails without running a remote command', { timeout: 10000 }, async t => {
  const ssh = await fixture(t);
  await assert.rejects(sparkExecute({ ...ssh.profile, password: 'incorrect-fixture-password' }, command, { input: '{}\n', timeout: 5000 }), /auth|password|permission|login/i);
  assert.ok(ssh.authentication.some(attempt => attempt.method === 'password'));
  assert.deepEqual(ssh.executed, []);
  await waitFor(() => ssh.connections.size === 0);
});

test('canceling an in-flight Spark command closes the SSH connection', { timeout: 10000 }, async t => {
  const ssh = await fixture(t, { hold: true });
  const controller = new AbortController();
  const pending = sparkExecute(ssh.profile, command, { input: '{}\n', signal: controller.signal, timeout: 5000 });
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await waitFor(() => ssh.executed.length === 1);
  controller.abort();
  await rejected;
  await waitFor(() => ssh.connections.size === 0);
  assert.equal(ssh.closed, 1);
});

test('a dedicated private key authenticates without retaining or sending a password', { timeout: 10000 }, async t => {
  const ssh = await fixture(t, { privateKeyOnly: true });
  const { password: unused, ...profile } = ssh.profile;
  const input = JSON.stringify({ action: 'status' }) + '\n';
  const result = await sparkExecute({ ...profile, privateKey: ssh.userKeys.private }, command, { input, timeout: 5000 });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { command, input });
  assert.ok(ssh.authentication.some(attempt => attempt.method === 'publickey'));
  assert.equal(ssh.authentication.some(attempt => attempt.method === 'password'), false);
});

test('remote nonzero exit preserves stdout, stderr, and status for setup diagnostics', { timeout: 10000 }, async t => {
  const ssh = await fixture(t, { exitCode: 7 });
  const result = await sparkExecute(ssh.profile, command, { input: '{}\n', timeout: 5000 });
  assert.equal(result.code, 7);
  assert.equal(result.stderr, 'fixture progress\n');
  assert.equal(JSON.parse(result.stdout).input, '{}\n');
});

test('legacy app keys migrate to the forced RPC command before status or revocation', { timeout: 20000 }, async t => {
  const ssh = await fixture(t, { privateKeyOnly: true, managedRpc: true, legacyRpc: true });
  const { password: unused, ...base } = ssh.profile;
  const profile = { ...base, privateKey: ssh.userKeys.private, runtime: 'docker' };
  const status = await sparkRequest(profile, { action: 'status' });
  assert.equal(status.hostname, 'managed-fixture'); assert.equal(ssh.restricted, true);
  assert.deepEqual(ssh.executed.slice(0, 4).map(item => item.command), [SPARK_RPC_COMMAND, SPARK_PAIR_COMMAND, SPARK_RPC_COMMAND, SPARK_RPC_COMMAND]);
  const before = ssh.executed.length;
  assert.equal((await sparkRequest({ ...profile }, { action: 'status' })).hostname, 'managed-fixture');
  assert.deepEqual(ssh.executed.slice(before).map(item => item.command), [SPARK_RPC_COMMAND], 'the restricted transport is cached across unlocked profile clones');
  assert.deepEqual(await sparkRequest(profile, { action: 'pairing:revoke' }), { revoked: true });
});

test('a chat on a managed pairing streams its frames instead of parsing them as one reply', { timeout: 20000 }, async t => {
  const ssh = await fixture(t, { privateKeyOnly: true, managedRpc: true });
  const { password: unused, ...base } = ssh.profile;
  const profile = { ...base, privateKey: ssh.userKeys.private, runtime: 'docker' };
  const events = [];
  const chat = new RemoteChatStream({ stream: 's_12345678', send: async () => {} });
  await sparkRequest(profile, { action: 'assistant:chat:start', stream: chat.id, model: { name: 'qwen', provider: 'ollama' }, messages: [{ role: 'user', content: 'Hi' }] }, {
    onOutput: (value, source) => { if (source === 'stdout') chat.push(Buffer.from(value), event => events.push(event)); },
  });
  assert.deepEqual(events, [{ type: 'delta', text: 'Hel' }, { type: 'delta', text: 'lo' }, { type: 'done' }]);
});


test('a large-model sharing response can take longer than the ordinary thirty-second Spark timeout', { timeout: 45000 }, async t => {
  const host = await fixture(t, { sharingRpc: true, responseDelayMs: 31000 });
  const request = { action: 'inventory:sharing', id: 'fixture-model', enabled: true };
  assert.equal(await sparkRequest(host.profile, request), true);
  assert.equal(host.executed.length, 1);
});
