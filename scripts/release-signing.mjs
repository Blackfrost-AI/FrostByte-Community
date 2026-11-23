/** Detached publisher signatures for immutable, edition-bound release checksums. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assemble, fingerprint, targets } from './release.mjs';
import { EDITIONS } from '../src/shared/edition-manifest.cjs';

export function requireFingerprint(value) {
  if (typeof value !== 'string' || !/^(?:[A-F0-9]{40}|[A-F0-9]{64})$/.test(value)) {
    throw new Error('Use the full, independently confirmed uppercase publisher fingerprint, not a key ID.');
  }
  return value;
}

export function canonicalChecksums(release) {
  const edition = Object.hasOwn(EDITIONS, release?.edition ?? '') ? EDITIONS[release.edition] : null;
  if (release?.schemaVersion !== 1 || !edition || release.channel !== edition.channel || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(release.version || '')
    || JSON.stringify(release.platforms) !== JSON.stringify(Object.keys(targets))
    || !Array.isArray(release.artifacts) || release.artifacts.length !== 7) throw new Error('Invalid edition-bound release manifest.');
  const files = Object.values(targets).flat().map(([format, suffix]) => [format, `${edition.artifactPrefix}-${release.version}-${suffix}`]);
  files.push(['checksums', `SHA256SUMS-${release.version}`]);
  const records = files.map(([format, filename]) => {
    const found = release.artifacts.filter(a => a.format === format && a.filename === filename);
    if (found.length !== 1 || !Number.isSafeInteger(found[0].bytes) || found[0].bytes <= 0
      || !/^[a-f0-9]{64}$/.test(found[0].sha256 || '')) throw new Error(`Invalid release artifact: ${filename}.`);
    return found[0];
  });
  return records.slice(0, 6).map(a => `${a.sha256}  ${a.filename}\n`).join('');
}

let posixGpg;
function windowsPosixGpg() {
  if (process.platform !== 'win32') return false;
  // Git for Windows includes an MSYS GnuPG, which resolves C:\\... relative to
  // its POSIX working directory. Native Gpg4win expects Windows paths instead.
  // bindir identifies that build independently of the caller's GNUPGHOME.
  posixGpg ??= spawnSync('gpgconf', ['--list-dirs', 'bindir'], { encoding: 'utf8', windowsHide: true })
    .stdout?.trim().startsWith('/') ?? false;
  return posixGpg;
}

export function gpgPath(value, { platform = process.platform, posix = windowsPosixGpg() } = {}) {
  if (platform !== 'win32' || !posix || typeof value !== 'string') return value;
  const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(value);
  if (drive) return `/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}`;
  return value;
}

const gpg = (args, options = {}) => execFileSync('gpg', ['--no-options', ...args.map(arg => gpgPath(arg))], {
  encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options,
});

/** No ambient keyring, keyserver retrieval, trust-on-first-use, or UID-based trust. */
export async function verifySignature({ checksums, signature, publicKey, publisherFingerprint }) {
  requireFingerprint(publisherFingerprint);
  for (const value of [checksums, signature, publicKey]) {
    if (!(typeof value === 'string' || Buffer.isBuffer(value)) || !value.length || Buffer.byteLength(value) > 65536) {
      throw new Error('Invalid or oversized signature input.');
    }
  }
  if (!String(signature).startsWith('-----BEGIN PGP SIGNATURE-----')
    || !String(publicKey).startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')
    || String(publicKey).includes('PRIVATE KEY')) throw new Error('Expected a detached armored signature and public key only.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-gpg-'));
  await fs.chmod(temporary, 0o700);
  try {
    await Promise.all([
      fs.writeFile(path.join(temporary, 'checksums'), checksums),
      fs.writeFile(path.join(temporary, 'checksums.asc'), signature),
      fs.writeFile(path.join(temporary, 'publisher.asc'), publicKey),
    ]);
    const base = ['--homedir', temporary, '--batch', '--no-tty', '--no-autostart', '--no-auto-key-retrieve'];
    gpg([...base, '--import', path.join(temporary, 'publisher.asc')]);
    const listing = gpg([...base, '--with-colons', '--fingerprint', '--list-keys']);
    const lines = listing.split('\n');
    const primary = lines.flatMap((line, i) => line.startsWith('pub:') ? [lines[i + 1]?.split(':')[9]] : []);
    if (primary.length !== 1 || primary[0] !== publisherFingerprint) throw new Error('Publisher public key does not match the pinned fingerprint.');
    const status = gpg([...base, '--status-fd', '1', '--verify', path.join(temporary, 'checksums.asc'), path.join(temporary, 'checksums')]);
    const signatures = status.split('\n').filter(line => line.startsWith('[GNUPG:] VALIDSIG '));
    if (signatures.length !== 1 || /\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|KEYEXPIRED|SIGEXPIRED|KEYREVOKED|FAILURE)\b/.test(status)) {
      throw new Error('Expected one valid, current, non-revoked publisher signature.');
    }
    const fields = signatures[0].slice('[GNUPG:] VALIDSIG '.length).trim().split(/\s+/);
    if ((fields[9] || fields[0]) !== publisherFingerprint || !['8', '9', '10', '11'].includes(fields[7]) || fields[8] !== '00') {
      throw new Error('Signature must bind the exact checksum bytes to the pinned publisher using SHA-2.');
    }
    return { publisherFingerprint, signingFingerprint: fields[0] };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function immutable(file, value) {
  try { await fs.writeFile(file, value, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !Buffer.from(await fs.readFile(file)).equals(Buffer.from(value))) {
      throw new Error(`Refusing to replace published verification material: ${path.basename(file)}.`);
    }
  }
}

