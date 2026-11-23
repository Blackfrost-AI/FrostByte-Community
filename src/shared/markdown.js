// Safe, dependency-free Markdown renderer for Hugging Face model cards.
//
// Security model: the output is built only from a fixed allowlist of tags this file writes itself. Every piece of
// source text is HTML-escaped. Raw HTML in the card is never passed through: <img> and <a> become Markdown
// images and links, <br> becomes a line break, and every other tag is dropped (its text is kept as escaped text).
// Links are inert <a href="#"> elements carrying a validated https/http URL in data-href; the renderer opens them
// through the reviewed openExternal IPC. Images become placeholders plus an {url, alt} list; the caller decides
// whether and how to load them. All regexes are bounded so hostile input cannot cause catastrophic backtracking.

const MAX_INPUT = 512 * 1024;
const MAX_IMAGES = 64;
const MAX_DEPTH = 6;
const HF = 'https://huggingface.co';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, ch => ESC[ch]);

// Hosts operated by Hugging Face. With card images on, these load automatically; other hosts need a click because
// loading them reveals the user's IP address to a third party.
const HF_IMAGE_HOSTS = /^(?:huggingface\.co|hf\.co|[a-z0-9-]{1,63}\.huggingface\.co|[a-z0-9-]{1,63}\.hf\.co|[a-z0-9-]{1,63}\.xethub\.hf\.co)$/;

export function isHfImageHost(hostname) {
  return HF_IMAGE_HOSTS.test(String(hostname || '').toLowerCase());
}

export function stripFrontMatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return text;
  const lines = text.split('\n');
  for (let i = 1; i < Math.min(lines.length, 2000); i++) {
    if (/^---\s*$/.test(lines[i])) return lines.slice(i + 1).join('\n');
  }
  return text;
}

// ── URL policy ────────────────────────────────────────────────────────────────
function cleanPath(raw) {
  const value = raw.trim().replace(/^<|>$/g, '');
  if (!value || value.length > 2048 || /[\\\u0000-\u001f]/.test(value)) return null;
  return value;
}

function resolveRepoUrl(value, ctx, kind) {
  if (!ctx?.repo) return null;
  const pathPart = value.split(/[?#]/)[0].replace(/^\.\//, '');
  if (!pathPart || pathPart.split('/').some(segment => segment === '..' || segment === '.')) return null;
  if (pathPart.startsWith('/')) return absoluteUrl(`${HF}${pathPart}`, ['https:']);
  const revision = encodeURIComponent(ctx.revision || 'main');
  const base = `${HF}/${ctx.repo}/${kind}/${revision}/`;
  const url = absoluteUrl(base + pathPart, ['https:']);
  return url && url.startsWith(base) ? url : null;
}

function absoluteUrl(value, protocols) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!protocols.includes(url.protocol) || url.username || url.password || !url.hostname) return null;
  const href = url.href;
  return href.length <= 2048 ? href : null;
}

const hasScheme = (value) => /^[a-z][a-z0-9+.-]*:/i.test(value);

function safeLink(raw, ctx) {
  const value = cleanPath(raw);
  if (!value || value.startsWith('#')) return null;
  if (hasScheme(value)) return absoluteUrl(value, ['https:', 'http:']);
  if (value.startsWith('//')) return null;
  return resolveRepoUrl(value, ctx, 'blob');
}

function safeImage(raw, ctx) {
  const value = cleanPath(raw);
  if (!value || value.startsWith('#') || value.startsWith('//')) return null;
  if (hasScheme(value)) return absoluteUrl(value, ['https:']);
  return resolveRepoUrl(value, ctx, 'resolve');
}

// ── Raw HTML → Markdown-ish text (outside fenced code) ───────────────────────
function removeBlocks(text, open, close) {
  // indexOf-based so unterminated blocks stay linear-time.
  let out = '';
  let index = 0;
  const lower = text.toLowerCase();
  for (;;) {
    const start = lower.indexOf(open, index);
    if (start === -1) return out + text.slice(index);
    const end = lower.indexOf(close, start + open.length);
    out += text.slice(index, start);
    if (end === -1) return open === '<!--' ? out : out + text.slice(start + open.length);
    index = end + close.length;
  }
}

function attr(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]{0,2048})"|'([^']{0,2048})'|([^\\s"'>]{1,2048}))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

const mdUrl = (url) => url.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
const mdLabel = (label) => label.replace(/[[\]\n]/g, ' ').trim();

