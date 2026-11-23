import test from 'node:test';
import assert from 'node:assert/strict';
import { THEME_CREDITS, THEME_CREDIT_URLS, themeCredit } from '../src/shared/theme-credits.js';
import { THEME_IDS } from '../src/shared/appearance.js';
import { approvedExternalUrl } from '../src/main/external-links.js';

test('each contributor theme credits its own author', () => {
  assert.deepEqual(themeCredit('aeon'), { name: 'AEON Forge', handle: '@SpaceTimeViking', url: 'https://x.com/SpaceTimeViking' });
  assert.deepEqual(themeCredit('u1tra_instinct'), { name: 'keys 🧪', handle: '@u1tra_instinct', url: 'https://x.com/u1tra_instinct' });
  assert.deepEqual(themeCredit('blackfrost'), { name: 'Blackfrost AI', handle: '@blackfrost_ai', url: 'https://x.com/blackfrost_ai' });
});

test('stock themes credit nobody and unknown ids are not inventing a credit', () => {
  for (const theme of ['frost', 'abyss', 'malachite', 'jensen']) assert.equal(themeCredit(theme), null, theme);
  assert.equal(themeCredit('nope'), null);
  assert.equal(themeCredit(undefined), null);
  assert.equal(themeCredit('toString'), null);
});

test('credits cover exactly the contributor themes and no duplicate handles', () => {
  for (const theme of Object.keys(THEME_CREDITS)) assert.ok(THEME_IDS.includes(theme), `${theme} is a real theme`);
  const handles = Object.values(THEME_CREDITS).map(credit => credit.handle);
  assert.equal(new Set(handles).size, handles.length);
  assert.equal(new Set(THEME_CREDIT_URLS).size, THEME_CREDIT_URLS.length);
  for (const credit of Object.values(THEME_CREDITS)) {
    assert.match(credit.url, /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/);
    assert.equal(credit.handle, '@' + credit.url.split('/').pop());
  }
});

test('every credit URL is allowlisted for opening externally, and lookalikes are not', () => {
  for (const url of THEME_CREDIT_URLS) assert.equal(approvedExternalUrl(url), url);
  assert.throws(() => approvedExternalUrl('https://x.com/evil'), /Only official/);
  assert.throws(() => approvedExternalUrl('https://x.com/u1tra_instinct?x=1'), /Only official/);
  assert.throws(() => approvedExternalUrl('http://x.com/u1tra_instinct'), /Only official/);
  assert.throws(() => approvedExternalUrl('javascript:alert(1)'), /Only official/);
});