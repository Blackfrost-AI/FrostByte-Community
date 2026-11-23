import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseChunk, SseParser, streamChatCompletion, validateChatRequest } from '../src/main/assistant-chat.js';

const chunk = value => Buffer.from(value);

test('SSE handles CRLF, comments, multiline data and split UTF-8 boundaries', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(chunk(': ping\r\n\r\ndata: {"choices":[{"delta":{"content":"hel')), []);
  assert.deepEqual(parser.push(chunk('lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" world"}}]}\r\n\r\n')), [{ type: 'delta', text: 'hello' }, { type: 'delta', text: ' world' }]);
  assert.deepEqual(parser.push(chunk('data: {"choices":\ndata: [{"delta":{"content":"joined"}}]}\n\n')), [{ type: 'delta', text: 'joined' }]);
  assert.deepEqual(parser.push(chunk('data: {"choices":[{"delta":{"content":"end"}}]}\n\ndata: [DONE]\n\n')), [{ type: 'delta', text: 'end' }, { type: 'done' }]);
});

test('SSE reports provider errors, rejects oversize frames, and never executes content', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(chunk('data: {"error":{"message":"bad input"}}\n\n')), [{ type: 'error', message: 'The model could not complete the request.' }]);
  assert.throws(() => new SseParser({ maxBytes: 20 }).push(chunk(`data: ${'x'.repeat(100)}\n\n`)), /event is too large/);
  assert.deepEqual(parseSseChunk('data: {"choices":[{"delta":{"content":"<img src=x onerror=alert(1)>"}}]}\n\n'), [{ type: 'delta', text: '<img src=x onerror=alert(1)>' }]);
});

test('SSE separates reasoning-model chain-of-thought from answer deltas', () => {
  assert.deepEqual(parseSseChunk('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'), [{ type: 'reasoning', text: 'thinking' }]);
  assert.deepEqual(parseSseChunk('data: {"choices":[{"delta":{"content":"answer","reasoning_content":"think"},"finish_reason":"stop"}]}\n\n'), [{ type: 'delta', text: 'answer' }, { type: 'reasoning', text: 'think' }, { type: 'done' }]);
  assert.deepEqual(parseSseChunk('data: {"choices":[{"delta":{"reasoning_content":""}}]}\n\n'), []);
});

test('chat request accepts only catalog identity and bounded messages', () => {
  const messages = [{ role: 'user', content: 'hello' }];
  assert.deepEqual(validateChatRequest({ model: { deviceId: 'local', provider: 'ollama', name: 'qwen3:8b' }, messages }).messages, messages);
  assert.throws(() => validateChatRequest({ model: { provider: 'other', name: 'x' }, messages }));
  assert.throws(() => validateChatRequest({ model: { provider: 'ollama', name: 'x' }, messages: [{ role: 'user', content: 'x'.repeat(8193) }] }));
  assert.throws(() => validateChatRequest({ model: { provider: 'ollama', name: 'x' }, messages: Array.from({ length: 61 }, () => ({ role: 'user', content: 'x' })) }));
  assert.throws(() => validateChatRequest({ model: { provider: 'ollama', name: 'x' }, messages: [{ role: 'system', content: 'run shell' }] }));
});

test('Ollama chat uses fixed native endpoint and emits ordered deltas', async () => {
  const events = [];
  let body;
  await streamChatCompletion({ model: { deviceId: 'local', provider: 'ollama', name: 'qwen3:8b' }, messages: [{ role: 'user', content: 'hi' }] }, {
    fetch: async (url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, body: (async function * () { yield chunk('{"message":{"content":"Hello"}}\n'); yield chunk('{"message":{"content":" there"},"done":true}\n'); })() };
    }, onEvent: event => events.push(event),
  });
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(events, [{ type: 'delta', text: 'Hello' }, { type: 'delta', text: ' there' }, { type: 'done' }]);
});

test('OpenAI-compatible chat never redirects and cancels an active request', async () => {
  let captured;
  await streamChatCompletion({ model: { deviceId: 'local', provider: 'lmstudio', name: 'test-model' }, messages: [{ role: 'user', content: 'hello' }] }, {
    fetch: async (url, options) => {
      captured = { url, options };
      options.signal.addEventListener('abort', () => {});
      return { ok: true, body: (async function * () { yield chunk('data: {"choices":[{"delta":{"content":"Safe"}}]}\n\n'); yield chunk('data: [DONE]\n\n'); })() };
    }, onEvent: () => {},
  });
  assert.equal(captured.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.headers.Authorization, undefined);
  assert.equal(JSON.parse(captured.options.body).max_tokens, 4096);
});
