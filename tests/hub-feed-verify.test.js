import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyUpdateFeed, manifestDigest } from '../src/main/hub-crypto.js';
import { generateKeypair, signFeedBody } from '../hub/src/crypto.js';
import { normalizeUpdateFeed, compareAgainstFeed } from '../src/main/hub-update-feed.js';

const key = generateKeypair();
const body = {
  version: 3,
  engines: [{ name: 'llama.cpp', version: 'b6000', digest: 'b'.repeat(64), severity: 'security' }],
  recipes: [{ id: 'ctf/llama-3.1-8b', digest: 'c'.repeat(64) }],
  configs: [],
  containers: [{ name: 'frostbyte/engine', tag: '2026.11', digest: 'd'.repeat(64) }],
};
const signed = { ...body, signature: signFeedBody(body, key.privateKeyHex), feedPubKey: key.publicKeyHex };

test('a valid hub feed signature verifies', () => {
  assert.equal(verifyUpdateFeed(signed), true);
});

test('a tampered feed body fails verification', () => {
  assert.equal(verifyUpdateFeed({ ...signed, version: 999 }), false);
  assert.equal(verifyUpdateFeed({ ...signed, engines: [] }), false);
});

test('a feed signed by a different key fails verification', () => {
  const other = generateKeypair();
  assert.equal(verifyUpdateFeed({ ...signed, feedPubKey: other.publicKeyHex }), false);
});

test('an unsigned or malformed envelope fails verification', () => {
  assert.equal(verifyUpdateFeed(body), false);
  assert.equal(verifyUpdateFeed(null), false);
  assert.equal(verifyUpdateFeed([]), false);
  assert.equal(verifyUpdateFeed({ ...signed, signature: 'not-base64!' }), false);
  assert.equal(verifyUpdateFeed({ ...signed, feedPubKey: 'zz' }), false);
});

test('a /v1/changes page is not mistaken for a clean update feed', () => {
  // The old bug: changes payload normalized to an empty-but-truthy feed → false all-clear.
  assert.equal(normalizeUpdateFeed({ changes: [], nextCursor: 'x' }), null);
  assert.equal(normalizeUpdateFeed({ version: 1 }), null);
  assert.throws(() => compareAgainstFeed({ installed: {}, feed: { changes: [] } }), /invalid update feed/);
});

test('container digest changes produce a nudge', () => {
  const feed = normalizeUpdateFeed(body);
  const result = compareAgainstFeed({
    installed: { containers: [{ name: 'frostbyte/engine', digest: 'e'.repeat(64) }] },
    feed,
  });
  const container = result.nudges.find(n => n.kind === 'container');
  assert.ok(container, 'expected a container nudge');
  assert.equal(container.name, 'frostbyte/engine');
  assert.equal(container.digest, 'd'.repeat(64));
});

test('an unchanged container digest produces no nudge', () => {
  const feed = normalizeUpdateFeed(body);
  const result = compareAgainstFeed({
    installed: { containers: [{ name: 'frostbyte/engine', digest: 'd'.repeat(64) }] },
    feed,
  });
  assert.equal(result.nudges.filter(n => n.kind === 'container').length, 0);
});

test('container digests are validated, not blindly trusted', () => {
  const feed = normalizeUpdateFeed({ version: 1, containers: [{ name: 'x', digest: 'not-a-digest' }] });
  assert.equal(feed.containers[0].digest, '');
});

test('manifestDigest is deterministic and order-independent', () => {
  assert.equal(manifestDigest({ a: 1, b: 2 }), manifestDigest({ b: 2, a: 1 }));
  assert.match(manifestDigest({ a: 1 }), /^[a-f0-9]{64}$/);
});