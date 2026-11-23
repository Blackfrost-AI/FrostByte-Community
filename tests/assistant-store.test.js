import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConversationStore, conversationId, publicMessage } from '../src/main/assistant-store.js';

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frostbyte-assistant-test-'));
  return { dir, store: new ConversationStore({ directory: dir }) };
};

test('conversation records have bounded validated text and a new conversation', async () => {
  const { store } = await setup();
  const chat = await store.create();
  assert.match(chat.id, /^c_[A-Za-z0-9_-]{22}$/);
  assert.equal(conversationId(chat.id), chat.id);
  assert.throws(() => conversationId('../../history'));
  assert.throws(() => publicMessage({ role: 'system', content: 'run shell' }));
  assert.throws(() => publicMessage({ role: 'user', content: 'x'.repeat(8193) }));
});

test('append persists complete messages atomically and excludes internal model credentials', async () => {
  const { store, dir } = await setup();
  const chat = await store.create();
  const saved = await store.append(chat.id, { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi <img onerror=x>' });
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[1].content, 'Hi <img onerror=x>');
  const raw = await fs.readFile(path.join(dir, 'conversations.json'), 'utf8');
  assert.equal(raw.includes('apiKey'), false);
  assert.equal((await store.list())[0].preview, 'Hello');
  assert.deepEqual((await store.get(chat.id)).messages, saved.messages);
});

test('history is capped, clear is permanent, and incomplete generations are not stored', async () => {
  const { store } = await setup();
  for (let index = 0; index < 101; index++) {
    const chat = await store.create();
    await store.append(chat.id, { role: 'user', content: `message ${index}` });
  }
  assert.equal((await store.list()).length, 100);
  assert.equal((await store.list()).at(-1).preview, 'message 1');
  await store.clear();
  assert.deepEqual(await store.list(), []);
});
