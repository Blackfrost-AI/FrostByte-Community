import { createHash } from 'node:crypto';
import { exactReviewText, reviewLabel, reviewSize } from './native-review.js';
import { parseIpfsSource } from '../shared/ipfs-source.js';
import { validatePortableComponent } from './portable-path.js';
import { originBlocksSharing, ORIGIN_SHARE_BLOCKED } from '../shared/aeon-origin-status.js';
import { integrityBlocksSharing, INTEGRITY_SHARE_BLOCKED } from './integrity-service.js';
const binding = row => createHash('sha256').update(JSON.stringify({ id: row.id, source: row.source, destination: row.destination, name: row.name, files: row.files?.map(f => [f.path, f.cid, f.size]) })).digest('hex');
const permission = (kind, target, destination) => ({ kind,
  scope: [target?.approval.digest || 'local', ...(destination ? [destination] : [])],
  label: destination ? 'Never show again for IPFS downloads to this device folder' : 'Never show again for IPFS lookups on this device',
});

export function registerIpfsHandlers({ handle, local, devices, requestRemote, store, pathCapabilities, confirm, currentState, integrity = null }) {
  const previews = new Map();
  const remote = async deviceId => {
    const result = await devices.refresh(deviceId, { force: true });
    if (!result.connected || !result.status?.capabilities?.ipfs) throw new Error('Reconnect this device and install a companion with IPFS support.');
    return { approval: devices.approvalSnapshot(deviceId), profile: devices.profile(deviceId), status: result.status, name: devices.record(deviceId).name || devices.record(deviceId).host };
  };
  const check = target => { if (target && !devices.isApprovalCurrent(target.approval)) throw new Error('The saved device changed during review. Review this action again.'); };
  handle('ipfs:inspect', async ({ source, deviceId } = {}) => {
    const parsed = parseIpfsSource(source);
    const target = deviceId ? await remote(deviceId) : null;
    if (!await confirm('Look up this IPFS source?', `Source: ${parsed.source}\nDevice: ${target?.name || 'This computer'}\n\nIPFS peers can see this content request and the downloading device’s network address. Downloaded blocks will not be shared automatically.`, 'Preview files', {
      summary: `${reviewLabel(target?.name || 'This computer')}\n\nFind the files on the IPFS network. Peers can see this request and your device’s IP address. Sharing starts off.`,
      remember: permission('ipfs-discovery', target),
    })) return { cancelled: true };
    check(target);
    const preview = target ? await requestRemote(target.profile, { action: 'ipfs:inspect', source: parsed.source }) : await local.inspect(parsed.source);
    check(target);
    if (preview.source !== parsed.source) throw new Error('The IPFS preview returned a different source.');
    for (const [id, value] of previews) if (value.expires < Date.now()) previews.delete(id);
    while (previews.size >= 8) previews.delete(previews.keys().next().value);
    previews.set(preview.id, { ...preview, deviceId: deviceId || '', target, expires: Date.now() + 10 * 60_000 });
    return preview;
  });
  handle('ipfs:add', async (options = {}) => {
    const preview = previews.get(options.previewId);
    if (!preview || preview.expires < Date.now() || preview.deviceId !== (options.deviceId || '')) throw new Error('Preview this IPFS source on the selected device again.');
    const selectedPaths = options.selectedPaths || preview.files.map(f => f.path);
    if (!Array.isArray(selectedPaths) || !selectedPaths.length || selectedPaths.length > preview.files.length || new Set(selectedPaths).size !== selectedPaths.length || selectedPaths.some(p => !preview.files.some(f => f.path === p))) throw new Error('Choose files from the reviewed IPFS source.');
    const name = options.name?.trim() || preview.name;
    validatePortableComponent(name, { platform: 'portable' });
    if (name.length > 120) throw new Error('Choose a shorter IPFS download name.');
    const destination = options.destination;
    let target;
    if (preview.deviceId) {
      check(preview.target); target = await remote(preview.deviceId);
      if (!target.status.storage?.some(folder => folder.path === destination && folder.available)) throw new Error('Choose an available folder on this device.');
    } else if (destination !== store.getSettings().downloadDir) pathCapabilities.verify(options.destinationCapability, destination, 'save');
    const size = preview.files.filter(f => selectedPaths.includes(f.path)).reduce((sum, f) => sum + f.size, 0);
    const selectionHash = createHash('sha256').update(JSON.stringify(selectedPaths)).digest('hex');
    if (!await confirm('Download these IPFS files?', `Source: ${preview.source}\nDevice: ${target?.name || 'This computer'}\nFolder: ${exactReviewText(destination)}\nCollection: ${exactReviewText(name)}\nSelected files: ${selectedPaths.length}\nBytes: ${size}\nSelection SHA-256: ${selectionHash}\n\nThe IPFS block cache needs additional disk space. Sharing starts off.`, 'Download selected', {
      summary: `${reviewLabel(name, 100)}\n${selectedPaths.length} files · ${reviewSize(size)}\n${reviewLabel(target?.name || 'This computer', 80)}: ${reviewLabel(destination, 180)}\n\nSharing starts off. The IPFS cache needs extra disk space.`,
      remember: permission('ipfs-download', target, destination),
    })) return { cancelled: true };
    check(target); check(preview.target);
    if (!preview.deviceId && destination !== store.getSettings().downloadDir) pathCapabilities.consume(options.destinationCapability, destination, 'save');
    const approved = { previewId: preview.id, selectedPaths, name, destination, kind: options.kind };
    const id = target ? await requestRemote(target.profile, { action: 'ipfs:add', ...approved }) : await local.add(approved);
    previews.delete(preview.id); if (target) await devices.refresh(preview.deviceId, { force: true });
    return { id, state: currentState() };
  });
  const mutation = async (options, share) => {
    const { id, deviceId, action, enabled } = options || {};
    if (!/^ipfs:[a-f0-9]{64}$/.test(id || '')) throw new Error('Invalid IPFS transfer.');
    if (share ? typeof enabled !== 'boolean' : !['pause', 'resume', 'cancel', 'clear', 'kind', 'remove', 'restore'].includes(action)) throw new Error('Invalid IPFS action.');
    const target = deviceId ? await remote(deviceId) : null;
    const row = target ? target.status.ipfs?.downloads?.find(d => d.id === id) : local.record(id);
    if (!row) throw new Error('The IPFS transfer is no longer available.');
    const before = binding(row);
    if (share && enabled && originBlocksSharing(row.origin)) throw new Error(ORIGIN_SHARE_BLOCKED);
    // Early refusal from a known integrity result, mirroring the cached origin
    // check above. The authoritative scan runs in changeSharing before publish.
    if (share && enabled && !target && integrity && integrityBlocksSharing(integrity.get(id))) throw new Error(INTEGRITY_SHARE_BLOCKED);
    if (action === 'remove' && !await confirm('Remove this IPFS transfer?', `Retain files at ${exactReviewText(row.destination)} and their resume records. Restore them from Hidden & retained entries. Sharing will stop.`, 'Keep files and remove')) return { cancelled: true };
    if (share && enabled || action === 'resume') {
      const accepted = await confirm(share ? 'Share this collection over IPFS?' : 'Resume this IPFS download?', `Source: ${row.source}\nCollection: ${exactReviewText(row.name)}\nDevice: ${target?.name || 'This computer'}\nFolder: ${exactReviewText(row.destination)}\nFiles: ${row.files.length}\nApproval SHA-256: ${before}\n\n${share ? 'These selected files will be copied into the IPFS publishing cache and made available to public peers until sharing is turned off. Confirm that redistribution is permitted.' : 'The device will reconnect to IPFS peers for this exact content.'}`, share ? 'Enable IPFS sharing' : 'Resume download', {
        summary: `${reviewLabel(row.name, 100)}\n${reviewLabel(target?.name || 'This computer', 80)}: ${reviewLabel(row.destination, 180)}\n\n${share ? 'Make these files available to public IPFS peers until you turn sharing off. Only share files you’re allowed to redistribute.' : 'Reconnect to IPFS peers and continue downloading to this folder.'}`,
        remember: share ? undefined : permission('ipfs-download', target, row.destination),
      });
      if (!accepted) return { cancelled: true };
      check(target);
      const current = target ? (await remote(deviceId)).status.ipfs?.downloads?.find(d => d.id === id) : local.record(id);
      if (!current || binding(current) !== before) throw new Error('The IPFS transfer changed during review. Review it again.');
    }
    check(target);
    if (target) await requestRemote(target.profile, { action: share ? 'ipfs:sharing' : 'ipfs:control', id, operation: action, enabled, kind: options.kind });
    else if (share) await local.sharing(id, enabled);
    else if (action === 'kind') { if (!['model', 'torrent'].includes(options.kind)) throw new Error('Choose a download category.'); row.kind = options.kind; local.persist(); }
    else await local.control(action, id);
    if (target) await devices.refresh(deviceId, { force: true });
    return { state: currentState() };
  };
  handle('ipfs:control', options => mutation(options, false));
  handle('ipfs:sharing', options => mutation(options, true));
  handle('ipfs:clear-cache', async () => { await local.clearCache(); return true; });
}
