#!/usr/bin/env python3
"""Install or uninstall frostbyte-hostd as the current user's service.

No administrator access is used. Linux installs a systemd user unit; macOS
installs a LaunchAgent. Token, recipes and receipts survive uninstall.
"""

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import secrets
import shutil
import subprocess
import sys


SERVICE_NAME = 'frostbyte-hostd'
LAUNCHD_LABEL = 'com.frostbyte.hostd'
WORKSPACE_ID = re.compile(r'[a-z0-9][a-z0-9._-]{0,63}')


def layout(system=None, home=None):
    system = (system or platform.system()).lower()
    explicit_home = home is not None
    home = Path(home or Path.home()).expanduser().resolve()
    if system == 'linux':
        config_base = home / '.config' if explicit_home else Path(os.environ.get('XDG_CONFIG_HOME', home / '.config'))
        state_base = home / '.local/state' if explicit_home else Path(os.environ.get('XDG_STATE_HOME', home / '.local/state'))
        config = config_base / 'frostbyte' / 'hostd'
        state = state_base / 'frostbyte' / 'hostd'
        code = home / '.local/lib/frostbyte-hostd'
        unit = config_base / 'systemd/user/frostbyte-hostd.service'
        kind = 'linux'
    elif system in ('darwin', 'macos'):
        config = home / 'Library/Application Support/FrostByte/hostd'
        state = config / 'state'
        code = config / 'bin'
        unit = home / 'Library/LaunchAgents/com.frostbyte.hostd.plist'
        kind = 'darwin'
    else:
        raise ValueError('frostbyte-hostd user installation supports Linux and macOS.')
    return {'system': kind, 'home': home, 'config': config, 'state': state,
            'code': code, 'unit': unit, 'daemon': code / 'frostbyte_hostd.py',
            'token': config / 'token', 'recipes': config / 'recipes.json',
            'manifest': config / 'install.json', 'receipts': state / 'receipts.jsonl'}


def quote_systemd(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def service_argv(paths, python, *, port, endpoint_port, bind_lan, spark_profile, workspaces):
    argv = [python, str(paths['daemon']), '--port', str(port),
            '--endpoint-port', str(endpoint_port), '--token-file', str(paths['token']),
            '--recipes', str(paths['recipes']), '--state-dir', str(paths['state']),
            '--receipts', str(paths['receipts'])]
    if bind_lan:
        argv.append('--bind-lan')
    if spark_profile:
        argv.append('--spark-profile')
    for workspace in workspaces:
        argv += ['--workspace', workspace]
    return argv


def render_systemd(argv, environment_path):
    command = ' '.join(quote_systemd(value) for value in argv)
    path = str(environment_path).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
    return f'''[Unit]
Description=Private FrostByte host-management sidecar
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart={command}
Environment="PATH={path}"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
'''


def render_launchd(argv, paths, environment_path):
    document = {
        'Label': LAUNCHD_LABEL,
        'ProgramArguments': [str(value) for value in argv],
        'EnvironmentVariables': {'PATH': str(environment_path)},
        'RunAtLoad': True,
        'KeepAlive': {'SuccessfulExit': False},
        'ThrottleInterval': 5,
        'ProcessType': 'Interactive',
        'StandardOutPath': str(paths['state'] / 'hostd.log'),
        'StandardErrorPath': str(paths['state'] / 'hostd.err.log'),
    }
    return plistlib.dumps(document, fmt=plistlib.FMT_XML, sort_keys=True)


def parse_workspaces(values):
    roots = {}
    normalized = []
    for raw in values or []:
        if not isinstance(raw, str) or not raw or any(char in raw for char in ('\x00', '\n', '\r')):
            raise ValueError('Workspace values must be non-empty single-line strings.')
        root_id, location = 'default', raw
        if '=' in raw:
            candidate, remainder = raw.split('=', 1)
            if WORKSPACE_ID.fullmatch(candidate):
                root_id, location = candidate, remainder
        if root_id in roots:
            raise ValueError(f'Duplicate workspace id: {root_id}.')
        root = Path(location).expanduser().resolve()
        if not root.is_dir():
            raise ValueError(f'Workspace root is not a directory: {location}.')
        if root in roots.values():
            raise ValueError(f'Workspace root is configured more than once: {root}.')
        roots[root_id] = root
        normalized.append(f'{root_id}={root}')
    return normalized


def atomic_write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.tmp-{os.getpid()}')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(temporary, flags, mode)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data if isinstance(data, bytes) else data.encode('utf-8'))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def secure_regular(path, mode):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Refusing non-regular or symlinked file: {path}.')
    os.chmod(path, mode)


