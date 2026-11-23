import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrivacyService, sendReport } from '../src/main/privacy.js';
import { TERMS_VERSION, PRIVACY_VERSION, DIAGNOSTICS_VERSION, validateReport } from '../src/shared/reports.js';

const accept = () => ({ termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, accepted: true });
const legacy = () => ({ termsVersion: 'frostbyte-beta-2026-09-11-v2', privacyVersion: 'frostbyte-privacy-2026-09-11-v2',
  acceptedAt: '2026-09-12T10:00:00.000Z', diagnosticsEnabled: true, diagnosticsVersion: DIAGNOSTICS_VERSION });
function setup(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-privacy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sent = [];
  // Deliberately pass the old injectable transport: v1 must not use it.
  const options = { directory, version: '1.0.0', send: async report => sent.push(structuredClone(report)), ...extra };
  return { service: new PrivacyService(options), options, sent, directory };
}

test('fresh profiles require the v1 notices; acceptance is durable without any reporting choice', async t => {
  const { service, options, sent } = setup(t);
  assert.equal(service.accepted, false);
  assert.equal(service.status().diagnosticsEnabled, false);
  assert.equal(service.status().collectionEnabled, false);
  assert.equal(service.status().feedbackMode, 'github');
  assert.equal(service.status().lastStatus, 'disabled');
  service.record('app_start'); await service.flush();
  assert.equal(sent.length, 0);
  service.accept(accept());
  const reopened = new PrivacyService(options);
  assert.equal(reopened.accepted, true);
  assert.equal(reopened.enabled, false);
  assert.equal(reopened.consent.diagnosticsEnabled, false);
  reopened.record('hf_ok'); await reopened.flush();
  assert.equal(sent.length, 0);
  assert.equal(reopened.diagnostics(), null);
  assert.equal(reopened.preview().report, null);
});

test('current notices reject stale, malformed and diagnostics-enabled acceptance', t => {
  const { service } = setup(t);
  for (const value of [null, [], { ...accept(), accepted: false }, { ...accept(), termsVersion: 'old' },
    { ...accept(), privacyVersion: 'old' }, { ...accept(), diagnosticsEnabled: true },
    { ...accept(), diagnosticsEnabled: 'false' }, { ...accept(), unexpected: true }]) {
    assert.throws(() => service.accept(value), /current FrostByte [\d.]+ terms/);
    assert.equal(service.accepted, false);
  }
  service.accept({ ...accept(), diagnosticsEnabled: false });
  assert.equal(service.accepted, true);
});

test('upgrading a historical opt-in collects nothing and does not rewrite the profile before acceptance', async t => {
  const { options, sent, directory } = setup(t);
  const previous = { ...legacy(), localNote: 'retain this local field' };
  const file = path.join(directory, 'privacy.json');
  fs.writeFileSync(file, JSON.stringify(previous));
  const bytes = fs.readFileSync(file);
  const service = new PrivacyService(options);
  assert.equal(service.accepted, false);
  assert.equal(service.enabled, false);
  service.record('app_start');
  service.error(Object.assign(new Error('secret model path'), { code: 'ENOSPC' }));
  await service.flush();
  assert.equal(sent.length, 0);
  assert.deepEqual(service.counters, {});
  assert.deepEqual(fs.readFileSync(file), bytes);
  service.accept(accept());
  assert.deepEqual(service.consent.acceptanceHistory, [legacy()]);
  assert.equal(service.consent.localNote, previous.localNote);
  assert.equal(service.consent.diagnosticsEnabled, false);
  assert.equal(new PrivacyService(options).accepted, true);
});

test('even a current-version profile with a legacy opt-in cannot activate reporting', async t => {
  const { options, sent, directory } = setup(t);
  fs.writeFileSync(path.join(directory, 'privacy.json'), JSON.stringify({ ...legacy(), termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION }));
  const service = new PrivacyService(options);
  assert.equal(service.accepted, true);
  assert.equal(service.enabled, false);
  assert.throws(() => service.setEnabled({ enabled: true, consentVersion: DIAGNOSTICS_VERSION }), /does not collect or send/);
  assert.equal(service.setEnabled({ enabled: false }).diagnosticsEnabled, false);
  service.record('app_start'); await service.flush();
  assert.deepEqual(service.counters, {});
  assert.equal(sent.length, 0);
});

test('repeat acceptance does not change its timestamp or duplicate history', t => {
  let now = Date.parse('2026-10-12T12:00:00Z');
  const { service } = setup(t, { now: () => now });
  service.save(legacy());
  service.accept(accept());
  const acceptedAt = service.consent.acceptedAt;
  now += 60000;
  service.accept(accept());
  assert.equal(service.consent.acceptedAt, acceptedAt);
  assert.deepEqual(service.consent.acceptanceHistory, [legacy()]);
});

test('unrecognized acceptance history is preserved instead of overwritten', t => {
  const { service } = setup(t);
  service.save({ ...legacy(), acceptanceHistory: { mustKeep: true } });
  const before = fs.readFileSync(service.file);
  assert.throws(() => service.accept(accept()), /history needs review/);
  assert.deepEqual(fs.readFileSync(service.file), before);
});

