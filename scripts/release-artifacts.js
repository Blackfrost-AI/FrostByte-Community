import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

export function requireMacSigningIdentity(value) {
  const match = /^Developer ID Application: (.+) \(([A-Z0-9]{10})\)$/.exec(value || '');
  if (typeof value !== 'string' || !match || value.length > 300 || /[\x00-\x1f\x7f]/.test(value)
    || match[1].trim() !== match[1] || !match[1].trim()) {
    throw new Error('Strict macOS release verification requires the full FROSTBYTE_MAC_SIGNING_IDENTITY.');
  }
  return { authority: value, teamIdentifier: match[2] };
}

export function validateMacCodeSigning(details, expectedIdentity) {
  const expected = requireMacSigningIdentity(expectedIdentity);
  if (typeof details !== 'string') throw new Error('The macOS code-signing details are invalid.');
  const authorities = [...details.matchAll(/^Authority=(.*)$/gm)].map(match => match[1].replace(/\r$/, ''));
  const team = /^TeamIdentifier=([^\r\n]+)$/m.exec(details)?.[1];
  if (authorities[0] !== expected.authority || team !== expected.teamIdentifier) {
    throw new Error('Release bundle is not signed by the configured FrostByte Developer ID identity.');
  }
  return true;
}

export function requireWindowsSigningSubject(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Strict Windows release verification requires FROSTBYTE_WINDOWS_SIGNING_SUBJECT.');
  }
  return value;
}

export function validateWindowsAuthenticode(value, file, expectedSubject) {
  expectedSubject = requireWindowsSigningSubject(expectedSubject);
  if (!value || value.Status !== 'Valid' || value.SignatureType !== 'Authenticode'
    || typeof value.Subject !== 'string' || !/^[A-F0-9]{40}$/i.test(value.Thumbprint || '')
    || typeof value.TimestampSubject !== 'string' || !value.TimestampSubject
    || !/^[A-F0-9]{40}$/i.test(value.TimestampThumbprint || '')) {
    throw new Error(`Authenticode signature is not valid: ${file}`);
  }
  if (value.Subject !== expectedSubject) throw new Error(`Authenticode signer is not the configured FrostByte publisher: ${file}`);
  return true;
}

export function expectedInstallerName(platform, version) {
  if (!VERSION.test(version || '')) throw new Error('The packaged application has an invalid release version.');
  const product = 'FrostByte';
  if (platform === 'win32') return `${product}-${version}-win-x64-setup.exe`;
  if (platform === 'darwin') return `${product}-${version}-mac-arm64.dmg`;
  if (platform === 'linux') return [`${product}-${version}-linux-x64.AppImage`, `${product}-${version}-linux-x64.deb`];
  throw new Error(`Unsupported release platform: ${platform}`);
}

export function assertInstallerFilename(file, platform, version) {
  const expected = expectedInstallerName(platform, version);
  const names = Array.isArray(expected) ? expected : [expected];
  if (!names.includes(path.basename(file))) throw new Error(`Release installer must be a matching ${names.join(' or ')} artifact.`);
  return true;
}

export function validateArchiveEntries(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('The release installer archive is empty.');
  const seen = new Set();
  for (const original of lines) {
    if (typeof original !== 'string' || !original || /[\x00-\x1f\x7f\\:]/.test(original)) throw new Error('The release installer contains an invalid path.');
    const entry = original.endsWith('/') ? original.slice(0, -1) : original;
    const parts = entry.split('/');
    if (!entry || path.posix.isAbsolute(entry) || /^[a-z]:/i.test(entry) || parts.some(part => !part || part === '.' || part === '..')) {
      throw new Error(`The release installer contains an unsafe path: ${original}`);
    }
    if (seen.has(entry)) throw new Error(`The release installer repeats a path: ${entry}`);
    seen.add(entry);
  }
  return seen;
}

function treeEntries(root) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory()) throw new Error('The release installer payload root is not a real directory.');
  const result = new Map();
  const visit = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const child = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) visit(target, child);
      else if (stat.isFile()) result.set(child, { type: 'file', target, stat });
      else if (stat.isSymbolicLink()) result.set(child, { type: 'link', target, value: fs.readlinkSync(target) });
      else throw new Error(`Release bundle contains an unsupported special file: ${child}`);
    }
  };
  visit(root);
  return result;
}

