/**
 * Desktop/companion RPC compatibility is independent from the app release.
 * Bump this only when the status and command contract becomes incompatible.
 */
export const COMPANION_PROTOCOL_VERSION = 1;

const LEGACY_COMPATIBLE_VERSION = /^0\.(?:2|3|4)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function isCompanionCompatible(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
  if (status.protocolVersion !== undefined) return status.protocolVersion === COMPANION_PROTOCOL_VERSION;
  // Companions released before the protocol field used this same bounded RPC contract.
  return LEGACY_COMPATIBLE_VERSION.test(String(status.version || ''));
}

export function isCompanionCurrent(status, expectedVersion) {
  return status?.protocolVersion === COMPANION_PROTOCOL_VERSION
    && typeof expectedVersion === 'string'
    && expectedVersion.length > 0
    && status.version === expectedVersion;
}
