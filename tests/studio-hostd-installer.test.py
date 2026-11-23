"""Focused tests for the non-root frostbyte-hostd installer."""

import importlib.util
import json
import os
from pathlib import Path
import plistlib
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
INSTALLER_PATH = ROOT / 'src/hostd/install_user.py'
SPEC = importlib.util.spec_from_file_location('frostbyte_hostd_installer', INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class ServiceManifestTests(unittest.TestCase):
    def test_linux_unit_uses_user_paths_loopback_and_exact_argv(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = installer.layout('linux', tmp)
            argv = installer.service_argv(paths, '/usr/bin/python3', port=8757,
                endpoint_port=30000, bind_lan=False, spark_profile=False,
                workspaces=[f'code={Path(tmp) / "Code Space"}'])
            unit = installer.render_systemd(argv, '/usr/local/bin:/usr/bin:/bin')
            self.assertIn('frostbyte-hostd', unit)
            self.assertIn(quote(paths['token']), unit)
            self.assertNotIn('--bind-lan', unit)
            self.assertNotIn('--spark-profile', unit)
            self.assertIn('--workspace', unit)
            self.assertNotIn('sudo ', unit)

    def test_launchd_plist_is_structured_and_lan_requires_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = installer.layout('darwin', tmp)
            argv = installer.service_argv(paths, '/usr/bin/python3', port=9000,
                endpoint_port=31000, bind_lan=True, spark_profile=True, workspaces=[])
            document = plistlib.loads(installer.render_launchd(argv, paths, '/usr/bin:/bin'))
            self.assertEqual(document['Label'], 'com.frostbyte.hostd')
            self.assertIn('--bind-lan', document['ProgramArguments'])
            self.assertIn('--spark-profile', document['ProgramArguments'])
            self.assertEqual(document['ProgramArguments'][0], '/usr/bin/python3')
            self.assertTrue(document['RunAtLoad'])


def quote(value):
    return installer.quote_systemd(value)


class InstallerFilesystemTests(unittest.TestCase):
    def args(self, home, **overrides):
        values = dict(system='linux', home=str(home), workspace=None, port=8757,
                      endpoint_port=30000, bind_lan=False, dry_run=False,
                      rotate_token=False, no_start=True, spark_profile=None)
        values.update(overrides)
        return types.SimpleNamespace(**values)

    def test_install_is_non_root_private_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            workspace = home / 'project'
            workspace.mkdir()
            args = self.args(home, workspace=[f'code={workspace}'])
            with mock.patch.object(installer.os, 'geteuid', return_value=501), \
                 mock.patch.object(installer.shutil, 'which', return_value=sys.executable):
                self.assertEqual(installer.install(args), 0)
                paths = installer.layout('linux', home)
                token = paths['token'].read_text()
                self.assertEqual(os.stat(paths['token']).st_mode & 0o777, 0o600)
                self.assertEqual(os.stat(paths['config']).st_mode & 0o777, 0o700)
                manifest = json.loads(paths['manifest'].read_text())
                self.assertEqual(manifest['workspaces'], [f'code={workspace.resolve()}'])
                self.assertFalse(manifest['bindLan'])
                self.assertNotIn('--bind-lan', paths['unit'].read_text())
                preserved = self.args(home)
                self.assertEqual(installer.install(preserved), 0)
                self.assertEqual(paths['token'].read_text(), token,
                                 'idempotent install must retain the pairing token')
                self.assertEqual(json.loads(paths['manifest'].read_text())['workspaces'],
                                 [f'code={workspace.resolve()}'])

                rotated = self.args(home, rotate_token=True)
                self.assertEqual(installer.install(rotated), 0)
                self.assertNotEqual(paths['token'].read_text(), token)

                with mock.patch.object(installer, 'stop_service') as stop, \
                     mock.patch.object(installer, 'command'):
                    self.assertEqual(installer.uninstall(self.args(home)), 0)
                stop.assert_called_once()
                self.assertFalse(paths['daemon'].exists())
                self.assertFalse(paths['unit'].exists())
                self.assertTrue(paths['token'].exists(), 'uninstall must preserve pairing state')

    def test_reinstall_preserves_restricted_spark_profile_without_repeated_flag(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(installer.os, 'geteuid', return_value=501), \
             mock.patch.object(installer.shutil, 'which', return_value=sys.executable):
            home = Path(tmp)
            self.assertEqual(installer.install(self.args(home, spark_profile=True)), 0)
            paths = installer.layout('linux', home)
            token = paths['token'].read_bytes()
            self.assertEqual(installer.install(self.args(home)), 0)
            self.assertTrue(json.loads(paths['manifest'].read_text())['sparkProfile'])
            self.assertIn('--spark-profile', paths['unit'].read_text())
            self.assertEqual(paths['token'].read_bytes(), token)

    def test_invalid_previous_permissions_do_not_replace_installed_service(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(installer.os, 'geteuid', return_value=501), \
             mock.patch.object(installer.shutil, 'which', return_value=sys.executable):
            home = Path(tmp)
            installer.install(self.args(home, spark_profile=True))
            paths = installer.layout('linux', home)
            unit = paths['unit'].read_bytes()
            for invalid in ['{', '[]', '{"sparkProfile":"false"}']:
                paths['manifest'].write_text(invalid)
                with self.assertRaises(ValueError):
                    installer.install(self.args(home))
                self.assertEqual(paths['unit'].read_bytes(), unit)

    def test_cli_omission_preserves_profile_and_explicit_flag_restricts(self):
        with mock.patch.object(installer, 'install', return_value=0) as install:
            self.assertEqual(installer.main(['install', '--no-start']), 0)
            self.assertIsNone(install.call_args.args[0].spark_profile)
            self.assertEqual(installer.main(['install', '--no-start', '--spark-profile']), 0)
            self.assertTrue(install.call_args.args[0].spark_profile)

    def test_root_execution_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(installer.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ValueError, 'without sudo'):
                installer.install(self.args(Path(tmp), dry_run=True))

    def test_workspace_specs_are_existing_unique_roots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'root'
            root.mkdir()
            self.assertEqual(installer.parse_workspaces([f'code={root}']),
                             [f'code={root.resolve()}'])
            with self.assertRaises(ValueError):
                installer.parse_workspaces([f'a={root}', f'b={root}'])
            with self.assertRaises(ValueError):
                installer.parse_workspaces([f'code={root}', f'code={root}'])
            with self.assertRaises(ValueError):
                installer.parse_workspaces([f'missing={root / "nope"}'])


if __name__ == '__main__':
    unittest.main()
