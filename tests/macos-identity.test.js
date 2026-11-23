import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { executableUuids, personalizeExecutable } = require('../build/macos-identity.cjs');

function thin(cpu = 0x0100000c) {
  const bytes = Buffer.alloc(80, 0xab);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0, 24); bytes.writeUInt32LE(0, 28);
  bytes.writeUInt32LE(0x1b, 32); bytes.writeUInt32LE(24, 36);
  return bytes;
}

test('Mac app identities change only LC_UUID and are distinct across bundles and helpers', () => {
  const stock = thin();
  const ids = ['ai.blackfrost.frostbyte:main', 'ai.blackfrost.frostbyte:helper', 'ai.blackfrost.spark:main'];
  const values = ids.map(id => personalizeExecutable(stock, id));
  assert.equal(new Set(values.map(value => executableUuids(value.bytes)[0].uuid)).size, 3);
  for (const value of values) {
    assert.deepEqual(value.bytes.subarray(0, 40), stock.subarray(0, 40));
    assert.deepEqual(value.bytes.subarray(56), stock.subarray(56));
    assert.notEqual(value.slices[0].uuid, value.slices[0].originalUuid);
    assert.match(value.slices[0].uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  }
  assert.deepEqual(values[0], personalizeExecutable(stock, ids[0]), 'same bytes and app identity remain reproducible');
  const changed = Buffer.from(stock); changed[79] ^= 1;
  assert.notEqual(personalizeExecutable(changed, ids[0]).slices[0].uuid, values[0].slices[0].uuid);
  assert.equal(stock[40], 0xab, 'upstream binary was not modified');
});

test('universal binaries get a distinct identity per architecture without touching their layout', () => {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [i, cpu, start] of [[0, 0x0100000c, 64], [1, 0x01000007, 160]]) {
    const at = 8 + 20 * i;
    bytes.writeUInt32BE(cpu, at); bytes.writeUInt32BE(start, at + 8); bytes.writeUInt32BE(80, at + 12);
    thin(cpu).copy(bytes, start);
  }
  const result = personalizeExecutable(bytes, 'fixture-app');
  assert.equal(result.slices.length, 2);
  assert.notEqual(result.slices[0].uuid, result.slices[1].uuid);
  assert.deepEqual(result.bytes.subarray(0, 64), bytes.subarray(0, 64));
  const overlap = Buffer.from(bytes); overlap.writeUInt32BE(64, 36);
  assert.throws(() => executableUuids(overlap), /Overlapping/);
});

test('malformed or non-executable Mach-O inputs fail closed without changing bytes', () => {
  for (const [offset, value] of [[0, 0], [12, 6], [16, 4097], [20, 10000], [32, 0], [36, 8], [36, 32]]) {
    const bytes = thin(); bytes.writeUInt32LE(value, offset);
    const before = Buffer.from(bytes);
    assert.throws(() => personalizeExecutable(bytes, 'fixture'));
    assert.deepEqual(bytes, before);
  }
  assert.throws(() => executableUuids(Buffer.alloc(12)));
  const missing = thin(); missing.fill(0, 40, 56);
  assert.throws(() => executableUuids(missing), /nonzero LC_UUID/);
});

test('actual Electron launcher parses and is never modified in place', { skip: process.platform !== 'darwin' }, () => {
  const stock = fs.readFileSync(new URL('../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', import.meta.url));
  const before = Buffer.from(stock);
  const result = personalizeExecutable(stock, 'fixture-only:community');
  assert.ok(result.slices.length > 0);
  assert.equal(executableUuids(result.bytes).length, executableUuids(stock).length);
  assert.deepEqual(stock, before);
});

test('local signed profile requires Developer ID but neither notarizes nor publishes', { skip: process.platform !== 'darwin' }, () => {
  const env = { ...process.env, FROSTBYTE_EDITION: 'community', FROSTBYTE_MAC_SIGNING_IDENTITY: 'Developer ID Application: Fixture Owner (A1B2C3D4E5)' };
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'GITHUB_BASE_REF', 'CSC_FOR_PULL_REQUEST', 'APPLE_KEYCHAIN_PROFILE']) delete env[key];
  const inspect = identity => spawnSync(process.execPath, ['-e', "const c=require('./build/signing-macos-local.cjs')(); console.log(JSON.stringify(c));"], { env: { ...env, FROSTBYTE_MAC_SIGNING_IDENTITY: identity }, encoding: 'utf8' });
  const output = inspect(env.FROSTBYTE_MAC_SIGNING_IDENTITY);
  assert.equal(output.status, 0, output.stderr);
  const config = JSON.parse(output.stdout);
  assert.equal(config.forceCodeSigning, true); assert.equal(config.publish, null);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.entitlements, 'build/entitlements.mac.release.plist');
  assert.equal(config.mac.entitlementsInherit, 'build/entitlements.mac.release.plist');
  assert.equal(config.directories.output, 'dist/signed-local');
  for (const bad of ['-', '', 'Apple Development: Fixture Owner (A1B2C3D4E5)', 'Developer ID Application: Fixture\nOwner (A1B2C3D4E5)']) assert.notEqual(inspect(bad).status, 0);
});

test('identity personalization is wired before signing and packaged verification requires it', () => {
  const hook = fs.readFileSync(new URL('../build/harden-electron.cjs', import.meta.url), 'utf8');
  assert.ok(hook.indexOf('personalizeMacBundle(executable,') < hook.indexOf("'/usr/bin/codesign'"));
  assert.match(fs.readFileSync(new URL('../scripts/test-packaged.js', import.meta.url), 'utf8'), /verifyMacBundleIdentity\(bundle, expectedEdition.appId, sourceMetadata.version\)/);
});
