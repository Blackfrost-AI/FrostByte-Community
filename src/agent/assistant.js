import { randomBytes } from 'node:crypto';
import { RUNTIME_NAMES, runtimeModels, modelId } from '../main/assistant-runtimes.js';
import { streamChatCompletion } from '../main/assistant-chat.js';

const chats = new Map();
const ids = new Set();

export function assistantDeviceId() {
  if (!assistantDeviceId.value) {
    const name = process.env.FROSTBYTE_DEVICE || 'paired-device';
    assistantDeviceId.value = `remote_${Buffer.from(name).toString('base64url').slice(0, 60)}`;
  }
  return assistantDeviceId.value;
}
export async function assistantModels(deviceId = assistantDeviceId()) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(deviceId || '')) throw new Error('Invalid device ID.');
  const catalogs = await Promise.all(RUNTIME_NAMES.map(provider => runtimeModels(provider, { deviceId })));
  return { models: catalogs.flatMap(item => item.models).slice(0, 1024), runtimes: catalogs.map(item => ({ provider: item.provider, status: item.status })) };
}
export async function assistantChatStart(request, client) {
  const stream = request.stream;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(stream || '') || ids.has(stream) || chats.size >= 16) throw new Error('Invalid assistant stream.');
  if (!client || typeof client.write !== 'function') throw new Error('Assistant chat requires a streaming connection.');
  const catalog = await assistantModels(request.model?.deviceId);
  const model = catalog.models.find(item => item.provider === request.model?.provider && item.name === request.model?.name);
  if (!model || model.state === 'offline' || model.state === 'incompatible') throw new Error('This model is no longer available.');
  ids.add(stream);
  const abort = new AbortController();
  chats.set(stream, abort);
  let seq = 1;
  let closed = false;
  const emit = event => {
    if (closed) return;
    const carriesText = event.type === 'delta' || event.type === 'reasoning';
    if (!carriesText) closed = true;
    client.write(JSON.stringify({ stream, seq: seq++, type: event.type, ...(carriesText ? { text: event.text } : {}) }) + '\n');
  };
  try {
    await streamChatCompletion({ model, messages: request.messages }, {
      remote: true, signal: abort.signal, onEvent: emit,
    });
    if (!closed) emit({ type: 'done' });
  } catch (error) {
    emit({ type: abort.signal.aborted ? 'cancelled' : 'error' });
  } finally { chats.delete(stream); ids.delete(stream); client.end(); }
}
export function assistantChatCancel(stream) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(stream || '')) throw new Error('Invalid assistant stream.');
  const chat = chats.get(stream);
  if (chat) chat.abort();
  return { cancelled: true };
}
export async function stopAssistantChats() { for (const chat of chats.values()) chat.abort(); chats.clear(); }
export { modelId, randomBytes };
