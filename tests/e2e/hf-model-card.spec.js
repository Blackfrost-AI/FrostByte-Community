import { acceptBetaTerms } from './consent-helper.js';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The model card is rendered locally from README text. This spec feeds a hostile README through the real renderer
// and checks that nothing executes, no remote request leaves the renderer, HF images load through the main-process
// guard, third-party images wait for a click, links route through openExternal, and the Settings toggle is honoured.
const sha = 'b'.repeat(40);
const model = { id: 'test/Card-Model', sha, gated: false, license: 'mit', downloads: 10, likes: 2, pipelineTag: 'text-generation',
  files: [{ path: 'model.safetensors', size: 1024 ** 3 }, { path: 'config.json', size: 900 }, { path: 'README.md', size: 4000 }] };
const readme = `---
license: mit
---
# Card Model

Intro with **bold** and a [docs link](https://example.com/docs) and a [relative file](config.json).

<script>window.__pwned = 'script'</script>
<img src="x" onerror="window.__pwned='img'">
<iframe src="https://evil.example/"></iframe>
[click me](javascript:window.__pwned='link')

![Benchmark](./figures/bench.png)

<p align="center"><img src="https://third-party.example/logo.png" alt="Partner logo"></p>

| Model | Score |
|---|--:|
| Card | 91.2 |

\`\`\`bash
vllm serve test/Card-Model
\`\`\`
`;
// 1×1 transparent PNG.
const png = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,120,156,99,248,15,0,0,1,1,1,0,24,221,141,176,0,0,0,0,73,69,78,68,174,66,96,130];

let app, page, home;
const errors = [];
const remoteRequests = [];

