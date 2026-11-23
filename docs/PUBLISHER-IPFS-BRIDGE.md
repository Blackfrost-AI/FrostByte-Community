# Publisher identity, hash-first IPFS publish, and resilient downloads

**Status:** Phase 1 publisher identity implemented; Phases 2–6 remain proposed work.
**Branch:** `aeon/publisher-ipfs-bridge`, targeting `main` after the theme merge.
**Scope:** optional publisher identity and a separate bridge roadmap. No community publication or additional transport is enabled by creating an identity.

## Goals

1. **Publisher identity** — BIP39 mnemonic → ed25519 key; register/import in Settings; unlock to sign.
2. **Publish & sign** — one CTA; sign uploads when unlocked.
3. **Hash-first dedupe** — if weight SHA-256s already exist on the IPFS/Aether network, **do not re-upload**; become another **provider** source.
4. **Dual network** — in-scope shared disk files propagate on BitTorrent **and** IPFS with the same manifest (cards, hashes, validation).
5. **Quarantine** — type check + streaming AV/malware pass + hash verify before library release (both protocols).
6. **Resilient IPFS downloads** — pause / offline / resume like torrents (partial checksum + offset).
7. **Live replicas** — surface how many peers are *actively serving* bytes, not merely gossip-announced.

## Non-goals (this PR)

- Merging HF + BT + IPFS piece schedulers into one accelerated job (document as Phase F follow-up).
- Granting Orb HID/MCP via theme or publisher identity.
- Auto-publishing gated/private HF content.
- Shipping Valorax (commercial); keep OFL stand-ins from #17.
- Full adversarial model eval in a GPU sandbox (research track; hash/magic/streaming gates are the Phase 4 baseline).

## Architecture

### Optional local archive source (accepted direction, 2026-09-16)

Dan Kelly's ModelArk proposal supplies verified original files **before** the
reviewed Sharing/publish pipeline. Cold-media preparation is its own Transfers
job; archival custody is not live replication, and completion never enables
Sharing automatically. Preserve vendor authority, original-byte verification,
and hold ownership separately. The concrete product and code mapping is retained in the private archive.
The provider client/API is still pending, not an implemented Phase 2 capability.

```
Settings → Publisher          Inventory / Transfers
  create/import/unlock   →      Publish & sign
         │                            │
         │                     hash weights (sha256)
         │                            │
         │              ┌─────────────┴─────────────┐
         │              │ already on network?       │
         │              └─────────────┬─────────────┘
         │                     yes/no │
         ▼                            ▼
   ed25519 sign            provider pin+attest     origin package+upload+sign
         │                            │                      │
         └──────────── announce / Sharing ───────────────────┘
                              │
                    BT seed  +  IPFS publisher pin
                              │
                    Aether community pin / gossip (aeon-model-share/v1)
                              │
                    live serving count (N-copies) ≠ last-seen gossip
```

Users explicitly select the files, device, folder, and sharing protocols. Enabling Sharing does not publish a listing or enroll an existing share in a new protocol or community. Public publication needs a separate preview and confirmation. A new download keeps its explicit sharing preference.

The model folder and Kubo blockstore are distinct storage systems. Ordinary IPFS imports may consume additional disk space. Account for that space before publishing; do not promise zero-copy storage until an appropriate import/storage mode is implemented and tested.

Discovery may use a community namespace carried by the software. A namespace is a routing label, not authentication or a private-network boundary. Gossip is a discovery hint; it is not proof of durable storage.

### Share Manifest (join key)

Versioned JSON (stored with inventory + embedded as `model-card.json` sidecar / companion file in IPFS directory):

```json
{
  "schema": 1,
  "name": "org/model",
  "source": "https://huggingface.co/org/model",
  "revision": "abc…",
  "license": "apache-2.0",
  "card": { "kind": "llm", "params": "8B", "quant": "gguf-q4_k_m", "format": "gguf", "tags": [] },
  "files": [{ "relative": "model.gguf", "size": 0, "sha256": "…" }],
  "seal": {
    "kind": "hf-revision",
    "repo": "org/model",
    "revision": "abc…",
    "bound_at_ms": 0,
    "authority": "huggingface"
  },
  "infoHash": "optional-40-hex",
  "cid": "optional-bafy…",
  "verified": true,
  "origin": { "pub_key": "hex", "pub_name": "petname", "pub_sig": "base64", "added_at_ms": 0 },
  "providers": [
    {
      "peer_id": "…",
      "pub_key": "…",
      "pub_sig": "…",
      "role": "provider",
      "location": { "kind": "ipfs", "cid": "bafy…" },
      "live": false
    }
  ],
  "replicas": { "announced": 0, "serving": 0, "as_of_ms": 0 }
}
```

Keep the content manifest immutable. Its own final CID/infohash and signatures belong in an external publication envelope, avoiding self-referential content identifiers. Source URLs, file names, and display text remain untrusted metadata.

