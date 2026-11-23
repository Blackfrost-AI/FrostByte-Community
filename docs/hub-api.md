# Hub API contract (v3 — recipe share plane + community home)

The deployed authority is `platform/functions` (codebase `hub`). The `hub/`
directory is a reference fixture only (ADR 002); where this document and the
fixture disagree, **this document wins** and the fixture is legacy.

## Common

- Base path `/v1`. JSON in/out. Errors: `{ "error": { "code", "message" } }`.
- Auth: `Authorization: Bearer <Firebase ID token>` or `X-Api-Key: bfk_…`.
  Anonymous reads are allowed where noted. **Publish/withdraw require an
  interactive session profile** — API keys get `403 profile_required`.
- Rate limits (per minute): anonymous reads **60/IP**; authenticated discovery
  reads are tier-scaled (free 20, plus 60, pro 240) with daily caps; publish and
  withdraw share the tier **writes** bucket (free 10/min & 500/day, plus 30/min,
  pro 120/min); admin 60/min. Exhaustion → `429 rate_limited` + `Retry-After`.
  (The old "authed 600/min" figure was aspirational; tier buckets are reality.)
- Body caps: 64 KiB default; **1 MiB for `POST /v1/recipes`** and the admin feed
  import. The server additionally enforces canonical-manifest **byte** size
  ≤ 1 MiB (`manifest_too_large`) — the validator's 750 000-char cap is not a
  byte cap.
- ETags: quoted `"sha256:<hex64>"` on recipe heads and manifests. `304` on
  `If-None-Match` hit. **A withdrawn head never 304s** — it returns `410`.
  `/v1/changes` and `/v1/updates` have **no ETag/304** (the desktop client has
  no conditional path for them).
- Cursors: search uses an **opaque base64url keyset cursor** (last
  `publishedAt`+`id`); invalid → `400 bad_cursor`. Changes use a
  **numeric-string seq cursor** (`cursor=0` start); invalid → `400 bad_cursor`.

## Routes

| # | Route | Auth | Notes |
|---|-------|------|-------|
| 1 | `GET /v1/health` | anon | Liveness + version. |
| 2 | `GET /v1/discovery/models` | optional | Upstream model discovery (HF etc.), tier-scaled, moderated. |
| 3 | `POST /v1/recipes` | session + bound key | Publish. Body `{manifest, digest?, terms, signature}`. |
| 4 | `GET /v1/search` | anon | Recipe metadata search. `{items, nextCursor}` — **no `total`**. |
| 5 | `GET /v1/recipes/:id` | anon | Head + manifest + provenance; ETag; withdrawn → **410**. |
| 6 | `GET /v1/recipes/:id/manifest` | anon | Manifest only; ETag; withdrawn → 410. |
| 7 | `GET /v1/manifests/:digest` | anon | **Immutable, stays 200 after withdraw** (verify downloaded content). |
| 8 | `DELETE /v1/recipes/:id` | session, owner-only | Withdraw → tombstone. Idempotent. |
| 9 | `GET /v1/changes` | anon | Append-only sync log, numeric seq cursor. |
| 10 | `GET /v1/updates` | Plus/Pro | Operator-signed envelope, served verbatim. Free → `403 upgrade_required`. |
| 11 | `POST /v1/admin/recipes/feed` | admin + step-up | Import operator-signed feed (verified before store). |
| 12 | `POST /v1/admin/recipes/:id/withdraw` | admin + step-up | Operator takedown (audited, bypasses owner pin). |
| 13 | `GET /v1/admin/recipes/feed` | admin | Inspect stored feed + signature validity. |
| 14 | `POST /v1/admin/frostnet-import` | admin + step-up | Legacy FrostNet retirement import (operator-vouched, audited, idempotent). |
| 15 | `GET /v1/feed` | anon | Community home feed: pinned + announcements + release notes + recent recipes (+`following=1`, session-only). |
| 16 | `GET /v1/announcements` | anon | Operator announcements, pinned-first. Bounded read, no cursor. |
| 17 | `POST /v1/follows/:pubKey` | session only | Follow a creator key. Idempotent, cap 256. API keys → `403 profile_required`. |
| 18 | `DELETE /v1/follows/:pubKey` | session only | Unfollow. Idempotent (missing follow → `removed:false`, still 200). |
| 19 | `GET /v1/me/follows` | session only | Caller's private follow graph `{follows:[{pubkey,followedAt}],limit:256}`. |
| 20 | `GET /v1/admin/announcements` | admin | Operator list (includes `authorUid`). |
| 21 | `POST /v1/admin/announcements` | admin + step-up | Publish announcement (audited). Pinned cap 3 → `409 pinned_cap`. |
| 22 | `PATCH /v1/admin/announcements/:id` | admin + step-up | Edit (audited). `publishedAt`/`authorUid` preserved. |
| 23 | `DELETE /v1/admin/announcements/:id` | admin + step-up | Delete (audited). Missing id → 404. |
| 24 | `GET /v1/admin/release-notes` | admin | Operator list (includes `authorUid`). |
| 25 | `POST /v1/admin/release-notes` | admin + step-up | Publish release notes (audited). Duplicate version → `409 release_note_exists`. |
| 26 | `PATCH /v1/admin/release-notes/:version` | admin + step-up | Edit (audited). |
| 27 | `DELETE /v1/admin/release-notes/:version` | admin + step-up | Delete (audited). Missing version → 404. |

