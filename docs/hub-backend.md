# Blackfrost Hub API — deployed backend reference

- **Status:** deployed and verified — 2026-10-18
- **GCP project:** `blackfrost-ai-prod`
- **Function:** `hubApi` (Cloud Functions v2, Node 22, `us-central1`)
- **Base URL:** `https://us-central1-blackfrost-ai-prod.cloudfunctions.net/hubApi`
- **Firestore database:** `blackfrost-hub` (dedicated — **not** `(default)`)
- **Architecture:** `docs/adr/002-hub-backend-firebase.md`
- **Probe evidence:** `research/2026-10-18-backend-probe.md`

## Endpoints

All responses are JSON with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
Errors are `{ "error": { "code": "…", "message": "…" } }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/v1/health` | none | Liveness + store kind |
| `GET` | `/v1/discovery/models` | required | Unified model search |
| `GET` | `/v1/me` | required | Profile + entitlement + orgs |
| `PATCH` | `/v1/me` | required | Update `displayName`, `photoUrl`, `locale`, `timezone`, `preferences` |
| `GET` | `/v1/me/entitlement` | required | Resolved tier + capabilities |
| `GET` | `/v1/me/usage` | required | Today's counters |
| `GET` | `/v1/api-keys` | required | List key metadata (no secrets) |
| `POST` | `/v1/api-keys` | Plus/Pro | Mint a key — plaintext returned **once** |
| `DELETE` | `/v1/api-keys/:prefix` | required | Revoke a key |
| `GET` | `/v1/orgs` | required | Organizations the caller belongs to |
| `POST` | `/v1/orgs` | Pro | Create an organization |
| `POST` | `/v1/billing/webhook` | Stripe sig | **Inert** — 503 until a real secret is set |

### `GET /v1/discovery/models`

Query params: `q` (≤200 chars), `providers` (comma list), `limit`, `cursor`, `sort`.

Fan-out is gated by tier:

| Tier | Providers queried | Max page |
|---|---|---|
| `free` / `offline` | `huggingface` | 25 |
| `plus` | `huggingface`, `localmaxxing`, `pirateface` | 50 |
| `pro` | `huggingface`, `localmaxxing`, `pirateface` | 100 |

Providers excluded by plan appear in `providers[]` with `status: "skipped"` and
`code: "plan_required"` rather than erroring, so the client can upsell.

A single provider failing degrades to a labelled partial result
(`status: "error"`). All providers failing returns `502 upstream_unavailable`.

Cursors are **HMAC-signed and bound to the query + tier + provider set**.
Forging one, or reusing one across a different query, is a `400`.

### Authentication

1. `Authorization: Bearer <firebase-id-token>` — first-party clients.
2. `Authorization: Bearer bfk_<prefix>_<secret>` — machine clients.

API keys are stored as SHA-256 hashes; the plaintext is shown once at creation.
All rejection paths return an identical `401` message, so a caller cannot probe
whether a guessed key exists, was revoked, or expired.

## Firestore data model

Database `blackfrost-hub`. All collections are server-write-only; clients may
read only their own `users/{uid}` document.

```
users/{uid}              email, displayName, photoUrl, locale, timezone,
                         preferences, createdAt, updatedAt, disabled

subscriptions/{uid}      provider, providerSubscriptionId, providerCustomerId,
                         tier, status, currentPeriodEnd, cancelAtPeriodEnd,
                         priceId, updatedAt

entitlements/{uid}       resolved tier snapshot (server-maintained)

orgs/{orgId}             name, plan, ownerUid, memberUids[], roles{uid: role},
                         createdAt

apiKeys/{sha256(key)}    uid, prefix, label, keyHash, createdAt, lastUsedAt,
                         revokedAt, expiresAt

usage/{uid}:{window}     uid, day, discovery, writes   (rate-limit counters)

discoveryCache/{key}     value, expiresAt              (TTL cache)

auditLog/{autoId}        action, uid/actor, eventType, at
```

### Entitlement resolution

`platform/functions/src/entitlements.js` is the single source of truth:

