import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TorrentEngine } from '../src/main/torrent.js';
import { inspectTorrent, normalizeSource } from '../src/main/torrent-source.js';
const waitFor = async fn => { for(let i=0;i<400;i++){ if(await fn()) return; await delay(25); } throw new Error('Timed out'); };

test('source normalization trims link formatting while preserving exact torrent filename whitespace', () => {
  const magnet = `  MAGNET:?xt=urn:btih:${'a'.repeat(40)}&dn=release.torrent  `;
  assert.equal(normalizeSource(magnet), magnet.trim().replace(/^MAGNET:/, 'magnet:'));
  const exactPath = path.join(os.tmpdir(), ' release metadata.torrent ');
  assert.equal(normalizeSource(exactPath), exactPath);
});

test('metadata preview and selective generic downloads preserve selection after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'fb-selection-'));
  const source = path.join(root,'update'); fs.mkdirSync(source);
  const config = Buffer.from('{"version":2}');
  fs.writeFileSync(path.join(source,'config.json'),config);
  fs.writeFileSync(path.join(source,'update.zip'),crypto.randomBytes(128 * 1024));
  fs.writeFileSync(path.join(source,'weights.gguf'),crypto.randomBytes(8 * 1024 ** 2));
  const opts = {dht:false,tracker:false,lsd:false,allowPeerAddresses:true};
  const seed = new TorrentEngine(opts), pull = new TorrentEngine(opts);
  let restored;
  try {
    const shared = await seed.seed(source); await waitFor(()=>seed.port);
    const metadata = path.join(root,'update.TORRENT');
    fs.writeFileSync(metadata,seed.client.torrents[0].torrentFile);
    const preview = await inspectTorrent(metadata);
    assert.equal(preview.files.length,3);
    assert.equal(pull.list().length,0,'preview does not create a transfer');
    const magnet = shared.magnetURI.replace(/^magnet:/, 'MAGNET:') + `&x.pe=127.0.0.1:${seed.port}&dn=release.torrent`;
    const magnetPreview = await inspectTorrent(magnet,{timeout:8000,allowPeerAddresses:true});
    assert.deepEqual(magnetPreview.files,preview.files);
    let completed = 0; pull.on('done',()=>completed++);
    const paths = ['update/config.json','update/update.zip'];
    await pull.add(magnet,{path:path.join(root,'download'),selectedPaths:paths});
    await waitFor(()=>pull.list()[0]?.done);
    const transfer = pull.list()[0];
    assert.equal(transfer.partial,true); assert.equal(transfer.progress,1);
    assert.equal(transfer.seeding,false,'partial transfer must not claim to be a full seed');
    assert.equal(transfer.length,config.length+128*1024);
    assert.equal(completed,1);
    assert.deepEqual(fs.readFileSync(path.join(root,'download','update','config.json')),config);
    assert.deepEqual(fs.readFileSync(path.join(root,'download','update','update.zip')),fs.readFileSync(path.join(source,'update.zip')));
    assert.equal(transfer.files.find(f=>f.name==='weights.gguf').selected,false);
    assert.ok(transfer.files.find(f=>f.name==='weights.gguf').progress < 0.05,'unselected weights are not downloaded');
    const [session] = pull.sessions();
    assert.deepEqual(session.selectedPaths,paths);
    await pull.destroy();
    restored = new TorrentEngine(opts); await restored.restore(session);
    await waitFor(()=>restored.list()[0]?.done);
    assert.equal(restored.list()[0].partial,true);
    assert.equal(restored.list()[0].length,transfer.length);
  } finally {
    await seed.destroy(); if (!pull._destroyed) await pull.destroy(); await restored?.destroy();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('closing a metadata preview cancels promptly', async () => {
  const controller = new AbortController();
  const pending = inspectTorrent('magnet:?xt=urn:btih:'+'e'.repeat(40),{signal:controller.signal});
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(pending,/cancelled/);
});
