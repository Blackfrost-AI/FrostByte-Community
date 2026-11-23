import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TorrentEngine } from '../src/main/torrent.js';
import { validateSparkHost } from '../src/main/spark.js';

test('Spark host accepts SSH aliases and user@host without shell syntax', () => {
  assert.equal(validateSparkHost(' spark '),'spark');
  assert.equal(validateSparkHost('owner@spark.local'),'owner@spark.local');
  assert.throws(()=>validateSparkHost('')); assert.throws(()=>validateSparkHost('invalid host'));
});

test('Spark signal shutdown has a hard deadline below the Docker stop grace period', () => {
  const source = fs.readFileSync(new URL('../src/agent/server.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function handleStopSignal()'), source.indexOf("process.on('SIGTERM'"));
  assert.match(handler, /setTimeout\([\s\S]*process\.exit\(1\)[\s\S]*35_000/);
  assert.match(handler, /clearTimeout\(deadline\)/);
});

async function storageFixture(t, { missingExternal = false, saved, slowHF = false, stateSetup, blockAdd = false, failRemoveHash = '' } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-storage-')));
  const internal = path.join(home, 'internal'), external = path.join(home, 'external');
  const state = path.join(home, 'state');
  fs.mkdirSync(state);
  const storageRoots = [internal, external];
  const identities = storageRoots.map(root => ({ path: root, marker: crypto.randomBytes(16).toString('hex') }));
  for (const identity of identities) {
    if (missingExternal && identity.path === external) continue;
    fs.mkdirSync(identity.path);
    fs.writeFileSync(path.join(identity.path, '.frostbyte-storage-id'), identity.marker + '\n', { mode: 0o600 });
  }
  if (saved) fs.writeFileSync(path.join(state, 'agent.json'), JSON.stringify(saved({ internal, external, home })));
  if (stateSetup) stateSetup({ internal, external, home, state });
  const payload = slowHF ? crypto.randomBytes(512 * 1024) : Buffer.from('{"model_type":"frostbyte-test","storage":"selected"}\n');
  const etag = crypto.createHash('sha256').update(payload).digest('hex');
  const httpServer = http.createServer((req, res) => {
    if (req.url.startsWith('/api/models/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture/storage', sha: 'a'.repeat(40), gated: false, private: false,
        tags: ['license:apache-2.0'], siblings: [{ rfilename: 'config.json', size: payload.length }] })); return;
    }
    res.writeHead(200, { 'content-length': payload.length, etag });
    if (req.method === 'HEAD' || !slowHF) return res.end(req.method === 'HEAD' ? undefined : payload);
    let offset = 0;
    const timer = setInterval(() => {
      res.write(payload.subarray(offset, offset + 8192)); offset += 8192;
      if (offset >= payload.length) { clearInterval(timer); res.end(); }
    }, 30);
    res.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const preload = path.join(home, 'fixture-fetch.mjs');
  const blockAddGate = blockAdd ? path.join(home, 'block-add') : '';
  const torrentModule = new URL('../src/main/torrent.js', import.meta.url).href;
  fs.writeFileSync(preload, `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(input);
      if (url.origin === 'https://huggingface.co') return nativeFetch(process.env.FROSTBYTE_TEST_HF_ORIGIN + url.pathname + url.search, options);
      return nativeFetch(input, options);
    };
    if (process.env.FROSTBYTE_TEST_BLOCK_ADD || process.env.FROSTBYTE_TEST_FAIL_REMOVE_HASH) {
      const fs = await import('node:fs');
      const { setTimeout: delay } = await import('node:timers/promises');
      const { TorrentEngine } = await import(${JSON.stringify(torrentModule)});
      if (process.env.FROSTBYTE_TEST_BLOCK_ADD) {
        const originalAdd = TorrentEngine.prototype.add;
        TorrentEngine.prototype.add = async function (...args) {
          const gate = process.env.FROSTBYTE_TEST_BLOCK_ADD;
          fs.writeFileSync(gate + '.entered', 'entered');
          while (!fs.existsSync(gate + '.release')) await delay(10);
          return originalAdd.apply(this, args);
        };
      }
      if (process.env.FROSTBYTE_TEST_FAIL_REMOVE_HASH) {
        const originalRemove = TorrentEngine.prototype.remove;
        let failed = false;
        TorrentEngine.prototype.remove = async function (infoHash, ...args) {
          if (!failed && infoHash === process.env.FROSTBYTE_TEST_FAIL_REMOVE_HASH) {
            failed = true;
            throw new Error('Simulated rollback removal failure.');
          }
          return originalRemove.call(this, infoHash, ...args);
        };
      }
    }
  `);
  let child, log = '';
  const waitFor = async check => {
    for (let i = 0; i < 400; i++) { if (await check()) return; await delay(25); }
    throw new Error('Spark storage fixture timed out.');
  };
  const start = async () => {
    log = '';
    child = spawn(process.execPath, ['--import', preload, 'src/agent/server.js'], {
      env: { ...process.env, FROSTBYTE_AGENT_HOME: state, FROSTBYTE_DOWNLOAD_DIR: internal, FROSTBYTE_AGENT_TEST: '1',
        FROSTBYTE_STORAGE_ROOTS: JSON.stringify(storageRoots), FROSTBYTE_STORAGE_IDENTITIES: JSON.stringify(identities),
        FROSTBYTE_TEST_HF_ORIGIN: `http://127.0.0.1:${httpServer.address().port}`,
        ...(blockAddGate ? { FROSTBYTE_TEST_BLOCK_ADD: blockAddGate } : {}),
        ...(failRemoveHash ? { FROSTBYTE_TEST_FAIL_REMOVE_HASH: failRemoveHash } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', chunk => { log += chunk; });
    await waitFor(() => new Promise(resolve => {
      if (child.exitCode !== null) throw new Error(log);
      const socket = net.connect(path.join(state, 'control.sock'));
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    }));
  };
  const stop = async () => {
    if (!child) return null;
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    const closed = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    try {
      child.kill('SIGTERM');
      const [code, signal] = await closed;
      assert.equal(signal, null, `Companion fixture exited by ${signal}: ${log}`);
      return code;
    } finally { clearTimeout(timer); }
  };
  const rpc = request => new Promise((resolve, reject) => {
    const socket = net.connect(path.join(state, 'control.sock')); let output = '';
    socket.setTimeout(10000, () => socket.destroy(new Error('Spark fixture request timed out.')));
    socket.on('error', reject); socket.on('data', chunk => { output += chunk; });
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('end', () => { try { const result = JSON.parse(output); result.ok ? resolve(result.data) : reject(new Error(result.error)); } catch (error) { reject(error); } });
  });
  t.after(async () => {
    if (blockAddGate) fs.writeFileSync(blockAddGate + '.release', 'release');
    try { await stop(); }
    finally {
      httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); fs.rmSync(home, { recursive: true, force: true });
    }
  });
  await start();
  return { home, internal, external, state, storageRoots, identities, payload, rpc, waitFor, start, stop, blockAddGate,
    getChild: () => child, getLog: () => log };
}

const hfRequest = { action: 'hf:add', repoId: 'fixture/storage', revision: 'a'.repeat(40), files: [{ path: 'config.json', size: 0 }] };

test('HF peer lookup requires explicit sharing and an exact verified public HF file', { timeout: 30000 }, async t => {
  const f = await storageFixture(t);
  await f.rpc(hfRequest);
  await f.waitFor(async () => (await f.rpc({ action: 'status' })).downloads.every(d => d.status === 'done'));
  const identity = { repoId: hfRequest.repoId, revision: hfRequest.revision, filePath: 'config.json', size: f.payload.length, sha256: crypto.createHash('sha256').update(f.payload).digest('hex') };
  assert.equal(await f.rpc({ action: 'hf:peer', identity }), null);
  const entry = (await f.rpc({ action: 'status' })).inventory[0];
  await f.rpc({ action: 'inventory:sharing', id: entry.id, enabled: true });
  const plan = await f.rpc({ action: 'hf:peer', identity });
  assert.deepEqual(plan.identity, identity); assert.ok(plan.metadata.length > 0);
  const { validateHybridManifest } = await import('../src/main/hf-hybrid.js');
  await validateHybridManifest(Buffer.from(plan.metadata, 'base64'), identity);
  assert.equal(await f.rpc({ action: 'hf:peer', identity: { ...identity, sha256: '0'.repeat(64) } }), null);
  await f.rpc({ action: 'inventory:sharing', id: entry.id, enabled: false });
  assert.equal(await f.rpc({ action: 'hf:peer', identity }), null);
  assert.ok((await f.rpc({ action: 'status' })).torrents.every(torrent => torrent.paused));
});

test('an existing file explicitly shared from Spark can supply HF without another download or copy', { timeout: 30000 }, async t => {
  const f = await storageFixture(t);
  const file = path.join(f.internal, 'config.json'); fs.writeFileSync(file, f.payload);
  await f.rpc({ action: 'seed', relative: 'config.json', root: f.internal });
  const identity = { repoId: hfRequest.repoId, revision: hfRequest.revision, filePath: 'config.json', size: f.payload.length, sha256: crypto.createHash('sha256').update(f.payload).digest('hex') };
  const plan = await f.rpc({ action: 'hf:peer', identity });
  assert.deepEqual(plan.identity, identity);
  assert.equal((await f.rpc({ action: 'status' })).downloads.length, 0);
  assert.deepEqual(fs.readFileSync(file), f.payload);
  assert.equal(fs.existsSync(path.join(f.internal, 'fixture')), false);
});

test('Spark chooses internal or external storage per HF download and preserves both across restart', { timeout: 25000 }, async t => {
  const agent = await storageFixture(t);
  const initial = await agent.rpc({ action: 'status' });
  assert.deepEqual(initial.storageRoots, agent.storageRoots);
  assert.ok(initial.storage.every(item => item.available && item.freeBytes > 0 && item.totalBytes >= item.freeBytes));
  assert.equal(initial.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  assert.equal(initial.protocolVersion, 1);
  const internalIds = await agent.rpc({ ...hfRequest, destination: agent.internal });
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).downloads.every(item => item.status === 'done'));
  assert.deepEqual(fs.readFileSync(path.join(agent.internal, 'fixture/storage/config.json')), agent.payload);
  assert.equal(fs.existsSync(path.join(agent.external, 'fixture/storage/config.json')), false, 'one request writes only to its selected root');
  const externalIds = await agent.rpc({ ...hfRequest, destination: agent.external });
  assert.notEqual(internalIds[0], externalIds[0], 'the same model file can be downloaded to two selected disks');
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).downloads.every(item => item.status === 'done'));
  for (const root of agent.storageRoots) assert.deepEqual(fs.readFileSync(path.join(root, 'fixture/storage/config.json')), agent.payload);
  await agent.stop(); await agent.start();
  const restored = await agent.rpc({ action: 'status' });
  assert.equal(restored.downloadDir, agent.internal);
  assert.deepEqual(restored.downloads.map(item => item.destination).sort(), [...agent.storageRoots].sort());
  assert.equal(restored.downloads.find(item => item.id === externalIds[0]).dest, path.join(agent.external, 'fixture/storage/config.json'));
  const files = await agent.rpc({ action: 'files', root: agent.external, relative: 'fixture/storage' });
  assert.equal(files.root, agent.external);
  assert.equal(files.entries[0].relative, 'fixture/storage/config.json');
  const shared = await agent.rpc({ action: 'seed', root: agent.external, relative: 'fixture/storage/config.json' });
  assert.equal(shared.dataPath, path.join(agent.external, 'fixture/storage/config.json'));
});

test('Spark rejects nonportable and colliding HF selections before writing', async t => {
  const agent = await storageFixture(t);
  const request = files => agent.rpc({ ...hfRequest, destination: agent.internal, files: files.map(path => ({ path, size: 0 })) });
  await assert.rejects(request(['CON.json']), /reserved Windows device name/i);
  await assert.rejects(request(['Weights/model.gguf', 'weights/MODEL.gguf']), /collide/i);
  await assert.rejects(request(['weights/Caf\u00e9.gguf', 'weights/Cafe\u0301.gguf']), /collide/i);
  await assert.rejects(request(['model.gguf', 'model.gguf.frostpart']), /temporary download filename/i);
  assert.equal(fs.existsSync(path.join(agent.internal, 'fixture')), false, 'rejected selections create no repository directory');
  assert.deepEqual((await agent.rpc({ action: 'status' })).downloads, []);
});

test('Spark rejects an HF queue atomically when its state file cannot be written', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
  timeout: 15000,
}, async t => {
  const agent = await storageFixture(t);
  fs.chmodSync(agent.state, 0o500);
  try {
    await assert.rejects(agent.rpc({ ...hfRequest, destination: agent.internal }), /permission denied|EACCES/i);
  } finally {
    fs.chmodSync(agent.state, 0o700);
  }
  assert.deepEqual((await agent.rpc({ action: 'status' })).downloads, [], 'a rejected request must leave no hidden queued record');
  const [id] = await agent.rpc({ ...hfRequest, destination: agent.internal });
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).downloads.find(record => record.id === id)?.status === 'done');

  fs.chmodSync(agent.state, 0o500);
  try { await assert.rejects(agent.rpc({ action: 'hf:remove', id }), /permission denied|EACCES/i); }
  finally { fs.chmodSync(agent.state, 0o700); }
  assert.equal((await agent.rpc({ action: 'status' })).downloads.some(record => record.id === id), true, 'failed remove keeps the retryable row');
  await agent.rpc({ action: 'hf:remove', id });
  assert.equal((await agent.rpc({ action: 'status' })).downloads.some(record => record.id === id), false);

  const [clearId] = await agent.rpc({ ...hfRequest, files: [{ path: 'clear.json', size: 0 }], destination: agent.internal });
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).downloads.find(record => record.id === clearId)?.status === 'done');
  fs.chmodSync(agent.state, 0o500);
  try { await assert.rejects(agent.rpc({ action: 'hf:clear' }), /permission denied|EACCES/i); }
  finally { fs.chmodSync(agent.state, 0o700); }
  assert.equal((await agent.rpc({ action: 'status' })).downloads.some(record => record.id === clearId), true, 'failed clear keeps every terminal row');
  await agent.rpc({ action: 'hf:clear' });
  assert.equal((await agent.rpc({ action: 'status' })).downloads.some(record => record.id === clearId), false);
});

