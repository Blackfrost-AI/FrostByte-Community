import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHfOptions } from '../src/renderer/hf-options.js';
import { variantFamily, quantLabel, groupVariants, fitHint, modelLifecycle } from '../src/renderer/hf-variants.js';

const GB = 1024 ** 3;
const st = (path, size) => ({ path, size });

test('safetensors family follows the repository format, primary formats first', () => {
  const exl3 = { id: 'turboderp/Qwen3-8B-exl3', tags: ['exl3'] };
  const nvfp4 = { id: 'nvidia/Qwen3-8B-NVFP4', tags: ['nvfp4'] };
  const plain = { id: 'Qwen/Qwen3-8B', tags: ['safetensors'] };
  const option = { format: 'Safetensors', detail: 'model.safetensors' };
  assert.equal(variantFamily(option, exl3).id, 'exl3');
  assert.equal(variantFamily(option, nvfp4).id, 'nvfp4');
  assert.equal(variantFamily(option, plain).id, 'safetensors');
  assert.equal(variantFamily({ format: 'GGUF', detail: 'x.Q4_K_M.gguf' }, exl3).id, 'gguf');
  assert.equal(variantFamily({ format: 'GGUF', auxiliary: true, detail: 'mmproj.gguf' }, plain).id, 'companion');
  assert.equal(variantFamily({ format: 'GGUF', incomplete: true, detail: 'x' }, plain).id, 'incomplete');
  assert.equal(variantFamily({ format: 'Safetensors', detail: '4.0bpw/model.safetensors' }, plain).id, 'exl3');
});

test('mixed-format repos classify each option by its own path, not the repo tag', () => {
  // Repo ships fp16 root weights AND an exl3 quant subfolder; tags expose both.
  const mixed = { id: 'org/Model', tags: ['safetensors', 'exl3'] };
  assert.equal(variantFamily({ format: 'Safetensors', detail: 'model.safetensors' }, mixed).id, 'safetensors');
  assert.equal(variantFamily({ format: 'Safetensors', detail: 'exl3/4.0bpw/model.safetensors' }, mixed).id, 'exl3');
  assert.equal(variantFamily({ format: 'Safetensors', detail: 'awq/model.safetensors' }, mixed).id, 'awq');
  // A single unambiguous quant tag with no original weights still classifies the root.
  assert.equal(variantFamily({ format: 'Safetensors', detail: 'model.safetensors' }, { id: 'org/M', tags: ['gptq'] }).id, 'gptq');
  // Repo named for a family wins even alongside a safetensors tag.
  assert.equal(variantFamily({ format: 'Safetensors', detail: 'model.safetensors' }, { id: 'org/M-exl3', tags: ['safetensors', 'exl3'] }).id, 'exl3');
});

test('extracts readable quant labels', () => {
  assert.equal(quantLabel({ format: 'Safetensors', detail: '4.0bpw/model.safetensors' }), '4.0 bpw');
  assert.equal(quantLabel({ format: 'Safetensors', detail: 'model.safetensors' }, { id: 'a/b-3.5bpw-exl3' }), '3.5 bpw');
  assert.equal(quantLabel({ format: 'GGUF', label: 'Q4_K_M', detail: 'm.Q4_K_M.gguf' }), 'Q4_K_M');
  assert.equal(quantLabel({ format: 'Safetensors', detail: 'model.safetensors' }, { id: 'nvidia/X-NVFP4', tags: ['nvfp4'] }), 'NVFP4');
  assert.equal(quantLabel({ format: 'Safetensors', detail: 'model.safetensors' }, { id: 'Qwen/Qwen3-8B' }), '');
});

