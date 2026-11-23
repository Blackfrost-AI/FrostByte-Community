# HF + connected Spark — beta.9

FrostByte can combine HuggingFace HTTP ranges with BitTorrent pieces from the
user's paired Spark. This beta uses authenticated SSH to find shared files on
that device. It does not introduce a community registry or public model discovery.
The receiving desktop uses one download job, one partial file, and one selected
destination. The HF CLI is not required.

## Using it

1. Update the Spark companion through Spark setup. Older companions continue to
   support ordinary HF downloads; the desktop falls back to HF when hybrid lookup
   is unavailable.
2. On Spark, finish a model download and enable its Sharing switch in My Models.
   Existing files also work: register their containing storage folder, browse to
   the file or model folder, and explicitly choose Share on swarm. FrostByte only
   searches inventory files already shared by the user, never the whole machine.
3. On the desktop's HuggingFace tab, choose the same model/version and the files
   wanted. Choose This Mac/This PC, one destination, and **HF + my Spark (beta)**.
4. Transfers shows bytes received from HF and Spark. Pause retains verified pieces;
   Resume reopens the same partial download. Sharing on the receiver stays off.
5. Turn Sharing off on Spark to stop its source connections. HF supplies remaining
   pieces. Clearing completed transfer rows keeps the downloaded inventory.

The beta matches eligible public, ungated files with SHA-256 identities and the
following declared licenses: Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, CC0-1.0.
The original filename must be retained; local storage folders may differ. Up to
eight already-shared size-matching candidates are checked, preferring repository
and filename matches. Unmatched files, Git-blob files without a SHA-256 identity,
other licenses, gated/private repositories, and unavailable peers use ordinary HF.
Sharing permissions still belong to the user and the applicable publisher terms.

## Integrity, storage, and privacy

The desktop resolves a pinned HF commit and independently retrieves its public
file identity. The paired Spark also resolves that identity, hashes its selected
local file, and creates a deterministic single-file private torrent manifest with
4 MiB pieces. A filename or size match alone never qualifies a file. Hashing
does not copy the model. The manifest is cached only while the local file's
device/inode/size/modification stamps remain unchanged.

The desktop accepts a manifest only for the selected file, size, and canonical
piece layout. It rejects trackers and web seeds embedded in the manifest. Paired
device addresses arrive through the existing verified SSH connection. These
swarms disable DHT, peer exchange, trackers, and LAN announcements; the desktop
adds the pinned HF URL itself. WebTorrent's private flag alone still permits LAN
announcements, so FrostByte uses a discovery adapter with no network transports.
Its behavior is tested against the locked WebTorrent version and must be checked
when upgrading that dependency.
HTTP responses must return the exact requested byte range. Tokens and temporary
CDN URLs are never embedded in peer metadata.

One WebTorrent scheduler verifies pieces from both sources. Its transfer is hidden
from the ordinary torrent queue because the HF row owns it. The same bandwidth
token bucket covers HF and peer traffic. Files stay under `<destination>.frosthybrid`
until a final whole-file SHA-256 matches HF; then the file is renamed into place.
Partial manifests preserve source counters and permit HF-only resume if Spark
disconnects. There is no second final copy and no automatic upload of downloaded
model pieces. The receiver explicitly blocks outgoing piece messages as well as
unchoking, since the dependency's `uploads:false` setting alone is insufficient.

Operational peer lookup necessarily tells the paired Spark which file is being
requested, and the peers see network addresses. This is separate from optional
diagnostics. No community lookup service or model-download telemetry is added.
Internal per-file source sessions remain attached to the existing item's Sharing
switch and statistics rather than creating duplicate inventory cards.

## Updates

Settings → Updates offers a manual check and an optional daily automatic check,
off by default. The app reads the public metadata-only endpoint at
`https://blackfrostai.com/frostbyte/updates`; it sends no model names, paths, search
history, invite code, or HF token. Ordinary hosting connection logs may contain IPs.
Version comparisons handle numbered betas, stable versions, and a local build
newer than the published release. Last-check time and known release metadata
survive restart. Checking never downloads or installs executables.

Get update opens the official download destination. The feed derives
from the maintainer-approved release manifest, not GitHub development commits.
Official installers are published on this repository's GitHub Releases page.
Automatic installation and a community-wide content registry remain later work.

## Verification

`npm run test:hybrid` exercises actual TCP/HTTP piece mixing, whole-file integrity,
resume with a disconnected peer, malformed ranges/manifests, refusal to upload
pieces to another receiver, update states, and persisted check scheduling.
`npm run test:spark` covers explicit sharing, existing-file matching, destination
boundaries, and the companion installer. `npm run test:e2e` includes update UI
controls; the physical Windows case is opt-in.

`scripts/verify-hybrid-lan.js` requires an operator-provided `FROSTBYTE_LAN_PLAN`
and explicit destination. Its magnet, hybrid, and baseline modes write SHA-256,
source byte counts, elapsed time, and result JSON under that test destination.
The physical UI test additionally needs `FROSTBYTE_LAN_HOST`, an isolated profile,
and a temporary SSH key restricted to the isolated Spark companion's RPC command.
Its generated key is never copied off Windows; remove its public-key authorization
and stop the isolated companion after testing. Never use the user's production
profile or alter system firewall/security settings to make a test pass.

Throughput depends on the desktop connection, HF, peer upload rate, and disk.
The real 12B trial exposed a slow final-piece handoff; the scheduler now releases
slow peer reservations when HF was recently healthy, and reconnects the peer if
HF does not finish promptly. Compare source bytes and checksums as well as timing;
a successful completion alone does not prove both sources contributed.