test('Spark rolls back torrent work and inventory controls when state persistence fails', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
  timeout: 30000,
}, async t => {
  const agent = await storageFixture(t);
  const source = path.join(agent.home, 'rollback-source.bin'), bytes = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(source, bytes);
  const seeder = new TorrentEngine({ dht: false, tracker: false, lsd: false, allowPeerAddresses: true });
  t.after(() => seeder.destroy());
  const shared = await seeder.seed(source);
  await agent.rpc({ action: 'torrent:add', source: `${shared.magnetURI}&x.pe=127.0.0.1:${seeder.port}` });
  let status;
  await agent.waitFor(async () => {
    status = await agent.rpc({ action: 'status' });
    return status.torrents[0]?.done && status.inventory.some(entry => entry.source === 'torrent');
  });
  const item = status.inventory.find(entry => entry.source === 'torrent');
  await agent.rpc({ action: 'inventory:sharing', id: item.id, enabled: false });
  status = await agent.rpc({ action: 'status' });
  assert.equal(status.torrents[0].paused, true);
  assert.equal(status.torrents[0].explicitShare, false);

  const rejectedHash = 'd'.repeat(40);
  const manual = path.join(agent.internal, 'manual-share.bin');
  fs.writeFileSync(manual, 'preserve manual bytes');
  fs.chmodSync(agent.state, 0o500);
  try {
    await assert.rejects(agent.rpc({ action: 'inventory:kind', id: item.id, kind: 'model' }), /permission denied|EACCES/i);
    await assert.rejects(agent.rpc({ action: 'inventory:sharing', id: item.id, enabled: true }), /permission denied|EACCES/i);
    await assert.rejects(agent.rpc({ action: 'torrent:resume', id: shared.infoHash }), /permission denied|EACCES/i);
    await assert.rejects(agent.rpc({ action: 'torrent:add', source: `magnet:?xt=urn:btih:${rejectedHash}` }), /permission denied|EACCES/i);
    await assert.rejects(agent.rpc({ action: 'seed', root: agent.internal, relative: path.basename(manual) }), /permission denied|EACCES/i);
    const durable = JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8'));
    assert.equal(durable.torrents.length, 1, 'engine events cannot publish rejected work before its RPC settles');
    assert.equal(durable.torrents[0].infohash, shared.infoHash);
    assert.equal(durable.torrents[0].paused, true);
    assert.equal(durable.torrents[0].explicitShare, false);
    assert.notEqual(durable.itemKinds[item.id], 'model', 'a rejected category change is never durable');
  } finally {
    fs.chmodSync(agent.state, 0o700);
  }

  status = await agent.rpc({ action: 'status' });
  const restored = status.torrents.find(torrent => torrent.infoHash === shared.infoHash);
  assert.equal(restored.paused, true, 'failed sharing enable restores the prior pause');
  assert.equal(restored.explicitShare, false, 'failed sharing enable restores the prior sharing intent');
  assert.equal(status.inventory.find(entry => entry.id === item.id).kind, item.kind, 'failed kind change restores the prior category');
  assert.equal(status.torrents.some(torrent => torrent.infoHash === rejectedHash), false, 'a rejected add leaves no active transfer');
  const rejectedSeed = status.torrents.find(torrent => torrent.dataPath === manual);
  assert.ok(!rejectedSeed || rejectedSeed.paused, 'a rejected seed is removed or left safely paused');
  assert.equal(fs.readFileSync(manual, 'utf8'), 'preserve manual bytes');

  await agent.rpc({ action: 'torrent:resume', id: shared.infoHash });
  assert.equal((await agent.rpc({ action: 'status' })).torrents.find(torrent => torrent.infoHash === shared.infoHash).paused, false);
  fs.chmodSync(agent.state, 0o500);
  try {
    await assert.rejects(agent.rpc({ action: 'torrent:pause', id: shared.infoHash }), /permission denied|EACCES/i);
    await assert.rejects(agent.rpc({ action: 'torrent:remove', id: shared.infoHash }), /permission denied|EACCES/i);
  } finally {
    fs.chmodSync(agent.state, 0o700);
  }
  const afterControlFailures = (await agent.rpc({ action: 'status' })).torrents.find(torrent => torrent.infoHash === shared.infoHash);
  assert.equal(afterControlFailures.paused, false, 'failed pause and remove restore the active transfer');
  assert.equal(afterControlFailures.explicitShare, false);
  assert.deepEqual(fs.readFileSync(path.join(agent.internal, path.basename(source))), bytes);
});