Identity routes (`/v1/me`, `/v1/me/handle`, `/v1/me/publisher-key*`,
`/v1/creators/*`) are documented in ADR 003; creator projections now carry
**real** `stats.followers` / `stats.recipes` (P3).

## Publish (`POST /v1/recipes`)

Request: `{ manifest, digest?, terms: "2026-10-10-v1", signature }`.

- `manifest` is recipe v2 (`schema: "frostbyte.recipe"`, `version: 2`) — the
  **normalized object the client signed** (`hubManifestDigest` normalizes via
  `validateRecipe` before hashing; transmitting a raw un-normalized object
  yields a different digest and a signature failure).
- `manifest.createdAt` is **required** and must be transmitted exactly as
  signed. The server refuses missing/defaulted timestamps (`created_at_required`)
  — it never invents a digest the client did not sign.
- `signature`: flat **base64**, 64-byte Ed25519 over
  `frostbyte-recipe/2\n<publisher-hex64>\n<digest-hex64>\n<createdAt>`
  (`recipeSigningBytes`). Verified with real crypto against `manifest.publisher`.
- `digest`, when provided, must equal the server-recomputed
  `canonicalDigest(manifest)` (`digest_mismatch`).
- The publisher key must be **bound to the caller's uid and not unbound**
  (`403 publisher_unbound`). Ownership of the record is then pinned to the
  caller's uid (`ownerUid`) **at publish time** — later key unbind/rebind never
  moves ownership.

Server check order: terms → validate → createdAt → digest → signature →
binding → tombstone (`409 withdrawn`) → cross-account id collision
(`409 not_owner`) → same-digest idempotency → new-revision write.

Response: `{ ok: true, digest, status: "published", id, currentVersion }`.

- Same uid + same id + same digest → idempotent success (no new change event).
- Same uid + same id + **new digest** → new revision: head advances
  (`currentVersion + 1`), old digest manifest stays immutable, `recipe.published`
  event appended.
- **Withdrawn recipes can never be republished** (`409 withdrawn`) — the
  signature has no freshness window, so replay of a withdrawn payload must fail.
- `redistribution_confirmed` is a **legacy release-v1** field and does not apply
  to metadata-only recipe v2.

## Search (`GET /v1/search`)

Query params: `q` (alias `query`), `kind`, `task`, `format`, `quant`,
`publisher` (hex64), `limit` (1–100, default 25), `cursor`.

