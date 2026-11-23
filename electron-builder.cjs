// electron-builder configuration.
//
// Every identity field — appId, product name, artifact names, executables,
// output directory, Linux packaging metadata — is derived from
// src/shared/edition-manifest.cjs, the same table the runtime and release
// tooling read. The Founders Edition was retired on 2026-10-07; the manifest
// carries a single entry and FROSTBYTE_EDITION no longer selects a variant.
//
//   npx electron-builder --mac
//
// The packaged app's own identity (`name`, `productName`, `desktopName`,
// `frostbyteEdition`, `description`) is baked in via `extraMetadata`, so the
// built artifact resolves its edition correctly at runtime WITHOUT mutating any
// tracked source file. That matters because resolveRuntimeEdition ignores
// FROSTBYTE_EDITION for installed executables by design — the identity has to be
// inside the package. scripts/test-packaged.js checks the packaged metadata
// against this same manifest table, so the two sides agree by construction.
//
// Field-for-field equivalent to the previous electron-builder.yml.

const { buildEdition } = require('./src/shared/edition-manifest.cjs');

// Resolve once, up front, so an unknown edition fails before any packaging work.
// Defaults to the edition this checkout is configured for, so a bare
// `electron-builder --mac` keeps building the same thing package.json says.
const edition = buildEdition();
const artifact = `${edition.artifactPrefix}-\${version}`;