function htmlToText(text) {
  const spans = [];
  // Protect inline code so `<tag>` examples survive as literal text.
  let out = text.replace(/`[^`\n]{1,2000}`/g, (code) => { spans.push(code); return `\u0002${spans.length - 1}\u0002`; });
  out = removeBlocks(out, '<!--', '-->');
  out = removeBlocks(out, '<script', '</script>');
  out = removeBlocks(out, '<style', '</style>');
  out = out.replace(/<https?:\/\/[^\s<>]{1,2048}>/g, (link) => `\u0003${link.slice(1, -1)}\u0003`);
  // Links first, so a badge (<a><img></a>) keeps its image as the link label.
  out = out.replace(/<a\b([^<>]{0,4096})>\s*([^<]{0,2000}|<img\b[^<>]{0,4096}>)\s*<\/a\s*>/gi, (_, attrs, label) => {
    const href = attr(` ${attrs}`, 'href');
    const text = label.startsWith('<') ? label : mdLabel(label);
    return href ? `[${text}](${mdUrl(href)})` : text;
  });
  out = out.replace(/<img\b[^<>]{0,4096}>/gi, (tag) => {
    const src = attr(tag, 'src');
    return src ? `![${mdLabel(attr(tag, 'alt'))}](${mdUrl(src)})` : '';
  });
  out = out.replace(/<br\s*\/?>/gi, '\u0001');
  out = out.replace(/<\/?(p|div|h[1-6]|table|tr|li|ul|ol|section|center|details|summary)\b[^<>]{0,4096}>/gi, '\n');
  out = out.replace(/<\/?[a-z][a-z0-9-]{0,40}\b[^<>]{0,4096}>/gi, '');
  out = out.replace(/<\/?[a-z][a-z0-9-]{0,40}>/gi, '');
  out = out.replace(/\u0003([^\u0003]{1,2048})\u0003/g, '<$1>');
  return out.replace(/\u0002(\d+)\u0002/g, (_, n) => spans[Number(n)] ?? '');
}

// ── Inline ────────────────────────────────────────────────────────────────────
const LINK = /\[([^[\]\n]{0,1000})\]\(\s*<?([^()\s<>]{1,2048})>?(?:\s+(?:"[^"\n]{0,500}"|'[^'\n]{0,500}'))?\s*\)/g;
const IMAGE = /!\[([^[\]\n]{0,500})\]\(\s*<?([^()\s<>]{1,2048})>?(?:\s+(?:"[^"\n]{0,500}"|'[^'\n]{0,500}'))?\s*\)/g;

function emphasis(text) {
  return text
    .replace(/\*\*([^*\n]{1,2000}?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__([^_\n]{1,2000}?)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*([^*\s](?:[^*\n]{0,2000}?[^*\s])?)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_([^_\s](?:[^_\n]{0,2000}?[^_\s])?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]{1,2000}?)~~/g, '<del>$1</del>');
}

function inline(source, state) {
  const { tokens, ctx } = state;
  const put = (html) => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000`; };
  let text = source;
  text = text.replace(/`([^`\n]{1,2000})`/g, (_, code) => put(`<code>${esc(code)}</code>`));
  text = text.replace(/<(https?:\/\/[^\s<>]{1,2048})>/g, (_, url) => {
    const href = safeLink(url, ctx);
    return href ? put(`<a href="#" class="md-link" data-href="${esc(href)}">${esc(url)}</a>`) : put(esc(url));
  });
  text = text.replace(IMAGE, (_, alt, url) => {
    const resolved = safeImage(url, ctx);
    if (!resolved || state.images.length >= MAX_IMAGES) return put(esc(alt));
    state.images.push({ url: resolved, alt });
    const label = alt || 'image';
    return put(`<span class="md-img" data-image="${state.images.length - 1}" role="img" aria-label="${esc(label)}">${esc(label)}</span>`);
  });
  text = text.replace(LINK, (_, label, url) => {
    const href = safeLink(url, ctx);
    const inner = emphasis(esc(label));
    return put(href ? `<a href="#" class="md-link" data-href="${esc(href)}">${inner}</a>` : inner);
  });
  text = emphasis(esc(text)).replace(/\u0001/g, '<br>');
  for (let pass = 0; pass < 4 && text.includes('\u0000'); pass++) {
    text = text.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)] ?? '');
  }
  return text.replace(/\u0000/g, '');
}

// ── Blocks ────────────────────────────────────────────────────────────────────
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( {0,12})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*){0,63}\|?[ \t]*$/;

function cells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const out = [];
  let current = '';
  for (let i = 0; i < text.length && out.length < 64; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { current += '|'; i++; }
    else if (text[i] === '|') { out.push(current.trim()); current = ''; }
    else current += text[i];
  }
  out.push(current.trim());
  return out;
}

function table(lines, start, state) {
  const header = cells(lines[start]);
  const aligns = cells(lines[start + 1]).map(spec => spec.startsWith(':') && spec.endsWith(':') ? 'center'
    : spec.endsWith(':') ? 'right' : spec.startsWith(':') ? 'left' : '');
  const style = (index) => aligns[index] ? ` style="text-align:${aligns[index]}"` : '';
  const row = (values, tag) => `<tr>${header.map((_, index) => `<${tag}${style(index)}>${inline(values[index] ?? '', state)}</${tag}>`).join('')}</tr>`;
  let i = start + 2;
  const body = [];
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() && body.length < 2000) body.push(row(cells(lines[i++]), 'td'));
  return { html: `<table><thead>${row(header, 'th')}</thead>${body.length ? `<tbody>${body.join('')}</tbody>` : ''}</table>`, next: i };
}

function list(lines, start, state, depth) {
  const first = LIST.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const match = LIST.exec(line);
    if (match && match[1].length === indent && /\d/.test(match[2]) === ordered) {
      items.push({ text: match[3], children: [] }); i++; continue;
    }
    if (match && match[1].length > indent && items.length && depth < MAX_DEPTH) {
      const nested = list(lines, i, state, depth + 1);
      items.at(-1).children.push(nested.html); i = nested.next; continue;
    }
    if (!match && items.length && line.trim() && /^\s/.test(line) && (line.match(/^ */)[0].length >= indent + 2)) {
      items.at(-1).text += ` ${line.trim()}`; i++; continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.map(item => `<li>${inline(item.text, state)}${item.children.join('')}</li>`).join('')}</${tag}>`, next: i };
}

