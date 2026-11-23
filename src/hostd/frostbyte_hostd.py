#!/usr/bin/env python3
"""frostbyte-hostd — private FrostByte host-management sidecar.

Adapted from the secured Frigid daemon 0.8.1. Stdlib-only (Python 3.10+).
Read-only by default: telemetry streaming (SSE 1 Hz), schema-1 snapshots, and
explicitly confirmed mutations only (recipes, power, workspace, git and PTY).
The inference proxy has a fixed loopback upstream and cannot fetch arbitrary
URLs. The HTTP listener is loopback-only unless --bind-lan is supplied.

Run: python3 frostbyte_hostd.py --port 8757
LAN: python3 frostbyte_hostd.py --bind-lan --port 8757
Debug: python3 frostbyte_hostd.py --once
"""
import argparse
import base64
import contextlib
import csv
import fcntl
import functools
import hashlib
import hmac
import http.client
import http.server
import io
import json
import os
from pathlib import Path
import platform
import pty
import pwd
import re
import secrets
import shlex
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.parse

DAEMON_NAME = 'frostbyte-hostd'
DAEMON_VERSION = '0.1.1'
FRIGID_COMPAT_VERSION = '0.8.1'
SCHEMA = 1
# Loopback by default: the bearer token crosses the wire in every request and
# the transport is plain HTTP, so exposure beyond the host is an explicit
# operator choice (the installer or CLI must receive --bind-lan).
DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 8757
ENDPOINT_PORT = 30000
PROC = Path('/proc')
BODY_LIMIT = 65536
INFERENCE_BODY_LIMIT = 4 * 1024 * 1024
INFERENCE_RESPONSE_LIMIT = 8 * 1024 * 1024
INFERENCE_STREAM_LIMIT = 64 * 1024 * 1024
POWER_DELAY_SEC = 2.0
MAX_STREAM_CLIENTS = 4
MAX_WATCH_CLIENTS = 8
MAX_INFERENCE_CLIENTS = 4
# /v1/fs/write carries base64 (4/3 overhead) of an 8 MB file.
FS_WRITE_BODY_LIMIT = 12 * 1024 * 1024
# Minimal environment for operator-facing shells (exec + PTY). The daemon's own
# environment never crosses into them: a secret exported to the daemon must not
# become readable from a terminal or an exec'd build step.
SHELL_ENV_KEYS = ('PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL')

def shell_env(cwd):
    return {key: os.environ[key] for key in SHELL_ENV_KEYS if key in os.environ}

POWER_PHRASES = {'shutdown': 'SHUTDOWN', 'reboot': 'REBOOT'}
POWER_VERBS = {'shutdown': 'poweroff', 'reboot': 'reboot'}
DOCKER_FORMAT = ('{"id":{{json .Id}},"name":{{json .Name}},"state":{{json .State.Status}},'
                 '"devices":{{json .HostConfig.DeviceRequests}},"runtime":{{json .HostConfig.Runtime}},'
                 '"ports":{{json .HostConfig.PortBindings}}}')
RE_PUBKEY = re.compile(r'[a-fA-F0-9]{64}')
RE_ID = re.compile(r'[a-z0-9-]{1,64}')
RE_SESSION = re.compile(r'[A-Za-z0-9._-]{1,64}')
RE_CONTAINER = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
RE_MODEL_FOLDER = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,127}')
RE_HOSTNAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}')
RE_WORKSPACE_ID = re.compile(r'[a-z0-9][a-z0-9._-]{0,63}')
LOCK_BUSY_MESSAGE = 'Another FrostByte host control request is active. Refresh before trying again.'


# ---------------------------------------------------------------------------
# Runner seam: every subprocess goes through run() so tests inject fakes.
# ---------------------------------------------------------------------------

