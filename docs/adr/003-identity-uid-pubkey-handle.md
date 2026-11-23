# ADR 003 — Identity binding: Firebase uid ↔ publisher pubkey ↔ handle

- **Status:** Accepted — 2026-11-17
- **Decision owner:** repository owner (Craig), answering the release-gap review
  ("keep it with alias", 2026-11-16/17).
- **Supersedes:** nothing. Constrains P1 (accounts), P2 (share loop / attribution)
  and P3 (creators / follows) of
  `plans/2026-11-16-frostnet-search-home-accounts-roadmap.md`.
- **Related:** ADR 002 (deployed backend = Firebase hubApi on `blackfrost-ai-prod`;
  the `hub/` fixture is a reference, not the service).

## Context

Three identity namespaces exist today and none is bound to the others:

1. **Firebase uid** — the account plane. `platform/functions/src/app.js` keys every
   `/v1/me*` route on the verified ID token's uid; profiles live in the `users`
   collection with a client-writable field allowlist
   (`platform/functions/src/store/contract.js:66-72`). No publisher concept exists
   in the deployed backend (grep: zero `pubKey|publisher` matches).
2. **Publisher pubkey (hex64, Ed25519)** — the signing plane. The desktop creates a
   local keypair (`src/main/publisher.js`), stores it OS-keychain-protected
   (`publisher-record.js`, schema 2), and signs every publication with it
   (`publisher.js:146-156`, `signPublication` → `{pubKey, pubName, pubSig}`).
   The shipped client contract is hex64: follows/creators routes
   (`hub-client.js`), fixture creator/follow routes
   (`hub/src/app.js:263,271`), and `verifyPublication` (`publisher.js:158-160`).
3. **Username / display name** — the human plane. The publisher record carries its
   own free-text `username` (≤64 chars, `publisher-record.js:20-22`); the account
   profile carries `displayName`. Neither is unique, reserved, or validated as a
   handle.

Without a binding, "attribution = handle" in P2 is spoofable: anyone could publish
a manifest claiming any name, and a handle could silently re-point at a different
key. With a binding, signatures prove *who published*, the account proves *who owns
the key*, and the handle is a stable, reserved alias for both.

## Decision

**Pubkey-canonical creators and follows, with a reserved handle alias.**

1. **Canonical creator identity = publisher pubkey (hex64).** All creator routes,
   follow sets, and manifest attribution key on the pubkey. The shipped hex64
   client contract is kept verbatim — no client migration.
2. **Handle = unique, reserved, human-readable alias** on the account profile
   (`users/{uid}.handle`), lowercase `[a-z0-9_]{3,24}`, reserved words blocked,
   case-insensitive uniqueness enforced by a reservation document
   (`handles/{handle}` → `{uid, reservedAt}`) written in the same transaction as
   the profile update. A handle is an *alias*, never a key: creator lookups accept
   `/v1/creators/{pubkey}` (canonical) and resolve `/v1/creators/by-handle/{handle}`
   to the bound pubkey; follows always store pubkeys.
3. **Binding uid ↔ pubkey happens at publish time, server-side, and is
   challenge-verified.** To register a publisher key on an account:
   - `POST /v1/me/publisher-key` (authenticated) with `{pubKey}` → server issues a
     single-use challenge nonce bound to `{uid, pubKey}` (TTL ≤ 10 min).
   - Client signs the nonce with the publisher private key (the same Ed25519 key
     that signs publications) and returns `{pubKey, challenge, signature}`.
   - Server verifies the signature against the claimed pubkey (SPKI reconstruction
     exactly as `publisher.js:165-173`), then writes
     `users/{uid}.publisherKeys[pubKey] = {boundAt, challengeId}` and a reverse
     index `publisherKeys/{pubKey} → {uid}`. **One pubkey binds to at most one uid**
     (transaction on the reverse index); a uid may hold several keys (rotation).
   - Unbinding is account-owner-only and tombstoned; re-binding a released key
     requires a fresh challenge. Attribution history is never rewritten.
4. **Attribution on every published manifest is the signing pubkey, not a name.**
   `pubName` stays informational (display convenience) and is never trusted for
   identity. The server rejects a publish whose signing pubkey is not bound to the
   authenticated uid (P2 gate). Display layers resolve pubkey → bound account →
   handle; unbound keys render as `pubkey[:12]…` with an "unverified" badge —
   exactly the fixture's current honest fallback (`hub/src/app.js:266`).
5. **Handle changes do not break attribution.** Because follows and manifests key
   on pubkey, renaming a handle re-points only the alias. Old handles are released
   after a grace period (default 30 days) during which they resolve to the same
   uid with a "formerly @old" note; reservation uniqueness is checked against both
   active and grace-period handles.
6. **The local publisher `username` becomes a display-name hint, not an identity.**
   On first successful key binding the app offers to sync it to the account handle
   (subject to reservation); it never overrides a reserved handle silently.

## Consequences

- P1 backend work: `handle` + `bio` join `CLIENT_WRITABLE_USER_FIELDS` with strict
  validation; `handles` reservation collection + transactional `updateUser` path;
  `publisherKeys` binding routes + challenge store; public projection
  (`/v1/creators/*`) exposes only `{pubkey, handle, displayName, bio, verified,
  stats}` — never uid, email, or billing fields.
- P2 publish gate: signing pubkey must be bound to the caller uid; withdraw is
  owner-only via the same binding. Signature verification reuses the existing
  Ed25519/SPKI code path — no new crypto.
- P3 follows/creators UI keeps the hex64 contract; handles are resolved for display
  and search only. "Follow by handle" resolves to pubkey client-side before the
  existing follow call.
- Key loss ≠ account loss: the account (uid) survives; the user generates a new
  publisher key, binds it, and old publications keep their original attribution
  (marked "key rotated" when the account chooses to link them). Recovery phrase
  flow (`publisher-manager.js`) is unchanged.
- The fixture (`hub/`) may implement a simplified in-memory version of the binding
  for tests, but the deployed hubApi is the authority (ADR 002).

## Alternatives rejected

- **Handle-canonical creators/follows (migrate the client):** breaks the shipped
  hex64 contract, makes attribution depend on a mutable, socially-squattable name,
  and forces a client migration before any sharing ships. Rejected by owner.
- **uid-canonical public creators:** leaks the account identifier into public
  surfaces and couples the signing plane to Firebase auth availability; offline
  bundle verification would need uid resolution it cannot do. Pubkey stays the
  public anchor.
- **Trust `pubName` for attribution:** trivially spoofable; the whole point of the
  signing plane is that names are claims and keys are proof.