test('Spark shutdown drains an accepted serialized mutation, closes idle sockets, and rejects later dispatch', { timeout: 20000 }, async t => {
  const agent = await storageFixture(t, { blockAdd: true });
  const infoHash = 'f'.repeat(40);
  const accepted = agent.rpc({ action: 'torrent:add', source: `magnet:?xt=urn:btih:${infoHash}` });
  await agent.waitFor(() => fs.existsSync(agent.blockAddGate + '.entered'));

  const idle = net.connect(path.join(agent.state, 'control.sock'));
  idle.on('error', () => {});
  await once(idle, 'connect');
  const idleClosed = once(idle, 'close');
  const child = agent.getChild(), exited = once(child, 'exit');
  child.kill('SIGTERM');
  await idleClosed;
  await delay(100);
  assert.equal(child.exitCode, null, 'shutdown must wait for the accepted mutation gate');
  await assert.rejects(agent.rpc({ action: 'status' }), /ECONNREFUSED|ENOENT|timed out|Unexpected end/i);

  fs.writeFileSync(agent.blockAddGate + '.release', 'release');
  const shared = await accepted;
  const [code, signal] = await exited;
  assert.equal(signal, null); assert.equal(code, 0);
  const durable = JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8'));
  assert.equal(shared.infoHash, infoHash);
  assert.equal(durable.torrents.some(torrent => torrent.infohash === infoHash), true, 'accepted mutation is persisted before exit');
  assert.doesNotMatch(agent.getLog(), /UnhandledPromiseRejection|unhandled rejection/i);
});

