/** Explicit physical-device acceptance test. No default hosts or download folders.
 * FROSTBYTE_LAN_PLAN names a private JSON plan prepared by the operator, containing
 * { destination, small:{identity,magnet}, large:{identity,metadata,peers} }.
 * Usage: node scripts/verify-hybrid-lan.js magnet|hybrid|baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { TorrentEngine } from '../src/main/torrent.js';
import { hfDownloadFile, sha256File } from '../src/main/hf.js';
import { downloadHybrid } from '../src/main/hf-hybrid.js';
const mode = process.argv[2];
if (!['magnet', 'hybrid', 'baseline'].includes(mode) || !process.env.FROSTBYTE_LAN_PLAN) throw new Error('Choose a test mode and an explicit FROSTBYTE_LAN_PLAN.');
const plan = JSON.parse(fs.readFileSync(process.env.FROSTBYTE_LAN_PLAN, 'utf8'));
assert.ok(path.isAbsolute(plan.destination));
const destination = path.join(plan.destination, mode);
fs.mkdirSync(destination, { recursive: true });
const identity = mode === 'magnet' ? plan.small.identity : plan.large.identity;
const file = path.join(destination, path.basename(identity.filePath));
assert.ok(!fs.existsSync(file), 'Use a fresh destination so a cached file cannot pass as a transfer.');
const disk = fs.statfsSync(destination);
assert.ok(disk.bavail * disk.bsize > identity.size + 1024 ** 3, 'Insufficient free space for this test.');
const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
let lastLog = 0, timer, progress = {}, payloadUploads = 0;
engine.client.on('torrent', torrent => torrent.on('wire', wire => wire.on('upload', bytes => { payloadUploads += bytes; })));
const report = value => {
  progress = value;
  if (Date.now() - lastLog > 5000) { lastLog = Date.now(); console.log(JSON.stringify({ mode, ...value })); }
};
const started = Date.now(), controller = new AbortController();
timer = setTimeout(() => controller.abort(new Error('Physical transfer exceeded 45 minutes.')), 45 * 60 * 1000);
const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  let result;
  if (mode === 'magnet') {
    const complete = new Promise((resolve, reject) => {
      engine.once('done', resolve); engine.once('torrent-error', error => reject(new Error(error.message)));
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    engine.on('progress', report);
    await engine.add(plan.small.magnet, { path: destination, kind: 'model' });
    result = await complete;
    assert.ok(result.downloaded > 0); await engine.pause(result.infoHash);
    result = { bytes: result.length, peerBytes: result.downloaded, hfBytes: 0 };
  } else if (mode === 'hybrid') {
    result = await downloadHybrid({ identity, plan: plan.large, dest: file, approvedRoot: destination,
      client: engine.client, signal: controller.signal, onProgress: report });
    assert.ok(result.hfBytes > 0, 'HF must contribute model bytes');
    assert.ok(result.peerBytes > 0, 'Spark must contribute model bytes');
    assert.equal(payloadUploads, 0, 'Receive-only mode must not upload model bytes');
  } else {
    result = await hfDownloadFile({ ...identity, dest: file, approvedRoot: destination, signal: controller.signal, onProgress: report });
  }
  assert.equal(fs.statSync(file).size, identity.size);
  const sha256 = await sha256File(file); assert.equal(sha256, identity.sha256);
  const evidence = { mode, completed: true, startedAt: new Date(started).toISOString(), seconds: (Date.now() - started) / 1000,
    repoId: identity.repoId, revision: identity.revision, filePath: identity.filePath, sha256, bytes: identity.size,
    hfBytes: result.hfBytes ?? (mode === 'baseline' ? identity.size : 0), peerBytes: result.peerBytes || 0, payloadUploads, destination: file };
  fs.writeFileSync(path.join(plan.destination, mode + '-result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); await engine.destroy(); }
