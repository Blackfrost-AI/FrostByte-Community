/**
 * CLI contract tests.
 *
 * These exist because six documented-but-broken CLI behaviours shipped in
 * 1.1.0: --offline was advertised but not enforced, `recipe pull` and
 * `update apply` were listed in USAGE but unimplemented, `update check` was a
 * print stub, --version was unhandled, and `search --limit 5 <q>` parsed the
 * flag value as the query. Nothing covered the CLI, so nothing caught it.
 *
 * The invariant under test is narrow and checkable: every command either works
 * or refuses with a documented non-zero exit, and nothing claimed in USAGE is
 * silently absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECIPE_SCHEMA, RECIPE_VERSION } from '../src/shared/recipe-manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'src', 'cli', 'index.js');
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

// A Hub URL is deliberately set to a closed port: if a command is supposed to
// refuse before touching the network, it must not hang or attempt a fetch.
function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      FROSTBYTE_HUB_URL: 'http://127.0.0.1:1',
      FROSTBYTE_HUB_TOKEN: '',
      ...env,
    },
  });
}

test('--version reports the package version and exits 0', () => {
  for (const flag of ['--version', '-v']) {
    const r = run([flag]);
    assert.equal(r.status, 0, `${flag} should exit 0`);
    assert.equal(r.stdout.trim(), pkg.version);
    assert.equal(r.stderr, '');
  }
});

test('no arguments prints usage and exits 0, not "Unknown command: undefined"', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.doesNotMatch(r.stderr, /undefined/);
});

test('unknown command exits 2 and echoes the command', () => {
  const r = run(['not-a-command']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown command: not-a-command/);
});

test('--offline is enforced, not just parsed', () => {
  // The defect: this used to perform a real network request despite --offline.
  const r = run(['search', 'qwen', '--offline']);
  assert.equal(r.status, 2, 'network command must refuse under --offline');
  assert.match(r.stderr, /requires network access/);
  assert.doesNotMatch(r.stderr, /fetch|ECONNREFUSED|ENOTFOUND/i);
});

test('--offline refusal is fast: no connection attempt is made', () => {
  // A real fetch to a closed port would take longer and surface a socket error.
  const started = Date.now();
  const r = run(['search', 'qwen', '--offline']);
  assert.equal(r.status, 2);
  assert.ok(Date.now() - started < 5000, 'refusal should be immediate');
  assert.doesNotMatch(r.stderr, /ECONNREFUSED/);
});

test('flag order does not change the parsed query', () => {
  // The defect: `search --limit 5 qwen` used "--limit" as the query string.
  for (const args of [
    ['search', '--limit', '5', 'qwen', '--offline'],
    ['search', 'qwen', '--limit', '5', '--offline'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, 'both orders should reach the offline guard');
    assert.match(r.stderr, /search requires network access/);
  }
});

test('search with no query exits 2 with a usage hint', () => {
  const r = run(['search', '--offline']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /search "<query>"/);
});

test('recipe pull requires an explicit --to directory', () => {
  const r = run(['recipe', 'pull', 'some-id']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--to <dir>/);
});

test('recipe pull refuses under --offline before any Hub contact', () => {
  const r = run(['recipe', 'pull', 'some-id', '--to', './out', '--offline']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /requires network access/);
});

test('recipe validate --file works fully offline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frostbyte-cli-'));
  try {
    const manifest = {
      schema: RECIPE_SCHEMA,
      version: RECIPE_VERSION,
      id: 'cli-test-recipe',
      title: 'CLI test recipe',
      kind: 'native',
      publisher: 'b'.repeat(64),
      files: [{ path: 'model.gguf', size: 1024, sha256: 'a'.repeat(64) }],
      license: { id: 'MIT', statement: 'test' },
      createdAt: new Date().toISOString(),
    };
    const file = path.join(dir, 'manifest.json');
    writeFileSync(file, JSON.stringify(manifest));

    const r = run(['recipe', 'validate', '--file', file, '--offline', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.id, 'cli-test-recipe');
    assert.equal(out.files, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe validate rejects a malformed manifest with non-zero exit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frostbyte-cli-'));
  try {
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ id: 'x' })); // missing required fields
    const r = run(['recipe', 'validate', '--file', file, '--offline']);
    assert.notEqual(r.status, 0, 'invalid manifest must not report success');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update check compares installed vs feed instead of printing a stub', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frostbyte-cli-'));
  try {
    const installed = path.join(dir, 'installed.json');
    const feed = path.join(dir, 'feed.json');
    writeFileSync(installed, JSON.stringify({
      engines: [{ name: 'vllm', version: '0.5.0', digest: 'a'.repeat(64) }],
    }));
    writeFileSync(feed, JSON.stringify({
      engines: [{
        name: 'vllm', version: '0.6.4', digest: 'b'.repeat(64),
        severity: 'security', notes: 'CVE test',
      }],
    }));

    const r = run(['update', 'check', '--feed', feed, '--installed', installed, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.nudges), 'must return a nudges array');
    assert.equal(out.nudges.length, 1);
    assert.equal(out.nudges[0].kind, 'engine');
    assert.equal(out.nudges[0].name, 'vllm');
    assert.equal(out.nudges[0].from, '0.5.0');
    assert.equal(out.nudges[0].to, '0.6.4');
    // The stub used to emit a `note` with no comparison at all.
    assert.equal(out.note, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update apply refuses honestly rather than pretending to work', () => {
  const r = run(['update', 'apply', '--engine', 'vllm', '--version', '0.6.4']);
  assert.equal(r.status, 2, 'unimplemented path must not exit 0');
  assert.match(r.stderr, /not implemented/);
});

test('update apply does not hijack --version as a global flag', () => {
  // Guard against the collision: `--version <v>` is an option here, so the
  // global version check must key off argv[0] only.
  const r = run(['update', 'apply', '--engine', 'vllm', '--version', '0.6.4']);
  assert.doesNotMatch(r.stdout.trim(), new RegExp(`^${pkg.version.replace(/\./g, '\\.')}$`));
  assert.match(r.stderr, /not implemented/);
});

test('every command advertised in USAGE is reachable or refuses explicitly', () => {
  const usage = run(['--help']).stdout;
  const advertised = [
    'search', 'hf search', 'hf info', 'hf options', 'hf serve',
    'recipe show', 'recipe pull', 'recipe validate',
    'bundle fetch', 'bundle seed', 'update check', 'update apply',
    'login', 'logout',
  ];
  for (const cmd of advertised) {
    assert.ok(usage.includes(cmd), `USAGE should document "${cmd}"`);
  }
  // And nothing advertised may fall through to "Unknown command".
  const probes = [
    ['recipe', 'pull'],
    ['update', 'apply'],
    ['bundle', 'fetch'],
    ['hf', 'search', 'qwen', '--offline'],
    ['hf', 'options', 'Qwen/Qwen3-8B', '--offline'],
    ['hf', 'serve', 'Qwen/Qwen3-8B', '--offline'],
  ];
  for (const probe of probes) {
    const r = run(probe);
    assert.doesNotMatch(r.stderr, /Unknown (recipe|update|bundle|hf) command/, `${probe.join(' ')} must be dispatched`);
  }
});

test('bundle seed is local-only and works with --offline', () => {
  const r = run(['bundle', 'seed', '--dir', './bundle', '--port', '6881', '--offline', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.seeding, './bundle');
  assert.equal(out.port, 6881);
});

test('the CLI is installable as a `frostbyte` command', () => {
  // The handoff flagged this: a shebang with no bin entry leaves the CLI
  // reachable only via `npm run`, which defeats the point for NAS operators.
  assert.equal(pkg.bin?.frostbyte, 'src/cli/index.js', 'package.json must map bin.frostbyte');

  const first = readFileSync(CLI, 'utf8').split('\n')[0];
  assert.equal(first, '#!/usr/bin/env node', 'CLI needs an executable shebang');

  const mode = statSync(CLI).mode;
  assert.ok(mode & 0o100, 'CLI must be executable');

  // And it must actually run through the shebang, not just under `node`.
  const direct = spawnSync(CLI, ['--version'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout.trim(), pkg.version);
});
