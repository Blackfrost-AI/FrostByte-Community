import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { listPackage, extractFile } from '@electron/asar';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { chromium } from '@playwright/test';
import { assertDirectoryContainsParity, assertDirectoryParity, assertInstallerFilename, assertWindowsInstallerParity, requireMacSigningIdentity, requireWindowsSigningSubject, validateMacCodeSigning, validateMacDmgLayout, validateWindowsAuthenticode } from './release-artifacts.js';
import { sparkCompanionSources } from './spark-companion-files.js';
import { PrivacyService } from '../src/main/privacy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { manifestFor, DEFAULT_EDITION_ID } = require('../src/shared/edition-manifest.cjs');
const sourceMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const testArgs = process.argv.slice(2);
const takeFlag = name => {
  const index = testArgs.indexOf(name);
  if (index < 0) return false;
  testArgs.splice(index, 1);
  return true;
};
const takeValue = name => {
  const index = testArgs.indexOf(name);
  if (index < 0) return null;
  if (!testArgs[index + 1] || testArgs[index + 1].startsWith('--')) throw new Error(`${name} requires a path.`);
  return path.resolve(testArgs.splice(index, 2)[1]);
};
const takeValues = name => {
  const values = [];
  for (;;) {
    const value = takeValue(name);
    if (!value) return values;
    values.push(value);
  }
};
const requireReleaseSignature = takeFlag('--require-release-signature');
const lifecycleSmoke = takeFlag('--lifecycle-smoke');
const explicitCommunityBuild = takeFlag('--community-build');
// Which edition is being verified must come from what the build was asked to
// produce, never from the artifact itself — otherwise the check is circular.
// An explicit flag wins, then FROSTBYTE_EDITION, then the source default.
const expectedEdition = manifestFor(
  explicitCommunityBuild ? 'community'
    : process.env.FROSTBYTE_EDITION ?? sourceMetadata.frostbyteEdition ?? DEFAULT_EDITION_ID,
);
const isolatedInstallerCheck = takeFlag('--isolated-installer-check');
const requireLinuxSandbox = takeFlag('--require-linux-sandbox');
const installers = takeValues('--installer');
const installer = installers[0] ?? null;
// Publisher-bound native checks apply to the shipped artifact. Edition controls
// identity, not signing policy.
const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const linux = process.platform === 'linux';
if (!windows && !mac && !linux) throw new Error('Packaged desktop tests require macOS, Windows, or Linux.');
if (!linux && installers.length > 1) throw new Error('Only Linux has more than one native installer format.');
if (linux && requireReleaseSignature) throw new Error('Linux publisher verification uses a separately signed checksum record, not --require-release-signature.');
if (requireLinuxSandbox && !linux) throw new Error('--require-linux-sandbox is only supported on Linux.');
if (isolatedInstallerCheck && !windows) throw new Error('--isolated-installer-check is only supported on Windows.');
if (isolatedInstallerCheck && !installer) throw new Error('--isolated-installer-check requires --installer.');
if (windows && installer && !isolatedInstallerCheck) {
  throw new Error('Windows installer verification requires --isolated-installer-check on a disposable test account.');
}
if (isolatedInstallerCheck && process.env.CI !== 'true' && process.env.FROSTBYTE_ALLOW_ISOLATED_INSTALLER_CHECK !== '1') {
  throw new Error('The isolated NSIS check can replace an existing per-user installation. Run it on CI or set FROSTBYTE_ALLOW_ISOLATED_INSTALLER_CHECK=1 on a disposable Windows account.');
}
const outputDirectory = expectedEdition.outputDirectory;
const defaultBundle = path.join(root, windows ? `${outputDirectory}/win-unpacked`
  : mac ? `${outputDirectory}/mac-arm64/${expectedEdition.macApp}`
    : `${outputDirectory}/linux-unpacked`);
// Preserve the existing explicit bundle argument while allowing an omitted bundle
// followed by a test allowlist, without mistaking a .spec.js file for the app.
const first = testArgs[0];
const explicitBundle = first && !first.startsWith('--') && (/\.(?:app|exe)$/i.test(first)
  || (fs.existsSync(first) && (fs.statSync(first).isDirectory() || (linux && fs.statSync(first).isFile()))));
const selected = path.resolve(explicitBundle ? testArgs.shift() : defaultBundle);
let bundle = windows && /\.exe$/i.test(selected) ? path.dirname(selected) : selected;
let executable;
if (windows) {
  executable = /\.exe$/i.test(selected) ? selected : path.join(bundle, expectedEdition.winExecutable);
} else if (mac) {
  const info = path.join(bundle, 'Contents/Info.plist');
  const result = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', info], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout.trim() || /[\/\0\r\n]/.test(result.stdout.trim())) {
    throw result.error || new Error(`Could not read the packaged executable name: ${(result.stderr || '').trim()}`);
  }
  executable = path.join(bundle, 'Contents/MacOS', result.stdout.trim());
} else {
  if (fs.existsSync(selected) && fs.statSync(selected).isFile()) {
    executable = fs.realpathSync(selected);
    bundle = path.dirname(executable);
  } else executable = path.join(bundle, expectedEdition.linuxExecutable);
}
const resources = path.join(bundle, mac ? 'Contents/Resources' : 'resources');
const ipfsRuntimeDirectory = path.join(resources, 'ipfs-runtime');
const ipfsRuntimeFile = path.join(ipfsRuntimeDirectory, windows ? 'ipfs.exe' : 'ipfs');
const ipfsReceipt = JSON.parse(fs.readFileSync(path.join(ipfsRuntimeDirectory, 'runtime.json')));
const ipfsManifest = JSON.parse(fs.readFileSync(path.join(root, 'build/ipfs-runtime.json')));
const ipfsTarget = ipfsManifest.targets[`${process.platform}-${process.arch}`];
if (!ipfsTarget || !fs.lstatSync(ipfsRuntimeFile).isFile() || fs.lstatSync(ipfsRuntimeFile).isSymbolicLink()
  || ipfsReceipt.version !== ipfsManifest.version || ipfsReceipt.archiveSha256 !== ipfsTarget.sha256
  || ipfsReceipt.binarySha256 !== crypto.createHash('sha256').update(fs.readFileSync(ipfsRuntimeFile)).digest('hex')) {
  throw new Error('The packaged IPFS runtime is missing, stale or fails its signed-byte checksum.');
}
const windowsSigningSubject = requireReleaseSignature && windows ? requireWindowsSigningSubject(process.env.FROSTBYTE_WINDOWS_SIGNING_SUBJECT) : null;
const macSigningIdentity = requireReleaseSignature && mac ? requireMacSigningIdentity(process.env.FROSTBYTE_MAC_SIGNING_IDENTITY) : null;
const platformScript = windows ? 'win' : mac ? 'mac' : 'linux';
if (!fs.existsSync(executable)) throw new Error(`Build the app first: npm run dist:${platformScript}. Missing ${executable}`);
for (const file of installers) if (!fs.existsSync(file)) throw new Error(`Installer does not exist: ${file}`);

