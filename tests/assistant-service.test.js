import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantService } from '../src/main/assistant-service.js';

function setup() {
  const events = [];
  const calls = [];
  const service = new AssistantService({
    directory: `/tmp/frostbyte-test-${process.pid}-${Math.random()}`,
    local: async () => ({ models: [{ id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'qwen', deviceId: 'local', provider: 'ollama', state: 'ready', capabilities: ['chat'], contextChars: 32000 }], runtimes: [] }),
    remote: async id => ({ models: [{ id: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'llama', deviceId: id, provider: 'vllm', state: 'ready', capabilities: ['chat'], contextChars: 32000 }], runtimes: [] }),
    chat: async (request, options) => { calls.push(request); options.onEvent({ type: 'delta', text: 'Hello' }); options.onEvent({ type: 'done' }); },
    listDevices: async () => [{ id: 'paired_abc', name: 'Studio' }],
    onEvent: event => events.push(event),
  });
  return { service, events, calls };
}

test('catalog includes local and paired device models with stable grouping', async () => {
  const { service } = await setup();
  const result = await service.catalog();
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices[0].name, 'This computer');
  assert.equal(result.devices[1].name, 'Studio');
  assert.equal(result.devices[1].models[0].name, 'llama');
});

test('send resolves a catalog model, streams to one conversation, and persists completed reply', async () => {
  const { service, events } = await setup();
  const catalog = await service.catalog();
  const chat = await service.create();
  const result = await service.send({ conversationId: chat.id, modelId: catalog.devices[0].models[0].id, content: 'Hi' });
  assert.equal(result.response, 'Hello');
  assert.equal(events.filter(event => event.type === 'delta').length, 1);
  assert.equal((await service.history(chat.id)).messages.length, 2);
  await assert.rejects(service.send({ conversationId: chat.id, modelId: 'm_ffffffffffffffffffffffffffffffff', content: 'No' }));
});

test('multi-turn send passes history plus the new prompt exactly once, newest last', async () => {
  const { service, calls } = await setup();
  const modelId = (await service.catalog()).devices[0].models[0].id;
  const chat = await service.create();
  await service.send({ conversationId: chat.id, modelId, content: 'First question' });
  await service.send({ conversationId: chat.id, modelId, content: 'Second question' });
  const request = calls.at(-1);
  assert.deepEqual(request.messages, [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'Second question' },
  ]);
  assert.equal((await service.history(chat.id)).messages.length, 4);
});

test('failed final persistence emits error, never complete', async () => {
  const { service, events } = await setup();
  const modelId = (await service.catalog()).devices[0].models[0].id;
  const chat = await service.create();
  const originalAppend = service.store.append.bind(service.store);
  let callsToAppend = 0;
  service.store.append = async (...args) => {
    callsToAppend += 1;
    if (args[1]?.role === 'assistant') throw new Error('disk full');
    return originalAppend(...args);
  };
  await assert.rejects(service.send({ conversationId: chat.id, modelId, content: 'Hi' }));
  assert.ok(callsToAppend >= 2);
  assert.ok(events.some(event => event.type === 'error'));
  assert.ok(!events.some(event => event.type === 'complete'));
});

test('cancel aborts a local stream and persists the partial assistant response', async () => {
  const { service } = await setup();
  const chat = await service.create();
  const modelId = (await service.catalog()).devices[0].models[0].id;
  service.chat = async (_request, { signal, onEvent }) => { onEvent({ type: 'delta', text: 'partial' }); if (signal.aborted) throw new Error('cancelled'); await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); };
  const pending = service.send({ conversationId: chat.id, modelId, content: 'Hi' });
  await new Promise(resolve => setImmediate(resolve));
  await service.cancel(chat.id);
  await assert.rejects(pending, /cancelled/);
  const history = await service.history(chat.id);
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[1].content, 'partial');
});

test('history limit caps the answer without throwing across the event callback boundary', async () => {
  const { service, events } = await setup();
  const chat = await service.create();
  const modelId = (await service.catalog()).devices[0].models[0].id;
  // Simulates a remote SSH data listener: onEvent is invoked synchronously
  // from a transport callback, so a throw here would crash the main process.
  service.chat = async (_request, { signal, onEvent }) => {
    for (let index = 0; index < 40 && !signal.aborted; index += 1) {
      await new Promise(resolve => setImmediate(resolve));
      if (signal.aborted) break;
      onEvent({ type: 'delta', text: 'x'.repeat(1024) });
    }
    if (signal.aborted) throw new Error('cancelled');
    onEvent({ type: 'done' });
  };
  const result = await service.send({ conversationId: chat.id, modelId, content: 'Hi' });
  assert.ok(result.response.length <= 8192 + 64);
  assert.ok(result.response.includes('[Response stopped: history limit reached.]'));
  assert.ok(events.some(event => event.type === 'capped'));
  assert.ok(!events.some(event => event.type === 'error'));
  const history = await service.history(chat.id);
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[1].content, result.response);
});
