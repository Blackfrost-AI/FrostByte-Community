"""Trusted FrostByte companion installer, transported by authenticated SSH with JSON stdin.
No Frigid dependencies, privilege escalation, management listener, or user shell interpolation.
"""
import base64
import csv
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import sys
import socket
import stat as stat_module
import subprocess
import tarfile
import tempfile
import time

NAME = 'frostbyte-beta'
LABEL = 'ai.blackfrost.frostbyte'
ROOT = Path.home() / '.local/share/frostbyte-beta'
STATE = ROOT / 'state'
STAGE_STALE_SECONDS = 60 * 60


def run(args, timeout=35, input=None, check=True, log=False):
    try:
        result = subprocess.run(args, input=input, text=True, capture_output=not log, timeout=timeout)
    except FileNotFoundError as error:
        raise RuntimeError('Docker is not installed. Install Docker on your Spark, then run setup again.') from error
    if check and result.returncode:
        message = (result.stderr or '').strip()[-1200:] if not log else ''
        raise RuntimeError(message or 'Docker could not complete this setup step.')
    return result


def inspect(name):
    result = run(['docker', 'container', 'inspect', name], check=False)
    if result.returncode:
        if 'No such' in (result.stderr or ''):
            return None
        raise RuntimeError((result.stderr or 'Cannot inspect Docker containers.').strip())
    return json.loads(result.stdout)[0]


def own_container(container):
    if not container:
        return
    config = container.get('Config', {})
    label = (config.get('Labels') or {}).get(LABEL)
    if label == 'agent':
        return
    reviewed = payload.get('adoptLegacyContainerId', '')
    # Older manual installs lack labels. Adoption requires a separately reviewed
    # immutable ID, the known daemon command and this account's exact state bind.
    state_mounts = [entry for entry in container.get('Mounts', []) if entry.get('Destination') == '/state']
    if (label is None and isinstance(reviewed, str) and re.fullmatch('[a-f0-9]{64}', reviewed)
            and container.get('Id') == reviewed and config.get('Cmd') == ['node', 'src/agent/server.js']
            and str(config.get('Image', '')).startswith('frostbyte-agent:')
            and len(state_mounts) == 1 and state_mounts[0].get('Type', 'bind') == 'bind'
            and Path(state_mounts[0].get('Source', '')).resolve() == STATE.resolve()):
        return
    raise RuntimeError('Another application owns the frostbyte-beta container. Nothing was changed.')


def _owned_directory_descriptor(folder):
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
    try:
        descriptor = os.open(folder, flags)
    except OSError as error:
        raise RuntimeError('The FrostByte state folder must be an owned directory, not a link.') from error
    held = os.fstat(descriptor)
    if not stat_module.S_ISDIR(held.st_mode) or held.st_uid != os.getuid():
        os.close(descriptor)
        raise RuntimeError('The FrostByte state folder must be an owned directory, not a link.')
    return descriptor


def _owned_directory(folder):
    """Require an existing, directly-owned directory without following a link."""
    try:
        held = os.lstat(folder)
    except OSError as error:
        raise RuntimeError('The FrostByte staging folder must be an owned directory, not a link.') from error
    if not stat_module.S_ISDIR(held.st_mode) or held.st_uid != os.getuid():
        raise RuntimeError('The FrostByte staging folder must be an owned directory, not a link.')
    return held


def read_owned_json(file, limit=1024 * 1024):
    """Read a bounded private JSON file through one held regular-file descriptor."""
    descriptor = None
    try:
        before = os.lstat(file)
        if (not stat_module.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_uid != os.getuid() or before.st_size < 2 or before.st_size > limit):
            raise RuntimeError('The FrostByte staging record is unsafe.')
        descriptor = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
        held = os.fstat(descriptor)
        current = os.lstat(file)
        if (not stat_module.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_uid != os.getuid()
                or held.st_size != before.st_size or held.st_dev != before.st_dev or held.st_ino != before.st_ino
                or held.st_dev != current.st_dev or held.st_ino != current.st_ino):
            raise RuntimeError('The FrostByte staging record is unsafe.')
        body = bytearray()
        while len(body) <= limit:
            chunk = os.read(descriptor, min(65536, limit + 1 - len(body)))
            if not chunk:
                break
            body.extend(chunk)
        current = os.lstat(file)
        if len(body) != held.st_size or held.st_dev != current.st_dev or held.st_ino != current.st_ino:
            raise RuntimeError('The FrostByte staging record is unsafe.')
        return json.loads(body.decode('utf-8'))
    except (OSError, UnicodeError, ValueError) as error:
        raise RuntimeError('The FrostByte staging record is unsafe.') from error
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


