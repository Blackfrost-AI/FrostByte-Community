/** Offline release provenance. Upload/deployment and owner installation are separate steps. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../src/main/updates.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { manifestFor, EDITION_IDS, DEFAULT_EDITION_ID, buildEdition } = require('../src/shared/edition-manifest.cjs');

export const targets = Object.freeze({
  'darwin-arm64': [['dmg', 'mac-arm64.dmg'], ['zip', 'mac-arm64.zip']],
  'win32-x64': [['win', 'win-x64-setup.exe'], ['win-zip', 'win-x64.zip']],
  'linux-x64': [['appimage', 'linux-x64.AppImage'], ['deb', 'linux-x64.deb']],
});
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
/**
 * Release profile, derived from the shared edition manifest.
 *
 * This used to be a second, hand-maintained copy of every edition-specific
 * string — which is exactly how the two editions drifted apart. The identity
 * table is defined once in the manifest and consumed by the builder config,
 * the runtime gates, the packaged-test expectations and here, so they cannot
 * disagree.
 */
const profileForEdition = manifest => Object.freeze({
  edition: manifest.id,
  channel: manifest.channel,
  notesFile: manifest.notesFile,
  notesTitle: manifest.notesTitle,
  outputDirectory: manifest.outputDirectory,
  artifactPrefix: manifest.artifactPrefix,
  macApp: manifest.macApp,
  packagedTestArgument: manifest.packagedTestArgument,
  tagPrefix: manifest.tagPrefix,
});

const releaseProfiles = Object.freeze(Object.fromEntries(
  EDITION_IDS.map(id => [id, profileForEdition(manifestFor(id))]),
));
const profileForPackage = pkg => {
  const edition = pkg.frostbyteEdition ?? DEFAULT_EDITION_ID;
  if (!Object.hasOwn(releaseProfiles, edition)) throw new Error(`Package has an unrecognized FrostByte edition: ${edition}. Expected one of: ${EDITION_IDS.join(', ')}.`);
  return releaseProfiles[edition];
};

/**
 * The profile for the edition a build is currently producing.
 *
 * Precedence matches electron-builder.cjs exactly: explicit FROSTBYTE_EDITION
 * first, then the edition this checkout is configured for. CI runs this per
 * matrix leg so each leg describes its own artifact.
 */
