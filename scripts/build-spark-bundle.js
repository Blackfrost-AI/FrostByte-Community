/** Build the self-contained desktop payload (never node_modules or user settings). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sparkCompanionSources } from './spark-companion-files.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'build', 'spark-companion');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-companion-'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
try {
  const original = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const pkg = Object.fromEntries(['name', 'version', 'description', 'license', 'type', 'dependencies', 'engines'].map(key => [key, original[key]]));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  lock.version = pkg.version;
  lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([name, info]) => !name || !info.dev));
  lock.packages[''] = { name: pkg.name, version: pkg.version, license: pkg.license, dependencies: pkg.dependencies, engines: pkg.engines };
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(staging, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  for (const relative of sparkCompanionSources) {
    fs.mkdirSync(path.dirname(path.join(staging, relative)), { recursive: true });
    fs.copyFileSync(path.join(root, relative), path.join(staging, relative));
  }
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, 'source.tar.gz');
  execFileSync('tar', ['-czf', archive, 'package.json', 'package-lock.json', ...sparkCompanionSources], { cwd: staging, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const archiveData = fs.readFileSync(archive);
  const installerData = fs.readFileSync(path.join(root, 'build/spark-onboard.py'));
  fs.writeFileSync(path.join(output, 'onboard.py'), installerData);
  const macInstallerData = fs.readFileSync(path.join(root, 'build/mac-onboard.py'));
  fs.writeFileSync(path.join(output, 'mac-onboard.py'), macInstallerData);
  const manifest = { schemaVersion: 1, version: pkg.version, archive: 'source.tar.gz', bytes: archiveData.length,
    sha256: digest(archiveData), installer: 'onboard.py', installerSha256: digest(installerData),
    macInstaller: 'mac-onboard.py', macInstallerSha256: digest(macInstallerData) };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Spark companion ${pkg.version}: ${(archiveData.length / 1024).toFixed(0)} KiB, SHA-256 ${manifest.sha256}`);
} finally { fs.rmSync(staging, { recursive: true, force: true }); }
