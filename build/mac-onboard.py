"""Per-user macOS companion. No sudo, Docker, Remote Login or firewall changes.

The desktop supplies a hash-checked source archive over an authenticated SSH
connection. A staged, pinned Node runtime belongs only to FrostByte. The old
service, settings and all downloaded files survive a failed activation.
"""
import base64
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import plistlib
import re
import secrets
import shutil
import stat as stat_module
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path.home() / '.local/share/frostbyte-beta'
STATE = ROOT / 'state'
LABEL = 'ai.blackfrost.frostbyte.companion'
PLIST = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
DOMAIN = 'gui/' + str(os.getuid())
STAGE_STALE_SECONDS = 60 * 60
ALLOWED = {'src/main/ipfs.js', 'src/main/ipfs-runtime.js', 'src/main/aeon-device.js', 'src/shared/ipfs-source.js', 'src/shared/aeon.js', 'build/ipfs-runtime.json', 'scripts/build-ipfs-runtime.js', 'package.json', 'package-lock.json', 'src/main/torrent.js', 'src/main/safe-torrent-store.js', 'src/main/torrent-descriptor-budget.js',
           'src/main/portable-path.js', 'src/main/hf.js', 'src/main/hf-authorizations.js',
           'src/main/hf-hybrid.js', 'src/main/store.js', 'src/main/publisher-record.js', 'src/main/device-info.js',
           'src/shared/content-kind.js', 'src/shared/appearance.js', 'src/shared/edition.js', 'src/shared/companion-protocol.js', 'src/shared/device-models.js', 'src/agent/server.js', 'src/agent/assistant.js', 'src/main/assistant-runtimes.js', 'src/main/assistant-chat.js', 'src/agent/test-mode.js',
           'src/agent/client.js', 'build/spark.Dockerfile', 'build/mac-node-runtime.json',
           'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'LICENSES.third-party.txt'}
ALLOWED.update({'src/main/inventory.js', 'src/shared/inventory-proof.js', 'src/shared/edition-manifest.cjs', 'src/main/aeon-origin-check.js', 'src/main/integrity-service.js', 'src/main/format-safety.js', 'src/main/file-hash.js', 'src/main/upstream-verify.js', 'src/shared/format-hints.js', 'src/shared/aeon-origin.js', 'src/shared/aeon-origin-status.js'})


def run(args, timeout=40, check=True, **kwargs):
    result = subprocess.run([str(x) for x in args], text=True, capture_output=True, timeout=timeout, **kwargs)
    if check and result.returncode:
        raise RuntimeError((result.stderr or result.stdout or 'Companion setup failed.').strip()[-1400:])
    return result


def _owned_directory_descriptor(folder):
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
    try:
        descriptor = os.open(folder, flags)
    except OSError as error:
        raise RuntimeError('The companion folder must belong to your account and cannot be a link.') from error
    held = os.fstat(descriptor)
    if not stat_module.S_ISDIR(held.st_mode) or held.st_uid != os.getuid():
        os.close(descriptor)
        raise RuntimeError('The companion folder must belong to your account and cannot be a link.')
    return descriptor


def _owned_existing_directory(folder):
    try:
        held = os.lstat(folder)
    except OSError as error:
        raise RuntimeError('The companion staging folder must belong to your account and cannot be a link.') from error
    if not stat_module.S_ISDIR(held.st_mode) or held.st_uid != os.getuid():
        raise RuntimeError('The companion staging folder must belong to your account and cannot be a link.')
    return held


def read_owned_json(file, limit=1024 * 1024):
    descriptor = None
    try:
        before = os.lstat(file)
        if (not stat_module.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_uid != os.getuid() or before.st_size < 2 or before.st_size > limit):
            raise RuntimeError('The companion staging record is unsafe.')
        descriptor = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
        held = os.fstat(descriptor)
        current = os.lstat(file)
        if (not stat_module.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_uid != os.getuid()
                or held.st_size != before.st_size or held.st_dev != before.st_dev or held.st_ino != before.st_ino
                or held.st_dev != current.st_dev or held.st_ino != current.st_ino):
            raise RuntimeError('The companion staging record is unsafe.')
        body = bytearray()
        while len(body) <= limit:
            chunk = os.read(descriptor, min(65536, limit + 1 - len(body)))
            if not chunk:
                break
            body.extend(chunk)
        current = os.lstat(file)
        if len(body) != held.st_size or held.st_dev != current.st_dev or held.st_ino != current.st_ino:
            raise RuntimeError('The companion staging record is unsafe.')
        return json.loads(body.decode('utf-8'))
    except (OSError, UnicodeError, ValueError) as error:
        raise RuntimeError('The companion staging record is unsafe.') from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def stage_lease(phase):
    return {'pid': os.getpid(), 'updatedAt': time.time(), 'phase': phase}


def lease_owner_is_gone(lease):
    if not isinstance(lease, dict):
        return False
    try:
        raw_pid = lease['pid']
        updated = float(lease['updatedAt'])
    except (KeyError, TypeError, ValueError):
        return False
    if (not isinstance(raw_pid, int) or isinstance(raw_pid, bool) or raw_pid <= 0
            or not math.isfinite(updated) or updated > time.time() or time.time() - updated < STAGE_STALE_SECONDS):
        return False
    try:
        os.kill(raw_pid, 0)
        return False
    except ProcessLookupError:
        return True
    except (OSError, ValueError, TypeError):
        return False


def stage_transaction(stage):
    _owned_existing_directory(stage)
    if not re.fullmatch(r'[-a-zA-Z0-9_]{8,64}', stage.name):
        return None
    file = stage / 'transaction.json'
    if not file.exists() or file.is_symlink():
        return None
    transaction = read_owned_json(file)
    if transaction.get('owner') != LABEL:
        return None
    return transaction


def update_stage_lease(stage, phase):
    transaction = stage_transaction(stage)
    if transaction is None or transaction.get('sessionId') != stage.name:
        raise RuntimeError('The companion staging record changed during setup.')
    transaction['phase'] = phase
    transaction['lease'] = stage_lease(phase)
    save(stage / 'transaction.json', transaction)
    return transaction


def save_bytes(file, body):
    """Atomically replace a private file without following temporary or destination links."""
    if not isinstance(body, bytes):
        raise TypeError('Companion state must be encoded as bytes.')
    directory = _owned_directory_descriptor(file.parent)
    temporary = '.' + file.name + '.' + str(os.getpid()) + '.' + secrets.token_hex(12) + '.tmp'
    descriptor = None
    created = None
    published = False
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
        descriptor = os.open(temporary, flags, 0o600, dir_fd=directory)
        created = os.fstat(descriptor)
        offset = 0
        while offset < len(body):
            written = os.write(descriptor, body[offset:])
            if written <= 0:
                raise RuntimeError('Could not save companion state.')
            offset += written
        os.fsync(descriptor)
        held = os.fstat(descriptor)
        current = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
        if (not stat_module.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_uid != os.getuid()
                or held.st_dev != current.st_dev or held.st_ino != current.st_ino):
            raise RuntimeError('The companion state temporary file is unsafe.')
        os.replace(temporary, file.name, src_dir_fd=directory, dst_dir_fd=directory)
        published = True
        os.fsync(directory)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if not published and created is not None:
            try:
                current = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
                if current.st_dev == created.st_dev and current.st_ino == created.st_ino:
                    os.unlink(temporary, dir_fd=directory)
            except OSError:
                pass
        os.close(directory)


def save(file, value):
    save_bytes(file, json.dumps(value).encode('utf-8'))


def owned_directory(folder):
    folder.mkdir(parents=True, mode=0o700, exist_ok=True)
    if folder.is_symlink() or folder.stat().st_uid != os.getuid() or not folder.is_dir():
        raise RuntimeError('The companion folder must belong to your account and cannot be a link.')


def lock():
    owned_directory(ROOT)
    directory = _owned_directory_descriptor(ROOT)
    descriptor = None
    try:
        flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
        descriptor = os.open('activation.lock', flags, 0o600, dir_fd=directory)
        held = os.fstat(descriptor)
        current = os.stat('activation.lock', dir_fd=directory, follow_symlinks=False)
        if (not stat_module.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_uid != os.getuid()
                or held.st_dev != current.st_dev or held.st_ino != current.st_ino):
            raise RuntimeError('The companion activation lock must be a private regular file owned by your account.')
        os.fchmod(descriptor, 0o600)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        raise RuntimeError('The companion activation lock must be a private regular file owned by your account.') from error
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
        raise
    finally:
        os.close(directory)
    file = os.fdopen(descriptor, 'r+')
    try:
        fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        file.close()
        raise RuntimeError('Another companion setup is running. Wait for it to finish.')
    return file


def storage(folder, expected=None):
    # An absent external disk must never turn into a directory on the system disk.
    if folder == Path('/Volumes') or Path('/Volumes') in folder.parents:
        mount = Path('/Volumes') / folder.relative_to('/Volumes').parts[0] if folder != Path('/Volumes') else folder
        if not mount.is_mount():
            raise RuntimeError('Mount the external drive on this Mac before selecting its folder.')
    if folder == ROOT or ROOT in folder.parents or folder in ROOT.parents:
        raise RuntimeError('Choose a dedicated download folder outside the companion folder.')
    marker = folder / '.frostbyte-storage-id'
    if expected and (marker.is_symlink() or not marker.is_file() or marker.read_text().strip() != expected):
        raise RuntimeError('Reconnect the registered drive at ' + str(folder) + ' before changing storage.')
    folder.mkdir(parents=True, exist_ok=True)
    if marker.is_symlink():
        raise RuntimeError('A storage identity file cannot be a link.')
    if marker.exists():
        value = marker.read_text().strip()
        if not re.fullmatch('[a-f0-9]{32}', value):
            raise RuntimeError('The storage identity file is invalid.')
    else:
        value = secrets.token_hex(16)
        with os.fdopen(os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600), 'w') as output:
            output.write(value + '\n')
    with tempfile.TemporaryFile(dir=folder) as output:
        output.write(b'FrostByte storage check')
    return {'path': str(folder), 'marker': value}


