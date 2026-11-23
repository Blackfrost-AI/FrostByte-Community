import { entryDevice, entryPath } from './entry-identity.js';
export const CSV_COLUMNS = ['schema_version', 'name', 'magnet_uri', 'infohash_v1', 'size_bytes', 'file_count', 'upstream_repo', 'upstream_revision', 'format', 'quantization', 'license', 'sharing_state', 'manifest_digest', 'frostnet_url', 'exported_at'];
const clean = value => typeof value === 'string' ? value.replace(/\0/g, '').slice(0, 4000) : '';
export function linkHash(value) {
  const text = String(value || '');
  if (/^[a-f0-9]{40}$/i.test(text)) return text.toLowerCase();
  const match = /^magnet:\?/i.test(text) && text.match(/(?:\?|&)xt=urn(?::|%3A)btih(?::|%3A)([a-f0-9]{40}|[a-z2-7]{32})(?:&|$)/i);
  if (!match) return '';
  if (match[1].length === 40) return match[1].toLowerCase();
  const bits = [...match[1].toUpperCase()].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  return bits.match(/.{8}/g).map(byte => parseInt(byte, 2).toString(16).padStart(2, '0')).join('');
}
export function portableMagnet(hash, name = '') { return `magnet:?xt=urn:btih:${hash}${name ? '&dn=' + encodeURIComponent(name) : ''}`; }
export const exportKey = row => `${row.device || 'local'}:${row.deviceId || ''}:${row.id}`;
const physicalKey = (device, pathname) => JSON.stringify([device, pathname]);
const copyKey = row => {
  const pathname = entryPath(row.path);
  return pathname ? physicalKey(entryDevice(row), pathname) : null;
};
function torrentIndex(torrents) {
  const byId = new Map(), byHash = new Map(), byPath = new Map();
  for (const [order, torrent] of torrents.entries()) {
    for (const [index, key] of [[byId, torrent.inventoryId], [byHash, torrent.infoHash], [byPath, torrent.dataPath]]) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ torrent, order });
    }
  }
  return row => {
    let live, liveOrder = Infinity, active = false;
    for (const bucket of [byId.get(row.id), byHash.get(row.infoHash || row.infohash), byPath.get(row.path)]) {
      for (const match of bucket || []) {
        if (match.torrent.magnetURI && match.order < liveOrder) { live = match.torrent; liveOrder = match.order; }
        if (!match.torrent.paused && (match.torrent.done || match.torrent.explicitShare)) active = true;
      }
    }
    return { live, active };
  };
}
function hiddenIndex(exclusions) {
  const exact = new Set(), directories = new Set();
  for (const row of exclusions || []) {
    const pathname = entryPath(row.path), device = entryDevice(row);
    if (pathname) exact.add(physicalKey(device, pathname));
    if (row.directory) directories.add(physicalKey(device, pathname));
  }
  return row => {
    const pathname = entryPath(row.path), device = entryDevice(row);
    if (pathname && exact.has(physicalKey(device, pathname))) return true;
    for (let at = pathname.lastIndexOf('/'); at >= 0; at = pathname.lastIndexOf('/', at - 1)) {
      if (directories.has(physicalKey(device, pathname.slice(0, at)))) return true;
      if (at === 0) break;
    }
    return false;
  };
}
export function linkEntries(state, { includeHidden = false } = {}) {
  const local = [...(state.inventory || []).map(row => ({ ...row, device: 'local' })), ...(state.modelLibrary?.items || [])];
  const localKeys = new Set(local.map(copyKey).filter(Boolean));
  for (const row of state.library || []) {
    const shared = { ...row, id: 'shared:' + row.infohash, device: 'local' }, key = copyKey(shared);
    if (key && localKeys.has(key)) continue;
    local.push(shared); if (key) localKeys.add(key);
  }
  const remote = (state.devices || []).flatMap(device => (device.status?.inventory || []).map(row => ({ ...row, device: 'spark', deviceId: device.id, offline: !device.connected })));
  const ipfs = [...(state.ipfs?.downloads || []).map(row => ({ ...row, device: 'local' })), ...(state.devices || []).flatMap(device => (device.status?.ipfs?.downloads || []).map(row => ({ ...row, device: 'spark', deviceId: device.id, offline: !device.connected })))].filter(row => row.status === 'done' && !row.removed).map(row => ({ ...row, source: 'ipfs', path: row.dest, size: row.total, fileCount: row.files?.length }));
  // These snapshots feed every selection toolbar and periodic refresh. Keep
  // exact-copy matching linear as libraries grow beyond the former item caps.
  const seen = new Set(), savedByCopy = new Map(), scannedKinds = new Map(), devicesById = new Map(), deviceTorrents = new Map();
  const copies = [...local, ...remote, ...ipfs].filter(row => {
    const key = copyKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
  for (const row of state.savedShareLinks || []) { const key = copyKey(row); if (key) savedByCopy.set(key, row); }
  for (const row of state.modelLibrary?.items || []) {
    const key = copyKey(row), kind = state.itemKinds?.[row.id];
    if (key && kind && !scannedKinds.has(key)) scannedKinds.set(key, kind);
  }
  for (const device of state.devices || []) if (!devicesById.has(device.id)) {
    devicesById.set(device.id, device); deviceTorrents.set(device.id, torrentIndex(device.status?.torrents || []));
  }
  const localTorrents = torrentIndex(state.torrents || []), isHidden = hiddenIndex(state.hiddenItems);
  const rows = copies.filter(row => includeHidden || !isHidden(row)).map(row => {
    const key = copyKey(row), device = row.device === 'spark' ? devicesById.get(row.deviceId) : null;
    const { live, active } = (device ? deviceTorrents.get(device.id) : localTorrents)(row);
    const saved = savedByCopy.get(key);
    const offline = row.offline || row.device === 'spark' && !device?.connected;
    const kind = scannedKinds.get(key) || state.itemKinds?.[row.id] || row.kind || (row.source === 'scan' ? 'model' : undefined);
    return { ...row, kind, infohash: live?.infoHash || saved?.infohash || row.infoHash || row.infohash,
      magnet: live?.magnetURI || saved?.magnet || row.magnet, sizeBytes: row.size ?? saved?.sizeBytes,
      fileCount: row.fileCount ?? saved?.fileCount,
      sharingState: offline ? 'unknown' : active ? 'active' : 'off' };
  });
  const portableByHash = new Map();
  for (const row of state.portableLinks || []) if (!portableByHash.has(row.infohash_v1)) portableByHash.set(row.infohash_v1, row);
  for (const row of state.catalog || []) {
    const portable = portableByHash.get(row.infohash);
    rows.push({ ...row, ...(portable ? { name: portable.name, sizeBytes: portable.size_bytes, upstream_repo: portable.upstream_repo, upstream_revision: portable.upstream_revision, file_manifests: portable.file_manifests, exportAlternatives: portable.alternatives, format: portable.format, quantization: portable.quantization, license: portable.license, manifest_digest: portable.manifest_digest, frostnet_url: portable.frostnet_url, fileCount: portable.file_count } : {}), id: 'catalog:' + row.id, device: 'catalog', sharingState: row.seeding ? 'active' : 'unknown' });
  }
  return rows;
}
function publicFiles(files) {
  return (Array.isArray(files) ? files : []).slice(0, 5000).filter(file => file && typeof file === 'object').map(file => ({ path: clean(file.relative || file.path).replaceAll('\\', '/'), size: file.size ?? file.length,
    sha256: /^[a-f0-9]{64}$/.test(file.sha256 || '') ? file.sha256 : '', revision: /^[a-f0-9]{40}$/.test(file.revision || '') ? file.revision : '' }))
    .filter(file => file.path && !/^(?:\/|[a-z]:|\\)/i.test(file.path) && !file.path.split('/').includes('..') && Number.isSafeInteger(file.size) && file.size >= 0);
}
function publicValue(name, value) {
  if (['size_bytes', 'file_count'].includes(name)) return Number.isSafeInteger(value) && value >= 0 ? value : '';
  if (name === 'upstream_repo') return /^[\w.-]+\/[\w.-]+$/.test(value || '') ? value : '';
  if (name === 'upstream_revision') return /^[a-f0-9]{40}$/.test(value || '') ? value : '';
  if (name === 'manifest_digest') return /^[a-f0-9]{64}$/.test(value || '') ? value : '';
  if (name === 'frostnet_url') return /^https:\/\/(?:frostnet\.si|frostnet-si\.web\.app)\/releases\/[a-f0-9]{64}$/.test(value || '') ? value : '';
  return clean(value);
}
export function buildShareExport(entries, { now = new Date().toISOString() } = {}) {
  const groups = new Map(), excluded = [];
  for (const row of entries) {
    const hash = linkHash(row.infohash || row.infoHash || row.magnet);
    if (!hash) { excluded.push({ name: clean(row.name), reason: row.source === 'ipfs' ? 'IPFS-only; no torrent identity' : 'No saved torrent identity; create a link first' }); continue; }
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(row);
  }
  const links = [...groups].map(([hash, copies]) => {
    const alternatives = {};
    const field = (name, getter) => { const values = [...new Set(copies.flatMap(row => [getter(row), ...(Array.isArray(row.exportAlternatives?.[name]) ? row.exportAlternatives[name].slice(0, 100) : [])]).map(value => publicValue(name, value)).filter(value => value !== ''))]; if (values.length > 1) alternatives[name] = values; return values.length === 1 ? values[0] : ''; };
    const name = field('name', row => clean(row.name));
    const states = copies.map(row => row.sharingState || 'unknown');
    return { schema_version: 1, name, magnet_uri: portableMagnet(hash, name), infohash_v1: hash,
      size_bytes: field('size_bytes', row => Number.isSafeInteger(row.sizeBytes ?? row.size) ? row.sizeBytes ?? row.size : ''),
      file_count: field('file_count', row => Number.isSafeInteger(row.fileCount) ? row.fileCount : ''),
      upstream_repo: field('upstream_repo', row => /^[\w.-]+\/[\w.-]+$/.test(row.repoId || row.upstream_repo || '') ? row.repoId || row.upstream_repo : ''),
      upstream_revision: field('upstream_revision', row => /^[a-f0-9]{40}$/.test(row.revision || row.upstream_revision || '') ? row.revision || row.upstream_revision : ''),
      format: field('format', row => clean(row.format)), quantization: field('quantization', row => clean(row.quantization || row.quant)), license: field('license', row => clean(row.license)),
      sharing_state: states.includes('active') ? 'active' : states.includes('unknown') ? 'unknown' : 'off',
      manifest_digest: field('manifest_digest', row => /^[a-f0-9]{64}$/.test(row.manifest_digest || '') ? row.manifest_digest : ''),
      frostnet_url: field('frostnet_url', row => /^https:\/\/(?:frostnet\.si|frostnet-si\.web\.app)\/releases\/[a-f0-9]{64}$/.test(row.frostnet_url || '') ? row.frostnet_url : ''),
      exported_at: now, alternatives, file_manifests: [...new Map(copies.flatMap(row => [row.files, ...(Array.isArray(row.file_manifests) ? row.file_manifests.slice(0, 100) : [])]).map(publicFiles).filter(files => files.length).map(files => [JSON.stringify(files), files])).values()] };
  });
  return { schema: 'frostbyte.saved-links', version: 1, exported_at: now, links, excluded };
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function shareCsv(bundle) { return '\uFEFF' + [CSV_COLUMNS, ...bundle.links.map(row => CSV_COLUMNS.map(key => row[key]))].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
export function readSavedLinks(value) {
  if (value?.schema !== 'frostbyte.saved-links' || value.version !== 1 || !Array.isArray(value.links) || value.links.length > 10000) throw new Error('Choose a FrostByte saved-links v1 JSON file. Release manifests have their own importer.');
  const entries = value.links.map(row => ({ id: 'portable:' + row.infohash_v1, name: row.name, infohash: linkHash(row.infohash_v1),
    sizeBytes: row.size_bytes, fileCount: row.file_count, upstream_repo: row.upstream_repo, upstream_revision: row.upstream_revision,
    format: row.format, quantization: row.quantization, license: row.license, manifest_digest: row.manifest_digest, frostnet_url: row.frostnet_url, sharingState: 'unknown', file_manifests: row.file_manifests, exportAlternatives: row.alternatives }));
  if (entries.some(row => !row.infohash)) throw new Error('One or more saved links have an invalid identity.');
  return buildShareExport(entries);
}
