import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAppAsset } from '../src/main/app-protocol.js';
import { THEME_IDS, normalizeTheme } from '../src/shared/appearance.js';
import {
  JENSEN_NVIDIA_LOGO,
  JENSEN_PORTRAITS,
  JENSEN_TAB_BACKDROPS,
  JENSEN_TIMELINE_MILESTONES,
} from '../src/renderer/jensen-tribute.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-jensen-'));
process.env.FROSTBYTE_HOME = home;
const { Store } = await import('../src/main/store.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoot = path.join(root, 'src', 'renderer');

function parseHex(hex) {
  const raw = hex.replace('#', '').trim();
  if (raw.length === 6) {
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
    };
  }
  throw new Error(`Unsupported color: ${hex}`);
}

function luminance({ r, g, b }) {
  const channel = v => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function cssVars(css) {
  const block = css.match(/\[data-theme="jensen"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'Founders Leather root token block exists');
  return Object.fromEntries(
    [...block[1].matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])
  );
}

test('Founders Leather (jensen) is optional, normalized, and persists across Store reload', () => {
  assert.equal(normalizeTheme('jensen'), 'jensen');
  assert.ok(THEME_IDS.includes('jensen'));

  const store = new Store();
  assert.equal(store.getSettings().theme, 'frost');

  store.setSettings({ theme: 'jensen' });
  const reloaded = new Store();
  assert.equal(reloaded.getSettings().theme, 'jensen');
});

test('Founders Leather HTML wiring preserves brand-icon invariants and keeps tribute card hidden by default', () => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="jensen\.css"\s*\/>/);
  assert.match(html, /<svg class="brand-icon brand-jensen"[^>]*hidden>/);
  assert.match(html, /<div class="card jensen-tribute-card" id="jensen-tribute-card" hidden><\/div>/);

  const imgBrandIcons = [...html.matchAll(/<img\s+class="brand-icon\b/g)];
  assert.equal(imgBrandIcons.length, 3, 'img.brand-icon count stays 3 for packaged smoke checks');
  assert.match(html, /<small class="brand-jensen-tag" hidden>Jensen is NVIDIA<\/small>/);
  assert.match(html, /viewBox="130 27 62 46"/, 'brand mark is the NVIDIA eye geometry');

  const options = [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .filter(match => THEME_IDS.includes(match[1]));
  assert.deepEqual(options.map(match => match[1]), THEME_IDS);
  const jensenOpt = options.find(match => match[1] === 'jensen');
  assert.equal(jensenOpt?.[2], 'Founders Leather — Jensen tribute');
});

test('Founders Leather tokens meet WCAG AA 4.5:1 contrast across every leather surface', () => {
  const css = fs.readFileSync(path.join(rendererRoot, 'jensen.css'), 'utf8');
  const vars = cssVars(css);
  const backgrounds = ['--abyss', '--surface', '--surface-hi'];
  const foregrounds = ['--text', '--text-dim', '--text-faint', '--lime', '--up', '--down', '--info', '--warn', '--danger'];

  for (const bg of backgrounds) {
    for (const fg of foregrounds) {
      const ratio = contrast(parseHex(vars[fg]), parseHex(vars[bg]));
      assert.ok(ratio >= 4.5, `${fg} (${vars[fg]}) on ${bg} (${vars[bg]}) contrast ${ratio.toFixed(2)} >= 4.5`);
    }
  }
  const ctaContrast = contrast(parseHex('#0A0C09'), parseHex(vars['--lime']));
  assert.ok(ctaContrast >= 4.5, `primary CTA text contrast ${ctaContrast.toFixed(2)} >= 4.5`);
  const rightsContrast = contrast(parseHex('#D8CBA0'), parseHex(vars['--surface']));
  assert.ok(rightsContrast >= 4.5, `rights notice text contrast ${rightsContrast.toFixed(2)} >= 4.5`);
});

test('NVIDIA brand system: eye mark, green scrollbars/buttons, hero lockup, and community rights disclaimer', () => {
  const css = fs.readFileSync(path.join(rendererRoot, 'jensen.css'), 'utf8');
  const js = fs.readFileSync(path.join(rendererRoot, 'jensen-tribute.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(rendererRoot, 'app.js'), 'utf8');

  assert.match(css, /\[data-theme="jensen"\] ::-webkit-scrollbar-thumb/);
  assert.match(css, /scrollbar-color: var\(--lime-lo\) var\(--abyss\)/);
  assert.match(css, /\[data-theme="jensen"\] \.btn\.primary \{\s*background: var\(--lime\);/);
  assert.match(css, /\.jensen-nvidia-logo \{[\s\S]*?filter: brightness\(0\) invert\(1\);/);
  assert.match(css, /\.jensen-rights-notice \{/);
  assert.match(css, /\.jensen-lockup-tag \{/);

  assert.match(js, /Community creation — we do not own these rights\./);
  assert.match(js, /To us, Jensen is NVIDIA/);
  assert.match(js, /class="jensen-nvidia-logo"/);
  assert.match(js, /role="note" aria-label="Community creation and rights notice"/);
  assert.match(appJs, /jensenTag\.hidden = t !== 'jensen'/);

  const url = new URL(JENSEN_NVIDIA_LOGO.src, 'frostbyte://app/renderer/index.html').href;
  const resolved = resolveAppAsset(url, root);
  assert.ok(resolved && fs.existsSync(resolved), 'nvidia-logo.svg resolves via app protocol');
  const svg = fs.readFileSync(resolved, 'utf8').replace(/xmlns(?::[a-z]+)?="http:\/\/[^"]+"/g, '');
  assert.doesNotMatch(svg, /<script|https?:\/\//i, 'nvidia-logo.svg is self-contained with no scripts or remote URLs');

  const sources = JSON.parse(fs.readFileSync(path.join(root, 'assets/brand/jensen/sources.json'), 'utf8'));
  const logoEntry = sources.find(entry => entry.asset === 'assets/brand/jensen/nvidia-logo.svg');
  assert.ok(logoEntry, 'nvidia-logo.svg has a provenance entry');
  assert.match(logoEntry.trademark, /trademarks of NVIDIA Corporation/);
  assert.match(logoEntry.license, /Public domain/i);
});

test('all 8 per-tab innovation SVG backdrops and tribute assets are local, script-free, and app-protocol resolvable', () => {
  const css = fs.readFileSync(path.join(rendererRoot, 'jensen.css'), 'utf8');
  assert.equal(JENSEN_TAB_BACKDROPS.length, 8);
  assert.equal(JENSEN_PORTRAITS.length, 3);
  assert.deepEqual(JENSEN_TIMELINE_MILESTONES.map(m => m.year), ['2021', '2022', '2023', '2024', '2025', '2026']);

  const seenAssets = new Set();
  for (const entry of JENSEN_TAB_BACKDROPS) {
    const ruleRe = new RegExp(`\\[data-theme="jensen"\\]\\[data-active-tab="${entry.tab}"\\][\\s\\S]*?${entry.asset}`);
    assert.match(css, ruleRe, `jensen.css maps tab ${entry.tab} to ${entry.asset}`);
    seenAssets.add(entry.asset);

    const url = new URL(`../../assets/brand/jensen/${entry.asset}`, 'frostbyte://app/renderer/index.html').href;
    const resolved = resolveAppAsset(url, root);
    assert.ok(resolved && fs.existsSync(resolved), `${entry.asset} resolves via app protocol`);
    const svg = fs.readFileSync(resolved, 'utf8').replaceAll('xmlns="http://www.w3.org/2000/svg"', '');
    assert.doesNotMatch(svg, /<script|https?:\/\//i, `${entry.asset} is self-contained with no scripts or remote URLs`);
  }
  assert.equal(seenAssets.size, 8, 'each of the 8 tabs has a distinct innovation backdrop');

  for (const photo of JENSEN_PORTRAITS) {
    assert.doesNotMatch(photo.src, /^https?:\/\//i);
    const url = new URL(photo.src, 'frostbyte://app/renderer/index.html').href;
    const resolved = resolveAppAsset(url, root);
    assert.ok(resolved && fs.existsSync(resolved), `${photo.src} resolves via app protocol`);
  }
});
