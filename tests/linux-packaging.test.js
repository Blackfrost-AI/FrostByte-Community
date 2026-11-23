import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builderConfigFor } from './helpers/builder-config.mjs';
import { EDITIONS } from '../src/shared/edition-manifest.cjs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { linuxAppRun, writeLinuxAppRun } = require('../build/linux-apprun.cjs');

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const builderSource = fs.readFileSync(new URL('../electron-builder.cjs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/package-linux.yml', import.meta.url), 'utf8');
const ciWorkflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
const verifier = fs.readFileSync(new URL('../scripts/test-packaged.js', import.meta.url), 'utf8');

test('Linux packaging stages the exact native runtime before x64 package targets', () => {
  for (const name of ['pack:linux', 'dist:linux']) {
    const script = packageJson.scripts[name];
    assert.match(script, /^node scripts\/build-ipfs-runtime\.js linux-x64 && npm run build:licenses && npm run build:icon && npm run build:spark && electron-builder --linux --x64 /);
    assert.match(script, /--publish never$/);
  }
  assert.match(packageJson.scripts['pack:linux'], /--dir --publish never$/);
  assert.doesNotMatch(packageJson.scripts['dist:linux'], /--dir/);

  // Asserted against the resolved config rather than against builder source
  // text, so the single shipped edition cannot silently lose a requirement.
  {
    const id = 'community';
    const edition = EDITIONS[id];
    const builder = builderConfigFor(id);
    const extra = builder.linux.extraResources;
    assert.deepEqual(extra, [{ from: 'build/ipfs-runtime/linux-${arch}', to: 'ipfs-runtime' }], `${id}: linux extraResources`);

    const targets = builder.linux.target;
    assert.deepEqual(targets.find(t => t.target === 'AppImage'), { target: 'AppImage', arch: ['x64'] }, `${id}: AppImage target`);
    assert.deepEqual(targets.find(t => t.target === 'deb'), { target: 'deb', arch: ['x64'] }, `${id}: deb target`);

    assert.equal(builder.linux.artifactName, `${edition.artifactPrefix}-\${version}-linux-x64.\${ext}`, `${id}: linux artifactName`);
    assert.equal(builder.linux.executableName, edition.linuxExecutable, `${id}: executableName`);
    assert.equal(builder.linux.syncDesktopName, true, `${id}: syncDesktopName`);
    assert.equal(builder.deb.packageName, edition.packageName, `${id}: deb packageName`);

    const torrent = builder.linux.fileAssociations.find(f => f.ext === 'torrent');
    assert.equal(torrent.mimeType, 'application/x-bittorrent', `${id}: torrent MIME type`);
    for (const dependency of ['libsecret-1-0', 'libnotify4', 'xdg-utils', 'libgbm1', 'libasound2t64 | libasound2']) {
      assert.ok(builder.deb.depends.includes(dependency), `${id}: deb depends on ${dependency}`);
    }
    assert.ok(builder.deb.recommends.includes('openssh-client'), `${id}: deb recommends openssh-client`);
    assert.deepEqual(builder.appImage.executableArgs, [], `${id}: AppImage must not disable the sandbox`);

    // desktopName drives the launcher name via syncDesktopName and is asserted by
    // scripts/test-packaged.js against the packaged metadata.
    assert.equal(packageJson.desktopName, EDITIONS[packageJson.frostbyteEdition].desktopName);
  }

  assert.match(builderSource, /syncDesktopName: true/);
});

test('Linux uses a stable edition profile and the verifier covers ELF, AppImage, Debian, and native launch', () => {
  assert.match(main, /process\.platform === 'linux'\) app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), EDITION_INFO\.profile, 'electron'\)\)/);
  assert.match(main, /!app\.isPackaged && process\.platform === 'linux'[\s\S]*?FROSTBYTE_TEST_LINUX_PASSWORD_STORE === 'gnome-libsecret'[\s\S]*?appendSwitch\('password-store', 'gnome-libsecret'\)/);
  assert.match(main, /setOpenAtLogin/);
  assert.match(verifier, /linux-unpacked/);
  assert.match(verifier, /valid x64 ELF executable/);
  assert.match(verifier, /--appimage-extract/);
  assert.match(verifier, /dpkg-deb/);
  assert.match(verifier, /assertLinuxDesktopIntegration/);
  assert.match(verifier, /AppRun %U/);
  assert.match(verifier, /package-type/);
  assert.match(verifier, /APPIMAGE_EXTRACT_AND_RUN/);
  assert.doesNotMatch(verifier, /launchArguments\.unshift\('--no-sandbox'\)/);
  assert.match(verifier, /path\.dirname\(fs\.realpathSync\(target\)\), 'chrome-sandbox'/);
  assert.match(verifier, /metadata\.uid !== 0 \|\| \(mode !== 0o0755 && mode !== 0o4755\)/);
  assert.match(verifier, /process\.exit\(result\.status \?\? 1\)/);
});

test('Linux hardening addresses the exact case-sensitive executable and installs the reviewed launcher', () => {
  const hardening = fs.readFileSync(new URL('../build/harden-electron.cjs', import.meta.url), 'utf8');
  assert.match(hardening, /platform === 'linux' \? context\.packager\.executableName : product \+ suffix/);
  assert.match(hardening, /if \(platform === 'linux'\) await writeLinuxAppRun\(context\.appOutDir, context\.packager\.executableName\)/);
});

