import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHfOptions, selectionSize, groupRepoFilesForBrowser } from '../src/renderer/hf-options.js';

const file = (path, size = 1024) => ({ path, size });

test('GGUF choices isolate variants and keep all split parts together', () => {
  const options = buildHfOptions([
    file('Q4/model-Q4_K_M-00001-of-00002.gguf'), file('Q4/model-Q4_K_M-00002-of-00002.gguf'),
    file('model-Q8_0.gguf'), file('model.safetensors'), file('README.md'), file('config.json'),
  ]);
  const q4 = options.find(option => option.label === 'Q4_K_M');
  assert.deepEqual(q4.paths, ['Q4/model-Q4_K_M-00001-of-00002.gguf', 'Q4/model-Q4_K_M-00002-of-00002.gguf', 'README.md']);
  assert.equal(q4.incomplete, false);
  assert.equal(q4.bytes, 3072);
  assert.equal(options.find(option => option.label === 'Q8_0').paths.length, 2);
});

test('incomplete, inconsistent and duplicate split sets cannot be offered as complete', () => {
  for (const paths of [
    ['m-Q4-00001-of-00002.gguf'],
    ['m-Q4-00001-of-00002.gguf', 'm-Q4-00002-of-00003.gguf'],
    ['m-Q4-00001-of-00002.gguf', 'm-Q4-00001-of-00002.gguf'],
    ['m-Q4-00000-of-00002.gguf', 'm-Q4-00002-of-00002.gguf'],
  ]) assert.equal(buildHfOptions(paths.map(path => file(path)))[0].incomplete, true);
});

test('Safetensors bundles include config, tokenizer and matching index without alternate weights', () => {
  const options = buildHfOptions([
    file('model-00001-of-00002.safetensors'), file('model-00002-of-00002.safetensors'),
    file('model.safetensors.index.json'), file('config.json'), file('tokenizer.json'), file('tokenizer.model'),
    file('merges.txt'), file('pytorch_model.bin'), file('pytorch_model.bin.index.json'),
    file('model-Q4_K_M.gguf'), file('optimizer.pt'), file('optimizer.safetensors'), file('trainer_state.json'),
  ]);
  const choice = options.find(option => option.format === 'Safetensors');
  assert.deepEqual(choice.paths, ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors',
    'model.safetensors.index.json', 'config.json', 'tokenizer.json', 'tokenizer.model', 'merges.txt']);
  assert.equal(options.length, 3);
});

test('folder variants retain their own metadata and ancestor files without sibling configurations', () => {
  const options = buildHfOptions([
    file('fp16/model.safetensors'), file('fp16/config.json'), file('fp16/model.safetensors.index.json'),
    file('int8/model.safetensors'), file('int8/config.json'), file('tokenizer.json'), file('LICENSE'),
  ]);
  const choice = options.find(option => option.id === 'safetensors:fp16/model');
  assert.deepEqual(choice.paths, ['fp16/model.safetensors', 'fp16/config.json', 'fp16/model.safetensors.index.json', 'tokenizer.json', 'LICENSE']);
});

test('unknown sizes are explicit and projector files are distinct companion choices', () => {
  assert.deepEqual(selectionSize([file('a', 100), file('b', 0), { path: 'c' }]), { bytes: 100, unknown: 2 });
  const options = buildHfOptions([file('mmproj-model-f16.gguf', 0), file('model-Q4_K_M.gguf')]);
  assert.equal(options[0].label, 'Q4_K_M');
  assert.equal(options[1].auxiliary, true);
  assert.equal(options[1].unknown, 1);
  assert.deepEqual(buildHfOptions([file('tokenizer.bin'), file('README.md')]), []);
});

test('non-5-digit split layouts are grouped and completeness-checked', () => {
  // 1-digit and 4-digit splits must not be offered as independent "complete" weights.
  const three = buildHfOptions([file('model-1-of-3.safetensors'), file('model-2-of-3.safetensors'), file('model-3-of-3.safetensors')]);
  assert.equal(three.length, 1);
  assert.equal(three[0].incomplete, false);
  assert.equal(three[0].shardCount, 3);
  const four = buildHfOptions([file('m-0001-of-0008.gguf'), file('m-0002-of-0008.gguf')]);
  assert.equal(four.length, 1);
  assert.equal(four[0].incomplete, true, 'a partial 4-digit split set is incomplete');
  // A lone shard of a declared multi-part set is never complete.
  assert.equal(buildHfOptions([file('model-1-of-3.safetensors')])[0].incomplete, true);
});

test('partNofM split files and groupRepoFilesForBrowser bundle shards cleanly', () => {
  const files = [
    file('Q4_K_M/model.gguf.part1of2', 2048),
    file('Q4_K_M/model.gguf.part2of2', 2048),
    file('config.json', 512),
    file('README.md', 256),
  ];
  const options = buildHfOptions(files);
  assert.equal(options.length, 1);
  assert.equal(options[0].incomplete, false);
  assert.equal(options[0].shardCount, 2);
  assert.deepEqual(options[0].paths, ['Q4_K_M/model.gguf.part1of2', 'Q4_K_M/model.gguf.part2of2', 'README.md']);

  const grouped = groupRepoFilesForBrowser(files);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].type, 'shard-group');
  assert.equal(grouped[0].files.length, 2);
  assert.equal(grouped[0].bytes, 4096);
});