export async function verifyRelease(directory, publisherFingerprint) {
  requireFingerprint(publisherFingerprint);
  const release = JSON.parse(await fs.readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  const expected = canonicalChecksums(release);
  const checksums = await fs.readFile(path.join(directory, `SHA256SUMS-${release.version}`), 'utf8');
  if (checksums !== expected) throw new Error('Checksum list must contain exactly the six authoritative edition-bound release files.');
  const verification = JSON.parse(await fs.readFile(path.join(directory, 'release-verification.json'), 'utf8'));
  const keyName = `FrostByte-release-key-${publisherFingerprint}.asc`;
  const signatureName = `SHA256SUMS-${release.version}.asc`;
  if (verification.schemaVersion !== 1 || verification.version !== release.version || verification.scheme !== 'openpgp-sha256'
    || verification.publisherFingerprint !== publisherFingerprint || verification.checksums !== `SHA256SUMS-${release.version}`
    || verification.signature?.filename !== signatureName || verification.publicKey?.filename !== keyName) throw new Error('Invalid release verification record.');
  const result = await verifySignature({ checksums, publisherFingerprint,
    signature: await fs.readFile(path.join(directory, signatureName)), publicKey: await fs.readFile(path.join(directory, keyName)) });
  for (const artifact of [...release.artifacts, verification.signature, verification.publicKey]) {
    const actual = await fingerprint(path.join(directory, artifact.filename));
    if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) throw new Error(`Release bytes do not match: ${artifact.filename}.`);
  }
  return { version: release.version, ...result, artifactsVerified: 6 };
}

export async function signRelease(root, directory, publisherFingerprint) {
  requireFingerprint(publisherFingerprint);
  // Existing assembly verifies all native receipts, source provenance, immutable
  // metadata and every package. Mixed-edition filenames are rejected.
  const release = await assemble(root, directory);
  const checksumName = `SHA256SUMS-${release.version}`;
  if (await fs.readFile(path.join(directory, checksumName), 'utf8') !== canonicalChecksums(release)) throw new Error('Non-canonical checksum list.');
  const signatureName = `${checksumName}.asc`;
  const keyName = `FrostByte-release-key-${publisherFingerprint}.asc`;
  // Re-verification is idempotent; never silently re-sign or rotate released data.
  let alreadySigned = false;
  try { await fs.lstat(path.join(directory, 'release-verification.json')); alreadySigned = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (alreadySigned) return verifyRelease(directory, publisherFingerprint);
  const publicKey = gpg(['--batch', '--armor', '--export-options', 'export-minimal', '--export', publisherFingerprint]);
  let signature;
  try { signature = await fs.readFile(path.join(directory, signatureName), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // GnuPG's normal pinentry/agent owns unlocking. No passphrase CLI flag,
    // secret export, CI secret, key creation or unprotected-key fallback.
    signature = gpg(['--batch', '--armor', '--local-user', publisherFingerprint, '--digest-algo', 'SHA256',
      '--detach-sign', '--output', '-', path.join(directory, checksumName)]);
  }
  await verifySignature({ checksums: await fs.readFile(path.join(directory, checksumName)), signature, publicKey, publisherFingerprint });
  await immutable(path.join(directory, keyName), publicKey);
  await immutable(path.join(directory, signatureName), signature);
  const verification = { schemaVersion: 1, version: release.version, scheme: 'openpgp-sha256', publisherFingerprint,
    checksums: checksumName,
    signature: { filename: signatureName, ...await fingerprint(path.join(directory, signatureName)) },
    publicKey: { filename: keyName, ...await fingerprint(path.join(directory, keyName)) } };
  await immutable(path.join(directory, 'release-verification.json'), JSON.stringify(verification, null, 2) + '\n');
  return verifyRelease(directory, publisherFingerprint);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, publisherFingerprint, ...extra] = process.argv.slice(2);
  if (!directory || !publisherFingerprint || extra.length || !['sign', 'verify'].includes(command)) {
    throw new Error('Usage: release-signing.mjs sign|verify DIRECTORY FULL_PUBLISHER_FINGERPRINT');
  }
  const result = command === 'sign'
    ? await signRelease(fileURLToPath(new URL('..', import.meta.url)), path.resolve(directory), publisherFingerprint)
    : await verifyRelease(path.resolve(directory), publisherFingerprint);
  console.log(JSON.stringify(result, null, 2));
}
