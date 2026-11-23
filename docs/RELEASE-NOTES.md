# FrostByte 2.0.0 — Local AI Assistant, Model Integrity Gates, and Honest Version Tracking

FrostByte 2.0.0 adds a device-local AI assistant sidebar, cryptographic integrity
gates for P2P-shared models, and the AEON Model Share integration, on top of the
verified 1.2.0 download and fleet foundation.

## Added

- AI Assistant sidebar (Beta): general chat against models already loaded on your
  devices. Local runtimes are discovered automatically — no endpoint setup in
  Settings — and every model on every connected device is listed in one picker.
  A managed llama.cpp runtime (pinned build b12584) ships inside the app and is
  signature-verified at launch.
- Model integrity gates for P2P sharing: format-safety checks before a shared
  model is accepted, Hugging Face hash anchoring for provenance, completion gates
  on real transfers, TOCTOU-safe review, and revocation warnings that survive
  restarts. Single-file scans and share/launch gates are enforced in the desktop
  app, not only on the website.
- AEON Model Share integration: share and receive model bundles with the AEON
  workflow merged into the Community edition.
- My HF account surface and in-app account management groundwork, aligned with
  the website's pubkey-canonical identity (handle alias preserved).
- Version tracking: the app and website now agree on the product version, and the
  download page serves only verified, published artifacts.

## Changed

- The Models tab is now Search, matching what it does.
- FrostNet in the app shows a Coming Soon placeholder while the community home
  (updates, shared models, connections) is built; the website /frostnet discovery
  utility remains live.
- Managed-runtime and assistant surfaces follow the active theme.

## Fixed

- Assistant sidebar theme switching and managed-runtime panel styling follow-ups
  from the 2.0 development cycle.
- Transfer review hardening: risky loose files and mid-review swaps are caught by
  the integrity gates instead of being published silently.

## Verification

- Source regression at the release commit: 893 unit tests and 210 end-to-end
  tests pass (9 hardware-only skips), including the full integrity suite with a
  real two-seed loopback transfer.
- Packaged suite against the installed bundle: 210 passed / 9 skipped, all 8
  integrity specs green; installed-app verifier PASS; codesign deep-strict PASS;
  pinned llama.cpp runtime verified; real-GGUF load + completion smoke passed.
- macOS artifacts are signed with the FrostByte Developer ID certificate
  (hardened runtime, library validation). Apple notarization is not yet applied
  to public installers, so macOS may require right-click → Open on first launch.
  Windows and Linux artifacts are unsigned. The checksum list for every platform
  carries a detached publisher signature: verify any download against
  SHA256SUMS-2.0.0 and SHA256SUMS-2.0.0.asc before installing.

## Known limitations

- The AI Assistant is Beta plumbing for general chat only. GPU-fit questions,
  download orchestration, and security scanning are future work; antivirus
  scanning of shared models is explicitly deferred.
- FrostNet community home content and backend are not complete; the app section
  is intentionally inactive.
- macOS Gatekeeper, Windows SmartScreen, and Linux package managers will warn
  about installers that are unnotarized or unsigned; verify the publisher
  signature on the checksum list, then use right-click → Open on macOS.
  Apple notarization of public installers is planned for a follow-up build.