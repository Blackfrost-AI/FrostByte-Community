import fs from 'node:fs';
import path from 'node:path';
import { PublicationQueue, FrostnetProvider, frostnetOrigin } from './publications.js';
import { verifyShareFiles } from './torrent.js';
import { FROSTNET_TERMS, validateRelease } from '../shared/release-manifest.js';
import { sameEntryCopy } from '../shared/entry-identity.js';
import { atomicExport } from './atomic-export.js';

export class PublishingService {
  constructor({ store, protection, resolve, inventory, sessions, review, dialog, state, handle, sharedCid = () => '' }) {
    this.sharedCid = sharedCid; this.store = store; this.protection = protection; this.resolve = resolve; this.inventory = inventory; this.sessions = sessions; this.review = review; this.dialog = dialog; this.state = state;
    this.verification = null;
    this.provider = new FrostnetProvider({ connection: unlock => this.connection(unlock) });
    this.queue = new PublicationQueue({ store, providers: { frostnet: this.provider }, beforeSubmit: async (job, release) => {
      const copy = (store.state.releaseCopies || []).find(row => row.digest === job.digest);
      if (!copy?.request) throw new Error('Imported manifest has no verified local copy. Rebuild its release preview before publishing.');
      const manifest = await resolve(copy.request), checked = await verifyShareFiles(manifest.path, manifest.files, this.metainfo(release.manifest.torrent.infohash_v1));
      if (JSON.stringify(checked.files) !== JSON.stringify(release.manifest.files)) throw new Error('Local bytes changed. Create a new release.');
      if (JSON.stringify(checked.torrent) !== JSON.stringify(release.manifest.torrent)) throw new Error('Retained torrent metadata changed. Verify and review a new release before publishing.');
    } });
    handle('publishing:connect', request => this.connect(request));
    handle('publishing:disconnect', () => { store._commitStateFields({ frostnetConnection: undefined }); return state(); });
    handle('publishing:preview', request => this.preview(request));
    handle('publishing:cancel', () => { this.verification?.controller.abort(); return true; });
    handle('publishing:submit', async ({ digest, withdraw = false }) => {
      const release = this.queue.releases.find(row => row.digest === digest); if (!release) throw new Error('Preview this release first.');
      const account = this.provider.account();
      if (!account || account.id !== release.manifest.publisher) throw new Error('Connect the Frostnet account for this publisher namespace first.');
      const choice = await review({ type: 'warning', buttons: ['Cancel', withdraw ? 'Withdraw Frostnet listing' : 'Publish metadata to Frostnet'], defaultId: 0, cancelId: 0,
        message: withdraw ? `Withdraw ${release.manifest.name}?` : `Publish ${release.manifest.name} to Frostnet?`,
        summary: `${this.connection(false).origin}\nPublisher: ${account.id}\n${release.manifest.files.length} files · variant ${release.manifest.variant}\n\n${withdraw ? 'Retain a withdrawal tombstone. Peer copies are not deleted.' : 'Only metadata and links are uploaded. Model files stay on your devices. Listing visibility does not imply a live seed.'}`,
        detail: `Manifest SHA-256: ${digest}\n${release.manifest.cid ? `IPFS CID: ${release.manifest.cid}\n` : ''}Terms: ${FROSTNET_TERMS}\n\n${withdraw ? 'This is separate from local file deletion and stopping sharing.' : 'Confirm the files are public, not gated or confidential, and you have redistribution permission. Hugging Face credentials are never sent to Frostnet.'}` });
      if (choice.response !== 1) return { cancelled: true };
      this.queue.enqueue(digest, ['frostnet'], withdraw ? 'withdraw' : 'publish'); return { state: state() };
    });
    handle('publishing:retry', ({ id }) => { this.queue.retry(id); return state(); });
    handle('publishing:export', async ({ digest }) => {
      const release = this.queue.releases.find(row => row.digest === digest); if (!release) throw new Error('Release not found.');
      const choice = await dialog.showSaveDialog({ title: 'Export immutable release manifest', defaultPath: release.manifest.release + '.release.json', filters: [{ name: 'Release JSON', extensions: ['json'] }] });
      if (choice.canceled) return { cancelled: true }; atomicExport(choice.filePath, JSON.stringify(release.manifest, null, 2) + '\n'); return { saved: true };
    });
    handle('publishing:import', async () => {
      const choice = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Release manifest', extensions: ['json'] }] });
      if (choice.canceled) return { cancelled: true };
      if (fs.statSync(choice.filePaths[0]).size > 750000) throw new Error('Manifest is too large.');
      const manifest = validateRelease(JSON.parse(fs.readFileSync(choice.filePaths[0], 'utf8')));
      const result = this.queue.draft(manifest, { imported: true }); return { ...result, state: state() };
    });
    this.timer = setInterval(() => { void this.queue.drain(); }, 30_000); this.timer.unref?.();
  }
  snapshot() { return { ...this.queue.snapshot(), connection: this.connection(false), verification: this.verification ? { name: this.verification.name, completed: this.verification.completed || 0, total: this.verification.total || 0 } : null }; }
  connection(unlock) {
    const row = this.store.state.frostnetConnection; if (!row) return null;
    const publicRow = { origin: row.origin, account: row.account, terms: row.terms, connectedAt: row.connectedAt };
    if (!unlock) return publicRow;
    if (!this.protection.isEncryptionAvailable() || this.protection.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Unlock the operating system key store to publish.');
    try { return { ...publicRow, token: this.protection.decryptString(Buffer.from(row.envelope, 'base64')) }; }
    catch { throw new Error('This computer cannot unlock the Frostnet token. Reconnect it.'); }
  }
  async connect({ origin, token }) {
    origin = frostnetOrigin(origin);
    if (typeof token !== 'string' || !/^fn_[a-zA-Z0-9_-]{32,180}$/.test(token)) throw new Error('Enter a Frostnet-scoped publishing token, not a Hugging Face token.');
    if (!this.protection.isEncryptionAvailable() || this.protection.getSelectedStorageBackend?.() === 'basic_text') throw new Error('The OS credential store must be unlocked before connecting.');
    const choice = await this.review({ type: 'question', buttons: ['Cancel', 'Connect Frostnet'], defaultId: 0, cancelId: 0, message: 'Connect this Frostnet publishing token?', summary: `${origin}\n\nValidate this token with Frostnet and protect it in the operating system credential store.`, detail: 'This connection permits explicit publication and withdrawal only. It does not enable automatic publication or reuse your Hugging Face credential.' });
    if (choice.response !== 1) return { cancelled: true };
    const account = await this.provider.request('/v1/account', { token, origin });
    if (!account || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(account.namespace || '') || account.terms !== FROSTNET_TERMS) throw new Error('Frostnet returned an unsupported account or changed terms.');
    this.store._commitStateFields({ frostnetConnection: { origin, account: account.namespace, terms: account.terms, envelope: this.protection.encryptString(token).toString('base64'), connectedAt: Date.now() } });
    return { state: this.state() };
  }
  metainfo(hash) {
    if (!/^[a-f0-9]{40}$/.test(hash || '')) throw new Error('Create a magnet link for this copy before preparing its release.');
    const saved = this.sessions().find(row => row.infohash === hash)?.torrentFile;
    if (saved) return Buffer.from(saved, 'base64');
    const target = path.join(this.store.appDir, 'share-metainfo', hash + '.torrent');
    if (!fs.existsSync(target)) throw new Error('Retained torrent metadata is unavailable. Use Create missing links to rebuild this copy’s metadata.');
    if (fs.statSync(target).size > 4 * 1024 * 1024) throw new Error('Retained metainfo exceeds the limit.');
    return fs.readFileSync(target);
  }
  async preview(request) {
    if (this.verification) throw new Error('A release is already being verified.');
    const copyRequest = { device: 'local', id: request.id };
    const local = await this.resolve(copyRequest), owned = this.inventory.rows.find(row => row.id === request.id);
    const link = (this.store.state.savedShareLinks || []).find(row => sameEntryCopy(row, { path: local.path, device: 'local' }));
    const metadata = this.metainfo(link?.infohash || owned?.infoHash);
    const revisions = new Set((owned?.files || []).map(file => file.revision));
    const upstream = owned?.repoId ? revisions.size === 1 && [...revisions][0] ? { repo: owned.repoId, revision: [...revisions][0] } : (() => { throw new Error('This copy has mixed or missing upstream revisions. Publish one pinned revision at a time.'); })() : null;
    const controller = new AbortController(); this.verification = { name: local.name, controller };
    try {
      const verified = await verifyShareFiles(local.path, local.files, metadata, { signal: controller.signal, onProgress: (completed, total) => Object.assign(this.verification, { completed, total }) });
      // Recorded only while these exact files are being shared over IPFS from
      // this computer; a release never enables or implies IPFS sharing.
      const cid = this.sharedCid(verified.files);
      const manifest = validateRelease({ schema: 'frostbyte.release', version: 1, publisher: request.publisher, release: request.release, variant: request.variant,
        name: request.name || local.name, description: request.description || '', origin: upstream ? 'derived' : 'original', upstream, license: request.license,
        ...verified, ...(cid ? { cid } : {}), verified_at: new Date().toISOString(), redistribution_confirmed: request.redistribution_confirmed === true });
      const result = this.queue.draft(manifest, { request: copyRequest, path: local.path, verifiedAt: Date.now() });
      return { ...result, state: this.state() };
    } finally { this.verification = null; }
  }
  stop() { clearInterval(this.timer); this.verification?.controller.abort(); }
}
