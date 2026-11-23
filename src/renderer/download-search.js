/** Search only the download data already available to the app. */
export function matchesDownloadQuery(row, query, deviceLabel = '') {
  const terms = String(query || '').normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const fields = [row.name, row.repoId, row.filePath, row.path, row.dest, row.destination, row.baseDir, row.root,
    deviceLabel, row.source === 'hf' || row.repoId ? 'HuggingFace HF' : 'BitTorrent torrent', ...(row.fileNames || []),
    ...(row.files || []).flatMap(file => typeof file === 'string' ? [file] : [file.name, file.path, file.filePath, file.relative])];
  const text = fields.filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
  return terms.every(term => text.includes(term));
}