Match **sha256**, never filenames alone. Interop with AEON Orb `ModelEntry` / `publication_digest(cid, name, sha256, added_at_ms)`.

#### Sealed revisions (Transfer Era)

While Hugging Face (and other authority repos FrostByte already supports) still host weights, prefer **sealed** manifests:

- Bind each file `sha256` to `repo@revision` (or equivalent authority commit) in `seal`.
- Reject mirrors that fail hash/validator checks — do **not** rely on karma alone.
- Known-bad `pub_key`s may be blocked locally / community-denied when evidence exists (ban list is explicit, auditable, and never silent).

Sealing does not replace live replica checks; it gives a strong origin truth while the Transfer Era lasts.

#### Locations vs live N-copies

Keep these separate everywhere (UI, gossip, manifest):

| Signal | Means | Counts as replica? |
|--------|--------|--------------------|
| Gossip / last-seen peer | Daemon was reachable and announced a CID | **No** |
| Location claim | Peer asserts blocks live at a path/CID | **No** (claim only) |
| Live serving (N-copies) | Peer can still open the mount, pin is present, and a random/known piece would still hash | **Recent serving evidence only** |

Cold or cycled USB volumes, unmounted disks, and GC'd DAGs must not inflate availability. A valid sampled piece is not proof of a complete durable copy. Report the observation method, time, and expiry; use unknown when there is no reliable observation.

## Phase commits (implement in this order)

### Phase 0 — Spec (this document)
Land contract + test plan. No behavior change. Updated with ModelArk-aligned notes: live N-copies, sealed `repo@rev`, streaming quarantine, pull→share default.

### Phase 1 — Publisher identity (implemented; corrected after review)
**Implementation:**
- `publisher.js`: 24-word identity recovery, password encryption and Ed25519 signing helpers.
- `publisher-manager.js`: OS-backed protection, persisted backup requirement, one-minute recovery views, and session locking.
- `publisher-record.js` / Store: bounded, versioned records; encrypted payloads stay out of public app state.
- Narrow IPC and Settings → Publisher UI. Publisher setup is optional and does not publish anything.

**Recovery:** Create/import saves an OS-protected, password-encrypted key with backup still required. Closing the app or leaving Settings preserves that requirement. The recovery text clears on navigation, focus loss, and timeout. To resume setup, enter the password and approve a fresh native reveal. The main process accepts acknowledgment only for the current unexpired reveal. Unlock/signing stays unavailable until backup is confirmed. Suspend and screen lock clear the signing session.

The recovery phrase is deliberately shown to the user during an approved recovery flow; it is never written to app storage or diagnostics. Clipboard copying is an explicit action and may be retained by clipboard history. No app can retract a phrase that the user has copied elsewhere.

**Storage:** scrypt + AES-GCM inside Electron safeStorage. Creation/recovery requires an available OS key store and rejects the Linux `basic_text` backend. Existing password-only development records migrate through approved recovery and require backup confirmation. An encrypted state-file copy alone is not a portable backup; the recovery phrase restores the identity on another computer.

