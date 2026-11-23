import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { checkOrigin, collectionFiles, originFingerprint, OriginRegistry } from '../src/main/aeon-origin-check.js';
import { originSigningBytes } from '../src/shared/aeon-origin.js';
import { CARD_FILE, normalizeOriginResult, originBlocksSharing, originSummary, ORIGIN_SHARE_BLOCKED } from '../src/shared/aeon-origin-status.js';
import { PublishingService } from '../src/main/publishing-service.js';
import { createShareMetadata } from '../src/main/torrent.js';
import { IpfsTransfers } from '../src/main/ipfs.js';

// The shared protocol vectors supply the keys, so a card signed here is signed
// exactly as an Orb (and a delegating user identity) would sign it.
const vectors = JSON.parse(fsSync.readFileSync(new URL('./fixtures/model-share-vectors.json', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const keyOf = secretHex => {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secretHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return { privateKey, hex: spki.subarray(spki.length - 32).toString('hex') };
};
const orb = keyOf(vectors.keys.orb_secret), stranger = keyOf('07'.repeat(32));
const delegation = { user_key: vectors.delegation.user_key, user_name: vectors.delegation.user_name, orb_key: vectors.delegation.orb_key, issued_ms: vectors.delegation.issued_ms, sig: vectors.delegation.sig };
const CONTENT = { 'README.md': 'A model.\n', 'weights/model.safetensors': Buffer.alloc(300_000, 7), 'tokenizer.json': '{}' };

/** Write a model folder and return what a download records about it. */
async function model(t, { content = CONTENT, card, signer = orb, sig, omit = [], rawCard } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-origin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = [];
  for (const [name, value] of Object.entries(content)) {
    const bytes = Buffer.from(value);
    manifest.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
    if (omit.includes(name)) continue;
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), bytes);
  }
  const base = { schema: 'aeon-model-card/2', name: 'Example', source: 'https://huggingface.co/example/example', verified: true, files: manifest };
  const signedMs = 1760000000002;
  const signature = sig ?? sign(null, originSigningBytes({ name: base.name, source: base.source, verified: true, signedMs, files: manifest }), signer.privateKey).toString('base64');
  const doc = card ? card(base, manifest) : { ...base, origin: { key: orb.hex, name: 'orb-one', signed_ms: signedMs, sig: signature } };
  if (doc !== null) await fs.writeFile(path.join(root, CARD_FILE), rawCard ?? JSON.stringify(doc));
  const files = [...manifest.filter(file => !omit.includes(file.path)).map(({ path: name, size }) => ({ path: name, size })),
    ...(doc !== null ? [{ path: CARD_FILE, size: (await fs.stat(path.join(root, CARD_FILE))).size }] : [])];
  return { root, files, manifest };
}

test('a model signed by an Orb verifies against the files on disk', async t => {
  const { root, files } = await model(t);
  const result = await checkOrigin(root, files, { now: () => 5 });
  assert.deepEqual({ ...result, fingerprint: '' }, { status: 'verified', reason: '', path: '', signer: orb.hex, identity: orb.hex, delegated: false, name: 'orb-one', fingerprint: '', checkedAt: 5 });
  assert.equal(originBlocksSharing(result), false);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.fingerprint, await originFingerprint(root, files));
});

test('a delegated signature is credited to the user identity, by key', async t => {
  const { root, files } = await model(t, { card: (base, manifest) => ({ ...base, origin: { key: orb.hex, name: 'orb-one', signed_ms: 1760000000002, delegation,
    sig: sign(null, originSigningBytes({ name: base.name, source: base.source, verified: true, signedMs: 1760000000002, files: manifest }), orb.privateKey).toString('base64') } }) });
  const result = await checkOrigin(root, files);
  assert.equal(result.status, 'verified'); assert.equal(result.signer, orb.hex);
  assert.equal(result.identity, vectors.delegation.user_key); assert.equal(result.delegated, true); assert.equal(result.name, 'alice');
  assert.match(originSummary(result).detail, /“alice” · identity 8a88e3dd7409…/);
});