def current_config():
    file = ROOT / 'managed.json'
    if not file.exists():
        if PLIST.exists() or PLIST.is_symlink() or (ROOT / 'current').exists() or run(['/bin/launchctl', 'print', DOMAIN + '/' + LABEL], check=False).returncode == 0:
            raise RuntimeError('An unmanaged companion already exists. Nothing was changed.')
        return None
    if file.is_symlink() or PLIST.is_symlink():
        raise RuntimeError('The existing companion configuration cannot be a link.')
    config = json.loads(file.read_text())
    if config.get('owner') != LABEL:
        raise RuntimeError('Another application owns this companion configuration.')
    if PLIST.exists():
        plist = plistlib.loads(PLIST.read_bytes())
        expected = [str(ROOT / 'current/runtime/bin/node'), str(ROOT / 'current/src/agent/server.js')]
        if plist.get('Label') != LABEL or plist.get('ProgramArguments') != expected:
            raise RuntimeError('The existing service was changed outside FrostByte. Keep it and review its configuration.')
    else:
        raise RuntimeError('The existing companion login service is missing. Restore its configuration before updating.')
    return config


def recover_stages():
    installs = ROOT / 'install'
    if not installs.exists():
        return
    _owned_existing_directory(installs)
    for stage in installs.iterdir():
        try:
            pending = stage_transaction(stage)
        except RuntimeError:
            continue
        if pending is None:
            continue
        phase = pending.get('phase')
        if phase == 'committed':
            try:
                shutil.rmtree(stage)
            except OSError:
                pass
            continue
        if phase in ('activating', 'awaiting-commit'):
            if time.time() < pending.get('recoverAfter', 0):
                raise RuntimeError('Another companion update is awaiting confirmation. Wait a few minutes, then reconnect.')
            rollback(stage)
            try:
                shutil.rmtree(stage)
            except OSError:
                pass
            continue
        if phase in ('restored', 'superseded') and pending.get('sessionId') == stage.name:
            try:
                shutil.rmtree(stage)
            except OSError:
                pass
            continue
        lease = pending.get('lease')
        if (phase in ('preparing', 'prepared', 'building', 'built', 'build-failed')
                and pending.get('sessionId') == stage.name and isinstance(lease, dict)
                and lease.get('phase') == phase and lease_owner_is_gone(lease)):
            shutil.rmtree(stage)