def run(argv, timeout=8, runner=subprocess.run):
    result = runner(argv, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{argv[0]} command failed or is unavailable.')
    return result.stdout


def run_rc(argv, timeout=8, runner=subprocess.run):
    """Like run() but returns (returncode, stdout) without raising."""
    try:
        result = runner(argv, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout
    except Exception:
        return 1, ''


def number(value):
    try:
        result = float(value)
        return result if result == result and abs(result) != float('inf') else None
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Pure /proc parsers (parity with collector.py; injectable proc_root).
# ---------------------------------------------------------------------------

def cpu_times(text):
    values = [int(v) for v in text.splitlines()[0].split()[1:9]]
    return sum(values), values[3] + values[4]


def cpu_percent(a, b):
    delta = b[0] - a[0]
    return 100 * (1 - (b[1] - a[1]) / delta) if delta else None


def memory(text):
    fields = {line.split(':')[0]: int(line.split()[1]) * 1024
              for line in text.splitlines() if ':' in line}
    return {'total': fields['MemTotal'], 'available': fields['MemAvailable'],
            'swapUsed': fields['SwapTotal'] - fields['SwapFree']}


def uptime_seconds(text):
    return float(text.split()[0])


def netdev_totals(text):
    """Sum rx/tx bytes over all interfaces except lo. Returns (rx, tx)."""
    rx = tx = 0
    for line in text.splitlines()[2:]:
        if ':' not in line:
            continue
        name, rest = line.split(':', 1)
        if name.strip() == 'lo':
            continue
        parts = rest.split()
        if len(parts) < 9:
            continue
        rx += int(parts[0])
        tx += int(parts[8])
    return rx, tx


def netdev_rates(prev, cur, dt):
    if prev is None or dt <= 0:
        return None, None
    return max(0.0, (cur[0] - prev[0]) / dt), max(0.0, (cur[1] - prev[1]) / dt)


def read_proc(proc_root, name):
    return (proc_root / name).read_text()


# ---------------------------------------------------------------------------
# Endpoint health (parity with collector.py; shorter timeout for the sampler).
# ---------------------------------------------------------------------------

def endpoint_health(port=ENDPOINT_PORT, timeout=2.0):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    try:
        connection.request('GET', '/health')
        code = connection.getresponse().status
        state = 'ready' if code == 200 else ('auth-required' if code in (401, 403) else 'not-ready')
        return {'port': port, 'state': state, 'detail': f'GET /health → HTTP {code}. Generation not tested.'}
    except Exception:
        return {'port': port, 'state': 'unreachable',
                'detail': 'No health response. Model may be stopped, loading, or unavailable.'}
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# Model library records (parity with collector.py).
# ---------------------------------------------------------------------------

def read_json(path, limit=16 * 1024 * 1024):
    if path.stat().st_size > limit:
        raise ValueError('metadata too large')
    return json.loads(path.read_text())


def model_record(path):
    record = {'name': path.name, 'bytes': 0, 'shards': 0, 'status': 'No index', 'architecture': 'Unknown'}
    config = path / 'config.json'
    if config.is_file():
        cfg = read_json(config)
        arch = cfg.get('architectures') or []
        record['architecture'] = str(arch[0]) if arch else str(cfg.get('model_type', 'Unknown'))
    files = [p for p in path.iterdir() if p.is_file() and p.suffix == '.safetensors']
    record['shards'] = len(files)
    record['bytes'] = sum(p.stat().st_size for p in files)
    index = path / 'model.safetensors.index.json'
    if index.is_file():
        idx = read_json(index, limit=64 * 1024 * 1024)
        names = set(idx.get('weight_map', {}).values())
        # Never follow untrusted index paths outside the chosen model directory.
        if not names or any(not isinstance(n, str) or Path(n).name != n or n in ('.', '..') for n in names):
            record['status'] = 'Invalid index'
        elif any(not (path / n).is_file() or (path / n).stat().st_size == 0 for n in names):
            record['status'] = 'Missing shards'
        elif not config.is_file() or not (path / 'tokenizer_config.json').is_file():
            record['status'] = 'Missing metadata'
        else:
            record['status'] = 'Indexed · not hash-verified'
    return record


# ---------------------------------------------------------------------------
# Full snapshot — schema 1, byte-compatible with collector.py.
# ---------------------------------------------------------------------------

def collect(proc_root=PROC, runner=subprocess.run, home=None, endpoint_port=ENDPOINT_PORT):
    warnings = []
    home = Path(home) if home else Path.home()
    try:
        a = cpu_times(read_proc(proc_root, 'stat'))
        time.sleep(0.2)
        b = cpu_times(read_proc(proc_root, 'stat'))
        cpu = cpu_percent(a, b)
    except Exception:
        cpu = None
        warnings.append('CPU telemetry unavailable (/proc/stat). No values have been substituted.')
    gpu = {'name': 'Unavailable', 'temperature': None, 'utilization': None, 'power': None}
    try:
        raw = run(['nvidia-smi', '--query-gpu=name,temperature.gpu,utilization.gpu,power.draw',
                   '--format=csv,noheader,nounits'], timeout=5, runner=runner)
        row = next(csv.reader(io.StringIO(raw)))
        gpu = dict(zip(('name', 'temperature', 'utilization', 'power'), [row[0].strip(), *map(number, row[1:4])]))
    except Exception:
        warnings.append('GPU telemetry unavailable. No values have been substituted.')
    containers = []
    try:
        raw = run(['docker', 'ps', '-a', '--no-trunc', '--format', '{{json .}}'], timeout=5, runner=runner)
        for line in raw.splitlines()[:200]:
            obj = json.loads(line)
            containers.append({'id': obj['ID'], 'name': obj['Names'], 'image': obj['Image'],
                               'state': obj['State'], 'status': obj['Status']})
    except Exception:
        warnings.append('Docker inventory unavailable. Check Docker group access.')
    root = home / 'model-lab/models'
    models = []
    if root.is_dir():
        for path in sorted(root.iterdir())[:100]:
            if path.is_dir() and not path.is_symlink():
                try:
                    models.append(model_record(path))
                except Exception:
                    models.append({'name': path.name, 'bytes': 0, 'shards': 0,
                                   'status': 'Unreadable metadata', 'architecture': 'Unknown'})
    else:
        warnings.append('Model library not found at ~/model-lab/models.')
    try:
        mem = memory(read_proc(proc_root, 'meminfo'))
    except Exception:
        mem = None
        warnings.append('Memory telemetry unavailable (/proc/meminfo). No values have been substituted.')
    try:
        uptime = uptime_seconds(read_proc(proc_root, 'uptime'))
    except Exception:
        uptime = None
        warnings.append('Uptime unavailable (/proc/uptime).')
    try:
        disk = shutil.disk_usage(home)
        disk_dict = {'total': disk.total, 'available': disk.free}
    except Exception:
        disk_dict = {'total': 0, 'available': 0}
        warnings.append('Disk usage unavailable for the home directory.')
    return {'schema': SCHEMA, 'host': socket.gethostname(), 'timestamp': time.time(),
            'uptime': uptime, 'cpu': cpu, 'memory': mem, 'gpu': gpu,
            'disk': disk_dict, 'containers': containers, 'models': models,
            'warnings': warnings, 'endpoint': endpoint_health(endpoint_port)}


# ---------------------------------------------------------------------------
# Recipes (~/.frostbyte/hostd/recipes.json) — validated on load and mtime change.
# ---------------------------------------------------------------------------

def validate_recipes(doc):
    """Returns (recipes, warnings). Raises ValueError on structural problems."""
    if not isinstance(doc, dict) or doc.get('schema') != SCHEMA:
        raise ValueError('recipes.json must be an object with schema 1.')
    items = doc.get('recipes')
    if not isinstance(items, list):
        raise ValueError('recipes.json must contain a recipes list.')
    recipes, warnings, seen = [], [], set()
    for entry in items:
        try:
            recipe = _validate_recipe(entry)
        except ValueError as error:
            warnings.append(f'Recipe {entry.get("id", "?") if isinstance(entry, dict) else "?"} rejected: {error}')
            continue
        if recipe['id'] in seen:
            warnings.append(f'Recipe {recipe["id"]} rejected: duplicate id.')
            continue
        seen.add(recipe['id'])
        recipes.append(recipe)
    return recipes, warnings


def _validate_recipe_v2(entry):
    """Hub recipe v2 — additive over v1: publisher, engine, compose/native, imageDigest.
    Accepted alongside v1; v1 fields remain required for v1 recipes. v2-only keys
    (engine, publisher, imageDigest, composeFile) are validated when present and
    ignored when absent, so old recipes keep working without migration.
    """
    rid = entry.get('id')
    if not isinstance(rid, str) or not RE_ID.fullmatch(rid):
        raise ValueError('id must match [a-z0-9-]{1,64}.')
    kind = entry.get('kind')
    if kind in ('compose', 'native'):
        title = entry.get('title') or rid
        if not isinstance(title, str) or len(title) > 120:
            raise ValueError('title must be a string of at most 120 characters.')
        if 'publisher' in entry and entry['publisher'] is not None:
            pub = entry.get('publisher')
            if not isinstance(pub, str) or not RE_PUBKEY.fullmatch(pub):
                raise ValueError('publisher must be 64 hex characters.')
        if 'imageDigest' in entry and entry['imageDigest']:
            dg = entry.get('imageDigest')
            if not isinstance(dg, str) or not re.fullmatch(r'[a-f0-9]{64}', dg):
                raise ValueError('imageDigest must be 64 hex characters.')
        base = {'id': rid, 'title': title, 'kind': kind, 'healthPort': int(entry.get('healthPort') or ENDPOINT_PORT),
                'stopGraceSec': int(entry.get('stopGraceSec') or 20),
                'modelFolder': _validate_model_folder(entry.get('modelFolder'))}
        if entry.get('publisher'): base['publisher'] = entry['publisher'].lower()
        if entry.get('imageDigest'): base['imageDigest'] = entry['imageDigest'].lower()
        if entry.get('engine'): base['engine'] = entry['engine']
        if entry.get('composeFile'): base['composeFile'] = entry['composeFile']
        if not (1024 <= base['healthPort'] <= 65535): raise ValueError('healthPort must be between 1024 and 65535.')
        if not (1 <= base['stopGraceSec'] <= 120): raise ValueError('stopGraceSec must be between 1 and 120.')
        return base
    return None


def _validate_recipe(entry):
    if not isinstance(entry, dict):
        raise ValueError('not an object.')
    rid = entry.get('id')
    if not isinstance(rid, str) or not RE_ID.fullmatch(rid):
        raise ValueError('id must match [a-z0-9-]{1,64}.')
    title = entry.get('title') or rid
    if not isinstance(title, str) or len(title) > 120:
        raise ValueError('title must be a string of at most 120 characters.')
    kind = entry.get('kind')
    v2 = _validate_recipe_v2(entry)
    if v2 is not None:
        return v2
    if kind == 'tmux':
        session = entry.get('session')
        if not isinstance(session, str) or not RE_SESSION.fullmatch(session):
            raise ValueError('tmux session must match [A-Za-z0-9._-]{1,64}.')
        argv = entry.get('argv')
        if not isinstance(argv, list) or not argv or len(argv) > 64:
            raise ValueError('tmux argv must be a non-empty list (max 64 items).')
        for token in argv:
            if not isinstance(token, str) or not token or '\n' in token or len(token) > 4096:
                raise ValueError('tmux argv items must be non-empty single-line strings.')
        # Executable path checks are best-effort at load time (advisory warnings);
        # start() re-checks existence before executing.
        recipe = {'id': rid, 'title': title, 'kind': 'tmux', 'session': session, 'argv': argv,
                  'cwd': entry.get('cwd') or None, 'healthPort': int(entry.get('healthPort') or ENDPOINT_PORT),
                  'stopGraceSec': int(entry.get('stopGraceSec') or 20),
                  'modelFolder': _validate_model_folder(entry.get('modelFolder'))}
        if not (1024 <= recipe['healthPort'] <= 65535):
            raise ValueError('healthPort must be between 1024 and 65535.')
        if not (1 <= recipe['stopGraceSec'] <= 120):
            raise ValueError('stopGraceSec must be between 1 and 120.')
        return recipe
    if kind == 'docker':
        container = entry.get('container')
        if not isinstance(container, str) or not RE_CONTAINER.fullmatch(container):
            raise ValueError('docker container name is invalid.')
        return {'id': rid, 'title': title, 'kind': 'docker', 'container': container,
                'healthPort': ENDPOINT_PORT, 'modelFolder': _validate_model_folder(entry.get('modelFolder'))}
    raise ValueError('kind must be tmux or docker.')


def _validate_model_folder(value):
    """Optional recipe->model linkage. None/absent means 'no linked model'."""
    if value is None:
        return None
    if not isinstance(value, str) or not RE_MODEL_FOLDER.fullmatch(value):
        raise ValueError('modelFolder must match [A-Za-z0-9][A-Za-z0-9._+-]{0,127}.')
    return value


class RecipeBook:
    """Thread-safe recipe store with mtime-based reload and a permissions gate."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.mtime = None
        self.recipes = []
        self.warnings = []
        self.loaded = False
        self.reload(force=True)

    def _perm_gate(self):
        if self.path.is_symlink():
            raise ValueError('recipes.json must not be a symlink.')
        info = self.path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
            raise ValueError('recipes.json must be a regular file no larger than 1 MB.')
        if info.st_uid != os.getuid():
            raise ValueError('recipes.json is not owned by the daemon user.')
        if info.st_mode & 0o022:
            raise ValueError('recipes.json must not be group/world writable.')

    def reload(self, force=False):
        with self.lock:
            try:
                mtime = self.path.stat().st_mtime
            except OSError:
                if force:
                    self.loaded, self.recipes = False, []
                    self.warnings = ['recipes.json not found; model controls unavailable.']
                return
            if not force and mtime == self.mtime:
                return
            try:
                self._perm_gate()
                doc = json.loads(self.path.read_text())
                recipes, warnings = validate_recipes(doc)
                self.recipes, self.warnings, self.loaded, self.mtime = recipes, warnings, True, mtime
            except Exception as error:
                self.loaded, self.recipes = False, []
                self.warnings = [f'recipes.json rejected: {error}']

    def get(self, recipe_id):
        self.reload()
        with self.lock:
            for recipe in self.recipes:
                if recipe['id'] == recipe_id:
                    return dict(recipe)
        return None

    def all(self):
        self.reload()
        with self.lock:
            return [dict(r) for r in self.recipes], list(self.warnings), self.loaded


# ---------------------------------------------------------------------------
# 1 Hz light sampler thread.
# ---------------------------------------------------------------------------

class Sampler(threading.Thread):
    """Publishes an immutable StreamSample dict under a lock at ~1 Hz.

    Degrades to None fields with warnings when sources are missing (e.g. local
    Mac smoke runs without /proc, nvidia-smi, or docker). Never fabricates.
    """

    def __init__(self, recipe_book, proc_root=PROC, runner=subprocess.run,
                 endpoint_port=ENDPOINT_PORT, interval=1.0):
        super().__init__(daemon=True, name='frostbyte-hostd-sampler')
        self.recipe_book = recipe_book
        self.proc_root = proc_root
        self.runner = runner
        self.endpoint_port = endpoint_port
        self.interval = interval
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.seq = 0
        self.sample = None
        self._prev_cpu = None
        self._prev_net = None
        self._prev_net_time = None
        self._prev_docker_models = []
        self._tick_count = 0
        self._last_error_log = 0.0

    def stop(self):
        self.stop_event.set()

    def latest(self):
        with self.lock:
            return self.seq, self.sample

    def run(self):
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                self._tick()
            except Exception:
                # A failed tick never kills the sampler; fields degrade. The
                # journal gets one rate-limited line so it is diagnosable.
                now = time.monotonic()
                if now - self._last_error_log >= 60:
                    self._last_error_log = now
                    sys.stderr.write(f'{DAEMON_NAME}: sampler tick failed; fields degrade\n')
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.05, self.interval - elapsed))

    def _tick(self):
        tick_started = time.monotonic()
        self._tick_count += 1
        heavy = self._tick_count % 5 == 1  # endpoint probe + docker every 5th tick
        warnings = []
        # CPU (delta across ticks; None on first tick or without /proc)
        cpu = None
        try:
            cur = cpu_times(read_proc(self.proc_root, 'stat'))
            if self._prev_cpu is not None:
                cpu = cpu_percent(self._prev_cpu, cur)
            self._prev_cpu = cur
        except Exception:
            warnings.append('CPU unavailable (/proc/stat).')
        # Memory
        mem_available = None
        try:
            mem_available = float(memory(read_proc(self.proc_root, 'meminfo'))['available'])
        except Exception:
            warnings.append('Memory unavailable (/proc/meminfo).')
        # Network rates
        rx = tx = None
        now = time.monotonic()
        try:
            cur_net = netdev_totals(read_proc(self.proc_root, 'net/dev'))
            rx, tx = netdev_rates(self._prev_net, cur_net,
                                  now - self._prev_net_time if self._prev_net_time else 0)
            self._prev_net, self._prev_net_time = cur_net, now
        except Exception:
            warnings.append('Network counters unavailable (/proc/net/dev).')
        # GPU
        gpu = None
        rc, raw = run_rc(['nvidia-smi', '--query-gpu=temperature.gpu,utilization.gpu,power.draw',
                          '--format=csv,noheader,nounits'], timeout=3, runner=self.runner)
        if rc == 0:
            try:
                row = next(csv.reader(io.StringIO(raw)))
                temperature, utilization, power = map(number, row[:3])
                gpu = {'temperature': temperature, 'utilization': utilization, 'power': power}
            except Exception:
                warnings.append('GPU telemetry unparseable.')
        else:
            warnings.append('GPU telemetry unavailable.')
        # Endpoint (budgeted: every 5th tick, short timeout)
        endpoint = None
        if heavy:
            endpoint = endpoint_health(self.endpoint_port, timeout=0.7)
        # Running models: tmux every tick (cheap), docker every 5th tick.
        # One `docker ps` per heavy tick regardless of how many docker
        # recipes exist — the per-recipe loop ran N subprocesses.
        running = []
        recipes, _, _ = self.recipe_book.all()
        for recipe in recipes:
            if recipe['kind'] == 'tmux':
                alive, pane_pid = self._tmux_alive(recipe['session'])
                if alive:
                    running.append({'kind': 'tmux', 'name': recipe['title'],
                                    'target': recipe['session'], 'pid': pane_pid})
        if heavy:
            self._prev_docker_models = self._docker_running(recipes)
        running.extend(self._prev_docker_models)
        sample = {'schema': SCHEMA, 't': time.time(), 'gpu': gpu, 'cpu': cpu,
                  'memAvailable': mem_available, 'netRxBps': rx, 'netTxBps': tx,
                  'endpoint': endpoint, 'runningModels': running, 'warnings': warnings,
                  'samplerMs': round((time.monotonic() - tick_started) * 1000, 1)}
        with self.lock:
            self.seq += 1
            self.sample = sample

    def _tmux_alive(self, session):
        rc, _ = run_rc(['tmux', 'has-session', '-t', '=' + session], timeout=3, runner=self.runner)
        if rc != 0:
            return False, None
        rc, raw = run_rc(['tmux', 'list-panes', '-t', '=' + session + ':', '-F', '#{pane_pid}'],
                         timeout=3, runner=self.runner)
        pid = None
        if rc == 0 and raw.strip():
            pid = int(raw.strip().splitlines()[0])
        return True, pid

    def _docker_running(self, recipes):
        names = {r['container']: r for r in recipes if r['kind'] == 'docker'}
        if not names:
            return []
        rc, raw = run_rc(['docker', 'ps', '--no-trunc', '--format', '{{json .}}'],
                         timeout=5, runner=self.runner)
        if rc != 0:
            return []
        found = []
        for line in raw.splitlines()[:200]:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            name = obj.get('Names', '').lstrip('/')
            if name in names:
                found.append({'kind': 'docker', 'name': names[name]['title'],
                              'target': name, 'pid': None})
        return found


# ---------------------------------------------------------------------------
# Auth, receipts, locks.
# ---------------------------------------------------------------------------

def load_token(path, enforce_permissions=True):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise ValueError('Token file must be a regular file, not a symlink.')
    if enforce_permissions and info.st_uid != os.getuid():
        raise ValueError('Token file must be owned by the daemon user.')
    if enforce_permissions and info.st_mode & 0o077:
        raise ValueError('Token file must not be accessible by group or other users (chmod 600).')
    raw = path.read_text(encoding='utf-8')
    text = raw.strip()
    if raw not in (text, text + '\n') or not (32 <= len(text.encode('utf-8')) <= 4096):
        raise ValueError('Token must be 32-4096 non-whitespace characters with one optional trailing newline.')
    if any(ord(char) < 0x21 or ord(char) > 0x7e for char in text):
        raise ValueError('Token must contain visible ASCII characters only.')
    return text


def token_fingerprint(token):
    import hashlib
    return hashlib.sha256(token.encode()).hexdigest()[:12]


def check_auth(headers, token):
    header = headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        return False
    return hmac.compare_digest(header[7:].strip(), token)


def host_ok(headers, port=None):
    """DNS-rebinding guard: Host must be an IP literal or localhost."""
    host = headers.get('Host', '')
    if host.startswith('['):
        hostname = host.split(']', 1)[0][1:]
    elif ':' in host:
        hostname = host.rsplit(':', 1)[0]
    else:
        hostname = host
    if hostname == 'localhost':
        return True
    try:
        socket.inet_pton(socket.AF_INET, hostname)
        return True
    except OSError:
        pass
    try:
        socket.inet_pton(socket.AF_INET6, hostname)
        return True
    except OSError:
        return False


def origin_ok(headers):
    # Native app clients send no Origin. Any browser Origin is refused: the
    # daemon API is not a web surface and tokens must never ride cross-origin.
    return headers.get('Origin') is None


def append_receipt(receipts_path, record):
    try:
        path = Path(receipts_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        record = dict(record)
        record['timestamp'] = time.time()
        with open(path, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps(record, allow_nan=False) + '\n')
        os.chmod(path, 0o600)
    except Exception:
        pass  # receipts are best-effort; never fail a confirmed action on them


@contextlib.contextmanager
def control_locks(lock_paths):
    """Non-blocking flock over every path; BlockingIOError propagates to caller."""
    fds = []
    try:
        for path in lock_paths:
            try:
                Path(path).parent.mkdir(parents=True, exist_ok=True)
            except Exception:
                continue
            fd = os.open(str(path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fds.append(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        for fd in fds:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except Exception:
                pass
            os.close(fd)


# ---------------------------------------------------------------------------
# Control engine — docker path mirrors controller.py; tmux path per recipes.
# ---------------------------------------------------------------------------

def docker_inspect(target, runner):
    return json.loads(run(['docker', 'inspect', '--format', DOCKER_FORMAT, target], runner=runner))


def gpu_preflight(runner, port, ignore_pids=()):
    """Refuse to start when the port is bound or GPU compute processes run."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(('127.0.0.1', int(port))) == 0:
            raise ValueError(f'Port {port} is already bound. Stop the running model explicitly first; '
                             'FrostByte will not switch it automatically.')
    rc, raw = run_rc(['nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader'],
                     timeout=5, runner=runner)
    if rc != 0:
        raise ValueError('GPU process state is unavailable. Start is blocked until it can be verified.')
    if rc == 0:
        pids = {p.strip() for p in raw.split() if p.strip()} - {str(p) for p in ignore_pids if p}
        if pids:
            raise ValueError('A GPU compute process is active. Review it before starting another model.')


def tmux_alive(session, runner):
    rc, _ = run_rc(['tmux', 'has-session', '-t', '=' + session], timeout=3, runner=runner)
    return rc == 0


def tmux_start(recipe, runner):
    executable = recipe['argv'][0]
    if not Path(executable).is_absolute() or not os.access(executable, os.X_OK):
        raise ValueError(f'Recipe executable is not an accessible absolute path: {executable}')
    if recipe.get('cwd') and not Path(recipe['cwd']).is_dir():
        raise ValueError(f'Recipe cwd does not exist: {recipe["cwd"]}')
    if tmux_alive(recipe['session'], runner):
        return {'ok': True, 'state': 'running',
                'message': 'Already running. No lifecycle command issued; endpoint health is separate.'}
    gpu_preflight(runner, recipe['healthPort'])
    command = 'exec ' + ' '.join(shlex.quote(token) for token in recipe['argv'])
    argv = ['tmux', 'new-session', '-d', '-s', recipe['session'], '--', '/bin/sh', '-c', command]
    if recipe.get('cwd'):
        argv = ['tmux', 'new-session', '-d', '-s', recipe['session'], '-c', recipe['cwd'],
                '--', '/bin/sh', '-c', command]
    run(argv, timeout=10, runner=runner)
    time.sleep(1.0)
    if not tmux_alive(recipe['session'], runner):
        return {'ok': False, 'state': 'exited',
                'message': 'Session ended immediately after start. Check the recipe argv and model path; '
                           'no automatic retry.'}
    return {'ok': True, 'state': 'started',
            'message': 'Session started. Model may still be loading; check endpoint health.'}


def tmux_stop(recipe, runner):
    session = recipe['session']
    if not tmux_alive(session, runner):
        return {'ok': True, 'state': 'stopped',
                'message': 'Already stopped. No lifecycle command issued.'}
    run(['tmux', 'send-keys', '-t', '=' + session + ':', 'C-c'], timeout=5, runner=runner)
    deadline = time.monotonic() + recipe['stopGraceSec']
    while time.monotonic() < deadline:
        if not tmux_alive(session, runner):
            break
        time.sleep(0.5)
    if tmux_alive(session, runner):
        run(['tmux', 'kill-session', '-t', '=' + session], timeout=5, runner=runner)
        time.sleep(0.3)
    if tmux_alive(session, runner):
        return {'ok': False, 'state': 'running',
                'message': 'Stop requested, but the session is still alive. Investigate before retrying.'}
    return {'ok': True, 'state': 'stopped',
            'message': 'Session stopped. Existing requests were interrupted; weights and recipe were retained.'}


def container_conflict(info, health_port):
    """True when a container holds GPU devices, the nvidia runtime, or the port."""
    ports = info.get('ports') or {}
    for bindings in ports.values():
        for binding in (bindings or []):
            if str(binding.get('HostPort')) == str(health_port):
                return True
    return bool(info.get('devices')) or info.get('runtime') == 'nvidia'


def docker_control(recipe, action, runner, expected_id=None):
    """Mirrors controller.py handle() semantics for a recipe-named container."""
    name = recipe['container']
    try:
        target = docker_inspect(name, runner)
    except Exception:
        raise ValueError('Container could not be inspected. It may not exist on this machine.')
    if target['name'].lstrip('/') != name:
        raise ValueError('Container identity changed. Refresh and confirm again.')
    if expected_id is not None and target['id'] != expected_id:
        raise ValueError('The reviewed container was replaced. Refresh and confirm again.')
    state = target['state']
    if action in ('check', 'start') and state == 'running':
        return {'ok': True, 'state': state,
                'message': 'Already running. No lifecycle command issued; endpoint health is separate.'}
    if action == 'stop' and state in ('exited', 'created'):
        return {'ok': True, 'state': state, 'message': 'Already stopped. No lifecycle command issued.'}
    if action in ('start', 'check'):
        if state not in ('exited', 'created'):
            raise ValueError('Container is transitioning or paused. Refresh and review it first.')
        # Port/GPU preflight: one batched inspect for every other container —
        # the previous per-container loop cost N sequential subprocess calls.
        rc, raw = run_rc(['docker', 'ps', '-q', '--no-trunc'], timeout=5, runner=runner)
        if rc == 0:
            others = [oid for oid in raw.split() if oid != target['id']][:100]
            if others:
                rc_inspect, raw_inspect = run_rc(
                    ['docker', 'inspect', '--format', DOCKER_FORMAT, *others], timeout=15, runner=runner)
                if rc_inspect == 0:
                    for line in raw_inspect.splitlines():
                        try:
                            info = json.loads(line)
                        except Exception:
                            continue
                        if container_conflict(info, recipe['healthPort']):
                            raise ValueError('Another GPU or serving-port container is running. Stop it explicitly '
                                             'first; FrostByte will not switch it automatically.')
        gpu_preflight(runner, recipe['healthPort'])
        if action == 'check':
            return {'ok': True, 'state': state,
                    'message': 'Start preflight passed. Nothing was started; model loading and memory '
                               'fit are not verified.'}
        run(['docker', 'start', target['id']], timeout=45, runner=runner)
        desired = 'running'
    else:
        if state != 'running':
            raise ValueError('Container is transitioning or paused. Refresh and review it first.')
        run(['docker', 'stop', '--timeout', '30', target['id']], timeout=45, runner=runner)
        desired = 'exited'
    after = docker_inspect(target['id'], runner)
    if after['state'] != desired:
        return {'ok': False, 'state': after['state'],
                'message': 'Lifecycle request returned, but expected state was not observed. Refresh and '
                           'investigate; no automatic retry.'}
    return {'ok': True, 'state': after['state'], 'message':
            'Container started. Model may still be loading; check endpoint health.' if action == 'start' else
            'Container stopped. Existing requests were interrupted; weights and saved configuration '
            'were retained.'}


def control_review(recipe, ctx):
    target_id = docker_inspect(recipe['container'], ctx.runner)['id'] if recipe['kind'] == 'docker' else None
    boot = (_read_small(getattr(ctx, 'proc_root', PROC) / 'sys/kernel/random/boot_id') or '').strip()
    body = json.dumps({'host': ctx.hostname, 'boot': boot, 'recipe': recipe, 'containerId': target_id}, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(body.encode()).hexdigest(), target_id


def handle_control(request, ctx):
    """Returns a ControlResult dict {ok, state, message}. Never raises."""
    try:
        if not isinstance(request, dict):
            raise ValueError('Request must be a JSON object.')
        action = request.get('action')
        if action not in ('start', 'stop', 'check'):
            raise ValueError('Unsupported action.')
        kind = request.get('kind')
        if kind not in ('tmux', 'docker'):
            raise ValueError('Kind must be tmux or docker.')
        target_id = request.get('target')
        if not isinstance(target_id, str) or not RE_ID.fullmatch(target_id):
            raise ValueError('Target must be a recipe id.')
        host = str(request.get('host', ''))
        if not RE_HOSTNAME.fullmatch(host):
            raise ValueError('An observed machine hostname is required.')
        if host != ctx.hostname:
            raise ValueError('Machine identity changed. Reconnect and review the target.')
        if request.get('confirm') is not True:
            raise ValueError('Controls require confirm:true from the FrostByte UI.')
        recipe = ctx.recipe_book.get(target_id)
        if recipe is None or recipe['kind'] != kind:
            raise ValueError('Target is not an approved recipe of that kind. Refresh recipes first.')
        if action == 'check':
            result = (tmux_check(recipe, ctx.runner) if kind == 'tmux'
                      else docker_control(recipe, 'check', ctx.runner))
            if result.get('ok'):
                result['reviewDigest'], _ = control_review(recipe, ctx)
        else:
            with control_locks(ctx.lock_paths):
                # Re-read the approved recipe under the operation lock. A native
                # confirmation for one recipe/container must not authorize its replacement.
                recipe = ctx.recipe_book.get(target_id)
                if recipe is None or recipe['kind'] != kind:
                    raise ValueError('The approved recipe changed. Refresh and confirm again.')
                expected_id = None
                if getattr(ctx, 'spark_profile', False) or request.get('reviewDigest'):
                    digest, expected_id = control_review(recipe, ctx)
                    reviewed = request.get('reviewDigest')
                    if not isinstance(reviewed, str) or not hmac.compare_digest(reviewed, digest):
                        raise ValueError('The reviewed model recipe or container changed. Refresh and confirm again.')
                result = (tmux_start(recipe, ctx.runner) if kind == 'tmux' and action == 'start'
                          else tmux_stop(recipe, ctx.runner) if kind == 'tmux'
                          else docker_control(recipe, action, ctx.runner, expected_id=expected_id))
    except (ValueError, RuntimeError) as error:
        result = {'ok': False, 'state': 'unverified', 'message': str(error)}
    except BlockingIOError:
        result = {'ok': False, 'state': 'unverified', 'message': LOCK_BUSY_MESSAGE}
    except Exception:
        result = {'ok': False, 'state': 'unverified',
                'message': 'Operation could not be verified. It may have reached the target. Refresh '
                           'before any further action; do not blindly retry.'}
    result['timestamp'] = time.time()
    append_receipt(ctx.receipts_path, {'channel': DAEMON_NAME, 'action': request.get('action') if isinstance(request, dict) else None,
                                       'target': request.get('target') if isinstance(request, dict) else None,
                                       'kind': request.get('kind') if isinstance(request, dict) else None,
                                       'ok': result.get('ok'), 'state': result.get('state'),
                                       'message': result.get('message')})
    return result


def tmux_check(recipe, runner):
    if tmux_alive(recipe['session'], runner):
        return {'ok': True, 'state': 'running',
                'message': 'Already running. No lifecycle command issued; endpoint health is separate.'}
    executable = recipe['argv'][0]
    if not Path(executable).is_absolute() or not os.access(executable, os.X_OK):
        raise ValueError(f'Recipe executable is not an accessible absolute path: {executable}')
    if recipe.get('cwd') and not Path(recipe['cwd']).is_dir():
        raise ValueError('Recipe working directory is unavailable.')
    gpu_preflight(runner, recipe['healthPort'])
    return {'ok': True, 'state': 'stopped',
            'message': 'Start preflight passed; executable, port and GPU availability checked. Nothing was started; model files and memory fit are not verified.'}


# ---------------------------------------------------------------------------
# Power engine — two-phase confirm; response flushed before execution.
# ---------------------------------------------------------------------------

def running_models(ctx):
    _, sample = ctx.sampler.latest()
    if sample and sample.get('runningModels'):
        return sample['runningModels']
    return []


def handle_power(request, ctx, executor=None):
    """Returns (response_dict, deferred_callable_or_None). Never raises.

    executor(argv) -> (returncode, stdout); default runs the real subprocess.
    """
    executor = executor or (lambda argv: run_rc(argv, timeout=30, runner=ctx.runner))
    deferred = None
    try:
        if not isinstance(request, dict):
            raise ValueError('Request must be a JSON object.')
        action = request.get('action')
        if action not in POWER_VERBS:
            raise ValueError('Action must be shutdown or reboot.')
        host = str(request.get('host', ''))
        if not RE_HOSTNAME.fullmatch(host):
            raise ValueError('An observed machine hostname is required.')
        if host != ctx.hostname:
            raise ValueError('Machine identity changed. Reconnect and review the target.')
        confirm = request.get('confirm', '')
        if not isinstance(confirm, str):
            raise ValueError('confirm must be a string.')
        models = running_models(ctx)
        if confirm == '':
            summary = (f'{len(models)} managed model(s) observed: ' +
                       ', '.join(m['name'] for m in models)) if models else 'No running models reported by the recipe sampler.'
            return {'ok': True, 'state': 'preview', 'timestamp': time.time(),
                    'message': f'{summary} Other workloads may be active. Models do not auto-start after power cycling. '
                               f'Confirm with the exact phrase {POWER_PHRASES[action]}.',
                    'requiredPhrase': POWER_PHRASES[action], 'runningModels': models}, None
        if confirm != POWER_PHRASES[action]:
            return {'ok': False, 'state': 'blocked', 'timestamp': time.time(),
                    'message': 'Confirmation phrase did not match. Nothing was executed.',
                    'requiredPhrase': POWER_PHRASES[action], 'runningModels': models}, None
        verb = POWER_VERBS[action]
        argv = ['/usr/bin/sudo', '-n', '/usr/bin/systemctl', verb]
        locks = control_locks(ctx.lock_paths)
        locks.__enter__()  # held through the delayed action, including against model controls
        try:
            operation_id = secrets.token_hex(16)
            result = {'ok': True, 'state': 'pending', 'timestamp': time.time(),
                      'operationID': operation_id,
                      'message': 'Power request acknowledged; execution has not yet been verified.',
                      'runningModels': models}
            with ctx.power_results_lock:
                while len(ctx.power_results) >= 100:
                    ctx.power_results.pop(next(iter(ctx.power_results)))
                ctx.power_results[operation_id] = dict(result)

            def finish_power(rc, message):
                final = {'ok': rc == 0, 'state': 'executing' if rc == 0 else 'blocked',
                         'operationID': operation_id, 'timestamp': time.time(), 'message': message}
                with ctx.power_results_lock:
                    ctx.power_results[operation_id] = final
                append_receipt(ctx.receipts_path, {**final, 'channel': DAEMON_NAME, 'action': 'power',
                                                  'target': action, 'kind': 'power'})
                locks.__exit__(None, None, None)

            def deferred_power():
                try:
                    rc, _ = executor(argv)
                    message = ('Power command accepted by systemd; physical completion is not verified.' if rc == 0 else
                               f'sudo -n denied or systemctl failed (rc={rc}). Check the sudoers drop-in.')
                except Exception:
                    rc, message = 1, 'Power executor failed; inspect Spark before retrying.'
                finish_power(rc, message)

            deferred_power.cancel = lambda: finish_power(1, 'Response delivery failed before power dispatch. Nothing executed.')
            deferred = deferred_power
            append_receipt(ctx.receipts_path, {'channel': DAEMON_NAME, 'action': 'power', 'target': action,
                                               'kind': 'power', 'ok': True, 'state': 'pending',
                                               'operationID': operation_id,
                                               'message': 'Confirmed power request pending dispatch.'})
            return result, deferred
        except BaseException:
            # Anything failing between acquire and handoff must release, or the
            # mutation-serializing lock is lost until process exit. The normal
            # return path above intentionally keeps it held for the executor.
            locks.__exit__(None, None, None)
            raise
    except BlockingIOError:
        return {'ok': False, 'state': 'blocked', 'message': LOCK_BUSY_MESSAGE}, None
    except (ValueError, RuntimeError) as error:
        return {'ok': False, 'state': 'blocked', 'timestamp': time.time(), 'message': str(error)}, None
    except Exception:
        return {'ok': False, 'state': 'blocked', 'timestamp': time.time(),
                'message': 'Power request could not be verified. Nothing was executed.'}, None


# ---------------------------------------------------------------------------
# Processes / services views.
# ---------------------------------------------------------------------------

def handle_processes(ctx):
    warnings = []
    gpu_pids = set()
    rc, raw = run_rc(['nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader'],
                     timeout=5, runner=ctx.runner)
    if rc == 0:
        gpu_pids = {p.strip() for p in raw.split() if p.strip()}
    else:
        warnings.append('GPU process list unavailable.')
    first, second = {}, {}
    for target in (first, second):
        for entry in _proc_pids(ctx.proc_root):
            stat_text = _read_small(entry / 'stat')
            if stat_text is None:
                continue
            try:
                parts = stat_text.rsplit(') ', 1)[1].split()
                utime, stime = int(parts[11]), int(parts[12])
                target[entry.name] = utime + stime
            except Exception:
                continue
        if target is first:
            time.sleep(0.25)
    hertz = os.sysconf('SC_CLK_TCK') if hasattr(os, 'sysconf') else 100
    rows = []
    for pid, ticks in second.items():
        delta = ticks - first.get(pid, ticks)
        status_text = _read_small(ctx.proc_root / pid / 'status') or ''
        uid, rss = None, None
        comm = None
        for line in status_text.splitlines():
            if line.startswith('Uid:'):
                uid = int(line.split()[1])
            elif line.startswith('VmRSS:'):
                rss = int(line.split()[1]) * 1024
            elif line.startswith('Name:'):
                comm = line.split('\t', 1)[1].strip()
        if uid is None:
            continue
        try:
            user = pwd.getpwuid(uid).pw_name
        except Exception:
            user = str(uid)
        rows.append({'pid': int(pid), 'user': user,
                     'cpu': round(100.0 * delta / (0.25 * hertz), 1) if delta else 0.0,
                     'memBytes': rss, 'comm': comm, 'gpu': pid in gpu_pids})
    rows.sort(key=lambda r: (r['gpu'], r['cpu']), reverse=True)
    if not rows:
        warnings.append('Process table unavailable (needs Linux /proc).')
    return {'schema': SCHEMA, 'processes': rows[:15], 'captured': time.time(), 'warnings': warnings}


def _proc_pids(proc_root):
    try:
        return [p for p in proc_root.iterdir() if p.name.isdigit()]
    except Exception:
        return []


def _read_small(path, limit=65536):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            return handle.read(limit)
    except Exception:
        return None


def handle_services(ctx):
    warnings = []
    tmux_sessions = []
    rc, raw = run_rc(['tmux', 'list-sessions', '-F', '#{session_name}'], timeout=3, runner=ctx.runner)
    if rc == 0:
        recipes, _, _ = ctx.recipe_book.all()
        by_session = {r['session']: r['id'] for r in recipes if r['kind'] == 'tmux'}
        tmux_sessions = [{'session': line.strip(), 'alive': True,
                          'recipeId': by_session.get(line.strip())}
                         for line in raw.splitlines() if line.strip()]
    else:
        warnings.append('tmux server not reachable from the daemon.')
    containers = []
    rc, raw = run_rc(['docker', 'ps', '-a', '--no-trunc', '--format', '{{json .}}'],
                     timeout=5, runner=ctx.runner)
    if rc == 0:
        for line in raw.splitlines()[:200]:
            try:
                obj = json.loads(line)
                containers.append({'id': obj['ID'], 'name': obj['Names'], 'image': obj['Image'],
                                   'state': obj['State'], 'status': obj['Status']})
            except Exception:
                continue
    else:
        warnings.append('Docker inventory unavailable.')
    llama = {'pid': None, 'session': None}
    for entry in _proc_pids(ctx.proc_root):
        cmdline = _read_small(entry / 'cmdline')
        if cmdline and 'llama-server' in cmdline.replace('\x00', ' '):
            try:
                llama['pid'] = int(entry.name)
            except Exception:
                pass
            break
    # No warning when absent: serving may legitimately live in docker/vllm.
    return {'schema': SCHEMA,
            'daemon': {'version': DAEMON_VERSION,
                       'uptimeSec': round(time.monotonic() - ctx.started_monotonic, 1)},
            'tmux': tmux_sessions, 'docker': containers, 'llamaServer': llama,
            'warnings': warnings}


# ---------------------------------------------------------------------------
# Workspace agent (v1) — jailed file operations for the Studio IDE. Enabled
# only when --workspace is set; the capability bit tells clients it exists.
# ---------------------------------------------------------------------------

RE_WORKSPACE_PATH = re.compile(r'[^\x00-\x1f\\]+')

def workspace_error(message):
    return {'ok': False, 'error': message}

def workspace_safe(handler):
    '''Convert jail/validation ValueErrors into clean JSON errors. Without this
    a refused path would surface as an HTTP 500 instead of a model-actionable
    message.'''
    @functools.wraps(handler)
    def wrapped(ctx, *args):
        try:
            return handler(ctx, *args)
        except ValueError as error:
            return workspace_error(str(error))
        except OSError as error:
            return workspace_error(f'Filesystem error: {error}')
    return wrapped

def workspace_resolve(ctx, rel):
    """Jail a model/operator-supplied relative path into ctx.workspace.

    Same two layers as the native app: lexical checks, then a realpath check on
    the deepest existing ancestor so a symlink inside the workspace cannot
    escape. Returns an absolute Path or raises ValueError.
    """
    if not ctx.workspace:
        raise ValueError('Workspace is not enabled on this daemon (start with --workspace).')
    rel = (rel or '').strip()
    if not rel or rel.startswith('/') or rel.startswith('~') or '\\' in rel:
        raise ValueError('Use a relative path inside the workspace.')
    parts = [p for p in rel.split('/') if p not in ('', '.')]
    if any(p == '..' for p in parts) or any(not RE_WORKSPACE_PATH.fullmatch(p) for p in parts):
        raise ValueError('Use a relative path inside the workspace.')
    root = ctx.workspace.resolve()
    target = root.joinpath(*parts)
    if target != root and root not in target.parents:
        raise ValueError('Resolved path left the workspace.')
    probe = target
    while probe != root and not probe.exists():
        probe = probe.parent
    probe_real = probe.resolve()
    if probe_real != root and root not in probe_real.parents:
        raise ValueError('Path escapes the workspace through a symlink.')
    return target

@workspace_safe
def handle_fs_list(ctx, query):
    # Empty path lists the workspace root (file reads reject '', by design).
    raw = (query.get('path') or '').strip()
    target = ctx.workspace if not raw else workspace_resolve(ctx, raw)
    if not target.is_dir():
        return workspace_error('Not a directory.')
    entries = []
    for entry in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name))[:2000]:
        try:
            stat = entry.stat()
            entries.append({'name': entry.name, 'dir': entry.is_dir(),
                            'size': stat.st_size, 'mtime': stat.st_mtime})
        except OSError:
            continue
    return {'ok': True, 'entries': entries}

@workspace_safe
def handle_fs_read(ctx, query):
    target = workspace_resolve(ctx, query.get('path', ''))
    if not target.is_file():
        return workspace_error('Not a file.')
    size = target.stat().st_size
    if size > 8 * 1024 * 1024:
        return workspace_error('File exceeds the 8 MB read limit.')
    offset = max(0, int(query.get('offset', 0)))
    limit = min(2 * 1024 * 1024, max(1, int(query.get('limit', 2 * 1024 * 1024))))
    with open(target, 'rb') as handle:
        handle.seek(offset)
        data = handle.read(limit)
    try:
        return {'ok': True, 'encoding': 'utf8', 'size': size, 'content': data.decode('utf-8'),
                'truncated': offset + len(data) < size}
    except UnicodeDecodeError:
        return {'ok': True, 'encoding': 'base64', 'size': size,
                'content': base64.b64encode(data).decode('ascii'), 'truncated': offset + len(data) < size}

@workspace_safe
def handle_fs_write(ctx, request):
    if request.get('confirm') is not True:
        raise ValueError('Writes require confirm:true from the client.')
    target = workspace_resolve(ctx, request.get('path', ''))
    if target.is_dir():
        return workspace_error('Refusing to write: path is a directory.')
    try:
        encoded = request.get('content_b64', '')
        if not isinstance(encoded, str):
            raise ValueError
        data = base64.b64decode(encoded, validate=True)
    except Exception:
        return workspace_error('content_b64 must be valid base64.')
    if len(data) > 8 * 1024 * 1024:
        return workspace_error('Write exceeds the 8 MB limit.')
    existed = target.exists()
    file_mode = (target.stat().st_mode & 0o777
                 if existed and target.is_file() and not target.is_symlink() else 0o644)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f'.{target.name}.frostbyte-hostd-tmp-{secrets.token_hex(8)}')
    descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, file_mode)
        os.replace(tmp, target)  # atomic: readers never see a partial file
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()
    return {'ok': True, 'message': f"{'Replaced' if existed else 'Created'} {request.get('path')} ({len(data)} bytes)."}

