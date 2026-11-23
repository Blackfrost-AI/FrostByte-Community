import test from 'node:test';
import assert from 'node:assert/strict';
import REGISTRY from '../src/shared/serve-registry.js';
import { serveOptions, shellQuote, SERVE_IMAGES } from '../src/shared/serve-recipes.js';

const st = { path: 'model.safetensors', size: 1 };
const qwen = { id: 'Qwen/Qwen3-8B', architectures: ['Qwen3ForCausalLM'], tags: ['safetensors'], files: [st], gated: false };

test('bundled registry is a real, pinned snapshot', () => {
  assert.equal(REGISTRY.schema, 'frostbyte.serve-registry');
  assert.match(REGISTRY.sources.vllm.commit, /^[a-f0-9]{40}$/);
  assert.match(REGISTRY.sources.sglang.commit, /^[a-f0-9]{40}$/);
  assert.ok(Object.keys(REGISTRY.vllm).length > 100 && REGISTRY.sglang.length > 100);
  for (const arch of ['LlamaForCausalLM', 'Qwen3ForCausalLM', 'Qwen3MoeForCausalLM', 'DeepseekV3ForCausalLM']) {
    assert.ok(REGISTRY.vllm[arch], arch); assert.ok(REGISTRY.sglang.includes(arch), arch);
  }
});

test('a supported architecture yields both engines with Spark images and copyable commands', () => {
  const result = serveOptions(qwen, { target: 'spark' });
  assert.equal(result.status, 'supported');
  assert.deepEqual(result.engines.map(e => e.id), ['vllm', 'sglang']);
  const [vllm, sglang] = result.engines;
  assert.equal(vllm.image, SERVE_IMAGES.vllm.spark);
  assert.equal(vllm.pull, `docker pull ${SERVE_IMAGES.vllm.spark}`);
  assert.match(vllm.run, /--gpus all/);
  assert.match(vllm.run, /vllm serve Qwen\/Qwen3-8B/);
  assert.match(vllm.run, /-p 8000:8000/);
  assert.match(sglang.run, /sglang\.launch_server --model-path Qwen\/Qwen3-8B/);
  assert.match(sglang.run, /-p 30000:30000/);
  assert.equal(sglang.image, 'lmsysorg/sglang:latest-cu130');
  assert.ok(!vllm.notes.some(note => /Linux host/.test(note)));
});

test('local target uses generic images and says an NVIDIA host is needed', () => {
  const [vllm] = serveOptions(qwen, { target: 'local' }).engines;
  assert.equal(vllm.image, 'vllm/vllm-openai:latest');
  assert.ok(vllm.notes.some(note => /NVIDIA GPU/.test(note)));
});

test('a saved copy is mounted read-only and keeps the public model name', () => {
  const [vllm, sglang] = serveOptions(qwen, { target: 'spark', localPath: "/srv/models/Qwen's 8B" }).engines;
  assert.match(vllm.run, /-v '\/srv\/models\/Qwen'\\''s 8B:\/model:ro'/);
  assert.match(vllm.run, /vllm serve \/model/);
  assert.match(vllm.run, /--served-model-name Qwen\/Qwen3-8B/);
  assert.match(sglang.run, /--model-path \/model/);
});

test('gated models reference HF_TOKEN by name only', () => {
  const [vllm] = serveOptions({ ...qwen, gated: 'manual' }, { target: 'spark' }).engines;
  assert.match(vllm.run, /-e HF_TOKEN /);
  assert.doesNotMatch(vllm.run, /HF_TOKEN=/);
  assert.ok(vllm.notes.some(note => /HF_TOKEN/.test(note)));
});

test('formats and repositories these engines cannot serve explain why and offer no buttons', () => {
  const cases = [
    [{ ...qwen, id: 'turboderp/Qwen3-8B-exl3', tags: ['exl3'] }, /ExLlamaV3/],
    [{ ...qwen, id: 'mlx-community/Qwen3-8B-4bit' }, /MLX/],
    [{ ...qwen, files: [{ path: 'q.Q4_K_M.gguf', size: 1 }] }, /GGUF/],
    [{ ...qwen, files: [{ path: 'README.md', size: 1 }] }, /No safetensors/],
    [{ ...qwen, architectures: ['TotallyMadeUpForCausalLM'] }, /isn.t in the bundled/],
  ];
  for (const [model, reason] of cases) {
    const result = serveOptions(model);
    assert.equal(result.status, 'unsupported', model.id);
    assert.deepEqual(result.engines, []);
    assert.match(result.reason, reason);
  }
  assert.equal(serveOptions({ ...qwen, architectures: [] }).status, 'unknown');
  assert.equal(serveOptions({ ...qwen, id: 'bad id; rm -rf /' }).status, 'unknown');
  assert.equal(serveOptions(null).status, 'unknown');
});

test('NVFP4 and pooling models carry the right caveats', () => {
  const nv = serveOptions({ ...qwen, id: 'nvidia/Qwen3-8B-NVFP4', tags: ['nvfp4'] }, { target: 'spark' });
  assert.equal(nv.status, 'supported');
  assert.ok(nv.engines[0].notes.some(note => /Blackwell/.test(note)));
  const bert = serveOptions({ ...qwen, id: 'google-bert/bert-base', architectures: ['BertModel'] }, { target: 'spark' });
  assert.ok(bert.engines.find(e => e.id === 'vllm').notes.some(note => /pooling/.test(note)));
});

test('shellQuote leaves safe tokens alone and single-quotes the rest', () => {
  assert.equal(shellQuote('Qwen/Qwen3-8B'), 'Qwen/Qwen3-8B');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('$(id)'), "'$(id)'");
});

test('includeAlternatives yields GGUF (llama.cpp + Ollama) and MLX (mlx_lm.server) recipes', () => {
  const ggufModel = { ...qwen, files: [{ path: 'Qwen3-8B-Q4_K_M.gguf', size: 1 }] };
  const ggufRes = serveOptions(ggufModel, { includeAlternatives: true });
  assert.equal(ggufRes.status, 'supported');
  assert.deepEqual(ggufRes.engines.map(e => e.id), ['llamacpp', 'ollama']);
  assert.match(ggufRes.engines[0].run, /llama-server -hf Qwen\/Qwen3-8B -hff Qwen3-8B-Q4_K_M\.gguf/);
  assert.match(ggufRes.engines[1].run, /ollama run hf\.co\/Qwen\/Qwen3-8B/);

  const mlxModel = { ...qwen, id: 'mlx-community/Qwen3-8B-4bit' };
  const mlxRes = serveOptions(mlxModel, { includeAlternatives: true });
  assert.equal(mlxRes.status, 'supported');
  assert.deepEqual(mlxRes.engines.map(e => e.id), ['mlx']);
  assert.match(mlxRes.engines[0].run, /mlx_lm\.server --model mlx-community\/Qwen3-8B-4bit/);
});
