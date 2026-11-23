import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHfReference } from '../src/shared/hf-reference.js';

test('recognizes pasted Hugging Face model links and repo ids', () => {
  const cases = {
    'https://huggingface.co/Qwen/Qwen3-8B': { repo: 'Qwen/Qwen3-8B', revision: null },
    'huggingface.co/Qwen/Qwen3-8B': { repo: 'Qwen/Qwen3-8B', revision: null },
    'https://www.huggingface.co/Qwen/Qwen3-8B/': { repo: 'Qwen/Qwen3-8B', revision: null },
    'https://hf.co/turboderp/Qwen3-8B-exl3': { repo: 'turboderp/Qwen3-8B-exl3', revision: null },
    'https://huggingface.co/turboderp/Qwen3-8B-exl3/tree/4.0bpw': { repo: 'turboderp/Qwen3-8B-exl3', revision: '4.0bpw' },
    'https://huggingface.co/org/m/blob/main/config.json': { repo: 'org/m', revision: 'main' },
    'https://huggingface.co/org/m/resolve/v1.0/model.safetensors?download=true': { repo: 'org/m', revision: 'v1.0' },
    'https://huggingface.co/org/m?library=transformers#usage': { repo: 'org/m', revision: null },
    '  nvidia/Llama-3.1-8B-Instruct-FP4  ': { repo: 'nvidia/Llama-3.1-8B-Instruct-FP4', revision: null },
    'https://huggingface.co/gpt2': { repo: 'gpt2', revision: null },
  };
  for (const [input, expected] of Object.entries(cases)) assert.deepEqual(parseHfReference(input), expected, input);
});

test('treats ordinary search text as a search, not a link', () => {
  for (const input of ['qwen 8b', 'llama', 'exl3', 'Qwen3', '', '   ', 'deepseek r1 nvfp4']) assert.equal(parseHfReference(input), null, input);
});

test('refuses lookalike hosts, other schemes, and non-model pages', () => {
  for (const input of [
    'https://huggingface.co.evil.example/Qwen/Qwen3-8B',
    'https://evil.example/huggingface.co/Qwen/Qwen3-8B',
    'https://huggingface.co@evil.example/Qwen/Qwen3-8B',
    'http://user:pass@huggingface.co/Qwen/Qwen3-8B',
    'javascript:alert(1)//huggingface.co/a/b',
    'file:///huggingface.co/a/b',
    'https://huggingface.co:8443/Qwen/Qwen3-8B',
    'https://huggingface.co/datasets/org/data',
    'https://huggingface.co/spaces/org/app',
    'https://huggingface.co/docs/hub',
    'https://huggingface.co/api/models/org/m',
    'https://huggingface.co/org/../etc',
    'https://huggingface.co/org/m%2F..%2Fx',
    'https://huggingface.co/org/m/tree/..',
    'org/../m', 'a/b/c', '../x', `${'a'.repeat(120)}/${'b'.repeat(120)}`,
  ]) assert.equal(parseHfReference(input), null, input);
});