const fusePolicy = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
  WasmTrapHandlers: true,
};
const fuseWire = await getCurrentFuseWire(mac ? bundle : executable);
const knownFuses = Object.keys(FuseV1Options).filter(name => Number.isNaN(Number(name)));
const binaryFuses = Object.keys(fuseWire).filter(name => /^\d+$/.test(name));
if (binaryFuses.length !== knownFuses.length) {
  throw new Error(`Electron exposes ${binaryFuses.length} fuses but the pinned verifier knows ${knownFuses.length}; review the new fuse before release.`);
}
for (const [name, enabled] of Object.entries(fusePolicy)) {
  const actual = fuseWire[FuseV1Options[name]];
  const expected = enabled ? '1'.charCodeAt(0) : '0'.charCodeAt(0);
  if (actual !== expected) throw new Error(`Unsafe Electron fuse: ${name} must be ${enabled ? 'enabled' : 'disabled'}.`);
}

function commandOutput(command, args, { stdoutOnly = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return stdoutOnly ? result.stdout || '' : `${result.stdout || ''}\n${result.stderr || ''}`;
}

function assertMacRelease() {
  if (!installer) throw new Error('A macOS release check requires --installer pointing to the distributed DMG.');
  const details = commandOutput('codesign', ['-dv', '--verbose=4', bundle]);
  if (/Signature=adhoc/i.test(details) || !/Authority=Developer ID Application:/i.test(details)) {
    throw new Error('Release bundle is not signed by a Developer ID Application identity.');
  }
  if (!/TeamIdentifier=[A-Z0-9]{10}/.test(details)) throw new Error('Release bundle has no valid Apple TeamIdentifier.');
  validateMacCodeSigning(details, macSigningIdentity.authority);
  if (!/^CodeDirectory .*\bflags=.*\bruntime\b/im.test(details)) throw new Error('Release bundle does not enforce the hardened runtime.');

  const machoMagic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  const pending = [bundle];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(target);
      else if (entry.isFile()) {
        const fd = fs.openSync(target, 'r');
        const magic = Buffer.alloc(4);
        try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (!machoMagic.has(magic.toString('hex'))) continue;
        const entitlements = commandOutput('codesign', ['-d', '--entitlements', '-', target]);
        if (entitlements.includes('com.apple.security.cs.disable-library-validation')) {
          throw new Error(`Release code disables Apple library validation: ${path.relative(bundle, target)}`);
        }
      }
    }
  }
  execFileSync('xcrun', ['stapler', 'validate', bundle], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle], { stdio: 'inherit' });
  if (installer) {
    if (path.extname(installer).toLowerCase() !== '.dmg') throw new Error('The macOS release installer check requires the distributed DMG.');
    execFileSync('xcrun', ['stapler', 'validate', installer], { stdio: 'inherit' });
    execFileSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', installer], { stdio: 'inherit' });
  }
}

