import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Address4, Address6 } from 'ip-address';
import {
  guardWebTorrentDhtQueries,
  guardWebTorrentPeerAddresses,
  isGloballyRoutablePeerEndpoint,
  TorrentEngine,
  usePairedDiscovery,
} from '../src/main/torrent.js';

test('IP parser rejects cross-family subnet matches and bounds malformed IPv6 diagnostics', () => {
  // Regressions for GHSA-j6r3-76f7-8jcv and GHSA-h3mg-xc3c-68pw.
  assert.equal(new Address6('a00::1').isInSubnet(new Address4('10.0.0.0/8')), false);
  assert.equal(new Address4('32.1.13.184').isInSubnet(new Address6('2001:db8::/32')), false);
  assert.equal(new Address4('10.0.0.1').isInSubnet(new Address4('10.0.0.0/8')), true);
  assert.throws(() => new Address6('!'.repeat(1024)), error => {
    assert.equal(error.name, 'AddressError');
    assert.ok(error.message.length < 512);
    assert.equal(error.parseMessage, undefined);
    return true;
  });
});

test('DHT UDP queries reject private compact nodes and recheck bootstrap DNS results', async () => {
  const sent = [];
  const resolutions = new Map([
    ['router.bittorrent.com', '1.1.1.1'],
    ['router.utorrent.com', '10.0.0.8'],
  ]);
  const socket = {
    query(peer, message, callback) {
      sent.push({ ...peer });
      const resolved = resolutions.get(peer.host);
      if (resolved) return this.query({ host: resolved, port: peer.port }, message, callback);
      queueMicrotask(() => callback?.(null, { ok: true }, peer));
      return sent.length;
    },
  };
  const client = { dht: { _rpc: { socket } } };
  guardWebTorrentDhtQueries(client);

  const query = peer => new Promise(resolve => {
    let synchronous = true;
    socket.query(peer, { q: 'find_node', a: {} }, error => resolve({ error, synchronous }));
    synchronous = false;
  });
  for (const peer of [
    { host: '10.0.0.2', port: 6881 },
    { host: '169.254.169.254', port: 80 },
    { host: '::ffff:127.0.0.1', port: 6881 },
    { host: '64:ff9b::7f00:1', port: 6881 },
    { host: 'attacker.invalid', port: 6881 },
  ]) {
    const result = await query(peer);
    assert.equal(result.error?.code, 'FROSTBYTE_DHT_BOUNDARY', JSON.stringify(peer));
    assert.equal(result.synchronous, false, 'blocked query callbacks stay asynchronous');
  }
  assert.deepEqual(sent, []);

  assert.equal((await query({ host: 'router.bittorrent.com', port: 6881 })).error, null);
  assert.deepEqual(sent.splice(0), [
    { host: 'router.bittorrent.com', port: 6881 },
    { host: '1.1.1.1', port: 6881 },
  ]);
  const privateResolution = await query({ host: 'router.utorrent.com', port: 6881 });
  assert.equal(privateResolution.error?.code, 'FROSTBYTE_DHT_BOUNDARY');
  assert.deepEqual(sent, [{ host: 'router.utorrent.com', port: 6881 }], 'a private bootstrap result never reaches UDP send');

  const testSent = [];
  const testSocket = { query(peer, _message, callback) { testSent.push(peer); queueMicrotask(() => callback?.(null)); } };
  guardWebTorrentDhtQueries({ dht: { _rpc: { socket: testSocket } } }, { allowPeerAddresses: true });
  await new Promise(resolve => testSocket.query({ host: '127.0.0.1', port: 6881 }, {}, resolve));
  assert.deepEqual(testSent, [{ host: '127.0.0.1', port: 6881 }]);
});

test('peer endpoint policy accepts only globally routable numeric IP literals', () => {
  const blocked = [
    'localhost:80',
    'instance-data.internal:80',
    '2130706433:80',
    '0x7f000001:80',
    '127.0.0.1:80',
    '127.1:80',
    '10.0.0.1:6881',
    '172.16.0.1:6881',
    '192.168.0.1:6881',
    '169.254.169.254:80',
    '100.64.0.1:6881',
    '0.0.0.0:6881',
    '224.0.0.1:6881',
    '198.51.100.1:6881',
    '[::1]:80',
    '[fe80::1]:80',
    '[fc00::1]:80',
    '[fd12:3456::1]:80',
    '[::ffff:127.0.0.1]:80',
    '[::ffff:10.0.0.1]:80',
    '[::ffff:169.254.169.254]:80',
    '[64:ff9b::7f00:1]:80',
    '[64:ff9b::a00:1]:80',
    '[2001:db8::1]:80',
    '[2002:7f00:1::]:80',
    '[2606:4700:4700::1111%en0]:80',
    '1.1.1.1:0',
    '1.1.1.1:-1',
    '1.1.1.1:80.5',
    '1.1.1.1/32:80',
  ];
  for (const endpoint of blocked) {
    assert.equal(isGloballyRoutablePeerEndpoint(endpoint), false, endpoint);
  }

  for (const endpoint of [
    '1.1.1.1:1',
    '8.8.8.8:65534',
    '1.1.1.1:65535',
    '[2606:4700:4700::1111]:6881',
    '[2001:4860:4860::8888]:443',
  ]) {
    assert.equal(isGloballyRoutablePeerEndpoint(endpoint), true, endpoint);
  }
});