def expected_stage_image(version, session):
    if (not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?', str(version))
            or not re.fullmatch(r'[-a-zA-Z0-9_]{8,64}', str(session))):
        return None
    return 'frostbyte-agent:' + str(version) + '-' + str(session).lower()


def remove_stage_image(metadata, session):
    """Remove only this owned session's derived tag, confirming success or absence."""
    if not isinstance(metadata, dict):
        return False
    image = expected_stage_image(metadata.get('version'), session)
    if (not image or metadata.get('owner') != LABEL or metadata.get('sessionId') != session
            or metadata.get('image') != image):
        return False
    result = run(['docker', 'image', 'rm', image], timeout=30, check=False)
    message = (result.stderr or result.stdout or '').lower()
    return result.returncode == 0 or 'no such image' in message or 'does not exist' in message


def stage_metadata(stage):
    _owned_directory(stage)
    if not re.fullmatch(r'[-a-zA-Z0-9_]{8,64}', stage.name):
        return None
    marker = stage / 'stage.json'
    if not marker.exists() or marker.is_symlink():
        return None
    metadata = read_owned_json(marker)
    expected = expected_stage_image(metadata.get('version'), stage.name) if isinstance(metadata, dict) else None
    if (not expected or metadata.get('owner') != LABEL or metadata.get('sessionId') != stage.name
            or metadata.get('image') != expected):
        return None
    return metadata


def mark_stage(stage, phase):
    current = stage_metadata(stage)
    if current is None:
        raise RuntimeError('The FrostByte staging record changed during setup.')
    current['lease'] = stage_lease(phase)
    save_json(stage / 'stage.json', current)
    return current


def save_json(file, value):
    """Atomically replace JSON without following a predictable temporary-file link."""
    body = json.dumps(value).encode('utf-8')
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
                raise RuntimeError('Could not save FrostByte state.')
            offset += written
        os.fsync(descriptor)
        held = os.fstat(descriptor)
        current = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
        if (not stat_module.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_uid != os.getuid()
                or held.st_dev != current.st_dev or held.st_ino != current.st_ino):
            raise RuntimeError('The FrostByte state temporary file is unsafe.')
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


def mount(source, destination):
    line = io.StringIO()
    csv.writer(line, lineterminator='').writerow(['type=bind', 'src=' + str(source), 'dst=' + str(destination)])
    return line.getvalue()


def storage_path(value):
    folder = Path(value).resolve()
    for reserved in (Path('/app'), Path('/state'), Path('/tmp')):
        if folder == reserved or reserved in folder.parents or folder in reserved.parents:
            raise RuntimeError('Choose a download folder outside the companion runtime folders.')
    return folder


def configuration():
    manifest = payload['manifest']
    session = payload['sessionId']
    if not re.fullmatch(r'[-a-zA-Z0-9_]{8,64}', session):
        raise RuntimeError('Invalid installation session.')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?', manifest['version']):
        raise RuntimeError('Invalid companion version.')
    if manifest.get('schemaVersion') != 1 or not re.fullmatch('[a-f0-9]{64}', manifest['sha256']):
        raise RuntimeError('Invalid companion manifest.')
    folder = payload['downloadDir']
    if not isinstance(folder, str) or not folder.startswith('/') or any(char in folder for char in '\0\r\n'):
        raise RuntimeError('Choose an absolute download folder on Spark.')
    return manifest, session, ROOT / 'install' / session, storage_path(folder)


def existing_folder(container):
    for item in container.get('Config', {}).get('Env', []):
        if item.startswith('FROSTBYTE_DOWNLOAD_DIR='):
            return Path(item.split('=', 1)[1]).resolve()
    return Path('/downloads')


def environment(container):
    return dict(value.split('=', 1) for value in container.get('Config', {}).get('Env', []) if '=' in value)


