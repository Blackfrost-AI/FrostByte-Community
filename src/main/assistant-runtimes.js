/** Fixed-loopback runtime adapters. No arbitrary endpoints, redirects, or ambient credentials. */
import { createHash } from 'node:crypto';

export const RUNTIME_ENDPOINTS = Object.freeze({ ollama: 11434, lmstudio: 1234, llamacpp: 8080, vllm: 8000, sglang: 30000 });
export const RUNTIME_NAMES = Object.freeze(Object.keys(RUNTIME_ENDPOINTS));
/** FrostByte-owned llama-server: dynamic loopback port, never a fixed endpoint. */
export const MANAGED_PROVIDER = 'frostbyte-llama';
export const PROVIDER_NAMES = Object.freeze([...RUNTIME_NAMES, MANAGED_PROVIDER]);
const validName = value => typeof value === 'string' && value.length >= 1 && value.length <= 240 && !/[\x00-\x1f\x7f]/.test(value) && !value.includes('..');
export const modelId = (deviceId, provider, name) => `m_${createHash('sha256').update(JSON.stringify([deviceId, provider, name])).digest('hex').slice(0, 32)}`;

export function endpointUrl(provider, suffix) {
  if (!Object.hasOwn(RUNTIME_ENDPOINTS, provider)) throw new Error('Unsupported inference runtime.');
  if (typeof suffix !== 'string' || !/^\/[A-Za-z0-9/_-]{1,100}$/.test(suffix)) throw new Error('Invalid runtime route.');
  return `http://127.0.0.1:${RUNTIME_ENDPOINTS[provider]}${suffix}`;
}

export function publicRuntimeError() { return 'Runtime is unavailable.'; }
export function publicDeviceError() { return 'Device is offline.'; }
const model = (deviceId, provider, name, state = 'ready', extra = {}) => ({
  id: modelId(deviceId, provider, name), name, deviceId, provider, state,
  contextChars: 32000, capabilities: ['chat'], ...extra,
});
export const runtimeModel = model;

async function json(fetch, url, signal) {
  const response = await fetch(url, { redirect: 'error', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) return { authRequired: true };
    throw new Error('Runtime listing failed.');
  }
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid runtime response.');
  return data;
}

/** A provider must advertise the model; filesystem names alone are never runnable models. */
export async function runtimeModels(provider, { deviceId = 'local', fetch: transport = fetch, signal } = {}) {
  if (!Object.hasOwn(RUNTIME_ENDPOINTS, provider)) throw new Error('Unsupported inference runtime.');
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(deviceId)) throw new Error('Invalid device ID.');
  try {
    if (provider === 'ollama') {
      const [listed, running] = await Promise.all([
        json(transport, endpointUrl(provider, '/api/tags'), signal),
        json(transport, endpointUrl(provider, '/api/ps'), signal),
      ]);
      if (listed.authRequired || running.authRequired) return { provider, status: 'auth-required', models: [] };
      if (!Array.isArray(listed.models) || !Array.isArray(running.models)) throw new Error('Invalid runtime response.');
      const runningNames = new Set(running.models.map(item => item?.name).filter(validName));
      const names = [...new Set(listed.models.map(item => item?.name).filter(validName))].slice(0, 256);
      return { provider, status: 'ready', models: names.map(name => model(deviceId, provider, name, runningNames.has(name) ? 'ready' : 'available')) };
    }
    const listed = await json(transport, endpointUrl(provider, '/v1/models'), signal);
    if (listed.authRequired) return { provider, status: 'auth-required', models: [] };
    if (!Array.isArray(listed.data)) throw new Error('Invalid runtime response.');
    const names = new Set();
    for (const item of listed.data.slice(0, 256)) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !validName(item.id)) continue;
      if (Array.isArray(item.capabilities) && !item.capabilities.includes('chat')) continue;
      if (/embed|rerank|whisper|tts|moderation/i.test(item.id)) continue;
      names.add(item.id);
    }
    return { provider, status: 'ready', models: [...names].map(name => model(deviceId, provider, name)) };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { provider, status: 'offline', models: [], error: publicRuntimeError(error) };
  }
}

export async function aggregateRuntimeCatalog(devices, discover) {
  if (!Array.isArray(devices) || devices.length > 17) throw new Error('Invalid device list.');
  const rows = await Promise.all(devices.map(async device => {
    if (!device || typeof device.id !== 'string' || typeof device.name !== 'string' || device.name.length > 200) throw new Error('Invalid device.');
    try {
      const catalog = await discover(device.id);
      const models = Array.isArray(catalog?.models) ? catalog.models : [];
      return { id: device.id, name: device.name, status: models.length ? 'ready' : 'empty', models, runtimes: catalog?.runtimes || [] };
    } catch {
      return { id: device.id, name: device.name, status: 'offline', models: [], runtimes: [], error: publicDeviceError() };
    }
  }));
  return { devices: rows };
}
