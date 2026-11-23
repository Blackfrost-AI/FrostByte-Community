#!/usr/bin/env node
/**
 * frostbyte-mcp — stdio MCP server. Tools: hub_search, recipe_get, recipe_validate, model_resolve, transfer_start, update_check, bundle_info.
 * No auto-transfer: transfer_start returns an intent for user confirmation (mirrors src/main/transfers).
 */
import { createHubClient } from '../main/hub-client.js';
import { hfSearch, hfModelInfo } from '../main/hf.js';
import { buildHfOptions } from '../renderer/hf-options.js';
import { serveOptions } from '../shared/serve-recipes.js';
import { validateRecipe } from '../shared/recipe-manifest.js';
import { checkUpdates } from '../main/hub-updates.js';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Derive the version rather than pinning it: this package ships inside app.asar
// where ../../package.json resolves to the packaged manifest, and in the dev
// tree to the repo manifest. A literal here silently goes stale on every bump.
function packageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}
const SERVER_VERSION = packageVersion();

const tools = [
  { name: 'hub_search', description: 'Search Hub for models/recipes (exact, quant-preserving).', inputSchema: { type: 'object', properties: { q: { type: 'string' }, kind: { type: 'string' }, quant: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
  { name: 'hf_search', description: 'Search Hugging Face models with full file tree and grouped checkpoint options.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'hf_model_options', description: 'Inspect a Hugging Face repository and return auto-bundled checkpoint/quant options (all shards + companion files) and serve recipes.', inputSchema: { type: 'object', properties: { repoId: { type: 'string' }, target: { type: 'string' }, localPath: { type: 'string' } }, required: ['repoId'] } },
  { name: 'recipe_get', description: 'Fetch a signed recipe manifest by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'recipe_validate', description: 'Validate a recipe manifest shape.', inputSchema: { type: 'object', properties: { manifest: { type: 'object' } }, required: ['manifest'] } },
  { name: 'model_resolve', description: 'Map intent (repoId/revision) to model variant + recipe.', inputSchema: { type: 'object', properties: { repoId: { type: 'string' }, revision: { type: 'string' }, files: { type: 'array' } }, required: ['repoId'] } },
  { name: 'transfer_start', description: 'Return a transfer intent (requires user approval; never auto-starts).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, digest: { type: 'string' } }, required: ['id'] } },
  { name: 'update_check', description: 'Check engine/container/recipe updates against installed snapshot.', inputSchema: { type: 'object', properties: { installed: { type: 'object' }, feed: { type: 'object' } }, required: ['installed', 'feed'] } },
  { name: 'bundle_info', description: 'Bundle status (digest + pointer).', inputSchema: { type: 'object', properties: { etag: { type: 'string' } }, required: [] } },
];

function hub() {
  const hubUrl = process.env.FROSTBYTE_HUB_URL || process.env.HUB_URL || '';
  return createHubClient({ hubUrl: hubUrl || undefined, token: process.env.FROSTBYTE_HUB_TOKEN || process.env.HUB_TOKEN || undefined });
}

async function handleTool(name, args) {
  const client = hub();
  if (name === 'hub_search') {
    const res = await client.search({ q: args.q, kind: args.kind, quant: args.quant, limit: args.limit });
    return { content: [{ type: 'text', text: JSON.stringify(res?.data ?? res, null, 2) }] };
  }
  if (name === 'hf_search') {
    const results = await hfSearch({ query: args.query || '', limit: args.limit || 10, token: process.env.HF_TOKEN || '' });
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
  if (name === 'hf_model_options') {
    const info = await hfModelInfo(args.repoId, process.env.HF_TOKEN || '');
    const options = buildHfOptions(info.files || []);
    const serve = serveOptions(info, { target: args.target === 'spark' ? 'spark' : 'local', localPath: args.localPath || '', includeAlternatives: true });
    return { content: [{ type: 'text', text: JSON.stringify({ id: info.id, sha: info.sha, options, serve }, null, 2) }] };
  }
  if (name === 'recipe_get') {
    if (!args.id) throw new Error('id required');
    const res = await client.recipe(args.id);
    return { content: [{ type: 'text', text: JSON.stringify(res?.data ?? { error: 'Not found' }, null, 2) }] };
  }
  if (name === 'recipe_validate') {
    const v = validateRecipe(args.manifest);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: v.id, files: v.files.length }, null, 2) }] };
  }
  if (name === 'model_resolve') {
    const options = Array.isArray(args.files) && args.files.length ? buildHfOptions(args.files) : [];
    return { content: [{ type: 'text', text: JSON.stringify({ repoId: args.repoId, revision: args.revision || '', candidate: `${args.repoId}@${args.revision || 'latest'}`, options }, null, 2) }] };
  }
  if (name === 'transfer_start') {
    const intent = { kind: 'hub-recipe', id: args.id, digest: args.digest || '', approved: false, note: 'Approve this transfer in FrostByte before it starts.' };
    return { content: [{ type: 'text', text: JSON.stringify(intent, null, 2) }] };
  }
  if (name === 'update_check') {
    const nudges = checkUpdates({ installed: args.installed, feed: args.feed });
    return { content: [{ type: 'text', text: JSON.stringify({ nudges }, null, 2) }] };
  }
  if (name === 'bundle_info') {
    const res = await client.bundleLatest({ etag: args.etag });
    return { content: [{ type: 'text', text: JSON.stringify(res?.data ?? { error: 'No bundle' }, null, 2) }] };
  }
  throw new Error('Unknown tool: ' + name);
}

// Minimal JSON-RPC / MCP framing over stdio
async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  for await (const line of rl) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'frostbyte-mcp', version: SERVER_VERSION } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools } });
    } else if (method === 'tools/call') {
      try {
        const result = await handleTool(params?.name, params?.arguments || {});
        send({ jsonrpc: '2.0', id, result });
      } catch (err) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
      }
    } else if (method === 'ping' || method === 'notifications/initialized') {
      if (id != null) send({ jsonrpc: '2.0', id, result: {} });
    } else if (id != null) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
  }
}

// Compare resolved filesystem paths, not a hand-built file:// string: the
// template form misses when the path contains a space or other character the
// URL encoding escapes, which silently prevents the server from starting.
const isEntry = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (isEntry) main().catch(err => { console.error(err.message); process.exit(1); });
