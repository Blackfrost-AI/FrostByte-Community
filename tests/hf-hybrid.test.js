import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { TorrentEngine } from '../src/main/torrent.js';
import { createHybridManifest, validateHybridManifest, downloadHybrid, identityKey, validateIdentity } from '../src/main/hf-hybrid.js';
import { hfFetchPublicRange, hfFetchRange, sha256File } from '../src/main/hf.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hybrid-'));
  const payload = crypto.randomBytes(40 * 1024 * 1024), source = path.join(root, 'model.gguf');
  fs.writeFileSync(source, payload);
  const identity = { repoId: 'fixture/model', revision: 'a'.repeat(40), filePath: 'model.gguf', size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const metadata = await createHybridManifest(source, identity);
  const sender = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  const receiver = new TorrentEngine({ dht: false, tracker: false, lsd: true, allowPeerAddresses: true });
  sender.setLimits({ up: 2 * 1024 * 1024 });
  await sender.add(metadata, { path: root, explicitShare: true, allowExisting: true });
  let badRange = false, hfAvailable = true;
  const server = http.createServer(async (request, response) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    if (!range || !hfAvailable) { response.writeHead(503); response.end(); return; }
    const start = +range[1], end = +range[2];
    await delay(150);
    response.writeHead(badRange ? 200 : 206, { 'Content-Range': `bytes ${start}-${end}/${payload.length}`, 'Content-Length': end - start + 1 });
    response.end(payload.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetchImpl = (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/model`, options);
  const plan = { identity, metadata: metadata.toString('base64'), peers: [`127.0.0.1:${sender.port}`] };
  t.after(async () => { if (!receiver._destroyed) await receiver.destroy(); if (!sender._destroyed) await sender.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, approvedRoot: root, source, sender, receiver, identity, plan, metadata, fetchImpl,
    approvePeers: async () => true, setBadRange: v => { badRange = v; }, setHfAvailable: v => { hfAvailable = v; } };
}

test('one download receives real HF ranges and peer bytes; no duplicate inventory or uploading', { timeout: 60000 }, async t => {
  const f = await fixture(t), dest = path.join(f.root, 'received.gguf');
  let progress, uploaded = 0;
  f.receiver.client.on('torrent', torrent => torrent.on('wire', wire => wire.on('upload', bytes => { uploaded += bytes; })));
  const result = await downloadHybrid({ ...f, dest, client: f.receiver.client, signal: new AbortController().signal, onProgress: value => { progress = value; assert.equal(f.receiver.list().length, 0); assert.equal(f.receiver.sessions().length, 0); if (f.receiver.client.torrents[0]) assert.equal(f.receiver.client.torrents[0].discovery.pairedOnly, true); } });
  assert.equal(await sha256File(dest), f.identity.sha256);
  assert.ok(result.hfBytes > 0, 'HF contributed bytes'); assert.ok(result.peerBytes > 0, 'TCP peer contributed bytes');
  assert.equal(uploaded, 0); assert.equal(progress.phase, 'verifying');
  assert.equal(fs.existsSync(dest + '.frosthybrid'), false); assert.equal(f.receiver.client.torrents.length, 0);
});

test('pause preserves pieces and HF can finish after the Spark peer disconnects', { timeout: 60000 }, async t => {
  const f = await fixture(t), dest = path.join(f.root, 'resumed.gguf'), controller = new AbortController();
  await assert.rejects(downloadHybrid({ ...f, dest, client: f.receiver.client, signal: controller.signal, checkpointMs: 100,
    onProgress: value => { if (value.downloaded >= 4 * 1024 * 1024) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(fs.existsSync(dest), false); assert.ok(fs.existsSync(dest + '.frosthybrid/manifest.json'));
  await f.sender.destroy();
  const result = await downloadHybrid({ ...f, plan: null, dest, client: f.receiver.client, signal: new AbortController().signal });
  assert.ok(result.resumedBytes > 0); assert.equal(await sha256File(dest), f.identity.sha256);
});

test('a second peer cannot fetch model pieces from a receive-only HF download', { timeout: 60000 }, async t => {
  const f = await fixture(t), observer = new TorrentEngine({ dht: false, tracker: false, lsd: false, allowPeerAddresses: true });
  t.after(async () => { if (!observer._destroyed) await observer.destroy(); });
  f.setHfAvailable(false);
  let attempt, observedBytes = -1;
  const dest = path.join(f.root, 'receive-only.gguf');
  await downloadHybrid({ ...f, dest, client: f.receiver.client, signal: new AbortController().signal, onProgress: value => {
    if (!attempt && value.downloaded >= 4 * 1024 * 1024) {
      attempt = (async () => {
        const remote = await observer.add(f.metadata, { path: path.join(f.root, 'observer') });
        const torrent = await observer.client.get(remote.infoHash);
        torrent.addPeer('127.0.0.1:' + f.receiver.port);
        await delay(1500);
        assert.ok(torrent.wires.length > 0, 'Observer connected to the receiving client');
        observedBytes = torrent.downloaded;
        await observer.destroy();
      })();
      attempt.catch(() => {});
    }
  } });
  await attempt; assert.equal(observedBytes, 0);
  assert.equal(await sha256File(dest), f.identity.sha256);
});

test('wrong manifest, changed local file, wrong HTTP ranges, and revision mismatch fail closed', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(validateHybridManifest(f.metadata, { ...f.identity, size: 12 }));
  await assert.rejects(createHybridManifest(f.source, { ...f.identity, sha256: '0'.repeat(64) }));
  const dest = path.join(f.root, 'bad.gguf'); f.setBadRange(true);
  await assert.rejects(downloadHybrid({ ...f, plan: { ...f.plan, peers: [] }, dest, client: f.receiver.client,
    signal: new AbortController().signal, idleTimeout: 1500 }), /stopped responding/);
  assert.equal(fs.existsSync(dest), false);
  const different = { ...f.identity, revision: 'b'.repeat(40) };
  assert.notEqual(identityKey(different), identityKey(f.identity));
  await assert.rejects(downloadHybrid({ ...f, identity: different, dest, client: f.receiver.client, signal: new AbortController().signal }), /different (?:revision|HF file)/);
});

test('identity, plan, and public range inputs use exact bounded schemas', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hybrid-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = crypto.randomBytes(64 * 1024), source = path.join(root, 'model.gguf');
  fs.writeFileSync(source, payload);
  const identity = { repoId: 'fixture/model', revision: 'a'.repeat(40), filePath: 'model.gguf',
    size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const metadata = await createHybridManifest(source, identity);
  const plan = { identity, metadata: metadata.toString('base64'), peers: [] };
  const client = { get: async () => null, add: () => { throw new Error('invalid input reached the torrent client'); } };
  const signal = new AbortController().signal;
  assert.throws(() => validateIdentity({ ...identity, unexpected: true }), /unsupported fields/);
  assert.throws(() => validateIdentity({ ...identity, repoId: `${'a'.repeat(200)}/b` }), /repository ID/);
  assert.throws(() => validateIdentity({ ...identity, filePath: 'a'.repeat(4097) }), /file path/);
  for (const [name, hostile, pattern] of [
    ['extra', { ...plan, unexpected: true }, /unsupported fields/],
    ['base64', { ...plan, metadata: `${plan.metadata}\n` }, /invalid or too large/],
    ['peers', { ...plan, peers: Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}:6881`) }, /too many device addresses/],
    ['duplicate', { ...plan, peers: ['10.0.0.2:6881', '10.0.0.2:6881'] }, /repeats a device address/],
  ]) {
    const dest = path.join(root, `${name}.gguf`);
    await assert.rejects(downloadHybrid({ identity, plan: hostile, dest, approvedRoot: root, client, signal }), pattern);
    assert.equal(fs.existsSync(`${dest}.frosthybrid`), false, 'invalid remote data must not create partial folders');
  }
  await assert.rejects(downloadHybrid({ identity, plan, dest: path.join(root, 'no-root.gguf'), client, signal }), /valid local download folder/);
  await assert.rejects(hfFetchPublicRange('http://huggingface.co/file', { headers: { Range: 'bytes=0-1' } }), /untrusted download host/);
  await assert.rejects(hfFetchPublicRange('https://127.0.0.1/file', { headers: { Range: 'bytes=0-1' } }), /untrusted download host/);
  await assert.rejects(hfFetchPublicRange('https://huggingface.co/file', { headers: { Range: 'bytes=0-', Authorization: 'secret' } }), /invalid HuggingFace byte range/i);
  const publishedCdnHosts = [
    'aws.cdn.hf.co', 'us-east-1.aws.cdn.hf.co', 'us-west-2.aws.cdn.hf.co',
    'eu-west-3.aws.cdn.hf.co', 'ap-southeast-1.aws.cdn.hf.co',
    'us-east1.us.gcp.cdn.hf.co', 'us-central1.us.gcp.cdn.hf.co', 'us-west4.us.gcp.cdn.hf.co',
    'europe-west4.us.gcp.cdn.hf.co', 'asia-southeast1.us.gcp.cdn.hf.co',
  ];
  const originalFetch = globalThis.fetch;
  const reached = [];
  globalThis.fetch = async (url, options) => {
    reached.push(new URL(url).hostname);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Range, 'bytes=0-1');
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    return new Response(Buffer.from('ok'), { status: 206, headers: { 'Content-Range': 'bytes 0-1/2' } });
  };
  try {
    for (const host of publishedCdnHosts) {
      const response = await hfFetchPublicRange(`https://${host}/blob`, { headers: { Range: 'bytes=0-1' } });
      await response.body.cancel();
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(reached, publishedCdnHosts);
  await assert.rejects(hfFetchPublicRange('https://aws.cdn.hf.co.attacker.invalid/file', { headers: { Range: 'bytes=0-1' } }), /untrusted download host/);
});