test('Spark reports an incomplete torrent rollback and leaves failed cleanup visibly paused', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
  timeout: 15000,
}, async t => {
  const infoHash = 'e'.repeat(40);
  const agent = await storageFixture(t, { failRemoveHash: infoHash });
  fs.chmodSync(agent.state, 0o500);
  try {
    await assert.rejects(
      agent.rpc({ action: 'torrent:add', source: `magnet:?xt=urn:btih:${infoHash}` }),
      /rollback was incomplete.*remains paused/i,
    );
  } finally { fs.chmodSync(agent.state, 0o700); }

  const status = await agent.rpc({ action: 'status' });
  const ghost = status.torrents.find(torrent => torrent.infoHash === infoHash);
  assert.ok(ghost, 'failed cleanup remains represented in live and durable state');
  assert.equal(ghost.paused, true);
  assert.match(ghost.error, /remains paused/i);
  const durable = JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8'));
  assert.equal(durable.torrents.find(torrent => torrent.infohash === infoHash)?.paused, true);
  await agent.rpc({ action: 'torrent:remove', id: infoHash });
});

test('Spark exits nonzero when its final shutdown state cannot be persisted without an unhandled rejection', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
  timeout: 15000,
}, async t => {
  const agent = await storageFixture(t);
  fs.chmodSync(agent.state, 0o500);
  let code;
  try { code = await agent.stop(); }
  finally { fs.chmodSync(agent.state, 0o700); }
  assert.equal(code, 1);
  assert.match(agent.getLog(), /Final Spark state could not be saved/i);
  assert.doesNotMatch(agent.getLog(), /UnhandledPromiseRejection|unhandled rejection/i);
});

