import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { approvedRevealPath } from '../src/main/reveal-path.js';

test('reveal paths must exactly match a known main-process path', () => {
  const root = path.resolve('/tmp/frostbyte-downloads');
  const file = path.join(root, 'model', 'weights.bin');
  assert.equal(approvedRevealPath(file, [root, file]), file);
  assert.throws(() => approvedRevealPath(path.join(root, 'unrecorded'), [root, file]), /not part/);
  assert.throws(() => approvedRevealPath('relative/model.bin', [file]), /known local/);
  assert.throws(() => approvedRevealPath('https://example.test/model', [file]), /known local/);
});

test('Windows reveal rejects UNC and device paths before matching', () => {
  const allowed = ['C:\\Models\\weights.bin', '\\\\server\\share\\weights.bin'];
  assert.equal(approvedRevealPath('c:\\models\\WEIGHTS.bin', allowed, { platform: 'win32' }), 'c:\\models\\WEIGHTS.bin');
  assert.throws(() => approvedRevealPath('\\\\server\\share\\weights.bin', allowed, { platform: 'win32' }), /Network and device/);
  assert.throws(() => approvedRevealPath('\\\\?\\C:\\Models\\weights.bin', allowed, { platform: 'win32' }), /Network and device/);
  assert.throws(() => approvedRevealPath('\\\\.\\PIPE\\frostbyte', allowed, { platform: 'win32' }), /Network and device/);
});
