import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateChecker, compareVersions, validateRelease, downloadUrlForChannel, DOWNLOAD_URL, UPDATE_URL } from '../src/main/updates.js';
const release = version => ({ schemaVersion: 1, version, channel: 'beta', platforms: ['darwin-arm64', 'win32-x64', 'linux-x64'], notes: 'Release notes' });
test('beta versions compare numerically; stable is newer and installed builds never downgrade', () => {
  assert.equal(compareVersions('0.2.0-beta.10', '0.2.0-beta.9'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0-beta.99'), 1);
  assert.equal(compareVersions('0.2.0-beta.8', '0.2.0-beta.8'), 0);
  assert.throws(() => compareVersions('garbage', '0.2.0'));
  assert.throws(() => validateRelease({ ...release('0.2.0'), channel: 'untrusted' }));
});
test('checks are deduplicated, daily opt-in checks honor persisted timestamp, manual checks retry', async () => {
  let calls = 0, saved, clock = 2 * 86400000;
  const checker = new UpdateChecker({ version: '0.2.0-beta.8', platform: 'win32-x64', now: () => clock, save: value => { saved = value; },
    fetchImpl: async (url, options) => { calls++; assert.equal(url, UPDATE_URL); assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined); return new Response(JSON.stringify(release('0.2.0-beta.7'))); } });
  const [first, second] = await Promise.all([checker.check(), checker.check()]);
  assert.equal(calls, 1); assert.equal(first.status, 'ahead'); assert.equal(second.status, 'ahead');
  await checker.check({ automatic: true }); assert.equal(calls, 1);
  const reopened = new UpdateChecker({ version: '0.2.0-beta.8', platform: 'win32-x64', saved, now: () => clock, fetchImpl: () => { throw new Error('Must not fetch'); } });
  await reopened.check({ automatic: true }); assert.equal(reopened.snapshot().status, 'ahead');
  await checker.check(); assert.equal(calls, 2);
  clock += 86400000; await checker.check({ automatic: true }); assert.equal(calls, 3);
});
test('available, unsupported, and offline states remain passive', async () => {
  const checker = new UpdateChecker({ version: '0.2.0-beta.8', platform: 'darwin-arm64', fetchImpl: async () => new Response(JSON.stringify(release('0.2.0-beta.9'))) });
  assert.equal((await checker.check()).status, 'available');
  checker.platform = 'darwin-x64'; assert.equal((await checker.check()).status, 'unsupported');
  checker.fetchImpl = async () => { throw new Error('offline'); };
  assert.equal((await checker.check()).status, 'error'); assert.equal(checker.pending, null);
});

test('Linux x64 participates in update availability without enabling downloads', async () => {
  const checker = new UpdateChecker({ version: '0.2.0-beta.8', platform: 'linux-x64',
    fetchImpl: async () => new Response(JSON.stringify(release('0.2.0-beta.9'))) });
  assert.equal((await checker.check()).status, 'available');
  assert.throws(() => validateRelease({ ...release('0.2.0-beta.9'), platforms: ['linux-arm64'] }), /platforms/i);
});

test('a non-beta channel never queries or links to the public beta provider', async () => {
  let fetched = false, saved = false;
  const checker = new UpdateChecker({
    version: '0.4.0',
    channel: 'nightly',
    saved: { lastChecked: 100, latest: release('0.4.1') },
    now: () => 200,
    fetchImpl: async () => { fetched = true; throw new Error('The public provider must not be queried.'); },
    save: () => { saved = true; },
  });
  assert.deepEqual(checker.snapshot(), {
    status: 'private', lastChecked: 0, latest: null, error: '', current: '0.4.0', channel: 'nightly',
  });
  assert.equal((await checker.check()).status, 'private');
  assert.equal((await checker.check({ automatic: true })).status, 'private');
  assert.equal(fetched, false);
  assert.equal(saved, false);
  assert.equal(downloadUrlForChannel('nightly'), null);
  assert.equal(downloadUrlForChannel('beta'), DOWNLOAD_URL);
  assert.throws(() => downloadUrlForChannel('unknown'), /update channel/i);
});

test('hostile or obsolete cached update state cannot break startup or suppress checks', async () => {
  for (const saved of [null, [], 'invalid', { lastChecked: Infinity }, { lastChecked: -1 }, { lastChecked: 1001 }, { lastChecked: Number.MAX_SAFE_INTEGER }, { lastChecked: '9999999999999999', latest: { version: '<script>' } }]) {
    const checker = new UpdateChecker({ version: '0.2.0-beta.8', saved, now: () => 1000 });
    assert.equal(checker.snapshot().lastChecked, 0);
    assert.equal(checker.snapshot().latest, null);
  }
  let clock = 2000, calls = 0;
  const checker = new UpdateChecker({ version: '0.2.0-beta.8', saved: { lastChecked: clock }, now: () => clock,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(release('0.2.0-beta.9'))); } });
  clock = 1000; // A clock correction must not turn the cached value into an indefinite holdoff.
  await checker.check({ automatic: true });
  assert.equal(calls, 1);
});

test('a failed update-state write restores the prior UI state and remains retryable', async () => {
  const cached = { lastChecked: 100, latest: release('0.2.0-beta.8') };
  let now = 200, calls = 0, fail = true;
  const checker = new UpdateChecker({ version: '0.2.0-beta.8', platform: 'win32-x64', saved: cached, now: () => now,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(release('0.2.0-beta.9'))); },
    save: () => { if (fail) throw new Error('fixture update write failed'); },
  });
  const before = checker.snapshot(), published = [];
  checker.on('change', value => published.push(value));
  await assert.rejects(checker.check(), /update write failed/);
  assert.deepEqual(checker.snapshot(), before);
  assert.equal(published[0].status, 'checking');
  assert.deepEqual(published.at(-1), before);

  fail = false; now = 300;
  const result = await checker.check();
  assert.equal(calls, 2);
  assert.equal(result.status, 'available');
  assert.equal(result.lastChecked, 300);
});
