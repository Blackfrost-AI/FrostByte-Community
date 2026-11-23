import test from 'node:test';
import './windows-native.test.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FuseV1Options } from '@electron/fuses';
import { npmAuditInvocation, validateAudit } from '../scripts/check-npm-audit.js';
import { assertDirectoryContainsParity, assertDirectoryParity, assertInstallerFilename, assertWindowsInstallerParity, requireMacSigningIdentity, validateArchiveEntries, validateMacCodeSigning, validateMacDmgLayout, validateWindowsAuthenticode } from '../scripts/release-artifacts.js';
import { sparkCompanionSources } from '../scripts/spark-companion-files.js';
import { allowTestTrackerEndpoints, normalizeExtraTrackers } from '../src/main/store.js';
import { AGENT_TEST_MARKER_CONTENT, AGENT_TEST_MARKER_RELATIVE, sourceAgentTestModeEnabled } from '../src/agent/test-mode.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json')));

function packageIdentity(lockPath, metadata) {
  const marker = '/node_modules/';
  const at = lockPath.lastIndexOf(marker);
  const name = lockPath.slice(at < 0 ? 'node_modules/'.length : at + marker.length);
  return `${name}@${metadata.version}`;
}

test('packaging applies an explicit policy to every Electron fuse', async () => {
  const hook = require('../build/harden-electron.cjs');
  const expected = {
    RunAsNode: false,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: false,
    WasmTrapHandlers: true,
  };
  assert.deepEqual(hook.FUSE_POLICY, expected);
  const apiFuses = Object.keys(FuseV1Options).filter(name => Number.isNaN(Number(name)));
  assert.deepEqual(Object.keys(expected).sort(), apiFuses.sort(), 'new Electron fuses require an explicit review');
  assert.equal(packageJson.devDependencies['@electron/fuses'], '2.1.3');
  const builderSource = fs.readFileSync(path.join(project, 'electron-builder.cjs'), 'utf8');
  // The hardening hook must be wired in the builder config, not merely present in
  // the tree. Asserted against the resolved config below, so this only pins that
  // the source is the file that produces it.
  assert.match(builderSource, /afterPack:\s*'build\/harden-electron\.cjs'/);
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const config = await getConfig(project, 'electron-builder.cjs');
  await validateConfiguration(config, { isEnabled: false });
  assert.equal(config.afterPack, 'build/harden-electron.cjs');
});

test('packaged runtime cannot unlock private tracker test endpoints with argv or environment', () => {
  const switches = {
    argv: ['/Applications/FrostByte.app/Contents/MacOS/FrostByte', '--dev'],
    env: { FROSTBYTE_TEST_DIRECT_PEERS: '1' },
    electronVersion: '44.3.0',
  };
  const loopback = 'http://127.0.0.1:8080/announce';
  const approved = 'udp://tracker.opentrackr.org:1337/announce';

  assert.equal(allowTestTrackerEndpoints({ ...switches, defaultApp: false }), false);
  assert.throws(() => normalizeExtraTrackers(loopback, { ...switches, defaultApp: false }), /supported by this FrostByte release/);
  assert.equal(normalizeExtraTrackers(approved, { ...switches, defaultApp: false }), approved);

  assert.equal(allowTestTrackerEndpoints({ ...switches, defaultApp: true }), true);
  assert.equal(normalizeExtraTrackers(loopback, { ...switches, defaultApp: true }), loopback);
});

test('packaged main process cannot enter development or private peer test mode', () => {
  const source = fs.readFileSync(path.join(project, 'src/main/index.js'), 'utf8');
  assert.match(source, /const isDev\s*=\s*!app\.isPackaged\s*&&\s*process\.argv\.includes\('--dev'\)/);
  assert.match(source, /const allowTestPeerAddresses\s*=\s*isDev\s*&&\s*process\.env\.FROSTBYTE_TEST_DIRECT_PEERS\s*===\s*'1'/);
});

