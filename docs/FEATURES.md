# FrostByte feature reference

## What it is

A peer-to-peer download and sharing app built around models. Torrents can contain
any file type, including configs, updates, and archives. Search HuggingFace in its
own tab, open a torrent, magnet or IPFS link, and choose what to share.
The top bar finds your transfers and recorded downloads; it does not query a
public torrent index. A community directory for legally shared open models is a
future phase, described in [the discovery roadmap](COMMUNITY-DISCOVERY.md).

It's the same idea LimeWire had for music, applied to model weights:

- **Find your downloads** → search recorded inventory and current transfers across your devices
- **Download** → pull the model from whoever's sharing it
- **Seed** → hand out what you already have
- **The box you leave on** → is the seedbox

Models being **byte-for-byte identical** is what makes this work. A 60 GB file
either hashes right or it doesn't, so BitTorrent's piece hashing is exactly the
right tool — no different in kind from sharing any other large file, just
bigger.

The always-on machine is the design center. Point it at your models, leave it
running, and it keeps handing them out.

---

## What it isn't

- **Not a hosting service.** No servers, no uploaded copies. A catalog entry is
  a magnet link. Delete the starter catalog and the app still works — paste any
  magnet.
- **Not distributed inference.** No sharding a model across machines, no
  scheduling jobs. Peers share whole files.
- **Existing peer networks.** BitTorrent and IPFS are separate transports.
  IPFS CIDs and torrent infohashes identify different content structures.
- **No ads or analytics.** No automatic diagnostics or in-app feedback
  collection; optional feedback goes through GitHub. An optional Blackfrost
  account unlocks community handles, follows and publishing; an optional
  HuggingFace token unlocks models your HF account can access.

---

## Using it

**From HuggingFace — search, gated models, selective pulls.** The HuggingFace
tab searches the live HF API directly; the HF CLI is not required. Sort across
the Hub by downloads, likes, trending, last update, or creation date, in either
direction. Filter by publisher, task, format, library, license, language, and
access. Filter choices come from the Hub API and are cached for an hour.
**Load more** follows the same search and filters. Model/license/task column
sorts explicitly apply to loaded results. Pick a model, choose a version by format and size,
then download. Split weights stay together; Safetensors and PyTorch choices
include config and tokenizer files from their folder and its ancestors.
A single available version comes preselected. **Customize files** offers
filename search, file-type filters, size/name sorting, and select-shown/clear
controls. In short windows, those controls scroll with the file list so they do
not cover selectable rows. **Just configs & tokenizer** selects supporting files without weights.
The **Version** selector loads repository branches and release tags. Downloads
use HTTP by default, with optional **HF + device** for eligible public files:
pinned to the chosen version's commit, resumable, and sharing
the same bandwidth caps as the swarm (max 2 concurrent pulls). **Gated models
work**: save a read token in Settings → HuggingFace (validated via whoami,
OS-level encrypted storage, sent only to huggingface.co). A 401 means no
token; a 403 means access wasn't granted — the transfer row says which.
Interrupted pulls resume after restarting the app. Finished pulls get a **Share on swarm** button that hashes the file locally
and starts serving it to peers. That's the intended loop: HF → this box →
the swarm.

**Connected devices.** Connect Macs and DGX machines by LAN address and login, or reuse
saved SSH aliases. Guided setup installs each companion directly from the desktop
app. Several devices can remain connected and download at once. Choose this
computer or a saved device in the torrent popup or HF download footer, then one
internal or mounted external folder for that download. Remote downloads continue
after the controller disconnects, with separate inventories and transfer controls.
See [device setup and limits](DEVICES.md), including Mac awake/logged-in
requirements and stock product photos.

**Share something you have.** `Share a folder` → hashes it locally → gives you a
magnet link. Give that link to whoever wants the model. This box keeps serving
it, and comes back up seeding it after a restart.

**Pull something.** Drop `.torrent` files or magnet links anywhere in the window,
paste a magnet/infohash in the top search box, or click **Add download**. The
review popup shows the file list, selected size, and a destination for this
download. Select only the files you need; no content transfer starts until you
confirm. A magnet preview fetches metadata from peers, so its file list may take
time or be unavailable without peers. You can still start all files. Closing
the popup cancels the preview. Multiple drops queue individual reviews.

