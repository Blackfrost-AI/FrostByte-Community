import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_ENDPOINTS, endpointUrl, modelId, publicRuntimeError,
  runtimeModels, aggregateRuntimeCatalog,
} from '../src/main/assistant-runtimes.js';

test('automatic endpoints are fixed numeric loopback sockets without user targets', () => {
  assert.equal(RUNTIME_ENDPOINTS.ollama, 11434);
  assert.equal(endpointUrl('ollama', '/api/tags'), 'http://127.0.0.1:11434/api/tags');
  assert.equal(endpointUrl('vllm', '/v1/models'), 'http://127.0.0.1:8000/v1/models');
  assert.throws(() => endpointUrl('https://attacker.invalid', '/v1/models'));
  assert.throws(() => endpointUrl('vllm', 'http://169.254.169.254/'));
  assert.throws(() => endpointUrl('vllm', '//attacker.invalid'));
});

test('Ollama exposes its advertised models and loaded state without a key', async () => {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({
      models: [{ name: 'qwen3:8b', size: 5_000_000_000 }, { name: 'qwen3:8b', size: 5_000_000_000 }],
    }), ps: async () => ({ models: [{ name: 'qwen3:8b', size_vram: 5_000_000_000 }] }) };
  };
  // Inject transport behavior at adapter boundary, including its second endpoint.
  const discover = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/api/ps')
      ? { models: [{ name: 'qwen3:8b' }] }
      : { models: [{ name: 'qwen3:8b', size: 5_000_000_000 }, { name: 'qwen3:8b' }] } };
  };
  const result = await runtimeModels('ollama', { fetch: discover });
  assert.equal(result.status, 'ready');
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].state, 'ready');
  assert.equal(result.models[0].id, modelId('local', 'ollama', 'qwen3:8b'));
  assert.equal(result.models[0].contextChars, 32000);
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test('OpenAI-compatible adapters validate object shape and reject auth-required', async () => {
  const result = await runtimeModels('lmstudio', { fetch: async () => ({
    ok: true, json: async () => ({ data: [{ id: 'model/a' }, { id: 'embed-only', capabilities: ['embeddings'] }, null] }),
  }) });
  assert.deepEqual(result.models.map(m => m.name), ['model/a']);
  const auth = await runtimeModels('vllm', { fetch: async () => ({ ok: false, status: 401 }) });
  assert.equal(auth.status, 'auth-required');
  assert.equal(auth.models.length, 0);
  assert.equal(publicRuntimeError(new Error('http://private.example:8000 token=secret')), 'Runtime is unavailable.');
});

test('models have stable opaque IDs, size and chat capability but no path or credential', async () => {
  const result = await runtimeModels('llamacpp', { fetch: async () => ({
    ok: true, json: async () => ({ data: [{ id: '../../bad', apiKey: 'leak' }, { id: 'gguf-model' }] }),
  }) });
  assert.deepEqual(result.models, [{ id: modelId('local', 'llamacpp', 'gguf-model'), name: 'gguf-model',
    deviceId: 'local', provider: 'llamacpp', state: 'ready', contextChars: 32000, capabilities: ['chat'] }]);
});

test('aggregation isolates offline devices and preserves every device model', async () => {
  const result = await aggregateRuntimeCatalog([
    { id: 'local', name: 'This computer' },
    { id: 'a', name: 'Studio' }, { id: 'b', name: 'Office' },
  ], async id => {
    if (id === 'b') throw new Error('SSH password or private endpoint leaked');
    return { models: [{ id: `m-${id}`, deviceId: id, name: id, state: 'ready', provider: 'ollama', capabilities: ['chat'], contextChars: 32000 }] };
  });
  assert.equal(result.devices.length, 3);
  assert.equal(result.devices[0].status, 'ready');
  assert.equal(result.devices[1].models[0].id, 'm-a');
  assert.equal(result.devices[2].status, 'offline');
  assert.equal(result.devices[2].error, 'Device is offline.');
  assert.equal(JSON.stringify(result).includes('SSH password'), false);
});
