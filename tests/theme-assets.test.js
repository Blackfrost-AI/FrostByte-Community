import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { resolveAppAsset } from '../src/main/app-protocol.js';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { getConfig } = require('app-builder-lib/out/util/config/config');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');

test('every local CSS font and titlebar image ships and resolves through the app protocol', async () => {
  const config = await getConfig(root, 'electron-builder.cjs');
  const filters = config.files.map(group => new FileMatcher(path.resolve(root, group.from || '.'), path.join(root, 'dist/app', group.to || '.'), value => value, group.filter).createFilter());
  const include = (file, stat) => filters.some(filter => filter(file, stat));
  const css = ['styles.css', 'blackfrost.css', 'jensen.css'].map(file => fs.readFileSync(path.join(root, 'src/renderer', file), 'utf8')).join('\n');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const fonts = [...css.matchAll(/url\(['"]?(\.\.\/\.\.\/assets\/fonts\/[^'"\s)]+)['"]?\)/g)].map(match => match[1]);
  const marks = [...html.matchAll(/<img\b[^>]*class="brand-icon[^>]*src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(fonts.length >= 2 && marks.length >= 2, 'the theme declares fonts and both brand marks');
  const art = [
    ...JSON.parse(fs.readFileSync(path.join(root, 'assets/brand/blackfrost/sources.json'))),
    ...JSON.parse(fs.readFileSync(path.join(root, 'assets/brand/jensen/sources.json'))),
  ];
  for (const source of [...fonts, ...marks, ...art.map(item => '../../' + item.asset)]) {
    const file = path.resolve(root, 'src/renderer', source);
    const url = new URL(source, 'frostbyte://app/renderer/index.html').href;
    assert.equal(resolveAppAsset(url, root), file, `${source} is available in the native app`);
    assert.equal(include(file, fs.statSync(file)), true, `${source} is included by Electron Builder`);
  }
  for (const item of art) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, item.asset))).digest('hex'), item.sha256, 'bundled artwork matches its provenance record');
  for (const retired of ['glacier.jpg', 'blizzard.png']) {
    const file = path.join(root, 'assets/brand/blackfrost', retired);
    assert.equal(include(file, fs.statSync(file)), false, 'promotional reference images are not packaged');
  }
  assert.equal(include(path.join(root, 'scripts/preview.html'), fs.statSync(path.join(root, 'scripts/preview.html'))), false,
    'the simulated preview is never packaged');
});

test('bundled fonts retain their exact bytes and complete upstream notices in the legal resources', async () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'assets/fonts/sources.json')));
  const config = await getConfig(root, 'electron-builder.cjs');
  assert.ok(config.extraResources.some(item => item.from === 'licenses' && item.to === 'Legal/licenses'));
  const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const font of inventory) {
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    assert.equal(digest(font.asset), font.sha256, font.family);
    assert.equal(digest(font.license), font.licenseSha256, font.license);
    const license = fs.readFileSync(path.join(root, font.license), 'utf8');
    assert.match(license, /Copyright/);
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(license, /OTHER DEALINGS IN THE FONT SOFTWARE\./);
    assert.ok(notices.includes(font.license), `${font.family} is in the shipped notice inventory`);
  }
});
