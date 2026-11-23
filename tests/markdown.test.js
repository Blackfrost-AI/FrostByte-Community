import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, stripFrontMatter } from '../src/shared/markdown.js';

const ctx = { repo: 'org/model', revision: 'main' };
const md = (text) => renderMarkdown(text, ctx);

test('renders common model-card markdown', () => {
  const out = md('# Title\n\nSome **bold**, *em*, `code` and [a link](https://example.com/x).\n\n- one\n- two\n\n1. first\n2. second\n\n> quote\n\n---\n');
  assert.match(out.html, /<h1[^>]*>Title<\/h1>/);
  assert.match(out.html, /<strong>bold<\/strong>/);
  assert.match(out.html, /<em>em<\/em>/);
  assert.match(out.html, /<code>code<\/code>/);
  assert.match(out.html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(out.html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(out.html, /<blockquote>.*quote.*<\/blockquote>/s);
  assert.match(out.html, /<hr>/);
  assert.match(out.html, /<a href="#" class="md-link" data-href="https:\/\/example\.com\/x">a link<\/a>/);
});

test('renders fenced code blocks verbatim and escaped', () => {
  const out = md('```python\nprint("<b>hi</b>") # **not bold**\n```');
  assert.match(out.html, /<pre><code data-lang="python">print\(&quot;&lt;b&gt;hi&lt;\/b&gt;&quot;\) # \*\*not bold\*\*<\/code><\/pre>/);
});

test('renders GFM tables used for benchmarks', () => {
  const out = md('| Model | Score |\n|---|--:|\n| A | 1.0 |\n| **B** | 2 |');
  assert.match(out.html, /<table><thead><tr><th>Model<\/th><th style="text-align:right">Score<\/th><\/tr><\/thead>/);
  assert.match(out.html, /<td><strong>B<\/strong><\/td><td style="text-align:right">2<\/td>/);
});

test('strips YAML front matter', () => {
  assert.equal(stripFrontMatter('---\nlicense: mit\ntags: [a]\n---\n# Hi'), '# Hi');
  assert.equal(stripFrontMatter('# No front matter'), '# No front matter');
  assert.match(md('---\nlicense: mit\n---\n# Hi').html, /<h1[^>]*>Hi<\/h1>/);
});

test('never emits raw HTML, scripts, handlers or dangerous URLs', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox)', '[x](file:///etc/passwd)',
    '![x](javascript:alert(1))',
    '<svg onload=alert(1)>', '<style>*{display:none}</style>', '<form action=https://evil.example><input></form>',
    '[x](https://ok.example "title\\" onmouseover=\\"alert(1))',
    '<div style="background:url(https://evil.example)">x</div>',
    '**<img src=x onerror=alert(1)>**', '`<script>`', '| <script>alert(1)</script> |\n|---|\n| x |',
  ];
  for (const input of hostile) {
    const { html, images } = md(input);
    assert.doesNotMatch(html, /<(script|iframe|svg|style|form|input|object|embed|div|img)\b/i, input);
    assert.doesNotMatch(html, /<[^>]*\son\w+\s*=/i, input);
    for (const tag of html.match(/<[a-z][^>]*>/gi) || []) {
      assert.match(tag, /^<(h[1-6]|p|br|hr|strong|em|del|code|pre|blockquote|ul|ol|li|table|thead|tbody|tr|th|td|a|span)\b/, `${input} → ${tag}`);
    }
    // Dangerous schemes may survive as escaped visible text, but never inside an attribute value.
    assert.doesNotMatch(html, /="[^"]*(javascript|vbscript|data|file):/i, input);
    for (const [, href] of html.matchAll(/data-href="([^"]*)"/g)) assert.match(href, /^https?:\/\//, input);
    assert.doesNotMatch(html, /\sstyle="(?!text-align:(left|right|center)")/i, input);
    for (const image of images) assert.match(image.url, /^https:\/\//, input);
  }
});

test('turns model-card images into placeholders with resolved https URLs', () => {
  const out = md('![chart](./figures/a.png)\n\n![abs](https://cdn-uploads.huggingface.co/x.png)\n\n<p align="center"><img src="https://qianwen-res.oss.aliyuncs.com/logo.png" alt="Logo" width="400"/></p>');
  assert.deepEqual(out.images.map(image => image.url), [
    'https://huggingface.co/org/model/resolve/main/figures/a.png',
    'https://cdn-uploads.huggingface.co/x.png',
    'https://qianwen-res.oss.aliyuncs.com/logo.png',
  ]);
  assert.equal(out.images[2].alt, 'Logo');
  assert.equal((out.html.match(/<span class="md-img" data-image="\d+"/g) || []).length, 3);
});

test('keeps linked badges as images inside links', () => {
  for (const input of [
    '<a href="https://chat.qwen.ai/"><img alt="Chat" src="https://img.shields.io/badge/💜️ Qwen Chat -536af5" style="display: inline-block"/></a>',
    '[![Chat](https://img.shields.io/badge/chat-blue)](https://chat.qwen.ai/)',
  ]) {
    const out = md(input);
    assert.equal(out.images.length, 1, input);
    assert.match(out.images[0].url, /^https:\/\/img\.shields\.io\/badge\//);
    assert.match(out.html, /<a href="#" class="md-link" data-href="https:\/\/chat\.qwen\.ai\/"><span class="md-img" data-image="0"/, input);
  }
});

test('resolves relative links to the repository and drops unsafe ones', () => {
  const out = md('[cfg](config.json) [sec](#usage) [up](../../etc) [abs](https://huggingface.co/docs)');
  assert.match(out.html, /data-href="https:\/\/huggingface\.co\/org\/model\/blob\/main\/config\.json"/);
  assert.match(out.html, /data-href="https:\/\/huggingface\.co\/docs"/);
  assert.doesNotMatch(out.html, /etc/);
  assert.doesNotMatch(out.html, /data-href="#usage"/);
});

test('keeps text from stripped HTML, handles <br>, and stays bounded', () => {
  const out = md('<div align="center"><b>Hello</b><br>World</div><!-- hidden -->');
  assert.match(out.html, /Hello<br>World/);
  assert.doesNotMatch(out.html, /hidden/);
  const big = md('x'.repeat(2_000_000));
  assert.ok(big.html.length < 600_000);
  assert.ok(big.truncated);
  const many = md(Array.from({ length: 1000 }, (_, i) => `![i](https://cdn-uploads.huggingface.co/${i}.png)`).join('\n\n'));
  assert.ok(many.images.length <= 64);
});
