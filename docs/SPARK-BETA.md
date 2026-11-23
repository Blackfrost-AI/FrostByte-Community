# DGX companion details

For the current multi-device workflow and Mac support, start with [Devices](DEVICES.md).

FrostByte connects from the desktop app to the user's Spark over SSH on their LAN.
The Spark runs its own download companion so transfers continue when the desktop disconnects.
Beta.4 adds Windows x64 support. Native installation and all 29 final installed-app
workflows passed, including encrypted pairing and password-free reconnection.
Frigid is optional; no Frigid daemon, token, or source repository is required.

## First connection

1. Open **Devices → Add device** in FrostByte. Enter the Spark's hostname or local IP address,
   Linux username, SSH port, and password. The username is separate from the host
   address. Users with an existing working SSH alias can choose **Saved SSH connection**.
2. Check the displayed SSH fingerprint against the host key on the Spark, then
   choose **Trust and continue**. FrostByte does not send login credentials before
   the user approves that identity.
3. FrostByte checks Linux ARM64/x64, Python 3, Docker, and the account's Docker access.
   Requirements that need attention are shown with a retry action. Setup does not
   install Docker, request sudo, or change another application's services.
4. Browse or enter a download folder **on Spark**, including a mounted external
   drive. If `~/model-lab/models` exists, the user can choose it as a shared model
   library. FrostByte does not choose Frigid's folder automatically.
5. Review and install the companion. A compatible existing companion can connect
   directly. The desktop app includes its own installer payload; no local terminal,
   system Node.js, HuggingFace CLI, or source checkout is required.
6. Choose the connected device and a destination folder in each HF or torrent download.
   **This Mac** / **This PC** remains available for local downloads.

The Spark must be reachable from the desktop with SSH enabled. Initial Docker builds
need internet access to Docker Hub, npm, and native dependency downloads. The
first build can take several minutes. NVIDIA documents its own connection setup
in [Connect to your Spark](https://build.nvidia.com/spark/connect-to-your-spark/manual-ssh).

## Storage belongs to the user

The Spark page shows one **Download destination**, remembered for the saved Spark
connection. New HF and torrent downloads start with that folder selected; a
download review can override it for that one request. Selecting a folder starts
no transfer and does not move existing files. If the selected drive is unavailable,
downloading stays blocked until the user connects it or chooses another folder.

**Add folder** browses the host filesystem and registers another writable folder,
including external storage, then selects it for new downloads. Previously
registered folders remain choices in the selector. Every request uses exactly one
destination; it does not fan out to all registered folders.

Completed models and torrents appear in **My Models** and **Torrents**, with
shortcuts from the Spark page. **Browse files on Spark** expands a file browser
when needed; browsing another folder never changes the download destination.

Registering storage restarts only the FrostByte companion, retains existing
mounts and transfer records, and preserves the original default folder. Up to 16
folders can be registered. Existing files are not moved between disks. Mount an
external drive in the Spark OS before adding it; formatting, mounting devices,
and removing registered roots are outside this beta.

FrostByte records a hidden storage identity marker. Missing or replaced storage
is reported as unavailable; downloads pause/fail instead of recreating a missing
mountpoint on the internal disk. Reconnect the same drive, then resume the job.
The same torrent cannot run concurrently into two folders; HF files can.

## Authentication and installation

Password setup generates a dedicated Ed25519 key for this desktop. It validates
the private/public pair and a test signature before enrolling or encrypting it,
discarding invalid candidates with a bounded retry limit. A key-generation
failure saves no new connection key. Setup verifies a key-only connection before
saving it. The password stays in a short-lived setup session
and is never saved. The private key is encrypted with Electron safeStorage using
macOS Keychain or Windows DPAPI. The approved host key is pinned. Existing SSH connections
continue to use OpenSSH configuration, keys, and strict known-host verification.

The companion runs as the Spark user's UID/GID in the labeled `frostbyte-beta`
Docker container with restart policy `unless-stopped`. Its state lives in
`~/.local/share/frostbyte-beta/state`. It mounts that state and the user-selected
storage folders, uses no GPU devices, and leaves other containers alone. Control
uses a private mode-0600 Unix socket through SSH; no HTTP management port is opened.
Docker host networking supports BitTorrent peer traffic.

Updates build before stopping the old companion. A failed or cancelled activation
restores its container and transfer state. A detached recovery process also handles
a disconnected desktop or interrupted installer; the next setup checks abandoned
installation state before proceeding. A completed installation remains installed
if a later desktop key-pairing step fails, and pairing can be retried.

Gated HF tokens are sent over SSH for an explicit download or resume, held only
in memory for the job, and excluded from status and saved state. After restarting
the companion—including when adding storage—a gated job may need **Resume** to
provide access again.

## Developer validation

The commands below describe the macOS/Linux validation lane. For native Windows
desktop and SSH fixtures, use [Windows packaging verification](PACKAGING.md#windows-x64).

```sh
npm run test:spark
npm run dist:mac
npm run test:packaged
FROSTBYTE_TEST_SPARK=your-alias FROSTBYTE_TEST_MAC_IP=your-mac-lan-ip npm run test:packaged
```

Tests cover real local SSH authentication, host trust, encrypted pairing and Mac
restart, folder selection, actual bytes written to separate storage roots,
missing-drive behavior, and Python installer failure/cancellation/recovery. The
optional live Spark test transfers a small file from the Mac, downloads a public
HF config directly to Spark, verifies both SHA-256 hashes, and reconnects after a
Mac restart. It uses the configured primary storage folder.

The final Windows encrypted-pairing test passed with a local SSH fixture and real
Windows DPAPI, enrolling a generated key and reconnecting from its encrypted saved
value without the password. It uses an isolated profile and does not contact a
physical Spark. Earlier beta.1 and
beta.2 Mac-to-Spark transfers passed on physical hardware. Those results are
historical coverage, not a Windows device test or a beta.4 physical-device rerun.
See [the release review](REVIEW.md) for the final packaged test status.

For development, the same reviewed installer can be invoked from the repository:

```sh
npm run deploy:spark -- your-ssh-alias
```

## Beta scope

Beta.12 supports up to 16 saved remote companions per desktop profile, including
Macs. GPU/inference controls, importing existing HF caches, copying arbitrary desktop folders,
and moving existing downloads between registered disks are future work. Spark
runs two HF downloads at a time; desktop bandwidth/queue settings apply to local jobs.
Torrent support uses v1-compatible metadata. Selected-file downloads report their
own completion; neighboring pieces may contain small portions of skipped files.