function authenticode(file) {
  const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $args[0]; [pscustomobject]@{Status=[string]$s.Status;SignatureType=[string]$s.SignatureType;Subject=[string]$s.SignerCertificate.Subject;Thumbprint=[string]$s.SignerCertificate.Thumbprint;TimestampSubject=[string]$s.TimeStamperCertificate.Subject;TimestampThumbprint=[string]$s.TimeStamperCertificate.Thumbprint}|ConvertTo-Json -Compress";
  const output = commandOutput('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, file]);
  const json = output.split(/\r?\n/).find(line => line.trimStart().startsWith('{'));
  if (!json) throw new Error(`PowerShell returned no Authenticode result for ${file}.`);
  const value = JSON.parse(json);
  validateWindowsAuthenticode(value, file, windowsSigningSubject);
}

if (mac) {
  require('../build/macos-identity.cjs').verifyMacBundleIdentity(bundle, expectedEdition.appId, sourceMetadata.version);
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  if (requireReleaseSignature) assertMacRelease();
} else if (windows) {
  const fd = fs.openSync(executable, 'r');
  try {
    const dos = Buffer.alloc(64), pe = Buffer.alloc(6);
    if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ'
      || fs.readSync(fd, pe, 0, pe.length, dos.readUInt32LE(0x3c)) !== pe.length || pe.toString('ascii', 0, 4) !== 'PE\0\0'
      || pe.readUInt16LE(4) !== 0x8664) throw new Error('The Windows package must contain a valid x64 executable.');
  } finally { fs.closeSync(fd); }
  if (requireReleaseSignature) {
    if (!installer || path.extname(installer).toLowerCase() !== '.exe') throw new Error('A Windows release check requires --installer pointing to the distributed NSIS .exe.');
    authenticode(executable);
    authenticode(installer);
  }
} else {
  const fd = fs.openSync(executable, 'r');
  try {
    const elf = Buffer.alloc(20);
    if (fs.readSync(fd, elf, 0, elf.length, 0) !== elf.length
      || !elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(18) !== 0x3e) {
      throw new Error('The Linux package must contain a valid x64 ELF executable.');
    }
  } finally { fs.closeSync(fd); }
  fs.accessSync(executable, fs.constants.X_OK);
}
const asar = path.join(resources, 'app.asar');
const readArchived = file => extractFile(asar, path.normalize(file));
const entries = new Set(listPackage(asar).map(file => file.replaceAll('\\', '/')));
const packagedMetadata = JSON.parse(readArchived('package.json'));
// Identity fields are deliberately rewritten per edition by the builder's
// `extraMetadata`, so they are checked against the expected edition's manifest
// rather than against the source package.json. Everything else must be byte
// identical — that is the staleness guard, and it stays strict for both editions.
const identityFields = ['name', 'productName', 'desktopName', 'frostbyteEdition', 'description'];
for (const field of identityFields) {
  const expected = expectedEdition.packageFields[field];
  if (!isDeepStrictEqual(packagedMetadata[field], expected)) {
    throw new Error(`Packaged application identity is wrong for the ${expectedEdition.id} edition: ${field} is ${JSON.stringify(packagedMetadata[field])}, expected ${JSON.stringify(expected)}`);
  }
}
for (const field of ['version', 'homepage', 'license', 'type', 'main', 'dependencies', 'engines']) {
  if (!isDeepStrictEqual(packagedMetadata[field], sourceMetadata[field])) {
    throw new Error(`Packaged application metadata is stale: ${field}`);
  }
}
function filesBelow(directory) {
  const result = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      // Python test runs can leave bytecode caches beside the dormant hostd
      // source. electron-builder excludes these transient files, so they are
      // not part of the packaged-source parity contract.
      if (entry.isDirectory() && entry.name === '__pycache__') continue;
      if (entry.isDirectory()) { visit(target); continue; }
      if (entry.isFile() && /\.py[co]$/i.test(entry.name)) continue;
      if (entry.isFile()) { result.push(path.relative(root, target).replaceAll('\\', '/')); continue; }
      throw new Error(`Packaged source contains an unsupported link or special file: ${path.relative(root, target)}`);
    }
  };
  visit(directory);
  return result.sort();
}
// electron-builder includes src/**. Compare every current source file so adding
// a new imported module cannot silently escape the release parity check.
const currentSourceFiles = filesBelow(path.join(root, 'src'));
for (const file of currentSourceFiles) {
  if (file.startsWith('src/hostd/')) continue;
  if (!entries.has('/' + file)) throw new Error(`Required packaged source is missing: ${file}`);
  if (!readArchived(file).equals(fs.readFileSync(path.join(root, file)))) throw new Error(`Packaged source is stale: ${file}`);
}
const jensenAssets = JSON.parse(fs.readFileSync(path.join(root, 'assets/brand/jensen/sources.json'), 'utf8')).map(item => item.asset);
for (const file of ['src/shared/legal.json', 'src/shared/reports.js', 'LICENSES.third-party.txt',
  'node_modules/ssh2/lib/index.js', 'assets/brand/app-icon.png', 'assets/brand/logo-dark.png',
  'assets/brand/aeon-orb.png', 'assets/fonts/Orbitron.ttf', 'assets/fonts/ShareTechMono-Regular.ttf',
  'assets/fonts/Manrope.ttf', 'assets/fonts/SpaceGrotesk.ttf', 'assets/brand/blackfrost/frozen-lake.png',
  ...jensenAssets]) {
  if (!entries.has('/' + file)) throw new Error(`Required runtime asset is missing: ${file}`);
  if (!readArchived(file).equals(fs.readFileSync(path.join(root, file)))) throw new Error(`Packaged runtime asset is stale: ${file}`);
}
for (const file of ['glacier.jpg', 'blizzard.png']) {
  if (entries.has('/assets/brand/blackfrost/' + file)) throw new Error('Retired promotional artwork was packaged: ' + file);
}
if (!readArchived('src/shared/device-photos.js').equals(fs.readFileSync(path.join(root, 'src/shared/device-photos.js')))) throw new Error('Packaged device photo catalog is stale.');
for (const file of fs.readdirSync(path.join(root, 'assets/devices'))) {
  if (!readArchived('assets/devices/' + file).equals(fs.readFileSync(path.join(root, 'assets/devices', file)))) throw new Error('Packaged device artwork is stale: ' + file);
}
if (JSON.parse(readArchived('catalog/starter.json')).models.length) throw new Error('Packaged catalog contains demo models.');
if (packagedMetadata.license !== expectedEdition.packageFields.license) throw new Error('Packaged app has unexpected original-code licensing metadata.');
const expectedLicense = fs.readFileSync(path.join(root, expectedEdition.licenseFile));
// electron-builder deliberately excludes extraResources from ASAR. Verify the
// complete user-readable Legal resources, not a second in-archive copy.
if (!fs.readFileSync(path.join(resources, 'Legal/LICENSE.txt')).equals(expectedLicense)) throw new Error('Packaged license differs from the selected edition.');
if (!expectedEdition.private && !fs.readFileSync(path.join(resources, 'Legal/NOTICE.txt')).equals(fs.readFileSync(path.join(root, 'NOTICE')))) throw new Error('Packaged Community attribution notice is missing or stale.');
for (const relative of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'licenses/electron/LICENSE', 'licenses/electron/LICENSES.chromium.html', 'licenses/native/README.md', 'licenses/native/node-datachannel-MPL-2.0.txt', 'licenses/npm-inventory.json', 'licenses/ipfs/LICENSE', 'licenses/ipfs/LICENSE-MIT', 'licenses/ipfs/LICENSE-APACHE', 'licenses/ipfs/GO-LICENSE', 'licenses/ipfs/go-inventory.json']) {
  if (!fs.statSync(path.join(resources, 'Legal', relative)).size) throw new Error(`Packaged legal notice is missing: ${relative}`);
}
assertDirectoryParity(path.join(root, 'licenses/ipfs'), path.join(resources, 'Legal/licenses/ipfs'));
assertDirectoryParity(path.join(root, 'licenses/fonts'), path.join(resources, 'Legal/licenses/fonts'));
if ([...entries].some(file => /^\/(tests|test-results|scripts|\.git)(\/|$)/.test(file))) throw new Error('Development files leaked into the application.');
const hostdPayload = [
  'src/hostd/frostbyte_hostd.py',
  'src/hostd/install_user.py',
];
for (const font of JSON.parse(fs.readFileSync(path.join(root, 'assets/fonts/sources.json')))) {
  const notice = path.join(resources, 'Legal', font.license);
  if (!fs.existsSync(notice) || !fs.readFileSync(notice).equals(fs.readFileSync(path.join(root, font.license)))) throw new Error(`Packaged font notice is missing or stale: ${font.family}`);
}
for (const file of hostdPayload) {
  const packaged = path.join(resources, 'hostd', path.basename(file));
  if (!fs.existsSync(packaged)) throw new Error(`Required packaged hostd resource is missing: ${file}`);
  if (!fs.readFileSync(packaged).equals(fs.readFileSync(path.join(root, file)))) throw new Error(`Packaged hostd resource is stale: ${file}`);
}
const companion = path.join(resources, 'spark-companion');
const manifest = JSON.parse(fs.readFileSync(path.join(companion, 'manifest.json')));
if (manifest.version !== packagedMetadata.version) throw new Error('Packaged companion version differs from the desktop app.');
for (const [name, hash] of [['source.tar.gz', manifest.sha256], ['onboard.py', manifest.installerSha256], ['mac-onboard.py', manifest.macInstallerSha256]]) {
  const bytes = fs.readFileSync(path.join(companion, name));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Packaged companion integrity check failed: ${name}`);
}
if (!fs.readFileSync(path.join(companion, 'onboard.py')).equals(fs.readFileSync(path.join(root, 'build/spark-onboard.py')))
  || !fs.readFileSync(path.join(companion, 'mac-onboard.py')).equals(fs.readFileSync(path.join(root, 'build/mac-onboard.py')))) {
  throw new Error('Packaged companion installer differs from the reviewed source.');
}
const companionArchive = path.join(companion, 'source.tar.gz');
// GNU tar warns about macOS PAX extended attributes on stderr. Those warnings
// are not file names; still fail on a nonzero exit and preserve its diagnostics.
const archiveEntries = commandOutput('tar', ['-tzf', companionArchive], { stdoutOnly: true }).split(/\r?\n/).map(value => value.trim()).filter(Boolean).sort();
const expectedCompanionEntries = ['package.json', 'package-lock.json', ...sparkCompanionSources].sort();
if (JSON.stringify(archiveEntries) !== JSON.stringify(expectedCompanionEntries)) {
  throw new Error('Packaged companion archive contains a missing or unexpected source file.');
}
for (const file of sparkCompanionSources) {
  const archived = execFileSync('tar', ['-xOzf', companionArchive, file], { maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!archived.equals(fs.readFileSync(path.join(root, file)))) throw new Error(`Packaged companion source is stale: ${file}`);
}

function filesNamedBelow(directory, predicate) {
  const result = [];
  const pending = [directory];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (++visited > 50_000) throw new Error('The Linux package extraction contains too many entries.');
      const target = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(target);
      else if (entry.isFile() && predicate(target, entry.name)) result.push(target);
    }
  }
  return result;
}

function linuxPayloadRoot(extractionRoot) {
  const asars = filesNamedBelow(extractionRoot, (target, name) => name === 'app.asar' && path.basename(path.dirname(target)) === 'resources');
  if (asars.length !== 1) throw new Error('The Linux installer must contain exactly one application payload.');
  return path.dirname(path.dirname(asars[0]));
}

function assertLinuxDesktopIntegration(extractionRoot, { appImage = false } = {}) {
  const entries = filesNamedBelow(extractionRoot, (_target, name) => name.endsWith('.desktop'));
  const expectedName = expectedEdition.packageFields.productName;
  const expectedExecutable = expectedEdition.linuxExecutable;
  const matching = entries.map(file => fs.readFileSync(file, 'utf8')).filter(value => value.includes(`Name=${expectedName}\n`));
  if (matching.length !== 1) throw new Error('The Linux package must contain exactly one FrostByte desktop entry.');
  const desktop = matching[0];
  const mimeLine = /^MimeType=([^\r\n]+)$/m.exec(desktop)?.[1] || '';
  const mimeTypes = new Set(mimeLine.split(';').filter(Boolean));
  for (const mime of ['application/x-bittorrent', 'x-scheme-handler/magnet', 'x-scheme-handler/ipfs', 'x-scheme-handler/frostbyte']) {
    if (!mimeTypes.has(mime)) throw new Error(`The Linux desktop entry is missing ${mime}.`);
  }
  const execLine = /^Exec=([^\r\n]+)$/m.exec(desktop)?.[1] || '';
  let installedExec = `/opt/${expectedName}/${expectedExecutable}`;
  if (!/^[/0-9A-Za-z._-]+$/.test(installedExec)) installedExec = `"${installedExec}"`;
  const expectedExec = appImage ? 'AppRun %U' : `${installedExec} %U`;
  if (execLine !== expectedExec) {
    throw new Error('The Linux desktop entry does not route URLs and files to the packaged executable.');
  }
  if (!desktop.includes(`StartupWMClass=${expectedExecutable}\n`)) throw new Error('The Linux desktop entry has the wrong window identity.');
}

function assertLinuxPackageMetadata(payload) {
  const file = path.join(payload, 'resources', 'apparmor-profile');
  if (fs.existsSync(file)) {
    const expectedExecutable = expectedEdition.linuxExecutable;
    const installName = expectedEdition.packageFields.productName;
    const expected = `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile "${expectedExecutable}" "/opt/${installName}/${expectedExecutable}" flags=(unconfined) {\n  userns,\n\n  # Site-specific additions and overrides. See local/README for details.\n  include if exists <local/${expectedExecutable}>\n}`;
    if (fs.readFileSync(file, 'utf8') !== expected) throw new Error('The Debian package contains an unexpected AppArmor profile.');
  }
  const packageType = path.join(payload, 'resources', 'package-type');
  // electron-builder only emits package-type when a built-in publisher also
  // generated app-update.yml. FrostByte performs metadata-only update checks
  // against its own service, so the file is normally absent. If a publisher is
  // configured later, still reject stale or mismatched package metadata.
  if (fs.existsSync(packageType) && fs.readFileSync(packageType, 'utf8') !== 'deb') {
    throw new Error('The Debian package has invalid update package metadata.');
  }
}