test('release entitlements preserve Apple library validation', () => {
  const local = fs.readFileSync(path.join(project, 'build/entitlements.mac.plist'), 'utf8');
  const release = fs.readFileSync(path.join(project, 'build/entitlements.mac.release.plist'), 'utf8');
  assert.match(local, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.doesNotMatch(release, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(release, /com\.apple\.security\.cs\.allow-jit/);
  const signing = fs.readFileSync(path.join(project, 'build/signing-macos.cjs'), 'utf8');
  assert.equal((signing.match(/entitlements\.mac\.release\.plist/g) || []).length, 2);
});

test('strict native signature verification accepts the shipped edition', () => {
  // Deliberately incompatible platform flags stop before touching a bundle.
  // The edition must reach that platform guard, not reject the release.
  const result = spawnSync(process.execPath, [path.join(project, 'scripts/test-packaged.js'),
    '--community-build', '--require-release-signature', '--require-linux-sandbox'],
  { cwd: project, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, process.platform === 'linux'
    ? /Linux publisher verification uses a separately signed checksum record/
    : /--require-linux-sandbox is only supported on Linux/);
  assert.doesNotMatch(result.stderr, /only valid for a private edition/);
});

test('strict install-script policy covers every locked lifecycle script', () => {
  const npmrc = fs.readFileSync(path.join(project, '.npmrc'), 'utf8');
  assert.match(npmrc, /^strict-allow-scripts=true$/m);
  assert.match(npmrc, /^engine-strict=true$/m);
  assert.equal(packageJson.engines.npm, '>=11.17.0');
  const uncovered = [];
  for (const [lockPath, metadata] of Object.entries(lock.packages)) {
    if (!metadata.hasInstallScript) continue;
    const identity = packageIdentity(lockPath, metadata);
    if (!Object.hasOwn(packageJson.allowScripts, identity)) uncovered.push(identity);
  }
  assert.deepEqual(uncovered, []);
  assert.equal(packageJson.allowScripts['ssh2@1.17.0'], false);
  assert.equal(packageJson.allowScripts['cpu-features@0.0.10'], false);
});

test('Spark container bases are pinned to one reviewed multi-platform digest', () => {
  const dockerfile = fs.readFileSync(path.join(project, 'build/spark.Dockerfile'), 'utf8');
  const images = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(match => match[1]);
  assert.equal(images.length, 2);
  assert.equal(new Set(images).size, 1);
  assert.match(images[0], /^node:22\.23\.2-bookworm-slim@sha256:[a-f0-9]{64}$/);
});

test('Spark container runtime drops host privileges and keeps its image read-only', () => {
  const installer = fs.readFileSync(path.join(project, 'build/spark-onboard.py'), 'utf8');
  for (const option of ["'--user'", "'--read-only'", "'--cap-drop', 'ALL'", "'no-new-privileges:true'", "'--pids-limit', '256'"]) {
    assert.match(installer, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(installer, /'--tmpfs', '\/tmp:rw,noexec,nosuid,nodev,size=67108864'/);
});

test('Spark companion payload is closed over local imports and both installers accept that exact set', () => {
  const sourceSet = new Set(['package.json', 'package-lock.json', ...sparkCompanionSources]);
  for (const relative of sparkCompanionSources.filter(file => /\.[cm]?js$/.test(file))) {
    const source = fs.readFileSync(path.join(project, relative), 'utf8');
    const imports = [
      ...source.matchAll(/\b(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g),
    ].map(match => path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
    for (const imported of imports) {
      assert.ok(sourceSet.has(imported), `${relative} imports missing companion source ${imported}`);
    }
  }

  const expected = ['package.json', 'package-lock.json', ...sparkCompanionSources].sort();
  const installerSets = [
    ['build/mac-onboard.py', /ALLOWED = \{([^}]*?)\}(?:\nALLOWED\.update\(\{([^}]*?)\}\))?/],
    ['build/spark-onboard.py', /    allowed = \{([^}]*?)\}(?:\n    allowed\.update\(\{([^}]*?)\}\))?/],
  ];
  for (const [relative, pattern] of installerSets) {
    const match = fs.readFileSync(path.join(project, relative), 'utf8').match(pattern);
    assert.ok(match, `could not locate companion allowlist in ${relative}`);
    const allowed = [...match.slice(1).join('\n').matchAll(/'([^']+)'/g)].map(value => value[1]).sort();
    assert.deepEqual(allowed, expected, `${relative} companion allowlist differs from the built payload`);
  }
});

test('Spark private-peer test mode requires a source marker omitted from companion payloads', t => {
  const enabled = { FROSTBYTE_AGENT_TEST: '1' };
  const sourceMarker = path.join(project, ...AGENT_TEST_MARKER_RELATIVE.split('/'));
  assert.equal(fs.readFileSync(sourceMarker, 'utf8'), AGENT_TEST_MARKER_CONTENT);
  assert.equal(sourceAgentTestModeEnabled({ env: {}, sourceRoot: project }), false);
  assert.equal(sourceAgentTestModeEnabled({ env: enabled, sourceRoot: project }), true);
  assert.equal(sparkCompanionSources.includes(AGENT_TEST_MARKER_RELATIVE), false);
  assert.equal(sparkCompanionSources.some(relative => relative.startsWith('tests/')), false);

  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-agent-test-boundary-'));
  t.after(() => fs.rmSync(extracted, { recursive: true, force: true }));
  assert.equal(sourceAgentTestModeEnabled({ env: enabled, sourceRoot: extracted }), false,
    'the environment switch alone must be inert in an extracted companion');
  const extractedMarker = path.join(extracted, ...AGENT_TEST_MARKER_RELATIVE.split('/'));
  fs.mkdirSync(path.dirname(extractedMarker), { recursive: true });
  fs.writeFileSync(extractedMarker, 'X'.repeat(Buffer.byteLength(AGENT_TEST_MARKER_CONTENT)));
  assert.equal(sourceAgentTestModeEnabled({ env: enabled, sourceRoot: extracted }), false,
    'a same-sized marker with different bytes must be inert');
  fs.writeFileSync(extractedMarker, AGENT_TEST_MARKER_CONTENT);
  assert.equal(sourceAgentTestModeEnabled({ env: enabled, sourceRoot: extracted }), true);
  if (process.platform !== 'win32') {
    fs.rmSync(extractedMarker);
    fs.symlinkSync(sourceMarker, extractedMarker);
    assert.equal(sourceAgentTestModeEnabled({ env: enabled, sourceRoot: extracted }), false,
      'a linked marker must be inert');
  }
});

test('committed macOS icon contains every required PNG representation', () => {
  const bytes = fs.readFileSync(path.join(project, 'build/icon.icns'));
  assert.equal(bytes.toString('ascii', 0, 4), 'icns');
  assert.equal(bytes.readUInt32BE(4), bytes.length);
  const types = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= bytes.length, 'invalid ICNS chunk length');
    types.push(bytes.toString('ascii', offset, offset + 4));
    offset += length;
  }
  assert.deepEqual(types, ['icp4', 'ic11', 'icp5', 'ic12', 'ic07', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10']);
});

test('production audit policy permits only the reviewed WebTorrent client advisory chain', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(project, 'security/npm-audit-policy.json')));
  assert.deepEqual(policy.exceptions.map(exception => exception.advisory), ['GHSA-2p57-rm9w-gvfp']);
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      ip: { severity: 'high', nodes: ['node_modules/ip'], via: [{ url: 'https://github.com/advisories/GHSA-2p57-rm9w-gvfp', severity: 'high' }] },
      'bittorrent-tracker': { severity: 'high', nodes: ['node_modules/bittorrent-tracker'], via: ['ip'] },
      'torrent-discovery': { severity: 'high', nodes: ['node_modules/torrent-discovery'], via: ['bittorrent-tracker'] },
      webtorrent: { severity: 'high', nodes: ['node_modules/webtorrent'], via: ['torrent-discovery'] },
    },
  };
  assert.deepEqual(validateAudit(report, policy, lock, '2026-09-12'), ['GHSA-2P57-RM9W-GVFP']);
  assert.throws(() => validateAudit({ ...report, vulnerabilities: {
    ...report.vulnerabilities,
    debug: { severity: 'critical', nodes: ['node_modules/debug'], via: [{ url: 'https://github.com/advisories/GHSA-1111-2222-3333', severity: 'critical' }] },
  } }, policy, lock, '2026-09-12'), /Unexpected production dependency advisory/);
  assert.throws(() => validateAudit(report, policy, lock, '2026-12-13'), /expired/);
  assert.throws(() => validateAudit({ ...report, vulnerabilities: { ...report.vulnerabilities, debug: { severity: 'high', nodes: ['node_modules/debug'], via: ['ip'] } } }, policy, lock, '2026-09-12'), /different package chain/);
  const nestedLock = structuredClone(lock);
  nestedLock.packages['node_modules/other/node_modules/ip'] = { version: '1.1.9' };
  const nestedReport = structuredClone(report);
  nestedReport.vulnerabilities.ip.nodes.push('node_modules/other/node_modules/ip');
  assert.throws(() => validateAudit(nestedReport, policy, nestedLock, '2026-09-12'), /unreviewed ip node or version/);
  nestedLock.packages['node_modules/other/node_modules/ip'].version = '2.0.1';
  assert.throws(() => validateAudit(nestedReport, policy, nestedLock, '2026-09-12'), /unreviewed ip node or version/);
  const unknownNode = structuredClone(report);
  unknownNode.vulnerabilities.ip.nodes = ['node_modules/missing/node_modules/ip'];
  assert.throws(() => validateAudit(unknownNode, policy, lock, '2026-09-12'), /unknown locked dependency path/);
  const changedPolicy = structuredClone(policy);
  changedPolicy.exceptions[0].nodes[0].path = 'node_modules/missing/node_modules/ip';
  assert.throws(() => validateAudit(report, changedPolicy, lock, '2026-09-12'), /unreviewed or missing locked node/);
});