Response: `{ items: [head…], nextCursor: string|null }`. **No `total`** —
counting the corpus per query is not worth the read cost at v1.

Token semantics (shared by both store backends, `store/contract.js`):

- `q`: case-insensitive substring over title + description + `modelRef.repoId`
  + file paths. Storage preserves case; only matching lowercases.
- `quant`: **verbatim case-sensitive** token match (`Q4_K_M` ≠ `q4_k_m`)
  against the canonical quant tokens: title + `modelRef.variant`. Recipe v2
  has no quant field — the publisher's title/variant is the token source.
  File paths do not contribute verbatim tokens (filenames conventionally
  lowercase the quant, which would defeat case-sensitive matching).
- `format`: verbatim file-extension match (`gguf`, `safetensors`, …).
- `task`: verbatim token match against title/repoId/variant tokens. Freeform
  description is excluded from verbatim token sources (wrong-case mentions).
- File paths feed the case-insensitive `q` haystack, so filename search works.
- Sort: `publishedAt DESC, id ASC`; keyset cursor is stable under concurrent
  publishes. Tombstones and operator-moderated recipes are excluded.

## Recipe head (`GET /v1/recipes/:id`)

`200 { head: {id, currentVersion}, digest, manifest, signature,
status: "published", provenance: {publisher, ownerUid, handle, terms,
publishedAt, createdAt} }` + ETag. `handle` is the owner's reserved alias at
read time (null if unset). Attribution of the *record* is the publish-time
`ownerUid`/`publisher` — never the live key binding.

