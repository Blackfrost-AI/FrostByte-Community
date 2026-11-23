// Durable release-tracking guard. Fails when the shipped version, the release notes, the tags or the
// documented history drift apart, so a version bump cannot land without its notes, and a tag cannot
// land without a released version behind it. This is the check that was missing while 1.1.0 and 1.1.1
// were cut untagged and 1.1.1 shipped with no notes entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const notes = read('docs/RELEASE-NOTES.md');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Semver precedence (major.minor.patch, then prerelease). Returns >0 when a is newer than b. */
function compareSemver(a, b) {
  const split = version => {
    const [core, pre = ''] = version.split('-');
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const [x, y] = [split(a), split(b)];
  for (let i = 0; i < 3; i += 1) { if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]; }
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0); // release outranks prerelease
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const [p, q] = [x.pre[i], y.pre[i]];
    const [np, nq] = [Number(p), Number(q)];
    if (!Number.isNaN(np) && !Number.isNaN(nq)) { if (np !== nq) return np - nq; continue; }
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
const tags = () => (git('tag', '--list', 'v*') || '').split('\n').filter(Boolean);
const hasGit = git('rev-parse', '--git-dir') !== null;

test('package.json and package-lock.json agree on one semver', () => {
  assert.match(pkg.version, SEMVER, `package.json version ${pkg.version} is not semver`);
  assert.equal(lock.version, pkg.version, 'lockfile version drifted from package.json');
  assert.equal(lock.packages?.['']?.version, pkg.version, 'lockfile root package version drifted from package.json');
});

test('the newest release notes section is the version being shipped', () => {
  const headings = [...notes.matchAll(/^# (.+)$/gm)].map(match => match[1]);
  assert.ok(headings.length > 0, 'release notes have no sections');
  const newest = headings[0].match(/^FrostByte (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) — /);
  assert.ok(newest, `newest release-notes heading is not a versioned FrostByte release: ${headings[0]}`);
  assert.equal(newest[1], pkg.version, `release notes lead with ${newest[1]} but package.json ships ${pkg.version}`);
});

test('release notes never go backwards and never repeat a version', () => {
  const seen = [...notes.matchAll(/^# FrostByte (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) — /gm)].map(match => match[1]);
  assert.equal(new Set(seen).size, seen.length, `duplicate release-notes version: ${seen.join(', ')}`);
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(compareSemver(seen[i - 1], seen[i]) > 0, `release notes out of order: ${seen[i - 1]} precedes ${seen[i]}`);
  }
});

test('every release tag names a version this history shipped', () => {
  if (!hasGit) return; // exported tarball with no git metadata
  for (const tag of tags()) {
    assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `malformed tag ${tag}`);
    const atTag = git('show', `${tag}:package.json`);
    if (atTag === null) continue; // tag predates package.json in the tree
    assert.equal(JSON.parse(atTag).version, tag.slice(1), `${tag} points at a commit whose package.json says ${JSON.parse(atTag).version}`);
  }
});

test('the shipped version is tagged, or the working tree has unreleased commits on top of the last tag', () => {
  if (!hasGit) return;
  const all = tags();
  if (!all.length) return;
  const sorted = all.map(tag => tag.slice(1)).sort((x, y) => {
    const [a, b] = [x.split('-')[0].split('.').map(Number), y.split('-')[0].split('.').map(Number)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  const newestTag = `v${sorted.at(-1)}`;
  if (all.includes(`v${pkg.version}`)) return; // version is tagged; nothing to prove
  // Untagged version: it must be genuinely ahead of the last tag, not a silent re-bump of released work.
  const head = git('rev-parse', 'HEAD');
  const tagCommit = git('rev-list', '-n', '1', newestTag);
  assert.ok(head && tagCommit, 'could not resolve HEAD and the newest tag');
  const ahead = git('rev-list', '--count', `${newestTag}..HEAD`);
  assert.ok(Number(ahead) > 0, `package.json ships ${pkg.version} but the newest tag ${newestTag} is HEAD and no v${pkg.version} tag exists`);
});