test('changed, missing and extra files each fail and name the file', async t => {
  const changed = await model(t);
  await fs.writeFile(path.join(changed.root, 'tokenizer.json'), '[]');
  assert.deepEqual((({ status, reason, path: name }) => ({ status, reason, name }))(await checkOrigin(changed.root, changed.files)), { status: 'failed', reason: 'changed', name: 'tokenizer.json' });

  // A partial selection that kept the publisher's card is not the signed model.
  const partial = await model(t, { omit: ['README.md'] });
  const missing = await checkOrigin(partial.root, partial.files);
  assert.equal(missing.status, 'failed'); assert.equal(missing.reason, 'missing'); assert.equal(missing.path, 'README.md');
  assert.equal(originBlocksSharing(missing), true);

  const extra = await model(t);
  await fs.writeFile(path.join(extra.root, 'added.bin'), 'x');
  const added = await checkOrigin(extra.root, [...extra.files, { path: 'added.bin', size: 1 }]);
  assert.equal(added.reason, 'extra'); assert.equal(added.path, 'added.bin');
  assert.match(originSummary(added).detail, /Not shared onward: this copy has a file the publisher did not list \(added\.bin\)\./);
  // A file the user dropped in the folder afterwards is not part of the download and is not read.
  assert.equal((await checkOrigin(extra.root, extra.files)).status, 'verified');
});

test('a signature that does not cover these files fails', async t => {
  const forged = await model(t, { signer: stranger });
  assert.equal((await checkOrigin(forged.root, forged.files)).reason, 'signature');
  const renamed = await model(t, { card: (base, manifest) => ({ ...base, name: 'Renamed', origin: { key: orb.hex, signed_ms: 1760000000002,
    sig: sign(null, originSigningBytes({ name: base.name, source: base.source, verified: true, signedMs: 1760000000002, files: manifest }), orb.privateKey).toString('base64') } }) });
  assert.equal((await checkOrigin(renamed.root, renamed.files)).reason, 'signature');
  const bare = await model(t, { card: base => ({ schema: 'aeon-model-card/1', name: base.name, origin: { key: orb.hex, signed_ms: 1, sig: 'A'.repeat(88) } }) });
  assert.equal((await checkOrigin(bare.root, bare.files)).reason, 'signature');
  const malformed = await model(t, { card: base => ({ ...base, files: [{ path: 'README.md', size: '9', sha256: 'zz' }], origin: { key: orb.hex, signed_ms: 1, sig: 'A'.repeat(88) } }) });
  assert.equal((await checkOrigin(malformed.root, malformed.files)).reason, 'manifest');
});

test('unsigned cards are reported as unsigned and still held to their file list', async t => {
  const mirror = await model(t, { card: base => ({ ...base, verified: false, origin: { upstream: 'hailo-model-zoo', signed_ms: 0 } }) });
  const result = await checkOrigin(mirror.root, mirror.files);
  assert.equal(result.status, 'unsigned'); assert.equal(result.signer, ''); assert.equal(originBlocksSharing(result), false);
  await fs.writeFile(path.join(mirror.root, 'README.md'), 'Edited.\n');
  assert.equal((await checkOrigin(mirror.root, mirror.files)).reason, 'changed');

  const primary = Buffer.from(CONTENT['weights/model.safetensors']);
  const old = await model(t, { card: () => ({ schema: 'aeon-model-card/1', name: 'Old', file: 'weights/model.safetensors', sha256: sha256(primary).toUpperCase() }) });
  assert.equal((await checkOrigin(old.root, old.files)).status, 'unsigned');
  const wrong = await model(t, { card: () => ({ schema: 'aeon-model-card/1', name: 'Old', file: 'weights/model.safetensors', sha256: 'ab'.repeat(32) }) });
  assert.deepEqual((({ reason, path: name }) => [reason, name])(await checkOrigin(wrong.root, wrong.files)), ['changed', 'weights/model.safetensors']);
});

test('folders without an AEON card are left alone', async t => {
  const none = await model(t, { card: () => null });
  assert.equal(await checkOrigin(none.root, none.files), null);
  const other = await model(t, { card: () => ({ title: 'Some other tool', files: [] }) });
  assert.equal(await checkOrigin(other.root, other.files), null);
  const broken = await model(t, { rawCard: '{ not json' });
  assert.equal(await checkOrigin(broken.root, broken.files), null);
  const nested = await model(t, { card: () => null, content: { 'docs/model-card.json': '{"origin":{"sig":"x"}}', 'a.bin': 'a' } });
  assert.equal(await checkOrigin(nested.root, nested.files), null, 'only a card at the collection root counts');
});

