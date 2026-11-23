import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { SPARK_PAIR_COMMAND, SPARK_PROBE_COMMAND } from '../../src/main/spark-setup.js';
import { SPARK_RPC_COMMAND } from '../../src/main/spark-pairing.js';
import { keyFingerprint, generateSparkKeyPair } from '../../src/main/spark.js';

const { Server, utils } = ssh2;
const CLIENT_COMMAND = 'docker exec -i frostbyte-beta node /app/src/agent/client.js';
const MAC_CLIENT_COMMAND = 'FROSTBYTE_AGENT_HOME="$HOME/.local/share/frostbyte-beta/state" "$HOME/.local/share/frostbyte-beta/current/runtime/bin/node" "$HOME/.local/share/frostbyte-beta/current/src/agent/client.js"';
const APP_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/** A loopback Spark stand-in. Commands are matched, never evaluated or run in a shell. */
async function startSparkFixture(platform = 'linux') {
  const clientCommand = platform === 'darwin' ? MAC_CLIENT_COMMAND : CLIENT_COMMAND;
  const hostKeys = generateSparkKeyPair();
  const hostKey = utils.parseKey(hostKeys.private).getPublicSSH();
  const username = 'frostbyte-beta-test';
  const password = `fixture-${crypto.randomBytes(24).toString('hex')}`;
  const status = { hostname: 'loopback-spark', architecture: 'aarch64', version: APP_VERSION, protocolVersion: 1,
    downloadDir: '/home/frostbyte-beta-test/FrostByte', freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4,
    memoryBytes: 128 * 1024 ** 3, torrents: [], downloads: [],
    storageRoots: ['/home/frostbyte-beta-test/FrostByte'],
    storage: [{ path: '/home/frostbyte-beta-test/FrostByte', available: true, freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4 }] };
  const connections = new Set(), authentication = [], enrollment = [], commands = [], requests = [], failures = [];
  const expectedDisconnects = new WeakSet();
  let allowedKey, publicKey, passwordAllowed = true, pairCommand = SPARK_PAIR_COMMAND;
  const server = new Server({ hostKeys: [hostKeys.private] }, client => {
    connections.add(client);
    // The first-use identity inspection deliberately disconnects before authentication.
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    client.on('authentication', ctx => {
      const record = { method: ctx.method, username: ctx.username, signed: Boolean(ctx.signature), accepted: false };
      authentication.push(record);
      if (ctx.username !== username) return ctx.reject(['password', 'publickey']);
      if (passwordAllowed && ctx.method === 'password' && ctx.password === password) { record.accepted = true; return ctx.accept(); }
      if (allowedKey && ctx.method === 'publickey' && ctx.key.algo === allowedKey.type && ctx.key.data.equals(allowedKey.getPublicSSH())
        && (!ctx.signature || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) { record.accepted = true; return ctx.accept(); }
      ctx.reject(passwordAllowed ? ['password', 'publickey'] : ['publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (acceptExec, reject, info) => {
        if (![SPARK_PROBE_COMMAND, pairCommand, SPARK_RPC_COMMAND, clientCommand].includes(info.command)) {
          failures.push('The app attempted an unexpected remote command.'); return reject();
        }
        commands.push(info.command);
        const stream = acceptExec(); let input = '';
        stream.on('error', () => {});
        stream.stderr.on('error', error => {
          if (expectedDisconnects.has(client) && client._sock?.destroyed) return;
          failures.push(`Fixture stderr failed: ${error.message}`);
        });
        stream.on('data', chunk => { input += chunk; });
        stream.on('end', () => {
          if (stream.destroyed || stream.writableEnded) return; // app shutdown can cancel a background poll
          // ssh2 can end stderr and the readable side of a dead channel before
          // marking its writable side ended. Only an explicitly expected app
          // shutdown with no request bytes is cancellation, not malformed RPC.
          if (expectedDisconnects.has(client) && client._sock?.destroyed
            && stream.incoming?.state === 'closed' && !input.trim()) return;
          try {
            let response;
            if (info.command === SPARK_PROBE_COMMAND) {
              response = { device: { hostname: status.hostname, architecture: 'arm64', platform, home: '/home/frostbyte-beta-test' },
                downloadDir: status.downloadDir, frigidLibrary: null,
                requirements: { dockerInstalled: true, dockerAccess: true, agentInstalled: true, containerConflict: false, desktopSession: true } };
            } else if (info.command === pairCommand) {
              const request = JSON.parse(input);
              if (request.action !== 'add' || typeof request.publicKey !== 'string' || !request.publicKey.startsWith('ssh-ed25519 ')) throw new Error('Unexpected pairing request.');
              const parsed = utils.parseKey(request.publicKey);
              if (parsed instanceof Error) throw new Error('The app supplied an invalid enrollment public key.');
              enrollment.push(request); publicKey = request.publicKey; allowedKey = parsed;
              // Once enrolled, this fixture requires the dedicated key for every new connection.
              passwordAllowed = false;
              response = { ok: true };
            } else {
              const request = JSON.parse(input); requests.push(request);
              if (request.action === 'pairing:ping' && info.command === SPARK_RPC_COMMAND) response = { ok: true, data: { restricted: true } };
              else if (request.action === 'pairing:revoke' && info.command === SPARK_RPC_COMMAND) response = { ok: true, data: { revoked: true } };
              else if (request.action === 'host:folders' && info.command === SPARK_RPC_COMMAND) response = { ok: true, data: { path: request.path || '/home/frostbyte-beta-test', parent: '/home', folders: [], shortcuts: [] } };
              else if (request.action === 'status') response = { ok: true, data: status };
              else if (request.action === 'device:telemetry') response = { ok: true, data: { schema: 1, memory: { totalBytes: status.memoryBytes, freeBytes: status.memoryBytes / 2 }, docker: { available: false, containers: [] } } };
              else if (request.action === 'device:recipes') response = { ok: true, data: { schema: 1, recipes: [] } };
              else if (request.action === 'files') response = { ok: true, data: { relative: request.relative || '', root: request.root || status.downloadDir, truncated: false,
                entries: [{ name: 'config.json', relative: 'config.json', directory: false, size: 123 }] } };
              else throw new Error('The app attempted an unexpected companion action.');
            }
            stream.write(JSON.stringify(response) + '\n'); stream.exit(0); stream.end();
          } catch (error) {
            // Preserve the original protocol failure even if the transport
            // closed before an error response could be written.
            failures.push(error.message);
            if (!stream.stderr.destroyed && !stream.stderr.writableEnded && stream.stderr.writable) {
              stream.stderr.write('Spark fixture rejected the request.\n');
            }
            if (!stream.destroyed && !stream.writableEnded) { stream.exit(1); stream.end(); }
          }
        });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { username, password, port: server.address().port, hostKey, authentication, enrollment, commands, requests, failures,
    get pairCommand() { return pairCommand; },
    setPairCommand(value) { pairCommand = value; },
    get publicKey() { return publicKey; },
    enablePassword() { passwordAllowed = true; },
    expectDisconnects() { for (const client of connections) expectedDisconnects.add(client); },
    async close() { for (const client of connections) { expectedDisconnects.add(client); client.end(); client._sock?.destroy(); } await new Promise(resolve => server.close(resolve)); } };
}

test('SSH fixture distinguishes expected empty-channel shutdown from malformed RPC', async () => {
  const fixture = await startSparkFixture();
  const clients = [];
  const connect = async () => {
    const client = new ssh2.Client(); clients.push(client); client.on('error', () => {});
    await new Promise((resolve, reject) => {
      client.once('ready', resolve); client.once('error', reject);
      client.connect({ host: '127.0.0.1', port: fixture.port, username: fixture.username, password: fixture.password });
    });
    return client;
  };
  const open = client => new Promise((resolve, reject) => client.exec(CLIENT_COMMAND, (error, stream) => {
    if (error) return reject(error); stream.on('error', () => {}); stream.stderr.on('data', () => {}); stream.resume(); resolve(stream);
  }));
  try {
    const cancelled = await connect(); await open(cancelled);
    fixture.expectDisconnects();
    const cancelledClosed = new Promise(resolve => cancelled.once('close', resolve));
    cancelled._sock.destroy(); await cancelledClosed;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fixture.failures).toEqual([]);

    const malformed = await connect(); const stream = await open(malformed);
    const closed = new Promise(resolve => stream.once('close', resolve));
    stream.end(JSON.stringify({ action: 'fixture-invalid-action' }));
    await closed;
    expect(fixture.failures).toEqual(['The app attempted an unexpected companion action.']);
  } finally {
    fixture.expectDisconnects(); for (const client of clients) client.destroy(); await fixture.close();
  }
});

for (const platform of ['linux', 'darwin']) test(`${platform} first-use pairing encrypts a dedicated key and reconnects after restart without a saved password`, async () => {
  test.setTimeout(90000);
  const fixture = await startSparkFixture(platform);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-spark-real-pairing-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), sparkHost: '',
    upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false }));
  let app;
  const pageErrors = [];
  const launch = async () => {
    app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE,
      args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
    const page = await app.firstWindow(); await acceptBetaTerms(page, app); page.on('pageerror', error => pageErrors.push(error.message));
    // The embedded bridge is deflated by the running Node runtime. Electron
    // and the test runner can use different zlib versions, producing different
    // compressed bytes for identical source. Still match one exact command.
    fixture.setPairCommand(await app.evaluate(({ app }) => {
      const require = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      return require('./src/main/spark-pairing.js').SPARK_PAIR_COMMAND;
    }));
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
    return page;
  };
  try {
    let page = await launch();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    expect(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())).toBe(true);
    const storageBackend = await app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend?.());
    expect(storageBackend).not.toBe('basic_text');
    if (process.platform === 'linux') expect(storageBackend).toBe('gnome_libsecret');
    await page.locator('#nav [data-tab="spark"]').click();
    await page.locator('#device-add').click();
    await expect(page.locator('#spark-setup-host')).toHaveValue('');
    await page.locator('#spark-setup-host').fill('127.0.0.1');
    await page.locator('#spark-setup-user').fill(fixture.username);
    await page.locator('#spark-setup-port').fill(String(fixture.port));
    await page.locator('#spark-setup-password').fill(fixture.password);
    await page.locator('#spark-setup-check').click();
    await expect(page.locator('#spark-setup-install')).toHaveText('Connect to device');
    await expect(page.locator('#spark-setup')).toContainText('A compatible FrostByte companion is already installed.');
    expect(keyFingerprint(fixture.hostKey)).toMatch(/^SHA256:/);
    expect(fixture.enrollment).toEqual([]);
    await page.locator('#spark-setup-install').click();
    await expect(page.locator('#spark-message')).toContainText('Connected to loopback-spark');
    if (!await page.locator('#spark-files-section').evaluate(section => section.open)) await page.locator('#spark-files-section > summary').click();
    await expect(page.locator('#spark-files')).toContainText('config.json');
    expect(fixture.enrollment).toHaveLength(1);
    expect(fixture.commands.filter(command => command === fixture.pairCommand)).toHaveLength(1);
    expect(fixture.authentication.some(record => record.method === 'password' && record.accepted)).toBe(true);
    expect(fixture.authentication.some(record => record.method === 'publickey' && record.signed && record.accepted)).toBe(true);

    const persistedText = fs.readFileSync(path.join(home, 'state.json'), 'utf8');
    const profile = JSON.parse(persistedText).sparkConnection;
    expect(profile).toMatchObject({ mode: 'password', runtime: platform === 'darwin' ? 'mac-native' : 'docker', host: '127.0.0.1', username: fixture.username, port: fixture.port,
      hostKey: fixture.hostKey.toString('base64'), publicKey: fixture.publicKey });
    expect(Object.keys(profile).sort()).toEqual(['host', 'hostKey', 'mode', 'port', 'privateKeyEnc', 'publicKey', 'runtime', 'username']);
    expect(profile.privateKeyEnc).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(profile.privateKeyEnc, 'base64').length).toBeGreaterThan(100);
    expect(Buffer.from(profile.privateKeyEnc, 'base64').toString()).not.toContain('PRIVATE KEY');
    expect(persistedText).not.toContain(fixture.password);
    expect(persistedText).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).not.toContain(fixture.password);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(fixture.password);
    // Exercise the real OS-backed decrypt path without returning or logging private key material.
    expect(await app.evaluate(({ safeStorage }, encrypted) => {
      const privateKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64')).trim();
      return privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----') && privateKey.endsWith('-----END OPENSSH PRIVATE KEY-----');
    }, profile.privateKeyEnc)).toBe(true);
    const acceptedKeyCount = fixture.authentication.filter(record => record.method === 'publickey' && record.signed && record.accepted).length;
    const passwordCount = fixture.authentication.filter(record => record.method === 'password').length;
    const requestsBeforeRestart = fixture.requests.length;
    fixture.expectDisconnects(); await app.close(); app = undefined;

    page = await launch();
    await page.locator('#nav [data-tab="spark"]').click();
    await page.locator('[data-select-device]:not([data-select-device="local"])').first().click();
    await expect(page.locator('#spark-setup')).toBeHidden();
    await expect(page.locator('#spark-host')).toHaveValue(`${fixture.username}@127.0.0.1:${fixture.port}`);
    await page.locator('#spark-connect').click();
    await expect(page.locator('#spark-message')).toContainText('Connected to loopback-spark');
    if (!await page.locator('#spark-files-section').evaluate(section => section.open)) await page.locator('#spark-files-section > summary').click();
    await expect(page.locator('#spark-files')).toContainText('config.json');
    expect(fixture.authentication.filter(record => record.method === 'password')).toHaveLength(passwordCount);
    expect(fixture.authentication.filter(record => record.method === 'publickey' && record.signed && record.accepted).length).toBeGreaterThan(acceptedKeyCount);
    expect(fixture.requests.slice(requestsBeforeRestart).some(request => request.action === 'files' && request.root === '/home/frostbyte-beta-test/FrostByte')).toBe(true);
    expect(fixture.enrollment).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).sparkConnection.privateKeyEnc).toBe(profile.privateKeyEnc);
    // Managed admin actions use the saved raw address and username in main.
    // The renderer receives the display label and submits only deviceId + password.
    fixture.enablePassword();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.locator('#spark-storage-add').click();
    await page.locator('#spark-storage-folder').fill('/home/frostbyte-beta-test/Extra Models');
    await page.locator('#modal-acts button.primary').click();
    await expect(page.locator('#spark-setup')).toContainText(`${fixture.username}@127.0.0.1:${fixture.port}`);
    await expect(page.locator('#spark-setup-host')).toHaveCount(0);
    await expect(page.locator('#spark-setup-user')).toHaveCount(0);
    await page.locator('#spark-setup-password').fill(fixture.password);
    await page.locator('#spark-setup-check').click();
    await expect(page.locator('#spark-setup-storage')).toBeVisible();
    await expect(page.locator('#spark-setup')).toContainText('/home/frostbyte-beta-test/Extra Models');
    await page.locator('[data-spark-setup="cancel"]').click();
    expect(fixture.authentication.filter(record => record.method === 'password' && record.accepted).length).toBeGreaterThan(passwordCount);
    expect(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).not.toContain(fixture.password);
    expect(fixture.failures).toEqual([]);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    const failedPage = app && await app.firstWindow();
    if (failedPage) {
      await test.info().attach('pairing-presentation-state', { contentType: 'application/json',
        body: JSON.stringify(await failedPage.evaluate(() => {
          const ids = ['device-dashboard', 'device-cards', 'spark-setup', 'spark-content', 'spark-files-section', 'spark-message'];
          return Object.fromEntries(ids.map(id => { const node = document.getElementById(id); return [id, { hidden: node.hidden, display: getComputedStyle(node).display, text: id === 'spark-message' ? node.textContent : undefined }]; }));
        })) });
    }
    throw error;
  } finally { fixture.expectDisconnects(); await app?.close(); await fixture.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
