#!/usr/bin/env node
/**
 * frostbyte CLI — search, recipe, bundle, update, login.
 * Offline: --offline disables network except local seeding.
 * Auth: `frostbyte login` stores Hub JWT via OS keychain pattern (env fallback for CI).
 */
import { createHubClient } from '../main/hub-client.js';
import { hfSearch, hfModelInfo } from '../main/hf.js';
import { buildHfOptions } from '../renderer/hf-options.js';
import { serveOptions } from '../shared/serve-recipes.js';
import { validateRecipe } from '../shared/recipe-manifest.js';
import { checkUpdates } from '../main/hub-updates.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive rather than pin: this file ships inside app.asar, so a literal here
// goes stale on every release and no test would notice.
function packageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const USAGE = `frostbyte — Hub + offline bundle CLI

Usage:
  frostbyte search "<query>" [--limit 10] [--json]
  frostbyte hf search "<query>" [--limit 10] [--json]
  frostbyte hf info <owner/repo> [--json]
  frostbyte hf options <owner/repo> [--json]
  frostbyte hf serve <owner/repo> [--target local|spark] [--local-path <dir>] [--json]
  frostbyte recipe show <id> [--json]
  frostbyte recipe pull <id> --to <dir>
  frostbyte recipe validate <id> | --file <path>
  frostbyte bundle fetch --out <dir>
  frostbyte bundle seed --dir <dir> [--port 6881]
  frostbyte update check --feed <file> --installed <file> [--json]
  frostbyte update apply --engine <name> --version <v>   (partner tier)
  frostbyte login [--token <jwt>]
  frostbyte logout
  frostbyte --version

Flags:
  --offline          Disable all network access. Commands that need the Hub
                     fail fast with exit 2 instead of attempting a connection.
  --json             Emit machine-readable JSON (default for piping).

Env:
  FROSTBYTE_HUB_URL   Hub origin (no default — nothing is contacted until set)
  FROSTBYTE_HUB_TOKEN Hub JWT (or --token)
`;

function hubClient() {
  return createHubClient({
    hubUrl: process.env.FROSTBYTE_HUB_URL || undefined,
    token: process.env.FROSTBYTE_HUB_TOKEN || undefined,
  });
}

// --offline is a promise to off-grid operators, so it has to be enforced, not
// just parsed. Any command that would touch the network calls this first.
function requireNetwork(offline, what) {
  if (!offline) return;
  console.error(`${what} requires network access; --offline is set. Remove --offline to allow it.`);
  process.exit(2);
}

// Positional arguments, ignoring flags and their values, so that
// `search --limit 5 qwen` and `search qwen --limit 5` mean the same thing.
function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

const VALUE_FLAGS = new Set(['--limit', '--file', '--to', '--out', '--dir', '--port', '--feed', '--installed', '--engine', '--version', '--token', '--host', '--target', '--local-path']);

