# ADR 002 — Hub backend: Firebase / Firestore / Cloud Functions

- **Status:** Accepted — 2026-10-18
- **Supersedes:** the *hosting* and *datastore* decisions in
  `docs/adr/001-hub-stack.md` (Node/Fastify + Postgres/Prisma on Fly.io).
  ADR 001's **protocol** decisions (`docs/hub-api.md`, cursor pagination,
  ETag/304, tombstones, verbatim quant tokens, tier names) remain in force.
  The `hub/` Prisma prototype stays in the tree as a reference implementation;
  it is not the deployed service.
- **Decision owner:** repository owner (Blackfrost AI).

## Context

ADR 001 chose Fly.io + Postgres. Since then the operating reality changed:

1. There is already a live GCP project, `blackfrost-ai-prod`, with billing
   enabled, Firebase Auth configured, Secret Manager in use, and an App Hosting
   backend serving `platform.blackfrost.si`.
2. Every other Blackfrost surface (the storefront, the Frostnet API, the
   platform app) already runs on that project. A second hosting provider means a
   second bill, a second set of credentials, a second audit surface, and a second
   backup story for one product.
3. The Hub's hot path is *read-mostly discovery fan-out plus entitlement
   lookup* — not the relational reporting workload Postgres was chosen for.
4. The team is one operator. Operational surface area is the binding constraint,
   not raw query flexibility.

## Decision

The Hub backend is a **Firebase project surface on `blackfrost-ai-prod`**:

- **Compute:** Cloud Functions v2 (Node 22, `us-central1`), HTTPS-triggered,
  single `hubApi` entry point behind a small internal router. This is the same
  shape as the existing `frostnetApi` function, so the deploy and rollback
  procedure is already known and tested.
- **Datastore:** a **dedicated Firestore database named `hub`** in `nam5`,
  *not* the `(default)` database. `(default)` carries live commerce records
  (`stripeEvents`, `modelOrders`, `checkoutIntents`, …) and the storefront's
  deployed rules; the Hub must not be able to break it, and a rules mistake on
  the Hub must not expose an order record.
- **Identity:** Firebase Auth (already configured). The Hub never stores
  passwords and never issues its own JWTs for first-party clients.
- **Secrets:** Secret Manager (`HF_TOKEN` already exists). No secret is ever
  inlined into `apphosting.yaml` or a function env file.
- **Rules:** deny-by-default on the `hub` database. All reads and writes go
  through the function, which uses the Admin SDK. Client SDK access is limited
  to the owner's own `users/{uid}` document.

## Consequences

**Gained**

- One bill, one IAM model, one audit log, one backup/export procedure.
- Firebase Auth already works — no new credential store, no password hashing to
  get wrong, no account-linking migration later.
- Deploy and rollback reuse the existing `firebase deploy` workflow.
- IAM is already granted to the operator account for functions, rules, indexes,
  and secrets (verified 2026-10-18).

**Given up**

- **No SQL joins.** Entitlement lookups are denormalized snapshots. Accepted:
  the read pattern is `get one user's tier`, not analytics.
- **No `tsvector`/trigram search.** Firestore has no full-text search. Accepted
  for v1 because discovery search is a *fan-out to three upstream APIs*, not a
  local index. A local search index is a later ADR if the recipe corpus outgrows
  upstream search.
- **Vendor coupling.** Accepted deliberately; this repo already depends on GCP
  for auth, storage, and hosting.
- **Cost model is per-operation.** Bounded by a TTL cache collection in front of
  every provider call, plus per-identity rate limits.

**Explicit non-goals for this ADR**

- No Stripe webhook activation. The webhook route is written and signature-gated
  but disabled until `STRIPE_HUB_WEBHOOK_SECRET` exists.
- No SSE/live-highway endpoint yet (needs a long-lived runtime; Cloud Functions
  HTTP streaming is a separate decision).
- No migration of `hub/`'s Prisma schema. The two are independent until a cutover
  ADR is written.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Keep Fly.io + Postgres (ADR 001) | Second provider, second bill, second credential set, for a workload that is read-mostly. The original reason (SQL search) is not on the v1 critical path. |
| Cloud Run + Postgres (Cloud SQL) | Keeps SQL, but adds a always-on database instance and VPC connector. More moving parts than Firestore for this access pattern. Revisit if relational reporting becomes real. |
| Firestore in `(default)` | Couples Hub schema to the live storefront. A bad rule or index deploy takes down commerce. |
| Supabase / Neon | Another vendor, another bill, and Auth would diverge from the existing Firebase users. |

## Follow-on ADRs

- 003 — Live highway transport (SSE vs WebSocket vs polling) for Plus/Pro.
- 004 — Bundle signing and key rotation.
- 005 — Entitlement enforcement boundaries between app cache and server truth.