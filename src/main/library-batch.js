import { createHash } from 'node:crypto';
import { exportKey } from '../shared/share-export.js';
import { reviewLabel } from './native-review.js';

const effects = {
  hide: ['Hide selected entries', 'Hide these listings. Files and sharing stay unchanged. Restore listings from Hidden & retained entries.'],
  remove: ['Remove selected · keep files', 'Stop sharing these copies and hide their listings. Files stay on disk; existing transfers are retained paused. Restore listings from Hidden & retained entries.'],
  stop: ['Stop sharing selected', 'Stop sharing these copies. Keep their files, listings, and paused transfer records.'],
};

// Main-owned identities only. Never authorize paths or device names supplied
// by the renderer, and never let a batch silently follow the selected device.
export function registerLibraryBatch({ handle, resolve, context, review, stopSharing, hide, state }) {
  let busy = false;
  const snapshot = request => {
    const row = resolve(request);
    const identity = createHash('sha256').update(JSON.stringify({
      id: row.id, device: row.device, deviceId: row.deviceId, path: row.path,
      source: row.source, name: row.name, directory: row.directory,
      files: row.files || row.fileNames, infoHash: row.infoHash || row.infohash,
      context: context(row),
    })).digest('hex');
    return { row, identity };
  };
  handle('items:batch', async ({ action, items } = {}) => {
    if (!Object.hasOwn(effects, action) || !Array.isArray(items) || !items.length || items.length > 20000
      || items.some(row => !row || !['local', 'spark'].includes(row.device) || typeof row.id !== 'string' || !row.id || row.id.length > 1024
        || row.device === 'spark' && (typeof row.deviceId !== 'string' || !row.deviceId || row.deviceId.length > 512)
        || row.device === 'local' && row.deviceId)) throw new Error('Choose exact library copies and a supported bulk action.');
    if (busy) throw new Error('Wait for the current library batch to finish.');
    busy = true;
    try {
      const requests = [...new Map(items.map(row => [exportKey(row), { device: row.device, deviceId: row.deviceId || '', id: row.id }])).values()];
      const selected = requests.map(request => ({ request, ...snapshot(request) }));
      const [label, effect] = effects[action];
      const choice = await review({ type: action === 'hide' ? 'question' : 'warning', buttons: ['Cancel', label], defaultId: 0, cancelId: 0,
        message: `${label} (${selected.length})?`, summary: effect,
        detail: effect + '\n\n' + selected.map(({ row }) => `${reviewLabel(row.name, 500)}\nDevice: ${reviewLabel(row.device === 'local' ? 'This computer' : row.deviceId, 512)}\n${JSON.stringify(row.path)}`).join('\n\n') });
      if (choice.response !== 1) return { cancelled: true, results: [], state: state() };
      const results = [];
      for (const selectedItem of selected) {
        const { request, row, identity } = selectedItem;
        try {
          if (snapshot(request).identity !== identity) throw new Error('This copy or saved device changed during review. Select it again.');
          if (action !== 'hide') await stopSharing(row);
          // Hide the reviewed copy, not a new object that replaced its ID.
          if (action !== 'stop') hide(row);
          results.push({ key: exportKey(row), name: row.name, ok: true });
        } catch (error) {
          results.push({ key: exportKey(row), name: row.name, ok: false, error: String(error.message || error) + (action === 'remove' ? ' Sharing may already be stopped; files were kept.' : '') });
        }
      }
      return { results, state: state() };
    } finally { busy = false; }
  });
}
