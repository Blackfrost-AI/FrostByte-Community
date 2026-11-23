// Hub search. Recipes come from the real content-addressed store; models come from a
// curated local catalog index (model discovery itself lives on HuggingFace — the hub
// indexes a small starter set for offline/local browsing). A single cursor space spans
// both kinds. Scoring is deterministic; pagination uses the shared protocol cursor.
import { decodeCursor, encodeCursor, PAGINATION } from '../../src/shared/hub-protocol.js';

// Local model catalog. These are index entries pointing at public HF repos, not hosted
// weights. Clearly a starter catalog for the local hub; production would sync this from
// a real directory. Kept small and honest.
export const MODEL_CATALOG = [
  { id: 'Qwen/Qwen2.5-7B-Instruct', title: 'Qwen2.5 7B Instruct', kind: 'model', task: 'chat', license: 'apache-2.0', downloads: 1200000, likes: 4200, tags: ['chat', 'instruct', '7b'] },
  { id: 'meta-llama/Llama-3.1-8B-Instruct', title: 'Llama 3.1 8B Instruct', kind: 'model', task: 'chat', license: 'llama3.1', downloads: 2100000, likes: 6100, tags: ['chat', 'instruct', '8b'] },
  { id: 'mistralai/Mistral-7B-Instruct-v0.3', title: 'Mistral 7B Instruct v0.3', kind: 'model', task: 'chat', license: 'apache-2.0', downloads: 900000, likes: 3300, tags: ['chat', 'instruct', '7b'] },
  { id: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', title: 'Llama 3.1 8B GGUF', kind: 'model', task: 'chat', license: 'llama3.1', downloads: 700000, likes: 1500, tags: ['gguf', 'quantized', '8b'] },
  { id: 'Qwen/Qwen2.5-Coder-7B-Instruct', title: 'Qwen2.5 Coder 7B', kind: 'model', task: 'code', license: 'apache-2.0', downloads: 500000, likes: 2100, tags: ['code', '7b'] },
  { id: 'BAAI/bge-small-en-v1.5', title: 'BGE small EN v1.5', kind: 'model', task: 'embedding', license: 'mit', downloads: 800000, likes: 900, tags: ['embedding', 'retrieval'] },
];

function scoreItem(item, q) {
  if (!q) return 1;
  const needle = q.toLowerCase();
  const id = String(item.id || '').toLowerCase();
  const title = String(item.title || '').toLowerCase();
  const tags = (item.tags || []).join(' ').toLowerCase();
  let score = 0;
  if (id === needle) score += 100;
  else if (id.includes(needle)) score += 40;
  if (title.includes(needle)) score += 30;
  if (tags.includes(needle)) score += 15;
  if (String(item.task || '').toLowerCase() === needle) score += 20;
  return score;
}

export function createSearch({ store }) {
  return function search({ q, cursor = null, limit = PAGINATION.DEFAULT_LIMIT, kind, task, license, publisher } = {}) {
    const maxLimit = Math.min(Number(limit) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
    let items = [];
    if (kind !== 'recipe') {
      items.push(...MODEL_CATALOG.map(m => ({ ...m })));
    }
    if (kind !== 'model') {
      // Real recipes from the content-addressed store.
      for (const head of store.headsList()) {
        items.push({
          id: head.id, title: head.title || head.id, kind: 'recipe',
          publisher: head.publisher, license: head.license, digest: head.digest,
          task: head.task || null, downloads: 0, likes: 0, tags: [],
        });
      }
    }
    if (task) items = items.filter(i => i.task === task);
    if (license) items = items.filter(i => String(i.license).toLowerCase() === String(license).toLowerCase());
    if (publisher) items = items.filter(i => String(i.publisher || '').toLowerCase() === String(publisher).toLowerCase());
    if (q) {
      items = items.map(i => ({ item: i, score: scoreItem(i, q) })).filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)))
        .map(x => x.item);
    } else {
      items.sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || String(a.id).localeCompare(String(b.id)));
    }
    let decoded = null;
    if (cursor) {
      try { decoded = decodeCursor(cursor); }
      catch { const err = new Error('Invalid cursor.'); err.status = 400; err.code = 'bad_cursor'; throw err; }
    }
    const start = decoded && Number.isInteger(decoded.seq) && decoded.seq >= 0 ? decoded.seq : 0;
    const page = items.slice(start, start + maxLimit);
    const nextSeq = start + page.length;
    const nextCursor = nextSeq < items.length ? encodeCursor({ seq: nextSeq }) : null;
    return { items: page, nextCursor };
  };
}