import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { allowDebugHfProbe, isAuthorizedAppIpc, lockDownAppWebContents, resolveAppAsset } from '../src/main/app-protocol.js';
import { LaunchSourceQueue, normalizeLaunchSource } from '../src/main/source-arguments.js';

const root = path.resolve('/application');

test('app protocol exposes only packaged renderer, shared, and asset files', () => {
  assert.equal(resolveAppAsset('frostbyte://app/renderer/index.html', root), path.join(root, 'src/renderer/index.html'));
  assert.equal(resolveAppAsset('frostbyte://app/shared/community.js', root), path.join(root, 'src/shared/community.js'));
  assert.equal(resolveAppAsset('frostbyte://app/assets/devices/example.png', root), path.join(root, 'assets/devices/example.png'));
  for (const font of ['Orbitron.ttf', 'ShareTechMono-Regular.ttf']) {
    assert.equal(resolveAppAsset(`frostbyte://app/assets/fonts/${font}`, root), path.join(root, 'assets/fonts', font));
  }
  for (const value of [
    'frostbyte://other/renderer/index.html',
    'frostbyte://app/main/index.js',
    'frostbyte://app/renderer/%2e%2e/main/index.js',
    'frostbyte://app/renderer/%2e%2e%2fmain%2findex.js',
    'frostbyte://app/renderer/secrets.env',
    'file:///application/src/renderer/index.html',
  ]) assert.equal(resolveAppAsset(value, root), null, value);
});

test('privileged IPC requires the current live application main frame', () => {
  const url = 'frostbyte://app/renderer/index.html';
  const mainFrame = { url };
  const contents = { mainFrame, isDestroyed: () => false };
  assert.equal(isAuthorizedAppIpc({ sender: contents, senderFrame: mainFrame }, contents, url), true);
  assert.equal(isAuthorizedAppIpc({ sender: { mainFrame }, senderFrame: mainFrame }, contents, url), false, 'a second same-URL webContents is not the app window');
  assert.equal(isAuthorizedAppIpc({ sender: contents, senderFrame: { url } }, contents, url), false, 'a same-URL subframe is not the main frame');
  assert.equal(isAuthorizedAppIpc({ sender: contents, senderFrame: { url: 'frostbyte://app/renderer/other.html' } }, contents, url), false);
  const destroyed = { mainFrame, isDestroyed: () => true };
  assert.equal(isAuthorizedAppIpc({ sender: destroyed, senderFrame: mainFrame }, destroyed, url), false);
});

test('application contents deny navigation, webviews, and every permission path', () => {
  const listeners = new Map();
  let permissionCheck, permissionRequest;
  const contents = {
    on: (name, listener) => listeners.set(name, listener),
    session: {
      setPermissionCheckHandler: listener => { permissionCheck = listener; },
      setPermissionRequestHandler: listener => { permissionRequest = listener; },
    },
  };
  lockDownAppWebContents(contents);

  for (const name of ['will-navigate', 'will-attach-webview']) {
    let prevented = false;
    listeners.get(name)({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, name);
  }
  assert.equal(permissionCheck(contents, 'camera', 'https://hostile.invalid'), false);
  let result;
  permissionRequest(contents, 'camera', value => { result = value; });
  assert.equal(result, false);
});

test('credentialed HF debug probes never run in packaged applications', () => {
  assert.equal(allowDebugHfProbe('org/repo', false), true);
  assert.equal(allowDebugHfProbe('org/repo', true), false);
  assert.equal(allowDebugHfProbe('x'.repeat(4097), false), false);
});

test('cold-start source listeners are registered before hardware discovery can block', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main/index.js'), 'utf8');
  const lock = source.indexOf('app.requestSingleInstanceLock()');
  const openFile = source.indexOf("app.on('open-file'");
  const secondInstance = source.indexOf("app.on('second-instance'");
  const hardware = source.indexOf('await getDeviceInfo()');
  assert.ok(lock >= 0 && openFile > lock && secondInstance > lock);
  assert.ok(openFile < hardware && secondInstance < hardware);
  assert.match(source.slice(lock, openFile), /await new Promise\(\(\) => \{\}\)/,
    'a losing single-instance process stops module evaluation');
  assert.match(source, /if \(!startupReady \|\| !app\.isReady\(\)\) return;/,
    'early source events cannot construct a partially initialized window');
  const protocolReady = source.indexOf('await registerAppProtocol()');
  const startupReady = source.indexOf('startupReady = true;');
  const firstReadyFocus = source.indexOf('focusWindow();', startupReady);
  assert.ok(protocolReady > hardware && startupReady > protocolReady && firstReadyFocus > startupReady,
    'startup opens the first window only after top-level discovery and protocol initialization');
  const shutdown = source.indexOf('function gracefulShutdown');
  assert.ok(source.indexOf('startupReady = false;', shutdown) > shutdown,
    'shutdown closes the source-delivery gate before asynchronous cleanup');
});

