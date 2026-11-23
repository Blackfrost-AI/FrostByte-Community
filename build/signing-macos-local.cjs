// Opt-in Developer ID profile for LOCAL installation only. No notarization,
// uploads, release publication, or changes to the ordinary ad-hoc profile.
const { isSignAllowed } = require('app-builder-lib/out/codeSign/macCodeSign');
const { isPullRequest } = require('builder-util');
const { buildEdition } = require('../src/shared/edition-manifest.cjs');

module.exports = () => {
  const identity = process.env.FROSTBYTE_MAC_SIGNING_IDENTITY || '';
  const match = /^Developer ID Application: (.+) \(([A-Z0-9]{10})\)$/.exec(identity);
  if (!match || identity.length > 300 || /[\x00-\x1f\x7f]/.test(identity) || match[1].trim() !== match[1] || !match[1].trim()) throw new Error('Local signing requires the full Developer ID Application identity.');
  if (!isSignAllowed(false) || isPullRequest()) throw new Error('Local signing requires a macOS build outside a pull-request job.');
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD']) if (process.env[key]) throw new Error(`Remove ${key}; local signing uses the existing OS Keychain identity.`);
  const edition = buildEdition();
  return {
    extends: 'electron-builder.cjs',
    directories: { output: `${edition.outputDirectory}/signed-local` },
    publish: null,
    forceCodeSigning: true,
    dmg: { sign: true },
    mac: { identity: `${match[1]} (${match[2]})`, type: 'distribution', notarize: false,
      entitlements: 'build/entitlements.mac.release.plist', entitlementsInherit: 'build/entitlements.mac.release.plist' },
  };
};
