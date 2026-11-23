import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { assertWindowsNativeDependencies } = require('../build/windows-native.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prepackaged = process.argv.indexOf('--prepackaged');
const nativeRoot = prepackaged >= 0
  ? path.join(path.resolve(process.argv[prepackaged + 1] || ''), 'resources/app.asar.unpacked')
  : root;
assertWindowsNativeDependencies(nativeRoot);
const cli = require.resolve('electron-builder/out/cli/cli.js');
const args = [cli, '--win', '--x64', ...process.argv.slice(2), '--publish', 'never'];
const result = spawnSync(process.execPath, args, {
  env: { ...process.env, ELECTRON_BUILDER_7Z_FILTER: 'BCJ' },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
