import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';
import { modelId } from './assistant-runtimes.js';
import { sanitizeSparkResponse } from './spark-schema.js';

export const ASSISTANT_CAPABILITY = 1;
const streamId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : null;

/** Assistant models of one paired device, asked over that device's saved connection. */
export async function remoteDeviceModels(devices, request, id) {
  const profile = devices.profile(id);
  const status = sanitizeSparkResponse('status', await request(profile, { action: 'status' }, { timeout: 12000 }));
  if (status.capabilities?.assistant !== 1) throw new Error('Update this device to use the assistant.');
  const response = sanitizeSparkResponse('assistant:models', await request(profile, { action: 'assistant:models' }, { timeout: 15000 }));
  return { ...response, models: response.models.map(model => ({ ...model, deviceId: id, id: modelId(id, model.provider, model.name) })) };
}

/** Delimited, ordered companion frames. A remote peer cannot supply transport or credentials. */
export function validateRemoteFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid assistant stream.');
  if (!streamId(frame.stream) || !Number.isSafeInteger(frame.seq) || frame.seq < 1 || frame.seq > 1_000_000) throw new Error('Invalid assistant stream.');
  if (!['delta', 'reasoning', 'done', 'error', 'cancelled'].includes(frame.type)) throw new Error('Invalid assistant stream.');
  const carriesText = frame.type === 'delta' || frame.type === 'reasoning';
  if (carriesText && (typeof frame.text !== 'string' || !frame.text.length || frame.text.length > 16384)) throw new Error('Invalid assistant stream.');
  const allowed = carriesText ? ['stream', 'seq', 'type', 'text'] : ['stream', 'seq', 'type'];
  if (Object.keys(frame).some(key => !allowed.includes(key))) throw new Error('Invalid assistant stream.');
  return { stream: frame.stream, seq: frame.seq, type: frame.type, ...(carriesText ? { text: frame.text } : {}) };
}

export function newStreamId() { return `s_${randomBytes(18).toString('base64url')}`; }

export class RemoteChatStream {
  constructor({ stream, send, maxBytes = 4 * 1024 * 1024, maxDurationMs = 600000, idleMs = 90000, onTimeout = () => {} }) {
    if (!streamId(stream) || typeof send !== 'function') throw new Error('Invalid assistant stream.');
    this.id = stream; this.send = send; this.expected = 1; this.buffer = ''; this.bytes = 0; this.maxBytes = maxBytes; this.done = false;
    this.decoder = new StringDecoder('utf8'); this.idleMs = idleMs; this.onTimeout = onTimeout;
    this.totalTimer = setTimeout(() => { this.done = true; this.onTimeout('The model took too long.'); }, maxDurationMs); this.totalTimer.unref?.();
    this.idle();
  }
  idle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.done = true; this.onTimeout('The model stopped responding.'); }, this.idleMs); this.idleTimer.unref?.();
  }
  push(bytes, onEvent) {
    if (this.done) return;
    this.idle(); this.bytes += bytes.length;
    if (this.bytes > this.maxBytes) { this.done = true; throw new Error('The model response is too large.'); }
    this.buffer += this.decoder.write(bytes);
    while (this.buffer.includes('\n')) {
      const end = this.buffer.indexOf('\n'); const raw = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!raw.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { this.done = true; throw new Error('Invalid assistant stream.'); }
      const frame = validateRemoteFrame(parsed);
      if (frame.stream !== this.id || frame.seq !== this.expected) { this.done = true; throw new Error('Assistant stream is out of order.'); }
      this.expected += 1;
      if (frame.type === 'delta' || frame.type === 'reasoning') onEvent({ type: frame.type, text: frame.text });
      else { this.done = true; this.terminal = true; this.close(); onEvent({ type: frame.type }); return; }
    }
  }
  async cancel() { if (!this.done || !this.terminal) { this.done = true; await this.send({ action: 'assistant:chat:cancel', stream: this.id }); } this.close(); }
  close() { clearTimeout(this.totalTimer); clearTimeout(this.idleTimer); this.buffer = ''; }
}
