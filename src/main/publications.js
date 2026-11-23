import { createHash } from 'node:crypto';
import { canonicalJson, validateRelease, FROSTNET_TERMS } from '../shared/release-manifest.js';
export const manifestDigest = manifest => createHash('sha256').update(canonicalJson(validateRelease(manifest))).digest('hex');
const statuses = new Set(['draft', 'needs connection', 'ineligible', 'queued', 'submitting', 'pending review', 'published', 'rejected', 'retryable error', 'withdrawal requested', 'withdrawn']);

export class PublicationQueue {
  constructor({ store, providers, beforeSubmit = async () => {}, now = Date.now }) {
    this.store = store; this.providers = providers; this.beforeSubmit = beforeSubmit; this.now = now; this.running = new Set();
  }
  get jobs() { return this.store.state.publicationJobs || []; }
  get releases() { return this.store.state.releaseManifests || []; }
  snapshot() { return { releases: this.releases, jobs: this.jobs }; }
  draft(raw, copy) {
    const manifest = validateRelease(raw);
    const duplicate = this.releases.find(row => canonicalJson({ ...row.manifest, verified_at: '' }) === canonicalJson({ ...manifest, verified_at: '' }));
    if (duplicate) {
      // Re-verifying an imported manifest may attach a local copy. Importing it
      // again must never replace an already verified, private copy binding.
      if (copy?.request) this.store._commitStateFields({ releaseCopies: [...(this.store.state.releaseCopies || []).filter(row => row.digest !== duplicate.digest), { ...copy, digest: duplicate.digest }] });
      return { digest: duplicate.digest, manifest: duplicate.manifest };
    }
    const digest = manifestDigest(manifest);
    if (!this.releases.some(row => row.digest === digest)) {
      if (this.releases.length >= 500) throw new Error('The release history is full. Export and archive it before creating more releases.');
      this.store._commitStateFields({ releaseManifests: [...this.releases, { digest, manifest, status: 'draft', createdAt: this.now() }],
        releaseCopies: [...(this.store.state.releaseCopies || []).filter(row => row.digest !== digest), { digest, ...copy }] });
    }
    return { digest, manifest };
  }
  update(id, patch) {
    if (patch.status && !statuses.has(patch.status)) throw new Error('Invalid publication status.');
    this.store._commitStateFields({ publicationJobs: this.jobs.map(row => row.id === id ? { ...row, ...patch, updatedAt: this.now() } : row) });
  }
  enqueue(digest, destinations, operation = 'publish') {
    const release = this.releases.find(row => row.digest === digest); if (!release) throw new Error('Preview a verified release first.');
    if (!Array.isArray(destinations) || !destinations.length || destinations.length > 3 || destinations.some(name => !this.providers[name])) throw new Error('Choose an available destination.');
    const jobs = [...this.jobs];
    for (const destination of new Set(destinations)) {
      const account = this.providers[destination].account();
      const id = createHash('sha256').update([digest, destination, account?.id || release.manifest.publisher, operation, FROSTNET_TERMS].join('\0')).digest('hex');
      if (jobs.some(row => row.id === id)) continue;
      if (jobs.length >= 2000) throw new Error('The publication outbox is full.');
      jobs.push({ id, digest, destination, account: account?.id || release.manifest.publisher, operation,
        status: account ? operation === 'withdraw' ? 'withdrawal requested' : 'queued' : 'needs connection', terms: FROSTNET_TERMS,
        attempts: 0, nextRetry: 0, createdAt: this.now(), updatedAt: this.now(), error: '', receipt: null });
    }
    this.store._commitStateFields({ publicationJobs: jobs });
    void this.drain(); return this.snapshot();
  }
  retry(id) { const row = this.jobs.find(row => row.id === id); if (!row || ['published', 'withdrawn', 'rejected'].includes(row.status)) throw new Error('This publication cannot be retried.'); this.update(id, { status: row.operation === 'withdraw' ? 'withdrawal requested' : 'queued', nextRetry: 0, error: '' }); void this.drain(); }
  async drain() {
    await Promise.all(Object.keys(this.providers).map(async destination => {
      if (this.running.has(destination)) return; this.running.add(destination);
      try {
        for (const job of [...this.jobs]) {
          if (job.destination !== destination || !['queued', 'submitting', 'retryable error', 'withdrawal requested', 'pending review', 'needs connection'].includes(job.status) || job.nextRetry > this.now()) continue;
          try { await this.dispatch(job.id); } catch { /* durable intent remains; no second send after an uncommitted result */ }
        }
      } finally { this.running.delete(destination); }
    }));
  }
  async dispatch(id) {
    let job = this.jobs.find(row => row.id === id), provider = this.providers[job.destination];
    const account = provider.account();
    if (!account || account.id !== job.account) { this.update(id, { status: 'needs connection', error: 'Reconnect the reviewed publishing account.' }); return; }
    if (job.terms !== FROSTNET_TERMS || account.terms !== FROSTNET_TERMS) { this.update(id, { status: 'ineligible', error: 'Publishing terms changed. Review this release and connection again.' }); return; }
    const release = this.releases.find(row => row.digest === job.digest);
    try {
      // Lookup first on every retry, including a crash after remote acceptance but before local persistence.
      let receipt = job.attempts ? await provider.lookup(job) : null;
      if (!receipt) {
        if (job.operation === 'publish') await this.beforeSubmit(job, release);
        this.update(id, { status: job.operation === 'withdraw' ? 'withdrawal requested' : 'submitting', attempts: job.attempts + 1, error: '' });
        job = this.jobs.find(row => row.id === id);
        receipt = await provider.submit(job, release.manifest);
      }
      if (!receipt || !['pending review', 'published', 'rejected', 'withdrawn'].includes(receipt.status) || receipt.digest !== job.digest) throw new Error('The destination returned an unrecognized receipt. Reconciliation is required.');
      this.update(id, { status: receipt.status, receipt: { id: String(receipt.id).slice(0, 200), digest: receipt.digest, status: receipt.status,
        url: provider.receiptUrl(receipt), withdrawal: receipt.withdrawal === true }, error: '', nextRetry: receipt.status === 'pending review' ? this.now() + 60_000 : 0 });
    } catch (error) {
      const status = error.status === 401 || error.status === 403 ? 'needs connection' : [400, 409, 422].includes(error.status) ? 'rejected' : 'retryable error';
      this.update(id, { status, error: String(error.message || 'Publication failed.').slice(0, 1000),
        nextRetry: this.now() + Math.min(3600_000, Math.max(30_000, error.retryAfter || 1000 * 2 ** Math.min(12, job.attempts + 1))) });
    }
  }
}

