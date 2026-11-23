/** Device-local integration capabilities. A theme never grants device access. */
export const AEON_X = 'https://x.com/SpaceTimeViking';
export const AEON_TOOLS = Object.freeze({
  models: { label: 'Aether model library', path: '/model-share', description: 'Browse the models available through this Orb.' },
  devices: { label: 'AEON device console', path: '/agent', description: 'Manage the machines connected to this Orb.' },
  view: { label: 'Open live view', path: '/', description: 'Open the Orb’s authorized hardware console.' },
});

export function aeonCapabilities(hardware, value) {
  if (hardware?.platform !== 'linux' || hardware?.kind !== 'pi' || value?.schema !== 1 || value?.image !== 'aeon-magick-orb'
    || typeof value.version !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(value.version)
    || ![443, 8443].includes(value.port) || !Array.isArray(value.tools)) return null;
  const tools = [...new Set(value.tools)].filter(tool => Object.hasOwn(AEON_TOOLS, tool));
  if (!tools.length) return null;
  return { schema: 1, image: value.image, version: value.version, port: value.port, tools };
}

export function deviceAeonTools(device) {
  return device?.connected === true ? aeonCapabilities(device.status?.hardware, device.status?.aeon) : null;
}
