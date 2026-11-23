import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const vector = JSON.parse(fs.readFileSync(new URL('./fixtures/publisher-aeon-vector.json', import.meta.url)));
const cid = vector.cid;
const shared = JSON.parse(fs.readFileSync(new URL('./fixtures/model-share-vectors.json', import.meta.url)));
import { createPrivateKey, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  createPublisherAccount,
  exportMnemonic,
  importPublisherAccount,
  publicationDigest,
  signPublication,
  signRecipe,
  unlockPublisherAccount,
  verifyPublication,
} from '../src/main/publisher.js';
import { canonicalDigest, verifyRecipeSignature } from '../src/shared/recipe-manifest.js';

const SPKI_ED25519 = '302a300506032b6570032100';
const edVerify = (bytes, sigBuf, pubKeyHex) => {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(SPKI_ED25519 + pubKeyHex, 'hex'), format: 'der', type: 'spki' });
    return cryptoVerify(null, bytes, publicKey, sigBuf);
  } catch { return false; }
};
const recipeFixture = (pubKey) => ({
  schema: 'frostbyte.recipe', version: 2, id: 'qwen3-8b-q4-k-m', title: 'Qwen3-8B Q4_K_M',
  kind: 'tmux', publisher: pubKey,
  files: [{ path: 'qwen3-8b-q4_k_m.gguf', size: 4_200_000_000, sha256: 'a'.repeat(64) }],
  license: { id: 'apache-2.0' },
  modelRef: { repoId: 'Qwen/Qwen3-8B-GGUF', revision: 'b'.repeat(40) },
  session: 'qwen3-serve', argv: ['llama-server', '-m', '/models/qwen3-8b-q4_k_m.gguf', '--port', '8080'],
  createdAt: '2026-11-16T00:00:00.000Z',
});

test('create → unlock → sign → verify', () => {
  const { account, mnemonic } = createPublisherAccount({ petname: 'AEON Forge', password: 'test-pass-word' });
  assert.equal(mnemonic.split(' ').length, 24);
  assert.match(account.pubKey, /^[a-f0-9]{64}$/);
  const unlocked = unlockPublisherAccount(account, 'test-pass-word');
  assert.equal(unlocked.pubKey, account.pubKey);
  const signed = signPublication(unlocked, {
    cid,
    name: 'demo-model',
    sha256: 'a'.repeat(64),
    addedAtMs: 1_700_000_000_000,
  });
  assert.equal(true, verifyPublication({
    cid,
    name: 'demo-model',
    sha256: 'a'.repeat(64),
    addedAtMs: 1_700_000_000_000,
    pubKey: signed.pubKey,
    pubSig: signed.pubSig,
  }));
});

test('import mnemonic restores the same pubkey', () => {
  const first = createPublisherAccount({ petname: 'One', password: 'test-pass-word' });
  const second = importPublisherAccount({
    mnemonic: first.mnemonic,
    petname: 'Two',
    password: 'other-pass-word',
  });
  assert.equal(first.account.pubKey, second.account.pubKey);
});

test('wrong password fails closed', () => {
  const { account } = createPublisherAccount({ petname: 'AEON Forge', password: 'test-pass-word' });
  assert.throws(() => unlockPublisherAccount(account, 'wrong-pass-word'));
});

test('export mnemonic round-trips', () => {
  const { account, mnemonic } = createPublisherAccount({ petname: 'AEON Forge', password: 'test-pass-word' });
  assert.equal(exportMnemonic(account, 'test-pass-word'), mnemonic);
});

test('digest is stable', () => {
  const a = publicationDigest(cid, 'name', 'a'.repeat(64), 1);
  const b = publicationDigest(cid, 'name', 'a'.repeat(64), 1);
  assert.equal(a.toString('hex'), b.toString('hex'));
  assert.notEqual(a.toString('hex'), publicationDigest(cid, 'name', 'a'.repeat(64), 2).toString('hex'));
});

test('AEON raw message and independent Ed25519 vector interoperate', () => {
  const { account } = importPublisherAccount({ mnemonic: vector.mnemonic, petname: 'Interop', password: 'test-pass-word' });
  assert.equal(account.pubKey, vector.pubKey);
  assert.equal(publicationDigest(vector.cid, vector.name, vector.sha256, vector.addedAtMs).toString('hex'), vector.messageHex);
  assert.equal(verifyPublication(vector), true);
  const signed = signPublication(unlockPublisherAccount(account, 'test-pass-word'), vector);
  assert.equal(signed.pubSig, vector.pubSig);
});

test('signRecipe → independent Ed25519 verify round-trips over the canonical digest', () => {
  const { account } = createPublisherAccount({ petname: 'Recipe Signer', password: 'test-pass-word' });
  const unlocked = unlockPublisherAccount(account, 'test-pass-word');
  const signed = signRecipe(unlocked, recipeFixture(account.pubKey));
  assert.equal(signed.pubKey, account.pubKey);
  assert.match(signed.digest, /^[a-f0-9]{64}$/);
  assert.equal(signed.digest, canonicalDigest(signed.manifest));
  assert.equal(Buffer.from(signed.signature, 'base64').length, 64);
  // The server verifies exactly this: recipeSigningBytes(digest, pubkey, createdAt).
  assert.equal(verifyRecipeSignature({
    digest: signed.digest, pubkey: signed.manifest.publisher,
    timestamp: signed.manifest.createdAt, signature: signed.signature, verify: edVerify,
  }), true);
});

