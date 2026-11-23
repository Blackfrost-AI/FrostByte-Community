import fs from 'node:fs';
import { buildShareExport, shareCsv, readSavedLinks, linkEntries, exportKey } from '../shared/share-export.js';
import { atomicExport } from './atomic-export.js';
import { normalizeCatalogEntry } from './catalog.js';

export function registerShareExport({ handle, state, store, inventory, dialog, review, links, resolve }) {
  const entries = () => {
    const snapshot = state();
    snapshot.inventory = snapshot.inventory.map(row => ({ ...row, files: inventory.rows.find(item => item.id === row.id)?.files }));
    for (const row of snapshot.inventory) { const revisions = [...new Set((row.files || []).map(file => file.revision).filter(Boolean))]; row.revision = revisions.length === 1 ? revisions[0] : ''; }
    return linkEntries(snapshot);
  };
  const selected = keys => {
    if (!Array.isArray(keys) || keys.length > 20000 || keys.some(key => typeof key !== 'string')) throw new Error('Choose entries to export.');
    const selection = new Set(keys), rows = entries().filter(row => selection.has(exportKey(row)));
    if (rows.length !== selection.size) throw new Error('The selection changed. Refresh and choose the entries again.');
    return rows;
  };
  handle('links:preview', ({ keys }) => buildShareExport(selected(keys)));
  handle('links:export', async ({ keys, format = 'csv' }) => {
    if (!['csv', 'json', 'both'].includes(format)) throw new Error('Choose CSV or JSON.');
    const bundle = buildShareExport(selected(keys));
    if (!bundle.links.length) throw new Error('No saved torrent identities in this selection. Create links first.');
    const saved = [];
    for (const extension of format === 'both' ? ['csv', 'json'] : [format]) {
      const choice = await dialog.showSaveDialog({ title: extension === 'json' ? 'Save portable link manifest' : 'Save bulk magnet CSV', defaultPath: 'frostbyte-links.' + extension, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
      if (choice.canceled) return { cancelled: !saved.length, saved, rows: bundle.links.length, excluded: bundle.excluded.length };
      try { atomicExport(choice.filePath, extension === 'csv' ? shareCsv(bundle) : JSON.stringify(bundle, null, 2) + '\n'); }
      catch (error) { throw new Error(`Could not save ${extension.toUpperCase()}: ${error.message}${saved.length ? ' The earlier export was saved successfully.' : ''}`); }
      saved.push(choice.filePath);
    }
    return { saved, rows: bundle.links.length, excluded: bundle.excluded.length };
  });
  handle('links:import', async () => {
    const choice = await dialog.showOpenDialog({ title: 'Import portable saved links', properties: ['openFile'], filters: [{ name: 'FrostByte saved-links JSON', extensions: ['json'] }] });
    if (choice.canceled) return { cancelled: true };
    if (fs.statSync(choice.filePaths[0]).size > 16 * 1024 * 1024) throw new Error('This export is too large.');
    const bundle = readSavedLinks(JSON.parse(fs.readFileSync(choice.filePaths[0], 'utf8')));
    const approval = await review({ type: 'question', buttons: ['Cancel', 'Import · keep hidden', 'Import · restore hidden links'], defaultId: 0, cancelId: 0,
      message: `Import ${bundle.links.length} saved links?`, summary: 'No files are downloaded. Existing hidden files stay hidden.', detail: 'Only the third option restores matching hidden saved catalog links. Rich file metadata is retained separately from the legacy catalog.' });
    if (!approval.response) return { cancelled: true };
    const hashes = new Set(bundle.links.map(row => row.infohash_v1));
    const userCatalog = [...store.getUserCatalog().filter(row => !hashes.has(row.infohash)), ...bundle.links.map(row => normalizeCatalogEntry({ name: row.name || row.infohash_v1, infohash: row.infohash_v1, sizeBytes: row.size_bytes || 0, license: row.license, source: 'user' }))];
    if (userCatalog.length > 10000) throw new Error('The saved-link catalog is full.');
    store._commitStateFields({ userCatalog, portableLinks: [...(store.state.portableLinks || []).filter(row => !hashes.has(row.infohash_v1)), ...bundle.links],
      hiddenCatalog: approval.response === 2 ? (store.state.hiddenCatalog || []).filter(hash => !hashes.has(hash)) : store.state.hiddenCatalog || [] });
    return { state: state(), imported: bundle.links.length };
  });
  handle('links:create', async ({ keys }) => {
    const rows = selected(keys);
    if (!rows.length || rows.length > 20 || rows.some(row => row.device !== 'local')) throw new Error('Choose up to 20 local copies. Remote link creation uses the device’s reviewed Sharing control.');
    const requests = rows.map(row => ({ device: 'local', id: row.id }));
    const manifests = await Promise.all(requests.map(resolve));
    const approval = await review({ type: 'question', buttons: ['Cancel', 'Create links without sharing'], defaultId: 0, cancelId: 0,
      message: `Create ${rows.length} magnet link${rows.length === 1 ? '' : 's'}?`, summary: 'Read and hash the selected files locally. No bytes are uploaded and sharing stays unchanged.',
      detail: manifests.map(row => `${row.name}: ${row.path}\n${row.files.length} files`).join('\n\n') + '\n\nPause jobs from Hidden & retained entries. Resume rechecks the files from the beginning.' });
    if (approval.response !== 1) return { cancelled: true };
    const current = await Promise.all(requests.map(resolve));
    if (JSON.stringify(current) !== JSON.stringify(manifests)) throw new Error('The selected file set changed during review. Preview link creation again.');
    for (const request of requests) await links.start(request);
    return { state: state() };
  });
  handle('links:control', async ({ key, action }) => {
    if (action === 'pause') links.pause(key);
    else if (action === 'resume') { const job = links.jobs.find(job => job.key === key); if (!job) throw new Error('Link job not found.'); await links.start(job.request); }
    else if (action === 'clear') links.clear(); else throw new Error('Choose a link action.');
    return state();
  });
}