test('production audit executes npm through its declared JavaScript CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-npm-cli-'));
  try {
    const packageRoot = path.join(root, 'node_modules', 'npm');
    const cli = path.join(packageRoot, 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'npm', version: '11.17.0', bin: { npm: 'bin/npm-cli.js' },
    }));
    assert.deepEqual(npmAuditInvocation({ nodePath: '/reviewed/node', npmExecPath: cli }), {
      command: '/reviewed/node', args: [fs.realpathSync(cli), 'audit', '--omit=dev', '--json'],
    });
    assert.throws(() => npmAuditInvocation({ npmExecPath: '' }), /npm run audit:production/);
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'not-npm', version: '11.17.0', bin: { npm: 'bin/npm-cli.js' },
    }));
    assert.throws(() => npmAuditInvocation({ npmExecPath: cli }), /declared JavaScript CLI/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reviewed ip usage remains confined to the tracker-server parser', () => {
  const library = path.join(project, 'node_modules/bittorrent-tracker/lib');
  const pending = [library];
  const imports = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith('.js') && /(?:from\s+|require\()(['"])ip\1/.test(fs.readFileSync(target, 'utf8'))) {
        imports.push(path.relative(library, target).replaceAll('\\', '/'));
      }
    }
  }
  assert.deepEqual(imports.sort(), ['server/parse-udp.js']);
});

