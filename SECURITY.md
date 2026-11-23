# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 2.0.x (Community) | ✅ security fixes |
| 1.x (Community) | best-effort; upgrade to 2.0.x |
| betas / Founders | ❌ retired |

## Reporting a vulnerability

**Do not open a public issue for security problems.**

- Preferred: GitHub private vulnerability reporting
  (Security → Report a vulnerability) once this repository is public.
- While the repository is private, or for anything involving the hosted
  platform: email **support@blackfrostai.com** with subject "SECURITY".

Please include: affected version/platform, reproduction steps, impact, and any
proof-of-concept. We aim to acknowledge within 72 hours and to ship or mitigate
confirmed high-severity issues before public disclosure. Coordinated disclosure
credit is offered unless you prefer anonymity.

## Scope notes

- FrostByte transfers model files peer-to-peer. Payload integrity gates (hash
  verification, origin signatures, safe-file screening) are security-relevant;
  bypasses are in scope.
- Model weights are data, not trusted code. Reports about malicious model
  distribution that bypass the integrity gates are in scope.
- Release artifacts are authenticated by the OpenPGP-signed `SHA256SUMS` list
  (key fingerprint `585A 5E6E D8E5 0B38 90A4 4CBB 5CFE 2F13 0753 BD6E`).
  macOS artifacts are Developer ID signed; Apple notarization and Windows
  Authenticode signing are pending production-signing work, disclosed in the
  release notes.

## Out of scope

- Findings requiring a compromised local OS account or physical device access.
- Social engineering, spam, or denial-of-service by volumetric flooding.
- Third-party services (Hugging Face, GitHub, trackers) — report upstream.