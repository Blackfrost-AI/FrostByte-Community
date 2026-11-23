import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSelectionFootprint } from '../src/shared/torrent-footprint.js';

// Small readable sizes: every fixture below is exact in bytes.
const bytes = value => `${value} B`;

const file = (path, length, offset) => ({ path, length, offset });

test('a selection with no shared pieces reports only the selected size', () => {
  const preview = {
    pieceLength: 1024,
    files: [file('a.bin', 2048, 0), file('b.bin', 2048, 2048)],
  };
  assert.equal(
    describeSelectionFootprint(preview, [preview.files[1]], bytes),
    '1 of 2 files · 2048 B',
  );
});

test('a packed directory reports the whole footprint, because one piece holds every file', () => {
  // 8 files of 100 B sit inside one 1024 B piece: fetching any of them fetches all.
  const files = Array.from({ length: 8 }, (_, index) => file(`shard-${index}`, 100, index * 100));
  const preview = { pieceLength: 1024, files };
  const summary = describeSelectionFootprint(preview, [files[2], files[3]], bytes);
  assert.equal(summary, '2 of 8 files · 200 B · uses 800 B disk (shared pieces also fetch 600 B of other files)');
});

test('a boundary piece shared with a neighbour reports the over-fetch', () => {
  // config.json shifts every shard off the piece grid, so each shard shares a
  // piece with the next one.
  const preview = {
    pieceLength: 1024,
    files: [
      file('config.json', 12, 0),
      file('shard-0', 2048, 12),
      file('shard-1', 2048, 2060),
    ],
  };
  const summary = describeSelectionFootprint(preview, [preview.files[2]], bytes);
  // shard-1 spans bytes [2060, 4108) => pieces 2..4. Piece 2 is shared with
  // shard-0, which begins at byte 12, so only 12 bytes of shard-0 come along.
  assert.equal(summary, '1 of 3 files · 2048 B · uses 2060 B disk (shared pieces also fetch 12 B of other files)');
});

test('an empty selection is reported, not treated as everything', () => {
  const preview = { pieceLength: 1024, files: [file('a.bin', 10, 0)] };
  assert.equal(describeSelectionFootprint(preview, [], bytes), '0 of 1 files · 0 B');
});

test('without a piece layout the selected size is reported rather than a guess', () => {
  const preview = { files: [file('a.bin', 100, 0)] };
  assert.equal(describeSelectionFootprint(preview, [preview.files[0]], bytes), '1 of 1 files · 100 B');
  const noOffsets = { pieceLength: 1024, files: [{ path: 'a.bin', length: 100 }] };
  assert.equal(describeSelectionFootprint(noOffsets, [noOffsets.files[0]], bytes), '1 of 1 files · 100 B');
});

test('empty files never inflate the footprint', () => {
  const preview = {
    pieceLength: 1024,
    files: [file('empty.bin', 0, 0), file('a.bin', 1024, 0)],
  };
  assert.equal(describeSelectionFootprint(preview, [preview.files[1]], bytes), '1 of 2 files · 1024 B');
});