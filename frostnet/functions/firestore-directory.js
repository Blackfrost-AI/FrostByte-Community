import { createHash } from 'node:crypto';
import { searchTokens } from './api.js';
const problem = (status, message) => Object.assign(new Error(message), { status });
const sha = value => createHash('sha256').update(value).digest('hex');

export class FirestoreDirectory {
  constructor(db) { this.db = db; }
  async get(collection, id) { const row = await this.db.collection(collection).doc(id).get(); return row.exists ? row.data() : null; }
  async search({ q, limit, cursor }) {
    let query = this.db.collection('listings'); if (q) query = query.where('tokens', 'array-contains', q);
    query = query.orderBy('__name__'); if (cursor) query = query.startAfter(cursor);
    const found = await query.limit(limit + 1).get(), docs = found.docs.slice(0, limit);
    const items = docs.map(row => { const { tokens, ...release } = row.data(); return release; });
    return { items, cursor: found.docs.length > limit ? docs.at(-1).id : '' };
  }
  async changes(cursor, limit) { const found = await this.db.collection('changes').orderBy('__name__').startAfter(String(cursor).padStart(16, '0')).limit(limit).get(); const changes = found.docs.map(row => row.data()); return { changes, cursor: String(changes.at(-1)?.sequence || cursor) }; }
  async submit({ key, digest, manifest, publisher, withdrawing, now, terms }) {
    const ref = (collection, id) => this.db.collection(collection).doc(id);
    const receiptRef = ref('submissions', key), releaseRef = ref('releases', digest), clock = ref('system', 'changes');
    const rate = ref('rates', sha(publisher + ':' + Math.floor(now / 3600000)));
    return this.db.runTransaction(async transaction => {
      const [priorReceipt, previous, count, quota] = await Promise.all([transaction.get(receiptRef), transaction.get(releaseRef), transaction.get(clock), transaction.get(rate)]);
      if (priorReceipt.exists) { const row = priorReceipt.data(); if (row.digest !== digest || (row.status === 'withdrawn') !== withdrawing) throw problem(409, 'Idempotency key already used.'); return row; }
      if ((quota.data()?.count || 0) >= 60) throw problem(429, 'Publisher hourly limit reached.');
      let identity;
      if (withdrawing) { if (!previous.exists || previous.data().manifest.publisher !== publisher) throw problem(404, 'Release not found.'); }
      else {
        identity = ref('identities', sha([publisher, manifest.release, manifest.variant].join('/')));
        const owner = await transaction.get(identity);
        if (owner.exists && owner.data().digest !== digest) throw problem(409, 'Immutable release variant; choose a new release ID.');
        if (previous.data()?.status === 'withdrawn') throw problem(409, 'Withdrawn release cannot be republished.');
      }
      const sequence = (count.data()?.sequence || 0) + 1, status = withdrawing ? 'withdrawn' : 'published';
      const release = { digest, manifest: manifest || previous.data().manifest, status, updated_at: new Date(now).toISOString(), availability: { status: 'unknown', observed_at: null } };
      const receipt = { id: key, digest, publisher, status, withdrawal: true, terms };
      if (identity) { transaction.set(identity, { digest }); transaction.set(ref('manifests', digest), manifest); }
      transaction.set(releaseRef, release); transaction.set(receiptRef, receipt);
      if (withdrawing) transaction.delete(ref('listings', digest)); else transaction.set(ref('listings', digest), { ...release, tokens: searchTokens(manifest) });
      transaction.set(clock, { sequence }); transaction.set(ref('changes', String(sequence).padStart(16, '0')), { sequence, digest, status, updated_at: release.updated_at });
      transaction.set(rate, { count: (quota.data()?.count || 0) + 1, expires_at: new Date(now + 86400000) });
      return receipt;
    });
  }
}
