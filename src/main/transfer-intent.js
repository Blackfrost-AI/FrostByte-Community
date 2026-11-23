function savedField(state, key) {
  return { present: Object.hasOwn(state, key), value: state[key] };
}

function restoreField(state, key, saved) {
  if (saved.present) state[key] = saved.value;
  else delete state[key];
}

/** Serialize whole transfer transactions so a rollback cannot erase a later commit. */
export class TransferMutationCoordinator {
  constructor() {
    this.tail = Promise.resolve();
    this.closed = false;
  }

  run(operation) {
    if (this.closed) return Promise.reject(new Error('FrostByte is shutting down. Try again after restarting.'));
    if (typeof operation !== 'function') return Promise.reject(new Error('A transfer transaction needs an operation.'));
    const result = this.tail.then(operation);
    // Keep the queue usable after a rejected transaction while returning the
    // original result to its caller.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async close() {
    this.closed = true;
    await this.tail;
  }
}

/** Commit the restart intent as one store write and restore in-memory state if it fails. */
export function commitTransferIntent(store, transfers, completionMoves) {
  if (!store?.state || typeof store._flush !== 'function' || !Array.isArray(transfers) || !Array.isArray(completionMoves)) {
    throw new Error('Invalid transfer persistence transaction.');
  }
  const previousTransfers = savedField(store.state, 'transfers');
  const previousMoves = savedField(store.state, 'completionMoves');
  // Clone the whole prospective transaction before publishing either field.
  // A non-cloneable completion record must not leave half of the in-memory
  // checkpoint changed even though no durable write was attempted.
  const nextTransfers = structuredClone(transfers);
  const nextMoves = structuredClone(completionMoves);
  store.state.transfers = nextTransfers;
  store.state.completionMoves = nextMoves;
  try { store._flush(); }
  catch (error) {
    restoreField(store.state, 'transfers', previousTransfers);
    restoreField(store.state, 'completionMoves', previousMoves);
    throw error;
  }
}

/** Persist intent before a live mutation. A rejected durable write never reaches run(). */
export async function applyDurableTransferIntent({ store, transfers, completionMoves, run, rollbackLive }) {
  if (typeof run !== 'function') throw new Error('A transfer transaction needs a live operation.');
  const beforeTransfers = structuredClone(store.state.transfers ?? []);
  const beforeMoves = structuredClone(store.state.completionMoves ?? []);
  commitTransferIntent(store, transfers, completionMoves);
  try {
    const result = await run();
    if (result === false) throw new Error('This transfer is no longer available. Refresh and try again.');
    return result;
  } catch (error) {
    const failures = [error];
    if (typeof rollbackLive === 'function') {
      try { await rollbackLive(); } catch (rollbackError) { failures.push(rollbackError); }
    }
    try { commitTransferIntent(store, beforeTransfers, beforeMoves); }
    catch (rollbackError) { failures.push(rollbackError); }
    if (failures.length > 1) throw new AggregateError(failures, 'Could not apply the transfer change or fully restore its previous state. Restart FrostByte before retrying.');
    throw error;
  }
}