test('signRecipe refuses a manifest whose publisher is not the unlocked key', () => {
  const { account } = createPublisherAccount({ petname: 'One', password: 'test-pass-word' });
  const other = createPublisherAccount({ petname: 'Two', password: 'test-pass-word' });
  const unlocked = unlockPublisherAccount(account, 'test-pass-word');
  assert.throws(() => signRecipe(unlocked, recipeFixture(other.account.pubKey)), /publisher must be your unlocked/);
});

test('signRecipe requires createdAt and a locked session fails closed', () => {
  const { account } = createPublisherAccount({ petname: 'One', password: 'test-pass-word' });
  const unlocked = unlockPublisherAccount(account, 'test-pass-word');
  const noDate = recipeFixture(account.pubKey); delete noDate.createdAt;
  assert.throws(() => signRecipe(unlocked, noDate), /createdAt is required/);
  assert.throws(() => signRecipe(null, recipeFixture(account.pubKey)), /Unlock the publisher identity/);
});

// Golden vector: a FIXED Ed25519 key + manifest with precomputed digest,
// signing-bytes, and signature. This pins the domain-string construction
// independently of the round-trip test above (which reuses recipeSigningBytes
// on both sides and would pass a symmetric bug). The expected bytes decode to
// "frostbyte-recipe/2\n<digest>\n<pubkey>\n<createdAt>" — if the domain string,
// field order, or newline framing ever drifts, this fails.
test('signRecipe matches a fixed golden signing-bytes + signature vector', () => {
  const seed = '11'.repeat(32);
  const privDer = Buffer.from('302e020100300506032b657004220420' + seed, 'hex');
  const privateKey = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubKey = spki.subarray(spki.length - 32).toString('hex');
  const unlocked = { pubKey, privateKey, publicKey, username: 'golden' };
  const manifest = {
    schema: 'frostbyte.recipe', version: 2, id: 'golden-recipe', title: 'Golden', kind: 'native',
    publisher: pubKey, files: [{ path: 'model.gguf', size: 1024, sha256: 'ab'.repeat(32) }],
    license: { id: 'apache-2.0' }, createdAt: '2026-01-01T00:00:00.000Z',
  };
  const signed = signRecipe(unlocked, manifest);
  assert.equal(signed.digest, '13088a7332b5a8efece571c6ea737b351b19e7bdb6ccd3236dff8aaa68b4fbce');
  assert.equal(Buffer.from(signed.signature, 'base64').toString('hex'),
    'e8aac4b2f745926c5c647d8dee2012a8930d85316d496bee2f8abdcfe0cdb4faa4cd5eae1b16fa8f81df31b695e2aca87b012b6cda940ea76007b5ecf8a30f05');
  // Independent verification of the exact golden signing bytes.
  const goldenMsg = Buffer.from('66726f7374627974652d7265636970652f320a313330383861373333326235613865666563653537316336656137333762333531623139653762646236636364333233366466663861616136386234666263650a643034616232333237343262623461623361313336386264343631356534653664303232346162373161303136626166383532306133333263393737383733370a323032362d30312d30315430303a30303a30302e3030305a', 'hex');
  assert.equal(cryptoVerify(null, goldenMsg, publicKey, Buffer.from(signed.signature, 'base64')), true);
});

test('signRecipe normalizes before signing: digest binds the normalized manifest, dropping unknown fields', () => {
  const { account } = createPublisherAccount({ petname: 'One', password: 'test-pass-word' });
  const unlocked = unlockPublisherAccount(account, 'test-pass-word');
  const raw = recipeFixture(account.pubKey);
  // Reorder keys and add an unknown field the validator drops. The signed
  // digest must bind the NORMALIZED canonical form, not this raw object.
  const reordered = { createdAt: raw.createdAt, title: raw.title, version: raw.version, schema: raw.schema,
    id: raw.id, kind: raw.kind, publisher: raw.publisher, files: raw.files, license: raw.license,
    modelRef: raw.modelRef, session: raw.session, argv: raw.argv, bogusField: 'dropped-by-validator' };
  const signed = signRecipe(unlocked, reordered);
  assert.equal(signed.manifest.bogusField, undefined);
  assert.equal(signed.digest, canonicalDigest(signed.manifest));
  // The raw object carries a field the validator drops, so its digest differs
  // from the normalized canonical form that actually gets signed.
  assert.notEqual(signed.digest, canonicalDigest(reordered));
  // Re-signing the normalized manifest is deterministic (same digest + sig).
  const again = signRecipe(unlocked, signed.manifest);
  assert.equal(again.digest, signed.digest);
  assert.equal(again.signature, signed.signature);
});

test('aeon-publish/1 matches the shared Model Share vector byte for byte', () => {
  const p = shared.publication, entry = { cid: p.cid, name: p.name, sha256: p.sha256, addedAtMs: p.added_at_ms };
  assert.equal(publicationDigest(p.cid, p.name, p.sha256, p.added_at_ms).toString('utf8'), p.signed_text);
  assert.equal(verifyPublication({ ...entry, pubKey: p.signer, pubSig: p.sig }), true);
  assert.equal(verifyPublication({ ...entry, name: p.name + ' ', pubKey: p.signer, pubSig: p.sig }), false);
  // Ed25519 is deterministic: signing with the vector's public test secret must reproduce its signature.
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(shared.keys.orb_secret, 'hex')]), format: 'der', type: 'pkcs8' });
  const signed = signPublication({ privateKey, pubKey: shared.keys.orb_key, username: 'orb' }, entry);
  assert.equal(signed.pubSig, p.sig); assert.equal(signed.pubKey, p.signer);
});
