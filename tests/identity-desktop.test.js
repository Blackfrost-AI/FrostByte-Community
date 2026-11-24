/**
 * P1 identity plane — desktop side (ADR 003).
 * 1. hub-client account methods: routes, shapes, bearer, input guards.
 * 2. Drift guard: shared/identity-rules.js must behave identically to the
 *    backend platform/functions/src/identity.js (server is the authority).
 * 3. signChallenge: domain-separated bind-frame signing matches the server's SPKI verify.
 * 4. normalizeHubAccount carries handle/bio with strict shape checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto';

import { createHubClient } from '../src/main/hub-client.js';
import { HUB_API_BASE } from '../src/main/hub-security.js';
import { normalizeHubAccount } from '../src/main/hub-store.js';
import { signChallenge, bindChallengeMessage } from '../src/main/publisher.js';
import * as shared from '../src/shared/identity-rules.js';
import * as backend from '../platform/functions/src/identity.js';
import { CLIENT_WRITABLE_USER_FIELDS as BACKEND_WRITABLE } from '../platform/functions/src/store/contract.js';

function recordingFetcher({ status = 200, data = { ok: true } } = {}) {
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, opts });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => '' },
      text: async () => JSON.stringify(data),
    };
  };
  return { fetcher, calls };
}

const PUBKEY = 'ab'.repeat(32);
const SIG = 'cd'.repeat(64);

// ---- hub-client account methods ---------------------------------------------

test('updateMe PATCHes /v1/me with the session bearer', async () => {
  const { fetcher, calls } = recordingFetcher();
  const client = createHubClient({ token: 'tok-1', fetcher });
  await client.updateMe({ bio: 'hello', displayName: 'Crafter' });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, HUB_API_BASE + '/v1/me');
  assert.equal(calls[0].opts.method, 'PATCH');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok-1');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { bio: 'hello', displayName: 'Crafter' });
});

test('updateMe rejects non-object patches before any network call', () => {
  const { fetcher, calls } = recordingFetcher();
  const client = createHubClient({ fetcher });
  assert.throws(() => client.updateMe(null));
  assert.throws(() => client.updateMe([]));
  assert.throws(() => client.updateMe('bio'));
  assert.equal(calls.length, 0);
});

test('setHandle / releaseHandle hit POST and DELETE /v1/me/handle', async () => {
  const { fetcher, calls } = recordingFetcher();
  const client = createHubClient({ token: 't', fetcher });
  await client.setHandle('Frost_Crafter99');
  await client.releaseHandle();
  assert.equal(new URL(calls[0].url).pathname, '/hubApi/v1/me/handle');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { handle: 'Frost_Crafter99' });
  assert.equal(calls[1].opts.method, 'DELETE');
  assert.throws(() => client.setHandle('  '));
});

test('publisher challenge/bind/unbind routes and guards', async () => {
  const { fetcher, calls } = recordingFetcher({ data: { ok: true, challengeId: 'c1', nonce: 'ef'.repeat(32) } });
  const client = createHubClient({ token: 't', fetcher });
  await client.publisherChallenge(PUBKEY);
  assert.equal(new URL(calls[0].url).pathname, '/hubApi/v1/me/publisher-key/challenge');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { pubKey: PUBKEY });

  await client.bindPublisherKey({ pubKey: PUBKEY, challengeId: 'c1', signature: SIG });
  assert.equal(new URL(calls[1].url).pathname, '/hubApi/v1/me/publisher-key');
  assert.deepEqual(JSON.parse(calls[1].opts.body), { pubKey: PUBKEY, challengeId: 'c1', signature: SIG });

  await client.unbindPublisherKey(PUBKEY);
  assert.equal(new URL(calls[2].url).pathname, '/hubApi/v1/me/publisher-key/' + PUBKEY);
  assert.equal(calls[2].opts.method, 'DELETE');

  assert.throws(() => client.publisherChallenge('nope'));
  assert.throws(() => client.bindPublisherKey({ pubKey: PUBKEY, challengeId: '', signature: SIG }));
  assert.throws(() => client.bindPublisherKey({ pubKey: PUBKEY, challengeId: 'c1', signature: 'short' }));
  assert.throws(() => client.unbindPublisherKey('XYZ'));
});

test('publisherKeys GETs the session list; creatorByHandle validates shape', async () => {
  const { fetcher, calls } = recordingFetcher({ data: { ok: true, keys: [] } });
  const client = createHubClient({ token: 't', fetcher });
  await client.publisherKeys();
  assert.equal(new URL(calls[0].url).pathname, '/hubApi/v1/me/publisher-keys');
  assert.equal(calls[0].opts.method, 'GET');

  await client.creatorByHandle('crafter_prime');
  assert.equal(new URL(calls[1].url).pathname, '/hubApi/v1/creators/by-handle/crafter_prime');
  // Public read: no bearer attached even with a session token set? The client
  // attaches the session token by default; the server ignores it on public
  // routes. Assert only that malformed handles never leave the device.
  assert.throws(() => client.creatorByHandle('x'));
  assert.throws(() => client.creatorByHandle('bad-handle'));
});

// ---- Drift guard: shared rules == backend rules ------------------------------

test('shared identity-rules mirror the backend validators exactly', () => {
  const handles = ['ab', 'abc', 'a'.repeat(24), 'a'.repeat(25), 'Frost_Crafter99', 'frost_crafter99',
    '_lead', 'trail_', 'bad-handle', 'bad handle', 'admin', 'FrostByte', 'support', 'null', '',
    '  padded_ok  ', 42, null, undefined, 'héllo', 'ok_123'];
  for (const input of handles) {
    assert.deepEqual(shared.validateHandle(input), backend.validateHandle(input), `handle drift: ${String(input)}`);
  }
  const bios = ['', null, undefined, 'x'.repeat(280), 'x'.repeat(281), 'a\u0000b', 'line\nbreak\tok',
    '  trimmed  ', 7, 'emoji 🧊 ok', 'del\u007Fchar'];
  for (const input of bios) {
    assert.deepEqual(shared.validateBio(input), backend.validateBio(input), `bio drift: ${String(input)}`);
  }
  const keys = [PUBKEY, 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '', null, 42];
  for (const input of keys) {
    assert.deepEqual(shared.validatePubKey(input), backend.validatePubKey(input), `pubkey drift: ${String(input)}`);
  }
  const names = ['', null, 'Crafter', 'x'.repeat(64), 'x'.repeat(65), 'bad\u0007name', '  padded  ', 9];
  for (const input of names) {
    assert.deepEqual(shared.validateDisplayName(input), backend.validateDisplayName(input), `displayName drift: ${String(input)}`);
  }
  const photos = ['', null, 'https://example.com/a.png', 'http://example.com/a.png', 'not a url',
    'https://user:pass@example.com/a.png', 'x'.repeat(201), 5];
  for (const input of photos) {
    assert.deepEqual(shared.validatePhotoUrl(input), backend.validatePhotoUrl(input), `photoUrl drift: ${String(input)}`);
  }
  assert.deepEqual([...shared.RESERVED_HANDLES].sort(), [...backend.RESERVED_HANDLES].sort());
  assert.deepEqual([...shared.CLIENT_WRITABLE_USER_FIELDS].sort(), [...BACKEND_WRITABLE].sort());
  assert.equal(shared.HANDLE_MIN, 3);
  assert.equal(shared.HANDLE_MAX, 24);
  assert.equal(shared.BIO_MAX, 280);
});

// ---- signChallenge matches the server's verification -------------------------

test('signChallenge signs the domain-separated bind frame the SPKI verifier accepts', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubHex = spki.subarray(spki.length - 32).toString('hex');
  const unlocked = { pubKey: pubHex, privateKey, publicKey };
  const nonce = 'ef'.repeat(32);

  const message = bindChallengeMessage(pubHex, nonce);
  const sigHex = signChallenge(unlocked, message);
  assert.match(sigHex, /^[a-f0-9]{128}$/);

  // Server-side reconstruction (platform app.js): fixed SPKI prefix + raw key.
  const serverKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubHex, 'hex')]),
    format: 'der', type: 'spki',
  });
  const bindMessage = `frostbyte-bind/1\n${pubHex}\n${nonce}`;
  assert.ok(cryptoVerify(null, Buffer.from(bindMessage, 'utf8'), serverKey, Buffer.from(sigHex, 'hex')));
  // Tampered nonce must not verify.
  assert.ok(!cryptoVerify(null, Buffer.from(`frostbyte-bind/1\n${pubHex}\n${'00'.repeat(32)}`, 'utf8'), serverKey, Buffer.from(sigHex, 'hex')));
});

test('signChallenge refuses raw nonces and foreign-protocol payloads (report #2)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubHex = spki.subarray(spki.length - 32).toString('hex');
  const unlocked = { pubKey: pubHex, privateKey, publicKey };
  const nonce = 'ab'.repeat(32);
  // A hostile Hub can no longer get the identity key to sign anything but
  // the exact bind frame for THIS key.
  assert.throws(() => signChallenge(unlocked, nonce), /non-bind-domain/);
  assert.throws(() => signChallenge(unlocked, 'aeon-delegate/1\nsome-payload'), /non-bind-domain/);
  assert.throws(() => signChallenge(unlocked, `frostbyte-bind/1\n${'00'.repeat(32)}\n${nonce}`), /non-bind-domain/);
  assert.throws(() => signChallenge(unlocked, `frostbyte-bind/2\n${pubHex}\n${nonce}`), /non-bind-domain/);
  assert.throws(() => bindChallengeMessage(pubHex, 'not-hex'), /nonce/);
  assert.throws(() => bindChallengeMessage('nope', nonce), /pubkey/);
});

test('signChallenge refuses locked sessions and oversized messages', () => {
  assert.throws(() => signChallenge(null, 'nonce'), /Unlock/);
  assert.throws(() => signChallenge({}, 'nonce'), /Unlock/);
  const { privateKey } = generateKeyPairSync('ed25519');
  assert.throws(() => signChallenge({ privateKey }, ''), /challenge/i);
  assert.throws(() => signChallenge({ privateKey }, 'x'.repeat(513)), /challenge/i);
});

// ---- account normalization carries handle/bio --------------------------------

test('normalizeHubAccount keeps valid handle/bio and drops malformed ones', () => {
  const base = { uid: 'u1', email: 'a@b.c', displayName: 'A' };
  const good = normalizeHubAccount({ ...base, handle: 'Frost_Crafter99', bio: 'Making models sing.' });
  assert.equal(good.handle, 'Frost_Crafter99');
  assert.equal(good.bio, 'Making models sing.');

  const bad = normalizeHubAccount({ ...base, handle: 'x', bio: 42 });
  assert.equal(bad.handle, '');
  assert.equal(bad.bio, '');

  const long = normalizeHubAccount({ ...base, handle: 'a'.repeat(30), bio: 'b'.repeat(400) });
  assert.equal(long.handle, '');
  assert.equal(long.bio.length, 280);

  const empty = normalizeHubAccount({ signedIn: false });
  assert.equal(empty.handle, '');
  assert.equal(empty.bio, '');
});