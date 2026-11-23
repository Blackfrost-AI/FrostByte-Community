const fs = require('node:fs/promises');
const path = require('node:path');

// electron-builder's generated AppRun silently disables Chromium's sandbox on
// hosts that reject user namespaces. Ship a reviewed launcher instead. Builder
// copies appOutDir over its AppImage staging files, including this AppRun.
function linuxAppRun(executableName) {
  if (!/^[a-zA-Z0-9._-]+$/.test(executableName)) throw new Error('Unsafe Linux executable name.');
  return `#!/bin/sh
set -eu

fail_sandbox() {
  message="FrostByte needs the Linux Chromium sandbox. Start it as a regular user on a system that permits unprivileged user namespaces, or install the Debian (.deb) package. FrostByte will not turn the sandbox off automatically."
  printf '%s\\n' "$message" >&2
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title='FrostByte: sandbox unavailable' --text="$message" 2>/dev/null || true
  fi
  exit 1
}

for argument in "$@"; do
  case "$argument" in
    --no-sandbox|--no-sandbox=*) fail_sandbox ;;
  esac
done
[ "$(id -u)" -ne 0 ] || fail_sandbox
command -v unshare >/dev/null 2>&1 || fail_sandbox
unshare -Ur true 2>/dev/null || fail_sandbox

APPDIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
export APPDIR
export LD_LIBRARY_PATH="$APPDIR/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$APPDIR/${executableName}" "$@"
`;
}

async function writeLinuxAppRun(appOutDir, executableName) {
  const destination = path.join(appOutDir, 'AppRun');
  await fs.writeFile(destination, linuxAppRun(executableName), { mode: 0o755 });
  await fs.chmod(destination, 0o755);
}

module.exports = { linuxAppRun, writeLinuxAppRun };
