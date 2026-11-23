# Frost/Byte — Plan

**by Blackfrost_AI** · *P2P sharing for open model weights.*

This replaces the earlier six-document plan. That plan had grown into a
distributed-inference architecture, a hardware-profiling layer, and a legal
treatise. None of it was asked for. This is the actual product.

---

## What it is

**A peer-to-peer file-sharing app for model files.** Search a catalog, pull a
model over BitTorrent, share what you already have.

Structurally this is the same thing LimeWire did with music:

| LimeWire | Frost/Byte |
|---|---|
| Search results: one row per file on a remote host | Catalog: one row per model, each pointing at peers |
| Pull the file from whoever has it | Pull the model from whoever has it |
| Seed what you have so others can get it | Same |
| The box you leave on shares your library | **The box you leave on is the seedbox** |

That last row is the whole point. A DGX or any always-on machine holds the
library and hands it out. Nothing is different from sharing any other large
file — models are just bigger, and **byte-for-byte identical**, which is what
makes BitTorrent's piece hashing exactly the right tool. A 60 GB file either
hashes right or it doesn't.

**What moves between peers:** model weights. That's it. No inference serving,
no job scheduling, no cluster.

---

## What it is not

- **Not distributed inference.** We don't shard a model across machines. Every
  peer is a whole file-holder. The measured economics of sharding over consumer
  links are bad (tensor parallel gets **0.4 tok/s over 1 GbE**), and it isn't
  what anyone asked for here.
- **Not a hosting service.** We run no servers and store no models. A catalog
  entry is a magnet link. Delete the starter catalog and the app still works —
  you can paste any magnet.
- **Not a new protocol.** BitTorrent for bytes, DHT + trackers + PEX + magnets
  for discovery. Everything battle-tested.
- **No accounts, no telemetry, no token, no ads.**

---

## How it works

```
┌─────────────────────────── Electron app ───────────────────────────┐
│  Renderer (Chromium)                                                │
│    Search · Transfers · My Library · Catalog · Settings             │
│         │  window.frostbyte  (narrow, explicit bridge)              │
│  Main process (Node)                                               │
│    ├─ TorrentEngine   WebTorrent: seed / add / pause / verify       │
│    ├─ Catalog         starter JSON + remote JSON + your entries     │
│    └─ Store           settings + library in plain JSON              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                  ┌────────────┴────────────┐
                  │  BitTorrent swarm        │
                  │  DHT · trackers · PEX    │
                  └──────────────────────────┘
```

**Sharing a folder** hashes it locally and produces a magnet link. Give that
link to anyone; they paste it in and pull. That's the whole sharing flow.

**Pulling** takes a magnet, infohash, or `.torrent` file — or one click on a
catalog row — and connects to whoever is seeding it.

---

## Layout

```
src/
  main/
    index.js      Electron main: window, menus, IPC handlers
    torrent.js    WebTorrent wrapper — testable in plain Node
    catalog.js    merge starter / remote / user entries
    store.js      JSON settings + library persistence
  preload/
    index.mjs     the renderer's entire view of the outside world
  renderer/
    index.html    shell
    styles.css    the design tokens (lime on near-black, dense grid)
    app.js        UI logic
catalog/
  starter.json    a few public magnet links + the entry format
scripts/
  test-engine.js  headless end-to-end P2P test (npm run test:engine)
  preview.html    dev harness — render the UI with a stubbed API
docs/
  01-limewire-research.md        why the UI looks like it does
  02-tech-landscape-research.md  the P2P / model-sharing landscape, with sources
```

---

## Run it

```bash
npm install
npm start              # launch the app
npm run test:engine    # headless P2P test: seed → pull → verify hashes
```

`scripts/preview.html` renders the UI in any browser against stubbed data, so
you can work on the interface without launching Electron or touching the
network.

---

## Verification

`npm run test:engine` runs the real P2P loop with no GUI:

1. create a 6 MB file
2. seed it from one engine instance → get a magnet link
3. pull that magnet from a second instance
4. **SHA-256 the received file and compare to the source**

23 checks, all passing — including byte-for-byte equality, peer connection,
pause/resume/remove, and the formatting helpers.

---

## Two upstream bugs worth knowing about

Both were hit and fixed while building this:

1. **`webtorrent@2.8.5` crashes on `seed()`** with the current `uint8-util`.
   `parse-torrent` returns `infoHash` as a hex *string*, but webtorrent calls
   `arr2hex(parsedTorrent.infoHash)` — and `uint8-util`'s `arr2hex` reads
   `.buffer`/`.byteOffset` off its argument. On a string those are `undefined`
   and it throws from inside a microtask. **Fixed in webtorrent 3**, which is
   what we depend on.
2. **ES modules don't load over `file://`.** Chromium blocks the fetch, so a
   `<script type="module" src="app.js">` silently does nothing in the packaged
   app. `app.js` is a classic script for that reason.

Also worth noting: **`[hidden]` loses to `display:flex`.** Every view in the
app is `.view{display:flex}`, so without an explicit
`[hidden]{display:none !important}` all five views render stacked on top of
each other.

---

## What's next

See **docs/HANDOFF.md** for the current state, landmines, and the prioritized
open list. Condensed:

1. **Web seeds** — attach HF resolve URLs as webseeds on our own torrents
   (llama.garden measured ~77 MB/s vs. slow plain-UDP swarms).
2. **`.torrent` file export** — we generate magnet links only.
3. **Piece sizing for big models** — target ~1,500–2,000 pieces on seeds we
   create; default WebTorrent sizing is wasteful at 300 GB.
4. **Two real machines** — the P2P loop is verified between two engine
   instances on one machine; the first cross-box transfer is the next honest gate.
5. **HF download restart-resume** — implemented and covered by the Electron suite.
6. **Packaging** — electron-builder (mac/win/linux, arm64), signing, and with
   it the real app name in the menu bar.
7. **Version control** — initialized with baseline commit `d0bd981`.

Done since this plan was written: bandwidth caps + alt limits + scheduler +
queue + seed goals + UPnP (the old item 3), HuggingFace search/gated/resumable
pulls, and the Share-on-swarm bridge.

See [REVIEW.md](REVIEW.md) for the current reliability fixes and release gates.
