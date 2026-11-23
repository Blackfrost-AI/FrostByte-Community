/**
 * Headless engine test.
 *
 * Verifies the real P2P loop end to end without any GUI:
 *   1. create a fake "model" file
 *   2. seed it from box A  -> get a magnet link
 *   3. pull that magnet from box B  -> bytes arrive
 *   4. confirm the received file is byte-for-byte identical
 *
 * Byte-for-byte equality is the whole point: models are content, not
 * something we parse. If hashes match, the file is correct.
 *
 * Run: npm run test:engine
 */
import { TorrentEngine } from '../src/main/torrent.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-test-'));
const srcDir = path.join(root, 'models');
const seedDir = path.join(root, 'seeder-home');
const leechDir = path.join(root, 'leecher-home');
for (const d of [srcDir, seedDir, leechDir]) fs.mkdirSync(d, { recursive: true });

// A pseudo-model: random bytes so a corrupted transfer can't pass by luck.
const MODEL_NAME = 'tiny-test-model-Q4_K_M.gguf';
const MODEL_PATH = path.join(srcDir, MODEL_NAME);
const payload = crypto.randomBytes(6 * 1024 * 1024); // 6 MB, spans multiple pieces
fs.writeFileSync(MODEL_PATH, payload);
const wantSha = sha256(payload);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const log = (...a) => console.log(...a);
let failures = 0;
function check(label, cond, extra = '') {
  const mark = cond ? '  ok  ' : ' FAIL ';
  log(`[${mark}] ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

const seeder = new TorrentEngine({ dht: false, tracker: false, lsd: false, allowPeerAddresses: true });
const leecher = new TorrentEngine({ dht: false, tracker: false, lsd: false, allowPeerAddresses: true });
seeder.setDownloadPath(seedDir);
leecher.setDownloadPath(leechDir);

try {
  log('\n1. seeding a model file from the always-on box');
  const seeded = await seeder.seed(MODEL_PATH, { name: MODEL_NAME });
  check('seeder reports the file', seeded.name === MODEL_NAME || !!seeded.infoHash, seeded.name);
  check('has an infohash', /^[a-f0-9]{40}$/i.test(seeded.infoHash), seeded.infoHash);
  check('magnet link generated', seeded.magnetURI?.startsWith('magnet:'), seeded.magnetURI?.slice(0, 60) + '…');
  check('length matches source', seeded.length === payload.length, `${seeded.length} bytes`);

  log('\n2. a second box pulls that magnet');
  const leeching = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('transfer timed out after 45s')), 45_000);
    leecher.on('done', (t) => { clearTimeout(timer); resolve(t); });
  });

  await leecher.add(seeded.magnetURI + `&x.pe=127.0.0.1:${seeder.port}`, { path: leechDir });

  // Watch progress so we can prove bytes actually moved over the wire.
  let sawPeers = false;
  let sawProgress = false;
  leecher.on('progress', (t) => {
    if (t.numPeers > 0) sawPeers = true;
    if (t.downloaded > 0) sawProgress = true;
  });

  await leeching;
  check('peers connected over the swarm', sawPeers);
  check('bytes transferred', sawProgress);

  log('\n3. verifying the received file is byte-for-byte identical');
  const receivedPath = path.join(leechDir, MODEL_NAME);
  const altPath = findFile(leechDir, MODEL_NAME);
  const actualPath = fs.existsSync(receivedPath) ? receivedPath : altPath;
  check('file landed on disk', !!actualPath, actualPath ? path.relative(root, actualPath) : 'not found');

  if (actualPath) {
    const got = fs.readFileSync(actualPath);
    check('size matches', got.length === payload.length, `${got.length} vs ${payload.length}`);
    const gotSha = sha256(got);
    check('sha256 matches source', gotSha === wantSha, gotSha.slice(0, 16) + '…');
  }

  log('\n4. transfers are drivable from the UI');
  const list = leecher.list();
  check('engine lists the torrent', list.length >= 1, `${list.length} torrent(s)`);
  const t = list[0];
  check('reports progress 1.0 when done', t.progress >= 0.999, String(t.progress));
  check('reports seeding once complete', t.seeding === true);
  check('reports a ratio field', typeof t.ratio === 'number', String(t.ratio));
  check('file list is populated', t.files.length >= 1, t.files.map((f) => f.name).join(','));
  check('finished files report 100% individually', t.files.every(f => f.progress === 1));

  check('pause works', await leecher.pause(t.infoHash));
  check('resume works', await leecher.resume(t.infoHash));
  check('remove works', await leecher.remove(t.infoHash, false));
  check('torrent gone after remove', leecher.list().length === 0);

  log('\n5. magnet parsing and formatting helpers');
  const { extractInfoHash, formatBytes, formatSpeed, formatEta } = await import('../src/main/torrent.js');
  check('extracts btih from magnet', extractInfoHash(seeded.magnetURI) === seeded.infoHash);
  check('formats bytes', formatBytes(18_200_000_000) === '17.0 GB', formatBytes(18_200_000_000));
  check('formats speed', formatSpeed(41_500_000) === '39.6 MB/s', formatSpeed(41_500_000));
  check('formats eta', formatEta(252_000) === '4m 12s', formatEta(252_000));
} catch (err) {
  log(`\n[fail] ${err.message}`);
  failures++;
} finally {
  await seeder.destroy();
  await leecher.destroy();
  log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}
