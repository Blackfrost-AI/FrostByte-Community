/** Versioned publisher storage. Secret material never belongs in public app state. */
const PUBLIC_KEYS = ['pubKey', 'username', 'createdAtMs'];
const LEGACY_KEYS = [...PUBLIC_KEYS, 'kdf', 'kdfSalt', 'nonce', 'encSecret'];
const PROTECTED_KEYS = [...PUBLIC_KEYS, 'schema', 'keyEnvelope', 'backupConfirmedAt'];

function base64(value, bytes, maximum = 65536) {
  if (typeof value !== 'string' || !value || value.length > maximum) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value && (!bytes || decoded.length === bytes);
}

export function normalizePublisherRecord(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved publisher identity is invalid.');
  const keys = value.schema === 2 ? PROTECTED_KEYS : LEGACY_KEYS;
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('Saved publisher identity has invalid fields.');
  }
  if (typeof value.pubKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.pubKey)
    || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 64
    || /[\x00-\x1f\x7f]/.test(value.username)
    || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) {
    throw new Error('Saved publisher identity has invalid metadata.');
  }
  if (value.schema === 2) {
    if (!base64(value.keyEnvelope) || !Number.isSafeInteger(value.backupConfirmedAt) || value.backupConfirmedAt < 0) {
      throw new Error('Saved publisher protection is invalid.');
    }
  } else if (value.kdf !== 'scrypt' || !base64(value.kdfSalt, 16)
    || !base64(value.nonce, 12) || !base64(value.encSecret, 48)) {
    throw new Error('Saved publisher encrypted key is invalid.');
  }
  return structuredClone(value);
}