test('Spark restores an interrupted active HF row paused without retaining its token or restarting it', async t => {
  const agent = await storageFixture(t, { saved: ({ internal }) => ({ downloads: [{
    id: 'interrupted', repoId: 'fixture/storage', revision: 'a'.repeat(40), filePath: 'config.json',
    destination: internal, dest: path.join(internal, 'fixture/storage/config.json'), total: 51, downloaded: 1,
    progress: 0.01, status: 'active', error: '', token: 'must-not-survive',
  }] }) });
  const [record] = (await agent.rpc({ action: 'status' })).downloads;
  assert.equal(record.status, 'paused');
  assert.equal(fs.existsSync(record.dest), false, 'an interrupted active row is not silently run');
  const saved = JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8'));
  assert.equal(saved.downloads[0].status, 'paused');
  assert.equal(JSON.stringify(saved).includes('must-not-survive'), false);
});

test('Spark keeps a completed HF row truthful in memory and retries its final state write', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
  timeout: 20000,
}, async t => {
  const agent = await storageFixture(t, { slowHF: true });
  const [id] = await agent.rpc({ ...hfRequest, destination: agent.internal });
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).downloads.find(record => record.id === id)?.status === 'active');
  fs.chmodSync(agent.state, 0o500);
  try {
    await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).downloads.find(record => record.id === id)?.status === 'done');
    const durable = JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8')).downloads.find(record => record.id === id);
    assert.equal(durable.status, 'active', 'the failed final flush must not falsify the live completed result');
  } finally {
    fs.chmodSync(agent.state, 0o700);
  }
  await agent.waitFor(() => JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8')).downloads
    .find(record => record.id === id)?.status === 'done');
  assert.equal((await agent.rpc({ action: 'status' })).downloads.find(record => record.id === id)?.status, 'done');
});

test('generic torrent downloads use the chosen external storage and restore that destination', { timeout: 25000 }, async t => {
  const agent = await storageFixture(t);
  const source = path.join(agent.home, 'update.zip');
  const bytes = crypto.randomBytes(128 * 1024);
  fs.writeFileSync(source, bytes);
  const seed = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  t.after(() => seed.destroy());
  const shared = await seed.seed(source);
  await agent.rpc({ action: 'torrent:add', destination: agent.external, source: shared.magnetURI + `&x.pe=127.0.0.1:${seed.port}` });
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).torrents[0]?.done);
  assert.deepEqual(fs.readFileSync(path.join(agent.external, 'update.zip')), bytes);
  assert.equal(fs.existsSync(path.join(agent.internal, 'update.zip')), false);
  await agent.stop(); await agent.start();
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).torrents[0]?.done);
  assert.equal((await agent.rpc({ action: 'status' })).torrents[0].destination, agent.external);
  await assert.rejects(agent.rpc({ action: 'torrent:add', source: shared.magnetURI, destination: agent.internal }), /already.*another storage/i);
});

test('an unavailable external root is never created or used as a fallback download folder', { timeout: 15000 }, async t => {
  const agent = await storageFixture(t, { missingExternal: true });
  const status = await agent.rpc({ action: 'status' });
  assert.equal(status.storage.find(item => item.path === agent.external).available, false);
  await assert.rejects(agent.rpc({ ...hfRequest, destination: agent.external }), /storage unavailable/i);
  await assert.rejects(agent.rpc({ action: 'torrent:add', destination: agent.external, source: 'magnet:?xt=urn:btih:' + 'b'.repeat(40) }), /storage unavailable/i);
  await assert.rejects(agent.rpc({ action: 'files', root: agent.external }), /storage unavailable/i);
  assert.equal(fs.existsSync(agent.external), false);
  assert.deepEqual(fs.readdirSync(agent.internal), ['.frostbyte-storage-id']);
});

test('oversized storage identity markers are rejected before their contents are read', { timeout: 15000 }, async t => {
  const agent = await storageFixture(t);
  fs.writeFileSync(path.join(agent.external, '.frostbyte-storage-id'), 'a'.repeat(1024 * 1024));
  await assert.rejects(agent.rpc({ action: 'files', root: agent.external }), /storage unavailable|bounded regular file/i);
  assert.equal((await agent.rpc({ action: 'status' })).storage.find(item => item.path === agent.external).available, false);
});