// Exported as a *factory*, not a plain object. electron-builder supports this
// (see app-builder-lib/out/util/config/load.js: `typeof result === 'function'`
// is called per load), and it matters here: `extends` deep-assigns a child
// config into the parent's object, and with a plain object export that parent is
// the require-cached singleton — so loading build/signing-macos.cjs would
// mutate this module's config in place and a later read of the base config would
// return the signed values. Returning a fresh object per load removes that
// shared mutable state.
module.exports = () => ({
  appId: edition.appId,
  // The slash remains in the visible brand; bundle paths use a filesystem-safe name.
  productName: edition.productName,
  directories: {
    output: edition.outputDirectory,
    buildResources: 'build',
  },
  // Makes the packaged app self-identify as this edition. See the header note:
  // an installed executable ignores the ambient FROSTBYTE_EDITION override.
  extraMetadata: { ...edition.packageFields },
  files: [
    'src/**/*',
    'catalog/starter.json',
    'assets/brand/app-icon.png',
    'assets/brand/logo-dark.png',
    'assets/brand/aeon-orb.png',
    'assets/brand/u1tra-instinct-avatar.jpg',
    'assets/brand/keys-vial.svg',
    'assets/brand/blackfrost/frozen-lake.png',
    'assets/brand/blackfrost/sources.json',
    'assets/brand/jensen/*',
    'assets/fonts/Manrope.ttf',
    'assets/fonts/DepartureMono-Regular.woff2',
    'assets/fonts/Orbitron.ttf',
    'assets/fonts/ShareTechMono-Regular.ttf',
    'assets/fonts/SpaceGrotesk.ttf',
    'assets/fonts/sources.json',
    'assets/devices/*',
    'package.json',
    edition.licenseFile,
    'LICENSES.third-party.txt',
    ...(!edition.private ? ['NOTICE'] : []),
    'THIRD_PARTY_NOTICES.md',
  ],
  extraResources: [
    { from: 'build/spark-companion', to: 'spark-companion' },
    { from: 'src/hostd/frostbyte_hostd.py', to: 'hostd/frostbyte_hostd.py' },
    { from: 'src/hostd/install_user.py', to: 'hostd/install_user.py' },
    { from: edition.licenseFile, to: 'Legal/LICENSE.txt' },
    ...(!edition.private ? [{ from: 'NOTICE', to: 'Legal/NOTICE.txt' }] : []),
    { from: 'THIRD_PARTY_NOTICES.md', to: 'Legal/THIRD_PARTY_NOTICES.md' },
    { from: 'licenses', to: 'Legal/licenses' },
  ],
  asar: true,
  asarUnpack: ['**/*.node'],
  // Electron Builder 26 currently bundles an older fuse writer that does not know
  // Electron 44's complete fuse wire. This hook uses our pinned current writer,
  // requires every fuse to be explicit, and runs before Builder signs the app.
  afterPack: 'build/harden-electron.cjs',
  // Production native dependencies use the N-API prebuilds installed by npm ci.
  npmRebuild: false,
  artifactName: `${artifact}-\${os}-\${arch}.\${ext}`,
  protocols: [
    { name: 'Magnet link', schemes: ['magnet'] },
    { name: 'IPFS link', schemes: ['ipfs'] },
    { name: 'FrostByte', schemes: ['frostbyte'] },
  ],
  mac: {
    signIgnore: ['Contents/Resources/ipfs-runtime/ipfs$', 'Contents/Resources/llama-runtime/'],
    extraResources: [
      { from: 'build/ipfs-runtime/darwin-${arch}', to: 'ipfs-runtime' },
      { from: 'build/llama-runtime/darwin-${arch}', to: 'llama-runtime' },
      { from: 'build/llama-runtime.json', to: 'llama-runtime.json' },
    ],
    artifactName: `${artifact}-mac-\${arch}.\${ext}`,
    fileAssociations: [{ ext: 'torrent', name: 'BitTorrent metadata', role: 'Viewer' }],
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    category: 'public.app-category.utilities',
    icon: 'build/icon.icns',
    darkModeSupport: true,
    // Local installation build. A distribution build must use Developer ID + notarization.
    identity: '-',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: false,
    extendInfo: {
      CFBundleDisplayName: edition.displayName,
      NSLocalNetworkUsageDescription: 'Frost/Byte connects to peers on your network to share files.',
    },
  },
  win: {
    extraResources: [{ from: 'build/ipfs-runtime/win32-${arch}', to: 'ipfs-runtime' }],
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    artifactName: `${artifact}-win-\${arch}.\${ext}`,
    icon: 'build/icon.ico',
    // windows-installer.nsh branches its registry identity off PRODUCT_FILENAME,
    // so the executable name is what keeps the two editions' ProgIDs and file
    // associations isolated from each other.
    executableName: edition.winExecutable.replace(/\.exe$/, ''),
    requestedExecutionLevel: 'asInvoker',
  },
  linux: {
    extraResources: [{ from: 'build/ipfs-runtime/linux-${arch}', to: 'ipfs-runtime' }],
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    artifactName: `${artifact}-linux-x64.\${ext}`,
    icon: 'assets/brand/app-icon.png',
    executableName: edition.linuxExecutable,
    syncDesktopName: true,
    category: 'Utility',
    maintainer: 'Blackfrost Softwares Corp <support@blackfrostai.com>',
    vendor: 'Blackfrost Softwares Corp',
    synopsis: edition.synopsis,
    description: edition.description,
    fileAssociations: [{
      ext: 'torrent',
      name: 'BitTorrent metadata',
      mimeType: 'application/x-bittorrent',
    }],
  },
  deb: {
    packageName: edition.packageName,
    depends: [
      'libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6',
      'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0',
      'libgbm1', 'libasound2t64 | libasound2',
    ],
    recommends: ['openssh-client'],
  },
  // Do not inherit Builder's legacy AppImage --no-sandbox desktop argument.
  // afterPack also replaces its automatic sandbox-disabling AppRun fallback.
  appImage: { executableArgs: [] },
  nsis: {
    include: 'build/windows-installer.nsh',
    artifactName: `${artifact}-win-\${arch}-setup.\${ext}`,
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: edition.productName,
  },
  dmg: {
    title: edition.productName,
    icon: 'build/icon.icns',
    backgroundColor: '#121512',
    window: { width: 580, height: 380 },
    iconSize: 100,
    contents: [
      { x: 150, y: 175, type: 'file' },
      { x: 430, y: 175, type: 'link', path: '/Applications' },
    ],
  },
});
