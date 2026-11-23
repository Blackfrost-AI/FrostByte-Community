// Update feed assembly + signing for the local Hub. The feed is signed with the hub's
// ed25519 feed key over BUNDLE_DOMAIN || canonicalJson(feedWithoutSignature). The client
// verifies against the hub's pinned feed public key before emitting any nudge (A2).
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_DOMAIN, generateKeypair, signFeedBody } from './crypto.js';

// Load or create the hub feed keypair. Persisted 0600 in the data dir so the same key
// survives restarts (clients pin it once). In memory-only mode a fresh key is generated.
export function loadOrCreateFeedKey(dataDir) {
  if (!dataDir) return generateKeypair();
  const file = path.join(dataDir, 'feed-key.json');
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (/^[a-f0-9]{64}$/.test(saved.publicKeyHex) && /^[a-f0-9]{64}$/.test(saved.privateKeyHex)) return saved;
    }
  } catch { /* regenerate on corrupt key */ }
  const key = generateKeypair();
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(key)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return key;
}

// Build the unsigned feed body. Versions/digests come from the real store, not constants.
export function buildFeedBody(store, { version = 1 } = {}) {
  const engines = [];
  const recipes = [];
  const configs = [];
  const containers = [];
  // Local hub publishes recipes; surface each head as a recipe update entry.
  for (const head of store.headsList ? store.headsList() : []) {
    recipes.push({
      id: head.id,
      version: Number(head.currentVersion) || 1,
      digest: head.digest,
      severity: 'normal',
      notes: `Recipe ${head.id} v${head.currentVersion}`,
    });
  }
  return { version, engines, recipes, configs, containers };
}

export function signFeed(body, feedKey) {
  const signature = signFeedBody(body, feedKey.privateKeyHex);
  return { ...body, signature, feedPubKey: feedKey.publicKeyHex };
}