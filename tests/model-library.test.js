import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModelLibrary, localModelDirectory, modelLocation, scanModelLocation } from '../src/main/model-library.js';
import { normalizeItemKinds } from '../src/main/store.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-model-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, value = 'fixture') => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), value);
  };
  return { root, write, source: modelLocation({ root }), read: (source, relative, options) => localModelDirectory(source.root, relative, options) };
}
const store = () => ({ state: {}, _commitStateFields(patch) { Object.assign(this.state, structuredClone(patch)); } });

test('scan groups shard folders, keeps GGUF models separate, skips partial files and symlinks, and writes no model bytes', async t => {
  const f = await fixture(t);
  await f.write('Qwen/config.json', '{}');
  await f.write('Qwen/model-00001-of-00002.safetensors');
  await f.write('Qwen/model-00002-of-00002.safetensors');
  await f.write('Qwen/tokenizer.json', '{}');
  await f.write('gguf/model-q4.gguf');
  await f.write('gguf/model-q8.gguf');
  await f.write('pending.gguf.frostpart');
  await f.write('empty.gguf', '');
  await f.write('.hidden/private-model.gguf');
  await f.write('node_modules/fixture/model.gguf');
  await f.write('notes.txt');
  await fs.symlink(path.join(f.root, 'Qwen'), path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await fs.readFile(path.join(f.root, 'Qwen/model-00001-of-00002.safetensors'));
  const result = await scanModelLocation(f.source, f.read);
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows.find(row => row.name === 'Qwen').fileCount, 4);
  assert.equal(result.rows.find(row => row.name === 'model-q4.gguf').directory, false);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'Qwen/model-00001-of-00002.safetensors')), before);
  assert(result.rows.every(row => row.source === 'scan' && !row.sharing));
});

test('saved model folder itself groups its config and shards without scanning its parent', async t => {
  const f = await fixture(t);
  await f.write('config.json', '{}');
  await f.write('model-00001-of-00002.safetensors');
  await f.write('nested/model-00002-of-00002.safetensors');
  const result = await scanModelLocation(f.source, f.read);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].path, f.root);
  assert.equal(result.rows[0].relative, '');
  assert.equal(result.rows[0].fileCount, 3);
});

test('inventory persists, deduplicates rescans, keeps offline rows, and marks missing models without deleting data', async t => {
  const f = await fixture(t), memory = store();
  await f.write('existing.gguf');
  let error = '';
  const options = { store: memory, sources: async () => [{ ...f.source, ...(error ? { error } : {}) }], readDirectory: f.read };
  const library = new ModelLibrary(options);
  library.start(); await library.pending;
  const id = library.list()[0].id;
  library.start(); await library.pending;
  assert.equal(library.list().length, 1);
  assert.equal(library.list()[0].id, id);
  assert(!Object.hasOwn(library.list()[0], 'files'));
  assert.equal(new ModelLibrary(options).list()[0].id, id);
  error = 'Drive offline'; library.start(); await library.pending;
  assert.equal(library.list()[0].available, true);
  assert.equal(library.progress.locations[0].status, 'unavailable');
  error = ''; await fs.rename(path.join(f.root, 'existing.gguf'), path.join(f.root, 'existing.keep'));
  library.start(); await library.pending;
  assert.equal(library.list()[0].available, false);
  assert.equal(await fs.readFile(path.join(f.root, 'existing.keep'), 'utf8'), 'fixture');
});

test('two devices with identical paths stay distinct and forgotten connections lose authority', async () => {
  const sources = ['spark-a', 'spark-b'].map(deviceId => modelLocation({ root: '/models', device: 'spark', deviceId, binding: deviceId }));
  let saved = true;
  const library = new ModelLibrary({ store: store(), sources: async () => sources, isCurrent: () => saved,
    readDirectory: async source => ({ root: source.root, relative: '', entries: [{ name: 'model.gguf', relative: 'model.gguf', directory: false, size: 32 }], truncated: false }) });
  library.start(); await library.pending;
  assert.equal(library.list().length, 2);
  assert.notEqual(library.list()[0].id, library.list()[1].id);
  const id = library.list()[0].id;
  saved = false;
  assert.equal(library.list().length, 0);
  assert.throws(() => library.entry(id), /no longer saved/);
});

