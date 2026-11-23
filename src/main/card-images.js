// Guarded fetch for model-card images. The renderer never loads remote URLs directly (CSP img-src stays local);
// it asks the main process, which fetches over HTTPS only, pins DNS to public addresses on every hop, caps size
// and redirects, and accepts only raster/SVG image types. SVG is returned for use in <img>, where scripts never run.
import dns from 'node:dns/promises';
import https from 'node:https';
import { isPublicCatalogAddress } from './catalog-import.js';
export { isHfImageHost } from '../shared/markdown.js';

export const MAX_CARD_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 20_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']);

export function validateCardImageUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw new Error('Invalid image URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.href.length > 2048) {
    throw new Error('Model card images must use a plain HTTPS URL.');
  }
  if (url.port && url.port !== '443') throw new Error('Model card images must use the standard HTTPS port.');
  return url;
}

async function pinnedAddress(hostname, resolve) {
  let records;
  try { records = await resolve(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('Could not resolve the image host.'); }
  if (!Array.isArray(records)) records = [records];
  if (!records.length || records.some(record => !isPublicCatalogAddress(record?.address))) {
    throw new Error('Model card images cannot load from this network address.');
  }
  return records.map(({ address, family }) => ({ address, family: Number(family) }));
}

function requestOnce(url, { resolve, deadline, request = https.request }) {
  return pinnedAddress(url.hostname, resolve).then(addresses => new Promise((done, fail) => {
    const remaining = Math.max(1, deadline - Date.now());
    const req = request(url, {
      method: 'GET',
      headers: { Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'FrostByte-ModelCard/1' },
      autoSelectFamily: false,
      lookup(_hostname, options, callback) {
        const compatible = options?.family ? addresses.filter(record => record.family === options.family) : addresses;
        const selected = compatible[0] || addresses[0];
        if (options?.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
    }, done);
    const timer = setTimeout(() => req.destroy(new Error('Image request timed out.')), remaining);
    timer.unref?.();
    req.on('response', () => clearTimeout(timer));
    req.on('error', error => { clearTimeout(timer); fail(error); });
    req.end();
  }));
}

function readBody(response, limit, deadline) {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { response.destroy(); reject(new Error('Image is too large to show.')); return; }
    const chunks = [];
    let total = 0;
    const timer = setTimeout(() => response.destroy(new Error('Image download timed out.')), Math.max(1, deadline - Date.now()));
    timer.unref?.();
    response.on('data', chunk => {
      total += chunk.length;
      if (total > limit) { response.destroy(new Error('Image is too large to show.')); return; }
      chunks.push(chunk);
    });
    response.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    response.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

/**
 * @returns {Promise<{mime: string, data: Buffer, bytes: number, host: string}>} image bytes
 */
export async function fetchCardImage(value, { resolve = dns.lookup, request, timeoutMs = TIMEOUT_MS, maxBytes = MAX_CARD_IMAGE_BYTES } = {}) {
  let url = validateCardImageUrl(value);
  const deadline = Date.now() + timeoutMs;
  for (let redirects = 0; ; redirects++) {
    const response = await requestOnce(url, { resolve, deadline, request });
    const status = response.statusCode;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects >= MAX_REDIRECTS) throw new Error('Image redirected too many times.');
      url = validateCardImageUrl(new URL(location, url).href);
      continue;
    }
    if (status < 200 || status >= 300) { response.destroy(); throw new Error(`Image request failed (HTTP ${status}).`); }
    const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(mime)) { response.destroy(); throw new Error('That link is not a supported image.'); }
    const body = await readBody(response, maxBytes, deadline);
    return { mime, data: body, bytes: body.length, host: url.hostname };
  }
}
