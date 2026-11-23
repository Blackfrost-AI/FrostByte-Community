const fs = require('node:fs');
const path = require('node:path');

// node-datachannel installs one platform's N-API binary, unlike dependencies
// that ship a prebuilds/ matrix. npmRebuild:false must not silently carry the
// build host's Mach-O/ELF binary into a Windows package.
function assertWindowsNativeBinary(file) {
  const bytes = fs.readFileSync(file);
  const pe = bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d ? bytes.readUInt32LE(0x3c) : -1;
  if (pe < 0 || pe > bytes.length - 6 || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error('Windows x64 packaging requires the Windows x64 node-datachannel N-API binary. Run npm ci and the Windows build on Windows; do not package the Mac/Linux native module.');
  }
  return true;
}

function assertWindowsNativeDependencies(root) {
  return assertWindowsNativeBinary(path.join(root, 'node_modules/node-datachannel/build/Release/node_datachannel.node'));
}

module.exports = { assertWindowsNativeBinary, assertWindowsNativeDependencies };
