// Cryptographic primitives for the local Hub. Mirrors the desktop client byte-for-byte:
//   - recipe publish: ed25519 over `frostbyte-recipe/2\n<digest>\n<pubkey>\n<timestamp>`
//     (src/shared/recipe-manifest.js recipeSigningBytes). The client (hub-client.publishRecipe)
//     sends a FLAT base64 signature; pubkey = manifest.publisher, timestamp = manifest.createdAt.
//   - update feed: ed25519 over `frostbyte-bundle/1\n` + canonicalJson(feedBody)
//     (BUNDLE_DOMAIN in src/shared/hub-protocol.js).
// Raw 32-byte keys are wrapped in the fixed SPKI/PKCS8 DER prefixes Node expects, exactly
// as src/main/publisher.js does. No third-party crypto dependency.
import crypto from 'node:crypto';
import { canonicalJson, recipeSigningBytes } from '../../src/shared/recipe-manifest.js';
import { BUNDLE_DOMAIN } from '../../src/shared/hub-protocol.js';

const SPKI_ED25519 = '302a300506032b6570032100';
const PKCS8_ED25519 = '302e020100300506032b657004220420';

export { BUNDLE_DOMAIN };

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function manifestDigest(manifest) {
  return sha256Hex(canonicalJson(manifest));
}

function publicKeyFromRaw(rawHex) {
  if (!/^[a-f0-9]{64}$/i.test(String(rawHex || ''))) throw new Error('publisher must be a 64-character hex ed25519 public key');
  return crypto.createPublicKey({ key: Buffer.from(SPKI_ED25519 + rawHex, 'hex'), format: 'der', type: 'spki' });
}

function privateKeyFromRaw(rawHex) {
  if (!/^[a-f0-9]{64}$/i.test(String(rawHex || ''))) throw new Error('private key must be 64 hex characters');
  return crypto.createPrivateKey({ key: Buffer.from(PKCS8_ED25519 + rawHex, 'hex'), format: 'der', type: 'pkcs8' });
}

// Verify a recipe publish. The client sends {manifest, digest, terms, signature} where
// signature is a flat base64 ed25519 signature over recipeSigningBytes({digest, pubkey,
// timestamp}), pubkey = manifest.publisher, timestamp = manifest.createdAt. The digest is
// ALWAYS recomputed from the manifest; a client-supplied digest is never trusted.
export function verifyRecipePublish({ manifest, signature }) {
  try {
    const pubkey = manifest?.publisher;
    const timestamp = manifest?.createdAt;
    if (!/^[a-f0-9]{64}$/.test(String(pubkey || ''))) return false;
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return false;
    const digest = manifestDigest(manifest);
    const sig = Buffer.from(String(signature || ''), 'base64');
    if (sig.length !== 64) return false;
    const bytes = recipeSigningBytes({ digest, pubkey, timestamp });
    return crypto.verify(null, bytes, publicKeyFromRaw(pubkey), sig);
  } catch {
    return false;
  }
}

export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const rawPrivate = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  return { publicKeyHex: rawPublic, privateKeyHex: rawPrivate };
}

// Produce the flat base64 signature the client sends, for seeding and tests.
export function signRecipePublish(manifest, privateKeyHex) {
  const digest = manifestDigest(manifest);
  const pubkey = manifest.publisher;
  const timestamp = manifest.createdAt;
  const bytes = recipeSigningBytes({ digest, pubkey, timestamp });
  return crypto.sign(null, bytes, privateKeyFromRaw(privateKeyHex)).toString('base64');
}

// Sign the update feed body: BUNDLE_DOMAIN + '\n' + canonicalJson(body).
export function signFeedBody(body, privateKeyHex) {
  const message = Buffer.from(`${BUNDLE_DOMAIN}\n${canonicalJson(body)}`, 'utf8');
  return crypto.sign(null, message, privateKeyFromRaw(privateKeyHex)).toString('base64');
}

export function verifyFeedBody(body, signatureB64, publicKeyHex) {
  try {
    const sig = Buffer.from(String(signatureB64 || ''), 'base64');
    if (sig.length !== 64) return false;
    const message = Buffer.from(`${BUNDLE_DOMAIN}\n${canonicalJson(body)}`, 'utf8');
    return crypto.verify(null, message, publicKeyFromRaw(publicKeyHex), sig);
  } catch {
    return false;
  }
}

export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}