# Devices beta

Devices connects FrostByte to Macs and DGX machines on your network. The local
computer has its own card. Up to 16 remote companions can be saved together,
with separate connections, default folders, inventories, and transfer controls.
Several devices can stay connected and download at the same time. Selecting a
card changes which device you are viewing; it does not disconnect the others.
Existing Spark connections migrate when beta.12 first opens.

## Add a computer

1. Open **Devices → Add device** on the computer running FrostByte.
2. Enter the other computer's address, username, and SSH port. Use its account
   password for first setup, or choose an existing SSH connection.
3. Verify the displayed SSH host fingerprint on that computer, then continue.
4. Review the detected machine and choose a download folder on it. An external
   drive must already be mounted. Choose one destination for each download.
5. Install the companion, or connect to a compatible existing installation.
6. Choose that device in an HF or torrent download. Follow progress in
   **Transfers**, where a model's shards remain grouped. Completed items appear
   in **My Models** or **Torrents**, filterable by their individual device.

### Remote Mac requirements

- Apple silicon or Intel Mac with macOS 11 or later for the Node companion.
  The FrostByte desktop installer remains Apple silicon only in this beta.
- Enable **System Settings → General → Sharing → Remote Login** for the account
  you will use. The app does not enable SSH or change firewall rules for you.
- Python 3 must be available through that SSH login. If it is missing, setup
  reports the prerequisite; it does not install Xcode or use administrator access.
- Sign in to the desktop with the same account. Downloads run while that account
  is logged in and the Mac is awake. Sleeping or shutting down the Mac interrupts
  its network transfers; turning off the controller computer does not.
- First setup needs access to nodejs.org, npm, and native dependency downloads.

The Mac companion is a per-user LaunchAgent named
`ai.blackfrost.frostbyte.companion`. It uses a hash-pinned Node runtime kept under
`~/.local/share/frostbyte-beta`, separate from a user's system Node installation.
It has no Docker or Frigid dependency. Its state is in the `state` subdirectory;
downloads stay in the folders the user selects. The login-service plist lives
in `~/Library/LaunchAgents`.

### DGX requirements

Linux ARM64 and x64 hosts need Python 3 and a running Docker installation that
the SSH account can use. The companion uses the existing labeled
`frostbyte-beta` container, runs as that account's UID/GID, and preserves its
state and registered storage during an upgrade. It does not need GPU access.
See [DGX installation details](SPARK-BETA.md) for the container and storage rules.

## Hardware and images

The companion reports its platform, hardware model identifier, manufacturer,
processor, physical core count when available, GPU names, GPU core counts when
reported, OS version, and memory reported by the operating system. These appear
on each card. Multiple real GPUs remain visible; USB and remote display adapters
are excluded. CPU threads are not labeled as physical cores.
Usable memory can be lower than the marketed capacity because the OS reserves
some memory. Storage space comes from the selected filesystem, including external
drives; the app does not assume every DGX has a 4 TB disk.

A local catalog maps known identifiers to model names and bundled manufacturer
product photos on white backgrounds. It distinguishes NVIDIA DGX Spark, ASUS
Ascent GX10 and Dell Pro Max with GB10, and uses Apple stock photos for Mac mini,
Mac Studio, Mac Pro, MacBooks and supported iMacs. Windows uses a representative
laptop or desktop photo while keeping the actual reported machine model and
hardware facts on the card. Changing the photo never changes those facts.

Stock photos show an enclosure family, not a promise of the unit's color or
configuration. Mac Pro tower and rack share an identifier, so the tower photo is
the default; **Device options** can choose the rack photo or another stock image.
Unknown machines keep their reported identifier and a neutral placeholder.
Only a recognized manufacturer and model select a matching GB10 product photo.

The identification table cites Apple's model identification pages in
`src/shared/device-models.js` and
[NVIDIA's DGX Spark hardware documentation](https://docs.nvidia.com/dgx/dgx-spark/hardware.html).
Photo source pages, credits and original-byte hashes are recorded in
`assets/devices/sources.json`. Images retain their manufacturers' copyrights;
they do not imply manufacturer endorsement. Remaining SVG placeholders are
original FrostByte artwork.

Hardware collection excludes serial numbers, hardware UUIDs, and MAC addresses.
It sends the allowlisted facts only over the user's authenticated SSH connection.
These details are not added to optional diagnostics or feedback payloads. Photos
are bundled locally; displaying a card makes no image-service or serial-lookup request.
Mac GPU detection uses System Profiler's minimal report and retains only GPU
model/core fields. Windows queries selected CIM properties. Linux setup passes
only host GPU names into the container, without granting it GPU access. If a
known GB10 system cannot report its GPU, the documented fixed GPU is labeled
as coming from the manufacturer's specifications. Other missing facts remain
explicitly unavailable.

## Storage, sharing, and disconnected devices

In **My Models**, **Scan all saved directories** finds models already on disk in
the saved local download/completed folders, recorded download destinations, and
every saved companion's registered storage directories. There is no need to
browse each device first. The same button stops an active scan; a compact status
line reports completion and unavailable locations.

Scanning reads directory metadata only. It does not move, download, load, or
share models, and it does not update the companion or change network settings.
Model folders/shards are grouped, standalone GGUF variants stay separate, and
discovered models are cached across restarts. Sharing from a discovered card
still requires native confirmation. Discovery is not a download-ownership record
and does not offer file deletion. Hidden folders, symbolic links, and partial
downloads are skipped; bounded or unreadable scans retain cached entries.

Each device remembers one default destination. Every download writes to exactly
one folder. Browsing a different folder or selecting another device does not
redirect a job or an open download choice. A missing selected drive blocks the
download rather than silently selecting internal storage.

Pause, Resume, Clear, and Sharing operate on the device that owns the item,
including when two devices have the same torrent hash or HF model/file IDs.
Offline devices retain their last known hardware and inventory; their controls
stay disabled until they reconnect. An offline connection does not prevent another
device's status from updating.

**HF + device** uses one selected companion as the source of already-shared,
verified public files. A saved job keeps that source's device ID. Ineligible,
unavailable, or forgotten peers fall back to HF; a different device is not
substituted silently. This beta does not aggregate several companions into one
hybrid swarm. Sharing remains controlled by the item's switch.

**Device options → Update companion** updates using the saved connection. The
Mac installer stages dependencies before stopping the service, waits for the old
process to save its jobs, checks the replacement, and restores the previous
service if activation fails. It retains one previous managed runtime. A gated HF
job may need **Resume** after a companion restart to supply its token again.

**Forget connection** removes this desktop's saved pairing. It does not stop the
remote companion, delete downloaded files, or revoke the remote authorized-key
entry. Pair again to regain control. It is not a remote uninstall action.

## Validation

```sh
npm run test:spark
python3 tests/mac-installer.test.py
npx playwright test tests/e2e/devices.spec.js tests/e2e/spark-pairing.spec.js
npm run build:spark
FROSTBYTE_TEST_MAC_INSTALLER=1 node --test tests/mac-companion-native.test.js
```

The last command is macOS-only. It installs a real LaunchAgent with a unique test
label in an isolated temporary home, downloads a public HF config and a loopback
torrent, verifies torrent bytes, upgrades the companion, checks retained state,
and removes its test service. It does not change the user's SSH configuration or
production companion.