test('disconnecting storage pauses torrents and missing identity stays unavailable after restart', { timeout: 20000 }, async t => {
  const agent = await storageFixture(t);
  const source = 'magnet:?xt=urn:btih:' + 'c'.repeat(40);
  const added = await agent.rpc({ action: 'torrent:add', destination: agent.external, source });
  const pendingState = JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8')).torrents[0];
  assert.equal(pendingState.magnet, source);
  assert.equal(pendingState.torrentFile, undefined, 'announce-only WebTorrent envelopes are not persisted as metadata');
  const detached = agent.external + '-detached';
  fs.renameSync(agent.external, detached);
  fs.mkdirSync(agent.external); // simulate the exposed, empty underlying mountpoint
  let lastTorrent;
  await agent.waitFor(async () => { lastTorrent = (await agent.rpc({ action: 'status' })).torrents[0]; return lastTorrent?.paused && /storage unavailable/i.test(lastTorrent.error); })
    .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(lastTorrent)}`); });
  await assert.rejects(agent.rpc({ action: 'torrent:resume', id: added.infoHash }), /storage unavailable/i);
  await assert.rejects(agent.rpc({ ...hfRequest, destination: agent.external }), /storage unavailable/i);
  await agent.stop(); await agent.start();
  const unavailable = await agent.rpc({ action: 'status' });
  assert.equal(unavailable.storage.find(item => item.path === agent.external).available, false);
  assert.equal(unavailable.torrents[0].paused, true);
  assert.match(unavailable.torrents[0].error, /storage unavailable/i);
  assert.deepEqual(fs.readdirSync(agent.external), [], 'restart must not create metadata or downloads on the exposed mountpoint');
  fs.rmdirSync(agent.external); fs.renameSync(detached, agent.external);
  await agent.rpc({ action: 'torrent:resume', id: added.infoHash });
  assert.equal((await agent.rpc({ action: 'status' })).torrents[0].paused, false);
  await agent.rpc({ action: 'torrent:remove', id: added.infoHash });
});

test('Spark refuses unregistered roots, parent paths, and linked destinations', { timeout: 15000 }, async t => {
  const agent = await storageFixture(t);
  const outside = path.join(agent.home, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'config.json'), 'preserve');
  fs.symlinkSync(outside, path.join(agent.external, 'linked'));
  fs.symlinkSync(outside, path.join(agent.external, 'fixture'));
  await assert.rejects(agent.rpc({ ...hfRequest, destination: outside }), /registered Spark storage/i);
  await assert.rejects(agent.rpc({ action: 'files', root: agent.external, relative: '../outside' }), /inside.*storage/i);
  await assert.rejects(agent.rpc({ action: 'files', root: agent.external, relative: 'linked' }), /linked/i);
  await assert.rejects(agent.rpc({ action: 'seed', root: agent.external, relative: 'linked/config.json' }), /linked/i);
  await assert.rejects(agent.rpc({ action: 'torrent:add', source: path.join(agent.home, 'private.torrent') }), /magnet|metadata/i);
  await assert.rejects(agent.rpc({ ...hfRequest, destination: agent.external }), /symbolic|linked/i);
  assert.equal(fs.readFileSync(path.join(outside, 'config.json'), 'utf8'), 'preserve');
  assert.deepEqual(fs.readdirSync(outside), ['config.json']);
});

test('disconnecting storage interrupts an active HF transfer without writing to its replacement mountpoint', { timeout: 15000 }, async t => {
  const agent = await storageFixture(t, { slowHF: true });
  const [id] = await agent.rpc({ ...hfRequest, destination: agent.external });
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).downloads.find(item => item.id === id)?.downloaded > 0);
  fs.renameSync(agent.external, agent.external + '-detached');
  fs.mkdirSync(agent.external);
  await agent.waitFor(async () => (await agent.rpc({ action: 'status' })).downloads.find(item => item.id === id)?.status === 'error');
  const record = (await agent.rpc({ action: 'status' })).downloads.find(item => item.id === id);
  assert.match(record.error, /storage unavailable/i);
  assert.equal(record.destination, agent.external);
  assert.deepEqual(fs.readdirSync(agent.external), []);
  await assert.rejects(agent.rpc({ action: 'hf:resume', id }), /storage unavailable/i);
});

test('saved HF paths outside registered roots remain blocked instead of moving to the primary disk', { timeout: 15000 }, async t => {
  const agent = await storageFixture(t, { saved: ({ home }) => ({ torrents: [], downloads: [{
    id: 'saved-unregistered', repoId: 'fixture/storage', revision: 'a'.repeat(40), filePath: 'config.json',
    dest: path.join(home, 'unregistered/fixture/storage/config.json'), status: 'queued', progress: 0,
  }] }) });
  const record = (await agent.rpc({ action: 'status' })).downloads[0];
  assert.equal(record.status, 'error');
  assert.match(record.error, /not registered/i);
  assert.equal(record.dest, path.join(agent.home, 'unregistered/fixture/storage/config.json'));
  await assert.rejects(agent.rpc({ action: 'hf:resume', id: record.id }), /not registered/i);
  assert.equal(fs.existsSync(path.join(agent.internal, 'fixture')), false);
});

test('Spark never reads a substituted or hardlinked agent state file', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  await t.test('symbolic link', async t => {
    const victimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-agent-state-victim-'));
    const victim = path.join(victimRoot, 'victim.json');
    const payload = JSON.stringify({ downloads: [{ token: 'do-not-read-or-persist' }] });
    fs.writeFileSync(victim, payload);
    t.after(() => fs.rmSync(victimRoot, { recursive: true, force: true }));
    const agent = await storageFixture(t, { stateSetup: ({ state }) => fs.symlinkSync(victim, path.join(state, 'agent.json')) });
    assert.deepEqual((await agent.rpc({ action: 'status' })).downloads, []);
    assert.equal(fs.readFileSync(victim, 'utf8'), payload);
    assert.ok(fs.readdirSync(agent.state).some(name => name.startsWith('agent.json.unsafe-')));
    assert.equal(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8').includes('do-not-read'), false);
  });

  await t.test('hard link', async t => {
    const victimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-agent-state-victim-'));
    const victim = path.join(victimRoot, 'victim.json');
    const payload = JSON.stringify({ downloads: [{ token: 'hardlink-secret' }] });
    fs.writeFileSync(victim, payload);
    try { fs.linkSync(victim, path.join(victimRoot, 'hardlink-probe')); fs.rmSync(path.join(victimRoot, 'hardlink-probe')); }
    catch (error) { fs.rmSync(victimRoot, { recursive: true, force: true }); t.skip(`hard links are unavailable: ${error.code}`); return; }
    t.after(() => fs.rmSync(victimRoot, { recursive: true, force: true }));
    const agent = await storageFixture(t, { stateSetup: ({ state }) => fs.linkSync(victim, path.join(state, 'agent.json')) });
    assert.deepEqual((await agent.rpc({ action: 'status' })).downloads, []);
    assert.equal(fs.readFileSync(victim, 'utf8'), payload);
    assert.ok(fs.readdirSync(agent.state).some(name => name.startsWith('agent.json.unsafe-')));
    assert.equal(fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8').includes('hardlink-secret'), false);
  });
});

test('Spark quarantines oversized state and drops unsupported persisted records', { timeout: 20000 }, async t => {
  await t.test('oversized state is never parsed', async t => {
    const agent = await storageFixture(t, { stateSetup: ({ state }) => {
      const file = path.join(state, 'agent.json'); fs.writeFileSync(file, ''); fs.truncateSync(file, 70 * 1024 * 1024);
    } });
    const status = await agent.rpc({ action: 'status' });
    assert.deepEqual(status.downloads, []); assert.deepEqual(status.torrents, []);
    assert.ok(fs.readdirSync(agent.state).some(name => name.startsWith('agent.json.oversized-')));
    assert.ok(fs.statSync(path.join(agent.state, 'agent.json')).size < 1024 * 1024);
  });

  await t.test('unsupported torrent and download fields do not survive startup', async t => {
    const agent = await storageFixture(t, { saved: ({ internal }) => ({
      torrents: [{ infohash: 'b'.repeat(40), magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}`, path: internal, paused: true, unexpected: 'retain-me' }],
      downloads: [
        { id: 'bad-repo', repoId: '../private', revision: 'a'.repeat(40), filePath: 'config.json', dest: path.join(internal, 'private/config.json'), status: 'queued' },
        { id: 'bad-status', repoId: 'fixture/storage', revision: 'a'.repeat(40), filePath: 'config.json', dest: path.join(internal, 'fixture/storage/config.json'), status: 'executing', token: 'state-secret' },
      ],
      inventory: [{ source: 'torrent', id: 'f'.repeat(64), infoHash: 'f'.repeat(40), name: 'oversized', destination: internal, path: internal, directory: true,
        files: Array.from({ length: 5001 }, (_, index) => ({ path: `file-${index}`, size: 1 })) }],
    }) });
    const status = await agent.rpc({ action: 'status' });
    assert.deepEqual(status.downloads, []); assert.deepEqual(status.torrents, []); assert.deepEqual(status.inventory, []);
    const persisted = fs.readFileSync(path.join(agent.state, 'agent.json'), 'utf8');
    assert.equal(persisted.includes('retain-me'), false); assert.equal(persisted.includes('state-secret'), false);
  });
});