def host_gpus():
    """Public GPU names only; no serial, UUID, utilization, or GPU access grant."""
    try:
        result = subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                                capture_output=True, text=True, timeout=4)
        if result.returncode == 0 and len(result.stdout) <= 16384:
            return [{'name': line.strip()[:160], 'source': 'system'}
                    for line in result.stdout.splitlines()[:16] if line.strip()]
    except (OSError, subprocess.TimeoutExpired):
        pass
    return []


def host_model():
    try:
        return Path('/proc/device-tree/model').read_bytes()[:160].decode('utf-8', errors='replace').replace('\0', '').strip()
    except OSError:
        return ''


def aeon_image():
    try:
        marker = Path('/etc/aeon/frostbyte-integration.json')
        info = marker.lstat()
        if marker.is_symlink() or not marker.is_file() or info.st_size > 4096 or info.st_uid != 0 or info.st_mode & 0o022:
            return ''
        value = json.loads(marker.read_text())
        return json.dumps(value) if isinstance(value, dict) else ''
    except (OSError, ValueError):
        return ''


def host_os():
    try:
        return platform.freedesktop_os_release().get('PRETTY_NAME', 'Linux')[:160]
    except (AttributeError, OSError):
        return ('Linux ' + platform.release())[:160]


def registered_roots(container, primary):
    env = environment(container) if container else {}
    try:
        roots = json.loads(env.get('FROSTBYTE_STORAGE_ROOTS', json.dumps([str(primary)])))
        identities = json.loads(env.get('FROSTBYTE_STORAGE_IDENTITIES', '[]'))
    except ValueError as error:
        raise RuntimeError('The existing storage configuration is invalid. Keep the current service and repair its settings first.') from error
    if not isinstance(roots, list) or not 1 <= len(roots) <= 16 or any(not isinstance(root, str) or not root.startswith('/') for root in roots):
        raise RuntimeError('The existing storage root list is invalid.')
    roots = list(dict.fromkeys(str(Path(root).resolve()) for root in [str(primary)] + roots))
    markers = {str(Path(item['path']).resolve()): item['marker'] for item in identities}
    return roots, markers


def storage_mounts(container, roots):
    """Preserve reviewed legacy bind aliases, never unrelated container mounts."""
    previous = container.get('Mounts', []) if container else []
    result = []
    for root in roots:
        matches = [entry for entry in previous if entry.get('Destination') == root]
        if len(matches) > 1:
            raise RuntimeError('The registered storage folder has ambiguous mounts.')
        if matches:
            entry = matches[0]
            if entry.get('Type', 'bind') != 'bind' or not isinstance(entry.get('Source'), str) or entry.get('RW') is False:
                raise RuntimeError('Registered storage requires a writable host-folder bind mount.')
            source = storage_path(entry['Source'])
        else:
            source = storage_path(root)
        if source == STATE.resolve() or STATE.resolve() in source.parents or source in STATE.resolve().parents:
            raise RuntimeError('Choose a dedicated download folder outside the companion state folder.')
        result.append({'source': str(source), 'destination': root})
    return result