test('groups real option lists in a stable order with one recommended pick per group', () => {
  const files = [
    st('model-Q8_0.gguf', 8 * GB), st('model-Q4_K_M.gguf', 4.6 * GB), st('model-Q2_K.gguf', 3 * GB),
    st('mmproj-F16.gguf', 0.6 * GB), st('model.safetensors', 16 * GB), st('config.json', 1000),
  ];
  const options = buildHfOptions(files);
  const groups = groupVariants(options, { id: 'org/Model-GGUF', tags: ['gguf'] }, { memoryBytes: 12 * GB });
  assert.deepEqual(groups.map(g => g.id), ['gguf', 'safetensors', 'companion']);
  const gguf = groups[0];
  assert.equal(gguf.label, 'GGUF');
  assert.equal(gguf.items.length, 3);
  // Largest variant that comfortably fits is recommended.
  assert.equal(gguf.items.find(item => item.recommended).quant, 'Q8_0');
  assert.equal(groups[1].items[0].fit.level, 'too-large');
  assert.ok(groups.every(g => g.items.filter(item => item.recommended).length <= 1));
  assert.equal(groups[2].items[0].recommended, false);
});

test('without memory information the smallest complete variant is not forced and no fit is claimed', () => {
  const options = buildHfOptions([st('a.Q4_K_M.gguf', 4 * GB), st('a.Q8_0.gguf', 8 * GB)]);
  const [group] = groupVariants(options, { id: 'o/a-GGUF' });
  assert.ok(group.items.every(item => item.fit === null));
  assert.equal(group.items.find(item => item.recommended).quant, 'Q4_K_M');
});

test('primary families sort before everything else', () => {
  const groups = groupVariants([
    { id: 'g', format: 'GGUF', label: 'Q4_K_M', detail: 'x.Q4_K_M.gguf', bytes: GB, unknown: 0, paths: [] },
    { id: 's', format: 'Safetensors', label: 'Safetensors', detail: '4.0bpw/model.safetensors', bytes: GB, unknown: 0, paths: [] },
  ], { id: 'o/m' });
  assert.deepEqual(groups.map(g => g.id), ['exl3', 'gguf']);
  assert.equal(groups[0].primary, true);
});

test('fit hints are conservative and never guess with missing data', () => {
  assert.equal(fitHint(0, 16 * GB), null);
  assert.equal(fitHint(4 * GB, 0), null);
  assert.equal(fitHint(4 * GB, undefined), null);
  assert.equal(fitHint(4 * GB, 16 * GB).level, 'fits');
  assert.equal(fitHint(13 * GB, 16 * GB).level, 'tight');
  assert.equal(fitHint(15 * GB, 16 * GB).level, 'too-large');
  assert.match(fitHint(4 * GB, 16 * GB).text, /fits/i);
});

test('lifecycle reports downloading and saved copies for the exact repository only', () => {
  const transfers = [
    { repoId: 'Org/Model', revision: 'main', device: 'local', status: 'active', downloaded: 50, total: 200, filePath: 'a', destination: '/d' },
    { repoId: 'Org/Model', revision: 'main', device: 'local', status: 'done', downloaded: 100, total: 100, filePath: 'b', destination: '/d' },
    { repoId: 'Org/Model-GGUF', revision: 'main', device: 'local', status: 'active', downloaded: 1, total: 2, filePath: 'c', destination: '/d' },
    { repoId: 'Org/Model', revision: 'main', device: 'spark', deviceId: 's1', deviceName: 'Spark', status: 'done', downloaded: 5, total: 5, filePath: 'a', destination: '/s' },
  ];
  const inventory = [
    { id: 'i1', source: 'hf', repoId: 'org/model', device: 'local', path: '/d/Org/Model', name: 'Org/Model' },
    { id: 'i2', source: 'hf', repoId: 'Org/Model-GGUF', device: 'local', path: '/d/x' },
    { id: 'i3', source: 'torrent', name: 'Org/Model', device: 'local', path: '/t' },
  ];
  const life = modelLifecycle('Org/Model', { transfers, inventory });
  assert.equal(life.downloading.length, 1);
  assert.equal(life.downloading[0].device, 'local');
  assert.equal(Math.round(life.downloading[0].progress * 100), 50);
  assert.deepEqual(life.saved.map(entry => entry.id), ['i1']);
  assert.equal(life.state, 'downloading');
  assert.equal(modelLifecycle('Org/Model', { transfers: [], inventory }).state, 'saved');
  assert.equal(modelLifecycle('Other/Repo', { transfers, inventory }).state, 'none');
  assert.equal(modelLifecycle('', {}).state, 'none');
});
