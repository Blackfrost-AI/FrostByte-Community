# Creator Guide — Publishing & Signing Recipes

## Identity

- Each creator is an **ed25519 publisher identity** (see `src/main/publisher.js`). 24-word mnemonic → deterministic keypair; `pubkey` hex is the public identity.
- Hub profiles (`GET /v1/creators/{pubkey}`) are display-only; the pubkey is the trust anchor, not the profile text.

## Recipe manifest v2

Sign canonical JSON (UTF-8, sorted keys) with domain string `frostbyte-recipe/2\n<sha256(canonical)>\n<pubkey>\n<timestamp>`. See `src/shared/recipe-manifest.js`.

Required fields: `id` (`[a-z0-9-]{1,64}`), `kind` (`tmux|docker|compose|native`), `title` (≤120), `publisher` (pubkey), `engine` (name+version when present), `files` (portable paths, bounded sizes), `license`, `terms` (`docs/hub-api.md`). Optional: `modelRef`, `imageDigest`, `healthPort`.

## Publish flow

1. In Frostbyt3: select local copy → *Publish to Hub* → verification (`verifyShareFiles`) → review → submit `POST /v1/recipes` with Bearer + `X-Publisher-Signature`.
2. Hub validates portable paths, `redistribution_confirmed`, publisher == token namespace, digest == canonical sha256.
3. Searchable once `published`; `GET /v1/changes` carries corrections/withdrawals. **Sharing keeps seeding; publishing/withdraw controls discovery listing only.**

## Rules

- No silent file expansion on publish — exactly the selected files.
- Private recipes (Pro) require org membership; public ones need license + provenance.
- Do not ship secrets in manifests. HF tokens never leave `src/main/hf.js`.

## Local test

```
npm test -- tests/unit.test.js
FROSTBYTE_HUB_URL=http://localhost:8787 npm test -- tests/frostnet.test.js
```