def read_secure_token(path):
    secure_regular(path, 0o600)
    raw = path.read_text(encoding='utf-8')
    token = raw.strip()
    if raw not in (token, token + '\n') or not (32 <= len(token.encode('utf-8')) <= 4096):
        raise ValueError('Existing token is malformed; use --rotate-token to replace it.')
    if any(ord(char) < 0x21 or ord(char) > 0x7e for char in token):
        raise ValueError('Existing token must contain visible ASCII only; rotate it.')
    return token


def command(argv, *, check=True, quiet=False):
    return subprocess.run(argv, check=check, text=True,
                          stdout=subprocess.DEVNULL if quiet else None,
                          stderr=subprocess.DEVNULL if quiet else None)


def stop_service(paths):
    if paths['system'] == 'linux':
        command(['systemctl', '--user', 'disable', '--now', 'frostbyte-hostd.service'],
                check=False, quiet=True)
        command(['systemctl', '--user', 'daemon-reload'], check=False, quiet=True)
    else:
        domain = f'gui/{os.getuid()}'
        command(['launchctl', 'bootout', domain, str(paths['unit'])], check=False, quiet=True)


def start_service(paths):
    if paths['system'] == 'linux':
        command(['systemctl', '--user', 'daemon-reload'])
        command(['systemctl', '--user', 'enable', '--now', 'frostbyte-hostd.service'])
        command(['systemctl', '--user', 'restart', 'frostbyte-hostd.service'])
    else:
        domain = f'gui/{os.getuid()}'
        command(['launchctl', 'bootout', domain, str(paths['unit'])], check=False, quiet=True)
        command(['launchctl', 'bootstrap', domain, str(paths['unit'])])
        command(['launchctl', 'kickstart', '-k', f'{domain}/{LAUNCHD_LABEL}'])