@workspace_safe
def handle_fs_mkdir(ctx, request):
    target = workspace_resolve(ctx, request.get('path', ''))
    target.mkdir(parents=True, exist_ok=False)
    return {'ok': True, 'message': f'Created {request.get("path")}.'}

@workspace_safe
def handle_fs_rename(ctx, request):
    source = workspace_resolve(ctx, request.get('from', ''))
    target = workspace_resolve(ctx, request.get('to', ''))
    if not source.exists():
        return workspace_error('Source does not exist.')
    if target.exists():
        return workspace_error('Target already exists.')
    source.rename(target)
    return {'ok': True, 'message': f'Renamed {request.get("from")} to {request.get("to")}.'}

@workspace_safe
def handle_fs_delete(ctx, request):
    if request.get('confirm') is not True:
        raise ValueError('Deletes require confirm:true from the client.')
    target = workspace_resolve(ctx, request.get('path', ''))
    if target == ctx.workspace:
        return workspace_error('Refusing to delete the workspace root.')
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    else:
        return workspace_error('Path does not exist.')
    return {'ok': True, 'message': f'Deleted {request.get("path")}.'}

@workspace_safe
def handle_exec(ctx, request):
    """Bounded command execution inside the workspace. v1 is synchronous with a
    hard cap; a streaming variant is planned. Output is truncated, never silent."""
    if request.get('confirm') is not True:
        raise ValueError('Execution requires confirm:true from the client.')
    command = request.get('command')
    if not isinstance(command, str) or not command.strip() or len(command) > 4096:
        return workspace_error('command must be a non-empty string (4096 char limit).')
    try:
        timeout = min(300.0, max(1.0, float(request.get('timeout', 120))))
    except (TypeError, ValueError):
        return workspace_error('timeout must be a number of seconds.')
    # Empty cwd means the workspace root (resolve() rejects '', by design, for
    # file tools — but 'run here' is the natural exec default).
    cwd = ctx.workspace if not (request.get('cwd') or '').strip() else workspace_resolve(ctx, request['cwd'])
    try:
        result = subprocess.run(['/bin/bash', '-lc', command], cwd=str(cwd),
                                env=shell_env(cwd),
                                capture_output=True, text=True, timeout=timeout,
                                stdin=subprocess.DEVNULL)
        out, err, code = result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired:
        return {'ok': True, 'exit': None, 'timeout': True,
                'stdout': '', 'stderr': f'Timeout after {int(timeout)}s; process killed.'}
    cap = 512 * 1024
    if len(out) > cap:
        out = out[-cap:] + '\n…[truncated]'
    if len(err) > cap:
        err = err[-cap:] + '\n…[truncated]'
    return {'ok': True, 'exit': code, 'timeout': False, 'stdout': out, 'stderr': err}

