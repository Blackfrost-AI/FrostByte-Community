/** Developer convenience; uses the same bundled installer and rollback flow as the desktop app. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SparkSetup } from '../src/main/spark-setup.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.argv[2];
if (!host) throw new Error('Usage: npm run deploy:spark -- your-ssh-alias [absolute-download-folder]');
execFileSync(process.execPath, [path.join(root, 'scripts/build-spark-bundle.js')], { stdio: 'inherit' });
const setup = new SparkSetup({ bundleDir: path.join(root, 'build/spark-companion'), saveConnection: () => {},
  encryptKey: () => { throw new Error('Use the desktop app for password pairing.'); }, onProgress: event => console.log(event.message) });
try {
  const probe = await setup.probe({ mode: 'ssh', host });
  if (probe.stage === 'requirements') throw new Error(probe.message);
  const result = await setup.install({ sessionId: probe.sessionId, downloadDir: process.argv[3] || probe.downloadDir });
  console.log(`Connected to ${result.status.hostname}, companion ${result.status.version}, downloads: ${result.status.downloadDir}`);
} finally { await setup.shutdown(); }