test('launch sources classify magnets before torrent-looking display names and preserve path whitespace', () => {
  const hash = 'a'.repeat(40);
  const magnet = `MAGNET:?xt=urn:btih:${hash}&dn=release.torrent`;
  assert.deepEqual(normalizeLaunchSource(magnet), {
    kind: 'magnet', value: `magnet:?xt=urn:btih:${hash}&dn=release.torrent`,
  });
  assert.equal(normalizeLaunchSource('magnet:?dn=release.torrent'), null);
  assert.equal(normalizeLaunchSource(`magnet:?xt=urn:btih:${hash}\t&dn=release.torrent`), null);
  assert.equal(normalizeLaunchSource(`magnet:?xt=urn:btih:${hash}${' '.repeat(32769)}`), null,
    'the input is bounded before trimming');
  assert.equal(normalizeLaunchSource('https://example.test/release.torrent'), null);

  const exact = ' release review.torrent ';
  assert.deepEqual(normalizeLaunchSource(exact, { platform: 'darwin', cwd: '/incoming' }), {
    kind: 'torrent', value: path.posix.resolve('/incoming', exact),
  });
});

test('queued launch requests retain one main-owned lease until exact acknowledgement', () => {
  const granted = [];
  const released = [];
  const queue = new LaunchSourceQueue({
    platform: 'darwin', cwd: '/incoming',
    grantTorrent: value => {
      granted.push(value);
      return { path: value, capability: `grant-${granted.length}`, purpose: 'torrent' };
    },
    releaseTorrent: value => released.push(value),
  });
  for (let index = 0; index < 25; index++) queue.enqueue(queue.capture(`release-${index}.torrent`));
  assert.equal(queue.size, 20);
  assert.deepEqual(granted, [], 'queuing raw paths consumes no capability budget');
  const delivered = queue.deliverNext();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].id, /^[a-f0-9-]{36}$/i);
  assert.equal(delivered[0].source.path, path.posix.resolve('/incoming', 'release-0.torrent'));
  assert.equal(granted.length, 1);
  assert.equal(queue.size, 20, 'the leased source remains inside the total queue bound');
  assert.deepEqual(queue.deliverNext(), delivered, 'a concurrent renderer request receives the same lease and grant');
  assert.equal(granted.length, 1, 'concurrent requests cannot mint or drain another path grant');
  assert.equal(queue.enqueue(queue.capture('overflow.torrent')), false, 'the in-flight lease counts toward the bound');
  assert.throws(() => queue.acknowledge('00000000-0000-0000-0000-000000000000'), /no longer awaiting review/);
  assert.deepEqual(queue.deliverNext(), delivered, 'a mismatched acknowledgement leaves the lease recoverable');

  assert.deepEqual(queue.acknowledge(delivered[0].id), { acknowledged: true, pending: 19 });
  assert.deepEqual(released, [delivered[0].source], 'dismissal releases the unused leased grant');
  assert.equal(queue.size, 19);
  const next = queue.deliverNext();
  assert.equal(next.length, 1);
  assert.notEqual(next[0].id, delivered[0].id);
  assert.equal(granted.length, 2, 'the next grant is minted only after exact acknowledgement');

  const magnet = queue.capture(`magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=file.torrent`);
  assert.equal(queue.deliver(magnet), magnet.value);
  assert.equal(granted.length, 2, 'magnet delivery never creates path authority');
});

test('catalog URL persistence shares the serialized settings transaction boundary', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main/index.js'), 'utf8');
  const handler = source.slice(source.indexOf("handle('catalog:importUrl'"), source.indexOf("handle('settings:set'"));
  assert.match(handler, /await settingsMutations\.run\(\(\) => persistCatalogImport/);
});

test('renderer source backpressure retains a wake-up that races an empty request', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(source, /api\.onSource\(\(\) => \{ launchSourceWakePending = true; requestLaunchSource\(\); \}\)/);
  assert.match(source, /else if \(launchSourceWakePending\) queueMicrotask\(requestLaunchSource\)/);
  assert.match(source, /delivery\.id \? api\.acknowledgeSource\(delivery\.id\)/,
    'the renderer releases a launch lease only when its review closes');
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main/index.js'), 'utf8');
  assert.match(main, /handle\('app:source-ack', id => \{[\s\S]*pendingSources\.acknowledge\(id\)/,
    'the main process owns acknowledgement and advances the queue');
  const preload = fs.readFileSync(path.resolve(import.meta.dirname, '../src/preload/index.cjs'), 'utf8');
  assert.match(preload, /invoke\('app:source-ack', id\)/,
    'the sandboxed renderer has a narrow acknowledgement method');
});
