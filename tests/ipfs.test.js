import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KuboRuntime } from '../src/main/ipfs-runtime.js';
import { IpfsTransfers } from '../src/main/ipfs.js';
import { parseIpfsSource } from '../src/shared/ipfs-source.js';
import { normalizeLaunchSource, LaunchSourceQueue } from '../src/main/source-arguments.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { originSigningBytes } from '../src/shared/aeon-origin.js';

const binaryDirectory = path.resolve(`build/ipfs-runtime/${process.platform}-${process.arch}`);
const available = fsSync.existsSync(path.join(binaryDirectory, 'runtime.json'));
const cid = 'QmbsqVAgHZ7dJ4XZi9sZPSHmGkeMJfZ66JstsZaA1x4sM4';
test('IPFS accepts immutable content and normalizes encoded file names', () => {
  assert.equal(parseIpfsSource(`/ipfs/${cid}/weights/a%20b.bin`).path, 'weights/a b.bin');
  assert.equal(parseIpfsSource(cid).source, parseIpfsSource(parseIpfsSource(cid).cid).source);
  for (const value of ['https://example.com/a', 'ipns://example.com', `ipfs://${cid}/..`, `ipfs://${cid}/a%2Fb`, `ipfs://${cid}?token=private`, 'not-a-cid']) assert.throws(() => parseIpfsSource(value));
});

test('IPFS OS launch requests retain their review lease without a file grant', () => {
  const queue = new LaunchSourceQueue({ grantTorrent: () => { throw new Error('IPFS must not grant a local path.'); } });
  const source = normalizeLaunchSource('ipfs://' + cid);
  assert.equal(source.kind, 'ipfs'); assert.equal(queue.enqueue(source), true);
  const [delivery] = queue.deliverNext();
  assert.deepEqual(queue.deliverNext(), [delivery]);
  queue.acknowledge(delivery.id); assert.equal(queue.size, 0);
  assert.equal(normalizeLaunchSource('ipfs://invalid-cid/model.torrent'), null);
});