Selected-file progress and completion survive restarts. A partial download is
shown as **selected files complete**, and does not claim to be a full seed.
BitTorrent pieces may overlap neighboring files, so small portions of skipped
files can be stored. Supported sources use the engine's BitTorrent v1-compatible
metadata/magnets. Packaged apps register torrent and magnet handlers. The Windows
installer adds Open With / Default Apps choices and preserves existing defaults.
Opening a source from Explorer, Finder, or a browser enters the same review popup,
including when FrostByte is already running. Selecting a default remains an OS choice.

**Save torrent links.** `Torrents → Manage saved links` keeps manually saved magnet
links and metadata. Import a JSON list URL or save a link yourself. Existing
entries survive the navigation update; they are separate from downloaded inventory.

---

## Screens

| | |
|---|---|
| **HuggingFace** | Live HF search with gated chips, downloads, likes, licenses. Collapsible details with version cards, grouped split weights, download totals, and an optional custom file picker. HTTP transfers (max 2 at a time) share your bandwidth caps. |
| **Transfers** | Default view, with grouped model and torrent progress. The top bar searches model/file names, folders and devices, including completed inventory after history is cleared. Device filters scope results; Pause/Resume results keeps each matching model intact. |
| **My Models** | Downloaded models on this computer or Spark, with file locations, browsing, sharing switches and live upload statistics. |
| **Torrents** | Other downloaded files, including documents, videos, software and archives. Filter by type, sort, or change a completed item's category in Options. |
| **Settings** | Download folder, share-after-download (enforced), Blackfrost and original themes, catalog URL, where the JSON lives. |

**Saved-link details.** Open a row under `Torrents → Manage saved links` for
metadata, license notes, source and download controls. These bookmarks are local.

**Keyboard.** `Cmd/Ctrl+F` opens Transfers and focuses download search. Enter
searches from any tab, or opens the review popup for a pasted magnet. Escape
clears an active download search or closes the current popup. `Cmd/Ctrl+1/2/3`
switches Transfers / My Models / Torrents; `Cmd/Ctrl+D` toggles alternative limits.
List density remains in `Settings → Interface`.

**Settings.** Changes apply
live unless marked *restart required*:

| Section | What it actually does |
|---|---|
| **Connection** | UPnP/NAT-PMP port mapping (maps whatever port the engine bound — verified against a real router), max global connections, DHT toggle, extra trackers appended to every pull |
| **Bandwidth** | Global up/down caps in KB/s, *alternative* limits with a manual turtle toggle (`Cmd/Ctrl+D` or the status bar) **and** a time-of-day schedule with a per-day picker — overnight windows belong to the day they start |
| **Queueing & Seeding** | Max active downloads — overflow parks as *queued* and resumes FIFO as slots free; user pauses are never auto-resumed. Seeding goals: stop at ratio N or after M minutes (never touches things you explicitly share; files are kept) |
| **Folders** | Download dir, move-completed-on-finish (cross-volume falls back to copy+delete), catalog URL |
| **Interface** | Theme, confirmation thresholds for big pulls, confirm-quit-while-sharing, start-at-login |
| **HuggingFace** | Token: validate-and-save (requires working OS encryption: Keychain on macOS, DPAPI on Windows), status display, remove |
| **Privacy & Feedback** | No automatic diagnostics or in-app report collection; optional GitHub feedback and offline versioned terms/privacy documents |

**Four densities** (comfortable → ultra), **Blackfrost**, and the original themes (Frost, Abyss,
Malachite), persisted locally. The status bar shows live DHT node count and
whether the listen port is open — a dead swarm reads as a warning, not silence.

---

See [local data, consent and GitHub feedback](PRIVACY-AND-FEEDBACK.md) for the
v1.0 privacy boundary, legacy opt-in behavior and necessary network requests.

## Layout

```
src/
  main/
    index.js      Electron main — window, menus, IPC
    torrent.js    WebTorrent wrapper (runs in plain Node, so it's testable)
    catalog.js    merges starter + remote + user entries
    store.js      settings and library as plain JSON
  preload/
    index.cjs     the renderer's entire view of the outside world
  renderer/
    index.html · styles.css · app.js
catalog/starter.json     empty by default; add or import your own entries
scripts/
  test-engine.js         headless end-to-end P2P test
  preview.html           render the UI in a browser against stubbed data
docs/
  HANDOFF.md             read this first — state, landmines, open items
  PLAN.md                where this is going, and the honest gaps
  01-limewire-research.md        why the UI looks the way it does
  02-tech-landscape-research.md  the P2P / model-sharing landscape, with sources
```

