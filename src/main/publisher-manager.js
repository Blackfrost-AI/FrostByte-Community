import { randomUUID } from 'node:crypto';
import { createPublisherAccount, importPublisherAccount, unlockPublisherAccount, exportMnemonic, fingerprint, signPublication, signChallenge, signRecipe } from './publisher.js';
import { normalizePublisherRecord } from './publisher-record.js';

export const PUBLISHER_REVEAL_MS = 60_000;

/** Main-owned setup, recovery and session lifecycle. No network or device access. */
export class PublisherManager {
  constructor({ store, protection, confirm, now = Date.now }) {
    this.store = store; this.protection = protection; this.confirm = confirm; this.now = now;
    this.session = null; this.reveal = null; this.epoch = 0;
  }

  available() {
    try { return this.protection.isEncryptionAvailable() && this.protection.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  }

  requireProtection() {
    if (!this.available()) throw new Error('Publisher key protection is unavailable. Unlock your operating system key store and try again.');
  }

  status() {
    const base = { present: false, unlocked: false, backupRequired: false, needsProtection: false, invalid: false,
      available: this.available(), pubKey: '', username: '', fingerprint: '' };
    let record;
    try { record = normalizePublisherRecord(this.store.getPublisherAccount()); }
    catch { if (this.session || this.reveal) this.lock(); return { ...base, present: true, invalid: true }; }
    if (!record) return base;
    if (!base.available && this.session) this.lock();
    return { ...base, present: true, pubKey: record.pubKey, username: record.username, fingerprint: fingerprint(record.pubKey),
      backupRequired: record.schema !== 2 || !record.backupConfirmedAt, needsProtection: record.schema !== 2,
      unlocked: !!(base.available && record.schema === 2 && record.backupConfirmedAt && this.session?.pubKey === record.pubKey) };
  }

  protect(account) {
    this.requireProtection();
    let envelope;
    try { envelope = this.protection.encryptString(JSON.stringify(normalizePublisherRecord(account))).toString('base64'); }
    catch { throw new Error('The operating system could not protect this publisher identity. Nothing was saved.'); }
    return normalizePublisherRecord({ schema: 2, pubKey: account.pubKey, username: account.username,
      createdAtMs: account.createdAtMs, keyEnvelope: envelope, backupConfirmedAt: 0 });
  }

  account(record) {
    this.requireProtection();
    if (!record) throw new Error('No publisher identity is saved.');
    if (record.schema !== 2) return record;
    try {
      const account = normalizePublisherRecord(JSON.parse(this.protection.decryptString(Buffer.from(record.keyEnvelope, 'base64'))));
      if (!account || account.schema || ['pubKey', 'username', 'createdAtMs'].some(key => account[key] !== record[key])) throw new Error();
      return account;
    } catch { throw new Error('This computer cannot open the publisher key. Unlock its key store, or restore your recovery phrase.'); }
  }

  beginReveal(record, mnemonic) {
    this.reveal = { id: randomUUID(), pubKey: record.pubKey, expiresAt: this.now() + PUBLISHER_REVEAL_MS };
    return { pubKey: record.pubKey, username: record.username, mnemonic, revealId: this.reveal.id,
      expiresAt: this.reveal.expiresAt, cancelled: false };
  }

  create(request, importing = false) {
    if (this.status().present) throw new Error('Remove the saved publisher identity before creating or importing another.');
    const allowed = importing ? ['petname', 'password', 'mnemonic'] : ['petname', 'password'];
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !allowed.includes(key))) {
      throw new Error('Invalid publisher setup request.');
    }
    this.requireProtection();
    const { account, mnemonic } = importing ? importPublisherAccount(request) : createPublisherAccount(request);
    const record = this.protect(account);
    this.store.setPublisherAccount(record);
    this.lock();
    return this.beginReveal(record, mnemonic);
  }

  async export(password) {
    this.lock();
    const epoch = this.epoch;
    const record = normalizePublisherRecord(this.store.getPublisherAccount());
    const account = this.account(record);
    // Validate credentials before prompting; never expose cipher/KDF internals in logs.
    let mnemonic;
    try { mnemonic = exportMnemonic(account, password); }
    catch { throw new Error('Could not unlock the publisher identity. Check your password.'); }
    if (!await this.confirm('export')) return { cancelled: true };
    if (epoch !== this.epoch) throw new Error('Publisher recovery changed during confirmation. Try again.');
    let protectedRecord = record;
    if (record.schema !== 2) {
      protectedRecord = this.protect(account);
      this.store.setPublisherAccount(protectedRecord);
    }
    return this.beginReveal(protectedRecord, mnemonic);
  }

  acknowledge(request) {
    const reveal = this.reveal;
    const record = normalizePublisherRecord(this.store.getPublisherAccount());
    if (!reveal || request?.revealId !== reveal.id || this.now() >= reveal.expiresAt
      || !record || record.schema !== 2 || record.pubKey !== reveal.pubKey) {
      throw new Error('This recovery view has expired. Show your recovery phrase again to finish its backup.');
    }
    this.store.setPublisherAccount({ ...record, backupConfirmedAt: Math.max(1, this.now()) });
    this.closeReveal(reveal.id);
    return this.status();
  }

  closeReveal(id) {
    if (typeof id === 'string' && id === this.reveal?.id) { this.reveal = null; this.epoch++; }
    return { closed: true };
  }

  unlock(password) {
    this.lock();
    const record = normalizePublisherRecord(this.store.getPublisherAccount());
    if (!record || record.schema !== 2 || !record.backupConfirmedAt) {
      throw new Error('Finish backing up your recovery phrase before unlocking this identity.');
    }
    const account = this.account(record);
    try { this.session = unlockPublisherAccount(account, password); }
    catch { throw new Error('Could not unlock the publisher identity. Check your password.'); }
    return this.status();
  }

  lock() { this.session = null; this.reveal = null; this.epoch++; return { unlocked: false }; }

  sign(fields) {
    if (!this.status().unlocked) throw new Error('Finish backup and unlock your publisher identity before signing.');
    return signPublication(this.session, fields);
  }

  /** ADR 003: sign the Hub's account-binding challenge nonce (raw UTF-8, hex sig). */
  signChallenge(message) {
    if (!this.status().unlocked) throw new Error('Finish backup and unlock your publisher identity before signing.');
    return signChallenge(this.session, message);
  }

  /** P2: sign a recipe v2 manifest for Hub publish (normalized manifest + base64 sig). */
  signRecipe(manifest) {
    if (!this.status().unlocked) throw new Error('Finish backup and unlock your publisher identity before signing.');
    return signRecipe(this.session, manifest);
  }

  async clear() {
    if (!this.status().present) return { cleared: true, cancelled: false };
    const epoch = this.epoch;
    if (!await this.confirm('clear')) return { cleared: false, cancelled: true };
    if (epoch !== this.epoch) throw new Error('Publisher identity changed during confirmation. Try again.');
    this.store.setPublisherAccount(null);
    this.lock();
    return { cleared: true, cancelled: false };
  }
}
