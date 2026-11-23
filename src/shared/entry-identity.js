/** Physical-copy identity, deliberately separate from repository/content identity. */
export function entryPath(value) {
  const name = String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(name) ? name.toLowerCase() : name;
}
export const entryDevice = row => row.device === 'spark' ? row.deviceId || 'spark' : 'local';
export function sameEntryCopy(a, b) {
  return entryDevice(a) === entryDevice(b) && !!entryPath(a.path) && entryPath(a.path) === entryPath(b.path);
}
/** A discovered file is already represented by this exact copy or owned folder. */
export function entryContainsCopy(owner, row) {
  if ((owner.device === 'spark') !== (row.device === 'spark') || entryDevice(owner) !== entryDevice(row)) return false;
  const parent = entryPath(owner.path), child = entryPath(row.path);
  return Boolean(parent && child) && (parent === child || Boolean(owner.directory) && child.startsWith(parent + '/'));
}
export function entryIsHidden(row, exclusions = []) {
  return exclusions.some(hidden => entryDevice(hidden) === entryDevice(row)
    && (sameEntryCopy(hidden, row) || hidden.directory && entryPath(row.path).startsWith(entryPath(hidden.path) + '/')));
}
export function hfGroupInventory(group, entries) {
  return entries.find(row => row.device === group.device && (row.deviceId || '') === (group.deviceId || '')
    && row.source === 'hf' && row.repoId === group.repoId && entryPath(row.path) === entryPath(group.dest));
}
