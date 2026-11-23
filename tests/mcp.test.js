import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hfFetchStub, HF_FIXTURE_MODEL } from './helpers/hf-fetch.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.js');

/** Call tools over the server's real stdio framing; one response per call, in order. */
function callTools(calls, env) {
  const input = calls.map((params, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params }) + '\n').join('');
  const r = spawnSync(process.execPath, [SERVER], {
    input, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, FROSTBYTE_HUB_URL: '', HUB_URL: '', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('hf tools send the requested query and limit, and authenticate repository reads', t => {
  const hf = hfFetchStub(t);
  const [search, options] = callTools([
    { name: 'hf_search', arguments: { query: 'qwen coder', limit: 5 } },
    { name: 'hf_model_options', arguments: { repoId: HF_FIXTURE_MODEL } },
  ], { ...hf.env, HF_TOKEN: 'hf_fixture' });
  assert.equal(search.error, undefined);
  assert.equal(JSON.parse(options.result.content[0].text).id, HF_FIXTURE_MODEL);

  const [searched, inspected] = hf.requests();
  const query = new URL(searched.url).searchParams;
  assert.equal(query.get('search'), 'qwen coder');
  assert.equal(query.get('limit'), '5');
  assert.equal(inspected.authorization, 'Bearer hf_fixture');
});
