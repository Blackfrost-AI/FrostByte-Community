import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebTorrent from 'webtorrent';
import SafeTorrentStore, { validateTorrentLayout } from './safe-torrent-store.js';
import parseTorrent from 'parse-torrent';
import { extractInfoHash, guardWebTorrentDhtQueries, guardWebTorrentPeerAddresses, sanitizeTorrentDiscovery, torrentFileId } from './torrent.js';

export function normalizeSource(source) {
  const original = String(source ?? '');
  if (original.length > 32768) throw new Error('This link is too long.');
  const value = original.trim().replace(/^magnet:/i, 'magnet:');
  if (extractInfoHash(value)) return value;
  // Local paths are capability-bound before this function reads them. Keep
  // their exact whitespace: trimming can silently select a different file.
  if (/\.torrent$/i.test(value) && !/[\0\r\n]/.test(original)) return original;
  throw new Error('Drop a .torrent file or a magnet link, or paste an infohash.');
}

export async function readTorrent(source) {
  const before = await fs.promises.lstat(source);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1 || before.size > 8 * 1024 ** 2) {
    throw new Error('Choose a regular .torrent metadata file smaller than 8 MB.');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0);
  let file;
  try {
    file = await fs.promises.open(source, flags);
    const opened = await file.stat();
    const linked = await fs.promises.lstat(source);
    const sameObject = !Number(opened.ino) || !Number(linked.ino) || (opened.dev === linked.dev && opened.ino === linked.ino);
    if (!opened.isFile() || opened.nlink > 1 || linked.isSymbolicLink() || !sameObject || opened.size > 8 * 1024 ** 2) {
      throw new Error('The selected .torrent file changed before it could be read.');
    }
    const data = await file.readFile();
    if (data.length > 8 * 1024 ** 2) throw new Error('Choose a .torrent metadata file smaller than 8 MB.');
    // A .torrent file is a bencoded dictionary, so its first byte must be `d`.
    // The suffix and the user's consent are the only other gates on this path;
    // rejecting anything else here means a renamed file never reaches a parser.
    if (data.length < 2 || data[0] !== 0x64 /* 'd' */) throw new Error('That file is not a .torrent file.');
    return data;
  } finally {
    await file?.close();
  }
}

/**
 * Describe a torrent from its metadata.
 *
 * A preview selects nothing, so the per-piece fan-out budget is deferred: it is
 * enforced when a transfer starts, against the files that transfer will fetch.
 * Without that split any legitimately packed shard directory (many small files
 * inside one piece) could not even be listed, let alone picked from.
 *
 * Policy: a *preview* never enforces the fan-out budget; every path that
 * actually transfers enforces it against the transfer's own scope
 * (`prepareOptions` in safe-torrent-store.js). Generation and share-binding
 * paths keep the whole-torrent check, since they describe what will be written
 * in full rather than what one peer will fetch.
 */
function describe(parsed, { selectedPaths = null, checkFanout = false } = {}) {
  validateTorrentLayout(parsed, { selectedPaths, checkFanout });
  // `offset` and `pieceLength` let the picker report what a selection will
  // actually cost on disk: torrent pieces are the transfer unit, so choosing
  // one file can fetch every file its pieces span.
  return { name: parsed.name || parsed.infoHash, infoHash: parsed.infoHash,
    length: parsed.length || 0, pieceLength: parsed.pieceLength || 0,
    files: (parsed.files ?? []).map(f => ({ path: torrentFileId(f.path), length: f.length, offset: f.offset ?? 0 })) };
}

/** Metadata only: no content pieces are selected, and the temporary client is always closed. */
export async function inspectTorrent(source, { signal, timeout = 25000, dht = true, announce = [], allowPeerAddresses = false } = {}) {
  const src = normalizeSource(source);
  signal?.throwIfAborted();
  if (!extractInfoHash(src) && /\.torrent$/i.test(src.trim())) {
    return describe(await parseTorrent(await sanitizeTorrentDiscovery(await readTorrent(src))));
  }
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'frostbyte-preview-'));
  // A preview only needs an outbound metadata connection. Keeping uTP enabled
  // opens a second native UDP listener on the temporary TCP port; utp-native
  // can still own that port briefly after WebTorrent's destroy callback runs,
  // so a following preview can fail with EADDRINUSE when the OS reuses it.
  const client = new WebTorrent({ dht, utp: false, natUpnp: false, natPmp: false, lsd: false, webSeeds: false, maxConns: 12 });
  guardWebTorrentPeerAddresses(client, { allowPeerAddresses });
  guardWebTorrentDhtQueries(client, { allowPeerAddresses });
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve(value);
      };
      const aborted = () => finish(new Error('Preview cancelled.'));
      const timer = setTimeout(() => finish(new Error('No file list received yet. You can download all files, or retry the preview when peers are available.')), timeout);
      client.on('error', error => finish(error));
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      sanitizeTorrentDiscovery(src, { allowPeerAddresses }).then(safeSource => {
        if (settled) return;
        const torrent = client.add(safeSource, { path: directory, store: SafeTorrentStore, storeOpts: { approvedRoot: directory }, deselect: true, announce });
        torrent.on('error', error => finish(error));
        torrent.once('metadata', () => {
          try { finish(null, describe(torrent)); }
          catch (error) { finish(error); torrent.destroy(); }
        });
      }).catch(error => finish(error));
    });
  } finally {
    // WebTorrent destroys itself after some early transport errors. Do not let
    // a second destroy replace the useful preview error with "already destroyed".
    if (!client.destroyed) await new Promise(resolve => client.destroy(resolve));
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}
