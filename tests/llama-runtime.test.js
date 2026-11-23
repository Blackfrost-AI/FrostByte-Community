import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { verifyLlamaRuntime, ManagedLlamaRuntime, llamaManifestRoot } from '../src/main/llama-runtime.js';
import { MANAGED_PROVIDER, RUNTIME_NAMES, runtimeModel } from '../src/main/assistant-runtimes.js';
import { streamChatCompletion, validateChatRequest } from '../src/main/assistant-chat.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-llama-test-'));
  const serverBytes = Buffer.from('#!/bin/sh\nexit 0\n');
  const libBytes = Buffer.from('fake-dylib');
  const manifest = {
    schemaVersion: 1, tag: 'test-b1',
    platforms: {
      'test-arm64': {
        archive: 'llama.tar.gz', url: 'https://example.invalid/llama.tar.gz',
        archiveSha256: 'a'.repeat(64), server: 'llama-server',
        files: { 'llama-server': sha(serverBytes), 'libfake.dylib': sha(libBytes) },
        links: { 'libalias.dylib': 'libfake.dylib' },
      },
    },
  };
  await fs.mkdir(path.join(root, 'build'));
  await fs.writeFile(path.join(root, 'build/llama-runtime.json'), JSON.stringify(manifest));
  const dir = path.join(root, 'build/llama-runtime/test-arm64');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'llama-server'), serverBytes, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'libfake.dylib'), libBytes);
  await fs.symlink('libfake.dylib', path.join(dir, 'libalias.dylib'));
  await fs.writeFile(path.join(dir, 'runtime.json'), JSON.stringify({ schemaVersion: 1, tag: 'test-b1', archiveSha256: 'a'.repeat(64) }));
  return { root, dir, manifest, serverBytes, libBytes, verify: () => verifyLlamaRuntime({ root, platform: 'test-arm64' }) };
}

test('verifier accepts the exact pinned inventory and rejects drift, extras, and broken links', async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  assert.equal(f.verify().available, true);
  assert.equal(f.verify().tag, 'test-b1');
  // Drifted bytes fail closed.
  await fs.writeFile(path.join(f.dir, 'libfake.dylib'), 'tampered');
  assert.equal(f.verify().available, false);
  await fs.writeFile(path.join(f.dir, 'libfake.dylib'), f.libBytes);
  assert.equal(f.verify().available, true);
  // An unreviewed extra file fails closed even when every pinned hash matches.
  await fs.writeFile(path.join(f.dir, 'smuggled.bin'), 'x');
  assert.equal(f.verify().available, false);
  await fs.rm(path.join(f.dir, 'smuggled.bin'));
  // Symlink retarget fails closed.
  await fs.rm(path.join(f.dir, 'libalias.dylib'));
  await fs.symlink('llama-server', path.join(f.dir, 'libalias.dylib'));
  assert.equal(f.verify().available, false);
  await fs.rm(path.join(f.dir, 'libalias.dylib'));
  await fs.symlink('libfake.dylib', path.join(f.dir, 'libalias.dylib'));
  assert.equal(f.verify().available, true);
  // A regular file posing as the pinned symlink fails closed.
  await fs.rm(path.join(f.dir, 'libalias.dylib'));
  await fs.writeFile(path.join(f.dir, 'libalias.dylib'), f.libBytes);
  assert.equal(f.verify().available, false);
});

test('verifier honours post-sign final hashes recorded by the packaging hook', async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  // Real Mach-O magic: overrides are only honoured for executable members.
  const signed = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from('signed-server-bytes')]);
  await fs.writeFile(path.join(f.dir, 'llama-server'), signed, { mode: 0o755 });
  assert.equal(f.verify().available, false);
  const receiptPath = path.join(f.dir, 'runtime.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath));
  receipt.finalFileSha256 = { 'llama-server': sha(signed) };
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal(f.verify().available, true);
  // A malformed override hash fails closed rather than skipping verification.
  receipt.finalFileSha256 = { 'llama-server': 'not-a-hash' };
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal(f.verify().available, false);
});

