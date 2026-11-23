import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfirmationService } from '../src/main/confirmations.js';
import { authenticatedHfRequestReview, clipboardWriteReview, hfDownloadReview,
  hfTokenValidationReview, privacyAcceptanceReview, remoteHfDownloadReview,
  sensitiveSettingsReview, reviewLabel } from '../src/main/native-review.js';

const token = `sha256:${'a'.repeat(64)}`;
const model = { repoId: 'owner/model', revision: 'b'.repeat(40), root: '/Models',
  fileCount: 2, totalBytes: 3 * 1024 ** 3, manifestDigest: 'c'.repeat(64), tokenGeneration: 'none' };
function fixture(t, responses = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-confirmations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], changes = [];
  const create = () => new ConfirmationService({ directory, onChange: value => changes.push(value),
    showMessageBox: async (_window, options) => {
      calls.push(structuredClone(options));
      const result = responses.shift();
      if (!result) throw new Error('Unexpected dialog');
      return typeof result === 'function' ? result(options) : result;
    },
  });
  return { directory, calls, changes, responses, create, service: create() };
}
const yes = { response: 1, checkboxChecked: true }, no = { response: 0, checkboxChecked: true };

test('compact download shows useful size and destination, with exact values behind Details', async t => {
  const f = fixture(t, [{ response: 2, checkboxChecked: true }, { response: 2, checkboxChecked: true }, { response: 1, checkboxChecked: false }]);
  const review = hfDownloadReview(model);
  const result = await f.service.show(null, review);
  assert.equal(result.response, 1);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[0].detail, /2 files · 3 GB/);
  assert.match(f.calls[0].detail, /To: \/Models/);
  assert.ok(f.calls[0].detail.length < 300);
  assert.doesNotMatch(f.calls[0].detail, /SHA-256|Credential generation|Pinned revision/);
  assert.equal(f.calls[1].detail, review.detail);
  assert.ok(f.calls[1].detail.includes(model.manifestDigest));
  assert.equal(f.calls[1].buttons[2], 'Back');
  assert.equal(f.calls[1].checkboxChecked, true);
  assert.equal(f.calls[2].detail, f.calls[0].detail);
  for (const call of f.calls) { assert.equal(call.defaultId, 0); assert.equal(call.cancelId, 0); assert.equal(call.noLink, true); }
  assert.equal(f.service.snapshot().remembered, 0);
});

test('checking Never show again and cancelling does not grant anything', async t => {
  const f = fixture(t, [no, no]);
  await f.service.show(null, clipboardWriteReview('first'));
  await f.service.show(null, clipboardWriteReview('second'));
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.snapshot().remembered, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'confirmations.json')), false);
});

test('an explicit native choice survives restart, omits private values, and can be reset', async t => {
  const f = fixture(t, [yes, no]);
  await f.service.show(null, clipboardWriteReview('private-text'));
  const restarted = f.create();
  assert.equal((await restarted.show(null, clipboardWriteReview('different text'))).response, 1);
  assert.equal(f.calls.length, 1);
  const saved = fs.readFileSync(path.join(f.directory, 'confirmations.json'), 'utf8');
  assert.doesNotMatch(saved, /private-text|different text/);
  assert.equal(restarted.reset().remembered, 0);
  assert.equal((await f.create().show(null, clipboardWriteReview('third'))).response, 0);
  assert.equal(f.calls.length, 2);
});

test('local downloads remember only the selected folder and exact saved credential', async t => {
  const f = fixture(t, [yes, no, no]);
  await f.service.show(null, hfDownloadReview(model));
  assert.equal((await f.service.show(null, hfDownloadReview({ ...model, repoId: 'owner/another-model' }))).response, 1);
  assert.equal((await f.service.show(null, hfDownloadReview({ ...model, root: '/External' }))).response, 0);
  assert.equal((await f.service.show(null, hfDownloadReview({ ...model, tokenGeneration: token }))).response, 0);
  assert.equal(f.calls.length, 3);
});

test('remote permission cannot cross device identities, folders, or token delegation', async t => {
  const f = fixture(t, [yes, no, no, yes, yes]);
  const request = { ...model, device: 'Studio Spark', destination: '/Models', deviceBinding: 'd'.repeat(64), savedCredentialPresent: false, usesCredential: false };
  await f.service.show(null, remoteHfDownloadReview(request));
  assert.equal((await f.service.show(null, remoteHfDownloadReview(request))).response, 1);
  assert.equal((await f.service.show(null, remoteHfDownloadReview({ ...request, deviceBinding: 'e'.repeat(64) }))).response, 0);
  assert.equal((await f.service.show(null, remoteHfDownloadReview({ ...request, destination: '/External' }))).response, 0);
  const delegated = remoteHfDownloadReview({ ...request, savedCredentialPresent: true, usesCredential: true, tokenGeneration: token });
  await f.service.show(null, delegated);
  await f.service.show(null, delegated);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[3].checkboxLabel, undefined);
  assert.equal(f.calls[4].checkboxLabel, undefined);
});