function assertLinuxInstallerParity(file) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-linux-payload-'));
  const targetMetadata = ['resources/apparmor-profile', 'resources/package-type'];
  try {
    if (file.endsWith('.AppImage')) {
      fs.accessSync(file, fs.constants.X_OK);
      const result = spawnSync(file, ['--appimage-extract'], {
        cwd: temporary,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        throw result.error || new Error(`Could not extract the AppImage: ${(result.stderr || result.stdout).trim()}`);
      }
      const extractionRoot = path.join(temporary, 'squashfs-root');
      assertDirectoryContainsParity(bundle, linuxPayloadRoot(extractionRoot), { optionalReviewedFiles: targetMetadata });
      assertLinuxDesktopIntegration(extractionRoot, { appImage: true });
      return;
    }
    if (!file.endsWith('.deb')) throw new Error('Linux installer verification requires an AppImage or .deb package.');
    const architecture = commandOutput('dpkg-deb', ['--field', file, 'Architecture']).trim();
    const packageName = commandOutput('dpkg-deb', ['--field', file, 'Package']).trim();
    const depends = commandOutput('dpkg-deb', ['--field', file, 'Depends']);
    const recommends = commandOutput('dpkg-deb', ['--field', file, 'Recommends']);
    if (architecture !== 'amd64' || packageName !== expectedEdition.packageName) {
      throw new Error('The Debian package has the wrong package name or architecture.');
    }
    for (const dependency of ['libsecret-1-0', 'libnotify4', 'xdg-utils', 'libgbm1']) {
      if (!new RegExp(`(?:^|[,\\s])${dependency.replaceAll('-', '\\-')}(?:$|[,\\s])`).test(depends)) {
        throw new Error(`The Debian package is missing its ${dependency} dependency.`);
      }
    }
    if (!/(?:^|,\s*)libasound2t64\s*\|\s*libasound2(?:\s*,|$)/.test(depends.trim())) {
      throw new Error('The Debian package must declare ALSA for both t64 and older distributions.');
    }
    if (!/(?:^|[,\s])openssh-client(?:$|[,\s])/.test(recommends)) throw new Error('The Debian package should recommend openssh-client.');
    execFileSync('dpkg-deb', ['--extract', file, temporary], { stdio: 'inherit' });
    const payload = linuxPayloadRoot(temporary);
    const optionalInstalledFiles = targetMetadata.filter(relative => !fs.existsSync(path.join(bundle, relative)) && fs.existsSync(path.join(payload, relative)));
    const optionalReviewedFiles = targetMetadata.filter(relative => fs.existsSync(path.join(bundle, relative)) && !fs.existsSync(path.join(payload, relative)));
    assertDirectoryParity(bundle, payload, {
      ...(optionalInstalledFiles.length ? { optionalInstalledFiles } : {}),
      ...(optionalReviewedFiles.length ? { optionalReviewedFiles } : {}),
    });
    assertLinuxPackageMetadata(payload);
    assertLinuxDesktopIntegration(temporary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function assertInstallerParity(file) {
  assertInstallerFilename(file, process.platform, packagedMetadata.version);
  if (windows) {
    assertWindowsInstallerParity(file, bundle);
    return;
  }
  if (linux) {
    assertLinuxInstallerParity(file);
    return;
  }

  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-dmg-payload-'));
  let attached = false;
  let failure;
  try {
    commandOutput('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, file]);
    attached = true;
    const installedBundle = validateMacDmgLayout(mountPoint);
    assertDirectoryParity(bundle, installedBundle);
  } catch (error) {
    failure = error;
  } finally {
    if (attached) {
      let detached = spawnSync('hdiutil', ['detach', mountPoint], { encoding: 'utf8', windowsHide: true });
      if (detached.error || detached.status !== 0) detached = spawnSync('hdiutil', ['detach', '-force', mountPoint], { encoding: 'utf8', windowsHide: true });
      if (!detached.error && detached.status === 0) attached = false;
      else if (!failure) failure = detached.error || new Error(`Could not detach the verified DMG: ${(detached.stderr || detached.stdout).trim()}`);
    }
    if (!attached) try { fs.rmSync(mountPoint, { recursive: true, force: true }); } catch { /* temporary mount folder cleanup */ }
  }
  if (failure) throw failure;
}

for (const file of installers) assertInstallerParity(file);

async function assertNativeLaunch(target = executable, { appImage = false, requireSandbox = false } = {}) {
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-packaged-smoke-')));
  if (lifecycleSmoke) {
    const destination = path.join(profile, 'downloads'), model = path.join(destination, 'fixture', 'packaged');
    fs.mkdirSync(model, { recursive: true }); fs.writeFileSync(path.join(model, 'model.gguf'), 'isolated packaged QA bytes');
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ downloadDir: destination, upnpEnabled: false, dhtEnabled: false, autoCheckUpdates: false, confirmExitSeeding: false }));
    fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ hfDownloads: [{ repoId: 'fixture/packaged', revision: 'a'.repeat(40), filePath: 'model.gguf', baseDir: destination, dest: path.join(model, 'model.gguf'), status: 'done', total: 26, downloaded: 26 }],
      userCatalog: [{ name: 'Packaged saved link', infohash: 'b'.repeat(40), source: 'user' }] }));
    // Fixture of an existing consenting profile, never the owner's profile.
    const privacy = new PrivacyService({ directory: profile, version: sourceMetadata.version });
    privacy.accept({ accepted: true, diagnosticsEnabled: false, termsVersion: privacy.status().termsVersion, privacyVersion: privacy.status().privacyVersion });
  }
  let output = '';
  let endpoint;
  let endpointReady;
  const endpointPromise = new Promise(resolve => { endpointReady = resolve; });
  const launchArguments = ['--remote-debugging-port=0'];
  if (linux) {
    if (requireSandbox) {
      // Debian exposes the app through update-alternatives. Resolve that
      // launcher before checking the sandbox helper installed beside Electron.
      const sandbox = path.join(path.dirname(fs.realpathSync(target)), 'chrome-sandbox');
      const metadata = fs.statSync(sandbox);
      const mode = metadata.mode & 0o4777;
      if (metadata.uid !== 0 || (mode !== 0o0755 && mode !== 0o4755)) {
        throw new Error('The installed Linux chrome-sandbox must be root-owned with mode 0755 or 4755.');
      }
    }
  }
  const child = spawn(target, launchArguments, {
    cwd: root,
    env: { ...process.env, FROSTBYTE_HOME: profile, ELECTRON_ENABLE_LOGGING: '1',
      ...(appImage && { APPIMAGE_EXTRACT_AND_RUN: '1' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const append = chunk => {
    output = (output + chunk).slice(-32 * 1024);
    const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
    if (!endpoint && match) { endpoint = match[1]; endpointReady(endpoint); }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const stopped = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let failure;
  let browser;
  const bounded = (promise, milliseconds, label) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out; check for a macOS Keychain or permission prompt.`)), milliseconds);
    })]).finally(() => clearTimeout(timer));
  };
  try {
    const outcome = await Promise.race([
      endpointPromise.then(value => ({ endpoint: value })),
      stopped.then(value => ({ stopped: value })),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 15_000)),
    ]);
    if (outcome.stopped) {
      failure = outcome.stopped.error?.message || `exit ${outcome.stopped.code ?? 'unknown'}${outcome.stopped.signal ? ` (${outcome.stopped.signal})` : ''}`;
    } else if (outcome.timeout) failure = 'timed out before exposing its renderer';
    else {
      const url = new URL(outcome.endpoint);
      if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`Unexpected DevTools endpoint: ${outcome.endpoint}`);
      browser = await chromium.connectOverCDP(outcome.endpoint, { timeout: 10_000 });
      const deadline = Date.now() + 10_000;
      let page;
      while (!page && Date.now() < deadline) {
        page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('frostbyte://app/'));
        if (!page) await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!page) throw new Error('The packaged renderer did not open on frostbyte://app/.');
      page.setDefaultTimeout(15000);
      console.log('Packaged native renderer connected; checking assets.');
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      const expectedTitle = expectedEdition.displayName;
      const actualTitle = await bounded(page.title(), 30_000, 'Packaged renderer response');
      if (page.url() !== 'frostbyte://app/renderer/index.html' || actualTitle !== expectedTitle) {
        throw new Error(`Unexpected packaged renderer: ${page.url()} (${actualTitle})`);
      }
      const text = await page.locator('body').innerText({ timeout: 10_000 });
      if (!text.includes('FROST') || !text.includes('BYTE')) throw new Error('The packaged renderer opened without its application shell.');
      // Validate actual native protocol/font loading while first-launch consent
      // remains visible. This does not unlock the app or enable a test bypass.
      const themeAssets = await Promise.race([page.evaluate(async () => {
        const fonts = await Promise.all(['AeonDisplay', 'AeonMono', 'KeysPixel', 'BlackfrostUI', 'SpaceGroteskUI'].map(async family => {
          const loaded = await document.fonts.load(`12px ${family}`);
          return loaded.length > 0 && loaded.every(face => face.status === 'loaded');
        }));
        const marks = [...document.querySelectorAll('img.brand-icon')];
        await Promise.all(marks.map(image => image.decode()));
        return fonts.every(Boolean) && marks.length === 3 && marks.every(image => image.naturalWidth > 0);
      }), new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged theme asset verification timed out.')), 10000))]);
      if (!themeAssets) throw new Error('The packaged theme marks or fonts did not load.');
      await page.waitForFunction(() => window.frostbyte);
      const privacyStatus = await page.evaluate(() => window.frostbyte.getPrivacy());
      if (!privacyStatus.ok || privacyStatus.data.diagnosticsEnabled !== false || privacyStatus.data.collectionEnabled !== false
        || privacyStatus.data.lastStatus !== 'disabled' || privacyStatus.data.lastSentAt !== null || privacyStatus.data.feedbackMode !== 'github') {
        throw new Error('The packaged privacy service must disable collection and automatic reporting.');
      }
      if (await page.locator('#set-diagnostics, #welcome-diagnostics').count()) throw new Error('The packaged app must not expose diagnostic collection controls.');
      if (await page.locator('#nav [data-tab="workspace"]').count()) throw new Error('The Community package exposes a retired Workspace navigation entry.');
      if (!lifecycleSmoke) {
        if (!privacyStatus.data.required) throw new Error('A fresh packaged profile must review the current welcome and privacy notice.');
        await page.locator('#welcome').waitFor({ state: 'visible' });
        const welcome = await page.locator('#welcome').innerText();
        if (!welcome.includes(`Welcome to FrostByte ${sourceMetadata.version}.`)
          || !welcome.includes(`VERSION ${sourceMetadata.version}`)
          || !welcome.includes('No data collection.')
          || !welcome.includes('Community source publication is in preparation') || !welcome.includes('Blackfrost AI/SI')) {
          throw new Error(`The packaged v${sourceMetadata.version} welcome or source-publication announcement is missing.`);
        }
        const welcomeVersionBadge = (await page.locator('#welcome-version').textContent())?.trim();
        const welcomeTitleVersion = (await page.locator('#welcome-version-number').textContent())?.trim();
        if (welcomeVersionBadge !== `VERSION ${sourceMetadata.version}` || welcomeTitleVersion !== sourceMetadata.version) {
          throw new Error(`The packaged welcome must report the active ${sourceMetadata.version} version.`);
        }
        if (await page.locator('#accept-terms').isChecked()) throw new Error('Packaged welcome consent must not be preselected.');
        await page.locator('#welcome-feedback').waitFor({ state: 'visible' });
        if (process.env.FROSTBYTE_QA_OUTPUT) { fs.mkdirSync(process.env.FROSTBYTE_QA_OUTPUT, { recursive: true }); await page.screenshot({ path: path.join(process.env.FROSTBYTE_QA_OUTPUT, 'packaged-welcome.png') }); }
        console.log(`Verified native v${sourceMetadata.version} welcome, source date, optional GitHub feedback and no data collection.`);
      } else if (privacyStatus.data.required) throw new Error('The isolated consenting profile did not retain its local acceptance.');
      if (lifecycleSmoke) {
        console.log('Packaged native assets verified; checking entry workflows.');
        await page.waitForFunction(() => window.frostbyte && document.querySelector('#nav .nav.on'));
        await page.locator('#nav [data-tab="library"]').click();
        await page.locator('#view-library').waitFor({ state: 'visible' });
        const card = page.locator('#library-downloads .inventory-item'); await card.waitFor();
        console.log('Packaged fixture inventory visible.');
        if (await card.count() !== 1) throw new Error('Packaged inventory did not recover the isolated fixture.');
        await card.getByRole('checkbox').check();
        await page.waitForFunction(() => document.querySelector('[data-selection-kind="model"] [data-selection-count]')?.textContent === '1 selected');
        const limits = await page.evaluate(async () => {
          const current = (await window.frostbyte.getState()).data;
          return { rates: current.rates, capacity: current.sharingCapacity, bulkApi: typeof window.frostbyte.batchItems };
        });
        if (limits.rates?.mode !== 'normal' || limits.rates.alt || limits.rates.down !== -1 || limits.rates.up !== -1
          || !Number.isSafeInteger(limits.capacity?.limit) || limits.capacity.limit < 1 || limits.bulkApi !== 'function') throw new Error('Packaged bandwidth or bulk controls are not connected to the main process.');
        console.log(`Verified packaged Normal/unlimited mode and selected-item controls; file-handle capacity ${limits.capacity.limit}.`);
        await page.locator('#view-library').getByRole('button', { name: 'Export links…', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#export-summary')?.textContent.includes('1 without torrent links'));
        await page.locator('#modal').getByRole('button', { name: 'Cancel', exact: true }).click();
        await card.locator('summary').click(); await card.getByRole('button', { name: 'Hide from library', exact: true }).click();
        await card.waitFor({ state: 'detached' });
        console.log('Packaged hide persisted; restoring listing.');
        await page.locator('#view-library').getByRole('button', { name: 'Hidden & retained entries', exact: true }).click();
        await page.locator('.recovery-list').getByRole('button', { name: 'Restore listing', exact: true }).click();
        await page.waitForFunction(async () => !(await window.frostbyte.getState()).data.hiddenItems.length);
        await page.locator('.recovery-list').getByText('No hidden entries or retained jobs.', { exact: true }).waitFor();
        await page.locator('#modal').getByRole('button', { name: 'Done', exact: true }).click(); await card.waitFor();
        console.log('Packaged restoration visible.');
        const exported = await page.evaluate(async () => { const state = (await window.frostbyte.getState()).data; return window.frostbyte.previewLinks(state.catalog.map(row => 'catalog::catalog:' + row.id)); });
        if (!exported.ok || exported.data.links.length !== 1 || exported.data.links[0].infohash_v1 !== 'b'.repeat(40) || JSON.stringify(exported).includes(profile)) throw new Error('Packaged portable export preview failed.');
        await page.locator('#view-library').getByRole('button', { name: 'Publishing & connections', exact: true }).click();
        await page.locator('#frostnet-connect').waitFor();
        if (process.env.FROSTBYTE_QA_OUTPUT) { fs.mkdirSync(process.env.FROSTBYTE_QA_OUTPUT, { recursive: true }); await page.screenshot({ path: path.join(process.env.FROSTBYTE_QA_OUTPUT, 'packaged-publishing.png') }); }
        console.log('Verified native packaged hide/restore, selection/export preview and publishing controls in an isolated profile.');
        await page.locator('#modal').getByRole('button', { name: 'Done', exact: true }).click();
        await page.locator('#nav [data-tab="settings"]').click();
        await page.locator('#settings-nav [data-sec="interface"]').click();
        await page.locator('#set-theme').selectOption('blackfrost');
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'blackfrost');
        await page.locator('.brand-blackfrost').waitFor({ state: 'visible' });
        if (await page.locator('.blackfrost-showcase, .blackfrost-atmosphere, #use-blackfrost, #set-blackfrost-snow').count()) throw new Error('Packaged theme still contains promotional controls.');
        if (!await page.evaluate(async () => {
          const source = getComputedStyle(document.documentElement).getPropertyValue('--blackfrost-artwork').match(/url\(['"]?([^'")]+)['"]?\)/)[1];
          const image = new Image(); image.src = new URL(source, document.baseURI).href; await image.decode();
          return image.naturalWidth > 1000 && image.src.endsWith('/frozen-lake.png');
        })) throw new Error('Packaged unbranded background failed to decode.');
        if (!await page.locator('#sec-interface .card').first().evaluate(el => {
          const material = getComputedStyle(el);
          return material.backdropFilter.includes('blur(') && material.opacity === '1' && material.filter === 'none'
            && getComputedStyle(el.querySelector('h4')).fontFamily.includes('BlackfrostUI');
        })) throw new Error('Packaged frosted glass or Blackfrost typography is missing.');
        const glassSession = await page.context().newCDPSession(page);
        await glassSession.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
        if (!await page.locator('#sec-interface .card').first().evaluate(el => getComputedStyle(el).backdropFilter === 'none' && getComputedStyle(el).backgroundColor === 'rgb(16, 34, 49)')) throw new Error('Packaged glass ignored Reduce Transparency.');
        await glassSession.send('Emulation.setEmulatedMedia', { features: [] });
        await glassSession.detach();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        if (await page.locator('#blackfrost-snow').count()) throw new Error('Packaged theme retained the removed snow decoration.');
        if (process.env.FROSTBYTE_QA_OUTPUT) await page.screenshot({ path: path.join(process.env.FROSTBYTE_QA_OUTPUT, 'packaged-blackfrost.png') });
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
        if (!await page.evaluate(async () => document.documentElement.dataset.theme === 'blackfrost'
          && (await window.frostbyte.getState()).data.settings.theme === 'blackfrost')) throw new Error('Packaged Blackfrost selection did not persist.');
        if (!await page.evaluate(() => document.getElementById('jensen-tribute-card')?.hidden === true)) throw new Error('Jensen tribute card leaked onto non-Jensen theme.');
        await page.locator('#nav [data-tab="settings"]').click();
        await page.locator('#settings-nav [data-sec="interface"]').click();
        await page.locator('#set-theme').selectOption('jensen');
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'jensen');
        await page.locator('.brand-jensen').waitFor({ state: 'visible' });
        await page.locator('#jensen-tribute-card').waitFor({ state: 'visible' });
        const jensenCheck = await page.evaluate(async () => {
          const rights = document.querySelector('#jensen-tribute-card .jensen-rights-notice');
          const rightsOk = !!rights && !rights.hidden && rights.textContent.includes('Community creation — we do not own these rights.');
          const lockupTag = document.querySelector('#jensen-tribute-card .jensen-lockup-tag')?.textContent.trim();
          const brandTag = document.querySelector('.brand-jensen-tag');
          const brandTagOk = !!brandTag && !brandTag.hidden && brandTag.textContent.trim() === 'Jensen is NVIDIA';
          const logo = document.querySelector('#jensen-tribute-card .jensen-nvidia-logo');
          const logoOk = !!logo && getComputedStyle(logo).filter.includes('invert(1)');
          const imgs = [...document.querySelectorAll('#jensen-tribute-card img')];
          for (const img of imgs) {
            const probe = new Image();
            probe.src = img.src;
            await probe.decode();
            if (!(probe.naturalWidth > 0)) return { ok: false, reason: 'img-decode:' + img.src };
          }
          const milestonesAll = [...document.querySelectorAll('#jensen-tribute-card [data-milestone-year]')].filter(el => !el.hidden).length;
          document.querySelector('#jensen-tribute-card [data-jensen-year="2024"]')?.click();
          const milestones2024 = [...document.querySelectorAll('#jensen-tribute-card [data-milestone-year]')].filter(el => !el.hidden).map(el => el.dataset.milestoneYear);
          document.querySelector('#jensen-tribute-card [data-jensen-year="all"]')?.click();
          const restoredAll = [...document.querySelectorAll('#jensen-tribute-card [data-milestone-year]')].filter(el => !el.hidden).length;
          const backdrops = new Set();
          for (const tab of ['dashboard', 'discover', 'transfers', 'library', 'catalog', 'hf', 'spark', 'settings']) {
            document.querySelector(`#nav [data-tab="${tab}"]`)?.click();
            const raw = getComputedStyle(document.documentElement).getPropertyValue('--jensen-tab-backdrop').trim();
            const m = raw.match(/url\(['"]?([^'")]+)['"]?\)/);
            if (!m) return { ok: false, reason: 'missing-backdrop:' + tab };
            const probe = new Image();
            probe.src = new URL(m[1], document.baseURI).href;
            await probe.decode();
            backdrops.add(probe.src);
          }
          return {
            ok: rightsOk && lockupTag === 'To us, Jensen is NVIDIA' && brandTagOk && logoOk
              && imgs.length === 5 && milestonesAll === 6 && milestones2024.length === 1 && milestones2024[0] === '2024' && restoredAll === 6 && backdrops.size === 8,
            rightsOk, lockupTag, brandTagOk, logoOk, imgs: imgs.length, milestonesAll, milestones2024, restoredAll, backdrops: backdrops.size,
          };
        });
        if (!jensenCheck.ok) throw new Error('Packaged Founders Leather verification failed: ' + JSON.stringify(jensenCheck));
        if (process.env.FROSTBYTE_QA_OUTPUT) await page.screenshot({ path: path.join(process.env.FROSTBYTE_QA_OUTPUT, 'packaged-jensen.png') });
        console.log('Verified native packaged regular theme selector, unbranded artwork, frosted glass, Founders Leather Jensen tribute + 8 backdrops, typography, accessibility and saved selection.');
      }
    }
  } catch (error) {
    failure = error.message;
    if (lifecycleSmoke && browser) {
      const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('frostbyte://app/'));
      if (page) console.error('Isolated fixture UI:', (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(-7000));
    }
  } finally {
    if (browser) {
      const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('frostbyte://app/'));
      await Promise.race([page?.evaluate(() => window.frostbyte.quit()).catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    if (browser) await bounded(browser.close(), 4000, 'Packaged browser disconnect').catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const ended = await Promise.race([
        stopped,
        new Promise(resolve => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (!ended) child.kill('SIGKILL');
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may still be releasing handles. */ }
  }
  if (failure) throw new Error(`Packaged app failed its native startup smoke check: ${failure}${output.trim() ? `\n${output.trim()}` : ''}`);
}

await assertNativeLaunch(executable, { requireSandbox: requireLinuxSandbox });
if (linux) {
  for (const file of installers.filter(value => value.endsWith('.AppImage'))) {
    await assertNativeLaunch(file, { appImage: true });
  }
}
const channel = requireReleaseSignature ? 'public release' : 'local/community';
const platformLabel = windows ? 'Windows x64 executable' : mac ? 'Mac bundle' : 'Linux x64 application';
console.log(`Verified ${channel} ${platformLabel}, hardened fuses, runtime assets, and empty catalog: ${bundle}`);
if (!requireReleaseSignature) console.warn('Local/community build: publisher identity and OS notarization/reputation were intentionally not claimed.');
// Playwright's Electron harness requires --inspect, which production explicitly
// fuses off. Exercise the packaged binary above through a normal launch, then
// run the selected source-backed functional workflows with the same Electron.
const workflowEnv = { ...process.env };
delete workflowEnv.FROSTBYTE_EXECUTABLE;
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...testArgs], {
  cwd: root,
  env: workflowEnv,
  stdio: 'inherit',
});
if (result.error) throw result.error;
// Native startup uses Playwright's CDP client before the source-backed suite.
// That client can retain an idle Linux handle after every check has finished;
// the synchronous child status is final, so terminate with it explicitly.
process.exit(result.status ?? 1);
