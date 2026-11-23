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
import { inventoryProofText } from '../src/shared/inventory-proof.js';

const revisionA = 'a'.repeat(40), revisionB = 'b'.repeat(40), repoId = 'fixture/inventory';
const bytesFor = (revision, file) => Buffer.from(JSON.stringify({ revision, file }) + '\n');
const hfRequest = (destination, revision = revisionA, files = ['config.json']) => ({
  action: 'hf:add', repoId, revision, destination,
  files: files.map(file => ({ path: file, size: bytesFor(revision, file).length })),
});

async function fixture(t, { prepare, nestedRoot = false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inventory-')));
  const internal = path.join(home, 'internal'), external = path.join(home, 'external'), state = path.join(home, 'state');
  const roots = [internal, external];
  if (nestedRoot) roots.push(path.join(internal, 'fixture'));
  const identities = roots.map(root => ({ path: root, marker: crypto.randomBytes(16).toString('hex') }));
  fs.mkdirSync(state);
  for (const identity of identities) {
    fs.mkdirSync(identity.path, { recursive: true });
    fs.writeFileSync(path.join(identity.path, '.frostbyte-storage-id'), identity.marker);
  }
  const writeHF = (root, revision = revisionA, file = 'config.json') => {
    const dest = path.join(root, repoId, file), bytes = bytesFor(revision, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes);
    return { dest, bytes };
  };
  if (prepare) fs.writeFileSync(path.join(state, 'agent.json'), JSON.stringify(prepare({ home, internal, external, state, roots, writeHF })));
  let gets = 0;
  const httpServer = http.createServer((req, res) => {
    const match = new URL(req.url, 'http://fixture').pathname.match(/^\/fixture\/inventory\/resolve\/([ab]{40})\/(.+)$/);
    if (!match) { res.writeHead(404); res.end(); return; }
    const bytes = bytesFor(match[1], match[2]);
    res.writeHead(200, { 'content-length': bytes.length, etag: crypto.createHash('sha256').update(bytes).digest('hex') });
    if (req.method === 'HEAD') res.end(); else { gets++; res.end(bytes); }
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const preload = path.join(home, 'fixture-fetch.mjs');
  fs.writeFileSync(preload, `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(input);
      if (url.origin !== 'https://huggingface.co') return nativeFetch(input, options);
      return nativeFetch(process.env.FROSTBYTE_TEST_HF_ORIGIN + url.pathname + url.search, options);
    };
  `);
  let child, log = '';
  const waitFor = async check => {
    for (let i = 0; i < 400; i++) {
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(log || 'Agent exited.');
      if (await check()) return;
      await delay(25);
    }
    throw new Error('Inventory fixture timed out. ' + log);
  };
  const start = async () => {
    log = '';
    child = spawn(process.execPath, ['--trace-uncaught', '--import', preload, 'src/agent/server.js'], {
      env: { ...process.env, FROSTBYTE_AGENT_HOME: state, FROSTBYTE_DOWNLOAD_DIR: internal, FROSTBYTE_AGENT_TEST: '1',
        FROSTBYTE_STORAGE_ROOTS: JSON.stringify(roots), FROSTBYTE_STORAGE_IDENTITIES: JSON.stringify(identities),
        FROSTBYTE_TEST_HF_ORIGIN: `http://127.0.0.1:${httpServer.address().port}` }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', chunk => { log += chunk; });
    await waitFor(() => fs.existsSync(path.join(state, 'control.sock')));
  };
  const stop = async () => {
    if (child?.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; }
  };
  const rpc = request => new Promise((resolve, reject) => {
    const socket = net.connect(path.join(state, 'control.sock')); let output = '';
    socket.setTimeout(10000, () => socket.destroy(new Error('Inventory RPC timed out. ' + log)));
    socket.on('error', reject); socket.on('data', chunk => { output += chunk; });
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('end', () => {
      try { const response = JSON.parse(output); response.ok ? resolve(response.data) : reject(new Error(response.error)); }
      catch (error) { reject(error); }
    });
  });
  const status = () => rpc({ action: 'status' });
  const pull = async (root, revision = revisionA, files = ['config.json']) => {
    const ids = await rpc(hfRequest(root, revision, files));
    await waitFor(async () => {
      const current = await status();
      return ids.every(id => current.downloads.find(record => record.id === id)?.status === 'done');
    });
    return ids;
  };
  t.after(async () => { await stop(); httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  await start();
  return { home, internal, external, state, roots, status, rpc, pull, waitFor, start, stop, getCount: () => gets };
}

test('device manifest deletion targets one root and preserves unrecorded bytes across restart', { timeout: 25000 }, async t => {
  const agent = await fixture(t); await agent.pull(agent.internal); await agent.pull(agent.external);
  const entry = (await agent.status()).inventory.find(row => row.destination === agent.external);
  const unowned = path.join(entry.path, 'keep.txt'); fs.writeFileSync(unowned, 'keep me');
  const proof = crypto.createHash('sha256').update(inventoryProofText(entry)).digest('hex');
  await assert.rejects(agent.rpc({ action: 'inventory:remove', id: entry.id, proof: 'wrong' }), /changed/);
  assert.equal(await agent.rpc({ action: 'inventory:remove', id: entry.id, proof }), true);
  assert.equal(fs.existsSync(path.join(agent.external, repoId, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(agent.internal, repoId, 'config.json')), true);
  assert.equal(fs.readFileSync(unowned, 'utf8'), 'keep me');
  assert.equal((await agent.status()).inventory.length, 1);
  await agent.stop(); await agent.start(); assert.equal((await agent.status()).inventory.length, 1);
});
test('device transfer removal retains paused ownership across restart without resuming network work', { timeout: 25000 }, async t => {
  const agent = await fixture(t, { prepare: ({ internal, writeHF }) => {
    const { dest } = writeHF(internal); fs.unlinkSync(dest); fs.writeFileSync(dest + '.frostpart', 'partial');
    return { downloads: [{ id: 'retained-test', repoId, revision: revisionA, filePath: 'config.json', dest, destination: internal, downloaded: 7, total: 100, status: 'error' }] };
  } });
  await agent.rpc({ action: 'hf:clear' }); assert.equal((await agent.status()).downloads.length, 1);
  await agent.rpc({ action: 'hf:remove', id: 'retained-test' });
  await agent.stop(); await agent.start();
  let row = (await agent.status()).downloads[0]; assert.equal(row.removed, true); assert.equal(row.status, 'paused');
  await assert.rejects(agent.rpc({ action: 'hf:resume', id: row.id }), /Restore/);
  await agent.rpc({ action: 'hf:restore', id: row.id }); row = (await agent.status()).downloads[0];
  assert.equal(row.removed, false); assert.equal(row.status, 'paused'); assert.equal(agent.getCount(), 0);
  assert.equal(fs.readFileSync(row.dest + '.frostpart', 'utf8'), 'partial');
});

test('migrates completed HF transfers into a durable selected-file inventory before clear and restart', { timeout: 25000 }, async t => {
  const agent = await fixture(t, { nestedRoot: true, prepare: ({ internal, writeHF }) => {
    const downloads = ['config.json', 'weights/model.gguf'].map((filePath, index) => {
      const { dest, bytes } = writeHF(internal, revisionA, filePath);
      return { id: 'legacy-' + index, repoId, revision: revisionA, filePath, dest, downloaded: bytes.length, total: bytes.length, status: 'done' };
    });
    return { torrents: [], downloads };
  } });
  const [entry] = (await agent.status()).inventory;
  assert.equal(entry.source, 'hf'); assert.equal(entry.repoId, repoId);
  assert.equal(entry.destination, agent.internal, 'a nested registered root does not rebase a legacy HF job');
  assert.equal(entry.path, path.join(agent.internal, repoId));
  assert.equal(entry.relative, repoId); assert.equal(entry.browseRelative, repoId); assert.equal(entry.directory, true);
  assert.equal(entry.fileCount, 2); assert.equal(entry.available, true); assert.equal(entry.missingFiles, 0);
  assert.deepEqual(entry.files.map(file => file.path).sort(), ['config.json', 'weights/model.gguf']);
  assert.equal(entry.size, entry.files.reduce((sum, file) => sum + file.size, 0));
  assert.ok(entry.updatedAt > 0); assert.equal(agent.getCount(), 0);
  await agent.rpc({ action: 'hf:clear' });
  await agent.stop(); await agent.start();
  const restored = await agent.status();
  assert.deepEqual(restored.downloads, []); assert.deepEqual(restored.inventory, [entry]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json'))).inventory.length, 1);
});

test('HF completion preserves separate roots and survives explicit transfer removal', { timeout: 25000 }, async t => {
  const agent = await fixture(t);
  const [internalId] = await agent.pull(agent.internal);
  const [externalId] = await agent.pull(agent.external);
  const entries = (await agent.status()).inventory;
  assert.equal(entries.length, 2); assert.notEqual(entries[0].id, entries[1].id);
  assert.deepEqual(entries.map(entry => entry.destination).sort(), [agent.internal, agent.external].sort());
  assert.ok(entries.every(entry => entry.available && entry.fileCount === 1 && entry.files[0].revision === revisionA));
  await agent.rpc({ action: 'hf:remove', id: internalId });
  await agent.rpc({ action: 'hf:remove', id: externalId });
  await agent.stop(); await agent.start();
  assert.deepEqual((await agent.status()).downloads, []);
  assert.deepEqual((await agent.status()).inventory, entries);
});

test('missing completed files can be restored while changed files require an explicit safe replacement', { timeout: 25000 }, async t => {
  const agent = await fixture(t);
  const [id] = await agent.pull(agent.internal);
  const dest = path.join(agent.internal, repoId, 'config.json');
  fs.unlinkSync(dest);
  let entry = (await agent.status()).inventory[0];
  assert.equal(entry.available, false); assert.equal(entry.missingFiles, 1);
  await agent.stop(); await agent.start();
  const before = agent.getCount();
  assert.deepEqual(await agent.pull(agent.internal), [id]);
  assert.equal(agent.getCount(), before + 1);
  entry = (await agent.status()).inventory[0]; assert.equal(entry.available, true); assert.equal(entry.missingFiles, 0);
  fs.writeFileSync(dest, 'changed');
  assert.equal((await agent.status()).inventory[0].available, false);
  const beforeRefusal = agent.getCount();
  await assert.rejects(agent.pull(agent.internal), /already exists.*HuggingFace destination/i);
  assert.equal(agent.getCount(), beforeRefusal, 'the refusal happens before another network download');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'changed', 'unrelated or edited bytes are never overwritten');
});

test('revision replacement requires an empty destination and old history cannot revert provenance', { timeout: 25000 }, async t => {
  const agent = await fixture(t);
  await agent.pull(agent.internal, revisionA, ['config.json', 'weights.gguf']);
  const original = (await agent.status()).inventory[0];
  const config = path.join(agent.internal, repoId, 'config.json');
  const beforeRefusal = agent.getCount();
  await assert.rejects(agent.pull(agent.internal, revisionB), /already exists.*HuggingFace destination/i);
  assert.equal(agent.getCount(), beforeRefusal);
  assert.deepEqual(fs.readFileSync(config), bytesFor(revisionA, 'config.json'));
  assert.equal((await agent.status()).inventory[0].files.find(file => file.path === 'config.json').revision, revisionA);

  fs.unlinkSync(config); // the user explicitly clears the old destination
  const [newId] = await agent.pull(agent.internal, revisionB);
  let entry = (await agent.status()).inventory[0];
  assert.equal(entry.id, original.id); assert.equal(entry.fileCount, 2);
  assert.equal(entry.files.find(file => file.path === 'config.json').revision, revisionB);
  assert.equal(entry.files.find(file => file.path === 'weights.gguf').revision, revisionA);
  await agent.rpc({ action: 'hf:remove', id: newId });
  await agent.stop(); await agent.start();
  assert.equal((await agent.status()).inventory[0].files.find(file => file.path === 'config.json').revision, revisionB);
  await assert.rejects(agent.pull(agent.internal, revisionA), /already exists.*HuggingFace destination/i);
  entry = (await agent.status()).inventory[0];
  assert.equal(entry.files.find(file => file.path === 'config.json').revision, revisionB);
  assert.deepEqual(fs.readFileSync(config), bytesFor(revisionB, 'config.json'));
});

test('inventory survives disconnected storage and recovers after remount without recreating files', { timeout: 25000 }, async t => {
  const agent = await fixture(t);
  await agent.pull(agent.external);
  const original = (await agent.status()).inventory[0];
  const detached = agent.external + '-detached';
  fs.renameSync(agent.external, detached); fs.mkdirSync(agent.external);
  await agent.rpc({ action: 'hf:clear' });
  await agent.stop(); await agent.start();
  const unavailable = (await agent.status()).inventory[0];
  assert.equal(unavailable.id, original.id); assert.equal(unavailable.available, false);
  assert.equal(unavailable.missingFiles, 0, 'an unmounted drive is unavailable, not proof that its files are missing');
  assert.match(unavailable.error, /storage unavailable/i); assert.deepEqual(fs.readdirSync(agent.external), []);
  fs.rmdirSync(agent.external); fs.renameSync(detached, agent.external);
  assert.deepEqual((await agent.status()).inventory, [original]);
  assert.equal(agent.getCount(), 1);
});

test('first upgrade migrates completed HF provenance even when its external drive is already offline', { timeout: 25000 }, async t => {
  const agent = await fixture(t, { prepare: ({ external, writeHF }) => {
    const { dest, bytes } = writeHF(external);
    fs.renameSync(external, external + '-detached'); fs.mkdirSync(external);
    return { torrents: [], downloads: [{ id: 'legacy-offline', repoId, revision: revisionA,
      filePath: 'config.json', destination: external, dest, status: 'done', total: bytes.length, downloaded: bytes.length }] };
  } });
  const unavailable = (await agent.status()).inventory[0];
  assert.equal(unavailable.available, false); assert.equal(unavailable.fileCount, 1);
  assert.equal(unavailable.files[0].revision, revisionA); assert.equal(agent.getCount(), 0);
  await agent.rpc({ action: 'hf:clear' });
  await agent.stop(); await agent.start();
  assert.deepEqual(fs.readdirSync(agent.external), []);
  fs.rmdirSync(agent.external); fs.renameSync(agent.external + '-detached', agent.external);
  const recovered = (await agent.status()).inventory[0];
  assert.equal(recovered.id, unavailable.id); assert.equal(recovered.available, true);
  const retained = (await agent.status()).downloads;
  assert.equal(retained.length, 1); assert.equal(retained[0].id, 'legacy-offline');
  assert.equal(retained[0].status, 'error', 'Clear completed must not erase a storage-error recovery record'); assert.equal(agent.getCount(), 0);
});

test('inventory never treats a symlink outside registered storage as an available downloaded file', { timeout: 25000 }, async t => {
  const agent = await fixture(t);
  await agent.pull(agent.internal);
  const dest = path.join(agent.internal, repoId, 'config.json');
  const outside = path.join(agent.home, 'outside.json'); fs.writeFileSync(outside, bytesFor(revisionA, 'config.json'));
  fs.unlinkSync(dest); fs.symlinkSync(outside, dest);
  const entry = (await agent.status()).inventory[0];
  assert.equal(entry.available, false); assert.equal(entry.missingFiles, 1);
  await assert.rejects(agent.rpc(hfRequest(agent.internal)), /symbolic|linked/i);
  assert.deepEqual(fs.readFileSync(outside), bytesFor(revisionA, 'config.json'));
});

test('completed selected torrent files remain inventoried after transfer removal and restart', { timeout: 30000 }, async t => {
  const agent = await fixture(t);
  const source = path.join(agent.home, 'update'); fs.mkdirSync(source);
  const config = Buffer.from('{"update":true}\n'); fs.writeFileSync(path.join(source, 'config.json'), config);
  fs.writeFileSync(path.join(source, 'unselected.gguf'), Buffer.alloc(2 * 1024 * 1024, 7));
  const seed = new TorrentEngine({ dht: false, tracker: false, lsd: false }); t.after(() => seed.destroy());
  const shared = await seed.seed(source);
  await agent.rpc({ action: 'torrent:add', destination: agent.external, source: shared.magnetURI + `&x.pe=127.0.0.1:${seed.port}`, selectedPaths: ['update/config.json'] });
  await agent.waitFor(async () => (await agent.status()).inventory.some(entry => entry.source === 'torrent'));
  let entry = (await agent.status()).inventory[0];
  assert.equal(entry.source, 'torrent'); assert.equal(entry.fileCount, 1); assert.equal(entry.size, config.length);
  assert.equal(entry.available, true); assert.equal(entry.directory, true); assert.equal(entry.relative, 'update');
  assert.equal(entry.browseRelative, 'update'); assert.deepEqual(entry.files, [{ path: 'config.json', size: config.length }]);
  await agent.stop();
  const legacy = JSON.parse(fs.readFileSync(path.join(agent.state, 'agent.json')));
  delete legacy.inventory; // The pre-inventory companion persisted only torrent sessions.
  fs.writeFileSync(path.join(agent.state, 'agent.json'), JSON.stringify(legacy));
  await agent.start();
  await agent.waitFor(async () => (await agent.status()).inventory.length === 1);
  const migrated = (await agent.status()).inventory[0];
  assert.equal(migrated.id, entry.id); assert.deepEqual(migrated.files, entry.files);
  assert.equal(migrated.available, true); entry = migrated;
  await agent.rpc({ action: 'torrent:remove', id: shared.infoHash });
  await agent.stop(); await agent.start();
  assert.deepEqual((await agent.status()).torrents, []);
  assert.deepEqual((await agent.status()).inventory, [entry]);
  assert.deepEqual(fs.readFileSync(path.join(agent.external, 'update/config.json')), config);
});

test('review-bound torrent removal deletes its files and inventory only for the current live session', { timeout: 30000 }, async t => {
  const agent = await fixture(t);
  const source = path.join(agent.home, 'delete-me'); fs.mkdirSync(source);
  const config = Buffer.from('{"delete":true}\n'); fs.writeFileSync(path.join(source, 'config.json'), config);
  const seed = new TorrentEngine({ dht: false, tracker: false, lsd: false }); t.after(() => seed.destroy());
  const shared = await seed.seed(source);
  await agent.rpc({ action: 'torrent:add', destination: agent.external, source: shared.magnetURI + `&x.pe=127.0.0.1:${seed.port}` });
  await agent.waitFor(async () => (await agent.status()).inventory.some(entry => entry.infoHash === shared.infoHash));
  const before = await agent.status(), transfer = before.torrents.find(row => row.infoHash === shared.infoHash);
  assert.equal(before.capabilities.torrentFileDeletion, true);
  assert.equal(transfer.dataPath, path.join(agent.external, 'delete-me'));
  assert.ok(Number.isSafeInteger(transfer.completionGeneration) && transfer.completionGeneration > 0);
  const sibling = path.join(agent.external, 'keep.txt'); fs.writeFileSync(sibling, 'keep');
  const expected = { infoHash: transfer.infoHash, dataPath: transfer.dataPath, sessionGeneration: transfer.completionGeneration };
  await assert.rejects(agent.rpc({ action: 'torrent:remove', id: transfer.infoHash, deleteData: true,
    expected: { ...expected, sessionGeneration: expected.sessionGeneration + 1 } }), /changed after review/);
  assert.deepEqual(fs.readFileSync(path.join(transfer.dataPath, 'config.json')), config);
  await agent.rpc({ action: 'torrent:remove', id: transfer.infoHash, deleteData: true, expected });
  const after = await agent.status();
  assert.equal(after.torrents.some(row => row.infoHash === transfer.infoHash), false);
  assert.equal(after.inventory.some(entry => entry.infoHash === transfer.infoHash), false);
  assert.equal(fs.existsSync(transfer.dataPath), false);
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep');
});

test('single-file torrents expose their actual file path and parent browse destination', { timeout: 25000 }, async t => {
  const agent = await fixture(t), source = path.join(agent.home, 'config.json');
  fs.writeFileSync(source, '{}\n');
  const seed = new TorrentEngine({ dht: false, tracker: false, lsd: false }); t.after(() => seed.destroy());
  const shared = await seed.seed(source);
  await agent.rpc({ action: 'torrent:add', destination: agent.external, source: shared.magnetURI + `&x.pe=127.0.0.1:${seed.port}` });
  await agent.waitFor(async () => (await agent.status()).inventory.length === 1);
  const entry = (await agent.status()).inventory[0];
  assert.equal(entry.path, path.join(agent.external, 'config.json')); assert.equal(entry.directory, false);
  assert.equal(entry.browseRelative, ''); assert.equal(entry.relative, 'config.json');
  assert.deepEqual(entry.files, [{ path: '', size: 3 }]);
});

test('Spark model sharing toggles persist with no duplicate inventory, and category changes keep files in place', { timeout: 25000 }, async t => {
  const agent = await fixture(t);
  await agent.pull(agent.external, revisionA, ['config.json', 'nested/model.gguf']);
  const [entry] = (await agent.status()).inventory;
  fs.writeFileSync(path.join(entry.path, 'unrelated-private.txt'), 'not selected');
  assert.equal(entry.kind, 'model');
  await agent.rpc({ action: 'inventory:sharing', id: entry.id, enabled: true });
  let status = await agent.status();
  assert.equal(status.inventoryControls, true);
  assert.equal(status.inventory.length, 1);
  assert.equal(status.torrents.length, 1);
  assert.equal(status.torrents[0].inventoryId, entry.id);
  assert.equal(status.torrents[0].seeding, true);
  assert.deepEqual(status.torrents[0].files.map(file => file.path).sort(), ['inventory/config.json', 'inventory/nested/model.gguf']);
  const hash = status.torrents[0].infoHash;
  await agent.rpc({ action: 'inventory:kind', id: entry.id, kind: 'torrent' });
  assert.equal((await agent.status()).inventory[0].kind, 'torrent');
  await agent.rpc({ action: 'inventory:sharing', id: entry.id, enabled: false });
  await agent.rpc({ action: 'hf:clear' });
  await agent.stop(); await agent.start();
  await agent.waitFor(async () => (await agent.status()).torrents[0]?.done);
  status = await agent.status();
  assert.equal(status.inventory.length, 1);
  assert.equal(status.inventory[0].kind, 'torrent');
  assert.equal(status.inventory[0].path, entry.path);
  assert.equal(status.torrents[0].paused, true);
  assert.equal(status.torrents[0].seeding, false);
  assert.equal(status.downloads.length, 0);
  await agent.rpc({ action: 'inventory:sharing', id: entry.id, enabled: true });
  assert.equal((await agent.status()).torrents[0].infoHash, hash);
  assert.equal((await agent.status()).torrents[0].seeding, true);
  await agent.rpc({ action: 'inventory:kind', id: entry.id, kind: 'model' });
  for (const file of ['config.json', 'nested/model.gguf']) assert.deepEqual(fs.readFileSync(path.join(entry.path, file)), bytesFor(revisionA, file));
  assert.equal(fs.readFileSync(path.join(entry.path, 'unrelated-private.txt'), 'utf8'), 'not selected');
});

test('Spark rejects invalid sharing controls and missing storage while Off stays usable', { timeout: 20000 }, async t => {
  const agent = await fixture(t);
  await agent.pull(agent.external);
  const [entry] = (await agent.status()).inventory;
  await assert.rejects(agent.rpc({ action: 'inventory:sharing', id: entry.id, enabled: 'yes' }), /on or off/);
  await assert.rejects(agent.rpc({ action: 'inventory:kind', id: entry.id, kind: 'other' }), /My Models or Torrents/);
  await assert.rejects(agent.rpc({ action: 'inventory:sharing', id: 'unregistered', enabled: true }), /no longer/);
  await agent.rpc({ action: 'inventory:sharing', id: entry.id, enabled: true });
  const parked = agent.external + '-offline'; fs.renameSync(agent.external, parked);
  await assert.rejects(agent.rpc({ action: 'inventory:sharing', id: entry.id, enabled: true }), /unavailable|missing/);
  await agent.rpc({ action: 'inventory:sharing', id: entry.id, enabled: false });
  fs.renameSync(parked, agent.external);
  assert.equal((await agent.status()).torrents[0].paused, true);
});
