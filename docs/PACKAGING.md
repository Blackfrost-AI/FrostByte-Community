# Desktop packaging and installation

Current release process: [VERSIONING.md](VERSIONING.md). Version 0.3.0 remains a
public beta; download access requires terms acceptance, with no invite code.
The new local 0.3.1 candidate adds the explicit signed Mac build described below;
the public 0.3.0 downloads are unchanged.

Frost/Byte packages as `FrostByte.app` with bundle ID `ai.blackfrost.frostbyte`.
The visible brand is still **Frost/Byte**; the app bundle uses a filename without
the slash. This build targets Apple Silicon (`arm64`).

## Build

```sh
npm ci
npm run dist:mac
```

This regenerates the native icon from the artwork, packages runtime source and
production dependencies into ASAR, unpacks native `.node` libraries, builds the
self-contained Spark companion in Resources/spark-companion, and creates:

- `dist/mac-arm64/FrostByte.app`
- `dist/FrostByte-<version>-mac-arm64.dmg`
- `dist/FrostByte-<version>-mac-arm64.zip`

Versioned filenames follow `package.json`. `npm run pack:mac` builds only the app.
Native dependencies use N-API prebuilds installed by `npm ci`; rebuilding for
Electron is disabled. Build this target on an Apple Silicon Mac. Artwork sources
and generation prompts are in `assets/brand/`.

Packaging first regenerates third-party notices from locked installed runtime
dependencies. `Contents/Resources/Legal` contains the beta license, dependency
attribution, native MPL source locations, and Electron/Chromium notices; Help →
Licenses and Third-Party Notices opens it. The companion archive/container also
includes the original-code license and combined runtime dependency notices.
Never overwrite a released version's artifacts after changing its license.

## Install

Open the DMG and drag **FrostByte** to **Applications**, then open it from there.
Quit an existing Frost/Byte instance before replacing the app. Installing the
bundle does not delete settings, saved model files, or catalog entries.

The app retains the existing locations:

- Settings and catalog: `~/Library/Application Support/frostbyte`
- Electron interface preferences: `~/Library/Application Support/Frost/Byte`
- Default downloads: `~/FrostByte` (or the folder selected in Settings)

The app name used for Keychain storage is preserved. If macOS asks about Keychain
access following installation, allow access for the installed FrostByte app.
Failed token unlocking leaves the stored encrypted token intact so it can be
retried or replaced explicitly in Settings. Spark pairing uses the same protected
app identity. An ad-hoc rebuild can trigger a login Keychain password prompt;
complete it in macOS to test real encrypted pairing/reconnection. Test automation
does not enter the Mac password or bypass the prompt.

## Verify the installed app

```sh
npm run test:packaged -- --community-build dist/mac-arm64/FrostByte.app \
  --installer dist/FrostByte-<version>-mac-arm64.dmg
```

Without an argument, this checks `dist/mac-arm64/FrostByte.app`. Verification
checks the bundle signature, required assets, companion archive integrity/version,
all Electron security fuses, empty starter catalog, absence of development files,
and a native startup that loads the `frostbyte://app/` renderer over an ephemeral
loopback DevTools connection. It then runs the Electron workflow suite (plus an
optional live Spark workflow) against the same source revision. Production turns
off Node's inspector fuse, so Playwright cannot instrument the packaged main process.
When `--installer` is supplied, community mode also mounts the DMG and compares its
complete application payload with the reviewed bundle; publisher identity and
notarization remain outside community verification.
Each workflow uses an isolated temporary profile and small test files. Live HF
checks contact the public service. Screenshots go to `test-results/screenshots/`.

## Signing scope

`electron-builder.yml` explicitly uses ad-hoc signing for local installation,
with hardened runtime and the JIT/native-library entitlements needed by Electron.
This ordinary build makes no Developer ID or notarization claim. The separate
`npm run dist:mac:signed` recipe uses the configured distribution certificate and
Keychain notarization profile; see [MACOS-SIGNING.md](MACOS-SIGNING.md).

For public distribution, use `build/signing-macos.cjs` with a **Developer ID
Application** certificate and Keychain notarization profile. This profile forces
signing, notarization, and release entitlements that keep library validation
enabled. The packaged release check requires a valid identity, stapled app and
DMG tickets, and Gatekeeper acceptance. It also mounts the exact versioned DMG
and rejects unexpected top-level DMG content before comparing every payload file
and link with the reviewed app bundle. Credentials stay outside the repository.
Verify installation from a browser download on a different Mac.
See [Electron’s signing and notarization guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing).

