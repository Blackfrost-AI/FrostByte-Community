import test from 'node:test';
import assert from 'node:assert/strict';

import { settleTorrentRemoval } from '../src/main/transfer-removal.js';

const infoHash = 'a'.repeat(40);
const otherHash = 'b'.repeat(40);

function makeFixture(remove, { failFlushes = [] } = {}) {
  const libraryEntry = { name: 'target', infohash: infoHash, path: '/downloads/target' };
  const otherLibraryEntry = { name: 'other', infohash: otherHash, path: '/downloads/other' };
  const transferEntry = { infohash: infoHash, status: 'paused' };
  const completionEntry = { infohash: infoHash, destination: '/library/target' };
  const initialState = {
    library: [libraryEntry, otherLibraryEntry],
    transfers: [transferEntry],
    completionMoves: [completionEntry],
  };
  let durableState = structuredClone(initialState);
  let flushCount = 0;
  const store = {
    state: initialState,
    getLibrary() { return this.state.library; },
    _flush() {
      flushCount += 1;
      if (failFlushes.includes(flushCount)) throw new Error(`state write ${flushCount} failed`);
      durableState = structuredClone(this.state);
    },
  };
  const pendingRecord = { destination: '/library/target', startedAt: 123 };
  const completionMove = { infohash: infoHash, destination: '/library/target', attempts: 1 };
  const pendingCompletionRecords = new Map([[infoHash, pendingRecord]]);
  const completionMoves = new Map([[infoHash, completionMove]]);

  return {
    args: {
      engine: { remove },
      store,
      infoHash,
      pendingCompletionRecords,
      completionMoves,
      transferSessionRecords: () => [transferEntry, { infohash: otherHash, status: 'downloading' }],
      completionMoveRecords: () => [...completionMoves.values()],
    },
    store,
    initialState,
    libraryEntry,
    otherLibraryEntry,
    pendingRecord,
    completionMove,
    pendingCompletionRecords,
    completionMoves,
    durableState: () => structuredClone(durableState),
    flushCount: () => flushCount,
  };
}

test('a desired-state write failure leaves the engine and removal intent untouched', async () => {
  let engineCalls = 0;
  const fixture = makeFixture(async () => {
    engineCalls += 1;
    return true;
  }, { failFlushes: [1] });
  const library = fixture.store.state.library;
  const transfers = fixture.store.state.transfers;
  const completionMovesState = fixture.store.state.completionMoves;
  const durableBefore = fixture.durableState();

  await assert.rejects(settleTorrentRemoval(fixture.args), /state write 1 failed/);

  assert.equal(engineCalls, 0);
  assert.equal(fixture.flushCount(), 1);
  assert.strictEqual(fixture.store.state.library, library);
  assert.strictEqual(fixture.store.state.transfers, transfers);
  assert.strictEqual(fixture.store.state.completionMoves, completionMovesState);
  assert.deepEqual(fixture.store.state, fixture.initialState);
  assert.deepEqual(fixture.durableState(), durableBefore);
  assert.strictEqual(fixture.pendingCompletionRecords.get(infoHash), fixture.pendingRecord);
  assert.strictEqual(fixture.completionMoves.get(infoHash), fixture.completionMove);
});

test('record generation failure restores maps before touching persistence or the engine', async () => {
  let engineCalls = 0;
  const fixture = makeFixture(async () => {
    engineCalls += 1;
    return true;
  });
  fixture.args.transferSessionRecords = () => { throw new Error('record generation failed'); };
  const stateBefore = { ...fixture.store.state };

  await assert.rejects(settleTorrentRemoval(fixture.args), /record generation failed/);

  assert.equal(engineCalls, 0);
  assert.equal(fixture.flushCount(), 0);
  assert.strictEqual(fixture.store.state.library, stateBefore.library);
  assert.strictEqual(fixture.store.state.transfers, stateBefore.transfers);
  assert.strictEqual(fixture.store.state.completionMoves, stateBefore.completionMoves);
  assert.strictEqual(fixture.pendingCompletionRecords.get(infoHash), fixture.pendingRecord);
  assert.strictEqual(fixture.completionMoves.get(infoHash), fixture.completionMove);
});