def handle_workspace(ctx):
    """Capability descriptor so clients can discover the jail root."""
    if not ctx.workspace:
        return {'ok': False, 'error': 'Workspace is not enabled on this daemon.'}
    return {'ok': True, 'id': getattr(ctx, 'workspace_id', 'default'),
            'root': str(ctx.workspace), 'maxRead': 8 * 1024 * 1024,
            'maxWrite': 8 * 1024 * 1024, 'execTimeout': 300}


def parse_workspace_specs(specs):
    """Parse repeatable ``--workspace [ID=]PATH`` values into explicit roots.

    An unlabelled path is the backward-compatible ``default`` root. Roots must
    already be directories; their resolved paths are captured once at startup.
    """
    if specs is None:
        return {}
    if isinstance(specs, (str, Path)):
        specs = [str(specs)]
    roots = {}
    seen_paths = set()
    for raw in specs:
        if not isinstance(raw, str) or not raw or '\x00' in raw or '\n' in raw or '\r' in raw:
            raise ValueError('Workspace values must be non-empty single-line strings.')
        workspace_id, location = 'default', raw
        if '=' in raw:
            candidate, remainder = raw.split('=', 1)
            if RE_WORKSPACE_ID.fullmatch(candidate):
                workspace_id, location = candidate, remainder
        if not RE_WORKSPACE_ID.fullmatch(workspace_id):
            raise ValueError('Workspace id must match [a-z0-9][a-z0-9._-]{0,63}.')
        if workspace_id in roots:
            raise ValueError(f'Duplicate workspace id: {workspace_id}.')
        root = Path(location).expanduser().resolve()
        if not root.is_dir():
            raise ValueError(f'Workspace root is not a directory: {location}.')
        if root in seen_paths:
            raise ValueError(f'Workspace root is configured more than once: {root}.')
        roots[workspace_id] = root
        seen_paths.add(root)
    return roots