const startsBlock = (line) => HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line);

function blocks(text, state, depth) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = HEADING.exec(line);
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2] || '', state)}</h${heading[1].length}>`); i++; continue; }
    if (HR.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_SEP.test(lines[i + 1])) {
      const result = table(lines, i, state); out.push(result.html); i = result.next; continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(QUOTE, ''));
      out.push(depth < MAX_DEPTH ? `<blockquote>${blocks(inner.join('\n'), state, depth + 1)}</blockquote>` : `<p>${inline(inner.join(' '), state)}</p>`);
      continue;
    }
    if (LIST.test(line)) { const result = list(lines, i, state, depth); out.push(result.html); i = result.next; continue; }
    const paragraph = [line.trim()];
    i++;
    if (i < lines.length && /^ {0,3}=+[ \t]*$/.test(lines[i])) { out.push(`<h1>${inline(paragraph[0], state)}</h1>`); i++; continue; }
    if (i < lines.length && /^ {0,3}-+[ \t]*$/.test(lines[i])) { out.push(`<h2>${inline(paragraph[0], state)}</h2>`); i++; continue; }
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) paragraph.push(lines[i++].trim());
    out.push(`<p>${inline(paragraph.join('\n'), state)}</p>`);
  }
  return out.join('');
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]{0,32})/;

/**
 * @param {string} markdown raw README text
 * @param {{repo?: string, revision?: string}} ctx repository used to resolve relative links and images
 * @returns {{html: string, images: {url: string, alt: string}[], truncated: boolean}}
 */
export function renderMarkdown(markdown, ctx = {}) {
  let text = typeof markdown === 'string' ? markdown : '';
  const truncated = text.length > MAX_INPUT;
  if (truncated) text = text.slice(0, MAX_INPUT);
  text = stripFrontMatter(text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0003]/g, ''));
  const state = { ctx, images: [], tokens: [] };
  const lines = text.split('\n');
  const out = [];
  let prose = [];
  const flush = () => { if (prose.length) { out.push(blocks(htmlToText(prose.join('\n')), state, 0)); prose = []; } };
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) { prose.push(lines[i]); continue; }
    flush();
    const fence = open[1];
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    const code = [];
    for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
    out.push(`<pre><code${open[2] ? ` data-lang="${esc(open[2])}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
  }
  flush();
  return { html: out.join(''), images: state.images, truncated };
}
