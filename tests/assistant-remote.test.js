import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRemoteFrame, RemoteChatStream, remoteDeviceModels, ASSISTANT_CAPABILITY } from '../src/main/assistant-remote.js';
import { DeviceRegistry } from '../src/main/devices.js';
import { sanitizeSparkResponse } from '../src/main/spark-schema.js';

test('paired device models are requested over the saved connection of that device', async () => {
  const store = { state: {}, settings: { sparkHost: '' }, getSettings() { return { ...this.settings }; }, setSettings(patch) { Object.assign(this.settings, patch); }, _flush() {} };
  const devices = new DeviceRegistry({ store, request: async () => ({}) });
  const id = devices.save({ mode: 'ssh', host: 'studio' }, 'studio');
  const model = { id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'qwen', provider: 'ollama', deviceId: 'local', state: 'ready', capabilities: ['chat'], contextChars: 32000 };
  const calls = [];
  const request = async (profile, payload) => {
    calls.push({ profile, action: payload.action });
    return payload.action === 'status' ? { capabilities: { assistant: ASSISTANT_CAPABILITY } } : { models: [model] };
  };
  const result = await remoteDeviceModels(devices, request, id);
  assert.deepEqual(calls, ['status', 'assistant:models'].map(action => ({ profile: devices.profile(id), action })));
  assert.deepEqual(result.models.map(row => [row.name, row.deviceId]), [['qwen', id]]);
});

test('remote discovery response is typed and bounded', () => {
  const model = { id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'qwen', provider: 'ollama', deviceId: 'remote', state: 'ready', capabilities: ['chat'], contextChars: 32000 };
  const result = sanitizeSparkResponse('assistant:models', { models: [model] });
  assert.equal(result.models.length, 1);
  assert.equal(ASSISTANT_CAPABILITY, 1);
  assert.throws(() => sanitizeSparkResponse('assistant:models', { models: [{ ...model, provider: 'custom' }] }));
});

test('remote event frames reject replay, stale stream, oversize chunks, and arbitrary URLs', () => {
  assert.equal(validateRemoteFrame({ stream: 'stream_1', seq: 1, type: 'delta', text: 'hello' }).text, 'hello');
  assert.equal(validateRemoteFrame({ stream: 'stream_1', seq: 2, type: 'reasoning', text: 'thinking' }).type, 'reasoning');
  assert.throws(() => validateRemoteFrame({ stream: 'stream_1', seq: '1', type: 'delta', text: 'hello' }));
  assert.throws(() => validateRemoteFrame({ stream: 'x', seq: 1, type: 'delta', text: 'hello', url: 'http://remote' }));
  assert.throws(() => validateRemoteFrame({ stream: 'x', seq: 1, type: 'delta', text: 'x'.repeat(16385) }));
  assert.throws(() => validateRemoteFrame({ stream: 'x', seq: 1, type: 'reasoning', text: 'x'.repeat(16385) }));
  assert.throws(() => validateRemoteFrame({ stream: 'x', seq: 1, type: 'reasoning' }));
  assert.throws(() => validateRemoteFrame({ stream: 'x', seq: 1, type: 'done', text: 'smuggled' }));
});

test('ordered remote stream emits deltas once and stops on terminal frame', async () => {
  const events = [];
  let cancelled = false;
  const stream = new RemoteChatStream({ stream: 's_12345678', send: () => { cancelled = true; } });
  stream.push(Buffer.from(JSON.stringify({ stream: 's_12345678', seq: 1, type: 'reasoning', text: 'think' }) + '\n'), event => events.push(event));
  stream.push(Buffer.from(JSON.stringify({ stream: 's_12345678', seq: 2, type: 'delta', text: 'A' }) + '\n'), event => events.push(event));
  assert.throws(() => stream.push(Buffer.from(JSON.stringify({ stream: 's_12345678', seq: 2, type: 'delta', text: 'replay' }) + '\n'), () => {}), /out of order/);
  await stream.cancel();
  assert.equal(cancelled, true);
  assert.deepEqual(events, [{ type: 'reasoning', text: 'think' }, { type: 'delta', text: 'A' }]);
});

test('remote terminal frames are acknowledged once and clean up timers', () => {
  const events = [];
  const stream = new RemoteChatStream({ stream: 's_abcdefgh', send: () => {} });
  stream.push(Buffer.from(JSON.stringify({ stream: 's_abcdefgh', seq: 1, type: 'done' }) + '\n'), event => events.push(event));
  assert.equal(stream.done, true);
  assert.equal(stream.buffer, '');
  assert.deepEqual(events, [{ type: 'done' }]);
});
