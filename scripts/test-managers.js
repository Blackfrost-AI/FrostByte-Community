/**
 * Unit tests for the runtime managers (no Electron, no network).
 *
 * The scheduler's overnight-window logic and the queue's user-pause-vs-
 * auto-pause distinction are exactly the kind of thing that fails silently
 * in production at 18:00, so they get exercised here directly.
 *
 * Run: npm run test:managers
 */
import assert from 'node:assert';
import test from 'node:test';
import { RateManager, QueueManager, SeedGoalManager } from '../src/main/managers.js';

/* --------------------------------------------------------------- fixtures */

function fakeEngine(torrents) {
  const list = () => torrents;
  const calls = [];
  return {
    list,
    calls,
    autoQueued: [],
    userPaused: new Set(),
    setLimits: (limits) => { calls.push(['setLimits', limits]); return limits; },
    async pause(h) { calls.push(['pause', h]); const t = torrents.find((x) => x.infoHash === h); t.paused = true; },
    async pauseForQueue(h) { calls.push(['pauseForQueue', h]); const t = torrents.find((x) => x.infoHash === h); t.paused = true; t.queued = true; this.autoQueued.push(h); },
    async resume(h) { calls.push(['resume', h]); const t = torrents.find((x) => x.infoHash === h); t.paused = false; t.queued = false; this.autoQueued = this.autoQueued.filter((x) => x !== h); },
    async remove(h) { calls.push(['remove', h]); const i = torrents.findIndex((x) => x.infoHash === h); torrents.splice(i, 1); },
    forget(h) { calls.push(['forget', h]); },
  };
}

const T = (infoHash, over = {}) => ({
  infoHash, name: infoHash.slice(0, 8), done: false, paused: false, queued: false,
  ratio: 0, seededMs: 0, addedAt: 1, ...over,
});

/* ------------------------------------------------------------------ rates */

test('inWindow: same-day window', () => {
  const r = new RateManager(fakeEngine([]), () => ({ schedEnabled: true, schedFrom: '09:00', schedTo: '17:00', schedDays: [1,1,1,1,1,1,1] }));
  assert.equal(r.inWindow(new Date('2026-09-10T12:00:00'), '09:00', '17:00'), true);
  assert.equal(r.inWindow(new Date('2026-09-10T08:59:00'), '09:00', '17:00'), false);
  assert.equal(r.inWindow(new Date('2026-09-10T17:00:00'), '09:00', '17:00'), false, 'end is exclusive');
});

test('inWindow: overnight window wraps midnight', () => {
  const r = new RateManager(fakeEngine([]), () => ({}));
  assert.equal(r.inWindow(new Date('2026-09-10T23:30:00'), '22:00', '06:00'), true);
  assert.equal(r.inWindow(new Date('2026-09-10T03:00:00'), '22:00', '06:00'), true);
  assert.equal(r.inWindow(new Date('2026-09-10T12:00:00'), '22:00', '06:00'), false);
});

test('scheduler: overnight window before dawn belongs to the previous day', () => {
  // Wednesday 03:00 with a 22:00–06:00 window that runs Tue–Sat only
  // (Sunday and Monday off). Before dawn Wednesday must still be "on",
  // because it's the tail of Tuesday's window.
  const s = { schedEnabled: true, schedFrom: '22:00', schedTo: '06:00', schedDays: [0, 0, 1, 1, 1, 1, 1] };
  const r = new RateManager(fakeEngine([]), () => s);
  const wed3am = new Date('2026-09-09T03:00:00'); // 2026-09-09 is a Wednesday
  assert.equal(r.inAltMode(wed3am), true, 'tail of Tuesday window');

  // Sunday 03:00: previous day is Saturday (index 6). In schedDays [0,0,1,1,1,1,1],
  // Saturday (index 6) = 1, so still on.
  const sun3am = new Date('2026-09-13T03:00:00');
  assert.equal(r.inAltMode(sun3am), true, 'tail of Saturday window');

  // Monday 03:00: previous day is Sunday (index 0) = 0 → off.
  const mon3am = new Date('2026-09-14T03:00:00');
  assert.equal(r.inAltMode(mon3am), false, 'Sunday is disabled');
});

test('manual turtle overrides the schedule in both directions', () => {
  const s = { schedEnabled: false, schedFrom: '09:00', schedTo: '10:00', schedDays: [1,1,1,1,1,1,1] };
  const r = new RateManager(fakeEngine([]), () => s);
  assert.equal(r.inAltMode(new Date('2026-09-10T12:00:00')), false);
  s.bandwidthMode = 'alt';
  assert.equal(r.inAltMode(new Date('2026-09-10T12:00:00')), true);
});

test('apply: 0/unset KB/s means unlimited (-1), values convert to bytes', () => {
  const eng = fakeEngine([]);
  const r = new RateManager(eng, () => ({ downLimitKBs: 0, upLimitKBs: 512, altDownKBs: 0, altUpKBs: 0 }));
  r.apply();
  const [_, limits] = eng.calls.at(-1);
  assert.equal(limits.down, -1, '0 = unlimited');
  assert.equal(limits.up, 512 * 1024, '512 KB/s -> bytes');
});

test('apply: alt mode uses the alt numbers', () => {
  const eng = fakeEngine([]);
  const s = { downLimitKBs: 1000, upLimitKBs: 1000, altDownKBs: 300, altUpKBs: 30, schedEnabled: false, schedFrom: '00:00', schedTo: '00:00', schedDays: [1,1,1,1,1,1,1] };
  const r = new RateManager(eng, () => s);
  s.bandwidthMode = 'alt';
  const info = r.apply();
  assert.equal(info.alt, true);
  assert.equal(info.up, 30 * 1024);
});

