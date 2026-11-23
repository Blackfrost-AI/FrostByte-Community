import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { TorrentEngine } from '../src/main/torrent.js';

test('optional uTP failures report live TCP fallback without hiding unrelated engine errors', async () => {
  // This test injects the optional transport failure below. Do not bind a real
  // UDP socket first: Windows may reserve the randomly chosen TCP port for UDP
  // and reject it before the injected failure can be tested. The real TCP
  // listener remains live; native uTP is covered by the engine/share tests.
  const engine = new TorrentEngine({ dht: false, tracker: false, utp: false, allowPeerAddresses: true });
  const warnings = [], failures = [];
  engine.on('engine-warning', event => warnings.push(event.message));
  engine.on('engine-error', event => failures.push(event.message));
  try {
    if (!engine.client.listening) await once(engine.client, 'listening');
    // Inject the optional transport failure into an owned fixture. TCP must
    // remain reachable; no other process or port is disturbed by the test.
    for (const code of ['EADDRINUSE', 'EACCES', 'EPERM']) {
      const error = Object.assign(new Error(`UDP bind: ${code}`), { code });
      const warningCount = warnings.length;
      engine.client._connPool._onUTPError(error);
      assert.equal(warnings.length, warningCount + 1);
      assert.match(warnings.at(-1), /continue over TCP/);
      assert.equal(failures.length, warningCount);
      // Even the identical Error, emitted outside the optional listener's
      // synchronous dispatch, must not be mistaken for a transport failure.
      engine.client.emit('error', error);
      assert.equal(failures.at(-1), error.message);
      assert.equal(warnings.length, warningCount + 1);
    }
    const socket = net.connect(engine.port, '127.0.0.1');
    await once(socket, 'connect'); socket.destroy();
    engine.client.emit('error', new Error('storage unavailable'));
    assert.equal(failures.at(-1), 'storage unavailable');
    const pool = engine.client._connPool;
    await new Promise(resolve => pool.tcpServer.close(resolve));
    pool._onUTPError(Object.assign(new Error('TCP unavailable too'), { code: 'EACCES' }));
    assert.equal(failures.at(-1), 'TCP unavailable too');
    assert.equal(warnings.length, 3);
    // Restore the fixture listener so WebTorrent owns its normal shutdown.
    pool.tcpServer.listen(0, '127.0.0.1');
    await once(pool.tcpServer, 'listening');
    await engine.destroy();
    engine.client.emit('error', new Error('engine destroyed'));
    assert.equal(failures.at(-1), 'engine destroyed');
  } finally { await engine.destroy(); }
});

test('native optional UDP server dispatch uses the scoped fallback handler', async (t) => {
  const engine = new TorrentEngine({ dht: false, tracker: false, allowPeerAddresses: true });
  const warnings = [], failures = [];
  engine.on('engine-warning', event => warnings.push(event.message));
  engine.on('engine-error', event => failures.push(event.message));
  try {
    if (!engine.client.listening) await once(engine.client, 'listening');
    const pool = engine.client._connPool;
    if (!pool.utpServer) return t.skip('Native uTP is unavailable on this runtime');
    assert.ok(pool.utpServer.listeners('error').includes(pool._onUTPError));
    const count = warnings.length;
    pool.utpServer.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    assert.equal(warnings.length, count + 1);
    assert.match(warnings.at(-1), /continue over TCP/);
    assert.deepEqual(failures, []);
    const socket = net.connect(engine.port, '127.0.0.1');
    await once(socket, 'connect'); socket.destroy();
  } finally { await engine.destroy(); }
});