def read_storage_marker(marker_file):
    """Read only the 32-hex drive marker through a held regular-file descriptor."""
    descriptor = None
    try:
        before = os.lstat(marker_file)
        if not stat_module.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size not in (32, 33):
            return None
        descriptor = os.open(marker_file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        held = os.fstat(descriptor)
        current = os.lstat(marker_file)
        if (not stat_module.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_size not in (32, 33)
                or held.st_dev != current.st_dev or held.st_ino != current.st_ino):
            return None
        value = os.read(descriptor, 34)
        if len(value) != held.st_size or not re.fullmatch(b'[a-f0-9]{32}\n?', value):
            return None
        return value[:32].decode('ascii')
    except (OSError, UnicodeError):
        return None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def storage_marker(folder, expected=None):
    marker_file = folder / '.frostbyte-storage-id'
    if expected is not None:
        if not re.fullmatch('[a-f0-9]{32}', expected) or read_storage_marker(marker_file) != expected:
            raise RuntimeError('Storage is unavailable at ' + str(folder) + '. Reconnect its drive before changing the companion.')
        return expected
    # On commonly used removable-storage paths, do not create a folder on the internal disk below an absent mount.
    if str(folder) in ('/mnt', '/media', '/run/media') or str(folder).startswith(('/mnt/', '/media/', '/run/media/')):
        ancestor = folder
        while not ancestor.exists() and ancestor != ancestor.parent:
            ancestor = ancestor.parent
        if ancestor.stat().st_dev == Path('/').stat().st_dev:
            raise RuntimeError('No drive is mounted at ' + str(folder) + '. Mount the drive on Spark, then select its folder again.')
    folder.mkdir(parents=True, exist_ok=True)
    if marker_file.is_symlink():
        raise RuntimeError('The storage identity file must not be a link.')
    if marker_file.exists():
        value = read_storage_marker(marker_file)
        if value is None:
            raise RuntimeError('The storage identity file is invalid at ' + str(folder) + '.')
        return value
    value = secrets.token_hex(16)
    descriptor = os.open(marker_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(value + '\n')
    return value


def activation_lock(wait=10):
    directory = _owned_directory_descriptor(ROOT)
    descriptor = None
    try:
        flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
        descriptor = os.open('activation.lock', flags, 0o600, dir_fd=directory)
        held = os.fstat(descriptor)
        current = os.stat('activation.lock', dir_fd=directory, follow_symlinks=False)
        if (not stat_module.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_uid != os.getuid()
                or held.st_dev != current.st_dev or held.st_ino != current.st_ino):
            raise RuntimeError('The FrostByte activation lock must be a private regular file owned by your account.')
        os.fchmod(descriptor, 0o600)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        raise RuntimeError('The FrostByte activation lock must be a private regular file owned by your account.') from error
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
        raise
    finally:
        os.close(directory)
    lock = os.fdopen(descriptor, 'r+')
    deadline = time.monotonic() + wait
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            if time.monotonic() >= deadline:
                lock.close()
                raise RuntimeError('Another FrostByte setup is activating. Wait for it to finish before retrying.')
            time.sleep(0.25)


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def cleanup_committed(stage, journal):
    try:
        if journal.get('oldId'):
            backup = inspect(journal['backupName'])
            if backup and backup['Id'] == journal['oldId']:
                run(['docker', 'rm', journal['backupName']])
    except (OSError, RuntimeError, ValueError):
        return False
    try:
        shutil.rmtree(stage)
    except OSError:
        return False
    return True


def recover_previous():
    installs = ROOT / 'install'
    if not installs.exists():
        return
    _owned_directory(installs)
    with activation_lock():
        for stage in installs.iterdir():
            try:
                _owned_directory(stage)
            except RuntimeError:
                continue
            journal_file = stage / 'activation.json'
            if journal_file.exists() or journal_file.is_symlink():
                journal = read_owned_json(journal_file)
                if journal.get('sessionId') != stage.name:
                    raise RuntimeError('A previous FrostByte activation record is invalid. Nothing was changed.')
                if journal.get('committed'):
                    cleanup_committed(stage, journal)
                    continue  # A committed, healthy service must never be rolled back by another setup.
                if alive(journal.get('ownerPid')) or (journal.get('phase') == 'awaiting-commit' and time.time() < journal.get('recoverAfter', 0)):
                    raise RuntimeError('A previous setup is finishing or recovering. Wait up to one minute, then check Spark again.')
                rollback(stage)
                shutil.rmtree(stage)
                continue
            metadata = stage_metadata(stage)
            lease = metadata.get('lease') if metadata else None
            if (metadata is None or not isinstance(lease, dict)
                    or lease.get('phase') not in ('preparing', 'prepared', 'building', 'built', 'build-failed')
                    or not lease_owner_is_gone(lease)):
                continue
            # The tag is derived again from the owned stage/session record; never
            # accept an arbitrary Docker image name from abandoned state.
            if not remove_stage_image(metadata, stage.name):
                continue  # Keep the stage so a later setup can retry image cleanup.
            shutil.rmtree(stage)


def start_watchdog(stage):
    # Its session is independent of sshd. A lost Mac connection cannot stop recovery of an uncommitted swap.
    request = dict(payload)
    request['action'] = 'watchdog'
    request.pop('archive', None)
    request_file = stage / 'watchdog.json'
    save_json(request_file, request)
    bootstrap = 'import base64,json,sys;payload=json.load(open(sys.argv[1]));exec(compile(base64.b64decode(payload["installer"]),"frostbyte-onboard.py","exec"))'
    subprocess.Popen([sys.executable, '-c', bootstrap, str(request_file)], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)


def watchdog(stage):
    journal_file = stage / 'activation.json'
    hard_deadline = time.monotonic() + 600
    while time.monotonic() < hard_deadline:
        if not journal_file.exists():
            return True
        try:
            journal = json.loads(journal_file.read_text())
        except FileNotFoundError:
            return True
        if journal.get('committed'):
            return True
        if time.time() < journal.get('recoverAfter', 0):
            time.sleep(0.5)
            continue
        try:
            lock = activation_lock()
        except RuntimeError:
            continue
        with lock:
            if not journal_file.exists():
                return True
            journal = json.loads(journal_file.read_text())
            if journal.get('committed'):
                return True
            if time.time() < journal.get('recoverAfter', 0):
                continue
            rollback(stage)
            shutil.rmtree(stage)
            return True
    raise RuntimeError('Companion recovery is waiting for another installation to release its lock.')


def prepare(manifest, session, stage, folder):
    if platform.system() != 'Linux' or platform.machine() not in ('aarch64', 'arm64', 'x86_64', 'amd64'):
        raise RuntimeError('The beta companion requires a 64-bit ARM or x64 Linux device.')
    result = run(['docker', 'info', '--format', '{{json .Architecture}}'], check=False)
    if result.returncode:
        raise RuntimeError('Docker is unavailable for this SSH user. Start Docker and give this account access, then retry. FrostByte does not use sudo.')
    if json.loads(result.stdout) not in ('aarch64', 'arm64', 'x86_64', 'amd64'):
        raise RuntimeError('Docker must run on the 64-bit ARM or x64 Linux device.')
    recover_previous()
    old = inspect(NAME)
    own_container(old)
    adding = payload.get('addStorage') is True
    if adding and not old:
        raise RuntimeError('Connect and install the device companion before adding another storage folder.')
    primary = existing_folder(old) if old else folder
    if old and primary != folder and not adding:
        raise RuntimeError('The existing companion uses ' + str(primary) + '. Choose that folder to preserve its downloads, or add a storage folder after connecting.')
    if old:
        previous_state = next((entry.get('Source') for entry in old.get('Mounts', []) if entry.get('Destination') == '/state'), None)
        if previous_state is None or Path(previous_state).resolve() != STATE.resolve():
            raise RuntimeError('The existing companion has a different state folder. Keep its current installation or migrate it before updating.')
    roots, markers = registered_roots(old, primary)
    if str(folder) not in roots:
        roots.append(str(folder))
    if len(roots) > 16:
        raise RuntimeError('A companion can have up to 16 storage folders.')
    ROOT.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(mode=0o700, exist_ok=True)
    if STATE.is_symlink() or STATE.stat().st_uid != os.getuid():
        raise RuntimeError('The companion state folder must be owned by your SSH account and must not be a link.')
    identities = []
    storage_binds = storage_mounts(old, roots)
    for binding in storage_binds:
        root, root_path = binding['destination'], Path(binding['source'])
        marker = storage_marker(root_path, markers.get(root))
        with tempfile.TemporaryFile(dir=root_path) as writable:
            writable.write(b'FrostByte folder check')
            writable.flush()
        identities.append({'path': root, 'marker': marker})
    installs = ROOT / 'install'
    installs.mkdir(mode=0o700, exist_ok=True)
    _owned_directory(installs)
    stage.mkdir(mode=0o700, exist_ok=False)
    image = expected_stage_image(manifest['version'], session)
    metadata = {'owner': LABEL, 'sessionId': session, 'version': manifest['version'],
                'image': image, 'lease': stage_lease('preparing')}
    save_json(stage / 'stage.json', metadata)
    data = base64.b64decode(payload['archive'], validate=True)
    if len(data) != manifest['bytes'] or len(data) > 8 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != manifest['sha256']:
        raise RuntimeError('The companion upload failed its integrity check.')
    archive = stage / 'source.tar.gz'
    archive.write_bytes(data)
    source = stage / 'source'
    source.mkdir()
    allowed = {'src/main/ipfs.js', 'src/main/ipfs-runtime.js', 'src/main/aeon-device.js', 'src/shared/ipfs-source.js', 'src/shared/aeon.js', 'build/ipfs-runtime.json', 'scripts/build-ipfs-runtime.js', 'package.json', 'package-lock.json', 'src/main/torrent.js', 'src/main/safe-torrent-store.js', 'src/main/torrent-descriptor-budget.js',
               'src/main/portable-path.js', 'src/main/hf.js', 'src/main/hf-authorizations.js', 'src/main/hf-hybrid.js', 'src/main/store.js', 'src/main/publisher-record.js',
               'src/shared/content-kind.js', 'src/shared/appearance.js', 'src/shared/edition.js', 'src/shared/companion-protocol.js', 'src/shared/device-models.js', 'src/main/device-info.js', 'src/agent/server.js', 'src/agent/test-mode.js', 'src/agent/client.js', 'build/spark.Dockerfile', 'build/mac-node-runtime.json',
               'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'LICENSES.third-party.txt'}
    allowed.update({'src/main/inventory.js', 'src/shared/inventory-proof.js', 'src/shared/edition-manifest.cjs', 'src/main/aeon-origin-check.js', 'src/main/integrity-service.js', 'src/main/format-safety.js', 'src/main/file-hash.js', 'src/main/upstream-verify.js', 'src/shared/format-hints.js', 'src/shared/aeon-origin.js', 'src/shared/aeon-origin-status.js', 'src/main/assistant-runtimes.js', 'src/main/assistant-chat.js', 'src/agent/assistant.js'})
    with tarfile.open(archive, 'r:gz') as stream:
        members = stream.getmembers()
        if {member.name for member in members} != allowed or any(not member.isfile() for member in members):
            raise RuntimeError('The companion archive contains unexpected files.')
        if sum(member.size for member in members) > 20 * 1024 * 1024:
            raise RuntimeError('The companion archive is too large.')
        for member in members:
            target = source / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with stream.extractfile(member) as incoming, target.open('wb') as output:
                shutil.copyfileobj(incoming, output)
    package = json.loads((source / 'package.json').read_text())
    if package.get('version') != manifest['version']:
        raise RuntimeError('The companion package version does not match its manifest.')
    save_json(stage / 'install.json', {'version': manifest['version'], 'requestedDir': str(folder), 'downloadDir': str(primary),
              'storageRoots': roots, 'storageIdentities': identities, 'storageMounts': storage_binds,
              'oldId': old['Id'] if old else None, 'image': image, 'sessionId': session})
    mark_stage(stage, 'prepared')
    return {'downloadDir': str(primary), 'storageRoots': roots, 'updating': old is not None}


def installation(stage, manifest, folder):
    if stage.is_symlink():
        raise RuntimeError('Invalid installation staging folder.')
    metadata = stage_metadata(stage)
    config = read_owned_json(stage / 'install.json')
    expected = expected_stage_image(manifest['version'], stage.name)
    if (metadata is None or config.get('sessionId') != stage.name or config.get('image') != expected
            or metadata.get('image') != expected or config.get('version') != manifest['version']
            or config.get('requestedDir') != str(folder)):
        raise RuntimeError('Installation settings changed. Start setup again.')
    return config


def restore_state(stage):
    backup = stage / 'state-backup'
    if not backup.exists():
        return
    # Both containers are stopped. Restore every previous state file, leaving downloaded data untouched.
    for entry in STATE.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink(missing_ok=True)
    shutil.copytree(backup, STATE, dirs_exist_ok=True, symlinks=True)


def rollback(stage):
    journal_file = stage / 'activation.json'
    if not journal_file.exists():
        return
    journal = json.loads(journal_file.read_text())
    if journal.get('committed'):
        return
    new = inspect(NAME)
    old = inspect(journal['backupName']) if journal.get('oldId') else None
    if journal.get('oldId') and not old and (not new or new['Id'] != journal['oldId']):
        raise RuntimeError('The previous companion backup is unavailable. The current service has been kept running.')
    if new and new['Id'] != journal.get('oldId'):
        own_container(new)
        if (new.get('Config', {}).get('Labels') or {}).get('ai.blackfrost.frostbyte.install') != journal['sessionId']:
            raise RuntimeError('Another installation changed the companion. The saved service is still available as ' + journal['backupName'] + '.')
        run(['docker', 'stop', '--time', '40', NAME], timeout=55, check=False)
        run(['docker', 'rm', NAME])
    if old:
        own_container(old)
        if old['Id'] != journal.get('oldId'):
            raise RuntimeError('The saved companion changed. Recovery stopped to preserve both services.')
        restore_state(stage)
        run(['docker', 'rename', journal['backupName'], NAME])
        if journal['oldRunning']:
            run(['docker', 'start', NAME])
    elif new and new['Id'] == journal.get('oldId') and journal['oldRunning'] and not new['State']['Running']:
        run(['docker', 'start', NAME])
    elif not journal.get('oldId'):
        restore_state(stage)
    journal_file.unlink()


def activate(stage, config, manifest, folder, session):
    old = inspect(NAME)
    own_container(old)
    if (old['Id'] if old else None) != config['oldId']:
        raise RuntimeError('The companion changed during setup. Start again.')
    primary = Path(config['downloadDir'])
    if old and existing_folder(old) != primary:
        raise RuntimeError('The existing download folder changed during setup. Start again.')
    bindings = storage_mounts(old, config['storageRoots'])
    if bindings != config['storageMounts']:
        raise RuntimeError('The storage mount mapping changed during setup. Start again.')
    for identity in config['storageIdentities']:
        binding = next(item for item in bindings if item['destination'] == identity['path'])
        storage_marker(Path(binding['source']), identity['marker'])
    journal = {'sessionId': session, 'oldId': old['Id'] if old else None,
               'oldRunning': bool(old and old['State']['Running']), 'backupName': NAME + '-previous-' + session.lower(),
               'ownerPid': os.getpid(), 'phase': 'activating', 'recoverAfter': time.time() + 300}
    save_json(stage / 'activation.json', journal)
    try:
        start_watchdog(stage)
        if old:
            if old['State']['Running']:
                run(['docker', 'stop', '--time', '40', NAME], timeout=55)
            run(['docker', 'rename', NAME, journal['backupName']])
        shutil.copytree(STATE, stage / 'state-backup-pending', symlinks=True, ignore=shutil.ignore_patterns('control.sock'))
        (stage / 'state-backup-pending').rename(stage / 'state-backup')
        mounts = []
        mounted = set()
        # Reconstruct the writable surface from reviewed durable configuration.
        # A labeled but altered old container must not carry an unrelated bind,
        # volume, or tmpfs mount into the hardened replacement.
        for source, destination in [(str(STATE), '/state')] + [(item['source'], item['destination']) for item in bindings]:
            if destination not in mounted:
                mounts += ['--mount', mount(source, destination)]
                mounted.add(destination)
        run(['docker', 'run', '-d', '--name', NAME, '--label', LABEL + '=agent',
             '--label', 'ai.blackfrost.frostbyte.install=' + session, '--label', 'ai.blackfrost.frostbyte.version=' + manifest['version'],
             '--init', '--restart', 'unless-stopped', '--network', 'host', '--user', str(os.getuid()) + ':' + str(os.getgid()),
             '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864', '--cap-drop', 'ALL',
             '--security-opt', 'no-new-privileges:true', '--pids-limit', '256',
             *mounts, '--env', 'FROSTBYTE_AGENT_HOME=/state', '--env', 'FROSTBYTE_DOWNLOAD_DIR=' + str(primary),
             '--env', 'FROSTBYTE_STORAGE_ROOTS=' + json.dumps(config['storageRoots']),
             '--env', 'FROSTBYTE_STORAGE_IDENTITIES=' + json.dumps(config['storageIdentities']),
             '--env', 'FROSTBYTE_DEVICE=' + socket.gethostname(), '--env', 'FROSTBYTE_HOST_OS=' + host_os(),
             '--env', 'FROSTBYTE_HOST_MODEL=' + host_model(), '--env', 'FROSTBYTE_AEON_IMAGE=' + aeon_image(),
             '--env', 'FROSTBYTE_HOST_GPUS=' + json.dumps(host_gpus()), config['image']], timeout=60)
        deadline = time.monotonic() + 75
        status = None
        last_error = ''
        while time.monotonic() < deadline:
            result = run(['docker', 'exec', '-i', NAME, 'node', '/app/src/agent/client.js'], input='{"action":"status"}\n', timeout=10, check=False)
            try:
                response = json.loads(result.stdout)
                candidate = response['data'] if response.get('ok') else None
                roots_ready = candidate and set(candidate.get('storageRoots', [])) == set(config['storageRoots']) and all(
                    any(entry.get('path') == root and entry.get('available') for entry in candidate.get('storage', [])) for root in config['storageRoots'])
                if candidate and candidate.get('version') == manifest['version'] and candidate.get('downloadDir') == str(primary) and roots_ready:
                    status = candidate
                    break
                last_error = 'The companion returned an unexpected version, or a registered storage folder is unavailable.'
            except (ValueError, KeyError):
                last_error = (result.stderr or '').strip()[-500:]
            time.sleep(1)
        if status is None:
            raise RuntimeError('The companion did not become ready. ' + last_error)
        journal['phase'] = 'awaiting-commit'
        journal['recoverAfter'] = time.time() + 45
        save_json(stage / 'activation.json', journal)
        return {'status': status}
    except BaseException as error:
        try:
            rollback(stage)
        except BaseException as rollback_error:
            raise RuntimeError(str(error) + ' Recovery also failed: ' + str(rollback_error)) from error
        raise


def main():
    manifest, session, stage, folder = configuration()
    action = payload['action']
    if action == 'prepare':
        return prepare(manifest, session, stage, folder)
    if action == 'cleanup':
        if not stage.exists():
            return True
        if not (stage / 'install.json').exists() and not stage.is_symlink() and stage.stat().st_uid == os.getuid():
            shutil.rmtree(stage)
            return True
    config = installation(stage, manifest, folder)
    if action == 'watchdog':
        return watchdog(stage)
    if action == 'build':
        with activation_lock():
            mark_stage(stage, 'building')
        # Docker output is inherited on stderr by redirecting stdout below, keeping the JSON response distinct.
        try:
            result = subprocess.run(['docker', 'build', '--platform', 'linux/arm64' if platform.machine() in ('arm64', 'aarch64') else 'linux/amd64', '-f', str(stage / 'source/build/spark.Dockerfile'),
                                     '-t', config['image'], str(stage / 'source')], stdout=__import__('sys').stderr,
                                    stderr=__import__('sys').stderr, timeout=1200)
            if result.returncode:
                raise RuntimeError('The companion build failed. Your existing companion is unchanged. Check Docker and internet access, then retry.')
        except BaseException:
            with activation_lock():
                mark_stage(stage, 'build-failed')
            raise
        with activation_lock():
            mark_stage(stage, 'built')
        return True
    # Serialize service replacement and recovery; concurrent builds may run without stopping the service.
    with activation_lock():
        if action == 'activate':
            return activate(stage, config, manifest, folder, session)
        if action == 'rollback' or action == 'cleanup':
            rollback(stage)
            if action == 'cleanup':
                metadata = stage_metadata(stage)
                if not remove_stage_image(metadata, session):
                    raise RuntimeError('Docker could not remove the staged companion image. Its private staging record was kept for a later cleanup retry.')
                shutil.rmtree(stage)
            return True
        if action == 'finalize':
            journal = json.loads((stage / 'activation.json').read_text())
            current = inspect(NAME)
            if not current or (current.get('Config', {}).get('Labels') or {}).get('ai.blackfrost.frostbyte.install') != session:
                raise RuntimeError('The companion changed before setup finished.')
            journal['committed'] = True
            save_json(stage / 'activation.json', journal)
            cleanup_committed(stage, journal)  # Housekeeping cannot turn a healthy committed service into a failed setup.
            return True
        raise RuntimeError('Unknown installation step.')


def interrupted(signum, frame):
    raise RuntimeError('Spark setup connection was interrupted; restoring the previous companion.')


if payload.get('action') != 'watchdog':
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)

try:
    result = main()
    print(json.dumps({'ok': True, 'data': result}), flush=True)
except BaseException as error:
    print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
    raise SystemExit(1)