test('cancellation drains readers and cannot publish late results into a new scan', async () => {
  let unblock;
  const waiting = new Promise(resolve => { unblock = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const library = new ModelLibrary({ store: store(), sources: async () => [modelLocation({ root: '/models', device: 'spark', deviceId: 'spark' })],
    readDirectory: async source => { started(); await waiting; return { root: source.root, relative: '', entries: [{ name: 'model.gguf', relative: 'model.gguf', directory: false, size: 10 }], truncated: false }; } });
  library.start(); await entered;
  const first = library.pending;
  library.cancel();
  assert.equal(library.start().scan.phase, 'cancelling');
  assert.equal(library.pending, first);
  unblock(); await first;
  assert.equal(library.progress.phase, 'cancelled');
  assert.deepEqual(library.list(), []);
});

test('truncated scans preserve prior results and report bounds', async () => {
  const source = modelLocation({ root: '/models', device: 'spark', deviceId: 'spark' });
  const result = await scanModelLocation(source, async () => ({ root: '/models', relative: '', truncated: true,
    entries: [{ name: 'a.gguf', relative: 'a.gguf', directory: false, size: 10 }] }));
  assert.equal(result.complete, false);
  assert.equal(result.rows.length, 1);
  assert.match(result.warnings[0], /Only part/);
});

test('invalid or unrelated remote file-listing paths are rejected', async () => {
  const source = modelLocation({ root: '/models', device: 'spark', deviceId: 'spark' });
  await assert.rejects(scanModelLocation(source, async () => ({ root: '/elsewhere', relative: '', entries: [] })), /different or invalid/);
  await assert.rejects(scanModelLocation(source, async () => ({ root: '/models', relative: '', entries: [{ name: 'model.gguf', relative: '../model.gguf', directory: false, size: 10 }] })), /invalid model file/);
  assert.throws(() => modelLocation({ root: path.parse(process.cwd()).root }), /entire drive/);
  assert.throws(() => modelLocation({ root: path.join(path.parse(process.cwd()).root, 'models') + path.sep + '..' }), /entire drive/);
});

test('discovered model categories survive normalization without accepting malformed IDs', () => {
  const id = 'scan:' + 'a'.repeat(64);
  assert.deepEqual(normalizeItemKinds({ [id]: 'torrent', 'scan:invalid': 'model' }), { [id]: 'torrent' });
  assert.deepEqual(normalizeItemKinds({ [id]: 'model' }), { [id]: 'model' });
});

test('sharing a discovered local model revalidates its exact files and rejects changed files', async t => {
  const f = await fixture(t), library = new ModelLibrary({ store: store(), sources: async () => [f.source], readDirectory: f.read });
  await f.write('model.gguf');
  library.start(); await library.pending;
  const id = library.list()[0].id;
  assert.equal((await library.localManifest(id)).files[0].path, path.join(f.root, 'model.gguf'));
  await fs.writeFile(path.join(f.root, 'model.gguf'), 'changed length');
  await assert.rejects(library.localManifest(id), /changed or are unavailable/);
});

test('persistence failure does not falsely report discovered models as saved', async t => {
  const f = await fixture(t);
  await f.write('model.gguf');
  const memory = store(); memory._commitStateFields = () => { throw new Error('disk full'); };
  const library = new ModelLibrary({ store: memory, sources: async () => [f.source], readDirectory: f.read });
  library.start(); await library.pending;
  assert.deepEqual(library.list(), []);
  assert.equal(library.progress.phase, 'error');
  assert.match(library.progress.message, /disk full/);
});

test('large standalone model libraries have bounded results without comparing every file to every model', async () => {
  const source = modelLocation({ root: '/models', device: 'spark', deviceId: 'spark' });
  const result = await scanModelLocation(source, async (_, relative) => ({ root: '/models', relative,
    entries: relative === '' ? Array.from({ length: 10 }, (_, index) => ({ name: `folder-${index}`, relative: `folder-${index}`, directory: true, size: 0 }))
      : Array.from({ length: 600 }, (_, index) => ({ name: `model-${index}.gguf`, relative: `${relative}/model-${index}.gguf`, directory: false, size: 10 })), truncated: false }));
  assert.equal(result.rows.length, 5000);
  assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /Model limit reached/);
  assert(result.rows.every(row => row.fileCount === 1 && row.size === 10));
});

test('completeness detects missing shards and missing config.json, and importLocalFolder imports a folder', async t => {
  const f = await fixture(t);
  await f.write('incomplete/model-00001-of-00003.safetensors');
  await f.write('incomplete/model-00003-of-00003.safetensors');
  const library = new ModelLibrary({ store: store(), sources: async () => [f.source], readDirectory: (source, relative) => localModelDirectory(source.root, relative) });
  const res = await library.importLocalFolder(path.join(f.root, 'incomplete'));
  assert.equal(res.imported, 1);
  const item = library.list()[0];
  assert.equal(item.completeness.complete, false);
  assert.equal(item.completeness.missingShards, 1);
  assert.equal(item.completeness.missingConfig, true);
  assert.match(item.completeness.summary, /1 shard missing/);
  assert.match(item.completeness.summary, /config\.json missing/);
});