const buildEditionSelectedProfile = () => releaseProfiles[buildEdition().id];
export async function releaseProfile(root) {
  // An explicitly selected build edition (CI matrix leg) wins over whatever this
  // checkout's package.json says, so the profile always describes the artifact
  // actually being produced. Without the env var the profile follows the
  // checkout, which is what local release staging has always done.
  const explicit = process.env.FROSTBYTE_EDITION;
  if (explicit) {
    if (!Object.hasOwn(releaseProfiles, explicit)) throw new Error(`Package has an unrecognized FrostByte edition: ${explicit}. Expected one of: ${EDITION_IDS.join(', ')}.`);
    return releaseProfiles[explicit];
  }
  return profileForPackage(await readJson(path.join(root, 'package.json')));
}
const artifactFilename = (profile, version, suffix) => `${profile.artifactPrefix}-${version}-${suffix}`;
const assertNativeDirectory = (root, directory, profile) => {
  if (path.resolve(directory) !== path.resolve(root, profile.outputDirectory)) {
    throw new Error(`${profile.notesTitle} native releases must use ${profile.outputDirectory}.`);
  }
};
export async function releaseConfig(root) {
  const pkg = await readJson(path.join(root, 'package.json'));
  compareVersions(pkg.version, pkg.version);
  const profile = await releaseProfile(root);
  const lock = await readJson(path.join(root, 'package-lock.json'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Package and lockfile versions differ. Use npm version VERSION --no-git-tag-version.');
  const notes = await fs.readFile(path.join(root, profile.notesFile), 'utf8');
  if (!notes.startsWith(`# ${profile.notesTitle} ${pkg.version} — `)) throw new Error('Release notes must start with the current package version and edition.');
  return { schemaVersion: 1, edition: profile.edition, channel: profile.channel, version: pkg.version, platforms: Object.keys(targets),
    notes: notes.split('\n# ')[0].split('\n').slice(1).join('\n').trim().slice(0, 4000) };
}
export async function fingerprint(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) throw new Error(`Not a complete regular artifact: ${path.basename(file)}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await fs.lstat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Artifact changed during hashing.');
  return { bytes: before.size, sha256: hash.digest('hex') };
}
async function writeImmutable(file, value) {
  try { await fs.writeFile(file, value, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || await fs.readFile(file, 'utf8') !== value) throw new Error(`Refusing to replace existing release metadata: ${path.basename(file)}`);
  }
}
export async function begin(root, directory) {
  const config = await releaseConfig(root);
  const profile = await releaseProfile(root);
  assertNativeDirectory(root, directory, profile);
  if (git(root, 'status', '--porcelain=v1')) throw new Error('Commit all source changes before building a release.');
  const input = { edition: config.edition, version: config.version, sourceCommit: git(root, 'rev-parse', 'HEAD'), sourceTree: git(root, 'rev-parse', 'HEAD^{tree}') };
  await fs.mkdir(directory, { recursive: true });
  await writeImmutable(path.join(directory, 'build-input.json'), JSON.stringify(input, null, 2) + '\n');
  return input;
}
export async function generatedChanges(root, input) {
  if (git(root, 'rev-parse', 'HEAD') !== input.sourceCommit || git(root, 'rev-parse', 'HEAD^{tree}') !== input.sourceTree) throw new Error('Source revision changed after build preparation.');
  // These are outputs of the committed icon/notice generators. Native Electron
  // notices and optional dependency notices can legitimately differ by platform.
  const generated = new Set(['LICENSES.third-party.txt', 'THIRD_PARTY_NOTICES.md', 'licenses/npm-inventory.json',
    'licenses/electron/LICENSE', 'licenses/electron/LICENSES.chromium.html', 'build/icon.icns', 'build/icon.ico', 'assets/brand/app-icon.png']);
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  const changes = [];
  for (const entry of status.split('\0').filter(Boolean)) {
    const filename = entry.slice(3);
    if (!generated.has(filename) && !filename.startsWith('licenses/npm/')) throw new Error(`Application source changed during packaging: ${filename}`);
    if (entry.slice(0, 2).trim() === 'D') changes.push({ filename, removed: true });
    else changes.push({ filename, ...await fingerprint(path.join(root, filename)) });
  }
  return changes;
}
export async function stage(root, directory, platform) {
  if (platform !== `${process.platform}-${process.arch}` || !targets[platform]) throw new Error('Stage each platform on its native build host.');
  const config = await releaseConfig(root);
  const profile = await releaseProfile(root);
  assertNativeDirectory(root, directory, profile);
  const input = await readJson(path.join(directory, 'build-input.json'));
  if ((input.edition ?? 'community') !== config.edition || input.version !== config.version) throw new Error('Build input edition or version changed.');
  const { sourceCommit, sourceTree } = input;
  const generated = await generatedChanges(root, input);
  const artifacts = [];
  for (const [format, suffix] of targets[platform]) {
    const filename = artifactFilename(profile, config.version, suffix);
    artifacts.push({ format, filename, ...await fingerprint(path.join(directory, filename)) });
  }
  const receipt = { schemaVersion: 1, edition: config.edition, version: config.version, platform, sourceCommit, sourceTree,
    // Hashing artifacts cannot establish their signing/notarization status.
    // Keep the native verification record alongside this provenance receipt.
    signing: 'not assessed by staging; see native verification record', generated, artifacts };
  await writeImmutable(path.join(directory, `build-info-${platform}.json`), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
export async function assemble(root, directory) {
  const config = await releaseConfig(root);
  const profile = await releaseProfile(root);
  assertNativeDirectory(root, directory, profile);
  const artifacts = [];
  let sourceCommit, sourceTree;
  for (const platform of config.platforms) {
    const receipt = await readJson(path.join(directory, `build-info-${platform}.json`));
    if (receipt.schemaVersion !== 1 || (receipt.edition ?? 'community') !== config.edition
      || receipt.version !== config.version || receipt.platform !== platform
      || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit) || !/^[a-f0-9]{40}$/.test(receipt.sourceTree)) throw new Error('Invalid native build receipt.');
    sourceCommit ??= receipt.sourceCommit; sourceTree ??= receipt.sourceTree;
    if (receipt.sourceCommit !== sourceCommit || receipt.sourceTree !== sourceTree) throw new Error('Native builds came from different source revisions.');
    if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== 2) throw new Error('Incomplete native build receipt.');
    for (const [format, suffix] of targets[platform]) {
      const filename = artifactFilename(profile, config.version, suffix);
      const recorded = receipt.artifacts.find(item => item.format === format && item.filename === filename);
      const actual = await fingerprint(path.join(directory, filename));
      if (!recorded || recorded.bytes !== actual.bytes || recorded.sha256 !== actual.sha256) throw new Error(`Native receipt does not match ${filename}.`);
      artifacts.push({ format, filename, ...actual });
    }
  }
  if (git(root, 'rev-parse', `${sourceCommit}^{tree}`) !== sourceTree) throw new Error('Source provenance does not match this repository.');
  const sourcePackage = JSON.parse(git(root, 'show', `${sourceCommit}:package.json`));
  if (sourcePackage.version !== config.version || profileForPackage(sourcePackage).edition !== config.edition) {
    throw new Error('Source edition or version does not match the release.');
  }
  const checksumName = `SHA256SUMS-${config.version}`;
  await writeImmutable(path.join(directory, checksumName), artifacts.map(a => `${a.sha256}  ${a.filename}\n`).join(''));
  artifacts.push({ format: 'checksums', filename: checksumName, ...await fingerprint(path.join(directory, checksumName)) });
  const manifest = { ...config, sourceCommit, sourceTree, sourceTag: `${profile.tagPrefix}${config.version}`, artifacts };
  await writeImmutable(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [command, ...args] = process.argv.slice(2);
  if (command === 'profile' && !args.length) {
    // The profile describes the edition this build is producing. The builder
    // config resolves the same way, so a CI matrix over both editions gets a
    // matching profile for each leg instead of a founders-only answer.
    const profile = buildEditionSelectedProfile();
    console.log(`edition=${profile.edition}\ndirectory=${profile.outputDirectory}\nartifact_prefix=${profile.artifactPrefix}\nmac_app=${profile.macApp}\nlinux_executable=${manifestFor(profile.edition).linuxExecutable}\npackaged_test_argument=${profile.packagedTestArgument}`);
  }
  else if (command === 'check' && !args.length) {
    // The npm-level release:check wrapper runs sync-version.mjs first. This
    // direct invocation keeps the same cross-surface guard when release.mjs is
    // called outside npm (for example by scripts and CI).
    execFileSync(process.execPath, [path.join(root, 'scripts', 'sync-version.mjs')], { cwd: root, stdio: 'inherit' });
    const config = await releaseConfig(root);
    console.log(`Release ${config.version} (${config.edition}): package, lockfile, notes and version surfaces agree.`);
  }
  else if (command === 'begin' && args.length === 1) console.log(JSON.stringify(await begin(root, path.resolve(args[0])), null, 2));
  else if (command === 'stage' && args.length === 2) console.log(JSON.stringify(await stage(root, path.resolve(args[1]), args[0]), null, 2));
  else if (command === 'assemble' && args.length === 1) console.log(JSON.stringify(await assemble(root, path.resolve(args[0])), null, 2));
  else throw new Error('Usage: release.mjs profile | check | begin DIRECTORY | stage PLATFORM DIRECTORY | assemble DIRECTORY');
}
