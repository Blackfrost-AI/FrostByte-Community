/**
 * Client-side Hub cryptography — verifies the update-feed signature the local Hub
 * produces. Mirrors hub/src/crypto.js byte-for-byte:
 *   ed25519 over `BUNDLE_DOMAIN\n` + canonicalJson(feedBody), flat base64 signature,
 *   raw 32-byte public key wrapped in the fixed SPKI DER prefix Node expects.
 *
 * The feed envelope is { ...feedBody, signature, feedPubKey }. Verification strips
 * the two signature fields and checks the signature over the remaining body, so a
 * compromised or hostile Hub cannot forge version/digest/severity nudges (A2).
 * No third-party crypto dependency.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { canonicalJson, canonicalDigest } from '../shared/recipe-manifest.js';
import { BUNDLE_DOMAIN } from '../shared/hub-protocol.js';

const SPKI_ED25519 = '302a300506032b6570032100';

export { BUNDLE_DOMAIN };

/** SHA-256 of the canonical JSON of a value (content addressing). */
export function manifestDigest(value) {
  return canonicalDigest(value);
}

function publicKeyFromRaw(rawHex) {
  if (!/^[a-f0-9]{64}$/i.test(String(rawHex || ''))) throw new Error('feed public key must be 64 hex characters');
  return createPublicKey({ key: Buffer.from(SPKI_ED25519 + rawHex, 'hex'), format: 'der', type: 'spki' });
}

/**
 * Verify a signed update-feed envelope. Returns true only when the ed25519
 * signature over BUNDLE_DOMAIN + canonicalJson(body) is valid for feedPubKey.
 * The body is the envelope minus { signature, feedPubKey }.
 */
export function verifyUpdateFeed(envelope) {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
    const { signature, feedPubKey, ...body } = envelope;
    if (typeof signature !== 'string' || typeof feedPubKey !== 'string') return false;
    const sig = Buffer.from(signature, 'base64');
    if (sig.length !== 64) return false;
    const message = Buffer.from(`${BUNDLE_DOMAIN}\n${canonicalJson(body)}`, 'utf8');
    return cryptoVerify(null, message, publicKeyFromRaw(feedPubKey), sig);
  } catch {
    return false;
  }
}