test('hidden files fail; links and unreadable cards are errors, never a pass', async t => {
  const hidden = await model(t, { content: { ...CONTENT, '.cache/note': 'x' } });
  assert.deepEqual((({ reason, path: name }) => [reason, name])(await checkOrigin(hidden.root, hidden.files)), ['hidden', '.cache/note']);

  const linked = await model(t);
  await fs.rm(path.join(linked.root, 'tokenizer.json'));
  await fs.symlink(path.join(linked.root, 'README.md'), path.join(linked.root, 'tokenizer.json'));
  await assert.rejects(checkOrigin(linked.root, linked.files), /linked or is no longer a regular file/);

  const huge = await model(t, { rawCard: JSON.stringify({ schema: 'aeon-model-card/2', pad: 'x'.repeat(1024 * 1024) }) });
  await assert.rejects(checkOrigin(huge.root, huge.files), /implausibly large/);
  const gone = await model(t);
  await fs.rm(path.join(gone.root, 'weights/model.safetensors'));
  await assert.rejects(checkOrigin(gone.root, gone.files), { code: 'ENOENT' });
  await assert.rejects(checkOrigin(gone.root, [{ path: '../escape', size: 1 }, { path: CARD_FILE, size: 1 }]), /not valid|ENOENT/);
});

test('hashes already taken from disk are reused; a card that changed since is an error', async t => {
  const { root, files, manifest } = await model(t);
  const cardHash = sha256(await fs.readFile(path.join(root, CARD_FILE)));
  const hashes = new Map([...manifest.map(file => [file.path, file.sha256]), [CARD_FILE, cardHash]]);
  assert.equal((await checkOrigin(root, files, { hashes })).status, 'verified');
  // The supplied hash is what is compared: no second read of the weights.
  const stale = new Map(hashes).set('tokenizer.json', 'cd'.repeat(32));
  assert.equal((await checkOrigin(root, files, { hashes: stale })).reason, 'changed');
  await assert.rejects(checkOrigin(root, files, { hashes: new Map(hashes).set(CARD_FILE, 'ef'.repeat(32)) }), /changed after it was downloaded/);
  await fs.appendFile(path.join(root, 'README.md'), 'more');
  await assert.rejects(checkOrigin(root, files, { hashes }), /changed after it was verified/);
});

test('the fingerprint follows the files, so a stored result is not reused after a change', async t => {
  const { root, files } = await model(t);
  const before = await originFingerprint(root, files);
  assert.equal(await originFingerprint(root, [...files].reverse()), before);
  await fs.writeFile(path.join(root, 'tokenizer.json'), '{"changed":true}');
  assert.notEqual(await originFingerprint(root, files), before);
});

test('release paths drop their folder to become collection paths', () => {
  assert.deepEqual(collectionFiles([{ path: 'Model/a.bin', size: 1 }, { path: 'Model/sub/b.bin', size: 2 }]).map(file => file.path), ['a.bin', 'sub/b.bin']);
  assert.deepEqual(collectionFiles([{ path: 'model.gguf', size: 1 }]).map(file => file.path), ['model.gguf']);
  assert.deepEqual(collectionFiles([{ path: 'A/a.bin', size: 1 }, { path: 'B/b.bin', size: 1 }]).map(file => file.path), ['A/a.bin', 'B/b.bin']);
  assert.deepEqual(collectionFiles([]), []);
});

