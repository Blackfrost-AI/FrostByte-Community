# FrostByte 2.0 privacy and feedback

FrostByte 2.0.0 does not collect analytics, automatic diagnostic reports or in-app
feedback. This is an enforced backend boundary, not a default-off checkbox.
Previous diagnostics opt-ins cannot activate collection.

The welcome screen presents bundled V2.0 terms and privacy notices before the
desktop transfer engine starts. Acceptance is saved locally in `privacy.json`.
An update that changes either notice requires review again. Earlier local
acceptance records are retained; settings, credentials, downloads and companion
state are not erased. Declining the notice does not stop an independently
running companion.

## No reporting transport

`src/main/privacy.js` has no reporting endpoint, HTTP transport, counters,
environment collector, report IDs, retry schedule or feedback attachment
generation. Its legacy observation calls are no-ops; operation wrappers return
the operation's own result or error without recording it.

Compatibility APIs fail closed. Attempts to enable diagnostics, prepare
in-app feedback or submit a report return an explanatory error. A disabled
preview returns `report: null`, not a would-be environment report. The main
process has no diagnostics timer.

The old report validators in `src/shared/reports.js` remain for historical
schema compatibility, not for desktop transmission. The legal-version constants
must exactly match `src/shared/legal.json`; an automated test enforces this.
No website reporting service, retention setting or existing server record is
changed by this application update.

## Optional GitHub feedback

The app opens only the exact official GitHub issue URL from
`COMMUNITY_LINKS.feedback` after the user's feedback action. It does not prefill
an issue body or append diagnostics, filenames, logs, credentials or other
application data.

The user decides whether to sign in to GitHub, write an issue and submit it.
Public repository issues may be visible to everyone. The app warns against
including secrets or sensitive data. GitHub handles that browser request under
its own privacy policy; not submitting feedback does not reduce functionality.

Community source publication was announced for Friday 16 October 2026, with
updates and pull requests regularly managed by Blackfrost AI/SI. FrostByte
Community 2.0.0 is licensed under Apache-2.0. This does not make the repository public early or
relicense private historical Founders releases, artifacts or documentation.

## Local state and necessary network requests

“No app collection” does not mean “no local state” or “anonymous networking.”

- Settings, libraries, destinations, transfer records, credentials and interface
  preferences are kept on the appropriate device for the app to work.
- Resource and transfer charts use local readings or information received over
  an approved companion connection. They are not analytics reports to Blackfrost.
- BitTorrent and IPFS exchange identifiers, network addresses and file pieces
  with relevant network participants. Sharing is not anonymous.
- Hugging Face and selected catalog/model services receive requests necessary
  for the feature, including approved credentials where required.
- Approved device discovery and existing WireGuard-overlay checks communicate
  with the selected network. They do not copy WireGuard private keys or change
  VPN routes.
- Optional update checks retrieve release metadata without attaching app
  history or an installation identifier. Hosting infrastructure can still
  process ordinary network metadata. Automatic checks can be disabled.
- External links and websites follow their operators' privacy policies.
  OS-level logs and earlier reports are not erased by installing V2.0.

Review the bundled privacy notice for credentials, retention and connected-device
details. Do not describe the whole application as network-free or anonymous.

## Verification

`npm run test:privacy` verifies disabled collection for fresh and migrated
profiles, preserved consent history, failure-safe persistence, disabled feedback,
no direct transport, no reporting timer and synchronized legal versions.

`tests/e2e/privacy-feedback.spec.js` covers the actual welcome screen,
persisted acceptance and manual external feedback. The hostile-renderer tests
verify that stale or manipulated calls cannot opt into reporting. The welcome
and ordinary workflow tests run with isolated profiles; production user data
must not be used as a test fixture.

Release testing must cover macOS, live Windows and Linux. Hardened packaged-app
smokes and source-backed workflow tests are separate checks and should be
reported as such.