export function frostnetOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['frostnet.si', 'frostnet-si.web.app'].includes(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Choose https://frostnet.si or the official Firebase preview https://frostnet-si.web.app.');
  return url.origin;
}
export class FrostnetProvider {
  constructor({ connection, fetcher = fetch }) { this.connection = connection; this.fetcher = fetcher; }
  account() { const row = this.connection(false); return row ? { id: row.account, terms: row.terms } : null; }
  async request(route, { method = 'GET', body, token, origin } = {}) {
    const connection = token ? { token, origin } : this.connection(true);
    if (!connection?.token) throw Object.assign(new Error('Connect a Frostnet publishing token first.'), { status: 401 });
    const response = await this.fetcher(frostnetOrigin(connection.origin) + route, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: 'Bearer ' + connection.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error(`Frostnet returned ${response.status}. ${[401, 403].includes(response.status) ? 'Reconnect your publishing token.' : 'Review the release or retry after the service recovers.'}`), { status: response.status, retryAfter: Math.min(3600, Number(response.headers.get('retry-after')) || 0) * 1000 });
    const text = await response.text(); if (text.length > 1_000_000) throw new Error('Frostnet returned an oversized response.'); return JSON.parse(text);
  }
  lookup(job) { return this.request('/v1/submissions/' + job.id); }
  submit(job, manifest) { return this.request(job.operation === 'withdraw' ? '/v1/releases/' + job.digest + '/withdraw' : '/v1/submissions', { method: 'POST', body: { idempotency_key: job.id, manifest, digest: job.digest, terms: job.terms } }); }
  receiptUrl(receipt) { const origin = frostnetOrigin(this.connection(false).origin); return /^[a-f0-9]{64}$/.test(receipt.digest || '') ? origin + '/releases/' + receipt.digest : ''; }
}
