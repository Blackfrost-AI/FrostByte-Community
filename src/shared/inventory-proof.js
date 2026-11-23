/** Stable across live availability/rate changes; covers the complete owned file set. */
export function inventoryProofText(entry) {
  return JSON.stringify({ id: entry.id, source: entry.source, path: entry.path, destination: entry.destination,
    relative: entry.relative, directory: entry.directory, repoId: entry.repoId || '', infoHash: entry.infoHash || '',
    files: (entry.files || []).map(file => ({ path: file.path, size: file.size, revision: file.revision || '' })) });
}
