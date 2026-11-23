import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from './store.js';
import { TERMS_VERSION, PRIVACY_VERSION, DIAGNOSTICS_VERSION } from '../shared/reports.js';
import { COMMUNITY_LINKS } from '../shared/community.js';

const MAX_CONSENT_BYTES = 64 * 1024;

function readConsent(file) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    const wrongOwner = typeof process.getuid === 'function' && before.uid !== process.getuid();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || wrongOwner || before.size > MAX_CONSENT_BYTES) return {};
    const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd), after = fs.lstatSync(file);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || after.dev !== before.dev || after.ino !== before.ino || opened.size > MAX_CONSENT_BYTES) return {};
    const body = Buffer.alloc(opened.size);
    if (opened.size && fs.readSync(fd, body, 0, opened.size, 0) !== opened.size) return {};
    const value = JSON.parse(body.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError || ['ELOOP', 'EMLINK'].includes(error.code)) return {};
    throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

export class PrivacyService {
  constructor({ directory, version = '0.0.0', now = Date.now } = {}) {
    this.file = path.join(directory, 'privacy.json');
    this.version = version;
    this.reportingDisabled = `FrostByte ${version} does not collect or send diagnostic reports or in-app feedback. Open feedback on GitHub and choose what to share there.`;
    this.now = now;
    this.consent = readConsent(this.file);
    this.clear();
  }
  get accepted() { return this.consent.termsVersion === TERMS_VERSION && this.consent.privacyVersion === PRIVACY_VERSION && typeof this.consent.acceptedAt === 'string'; }
  // Old profiles can retain their historical opt-in until the new notice is
  // accepted. That history is never an instruction to collect or transmit.
  get enabled() { return false; }
  status() { return { required: !this.accepted, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, diagnosticsVersion: DIAGNOSTICS_VERSION, acceptedAt: this.accepted ? this.consent.acceptedAt : null, diagnosticsEnabled: false, collectionEnabled: false, feedbackMode: 'github', feedbackUrl: COMMUNITY_LINKS.feedback || COMMUNITY_LINKS.app, lastSentAt: null, lastStatus: 'disabled' }; }
  save(next) { writeJson(this.file, next, { maxBytes: MAX_CONSENT_BYTES }); this.consent = next; }
  validateAcceptance(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['termsVersion', 'privacyVersion', 'accepted', 'diagnosticsEnabled'].includes(k))
      || value.accepted !== true || value.termsVersion !== TERMS_VERSION || value.privacyVersion !== PRIVACY_VERSION
      || (Object.hasOwn(value, 'diagnosticsEnabled') && value.diagnosticsEnabled !== false)) {
      throw new Error(`Review and accept the current FrostByte ${this.version} terms and privacy notice. Diagnostics cannot be enabled.`);
    }
  }
  accept(value) {
    this.validateAcceptance(value);
    if (Object.hasOwn(this.consent, 'acceptanceHistory') && !Array.isArray(this.consent.acceptanceHistory)) {
      throw new Error('The saved privacy acceptance history needs review before it can be updated. Existing data was kept.');
    }
    const history = Array.isArray(this.consent.acceptanceHistory) ? structuredClone(this.consent.acceptanceHistory) : [];
    if (!this.accepted && typeof this.consent.acceptedAt === 'string') {
      history.push(Object.fromEntries(['termsVersion', 'privacyVersion', 'acceptedAt', 'diagnosticsEnabled', 'diagnosticsVersion']
        .filter(key => Object.hasOwn(this.consent, key)).map(key => [key, this.consent[key]])));
    }
    // Retain earlier acceptance records and unrelated local fields. A failed
    // bounded write leaves the previous record intact instead of truncating it.
    this.save({ ...this.consent, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION,
      acceptedAt: this.accepted ? this.consent.acceptedAt : new Date(this.now()).toISOString(),
      diagnosticsEnabled: false, diagnosticsVersion: DIAGNOSTICS_VERSION,
      ...(history.length ? { acceptanceHistory: history } : {}) });
    this.clear();
    return this.status();
  }
  setEnabled({ enabled } = {}) {
    if (enabled !== false) throw new Error(this.reportingDisabled);
    return this.status();
  }
  clear() {
    this.counters = {}; this.pending = null; this.feedback = null;
    this.lastSentAt = null; this.lastStatus = 'disabled';
  }
  // Compatibility methods intentionally do not inspect values, sample the OS,
  // count events, create report IDs, schedule retries, or retain feedback text.
  record() {}
  error() {}
  async measure(_service, operation) { return await operation(); }
  diagnostics() { return null; }
  preview() { return { ...this.status(), report: null }; }
  async flush() { return this.status(); }
  prepareFeedback() { throw new Error(this.reportingDisabled); }
  feedbackForReview() { throw new Error(this.reportingDisabled); }
  async submitFeedback() { throw new Error(this.reportingDisabled); }
  discardFeedback() { this.feedback = null; }
}

// A stale internal caller must also fail closed. There is no transport or
// reporting endpoint in this module, even if a legacy opt-in is present.
export async function sendReport() { throw new Error('FrostByte does not collect or send diagnostic reports or in-app feedback. Open feedback on GitHub and choose what to share there.'); }
