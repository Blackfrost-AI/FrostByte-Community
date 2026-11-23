/**
 * Hugging Face API stub for CLI and MCP child processes.
 *
 * Preloaded with `node --import`, it answers API requests locally and records
 * the URL and Authorization header of each one. Imported by a test, it only
 * provides the environment that preloads it and a reader for that record.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const HF_FIXTURE_MODEL = 'fixture/model';

if (process.env.FROSTBYTE_TEST_HF_REQUESTS) {
  const model = { id: HF_FIXTURE_MODEL, sha: 'a'.repeat(40), tags: ['license:apache-2.0'], siblings: [{ rfilename: 'config.json', size: 2 }] };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    appendFileSync(process.env.FROSTBYTE_TEST_HF_REQUESTS,
      JSON.stringify({ url: url.href, authorization: new Headers(options.headers).get('authorization') }) + '\n');
    return Response.json(url.pathname === '/api/models' ? [] : model);
  };
}

export function hfFetchStub(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fb-hf-stub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'requests.jsonl');
  return {
    env: { NODE_OPTIONS: `--import=${import.meta.url}`, FROSTBYTE_TEST_HF_REQUESTS: log },
    requests: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}
