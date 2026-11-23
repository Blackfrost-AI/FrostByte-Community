/** Layer 3 — anchor local model bytes to the publisher's HuggingFace hashes.
 * The AEON card's `source` names the upstream repo (and optionally a pinned
 * revision via a resolve URL). Verdicts are three-state:
 *   matches-upstream — at least one file compared and every comparison matched
 *   differs          — at least one comparable file's bytes do not match
 *   unknown          — no anchor, unreachable repo, or nothing comparable
 * Zero comparable files is NEVER a match. Local-only files (no upstream entry)
 * count as missing, not as evidence of integrity.
 */
import path from 'node:path';
import { getUpstreamHashes as fetchUpstreamHashes, validateHfRepoId } from './hf.js';
import { sha256File as hashFile } from './file-hash.js';

const MAX_MISMATCHES = 50;

/** Resolve {repoId, revision} from an AEON card source URL. Exact host, exact
 * repo shape; anything else (other hosts, lookalike hosts, odd paths) is null. */
export function upstreamRepoFromSource(source) {
  if (typeof source !== 'string' || !source || source.length > 1000) return null;
  let url;
  try { url = new URL(source); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.username || url.password || url.port) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  let repoId;
  try { repoId = validateHfRepoId(`${parts[0]}/${parts[1]}`); } catch { return null; }
  let revision;
  if (parts.length >= 4 && (parts[2] === 'resolve' || parts[2] === 'blob' || parts[2] === 'tree')) {
    const candidate = parts[3];
    if (!candidate || candidate.length > 200 || /[\0\r\n]/.test(candidate)) return null;
    revision = candidate;
  } else if (parts.length > 2) {
    return null; // repo URL with an unrecognized extra path — do not guess
  }
  return { repoId, revision };
}

/** Compare every local file that has an upstream sha256 anchor. `item` is an
 * inventory row: {path: root, files: [{relative, size}], card}. Fetcher and
 * hasher are injectable for tests; defaults are the real HF + streaming hash. */
export async function verifyAgainstUpstream(item, { getUpstreamHashes = fetchUpstreamHashes, sha256File = hashFile, signal } = {}) {
  const unknown = (compared = 0, missing = 0, repoId) => ({ verdict: 'unknown', compared, missing, mismatches: [], ...(repoId ? { repoId } : {}) });
  const repo = upstreamRepoFromSource(item?.card?.source);
  const files = Array.isArray(item?.files) ? item.files : [];
  if (!repo || !item?.path || !files.length) return unknown();
  let upstream;
  try { upstream = await getUpstreamHashes(repo.repoId, { revision: repo.revision, signal }); }
  catch { return unknown(0, 0, repo.repoId); } // 404 / gated / offline: no anchor, honest unknown
  if (!(upstream instanceof Map)) return unknown(0, 0, repo.repoId);

  let compared = 0, missing = 0, unreadable = 0;
  const mismatches = [];
  for (const file of files) {
    const relative = typeof file?.relative === 'string' ? file.relative : '';
    if (!relative) { missing++; continue; }
    const expected = upstream.get(relative);
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) { missing++; continue; }
    let actual;
    try { actual = await sha256File(path.join(item.path, relative), { signal }); }
    catch { unreadable++; continue; }
    compared++;
    if (actual.toLowerCase() !== expected && mismatches.length < MAX_MISMATCHES) mismatches.push(relative);
  }
  if (mismatches.length) return { verdict: 'differs', compared, missing, mismatches, repoId: repo.repoId };
  if (!compared || unreadable) return unknown(compared, missing, repo.repoId);
  return { verdict: 'matches-upstream', compared, missing, mismatches: [], repoId: repo.repoId };
}
