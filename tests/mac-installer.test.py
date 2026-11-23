"""Exercise service swaps with an isolated home and launchctl double; no real services changed."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mac_onboard', Path(__file__).parent.parent / 'build/mac-onboard.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MacInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fb-mi-')
        self.addCleanup(self.temp.cleanup)
        home = Path(self.temp.name)
        self.root = home / 'companion'
        self.folder = home / 'models'
        self.calls = []
        self.running = False
        self.health_fail = False
        for name, value in [('ROOT', self.root), ('STATE', self.root / 'state'), ('PLIST', home / 'LaunchAgents/companion.plist')]:
            patcher = patch.object(module, name, value); patcher.start(); self.addCleanup(patcher.stop)
        for target, name, value in [(module.sys, 'platform', 'darwin'), (module.platform, 'machine', lambda: 'arm64'), (module, 'watchdog', lambda stage: None), (module.time, 'sleep', lambda _: None), (module, 'run', self.run_command)]:
            patcher = patch.object(target, name, value); patcher.start(); self.addCleanup(patcher.stop)

    def run_command(self, args, **kwargs):
        args = [str(x) for x in args]
        self.calls.append(args)
        if args[0].endswith('launchctl'):
            if args[1] == 'print':
                return subprocess.CompletedProcess(args, 0 if len(args[2].split('/')) == 2 or self.running else 1, '', '')
            if args[1] == 'bootout': self.running = False
            if args[1] == 'bootstrap': self.running = True
            return subprocess.CompletedProcess(args, 0, '', '')
        if args[-1].endswith('client.js'):
            if self.health_fail: raise RuntimeError('Health check failed')
            return subprocess.CompletedProcess(args, 0, json.dumps({'ok': True, 'data': {'version': '0.2.0-beta.12', 'downloads': []}}), '')
        raise AssertionError(args)

    def payload(self, session='test-session-1'):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name in module.ALLOWED:
                body = b'{"version":"0.2.0-beta.12"}' if name == 'package.json' else b'fixture'
                member = tarfile.TarInfo(name); member.size = len(body)
                archive.addfile(member, io.BytesIO(body))
        data = data.getvalue()
        return {'sessionId': session, 'downloadDir': str(self.folder), 'archive': base64.b64encode(data).decode(),
                'manifest': {'schemaVersion': 1, 'version': '0.2.0-beta.12', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}}

    def call(self, payload, action):
        return module.dispatch({**payload, 'action': action})

    def test_install_and_failed_upgrade_restore_service_and_keep_files(self):
        payload = self.payload()
        self.call(payload, 'prepare')
        (self.folder / 'model.safetensors').write_bytes(b'keep these user bytes')
        self.call(payload, 'activate'); self.call(payload, 'finalize')
        old_target = (self.root / 'current').resolve()
        old_plist = module.PLIST.read_bytes()
        (module.STATE / 'agent.json').write_text('{"downloads":["keep"]}')
        newer = self.payload('test-session-2')
        self.call(newer, 'prepare')
        self.health_fail = True
        with self.assertRaisesRegex(RuntimeError, 'Health check'):
            self.call(newer, 'activate')
        self.assertTrue(self.running)
        self.assertEqual((self.root / 'current').resolve(), old_target)
        self.assertEqual(module.PLIST.read_bytes(), old_plist)
        self.assertEqual((self.folder / 'model.safetensors').read_bytes(), b'keep these user bytes')
        self.assertEqual((module.STATE / 'agent.json').read_text(), '{"downloads":["keep"]}')
        self.call(newer, 'cleanup')

    def test_lost_activation_response_cleanup_restores_first_install(self):
        payload = self.payload()
        self.call(payload, 'prepare'); self.call(payload, 'activate')
        self.call(payload, 'cleanup')
        self.assertFalse(self.running)
        self.assertFalse(module.PLIST.exists())
        self.assertFalse((self.root / 'current').exists())
        self.assertTrue(self.folder.is_dir())

    def test_storage_cannot_silently_change_or_use_absent_external_disk(self):
        payload = self.payload()
        self.call(payload, 'prepare'); self.call(payload, 'activate'); self.call(payload, 'finalize')
        changed = {**self.payload('test-session-3'), 'downloadDir': str(self.folder.parent / 'other')}
        with self.assertRaisesRegex(RuntimeError, 'primary folder'):
            self.call(changed, 'prepare')
        with self.assertRaisesRegex(RuntimeError, 'Mount the external drive'):
            module.storage(Path('/Volumes/FrostByte-Definitely-Absent/Models'))
        self.call({**changed, 'addStorage': True}, 'prepare')
        config = json.loads((self.root / 'install/test-session-3/transaction.json').read_text())['config']
        self.assertEqual(config['downloadDir'], str(self.folder.resolve()))
        self.assertEqual(len(config['storageRoots']), 2)

    def test_symlink_and_unmanaged_service_are_preserved(self):
        module.PLIST.parent.mkdir(parents=True)
        module.PLIST.write_bytes(b'another service')
        with self.assertRaisesRegex(RuntimeError, 'unmanaged'):
            self.call(self.payload(), 'prepare')
        self.assertEqual(module.PLIST.read_bytes(), b'another service')
        module.PLIST.unlink()
        self.root.mkdir(exist_ok=True)
        (self.root / 'install').mkdir()
        (self.root / 'install/test-session-1').symlink_to(self.folder)
        with self.assertRaisesRegex(RuntimeError, 'staging'):
            self.call(self.payload(), 'prepare')

    def test_state_writes_and_activation_lock_do_not_follow_links(self):
        self.root.mkdir()
        stage = self.root / 'install/test-session-1'
        stage.mkdir(parents=True)
        victim = self.root / 'outside-sentinel'
        victim.write_text('do not replace')
        target = stage / 'transaction.json'
        legacy_temporary = target.with_suffix('.tmp')
        legacy_temporary.symlink_to(victim)

        module.save(target, {'phase': 'prepared'})

        self.assertEqual(json.loads(target.read_text()), {'phase': 'prepared'})
        self.assertTrue(legacy_temporary.is_symlink())
        self.assertEqual(victim.read_text(), 'do not replace')
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

        module.PLIST.parent.mkdir(parents=True)
        module.PLIST.symlink_to(victim)
        module.save_bytes(module.PLIST, b'new launch agent')
        self.assertEqual(module.PLIST.read_bytes(), b'new launch agent')
        self.assertFalse(module.PLIST.is_symlink())
        self.assertEqual(victim.read_text(), 'do not replace')

        activation_lock = self.root / 'activation.lock'
        activation_lock.symlink_to(victim)
        with self.assertRaisesRegex(RuntimeError, 'activation lock'):
            module.lock()
        self.assertEqual(victim.read_text(), 'do not replace')
        activation_lock.unlink()

        with module.lock():
            pass
        second_name = self.root / 'activation.lock.alias'
        os.link(activation_lock, second_name)
        with self.assertRaisesRegex(RuntimeError, 'activation lock'):
            module.lock()

    def test_unconfirmed_activation_blocks_another_setup_then_recovers(self):
        payload = self.payload()
        self.call(payload, 'prepare'); self.call(payload, 'activate')
        second = self.payload('test-session-2')
        with self.assertRaisesRegex(RuntimeError, 'awaiting confirmation'):
            self.call(second, 'prepare')
        journal = self.root / 'install/test-session-1/transaction.json'
        value = json.loads(journal.read_text()); value['recoverAfter'] = 0
        module.save(journal, value)
        self.call(second, 'prepare')
        self.assertFalse(self.running)
        self.assertFalse((self.root / 'current').exists())

    def test_stale_recovery_never_stops_a_newer_service(self):
        payload = self.payload()
        self.call(payload, 'prepare'); self.call(payload, 'activate')
        later = self.root / 'releases/newer-committed-release'
        later.mkdir()
        module.point_to(later)
        result = self.call(payload, 'rollback')
        self.assertFalse(result['restored'])
        self.assertTrue(self.running)
        self.assertEqual((self.root / 'current').resolve(), later.resolve())

    def test_committed_service_survives_staging_cleanup_failure(self):
        payload = self.payload()
        self.call(payload, 'prepare'); self.call(payload, 'activate')
        stage = self.root / 'install/test-session-1'
        with patch.object(module.shutil, 'rmtree', side_effect=OSError('busy staging folder')):
            self.assertEqual(self.call(payload, 'finalize'), {'ready': True})
        self.assertTrue(stage.exists())
        self.assertEqual(json.loads((stage / 'transaction.json').read_text())['phase'], 'committed')
        second = self.payload('test-session-2')
        self.call(second, 'prepare')
        self.assertFalse(stage.exists())
        self.call(second, 'cleanup')

    def test_next_setup_reclaims_only_a_stale_abandoned_pre_activation_stage(self):
        first = self.payload('test-session-1')
        self.call(first, 'prepare')
        stage = self.root / 'install/test-session-1'
        runtime = stage / 'source/runtime'
        runtime.mkdir()
        (runtime / 'abandoned-node').write_bytes(b'abandoned build bytes')
        journal = stage / 'transaction.json'
        pending = json.loads(journal.read_text())
        pending['phase'] = 'built'
        pending['lease']['phase'] = 'built'
        pending['lease']['updatedAt'] = module.time.time() - 2 * 60 * 60
        module.save(journal, pending)

        # Even an old timestamp cannot reclaim a stage while its recorded
        # action process is alive.
        second = self.payload('test-session-2')
        self.call(second, 'prepare')
        self.assertTrue(stage.is_dir())
        self.call(second, 'cleanup')

        # A fresh lease also protects the normal gap between build and
        # activation after the action process has exited.
        pending['lease']['pid'] = 2147483647
        pending['lease']['updatedAt'] = module.time.time()
        module.save(journal, pending)
        third = self.payload('test-session-3')
        self.call(third, 'prepare')
        self.assertTrue(stage.is_dir())
        self.call(third, 'cleanup')

        victim = self.root.parent / 'not-frostbyte-staging'
        victim.mkdir()
        (victim / 'sentinel').write_text('keep')
        unsafe = self.root / 'install/symlink-stage-1'
        unsafe.symlink_to(victim)
        pending['lease']['updatedAt'] = module.time.time() - 2 * 60 * 60
        module.save(journal, pending)

        fourth = self.payload('test-session-4')
        self.call(fourth, 'prepare')
        self.assertFalse(stage.exists())
        self.assertTrue(unsafe.is_symlink())
        self.assertEqual((victim / 'sentinel').read_text(), 'keep')
        self.assertFalse(any(call[1] == 'bootout' for call in self.calls if len(call) > 1))
        self.call(fourth, 'cleanup')


if __name__ == '__main__':
    unittest.main()
