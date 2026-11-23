import path from 'node:path';
import { RUNTIME_NAMES, aggregateRuntimeCatalog } from './assistant-runtimes.js';
import { validateChatRequest, streamChatCompletion } from './assistant-chat.js';
import { ConversationStore, conversationId } from './assistant-store.js';
import { newStreamId } from './assistant-remote.js';

export class AssistantService {
  constructor({ directory, local, remote, chat = streamChatCompletion, listDevices = async () => [], onEvent = () => {} }) {
    this.store = new ConversationStore({ directory });
    this.local = local; this.remote = remote; this.chat = chat; this.listDevices = listDevices; this.onEvent = onEvent;
    this.cache = null; this.cacheAt = 0; this.pending = null; this.active = new Map(); this.streamOwners = new Map();
  }
  async catalog({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cacheAt < 30000) return this.cache;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const paired = await this.listDevices();
      const result = await aggregateRuntimeCatalog([{ id: 'local', name: 'This computer' }, ...paired], async id => id === 'local' ? this.local() : this.remote(id));
      this.cache = result; this.cacheAt = Date.now(); return result;
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async resolve(id) {
    if (typeof id !== 'string' || !/^m_[a-f0-9]{32}$/.test(id)) throw new Error('Choose a model.');
    const model = (await this.catalog()).devices.flatMap(device => device.models).find(item => item.id === id);
    if (!model || model.state === 'offline' || model.state === 'incompatible') throw new Error('This model is not available.');
    return model;
  }
  create() { return this.store.create(); }
  conversations() { return this.store.list(); }
  async history(id) { const result = await this.store.get(id); if (!result) throw new Error('Conversation not found.'); return result; }
  async clear() { await this.cancelAll(); return this.store.clear(); }
  async send({ conversationId: id, modelId, content } = {}) {
    const chatId = conversationId(id);
    if (this.active.has(chatId)) throw new Error('This conversation is already generating.');
    const reservation = new AbortController();
    this.active.set(chatId, { abort: reservation, cancelled: false, stream: null });
    try { return await this.performSend(chatId, modelId, content, reservation); }
    finally { if (this.active.get(chatId)?.abort === reservation) this.active.delete(chatId); }
  }
  async performSend(chatId, modelId, content, reservation) {
    if (reservation.signal.aborted) throw new Error('cancelled');
    const model = await this.resolve(modelId);
    const clean = validateChatRequest({ model, messages: [{ role: 'user', content }] }).messages[0].content;
    const history = await this.history(chatId);
    const messages = [...history.messages, { role: 'user', content: clean }].slice(-60);
    const stream = newStreamId(); const abort = reservation;
    const session = { abort, stream, model, cancelled: false, promise: null };
    this.active.set(chatId, session); this.streamOwners.set(stream, chatId);
    await this.store.append(chatId, { role: 'user', content: clean });
    await this.store.setModel(chatId, model.name);
    let response = '';
    let capped = false;
    const CAP_MARKER = '\n\n[Response stopped: history limit reached.]';
    const MAX_RESPONSE = 8192 - CAP_MARKER.length;
    session.promise = (async () => {
      try {
        this.onEvent({ type: 'start', conversationId: chatId, stream, model: model.name });
        await this.chat({ model, messages }, {
          stream, signal: abort.signal, onEvent: event => {
            if (event.type === 'delta') {
              if (response.length + event.text.length > MAX_RESPONSE) {
                // Keep the prefix that fits (leaving room for the marker),
                // stop generation, and persist the partial answer. Never
                // throw here: this callback can run inside a transport data
                // listener (remote SSH streams).
                response += event.text.slice(0, Math.max(0, MAX_RESPONSE - response.length));
                if (!capped) { capped = true; session.capped = true; abort.abort(); }
                return;
              }
              response += event.text;
            }
            this.onEvent({ ...event, conversationId: chatId, stream });
          },
        });
        if (capped) response += CAP_MARKER;
        if (response) await this.store.append(chatId, { role: 'assistant', content: response });
        else if (!abort.signal.aborted) await this.store.append(chatId, { role: 'assistant', content: '(The model returned an empty response.)' });
        this.onEvent({ type: capped ? 'capped' : 'complete', conversationId: chatId, stream });
        return { conversationId: chatId, response };
      } catch (error) {
        // A capped or cancelled stream still persists whatever was received.
        if (capped && !response.includes('[Response stopped: history limit reached.]')) response += CAP_MARKER;
        if (response && (capped || session.cancelled || abort.signal.aborted)) {
          try { await this.store.append(chatId, { role: 'assistant', content: response }); } catch { /* store may be closing */ }
        }
        this.onEvent({ type: capped ? 'capped' : session.cancelled || abort.signal.aborted ? 'cancelled' : 'error', conversationId: chatId, stream });
        if (capped) return { conversationId: chatId, response };
        if (session.cancelled || abort.signal.aborted) throw new Error('cancelled');
        throw new Error('The model could not complete the request.');
      } finally { this.active.delete(chatId); this.streamOwners.delete(stream); }
    })();
    return session.promise;
  }
  async cancel(id) {
    const session = this.active.get(conversationId(id));
    if (session) { session.cancelled = true; session.abort.abort(); await this.cancelRemote?.(session); }
  }
  async cancelAll() { for (const id of [...this.active.keys()]) await this.cancel(id); }
}
