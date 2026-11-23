import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDurableTransferIntent, commitTransferIntent, TransferMutationCoordinator } from '../src/main/transfer-intent.js';
import { TorrentEngine } from '../src/main/torrent.js';

const oldHash = 'a'.repeat(40), newHash = 'b'.repeat(40);
function fixture() {
  let writes = 0;
  const store = { state: { transfers: [{ infohash: oldHash, paused: false }], completionMoves: [] }, _flush() { writes++; } };
  return { store, writes: () => writes };
}

test('a rejected transfer checkpoint restores memory and never runs the network mutation', async () => {
  const { store } = fixture();
  const before = structuredClone(store.state);
  let ran = false;
  store._flush = () => { throw new Error('disk full'); };
  await assert.rejects(applyDurableTransferIntent({ store, transfers: [{ infohash: oldHash, paused: true }], completionMoves: [],
    run: async () => { ran = true; } }), /disk full/);
  assert.equal(ran, false);
  assert.deepEqual(store.state, before);
});

test('a failed live mutation rolls back both live intent and the durable snapshot', async () => {
  const { store, writes } = fixture();
  let live = 'active', rolledBack = false;
  await assert.rejects(applyDurableTransferIntent({ store, transfers: [{ infohash: newHash, paused: true }], completionMoves: [],
    run: async () => { live = 'partially-paused'; throw new Error('engine refused'); },
    rollbackLive: async () => { live = 'active'; rolledBack = true; },
  }), /engine refused/);
  assert.equal(rolledBack, true); assert.equal(live, 'active');
  assert.deepEqual(store.state.transfers, [{ infohash: oldHash, paused: false }]);
  assert.equal(writes(), 2);
});

test('successful durable transfer intent is visible before the live operation', async () => {
  const { store } = fixture();
  await applyDurableTransferIntent({ store, transfers: [{ infohash: oldHash, paused: true }], completionMoves: [],
    run: async () => assert.equal(store.state.transfers[0].paused, true) });
  assert.equal(store.state.transfers[0].paused, true);
  assert.throws(() => commitTransferIntent(store, null, []), /Invalid transfer/);
});

test('prospective transfer fields are cloned before either is published', () => {
  const { store } = fixture();
  const before = structuredClone(store.state);
  assert.throws(() => commitTransferIntent(store, [{ infohash: newHash }], [() => {}]), /could not be cloned/i);
  assert.deepEqual(store.state, before);
});

test('serialized rollback finishes before a later transfer commit', async () => {
  const { store } = fixture();
  const queue = new TransferMutationCoordinator();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const first = queue.run(() => applyDurableTransferIntent({
    store, transfers: [{ infohash: oldHash, paused: true }], completionMoves: [],
    run: async () => { await blocked; throw new Error('first live change failed'); },
  }));
  const second = queue.run(() => applyDurableTransferIntent({
    store, transfers: [{ infohash: oldHash, paused: false }, { infohash: newHash, paused: true }], completionMoves: [],
    run: async () => {},
  }));
  release();
  await assert.rejects(first, /first live change failed/);
  await second;
  assert.deepEqual(store.state.transfers, [
    { infohash: oldHash, paused: false }, { infohash: newHash, paused: true },
  ]);
  const closing = queue.close();
  await closing;
  await assert.rejects(queue.run(async () => {}), /shutting down/i);
});

test('engine intent rolls back when an update listener rejects pause or resume', async () => {
  const infoHash = 'c'.repeat(40);
  const torrent = {
    infoHash, paused: false, wires: [], _peers: new Map(), _resumePeers: [], _explicitShare: false,
    pause() { this.paused = true; }, resume() { this.paused = false; }, addPeer() { return true; },
  };
  const engine = Object.create(TorrentEngine.prototype);
  Object.assign(engine, {
    client: { get: async () => torrent }, userPaused: new Set(), autoQueued: [],
    _shape: value => ({ infoHash: value.infoHash, paused: value.paused }),
    emit() { throw new Error('checkpoint listener failed'); },
  });
  await assert.rejects(engine.pause(infoHash), /checkpoint listener failed/);
  assert.equal(torrent.paused, false); assert.equal(engine.userPaused.has(infoHash), false);

  torrent.paused = true; torrent._resumePeers = ['192.0.2.20:6881']; engine.userPaused.add(infoHash);
  await assert.rejects(engine.resume(infoHash), /checkpoint listener failed/);
  assert.equal(torrent.paused, true); assert.equal(engine.userPaused.has(infoHash), true);
  assert.deepEqual(torrent._resumePeers, ['192.0.2.20:6881']);
});