test('changed account credentials ask again, even for the same repository', async t => {
  const f = fixture(t, [yes, no]);
  const request = { action: 'model', endpoint: 'https://huggingface.co/api/models/owner/model', repoId: 'owner/model', tokenGeneration: token };
  await f.service.show(null, authenticatedHfRequestReview(request));
  await f.service.show(null, authenticatedHfRequestReview({ ...request, action: 'refs', endpoint: 'https://huggingface.co/api/models/owner/model/refs' }));
  assert.equal((await f.service.show(null, authenticatedHfRequestReview({ ...request, tokenGeneration: `sha256:${'f'.repeat(64)}` }))).response, 0);
  assert.equal(f.calls.length, 2);
});

test('reset invalidates an open approval and cannot be undone by its stale checkbox', async t => {
  let finish;
  const f = fixture(t, [() => new Promise(resolve => { finish = resolve; }), no]);
  const pending = f.service.show(null, clipboardWriteReview('copy'));
  f.service.reset();
  finish(yes);
  assert.equal((await pending).response, 0);
  assert.equal(f.service.snapshot().remembered, 0);
  assert.equal((await f.service.show(null, clipboardWriteReview('copy'))).response, 0);
});

test('privacy, token validation, and system exposure never offer a remembered permission', async t => {
  const f = fixture(t, [yes, yes, yes, no, no, no]);
  const reviews = [sensitiveSettingsReview({ upnpEnabled: true }),
    hfTokenValidationReview({ endpoint: 'https://huggingface.co/api/whoami-v2', byteLength: 30, fingerprint: 'a'.repeat(64) }),
    privacyAcceptanceReview({ termsVersion: 'v1', privacyVersion: 'v1', diagnosticsVersion: 'v1', diagnosticsEnabled: false })];
  for (const review of reviews) await f.service.show(null, review);
  for (const review of reviews) assert.equal((await f.service.show(null, review)).response, 0);
  for (const call of f.calls) assert.equal(call.checkboxLabel, undefined);
  assert.equal(f.service.snapshot().remembered, 0);
});

test('malformed saved permissions fail closed and unknown permission kinds are rejected', async t => {
  const f = fixture(t, [no, no]);
  const file = path.join(f.directory, 'confirmations.json');
  fs.writeFileSync(file, JSON.stringify({ version: 99, grants: ['clipboard:' + 'a'.repeat(64)] }));
  assert.equal(f.create().snapshot().remembered, 0);
  fs.writeFileSync(file, '{broken');
  assert.equal((await f.create().show(null, clipboardWriteReview('copy'))).response, 0);
  assert.throws(() => f.service.show(null, { ...clipboardWriteReview('copy'), remember: { kind: 'all', scope: [], label: 'Skip everything' } }), /Invalid remembered/);
});

test('persistence failure cannot turn into an approved action or an in-memory grant', async t => {
  const f = fixture(t, [yes]);
  fs.mkdirSync(path.join(f.directory, 'confirmations.json'));
  await assert.rejects(f.service.show(null, clipboardWriteReview('copy')));
  assert.equal(f.service.snapshot().remembered, 0);
});

test('linked and oversized preference files cannot supply remembered permissions', async t => {
  const f = fixture(t, [yes]);
  await f.service.show(null, clipboardWriteReview('copy'));
  const file = path.join(f.directory, 'confirmations.json'), other = path.join(f.directory, 'other.json');
  fs.renameSync(file, other);
  fs.linkSync(other, file);
  assert.equal(f.create().snapshot().remembered, 0);
  fs.unlinkSync(file);
  if (process.platform !== 'win32') {
    fs.symlinkSync(other, file);
    assert.equal(f.create().snapshot().remembered, 0);
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, ' '.repeat(65 * 1024));
  assert.equal(f.create().snapshot().remembered, 0);
});

test('long or misleading display strings are bounded and escaped; details retain exact values', () => {
  const text = 'name\n\u202efile' + 'x'.repeat(1000);
  assert.ok(reviewLabel(text).length <= 160);
  assert.match(reviewLabel(text), /\\n\\u202e/);
  const review = clipboardWriteReview(text);
  assert.equal(review.detail, JSON.stringify(text));
  assert.ok(review.summary.length < 240);
});
