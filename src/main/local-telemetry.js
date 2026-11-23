/** Read-only local measurements. No commands, credentials, or renderer-chosen paths. */
import os from 'node:os';
import fs from 'node:fs/promises';

export async function localTelemetry(downloadDir, { system = os, statfs = fs.statfs, now = Date.now } = {}) {
  let storage = null;
  if (typeof downloadDir === 'string' && downloadDir) {
    try {
      const disk = await statfs(downloadDir);
      storage = { path: downloadDir, totalBytes: disk.blocks * disk.bsize, freeBytes: disk.bavail * disk.bsize, available: true };
    } catch { storage = { path: downloadDir, available: false }; }
  }
  return { schema: 1, collectedAt: new Date(now()).toISOString(), hostname: system.hostname(), architecture: system.arch(),
    uptimeSeconds: system.uptime(), load: system.platform() === 'win32' ? [] : system.loadavg(),
    memory: { totalBytes: system.totalmem(), freeBytes: system.freemem() }, storage,
    docker: { available: false, containers: [] }, capabilities: { docker: false, gpu: false, power: false } };
}
