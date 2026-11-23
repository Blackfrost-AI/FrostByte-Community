const bytes = value => Number.isFinite(value) && value > 0 ? value : 0;
function destination(row) {
  const explicit = row.baseDir || row.destination;
  if (explicit) return explicit;
  const file = String(row.dest || '').replaceAll('\\', '/');
  const suffix = `/${row.repoId}/${row.filePath}`;
  return file.endsWith(suffix) ? file.slice(0, -suffix.length) : file;
}

/** One model/revision/destination per device; shard sizes determine progress. */
export function groupHfTransfers(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.status === 'cancelled') continue;
    const root = destination(row);
    const normalizedRoot = String(root).replaceAll('\\', '/').replace(/\/$/, '');
    const id = JSON.stringify([row.device, row.deviceId || row.sparkHost || '', row.repoId, row.revision || '', normalizedRoot]);
    if (!groups.has(id)) groups.set(id, { id, repoId: row.repoId, revision: row.revision, device: row.device, deviceId: row.deviceId, deviceName: row.deviceName, sparkHost: row.sparkHost, root, files: [] });
    groups.get(id).files.push(row);
  }
  return [...groups.values()].map(group => {
    const files = group.files;
    const count = status => files.filter(file => file.status === status).length;
    const counts = Object.fromEntries(['done', 'active', 'queued', 'paused', 'error'].map(status => [status, count(status)]));
    const complete = counts.done === files.length;
    const status = complete ? 'done' : ['active', 'queued', 'error', 'paused'].find(status => counts[status]) || 'queued';
    const total = files.reduce((sum, file) => sum + (bytes(file.total) || (file.status === 'done' ? bytes(file.downloaded) : 0)), 0);
    const downloaded = files.reduce((sum, file) => sum + Math.min(bytes(file.downloaded), bytes(file.total) || bytes(file.downloaded)), 0);
    const sizeKnown = files.every(file => bytes(file.total) > 0 || file.status === 'done');
    const offline = files.some(file => file.offline);
    const speedBps = offline ? 0 : files.reduce((sum, file) => sum + (file.status === 'active' ? bytes(file.speedBps) : 0), 0);
    const progress = complete ? 1 : total ? Math.min(sizeKnown ? 1 : .99, downloaded / total) : 0;
    const etaMs = sizeKnown && speedBps && !counts.paused && !counts.error ? Math.max(0, total - downloaded) / speedBps * 1000 : 0;
    const hybrid = files.some(file => file.sourceMode === 'hybrid');
    return { ...group, counts, status, complete, total, downloaded, sizeKnown, offline, speedBps, progress, etaMs, hybrid,
      hfBytes: files.reduce((sum, file) => sum + bytes(file.hfBytes), 0), peerBytes: files.reduce((sum, file) => sum + bytes(file.peerBytes), 0),
      phase: counts.active && files.filter(file => file.status === 'active').every(file => file.phase === 'verifying') ? 'verifying' : '',
      sourceNotes: [...new Set(files.map(file => file.sourceNote).filter(Boolean))],
      dest: group.root ? `${String(group.root).replace(/[\\/]$/, '')}/${group.repoId}` : '',
    };
  }).sort((a, b) => Number(a.complete) - Number(b.complete));
}
