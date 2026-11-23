import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PublisherManager, PUBLISHER_REVEAL_MS } from '../src/main/publisher-manager.js';
import { createPublisherAccount, verifyPublication } from '../src/main/publisher.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-publisher-store-'));
process.env.FROSTBYTE_HOME = home;
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads') }));
const { Store } = await import('../src/main/store.js');
const vector = JSON.parse(fs.readFileSync(new URL('./fixtures/publisher-aeon-vector.json', import.meta.url)));
const password = 'publisher-test-password';
const osKey = randomBytes(32);
const protection = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', osKey, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decryptString(bytes) {
    const decipher = createDecipheriv('aes-256-gcm', osKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  },
};
let store, manager, now, approved;
beforeEach(() => {
  store = new Store(); store.setPublisherAccount(null); now = 1700000000000; approved = true;
  manager = new PublisherManager({ store, protection, confirm: async () => approved, now: () => now });
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

function create() { return manager.create({ petname: 'Test publisher', password }); }
function acknowledge(reveal) { return manager.acknowledge({ revealId: reveal.revealId }); }

test('backup requirement survives Store and manager restart, then unlocks and signs', async () => {
  const reveal = create();
  const saved = fs.readFileSync(path.join(home, 'state.json'), 'utf8');
  assert.equal(saved.includes(reveal.mnemonic), false);
  assert.equal(saved.includes(password), false);
  assert.equal(saved.includes('encSecret'), false);
  assert.equal(manager.status().backupRequired, true);
  store = new Store(); manager = new PublisherManager({ store, protection, confirm: async () => true, now: () => now });
  assert.throws(() => manager.unlock(password), /backing up/);
  const recovered = await manager.export(password);
  assert.equal(recovered.mnemonic, reveal.mnemonic);
  acknowledge(recovered);
  assert.equal(new Store().getPublisherAccount().backupConfirmedAt, now);
  manager.unlock(password);
  const signature = manager.sign(vector);
  assert.equal(verifyPublication({ ...vector, ...signature }), true);
  manager.lock(); assert.equal(manager.status().unlocked, false);
});

test('reveal expiry and leaving recovery require a fresh view before acknowledgment', async () => {
  const first = create(); now += PUBLISHER_REVEAL_MS;
  assert.throws(() => acknowledge(first), /expired/);
  const second = await manager.export(password); manager.closeReveal(second.revealId);
  assert.throws(() => acknowledge(second), /expired/);
  assert.equal(manager.status().backupRequired, true);
  acknowledge(await manager.export(password));
});

test('unavailable or plaintext OS protection never saves a publisher', () => {
  for (const backend of [{ isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }]) {
    const unavailable = new PublisherManager({ store, protection: backend });
    assert.throws(() => unavailable.create({ petname: 'Test', password }), /protection is unavailable/);
    assert.equal(store.getPublisherAccount(), null);
  }
});

test('password-only development accounts migrate after approved recovery', async () => {
  const original = createPublisherAccount({ petname: 'Legacy', password });
  store.setPublisherAccount(original.account);
  assert.equal(manager.status().needsProtection, true);
  approved = false;
  assert.equal((await manager.export(password)).cancelled, true);
  assert.equal(store.getPublisherAccount().schema, undefined);
  approved = true;
  const reveal = await manager.export(password);
  assert.equal(reveal.mnemonic, original.mnemonic);
  assert.equal(store.getPublisherAccount().schema, 2);
  assert.equal(manager.status().backupRequired, true);
  acknowledge(reveal); manager.unlock(password);
});

test('cancelled recovery and removal retain the identity without exposing a phrase', async () => {
  const reveal = create(); acknowledge(reveal); manager.unlock(password); approved = false;
  const exported = await manager.export(password);
  assert.deepEqual(exported, { cancelled: true });
  assert.equal(manager.status().unlocked, false);
  assert.deepEqual(await manager.clear(), { cleared: false, cancelled: true });
  assert.equal(manager.status().present, true);
  approved = true; await manager.clear();
  assert.equal(new Store().getPublisherAccount(), null);
});

test('failed persistence does not advance backup or remove the account', async () => {
  const reveal = create(); const flush = store._flush;
  store._flush = () => { throw new Error('fixture disk unavailable'); };
  assert.throws(() => acknowledge(reveal), /disk unavailable/);
  assert.equal(manager.status().backupRequired, true);
  await assert.rejects(manager.clear(), /disk unavailable/);
  assert.equal(manager.status().present, true);
  store._flush = flush; acknowledge(reveal);
});

test('unreadable saved metadata is recoverable through explicit removal', async () => {
  store.state.publisherAccount = { pubKey: '' };
  assert.equal(manager.status().invalid, true);
  assert.equal(manager.status().pubKey, '');
  await manager.clear(); assert.equal(manager.status().present, false);
});

test('locking while recovery confirmation is open cancels its reveal', async () => {
  create();
  let finish;
  manager.confirm = () => new Promise(resolve => { finish = resolve; });
  const pending = manager.export(password);
  manager.lock(); finish(true);
  await assert.rejects(pending, /changed during confirmation/);
  assert.equal(manager.reveal, null);
});
