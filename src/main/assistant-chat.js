import { StringDecoder } from 'node:string_decoder';
import { endpointUrl, RUNTIME_NAMES, MANAGED_PROVIDER } from './assistant-runtimes.js';

const CHAT_ERROR = 'The model could not complete the request.';
const text = (value, max = 8192) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : null;

export function validateChatRequest({ model, messages } = {}) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Choose a model.');
  if (![...RUNTIME_NAMES, MANAGED_PROVIDER].includes(model.provider) || (typeof model.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(model.deviceId))) throw new Error('Choose a model.');
  if (model.provider === MANAGED_PROVIDER && (model.deviceId !== 'local' || (model.port !== undefined && (!Number.isInteger(model.port) || model.port < 1024 || model.port > 65535)))) throw new Error('Choose a model.');
  const name = text(model.name, 240);
  if (!name || name.includes('..')) throw new Error('Choose a model.');
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 60) throw new Error('The conversation is too long.');
  const clean = messages.map(message => {
    if (!message || typeof message !== 'object' || !['user', 'assistant'].includes(message.role)) throw new Error('Invalid conversation.');
    const content = text(message.content);
    if (!content) throw new Error('Enter a message.');
    return { role: message.role, content };
  });
  if (clean.reduce((sum, message) => sum + message.content.length, 0) > 32000) throw new Error('Start a new conversation.');
  return { model: { deviceId: model.deviceId, provider: model.provider, name, ...(model.provider === MANAGED_PROVIDER && model.port !== undefined ? { port: model.port } : {}) }, messages: clean };
}

export class SseParser {
  constructor({ maxBytes = 1024 * 1024 } = {}) {
    this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.maxBytes = maxBytes; this.bytes = 0;
  }
  push(bytes) {
    this.bytes += bytes.length;
    if (this.bytes > this.maxBytes) throw new Error('The model event is too large.');
    this.buffer += this.decoder.write(bytes);
    const events = [];
    while (true) {
      const match = this.buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const end = match.index;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + match[0].length);
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { events.push({ type: 'done' }); continue; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw new Error('The model returned an invalid response.'); }
      if (parsed?.error) { events.push({ type: 'error', message: CHAT_ERROR }); continue; }
      const content = parsed?.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content.length) events.push({ type: 'delta', text: content });
      // Reasoning models (llama.cpp --jinja, DeepSeek-R1 style) stream their
      // chain-of-thought separately; surface it as a distinct, labelled event
      // so the answer text stays clean and the UI can collapse it.
      const reasoning = parsed?.choices?.[0]?.delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length) events.push({ type: 'reasoning', text: reasoning });
      if (parsed?.choices?.[0]?.finish_reason) events.push({ type: 'done' });
    }
    return events;
  }
}

export function parseSseChunk(value) {
  return new SseParser().push(Buffer.from(value));
}

export async function streamChatCompletion(request, { fetch: transport = fetch, signal, onEvent, apiKey, maxBytes = 4 * 1024 * 1024, remote = false } = {}) {
  const { model, messages } = validateChatRequest(request);
  if (remote && model.deviceId === 'local') throw new Error('Choose a model.');
  const ollama = model.provider === 'ollama';
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer;
  let bytes = 0;
  const idle = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('The model stopped responding.')), 90000); timer.unref?.(); };
  idle();
  try {
    const headers = { 'Content-Type': 'application/json', Accept: ollama ? 'application/x-ndjson' : 'text/event-stream' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const url = model.provider === MANAGED_PROVIDER ? `http://127.0.0.1:${model.port}/v1/chat/completions` : endpointUrl(model.provider, ollama ? '/api/chat' : '/v1/chat/completions');
    const response = await transport(url, {
      method: 'POST', redirect: 'error', headers, signal: controller.signal,
      body: JSON.stringify({ model: model.name, messages, stream: true, ...(ollama ? { options: { num_predict: 4096 } } : { max_tokens: 4096 }) }),
    });
    if (!response.ok || !response.body) {
      if ([401, 403].includes(response.status)) throw new Error('This runtime requires an authorized configuration.');
      throw new Error(CHAT_ERROR);
    }
    const parser = new SseParser({ maxBytes });
    const decoder = new StringDecoder('utf8');
    let ndjson = '', done = false;
    for await (const value of response.body) {
      idle();
      if (ollama) {
        bytes += value.length;
        if (bytes > maxBytes) throw new Error('The model response is too large.');
        ndjson += decoder.write(value);
        while (ndjson.includes('\n')) {
          const end = ndjson.indexOf('\n'); const raw = ndjson.slice(0, end); ndjson = ndjson.slice(end + 1);
          if (!raw.trim()) continue;
          let data;
          try { data = JSON.parse(raw); } catch { throw new Error('The model returned an invalid response.'); }
          if (data.error) throw new Error(CHAT_ERROR);
          if (typeof data.message?.thinking === 'string' && data.message.thinking.length) onEvent({ type: 'reasoning', text: data.message.thinking });
          if (typeof data.message?.content === 'string' && data.message.content.length) onEvent({ type: 'delta', text: data.message.content });
          if (data.done === true) done = true;
        }
      } else {
        for (const event of parser.push(value)) {
          if (event.type === 'error') throw new Error(event.message);
          onEvent(event);
          if (event.type === 'done') done = true;
        }
      }
      // Stop as soon as the model is finished; some servers keep the
      // connection open after the terminal frame.
      if (done) break;
    }
    if (controller.signal.aborted) throw controller.signal.reason || new Error('Chat was cancelled.');
    if (!done) throw new Error('The model connection ended unexpectedly.');
    if (ollama) onEvent({ type: 'done' });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