/* ------------------------------------------------------------------ queue */

test('queue: over-limit downloads are queued newest-first, resumed FIFO', async () => {
  const eng = fakeEngine([T('a'), T('b'), T('c'), T('d')].map((t, i) => ({ ...t, addedAt: i + 1 })));
  const q = new QueueManager(eng, () => ({ maxActiveDownloads: 2 }));
  await q.enforce();
  const paused = eng.calls.filter((c) => c[0] === 'pauseForQueue').map((c) => c[1]);
  assert.deepEqual(paused, ['d', 'c'], 'newest two are parked');
  assert.equal(eng.list().filter((t) => !t.paused).length, 2);

  // Finish one active torrent; the oldest queued one resumes.
  const a = eng.list().find((t) => t.infoHash === 'a');
  const idx = eng.list().indexOf(a);
  a.done = true;
  await q.enforce();
  const resumed = eng.calls.filter((c) => c[0] === 'resume').map((c) => c[1]);
  assert.deepEqual(resumed, ['c'], 'oldest queued resumes into the free slot');
});

test('queue: user-paused torrents are never auto-resumed and do not count as active', async () => {
  const eng = fakeEngine([T('a'), T('b')]);
  eng.userPaused.add('a');
  const a = eng.list().find((t) => t.infoHash === 'a');
  a.paused = true; // user paused it directly
  const q = new QueueManager(eng, () => ({ maxActiveDownloads: 1 }));
  await q.enforce();
  assert.equal(eng.list().find((t) => t.infoHash === 'a').paused, true, 'user pause untouched');
  assert.equal(eng.list().find((t) => t.infoHash === 'b').paused, false, 'b is within the limit: a does not count as active');
});

test('queue: limit 0 (unlimited) releases everything queued', async () => {
  const eng = fakeEngine([T('a', { paused: true })]);
  eng.autoQueued.push('a');
  const q = new QueueManager(eng, () => ({ maxActiveDownloads: 0 }));
  await q.enforce();
  assert.equal(eng.list().find((t) => t.infoHash === 'a').paused, false);
});

/* ------------------------------------------------------------- seed goals */

test('seed goals: ratio goal stops pulled torrents but never library items', async () => {
  const eng = fakeEngine([
    T('pulled', { done: true, ratio: 3.2 }),
    T('library', { done: true, ratio: 9.9 }),
  ]);
  const g = new SeedGoalManager(eng, () => ({ seedRatioStop: 2, seedMinutesStop: 0 }), { isLibraryHash: (h) => h === 'library' });
  const stopped = await g.enforce();
  assert.deepEqual(stopped, ['pulled']);
  assert.equal(eng.list().length, 1, 'library torrent survives');
  assert.equal(eng.calls.some((c) => c[0] === 'remove' && c[1] === 'pulled'), true);
});

test('seed goals: time goal uses seededMs; 0 disables', async () => {
  const eng = fakeEngine([
    T('timed', { done: true, ratio: 0.1, seededMs: 61 * 60_000 }),
  ]);
  const g = new SeedGoalManager(eng, () => ({ seedRatioStop: 0, seedMinutesStop: 60 }));
  const stopped = await g.enforce();
  assert.deepEqual(stopped, ['timed']);

  const eng2 = fakeEngine([T('x', { done: true, ratio: 5, seededMs: 999_999_999 })]);
  const g2 = new SeedGoalManager(eng2, () => ({ seedRatioStop: 0, seedMinutesStop: 0 }));
  assert.deepEqual(await g2.enforce(), [], 'both goals off = never stop');
});

test('seed goals: paused torrents are left alone (nothing to stop)', async () => {
  const eng = fakeEngine([T('a', { done: true, ratio: 5, paused: true })]);
  const g = new SeedGoalManager(eng, () => ({ seedRatioStop: 2, seedMinutesStop: 0 }));
  assert.deepEqual(await g.enforce(), []);
});

test('normal mode remains unlimited through schedule edits and manager restart', () => {
  const s = { bandwidthMode: 'normal', schedEnabled: true, schedFrom: '00:00', schedTo: '00:00', schedDays: [1,1,1,1,1,1,1], downLimitKBs: 0, upLimitKBs: 0, altDownKBs: 300, altUpKBs: 30 };
  const engine = fakeEngine([]);
  assert.equal(new RateManager(engine, () => s).apply().up, -1);
  s.schedFrom = '01:00'; s.schedTo = '01:00';
  assert.deepEqual(new RateManager(engine, () => s).snapshot(), { mode: 'normal', alt: false, manualAlt: false, down: -1, up: -1 });
  s.bandwidthMode = 'schedule';
  assert.equal(new RateManager(engine, () => s).apply().up, 30 * 1024);
});

test('hundreds of explicit shares and completed seeds do not consume download slots or hit seed goals', async () => {
  const torrents = Array.from({ length: 300 }, (_, i) => T('seed-' + i, { done: i % 2 === 0, explicitShare: true, ratio: 100, seededMs: 999999999 }));
  torrents.push(T('download'));
  const engine = fakeEngine(torrents), settings = { maxActiveDownloads: 1, seedRatioStop: 1, seedMinutesStop: 1 };
  await new QueueManager(engine, () => settings).enforce();
  assert.deepEqual(await new SeedGoalManager(engine, () => settings).enforce(), []);
  assert.equal(engine.list().length, 301);
  assert.equal(engine.calls.length, 0);
});