test('missing receipt or wrong archive pin fails closed', async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const receiptPath = path.join(f.dir, 'runtime.json');
  const good = await fs.readFile(receiptPath);
  await fs.rm(receiptPath);
  assert.equal(f.verify().available, false);
  await fs.writeFile(receiptPath, JSON.stringify({ schemaVersion: 1, tag: 'test-b1', archiveSha256: 'b'.repeat(64) }));
  assert.equal(f.verify().available, false);
  await fs.writeFile(receiptPath, good);
  assert.equal(f.verify().available, true);
  assert.equal(verifyLlamaRuntime({ root: f.root, platform: 'win32-x64' }).available, false);
});

function fakeLibrary(rows) {
  return { list: () => rows.map(({ files, root, ...rest }) => rest), entry: id => rows.find(row => row.id === id) };
}

/** Real on-disk GGUF stand-ins so load-time realpath containment is exercised. */
async function modelFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-models-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'qwen.gguf'), 'gguf-weights');
  await fs.writeFile(path.join(root, 'model-00001-of-00002.gguf'), 'shard1');
  await fs.writeFile(path.join(root, 'model-00002-of-00002.gguf'), 'shard2');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'outside.gguf'), 'outside-weights');
  await fs.symlink(path.join(outside, 'outside.gguf'), path.join(root, 'escape.gguf'));
  return { root, outside };
}

test('loadableModels only offers complete local saved GGUF entries inside their library root', async t => {
  const f = await modelFixture(t);
  const runtime = new ManagedLlamaRuntime({ modelLibrary: fakeLibrary([
    { id: 'a', name: 'Qwen Test', device: 'local', available: true, completeness: { complete: true }, root: f.root, files: [{ relative: 'qwen.gguf', size: 10 }] },
    { id: 'b', name: 'Sharded', device: 'local', available: true, completeness: { complete: true }, root: f.root, files: [{ relative: 'model-00002-of-00002.gguf' }, { relative: 'model-00001-of-00002.gguf' }] },
    { id: 'c', name: 'Remote', device: 'spark-1', available: true, root: f.root, files: [{ relative: 'x.gguf' }] },
    { id: 'd', name: 'Incomplete', device: 'local', available: true, completeness: { complete: false }, root: f.root, files: [{ relative: 'y.gguf' }] },
    { id: 'e', name: 'No weights', device: 'local', available: true, root: f.root, files: [{ relative: 'README.md' }] },
    { id: 'f', name: 'Escape', device: 'local', available: true, root: f.root, files: [{ relative: '../outside.gguf' }] },
    { id: 'g', name: 'Symlink escape', device: 'local', available: true, root: f.root, files: [{ relative: 'escape.gguf' }] },
  ]) });
  const models = runtime.loadableModels();
  assert.deepEqual(models.map(model => model.name), ['Qwen Test', 'Sharded', 'Symlink escape']);
  assert.equal(models[0].path, path.join(f.root, 'qwen.gguf'));
  assert.equal(models[1].path, path.join(f.root, 'model-00001-of-00002.gguf'));
  assert.equal(runtime.resolveModel('Qwen Test').libraryId, 'a');
  assert.throws(() => runtime.resolveModel('Missing'), /not available/);
  // A symlink inside the root that points outside it is refused at load time.
  assert.throws(() => runtime.resolveModel('Symlink escape'), /not available/);
});

function fakeSpawn({ exitImmediately = false } = {}) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = exitImmediately ? 1 : null;
    child.killed = [];
    child.kill = signal => { child.killed.push(signal); if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0, signal)); } return true; };
    calls.push({ command, args, options, child });
    if (exitImmediately) queueMicrotask(() => child.emit('exit', 1, null));
    return child;
  };
  return { calls, spawnProcess };
}