Withdrawn id → **`410 { error: { code: "withdrawn" } }`** with
`X-Recipe-Status: withdrawn` and `X-Recipe-Withdrawn-At` headers. This is a new
contract decision (the fixture has no tombstones): cached clients must learn
about the withdraw, never 304 against the old ETag. Digest-addressed manifests
(#7) remain fetchable so importers can verify already-downloaded content.

## Withdraw (`DELETE /v1/recipes/:id`)

Session + owner-only, checked against the **publish-time `ownerUid` pin**.
Response `{ ok: true, id, status: "withdrawn", already }`. Sets
`head.withdrawnAt`, appends a `recipe.withdrawn` change event, excludes the id
from search. Idempotent (`already: true` on repeat). Cross-account →
`403 not_owner`; unknown id → `404 recipe_not_found`.

Operator takedown (#12) is the only bypass: admin + step-up + audit reason,
recorded as `recipe.takedown` in the immutable audit log.

## Legacy FrostNet import (`POST /v1/admin/frostnet-import`)

Retirement migration (P2.3): imports recipes enumerated from the legacy
`frostnet-si` deployment. Same zero-trust gate as every admin mutation
(interactive Firebase admin + active admin record + fresh step-up + audit
reason). Body: `{ reason, source?, records: [{ id?, manifest, digest?,
signature, legacySeq? }] }` — ≤200 records / 8 MiB per request.

Trust invariants (enforced server-side, never trust client claims):

- Each manifest is re-validated (`validateRecipe`), the digest **recomputed**
  (`canonicalDigest`), and any supplied `digest` claim must match.
- `createdAt` required and transmitted exactly as signed; canonical size
  capped at 1 MiB.
- The **original** Ed25519 signature is verified over the recipe signing
  domain — migration never re-signs or re-keys.
- `ownerUid` resolves to the publisher key's **bound account** when present,
  else the importing operator (who vouches for the legacy record).
- Idempotent per digest (re-import is a no-op); withdrawn ids stay tombstoned
  (`withdrawn` refusal); ids owned by another account refuse `not_owner`.
- Every imported record gets a `recipe.import` audit entry carrying
  `{ digest, ownerUid, publisher, migratedFrom, legacySeq, importedAt,
  idempotent }` — the provenance receipt.

Response: `{ ok, source, importedAt, total, imported, idempotent, refused,
results: [{ id, outcome: imported|idempotent|refused, digest?, ownerUid?,
code?, message? }] }`. Per-record refusals never abort the batch.

Operator tooling (`scripts/legacy-frostnet-{export,convert,freeze}.mjs`; the
import stage runs from the private maintainer repository): enumerate → convert
(independent verify) → import → freeze-verify, each stage writing a hashed
receipt. The legacy freeze is `FROSTNET_FROZEN=1` on the legacy deployment
(content writes → `410 legacy_frozen`; reads stay live); no DNS takedown or
deletion is performed by the tooling.

## Changes (`GET /v1/changes`)

`{ changes: [{seq, type, status, id, digest, publisher, at}], nextCursor }`.

- `type`: `recipe.published` | `recipe.withdrawn`; `status`: `published` |
  `withdrawn`. (One vocabulary — the fixture's `type`, the docs' `status`,
  both present; **no `operation` field**.)
- `seq`: monotonically increasing integer, assigned inside the publish/withdraw
  transaction. `nextCursor` is `String(lastSeq)` and appears only when the page
  is full; an exact-final-full-page may yield a cursor that returns an empty
  page (documented quirk).
- The log is **append-only, never trimmed** — offline sync and tombstone
  propagation depend on old cursors remaining valid.

## Updates (`GET /v1/updates`)

Plus/Pro only (`403 upgrade_required` otherwise; `503 feed_unavailable` before
the operator publishes). The stored envelope is served **verbatim**:

`{ version, engines?, recipes?, configs?, containers?, signature, feedPubKey }`

- Signature: flat base64 Ed25519 over
  `frostbyte-bundle/1\n` + `canonicalJson(envelope minus {signature, feedPubKey})`.
- At least one of the four arrays must be present; entry `severity` ∈
  `info | recommended | security` (the desktop normalizer's vocabulary).
- The server adds **no fields** at serve time — any addition breaks client
  signature verification. No `since`/inventory deltas and no ETag at v1.
- The operator feed key is provisioned durably (Secret Manager / Firestore) and
  stable across instances; the admin import route verifies the signature
  **before** storing. Desktop feed-key pinning is tracked as an ADR decision
  (the client currently trusts the envelope's own `feedPubKey`).

## Moderation

Recipe search and GET compose the existing `frostnetModeration` rules:
`repo` targets match `manifest.modelRef.repoId` (with `org/*` prefix support),
`infohash` targets match `manifest.torrent.infohash_v1`. Blocked recipes are
invisible to reads (404 / excluded from search). Recipe-id and publisher
takedowns use the audited admin withdraw route.

## Feed (`GET /v1/feed`) — P3 community home

Anonymous-readable (same per-IP bucket as search). Query: `limit` (default 25,
**max 50** — below search's 100 to bound the creator-join read amplification),
`cursor` (same opaque keyset codec as search; invalid → `400 bad_cursor`),
`following=1` (session-only; anonymous → 401, API key → `403 profile_required`).

Response:

```json
{
  "generatedAt": "ISO",
  "pinned": [ "≤3 pinned announcements" ],
  "announcements": [ "≤10 newest non-pinned announcements" ],
  "releases": [ "≤5 release notes, released DESC" ],
  "recipes": [ { "...head": "same shape as search items", "totalBytes": 123, "creator": { "pubkey": "hex64", "handle": "", "displayName": "", "photoUrl": "", "verified": true } } ],
  "following": false,
  "nextCursor": "opaque | null"
}
```

- **Creator join** is a strict public subset (`feedCreatorProjection`): never
  uid/email/tier/tenant/bio. Joins are deduped per pubkey per request. A recipe
  whose owner account was deleted projects key-only (`verified:false`, empty
  handle/name) — recipes outlive accounts; provenance stays immutable.
- **`totalBytes`** (feed recipes only) is the sum of the pinned manifest's file
  sizes — derived server-side, never a head claim — so clients can render
  memory-fit badges without a detail fetch. `0` when the manifest is gone.
- **Moderation**: identical filtering to search (`recipeIsBlocked` + rules).
  `nextCursor` is the **raw store page cursor**, taken before filtering — a
  fully-blocked page still paginates.
- **`following=1`** filters inside ONE store scan against the caller's follow
  set (`listRecipes({publishers})`) — never a per-follow fan-out. Empty graph →
  empty `recipes` segment (not an error).
- **Ceilings (v1, documented)**: recipe search/feed only see the
  `RECIPE_SCAN_WINDOW = 500` newest heads; announcements/release-notes reads are
  bounded at the 100 newest rows. No ETag/304 on the feed (composed document).
- Release notes give **anonymous and free users** public release news; the
  signed engine-nudge feed (`GET /v1/updates`) stays Plus/Pro — different product.

## Announcements & release notes (P3)

Operator-published only — no user free-text in v1. Bodies are **plain text**
(clients render as text, never HTML).

- Announcement: `{id,title,body,tag,pinned,publishedAt,updatedAt}` public;
  `authorUid` admin-only. `id`: `^[a-z0-9][a-z0-9-]{0,63}$`; title 1–140;
  body 1–4000; tag `^[a-z0-9][a-z0-9-]{0,31}$` optional. Pinned cap **3**,
  enforced transactionally on create AND update (`409 pinned_cap`).
- Release note: `{version,released,title,body,current,updatedAt}` public.
  `version` semver (`2.0.0`, optional prerelease); `released` ISO date
  `YYYY-MM-DD`; `current` informational (single-current is operator discipline,
  not server-enforced). Doc id = version.
- `GET /v1/announcements`: default limit 20, max 50, pinned-first then
  newest-first; **no cursor** (bounded read of the 100 newest).
- Firestore: `announcements.body` and `releaseNotes.body` are **exempt from
  indexing** (`fieldOverrides`, `platform/firestore.indexes.json`) — indexed
  strings >1500 bytes are rejected by production Firestore. The emulator does
  NOT enforce that limit; only a deployed probe verifies it. All P3 queries are
  single-field reads + in-memory sort/filter: **zero new composite indexes**.

## Follows (`/v1/follows/:pubKey`, `/v1/me/follows`) — P3

- **Session-only** (Firebase ID token). API keys → `403 profile_required` on
  all three routes; anonymous → 401. Writes bucket for mutations, discovery
  bucket for `me/follows`.
- Follows attach to the **publisher key** (ADR 003), doc id `${uid}:${pubKey}`.
  **Rebind consequence (intended, tested):** when a key is released and rebound
  to another account, followers and counts transfer with the key and the feed
  shows the new account's handle. Follow the key, not the account.
- Target must resolve to a binding **and a live user doc** — a deleted
  account's key is not followable (`404 creator_not_found`). The creator route
  applies the same ghost guard. Self-follow allowed.
- Cap **256/user**, enforced inside the write transaction (two concurrent
  follows at 255 cannot both pass) → `409 follow_cap`. Idempotent re-follow at
  the cap still succeeds.
- **Private graph**: no route lists who follows whom; only aggregate
  `stats.followers` is public. `GET /v1/me/follows` returns only the caller's
  follows.
- `DELETE` is idempotent and needs no target resolution — unfollowing a deleted
  creator always succeeds (`removed:false` when nothing was stored).
- `stats.recipes` counts live heads in the shared 500-head scan window;
  moderation-blocked-but-not-withdrawn heads still count (documented divergence
  from visible search results).
- `deleteFollowsForUser(uid)` exists in both stores and MUST be wired into any
  future account-deletion route (none exists today).

## Out of scope at v1 (explicit)

- Private/org-visible recipes: recipe v2 has no visibility field. Deferred.
- `total` counts, updates ETag/304, `since`-based feed deltas: deferred.
- Legacy release-v1 manifests are **not** publishable through this plane;
  migration is an operator-vouched admin import with a conversion ADR (P2.3).