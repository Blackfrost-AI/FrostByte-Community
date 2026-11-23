import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


bridge = load('spark_bridge', 'src/hostd/spark_bridge.py')
hostd = load('hostd_review', 'src/hostd/frostbyte_hostd.py')


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.token = Path(self.folder.name) / 'token'
        self.token.write_text('fixture-only-token-not-a-real-credential')
        self.token.chmod(0o600)
        self.calls = []
        self.responses = {
            '/v1/info': {'schema': 1, 'name': 'frostbyte-hostd', 'hostname': 'test-spark', 'authenticated': True,
                         'capabilities': ['spark-profile-v1', 'review-bound-control-v1']},
            '/v1/snapshot': {'schema': 1, 'uptime': 3601, 'memory': {'total': 1000, 'available': 400},
                             'disk': {'total': 2000, 'available': 500}, 'containers': [], 'warnings': []},
            '/v1/recipes': {'schema': 1, 'recipes': [{'id': 'old', 'title': 'Old model', 'kind': 'docker', 'container': 'missing-model'}]},
            '/v1/control': {'ok': False, 'state': 'unverified', 'message': 'Container is missing.'},
        }
        owner = self

        class Connection:
            def __init__(self, host, port, **kwargs):
                owner.assertEqual((host, port), ('127.0.0.1', 8758))
            def request(self, method, route, body, headers):
                self.route = route
                owner.calls.append((method, route, json.loads(body) if body else None))
                owner.assertTrue(headers['Authorization'].startswith('Bearer '))
            def getresponse(self):
                return types.SimpleNamespace(status=200, read=lambda size: json.dumps(owner.responses[self.route]).encode())
            def close(self):
                pass

        patch = mock.patch.object(bridge.http.client, 'HTTPConnection', Connection)
        patch.start(); self.addCleanup(patch.stop)
        expand = mock.patch.object(bridge.os.path, 'expanduser', lambda value: str(self.token) if value.endswith('/token') else self.folder.name)
        expand.start(); self.addCleanup(expand.stop)

    def test_telemetry_and_missing_recipe_are_truthful(self):
        result = bridge.spark_hostd_request({'action': 'device:telemetry'})
        self.assertEqual(result['uptimeSeconds'], 3601)
        self.assertEqual(result['memory'], {'totalBytes': 1000, 'freeBytes': 400})
        recipes = bridge.spark_hostd_request({'action': 'device:recipes'})['recipes']
        self.assertEqual(recipes[0]['state'], 'missing')
        self.assertFalse(recipes[0]['available'])
        self.assertNotIn(self.token.read_text(), json.dumps(result))
        self.assertTrue(all(call[0] == 'GET' for call in self.calls))
        # Missing hardware readings stay absent instead of becoming zeros.
        self.assertEqual(result['gpu'], {'name': '', 'temperatureC': None, 'utilizationPercent': None, 'powerWatts': None})
        self.assertEqual(result['cpu'], {'utilizationPercent': None})
        self.assertFalse(result['capabilities']['gpu'])
        self.assertEqual(result['endpoint'], {'state': 'unknown', 'port': None})

    def test_telemetry_passes_measured_gpu_cpu_network_and_endpoint(self):
        self.responses['/v1/snapshot'].update({'cpu': 37.5, 'gpu': {'name': 'NVIDIA GB10', 'temperature': 61.0, 'utilization': 88.0, 'power': 42.5},
                                               'endpoint': {'state': 'ready', 'port': 30000, 'detail': 'internal detail not forwarded'}})
        totals = iter([(1000, 2000, 10.0), (3000, 2500, 10.5)])
        with mock.patch.object(bridge, '_net_totals', lambda: next(totals)):
            result = bridge.spark_hostd_request({'action': 'device:telemetry'})
        self.assertEqual(result['gpu'], {'name': 'NVIDIA GB10', 'temperatureC': 61.0, 'utilizationPercent': 88.0, 'powerWatts': 42.5})
        self.assertEqual(result['cpu'], {'utilizationPercent': 37.5})
        self.assertEqual(result['network'], {'rxBytesPerSecond': 4000.0, 'txBytesPerSecond': 1000.0})
        self.assertEqual(result['endpoint'], {'state': 'ready', 'port': 30000})
        self.assertTrue(result['capabilities']['gpu'])
        self.assertEqual(result['bridgeRevision'], bridge.BRIDGE_REVISION)

    def test_telemetry_rejects_garbage_readings(self):
        self.responses['/v1/snapshot'].update({'cpu': 'NaN', 'gpu': {'name': 'NVIDIA GB10', 'temperature': float('nan'), 'utilization': 250, 'power': True},
                                               'endpoint': {'state': '<script>', 'port': 99999}})
        with mock.patch.object(bridge, '_net_totals', lambda: None):
            result = bridge.spark_hostd_request({'action': 'device:telemetry'})
        self.assertEqual(result['gpu'], {'name': 'NVIDIA GB10', 'temperatureC': None, 'utilizationPercent': None, 'powerWatts': None})
        self.assertEqual(result['cpu'], {'utilizationPercent': None})
        self.assertEqual(result['network'], {'rxBytesPerSecond': None, 'txBytesPerSecond': None})
        self.assertEqual(result['endpoint'], {'state': 'unknown', 'port': None})

    def test_no_general_routes_or_unreviewed_mutations(self):
        for request in [{'action': 'device:power'}, {'action': 'device:telemetry', 'url': 'https://elsewhere.invalid'},
                        {'action': 'device:control', 'operation': 'start', 'recipeId': 'old'}]:
            with self.assertRaises(ValueError):
                bridge.spark_hostd_request(request)
        self.assertEqual(self.calls, [])

    def test_refuses_unrestricted_service_and_exposed_token(self):
        self.responses['/v1/info']['capabilities'] = []
        with self.assertRaisesRegex(ValueError, 'restricted Spark profile'):
            bridge.spark_hostd_request({'action': 'device:telemetry'})
        self.token.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'private owned file'):
            bridge.spark_hostd_request({'action': 'device:telemetry'})

    def test_control_preserves_rejection_and_exact_review(self):
        result = bridge.spark_hostd_request({'action': 'device:control', 'operation': 'check', 'recipeId': 'old'})
        self.assertEqual(result['state'], 'blocked')
        self.assertEqual(self.calls[-1][2]['target'], 'old')
        self.assertEqual(self.calls[-1][2]['host'], 'test-spark')