test('companion tar listing separates benign metadata warnings from entries without hiding failures', () => {
  const helperSource = verifier.match(/function commandOutput\(command, args, \{ stdoutOnly = false \} = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helperSource, 'the bounded command helper must be present');
  const output = vm.runInNewContext(`(${helperSource})`, { spawnSync });
  const warning = "tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'";
  const args = ['-e', `process.stdout.write('package.json\\n'); process.stderr.write(${JSON.stringify(warning)});`];
  assert.equal(output(process.execPath, args, { stdoutOnly: true }), 'package.json\n');
  assert.match(output(process.execPath, args), /LIBARCHIVE\.xattr/);
  assert.throws(() => output(process.execPath, ['-e', "process.stderr.write('archive truncated'); process.exit(2)"], { stdoutOnly: true }), /failed \(2\): archive truncated/);
  assert.match(verifier, /commandOutput\('tar', \['-tzf', companionArchive\], \{ stdoutOnly: true \}\)/);
});

test('AppImage launcher fails closed and preserves magnet arguments without shell expansion', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-apprun-'));
  const mocks = path.join(root, 'commands');
  fs.mkdirSync(mocks);
  const executable = (name, value) => fs.writeFileSync(path.join(mocks, name), value, { mode: 0o755 });
  try {
    await writeLinuxAppRun(root, 'frostbyte');
    assert.equal(fs.readFileSync(path.join(root, 'AppRun'), 'utf8'), linuxAppRun('frostbyte'));
    assert.equal(fs.statSync(path.join(root, 'AppRun')).mode & 0o777, 0o755);
    assert.throws(() => linuxAppRun('../bad'), /Unsafe/);
    executable('id', '#!/bin/sh\nprintf "%s\\n" 1000\n');
    executable('unshare', '#!/bin/sh\nexit 0\n');
    executable('zenity', '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(root, 'frostbyte'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${mocks}${path.delimiter}/usr/bin${path.delimiter}/bin`, APPDIR: '/deliberately/wrong' };
    const magnet = 'magnet:?xt=urn:btih:abc&dn=hello%20world&x=$(false)';
    const valid = spawnSync(path.join(root, 'AppRun'), [magnet, 'file with spaces.torrent'], { encoding: 'utf8', env });
    assert.ifError(valid.error);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, `${magnet}\nfile with spaces.torrent\n`);
    for (const argument of ['--no-sandbox', '--no-sandbox=true']) {
      const rejected = spawnSync(path.join(root, 'AppRun'), [argument], { encoding: 'utf8', env });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /will not turn the sandbox off automatically/);
    }
    executable('unshare', '#!/bin/sh\nexit 1\n');
    const unavailable = spawnSync(path.join(root, 'AppRun'), [], { encoding: 'utf8', env });
    assert.equal(unavailable.status, 1);
    assert.match(unavailable.stderr, /Debian \(\.deb\) package/);
    assert.equal(unavailable.stdout, '');
    executable('id', '#!/bin/sh\nprintf "%s\\n" 0\n');
    const rootUser = spawnSync(path.join(root, 'AppRun'), [], { encoding: 'utf8', env });
    assert.equal(rootUser.status, 1);
    assert.match(rootUser.stderr, /regular user/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the private Linux lane is pinned, commit-bound, native, and non-publishing', () => {
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /source_commit:/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /ref: \$\{\{ inputs\.source_commit \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --no-audit --no-fund/);
  assert.match(workflow, /npm run dist:linux/);
  // Founders Edition is retired (private handoff, 2026-11-09): the linux-x64
  // release:stage step lived on the Founders leg and is no longer present on any
  // leg. The community lane stays strictly non-publishing.
  assert.doesNotMatch(workflow, /release:stage -- linux-x64/);
  const keyringUnlock = workflow.indexOf('gnome-keyring-daemon --daemonize --components=secrets --unlock');
  const keyringProbe = workflow.indexOf('secret-tool store');
  assert.ok(keyringUnlock >= 0 && keyringProbe > keyringUnlock, 'headless CI must create/unlock its disposable keyring before probing Secret Service');
  assert.doesNotMatch(workflow, /gnome-keyring-daemon --(?:login|start)/, 'a headless job has no PAM session to hand off the login daemon');
  assert.match(workflow, /export FROSTBYTE_TEST_LINUX_PASSWORD_STORE=gnome-libsecret/);
  assert.match(workflow, /timeout --foreground --signal=TERM --kill-after=10s 15m/);
  // The install/remove identity is resolved from the per-edition profile output,
  // not hardcoded — so both matrix legs verify their own executable name.
  assert.match(workflow, /apt-get remove --yes \$\{\{ steps\.release\.outputs\.linux_executable \}\}/);
  assert.doesNotMatch(workflow, /apt-get remove --yes frostbyte-founders/);
  assert.doesNotMatch(workflow, /command -v frostbyte-founders/);
  assert.doesNotMatch(workflow, /\.config\/frostbyte-founders\//);
  assert.match(workflow, /--require-linux-sandbox/);
  assert.doesNotMatch(workflow, /release:assemble|release:stage\s+--\s+(?:darwin|win32)|gh release|npm publish/);
  for (const line of workflow.split('\n').filter(line => /^\s*uses:/.test(line))) {
    assert.match(line, /@[a-f0-9]{40}(?:\s+#.*)?$/, `workflow action is not pinned: ${line.trim()}`);
  }
  assert.match(ciWorkflow, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(ciWorkflow, /uses: \.\/\.github\/workflows\/package-linux\.yml/);
  assert.match(ciWorkflow, /source_commit: \$\{\{ github\.sha \}\}/);
});