test('headless Spark service downloads selected generic files, browses and restores them', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'fb-agent-'));
  const downloadDir=path.join(home,'downloads'),stateDir=path.join(home,'state');
  const source=path.join(home,'update');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'config.json'),'{"beta":true}');
  fs.writeFileSync(path.join(source,'weights.gguf'),Buffer.alloc(4*1024*1024,7));
  const seed=new TorrentEngine({dht:false,tracker:false,lsd:false});
  let child;
  const waitFor=async fn=>{for(let i=0;i<400;i++){if(await fn())return;await delay(25);}throw new Error('Timed out');};
  const start=async()=>{
    child=spawn(process.execPath,['src/agent/server.js'],{env:{...process.env,FROSTBYTE_AGENT_HOME:stateDir,FROSTBYTE_DOWNLOAD_DIR:downloadDir,FROSTBYTE_AGENT_TEST:'1'},stdio:['ignore','pipe','pipe']});
    let log='';child.stderr.on('data',chunk=>{log+=chunk;});
    await waitFor(()=>{if(child.exitCode!==null)throw new Error(log);return fs.existsSync(path.join(stateDir,'control.sock'));});
  };
  const stop=async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}};
  const rpc=request=>new Promise((resolve,reject)=>{
    const socket=net.connect(path.join(stateDir,'control.sock'));let output='';
    socket.on('error',reject);socket.on('data',chunk=>{output+=chunk;});
    socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('end',()=>{try{const result=JSON.parse(output);result.ok?resolve(result.data):reject(new Error(result.error));}catch(error){reject(error);}});
  });
  try {
    const shared=await seed.seed(source);await start();
    const initial=await rpc({action:'status'});assert.equal(initial.torrents.length,0);assert.ok(initial.freeBytes>0);
    await rpc({action:'torrent:add',source:shared.magnetURI+`&x.pe=127.0.0.1:${seed.port}`,selectedPaths:['update/config.json']});
    await waitFor(async()=> (await rpc({action:'status'})).torrents[0]?.done);
    assert.equal(fs.readFileSync(path.join(downloadDir,'update/config.json'),'utf8'),'{"beta":true}');
    assert.equal((await rpc({action:'files',relative:''})).entries[0].name,'update');
    assert.equal((await rpc({action:'files',relative:'update'})).entries.some(f=>f.name==='config.json'),true);
    await stop();await start();
    await waitFor(async()=> (await rpc({action:'status'})).torrents[0]?.done);
    const restored=(await rpc({action:'status'})).torrents[0];assert.equal(restored.partial,true);assert.equal(restored.length,13);
    await rpc({action:'torrent:pause',id:restored.infoHash});
    assert.equal((await rpc({action:'status'})).torrents[0].paused,true);
    await rpc({action:'torrent:remove',id:restored.infoHash});
    assert.equal((await rpc({action:'status'})).torrents.length,0);
    assert.equal(fs.existsSync(path.join(downloadDir,'update/config.json')),true);
  } finally {await stop();await seed.destroy();fs.rmSync(home,{recursive:true,force:true});}
});