class WorkspaceView:
    """Request-scoped root selection without mutating the shared server Ctx."""

    def __init__(self, parent, workspace_id, workspace):
        self._parent = parent
        self.workspace_id = workspace_id
        self.workspace = workspace

    def __getattr__(self, name):
        return getattr(self._parent, name)


def workspace_context(ctx, workspace_id=None):
    roots = getattr(ctx, 'workspaces', None) or {}
    # Preserve direct-handler compatibility for a Ctx whose workspace was set
    # by an embedding application after construction.
    if not roots:
        if ctx.workspace:
            if workspace_id not in (None, '', getattr(ctx, 'workspace_id', 'default')):
                raise ValueError('Unknown workspace root.')
            return ctx
        raise ValueError('Workspace is not enabled on this daemon.')
    selected = workspace_id or getattr(ctx, 'default_workspace_id', None)
    if not isinstance(selected, str) or not RE_WORKSPACE_ID.fullmatch(selected) or selected not in roots:
        raise ValueError('Unknown workspace root.')
    return WorkspaceView(ctx, selected, roots[selected])


def handle_workspaces(ctx):
    roots = getattr(ctx, 'workspaces', None) or {}
    if not roots and ctx.workspace:
        roots = {getattr(ctx, 'workspace_id', 'default'): ctx.workspace}
    default = getattr(ctx, 'default_workspace_id', None) or next(iter(roots), None)
    return {'ok': True, 'default': default,
            'roots': [{'id': key, 'root': str(value)} for key, value in roots.items()]}



# ---------------------------------------------------------------------------
# Workspace agent (v2) — search, git, watch, PTY. Same jail as v1.
# ---------------------------------------------------------------------------

MAX_PTY_SESSIONS = 4
WATCH_INTERVAL = 1.0
SEARCH_LIMIT = 200

def require_workspace(ctx):
    """Every v2 handler needs the jail; refusing early gives a clean error
    instead of a TypeError deep inside os.walk."""
    if not ctx.workspace:
        raise ValueError('Workspace is not enabled on this daemon (start with --workspace).')
    return ctx.workspace


def _walk_workspace(ctx, rel, limit=20000):
    """Yield files under rel, skipping VCS/build noise. Bounded."""
    root = workspace_resolve(ctx, rel) if rel else ctx.workspace
    skip = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.build'}
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith('.')]
        for name in filenames:
            count += 1
            if count > limit:
                return
            yield Path(dirpath) / name

@workspace_safe
def handle_search(ctx, query):
    require_workspace(ctx)
    """ripgrep when present, else a bounded pure-Python scan. Never silent: the
    response says which engine ran."""
    needle = (query.get('q') or '').strip()
    if not needle or len(needle) > 400:
        return workspace_error('q must be 1-400 characters.')
    rel = (query.get('path') or '').strip()
    glob = (query.get('glob') or '').strip()
    limit = min(SEARCH_LIMIT, max(1, int(query.get('limit', SEARCH_LIMIT))))

    rg = shutil.which('ripgrep') or shutil.which('rg')
    if rg:
        argv = [rg, '--json', '--max-count', str(limit), '--max-filesize', '2M', needle]
        if glob:
            argv += ['--glob', glob]
        argv.append(str(workspace_resolve(ctx, rel) if rel else ctx.workspace))
        rc, raw = run_rc(argv, timeout=20, runner=ctx.runner)
        if rc == 0 or raw:
            hits = []
            for line in raw.splitlines():
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if obj.get('type') != 'match':
                    continue
                data = obj.get('data', {})
                path = data.get('path', {}).get('text', '')
                line_no = data.get('line_number')
                text = (data.get('lines', {}) or {}).get('text', '').rstrip('\n')
                try:
                    display = str(Path(path).relative_to(ctx.workspace))
                except ValueError:
                    display = path
                hits.append({'path': display, 'line': line_no, 'text': text[:400]})
                if len(hits) >= limit:
                    break
            return {'ok': True, 'engine': 'ripgrep', 'hits': hits}

    # Fallback: bounded regex scan (case-insensitive substring semantics).
    try:
        pattern = re.compile(re.escape(needle), re.IGNORECASE)
    except re.error as error:
        return workspace_error(f'Invalid query: {error}')
    hits = []
    for path in _walk_workspace(ctx, rel):
        if glob and not path.match(glob):
            continue
        try:
            if path.stat().st_size > 2 * 1024 * 1024:
                continue
            with open(path, 'r', encoding='utf-8', errors='ignore') as handle:
                for line_no, line in enumerate(handle, 1):
                    if needle.lower() in line.lower():
                        hits.append({'path': str(path.relative_to(ctx.workspace)),
                                     'line': line_no, 'text': line.rstrip()[:400]})
                        if len(hits) >= limit:
                            break
        except OSError:
            continue
        if len(hits) >= limit:
            break
    return {'ok': True, 'engine': 'builtin', 'hits': hits}

