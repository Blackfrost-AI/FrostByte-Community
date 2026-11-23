/** Publisher identity: 24-word recovery phrase to Ed25519.
 * Password encryption is wrapped by PublisherManager using OS-backed safeStorage.
 * Publication bytes follow AEON Orb publisher.rs: aeon-publish/1, without prehashing.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes, scryptSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { generateMnemonic, mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from '@scure/bip39';
import { CID } from 'multiformats/cid';
import { normalizePublisherRecord } from './publisher-record.js';
import { validateRecipe, canonicalDigest, recipeSigningBytes } from '../shared/recipe-manifest.js';
import { wordlist } from '@scure/bip39/wordlists/english';

const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const TEXT = 'utf8';

function requirePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new Error('Choose a password between 8 and 200 characters.');
  }
}

function requirePetname(name) {
  const username = typeof name === 'string' ? name.trim() : '';
  if (!username || username.length > 64 || /[\x00-\x1f\x7f]/.test(username)) {
    throw new Error('Choose a display name up to 64 characters.');
  }
  return username;
}

/** Exact UTF-8 publication message consumed by AEON's Ed25519 verifier. */
export function publicationDigest(cid, name, sha256, addedAtMs) {
  if (typeof cid !== 'string' || cid.length > 128) throw new Error('Invalid publication CID.');
  try { if (CID.parse(cid).toString() !== cid) throw new Error(); }
  catch { throw new Error('Invalid publication CID.'); }
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Invalid publication metadata.');
  if (!Number.isSafeInteger(addedAtMs) || addedAtMs < 0) throw new Error('Invalid publication timestamp.');
  return Buffer.from(`aeon-publish/1\n${cid}\n${name}\n${sha256}\n${addedAtMs}`, TEXT);
}

function keyPairFromSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('Publisher secret must be 32 bytes.');
  // Node PKCS8 for ed25519: prepend fixed header to raw 32-byte seed.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    secret,
  ]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // SPKI for ed25519 ends with the 32-byte raw public key.
  const pubRaw = spki.subarray(spki.length - 32);
  return { privateKey, publicKey, pubHex: Buffer.from(pubRaw).toString('hex'), secret };
}

function encryptSecret(secret, password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, SCRYPT_OPTS);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kdf: 'scrypt',
    kdfSalt: salt.toString('base64'),
    nonce: iv.toString('base64'),
    encSecret: Buffer.concat([ciphertext, tag]).toString('base64'),
  };
}

function decryptSecret(record, password) {
  requirePassword(password);
  record = normalizePublisherRecord(record);
  if (!record || record.schema) throw new Error('Invalid publisher encrypted account.');
  const salt = Buffer.from(record.kdfSalt, 'base64');
  const iv = Buffer.from(record.nonce, 'base64');
  const blob = Buffer.from(record.encSecret, 'base64');
  if (blob.length < 17) throw new Error('Corrupt publisher key material.');
  const ciphertext = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const key = scryptSync(password, salt, 32, SCRYPT_OPTS);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (secret.length !== 32) throw new Error('Corrupt publisher key material.');
  return secret;
}

export function createPublisherAccount({ petname, password }) {
  requirePassword(password);
  const username = requirePetname(petname);
  const mnemonic = generateMnemonic(wordlist, 256);
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Failed to generate a valid recovery phrase.');
  const entropy = Buffer.from(mnemonicToEntropy(mnemonic, wordlist));
  const { pubHex, secret } = keyPairFromSecret(entropy);
  const sealed = encryptSecret(secret, password);
  return {
    account: {
      pubKey: pubHex,
      username,
      createdAtMs: Date.now(),
      ...sealed,
    },
    mnemonic,
  };
}

export function importPublisherAccount({ mnemonic, petname, password }) {
  requirePassword(password);
  const username = requirePetname(petname);
  if (typeof mnemonic !== 'string' || mnemonic.length > 1024) throw new Error('Enter a valid 24-word recovery phrase.');
  const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (phrase.split(' ').length !== 24) throw new Error('The recovery phrase must contain 24 words.');
  if (!validateMnemonic(phrase, wordlist)) throw new Error('That recovery phrase is not valid.');
  const entropy = Buffer.from(mnemonicToEntropy(phrase, wordlist));
  const { pubHex, secret } = keyPairFromSecret(entropy);
  const sealed = encryptSecret(secret, password);
  return {
    account: {
      pubKey: pubHex,
      username,
      createdAtMs: Date.now(),
      ...sealed,
    },
    mnemonic: entropyToMnemonic(entropy, wordlist),
  };
}

