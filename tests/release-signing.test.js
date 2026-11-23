import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { assemble, fingerprint, targets } from '../scripts/release.mjs';
import { canonicalChecksums, gpgPath, requireFingerprint, signRelease, verifyRelease, verifySignature } from '../scripts/release-signing.mjs';

test('GnuPG paths support both native Windows and Git MSYS without shell interpolation', () => {
  const file = 'C:\\Users\\Release Owner\\checksums.asc';
  assert.equal(gpgPath(file, { platform: 'win32', posix: true }), '/c/Users/Release Owner/checksums.asc');
  assert.equal(gpgPath('D:/release/keyring', { platform: 'win32', posix: true }), '/d/release/keyring');
  assert.equal(gpgPath(file, { platform: 'win32', posix: false }), file);
  assert.equal(gpgPath('/tmp/release', { platform: 'darwin', posix: false }), '/tmp/release');
  assert.equal(gpgPath('--no-options', { platform: 'win32', posix: true }), '--no-options');
});

test('publisher identity requires a full fingerprint, not a UID or short key ID', () => {
  assert.equal(requireFingerprint('A'.repeat(40)), 'A'.repeat(40));
  for (const value of ['', 'Blackfrost', '0x12345678', 'a'.repeat(40), '../publisher', null]) {
    assert.throws(() => requireFingerprint(value), /fingerprint/);
  }
});