class ReviewTest(unittest.TestCase):
    def test_review_binds_recipe_and_physical_container(self):
        with tempfile.TemporaryDirectory() as folder:
            recipe = {'id': 'demo', 'title': 'Demo', 'kind': 'docker', 'container': 'model-a', 'healthPort': 30000}
            ctx = types.SimpleNamespace(recipe_book=types.SimpleNamespace(get=lambda target: dict(recipe)),
                                        hostname='test-spark', proc_root=Path(folder), spark_profile=True,
                                        lock_paths=[], receipts_path=Path(folder) / 'receipts', runner=None)
            target = {'id': 'a' * 64}
            with mock.patch.object(hostd, 'docker_inspect', side_effect=lambda *args: dict(target)), \
                 mock.patch.object(hostd, 'docker_control', return_value={'ok': True, 'state': 'exited', 'message': 'Checked.'}) as control:
                request = {'action': 'check', 'kind': 'docker', 'target': 'demo', 'host': 'test-spark', 'confirm': True}
                checked = hostd.handle_control(request, ctx)
                self.assertTrue(checked['ok'])
                control.reset_mock()
                change = {**request, 'action': 'start', 'reviewDigest': checked['reviewDigest']}
                recipe['container'] = 'model-b'
                self.assertFalse(hostd.handle_control(change, ctx)['ok'])
                control.assert_not_called()
                recipe['container'] = 'model-a'; target['id'] = 'b' * 64
                self.assertFalse(hostd.handle_control(change, ctx)['ok'])
                control.assert_not_called()
                target['id'] = 'a' * 64
                self.assertTrue(hostd.handle_control(change, ctx)['ok'])
                self.assertEqual(control.call_args.kwargs['expected_id'], 'a' * 64)


if __name__ == '__main__':
    unittest.main()