**Interop:** the identity uses the same 32-byte BIP39 entropy as AEON. Publication signatures cover the exact UTF-8 `aeon-publish/1` message from [the reviewed AEON implementation](https://github.com/AEON-7/aeon-magick-ai-computer-control/blob/bdb3a571e98d719ba32780c81212c0a053a005e2/aeon-supervisor/src/publisher.rs), without an extra SHA-256 prehash. `tests/fixtures/publisher-aeon-vector.json` contains a public test vector produced independently with Python cryptography, plus the upstream source reference. Private-key storage formats differ across the apps; recovery restores the same identity.

**Coverage:** `npm run test:publisher` covers persistence, recovery, locking, OS-store failure, legacy migration, and signature compatibility. `tests/e2e/publisher.spec.js` exercises setup/restart, navigation/timeout cleanup, cancellation, import and migration. Mac/Windows runs use real Keychain/DPAPI; Linux CI uses a test-process-only protection adapter for UI checks.

### Phase 2 — Hash-first Publish & sign
**Files:** `src/main/share-manifest.js`, hooks in `ipfs.js` / inventory UI.

Flow:
1. Hash selected weight files.
2. If HF (or other authority) provenance is known, attach `seal` (`repo@revision` + bound hashes).
3. Probe local registry / known CIDs / provider index by sha256.
4. **Novel** → quarantine → package → add/pin → sign as **origin**.
5. **Exists** → validate the known CID and canonical import/chunking format, then use selected local bytes to become a provider. Do not fetch a duplicate merely to pin. UI: "Already on the network — adding you as another source."
6. Manifest `providers[].location` records where; `replicas.serving` is computed from live probes, not gossip alone.
7. Reject / refuse publish when sealed hashes disagree with authority (when online and seal present).

### Phase 3 — Dual BT ↔ IPFS mirror
After the user explicitly opts this collection into both protocols:
- Ensure torrent seed **and** IPFS publisher pin for the same manifest.
- Sharing off stops both for that collection.
- Protocol checkboxes under the main switch preserve the user’s selection; existing shares retain their existing scope.
- Publishing or announcing the collection to a community still requires separate consent. Downloading into a folder never grants publication permission.

### Phase 4 — Quarantine + AV (streaming-capable)
Shared pipeline for torrent complete + IPFS complete:
1. partial/quarantine path
2. magic-byte / type gate (baseline: reject unexpected executables; treat pickle/torch pickle as high-risk — allow only with explicit user override, not by default)
3. **Streaming** AV / malware pass in bounded chunks. Before making scanning a production gate, define scanner availability, installation, error states and support for Mac, Windows and companions. An unavailable scanner must not be described as a passed scan. Preserve intentional software and other non-model torrent downloads; model publication rules are separate.
4. final sha256 (and seal check when `seal` present)
5. promote to library

Full model-sandbox behavioural eval of malicious weights is **out of scope** for this PR; hash invalidity + publisher ban are the primary Transfer Era defenses against fake mirrors.

### Phase 5 — Resilient IPFS resume
Build on existing `partialHash` + `cat offset` in `ipfs.js`:
- Auto-pause when peers stall / offline (not hard fail)
- Restore jobs paused across restart
- Re-resolve providers by sha256/CID on resume; prefer peers with live serving evidence
- Torrents-parity UX copy in Transfers

### Phase 6 — Aether gossip + live replica counter
Announce signed manifests on `aeon-model-share/v1` for Orb/FrostByte shared **community pin** (swarm id), not a DNS domain.
- Gossip = discovery / routing hints only.
- Maintain a live **"actively serving"** counter (and optional announced-but-not-verified count) in Transfers / model detail.
- Periodically re-verify a sample of local pins so GC / unmount drops `live` without waiting for a failed download.

## Safety

- Explicit publish / Sharing only.
- Gated HF never auto-public.
- Theme never grants device access (unchanged).
- Publisher secret 0600 / password seal; no telemetry of seeds, paths, CIDs in diagnostics.
- Preserve foreign `origin` signatures when mirroring; provider role is separate.
- Model plane only.
- Ban / deny lists for known-bad `pub_key`s are explicit and user-visible when applied.
- Never equate gossip last-seen with durable copies.

## Test plan

- [x] Create publisher → unlock → sign digest → verify
- [x] Import same mnemonic on second profile → same pubkey
- [x] Wrong password fails; export mnemonic round-trips; backup requirement survives restart and UI recovery is covered
- [ ] Publish novel files → CID + origin signature in manifest
- [ ] Sealed HF `repo@rev` binds hashes; mismatched mirror rejected
- [ ] Second client with same bytes → provider path, no full re-upload
- [ ] Sharing on → BT peers and IPFS retrieval both succeed; hashes match
- [ ] Pause IPFS mid-download, kill network, resume later → byte-identical
- [ ] Quarantine rejects executable / bad magic; streaming AV fail blocks library
- [ ] Gossip-announced-only peer does **not** increment "actively serving"
- [ ] Unmount / GC local pin drops live count without a download attempt
- [ ] AEON Orbit theme from #17 still loads; credit link intact (release verification)
- [ ] `npm test` / `npm run test:ipfs` / `npm run test:publisher` / relevant Electron specs green

## AEON Model Share bridge, part 1 (implemented)

The AEON Orb repository now fixes the wire contract in
`docs/MODEL_SHARE_PROTOCOL.md` with signing vectors. It supersedes the `origin`
and `providers` sketch in the Share Manifest above: an origin statement is
`aeon-origin/1`, signed over the sorted file list and stored inside the shared
folder's `model-card.json`.

Implemented from that contract, without changing any consent rule:

- `src/shared/aeon-origin.js` verifies origin, delegation, peer-binding and
  identity-proof statements. `tests/fixtures/model-share-vectors.json` is the
  Orb's vector file, unchanged.
- A completed IPFS or BitTorrent download with an AEON card is held to it and
  the result is shown on the library card. A failed copy is not shared.
- IPFS sharing imports with the protocol's fixed parameters, and a release
  manifest records the CID while the same files are shared over IPFS.

This is the hash and signature part of Phases 2 and 4. Hash-first publishing,
the opt-in dual mirror, the format gate and scanner, and gossip remain proposed.

## PR workflow

Keep the current PR scoped to the implemented publisher identity, tests and this roadmap. Target `main`, preserve AEON's commits, and merge only after the updated checks pass. Later phases need their own implementation and acceptance evidence; green identity tests are not evidence of public-network acceleration.

## References

- `docs/IPFS-AEON.md` — current IPFS transport (no catalog sync yet)
- `docs/HF-HYBRID.md` — sha256-before-peer pieces
- `docs/AEON-THEME.md` — Orbit visual system (#17)
- AEON Orb `publisher.rs` / `ipfs.rs` — identity + quarantine precedent
- ModelArk / Annex peer discussion (2026-09) — live N-copies vs gossip, Transfer Era sealing, streaming quarantine, NAS+IPFS host role