def install(args):
    if hasattr(os, 'geteuid') and os.geteuid() == 0:
        raise ValueError('Run this installer as the target user, without sudo.')
    paths = layout(args.system, args.home)
    source_dir = Path(__file__).resolve().parent
    daemon_source = source_dir / 'frostbyte_hostd.py'
    recipes_source = source_dir / 'recipes.example.json'
    python = shutil.which('python3')
    if python is None:
        raise ValueError('python3 is required.')
    if sys.version_info < (3, 10):
        raise ValueError('Python 3.10 or newer is required.')
    previous = {}
    if paths['manifest'].exists() or paths['manifest'].is_symlink():
        if paths['manifest'].is_symlink() or not paths['manifest'].is_file():
            raise ValueError('Refusing non-regular or symlinked installation manifest.')
        try:
            previous = json.loads(paths['manifest'].read_text(encoding='utf-8'))
            if not isinstance(previous, dict):
                raise ValueError('The installation manifest must be an object.')
        except (OSError, ValueError, TypeError) as error:
            raise ValueError('Cannot read the existing installation permissions; preserve and repair its manifest before reinstalling.') from error
    workspace_values = args.workspace
    if workspace_values is None:
        workspace_values = previous.get('workspaces', [])
    # A routine upgrade must not widen a restricted companion into the full
    # host-management service merely because --spark-profile was omitted.
    spark_profile = getattr(args, 'spark_profile', None)
    if spark_profile is None:
        spark_profile = previous.get('sparkProfile', False)
    if not isinstance(spark_profile, bool):
        raise ValueError('The saved Spark profile permission must be true or false.')
    if getattr(args, 'clear_workspaces', False):
        workspace_values = []
    workspaces = parse_workspaces(workspace_values)
    manifest = {'schema': 1, 'service': SERVICE_NAME, 'port': args.port,
                'endpointPort': args.endpoint_port, 'bindLan': bool(args.bind_lan),
                'sparkProfile': spark_profile,
                'workspaces': workspaces, 'system': paths['system']}
    argv = service_argv(paths, python, port=args.port, endpoint_port=args.endpoint_port,
                        bind_lan=args.bind_lan, spark_profile=spark_profile, workspaces=workspaces)
    unit = (render_systemd(argv, os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'))
            if paths['system'] == 'linux'
            else render_launchd(argv, paths, os.environ.get('PATH', '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')))

    print(f'Install {SERVICE_NAME} for {paths["system"]}:')
    print(f'  daemon: {paths["daemon"]}')
    print(f'  service: {paths["unit"]}')
    print(f'  bind: {"0.0.0.0" if args.bind_lan else "127.0.0.1"}:{args.port}')
    print(f'  profile: {"spark" if spark_profile else "full"}')
    for workspace in workspaces:
        print(f'  workspace: {workspace}')
    if args.dry_run:
        return 0

    for directory in (paths['config'], paths['state'], paths['code'], paths['unit'].parent):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError(f'Refusing non-directory or symlinked install path: {directory}.')
        directory.mkdir(parents=True, exist_ok=True)
    os.chmod(paths['config'], 0o700)
    os.chmod(paths['state'], 0o700)
    atomic_write(paths['daemon'], daemon_source.read_bytes(), 0o700)
    if not paths['recipes'].exists():
        atomic_write(paths['recipes'], recipes_source.read_bytes(), 0o600)
    else:
        secure_regular(paths['recipes'], 0o600)
    if args.rotate_token or not paths['token'].exists():
        atomic_write(paths['token'], secrets.token_hex(32) + '\n', 0o600)
    else:
        secure_regular(paths['token'], 0o600)
    token = read_secure_token(paths['token'])
    atomic_write(paths['manifest'], json.dumps(manifest, indent=2) + '\n', 0o600)
    atomic_write(paths['unit'], unit, 0o600 if paths['system'] == 'darwin' else 0o644)
    if not args.no_start:
        start_service(paths)
    fingerprint = hashlib.sha256(token.encode('utf-8')).hexdigest()[:12]
    print(f'Installed. Token fingerprint: {fingerprint}')
    if args.bind_lan:
        print('LAN mode uses plain HTTP. Restrict port access to a trusted segment or tunnel it.')
    return 0


def uninstall(args):
    if hasattr(os, 'geteuid') and os.geteuid() == 0:
        raise ValueError('Run this uninstaller as the service user, without sudo.')
    paths = layout(args.system, args.home)
    print(f'Uninstall {SERVICE_NAME}; preserve token, recipes, receipts and workspaces.')
    if args.dry_run:
        return 0
    stop_service(paths)
    paths['unit'].unlink(missing_ok=True)
    paths['daemon'].unlink(missing_ok=True)
    with contextlib.suppress(OSError):
        paths['code'].rmdir()
    if paths['system'] == 'linux':
        command(['systemctl', '--user', 'daemon-reload'], check=False, quiet=True)
    print(f'Removed service files. Preserved state at {paths["config"]} and {paths["state"]}.')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description='Install frostbyte-hostd as a non-root user service')
    parser.add_argument('action', choices=('install', 'uninstall'))
    parser.add_argument('--bind-lan', action='store_true', help='explicitly listen on 0.0.0.0')
    parser.add_argument('--spark-profile', action='store_true', default=None,
                        help='restrict routes to Spark device management (preserved on upgrades)')
    parser.add_argument('--port', type=int, default=8757)
    parser.add_argument('--endpoint-port', type=int, default=30000)
    parser.add_argument('--workspace', action='append', default=None, metavar='[ID=]PATH')
    parser.add_argument('--clear-workspaces', action='store_true',
                        help='remove previously installed workspace roots')
    parser.add_argument('--rotate-token', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-start', action='store_true', help='write files without loading the service')
    parser.add_argument('--home', help=argparse.SUPPRESS)
    parser.add_argument('--system', choices=('linux', 'darwin'), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.workspace and args.clear_workspaces:
        parser.error('--workspace and --clear-workspaces cannot be combined')
    if not 1 <= args.port <= 65535 or not 1 <= args.endpoint_port <= 65535:
        parser.error('ports must be between 1 and 65535')
    try:
        return install(args) if args.action == 'install' else uninstall(args)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'{SERVICE_NAME}: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