function fakeClient() {
  const client = new EventEmitter();
  client.torrents = [];
  return client;
}

function fakeTorrent() {
  const torrent = new EventEmitter();
  torrent.calls = [];
  torrent.addPeer = function (peer, source) {
    this.calls.push({ peer, source });
    return true;
  };
  return torrent;
}

test('peer gate blocks tracker, DHT, PEX, and manual local endpoints before WebTorrent sees them', () => {
  const client = fakeClient();
  guardWebTorrentPeerAddresses(client);
  const torrent = fakeTorrent();
  const blocked = [];
  torrent.on('blockedPeer', peer => blocked.push(peer));
  client.emit('add', torrent);

  for (const source of ['tracker', 'dht', 'ut_pex', 'manual', undefined]) {
    assert.equal(torrent.addPeer('127.0.0.1:8080', source), false);
  }
  assert.equal(torrent.addPeer('metadata.internal:80', 'tracker'), false);
  assert.equal(torrent.calls.length, 0);
  assert.equal(blocked.length, 6);

  assert.equal(torrent.addPeer('1.1.1.1:6881', 'dht'), true);
  assert.deepEqual(torrent.calls, [{ peer: '1.1.1.1:6881', source: 'dht' }]);
});

test('explicit test-only peer bypass retains isolated loopback transfers', () => {
  const client = fakeClient();
  guardWebTorrentPeerAddresses(client, { allowPeerAddresses: true });
  const torrent = fakeTorrent();
  client.emit('add', torrent);

  assert.equal(torrent.addPeer('127.0.0.1:6881', 'manual'), true);
  assert.equal(torrent.addPeer('localhost:6881', 'tracker'), true);
  assert.equal(torrent.calls.length, 2);
});

test('private endpoints require the paired-only discovery capability', () => {
  const client = fakeClient();
  guardWebTorrentPeerAddresses(client);

  const ordinary = fakeTorrent();
  client.emit('add', ordinary);
  assert.equal(ordinary.addPeer('10.0.0.2:6881', 'manual'), false);
  assert.equal(ordinary.addPairedPeer('10.0.0.2:6881'), false);
  assert.equal(ordinary.calls.length, 0);

  const paired = fakeTorrent();
  client.emit('add', paired);
  usePairedDiscovery(paired);
  assert.equal(paired.addPeer('10.0.0.2:6881', 'manual'), false);
  assert.equal(paired.addPairedPeer('10.0.0.2:6881'), true);
  assert.equal(paired.addPairedPeer('[fd12:3456::2]:6881'), true);
  assert.equal(paired.addPairedPeer('1.1.1.1:6881'), true);
  for (const endpoint of [
    '127.0.0.1:6881',
    '169.254.169.254:80',
    '100.64.0.1:6881',
    '[::1]:6881',
    '[fe80::1]:6881',
    '[::ffff:127.0.0.1]:6881',
    '[::ffff:10.0.0.2]:6881',
    '[::ffff:169.254.169.254]:80',
    '[64:ff9b::a00:2]:6881',
    '[64:ff9b:1::1]:6881',
    '[2001:db8::1]:6881',
  ]) assert.equal(paired.addPairedPeer(endpoint), false, endpoint);
  assert.equal(paired.addPairedPeer('paired-device.local:6881'), false);
  assert.deepEqual(paired.calls, [
    { peer: '10.0.0.2:6881', source: 'manual' },
    { peer: '[fd12:3456::2]:6881', source: 'manual' },
    { peer: '1.1.1.1:6881', source: 'manual' },
  ]);

  const testClient = fakeClient();
  guardWebTorrentPeerAddresses(testClient, { allowPeerAddresses: true });
  const testPaired = fakeTorrent();
  testClient.emit('add', testPaired);
  usePairedDiscovery(testPaired);
  assert.equal(testPaired.addPairedPeer('127.0.0.1:6881'), true);
  assert.equal(testPaired.addPairedPeer('169.254.169.254:80'), false);
  assert.equal(testPaired.addPairedPeer('[::ffff:127.0.0.1]:6881'), false);
  assert.equal(testPaired.addPairedPeer('localhost:6881'), false);
});

test('TorrentEngine installs the peer gate synchronously and keeps LSD disabled', async t => {
  const engine = new TorrentEngine({ dht: false, tracker: false, lsd: true });
  t.after(() => engine.destroy());
  assert.equal(engine.client.lsd, false);

  const torrent = engine.client.add(`magnet:?xt=urn:btih:${'a'.repeat(40)}`, { paused: true });
  const blocked = [];
  torrent.on('blockedPeer', peer => blocked.push(peer));
  assert.equal(torrent.addPeer('127.0.0.1:8080', 'tracker'), false);
  assert.deepEqual(blocked, ['127.0.0.1:8080']);
});