test('stored results are bounded and never trusted beyond their shape', () => {
  assert.equal(normalizeOriginResult(null), null);
  assert.equal(normalizeOriginResult({ status: 'trusted' }), null);
  assert.equal(normalizeOriginResult({ status: 'verified', signer: 'zz', identity: orb.hex }), null, 'a verified result needs both keys');
  assert.equal(normalizeOriginResult({ status: 'failed', reason: 'because' }), null);
  const cleaned = normalizeOriginResult({ status: 'verified', signer: orb.hex, identity: orb.hex, name: 'a\u0000b\n' + 'x'.repeat(200), delegated: true, path: '/secret', extra: 1 });
  assert.equal(cleaned.name.length, 64); assert.equal(/[\x00-\x1f]/.test(cleaned.name), false);
  assert.equal(cleaned.delegated, false); assert.equal(cleaned.path, ''); assert.equal('extra' in cleaned, false);
  assert.equal(originSummary({ status: 'unsigned' }).label, 'Origin unsigned');
  assert.equal(originSummary({ status: 'nope' }), null);
  assert.match(ORIGIN_SHARE_BLOCKED, /cannot be shared/);
});

test('torrent copies are checked once, rechecked after a change, and forgotten with their record', async t => {
  const { root, files } = await model(t);
  const destination = path.dirname(root), folder = path.basename(root);
  const row = { id: 'torrent:' + 'ab'.repeat(20), source: 'torrent', directory: true, relative: folder, path: root, destination,
    files: files.map(file => ({ relative: folder + '/' + file.path, size: file.size })) };
  const commits = [];
  const store = { state: {}, _commitStateFields(patch) { commits.push(patch); Object.assign(this.state, patch); } };
  const inventory = { rows: [row, { id: 'torrent:' + 'cd'.repeat(20), source: 'torrent', directory: false, relative: 'one.gguf', path: path.join(destination, 'one.gguf'), destination, files: [{ relative: 'one.gguf', size: 1 }] },
    { id: 'hf:x', source: 'hf', directory: true, relative: 'org/model', path: root, destination, files: [{ relative: 'org/model/model-card.json', size: 1 }] }] };
  const registry = new OriginRegistry({ store, inventory });
  assert.equal(await registry.ensure('torrent:' + 'cd'.repeat(20)), null, 'a single file has no card');
  assert.equal(await registry.ensure('hf:x'), null, 'Hugging Face copies are not AEON shares');
  assert.equal(await registry.ensure('missing'), null);
  assert.equal(commits.length, 0);

  const [first, concurrent] = await Promise.all([registry.ensure(row.id), registry.ensure(row.id)]);
  assert.equal(first.status, 'verified'); assert.equal(concurrent, first); assert.equal(commits.length, 1);
  assert.deepEqual(registry.snapshot(), { [row.id]: first });
  assert.deepEqual(await registry.ensure(row.id), first); assert.equal(commits.length, 1, 'unchanged files reuse the stored result');

  await fs.writeFile(path.join(root, 'tokenizer.json'), '[]');
  const second = await registry.ensure(row.id);
  assert.equal(second.reason, 'changed'); assert.equal(originBlocksSharing(registry.get(row.id)), true);

  store.state.aeonOrigins[row.id] = { status: 'verified', signer: 'not-a-key' };
  assert.equal(registry.get(row.id), null, 'a damaged stored result is never a pass');
  inventory.rows = [];
  assert.deepEqual(registry.snapshot(), {});
  assert.equal(await registry.ensure(row.id), null); assert.deepEqual(store.state.aeonOrigins, {});
});

