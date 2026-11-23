Related: [AEON Orb theme design system](AEON-THEME.md).

# AEON Raspberry Pi image integration

**Status: integration kit only. A combined flashable image has not been built
or boot-tested.** AEON's official clean base-image file, release identifier and
checksum are required. A working Linux image builder and a physical Pi are
also needed. Do not label this kit an installer or a flashable image.

The desktop remains one FrostByte distribution. AEON Orbit is available to
everyone. A connected Pi can report the image capability below to show its
AEON tools in that device's detail panel.

## Current deliverable

Run `npm run build:aeon-kit`. The generated `build/aeon-image-kit/` contains
the checksummed companion source payload, its existing transactional
installer, the manifest, this guide, and an intentionally invalid example
capability marker. It contains no user profile, password, SSH key, HF token,
IPFS identity, downloaded model or subscriber data.

The marker example stays invalid until the reviewed AEON release identifier
is supplied. The Pi image itself must use AEON's approved base; an arbitrary
stock Linux image with this marker is not an AEON distribution.

## Image contract

The image maintainer installs `/etc/aeon/frostbyte-integration.json` as a
root-owned ordinary file, maximum 4096 bytes, mode `0644` or stricter:

```json
{
  "schema": 1,
  "image": "aeon-magick-orb",
  "version": "ACTUAL-REVIEWED-IMAGE-VERSION",
  "port": 443,
  "tools": ["models", "devices", "view"]
}
```

Only advertise routes actually provided by that release: `models` opens
`/model-share`, `devices` opens `/agent`, and `view` opens `/`. HTTPS ports
443 and 8443 are supported. The browser retains AEON's own authentication.
FrostByte transfers no AEON administrator credentials and exposes no remote
web content to its Electron bridge. This is capability detection, not image
attestation, subscription entitlement or a grant of computer-control access.

The installer reads the host's device-tree model and this marker and passes
only those facts to the companion for validation. This requires no extra
container privileges or host filesystem mounts. A Mac, DGX, ordinary Pi
image or offline Pi does not receive AEON tools from choosing a theme.

## Assembly and first boot

1. Verify the official base image and record its source, version and SHA-256.
   Work on a copy. Inspect the actual OS, partition layout, AEON routes,
   Docker support and first-boot provisioning before choosing the final
   assembly commands.
2. Build the ARM64 FrostByte companion from the exact staged source archive
   and pinned Dockerfile. Test the container on Linux ARM64. Include the
   original FrostByte, Kubo, Node and AEON/component licenses.
3. Integrate through the image's supported provisioning mechanism. Preserve
   FrostByte's reviewed SSH setup and chosen-folder activation. A preloaded
   container must be bound to exact payload/image digests; the current
   installer continues to build its own reviewed payload. This kit does not
   implement offline container activation.
4. Keep first boot personal: unique SSH, host and IPFS identities; user-created
   login and AEON credentials; no preselected sharing or model download.
   Never clone a configured user's Orb into the distributable image.
5. In FrostByte, choose **Devices → Add device**, verify the SSH host, pair
   the Pi, and choose an internal or mounted external folder. Each download
   selects one destination. Enable sharing for the desired collection.

IPFS currently keeps separate receive and publishing caches under the
companion state directory. Final files can go to external storage, but the
cache still uses the state drive. Qualify state/cache placement before
large-model trials on an SD card. Torrent bandwidth limits do not apply to IPFS.

## Hardware acceptance

Qualify Pi 5 with 64-bit Linux first. Pi 4 identification is implemented, but
Pi 4 must be boot- and load-tested separately. Verify fresh pairing, external
drive selection, HF/torrent/IPFS downloads, grouped progress, sharing on/off,
restart recovery, drive removal, image update and rollback. Selecting another
device must hide the Pi's tools. No model starts automatically, and download
support is not a promise that the Pi can run a given model.

The Mac-hosted tests use isolated peers and example hardware reports; they do
not substitute for the physical image test.

Upstream reviewed for the initial contract:
https://github.com/AEON-7/aeon-magick-ai-computer-control/tree/ffb7489e108e82bbbeb3d6248a665960264ec064
