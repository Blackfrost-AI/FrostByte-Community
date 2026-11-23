# Private development and releases

Current Community version: **2.0.0**, licensed under Apache-2.0. The default
checkout and packaging identity are Community. Founders is retired and private.
See [VERSIONING.md](VERSIONING.md) for provenance and immutable artifacts and
[RELEASE-NOTES.md](RELEASE-NOTES.md) for the current product release.

Repository: https://github.com/Blackfrost-AI/FrostByte-Community

Keep this repository private until the owner explicitly authorizes Community
source publication. Do not expose private history, Founders
artifacts, workflow logs, credentials, local profiles or unrestricted build
directories on the product website. Public downloads consist only of the six
approved, tested Community artifacts and public verification files.

## Licensing

FrostByte Community 2.0.0 uses Apache-2.0 in `LICENSE`.
`NOTICE` records attribution and historical-release boundaries. The npm metadata
is `Apache-2.0` with `private: true` to prevent accidental package publication.
Historical private Founders releases retain their original supplied license;
the dormant packaging profile uses `build/founders-LICENSE.txt`.

Dependencies and fonts remain independently licensed. `npm run build:licenses`
preserves upstream notices and attribution, including MPL-covered networking
source locations. Do not relabel third-party components or restrict rights they
grant. Earlier release artifacts and previously granted rights are unchanged.

## Develop

Use Node 22.12 or newer with npm 11.17 or newer, install with `npm ci`, and run
`npm start`. Exact dependency lifecycle versions are governed by `allowScripts`.
Use feature branches and pull requests. Run relevant tests for every change;
`npm test` covers backend logic, including live public Hugging Face checks, and
`npm run test:e2e` runs desktop workflows in isolated temporary profiles.

Windows uses native x64 Node and a fresh `npm ci`; never reuse another OS's
installed dependencies. Unix companion/installer fixtures depend on file modes,
Unix sockets, shell and Python. Use the Windows-safe unit matrix plus native
packaged startup/lifecycle and source-backed workflows; do not describe an
unsupported `npm run test:all` command as native Windows qualification.

Physical Spark tests are opt-in. Pairing tests use isolated SSH fixtures and
OS-backed encrypted storage. Never bypass a Keychain prompt or use owner profiles
as test fixtures. Quit installed apps normally, archive and verify rollback
copies on the delivery SSD, then replace bundles and verify owner-data parity.
Never automatically accept new legal notices on the owner's behalf.

## Package and qualify

Build all three platform pairs from one frozen source commit/tree. Run
`release:begin` before packaging in a clean checkout, `release:stage` on each
platform, then `release:assemble` after all six final artifacts and native
receipts are collected. Sign the exact immutable checksum list with the existing
publisher key and re-verify all hashes and its pinned full fingerprint.

Community packaging uses `npm run dist:mac:community`,
`npm run dist:win:community` and `npm run dist:linux:community`. Native dependencies
must match the target OS and architecture. Never commit `dist/`, installed
dependencies, local state, tokens, private keys or signing credentials.

For the owner-approved October 13, 2026 release, reuse the existing signing
approach: Developer ID signed Mac app/DMG without Apple notarization, unsigned
Windows Authenticode, and Blackfrost OpenPGP-signed SHA-256 sums for all six files.
This is a disclosed release-specific exception, not a claim that the strict
`--require-release-signature` gate passed. Preserve the strict notarized Mac
recipe in `build/signing-macos.cjs` and native signature checker. Do not weaken
OS protections or describe these packages as notarized or SmartScreen-approved.

Mac and Desktop-128 Windows qualification use actual target machines. Linux
functional qualification uses x64 userspace in Docker on an arm64 Mac; record
that limitation and do not claim native x64 kernel/seccomp qualification.
Keep sandbox enforcement enabled in shipped Linux packages.

## Product page

The product website is maintained in a separate private repository (domain
migration in progress; the previous canonical host was
`blackfrostai.com/frostbyte`). Official installers are published on this
repository's GitHub Releases page. Frostnet remains shelved and is not a
deployment target.

FrostByte Community 2.0.0 downloads require no invite, account, acceptance form or browser
session. Keep the artifact bucket private: allowlisted files receive short-lived,
generation-pinned URLs only after byte count and checksum metadata match.
Publish the checksum list, detached signature and public key alongside the
release. Never publish credentials or embed expiring storage URLs in HTML.

Promote both sites only after platform QA and uploaded-byte verification.
Existing release objects and historical installers remain immutable.
