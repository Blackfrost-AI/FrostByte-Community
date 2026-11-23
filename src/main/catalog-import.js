import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Address4, Address6 } from 'ip-address';

export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

const deprecated6to4Relay = new Address4('192.88.99.0/24');

export function isPublicCatalogAddress(value) {
  const address = String(value || '').split('%')[0];
  const family = net.isIP(address);
  try {
    if (family === 4) {
      const parsed = new Address4(address);
      return parsed.isGlobal() && !parsed.isInSubnet(deprecated6to4Relay);
    }
    if (family === 6) return new Address6(address).isGlobal();
  } catch { /* malformed DNS answers are never connection targets */ }
  return false;
}

export function validateCatalogUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); }
  catch { throw new Error('Enter a valid HTTPS catalog URL.'); }
  if (url.protocol !== 'https:') throw new Error('Catalog URLs must use HTTPS.');
  if (url.username || url.password) throw new Error('Catalog URLs cannot contain credentials.');
  if (!url.hostname || url.hostname.length > 253 || url.href.length > 4096) throw new Error('Catalog URL is too long.');
  return url;
}

/**
 * Persist one reviewed import across the catalog state and settings files.
 * The settings write follows the catalog commit so a failure can restore the
 * exact prior catalog snapshot. If that single rollback also fails, callers
 * must report success with a warning because the imported entries remain the
 * durable outcome.
 */
export function persistCatalogImport({ catalog, store, entries, catalogUrl }) {
  const previousCatalog = structuredClone(store.getUserCatalog());
  const previousHiddenCatalog = structuredClone(store.state.hiddenCatalog ?? []);
  const imported = catalog.addMany(entries);
  if (!imported.added.length && imported.skipped) throw new Error('The catalog contained no valid model entries.');
  try { store.setSettings({ catalogUrl }); }
  catch (settingsError) {
    try { store.setCatalogState(previousCatalog, previousHiddenCatalog); }
    catch (rollbackError) {
      return { imported, settingsSaved: false, rollbackError, settingsError };
    }
    throw settingsError;
  }
  return { imported, settingsSaved: true };
}

async function publicAddresses(hostname, resolve, timeoutMs) {
  let records;
  let timer;
  try {
    records = await Promise.race([
      resolve(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Catalog request timed out.')), Math.max(1, timeoutMs)); timer.unref?.(); }),
    ]);
  }
  catch { throw new Error('Could not resolve the catalog host.'); }
  finally { clearTimeout(timer); }
  if (!Array.isArray(records)) records = [records];
  if (!records.length || records.some(record => !isPublicCatalogAddress(record?.address))) {
    throw new Error('Catalog URLs cannot access this network address.');
  }
  return records.map(({ address, family }) => ({ address, family: Number(family) }));
}

function responseBytes(response, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const timer = setTimeout(() => response.destroy(new Error('Catalog response timed out.')), timeoutMs);
    timer.unref?.();
    response.on('data', chunk => {
      total += chunk.length;
      if (total > limit) {
        response.destroy(new Error(`Catalog response exceeds ${Math.floor(limit / 1024)} KiB.`));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    response.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function requestOnce(url, { resolve, deadline, maxBytes }) {
  const remaining = () => Math.max(1, deadline - Date.now());
  const addresses = await publicAddresses(url.hostname, resolve, remaining());
  return new Promise((resolveRequest, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const timer = setTimeout(() => request.destroy(new Error('Catalog request timed out.')), remaining());
    timer.unref?.();
    const request = transport.request(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'FrostByte-Catalog/1' },
      autoSelectFamily: false,
      lookup(_hostname, options, callback) {
        const compatible = options?.family ? addresses.filter(record => record.family === options.family) : addresses;
        const selected = compatible[0] || addresses[0];
        if (options?.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
    }, response => {
      clearTimeout(timer);
      resolveRequest({ response, bytes: () => responseBytes(response, maxBytes, remaining()) });
    });
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

/**
 * Fetch the exact public HTTPS JSON catalog selected by the caller while
 * pinning its validated DNS result. Redirects are rejected because a native
 * approval for one URL must not authorize a different network destination or
 * trust catalog identities returned by that destination.
 */
export async function fetchCatalogJson(value, {
  resolve = dns.lookup,
  timeoutMs = 20_000,
  maxBytes = MAX_CATALOG_BYTES,
} = {}) {
  const url = validateCatalogUrl(value);
  const deadline = Date.now() + timeoutMs;
  if (Date.now() >= deadline) throw new Error('Catalog request timed out.');
  const { response, bytes } = await requestOnce(url, { resolve, deadline, maxBytes });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    throw new Error('Catalog redirects are not allowed. Import the final HTTPS URL so it can be reviewed.');
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new Error(`Could not fetch catalog (HTTP ${response.statusCode}).`);
  }
  let data;
  try { data = JSON.parse((await bytes()).toString('utf8')); }
  catch (error) {
    if (/exceeds/.test(error.message)) throw error;
    throw new Error('Catalog response is not valid JSON.');
  }
  return { data, url: url.href };
}