def _git(ctx, rel, args, timeout=15):
    cwd = workspace_resolve(ctx, rel) if rel else ctx.workspace
    rc, raw = run_rc(['git', '-C', str(cwd), *args], timeout=timeout, runner=ctx.runner)
    return rc, raw, cwd

@workspace_safe
def handle_git_status(ctx, query):
    require_workspace(ctx)
    rc, raw, cwd = _git(ctx, query.get('path', ''), ['rev-parse', '--is-inside-work-tree'])
    if rc != 0 or 'true' not in raw:
        return {'ok': False, 'isRepo': False, 'error': 'Not a git repository.'}
    rc, raw, _ = _git(ctx, query.get('path', ''), ['status', '--porcelain=v1', '--branch'])
    if rc != 0:
        return workspace_error('git status failed.')
    branch = ''
    entries = []
    for line in raw.splitlines():
        if line.startswith('##'):
            branch = line[2:].strip()
            continue
        if len(line) < 4:
            continue
        entries.append({'index': line[0], 'worktree': line[1], 'path': line[3:]})
    rc, raw, _ = _git(ctx, query.get('path', ''), ['rev-parse', '--short', 'HEAD'])
    head = raw.strip() if rc == 0 else ''
    return {'ok': True, 'isRepo': True, 'branch': branch, 'head': head, 'entries': entries}

@workspace_safe
def handle_git_diff(ctx, query):
    require_workspace(ctx)
    args = ['diff', '--no-color', '--unified=3']
    if query.get('staged') == '1':
        args.append('--cached')
    file = (query.get('file') or '').strip()
    if file:
        args += ['--', file]
    rc, raw, _ = _git(ctx, query.get('path', ''), args, timeout=20)
    if rc != 0:
        return workspace_error('git diff failed.')
    if len(raw) > 512 * 1024:
        raw = raw[:512 * 1024] + '\n…[truncated]'
    return {'ok': True, 'diff': raw}

@workspace_safe
def handle_git_stage(ctx, request):
    require_workspace(ctx)
    files = request.get('files')
    if not isinstance(files, list) or not files or len(files) > 200:
        return workspace_error('files must be a non-empty list (max 200).')
    for entry in files:
        if not isinstance(entry, str) or entry.startswith('/') or '..' in entry.split('/'):
            return workspace_error('Use workspace-relative paths.')
    rc, raw, _ = _git(ctx, request.get('path', ''), ['add', '--', *files])
    if rc != 0:
        return {'ok': False, 'error': raw.strip()[:400] or 'git add failed.'}
    return {'ok': True, 'message': f'Staged {len(files)} path(s).'}

@workspace_safe
def handle_git_commit(ctx, request):
    require_workspace(ctx)
    if request.get('confirm') is not True:
        raise ValueError('Commits require confirm:true from the client.')
    message = request.get('message')
    if not isinstance(message, str) or not message.strip() or len(message) > 4000:
        return workspace_error('message must be 1-4000 characters.')
    rc, raw, _ = _git(ctx, request.get('path', ''), ['commit', '-m', message], timeout=30)
    if rc != 0:
        return {'ok': False, 'error': raw.strip()[:400] or 'git commit failed.'}
    rc2, head, _ = _git(ctx, request.get('path', ''), ['rev-parse', '--short', 'HEAD'])
    return {'ok': True, 'message': 'Committed.', 'head': head.strip() if rc2 == 0 else ''}

@workspace_safe
def handle_git_log(ctx, query):
    require_workspace(ctx)
    limit = min(100, max(1, int(query.get('limit', 30))))
    fmt = '%h%x1f%an%x1f%ar%x1f%s'
    rc, raw, _ = _git(ctx, query.get('path', ''), ['log', f'-{limit}', f'--pretty=format:{fmt}'])
    if rc != 0:
        return workspace_error('git log failed.')
    commits = []
    for line in raw.splitlines():
        parts = line.split('\x1f')
        if len(parts) == 4:
            commits.append({'hash': parts[0], 'author': parts[1], 'when': parts[2], 'subject': parts[3]})
    return {'ok': True, 'commits': commits}


# --- PTY ---------------------------------------------------------------------

def workspace_tree_state(ctx, rel=''):
    require_workspace(ctx)
    """path -> (mtime, size) for every file under rel. Bounded."""
    state = {}
    root = ctx.workspace if not rel else workspace_resolve(ctx, rel)
    for path in _walk_workspace(ctx, rel, limit=5000):
        try:
            stat = path.stat()
            state[str(path.relative_to(ctx.workspace))] = (stat.st_mtime, stat.st_size)
        except OSError:
            continue
    return state


class PtySession:
    """One interactive shell in a PTY. Output is buffered and drained by the
    SSE stream endpoint; input arrives as base64 over POST."""

    def __init__(self, session_id, cwd, cols=80, rows=24):
        self.id = session_id
        self.cwd = str(cwd)
        self.buffer = bytearray()
        self.lock = threading.Lock()
        self.closed = False
        self.master, slave = pty.openpty()
        self._set_size(cols, rows)
        env = shell_env(self.cwd)
        env.update({'TERM': 'xterm-256color', 'FROSTBYTE_HOSTD': '1'})
        self.proc = subprocess.Popen(
            ['/bin/bash', '-l'], cwd=self.cwd, env=env,
            stdin=slave, stdout=slave, stderr=slave,
            preexec_fn=os.setsid, close_fds=True)
        os.close(slave)
        os.set_blocking(self.master, False)

    def _set_size(self, cols, rows):
        try:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ,
                        struct.pack('HHHH', int(rows), int(cols), 0, 0))
        except Exception:
            pass

    def drain(self):
        """Read whatever the shell has produced into the buffer."""
        with self.lock:
            while True:
                try:
                    chunk = os.read(self.master, 65536)
                except BlockingIOError:
                    break
                except OSError:
                    self.closed = True
                    break
                if not chunk:
                    self.closed = True
                    break
                self.buffer.extend(chunk)
                if len(self.buffer) > 4 * 1024 * 1024:      # bounded scrollback
                    del self.buffer[:len(self.buffer) - 4 * 1024 * 1024]

    def take(self):
        with self.lock:
            data = bytes(self.buffer)
            self.buffer.clear()
            return data

    def write(self, data):
        try:
            os.write(self.master, data)
        except OSError:
            self.closed = True

    def resize(self, cols, rows):
        self._set_size(cols, rows)

    @property
    def alive(self):
        return (not self.closed) and self.proc.poll() is None

    def close(self):
        self.closed = True
        if self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except Exception:
                with contextlib.suppress(Exception):
                    self.proc.terminate()
            try:
                self.proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except Exception:
                    with contextlib.suppress(Exception):
                        self.proc.kill()
                with contextlib.suppress(Exception):
                    self.proc.wait(timeout=1)
        try:
            os.close(self.master)
        except Exception:
            pass

@workspace_safe
def handle_pty_open(ctx, request):
    require_workspace(ctx)
    with ctx.pty_lock:
        live = [s for s in ctx.ptys.values() if s.alive]
        if len(live) >= MAX_PTY_SESSIONS:
            return workspace_error(f'At most {MAX_PTY_SESSIONS} terminals at once.')
        session_id = secrets.token_hex(8)
        cwd = ctx.workspace if not (request.get('cwd') or '').strip() else workspace_resolve(ctx, request['cwd'])
        session = PtySession(session_id, cwd,
                             cols=int(request.get('cols') or 80), rows=int(request.get('rows') or 24))
        ctx.ptys[session_id] = session
        # Reap dead sessions so the cap does not leak.
        for key, value in list(ctx.ptys.items()):
            if not value.alive:
                value.close()
                ctx.ptys.pop(key, None)
    return {'ok': True, 'id': session_id}

def _pty(ctx, session_id):
    with ctx.pty_lock:
        session = ctx.ptys.get(session_id)
    if session is None:
        raise ValueError('Unknown terminal session.')
    if not session.alive and session.closed:
        raise ValueError('That terminal has exited.')
    return session

@workspace_safe
def handle_pty_input(ctx, request):
    session = _pty(ctx, str(request.get('id', '')))
    try:
        encoded = request.get('data_b64', '')
        if not isinstance(encoded, str):
            raise ValueError
        data = base64.b64decode(encoded, validate=True)
    except Exception:
        return workspace_error('data_b64 must be valid base64.')
    if len(data) > 65536:
        return workspace_error('Input chunk too large.')
    session.write(data)
    return {'ok': True}

@workspace_safe
def handle_pty_resize(ctx, request):
    session = _pty(ctx, str(request.get('id', '')))
    session.resize(int(request.get('cols') or 80), int(request.get('rows') or 24))
    return {'ok': True}

@workspace_safe
def handle_pty_close(ctx, request):
    session = _pty(ctx, str(request.get('id', '')))
    session.close()
    with ctx.pty_lock:
        ctx.ptys.pop(session.id, None)
    return {'ok': True, 'message': 'Terminal closed.'}


def handle_diagnostics(ctx):
    """Bounded self-report for the operator console: identity, cadence, sampler
    health, recipe state and warnings. Read-only; never includes the token."""
    seq, sample = ctx.sampler.latest()
    age = None
    warnings = []
    if sample is not None:
        age = max(0.0, time.time() - float(sample.get('t', time.time())))
        warnings = list(sample.get('warnings') or [])
    _, recipe_warnings, recipes_loaded = ctx.recipe_book.all()
    warnings.extend(recipe_warnings)
    with ctx.stream_active_lock:
        active = ctx.stream_active
    boot = (_read_small(ctx.proc_root / 'sys/kernel/random/boot_id') or '').strip() or None
    return {'schema': SCHEMA,
            'name': DAEMON_NAME,
            'version': DAEMON_VERSION,
            'frigidCompatVersion': FRIGID_COMPAT_VERSION,
            'uptimeSec': round(time.monotonic() - ctx.started_monotonic, 1),
            'hostname': ctx.hostname,
            'platform': f'{platform.system()} {platform.release()} ({platform.machine()})',
            'python': '%d.%d.%d' % sys.version_info[:3],
            'samplerIntervalSec': round(float(ctx.sampler.interval), 2),
            'lastSampleAgeSec': None if age is None else round(age, 1),
            'sampleCount': seq,
            'streamClients': active,
            'recipesLoaded': bool(recipes_loaded),
            'recipesPath': str(ctx.recipe_book.path),
            'workspaceRoots': list((getattr(ctx, 'workspaces', None) or {}).keys()),
            'inferenceEndpoint': f'http://127.0.0.1:{ctx.endpoint_port}/v1',
            'tokenFingerprint': token_fingerprint(ctx.token),
            'bootID': boot,
            'warnings': warnings}


def handle_recipes(ctx):
    recipes, warnings, loaded = ctx.recipe_book.all()
    return {'schema': SCHEMA, 'loaded': loaded, 'warnings': warnings,
            'recipes': [{'id': r['id'], 'title': r['title'], 'kind': r['kind'],
                         'session': r.get('session'), 'container': r.get('container'),
                         'healthPort': r.get('healthPort'), 'modelFolder': r.get('modelFolder')} for r in recipes]}


# ---------------------------------------------------------------------------
# Fixed inference proxy. The upstream is always 127.0.0.1:endpoint_port.
# ---------------------------------------------------------------------------

def validate_inference_request(request):
    if not isinstance(request, dict):
        raise ValueError('Inference request must be a JSON object.')
    model = request.get('model')
    messages = request.get('messages')
    if not isinstance(model, str) or not model or len(model.encode('utf-8')) > 512:
        raise ValueError('Inference model must be a non-empty string (512-byte limit).')
    if not isinstance(messages, list) or not messages or len(messages) > 512:
        raise ValueError('Inference messages must be a non-empty list (max 512).')
    if request.get('stream', False) not in (True, False):
        raise ValueError('Inference stream must be a boolean.')

    pending = [(request, 0)]
    nodes = 0
    while pending:
        value, depth = pending.pop()
        nodes += 1
        if nodes > 50000 or depth > 16:
            raise ValueError('Inference JSON is too complex.')
        if value is None or isinstance(value, (str, bool, int)):
            continue
        if isinstance(value, float):
            if value != value or abs(value) == float('inf'):
                raise ValueError('Inference JSON contains a non-finite number.')
            continue
        if isinstance(value, list):
            if len(value) > 4096:
                raise ValueError('Inference JSON array is too large.')
            pending.extend((child, depth + 1) for child in value)
            continue
        if isinstance(value, dict):
            if len(value) > 256 or any(not isinstance(key, str) or len(key) > 256 for key in value):
                raise ValueError('Inference JSON object is invalid or too large.')
            pending.extend((child, depth + 1) for child in value.values())
            continue
        raise ValueError('Inference request contains an unsupported JSON value.')
    return request


