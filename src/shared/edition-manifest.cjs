// Single source of truth for application identity.
//
// Written as CommonJS because it must be loadable from three different module
// systems in one repo:
//   - electron-builder.cjs        (CJS, evaluated by electron-builder's loader)
//   - src/shared/edition.js       (ESM, loads this via createRequire)
//   - scripts/release.mjs         (ESM, loads this via createRequire)
//
// FrostByte ships one edition. The Founders Edition was retired on 2026-10-07
// (private retirement handoff, 2026-11-09); its build identity, data profile and
// update channel are gone. The table below is retained — rather than replaced by
// loose constants — because every consumer (builder config, packaged-test
// expectations, release profile, runtime identity) already derives its values
// from it, so identity stays defined in exactly one place.
//
// Field notes:
//   packageName / appId        OS-level install identity.
//   productName                Builder product name -> .app bundle name on macOS.
//   appSetName                 The visible brand passed to app.setName(). Contains a
//                              slash deliberately: on Windows there is no explicit
//                              userData override, so Electron derives
//                              %APPDATA%\Frost\Byte from this name, matching
//                              the explicit darwin path below. Do not "fix" the slash.
//   artifactPrefix             Release artifact filename prefix.
//   outputDirectory            Where electron-builder writes.
//   profile                    Application data directory name (store.js, userData).
//   channel                    Update feed channel.
//   desktopId                  Linux autostart .desktop identity.
//   desktopName                package.json `desktopName`; electron-builder's
//                              `syncDesktopName` uses it for the launcher, and
//                              scripts/test-packaged.js asserts the packaged value
//                              matches. Equals linuxExecutable by design.
//   notesFile / notesTitle     Release notes location + heading.
//   tagPrefix                  Git release tag prefix.
//   packageFields              The exact package.json identity values that must be
//                              baked into a build. Consumed by the builder config's
//                              extraMetadata and by the packaged test, so both sides
//                              agree by construction.

const EDITIONS = Object.freeze({
  community: Object.freeze({
    id: 'community',
    name: 'Community Edition',
    packageName: 'frostbyte',
    appId: 'ai.blackfrost.frostbyte',
    productName: 'FrostByte',
    appSetName: 'Frost/Byte',
    artifactPrefix: 'FrostByte',
    outputDirectory: 'dist',
    macApp: 'FrostByte.app',
    winExecutable: 'FrostByte.exe',
    linuxExecutable: 'frostbyte',
    profile: 'frostbyte',
    channel: 'beta',
    licenseFile: 'LICENSE',
    desktopId: 'ai.blackfrost.frostbyte.desktop',
    desktopName: 'frostbyte',
    notesFile: 'docs/RELEASE-NOTES.md',
    notesTitle: 'FrostByte',
    tagPrefix: 'v',
    packagedTestArgument: '--community-build',
    synopsis: 'FrostByte model workspace and peer-to-peer client',
    description: 'FrostByte is an agentic workspace, model manager, and peer-to-peer model network.',
    displayName: 'Frost/Byte',
    packageFields: Object.freeze({
      name: 'frostbyte',
      productName: 'FrostByte',
      desktopName: 'frostbyte',
      frostbyteEdition: 'community',
      license: 'Apache-2.0',
      description: 'FrostByte — an agentic workspace, model manager, and peer-to-peer model network.',
    }),
  }),
  // Plus/Pro are Hub entitlement tiers, not OS build identities. They share
  // the Community build artifact and are gated at runtime via signed
  // entitlement claims (see src/main/hub-entitlements.js / docs/hub-api.md).
  // No new build identities are added here — packaging stays single-artifact.
});

const EDITION_IDS = Object.freeze(Object.keys(EDITIONS));
const DEFAULT_EDITION_ID = 'community';

// The edition this checkout is configured for. Used as the build default so
// `npm run dist:mac` with no env var keeps doing what package.json says, exactly
// like the runtime resolver does. An explicit FROSTBYTE_EDITION always wins.
let checkedOutEditionId = DEFAULT_EDITION_ID;
try {
  checkedOutEditionId = manifestFor(require('../../package.json').frostbyteEdition).id;
} catch { /* a consumer outside a full checkout can still select an edition explicitly */ }
const CHECKED_OUT_EDITION_ID = checkedOutEditionId;

/**
 * Normalize any incoming edition identifier to a manifest entry.
 *
 * Accepts undefined/null/'' and resolves to the default edition. Throws on an
 * unknown non-empty id rather than silently downgrading — a typo in
 * FROSTBYTE_EDITION must fail the build loudly, not ship a mislabeled app.
 */
function manifestFor(id) {
  if (id === undefined || id === null || id === '') return EDITIONS[DEFAULT_EDITION_ID];
  const normalized = String(id).trim().toLowerCase();
  const entry = EDITIONS[normalized];
  if (!entry) {
    throw new Error(`Unknown FrostByte edition "${id}". Expected one of: ${EDITION_IDS.join(', ')}.`);
  }
  return entry;
}

/**
 * The edition a build/release tool should target.
 *
 * Precedence: explicit `FROSTBYTE_EDITION`, then the edition this checkout is
 * configured for. It deliberately does NOT honour `process.defaultApp` — build
 * tooling must be driven by an explicit selection, and a stray Electron flag
 * must not change what gets built.
 */
function buildEdition(environment = process.env, fallbackId = CHECKED_OUT_EDITION_ID) {
  return manifestFor(environment.FROSTBYTE_EDITION ?? fallbackId);
}

module.exports = {
  EDITIONS,
  EDITION_IDS,
  DEFAULT_EDITION_ID,
  CHECKED_OUT_EDITION_ID,
  manifestFor,
  buildEdition,
};