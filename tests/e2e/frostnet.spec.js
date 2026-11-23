import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createApi, MemoryDirectory } from '../../frostnet/functions/api.js';
import { validateRelease, FROSTNET_TERMS } from '../../src/shared/release-manifest.js';
import { manifestDigest } from '../../src/main/publications.js';
let server, origin, storage, digest;
test.beforeAll(async () => {
  storage = new MemoryDirectory();
  const manifest = validateRelease({ schema: 'frostbyte.release', version: 1, publisher: 'blackfrost', release: 'aurora-v1', variant: 'gguf-q4-k-m', name: 'Blackfrost Aurora', description: 'Local QA fixture for precise model provenance and portable peer links. Never published to the live directory.', origin: 'original', files: [{ path: 'aurora/model.gguf', size: 4_200_000_000, sha256: 'a'.repeat(64) }, { path: 'aurora/config.json', size: 3000, sha256: 'b'.repeat(64) }], license: { id: 'Apache-2.0', statement: 'Owner-created QA fixture. No actual model bytes are hosted.' }, torrent: { infohash_v1: 'c'.repeat(40), metainfo_sha256: 'd'.repeat(64), piece_length: 1048576 }, verified_at: '2026-10-10T00:00:00Z', redistribution_confirmed: true });
  digest = manifestDigest(manifest); await storage.submit({ key: 'e'.repeat(64), digest, manifest, publisher: 'blackfrost', withdrawing: false, now: Date.now(), terms: FROSTNET_TERMS });
  const api = createApi({ storage, tokenHash: () => '' });
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/')) { void api(req, res); return; }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const filename = pathname.startsWith('/releases/') || pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'app.js', 'styles.css'].includes(filename)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(fs.readFileSync(path.resolve('frostnet/public', filename)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
for (const [name, size] of [['desktop', { width: 1440, height: 1050 }], ['mobile', { width: 390, height: 844 }]]) test(`${name} directory search, release evidence, safe magnet handoff and withdrawal`, async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.setViewportSize(size);
  await page.goto(origin); await expect(page.locator('.release-card')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath(name + '-directory.png'), fullPage: true });
  await page.getByRole('searchbox').fill('nothing-matches'); await page.getByRole('button', { name: 'Search' }).click(); await expect(page.getByText('No matching releases yet.')).toBeVisible();
  await page.getByRole('searchbox').fill('aurora'); await page.getByRole('button', { name: 'Search' }).click(); await page.locator('.release-card').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Blackfrost Aurora');
  await expect(page.locator('.file-table tbody tr')).toHaveCount(2); await expect(page.getByText('Seed availability unknown.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in FrostByte' })).toHaveAttribute('href', /^magnet:\?xt=urn:btih:/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(name + '-release.png'), fullPage: true });
  await page.route('**/v1/releases/' + digest, async route => { const row = await storage.get('releases', digest); await route.fulfill({ json: { ...row, status: 'withdrawn' } }); });
  await page.reload(); await expect(page.getByText('This listing has been withdrawn.', { exact: false })).toBeVisible(); await expect(page.getByRole('link', { name: 'Open in FrostByte' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