test('corrupt privacy records fail closed and cannot damage download state', t => {
  const { directory, options } = setup(t);
  fs.writeFileSync(path.join(directory, 'state.json'), '{"downloads":["keep"]}');
  for (const text of ['{', 'null', '[]', 'false']) {
    fs.writeFileSync(path.join(directory, 'privacy.json'), text);
    assert.equal(new PrivacyService(options).accepted, false);
  }
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), '{"downloads":["keep"]}');
});

test('privacy consent ignores linked, hard-linked, and oversized files', { skip: process.platform === 'win32' }, t => {
  const { directory, options } = setup(t);
  const file = path.join(directory, 'privacy.json');
  const accepted = JSON.stringify({ ...legacy(), termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION });
  const outside = path.join(directory, 'outside.json');
  fs.writeFileSync(outside, accepted);
  fs.symlinkSync(outside, file);
  assert.equal(new PrivacyService(options).accepted, false);
  fs.unlinkSync(file); fs.linkSync(outside, file);
  assert.equal(new PrivacyService(options).accepted, false);
  fs.unlinkSync(file); fs.writeFileSync(file, ' '.repeat(65 * 1024));
  assert.equal(new PrivacyService(options).accepted, false);
});

test('failed persistence does not accept notices or activate reporting', t => {
  const { service } = setup(t);
  fs.mkdirSync(service.file);
  assert.throws(() => service.accept(accept()));
  assert.equal(service.accepted, false);
  assert.equal(service.enabled, false);
});

test('ordinary operations return their results and errors without recording or retaining them', async t => {
  const { service, sent } = setup(t);
  service.accept(accept());
  assert.equal(await service.measure('hf', async () => 'owner/private-model'), 'owner/private-model');
  const failure = Object.assign(new Error('/private/model hf_secret 10.0.0.13'), { code: 'ETIMEDOUT' });
  await assert.rejects(service.measure('spark', async () => { throw failure; }), error => error === failure);
  for (let i = 0; i < 12000; i++) service.record('app_start');
  service.error(failure);
  await service.flush();
  assert.deepEqual(service.counters, {});
  assert.equal(service.pending, null);
  assert.equal(service.lastSentAt, null);
  assert.equal(sent.length, 0);
  assert.doesNotMatch(JSON.stringify(service), /private-model|hf_secret|10\.0\.0/);
});

test('retired feedback APIs cannot retain drafts, generate attachments or send reports', async t => {
  const { service, sent } = setup(t);
  service.accept(accept());
  const draft = { category: 'bug', message: 'A private message', expected: '', attachDiagnostics: true };
  assert.throws(() => service.prepareFeedback(draft), /Open feedback on GitHub/);
  assert.throws(() => service.feedbackForReview('old-report'), /Open feedback on GitHub/);
  await assert.rejects(service.submitFeedback('old-report', draft), /Open feedback on GitHub/);
  assert.equal(service.feedback, null);
  service.discardFeedback();
  assert.equal(service.preview().report, null);
  assert.equal(sent.length, 0);
});

test('the retired direct transport cannot call fetch even with a valid legacy report', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must never run'); });
  const report = { kind: 'diagnostics', schemaVersion: 1, reportId: '1cc95df7-f3ec-4837-b6bb-3435e8b0fcb3',
    consentVersion: DIAGNOSTICS_VERSION, diagnostics: { app: { version: '1.0.0', platform: 'darwin', arch: 'arm64', osMajor: 25 }, counters: { app_start: 1 } } };
  assert.deepEqual(validateReport(report), report);
  await assert.rejects(sendReport(report), /does not collect or send/);
  assert.equal(requests, 0);
});

test('the reporting module and runtime contain no reporting endpoint, timer or environment collector', () => {
  const source = fs.readFileSync(new URL('../src/main/privacy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|frostbyte\/reports|setTimeout|setInterval|randomUUID|os\.release/);
  const runtime = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /diagnosticsTimer|privacy\.flush\s*\(|diagnosticsEnableReview/);
});

test('displayed legal document versions match the consent gate and describe the v1 collection boundary', () => {
  const legal = JSON.parse(fs.readFileSync(new URL('../src/shared/legal.json', import.meta.url), 'utf8'));
  assert.equal(legal.termsVersion, TERMS_VERSION);
  assert.equal(legal.privacyVersion, PRIVACY_VERSION);
  assert.match(legal.terms, /Friday 16 October 2026/);
  assert.match(legal.terms, /Blackfrost AI\/SI/);
  assert.match(legal.privacy, /No analytics, automatic diagnostic reports or in-app feedback collection/);
  assert.match(legal.privacy, /previously submitted|already submitted/);
  assert.match(legal.privacy, /ordinary network data/);
  assert.doesNotMatch(legal.terms, /Beta Terms|ad-hoc signed/);
});

test('legacy report schema continues rejecting extra fields and content identifiers', () => {
  const report = { kind: 'diagnostics', schemaVersion: 1, reportId: '1cc95df7-f3ec-4837-b6bb-3435e8b0fcb3',
    consentVersion: DIAGNOSTICS_VERSION, diagnostics: { app: { version: '1.0.0', platform: 'linux', arch: 'x64', osMajor: 6 }, counters: {} } };
  for (const mutate of [r => r.filename = 'secret', r => r.diagnostics.app.hostname = 'spark', r => r.diagnostics.counters.model = 1,
    r => r.diagnostics.counters.hf_ok = 'secret', r => r.diagnostics.counters.hf_ok = 10001, r => r.reportId = 'device-identity']) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => validateReport(changed));
  }
});
