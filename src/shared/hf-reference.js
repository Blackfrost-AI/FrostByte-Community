// Recognize a pasted Hugging Face model link or `org/name` id so search can jump straight to a model.
// Pure and strict: an exact host allowlist, model pages only, and the same segment rules as the main-process
// validateHfRepoId (which still re-validates every request). Anything ambiguous returns null and is searched.

const HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co']);
// First path segments that are Hugging Face site pages, not model owners.
const RESERVED = new Set(['api', 'datasets', 'spaces', 'docs', 'models', 'organizations', 'settings', 'join', 'login',
  'blog', 'learn', 'pricing', 'papers', 'collections', 'posts', 'tasks', 'new', 'search', 'chat', 'enterprise', 'storage']);
const SEGMENT = /^[\w.-]{1,96}$/;
const segment = value => SEGMENT.test(value) && value !== '.' && value !== '..' && !value.startsWith('.');

function repoFrom(parts) {
  if (!parts.length || parts.length > 2 || !parts.every(segment)) return null;
  const repo = parts.join('/');
  return repo.length <= 200 ? repo : null;
}

export function parseHfReference(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) return null;
  const linkLike = /^[a-z][a-z0-9+.-]*:/i.test(text) || /^(www\.)?(huggingface\.co|hf\.co)\//i.test(text);
  if (!linkLike) {
    // A bare id needs an owner: a single word like "qwen" is far more likely a search term.
    const parts = text.split('/');
    return parts.length === 2 ? (repoFrom(parts) ? { repo: repoFrom(parts), revision: null } : null) : null;
  }
  // URL() silently resolves dot segments (org/../etc -> etc), so refuse them in the raw text first.
  if (/(^|[/\\])\.\.?([/\\?#]|$)|\\/.test(text)) return null;
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : (/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)); }
  catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port || !HOSTS.has(url.hostname.toLowerCase())) return null;
  // Reject encoded separators/traversal outright instead of decoding them.
  if (/%2f|%5c|%2e/i.test(url.pathname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length || RESERVED.has(parts[0].toLowerCase())) return null;
  const marker = parts.findIndex(part => part === 'tree' || part === 'blob' || part === 'resolve' || part === 'commit');
  const repoParts = marker === -1 ? parts : parts.slice(0, marker);
  if (marker === -1 && parts.length > 2) return null;
  const repo = repoFrom(repoParts);
  if (!repo) return null;
  let revision = null;
  if (marker !== -1) {
    revision = parts[marker + 1];
    if (!revision || !segment(revision)) return null;
  }
  return { repo, revision };
}