test('ensureLoaded starts a fixed loopback argv with a private key file and tears down on stop', async t => {
  const f = await fixture();
  const m = await modelFixture(t);
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const { calls, spawnProcess } = fakeSpawn();
  const keyPaths = [];
  const runtime = new ManagedLlamaRuntime({
    verify: f.verify, spawnProcess, portAllocator: async () => 43210,
    modelLibrary: fakeLibrary([{ id: 'a', name: 'Qwen Test', device: 'local', available: true, root: m.root, files: [{ relative: 'qwen.gguf' }] }]),
    fetch: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:43210/health');
      assert.match(options.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
      keyPaths.push(options.headers.Authorization);
      return { ok: true };
    },
  });
  const session = await runtime.ensureLoaded('Qwen Test');
  assert.equal(session.port, 43210);
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, f.verify().server);
  assert.deepEqual(args.slice(0, 6), ['--model', path.join(m.root, 'qwen.gguf'), '--host', '127.0.0.1', '--port', '43210']);
  assert.ok(args.includes('--no-webui'));
  assert.ok(args.includes('--api-key-file'));
  assert.ok(!args.some(arg => String(arg).includes(keyPaths[0].slice(7))));
  assert.equal(options.env.PATH !== undefined, true);
  const keyFile = args[args.indexOf('--api-key-file') + 1];
  const keyStat = await fs.stat(keyFile);
  assert.equal(keyStat.mode & 0o777, 0o600);
  assert.equal(await fs.readFile(keyFile, 'utf8'), session.apiKey);
  // Same model reuses the running process.
  await runtime.ensureLoaded('Qwen Test');
  assert.equal(calls.length, 1);
  await runtime.stop();
  assert.deepEqual(calls[0].child.killed, ['SIGTERM']);
  await assert.rejects(fs.stat(keyFile));
  assert.equal(runtime.status().running, false);
});

test('ensureLoaded fails closed on bad names, missing runtime, early exit, and never leaks the key file', async t => {
  const f = await fixture();
  const m = await modelFixture(t);
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const library = fakeLibrary([{ id: 'a', name: 'Qwen Test', device: 'local', available: true, root: m.root, files: [{ relative: 'qwen.gguf' }] }]);
  const bad = new ManagedLlamaRuntime({ verify: f.verify, modelLibrary: library, spawnProcess: fakeSpawn().spawnProcess });
  await assert.rejects(bad.ensureLoaded('../etc/passwd'), /Choose a model/);
  await assert.rejects(bad.ensureLoaded('Qwen Test\u0000x'), /Choose a model/);
  const missing = new ManagedLlamaRuntime({ verify: () => ({ available: false }), modelLibrary: library, spawnProcess: fakeSpawn().spawnProcess });
  await assert.rejects(missing.ensureLoaded('Qwen Test'), /not installed/);
  const { calls, spawnProcess } = fakeSpawn({ exitImmediately: true });
  const dying = new ManagedLlamaRuntime({
    verify: f.verify, modelLibrary: library, spawnProcess, portAllocator: async () => 43211,
    fetch: async () => ({ ok: false }), readinessTimeoutMs: 3000,
  });
  await assert.rejects(dying.ensureLoaded('Qwen Test'), /exited during startup/);
  const keyFile = calls[0].args[calls[0].args.indexOf('--api-key-file') + 1];
  await assert.rejects(fs.stat(keyFile));
  assert.equal(dying.status().running, false);
});

test('managed provider is catalog-visible and streams through the injected loopback port only', async () => {
  assert.ok(!RUNTIME_NAMES.includes(MANAGED_PROVIDER));
  const entry = runtimeModel('local', MANAGED_PROVIDER, 'Qwen Test', 'available');
  assert.equal(entry.state, 'available');
  const request = validateChatRequest({ model: { deviceId: 'local', provider: MANAGED_PROVIDER, name: 'Qwen Test' }, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(request.model.port, undefined);
  assert.throws(() => validateChatRequest({ model: { deviceId: 'spark-1', provider: MANAGED_PROVIDER, name: 'x' }, messages: [{ role: 'user', content: 'hi' }] }), /Choose a model/);
  assert.throws(() => validateChatRequest({ model: { deviceId: 'local', provider: MANAGED_PROVIDER, name: 'x', port: 80 }, messages: [{ role: 'user', content: 'hi' }] }), /Choose a model/);
  let seen;
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  } });
  const events = [];
  await streamChatCompletion({ ...request, model: { ...request.model, port: 43212 } }, {
    apiKey: 'k'.repeat(64), stream: 's1', onEvent: event => events.push(event),
    fetch: async (url, options) => { seen = { url, options }; return { ok: true, body }; },
  });
  assert.equal(seen.url, 'http://127.0.0.1:43212/v1/chat/completions');
  assert.equal(seen.options.headers.Authorization, `Bearer ${'k'.repeat(64)}`);
  assert.equal(JSON.parse(seen.options.body).model, 'Qwen Test');
  assert.equal(events.find(event => event.type === 'delta').text, 'Hi');
  assert.ok(events.some(event => event.type === 'done'));
});