test('community: real GPG signatures pin the publisher and reject changed bytes, keys and release lists', {
  skip: spawnSync('gpg', ['--version']).status !== 0 ? 'GnuPG is required for the signing integration fixture' : false,
}, async t => {
  // Keep macOS's long TMPDIR plus Unix-domain agent socket below sun_path's limit.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-sign-'));
  const keyring = path.join(temporary, 'gnupg');
  await fs.mkdir(keyring, { mode: 0o700 });
  t.after(async () => {
    spawnSync('gpgconf', ['--homedir', gpgPath(keyring), '--kill', 'gpg-agent']);
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const previous = process.env.GNUPGHOME;
  process.env.GNUPGHOME = gpgPath(keyring);
  t.after(() => { if (previous === undefined) delete process.env.GNUPGHOME; else process.env.GNUPGHOME = previous; });
  const gpg = (...args) => execFileSync('gpg', ['--no-options', '--homedir', gpgPath(keyring), '--batch', ...args.map(arg => gpgPath(arg))], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Only these throwaway, .invalid test identities are unprotected. No real key
  // is generated or unlocked by release tooling or by this fixture.
  gpg('--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Release fixture <fixture@example.invalid>', 'ed25519', 'cert', '1d');
  const publisherFingerprint = gpg('--with-colons', '--list-keys').split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
  gpg('--pinentry-mode', 'loopback', '--passphrase', '', '--quick-add-key', publisherFingerprint, 'ed25519', 'sign', '1d');
  gpg('--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Wrong fixture <wrong@example.invalid>', 'ed25519', 'sign', '1d');
  const wrongFingerprint = gpg('--with-colons', '--list-keys', 'wrong@example.invalid').split('\n').find(line => line.startsWith('fpr:')).split(':')[9];

  const prefix = 'FrostByte';
  const root = path.join(temporary, 'source'), output = path.join(root, 'dist');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(output);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.0', frostbyteEdition: 'community' }));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.4.0', packages: { '': { version: '0.4.0' } } }));
  await fs.writeFile(path.join(root, 'docs/RELEASE-NOTES.md'), '# FrostByte 0.4.0 — fixture\n\nHarmless test release.\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('add', '.');
  git('-c', 'user.name=Release fixture', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Fixture');
  const sourceCommit = git('rev-parse', 'HEAD'), sourceTree = git('rev-parse', 'HEAD^{tree}');
  for (const [platform, entries] of Object.entries(targets)) {
    const artifacts = [];
    for (const [format, suffix] of entries) {
      const filename = `${prefix}-0.4.0-${suffix}`;
      await fs.writeFile(path.join(output, filename), `Harmless fixture: ${format}.`);
      artifacts.push({ format, filename, ...await fingerprint(path.join(output, filename)) });
    }
    await fs.writeFile(path.join(output, `build-info-${platform}.json`), JSON.stringify({ schemaVersion: 1, edition: 'community', version: '0.4.0', platform, sourceCommit, sourceTree, artifacts }));
  }
  const release = await assemble(root, output);
  const originalManifest = await fs.readFile(path.join(output, 'release-manifest.json'));
  const signed = await signRelease(root, output, publisherFingerprint);
  assert.equal(signed.publisherFingerprint, publisherFingerprint);
  assert.notEqual(signed.signingFingerprint, publisherFingerprint, 'a certified signing subkey is supported');
  assert.equal(signed.artifactsVerified, 6);
  assert.deepEqual(await signRelease(root, output, publisherFingerprint), signed, 'repeat signing only re-verifies immutable files');
  assert.deepEqual(await fs.readFile(path.join(output, 'release-manifest.json')), originalManifest);
  const checksums = canonicalChecksums(release);
  const signature = await fs.readFile(path.join(output, 'SHA256SUMS-0.4.0.asc'), 'utf8');
  const publicKey = await fs.readFile(path.join(output, `FrostByte-release-key-${publisherFingerprint}.asc`), 'utf8');
  const inputs = { checksums, signature, publicKey, publisherFingerprint };
  await verifySignature(inputs);
  await assert.rejects(verifySignature({ ...inputs, publisherFingerprint: wrongFingerprint }), /pinned fingerprint/);
  await assert.rejects(verifySignature({ ...inputs, publicKey: gpg('--armor', '--export', wrongFingerprint) }), /pinned fingerprint/);
  await assert.rejects(verifySignature({ ...inputs, publicKey: publicKey + gpg('--armor', '--export', wrongFingerprint) }), /pinned fingerprint/);
  await assert.rejects(verifySignature({ ...inputs, checksums: checksums.replace(/[a-f0-9]/, 'Z') }));
  await assert.rejects(verifySignature({ ...inputs, signature: signature.replace(/\n\n./, '\n\n!') }));
  await assert.rejects(verifySignature({ ...inputs, publicKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----\n' }), /public key only/);
  await assert.rejects(verifySignature({ ...inputs, checksums: 'x'.repeat(65537) }), /oversized/);
  for (const change of [
    value => value.edition = 'founders',
    value => value.channel = 'nightly',
    value => value.artifacts.pop(),
    value => value.artifacts[0].filename = '../private-file',
    value => value.artifacts[4].filename = 'FrostByte-Founders-0.4.0-linux-x64.AppImage',
    value => value.artifacts[5].format = 'appimage',
    value => value.artifacts[1].bytes = 0,
  ]) {
    const changed = structuredClone(release); change(changed);
    assert.throws(() => canonicalChecksums(changed));
  }
  await fs.appendFile(path.join(output, 'SHA256SUMS-0.4.0'), '\n');
  await assert.rejects(verifyRelease(output, publisherFingerprint), /exactly the six/);
  await fs.writeFile(path.join(output, 'SHA256SUMS-0.4.0'), checksums);
  await fs.appendFile(path.join(output, release.artifacts[4].filename), 'tampered');
  await assert.rejects(verifyRelease(output, publisherFingerprint), /bytes do not match/);
  await assert.rejects(signRelease(root, output, publisherFingerprint), /does not match/);
  const revocation = await fs.readFile(path.join(keyring, 'openpgp-revocs.d', `${publisherFingerprint}.rev`), 'utf8');
  const start = revocation.indexOf(':-----BEGIN PGP PUBLIC KEY BLOCK-----');
  assert.ok(start >= 0, 'GnuPG generated the throwaway key revocation certificate');
  const revocationFile = path.join(temporary, 'fixture-revocation.asc');
  await fs.writeFile(revocationFile, revocation.slice(start + 1));
  gpg('--import', revocationFile);
  await assert.rejects(verifySignature({ ...inputs, publicKey: gpg('--armor', '--export', publisherFingerprint) }), /revoked|Command failed/);
});