export function validateMacDmgLayout(mountRoot) {
  const bundleName = 'FrostByte.app';
  const allowed = new Set(['.background', '.DS_Store', '.VolumeIcon.icns', 'Applications', bundleName]);
  const names = fs.readdirSync(mountRoot);
  const unexpected = names.filter(name => !allowed.has(name));
  if (unexpected.length) throw new Error(`The release DMG contains an unexpected top-level item: ${unexpected.sort()[0]}.`);
  const application = path.join(mountRoot, bundleName);
  if (!fs.lstatSync(application).isDirectory()) throw new Error(`The release DMG does not contain a real ${bundleName} directory.`);
  const applications = path.join(mountRoot, 'Applications');
  if (!fs.lstatSync(applications).isSymbolicLink() || fs.readlinkSync(applications) !== '/Applications') {
    throw new Error('The release DMG has an invalid Applications link.');
  }
  for (const name of ['.DS_Store', '.VolumeIcon.icns']) {
    const target = path.join(mountRoot, name);
    if (names.includes(name) && !fs.lstatSync(target).isFile()) throw new Error(`The release DMG has an invalid ${name}.`);
  }
  const background = path.join(mountRoot, '.background');
  if (names.includes('.background') && !fs.lstatSync(background).isDirectory()) throw new Error('The release DMG has an invalid .background folder.');
  return application;
}

function filesEqual(left, right, size) {
  const leftFd = fs.openSync(left, 'r'), rightFd = fs.openSync(right, 'r');
  const leftBuffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  const rightBuffer = Buffer.allocUnsafe(leftBuffer.length);
  try {
    for (let position = 0; position < size;) {
      const length = Math.min(leftBuffer.length, size - position);
      const leftRead = fs.readSync(leftFd, leftBuffer, 0, length, position);
      const rightRead = fs.readSync(rightFd, rightBuffer, 0, length, position);
      if (leftRead !== length || rightRead !== length || !leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))) return false;
      position += length;
    }
    return true;
  } finally {
    fs.closeSync(leftFd); fs.closeSync(rightFd);
  }
}

/** Compare the payload files and links, ignoring timestamps and empty directories. */
export function assertDirectoryParity(reviewedRoot, installedRoot, { allowedInstalledFiles = [], optionalInstalledFiles = [], optionalReviewedFiles = [] } = {}) {
  const reviewed = treeEntries(reviewedRoot), installed = treeEntries(installedRoot);
  const reviewedNames = [...reviewed.keys()].sort(), installedNames = [...installed.keys()].sort();
  if (!Array.isArray(allowedInstalledFiles) || allowedInstalledFiles.some(name => typeof name !== 'string' || !name || path.posix.normalize(name) !== name)) {
    throw new Error('The release installer verifier has an invalid installed-file allowance.');
  }
  if (!Array.isArray(optionalInstalledFiles) || optionalInstalledFiles.some(name => typeof name !== 'string' || !name || path.posix.normalize(name) !== name)) {
    throw new Error('The release installer verifier has an invalid optional installed-file allowance.');
  }
  if (!Array.isArray(optionalReviewedFiles) || optionalReviewedFiles.some(name => typeof name !== 'string' || !name || path.posix.normalize(name) !== name)) {
    throw new Error('The release installer verifier has an invalid optional reviewed-file allowance.');
  }
  const allowed = [...new Set(allowedInstalledFiles)].sort();
  const optional = [...new Set(optionalInstalledFiles)].sort();
  const optionalReviewed = [...new Set(optionalReviewedFiles)].sort();
  if (optional.some(name => allowed.includes(name)) || optionalReviewed.some(name => optional.includes(name) || allowed.includes(name))) {
    throw new Error('The release installer verifier repeats a file allowance.');
  }
  const extras = installedNames.filter(name => !reviewed.has(name)).sort();
  const comparableInstalled = installedNames.filter(name => !allowed.includes(name) && !optional.includes(name));
  const comparableReviewed = reviewedNames.filter(name => !optionalReviewed.includes(name) || installed.has(name));
  if (allowed.some(name => reviewed.has(name) || installed.get(name)?.type !== 'file')
    || optional.some(name => reviewed.has(name) || (installed.has(name) && installed.get(name)?.type !== 'file'))
    || optionalReviewed.some(name => installed.has(name) && !reviewed.has(name) || (reviewed.has(name) && reviewed.get(name)?.type !== 'file'))
    || extras.some(name => !allowed.includes(name) && !optional.includes(name))
    || allowed.some(name => !extras.includes(name))
    || JSON.stringify(comparableReviewed) !== JSON.stringify(comparableInstalled)) {
    throw new Error('The release installer payload differs from the reviewed application bundle.');
  }
  for (const name of reviewedNames) {
    const left = reviewed.get(name), right = installed.get(name);
    if (!right && optionalReviewed.includes(name)) continue;
    if (left.type !== right.type) throw new Error(`The release installer changed the type of ${name}.`);
    if (left.type === 'link') {
      if (left.value !== right.value) throw new Error(`The release installer changed the link ${name}.`);
      continue;
    }
    if (left.stat.size !== right.stat.size || (process.platform !== 'win32' && (left.stat.mode & 0o777) !== (right.stat.mode & 0o777))
      || !filesEqual(left.target, right.target, left.stat.size)) {
      throw new Error(`The release installer payload differs at ${name}.`);
    }
  }
  return true;
}