def inference_upstream(ctx, method, route, payload=None, timeout=600):
    """Open one fixed loopback request. Caller owns and closes the connection."""
    if route not in ('/v1/models', '/v1/chat/completions'):
        raise ValueError('Unsupported inference route.')
    connection = http.client.HTTPConnection('127.0.0.1', ctx.endpoint_port, timeout=timeout)
    headers = {'Accept': 'text/event-stream, application/json',
               'Accept-Encoding': 'identity', 'Connection': 'close'}
    body = None
    if payload is not None:
        body = json.dumps(payload, allow_nan=False, separators=(',', ':')).encode('utf-8')
        if len(body) > INFERENCE_BODY_LIMIT:
            connection.close()
            raise ValueError('Inference request exceeds the 4 MB limit.')
        headers['Content-Type'] = 'application/json'
    connection.request(method, route, body=body, headers=headers)
    return connection, connection.getresponse()


# ---------------------------------------------------------------------------
# HTTP layer.
# ---------------------------------------------------------------------------

class Ctx:
    def __init__(self, token, recipe_book, sampler, hostname, lock_paths, receipts_path,
                 runner=subprocess.run, proc_root=PROC, home=None, workspace=None,
                 workspaces=None, endpoint_port=ENDPOINT_PORT):
        self.token = token
        self.recipe_book = recipe_book
        self.sampler = sampler
        self.hostname = hostname
        self.lock_paths = lock_paths
        self.receipts_path = receipts_path
        self.runner = runner
        self.proc_root = proc_root
        self.home = Path(home) if home else Path.home()
        roots = {key: Path(value).expanduser().resolve()
                 for key, value in (workspaces or {}).items()}
        if workspace and 'default' not in roots:
            roots['default'] = Path(workspace).expanduser().resolve()
        self.workspaces = roots
        self.default_workspace_id = ('default' if 'default' in roots
                                     else next(iter(roots), None))
        self.workspace_id = self.default_workspace_id or 'default'
        self.workspace = roots.get(self.default_workspace_id) if self.default_workspace_id else None
        self.endpoint_port = int(endpoint_port)
        if not 1 <= self.endpoint_port <= 65535:
            raise ValueError('Inference endpoint port must be between 1 and 65535.')
        self.ptys = {}
        self.pty_lock = threading.Lock()
        self.started_monotonic = time.monotonic()
        self.stopping = threading.Event()
        self.power_results = {}
        self.power_results_lock = threading.Lock()
        # Bounds daemon thread usage: each SSE stream holds one thread.
        self.stream_slots = threading.BoundedSemaphore(MAX_STREAM_CLIENTS)
        self.stream_active = 0
        self.stream_active_lock = threading.Lock()
        self.watch_slots = threading.BoundedSemaphore(MAX_WATCH_CLIENTS)
        self.pty_stream_slots = threading.BoundedSemaphore(MAX_PTY_SESSIONS)
        self.inference_slots = threading.BoundedSemaphore(MAX_INFERENCE_CLIENTS)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = f'{DAEMON_NAME}/{DAEMON_VERSION}'
    timeout = 60

    # -- helpers -------------------------------------------------------------
    def _json(self, obj, code=200):
        payload = json.dumps(obj, allow_nan=False).encode('utf-8')
        self._raw(payload, code, 'application/json')

    def _raw(self, payload, code=200, content_type='application/octet-stream'):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self, limit=None):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return None
        limit = limit or BODY_LIMIT
        if length <= 0 or length > limit:
            return None
        return self.rfile.read(length)

    def _guard(self, needs_auth=True):
        """Returns None if OK, else sends the error response and returns True."""
        ctx = self.server.ctx
        if not host_ok(self.headers):
            self.close_connection = True
            self._json({'ok': False, 'message': 'Unexpected Host header.'}, 421)
            return True
        if not origin_ok(self.headers):
            self.close_connection = True
            self._json({'ok': False, 'message': 'Browser origins are refused; frostbyte-hostd serves native clients only.'}, 403)
            return True
        if needs_auth and not check_auth(self.headers, ctx.token):
            self.close_connection = True
            self._json({'ok': False, 'message': 'Bearer token required.'}, 401)
            return True
        return None

    def _proxy_inference(self, ctx, method, route, payload=None):
        if not ctx.inference_slots.acquire(blocking=False):
            self._json({'error': {'message': 'Inference proxy is at its four-request concurrency limit.'}}, 503)
            return
        connection = None
        headers_sent = False
        try:
            if payload is not None:
                try:
                    payload = validate_inference_request(payload)
                except ValueError as error:
                    self._json({'error': {'message': str(error)[:512]}}, 400)
                    return
            streaming = bool(payload and payload.get('stream') is True)
            connection, upstream = inference_upstream(ctx, method, route, payload)
            content_type = upstream.getheader('Content-Type') or ''
            media_type = content_type.partition(';')[0].strip().lower()
            content_encoding = upstream.getheader('Content-Encoding')
            if content_encoding is not None and content_encoding.strip().lower() not in ('', 'identity'):
                raise ValueError('Compressed inference responses are refused.')
            length = upstream.getheader('Content-Length')
            response_limit = INFERENCE_STREAM_LIMIT if streaming else INFERENCE_RESPONSE_LIMIT
            if length is not None and (not length.isdigit() or int(length) > response_limit):
                raise ValueError('Inference response length is invalid or exceeds the limit.')

            if streaming and 200 <= upstream.status < 300:
                if media_type != 'text/event-stream':
                    raise ValueError('Inference stream did not return text/event-stream.')
                self.send_response(upstream.status)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
                headers_sent = True
                total = 0
                while True:
                    # SSE is line-oriented. read(64 KiB) waits for the full amount on
                    # chunked HTTP responses and would turn token streaming into one
                    # buffered response, so forward each bounded line as it arrives.
                    chunk = upstream.readline(64 * 1024 + 1)
                    if not chunk:
                        break
                    if len(chunk) > 64 * 1024:
                        break
                    total += len(chunk)
                    if total > INFERENCE_STREAM_LIMIT:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                return

            body = upstream.read(INFERENCE_RESPONSE_LIMIT + 1)
            if len(body) > INFERENCE_RESPONSE_LIMIT:
                raise ValueError('Inference response exceeds the 8 MB limit.')
            if not 200 <= upstream.status < 300:
                self._json({'error': {'message': f'Inference endpoint rejected the request (HTTP {upstream.status}).'}},
                           upstream.status if 400 <= upstream.status <= 599 else 502)
                return
            if media_type != 'application/json':
                raise ValueError('Inference endpoint did not return JSON.')
            try:
                json.loads(body.decode('utf-8'), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            except Exception as error:
                raise ValueError('Inference endpoint returned invalid JSON.') from error
            self._raw(body, upstream.status, 'application/json')
        except (OSError, http.client.HTTPException, ValueError) as error:
            if not headers_sent:
                self._json({'error': {'message': str(error)[:512] or 'Inference endpoint is unavailable.'}}, 502)
        finally:
            if connection is not None:
                connection.close()
            ctx.inference_slots.release()

    # -- routing ---------------------------------------------------------------
    def do_GET(self):
        path, _, query = self.path.partition('?')
        if getattr(self.server.ctx, 'spark_profile', False) and path in {
                '/v1/workspace', '/v1/workspaces', '/v1/fs/list', '/v1/fs/read',
                '/v1/fs/watch', '/v1/search', '/v1/git/status', '/v1/git/diff',
                '/v1/git/log', '/v1/pty/stream', '/v1/models'}:
            self._json({'ok': False, 'message': 'Route unavailable in Spark profile.'}, 404)
            return
        if path == '/v1/info':
            if self._guard(needs_auth=False):
                return
            capabilities = ['telemetry-v1', 'recipes-v1', 'model-control-v1',
                            'inference-proxy-v1', 'power-status',
                            'exact-tmux-targets', 'diagnostics']
            if getattr(self.server.ctx, 'spark_profile', False):
                capabilities = ['telemetry-v1', 'recipes-v1', 'model-control-v1', 'power-status', 'diagnostics', 'spark-profile-v1', 'review-bound-control-v1']
            if self.server.ctx.workspaces or self.server.ctx.workspace:
                capabilities.extend(['workspace-v1', 'workspace-v2', 'workspace-roots-v1'])
            # The endpoint doubles as the unauthenticated pairing probe, so it
            # answers without a token — but host identity (hostname, boot ID)
            # is recon material and is only disclosed to a valid bearer token.
            authenticated = check_auth(self.headers, self.server.ctx.token)
            self._json({'name': DAEMON_NAME, 'version': DAEMON_VERSION, 'schema': SCHEMA,
                        'frigidCompatVersion': FRIGID_COMPAT_VERSION,
                        # A non-empty placeholder preserves the strict client
                        # schema without disclosing host identity pre-pairing.
                        'hostname': self.server.ctx.hostname if authenticated else 'redacted',
                        'bootID': ((_read_small(self.server.ctx.proc_root / 'sys/kernel/random/boot_id') or '').strip() or None) if authenticated else None,
                        'authenticated': authenticated,
                        'capabilities': capabilities})
            return
        if self._guard():
            return
        ctx = self.server.ctx
        params = dict(urllib.parse.parse_qsl(query, keep_blank_values=True))
        workspace_paths = {'/v1/workspace', '/v1/fs/list', '/v1/fs/read', '/v1/search',
                           '/v1/git/status', '/v1/git/diff', '/v1/git/log',
                           '/v1/fs/watch', '/v1/pty/stream'}
        if path in workspace_paths:
            try:
                ctx = workspace_context(ctx, params.get('root'))
            except ValueError as error:
                self._json({'ok': False, 'error': str(error)}, 400)
                return
        if path == '/v1/snapshot':
            self._json(collect(proc_root=ctx.proc_root, runner=ctx.runner, home=ctx.home,
                               endpoint_port=ctx.endpoint_port))
        elif path == '/v1/processes':
            self._json(handle_processes(ctx))
        elif path == '/v1/services':
            self._json(handle_services(ctx))
        elif path == '/v1/recipes':
            self._json(handle_recipes(ctx))
        elif path == '/v1/diagnostics':
            self._json(handle_diagnostics(ctx))
        elif path == '/v1/models':
            self._proxy_inference(ctx, 'GET', '/v1/models')
        elif path == '/v1/workspaces':
            self._json(handle_workspaces(ctx))
        elif path == '/v1/workspace':
            self._json(handle_workspace(ctx))
        elif path == '/v1/fs/list':
            self._json(handle_fs_list(ctx, params))
        elif path == '/v1/fs/read':
            self._json(handle_fs_read(ctx, params))
        elif path == '/v1/search':
            self._json(handle_search(ctx, params))
        elif path == '/v1/git/status':
            self._json(handle_git_status(ctx, params))
        elif path == '/v1/git/diff':
            self._json(handle_git_diff(ctx, params))
        elif path == '/v1/git/log':
            self._json(handle_git_log(ctx, params))
        elif path == '/v1/fs/watch':
            self._watch(ctx, params)
        elif path == '/v1/pty/stream':
            self._pty_stream(ctx, params)
        elif path == '/v1/stream':
            self._stream(ctx)
        elif path.startswith('/v1/power/status/'):
            operation_id = path.rsplit('/', 1)[-1]
            with ctx.power_results_lock:
                result = ctx.power_results.get(operation_id)
            self._json(result or {'ok': False, 'state': 'unknown', 'message': 'Operation is not available; do not infer success.'},
                       200 if result else 404)
        else:
            self._json({'ok': False, 'message': 'Unknown endpoint.'}, 404)

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if getattr(self.server.ctx, 'spark_profile', False) and path not in {
                '/v1/control', '/v1/power'}:
            self._json({'ok': False, 'message': 'Route unavailable in Spark profile.'}, 404)
            return
        if self._guard():
            return
        ctx = self.server.ctx
        # Workspace writes carry base64; inference carries bounded prompt/tool
        # JSON. Every other endpoint stays at the original 64 KiB ceiling.
        limit = (FS_WRITE_BODY_LIMIT if path == '/v1/fs/write'
                 else INFERENCE_BODY_LIMIT if path == '/v1/chat/completions'
                 else BODY_LIMIT)
        raw = self._read_body(limit=limit)
        if raw is None:
            self._json({'ok': False, 'message': 'Body missing or over the size limit.'}, 400)
            return
        try:
            request = json.loads(raw)
        except Exception:
            self._json({'ok': False, 'message': 'Body must be JSON.'}, 400)
            return
        workspace_paths = {'/v1/fs/write', '/v1/fs/mkdir', '/v1/fs/rename',
                           '/v1/fs/delete', '/v1/exec', '/v1/git/stage',
                           '/v1/git/commit', '/v1/pty/open', '/v1/pty/input',
                           '/v1/pty/resize', '/v1/pty/close'}
        if path in workspace_paths:
            try:
                ctx = workspace_context(ctx, request.get('root') if isinstance(request, dict) else None)
            except ValueError as error:
                self._json({'ok': False, 'error': str(error)}, 400)
                return
        if path == '/v1/control':
            self._json(handle_control(request, ctx))
        elif path == '/v1/chat/completions':
            self._proxy_inference(ctx, 'POST', '/v1/chat/completions', request)
        elif path == '/v1/fs/write':
            self._json(handle_fs_write(ctx, request))
        elif path == '/v1/fs/mkdir':
            self._json(handle_fs_mkdir(ctx, request))
        elif path == '/v1/fs/rename':
            self._json(handle_fs_rename(ctx, request))
        elif path == '/v1/fs/delete':
            self._json(handle_fs_delete(ctx, request))
        elif path == '/v1/exec':
            self._json(handle_exec(ctx, request))
        elif path == '/v1/git/stage':
            self._json(handle_git_stage(ctx, request))
        elif path == '/v1/git/commit':
            self._json(handle_git_commit(ctx, request))
        elif path == '/v1/pty/open':
            self._json(handle_pty_open(ctx, request))
        elif path == '/v1/pty/input':
            self._json(handle_pty_input(ctx, request))
        elif path == '/v1/pty/resize':
            self._json(handle_pty_resize(ctx, request))
        elif path == '/v1/pty/close':
            self._json(handle_pty_close(ctx, request))
        elif path == '/v1/power':
            response, deferred = handle_power(request, ctx)
            try:
                self._json(response)
                self.wfile.flush()
            except OSError:
                if deferred is not None:
                    deferred.cancel()
                return
            if deferred is not None:
                timer = threading.Timer(POWER_DELAY_SEC, deferred)
                timer.daemon = True
                timer.start()
        else:
            self._json({'ok': False, 'message': 'Unknown endpoint.'}, 404)

    # -- workspace SSE --------------------------------------------------------

    def _sse_headers(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True

    def _watch(self, ctx, query):
        """Emit changed paths as they appear. Poll-based: portable across Linux
        and macOS, and honest about it in the event payload."""
        if not ctx.workspace:
            self._json({'ok': False, 'error': 'Workspace is not enabled.'}, 400)
            return
        rel = (query.get('path') or '').strip()
        try:
            state = workspace_tree_state(ctx, rel)
        except ValueError as error:
            self._json({'ok': False, 'error': str(error)}, 400)
            return
        if not ctx.watch_slots.acquire(blocking=False):
            self.close_connection = True
            self._json({'ok': False,
                        'message': f'More than {MAX_WATCH_CLIENTS} concurrent workspace watchers; close another client first.'},
                       503)
            return
        try:
            self._sse_headers()
            opened = time.monotonic()
            self.wfile.write(b'event: ready\ndata: {"ok": true}\n\n')
            self.wfile.flush()
            while not ctx.stopping.is_set() and time.monotonic() - opened < 3600:
                time.sleep(WATCH_INTERVAL)
                try:
                    current = workspace_tree_state(ctx, rel)
                except Exception:
                    continue
                changed = [p for p in current if state.get(p) != current[p]]
                removed = [p for p in state if p not in current]
                if changed or removed:
                    payload = json.dumps({'changed': changed[:200], 'removed': removed[:200]})
                    self.wfile.write(('event: change\ndata: ' + payload + '\n\n').encode('utf-8'))
                    self.wfile.flush()
                state = current
                self.wfile.write(b'event: tick\ndata: {}\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            ctx.watch_slots.release()

    def _pty_stream(self, ctx, query):
        session_id = (query.get('id') or '').strip()
        try:
            session = _pty(ctx, session_id)
        except ValueError as error:
            self._json({'ok': False, 'error': str(error)}, 404)
            return
        if not ctx.pty_stream_slots.acquire(blocking=False):
            self.close_connection = True
            self._json({'ok': False,
                        'message': f'More than {MAX_PTY_SESSIONS} concurrent terminal streams; close another client first.'},
                       503)
            return
        try:
            self._sse_headers()
            last_ping = time.monotonic()
            try:
                while not ctx.stopping.is_set():
                    session.drain()
                    data = session.take()
                    if data:
                        payload = json.dumps({'b64': base64.b64encode(data).decode('ascii')})
                        self.wfile.write(('event: output\ndata: ' + payload + '\n\n').encode('utf-8'))
                        self.wfile.flush()
                        last_ping = time.monotonic()
                    elif time.monotonic() - last_ping >= 15:
                        self.wfile.write(b'event: ping\ndata: {}\n\n')
                        self.wfile.flush()
                        last_ping = time.monotonic()
                    if not session.alive and not data:
                        self.wfile.write(b'event: exit\ndata: {"ok": true}\n\n')
                        self.wfile.flush()
                        break
                    time.sleep(0.05)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        finally:
            ctx.pty_stream_slots.release()

    # -- SSE -------------------------------------------------------------------
    def _stream(self, ctx):
        if not ctx.stream_slots.acquire(blocking=False):
            self.close_connection = True
            self._json({'ok': False,
                        'message': f'More than {MAX_STREAM_CLIENTS} concurrent telemetry streams; close another client first.'},
                       503)
            return
        try:
            with ctx.stream_active_lock:
                ctx.stream_active += 1
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            last_seq = -1
            last_ping = time.monotonic()
            frames = 0
            opened = time.monotonic()
            # Stream requests never complete through log_request while open, so the
            # lifecycle gets its own two lean lines (no headers, no tokens).
            sys.stderr.write(f'{DAEMON_NAME}: {self.address_string()} stream opened\n')
            try:
                while not ctx.stopping.is_set():
                    seq, sample = ctx.sampler.latest()
                    now = time.monotonic()
                    if sample is not None and seq != last_seq:
                        last_seq = seq
                        frame = ('event: sample\ndata: ' +
                                 json.dumps(sample, allow_nan=False) + '\n\n')
                        self.wfile.write(frame.encode('utf-8'))
                        self.wfile.flush()
                        frames += 1
                        last_ping = now
                    elif now - last_ping >= 15:
                        self.wfile.write(b'event: ping\ndata: {}\n\n')
                        self.wfile.flush()
                        last_ping = now
                    time.sleep(0.2)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                sys.stderr.write(f'{DAEMON_NAME}: {self.address_string()} stream closed '
                                 f'after {frames} frames, {time.monotonic() - opened:.1f}s\n')
        finally:
            with ctx.stream_active_lock:
                ctx.stream_active = max(0, ctx.stream_active - 1)
            ctx.stream_slots.release()

    def log_message(self, fmt, *args):
        # Keep journal output lean; never log headers or tokens.
        if self.path.split('?', 1)[0] != '/v1/stream':
            sys.stderr.write(f'{DAEMON_NAME}: {self.address_string()} {fmt % args}\n')


def ctx_port(server):
    return server.server_address[1]


class FrostByteHostServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, ctx):
        self.ctx = ctx
        super().__init__(address, Handler)

    def handle_error(self, request, client_address):
        # Native clients commonly close an HTTP/1.1 keep-alive socket after the
        # response. Treat that reset as routine rather than dumping a traceback.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def build_ctx(args):
    state_dir = Path(args.state_dir).expanduser()
    token = load_token(args.token_file)
    recipe_book = RecipeBook(args.recipes)
    lock_paths = [str(state_dir / 'controls.lock'),
                  f'/run/user/{os.getuid()}/frostbyte-hostd-controls.lock']
    receipts_path = Path(args.receipts) if args.receipts else Path(args.token_file).expanduser().parent / 'receipts.jsonl'
    sampler = Sampler(recipe_book, proc_root=Path(args.proc_root), endpoint_port=args.endpoint_port,
                      interval=args.interval)
    workspaces = parse_workspace_specs(getattr(args, 'workspace', None))
    return Ctx(token=token, recipe_book=recipe_book, sampler=sampler,
               hostname=socket.gethostname(), lock_paths=lock_paths,
               receipts_path=str(receipts_path), home=None,  # home defaults to Path.home()
               proc_root=Path(args.proc_root),   # --proc-root must reach /v1/snapshot too
               workspaces=workspaces, endpoint_port=args.endpoint_port)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Private FrostByte host-management sidecar')
    parser.add_argument('--version', action='version', version=f'{DAEMON_NAME} {DAEMON_VERSION}')
    parser.add_argument('--host', choices=(DEFAULT_HOST,), default=DEFAULT_HOST,
                        help='loopback listener (default: 127.0.0.1)')
    parser.add_argument('--bind-lan', action='store_true',
                        help='explicitly expose plain HTTP on 0.0.0.0; trusted LANs only')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--token-file', default='~/.frostbyte/hostd/token')
    parser.add_argument('--recipes', default='~/.frostbyte/hostd/recipes.json')
    parser.add_argument('--state-dir', default='~/.frostbyte/hostd')
    parser.add_argument('--receipts', default=None)
    parser.add_argument('--proc-root', default=str(PROC))
    parser.add_argument('--endpoint-port', type=int, default=ENDPOINT_PORT)
    parser.add_argument('--workspace', action='append', default=[], metavar='[ID=]PATH',
                        help='enable an explicit jailed root; repeat for multiple named roots')
    parser.add_argument('--interval', type=float, default=1.0)
    parser.add_argument('--once', action='store_true',
                        help='print one snapshot JSON and exit (debug; no server, no token needed)')
    parser.add_argument('--spark-profile', action='store_true',
                        help='restrict the daemon to Spark device-management routes only')
    args = parser.parse_args(argv)
    args.token_file = os.path.expanduser(args.token_file)
    args.recipes = os.path.expanduser(args.recipes)
    args.state_dir = os.path.expanduser(args.state_dir)
    if not 1 <= args.port <= 65535 or not 1 <= args.endpoint_port <= 65535:
        parser.error('ports must be between 1 and 65535')
    if not 0.1 <= args.interval <= 60:
        parser.error('interval must be between 0.1 and 60 seconds')
    bind_host = '0.0.0.0' if args.bind_lan else args.host

    if args.once:
        print(json.dumps(collect(proc_root=Path(args.proc_root)), allow_nan=False))
        return 0

    ctx = build_ctx(args)
    ctx.spark_profile = bool(args.spark_profile)
    server = FrostByteHostServer((bind_host, args.port), ctx)
    ctx.sampler.start()

    def sigterm(*_):
        ctx.stopping.set()
        ctx.sampler.stop()
        # shutdown() from the signal handler deadlocks; run it off-thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, sigterm)
    signal.signal(signal.SIGINT, sigterm)
    print(f'{DAEMON_NAME} {DAEMON_VERSION} listening on {bind_host}:{args.port} '
          f'(token {token_fingerprint(ctx.token)})', flush=True)
    if args.bind_lan:
        print(f'{DAEMON_NAME}: WARNING: LAN mode sends bearer credentials over plain HTTP; '
              'use only on a restricted trusted network or tunnel.', file=sys.stderr, flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        ctx.stopping.set()
        ctx.sampler.stop()
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
