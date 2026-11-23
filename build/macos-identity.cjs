// Electron reuses its launcher binaries across apps. macOS network privacy also
// keys on their LC_UUIDs (Apple TN3178/TN3179), not just CFBundleIdentifier.
// Personalize ONLY app executables, before code signing. Shared libraries retain
// their upstream UUIDs. The receipt preserves the upstream symbol UUID mapping.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const receiptPath = 'Contents/Resources/macos-identity.json';
const uuidString = bytes => {
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
};

function executableUuids(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) throw new Error('Invalid Mach-O executable.');
  const slices = [];
  function thin(start, length) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 32 || start + length > bytes.length) throw new Error('Invalid Mach-O slice bounds.');
    const magic = bytes.readUInt32LE(start);
    if (magic !== 0xfeedfacf) throw new Error('Expected a little-endian 64-bit Mach-O executable.');
    const read = offset => bytes.readUInt32LE(start + offset);
    if (read(12) !== 2) throw new Error('Only MH_EXECUTE images may be personalized.');
    const count = read(16), size = read(20), end = start + 32 + size;
    if (count < 1 || count > 4096 || end > start + length || count * 8 > size) throw new Error('Invalid Mach-O load-command bounds.');
    let offset = start + 32, found;
    for (let i = 0; i < count; i++) {
      if (offset + 8 > end) throw new Error('Truncated Mach-O load command.');
      const command = bytes.readUInt32LE(offset), commandSize = bytes.readUInt32LE(offset + 4);
      if (commandSize < 8 || commandSize % 8 || offset + commandSize > end) throw new Error('Invalid Mach-O load command.');
      if (command === 0x1b) {
        if (found || commandSize !== 24) throw new Error('Expected exactly one LC_UUID per executable slice.');
        found = { cpuType: read(4), cpuSubtype: read(8), offset: offset + 8, uuid: uuidString(bytes.subarray(offset + 8, offset + 24)) };
      }
      offset += commandSize;
    }
    if (offset !== end || !found || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(found.uuid)) throw new Error('Executable must contain a nonzero LC_UUID.');
    slices.push(found);
  }
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const wide = magic === 0xcafebabf, width = wide ? 32 : 20, count = bytes.readUInt32BE(4);
    const headerEnd = 8 + width * count;
    if (count < 1 || count > 8 || headerEnd > bytes.length) throw new Error('Invalid universal Mach-O header.');
    const ranges = [];
    for (let i = 0; i < count; i++) {
      const offset = 8 + width * i;
      const start = wide ? Number(bytes.readBigUInt64BE(offset + 8)) : bytes.readUInt32BE(offset + 8);
      const length = wide ? Number(bytes.readBigUInt64BE(offset + 16)) : bytes.readUInt32BE(offset + 12);
      if (start < headerEnd || ranges.some(([a, b]) => start < b && start + length > a)) throw new Error('Overlapping universal Mach-O slices.');
      ranges.push([start, start + length]);
      thin(start, length);
      const last = slices.at(-1);
      if (last.cpuType !== bytes.readUInt32BE(offset) || last.cpuSubtype !== bytes.readUInt32BE(offset + 4)) throw new Error('Universal Mach-O architecture mismatch.');
    }
  } else thin(0, bytes.length);
  return slices;
}

function personalizeExecutable(bytes, identity) {
  if (typeof identity !== 'string' || !identity || identity.length > 2048) throw new Error('Missing app executable identity.');
  const result = Buffer.from(bytes), slices = executableUuids(bytes);
  const sourceHash = createHash('sha256').update(bytes).digest();
  const records = slices.map(({ offset, uuid, cpuType, cpuSubtype }) => {
    // Hash-based UUIDv8: reproducible for the same app/code; distinct between
    // editions, executable roles, app versions, architectures, and code bytes.
    const value = createHash('sha256').update('FrostByte Mach-O identity v1\0').update(identity).update('\0').update(sourceHash)
      .update(`\0${cpuType}:${cpuSubtype}`).digest().subarray(0, 16);
    value[6] = (value[6] & 0x0f) | 0x80; value[8] = (value[8] & 0x3f) | 0x80;
    value.copy(result, offset);
    return { cpuType, cpuSubtype, originalUuid: uuid, uuid: uuidString(value) };
  });
  return { bytes: result, slices: records };
}

function bundleExecutables(bundle) {
  const frameworkDir = path.join(bundle, 'Contents/Frameworks');
  const apps = [bundle, ...fs.readdirSync(frameworkDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.endsWith('.app')).map(entry => path.join(frameworkDir, entry.name))].sort();
  return apps.map(app => {
    const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }));
    if (!/^[A-Za-z0-9.-]+$/.test(plist.CFBundleIdentifier || '') || !plist.CFBundleExecutable || /[\/\\\0]/.test(plist.CFBundleExecutable)) throw new Error('Invalid app executable metadata.');
    const file = path.join(app, 'Contents/MacOS', plist.CFBundleExecutable);
    if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(bundle) + path.sep)) throw new Error('App executable must be an owned bundle file.');
    return { path: path.relative(bundle, file).split(path.sep).join('/'), bundleId: plist.CFBundleIdentifier };
  });
}

function personalizeMacBundle(bundle, appId, version) {
  const target = path.join(bundle, receiptPath);
  if (fs.existsSync(target)) throw new Error('Mac executable identities were already prepared. Rebuild from fresh Electron binaries.');
  const executables = bundleExecutables(bundle).map(entry => {
    const file = path.join(bundle, entry.path);
    const result = personalizeExecutable(fs.readFileSync(file), `${appId}\0${version}\0${entry.bundleId}\0${entry.path}`);
    fs.writeFileSync(file, result.bytes);
    return { ...entry, slices: result.slices };
  });
  fs.writeFileSync(target, JSON.stringify({ schema: 1, appId, version, executables }, null, 2) + '\n');
  verifyMacBundleIdentity(bundle, appId, version);
}

function verifyMacBundleIdentity(bundle, appId, version) {
  const receipt = JSON.parse(fs.readFileSync(path.join(bundle, receiptPath), 'utf8'));
  const expected = bundleExecutables(bundle);
  if (receipt.schema !== 1 || receipt.appId !== appId || receipt.version !== version || !Array.isArray(receipt.executables) || receipt.executables.length !== expected.length) throw new Error('Mac executable identity receipt does not match this app.');
  const seen = new Set(), originals = new Set(receipt.executables.flatMap(entry => entry.slices || []).map(slice => slice.originalUuid));
  for (let i = 0; i < expected.length; i++) {
    const entry = receipt.executables[i];
    if (entry.path !== expected[i].path || entry.bundleId !== expected[i].bundleId) throw new Error('Mac executable identity receipt has an unexpected target.');
    const actual = executableUuids(fs.readFileSync(path.join(bundle, expected[i].path)));
    if (!Array.isArray(entry.slices) || actual.length !== entry.slices.length) throw new Error('Mac executable architectures changed.');
    for (let j = 0; j < actual.length; j++) {
      const value = actual[j], saved = entry.slices[j];
      if (value.uuid !== saved.uuid || value.cpuType !== saved.cpuType || value.cpuSubtype !== saved.cpuSubtype || originals.has(value.uuid) || seen.has(value.uuid)) throw new Error('Mac executable UUIDs are stale or shared.');
      seen.add(value.uuid);
    }
  }
  return receipt;
}

module.exports = { executableUuids, personalizeExecutable, personalizeMacBundle, verifyMacBundleIdentity };
