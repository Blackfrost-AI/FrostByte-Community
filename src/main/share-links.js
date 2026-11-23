import fs from 'node:fs';
import path from 'node:path';
import { createShareMetadata } from './torrent.js';
import { atomicExport } from './atomic-export.js';
import { sameEntryCopy } from '../shared/entry-identity.js';

export class ShareLinks {
  constructor({ store, resolve }) {
    this.store = store; this.resolve = resolve; this.running = new Map(); this.progress = new Map();
    if (this.jobs.some(job => job.status === 'hashing')) this.saveJobs(this.jobs.map(job => job.status === 'hashing' ? { ...job, status: 'paused' } : job));
  }
  get jobs() { return this.store.state.linkJobs || []; }
  snapshot() { return this.jobs.map(job => ({ ...job, ...this.progress.get(job.key) })); }
  saveJobs(jobs) { this.store._commitStateFields({ linkJobs: jobs }); }
  remember(row, result) {
    const link = { id: row.id, device: row.device || 'local', deviceId: row.deviceId || '', path: row.path,
      name: result.name, infohash: result.infohash || result.infoHash, magnet: result.magnet || result.magnetURI,
      sizeBytes: result.sizeBytes ?? result.length, fileCount: result.fileCount ?? result.files?.length, createdAt: Date.now() };
    if (!/^[a-f0-9]{40}$/.test(link.infohash || '')) return;
    const previous = this.store.state.savedShareLinks || [];
    const links = previous.filter(item => !sameEntryCopy(item, link));
    if (links.length >= 10000) throw new Error('The saved share-link history is full.');
    this.store._commitStateFields({ savedShareLinks: [...links, link] });
  }
  async start(request) {
    const key = JSON.stringify([request.device || 'local', request.deviceId || '', request.id]);
    if (this.running.has(key)) return key;
    const manifest = await this.resolve(request);
    const job = { key, request, name: manifest.name, status: 'hashing', startedAt: Date.now(), error: '' };
    const jobs = this.jobs.filter(row => row.key !== key);
    if (jobs.length >= 200) throw new Error('Clear completed link jobs before creating more links.');
    this.saveJobs([...jobs, job]);
    const controller = new AbortController(); this.running.set(key, controller);
    void (async () => {
      try {
        const result = await createShareMetadata(manifest.path, { files: manifest.files, signal: controller.signal,
          onProgress: (completed, total) => this.progress.set(key, { completed, total }) });
        const directory = path.join(this.store.appDir, 'share-metainfo'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicExport(path.join(directory, result.infohash + '.torrent'), result.metadata);
        this.remember({ ...request, path: manifest.path }, result);
        this.saveJobs(this.jobs.map(row => row.key === key ? { ...row, status: 'done', infohash: result.infohash } : row));
      } catch (error) {
        try { this.saveJobs(this.jobs.map(row => row.key === key ? { ...row, status: controller.signal.aborted ? 'paused' : 'error', error: error.message } : row)); }
        catch { this.progress.set(key, { error: 'Could not save link progress. Restart to recover the paused job.' }); }
      } finally { this.running.delete(key); if (!this.progress.get(key)?.error) this.progress.delete(key); }
    })();
    return key;
  }
  pause(key) { this.running.get(key)?.abort(); }
  clear() { this.saveJobs(this.jobs.filter(row => row.status !== 'done')); }
}
