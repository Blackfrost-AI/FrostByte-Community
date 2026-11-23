# Mac distribution signing

`build/signing-macos.cjs` is an explicit local distribution profile for pinned
electron-builder 26.15.3. It inherits the normal YAML's hardened runtime,
ARM64 DMG/ZIP targets, legal notices and companion payload. It replaces the
local entitlement set with `build/entitlements.mac.release.plist`, which keeps
Apple library validation enabled. Output
goes to `dist/signed-macos` for Community or `dist-founders/signed-macos` for
Founders; publishing is disabled. The ordinary ad-hoc build is
unchanged. No signing account, certificate or notarization credential is created
by loading this profile.

Before a real build, obtain the paid team's **Developer ID Application** identity
in the OS Keychain and store notarization credentials with Apple's `notarytool
store-credentials` workflow. Complete Apple's prompts directly; keep passwords
and API keys out of repository files, command history and agent output. Team/account
selection and credential setup are complete on the owner's Mac as of September
14, 2026. Build credentials remain in Keychain; Apple Development certificates
do not satisfy distribution signing.

The profile requires two non-secret environment values:

- `FROSTBYTE_MAC_SIGNING_IDENTITY`: the exact full label, such as
  `Developer ID Application: Your Legal Organization (TEAMID1234)`.
- `APPLE_KEYCHAIN_PROFILE`: the name of the existing notarization credential
  profile. `APPLE_KEYCHAIN` is optional for a custom Keychain; otherwise Apple's
  default Keychain lookup applies. The saved credentials must belong to the same team.

If supplied, `APPLE_TEAM_ID` must match the identity's team. Competing Apple ID/API
credential variables and certificate-import variables are rejected. Builder 26
strips the certificate class from its identity qualifier, so this profile validates
the complete label and passes the organization/team with `type: distribution`.
It forces code signing and enables notarization; missing metadata or a context
where builder would skip signing stops the build instead of falling back to ad-hoc.

Use a **new release version**, then run `npm run dist:mac:signed`. It prepares
icons, legal notices, IPFS and the companion payload; invokes the distribution
profile; and submits/staples the final DMG after builder has notarized the app.
The ZIP is created from the already stapled app. Do not overwrite a published
version or reuse its hashes. Keep native verification evidence beside the
source/hash receipt; artifact staging itself does not establish signing status.

The metadata tests run with `node --test tests/macos-signing-config.test.js`.
They use synthetic values and the real builder config/schema and notarization
option resolver, without reading Keychain contents or submitting software.

Packaging also applies the complete policy in `build/harden-electron.cjs` with
the pinned `@electron/fuses` release. It disables Electron's Node execution,
environment-option, inspector and extra file-protocol entry points; requires
ASAR integrity and ASAR-only startup; and fails when a new fuse has not been
reviewed. `npm run test:release` validates both policies.

A successful build still requires Accepted notarization, strict signature and
staple validation, Gatekeeper acceptance, and a browser-origin installation test
on a separate Mac with protections intact. Check the app inside the ZIP as well
as the DMG; never strip quarantine to claim a pass. Rerun native packaged startup,
installer payload parity, the source-backed workflows, and saved-credential
reconnection, then publish a new manifest/checksum set. See the
[current security and functionality review](SECURITY-AND-FUNCTIONALITY-REVIEW-2026-09-12.md) and
[Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

The packaged release gate requires the contained app's first signing Authority
and TeamIdentifier to match the full configured Developer ID Application identity.
It also checks every Mach-O entitlement, the stapled app and DMG tickets, and
Gatekeeper. It mounts the named DMG and compares its full application payload
with the reviewed bundle; the DMG's own signing authority is not separately parsed:

```sh
npm run test:packaged -- --require-release-signature \
  dist-founders/signed-macos/mac-arm64/FrostByte\ Founders.app \
  --installer dist-founders/signed-macos/FrostByte-Founders-<version>-mac-arm64.dmg
```
