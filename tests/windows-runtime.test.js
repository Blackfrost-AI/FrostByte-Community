import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadSourcesFromArguments } from '../src/main/source-arguments.js';
import { resolveOpenSsh } from '../src/main/spark.js';
import { hfDestination, hfDestinationPath } from '../src/main/hf.js';
import { normalizeTorrentSelection, TorrentEngine } from '../src/main/torrent.js';
import { inspectTorrent } from '../src/main/torrent-source.js';

const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
const windowsLaunch = { platform: 'win32', cwd: 'C:\\Users\\Beta User\\Downloads' };

test('Windows associations preserve file paths and magnet queries while filtering launch options', () => {
  const args = ['C:\\Program Files\\FrostByte\\FrostByte.exe', '--inspect=9222',
    'C:\\Users\\Beta User\\Downloads\\Model Update.TORRENT', magnet + '&dn=Model%20Update.torrent',
    'https://example.test/update.torrent', '--log-file=debug.torrent', 'notes.txt'];
  assert.deepEqual(downloadSourcesFromArguments(args, windowsLaunch), [args[2], args[3]]);
});

test('development and second-instance sources resolve against the launching process directory', () => {
  assert.deepEqual(downloadSourcesFromArguments(['electron.exe', 'C:\\source\\FrostByte', 'Model Update.torrent'], {
    ...windowsLaunch, isPackaged: false,
  }), ['C:\\Users\\Beta User\\Downloads\\Model Update.torrent']);
  assert.deepEqual(downloadSourcesFromArguments(['FrostByte.exe', 'folder\\update.torrent'], {
    ...windowsLaunch, cwd: 'G:\\Incoming',
  }), ['G:\\Incoming\\folder\\update.torrent']);
  assert.deepEqual(downloadSourcesFromArguments(['FrostByte.exe', '\\\\server\\models\\update.torrent'], windowsLaunch), ['\\\\server\\models\\update.torrent']);
});

test('association requests are bounded, deduplicated, and ignore unsupported arguments', () => {
  const args = ['FrostByte.exe', '--dev', 'MAGNET:' + magnet.slice(7), magnet, 'bad\nfile.torrent', 'bad\0file.torrent', 'a'.repeat(32769) + '.torrent'];
  assert.deepEqual(downloadSourcesFromArguments(args, windowsLaunch), [magnet]);
  assert.equal(downloadSourcesFromArguments(['FrostByte.exe', ...Array.from({ length: 30 }, (_, i) => `update-${i}.torrent`)], windowsLaunch).length, 20);
  assert.deepEqual(downloadSourcesFromArguments(['FrostByte', './update.torrent'], { platform: 'darwin', cwd: '/tmp/with spaces' }), ['/tmp/with spaces/update.torrent']);
});

test('Windows SSH uses the system OpenSSH executable before an absolute PATH fallback', () => {
  const system = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  const fallback = 'C:\\Program Files\\OpenSSH\\ssh.exe';
  const env = { SystemRoot: 'C:\\Windows', Path: '.;relative;"C:\\Program Files\\OpenSSH"' };
  assert.equal(resolveOpenSsh({ platform: 'win32', env, isExecutable: file => [system, fallback].includes(file) }), system);
  const checked = [];
  assert.equal(resolveOpenSsh({ platform: 'win32', env, isExecutable: file => { checked.push(file); return file === fallback; } }), fallback);
  assert.ok(checked.every(file => path.win32.isAbsolute(file) && file.endsWith('\\ssh.exe')));
  assert.throws(() => resolveOpenSsh({ platform: 'win32', env: { Path: '.;relative' }, isExecutable: () => false }), /Windows OpenSSH Client.*address and password/);
  assert.equal(resolveOpenSsh({ platform: 'darwin', env: {}, isExecutable: file => file === '/usr/bin/ssh' }), '/usr/bin/ssh');
});