test('strict release artifacts bind the publisher, version, and installer payload', t => {
  const signature = {
    Status: 'Valid', SignatureType: 'Authenticode', Subject: 'CN=Blackfrost Test Publisher',
    Thumbprint: 'A'.repeat(40), TimestampSubject: 'CN=Timestamp Service', TimestampThumbprint: 'B'.repeat(40),
  };
  assert.equal(validateWindowsAuthenticode(signature, 'FrostByte.exe', signature.Subject), true);
  assert.throws(() => validateWindowsAuthenticode(signature, 'FrostByte.exe', ''), /requires FROSTBYTE_WINDOWS_SIGNING_SUBJECT/);
  assert.throws(() => validateWindowsAuthenticode(signature, 'FrostByte.exe', 'CN=Another Publisher'), /configured FrostByte publisher/);
  const macIdentity = 'Developer ID Application: Blackfrost Test Publisher (A1B2C3D4E5)';
  const macDetails = `Authority=${macIdentity}\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=A1B2C3D4E5\n`;
  assert.deepEqual(requireMacSigningIdentity(macIdentity), { authority: macIdentity, teamIdentifier: 'A1B2C3D4E5' });
  assert.equal(validateMacCodeSigning(macDetails, macIdentity), true);
  assert.throws(() => validateMacCodeSigning(macDetails, 'Developer ID Application: Another Publisher (Z9Y8X7W6V5)'), /configured FrostByte/);
  assert.throws(() => validateMacCodeSigning(macDetails.replace('TeamIdentifier=A1B2C3D4E5', 'TeamIdentifier=Z9Y8X7W6V5'), macIdentity), /configured FrostByte/);
  assert.throws(() => requireMacSigningIdentity('Developer ID Application: Publisher (short)'), /full FROSTBYTE_MAC_SIGNING_IDENTITY/);
  assert.equal(assertInstallerFilename('/release/FrostByte-0.2.0-beta.15-win-x64-setup.exe', 'win32', '0.2.0-beta.15'), true);
  assert.equal(assertInstallerFilename('/release/FrostByte-0.2.0-beta.15-mac-arm64.dmg', 'darwin', '0.2.0-beta.15'), true);
  assert.equal(assertInstallerFilename('/release/FrostByte-0.2.0-beta.15-linux-x64.AppImage', 'linux', '0.2.0-beta.15'), true);
  assert.equal(assertInstallerFilename('/release/FrostByte-0.2.0-beta.15-linux-x64.deb', 'linux', '0.2.0-beta.15'), true);
  assert.throws(() => assertInstallerFilename('/release/FrostByte-0.2.0-beta.14-win-x64-setup.exe', 'win32', '0.2.0-beta.15'), /matching/);
  assert.deepEqual([...validateArchiveEntries(['FrostByte.exe', 'resources/', 'resources/app.asar'])], ['FrostByte.exe', 'resources', 'resources/app.asar']);
  assert.throws(() => validateArchiveEntries(['../outside']), /unsafe path/);
  assert.throws(() => validateArchiveEntries(['resources/file.txt:stream']), /invalid path/);

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-release-parity-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const reviewed = path.join(fixture, 'reviewed'), installed = path.join(fixture, 'installed');
  for (const directory of [reviewed, installed]) {
    fs.mkdirSync(path.join(directory, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'FrostByte.exe'), 'application');
    fs.writeFileSync(path.join(directory, 'resources/app.asar'), 'archive');
  }
  assert.equal(assertDirectoryParity(reviewed, installed), true);
  fs.writeFileSync(path.join(installed, 'AppRun'), 'package integration launcher');
  assert.equal(assertDirectoryContainsParity(reviewed, installed), true);
  fs.rmSync(path.join(installed, 'AppRun'));
  fs.writeFileSync(path.join(reviewed, 'resources/apparmor-profile'), 'builder-generated confinement profile');
  assert.throws(() => assertDirectoryContainsParity(reviewed, installed), /missing or changed/);
  assert.equal(assertDirectoryContainsParity(reviewed, installed, { optionalReviewedFiles: ['resources/apparmor-profile'] }), true);
  fs.writeFileSync(path.join(installed, 'resources/apparmor-profile'), 'changed confinement profile');
  assert.throws(() => assertDirectoryContainsParity(reviewed, installed, { optionalReviewedFiles: ['resources/apparmor-profile'] }), /differs/);
  fs.writeFileSync(path.join(installed, 'resources/apparmor-profile'), 'builder-generated confinement profile');
  assert.equal(assertDirectoryParity(reviewed, installed), true);
  fs.rmSync(path.join(reviewed, 'resources/apparmor-profile'));
  fs.rmSync(path.join(installed, 'resources/apparmor-profile'));
  fs.writeFileSync(path.join(installed, 'resources/apparmor-profile'), 'builder-generated confinement profile');
  assert.equal(assertDirectoryParity(reviewed, installed, { optionalInstalledFiles: ['resources/apparmor-profile'] }), true);
  fs.writeFileSync(path.join(installed, 'unexpected'), 'unreviewed executable');
  assert.throws(() => assertDirectoryParity(reviewed, installed, { optionalInstalledFiles: ['resources/apparmor-profile'] }), /payload differs/);
  fs.rmSync(path.join(installed, 'unexpected'));
  fs.rmSync(path.join(installed, 'resources/apparmor-profile'));
  fs.writeFileSync(path.join(installed, 'resources/app.asar'), 'changed');
  assert.throws(() => assertDirectoryParity(reviewed, installed), /payload differs/);

  if (process.platform !== 'win32') {
    const dmg = path.join(fixture, 'dmg');
    fs.mkdirSync(dmg);
    fs.cpSync(reviewed, path.join(dmg, 'FrostByte.app'), { recursive: true });
    fs.symlinkSync('/Applications', path.join(dmg, 'Applications'));
    assert.equal(validateMacDmgLayout(dmg), path.join(dmg, 'FrostByte.app'));
    fs.writeFileSync(path.join(dmg, 'unexpected.command'), 'echo unsafe');
    assert.throws(() => validateMacDmgLayout(dmg), /unexpected top-level item/);
    fs.rmSync(path.join(dmg, 'unexpected.command'));
    fs.rmSync(path.join(dmg, 'FrostByte.app'), { recursive: true });
    fs.symlinkSync(reviewed, path.join(dmg, 'FrostByte.app'));
    assert.throws(() => validateMacDmgLayout(dmg), /real FrostByte\.app directory/);
  }
});

