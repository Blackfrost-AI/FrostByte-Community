/**
 * Report what a torrent file selection actually costs on disk.
 *
 * BitTorrent transfers whole pieces, and one piece can span several files. When
 * files are packed many-to-a-piece, choosing one fetches all of them, so simply
 * summing the selected lengths badly understates the footprint. This walks the
 * selected files' piece ranges and totals every file segment those pieces
 * cover — which is what the chunk store will write.
 *
 * Measured behaviour this describes: internal shared-piece fan-out analysis (2026-10-31).
 */

/**
 * @param {{pieceLength?: number, files?: Array<{path: string, length: number, offset?: number}>}} preview
 * @param {Array<{path: string, length: number, offset?: number}>} selected
 * @param {(bytes: number) => string} formatBytes
 * @returns {string} summary line for the picker
 */
export function describeSelectionFootprint(preview, selected, formatBytes) {
  const all = preview?.files ?? [];
  const selectedBytes = selected.reduce((sum, file) => sum + file.length, 0);
  const base = `${selected.length} of ${all.length} files · ${formatBytes(selectedBytes)}`;
  const pieceLength = preview?.pieceLength;
  // Without a piece layout the honest answer is just the selected size.
  if (!pieceLength || pieceLength <= 0 || !all.length) return base;
  if (!all.every(file => Number.isFinite(file.offset))) return base;

  const span = file => {
    if (!file.length) return null;
    return {
      first: Math.floor(file.offset / pieceLength),
      last: Math.floor((file.offset + file.length - 1) / pieceLength),
    };
  };

  const fetched = new Set();
  for (const file of selected) {
    const range = span(file);
    if (!range) continue;
    for (let piece = range.first; piece <= range.last; piece += 1) fetched.add(piece);
  }
  if (!fetched.size) return base;

  const selectedPaths = new Set(selected.map(file => file.path));
  let footprint = 0;
  let extra = 0;
  for (const file of all) {
    const range = span(file);
    if (!range) continue;
    let covered = 0;
    for (let piece = range.first; piece <= range.last; piece += 1) {
      if (!fetched.has(piece)) continue;
      const start = Math.max(piece * pieceLength, file.offset);
      const end = Math.min((piece + 1) * pieceLength, file.offset + file.length);
      if (end > start) covered += end - start;
    }
    if (!covered) continue;
    footprint += covered;
    if (!selectedPaths.has(file.path)) extra += covered;
  }

  // Nothing comes along for free: say nothing and keep the line short.
  if (!extra) return base;
  return `${base} · uses ${formatBytes(footprint)} disk (shared pieces also fetch ${formatBytes(extra)} of other files)`;
}