test('concurrent ensureLoaded calls serialize: exactly one process, no orphaned key dirs', async t => {
  const f = await fixture();
  const m = await modelFixture(t);
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const { calls, spawnProcess } = fakeSpawn();
  let ports = 43300;
  const runtime = new ManagedLlamaRuntime({
    verify: f.verify, spawnProcess, portAllocator: async () => ++ports,
    modelLibrary: fakeLibrary([
      { id: 'a', name: 'Model A', device: 'local', available: true, root: m.root, files: [{ relative: 'qwen.gguf' }] },
      { id: 'b', name: 'Model B', device: 'local', available: true, root: m.root, files: [{ relative: 'model-00001-of-00002.gguf' }] },
    ]),
    fetch: async () => ({ ok: true }),
  });
  const [a, b, a2] = await Promise.all([
    runtime.ensureLoaded('Model A'), runtime.ensureLoaded('Model B'), runtime.ensureLoaded('Model A'),
  ]);
  // Requests serialize behind one queue: A starts, B preempts it, the queued
  // A request then loads A again. Every superseded child was terminated and
  // its key dir removed — nothing is orphaned, and the last request wins.
  assert.equal(calls.length, 3);
  assert.equal(a.name, 'Model A');
  assert.equal(b.name, 'Model B');
  assert.equal(a2.name, 'Model A');
  for (const call of calls.slice(0, -1)) {
    assert.deepEqual(call.child.killed, ['SIGTERM']);
    const keyFile = call.args[call.args.indexOf('--api-key-file') + 1];
    await assert.rejects(fs.stat(keyFile));
  }
  await runtime.stop();
  assert.deepEqual(calls.at(-1).child.killed, ['SIGTERM']);
  const lastKey = calls.at(-1).args[calls.at(-1).args.indexOf('--api-key-file') + 1];
  await assert.rejects(fs.stat(lastKey));
  assert.equal(runtime.status().running, false);
});

test('stop during an in-flight start leaves no process or key file behind', async t => {
  const f = await fixture();
  const m = await modelFixture(t);
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const { calls, spawnProcess } = fakeSpawn();
  const runtime = new ManagedLlamaRuntime({
    verify: f.verify, spawnProcess, portAllocator: async () => 43400,
    modelLibrary: fakeLibrary([{ id: 'a', name: 'Qwen Test', device: 'local', available: true, root: m.root, files: [{ relative: 'qwen.gguf' }] }]),
    fetch: async () => ({ ok: false }), readinessTimeoutMs: 60000,
  });
  const pending = runtime.ensureLoaded('Qwen Test');
  const rejected = assert.rejects(pending);
  // Let the start reach the readiness loop, then shut down mid-start.
  await new Promise(resolve => setTimeout(resolve, 400));
  await runtime.stop();
  await rejected;
  assert.equal(runtime.status().running, false);
  if (calls.length) {
    const keyFile = calls[0].args[calls[0].args.indexOf('--api-key-file') + 1];
    await assert.rejects(fs.stat(keyFile));
    assert.ok(calls[0].child.killed.includes('SIGTERM'));
  }
});

test('llamaManifestRoot prefers a packaged Resources manifest and falls back to the repo', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-llama-res-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.resolve(new URL('.', import.meta.url).pathname, '..');
  assert.equal(llamaManifestRoot(dir), repo);
  await fs.writeFile(path.join(dir, 'llama-runtime.json'), '{}');
  assert.equal(llamaManifestRoot(dir), dir);
});