test('real isolated Kubo: selected files, inventory state, explicit publishing, restart and stop', { skip: !available, timeout: 120_000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-ipfs-test-'));
  const source = new KuboRuntime({ directory: path.join(home, 'source-node'), binaryDirectory, publishing: true, isolated: true });
  const manager = new IpfsTransfers({ directory: path.join(home, 'managed'), binaryDirectory, isolated: true });
  const viewer = new KuboRuntime({ directory: path.join(home, 'viewer'), binaryDirectory, isolated: true });
  try {
    const fixture = path.join(home, 'fixture'), destination = path.join(home, 'downloads');
    await fs.mkdir(path.join(fixture, 'weights'), { recursive: true }); await fs.mkdir(destination);
    const contents = Buffer.alloc(1024 * 1024 + 7, 42);
    await fs.writeFile(path.join(fixture, 'config.json'), '{"fixture":true}\n');
    await fs.writeFile(path.join(fixture, 'weights/model.safetensors'), contents);
    await fs.writeFile(path.join(fixture, 'omitted.txt'), 'This fixture is not selected.');
    await source.ensure(); await source.stop();
    const imported = await source.command(['add', '--offline', '-Qr', fixture]);
    const root = imported.stdout.trim();
    await source.ensure(); await manager.load(); await manager.reader.ensure();
    const sourceId = await source.json('id');
    await manager.reader.json('swarm/connect', { arg: sourceId.Addresses.find(a => a.startsWith('/ip4/127.0.0.1/')) });
    const denied = await fetch(manager.reader.url + '/api/v0/id', { method: 'POST' });
    assert.equal(denied.status, 403);
    const config = JSON.parse(await fs.readFile(path.join(manager.reader.directory, 'config')));
    assert.equal(config.Bitswap.ServerEnabled, false); assert.equal(config.Provide.Enabled, false);
    const preview = await manager.inspect('ipfs://' + root);
    assert.deepEqual(preview.files.map(f => f.path).sort(), ['config.json', 'omitted.txt', 'weights/model.safetensors']);
    const id = await manager.add({ previewId: preview.id, selectedPaths: ['config.json', 'weights/model.safetensors'], destination, name: 'Fixture model', kind: 'model' });
    await manager.running.get(id);
    const job = manager.record(id); assert.equal(job.status, 'done', job.error);
    assert.equal(job.sharing, false);
    await assert.rejects(fs.access(path.join(destination, job.folder, 'omitted.txt')), { code: 'ENOENT' });
    const duplicate = await manager.inspect(parseIpfsSource(root).source);
    await assert.rejects(manager.add({ previewId: duplicate.id, destination, name: 'Duplicate' }), /already has a transfer/);
    assert.deepEqual(await fs.readFile(path.join(destination, job.folder, 'weights/model.safetensors')), contents);
    assert.equal(manager.snapshot().downloads[0].downloaded, contents.length + 17);
    await manager.sharing(id, true);
    assert.equal(manager.snapshot().downloads[0].sharing, true);
    await viewer.ensure();
    const publisherId = await manager.publisher.json('id');
    const sharedListing = await manager.publisher.json('ls', { arg: job.shareCid });
    assert.deepEqual(sharedListing.Objects[0].Links.map(link => link.Name).sort(), ['config.json', 'weights']);
    await viewer.json('swarm/connect', { arg: publisherId.Addresses.find(a => a.startsWith('/ip4/127.0.0.1/')) });
    const shared = await viewer.json('files/stat', { arg: `/ipfs/${job.shareCid}/weights/model.safetensors` });
    assert.equal(shared.Size, contents.length);
    const downloaded = await viewer.request('cat', { arg: `/ipfs/${job.shareCid}/weights/model.safetensors` });
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), contents);
    await manager.sharing(id, false);
    assert.equal(manager.publisher.child, null);
    assert.equal(manager.snapshot().downloads[0].sharing, false);
    await manager.control('clear', id); assert.equal(job.cleared, true);
    await manager.control('remove', id); assert.equal(job.removed, true);
    const persist = manager.persist.bind(manager); manager.persist = () => { throw new Error('disk full'); };
    await assert.rejects(manager.control('restore', id), /disk full/); assert.equal(job.removed, true); manager.persist = persist;
    const readd = await manager.inspect(root);
    assert.equal(await manager.add({ previewId: readd.id, selectedPaths: ['config.json', 'weights/model.safetensors'], destination }), id);
    assert.equal(job.removed, false); assert.equal(job.cleared, false); assert.equal(job.sharing, false);
    await manager.control('clear', id);
    await manager.close();
    const restored = new IpfsTransfers({ directory: path.join(home, 'managed'), binaryDirectory, isolated: true });
    try { await restored.load(); assert.equal(restored.record(id).status, 'done'); assert.equal(restored.record(id).sharing, false); assert.equal(restored.reader.child, null); }
    finally { await restored.close(); }
  } finally { await Promise.allSettled([manager.close(), source.stop(), viewer.stop()]); await fs.rm(home, { recursive: true, force: true }); }
});

