import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicationQueue, manifestDigest, frostnetOrigin } from '../src/main/publications.js';
import { validateRelease, FROSTNET_TERMS } from '../src/shared/release-manifest.js';
export const manifestFixture = () => validateRelease({ schema: 'frostbyte.release', version: 1, publisher: 'blackfrost', release: 'fixture-v1', variant: 'gguf', name: 'Fixture model', description: 'Local test only', origin: 'original', files: [{ path: 'model.gguf', size: 4, sha256: 'a'.repeat(64) }], license: { id: 'MIT', statement: 'Owner-created test bytes.' }, torrent: { infohash_v1: 'b'.repeat(40), metainfo_sha256: 'c'.repeat(64), piece_length: 16384 }, verified_at: '2026-10-10T00:00:00.000Z', redistribution_confirmed: true });
const settle = async queue => { for (let i = 0; i < 200 && queue.running.size; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(queue.running.size, 0); };
function fixture() {
  const store = { state: {}, _commitStateFields(patch) { Object.assign(this.state, structuredClone(patch)); } };
  const receipts = new Map(); let writes = 0, outage = false, connected = true, terms = FROSTNET_TERMS;
  const provider = { account: () => connected ? { id: 'blackfrost', terms } : null, lookup: async job => { if (outage) throw new Error('offline'); return receipts.get(job.id); }, receiptUrl: row => 'https://frostnet.si/releases/' + row.digest,
    submit: async job => { writes++; const receipt = { id: job.id, digest: job.digest, status: job.operation === 'withdraw' ? 'withdrawn' : 'published', withdrawal: true }; receipts.set(job.id, receipt); if (outage) throw new Error('timeout after acceptance'); return receipt; } };
  const queue = new PublicationQueue({ store, providers: { frostnet: provider } }), release = queue.draft(manifestFixture(), { request: { id: 'test' } });
  return { store, provider, queue, release, receipts, writes: () => writes, outage: value => { outage = value; }, connected: value => { connected = value; }, terms: value => { terms = value; } };
}
test('manifest is immutable, strips private extensions and rejects invalid provenance/path scope', () => {
  const original = manifestFixture(); assert.equal(validateRelease({ ...original, token: 'secret', path: '/private/model' }).token, undefined);
  assert.throws(() => validateRelease({ ...original, origin: 'derived' }), /pinned/);
  assert.throws(() => validateRelease({ ...original, files: [{ ...original.files[0], path: '../secret' }] }), /relative/);
  assert.throws(() => validateRelease({ ...original, license: { ...original.license, evidence_url: 'https://site.test?token=secret' } }), /credentials/);
  assert.equal(manifestDigest(original).length, 64); assert.throws(() => frostnetOrigin('https://frostnet.si.evil.test'), /Choose/);
});
test('draft re-verification does not create a second immutable identity solely for a timestamp', () => { const f = fixture(); const again = f.queue.draft({ ...manifestFixture(), verified_at: '2026-10-11T00:00:00Z' }, {}); assert.equal(again.digest, f.release.digest); });
test('verified local copies can attach to an imported draft without being erased by later imports', () => {
  const f = fixture(); f.store.state.releaseCopies = [{ digest: f.release.digest, imported: true }];
  f.queue.draft(manifestFixture(), { request: { id: 'verified-copy' }, path: '/private/local' });
  f.queue.draft(manifestFixture(), { imported: true });
  assert.equal(f.store.state.releaseCopies[0].request.id, 'verified-copy');
  assert.equal(f.queue.releases.length, 1);
});
test('timeout after acceptance reconciles on restart without duplicate writes', async () => {
  const f = fixture(); f.outage(true); f.queue.enqueue(f.release.digest, ['frostnet']); await settle(f.queue);
  assert.equal(f.queue.jobs[0].status, 'retryable error'); assert.equal(f.writes(), 1);
  f.outage(false); const restored = new PublicationQueue({ store: f.store, providers: { frostnet: f.provider } }); restored.retry(restored.jobs[0].id); await settle(restored);
  assert.equal(restored.jobs[0].status, 'published'); assert.equal(f.writes(), 1);
  restored.enqueue(f.release.digest, ['frostnet']); await settle(restored); assert.equal(restored.jobs.length, 1); assert.equal(f.writes(), 1);
  restored.enqueue(f.release.digest, ['frostnet'], 'withdraw'); await settle(restored); assert.equal(restored.jobs.at(-1).status, 'withdrawn');
});
test('revocation, changed terms and changed bytes block only the affected work', async () => {
  const f = fixture(); f.connected(false); f.queue.enqueue(f.release.digest, ['frostnet']); await settle(f.queue); assert.equal(f.queue.jobs[0].status, 'needs connection'); assert.equal(f.writes(), 0);
  f.connected(true); f.terms('new-terms'); f.queue.retry(f.queue.jobs[0].id); await settle(f.queue); assert.equal(f.queue.jobs[0].status, 'ineligible'); assert.equal(f.writes(), 0);
  const second = fixture(); const q = new PublicationQueue({ store: second.store, providers: { frostnet: second.provider, other: { ...second.provider, submit: async () => { throw new Error('provider outage'); } } } });
  q.enqueue(second.release.digest, ['frostnet', 'other']); await settle(q); assert.equal(q.jobs[0].status, 'published'); assert.equal(q.jobs[1].status, 'retryable error');
});
test('pending review remains distinct; durable intent precedes sending and disk errors do not send', async () => {
  const f = fixture(); f.provider.submit = async job => { assert.equal(f.queue.jobs.find(row => row.id === job.id).status, 'submitting'); return { id: job.id, digest: job.digest, status: 'pending review' }; };
  f.queue.enqueue(f.release.digest, ['frostnet']); await settle(f.queue); assert.equal(f.queue.jobs[0].status, 'pending review');
  const broken = fixture(); broken.store._commitStateFields = () => { throw new Error('disk full'); }; assert.throws(() => broken.queue.enqueue(broken.release.digest, ['frostnet']), /disk full/); assert.equal(broken.writes(), 0);
});
