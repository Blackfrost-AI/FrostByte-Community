import test from 'node:test';
import assert from 'node:assert/strict';
import { detectHfFormats, HF_FORMAT_CHIPS, formatSearchFilter } from '../src/shared/hf-formats.js';

const ids = (model) => detectHfFormats(model).map(format => format.id);

test('detects primary EXL3 and NVFP4 formats from tags and repo names', () => {
  assert.deepEqual(ids({ id: 'turboderp/Qwen3-8B-exl3', tags: ['exl3', 'base_model:quantized:Qwen/Qwen3-8B'] }), ['exl3']);
  assert.deepEqual(ids({ id: 'someone/Model-EXL3-4.0bpw', tags: [] }), ['exl3']);
  assert.deepEqual(ids({ id: 'nvidia/Llama-3.1-8B-Instruct-FP4', tags: ['modelopt', 'nvfp4', 'safetensors'] }), ['nvfp4', 'safetensors']);
  assert.deepEqual(ids({ id: 'RedHatAI/Qwen3-8B-NVFP4', tags: ['compressed-tensors'] }), ['nvfp4']);
  assert.ok(detectHfFormats({ id: 'turboderp/x-exl3', tags: ['exl3'] })[0].primary);
});

test('keeps EXL3 distinct from EXL2 and NVFP4 distinct from MXFP4', () => {
  assert.deepEqual(ids({ id: 'a/Model-exl2-6.0bpw', tags: ['exl2'] }), ['exl2']);
  assert.deepEqual(ids({ id: 'openai/gpt-oss-20b', tags: ['mxfp4', 'safetensors'] }), ['mxfp4', 'safetensors']);
  assert.deepEqual(ids({ id: 'a/Model-MXFP4', tags: [] }), ['mxfp4']);
});

test('detects common secondary formats and orders primary first', () => {
  assert.deepEqual(ids({ id: 'unsloth/Qwen3-8B-GGUF', tags: ['gguf'] }), ['gguf']);
  assert.deepEqual(ids({ id: 'Qwen/Qwen3-8B-AWQ', tags: ['awq', 'safetensors'] }), ['awq', 'safetensors']);
  assert.deepEqual(ids({ id: 'x/m-GPTQ-Int4', tags: ['gptq'] }), ['gptq']);
  assert.deepEqual(ids({ id: 'mlx-community/Qwen3-8B-4bit', tags: ['mlx', 'safetensors'] }), ['mlx', 'safetensors']);
  assert.deepEqual(ids({ id: 'x/m-NVFP4-GGUF', tags: ['gguf', 'safetensors'] }), ['nvfp4', 'gguf', 'safetensors']);
});

test('does not invent formats from unrelated words or hostile input', () => {
  assert.deepEqual(ids({ id: 'a/ggufless-awqward-model', tags: [] }), []);
  assert.deepEqual(ids({ id: 'a/plain', tags: ['text-generation'] }), []);
  assert.deepEqual(ids({}), []);
  assert.deepEqual(ids(null), []);
  assert.deepEqual(ids({ id: 42, tags: 'gguf' }), []);
  assert.deepEqual(ids({ id: 'a/b', tags: Array.from({ length: 5000 }, () => 'gguf') }), ['gguf']);
});

test('format chips map to Hugging Face filters, primary formats first', () => {
  assert.deepEqual(HF_FORMAT_CHIPS.slice(0, 2).map(chip => chip.id), ['exl3', 'nvfp4']);
  assert.equal(formatSearchFilter('exl3'), 'exl3');
  assert.equal(formatSearchFilter('nvfp4'), 'nvfp4');
  assert.equal(formatSearchFilter('gguf'), 'gguf');
  assert.equal(formatSearchFilter(''), '');
  assert.equal(formatSearchFilter('license:mit'), '');
  assert.equal(formatSearchFilter('anything-else'), '');
});