test('HF destinations accept Windows drive/share roots and preserve repository path restrictions', () => {
  assert.equal(hfDestinationPath('E:\\', 'owner/model', 'config.json', path.win32), 'E:\\owner\\model\\config.json');
  assert.equal(hfDestinationPath('G:\\Model Files', 'owner/model', 'sub/tokenizer.json', path.win32), 'G:\\Model Files\\owner\\model\\sub\\tokenizer.json');
  assert.equal(hfDestinationPath('\\\\server\\models\\', 'owner/model', 'config.json', path.win32), '\\\\server\\models\\owner\\model\\config.json');
  assert.equal(hfDestinationPath('/', 'owner/model', 'config.json', path.posix), '/owner/model/config.json');
  for (const file of ['../config.json', '/config.json', 'sub/../../config.json', 'C:\\config.json', '\\\\server\\file', 'config.json:stream', 'sub//config.json', 'sub/./config.json']) {
    assert.throws(() => hfDestinationPath('E:\\', 'owner/model', file, path.win32), /Invalid repository file path/);
  }
});

test('HF filesystem validation still rejects a linked repository directory', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-windows-path-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, 'downloads'), outside = path.join(home, 'other');
  fs.mkdirSync(base); fs.mkdirSync(outside);
  assert.equal(hfDestination(base, 'owner/model', 'config.json'), path.join(base, 'owner', 'model', 'config.json'));
  fs.symlinkSync(outside, path.join(base, 'owner'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => hfDestination(base, 'owner/model', 'config.json'), /without symbolic links/);
});

test('torrent selections have portable identifiers while rejecting absolute and parent paths', () => {
  assert.deepEqual(normalizeTorrentSelection(['release\\config.json', 'release/config.json', 'release\\sub\\update.zip']), ['release/config.json', 'release/sub/update.zip']);
  assert.equal(normalizeTorrentSelection(undefined), null);
  for (const values of [[], ['../config.json'], ['release\\..\\config.json'], ['/release/config.json'], ['C:\\release\\config.json'], ['release//config.json'], [null]]) {
    assert.throws(() => normalizeTorrentSelection(values));
  }
});

test('a Windows-style selection downloads only its files and restores with portable identifiers', { timeout: 25000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-portable-selection-'));
  const source = path.join(home, 'release'); fs.mkdirSync(source);
  const config = Buffer.from('{"portable":true}');
  fs.writeFileSync(path.join(source, 'config.json'), config);
  fs.writeFileSync(path.join(source, 'weights.gguf'), crypto.randomBytes(2 * 1024 ** 2));
  const options = { dht: false, tracker: false, lsd: false, allowPeerAddresses: true };
  const seed = new TorrentEngine(options), pull = new TorrentEngine(options);
  let restored;
  t.after(async () => { await seed.destroy(); if (!pull._destroyed) await pull.destroy(); await restored?.destroy(); fs.rmSync(home, { recursive: true, force: true }); });
  const waitFor = async check => {
    for (let i = 0; i < 600; i++) { if (check()) return; await delay(20); }
    throw new Error('Portable selection fixture timed out.');
  };
  const shared = await seed.seed(source);
  const metadata = path.join(home, 'release.torrent');
  fs.writeFileSync(metadata, seed.client.torrents[0].torrentFile);
  const preview = await inspectTorrent(metadata);
  assert.deepEqual(preview.files.map(file => file.path).sort(), ['release/config.json', 'release/weights.gguf']);
  await pull.add(shared.magnetURI + `&x.pe=127.0.0.1:${seed.port}`, {
    path: path.join(home, 'download'), selectedPaths: ['release\\config.json'],
  });
  await waitFor(() => pull.list()[0]?.done);
  const transfer = pull.list()[0];
  assert.equal(transfer.partial, true);
  assert.equal(transfer.length, config.length);
  assert.equal(transfer.files.find(file => file.path === 'release/config.json').selected, true);
  assert.equal(transfer.files.find(file => file.path === 'release/weights.gguf').selected, false);
  assert.deepEqual(fs.readFileSync(path.join(home, 'download', 'release', 'config.json')), config);
  const [record] = pull.sessions();
  assert.deepEqual(record.selectedPaths, ['release/config.json']);
  await pull.destroy();
  restored = new TorrentEngine(options);
  await restored.restore({ ...record, selectedPaths: ['release\\config.json'] });
  await waitFor(() => restored.list()[0]?.done);
  assert.equal(restored.list()[0].length, config.length);
  assert.deepEqual(restored.sessions()[0].selectedPaths, ['release/config.json']);
});