export function unlockPublisherAccount(account, password) {
  requirePassword(password);
  if (!account?.pubKey || !account?.encSecret) throw new Error('No publisher account to unlock.');
  const secret = decryptSecret(account, password);
  const pair = keyPairFromSecret(secret);
  if (pair.pubHex !== account.pubKey) throw new Error('Publisher key does not match the saved account.');
  return {
    pubKey: pair.pubHex,
    username: account.username,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}

export function exportMnemonic(account, password) {
  const secret = decryptSecret(account, password);
  return entropyToMnemonic(secret, wordlist);
}

export function signPublication(unlocked, { cid, name, sha256, addedAtMs }) {
  if (!unlocked?.privateKey) throw new Error('Unlock the publisher identity before signing.');
  const digest = publicationDigest(cid, name, sha256, addedAtMs);
  const sig = cryptoSign(null, digest, unlocked.privateKey);
  return {
    pubKey: unlocked.pubKey,
    pubName: unlocked.username,
    pubSig: sig.toString('base64'),
    digestHex: digest.toString('hex'),
  };
}

export function verifyPublication({ cid, name, sha256, addedAtMs, pubKey, pubSig }) {
  if (typeof pubKey !== 'string' || !/^[a-f0-9]{64}$/i.test(pubKey)) return false;
  if (typeof pubSig !== 'string' || pubSig.length > 256) return false;
  let sig;
  try { sig = Buffer.from(pubSig, 'base64'); } catch { return false; }
  if (sig.length !== 64) return false;
  let digest;
  try { digest = publicationDigest(cid, name, sha256, addedAtMs); } catch { return false; }
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(pubKey, 'hex'),
  ]);
  try {
    const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return cryptoVerify(null, digest, publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * Sign a raw UTF-8 challenge message (ADR 003 account binding). Unlike
 * signPublication there is no digest structure: the server verifies the
 * signature over the exact nonce bytes it issued. Hex-encoded 64-byte sig.
 */
export function signChallenge(unlocked, message) {
  if (!unlocked?.privateKey) throw new Error('Unlock the publisher identity before signing.');
  if (typeof message !== 'string' || !message || message.length > 512) throw new Error('Invalid challenge message.');
  const sig = cryptoSign(null, Buffer.from(message, TEXT), unlocked.privateKey);
  return sig.toString('hex');
}

/**
 * Sign a recipe v2 manifest for Hub publish (P2). Returns the NORMALIZED
 * manifest (the exact object whose digest is signed — transmitting a raw
 * un-normalized object would change the digest server-side), the hex64
 * digest, and a flat BASE64 64-byte Ed25519 signature over
 * `frostbyte-recipe/2\n<pubkey>\n<digest>\n<createdAt>`.
 *
 * Deliberately separate from signChallenge (hex, bind protocol): recipe
 * signatures use base64 per verifyRecipeSignature, and the signing domain
 * differs. The caller must publish `manifest` exactly as returned here.
 */
export function signRecipe(unlocked, manifest) {
  if (!unlocked?.privateKey) throw new Error('Unlock the publisher identity before signing.');
  // Require an explicit createdAt on the RAW manifest: validateRecipe would
  // otherwise default it to now(), which would silently bind the signature to
  // a timestamp the publisher never chose. Check before normalizing.
  if (typeof manifest?.createdAt !== 'string' || !manifest.createdAt.trim()) {
    throw new Error('Recipe createdAt is required before signing.');
  }
  const normalized = validateRecipe(manifest);
  if (normalized.publisher !== unlocked.pubKey) {
    throw new Error('The manifest publisher must be your unlocked publisher key.');
  }
  const digest = canonicalDigest(normalized);
  const bytes = recipeSigningBytes({ digest, pubkey: normalized.publisher, timestamp: normalized.createdAt });
  const sig = cryptoSign(null, bytes, unlocked.privateKey);
  return { manifest: normalized, digest, signature: sig.toString('base64'), pubKey: unlocked.pubKey };
}

export function fingerprint(pubKey, size = 12) {
  if (typeof pubKey !== 'string') return '';
  return pubKey.slice(0, Math.max(8, Math.min(size, pubKey.length)));
}