def prepare(payload, stage):
    if sys.platform != 'darwin' or platform.machine() not in ('arm64', 'x86_64'):
        raise RuntimeError('This companion supports Apple silicon and Intel Macs.')
    if run(['/bin/launchctl', 'print', DOMAIN], check=False).returncode:
        raise RuntimeError('Sign in to the Mac desktop with this SSH account before installing its companion.')
    if len(os.fsencode(STATE / 'control.sock')) >= 104:
        raise RuntimeError('This account’s home path is too long for the companion socket. Use an account with a shorter home path.')
    recover_stages()
    previous = current_config()
    folder = Path(payload['downloadDir']).resolve()
    roots = list(previous['storageRoots']) if previous else []
    primary = previous['downloadDir'] if previous else str(folder)
    if previous and not payload.get('addStorage') and str(folder) != primary:
        raise RuntimeError('Keep the existing primary folder during an update. Add storage after connecting.')
    if str(folder) not in roots:
        roots.append(str(folder))
    if len(roots) > 16:
        raise RuntimeError('A device can have up to 16 storage folders.')
    identities = {x['path']: x['marker'] for x in (previous or {}).get('storageIdentities', [])}
    identities = [storage(Path(root), identities.get(root)) for root in roots]
    owned_directory(STATE)
    installs = ROOT / 'install'
    owned_directory(installs)
    stage.mkdir(mode=0o700, exist_ok=False)
    transaction = {'owner': LABEL, 'sessionId': stage.name, 'phase': 'preparing', 'lease': stage_lease('preparing'),
         'previous': previous,
         'previousPlist': base64.b64encode(PLIST.read_bytes()).decode() if PLIST.exists() else None,
         'previousTarget': os.readlink(ROOT / 'current') if (ROOT / 'current').is_symlink() else None,
         'config': {'owner': LABEL, 'version': payload['manifest']['version'], 'downloadDir': primary,
                    'storageRoots': roots, 'storageIdentities': identities}}
    save(stage / 'transaction.json', transaction)
    data = base64.b64decode(payload['archive'], validate=True)
    manifest = payload['manifest']
    if len(data) != manifest['bytes'] or len(data) > 8 * 1024 ** 2 or hashlib.sha256(data).hexdigest() != manifest['sha256']:
        raise RuntimeError('The companion archive failed its integrity check.')
    source = stage / 'source'
    source.mkdir()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if len(members) != len(ALLOWED) or {x.name for x in members} != ALLOWED or any(not x.isfile() for x in members) or sum(x.size for x in members) > 20 * 1024 ** 2:
            raise RuntimeError('Unexpected files in the companion archive.')
        for member in members:
            target = source / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as incoming, target.open('wb') as output:
                shutil.copyfileobj(incoming, output)
    if json.loads((source / 'package.json').read_text())['version'] != manifest['version']:
        raise RuntimeError('The companion version does not match its manifest.')
    transaction['phase'] = 'prepared'
    transaction['lease'] = stage_lease('prepared')
    save(stage / 'transaction.json', transaction)
    return {'downloadDir': primary, 'updating': bool(previous)}