| Subscription status | Result |
|---|---|
| no record | `free` |
| `active` / `trialing` / `past_due` | subscribed tier |
| `canceled` | subscribed tier until `currentPeriodEnd` |
| past `currentPeriodEnd` + 7-day grace | `free` (`source: "grace"` before that) |
| `unpaid` / `incomplete_expired` / `revoked` | `free` immediately |
| unknown tier, or paid tier with no `currentPeriodEnd` | `free` (fails closed) |

A client that lies about its tier only loses its own features — every gated
route re-resolves from Firestore.

## Secrets

| Secret | Purpose | State |
|---|---|---|
| `HUB_CURSOR_SECRET` | HMAC key for discovery cursors | **Set** |
| `STRIPE_HUB_WEBHOOK_SECRET` | Stripe signing secret | Placeholder `unconfigured` — billing inert |

Billing activates when `STRIPE_HUB_WEBHOOK_SECRET` matches `whsec_[A-Za-z0-9]{8,}`.
No code change or redeploy is needed; update the secret version and the webhook
starts verifying. Until then every delivery gets `503`.

## Verification receipts

| Suite | Command | Result |
|---|---|---|
| Unit + integration | `cd platform/functions && npm test` | **105/105 pass** |
| Live API | `FIREBASE_WEB_API_KEY=… node scripts/verify-live.mjs` | **29/29 pass** |
| Firestore rules | `FIREBASE_WEB_API_KEY=… node scripts/verify-rules.mjs` | **17/17 pass** |

Both live scripts create throwaway accounts and delete them plus their
documents at the end. Re-run either at any time; they are idempotent.

### Verified live (not just asserted)

- health public → `200`; anonymous discovery → `401`; garbage token → `401`
- free tier returns huggingface only; `localmaxxing`/`pirateface` → `skipped`
- pro tier fans out to all three and merges >1 provider
- pagination: page 2 has **zero** overlap with page 1
- forged cursor → `400`; cursor reused on a different query → `400`
- malformed percent-escape in a path param → `400` (was `500`)
- API key mint → authenticate → revoke → `401`
- `PATCH /v1/me {tier:"pro"}` → `400`, and `tier` is not written
- billing webhook unconfigured → `503`
- rules: cross-user read denied, all client writes denied, 5 server-only
  collections denied read and write

## Operating notes

- **Deploy:** `cd platform && firebase --project blackfrost-ai-prod deploy --only functions,firestore`
- **Deploying `--only firestore` does not touch `(default)`.** Confirmed by
  ruleset id before and after: `(default)` stayed on `51ca2cf3-…` while
  `blackfrost-hub` moved to a new release.
- **PITR is on** for `blackfrost-hub` (7-day retention) and **delete
  protection is enabled** — dropping the database now requires an explicit
  update first. It holds billing state.
- **No Java on this machine**, so the Firestore emulator cannot run. Tests use
  an in-memory store and injected fetchers; live verification runs against the
  deployed function.

## Known gaps / next steps

1. **Rate-limit counters are read-then-incremented**, so two concurrent
   requests can both pass at the boundary. Acceptable for abuse control; not
   exact. A transactional increment would close it if it ever matters.
2. **`discoveryCache` is wired but unused.** Every discovery request hits all
   upstreams. Adding a 60s cache read/write in `discover()` is a one-line
   change and would cut upstream load substantially.
3. **`entitlements/{uid}` is written by nothing yet.** Reads resolve live from
   `subscriptions`. Either populate it on subscription change or drop the
   collection.
4. **`lastUsedAt` on API keys is never updated.** Useful for operators; needs a
   write on each authenticated request (or a sampled one to avoid write
   amplification).
5. **Stripe price IDs are unset.** `STRIPE_PRICE_PLUS_MONTHLY` etc. must be
   configured before billing can map a price to a tier; until then
   `tierFromSubscription` falls back to `metadata.tier` or `free`.
6. **`hub/` (the Prisma prototype) is still in the tree** and is now dead code
   relative to the deployed service. ADR 002 keeps it as a reference; it should
   either be deleted or clearly marked superseded.
7. **One pre-existing test auth user** remains:
   `probe-1792282164@blackfrost-test.local`, created 2026-10-18T00:09Z, before
   this work. Left alone deliberately.