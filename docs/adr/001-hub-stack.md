# ADR 001 — Hub Stack: Node/Fastify + Postgres (Prisma) on Fly.io

- **Status:** Superseded (hosting + datastore) by ADR 002 — 2026-10-18. Accepted — 2026-10-16.
- **Replaces:** an earlier shared-hosting plan (DirectAdmin/cPanel + PHP + MySQL, private planning record). That plan targeted a consumer lifetime shared-hosting account; its ToS restrictions (no file-dump/mirror, bot/client limits) and lack of long-lived process + cron guarantees make it unsuitable for a live update highway, SSE, or signed bundle signing.
- **Context:** Frostbyt3 needs a Hub that is (a) a public discovery portal with exact search, (b) an authenticated API for recipe/model manifests, (c) a live channel for Plus/Pro (follow feed + engine/container/config update nudges), and (d) a deterministic offline bundle that a NAS can seed. The app is Electron + Node; the host sidecar is Python; the existing directory is a local file store, not a service.
- **Decision:** Hub service is **Node + Fastify + Postgres + Prisma**, deployed on **Fly.io** (or equivalent: Render, Railway, or self-hosted Postgres). Public web is a minimal static site (no SSR framework until Milestone 5). Auth is Hub JWT + Stripe entitlements; recipe identity is publisher pubkey (ed25519), not the JWT. Redis is not required at v1; a Postgres-backed job queue handles imports. Search is SQL-first (tsvector + trigram + exact-match ranking); a dedicated search engine is a later ADR.
- **Consequences:**
  - PHP/MySQL and the shared-host plan are retired for the Hub — keep them only if a static marketing site needs shared hosting separately.
  - All Hub client code in the app is pure Node (no PHP SDK), aligned with `src/main/hf.js`, `src/main/torrent.js`, and `src/shared/edition-manifest.cjs` patterns.
  - Hosting cost is bounded: Fly free/low tier + Postgres + object store for bundles; bandwidth is offloaded to BitTorrent/IPFS for the offline path.
  - Migration, backup/restore, and staging deploy gates become first-class (not possible on the shared host).
- **Alternatives considered:** PHP/MySQL on DirectAdmin (rejected — no SSE/long-lived process, ToS risk), Firebase (rejected — query cost + vendor lock for search/ranking), Next.js + Vercel (deferred — SSR not needed for Hub v1).
- **Follow-on ADRs:** 002 — Search ranking & indexes; 003 — Bundle signing & key rotation; 004 — Entitlement enforcement boundaries.