def build(stage):
    source = stage / 'source'
    runtime = json.loads((source / 'build/mac-node-runtime.json').read_text())
    architecture = 'arm64' if platform.machine() == 'arm64' else 'x64'
    filename = 'node-v' + runtime['version'] + '-darwin-' + architecture
    archive_file = stage / 'node.tar.gz'
    sha = hashlib.sha256()
    with urllib.request.urlopen('https://nodejs.org/dist/v' + runtime['version'] + '/' + filename + '.tar.gz', timeout=60) as response, archive_file.open('wb') as output:
        size = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > 90 * 1024 ** 2:
                raise RuntimeError('The Node runtime download is too large.')
            sha.update(chunk)
            output.write(chunk)
    if sha.hexdigest() != runtime[architecture]:
        raise RuntimeError('The Node runtime failed its integrity check.')
    destination = source / 'runtime'
    destination.mkdir()
    # Only regular files/directories are needed: npm is invoked via npm-cli.js.
    with tarfile.open(archive_file, 'r:gz') as archive:
        total = 0
        for member in archive:
            parts = Path(member.name).parts
            if not parts or parts[0] != filename or '..' in parts or Path(member.name).is_absolute():
                raise RuntimeError('Invalid path in the Node runtime archive.')
            if not member.isfile():
                continue
            total += member.size
            if total > 400 * 1024 ** 2:
                raise RuntimeError('The extracted Node runtime is too large.')
            target = destination.joinpath(*parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as incoming, target.open('wb') as output:
                shutil.copyfileobj(incoming, output)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    for command in ('npm', 'npx'):
        (destination / 'bin' / command).symlink_to('../lib/node_modules/npm/bin/' + command + '-cli.js')
    env = {**os.environ, 'PATH': str(destination / 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', 'npm_config_cache': str(stage / 'npm-cache')}
    node = destination / 'bin/node'
    npm = destination / 'lib/node_modules/npm/bin/npm-cli.js'
    # Match the Linux companion's reviewed lifecycle allowlist. Dependency
    # package-manager hooks are not part of installing the download engine.
    run([node, npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], timeout=1200, cwd=source, env=env)
    run([node, npm, 'rebuild', 'node-datachannel', 'utp-native', 'bufferutil', 'utf-8-validate'], timeout=1200, cwd=source, env=env)
    run([node, 'scripts/build-ipfs-runtime.js'], timeout=300, cwd=source, env=env)
    run([node, '--input-type=module', '-e', "await import('./src/main/torrent.js'); await import('./src/main/device-info.js')"], cwd=source, env=env)
    return {'built': True}


def stop_service():
    result = run(['/bin/launchctl', 'print', DOMAIN + '/' + LABEL], check=False)
    if result.returncode == 0:
        match = re.search(r'\bpid = ([0-9]+)', result.stdout)
        pid = int(match.group(1)) if match else None
        run(['/bin/launchctl', 'bootout', DOMAIN + '/' + LABEL])
        # bootout returns before the old process has finished persisting jobs.
        # Wait for it to exit before swapping binaries or starting a new writer.
        for attempt in range(120):
            alive = False
            if pid:
                try:
                    os.kill(pid, 0)
                    alive = True
                except ProcessLookupError:
                    pass
            registered = run(['/bin/launchctl', 'print', DOMAIN + '/' + LABEL], check=False).returncode == 0
            if not alive and not registered:
                return
            time.sleep(0.25)
        raise RuntimeError('The previous companion is still shutting down. Wait for it to finish before updating again.')


def point_to(target):
    directory = _owned_directory_descriptor(ROOT)
    temporary = '.current.' + str(os.getpid()) + '.' + secrets.token_hex(12) + '.next'
    created = None
    published = False
    try:
        os.symlink(str(target), temporary, dir_fd=directory)
        created = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
        if not stat_module.S_ISLNK(created.st_mode) or os.readlink(temporary, dir_fd=directory) != str(target):
            raise RuntimeError('The companion release link is unsafe.')
        os.replace(temporary, 'current', src_dir_fd=directory, dst_dir_fd=directory)
        published = True
        os.fsync(directory)
    finally:
        if not published and created is not None:
            try:
                current = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
                if current.st_dev == created.st_dev and current.st_ino == created.st_ino:
                    os.unlink(temporary, dir_fd=directory)
            except OSError:
                pass
        os.close(directory)


def rollback(stage):
    file = stage / 'transaction.json'
    transaction = read_owned_json(file)
    if transaction['phase'] not in ('activating', 'awaiting-commit'):
        return {'restored': False}
    expected = {(ROOT / 'releases' / stage.name).resolve(), Path(transaction['previousTarget']).resolve() if transaction['previousTarget'] else None}
    current = (ROOT / 'current').resolve() if (ROOT / 'current').exists() else None
    if current not in expected:
        transaction['phase'] = 'superseded'
        save(file, transaction)
        return {'restored': False}  # A stale recovery task must not stop a newer service.
    stop_service()
    if transaction['previousTarget']:
        point_to(transaction['previousTarget'])
    else:
        (ROOT / 'current').unlink(missing_ok=True)
    if transaction['previousPlist']:
        save_bytes(PLIST, base64.b64decode(transaction['previousPlist']))
        run(['/bin/launchctl', 'bootstrap', DOMAIN, PLIST])
    else:
        PLIST.unlink(missing_ok=True)
    if transaction['previous']:
        save(ROOT / 'managed.json', transaction['previous'])
    else:
        (ROOT / 'managed.json').unlink(missing_ok=True)
    transaction['phase'] = 'restored'
    save(file, transaction)
    return {'restored': True}


def watchdog(stage):
    pid = os.fork()
    if pid:
        return
    os.setsid()
    # The watchdog must not retain the parent's activation lock or SSH pipes.
    os.closerange(3, 65536)
    for descriptor in (0, 1, 2):
        with open(os.devnull, 'r+' if descriptor == 0 else 'a') as null:
            os.dup2(null.fileno(), descriptor)
    time.sleep(150)
    try:
        if (stage / 'transaction.json').exists():
            with lock():
                if (stage / 'transaction.json').exists():
                    rollback(stage)
    finally:
        os._exit(0)


def activate(stage):
    file = stage / 'transaction.json'
    transaction = read_owned_json(file)
    if transaction['phase'] not in ('prepared', 'built'):
        raise RuntimeError('This setup was already activated. Reconnect before trying again.')
    if current_config() != transaction['previous']:
        raise RuntimeError('The companion changed during setup. Run setup again.')
    release = ROOT / 'releases' / stage.name
    release.parent.mkdir(exist_ok=True)
    (stage / 'source').rename(release)
    save(release / '.frostbyte-release.json', {'owner': LABEL, 'session': stage.name})
    transaction['phase'] = 'activating'
    transaction['recoverAfter'] = time.time() + 150
    save(file, transaction)
    watchdog(stage)
    try:
        stop_service()
        point_to(release)
        config = transaction['config']
        env = {'FROSTBYTE_AGENT_HOME': str(STATE), 'FROSTBYTE_DOWNLOAD_DIR': config['downloadDir'],
               'FROSTBYTE_STORAGE_ROOTS': json.dumps(config['storageRoots']),
               'FROSTBYTE_STORAGE_IDENTITIES': json.dumps(config['storageIdentities']), 'FROSTBYTE_DEVICE': platform.node()}
        PLIST.parent.mkdir(parents=True, exist_ok=True)
        plist = {'Label': LABEL, 'ProgramArguments': [str(ROOT / 'current/runtime/bin/node'), str(ROOT / 'current/src/agent/server.js')],
                 'WorkingDirectory': str(STATE), 'EnvironmentVariables': env, 'RunAtLoad': True,
                 'KeepAlive': {'SuccessfulExit': False}, 'ThrottleInterval': 10, 'ProcessType': 'Background',
                 'StandardOutPath': str(STATE / 'service.log'), 'StandardErrorPath': str(STATE / 'service-error.log')}
        save_bytes(PLIST, plistlib.dumps(plist))
        run(['/bin/launchctl', 'bootstrap', DOMAIN, PLIST])
        status = None
        for attempt in range(20):
            result = run([release / 'runtime/bin/node', release / 'src/agent/client.js'], timeout=8,
                         input='{"action":"status"}\n', check=False, env={**os.environ, **env})
            try:
                response = json.loads(result.stdout)
                if response.get('ok') and response['data']['version'] == config['version']:
                    status = response['data']
                    break
            except (ValueError, KeyError):
                pass
            time.sleep(0.5)
        if status is None:
            raise RuntimeError('The Mac companion did not become ready. Restoring the previous service.')
        save(ROOT / 'managed.json', config)
        transaction['phase'] = 'awaiting-commit'
        save(file, transaction)
        return {'status': status}
    except Exception:
        rollback(stage)
        raise


def dispatch(payload):
    session = payload.get('sessionId', '')
    if not re.fullmatch(r'[-a-zA-Z0-9_]{8,64}', session):
        raise RuntimeError('Invalid companion installation session.')
    manifest = payload.get('manifest', {})
    if manifest.get('schemaVersion') != 1 or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?', manifest.get('version', '')):
        raise RuntimeError('Invalid companion manifest.')
    folder = payload.get('downloadDir')
    if not isinstance(folder, str) or not folder.startswith('/') or any(x in folder for x in '\0\r\n'):
        raise RuntimeError('Choose an absolute download folder on this Mac.')
    stage = ROOT / 'install' / session
    with lock():
        if stage.is_symlink():
            raise RuntimeError('Invalid staging folder.')
        action = payload.get('action')
        if action == 'prepare':
            return prepare(payload, stage)
        if action == 'build':
            update_stage_lease(stage, 'building')
            try:
                result = build(stage)
            except BaseException:
                update_stage_lease(stage, 'build-failed')
                raise
            update_stage_lease(stage, 'built')
            return result
        if action == 'activate':
            return activate(stage)
        if action == 'rollback':
            return rollback(stage)
        if action == 'finalize':
            file = stage / 'transaction.json'
            transaction = read_owned_json(file)
            if transaction['phase'] != 'awaiting-commit':
                raise RuntimeError('The companion is not ready to finalize.')
            transaction['phase'] = 'committed'
            save(file, transaction)
            # Keep the running release and one previous release, not an
            # unbounded pile of Node runtimes on a smaller Mac system disk.
            protected = {(ROOT / 'current').resolve(), Path(transaction['previousTarget']).resolve() if transaction['previousTarget'] else None}
            for release in (ROOT / 'releases').iterdir():
                marker = release / '.frostbyte-release.json'
                if release.is_symlink() or release.resolve() in protected or not marker.is_file() or marker.is_symlink():
                    continue
                try:
                    if json.loads(marker.read_text()).get('owner') == LABEL:
                        shutil.rmtree(release)
                except (OSError, ValueError):
                    pass  # Housekeeping must not undo a healthy committed service.
            try:
                shutil.rmtree(stage)
            except OSError:
                pass  # The next setup retries cleanup of committed staging.
            return {'ready': True}
        if action == 'cleanup':
            if (stage / 'transaction.json').exists():
                rollback(stage)
            if stage.exists():
                shutil.rmtree(stage)
            return {'cleaned': True}
        raise RuntimeError('Unsupported companion setup action.')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'data': dispatch(payload)}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
