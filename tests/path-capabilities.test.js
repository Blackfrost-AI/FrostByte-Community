import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { PathCapabilities } from '../src/main/path-capabilities.js';

test('native path grants are purpose-bound, path-bound, expiring, and single-use', () => {
  let now = 1000;
  const grants = new PathCapabilities({ now: () => now });
  const selected = path.join(os.tmpdir(), 'frostbyte-selected');
  const save = grants.grant(selected, 'save');
  assert.throws(() => grants.consume(save.capability, path.join(os.tmpdir(), 'other'), 'save'), /Choose this file or folder again/);
  assert.equal(grants.consume(save.capability, selected, 'save'), path.resolve(selected), 'a mismatched request does not burn the real selection');

  const seed = grants.grant(selected, 'seed');
  assert.throws(() => grants.consume(seed.capability, selected, 'save'), /Choose this file or folder again/);

  const valid = grants.grant(selected, 'completed');
  assert.equal(grants.consume(valid.capability, selected, 'completed'), path.resolve(selected));
  assert.throws(() => grants.consume(valid.capability, selected, 'completed'), /Choose this file or folder again/);

  const torrent = grants.grant(`${selected}.torrent`, 'torrent');
  assert.equal(grants.verify(torrent.capability, torrent.path, 'torrent'), torrent.path);
  assert.equal(grants.verify(torrent.capability, torrent.path, 'torrent'), torrent.path, 'preview checks are reusable');
  assert.equal(grants.consume(torrent.capability, torrent.path, 'torrent'), torrent.path);
  assert.throws(() => grants.verify(torrent.capability, torrent.path, 'torrent'), /Choose this file or folder again/);

  const dismissed = grants.grant(`${selected}-dismissed.torrent`, 'torrent');
  assert.equal(grants.verify(dismissed.capability, dismissed.path, 'torrent'), dismissed.path);
  assert.equal(grants.revoke(dismissed.capability), true);
  assert.equal(grants.revoke(dismissed.capability), false, 'revocation is safe after a grant was already released');
  assert.throws(() => grants.verify(dismissed.capability, dismissed.path, 'torrent'), /Choose this file or folder again/);

  const expired = grants.grant(selected, 'save');
  now += 16 * 60 * 1000;
  assert.throws(() => grants.consume(expired.capability, selected, 'save'), /Choose this file or folder again/);
});