test('isolated NSIS verification exercises install cleanup and detects omitted native payload files', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-nsis-parity-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const reviewed = path.join(fixture, 'reviewed');
  const installer = path.join(fixture, 'FrostByte-0.2.0-beta.15-win-x64-setup.exe');
  const files = new Map([
    ['FrostByte.exe', 'main PE bytes'],
    ['ffmpeg.dll', 'Chromium DLL bytes'],
    ['resources/app.asar', 'application archive'],
    ['resources/app.asar.unpacked/node_modules/node-datachannel/build/Release/node_data_channel.node', 'native addon bytes'],
  ]);
  for (const [relative, body] of files) {
    const target = path.join(reviewed, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  fs.writeFileSync(installer, 'fixture NSIS executable');

  const exercise = (omitted) => {
    const calls = [];
    const run = (command, args, context) => {
      calls.push({ command, args, ...context });
      if (context.phase === 'install') {
        for (const [relative] of files) {
          if (relative === omitted) continue;
          const target = path.join(context.installRoot, relative);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(reviewed, relative), target);
        }
        fs.writeFileSync(path.join(context.installRoot, 'Uninstall FrostByte.exe'), 'uninstaller');
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const verify = () => assertWindowsInstallerParity(installer, reviewed, { run, tempDirectory: fixture });
    if (omitted) assert.throws(verify, /payload differs/);
    else assert.equal(verify(), true);
    assert.equal(calls[0].phase, 'install');
    assert.deepEqual(calls[0].args.slice(0, 1), ['/S']);
    assert.equal(calls[0].args.at(-1), `/D=${calls[0].installRoot}`);
    assert.equal(calls.at(-1).phase, 'uninstall');
    assert.deepEqual(calls.at(-1).args, ['/S', `_?=${calls.at(-1).installRoot}`]);
    assert.equal(fs.existsSync(calls[0].installRoot), false);
  };

  exercise();
  for (const omitted of ['FrostByte.exe', 'ffmpeg.dll', 'resources/app.asar.unpacked/node_modules/node-datachannel/build/Release/node_data_channel.node']) {
    exercise(omitted);
  }
});

test('renderer trust and real device approval regressions run in development and both package workflows', () => {
  const ci = fs.readFileSync(path.join(project, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /github\.event\.repository\.private/, 'community CI must not silently skip public repositories');
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/package-macos.yml', '.github/workflows/package-windows.yml', '.github/workflows/package-linux.yml']) {
    assert.match(fs.readFileSync(path.join(project, file), 'utf8'), /tests\/e2e\/renderer-trust\.spec\.js/, file);
    assert.match(fs.readFileSync(path.join(project, file), 'utf8'), /tests\/e2e\/device-approvals\.spec\.js/, file);
  }
  for (const file of ['.github/workflows/package-macos.yml', '.github/workflows/package-windows.yml', '.github/workflows/package-linux.yml']) {
    assert.match(fs.readFileSync(path.join(project, file), 'utf8'), /--installer/, `${file} must verify the installer payload`);
  }
  const verifier = fs.readFileSync(path.join(project, 'scripts/test-packaged.js'), 'utf8');
  assert.match(verifier, /assertWindowsInstallerParity\(file, bundle\)/);
  assert.match(verifier, /assertDirectoryParity\(bundle, installedBundle\)/);
  const windowsWorkflow = fs.readFileSync(path.join(project, '.github/workflows/package-windows.yml'), 'utf8');
  assert.match(windowsWorkflow, /ELECTRON_BUILDER_7Z_FILTER:\s*BCJ/);
  assert.match(windowsWorkflow, /--isolated-installer-check/);
  assert.match(packageJson.scripts['pack:win'], /scripts\/build-windows\.js --dir/);
  assert.match(packageJson.scripts['dist:win'], /scripts\/build-windows\.js$/);
  assert.match(fs.readFileSync(path.join(project, 'scripts/build-windows.js'), 'utf8'), /ELECTRON_BUILDER_7Z_FILTER:\s*'BCJ'/);
});