test.describe.serial('Model card', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-card-'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ downloadDir: path.join(home, 'downloads'), upnpEnabled: false, dhtEnabled: false, confirmExitSeeding: false }));
    app = await electron.launch({ executablePath: process.env.FROSTBYTE_EXECUTABLE, args: process.env.FROSTBYTE_EXECUTABLE ? [] : ['.'], env: { ...process.env, FROSTBYTE_HOME: home } });
    page = await app.firstWindow(); await acceptBetaTerms(page, app);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/i.test(request.url())) remoteRequests.push(request.url()); });
    await page.waitForFunction(() => document.querySelector('#nav .nav.on'));
    await app.evaluate(({ ipcMain }, { model, readme, png }) => {
      for (const name of ['hf:search', 'hf:model', 'hf:readme', 'hf:card-image', 'shell:openExternal']) ipcMain.removeHandler(name);
      globalThis.cardCalls = { readme: [], images: [], external: [] };
      ipcMain.handle('hf:search', () => ({ ok: true, data: [model] }));
      ipcMain.handle('hf:model', () => ({ ok: true, data: model }));
      ipcMain.handle('hf:readme', (_, id, revision) => { globalThis.cardCalls.readme.push([id, revision]); return { ok: true, data: { text: readme, truncated: false } }; });
      ipcMain.handle('hf:card-image', (_, url) => { globalThis.cardCalls.images.push(url); return { ok: true, data: { mime: 'image/png', data: Buffer.from(png), bytes: png.length, host: new URL(url).hostname } }; });
      ipcMain.handle('shell:openExternal', (_, url) => { globalThis.cardCalls.external.push(url); return { ok: true, data: true }; });
    }, { model, readme, png });
  });
  test.afterAll(async () => { await app?.close(); if (home) fs.rmSync(home, { recursive: true, force: true }); });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && page && !page.isClosed()) await page.screenshot({ path: info.outputPath('model-card-failure.png') }).catch(() => {});
  });

  const openCard = async () => {
    await page.locator('#nav [data-tab="hf"]').click();
    await page.locator('#hf-q').fill('Card'); await page.locator('#hf-go').click();
    await page.locator(`#grid-hf [data-id="${model.id}"]`).first().click();
    await expect(page.locator('#hf-detail h3')).toHaveText(model.id);
    await page.locator('#hf-tab-card').click();
    await expect(page.locator('#hf-pane-card article.md h1')).toHaveText('Card Model');
  };

  test('renders the README locally, pinned to the commit, without running anything in it', async () => {
    await openCard();
    await expect(page.locator('#hf-pane-download')).toBeHidden();
    expect(await app.evaluate(() => globalThis.cardCalls.readme)).toEqual([[model.id, sha]]);
    const card = page.locator('#hf-pane-card article.md');
    await expect(card.locator('strong')).toHaveText('bold');
    await expect(card.locator('table td').last()).toHaveText('91.2');
    await expect(card.locator('pre code')).toHaveText('vllm serve test/Card-Model');
    expect(await card.locator('script, iframe, object, embed, form, style').count()).toBe(0);
    expect(await card.evaluate(el => [...el.querySelectorAll('*')].some(node => [...node.attributes].some(a => /^on/i.test(a.name))))).toBe(false);
    expect(await card.evaluate(el => [...el.querySelectorAll('a')].map(a => a.getAttribute('href')))).toEqual(expect.arrayContaining(['#']));
    expect(await card.evaluate(el => [...el.querySelectorAll('a')].every(a => a.getAttribute('href') === '#'))).toBe(true);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });

  test('loads Hugging Face images through the main-process guard and holds third-party images for a click', async () => {
    const bench = page.locator('#hf-pane-card .md-img[aria-label="Benchmark"] img');
    await expect(bench).toBeVisible();
    expect(await bench.getAttribute('src')).toMatch(/^blob:/);
    const images = await app.evaluate(() => globalThis.cardCalls.images);
    // The hostile <img src="x" onerror=…> survives only as an inert repo-relative image, its handler removed.
    expect(images.sort()).toEqual([`https://huggingface.co/${model.id}/resolve/${sha}/figures/bench.png`, `https://huggingface.co/${model.id}/resolve/${sha}/x`]);
    const partner = page.locator('#hf-pane-card .md-img.external');
    await expect(partner.locator('button')).toHaveText('Load image from third-party.example');
    await partner.locator('button').click();
    await expect(partner.locator('img')).toBeVisible();
    expect(await app.evaluate(() => globalThis.cardCalls.images.at(-1))).toBe('https://third-party.example/logo.png');
    expect(remoteRequests).toEqual([]);
  });

  test('links open through openExternal, relative links resolve to the repository, and unsafe links stay inert', async () => {
    const card = page.locator('#hf-pane-card article.md');
    await card.locator('a', { hasText: 'docs link' }).click();
    await card.locator('a', { hasText: 'relative file' }).click();
    expect(await card.locator('a', { hasText: 'click me' }).count()).toBe(0);
    await page.locator('#hf-pane-card [data-card-page]').click();
    expect(await app.evaluate(() => globalThis.cardCalls.external)).toEqual([
      'https://example.com/docs', `https://huggingface.co/${model.id}/blob/${sha}/config.json`, `https://huggingface.co/${model.id}`,
    ]);
    await page.locator('#hf-tab-download').click();
    await expect(page.locator('#hf-pane-download')).toBeVisible();
    await expect(page.locator('#hf-download')).toBeVisible();
  });

  test('turning images off in Settings shows placeholders and requests nothing', async () => {
    await page.locator('#nav [data-tab="settings"]').click();
    await page.locator('#settings-nav [data-sec="hftoken"]').click();
    await expect(page.locator('#set-cardimages')).toBeChecked();
    await page.locator('#set-cardimages').uncheck();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).modelCardImages).toBe(false);
    await app.evaluate(() => { globalThis.cardCalls.images = []; });
    // Close and reopen the model so the card is rendered fresh with the new setting.
    await page.locator('#nav [data-tab="hf"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#hf-detail')).toBeHidden();
    await openCard();
    await expect(page.locator('#hf-pane-card .md-img.off')).toHaveCount(3);
    await page.waitForTimeout(400);
    expect(await page.locator('#hf-pane-card .md-img img').count()).toBe(0);
    expect(await app.evaluate(() => globalThis.cardCalls.images)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