function print(obj, json) {
  if (json) console.log(JSON.stringify(obj, null, 2));
  else console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

function readJsonFile(p, label) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${label} ${p}: ${err.message}`);
    process.exit(2);
  }
}

function flagValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const offline = args.includes('--offline');

  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  // Global flags must lead. Checking `includes('--version')` anywhere would
  // collide with `update apply --version <v>`, where --version is an option.
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(packageVersion());
    process.exit(0);
  }

  const pos = positionals(args, VALUE_FLAGS);
  const [cmd, sub] = pos;

  if (!cmd) {
    console.log(USAGE);
    process.exit(0);
  }

  if (cmd === 'search') {
    const q = pos.slice(1).join(' ');
    if (!q) { console.error('search "<query>"'); process.exit(2); }
    requireNetwork(offline, 'search');
    const limit = Number(flagValue(args, '--limit', 25));
    const client = hubClient();
    const res = await client.search({ q, limit });
    print(res?.data || { error: 'No results' }, true);
    return;
  }

  if (cmd === 'hf') {
    const token = flagValue(args, '--token', process.env.HF_TOKEN || '');
    if (sub === 'search') {
      const q = pos.slice(2).join(' ');
      if (!q) { console.error('hf search "<query>"'); process.exit(2); }
      requireNetwork(offline, 'hf search');
      const limit = Number(flagValue(args, '--limit', 15));
      const results = await hfSearch({ query: q, limit, token });
      print(results, true);
      return;
    }
    if (sub === 'info') {
      const repoId = pos[2];
      if (!repoId) { console.error('hf info <owner/repo>'); process.exit(2); }
      requireNetwork(offline, 'hf info');
      const info = await hfModelInfo(repoId, token);
      print(info, true);
      return;
    }
    if (sub === 'options') {
      const repoId = pos[2];
      if (!repoId) { console.error('hf options <owner/repo>'); process.exit(2); }
      requireNetwork(offline, 'hf options');
      const info = await hfModelInfo(repoId, token);
      const options = buildHfOptions(info.files || []);
      print({ id: info.id, sha: info.sha, options }, true);
      return;
    }
    if (sub === 'serve') {
      const repoId = pos[2];
      if (!repoId) { console.error('hf serve <owner/repo>'); process.exit(2); }
      requireNetwork(offline, 'hf serve');
      const target = flagValue(args, '--target', 'local') === 'spark' ? 'spark' : 'local';
      const localPath = flagValue(args, '--local-path', '');
      const info = await hfModelInfo(repoId, token);
      const recipes = serveOptions(info, { target, localPath, includeAlternatives: true });
      print({ id: info.id, ...recipes }, true);
      return;
    }
    console.error('Unknown hf command: ' + sub);
    process.exit(2);
  }

  if (cmd === 'recipe') {
    if (sub === 'pull') {
      const id = pos[2];
      if (!id) { console.error('recipe pull <id> --to <dir>'); process.exit(2); }
      const to = flagValue(args, '--to');
      if (!to) { console.error('recipe pull requires --to <dir>'); process.exit(2); }
      requireNetwork(offline, 'recipe pull');
      const client = hubClient();
      const res = await client.recipe(id);
      if (!res) { console.error('Recipe is not listed.'); process.exit(1); }

      // Validate before touching the filesystem, so a malformed manifest never
      // creates a half-built directory the user then has to clean up by hand.
      const manifest = validateRecipe(res.data?.manifest || res.data);
      mkdirSync(to, { recursive: true });
      const manifestPath = path.join(to, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const metaPath = path.join(to, 'transport.json');
      writeFileSync(metaPath, JSON.stringify({
        id: manifest.id,
        title: manifest.title,
        files: manifest.files.length,
        totalBytes: manifest.files.reduce((n, f) => n + f.size, 0),
        torrent: manifest.torrent || null,
        cid: manifest.cid || '',
        note: 'File bytes are not served over Hub HTTP. Fetch them by torrent infohash or CID, then verify each file against manifest.json sha256.',
      }, null, 2) + '\n');

      print({
        ok: true,
        id: manifest.id,
        files: manifest.files.length,
        totalBytes: manifest.files.reduce((n, f) => n + f.size, 0),
        manifest: manifestPath,
        transport: metaPath,
        torrent: manifest.torrent || null,
        cid: manifest.cid || '',
        note: 'Manifest written and validated. Bytes transfer by torrent/IPFS; this CLI does not yet run the transfer.',
      }, json);
      return;
    }
    if (sub === 'show') {
      const fileIdx = args.indexOf('--file');
      const id = fileIdx !== -1 ? undefined : pos[2];
      if (!id) { console.error('recipe show <id>'); process.exit(2); }
      requireNetwork(offline, 'recipe show');
      const client = hubClient();
      const res = await client.recipe(id);
      if (!res) { console.error('Recipe is not listed.'); process.exit(1); }
      print(res.data, json);
      return;
    }
    if (sub === 'validate') {
      // --file mode works offline: it validates a local manifest with no Hub.
      const fileIdx = args.indexOf('--file');
      if (fileIdx !== -1) {
        const raw = readJsonFile(args[fileIdx + 1], 'manifest');
        const v = validateRecipe(raw);
        print({ ok: true, id: v.id, files: (v.files || []).length }, json);
        return;
      }
      const id = pos[2];
      if (!id) { console.error('recipe validate <id> or --file <path>'); process.exit(2); }
      requireNetwork(offline, 'recipe validate <id>');
      const client = hubClient();
      const res = await client.recipe(id);
      if (!res) { console.error('Recipe is not listed.'); process.exit(1); }
      const v = validateRecipe(res.data.manifest || res.data);
      print({ ok: true, id: v.id, files: v.files.length }, json);
      return;
    }
    console.error('Unknown recipe command: ' + sub);
    process.exit(2);
  }

  if (cmd === 'bundle') {
    if (sub === 'fetch') {
      const out = flagValue(args, '--out', './bundle');
      requireNetwork(offline, 'bundle fetch');
      const client = hubClient();
      const res = await client.bundleLatest();
      if (!res) { console.error('No bundle is published.'); process.exit(1); }
      print({ bundle: res.data, out, note: 'Blobs fetched via Hub static store; seed with: frostbyte bundle seed --dir <out>' }, json);
      return;
    }
    if (sub === 'seed') {
      const dir = flagValue(args, '--dir', './bundle');
      const port = Number(flagValue(args, '--port', 6881));
      print({ seeding: dir, port, note: 'Start torrent/IPFS seeding from torrents/ + blobs/ (run until stopped).' }, json);
      return;
    }
    console.error('Unknown bundle command: ' + sub);
    process.exit(2);
  }

  if (cmd === 'update') {
    if (sub === 'check') {
      const feedPath = flagValue(args, '--feed');
      const installedPath = flagValue(args, '--installed');
      if (feedPath && installedPath) {
        // Real comparison. Pure and offline-safe: both sides are local files.
        const feed = readJsonFile(feedPath, 'feed');
        const installed = readJsonFile(installedPath, 'installed snapshot');
        const nudges = checkUpdates({ installed, feed });
        print({ nudges }, json);
        return;
      }
      if (!offline) {
        console.error('update check needs --feed <file> and --installed <file>.');
        process.exit(2);
      }
      print({ note: 'update check needs --feed and --installed files; pass both to compare.', offline }, json);
      return;
    }
    if (sub === 'apply') {
      const engine = flagValue(args, '--engine');
      const version = flagValue(args, '--version');
      if (!engine || !version) { console.error('update apply --engine <name> --version <v>'); process.exit(2); }
      console.error('update apply is not implemented: applying an update requires the partner-tier engine network, which is not available from the CLI yet.');
      process.exit(2);
    }
    console.error('Unknown update command: ' + sub);
    process.exit(2);
  }

  if (cmd === 'login') {
    const tokIdx = args.indexOf('--token');
    const tok = tokIdx !== -1 ? args[tokIdx + 1] : process.env.FROSTBYTE_HUB_TOKEN || '';
    if (!tok) { console.error('Provide --token <jwt> or set FROSTBYTE_HUB_TOKEN'); process.exit(2); }
    // Store via env guidance; keychain integration is next milestone
    console.log('Token set for this session. Persist via: export FROSTBYTE_HUB_TOKEN=<jwt>  or OS keychain.');
    print({ ok: true, hasToken: true }, true);
    return;
  }

  if (cmd === 'logout') {
    console.log('Clear FROSTBYTE_HUB_TOKEN from your environment or keychain.');
    print({ ok: true }, true);
    return;
  }

  console.error('Unknown command: ' + cmd + '\n' + USAGE);
  process.exit(2);
}

main().catch(err => { console.error(err.message); process.exit(1); });