The current dependency advisory and remaining operating limits are documented
in the [security and functionality review](SECURITY-AND-FUNCTIONALITY-REVIEW-2026-09-12.md),
separately from the earlier successful small Mac-to-Spark transfers.

## Windows x64

Use native Windows x64 Node 22.12+ in a fresh checkout:

```powershell
npm ci
npm run dist:win
```

Do not copy another platform's `node_modules`. The N-API networking binaries must
match Windows x64; Electron rebuilding is disabled. The build uses `tar` to make
the Linux Spark payload and regenerates icons and dependency notices. End users
do not need Node, Python, a compiler, or the HF CLI to run the installed app.
The Windows build wrapper forces the NSIS app archive to use the BCJ executable
filter because the decoder bundled with electron-builder 26.15.x cannot safely
extract BCJ2 payloads.

Versioned outputs:

- `dist/win-unpacked/FrostByte.exe`
- `dist/FrostByte-<version>-win-x64-setup.exe`
- `dist/FrostByte-<version>-win-x64.zip`

`npm run pack:win` creates only the unpacked app. Run the setup executable as the
normal desktop user. NSIS installs per-user, creates shortcuts, requests no
administrator elevation, and leaves launch to the user after setup completes.
The executable and installer are unsigned; no publisher signature or SmartScreen
approval is claimed. Compare the release checksum and contact support if Windows
blocks installation; do not disable OS protections. ZIP extraction does not run
the installer or register its file associations.

The installer adds FrostByte to Open With / Default Apps for `.torrent` and
`magnet`, preserving existing handlers and Windows UserChoice. It supplies a
fallback only when no handler exists. Opening a source starts the review popup,
even if the app is already running; a download still requires confirmation.
Uninstall is configured to retain app data. The default download folder is
`%USERPROFILE%\FrostByte`; settings live in `%APPDATA%\frostbyte`. Selected files
and saved settings should be backed up separately from the application.