test('removal intent is durable before the one engine call and deleteData is preserved', async () => {
  const sequence = [];
  let releaseEngine;
  const engineResult = new Promise(resolve => { releaseEngine = resolve; });
  const fixture = makeFixture(async (receivedHash, deleteData) => {
    sequence.push('engine');
    assert.equal(receivedHash, infoHash);
    assert.equal(deleteData, true);
    return engineResult;
  });
  const originalFlush = fixture.store._flush;
  fixture.store._flush = () => {
    sequence.push('flush');
    originalFlush.call(fixture.store);
  };
  fixture.args.deleteData = true;
  fixture.args.runEngineTransaction = async operation => {
    sequence.push('transaction');
    assert.deepEqual(fixture.store.state.library, [fixture.otherLibraryEntry]);
    assert.deepEqual(fixture.store.state.transfers, [{ infohash: otherHash, status: 'downloading' }]);
    assert.deepEqual(fixture.store.state.completionMoves, []);
    assert.deepEqual(fixture.durableState(), fixture.store.state);
    assert.equal(fixture.pendingCompletionRecords.has(infoHash), false);
    assert.equal(fixture.completionMoves.has(infoHash), false);
    return operation();
  };

  const removal = settleTorrentRemoval(fixture.args);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(sequence, ['flush', 'transaction', 'engine']);
  assert.equal(fixture.flushCount(), 1);
  assert.deepEqual(fixture.durableState(), fixture.store.state);
  releaseEngine(true);
  assert.equal(await removal, true);
  assert.equal(fixture.flushCount(), 1);
});

test('an engine failure restores the prior store and completion intent durably', async () => {
  let engineCalls = 0;
  const fixture = makeFixture(async () => {
    engineCalls += 1;
    throw new Error('engine refused removal');
  });
  const durableBefore = fixture.durableState();

  await assert.rejects(settleTorrentRemoval(fixture.args), /engine refused removal/);

  assert.equal(engineCalls, 1);
  assert.equal(fixture.flushCount(), 2);
  assert.deepEqual(fixture.store.state, fixture.initialState);
  assert.deepEqual(fixture.durableState(), durableBefore);
  assert.strictEqual(fixture.pendingCompletionRecords.get(infoHash), fixture.pendingRecord);
  assert.strictEqual(fixture.completionMoves.get(infoHash), fixture.completionMove);
});

test('a stale engine result is rolled back like an engine failure', async () => {
  const fixture = makeFixture(async () => false);
  const durableBefore = fixture.durableState();

  await assert.rejects(settleTorrentRemoval(fixture.args), /no longer available/);

  assert.equal(fixture.flushCount(), 2);
  assert.deepEqual(fixture.store.state, fixture.initialState);
  assert.deepEqual(fixture.durableState(), durableBefore);
  assert.equal(fixture.pendingCompletionRecords.has(infoHash), true);
  assert.equal(fixture.completionMoves.has(infoHash), true);
});

test('rollback persistence failure reports both failures and restores prior memory', async () => {
  const fixture = makeFixture(async () => { throw new Error('engine refused removal'); }, { failFlushes: [2] });
  let failure;
  try {
    await settleTorrentRemoval(fixture.args);
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /saved state could not be restored/);
  assert.deepEqual(failure.errors.map(error => error.message), [
    'engine refused removal',
    'state write 2 failed',
  ]);
  assert.equal(fixture.flushCount(), 2);
  assert.deepEqual(fixture.store.state, fixture.initialState);
  assert.deepEqual(fixture.durableState(), {
    library: [fixture.otherLibraryEntry],
    transfers: [{ infohash: otherHash, status: 'downloading' }],
    completionMoves: [],
  });
  assert.strictEqual(fixture.pendingCompletionRecords.get(infoHash), fixture.pendingRecord);
  assert.strictEqual(fixture.completionMoves.get(infoHash), fixture.completionMove);
});

test('a transaction wrapper cannot skip the engine call while accepting removal', async () => {
  let engineCalls = 0;
  const fixture = makeFixture(async () => {
    engineCalls += 1;
    return true;
  });
  fixture.args.runEngineTransaction = async () => true;

  await assert.rejects(settleTorrentRemoval(fixture.args), /did not invoke the engine/);

  assert.equal(engineCalls, 0);
  assert.equal(fixture.flushCount(), 2);
  assert.deepEqual(fixture.store.state, fixture.initialState);
  assert.equal(fixture.pendingCompletionRecords.has(infoHash), true);
  assert.equal(fixture.completionMoves.has(infoHash), true);
});
