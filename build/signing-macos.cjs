// Explicit local distribution profile; never used by the ordinary ad-hoc build.
const { isSignAllowed } = require('app-builder-lib/out/codeSign/macCodeSign');
const { isPullRequest } = require('builder-util');
const { buildEdition } = require('../src/shared/edition-manifest.cjs');

module.exports = () => {
  const env = process.env;
  // Resolve from the same table the runtime and electron-builder.cjs use, so a
  // signed build can never disagree with the artifact that was produced.
  const edition = buildEdition(env);
  const identity = env.FROSTBYTE_MAC_SIGNING_IDENTITY;
  const match = /^Developer ID Application: (.+) \(([A-Z0-9]{10})\)$/.exec(identity || '');
  if (!match || identity.length > 300 || /[\x00-\x1f\x7f]/.test(identity)
    || match[1].trim() !== match[1] || !match[1].trim()) {
    throw new Error('FROSTBYTE_MAC_SIGNING_IDENTITY must be the full Developer ID Application: Organization (TEAMID) label.');
  }
  const profile = env.APPLE_KEYCHAIN_PROFILE;
  if (!profile || profile.length > 128 || profile.trim() !== profile || profile.startsWith('-') || /[\x00-\x1f\x7f]/.test(profile)) {
    throw new Error('APPLE_KEYCHAIN_PROFILE must name an existing notarization credential profile in the OS Keychain.');
  }
  if (env.APPLE_KEYCHAIN !== undefined && (!env.APPLE_KEYCHAIN.trim() || env.APPLE_KEYCHAIN.length > 1024
    || env.APPLE_KEYCHAIN.trim() !== env.APPLE_KEYCHAIN || env.APPLE_KEYCHAIN.startsWith('-')
    || /[\x00-\x1f\x7f]/.test(env.APPLE_KEYCHAIN))) {
    throw new Error('APPLE_KEYCHAIN must be a valid Keychain name or path when supplied.');
  }
  // Builder 26 prioritizes these credential modes over its Keychain profile.
  for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'CSC_LINK', 'CSC_KEY_PASSWORD']) {
    if (env[key]) throw new Error(`Remove ${key} for this OS-Keychain-only signing profile.`);
  }
  if (env.APPLE_TEAM_ID && env.APPLE_TEAM_ID !== match[2]) {
    throw new Error('APPLE_TEAM_ID must match the Developer ID Application label.');
  }
  if (!isSignAllowed(false) || isPullRequest()) {
    throw new Error('This distribution profile requires a local macOS build outside a pull-request job.');
  }
  return {
    extends: 'electron-builder.cjs',
    directories: { output: `${edition.outputDirectory}/signed-macos` },
    publish: null,
    forceCodeSigning: true,
    // Builder signs applications by default, but DMG container signing is opt-in.
    dmg: { sign: true },
    mac: {
      // Builder selects the certificate class from type and rejects that prefix
      // in identity itself; retain the exact organization and team qualifier.
      identity: `${match[1]} (${match[2]})`,
      type: 'distribution',
      // The local profile disables library validation for ad-hoc builds. A
      // Developer ID release must keep it enabled for the complete app tree.
      entitlements: 'build/entitlements.mac.release.plist',
      entitlementsInherit: 'build/entitlements.mac.release.plist',
      notarize: true,
    },
  };
};