test('a release records the IPFS CID only while those exact files are shared over IPFS', async t => {
  const root = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-release-cid-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Model'); await fs.mkdir(path.join(folder, 'sub'), { recursive: true });
  const content = { 'a.bin': 'alpha', 'sub/b.bin': 'beta' };
  for (const [name, value] of Object.entries(content)) await fs.writeFile(path.join(folder, name), value);
  const files = Object.entries(content).map(([name, value]) => ({ path: path.join(folder, name), size: value.length }));
  const link = await createShareMetadata(folder, { files });
  const store = { appDir: root, state: { savedShareLinks: [{ path: folder, device: 'local', infohash: link.infohash }] }, _commitStateFields(patch) { Object.assign(this.state, structuredClone(patch)); } };
  await fs.mkdir(path.join(root, 'share-metainfo')); await fs.writeFile(path.join(root, 'share-metainfo', link.infohash + '.torrent'), link.metadata);

  // The IPFS side as IpfsTransfers records it: collection-relative paths and the hash of each file.
  const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const job = { sharing: true, shareCid: cid, files: Object.entries(content).map(([name, value]) => ({ path: name, size: value.length, hash: sha256(Buffer.from(value)) })) };
  const ipfs = { jobs: new Map([['ipfs:x', job]]), publisher: { publishing: true, url: 'http://127.0.0.1:1' } };
  const service = new PublishingService({ store, protection: {}, resolve: async () => ({ path: folder, name: 'Model', files }), inventory: { rows: [] }, sessions: () => [], review: async () => ({ response: 0 }), dialog: {}, state: () => ({}), handle() {},
    sharedCid: list => IpfsTransfers.prototype.sharedCid.call(ipfs, collectionFiles(list)) });
  t.after(() => service.stop());
  const request = { id: 'test', publisher: 'blackfrost', release: 'fixture', variant: 'safetensors', license: { id: 'MIT', statement: 'Owner-created test bytes.' }, redistribution_confirmed: true };

  const shared = await service.preview(request);
  assert.deepEqual(shared.manifest.files.map(file => file.path), ['Model/a.bin', 'Model/sub/b.bin']);
  assert.equal(shared.manifest.cid, cid); assert.equal(shared.manifest.torrent.infohash_v1, link.infohash);
  await service.queue.beforeSubmit({ digest: shared.digest }, shared);

  job.sharing = false;
  assert.equal((await service.preview(request)).manifest.cid, '', 'no CID is claimed once IPFS sharing is off');
  job.sharing = true; job.files[0].hash = 'ab'.repeat(32);
  assert.equal((await service.preview(request)).manifest.cid, '', 'another file set is not this release');
  job.files[0].hash = sha256(Buffer.from('alpha')); ipfs.publisher.url = null;
  assert.equal((await service.preview(request)).manifest.cid, '', 'a stopped publisher is not sharing');
});

test('integrityFingerprint: content-anchored for small files, stat-keyed for large', async t => {
  const { integrityFingerprint } = await import('../src/main/aeon-origin-check.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-ifp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const small = Buffer.from([0x80, 0x02, 0x7d, 0x2e]);
  await fs.writeFile(path.join(root, 'a.pkl'), small);
  const files = [{ path: 'a.pkl', size: small.length }];
  const first = await integrityFingerprint(root, files);
  const stat = await fs.stat(path.join(root, 'a.pkl'));
  await fs.writeFile(path.join(root, 'a.pkl'), Buffer.from([0x80, 0x02, 0x7d, 0x2f]));
  await fs.utimes(path.join(root, 'a.pkl'), stat.atime, stat.mtime);
  const second = await integrityFingerprint(root, files);
  assert.notEqual(second, first, 'same-size same-mtime rewrite must change the fingerprint');
  // Large files stay stat-keyed (multi-GB weights are bound by upstream/torrent hashes).
  const big = [{ path: 'a.pkl', size: small.length }];
  const statOnly = await integrityFingerprint(root, big, { contentMaxBytes: 0 });
  const statOnly2 = await integrityFingerprint(root, big, { contentMaxBytes: 0 });
  assert.equal(statOnly2, statOnly);
});

test('regular() refuses backslash/colon path components on every platform', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-regular-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'ok.gguf'), Buffer.from('w'));
  await fs.mkdir(path.join(root, 'a'));
  const { originFingerprint } = await import('../src/main/aeon-origin-check.js');
  await assert.rejects(() => originFingerprint(root, [{ path: '..\\evil', size: 1 }]), /not valid/);
  await assert.rejects(() => originFingerprint(root, [{ path: 'C:evil', size: 1 }]), /not valid/);
  await assert.rejects(() => originFingerprint(root, [{ path: 'a/../../etc/passwd', size: 1 }]), /not valid/);
  // A traversal through an existing regular file fails closed too — the
  // per-component lstat rejects it as non-directory before any '..' step.
  await fs.writeFile(path.join(root, 'b.bin'), Buffer.from('w'));
  await assert.rejects(() => originFingerprint(root, [{ path: 'b.bin/../../etc/passwd', size: 1 }]), /linked or is no longer a regular file/);
  assert.match(await originFingerprint(root, [{ path: 'ok.gguf', size: 1 }]), /^[a-f0-9]{64}$/);
});
