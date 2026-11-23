import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { descriptorCapacity, MAX_TORRENT_OPEN_DESCRIPTORS, torrentDescriptorBudgetSnapshot } from '../src/main/torrent-descriptor-budget.js';
import { TorrentEngine } from '../src/main/torrent.js';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-capacity-')));
process.env.FROSTBYTE_HOME = path.join(root, 'profile');
const { Store } = await import('../src/main/store.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
test('file budget scales with OS limits, reserves headroom, and fails conservatively when unknown', () => {
  assert.equal(descriptorCapacity(256), 128);
  assert.equal(descriptorCapacity(8192), 4096);
  assert.equal(descriptorCapacity(1048575), 16384);
  assert.equal(descriptorCapacity('unlimited'), 16384);
  assert.equal(descriptorCapacity(undefined, 'linux'), 128);
  assert.equal(descriptorCapacity(undefined, 'darwin'), 128);
  assert.equal(descriptorCapacity(undefined, 'win32'), 4096);
  assert.equal(descriptorCapacity(null, 'win32'), 4096);
  assert.equal(descriptorCapacity(64, 'win32'), 32);
  assert.equal(descriptorCapacity(-1, 'win32'), 128);
  assert.equal(descriptorCapacity(64), 32);
});
test('active sessions and library entries survive beyond the old count-trimming limits', () => {
  fs.mkdirSync(process.env.FROSTBYTE_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.FROSTBYTE_HOME, 'settings.json'), JSON.stringify({ downloadDir: path.join(root, 'downloads'), schedEnabled: true }));
  const store = new Store(); assert.equal(store.getSettings().bandwidthMode, 'schedule');
  store.setSettings({ bandwidthMode: 'normal' });
  const library = Array.from({ length: 5001 }, (_, i) => ({ name: `Model ${i}`, path: path.join(root, `model-${i}`), infohash: i.toString(16).padStart(40, '0') }));
  const transfers = Array.from({ length: 2001 }, (_, i) => ({ infohash: i.toString(16).padStart(40, '0'), paused: false, explicitShare: true }));
  store._commitStateFields({ library, transfers });
  store.addToLibrary({ name: 'Next', path: path.join(root, 'next'), infohash: 'f'.repeat(40) });
  const restored = new Store();
  assert.equal(restored.getSettings().bandwidthMode, 'normal');
  assert.equal(restored.state.library.length, 5002); assert.equal(restored.state.transfers.length, 2001);
  assert.equal(restored.state.library[0].path, library[0].path);
  assert.throws(() => store.setSettings({ bandwidthMode: 'unlimited-ish' }), /Choose Normal/);
});
test('more than 128 reviewed files can remain shared without removing existing seeds', { skip: MAX_TORRENT_OPEN_DESCRIPTORS < 512, timeout: 30000 }, async () => {
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: false });
  try {
    for (let i = 0; i < 140; i++) {
      const file = path.join(root, `seed-${i}.gguf`); fs.writeFileSync(file, `unique share ${i}`);
      await engine.seed(file);
    }
    assert.equal(engine.list().length, 140); assert.equal(engine.list().every(row => row.explicitShare && !row.paused), true);
    assert.ok(torrentDescriptorBudgetSnapshot().inUse > 128);
  } finally { await engine.destroy(); }
  assert.equal(torrentDescriptorBudgetSnapshot().inUse, 0);
});
