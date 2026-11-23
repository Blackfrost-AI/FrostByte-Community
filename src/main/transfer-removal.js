/** Commit removal intent before the irreversible engine operation. */
export async function settleTorrentRemoval({
  engine, store, infoHash, deleteData = false, pendingCompletionRecords, completionMoves,
  transferSessionRecords, completionMoveRecords, runEngineTransaction = operation => operation(),
}) {
  if (!engine || typeof engine.remove !== 'function' || !store?.state || typeof store.getLibrary !== 'function'
    || typeof store._flush !== 'function' || !(pendingCompletionRecords instanceof Map) || !(completionMoves instanceof Map)
    || typeof transferSessionRecords !== 'function' || typeof completionMoveRecords !== 'function'
    || typeof runEngineTransaction !== 'function' || typeof infoHash !== 'string' || !/^[a-f0-9]{40}$/i.test(infoHash)) {
    throw new Error('Torrent removal state is invalid.');
  }
  infoHash = infoHash.toLowerCase();
  const stateFields = ['library', 'transfers', 'completionMoves'];
  const previousState = new Map(stateFields.map(key => [key, {
    present: Object.hasOwn(store.state, key), value: store.state[key],
  }]));
  const previousPending = [...pendingCompletionRecords.entries()];
  const previousCompletion = [...completionMoves.entries()];
  const sameHash = value => typeof value === 'string' && value.toLowerCase() === infoHash;
  const restoreMemory = () => {
    for (const [key, previous] of previousState) {
      if (previous.present) store.state[key] = previous.value;
      else delete store.state[key];
    }
    pendingCompletionRecords.clear();
    for (const entry of previousPending) pendingCompletionRecords.set(...entry);
    completionMoves.clear();
    for (const entry of previousCompletion) completionMoves.set(...entry);
  };

  pendingCompletionRecords.delete(infoHash);
  completionMoves.delete(infoHash);
  try {
    const transfers = transferSessionRecords();
    const moves = completionMoveRecords();
    if (!Array.isArray(transfers) || !Array.isArray(moves)) throw new Error('Torrent removal records are invalid.');
    store.state.library = store.getLibrary().filter(item => !sameHash(item?.infohash));
    store.state.transfers = transfers.filter(item => !sameHash(item?.infohash));
    store.state.completionMoves = moves.filter(item => !sameHash(item?.infohash));
    store._flush();
  } catch (error) {
    restoreMemory();
    throw error;
  }

  let operationCalled = false;
  const remove = () => {
    if (operationCalled) throw new Error('Torrent removal transaction invoked the engine more than once.');
    operationCalled = true;
    return engine.remove(infoHash, deleteData);
  };
  try {
    const removed = await runEngineTransaction(remove);
    if (!operationCalled) throw new Error('Torrent removal transaction did not invoke the engine.');
    if (!removed) throw new Error('This transfer is no longer available. Refresh and try again.');
  } catch (error) {
    restoreMemory();
    try { store._flush(); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'The transfer could not be removed and its saved state could not be restored. Restart FrostByte before retrying.');
    }
    throw error;
  }
  return true;
}
