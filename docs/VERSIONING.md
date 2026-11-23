# Versioning and release process

`package.json` is the application version authority. Use semantic versions:
patches for compatible fixes, minors for features, and majors for incompatible
changes once the app reaches 1.0. During 0.x, describe compatibility changes
explicitly. A version such as 0.3.0 can remain on the **beta** distribution channel;
the number does not claim production readiness or platform signing.

1. Start a release branch from current `main`. Run
   `npm version VERSION --no-git-tag-version`, add the current section to
   `docs/RELEASE-NOTES.md`, and run `npm run release:check`.
2. Commit all reviewed changes, open a PR and pass development CI. Keep private
   source and planning documents in the private repository. CodeRabbit is disabled.
3. Freeze that source commit. Run `npm run release:begin -- dist` in the clean
   checkout, then build all three native targets from it. Run the packaged
   startup, payload/installer parity, and applicable desktop fixtures. CI uses a
   disposable Windows account for NSIS parity; never use that isolated installer
   test on the owner's normal Windows account.
4. After verification, run `npm run release:stage -- PLATFORM dist` on each native
   build host. This produces `build-info-PLATFORM.json` with the source commit,
   source tree and artifact sizes/hashes. Signing status belongs in the separate
   native verification record; staging does not infer trust from hashes. Committed
   build recipes regenerate icons and platform-specific dependency notices; their
   changed output hashes are recorded separately. Any application-source change
   after build preparation stops staging.
5. Collect the six native binaries and three receipts in one version directory.
   Run `npm run release:assemble -- DIRECTORY`. It rejects missing artifacts,
   mixed source revisions, hash mismatches and replacement metadata. Keep the
   generated `release-manifest.json` and `SHA256SUMS-VERSION` with the artifacts.
6. Merge the reviewed PR and create annotated tag `vVERSION` at the exact frozen
   source commit (which must be reachable from `main`). Never move a published
   tag or overwrite released bytes. A correction receives a new version.
7. Publish the six native artifacts plus `SHA256SUMS-VERSION`, its OpenPGP
   signature and the release public key to this repository's GitHub Releases
   page for tag `vVERSION`. Verify every uploaded asset's SHA-256 against the
   signed checksum list. Where the product website mirrors downloads, promote
   its release manifest, version displays and notes together only after
   artifact verification. Development history and private planning documents
   never go to the public product repository.
8. Verify the release page, update metadata, terms acceptance, all six complete
   downloads against SHA-256 (and the OpenPGP signature over the checksum list),
   and session sign-out. Create the public product
   release announcement with the official release link and matching notes.
9. **Then** update the owner's `/Applications/FrostByte.app` and per-user Windows
   installation, preserving profiles, device pairings and downloaded files.
   Launch both and verify installed versions. Keep rollback copies only until
   verification succeeds; remove temporary build checkouts afterward.

The updater checks metadata only. Automatic checks remain optional and off by
default; downloading and installing remain user choices. Existing 0.2 beta
clients recognize 0.3.0. Publishing an update does not silently replace apps or
restart users' remote companions. Devices offers explicit companion updates.

Record source/tag, CI runs, artifact hashes, website commit/rollout, live-download
results and owner installation results for every release. Promote a previous
verified manifest if rollback is needed; preserve immutable artifacts and do not
silently downgrade installed clients. Stop promotion if either target fails.

Published 0.3.0 uses the public beta exception: ad-hoc Mac, not notarized;
unsigned Windows. Developer ID and Keychain notarization are configured for the
new local Mac candidate. Signed distribution requires the strict platform checks;
do not treat the beta verification mode as a production-signing pass. Windows
production signing remains pending.

## Version-consistency check (added 1.2.0)

Two guards run on every `npm test`, so version tracking no longer depends on
someone remembering:

- `tests/release-tracking.test.js` fails when `package.json` and
  `package-lock.json` disagree, when the newest `docs/RELEASE-NOTES.md` section
  is not the version being shipped, when notes repeat or go backwards, when a
  `v*` tag points at a commit whose `package.json` names a different version, or
  when the shipped version is neither tagged nor ahead of the last tag.
- `npm run release:check` remains the release-time gate (package, lockfile and
  notes must agree).

History this check was written against (maintainer repository): `1.1.0` and
`1.1.1` were both cut without a tag, and `1.1.1` shipped with no notes
section, so `release:check` failed until `1.2.0` backfilled the `1.1.1` section
and the tags. This repository's fresh history begins at the curated `v2.0.0`
tag.

## V2.0 cross-surface version check

V2.0 adds `scripts/sync-version.mjs`, invoked by `npm run version:sync` and
`npm run release:check`. It keeps `package.json` as the single active product
version and checks the lockfile root fields, the leading release-note section,
runtime UI wiring, diagnostics, and (only when a separate website checkout is
present) the website release identity. `tests/version-sync.test.js`
runs it from `npm test` and also guards the public-artifact boundary.

Active UI labels derive from `app.getVersion()`; frozen site artifact records,
dependency versions, protocol versions, and historical notes are not swept by a
global replacement. The release-facing version map is the GitHub Releases page
and `docs/RELEASE-NOTES.md`. A public 2.0.0 release is created only from real
signed artifacts and a separate owner-authorized release phase.

## Public 2.0.0 release record

The public Community 2.0.0 release is published on this repository's GitHub
Releases page: six native artifacts (macOS DMG/ZIP, Windows EXE/ZIP, Linux
AppImage/deb), `SHA256SUMS-2.0.0` and its OpenPGP signature. The release was cut
from the annotated tag `v2.0.0` in this repository; artifact hashes are in the
signed checksum list attached to the release. Local, unpublished build and
install records (including pre-publication Developer ID candidates) live in the
maintainer's private repository and are not shipped here.

Local installs follow a verify-before-delivered rule: build in a dedicated
workspace, quit the installed app cleanly, keep a verified rollback bundle, and
verify the installed bundle before declaring the work delivered. A local install
does not authorize a website update, public release, or push of immutable
artifacts.