The local download choice reads **This PC**, with `Ctrl` shortcuts. Windows
encrypts HF tokens and pairing keys through Electron safeStorage and DPAPI,
associated with the Windows logon account. This does not isolate secrets from
other applications running as that user. Reconnect if a copied profile cannot be
unlocked; failed unlocks retain the existing ciphertext. See [Electron's storage
semantics](https://www.electronjs.org/docs/latest/api/safe-storage).

Run native checks in the logged-in Windows desktop session:

```powershell
node --test tests/windows-runtime.test.js tests/spark-transport.test.js tests/torrent-selection.test.js
$env:FROSTBYTE_ALLOW_ISOLATED_INSTALLER_CHECK = '1' # disposable test account only
npm run test:packaged -- --community-build dist/win-unpacked `
  --installer dist/FrostByte-<version>-win-x64-setup.exe `
  --isolated-installer-check
```

The packaged runner defaults to `dist/win-unpacked`, accepts an installed
`FrostByte.exe` path, verifies x64 PE format, assets, licenses and companion
integrity, then runs isolated source-backed Electron workflows from the same
revision. It does not certify a Windows code signature in community mode. With
`--installer --isolated-installer-check`, it silently installs NSIS into a fresh
temporary directory, compares every installed application file with the reviewed
unpacked app, and runs the generated uninstaller. Run this only in CI or a
disposable Windows account: NSIS checks the account's existing install registry
before honoring the isolated destination. A public package must run the strict gate on
both the application and distributed installer:

```powershell
$env:FROSTBYTE_WINDOWS_SIGNING_SUBJECT = '<exact Authenticode certificate subject>'
$env:FROSTBYTE_ALLOW_ISOLATED_INSTALLER_CHECK = '1' # disposable test account only
npm run test:packaged -- --require-release-signature dist/win-unpacked `
  --installer dist/FrostByte-<version>-win-x64-setup.exe `
  --isolated-installer-check
```

That mode requires embedded, timestamped Authenticode signatures and the exact
configured certificate subject on both files. It also requires the exact versioned
installer name and verifies the actual files produced by NSIS against the reviewed
unpacked application. The physical Spark
workflow remains opt-in. Linux companion
tests use Unix sockets, POSIX modes and shell/Python helpers and stay in their
Linux lane; `npm run test:all` is not the Windows test command.

The earlier beta.4 Windows installation, uninstall, reinstall and final upgrade
were verified with existing torrent/magnet defaults and app data preserved. All 28
portable backend fixtures and all 29 final installed-app workflows passed, with
no desktop failures or skips. ZIP CRC and packaged-source parity checks passed;
the final SHA-256 checksums are in `dist/SHA256SUMS-0.2.0-beta.4`.
Windows pairing uses a loopback SSH fixture and real Windows DPAPI;
physical Windows-to-Spark testing remains separate. Installation from a locally
transferred artifact does not reproduce browser Mark-of-the-Web or SmartScreen
behavior. Preserve the final executable and SHA-256 checksums together;
see [the release review](REVIEW.md) for completed release checks.

## Linux x64 private nightly

Build Linux packages only in a fresh native Ubuntu 24.04 x64 checkout with Node
22.12 or newer and npm 11.17. Do not copy `node_modules` from macOS, Windows, or
ARM Linux.

```sh
npm ci --no-audit --no-fund
npm run dist:linux
```

The build creates these private, unsigned artifacts:

- `dist-founders/linux-unpacked/frostbyte-founders`
- `dist-founders/FrostByte-Founders-<version>-linux-x64.AppImage`
- `dist-founders/FrostByte-Founders-<version>-linux-x64.deb`

The packages contain the x64 checksum-pinned Kubo runtime, the Spark companion,
Studio V2, legal notices, and the same hardened Electron fuse policy used on
macOS and Windows. AppImage and Debian packaging register `magnet:`, `ipfs:`, and
`application/x-bittorrent`/`.torrent` sources. Opening one reaches FrostByte's
review flow; it does not start a transfer without confirmation.

Run the AppImage without root:

```sh
chmod +x FrostByte-Founders-<version>-linux-x64.AppImage
./FrostByte-Founders-<version>-linux-x64.AppImage
```

Some systems need the FUSE compatibility library. If FUSE mounting is not
available, use the AppImage runtime's extraction fallback instead of running as
root:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./FrostByte-Founders-<version>-linux-x64.AppImage
```

AppImage also requires unprivileged user namespaces for Chromium's sandbox and
the standard `unshare` utility. Its launcher now stops with an explanation if
that sandbox is unavailable; it never adds `--no-sandbox`. Prefer the Debian
package on systems whose security policy disallows AppImage user namespaces.
Do not disable the sandbox or weaken a system-wide security policy to launch it.
The packaged verifier likewise launches without a sandbox bypass.

Install or remove the Debian package through APT so its declared desktop
dependencies are resolved:

```sh
sudo apt install ./FrostByte-Founders-<version>-linux-x64.deb
sudo apt remove frostbyte-founders
```

Removal preserves settings, transfer history, credentials, and downloaded files.
Turn off **Start at login** before uninstalling to remove FrostByte's per-user
autostart entry. Application records default to
`~/.config/frostbyte-founders`; Electron interface data is in its `electron/`
subfolder, and downloads default to `~/FrostByte`. Remove those exact paths
manually only when their retained contents are no longer wanted.

Linux secret storage requires an unlocked desktop credential service. GNOME
sessions normally provide Secret Service through GNOME Keyring; compatible KDE
sessions use KWallet. The Debian package depends on `libsecret-1-0`, but a
library alone is not an unlocked user keyring. FrostByte refuses to save new
tokens or managed private keys if Electron selects its insecure `basic_text`
backend. Unlock or configure the desktop keyring and retry; do not bypass this
check for a headless machine.

Verify both container formats, their extracted payloads, native launch, desktop
associations, hardened fuses, Kubo receipt, companion parity, assets, and an
isolated profile under Xvfb when needed:

```sh
xvfb-run --auto-servernum npm run test:packaged -- \
  dist-founders/linux-unpacked \
  --installer dist-founders/FrostByte-Founders-<version>-linux-x64.AppImage \
  --installer dist-founders/FrostByte-Founders-<version>-linux-x64.deb
```

The private Founders nightly channel does not query or link to the public beta
update service. Updating is an explicit download and package replacement; it
does not replace the app, restart a companion, or delete the retained profile.
Linux ARM64, RPM, Snap, Flatpak, background tray mode, and public Linux signing
remain outside this x64 package.

## Limited beta distribution

The owner has authorized invite-only beta distribution before production signing.
The Mac app retains an ad-hoc signature and is not notarized. Windows executables
are unsigned. Testers may encounter warnings or policies that prevent installation.
Do not promise warning-free installation or ask testers to disable protections.
Use Blackfrost's own accounts for future signing; other businesses' accounts are
not part of this release. Current beta.15 checks and limitations are recorded in
the [security and functionality review](SECURITY-AND-FUNCTIONALITY-REVIEW-2026-09-12.md);
[tester readiness](TESTER-READINESS.md) is the historical record through beta.13.