---

## macOS build and installation

The Apple Silicon app includes the Frost/Byte logo and native Dock icon. Build a
DMG and ZIP with `npm run dist:mac`, then drag **FrostByte** from the DMG into
**Applications**. This is an ad-hoc signed local build; public distribution still
requires Developer ID signing and notarization.

Run `npm run test:packaged -- /Applications/FrostByte.app` to verify the installed
copy. See [packaging instructions](PACKAGING.md) for output paths, profile
preservation, and release signing. Original artwork and prompts are in
[assets/brand](../assets/brand/README.md).

## Windows build and installation

Use a native Windows x64 checkout with Node 22.12+ and npm 11.17+: run `npm ci`, then
`npm run dist:win`. Do not copy Mac `node_modules`; the networking binaries must
match Windows. The build creates a ZIP and a per-user NSIS setup executable.
Run setup as your normal Windows user; it requests no administrator elevation.
This private beta is unsigned and does not claim Windows publisher verification.

Local destinations read **This PC**. Saved HF tokens and pairing keys use
Electron safeStorage with Windows DPAPI; a profile copied from another account
or operating system may require reconnecting. See [Windows packaging and
verification](PACKAGING.md#windows-x64) for artifacts, association behavior,
and native test commands. Upgrades preserve existing torrent/magnet defaults
and app data. Release acceptance evidence is retained in the private release
archive; published checksums and their OpenPGP signatures accompany every
GitHub Release.

## Verification

On macOS, run `npm run test:all` for the full check: engine + managers + reliability regressions + download-choice checks + live HuggingFace + the actual Electron UI. On Windows, use the native checks in [PACKAGING.md](PACKAGING.md#windows-x64); Linux companion tests retain their Unix requirements. Run `npm run test:e2e` for desktop workflows alone. The Electron tests use an isolated temporary profile and small temporary files; native file-picker results are supplied automatically. Live HF checks need internet access.

The desktop suite exercises all six views, settings and catalog editing, real P2P pause/resume, safe moves, selective HF downloads, restart-resume, HF → swarm sharing, and removal across another restart. Downloaded bytes are checked against their source hashes. Screenshots land in `test-results/screenshots/`.

Community 2.0.0 shipped with the full desktop suite green (unit + packaged
end-to-end), bundle/DMG/ZIP integrity checks, and installed-app verification.
Physical Spark inventory, sharing, restart and retained-file hashes have been
verified across real devices. Apple notarization and Windows Authenticode
signing remain open production-signing items; the OpenPGP-signed checksum list
authenticates every published artifact in the meantime.

`scripts/preview.html` renders the UI against a stubbed API in any browser, so
you can work on the interface without launching Electron or contacting HF. Serve
the repository with `python3 -m http.server 8000 --bind 127.0.0.1`, then open
`http://127.0.0.1:8000/scripts/preview.html`. The module-based renderer needs HTTP
in a regular browser.

---

## Notes from building it

Three things bit us, all worth knowing:

- **`webtorrent@2.8.5` crashes on `seed()`.** `parse-torrent` returns `infoHash`
  as a hex string, but webtorrent calls `arr2hex(parsedTorrent.infoHash)`, and
  `uint8-util`'s `arr2hex` reads `.buffer` off its argument — `undefined` on a
  string. It throws from inside a microtask, so it looks like a silent crash.
  Fixed in webtorrent 3, which is what we depend on.
- **The renderer uses ES modules and a sandboxed CommonJS preload.**
  Keep the preload bridge explicit and preserve context isolation.
- **`[hidden]` loses to `display:flex`.** Every view is `display:flex`, so
  without `[hidden]{display:none !important}` all of them render stacked.

---

## The look

Classic LimeWire had it right about one thing: a dense, sortable grid of what's
out there on other machines *is* the product. So the palette keeps the lime
(`#22D511`, still LimeWire's brand green) as the single accent on a near-black
canvas, the data columns are monospace with tabular figures, and the chrome is
ours rather than the platform's.

What we left behind: Java Swing chrome that rendered differently on every OS,
bundled adware (FrostWire shipped an Ask.com toolbar and later a browser
hijacker — there's no bundled anything here), and any central point of failure.

---

*Keep the models alive.*