test('real IPFS pause, restart, publication recovery and missing-file reporting preserve the selected bytes', { skip: !available, timeout: 120_000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-ipfs-recovery-'));
  const source = new KuboRuntime({ directory: path.join(home, 'source'), binaryDirectory, publishing: true, isolated: true });
  let manager = new IpfsTransfers({ directory: path.join(home, 'managed'), binaryDirectory, isolated: true });
  const unlink = fs.unlink;
  try {
    const destination = path.join(home, 'downloads'); await fs.mkdir(destination);
    const fixture = path.join(home, 'model.safetensors'), bytes = Buffer.alloc(2 * 1024 * 1024 + 19, 13);
    await fs.writeFile(fixture, bytes);
    await source.ensure(); await source.stop();
    const root = (await source.command(['add', '--offline', '-Q', fixture])).stdout.trim(); await source.ensure();
    const address = (await source.json('id')).Addresses.find(a => a.startsWith('/ip4/127.0.0.1/'));
    await manager.load(); await manager.reader.ensure(); await manager.reader.json('swarm/connect', { arg: address });
    const preview = await manager.inspect(root);
    const request = manager.reader.request.bind(manager.reader);
    manager.reader.request = async (command, params, options) => {
      const response = await request(command, params, options);
      if (command !== 'cat') return response;
      const reader = response.body.getReader();
      return { body: { getReader: () => ({ read: async () => { await delay(40); return reader.read(); }, cancel: () => reader.cancel() }) } };
    };
    const id = await manager.add({ previewId: preview.id, destination, name: 'Recoverable model', kind: 'model' });
    const deadline = Date.now() + 10_000;
    while (!manager.record(id).files[0].downloaded && Date.now() < deadline) await delay(10);
    // A separate action may save global state while bytes are still arriving.
    // Reuse that exact journal to simulate an abrupt exit before the final
    // checkpoint, then verify recovery against the real retained partial file.
    manager.persist();
    const interruptedJournal = await fs.readFile(manager.stateFile);
    await manager.control('pause', id);
    const paused = manager.record(id).files[0];
    assert.ok(paused.downloaded > 0 && paused.downloaded < bytes.length);
    assert.match(paused.partialHash, /^[a-f0-9]{64}$/); assert.equal(manager.record(id).status, 'paused');
    await assert.rejects(manager.control('clear', id), /Unsupported/);
    await manager.close();
    const legacy = JSON.parse(interruptedJournal); legacy[0].cleared = true;
    await fs.writeFile(manager.stateFile, JSON.stringify(legacy));
    manager = new IpfsTransfers({ directory: path.join(home, 'managed'), binaryDirectory, isolated: true });
    await manager.load(); assert.equal(manager.record(id).cleared, false, 'legacy unfinished cleared transfers become recoverable'); await manager.reader.ensure(); await manager.reader.json('swarm/connect', { arg: address });
    let interrupted = false;
    const canonicalHome = await fs.realpath(home);
    fs.unlink = async target => {
      if (!interrupted && String(target).startsWith(canonicalHome + path.sep) && String(target).endsWith('.frostipfs')) { interrupted = true; throw new Error('Fixture interruption immediately after publication.'); }
      return unlink(target);
    };
    await manager.control('resume', id); await manager.running.get(id); fs.unlink = unlink;
    assert.equal(interrupted, true); assert.equal(manager.record(id).status, 'error');
    const target = path.join(manager.record(id).destination, manager.record(id).folder, manager.record(id).files[0].path);
    assert.equal((await fs.lstat(target)).nlink, 2);
    await manager.close();
    manager = new IpfsTransfers({ directory: path.join(home, 'managed'), binaryDirectory, isolated: true });
    await manager.load(); await manager.control('resume', id); await manager.running.get(id);
    assert.equal(manager.record(id).status, 'done', manager.record(id).error);
    assert.equal((await fs.lstat(target)).nlink, 1); assert.deepEqual(await fs.readFile(target), bytes);
    await manager.sampleInventory(); assert.equal(manager.record(id).available, true);
    await fs.unlink(target); await manager.sampleInventory();
    assert.equal(manager.record(id).available, false); assert.equal(manager.record(id).missingFiles, 1);
  } finally { fs.unlink = unlink; await Promise.allSettled([manager.close(), source.stop()]); await fs.rm(home, { recursive: true, force: true }); }
});

