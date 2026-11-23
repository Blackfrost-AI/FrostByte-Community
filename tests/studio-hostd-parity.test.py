"""Parity tests for frostbyte-hostd, adapted from Frigid 0.8.1 tests.

Run: python3 tests/studio-hostd-parity.test.py
"""
import argparse
import contextlib
import fcntl
import http.client
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / 'src/hostd'


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hostd = load_module('frostbyte_hostd', RESOURCES / 'frostbyte_hostd.py')

FAKE_STAT = ('cpu  100 0 100 800 0 0 0 0 0 0\n'
             'cpu0 50 0 50 400 0 0 0 0 0 0\n')
FAKE_STAT_BUSY = ('cpu  200 0 200 900 0 0 0 0 0 0\n'
                  'cpu0 100 0 100 450 0 0 0 0 0 0\n')
FAKE_MEMINFO = ('MemTotal:       16384000 kB\n'
                'MemFree:         512000 kB\n'
                'MemAvailable:    8192000 kB\n'
                'SwapTotal:       2048000 kB\n'
                'SwapFree:        1024000 kB\n')
FAKE_UPTIME = '12345.67 99999.99\n'
FAKE_NETDEV_A = ('Inter-|   Receive                                                |  Transmit\n'
                 ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n'
                 '    lo: 1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0\n'
                 '  eth0: 5000      50    0    0    0     0          0         0     3000      30    0    0    0     0       0          0\n'
                 '   wg0: 2000      20    0    0    0     0          0         0     1000      10    0    0    0     0       0          0\n')
FAKE_NETDEV_B = FAKE_NETDEV_A.replace('5000', '6000').replace('3000', '3500').replace('2000', '2500').replace('1000      10', '1250      12')

NVIDIA_CSV = 'NVIDIA GB10, 45, 12.5, 30.25\n'          # collector query (with name)
NVIDIA_NA = 'NVIDIA GB10, [N/A], [N/A], [N/A]\n'
NVIDIA_SAMPLER = '45, 12.5, 30.25\n'                    # sampler query (no name column)
NVIDIA_SAMPLER_NA = '[N/A], [N/A], [N/A]\n'
DOCKER_PS_JSON = json.dumps({'ID': 'a' * 64, 'Names': 'some-container', 'Image': 'img:1',
                             'State': 'Exited', 'Status': 'Exited (0) 2 hours ago'})


def fake_completed(rc, out):
    return types.SimpleNamespace(returncode=rc, stdout=out, stderr='')


def make_runner(table, default_rc=1):
    """table maps tuple(argv-prefix) or exact list to (rc, stdout)."""
    calls = []

    def runner(argv, **kwargs):
        calls.append(list(argv))
        for key, value in table.items():
            if list(argv)[:len(key)] == list(key):
                return fake_completed(value[0], value[1])
        return fake_completed(default_rc, '')

    runner.calls = calls
    return runner


def fake_proc_dir(tmp):
    proc = Path(tmp) / 'proc'
    (proc / 'net').mkdir(parents=True)
    (proc / 'stat').write_text(FAKE_STAT)
    (proc / 'meminfo').write_text(FAKE_MEMINFO)
    (proc / 'uptime').write_text(FAKE_UPTIME)
    (proc / 'net/dev').write_text(FAKE_NETDEV_A)
    return proc


def empty_recipe_file(tmp):
    path = Path(tmp) / 'recipes.json'
    path.write_text(json.dumps({'schema': 1, 'recipes': []}))
    os.chmod(path, 0o600)
    return path


def make_ctx(tmp, runner=None, recipes=None, sampler=None):
    recipe_book = hostd.RecipeBook(recipes or empty_recipe_file(tmp))
    dummy_sampler = sampler or types.SimpleNamespace(latest=lambda: (0, None))
    return hostd.Ctx(token='t' * 64, recipe_book=recipe_book, sampler=dummy_sampler,
                       hostname=socket.gethostname(),
                       lock_paths=[str(Path(tmp) / 'controls.lock')],
                       receipts_path=str(Path(tmp) / 'receipts.jsonl'),
                       runner=runner or (lambda *a, **k: fake_completed(1, '')),
                       proc_root=Path(tmp) / 'proc', home=Path(tmp))


# ---------------------------------------------------------------------------
# Pure parsers
# ---------------------------------------------------------------------------

class ParserTests(unittest.TestCase):
    def test_netdev_excludes_lo_and_sums(self):
        rx, tx = hostd.netdev_totals(FAKE_NETDEV_A)
        self.assertEqual(rx, 7000)   # eth0 5000 + wg0 2000, lo excluded
        self.assertEqual(tx, 4000)   # eth0 3000 + wg0 1000

    def test_netdev_no_space_after_colon(self):
        text = ('a\nb\n'
                '  eth0:9000 90 0 0 0 0 0 0 7000 70 0 0 0 0 0 0\n')
        rx, tx = hostd.netdev_totals(text)
        self.assertEqual((rx, tx), (9000, 7000))

    def test_netdev_rates(self):
        rx, tx = hostd.netdev_rates((100, 50), (300, 150), 2.0)
        self.assertEqual((rx, tx), (100.0, 50.0))
        self.assertEqual(hostd.netdev_rates(None, (1, 1), 1.0), (None, None))

    def test_memory_parity_with_collector(self):
        self.assertEqual(hostd.memory(FAKE_MEMINFO), {
            'total': 16_384_000 * 1024,
            'available': 8_192_000 * 1024,
            'swapUsed': 1_024_000 * 1024,
        })

    def test_cpu_parity_with_collector(self):
        a = hostd.cpu_times(FAKE_STAT)
        b = hostd.cpu_times(FAKE_STAT_BUSY)
        # a = (1000, 800), b = (1300, 900) → delta total 300, delta idle 100
        self.assertEqual(a, (1000, 800))
        self.assertEqual(b, (1300, 900))
        self.assertAlmostEqual(hostd.cpu_percent(a, b), 100 * (1 - 100 / 300), places=6)

    def test_number_rejects_na(self):
        self.assertIsNone(hostd.number('[N/A]'))
        self.assertIsNone(hostd.number(float('nan')))
        self.assertEqual(hostd.number(' 12.5 '), 12.5)


# ---------------------------------------------------------------------------
# Schema parity with collector.py
# ---------------------------------------------------------------------------

def runner_table_for(argv):
    if argv[0] == 'nvidia-smi':
        return (0, NVIDIA_CSV)
    if argv[0] == 'docker':
        return (0, DOCKER_PS_JSON)
    return (1, '')


def parity_runner(argv, **kwargs):
    return fake_completed(*runner_table_for(argv))


