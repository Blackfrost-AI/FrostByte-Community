/**
 * Spark model-management adapter.  It deliberately uses the existing
 * restricted SSH companion channel: neither hostd nor its bearer token is
 * exposed on the local network.  The current companion supplies a safe
 * read-only telemetry fallback; model mutations remain unavailable until a
 * restricted hostd bridge is installed on the device.
 */
import { SPARK_BRIDGE_REVISION } from './spark-hostd.js';

const MAX_RECIPES = 32;

function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid Spark model recipe.');
  return value;
}

function telemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) throw new Error('The Spark returned an invalid device telemetry response.');
  return {
    schema: 1,
    collectedAt: typeof value.collectedAt === 'string' ? value.collectedAt : new Date(0).toISOString(),
    hostname: typeof value.hostname === 'string' ? value.hostname.slice(0, 255) : '',
    architecture: typeof value.architecture === 'string' ? value.architecture.slice(0, 80) : '',
    uptimeSeconds: Number.isFinite(value.uptimeSeconds) && value.uptimeSeconds >= 0 ? value.uptimeSeconds : null,
    load: Array.isArray(value.load) ? value.load.slice(0, 3).map(item => Number.isFinite(item) ? item : 0) : [],
    memory: value.memory && typeof value.memory === 'object' ? { totalBytes: Number(value.memory.totalBytes) || 0, freeBytes: Number(value.memory.freeBytes) || 0 } : { totalBytes: 0, freeBytes: 0 },
    storage: value.storage && typeof value.storage === 'object' ? { path: String(value.storage.path || '').slice(0, 4096), totalBytes: Number(value.storage.totalBytes) || 0, freeBytes: Number(value.storage.freeBytes) || 0, available: value.storage.available !== false } : null,
    docker: { available: value.docker?.available === true, containers: Array.isArray(value.docker?.containers) ? value.docker.containers.slice(0, 64).map(item => ({ name: String(item.Names || item.name || '').slice(0, 255), state: String(item.State || item.state || '').slice(0, 80), status: String(item.Status || item.status || '').slice(0, 255), image: String(item.Image || item.image || '').slice(0, 512) })) : [] },
    bridgeRevision: Number.isSafeInteger(value.bridgeRevision) && value.bridgeRevision > 0 ? value.bridgeRevision : null,
    // A helper paired by an older build cannot report live readings until the companion is updated.
    bridgeOutdated: !(Number.isSafeInteger(value.bridgeRevision) && value.bridgeRevision >= SPARK_BRIDGE_REVISION),
    cpu: { utilizationPercent: reading(value.cpu?.utilizationPercent, 0, 100) },
    gpu: { name: typeof value.gpu?.name === 'string' ? value.gpu.name.slice(0, 128) : '', temperatureC: reading(value.gpu?.temperatureC, -50, 200),
      utilizationPercent: reading(value.gpu?.utilizationPercent, 0, 100), powerWatts: reading(value.gpu?.powerWatts, 0, 5000) },
    network: { rxBytesPerSecond: reading(value.network?.rxBytesPerSecond, 0, 1e15), txBytesPerSecond: reading(value.network?.txBytesPerSecond, 0, 1e15) },
    endpoint: { state: ENDPOINT_STATES.has(value.endpoint?.state) ? value.endpoint.state : 'unknown',
      port: Number.isSafeInteger(value.endpoint?.port) && value.endpoint.port > 0 && value.endpoint.port < 65536 ? value.endpoint.port : null },
    capabilities: { docker: value.capabilities?.docker === true, gpu: value.capabilities?.gpu === true, power: false },
  };
}

const ENDPOINT_STATES = new Set(['ready', 'auth-required', 'not-ready', 'unreachable']);
// Older companions omit these readings; keep them null so the UI shows "not reported" rather than a false zero.
function reading(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export class SparkDeviceManager {
  constructor({ devices }) { this.devices = devices; }
  async request(deviceId, payload) {
    const approval = this.devices.approvalSnapshot(deviceId);
    const response = await this.devices.request(this.devices.profile(deviceId), payload);
    if (!this.devices.isApprovalCurrent(approval)) throw new Error('The saved connection changed while the Spark request was running.');
    return response;
  }
  async status(deviceId) { return telemetry(await this.request(deviceId, { action: 'device:telemetry' })); }
  async recipes(deviceId) {
    const result = await this.request(deviceId, { action: 'device:recipes' });
    if (!result || result.schema !== 1 || !Array.isArray(result.recipes)) throw new Error('The Spark returned invalid model recipes.');
    return result.recipes.slice(0, MAX_RECIPES).map(recipe => ({ id: id(recipe.id), title: String(recipe.title || recipe.id).slice(0, 160), kind: recipe.kind === 'tmux' ? 'tmux' : 'docker', state: String(recipe.state || 'unknown').slice(0, 40), available: recipe.available !== false }));
  }
  async control(deviceId, operation, recipeId, reviewDigest) {
    if (!['check', 'start', 'stop'].includes(operation)) throw new Error('Unsupported Spark model operation.');
    const safeRecipeId = id(recipeId);
    if (operation !== 'check' && !/^[a-f0-9]{64}$/.test(reviewDigest || '')) throw new Error('Review this exact model recipe before changing it.');
    const result = await this.request(deviceId, { action: 'device:control', operation, recipeId: safeRecipeId, ...(reviewDigest ? { reviewDigest } : {}) });
    if (!result || result.schema !== 1 || result.recipeId !== safeRecipeId || result.operation !== operation) throw new Error('The Spark returned an invalid model control result.');
    return { operation, recipeId: safeRecipeId, state: String(result.state || 'unknown').slice(0, 80), observedState: String(result.observedState || 'unknown').slice(0, 80),
      reviewDigest: /^[a-f0-9]{64}$/.test(result.reviewDigest || '') ? result.reviewDigest : '', message: String(result.message || '').slice(0, 1000) };
  }
}