test('authenticated range downloads send the HF token only to HuggingFace', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: { ...options.headers }, redirect: options.redirect });
    if (calls.length === 1) {
      return new Response(null, { status: 307, headers: { location: 'https://cdn-lfs.huggingface.co/model/blob' } });
    }
    return new Response(Buffer.from('ok'), { status: 206, headers: { 'Content-Range': 'bytes 0-1/2' } });
  };
  try {
    const response = await hfFetchRange('https://huggingface.co/owner/model/resolve/main/model.gguf', {
      headers: { Range: 'bytes=0-1' }, token: 'test-token',
    });
    await response.body.cancel();
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].headers.Range, 'bytes=0-1');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[1].headers.Authorization, undefined, 'credentials are stripped on the signed CDN hop');
  assert.equal(calls[1].headers.Range, 'bytes=0-1');
});

test('unapproved private peer plans cannot touch storage, clients, or sockets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hybrid-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = crypto.randomBytes(64 * 1024), source = path.join(root, 'source.gguf');
  fs.writeFileSync(source, payload);
  const identity = { repoId: 'fixture/model', revision: 'a'.repeat(40), filePath: 'model.gguf',
    size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const metadata = await createHybridManifest(source, identity);
  const parsed = await validateHybridManifest(metadata, identity);
  const plan = { identity, metadata: metadata.toString('base64'), peers: ['192.168.50.20:6881'] };
  let clientCalls = 0, socketCalls = 0;
  const client = { get: async () => { clientCalls++; return null; }, add: () => { clientCalls++; throw new Error('client activity was not approved'); } };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { socketCalls++; return connect.apply(this, args); };
  t.after(() => { net.Socket.prototype.connect = connect; });
  const signal = new AbortController().signal;
  const destination = name => path.join(root, `${name}.gguf`);

  await assert.rejects(downloadHybrid({ identity, plan, dest: destination('missing'), approvedRoot: root, client, signal }), /explicit approval/);
  let request, repeatedRequest;
  await assert.rejects(downloadHybrid({ identity, plan, dest: destination('denied'), approvedRoot: root, client, signal,
    approvePeers: async value => { request = value; return false; } }), /not approved/);
  await assert.rejects(downloadHybrid({ identity, plan, dest: destination('threw'), approvedRoot: root, client, signal,
    approvePeers: async value => { repeatedRequest = value; throw new Error('approval context expired'); } }), /approval context expired/);
  let ipv6Request;
  await assert.rejects(downloadHybrid({ identity,
    plan: { ...plan, peers: ['[fd00:0:0:0:0:0:0:20]:6881'] },
    dest: destination('ipv6-denied'), approvedRoot: root, client, signal,
    approvePeers: async value => { ipv6Request = value; return false; },
  }), /not approved/);

  assert.notEqual(request.identity, identity);
  assert.deepEqual(request, { identity, planDigest: request.planDigest, infoHash: parsed.infoHash, peers: ['192.168.50.20:6881'] });
  assert.match(request.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(repeatedRequest.planDigest, request.planDigest);
  assert.deepEqual(ipv6Request.peers, ['[fd00::20]:6881']);
  assert.deepEqual(Object.keys(request).sort(), ['identity', 'infoHash', 'peers', 'planDigest']);
  request.identity.repoId = 'mutated/copy'; request.peers[0] = '127.0.0.1:1';
  assert.equal(identity.repoId, 'fixture/model'); assert.equal(plan.peers[0], '192.168.50.20:6881');
  assert.equal(clientCalls, 0); assert.equal(socketCalls, 0);
  for (const name of ['missing', 'denied', 'threw', 'ipv6-denied']) assert.equal(fs.existsSync(`${destination(name)}.frosthybrid`), false);
});

test('shared files and saved manifests reject symbolic links, hard links, oversize data, and extra fields', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hybrid-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = crypto.randomBytes(64 * 1024), source = path.join(root, 'model.gguf');
  fs.writeFileSync(source, payload);
  const identity = { repoId: 'fixture/model', revision: 'a'.repeat(40), filePath: 'model.gguf',
    size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const metadata = await createHybridManifest(source, identity);
  const parsed = await validateHybridManifest(metadata, identity);
  const client = { get: async () => null, add: () => { throw new Error('unsafe manifest reached the torrent client'); } };
  const signal = new AbortController().signal;
  const linkedSource = path.join(root, 'linked-source.gguf');
  fs.linkSync(source, linkedSource);
  await assert.rejects(createHybridManifest(linkedSource, identity), /single-link file/);
  fs.unlinkSync(linkedSource);
  const symbolicSource = path.join(root, 'symbolic-source.gguf');
  try { fs.symlinkSync(source, symbolicSource, 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }
  if (fs.existsSync(symbolicSource)) await assert.rejects(createHybridManifest(symbolicSource, identity), /single-link file/);

  const prepare = name => {
    const dest = path.join(root, `${name}.gguf`), directory = `${dest}.frosthybrid`;
    fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
    return { dest, directory, manifest: path.join(directory, 'manifest.json') };
  };
  const victim = path.join(root, 'manifest-victim');
  fs.writeFileSync(victim, 'do not touch');
  const symbolic = prepare('symbolic');
  try { fs.symlinkSync(victim, symbolic.manifest, 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }
  if (fs.existsSync(symbolic.manifest)) {
    await assert.rejects(downloadHybrid({ identity, plan: null, dest: symbolic.dest, approvedRoot: root, client, signal }), /single-link file/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'do not touch');
  }
  const hard = prepare('hard');
  fs.linkSync(victim, hard.manifest);
  await assert.rejects(downloadHybrid({ identity, plan: null, dest: hard.dest, approvedRoot: root, client, signal }), /single-link file/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not touch');
  fs.unlinkSync(hard.manifest);
  const oversized = prepare('oversized');
  fs.writeFileSync(oversized.manifest, Buffer.alloc(6 * 1024 * 1024));
  await assert.rejects(downloadHybrid({ identity, plan: null, dest: oversized.dest, approvedRoot: root, client, signal }), /too large/);
  const extra = prepare('extra');
  fs.writeFileSync(extra.manifest, JSON.stringify({ schemaVersion: 1, key: identityKey(identity), infoHash: parsed.infoHash,
    metadata: metadata.toString('base64'), hfBytes: 0, peerBytes: 0, unexpected: true }));
  await assert.rejects(downloadHybrid({ identity, plan: null, dest: extra.dest, approvedRoot: root, client, signal }), /unsupported fields/);
});

test('destination and partial directories cannot escape the approved root', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hybrid-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hybrid-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const payload = crypto.randomBytes(64 * 1024), source = path.join(root, 'model.gguf');
  fs.writeFileSync(source, payload);
  const identity = { repoId: 'fixture/model', revision: 'a'.repeat(40), filePath: 'model.gguf',
    size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const metadata = await createHybridManifest(source, identity);
  const plan = { identity, metadata: metadata.toString('base64'), peers: [] };
  const client = { get: async () => null, add: () => { throw new Error('unsafe path reached the torrent client'); } };
  const signal = new AbortController().signal;
  await assert.rejects(downloadHybrid({ identity, plan, dest: path.join(outside, 'escaped.gguf'), approvedRoot: root, client, signal }), /inside the approved download folder/);
  const existing = path.join(root, 'existing.gguf'), bytes = crypto.randomBytes(32);
  fs.writeFileSync(existing, bytes);
  await assert.rejects(downloadHybrid({ identity, plan, dest: existing, approvedRoot: root, client, signal }), /already exists/);
  assert.deepEqual(fs.readFileSync(existing), bytes);
  assert.equal(fs.existsSync(`${existing}.frosthybrid`), false);
  const partialLinkDest = path.join(root, 'partial-link.gguf');
  try { fs.symlinkSync(outside, `${partialLinkDest}.frosthybrid`, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(downloadHybrid({ identity, plan, dest: partialLinkDest, approvedRoot: root, client, signal }), /partial folder.*linked or unavailable/i);
  fs.unlinkSync(`${partialLinkDest}.frosthybrid`);
  const dataLinkDest = path.join(root, 'data-link.gguf');
  fs.mkdirSync(`${dataLinkDest}.frosthybrid`);
  fs.symlinkSync(outside, path.join(`${dataLinkDest}.frosthybrid`, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(downloadHybrid({ identity, plan, dest: dataLinkDest, approvedRoot: root, client, signal }), /partial data folder.*linked or unavailable/i);
  fs.unlinkSync(path.join(`${dataLinkDest}.frosthybrid`, 'data'));
  fs.rmdirSync(`${dataLinkDest}.frosthybrid`);
  const linked = path.join(root, 'linked');
  try { fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(downloadHybrid({ identity, plan, dest: path.join(linked, 'escaped.gguf'), approvedRoot: root, client, signal }), /linked or unavailable/);
  assert.equal(fs.existsSync(path.join(outside, 'escaped.gguf')), false);
});

test('a destination created during verification is never replaced', { timeout: 60000 }, async t => {
  const f = await fixture(t), dest = path.join(f.root, 'raced.gguf'), attacker = crypto.randomBytes(48);
  let inserted = false;
  await assert.rejects(downloadHybrid({ ...f, dest, client: f.receiver.client, signal: new AbortController().signal,
    onProgress: value => {
      if (value.phase === 'verifying' && !inserted) { inserted = true; fs.writeFileSync(dest, attacker); }
    } }), /already exists/);
  assert.equal(inserted, true);
  assert.deepEqual(fs.readFileSync(dest), attacker);
  assert.equal(fs.existsSync(path.join(`${dest}.frosthybrid`, 'data', path.basename(f.identity.filePath))), true,
    'verified pieces stay available for recovery after a publication race');
});
