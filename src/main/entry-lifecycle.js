import { randomUUID } from 'node:crypto';
import { entryPath, sameEntryCopy, entryIsHidden } from '../shared/entry-identity.js';

function copy(row) {
  if (!row?.id || !row.path || !['local', 'spark'].includes(row.device || 'local')) throw new Error('Choose an exact file copy.');
  return { id: row.id, device: row.device || 'local', deviceId: row.deviceId || '', path: row.path,
    directory: row.directory === true, name: row.name || row.repoId || row.id };
}
/** Durable metadata reconciliation. Deleted bytes are never claimed to be rolled back. */
export class EntryLifecycle {
  constructor(store) { this.store = store; }
  get hidden() { return this.store.state.hiddenItems || []; }
  get operations() { return this.store.state.entryOperations || []; }
  hide(row) {
    const entry = copy(row), hidden = this.hidden.filter(item => !sameEntryCopy(item, entry));
    if (hidden.length >= 5000) throw new Error('Restore some hidden entries before hiding more.');
    this.store._commitStateFields({ hiddenItems: [...hidden, { ...entry, hiddenAt: Date.now() }] });
  }
  restore(selector) {
    const matches = this.hidden.filter(row => typeof selector === 'string' ? row.id === selector : sameEntryCopy(row, selector));
    if (typeof selector === 'string' && matches.length > 1) throw new Error('Choose the exact device copy to restore.');
    this.store._commitStateFields({ hiddenItems: this.hidden.filter(row => !matches.includes(row)) });
  }
  begin(row, action) {
    const entry = copy(row), operations = this.operations.filter(op => !sameEntryCopy(op.entry, entry));
    if (operations.length >= 500) throw new Error('Resolve pending removals before starting another.');
    const operation = { id: randomUUID(), entry, action, phase: 'prepared', updatedAt: Date.now() };
    this.store._commitStateFields({ entryOperations: [...operations, operation] });
    return operation.id;
  }
  step(id, phase, error = '') {
    this.store._commitStateFields({ entryOperations: this.operations.map(op => op.id === id
      ? { ...op, phase, error: String(error).slice(0, 2000), updatedAt: Date.now() } : op) });
  }
  finish(id, inventory, hfRecords = this.store.state.hfDownloads || []) {
    const op = this.operations.find(row => row.id === id);
    if (!op || op.phase !== 'files-complete') throw new Error('The removal is not ready for reconciliation.');
    const base = entryPath(op.entry.path);
    const hfDownloads = hfRecords.filter(row => !(entryPath(row.dest) === base || op.entry.directory && entryPath(row.dest).startsWith(base + '/')));
    const downloadedItems = inventory.rows.filter(row => !sameEntryCopy({ ...row, device: 'local' }, op.entry));
    const hiddenItems = this.hidden.filter(row => !sameEntryCopy(row, op.entry));
    if (!entryIsHidden(op.entry, hiddenItems)) hiddenItems.push({ ...op.entry, hiddenAt: Date.now() });
    this.store._commitStateFields({ downloadedItems, hfDownloads, hiddenItems,
      entryOperations: this.operations.filter(row => row.id !== id) });
    inventory.rows = downloadedItems; inventory.cache = null;
    return hfDownloads;
  }
  recover(inventory) {
    for (const op of [...this.operations]) if (op.phase === 'files-complete') this.finish(op.id, inventory);
    // Prepared/interrupted file deletions require a fresh native review, never an automatic retry.
  }
}
