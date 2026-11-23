import test from 'node:test';
import assert from 'node:assert/strict';
import { TorrentDiscoveryAuthorizations } from '../src/main/torrent-authorizations.js';

test('torrent discovery approval is bounded to the exact normalized content identity', () => {
  let now = 1000;
  const grants = new TorrentDiscoveryAuthorizations({ ttlMs: 1000, max: 2, now: () => now });
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
  assert.equal(grants.approve(`magnet:?xt=urn:btih:${a}&tr=https://attacker.invalid/announce`, 'inspect'), a);
  assert.equal(grants.has(a, 'inspect'), true);
  assert.equal(grants.has(a, 'download'), false, 'metadata review never grants a download');
  assert.equal(grants.has(b, 'inspect'), false);
  assert.equal(grants.consume(`magnet:?xt=urn:btih:${a}&dn=changed`, 'inspect'), true);
  assert.equal(grants.has(a, 'inspect'), false);

  grants.approve(a, 'inspect'); grants.approve(b, 'inspect'); grants.approve(c, 'inspect');
  assert.equal(grants.has(a, 'inspect'), false, 'oldest approval is evicted');
  assert.equal(grants.has(b, 'inspect'), true); assert.equal(grants.has(c, 'inspect'), true);
  now += 1001;
  assert.equal(grants.has(b, 'inspect'), false, 'approval expires');
});
