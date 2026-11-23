import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THEME_IDS, normalizeTheme } from '../src/shared/appearance.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-appearance-'));
process.env.FROSTBYTE_HOME = home;
const { Store } = await import('../src/main/store.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('Blackfrost is optional and appearance settings survive a store reload', () => {
  const store = new Store();
  assert.equal(store.getSettings().theme, 'frost', 'existing default is preserved');
  for (const theme of THEME_IDS) {
    store.setSettings({ theme });
    assert.equal(new Store().getSettings().theme, theme);
  }
  store.setSettings({ blackfrostScene: 'blizzard', blackfrostSnow: false });
  assert.equal(new Store().getSettings().blackfrostScene, 'blizzard');
  assert.equal(new Store().getSettings().blackfrostSnow, false);
});

test('untrusted appearance settings cannot name external artwork or change unrelated settings', () => {
  const store = new Store(), before = store.getSettings();
  for (const patch of [{ theme: 'invalid' }, { blackfrostSnow: 'true' }, { blackfrostScene: 'https://example.com/snow.png' }, { blackfrostScene: '__proto__' }]) {
    assert.throws(() => store.setSettings(patch));
    assert.deepEqual(store.getSettings(), before);
  }
  assert.equal(normalizeTheme('invalid'), 'frost');
});

test('Blackfrost is a regular theme with no promotional showcase or scene controls', () => {
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const renderer = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/renderer/blackfrost.css', import.meta.url), 'utf8');
  const options = [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].filter(match => THEME_IDS.includes(match[1]));
  assert.deepEqual(options.map(match => match[1]), THEME_IDS);
  assert.equal(options.find(match => match[1] === 'blackfrost')[2], 'Blackfrost — frosted glass');
  assert.doesNotMatch(html, /blackfrost-(?:showcase|scene|art|atmosphere|snow|tier)|use-blackfrost|THE BLACKFROST COLLECTION|Tier 3/);
  assert.doesNotMatch(renderer, /blackfrostAtmosphere|blackfrostScene|blackfrostSnow|blackfrost-theme\.js/);
  assert.doesNotMatch(css, /glacier\.jpg|blizzard\.png|data-blackfrost-landscape|blackfrost-snowfall|blackfrost-showcase/);
  assert.match(css, /frozen-lake\.png/);
});

test('Blackfrost text and semantic colors meet 4.5:1 on every working surface', () => {
  const css = fs.readFileSync(new URL('../src/renderer/blackfrost.css', import.meta.url), 'utf8');
  const token = key => css.match(new RegExp(`--${key}: (#[\\dA-F]{6});`))[1];
  const luminance = hex => {
    const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  };
  for (const foreground of ['text', 'text-dim', 'text-faint', 'lime', 'up', 'down', 'info', 'warn', 'danger']) {
    for (const background of ['abyss', 'surface', 'surface-hi']) {
      const ratio = (luminance(token(foreground)) + .05) / (luminance(token(background)) + .05);
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}`);
    }
  }
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-reduced-transparency: reduce/);
  assert.match(css, /@supports not \(backdrop-filter:/);
  assert.doesNotMatch(css, /AeonDisplay|AeonMono/);
  assert.doesNotMatch(css, /(?:https?:|@import)/);
  assert.doesNotMatch(css, /@keyframes|animation:\s*[^n]/);
});

test('glass text retains 4.5:1 contrast even with pure white behind either glass gradient stop', () => {
  const css = fs.readFileSync(new URL('../src/renderer/blackfrost.css', import.meta.url), 'utf8');
  const stops = css.match(/--blackfrost-glass: ([^;]+);/)[1].match(/#[\dA-F]{8}/g);
  const colors = ['text', 'text-dim', 'text-faint', 'lime', 'up', 'down', 'info', 'warn', 'danger'].map(key => [key, css.match(new RegExp(`--${key}: (#[\\dA-F]{6});`))[1]]);
  const rgb = hex => hex.slice(1, 7).match(/../g).map(v => parseInt(v, 16) / 255);
  const luminance = values => values.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  for (const stop of stops) {
    const alpha = parseInt(stop.slice(7), 16) / 255;
    const background = rgb(stop).map(v => v * alpha + 1 - alpha);
    for (const [name, hex] of colors) {
      const ratio = (luminance(rgb(hex)) + .05) / (luminance(background) + .05);
      assert.ok(ratio >= 4.5, `${name} over ${stop} over white: ${ratio.toFixed(2)}`);
    }
  }
});
