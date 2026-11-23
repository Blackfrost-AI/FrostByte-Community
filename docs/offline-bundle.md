# Offline Bundle (NAS / Air-Gap) — Spec

Bundle = a static, signed directory that seeds without the Hub: `manifest.json` + content-addressed blobs, shareable over BitTorrent + IPFS.

## Layout

```
bundle-v1/
  manifest.json        # signed index: { version, createdAt, hubOrigin, bundleDigest, entries:[{digest, kind, size, license, publisher, provenance}], signature, pubkey }
  blobs/               # optional pre-downloaded shard files (not required for discovery)
  torrents/            # per-entry .torrent metainfo for seeding on NAS
  cids/                # per-entry CID records (if IPFS-sourced)
  CHANGES.jsonl        # cursor-ordered tombstones/corrections since bundleDigest
```

## Guarantees

- Verifiable: Ed25519 over canonical `manifest.json` bytes (domain `frostbyte-bundle/1`). Client rejects mismatched `bundleDigest` or signature.
- Portable: `portable-path.js` rules for every file path; no symlink, no `..`, bounded sizes.
- No live highway: bundle consumers get poll-only `CHANGES.jsonl`; Plus/Pro live feed is server-side.
- NAS seed: `frostbyte bundle seed /mnt/nas/bundle-v1` starts a local torrent/IPFS provider from `torrents/` + `blobs/`.

## Ops

- Build: Hub nightly job → `bundle/latest` pointer + `bundle/{digest}` segments.
- Client: `GET /v1/bundle/latest` → verify ETag → `GET /v1/bundle/{digest}` → import. Offline: `frostbyte bundle import /mnt/nas/bundle-v1/manifest.json`.

## Security

- No HF/BT/IPFS auto-fetch from bundle — selected entries still route through existing `hf.js`/`torrent.js`/`ipfs.js` with user review.
- Withdrawn entries remain tombstoned; clients must not silently re-share them.
