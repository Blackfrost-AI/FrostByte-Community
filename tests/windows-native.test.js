import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { assertWindowsNativeBinary } = createRequire(import.meta.url)('../build/windows-native.cjs');

test('Windows packaging requires a bounded PE x64 native module, not host-native bytes', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frostbyte-pe-test-'));
  const file=path.join(directory,'fixture.node');
  try {
    const bytes=Buffer.alloc(128); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64,0x3c); bytes.writeUInt32LE(0x4550,64); bytes.writeUInt16LE(0x8664,68);
    fs.writeFileSync(file,bytes); assert.equal(assertWindowsNativeBinary(file),true);
    for(const invalid of [Buffer.from([0xcf,0xfa,0xed,0xfe]),Buffer.from('ELF'),Buffer.alloc(0)]) {
      fs.writeFileSync(file,invalid); assert.throws(()=>assertWindowsNativeBinary(file),/Windows x64/);
    }
    bytes.writeUInt16LE(0xaa64,68); fs.writeFileSync(file,bytes); assert.throws(()=>assertWindowsNativeBinary(file),/Windows x64/);
    bytes.writeUInt32LE(0xffffffff,0x3c); fs.writeFileSync(file,bytes); assert.throws(()=>assertWindowsNativeBinary(file),/Windows x64/);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