test('companion assistant stream aborts when the client disconnects and on explicit cancel', { timeout: 30000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-assistant-agent-')));
  const state = path.join(home, 'state'); fs.mkdirSync(state);
  let aborted = 0, requests = 0;
  const runtime = http.createServer((req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] })); return; }
    if (req.url === '/v1/chat/completions') {
      requests += 1;
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"working"}}]}\n\n');
      const timer = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { clearInterval(timer); } }, 200);
      res.on('close', () => { aborted += 1; clearInterval(timer); });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => runtime.listen(8000, '127.0.0.1', resolve));
  let child, log = '';
  const waitFor = async check => { for (let i = 0; i < 400; i++) { if (await check()) return; await delay(25); } throw new Error('Assistant companion fixture timed out: ' + log); };
  const start = async () => {
    child = spawn(process.execPath, ['src/agent/server.js'], { env: { ...process.env, FROSTBYTE_AGENT_HOME: state, FROSTBYTE_DOWNLOAD_DIR: home, FROSTBYTE_AGENT_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => { log += chunk; });
    await waitFor(() => new Promise(resolve => {
      if (child.exitCode !== null) throw new Error(log);
      const probe = net.connect(path.join(state, 'control.sock'));
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    }));
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try { await closed; } finally { clearTimeout(timer); }
  };
  t.after(async () => { await stop(); runtime.closeAllConnections(); await new Promise(resolve => runtime.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  const streamRequest = stream => ({ action: 'assistant:chat:start', stream, model: { deviceId: 'paired-device', provider: 'vllm', name: 'fixture-chat' }, messages: [{ role: 'user', content: 'Hello' }] });
  await start();
  const catalog = await new Promise((resolve, reject) => {
    const socket = net.connect(path.join(state, 'control.sock')); let output = '';
    socket.on('error', reject); socket.on('data', chunk => { output += chunk; });
    socket.on('connect', () => socket.write(JSON.stringify({ action: 'assistant:models' }) + '\n'));
    socket.on('end', () => { try { const result = JSON.parse(output); result.ok ? resolve(result.data) : reject(new Error(result.error)); } catch (error) { reject(error); } });
  });
  assert.ok(catalog.models.some(item => item.name === 'fixture-chat'));
  // Case 1: the desktop disappears mid-stream (Stop tears down the SSH channel).
  const first = net.connect(path.join(state, 'control.sock'));
  first.on('error', () => {});
  await once(first, 'connect');
  first.write(JSON.stringify(streamRequest('s_disconnect01')) + '\n');
  await waitFor(() => requests >= 1);
  first.destroy();
  await waitFor(() => aborted >= 1);
  // Case 2: explicit restricted cancel action aborts the same generation.
  const second = net.connect(path.join(state, 'control.sock'));
  second.on('error', () => {});
  await once(second, 'connect');
  second.write(JSON.stringify(streamRequest('s_explicit0002')) + '\n');
  await waitFor(() => requests >= 2);
  const cancelSocket = net.connect(path.join(state, 'control.sock')); let cancelOut = '';
  cancelSocket.on('error', () => {});
  cancelSocket.on('data', chunk => { cancelOut += chunk; });
  await once(cancelSocket, 'connect');
  cancelSocket.write(JSON.stringify({ action: 'assistant:chat:cancel', stream: 's_explicit0002' }) + '\n');
  await waitFor(() => aborted >= 2);
  await waitFor(() => cancelOut.includes('"ok":true'));
  cancelSocket.destroy(); second.destroy();
});