/** Compare every reviewed payload file/link while permitting package-container integration files. */
export function assertDirectoryContainsParity(reviewedRoot, installedRoot, { optionalReviewedFiles = [] } = {}) {
  const reviewed = treeEntries(reviewedRoot), installed = treeEntries(installedRoot);
  if (!Array.isArray(optionalReviewedFiles) || optionalReviewedFiles.some(name => typeof name !== 'string' || !name || path.posix.normalize(name) !== name)) {
    throw new Error('The packaged-container verifier has an invalid optional reviewed-file allowance.');
  }
  const optionalReviewed = new Set(optionalReviewedFiles);
  for (const [name, left] of reviewed) {
    const right = installed.get(name);
    if (!right && optionalReviewed.has(name) && left.type === 'file') continue;
    if (!right || left.type !== right.type) throw new Error(`The packaged container is missing or changed ${name}.`);
    if (left.type === 'link') {
      if (left.value !== right.value) throw new Error(`The packaged container changed the link ${name}.`);
      continue;
    }
    if (left.stat.size !== right.stat.size || (process.platform !== 'win32' && (left.stat.mode & 0o777) !== (right.stat.mode & 0o777))
      || !filesEqual(left.target, right.target, left.stat.size)) {
      throw new Error(`The packaged container payload differs at ${name}.`);
    }
  }
  return true;
}

function runWindowsInstaller(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertProcessSucceeded(result, label) {
  if (!result || result.error) throw result?.error || new Error(`${label} did not return a result.`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-2000);
    throw new Error(`${label} failed (${result.status ?? result.signal ?? 'unknown'}).${detail ? ` ${detail}` : ''}`);
  }
}

/**
 * Exercise the real NSIS extraction path in a disposable per-user directory.
 * Callers must use a clean Windows account: NSIS upgrade discovery is global to
 * that account even when /D selects an isolated destination.
 */
export function assertWindowsInstallerParity(installer, reviewedRoot, {
  run = runWindowsInstaller,
  tempDirectory = os.tmpdir(),
} = {}) {
  const installerStat = fs.lstatSync(installer);
  if (!installerStat.isFile() || installerStat.isSymbolicLink()) throw new Error('The Windows installer must be a regular file.');
  const installRoot = fs.mkdtempSync(path.join(tempDirectory, 'frostbyte-nsis-install-'));
  const uninstallerName = 'Uninstall FrostByte.exe';
  const uninstaller = path.join(installRoot, uninstallerName);
  let failure;
  let cleanupFailure;
  try {
    assertProcessSucceeded(run(installer, ['/S', `/D=${installRoot}`], { phase: 'install', installRoot }), 'The isolated NSIS installation');
    let uninstallerStat;
    try { uninstallerStat = fs.lstatSync(uninstaller); }
    catch (error) {
      if (error?.code === 'ENOENT') throw new Error('The isolated NSIS installation did not create its uninstaller.');
      throw error;
    }
    if (!uninstallerStat.isFile() || uninstallerStat.isSymbolicLink()) throw new Error('The isolated NSIS installation did not create a safe uninstaller.');
    assertDirectoryParity(reviewedRoot, installRoot, { allowedInstalledFiles: [uninstallerName] });
  } catch (error) {
    failure = error;
  } finally {
    try {
      const current = fs.lstatSync(uninstaller);
      if (!current.isFile() || current.isSymbolicLink()) throw new Error('The isolated NSIS uninstaller changed before cleanup.');
      assertProcessSucceeded(run(uninstaller, ['/S', `_?=${installRoot}`], { phase: 'uninstall', installRoot }), 'The isolated NSIS cleanup');
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupFailure = error;
    }
    try {
      fs.rmSync(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      cleanupFailure ||= error;
    }
  }
  if (failure && cleanupFailure) {
    throw new Error(`${failure.message} Cleanup also failed: ${cleanupFailure.message}`, { cause: failure });
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return true;
}
