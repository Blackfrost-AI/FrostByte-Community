import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const valid = {
  FROSTBYTE_MAC_SIGNING_IDENTITY: 'Developer ID Application: Example Signing Corporation (A1B2C3D4E5)',
  APPLE_KEYCHAIN_PROFILE: 'frostbyte-notary-test',
};
const signingEnvironment = new Set([
  'FROSTBYTE_MAC_SIGNING_IDENTITY', 'APPLE_KEYCHAIN_PROFILE', 'APPLE_KEYCHAIN', 'APPLE_TEAM_ID',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'GITHUB_BASE_REF', 'CSC_FOR_PULL_REQUEST',
]);
const hostEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !signingEnvironment.has(key)));
// A fresh process keeps the host runtime but gets only fixture signing metadata;
// no inherited signing credentials, Keychain queries, account discovery,
// packaging or notarization are performed. Windows needs SystemRoot and its
// temporary-directory variables to start Node and builder dependencies.
function inspect(overrides = {}, merge = false) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const result = require('./build/signing-macos.cjs')();
    if (${merge}) {
      const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
      const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper');
      const config = await getConfig(process.cwd(), 'build/signing-macos.cjs');
      const base = await getConfig(process.cwd(), 'electron-builder.cjs');
      await validateConfiguration(config, { isEnabled: false });
      console.log(JSON.stringify({
        version: require('electron-builder/package.json').version,
        config, base,
        certificates: MacTargetHelper.getCertificateTypes(false, config.mac.type === 'development'),
        notarize: MacTargetHelper.getNotarizeOptions('/fixture/FrostByte.app'),
      }));
    } else console.log(JSON.stringify(result));
  `], { cwd: project, env: { ...hostEnvironment, ...valid, ...overrides }, encoding: 'utf8', timeout: 10000 });
}
function rejected(overrides, expected) {
  const result = inspect(overrides);
  assert.notEqual(result.status, 0, 'Invalid signing metadata must stop configuration loading');
  assert.match(result.stderr, expected);
}

test('Mac distribution requires the complete Developer ID Application identity and team', () => {
  for (const identity of ['', '-', 'Example Signing Corporation (A1B2C3D4E5)',
    'Apple Development: Example Signing Corporation (A1B2C3D4E5)',
    'Developer ID Installer: Example Signing Corporation (A1B2C3D4E5)',
    'Developer ID Application: Example Signing Corporation (short)',
    'Developer ID Application: Example Signing Corporation (a1b2c3d4e5)',
    'Developer ID Application: Example Signing\nCorporation (A1B2C3D4E5)',
    'Developer ID Application:   (A1B2C3D4E5)']) {
    rejected({ FROSTBYTE_MAC_SIGNING_IDENTITY: identity }, /must be the full Developer ID Application/);
  }
});

test('missing or invalid Keychain notarization metadata stops configuration loading', () => {
  for (const profile of ['', ' ', ' profile ', '--invalid', 'profile\nsecond', 'x'.repeat(129)]) {
    rejected({ APPLE_KEYCHAIN_PROFILE: profile }, /APPLE_KEYCHAIN_PROFILE must name/);
  }
  for (const keychain of ['', '\n', ' relative.keychain ', '--invalid', 'x'.repeat(1025)]) {
    rejected({ APPLE_KEYCHAIN: keychain }, /APPLE_KEYCHAIN must be/);
  }
  rejected({ APPLE_TEAM_ID: 'Z9Y8X7W6V5' }, /APPLE_TEAM_ID must match/);
});

test('competing environment credential modes cannot override the Keychain profile', () => {
  for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'CSC_LINK', 'CSC_KEY_PASSWORD']) {
    rejected({ [key]: 'fixture-only-value' }, new RegExp(`Remove ${key}`));
  }
});

test('pull-request contexts cannot silently skip distribution signing', () => {
  rejected({ GITHUB_BASE_REF: 'main' }, /requires a local macOS build/);
  rejected({ GITHUB_BASE_REF: 'main', CSC_FOR_PULL_REQUEST: 'true' }, /requires a local macOS build/);
});

test('distribution config merges and validates against pinned electron-builder without losing packaging requirements', { skip: process.platform !== 'darwin' }, () => {
  const result = inspect({ APPLE_TEAM_ID: 'A1B2C3D4E5' }, true);
  assert.equal(result.status, 0, result.stderr);
  const { version, config, base, certificates, notarize } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(version, '26.15.3');
  assert.equal(config.directories.output, 'dist/signed-macos');
  assert.equal(config.directories.buildResources, base.directories.buildResources);
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.dmg.sign, true, 'the installer container must be signed before notarization');
  assert.deepEqual(config.dmg.contents, base.dmg.contents);
  assert.equal(config.publish, null);
  assert.equal(config.mac.identity, 'Example Signing Corporation (A1B2C3D4E5)');
  assert.equal(config.mac.type, 'distribution');
  assert.equal(config.mac.notarize, true);
  assert.deepEqual(certificates, ['Developer ID Application']);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(base.mac.entitlements, 'build/entitlements.mac.plist');
  assert.equal(base.mac.entitlementsInherit, 'build/entitlements.mac.plist');
  assert.equal(config.mac.entitlements, 'build/entitlements.mac.release.plist');
  assert.equal(config.mac.entitlementsInherit, 'build/entitlements.mac.release.plist');
  assert.deepEqual(config.mac.target, base.mac.target);
  assert.deepEqual(config.files, base.files);
  assert.deepEqual(config.extraResources, base.extraResources);
  assert.deepEqual(notarize, { tool: 'notarytool', appPath: '/fixture/FrostByte.app', keychainProfile: valid.APPLE_KEYCHAIN_PROFILE });
});

test('explicit Keychain paths reach the builder notarization resolver unchanged', { skip: process.platform !== 'darwin' }, () => {
  const keychain = '/fixture/Keychains/Signing Profiles.keychain-db';
  const result = inspect({ APPLE_KEYCHAIN: keychain }, true);
  assert.equal(result.status, 0, result.stderr);
  const { notarize } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(notarize.keychain, keychain);
  assert.equal(notarize.keychainProfile, valid.APPLE_KEYCHAIN_PROFILE);
  assert.equal(notarize.appleId, undefined);
  assert.equal(notarize.appleApiKey, undefined);
});

test('non-Mac hosts reject the distribution profile', { skip: process.platform === 'darwin' }, () => {
  rejected({}, /requires a local macOS build/);
});