test('real Kubo: an Orb-signed model verifies, is re-shared under the Orb\'s CID, and a partial copy is refused', { skip: !available, timeout: 120_000 }, async () => {
  const vectors = JSON.parse(fsSync.readFileSync(new URL('./fixtures/model-share-vectors.json', import.meta.url)));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-ipfs-origin-'));
  const orb = new KuboRuntime({ directory: path.join(home, 'orb'), binaryDirectory, publishing: true, isolated: true });
  let manager = new IpfsTransfers({ directory: path.join(home, 'managed'), binaryDirectory, isolated: true });
  try {
    const fixture = path.join(home, 'model'), destination = path.join(home, 'downloads'), partial = path.join(home, 'partial');
    await fs.mkdir(path.join(fixture, 'tokenizer'), { recursive: true }); await fs.mkdir(destination); await fs.mkdir(partial);
    const files = [];
    for (const [name, value] of Object.entries({ 'README.md': 'An example.\n', 'example.gguf': Buffer.alloc(2 * 1024 * 1024 + 5, 9), 'tokenizer/tokenizer.json': '{}' })) {
      const bytes = Buffer.from(value); await fs.writeFile(path.join(fixture, name), bytes);
      files.push({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.keys.orb_secret, 'hex')]), format: 'der', type: 'pkcs8' });
    const signedMs = 1760000000002;
    const card = Buffer.from(JSON.stringify({ schema: 'aeon-model-card/2', name: 'Example', source: '', verified: false, files,
      origin: { key: vectors.keys.orb_key, name: 'orb-one', signed_ms: signedMs, sig: sign(null, originSigningBytes({ name: 'Example', signedMs, files }), key).toString('base64') } }));
    await fs.writeFile(path.join(fixture, 'model-card.json'), card);
    const everything = [...files, { path: 'model-card.json', size: card.length, sha256: createHash('sha256').update(card).digest('hex') }];
    await orb.ensure(); await orb.stop();
    // The Orb's `add-fixed` command line: the protocol's fixed import parameters.
    const root = (await orb.command(['add', '--offline', '-rQ', '--cid-version=1', '--raw-leaves=true', '--chunker=size-1048576', '--hash=sha2-256', '--', fixture])).stdout.trim();
    await orb.ensure(); await manager.load(); await manager.reader.ensure();
    await manager.reader.json('swarm/connect', { arg: (await orb.json('id')).Addresses.find(a => a.startsWith('/ip4/127.0.0.1/')) });

    const id = await manager.add({ previewId: (await manager.inspect('ipfs://' + root)).id, destination, name: 'Example', kind: 'model' });
    await manager.running.get(id);
    const job = manager.record(id); assert.equal(job.status, 'done', job.error);
    assert.equal(job.origin.status, 'verified'); assert.equal(job.origin.identity, vectors.keys.orb_key); assert.equal(job.origin.name, 'orb-one');
    assert.equal(manager.snapshot().downloads[0].origin.status, 'verified');
    assert.equal(manager.sharedCid(everything), '', 'nothing is shared until sharing is turned on');
    await manager.sharing(id, true);
    assert.equal(job.shareCid, root, 'the same files are published under the CID the Orb produced');
    assert.equal(manager.sharedCid(everything), root); assert.equal(manager.sharedCid(files), '', 'a different file set is not this share');
    await manager.sharing(id, false);
    assert.equal(manager.sharedCid(everything), '');

    // Keeping the publisher's card with only some of its files is not the signed model.
    const partialId = await manager.add({ previewId: (await manager.inspect('ipfs://' + root)).id, selectedPaths: ['example.gguf', 'model-card.json'], destination: partial, name: 'Partial', kind: 'model' });
    await manager.running.get(partialId);
    const incomplete = manager.record(partialId); assert.equal(incomplete.status, 'done', incomplete.error);
    assert.equal(incomplete.origin.status, 'failed'); assert.equal(incomplete.origin.reason, 'missing'); assert.equal(incomplete.origin.path, 'README.md');
    await assert.rejects(manager.sharing(partialId, true), /failed its AEON origin check/);
    assert.equal(incomplete.sharing, false); assert.equal(incomplete.shareCid, ''); assert.equal(manager.publisher.child, null);

    await manager.close();
    manager = new IpfsTransfers({ directory: path.join(home, 'managed'), binaryDirectory, isolated: true });
    await manager.load();
    assert.equal(manager.record(id).origin.status, 'verified'); assert.equal(manager.record(partialId).origin.reason, 'missing');
    assert.equal(manager.record(id).sharing, false, 'a verified origin never turns sharing on');
  } finally { await Promise.allSettled([manager.close(), orb.stop()]); await fs.rm(home, { recursive: true, force: true }); }
});
