"""Fixed SSH-to-loopback adapter. No token, arbitrary URL or shell reaches the app."""
# Bump when the device:telemetry contract gains fields; the desktop uses it to detect a stale paired helper.
BRIDGE_REVISION = 2
import datetime
import http.client
import json
import os
import platform
import re
import stat
import time


def _net_totals():
    """Sum rx/tx bytes over non-loopback interfaces, or None when unreadable."""
    try:
        with open('/proc/net/dev', encoding='ascii', errors='replace') as handle:
            lines = handle.read(256 * 1024).splitlines()[2:]
        rx = tx = 0
        for line in lines:
            name, sep, rest = line.partition(':')
            parts = rest.split()
            if not sep or name.strip() == 'lo' or len(parts) < 9:
                continue
            rx, tx = rx + int(parts[0]), tx + int(parts[8])
        return rx, tx, time.monotonic()
    except (OSError, ValueError):
        return None


def _metric(value, low=0.0, high=1e15):
    """A finite measured number inside bounds, else None (never a fabricated zero)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or not low <= value <= high:
        return None
    return round(float(value), 2)


def spark_hostd_request(request):
    action = request.get('action') if isinstance(request, dict) else None
    allowed = {'action'} if action in ('device:telemetry', 'device:recipes') else {'action', 'operation', 'recipeId', 'reviewDigest'}
    if action not in ('device:telemetry', 'device:recipes', 'device:control') or set(request) - allowed:
        raise ValueError('Unsupported device-management request.')
    if action == 'device:control':
        if request.get('operation') not in ('check', 'start', 'stop') or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', str(request.get('recipeId', ''))):
            raise ValueError('Choose an approved model recipe and operation.')
        if request['operation'] != 'check' and not re.fullmatch(r'[a-f0-9]{64}', str(request.get('reviewDigest', ''))):
            raise ValueError('Review this exact model recipe before changing it.')

    token_path = os.path.expanduser('~/.config/frostbyte/hostd/token')
    try:
        descriptor = os.open(token_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077 or not 1 <= info.st_size <= 4096:
                raise ValueError('The FrostByte host-service token must be a private owned file.')
            token = os.read(descriptor, 4097).decode().strip()
        finally:
            os.close(descriptor)
    except OSError:
        raise ValueError('Install the restricted FrostByte host service on this Spark first.') from None
    if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise ValueError('The FrostByte host-service token is invalid.')

    def call(route, body=None):
        # http.client does not honor proxy environment variables or follow redirects.
        connection = http.client.HTTPConnection('127.0.0.1', 8758, timeout=60 if body else 20)
        try:
            connection.request('POST' if body else 'GET', route, json.dumps(body) if body else None,
                               {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(2 * 1024 * 1024 + 1)
            if response.status != 200 or len(raw) > 2 * 1024 * 1024:
                raise ValueError('The restricted host service rejected this request. Check its installation.')
            result = json.loads(raw)
            if not isinstance(result, dict) or result.get('schema', 1) != 1:
                raise ValueError('The host service returned an unsupported response.')
            return result
        except (OSError, http.client.HTTPException):
            raise ValueError('Cannot reach the restricted FrostByte host service on Spark localhost:8758.') from None
        finally:
            connection.close()

    info = call('/v1/info')
    if info.get('name') != 'frostbyte-hostd' or not info.get('authenticated') or 'spark-profile-v1' not in info.get('capabilities', []):
        raise ValueError('The host service must use the restricted Spark profile.')
    if action == 'device:telemetry':
        net_before = _net_totals()
        snap = call('/v1/snapshot')
        net_after = _net_totals()
        network = {'rxBytesPerSecond': None, 'txBytesPerSecond': None}
        if net_before and net_after and net_after[2] - net_before[2] >= 0.1:
            elapsed = net_after[2] - net_before[2]
            network = {'rxBytesPerSecond': _metric(max(0, net_after[0] - net_before[0]) / elapsed),
                       'txBytesPerSecond': _metric(max(0, net_after[1] - net_before[1]) / elapsed)}
        endpoint = snap.get('endpoint') if isinstance(snap.get('endpoint'), dict) else {}
        memory, disk = snap.get('memory') or {}, snap.get('disk') or {}
        containers = snap.get('containers') or []
        docker_available = not any('Docker inventory unavailable' in text for text in snap.get('warnings', []))
        gpu = snap.get('gpu') if isinstance(snap.get('gpu'), dict) else {}
        gpu_name = str(gpu.get('name') or 'Unavailable')[:128]
        gpu_present = gpu_name != 'Unavailable'
        return {'schema': 1, 'bridgeRevision': BRIDGE_REVISION, 'collectedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'hostname': info['hostname'], 'architecture': platform.machine(), 'uptimeSeconds': snap.get('uptime'),
                'load': list(os.getloadavg()), 'memory': {'totalBytes': memory.get('total', 0), 'freeBytes': memory.get('available', 0)},
                'storage': {'path': os.path.expanduser('~'), 'totalBytes': disk.get('total', 0), 'freeBytes': disk.get('available', 0), 'available': bool(disk.get('total'))},
                'docker': {'available': docker_available, 'containers': [{k: row.get(k, '') for k in ('name', 'state', 'status', 'image')} for row in containers[:64]]},
                'cpu': {'utilizationPercent': _metric(snap.get('cpu'), 0, 100)},
                'gpu': {'name': gpu_name if gpu_present else '', 'temperatureC': _metric(gpu.get('temperature'), -50, 200) if gpu_present else None,
                        'utilizationPercent': _metric(gpu.get('utilization'), 0, 100) if gpu_present else None,
                        'powerWatts': _metric(gpu.get('power'), 0, 5000) if gpu_present else None},
                'network': network,
                'endpoint': {'state': endpoint.get('state') if endpoint.get('state') in ('ready', 'auth-required', 'not-ready', 'unreachable') else 'unknown',
                             'port': endpoint.get('port') if isinstance(endpoint.get('port'), int) and 0 < endpoint.get('port') < 65536 else None},
                'capabilities': {'docker': docker_available, 'gpu': gpu_present, 'power': False}}
    book = call('/v1/recipes')
    recipes = book.get('recipes', [])
    if not isinstance(recipes, list) or len(recipes) > 32:
        raise ValueError('The host service returned too many model recipes.')
    if action == 'device:recipes':
        snapshot = call('/v1/snapshot')
        containers = {row.get('name'): row.get('state', 'unknown') for row in snapshot.get('containers', [])}
        return {'schema': 1, 'recipes': [{'id': row['id'], 'title': row['title'], 'kind': row['kind'],
                'state': containers.get(row.get('container'), 'missing') if row['kind'] == 'docker' else 'unknown',
                'available': row.get('container') in containers if row['kind'] == 'docker' else True} for row in recipes]}
    recipe = next((row for row in recipes if row.get('id') == request['recipeId']), None)
    if recipe is None:
        raise ValueError('This model recipe is not approved on the selected Spark.')
    if 'review-bound-control-v1' not in info.get('capabilities', []):
        raise ValueError('Update the restricted host service before using model controls.')
    result = call('/v1/control', {'action': request['operation'], 'target': recipe['id'], 'kind': recipe['kind'],
                                 'host': info['hostname'], 'confirm': True, 'reviewDigest': request.get('reviewDigest')})
    return {'schema': 1, 'operation': request['operation'], 'recipeId': recipe['id'],
            'state': ('ready' if request['operation'] == 'check' else result.get('state', 'unknown')) if result.get('ok') else 'blocked',
            'observedState': str(result.get('state', 'unknown')), 'message': str(result.get('message', ''))[:1000],
            'reviewDigest': result.get('reviewDigest', '')}