class SchemaParityTests(unittest.TestCase):
    def test_snapshot_keys_match_collector(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = fake_proc_dir(tmp)
            mine = hostd.collect(proc_root=proc, runner=parity_runner, home=Path(tmp))
            self.assertEqual(set(mine), {
                'schema', 'host', 'timestamp', 'uptime', 'cpu', 'memory', 'gpu',
                'disk', 'containers', 'models', 'warnings', 'endpoint',
            })
            self.assertEqual(set(mine['memory']), {'total', 'available', 'swapUsed'})
            self.assertEqual(set(mine['gpu']), {'name', 'temperature', 'utilization', 'power'})
            self.assertEqual(set(mine['disk']), {'total', 'available'})
            self.assertEqual(set(mine['endpoint']), {'port', 'state', 'detail'})
            self.assertEqual(mine['schema'], 1)
            self.assertEqual(mine['uptime'], 12345.67)
            self.assertEqual(mine['containers'][0]['name'], 'some-container')


# ---------------------------------------------------------------------------
# Sampler / StreamSample
# ---------------------------------------------------------------------------

class SamplerTests(unittest.TestCase):
    def _sampler(self, tmp, runner, interval=0.2, recipes=None):
        proc = fake_proc_dir(tmp)
        book = hostd.RecipeBook(recipes or empty_recipe_file(tmp))
        return hostd.Sampler(book, proc_root=proc, runner=runner, interval=interval)

    def test_stream_sample_assembly_and_na(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = make_runner({
                ('nvidia-smi',): (0, NVIDIA_SAMPLER_NA),
                ('tmux',): (1, ''),
                ('docker',): (1, ''),
            })
            sampler = self._sampler(tmp, runner)
            sampler._tick()
            _, first = sampler.latest()
            self.assertEqual(first['schema'], 1)
            self.assertIsNone(first['cpu'])  # first tick has no delta
            self.assertEqual(first['gpu'], {'temperature': None, 'utilization': None, 'power': None})
            self.assertAlmostEqual(first['memAvailable'], 8192000 * 1024)
            # second tick with changed counters
            (Path(tmp) / 'proc/stat').write_text(FAKE_STAT_BUSY)
            (Path(tmp) / 'proc/net/dev').write_text(FAKE_NETDEV_B)
            sampler._tick()
            _, second = sampler.latest()
            self.assertIsNotNone(second['cpu'])
            self.assertIsNotNone(second['netRxBps'])
            self.assertGreater(second['netRxBps'], 0)
            self.assertEqual(second['runningModels'], [])

    def test_gpu_values_parsed(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = make_runner({('nvidia-smi',): (0, NVIDIA_SAMPLER), ('tmux',): (1, ''), ('docker',): (1, '')})
            sampler = self._sampler(tmp, runner)
            sampler._tick()
            _, sample = sampler.latest()
            self.assertEqual(sample['gpu'], {'temperature': 45.0, 'utilization': 12.5, 'power': 30.25})

    def test_running_models_detects_tmux_recipe(self):
        with tempfile.TemporaryDirectory() as tmp:
            recipes = Path(tmp) / 'recipes.json'
            recipes.write_text(json.dumps({'schema': 1, 'recipes': [{
                'id': 'test-model', 'title': 'Test', 'kind': 'tmux', 'session': 'test-session',
                'argv': ['/bin/sh', '-c', 'true'], 'healthPort': 30001, 'stopGraceSec': 1}]}))
            os.chmod(recipes, 0o600)
            runner = make_runner({
                ('tmux', 'has-session', '-t', '=test-session'): (0, ''),
                ('tmux', 'list-panes', '-t', '=test-session:'): (0, '4242\n'),
                ('nvidia-smi',): (0, NVIDIA_SAMPLER),
                ('docker',): (1, ''),
            })
            sampler = self._sampler(tmp, runner, recipes=recipes)
            sampler._tick()
            _, sample = sampler.latest()
            self.assertEqual(sample['runningModels'],
                             [{'kind': 'tmux', 'name': 'Test', 'target': 'test-session', 'pid': 4242}])


# ---------------------------------------------------------------------------
# Auth / guards
# ---------------------------------------------------------------------------

class GuardTests(unittest.TestCase):
    def test_check_auth_constant_time_compare(self):
        headers = {'Authorization': 'Bearer ' + 'a' * 64}
        self.assertTrue(hostd.check_auth(headers, 'a' * 64))
        self.assertFalse(hostd.check_auth(headers, 'b' * 64))
        self.assertFalse(hostd.check_auth({}, 'a' * 64))
        self.assertFalse(hostd.check_auth({'Authorization': 'Basic xyz'}, 'a' * 64))

    def test_host_ok(self):
        self.assertTrue(hostd.host_ok({'Host': '10.80.10.37:8757'}))
        self.assertTrue(hostd.host_ok({'Host': '127.0.0.1:8757'}))
        self.assertTrue(hostd.host_ok({'Host': 'localhost:8757'}))
        self.assertTrue(hostd.host_ok({'Host': '[::1]:8757'}))
        self.assertFalse(hostd.host_ok({'Host': 'evil.example.com'}))
        self.assertFalse(hostd.host_ok({}))

    def test_origin_refused(self):
        self.assertTrue(hostd.origin_ok({}))
        self.assertFalse(hostd.origin_ok({'Origin': 'http://evil.example.com'}))

    def test_load_token_min_length(self):
        with tempfile.TemporaryDirectory() as tmp:
            short = Path(tmp) / 'short'
            short.write_text('abc')
            with self.assertRaises(ValueError):
                hostd.load_token(short)
            good = Path(tmp) / 'good'
            good.write_text(secrets.token_hex(32) + '\n')
            os.chmod(good, 0o600)
            self.assertEqual(len(hostd.load_token(good)), 64)
            os.chmod(good, 0o640)
            with self.assertRaises(ValueError):
                hostd.load_token(good)


# ---------------------------------------------------------------------------
# Recipes validation
# ---------------------------------------------------------------------------

class RecipeTests(unittest.TestCase):
    def base(self, **over):
        recipe = {'id': 'test-model', 'title': 'T', 'kind': 'tmux', 'session': 'sess',
                  'argv': ['/bin/sh', '-c', 'true'], 'healthPort': 30001, 'stopGraceSec': 5}
        recipe.update(over)
        return recipe

    def test_valid(self):
        recipes, warnings = hostd.validate_recipes({'schema': 1, 'recipes': [self.base()]})
        self.assertEqual(len(recipes), 1)
        self.assertEqual(warnings, [])

    def test_model_folder_optional_and_validated(self):
        # Absent → None (back-compat with pre-0.4.1 recipes).
        recipes, _ = hostd.validate_recipes({'schema': 1, 'recipes': [self.base()]})
        self.assertIsNone(recipes[0]['modelFolder'])
        # Valid real-world folder name.
        recipes, _ = hostd.validate_recipes(
            {'schema': 1, 'recipes': [self.base(modelFolder='Qwen3.8-Flash-Next-DERISKED-NVFP4')]})
        self.assertEqual(recipes[0]['modelFolder'], 'Qwen3.8-Flash-Next-DERISKED-NVFP4')
        # Traversal, empty, non-string, and over-long values are rejected.
        for bad in ['../evil', '', 123, 'a' * 129, '/abs/path']:
            doc = {'schema': 1, 'recipes': [self.base(modelFolder=bad)]}
            recipes, warnings = hostd.validate_recipes(doc)
            self.assertEqual(recipes, [], f'modelFolder={bad!r} should be rejected')
            self.assertTrue(any('modelFolder' in w for w in warnings), warnings)

    def test_docker_recipe_accepts_model_folder(self):
        doc = {'schema': 1, 'recipes': [
            {'id': 'd1', 'title': 'D', 'kind': 'docker', 'container': 'c1',
             'modelFolder': 'GLM-5.3-UD-Q3_K_XL'}]}
        recipes, _ = hostd.validate_recipes(doc)
        self.assertEqual(recipes[0]['modelFolder'], 'GLM-5.3-UD-Q3_K_XL')
        self.assertEqual(recipes[0]['container'], 'c1')

    def test_rejects_shell_metachar_tokens(self):
        recipes, warnings = hostd.validate_recipes(
            {'schema': 1, 'recipes': [self.base(argv=['/bin/sh', '-c', 'x\nrm -rf /'])]})
        self.assertEqual(recipes, [])
        self.assertIn('rejected', warnings[0])

    def test_relative_argv0_allowed_at_load_but_start_refuses(self):
        # Load-time validation is structural; executable path is checked at start.
        recipes, _ = hostd.validate_recipes(
            {'schema': 1, 'recipes': [self.base(argv=['llama-server'])]})
        self.assertEqual(len(recipes), 1)
        with tempfile.TemporaryDirectory() as tmp:
            runner = make_runner({('tmux', 'has-session'): (1, '')})
            with self.assertRaises(ValueError):
                hostd.tmux_start(recipes[0], runner)

    def test_rejects_duplicate_ids_bad_session_bad_kind(self):
        doc = {'schema': 1, 'recipes': [self.base(), self.base(),
                                        self.base(id='other', session='bad session; rm'),
                                        self.base(id='third', kind='podman')]}
        recipes, warnings = hostd.validate_recipes(doc)
        self.assertEqual([r['id'] for r in recipes], ['test-model'])
        self.assertEqual(len(warnings), 3)

    def test_rejects_bad_schema(self):
        with self.assertRaises(ValueError):
            hostd.validate_recipes({'schema': 2, 'recipes': []})

    def test_perm_gate_world_writable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'recipes.json'
            path.write_text(json.dumps({'schema': 1, 'recipes': []}))
            os.chmod(path, 0o666)
            book = hostd.RecipeBook(path)
            self.assertFalse(book.loaded)
            self.assertIn('rejected', book.warnings[0])

    def test_reload_on_mtime_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = empty_recipe_file(tmp)
            book = hostd.RecipeBook(path)
            self.assertEqual(book.all()[0], [])
            time.sleep(0.01)
            path.write_text(json.dumps({'schema': 1, 'recipes': [self.base()]}))
            os.utime(path, (time.time() + 1, time.time() + 1))
            recipes, _, loaded = book.all()
            self.assertTrue(loaded)
            self.assertEqual(recipes[0]['id'], 'test-model')


# ---------------------------------------------------------------------------
# Control engine
# ---------------------------------------------------------------------------

class ControlTests(unittest.TestCase):
    def tmux_recipe_file(self, tmp, grace=1):
        path = Path(tmp) / 'recipes.json'
        path.write_text(json.dumps({'schema': 1, 'recipes': [
            {'id': 'test-model', 'title': 'T', 'kind': 'tmux', 'session': 'test-session',
             'argv': ['/bin/echo', 'hello'], 'healthPort': 30099, 'stopGraceSec': grace},
            {'id': 'docker-model', 'title': 'D', 'kind': 'docker', 'container': 'test-container'}]}))
        os.chmod(path, 0o600)
        return path

    def request(self, **over):
        req = {'action': 'stop', 'kind': 'tmux', 'target': 'test-model',
               'host': socket.gethostname(), 'confirm': True}
        req.update(over)
        return req

    def test_unknown_target_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp, recipes=self.tmux_recipe_file(tmp))
            result = hostd.handle_control(self.request(target='nope'), ctx)
            self.assertFalse(result['ok'])
            self.assertIn('not an approved recipe', result['message'])

    def test_confirm_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp, recipes=self.tmux_recipe_file(tmp))
            result = hostd.handle_control(self.request(confirm=False), ctx)
            self.assertFalse(result['ok'])
            self.assertIn('confirm', result['message'])

    def test_hostname_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp, recipes=self.tmux_recipe_file(tmp))
            result = hostd.handle_control(self.request(host='some-other-host'), ctx)
            self.assertFalse(result['ok'])
            self.assertIn('Machine identity changed', result['message'])

    def test_tmux_stop_sequence(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {'alive': True}

            def runner(argv, **kwargs):
                calls.append(list(argv))
                if argv[:2] == ['tmux', 'has-session']:
                    return fake_completed(0 if state['alive'] else 1, '')
                if argv[:2] == ['tmux', 'send-keys']:
                    state['alive'] = False
                    return fake_completed(0, '')
                return fake_completed(0, '')

            calls = []
            ctx = make_ctx(tmp, runner=runner, recipes=self.tmux_recipe_file(tmp))
            result = hostd.handle_control(self.request(), ctx)
            self.assertTrue(result['ok'], result['message'])
            self.assertEqual(result['state'], 'stopped')
            self.assertIn(['tmux', 'send-keys', '-t', '=test-session:', 'C-c'], calls)
            self.assertNotIn('kill-session', [c[1] if len(c) > 1 else '' for c in calls])

    def test_tmux_stop_kill_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {'cc_sent': False, 'killed': False}

            def runner(argv, **kwargs):
                if argv[:2] == ['tmux', 'has-session']:
                    alive = not state['killed']
                    return fake_completed(0 if alive else 1, '')
                if argv[:2] == ['tmux', 'send-keys']:
                    state['cc_sent'] = True  # model ignores C-c in this scenario
                    return fake_completed(0, '')
                if argv[:2] == ['tmux', 'kill-session']:
                    state['killed'] = True
                    return fake_completed(0, '')
                return fake_completed(0, '')

            ctx = make_ctx(tmp, runner=runner, recipes=self.tmux_recipe_file(tmp, grace=1))
            result = hostd.handle_control(self.request(), ctx)
            self.assertTrue(result['ok'], result['message'])
            self.assertTrue(state['cc_sent'])
            self.assertTrue(state['killed'])

    def test_tmux_start_preflight_port_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            # bind the recipe's health port so preflight must refuse
            with socket.socket() as blocker:
                blocker.bind(('127.0.0.1', 30099))
                blocker.listen(1)
                runner = make_runner({
                    ('tmux', 'has-session'): (1, ''),
                    ('nvidia-smi', '--query-compute-apps'): (0, ''),
                })
                ctx = make_ctx(tmp, runner=runner, recipes=self.tmux_recipe_file(tmp))
                result = hostd.handle_control(self.request(action='start'), ctx)
            self.assertFalse(result['ok'])
            self.assertIn('already bound', result['message'])
            self.assertFalse(any(c[0] == 'tmux' and c[1] == 'new-session' for c in runner.calls))

    def test_tmux_start_gpu_busy(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = make_runner({
                ('tmux', 'has-session'): (1, ''),
                ('nvidia-smi',): (0, '4321\n'),
            })
            ctx = make_ctx(tmp, runner=runner, recipes=self.tmux_recipe_file(tmp))
            result = hostd.handle_control(self.request(action='start'), ctx)
            self.assertFalse(result['ok'])
            self.assertIn('GPU compute process', result['message'])

    def test_tmux_start_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {'started': False}

            def runner(argv, **kwargs):
                calls.append(list(argv))
                if argv[:2] == ['tmux', 'has-session']:
                    return fake_completed(0 if state['started'] else 1, '')
                if argv[:2] == ['tmux', 'new-session']:
                    state['started'] = True
                    return fake_completed(0, '')
                if 'query-compute-apps' in ' '.join(argv):
                    return fake_completed(0, '')
                return fake_completed(0, '')

            calls = []
            ctx = make_ctx(tmp, runner=runner, recipes=self.tmux_recipe_file(tmp))
            result = hostd.handle_control(self.request(action='start'), ctx)
            self.assertTrue(result['ok'], result['message'])
            new_session = next(c for c in calls if len(c) > 1 and c[1] == 'new-session')
            self.assertIn('exec /bin/echo hello', new_session[-1])

    def test_docker_start_blocked_by_other_gpu_container(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = make_runner({
                ('docker', 'inspect', '--format', hostd.DOCKER_FORMAT, 'test-container'):
                    (0, json.dumps({'id': 'b' * 64, 'name': '/test-container', 'state': 'exited',
                                    'devices': None, 'runtime': 'runc', 'ports': None})),
                ('docker', 'ps', '-q', '--no-trunc'): (0, 'c' * 64 + '\n'),
                ('docker', 'inspect', '--format', hostd.DOCKER_FORMAT, 'c' * 64):
                    (0, json.dumps({'id': 'c' * 64, 'name': '/other', 'state': 'running',
                                    'devices': [{'Driver': 'nvidia'}], 'runtime': 'nvidia',
                                    'ports': None})),
                ('nvidia-smi', '--query-compute-apps'): (0, ''),
            })
            ctx = make_ctx(tmp, runner=runner, recipes=self.tmux_recipe_file(tmp))
            result = hostd.handle_control(
                self.request(action='start', kind='docker', target='docker-model'), ctx)
            self.assertFalse(result['ok'])
            self.assertIn('Another GPU or serving-port container', result['message'])
            self.assertFalse(any(c[:2] == ['docker', 'start'] for c in runner.calls))

    def test_lock_contention_message_parity(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / 'controls.lock'
            fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                runner = make_runner({('tmux', 'has-session'): (0, ''), ('tmux', 'send-keys'): (0, '')})
                ctx = make_ctx(tmp, runner=runner, recipes=self.tmux_recipe_file(tmp))
                result = hostd.handle_control(self.request(), ctx)
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
            self.assertFalse(result['ok'])
            self.assertEqual(result['message'],
                             'Another FrostByte host control request is active. Refresh before trying again.')

    def test_receipt_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = make_runner({('tmux', 'has-session'): (1, '')})
            ctx = make_ctx(tmp, runner=runner, recipes=self.tmux_recipe_file(tmp))
            hostd.handle_control(self.request(), ctx)
            lines = Path(ctx.receipts_path).read_text().splitlines()
            record = json.loads(lines[-1])
            self.assertEqual(record['action'], 'stop')
            self.assertEqual(record['target'], 'test-model')
            self.assertEqual(record['channel'], 'frostbyte-hostd')


# ---------------------------------------------------------------------------
# Power engine
# ---------------------------------------------------------------------------

class PowerTests(unittest.TestCase):
    def request(self, **over):
        req = {'action': 'reboot', 'host': socket.gethostname(), 'confirm': ''}
        req.update(over)
        return req

    def test_preview_without_phrase(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp)
            response, deferred = hostd.handle_power(self.request(), ctx)
            self.assertIsNone(deferred)
            self.assertEqual(response['state'], 'preview')
            self.assertEqual(response['requiredPhrase'], 'REBOOT')
            self.assertIn('do not auto-start', response['message'])

    def test_wrong_phrase_blocked_no_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            executed = []
            ctx = make_ctx(tmp)
            response, deferred = hostd.handle_power(
                self.request(confirm='reboot'), ctx, executor=lambda argv: executed.append(argv) or (0, ''))
            self.assertIsNone(deferred)
            self.assertFalse(response['ok'])
            self.assertEqual(response['state'], 'blocked')
            self.assertEqual(executed, [])

    def test_correct_phrase_dispatches_exact_argv(self):
        with tempfile.TemporaryDirectory() as tmp:
            executed = []
            ctx = make_ctx(tmp)
            response, deferred = hostd.handle_power(
                self.request(confirm='REBOOT'), ctx,
                executor=lambda argv: executed.append(argv) or (0, ''))
            self.assertEqual(response['state'], 'pending')
            self.assertIsNotNone(deferred)
            self.assertEqual(executed, [])  # nothing until the deferred call fires
            deferred()
            self.assertEqual(executed, [['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'reboot']])

    def test_shutdown_maps_to_poweroff(self):
        with tempfile.TemporaryDirectory() as tmp:
            executed = []
            ctx = make_ctx(tmp)
            response, deferred = hostd.handle_power(
                {'action': 'shutdown', 'host': socket.gethostname(), 'confirm': 'SHUTDOWN'}, ctx,
                executor=lambda argv: executed.append(argv) or (0, ''))
            deferred()
            self.assertEqual(executed, [['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'poweroff']])

    def test_blocked_executor_writes_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp)
            _, deferred = hostd.handle_power(
                self.request(confirm='REBOOT'), ctx, executor=lambda argv: (1, ''))
            deferred()
            record = json.loads(Path(ctx.receipts_path).read_text().splitlines()[-1])
            self.assertEqual(record['state'], 'blocked')
            self.assertFalse(record['ok'])

    def test_hostname_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp)
            response, deferred = hostd.handle_power(self.request(host='other-host', confirm='REBOOT'), ctx)
            self.assertIsNone(deferred)
            self.assertFalse(response['ok'])

    def test_power_status_records_denied_executor_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp)
            response, deferred = hostd.handle_power(self.request(confirm='REBOOT'), ctx,
                                                     executor=lambda argv: (1, ''))
            operation_id = response['operationID']
            self.assertEqual(ctx.power_results[operation_id]['state'], 'pending')
            second, second_deferred = hostd.handle_power(self.request(confirm='REBOOT'), ctx)
            self.assertIsNone(second_deferred)
            self.assertFalse(second['ok'])
            self.assertEqual(second['message'], hostd.LOCK_BUSY_MESSAGE)
            deferred()
            self.assertEqual(ctx.power_results[operation_id]['state'], 'blocked')
            with hostd.control_locks(ctx.lock_paths):
                pass  # completion released the same lock used by model controls

    def test_undelivered_power_response_cancels_without_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            executed = []
            ctx = make_ctx(tmp)
            response, deferred = hostd.handle_power(self.request(confirm='REBOOT'), ctx,
                executor=lambda argv: executed.append(argv) or (0, ''))
            deferred.cancel()
            self.assertEqual(executed, [])
            self.assertEqual(ctx.power_results[response['operationID']]['state'], 'blocked')

    def test_power_executor_exception_releases_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp)
            def broken(argv):
                raise RuntimeError('fixture')
            response, deferred = hostd.handle_power(self.request(confirm='REBOOT'), ctx, executor=broken)
            deferred()
            self.assertFalse(ctx.power_results[response['operationID']]['ok'])
            with hostd.control_locks(ctx.lock_paths):
                pass


# ---------------------------------------------------------------------------
# Integration: live server on 127.0.0.1 ephemeral port
# ---------------------------------------------------------------------------

class ServerIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        tmp = cls.tmp.name
        cls.proc = fake_proc_dir(tmp)
        cls.token = secrets.token_hex(32)
        token_file = Path(tmp) / 'token'
        token_file.write_text(cls.token)
        os.chmod(token_file, 0o600)
        cls.recipes = empty_recipe_file(tmp)
        args = argparse.Namespace(
            host='127.0.0.1', port=0, token_file=str(token_file), recipes=str(cls.recipes),
            state_dir=tmp, receipts=str(Path(tmp) / 'receipts.jsonl'), proc_root=str(cls.proc),
            endpoint_port=30099, interval=0.2)
        cls.ctx = hostd.build_ctx(args)
        cls.runner = make_runner({('nvidia-smi',): (0, NVIDIA_CSV), ('tmux',): (1, ''), ('docker',): (1, '')})
        cls.ctx.runner = cls.runner
        cls.ctx.sampler = hostd.Sampler(cls.ctx.recipe_book, proc_root=cls.proc,
                                          runner=cls.runner, endpoint_port=30099, interval=0.2)
        cls.server = hostd.FrostByteHostServer(('127.0.0.1', 0), cls.ctx)
        cls.port = cls.server.server_address[1]
        cls.ctx.sampler.start()
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={'poll_interval': 0.1},
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.stopping.set()
        cls.ctx.sampler.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.tmp.cleanup()

    def conn(self):
        client = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        return client

    def auth(self):
        return {'Authorization': 'Bearer ' + self.token}

    def test_info_unauthenticated(self):
        client = self.conn()
        client.request('GET', '/v1/info')
        response = client.getresponse()
        body = json.loads(response.read())
        self.assertEqual(response.status, 200)
        self.assertEqual(body['name'], 'frostbyte-hostd')
        # Host identity is recon material; it is disclosed only to a valid token.
        self.assertEqual(body.get('hostname'), 'redacted')
        self.assertFalse(body.get('authenticated'))
        self.assertIsNone(body.get('bootID'))
        client.close()
        client = self.conn()
        client.request('GET', '/v1/info', headers=self.auth())
        response = client.getresponse()
        body = json.loads(response.read())
        self.assertEqual(response.status, 200)
        self.assertEqual(body['hostname'], socket.gethostname())
        # bootID is only present where the kernel exposes it (Linux); on hosts
        # without /proc it is None for authed callers too.
        self.assertIn('bootID', body)
        client.close()

    def test_snapshot_requires_token(self):
        client = self.conn()
        client.request('GET', '/v1/snapshot')
        self.assertEqual(client.getresponse().status, 401)
        client.close()
        client = self.conn()
        client.request('GET', '/v1/snapshot', headers=self.auth())
        response = client.getresponse()
        body = json.loads(response.read())
        self.assertEqual(response.status, 200)
        self.assertEqual(body['schema'], 1)
        for key in ('host', 'timestamp', 'uptime', 'cpu', 'memory', 'gpu', 'disk',
                    'containers', 'models', 'warnings', 'endpoint'):
            self.assertIn(key, body)
        client.close()

    def test_origin_refused(self):
        client = self.conn()
        headers = dict(self.auth())
        headers['Origin'] = 'http://evil.example.com'
        client.request('GET', '/v1/snapshot', headers=headers)
        self.assertEqual(client.getresponse().status, 403)
        client.close()

    def test_bad_host_refused(self):
        client = self.conn()
        headers = dict(self.auth())
        headers['Host'] = 'evil.example.com'
        client.request('GET', '/v1/snapshot', headers=headers)
        self.assertEqual(client.getresponse().status, 421)
        client.close()

    def test_unknown_endpoint_404(self):
        client = self.conn()
        client.request('GET', '/v1/nope', headers=self.auth())
        self.assertEqual(client.getresponse().status, 404)
        client.close()

    def test_sse_stream_frames(self):
        client = self.conn()
        client.request('GET', '/v1/stream', headers=self.auth())
        response = client.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn('text/event-stream', response.getheader('Content-Type'))
        frames = []
        buffer = b''
        deadline = time.monotonic() + 10
        while len(frames) < 2 and time.monotonic() < deadline:
            chunk = response.read(1)
            if not chunk:
                break
            buffer += chunk
            while b'\n\n' in buffer:
                frame, buffer = buffer.split(b'\n\n', 1)
                frames.append(frame.decode())
        client.close()
        self.assertGreaterEqual(len(frames), 2)
        for frame in frames:
            lines = frame.splitlines()
            self.assertEqual(lines[0], 'event: sample')
            payload = json.loads(lines[1][len('data: '):])
            self.assertEqual(payload['schema'], 1)
            self.assertIn('gpu', payload)
            self.assertIn('runningModels', payload)

    def test_stream_requires_token(self):
        client = self.conn()
        client.request('GET', '/v1/stream')
        self.assertEqual(client.getresponse().status, 401)
        client.close()

    def test_power_preview_then_rejected_phrase_via_http(self):
        client = self.conn()
        body = json.dumps({'action': 'reboot', 'host': self.ctx.hostname, 'confirm': ''})
        client.request('POST', '/v1/power', body=body,
                       headers={**self.auth(), 'Content-Type': 'application/json'})
        response = json.loads(client.getresponse().read())
        self.assertEqual(response['state'], 'preview')
        self.assertEqual(response['requiredPhrase'], 'REBOOT')
        body = json.dumps({'action': 'reboot', 'host': self.ctx.hostname, 'confirm': 'nope'})
        client.request('POST', '/v1/power', body=body,
                       headers={**self.auth(), 'Content-Type': 'application/json'})
        response = json.loads(client.getresponse().read())
        self.assertFalse(response['ok'])
        self.assertEqual(response['state'], 'blocked')
        client.close()

    def test_control_rejects_unknown_recipe_via_http(self):
        client = self.conn()
        body = json.dumps({'action': 'stop', 'kind': 'tmux', 'target': 'ghost',
                           'host': self.ctx.hostname, 'confirm': True})
        client.request('POST', '/v1/control', body=body,
                       headers={**self.auth(), 'Content-Type': 'application/json'})
        response = json.loads(client.getresponse().read())
        self.assertFalse(response['ok'])
        client.close()

    def test_power_status_reports_mocked_sudo_denial(self):
        # This server's runner is entirely fake, including sudo. No power command executes.
        with mock.patch.object(hostd, 'POWER_DELAY_SEC', 0.01):
            client = self.conn()
            client.request('POST', '/v1/power',
                body=json.dumps({'action': 'reboot', 'host': self.ctx.hostname, 'confirm': 'REBOOT'}),
                headers={**self.auth(), 'Content-Type': 'application/json'})
            initial = json.loads(client.getresponse().read())
            client.close()
        self.assertEqual(initial['state'], 'pending')
        deadline = time.monotonic() + 2
        final = initial
        while final['state'] == 'pending' and time.monotonic() < deadline:
            time.sleep(0.02)
            client = self.conn()
            client.request('GET', '/v1/power/status/' + initial['operationID'], headers=self.auth())
            final = json.loads(client.getresponse().read())
            client.close()
        self.assertEqual(final['state'], 'blocked')
        self.assertFalse(final['ok'])
        self.assertIn('sudo -n denied', final['message'])

    def test_stream_client_cap(self):
        # The daemon bounds concurrent SSE streams (one thread each); the
        # client past the cap gets a clean 503 instead of unbounded threads.
        # Settle first: the alphabetically-earlier stream test's slot is
        # released asynchronously when its closed socket fails the next write.
        time.sleep(1.0)
        clients = []
        try:
            for _ in range(hostd.MAX_STREAM_CLIENTS):
                client = self.conn()
                client.request('GET', '/v1/stream', headers=self.auth())
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                clients.append(client)
            rejected = self.conn()
            rejected.request('GET', '/v1/stream', headers=self.auth())
            response = rejected.getresponse()
            body = json.loads(response.read())
            self.assertEqual(response.status, 503)
            self.assertFalse(body['ok'])
            rejected.close()
        finally:
            for client in clients:
                client.close()
            # Let the server notice the closed sockets and release the slots
            # before any later test opens a stream.
            time.sleep(1.0)

    def test_recipes_endpoint(self):
        client = self.conn()
        client.request('GET', '/v1/recipes', headers=self.auth())
        body = json.loads(client.getresponse().read())
        self.assertTrue(body['loaded'])
        self.assertEqual(body['recipes'], [])
        client.close()

    def test_diagnostics_requires_auth_and_reports_health(self):
        client = self.conn()
        client.request('GET', '/v1/diagnostics')
        self.assertEqual(client.getresponse().status, 401)
        client.close()
        client = self.conn()
        client.request('GET', '/v1/diagnostics', headers=self.auth())
        response = client.getresponse()
        body = json.loads(response.read())
        self.assertEqual(response.status, 200)
        for key in ('version', 'uptimeSec', 'hostname', 'platform', 'python',
                    'samplerIntervalSec', 'lastSampleAgeSec', 'sampleCount',
                    'streamClients', 'recipesLoaded', 'recipesPath',
                    'tokenFingerprint', 'bootID', 'warnings'):
            self.assertIn(key, body, key)
        self.assertEqual(body['version'], hostd.DAEMON_VERSION)
        self.assertNotIn(self.token, json.dumps(body), 'diagnostics must never leak the token')
        self.assertEqual(body['tokenFingerprint'], hostd.token_fingerprint(self.token))
        self.assertIsInstance(body['streamClients'], int)
        self.assertGreaterEqual(body['sampleCount'], 0)
        client.close()


# ---------------------------------------------------------------------------
# CLI smoke
# ---------------------------------------------------------------------------

class OnceModeTests(unittest.TestCase):
    def test_once_prints_snapshot_without_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = fake_proc_dir(tmp)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = hostd.main(['--once', '--proc-root', str(proc), '--state-dir', tmp])
            self.assertEqual(rc, 0)
            body = json.loads(out.getvalue())
            self.assertEqual(body['schema'], 1)
            self.assertIn('warnings', body)

    def test_no_nonstdlib_imports(self):
        source = (RESOURCES / 'frostbyte_hostd.py').read_text()
        import ast
        tree = ast.parse(source)
        allowed = {'argparse', 'contextlib', 'csv', 'fcntl', 'hmac', 'http.client', 'http.server',
                   'io', 'json', 'os', 'pathlib', 'pwd', 're', 'shlex', 'shutil', 'signal',
                   'socket', 'stat', 'subprocess', 'sys', 'threading', 'time', 'hashlib', 'secrets', 'platform', 'base64', 'functools', 'pty', 'termios', 'struct',
                   'urllib.parse'}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertIn(alias.name, allowed, f'non-stdlib import: {alias.name}')
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module:
                    self.assertIn(node.module, allowed, f'non-stdlib import: {node.module}')


# ---------------------------------------------------------------------------
# Workspace agent (hostd 0.7.0) — jailed fs + exec for Frigid Studio
# ---------------------------------------------------------------------------

class WorkspaceTests(unittest.TestCase):
    def ws_ctx(self, tmp):
        ctx = make_ctx(tmp)
        ctx.workspace = (Path(tmp) / 'ws').resolve()
        ctx.workspace.mkdir(exist_ok=True)
        return ctx

    def write_req(self, path, content, confirm=True):
        import base64
        return {'path': path, 'content_b64': base64.b64encode(content.encode()).decode(),
                'confirm': confirm}

    def test_capability_and_descriptor(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            self.assertEqual(hostd.handle_workspace(ctx)['root'], str(ctx.workspace))
            off = make_ctx(tmp)
            self.assertFalse(hostd.handle_workspace(off)['ok'],
                             'descriptor must refuse when no workspace is configured')

    def test_write_read_roundtrip_is_atomic_and_jailed(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            result = hostd.handle_fs_write(ctx, self.write_req('src/main.py', 'print(1)\n'))
            self.assertTrue(result['ok'], result)
            read = hostd.handle_fs_read(ctx, {'path': 'src/main.py'})
            self.assertEqual(read['encoding'], 'utf8')
            self.assertEqual(read['content'], 'print(1)\n')
            self.assertFalse(read['truncated'])
            # No temp files left behind (atomic rename).
            leftovers = [p.name for p in (ctx.workspace / 'src').iterdir() if 'frostbyte-hostd-tmp' in p.name]
            self.assertEqual(leftovers, [])

    def test_jail_refuses_every_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            for bad in ['../escape', '/etc/passwd', '~/.ssh/id_rsa', 'a/../../b', 'a\\b', '..']:
                for handle in (hostd.handle_fs_read, hostd.handle_fs_list):
                    result = handle(ctx, {'path': bad})
                    self.assertFalse(result['ok'], f'{bad!r} must be refused')
                    self.assertIn('relative path', result['error'])
            # Empty path means "the workspace root" for list (legitimate), but
            # is meaningless for a file read and must be refused there.
            self.assertTrue(hostd.handle_fs_list(ctx, {'path': ''})['ok'])
            self.assertFalse(hostd.handle_fs_read(ctx, {'path': ''})['ok'])
            # A symlink inside the workspace pointing out must not read outside.
            outside = Path(tmp) / 'secret.txt'
            outside.write_text('top secret')
            (ctx.workspace / 'door').symlink_to(outside)
            result = hostd.handle_fs_read(ctx, {'path': 'door'})
            self.assertFalse(result['ok'], 'symlink escape must be refused')
            self.assertIn('symlink', result['error'])

    def test_write_requires_confirm_and_respects_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            no_confirm = hostd.handle_fs_write(ctx, self.write_req('a.txt', 'x', confirm=False))
            self.assertFalse(no_confirm['ok'])
            self.assertIn('confirm', no_confirm['error'])
            huge = hostd.handle_fs_write(ctx, self.write_req('a.txt', 'x' * (9 * 1024 * 1024)))
            self.assertFalse(huge['ok'])
            self.assertIn('8 MB', huge['error'])
            # Refuses to overwrite a directory.
            (ctx.workspace / 'adir').mkdir()
            result = hostd.handle_fs_write(ctx, self.write_req('adir', 'x'))
            self.assertFalse(result['ok'])

    def test_delete_requires_confirm_and_spares_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            hostd.handle_fs_write(ctx, self.write_req('gone.txt', 'bye'))
            no_confirm = hostd.handle_fs_delete(ctx, {'path': 'gone.txt'})
            self.assertFalse(no_confirm['ok'])
            result = hostd.handle_fs_delete(ctx, {'path': 'gone.txt', 'confirm': True})
            self.assertTrue(result['ok'])
            self.assertFalse((ctx.workspace / 'gone.txt').exists())
            root_result = hostd.handle_fs_delete(ctx, {'path': '.', 'confirm': True})
            self.assertFalse(root_result['ok'], 'the workspace root must be undeletable')

    def test_exec_runs_bounded_in_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            hostd.handle_fs_write(ctx, self.write_req('hello.sh', '#!/bin/sh\necho agent-m1\n'))
            result = hostd.handle_exec(ctx, {'command': 'sh hello.sh', 'cwd': '.', 'confirm': True})
            self.assertTrue(result['ok'])
            self.assertEqual(result['exit'], 0)
            self.assertIn('agent-m1', result['stdout'])
            # Unbounded timeout is refused.
            huge = hostd.handle_exec(ctx, {'command': 'true', 'timeout': 99999, 'confirm': True})
            self.assertTrue(huge['ok'], 'timeout is clamped, not rejected')
            # Without confirm: nothing runs.
            denied = hostd.handle_exec(ctx, {'command': 'sh hello.sh', 'cwd': '.'})
            self.assertFalse(denied['ok'])
            self.assertIn('confirm', denied['error'])

    def test_exec_rejects_missing_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            result = hostd.handle_exec(ctx, {'command': 'true', 'cwd': 'nope', 'confirm': True})
            self.assertFalse(result['ok'])

    def test_rename_checks_both_sides(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            hostd.handle_fs_write(ctx, self.write_req('a.txt', 'x'))
            missing = hostd.handle_fs_rename(ctx, {'from': 'ghost', 'to': 'x'})
            self.assertFalse(missing['ok'])
            collision = hostd.handle_fs_rename(ctx, {'from': 'a.txt', 'to': 'a.txt'})
            self.assertFalse(collision['ok'])
            ok = hostd.handle_fs_rename(ctx, {'from': 'a.txt', 'to': 'b.txt'})
            self.assertTrue(ok['ok'])
            self.assertTrue((ctx.workspace / 'b.txt').exists())


class WorkspaceV2Tests(unittest.TestCase):
    def ws_ctx(self, tmp, real_runner=False):
        # git and pty operations spawn real processes; use the real runner there.
        ctx = make_ctx(tmp, runner=subprocess.run if real_runner else None)
        ctx.workspace = (Path(tmp) / 'ws').resolve()
        ctx.workspace.mkdir(exist_ok=True)
        return ctx

    def write(self, ctx, rel, text):
        import base64
        return hostd.handle_fs_write(ctx, {
            'path': rel,
            'content_b64': base64.b64encode(text.encode()).decode(),
            'confirm': True})

    def test_search_finds_matches_with_line_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            self.write(ctx, 'a.py', 'import os\nneedle_here = 1\n')
            self.write(ctx, 'sub/b.py', 'x = 2\n# needle_here too\n')
            self.write(ctx, 'c.txt', 'nothing\n')
            result = hostd.handle_search(ctx, {'q': 'needle_here'})
            self.assertTrue(result['ok'], result)
            self.assertIn(result['engine'], ('ripgrep', 'builtin'))
            paths = sorted(hit['path'] for hit in result['hits'])
            self.assertEqual(paths, ['a.py', 'sub/b.py'])
            first = next(h for h in result['hits'] if h['path'] == 'a.py')
            self.assertEqual(first['line'], 2)
            self.assertIn('needle_here', first['text'])

    def test_search_is_bounded_and_jail_safe(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            self.write(ctx, 'a.txt', 'x\n')
            self.assertFalse(hostd.handle_search(ctx, {'q': ''})['ok'])
            self.assertFalse(hostd.handle_search(ctx, {'q': 'x' * 500})['ok'])
            self.assertFalse(hostd.handle_search(ctx, {'q': 'x', 'path': '../'})['ok'])

    def test_search_reports_engine_honestly(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            self.write(ctx, 'a.txt', 'hello world\n')
            result = hostd.handle_search(ctx, {'q': 'hello'})
            self.assertIn(result['engine'], ('ripgrep', 'builtin'),
                          'the response must say which engine ran')

    def _git_repo(self, ctx):
        # Real git, isolated: the workspace is its own repo.
        subprocess.run(['git', 'init', '-q', str(ctx.workspace)], check=True)
        subprocess.run(['git', '-C', str(ctx.workspace), 'config', 'user.email', 't@example.com'], check=True)
        subprocess.run(['git', '-C', str(ctx.workspace), 'config', 'user.name', 'Test'], check=True)
        self.write(ctx, 'readme.md', 'hello\n')

    def test_git_status_and_diff(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp, real_runner=True)
            self._git_repo(ctx)
            # Untracked files show in status...
            status = hostd.handle_git_status(ctx, {})
            self.assertTrue(status['ok'], status)
            self.assertIn('readme.md', [e['path'] for e in status['entries']])
            self.assertEqual(status['entries'][0]['worktree'], '?', 'untracked marker expected')
            # ...but git diff only shows tracked changes, so commit then modify.
            hostd.handle_git_stage(ctx, {'files': ['readme.md']})
            self.assertTrue(hostd.handle_git_commit(ctx, {'message': 'base', 'confirm': True})['ok'])
            self.write(ctx, 'readme.md', 'hello\nsecond line\n')
            diff = hostd.handle_git_diff(ctx, {'file': 'readme.md'})
            self.assertTrue(diff['ok'])
            self.assertIn('+second line', diff['diff'])

    def test_git_commit_requires_confirm_and_landed(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp, real_runner=True)
            self._git_repo(ctx)
            staged = hostd.handle_git_stage(ctx, {'files': ['readme.md']})
            self.assertTrue(staged['ok'], staged)
            denied = hostd.handle_git_commit(ctx, {'message': 'x'})
            self.assertFalse(denied['ok'])
            self.assertIn('confirm', denied['error'])
            done = hostd.handle_git_commit(ctx, {'message': 'first commit', 'confirm': True})
            self.assertTrue(done['ok'], done)
            log = hostd.handle_git_log(ctx, {})
            self.assertEqual(log['commits'][0]['subject'], 'first commit')

    def test_git_stage_rejects_escapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp, real_runner=True)
            self._git_repo(ctx)
            for bad in [['../outside'], ['/etc/passwd'], []]:
                self.assertFalse(hostd.handle_git_stage(ctx, {'files': bad})['ok'])

    def test_git_status_outside_a_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            result = hostd.handle_git_status(ctx, {})
            self.assertFalse(result['ok'])
            self.assertFalse(result['isRepo'])

    def test_pty_echo_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp, real_runner=True)
            opened = hostd.handle_pty_open(ctx, {'cols': 100, 'rows': 30})
            self.assertTrue(opened['ok'], opened)
            session_id = opened['id']
            try:
                import base64, time as _t
                hostd.handle_pty_input(ctx, {'id': session_id,
                    'data_b64': base64.b64encode(b'echo frigid-pty-ok\n').decode()})
                deadline = _t.time() + 10
                seen = b''
                while _t.time() < deadline and b'frigid-pty-ok' not in seen:
                    ctx.ptys[session_id].drain()
                    seen += ctx.ptys[session_id].take()
                    _t.sleep(0.1)
                self.assertIn(b'frigid-pty-ok', seen, seen[:200])
            finally:
                hostd.handle_pty_close(ctx, {'id': session_id})
            self.assertNotIn(session_id, ctx.ptys)

    def test_pty_cap_and_unknown_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp, real_runner=True)
            ids = []
            try:
                for _ in range(hostd.MAX_PTY_SESSIONS):
                    opened = hostd.handle_pty_open(ctx, {})
                    self.assertTrue(opened['ok'], opened)
                    ids.append(opened['id'])
                over = hostd.handle_pty_open(ctx, {})
                self.assertFalse(over['ok'])
                self.assertIn('At most', over['error'])
            finally:
                for session_id in ids:
                    hostd.handle_pty_close(ctx, {'id': session_id})
            self.assertFalse(hostd.handle_pty_input(ctx, {'id': 'nope', 'data_b64': ''})['ok'])

    def test_watch_tree_state_detects_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.ws_ctx(tmp)
            self.write(ctx, 'one.txt', 'a')
            before = hostd.workspace_tree_state(ctx)
            self.assertIn('one.txt', before)
            self.write(ctx, 'two.txt', 'b')
            after = hostd.workspace_tree_state(ctx)
            changed = [p for p in after if before.get(p) != after[p]]
            self.assertIn('two.txt', changed)
            # Deleting shows up as a removal.
            (ctx.workspace / 'one.txt').unlink()
            final = hostd.workspace_tree_state(ctx)
            self.assertIn('one.txt', [p for p in after if p not in final])

    def test_watch_and_pty_require_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            off = make_ctx(tmp)          # no workspace configured
            self.assertFalse(hostd.handle_search(off, {'q': 'x'})['ok'])
            self.assertFalse(hostd.handle_git_status(off, {})['ok'])
            self.assertFalse(hostd.handle_pty_open(off, {})['ok'])


# ---------------------------------------------------------------------------
# v0.5.0 production hardening
# ---------------------------------------------------------------------------

class ProductionHardeningTests(unittest.TestCase):
    def test_version_flag(self):
        result = subprocess.run([sys.executable, str(RESOURCES / 'frostbyte_hostd.py'), '--version'],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), f'frostbyte-hostd {hostd.DAEMON_VERSION}')

    def test_public_bind_requires_the_explicit_lan_flag(self):
        daemon = str(RESOURCES / 'frostbyte_hostd.py')
        rejected = subprocess.run([sys.executable, daemon, '--host', '0.0.0.0', '--once'],
                                  capture_output=True, text=True, timeout=15)
        self.assertEqual(rejected.returncode, 2)
        self.assertIn('invalid choice', rejected.stderr)

    def test_sampler_runs_docker_once_per_heavy_tick(self):
        with tempfile.TemporaryDirectory() as tmp:
            recipes = Path(tmp) / 'recipes.json'
            recipes.write_text(json.dumps({'schema': 1, 'recipes': [
                {'id': 'd1', 'title': 'One', 'kind': 'docker', 'container': 'c1'},
                {'id': 'd2', 'title': 'Two', 'kind': 'docker', 'container': 'c2'}]}))
            os.chmod(recipes, 0o600)
            runner = make_runner({('nvidia-smi',): (0, NVIDIA_SAMPLER),
                                  ('tmux',): (1, ''), ('docker',): (1, '')})
            sampler = hostd.Sampler(hostd.RecipeBook(recipes), proc_root=fake_proc_dir(tmp),
                                      runner=runner, interval=1.0)
            sampler._tick()  # tick 1 is heavy
            docker_ps = [c for c in runner.calls if c[:2] == ['docker', 'ps']]
            self.assertEqual(len(docker_ps), 1,
                             'one docker ps per heavy tick regardless of docker recipe count')

    def test_docker_preflight_batches_inspect_and_blocks_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            other1, other2 = 'a' * 64, 'b' * 64
            recipes = Path(tmp) / 'recipes.json'
            recipes.write_text(json.dumps({'schema': 1, 'recipes': [
                {'id': 'docker-model', 'title': 'D', 'kind': 'docker', 'container': 'test-container'}]}))
            os.chmod(recipes, 0o600)
            runner = make_runner({
                ('docker', 'inspect', '--format', hostd.DOCKER_FORMAT, 'test-container'):
                    (0, json.dumps({'id': 'c' * 64, 'name': '/test-container', 'state': 'exited',
                                    'devices': None, 'runtime': 'runc', 'ports': None})),
                ('docker', 'ps', '-q', '--no-trunc'): (0, other1 + '\n' + other2 + '\n'),
                ('docker', 'inspect', '--format', hostd.DOCKER_FORMAT, other1): (0, '\n'.join([
                    json.dumps({'id': other1, 'name': '/first', 'state': 'running',
                                'devices': [{'Driver': 'nvidia'}], 'runtime': 'nvidia', 'ports': None}),
                    json.dumps({'id': other2, 'name': '/second', 'state': 'running',
                                'devices': None, 'runtime': 'runc', 'ports': None})])),
                ('nvidia-smi',): (0, ''),
            })
            ctx = make_ctx(tmp, runner=runner, recipes=recipes)
            result = hostd.handle_control(
                {'action': 'start', 'kind': 'docker', 'target': 'docker-model',
                 'host': ctx.hostname, 'confirm': True}, ctx)
            self.assertFalse(result['ok'])
            self.assertIn('Another GPU or serving-port container', result['message'])
            batched = [c for c in runner.calls
                       if c[:2] == ['docker', 'inspect'] and other1 in c]
            self.assertEqual(len(batched), 1, 'other-container preflight must batch into one inspect')
            self.assertIn(other2, batched[0])
            self.assertFalse(any(c[:2] == ['docker', 'start'] for c in runner.calls))


class FrostByteWorkspaceRootsTests(unittest.TestCase):
    def test_named_roots_are_explicit_distinct_and_request_scoped(self):
        with tempfile.TemporaryDirectory() as tmp:
            one = Path(tmp) / 'one'
            two = Path(tmp) / 'two'
            one.mkdir()
            two.mkdir()
            roots = hostd.parse_workspace_specs([f'code={one}', f'docs={two}'])
            ctx = make_ctx(tmp)
            ctx.workspaces = roots
            ctx.default_workspace_id = 'code'
            ctx.workspace = roots['code']
            ctx.workspace_id = 'code'
            code = hostd.workspace_context(ctx, 'code')
            docs = hostd.workspace_context(ctx, 'docs')
            self.assertEqual(code.workspace, one.resolve())
            self.assertEqual(docs.workspace, two.resolve())
            self.assertIs(code._parent, docs._parent)
            self.assertEqual(hostd.handle_workspace(docs)['id'], 'docs')
            self.assertEqual([item['id'] for item in hostd.handle_workspaces(ctx)['roots']], ['code', 'docs'])
            with self.assertRaises(ValueError):
                hostd.workspace_context(ctx, 'missing')
            with self.assertRaises(ValueError):
                hostd.parse_workspace_specs([f'a={one}', f'b={one}'])

    def test_named_root_routing_never_crosses_roots(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = Path(tmp) / 'code'
            docs = Path(tmp) / 'docs'
            code.mkdir()
            docs.mkdir()
            ctx = make_ctx(tmp)
            ctx.workspaces = {'code': code.resolve(), 'docs': docs.resolve()}
            ctx.default_workspace_id = 'code'
            ctx.workspace_id = 'code'
            ctx.workspace = code.resolve()
            server = hostd.FrostByteHostServer(('127.0.0.1', 0), ctx)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                payload = json.dumps({'root': 'docs', 'path': 'note.txt',
                                      'content_b64': __import__('base64').b64encode(b'docs').decode(),
                                      'confirm': True})
                conn = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
                conn.request('POST', '/v1/fs/write', payload,
                             {'Authorization': 'Bearer ' + ctx.token, 'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                conn.close()
                self.assertEqual((docs / 'note.txt').read_text(), 'docs')
                self.assertFalse((code / 'note.txt').exists())

                conn = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
                conn.request('GET', '/v1/workspace?root=missing',
                             headers={'Authorization': 'Bearer ' + ctx.token})
                self.assertEqual(conn.getresponse().status, 400)
                conn.close()

                conn = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
                conn.request('GET', '/v1/info', headers={'Authorization': 'Bearer ' + ctx.token})
                info = json.loads(conn.getresponse().read())
                self.assertIn('workspace-roots-v1', info['capabilities'])
                conn.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


class FrostByteInferenceProxyTests(unittest.TestCase):
    def test_models_chat_and_stream_use_only_fixed_loopback_upstream(self):
        requests = []

        class Upstream(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def do_GET(self):
                requests.append((self.command, self.path, None, self.headers.get('Authorization')))
                body = json.dumps({'data': [{'id': 'local-model', 'object': 'model', 'owned_by': 'local'}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                document = json.loads(body)
                requests.append((self.command, self.path, document, self.headers.get('Authorization')))
                if document.get('stream'):
                    payload = b'data: {"id":"c","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                else:
                    payload = json.dumps({'id': 'c', 'choices': [{'index': 0,
                        'message': {'role': 'assistant', 'content': 'hi'}, 'finish_reason': 'stop'}]}).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_ctx(tmp)
            ctx.endpoint_port = upstream.server_address[1]
            server = hostd.FrostByteHostServer(('127.0.0.1', 0), ctx)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            headers = {'Authorization': 'Bearer ' + ctx.token, 'Content-Type': 'application/json'}
            try:
                conn = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
                conn.request('GET', '/v1/models', headers=headers)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['data'][0]['id'], 'local-model')
                conn.close()

                prompt = {'model': 'local-model', 'messages': [{'role': 'user', 'content': 'hello'}]}
                conn = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
                conn.request('POST', '/v1/chat/completions', json.dumps(prompt), headers)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['choices'][0]['message']['content'], 'hi')
                conn.close()

                prompt['stream'] = True
                conn = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
                conn.request('POST', '/v1/chat/completions', json.dumps(prompt), headers)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn(b'data: [DONE]', response.read())
                conn.close()
                self.assertEqual([entry[1] for entry in requests],
                                 ['/v1/models', '/v1/chat/completions', '/v1/chat/completions'])
                self.assertTrue(all(entry[3] is None for entry in requests),
                                'host bearer must never be forwarded to inference')

                conn = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
                conn.request('POST', '/v1/chat/completions', json.dumps({'model': 'local-model'}), headers)
                self.assertEqual(conn.getresponse().status, 400)
                conn.close()
                self.assertEqual(len(requests), 3, 'invalid prompts must not reach the model endpoint')
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        upstream.shutdown()
        upstream.server_close()
        upstream_thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
