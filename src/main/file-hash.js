/** Streaming SHA-256 for model weights. Fixed chunk bound so a 40 GB GGUF
 * hashes with flat memory; cancellable via AbortSignal. */
import fs from 'node:fs';
import crypto from 'node:crypto';

export const HASH_CHUNK_BYTES = 1024 * 1024;

export function sha256File(filePath, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: HASH_CHUNK_BYTES, signal });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
