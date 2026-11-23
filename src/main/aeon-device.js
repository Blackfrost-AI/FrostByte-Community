import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import { AEON_TOOLS, aeonCapabilities, deviceAeonTools } from '../shared/aeon.js';

/** This marker is supplied by the combined image or its trusted installer,
 * never a hostname, CSS theme, remote web page or renderer preference. */
export async function readAeonCapabilities(hardware, { env = process.env, read = fs.readFile } = {}) {
  let raw = env.FROSTBYTE_AEON_IMAGE || '';
  try {
    if (!raw) {
      const file = '/etc/aeon/frostbyte-integration.json';
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || stat.uid !== 0 || stat.mode & 0o022) return null;
      raw = await read(file, 'utf8');
    }
    if (typeof raw !== 'string' || raw.length > 4096) return null;
    return aeonCapabilities(hardware, JSON.parse(raw));
  } catch { return null; }
}

export function aeonDeviceUrl(device, profile, tool) {
  const capabilities = deviceAeonTools(device);
  if (!capabilities?.tools.includes(tool) || !Object.hasOwn(AEON_TOOLS, tool)) throw new Error('This AEON feature is unavailable on the selected device.');
  const host = String(profile?.host || '').split('@').at(-1);
  if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(host)) throw new Error('This saved device needs a directly usable address to open its console.');
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  const url = new URL(`https://${authority}:${capabilities.port}${AEON_TOOLS[tool].path}`);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid AEON console address.');
  return url.href;
}
