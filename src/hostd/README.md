# frostbyte-hostd

`frostbyte-hostd` is FrostByte's private, user-owned host-management sidecar. It
is a standard-library-only Python service adapted from the secured Frigid 0.8.1
daemon. The Frigid repository is not read or modified at runtime.

The service listens on `127.0.0.1:8757` by default and authenticates protected
routes with a bearer token stored in a mode-0600 file. Browser `Origin` headers
and non-IP `Host` headers are refused. `--bind-lan` is the only supported way to
listen on `0.0.0.0`; LAN mode is plain HTTP and should be restricted to a trusted
segment or carried through an SSH/VPN tunnel.

## Install

Run as the desktop/login user, without `sudo`:

```sh
python3 src/hostd/install_user.py install \
  --workspace code=/absolute/path/to/project \
  --workspace docs=/absolute/path/to/docs
```

The same command installs a systemd user unit on Linux and a LaunchAgent on
macOS. Reinstalling keeps the token unless `--rotate-token` is supplied. It also
keeps an existing `recipes.json` and prior workspace roots; pass
`--clear-workspaces` to remove those roots from the service configuration.

Useful commands:

```sh
# Inspect without writing or loading a service
python3 src/hostd/install_user.py install --dry-run

# Explicit trusted-LAN exposure
python3 src/hostd/install_user.py install --bind-lan

# Remove code and service files; preserve token, recipes and receipts
python3 src/hostd/install_user.py uninstall

# Linux status/logs
systemctl --user status frostbyte-hostd.service
journalctl --user -u frostbyte-hostd.service -f

# macOS status
launchctl print gui/$UID/com.frostbyte.hostd
```

Linux installs under `~/.config/frostbyte/hostd`,
`~/.local/state/frostbyte/hostd`, and `~/.local/lib/frostbyte-hostd`. macOS uses
`~/Library/Application Support/FrostByte/hostd` and
`~/Library/LaunchAgents/com.frostbyte.hostd.plist`.

For a foreground development run:

```sh
mkdir -p ~/.frostbyte/hostd
python3 -c 'import secrets; print(secrets.token_hex(32))' > ~/.frostbyte/hostd/token
chmod 600 ~/.frostbyte/hostd/token
cp src/hostd/recipes.example.json ~/.frostbyte/hostd/recipes.json
chmod 600 ~/.frostbyte/hostd/recipes.json
python3 src/hostd/frostbyte_hostd.py --workspace code="$PWD"
```

Verify and pair locally on Linux:

```sh
curl -s http://127.0.0.1:8757/v1/info
curl -s -H "Authorization: Bearer $(cat ~/.config/frostbyte/hostd/token)" \
  http://127.0.0.1:8757/v1/snapshot
```

The installer prints only the token fingerprint. Read the actual token from the
mode-0600 token file when placing it in FrostByte's credential store. For a
remote loopback installation, forward the service instead of exposing it:

```sh
ssh -N -L 8757:127.0.0.1:8757 user@managed-host
```

Then use `http://127.0.0.1:8757/` as the host-client base URL.

## API and parity

The following Frigid 0.8.1 behavior is retained:

- schema-1 snapshots and bounded 1 Hz telemetry SSE;
- validated Docker/tmux recipes and confirmed model start, stop, and preflight;
- two-phase Linux power confirmation, delayed dispatch, operation status, locks,
  and receipts;
- process, service, diagnostics, and recipe views;
- jailed list/read/write/mkdir/rename/delete and confirmed shell execution;
- bounded search, git status/diff/stage/commit/log, file watching, and PTY APIs;
- constant-time bearer comparison, DNS-rebinding/browser guards, body limits,
  stream concurrency limits, and degraded telemetry rather than invented data.

FrostByte adds:

- fixed `/v1/models` and `/v1/chat/completions` proxies to
  `127.0.0.1:<endpoint-port>`; no caller can choose an upstream URL and the host
  bearer is never forwarded;
- repeatable `--workspace [ID=]PATH`, `/v1/workspaces`, and a `root` query/body
  field for request-scoped named-root selection;
- stricter token/recipe file ownership, mode, regular-file, and size gates;
- unique no-follow atomic workspace writes and PTY process-group reaping;
- a loopback-only `--host` value plus the explicit `--bind-lan` switch;
- FrostByte service names, paths, receipts, environment marker, and installer.

`GET /v1/info` is the only unauthenticated route. Before authentication it
returns `hostname: "redacted"` and no boot ID. All other routes require:

```text
Authorization: Bearer <token>
```

The default workspace is the root named `default`, or the first configured root
when no root has that name. Existing single-root clients therefore continue to
work; named-root clients send `root=<id>` for GET routes or `{"root":"<id>"}`
inside POST bodies.

The inference upstream is always local HTTP. It does not forward the host token,
does not accept an arbitrary base URL, and currently has no separate upstream
API-key option. Requests are capped at 4 MB, JSON responses at 8 MB, streams at
64 MB, and concurrent inference requests at four.

## Power and platform limits

The non-root installer does not modify sudoers. Linux power execution remains
disabled until an administrator reviews, substitutes the service username in,
validates, and installs `frostbyte-hostd-power.sudoers.example`. The policy
allows only exact `/usr/bin/systemctl poweroff` and `reboot` commands. Power is
not implemented for macOS.

On macOS, `/proc`, `nvidia-smi`, Docker, or tmux may be absent. Corresponding
telemetry and model controls report unavailable while workspace, git, PTY, and
the fixed inference proxy remain usable. PTYs currently require `/bin/bash`.

## Tests

```sh
python3 tests/studio-hostd-parity.test.py
python3 tests/studio-hostd-installer.test.py
```

The parity suite is adapted from the Frigid 0.8.1 daemon tests and adds live
loopback coverage for named roots and both buffered and streamed inference.
