import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedExternalUrl, classifyExternalUrl } from '../src/main/external-links.js';

test('external handoff permits only exact community links and canonical HuggingFace model pages', () => {
  assert.equal(approvedExternalUrl('https://huggingface.co/owner/model'), 'https://huggingface.co/owner/model');
  assert.deepEqual(classifyExternalUrl('https://huggingface.co/owner/model'), {
    url: 'https://huggingface.co/owner/model', requiresNativeReview: true,
  });
  assert.equal(approvedExternalUrl('https://github.com/Blackfrost-AI/FrostByte-App'), 'https://github.com/Blackfrost-AI/FrostByte-App');
  assert.equal(classifyExternalUrl('https://github.com/Blackfrost-AI/FrostByte-App').requiresNativeReview, false);
  for (const value of [
    'http://huggingface.co/owner/model',
    'https://huggingface.co.evil.example/owner/model',
    'https://user:secret@huggingface.co/owner/model',
    'https://huggingface.co/owner/model?local-path=%2FUsers%2Fperson',
    'https://huggingface.co/owner/model#private-state',
    'https://huggingface.co/owner/model/files',
    'https://huggingface.co/owner/%2e%2e',
    'https://huggingface.co/owner%2Fother/model',
    'file:///etc/passwd',
    'mailto:someone@example.com',
    'https://example.com',
  ]) assert.throws(() => approvedExternalUrl(value), /Only official/);
});

test('pre-acceptance external handoff is limited to the legal and community allowlist', () => {
  assert.equal(approvedExternalUrl('https://blackfrostai.com/frostbyte/terms', { accepted: false }), 'https://blackfrostai.com/frostbyte/terms');
  assert.throws(() => approvedExternalUrl('https://huggingface.co/owner/model', { accepted: false }), /before acceptance/);
});

test('frostbyte.si console handoffs are exact-match and post-acceptance only', () => {
  for (const path of ['/admin', '/dashboard', '/account', '/frostnet', '/pricing']) {
    const url = `https://frostbyte.si${path}`;
    assert.equal(approvedExternalUrl(url), url);
    assert.equal(classifyExternalUrl(url).requiresNativeReview, false);
    assert.throws(() => approvedExternalUrl(url, { accepted: false }), /before acceptance/);
  }
  for (const value of [
    'https://frostbyte.si/admin?next=/evil',
    'https://frostbyte.si/dashboard#fragment',
    'https://user:secret@frostbyte.si/account',
    'https://frostbyte.si:8443/frostnet',
    'http://frostbyte.si/pricing',
    'https://frostbyte.si.evil.example/admin',
    'https://frostbyte.si/admin/extra',
    'https://frostbyte.si/',
  ]) assert.throws(() => approvedExternalUrl(value), /Only official/);
});
