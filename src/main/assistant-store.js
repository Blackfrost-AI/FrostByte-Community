import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export const conversationId = value => {
  if (typeof value !== 'string' || !/^c_[A-Za-z0-9_-]{22}$/.test(value)) throw new Error('Invalid conversation.');
  return value;
};
export function publicMessage(message) {
  if (!message || typeof message !== 'object' || !['user', 'assistant'].includes(message.role) || !validText(message.content)) throw new Error('Invalid message.');
  return { role: message.role, content: message.content };
}

export class ConversationStore {
  constructor({ directory }) { this.directory = directory; this.file = path.join(directory, 'conversations.json'); this.queue = Promise.resolve(); this.records = null; }
  async load() {
    if (this.records) return this.records;
    try {
      const stat = await fs.stat(this.file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid assistant history.');
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('Invalid assistant history.');
      this.records = parsed.map(record => {
        const id = conversationId(record.id);
        if (!Array.isArray(record.messages) || record.messages.length > 60) throw new Error('Invalid assistant history.');
        const messages = record.messages.map(publicMessage);
        if (messages.reduce((sum, message) => sum + message.content.length, 0) > 32000) throw new Error('Invalid assistant history.');
        return { id, messages, created: Number.isSafeInteger(record.created) ? record.created : Date.now(), updated: Number.isSafeInteger(record.updated) ? record.updated : Date.now(), model: typeof record.model === 'string' ? record.model.slice(0, 240) : '' };
      });
    } catch (error) { if (error.code !== 'ENOENT') { await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {}); } this.records = []; }
    return this.records;
  }
  write(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  async save() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(this.directory, 0o700);
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.records), { mode: 0o600 });
    await fs.rename(temporary, this.file);
    if (process.platform !== 'win32') await fs.chmod(this.file, 0o600);
  }
  summary(record) { return { id: record.id, created: record.created, updated: record.updated, preview: record.messages[0]?.content.slice(0, 120) || 'New conversation', model: record.model || '' }; }
  async list() { return this.write(async () => (await this.load()).map(record => this.summary(record))); }
  async get(id) { return this.write(async () => { const record = (await this.load()).find(item => item.id === conversationId(id)); return record ? structuredClone(record) : null; }); }
  async create() {
    return this.write(async () => {
      await this.load();
      const now = Date.now();
      const record = { id: `c_${randomBytes(16).toString('base64url')}`, messages: [], created: now, updated: now, model: '' };
      this.records.unshift(record); this.records.length = Math.min(this.records.length, 100); await this.save();
      return structuredClone(record);
    });
  }
  async append(id, ...messages) {
    return this.write(async () => {
      const record = (await this.load()).find(item => item.id === conversationId(id));
      if (!record) throw new Error('Conversation not found.');
      const clean = messages.map(publicMessage);
      if (record.messages.length + clean.length > 60 || [...record.messages, ...clean].reduce((sum, message) => sum + message.content.length, 0) > 32000) throw new Error('Start a new conversation.');
      record.messages.push(...clean); record.updated = Date.now(); await this.save();
      return structuredClone(record);
    });
  }
  async setModel(id, model) {
    return this.write(async () => {
      const record = (await this.load()).find(item => item.id === conversationId(id));
      if (!record || typeof model !== 'string' || model.length > 240) throw new Error('Invalid conversation.');
      record.model = model; await this.save();
    });
  }
  async clear() { return this.write(async () => { this.records = []; await this.save(); }); }
}
