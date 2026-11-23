import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

test('version synchronization check is wired into release:check and passes', () => {
  const pkg = JSON.parse(read('package.json'));
  const pkgScripts = JSON.parse(read('package.json')).scripts;
  const release = read('scripts/release.mjs');
  assert.match(
    pkgScripts['release:check'],
    /scripts\/sync-version\.mjs/,
    'release:check must run the cross-surface version synchronization check',
  );
  assert.match(
    release,
    /sync-version\.mjs/,
    'direct release.mjs check must also run the cross-surface version synchronization check',
  );

  const output = execFileSync(process.execPath, ['scripts/sync-version.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(output, new RegExp(`VERSION_SYNC: PASS ${pkg.version.replace(/\./g, '\\.')}`));
});

test('V2.0 release identity is explicit; website identity is checked only when a site checkout is present', () => {
  const pkg = JSON.parse(read('package.json'));
  const notes = read('docs/RELEASE-NOTES.md');
  const versioning = read('docs/VERSIONING.md');

  assert.equal(pkg.version, '2.0.0');
  assert.match(versioning, /`package\.json`[^\n]*`2\.0\.0`|2\.0\.0/);
  assert.match(notes, /^# FrostByte 2\.0\.0/m);

  // The website is a separate repository (migration in progress). The
  // sync-version script gates website identity on the checkout's presence;
  // this test proves the conditional wiring exists rather than assuming a
  // site/ directory ships inside the source repo.
  const sync = read('scripts/sync-version.mjs');
  assert.match(sync, /websitePresent/);
  assert.match(sync, /existsSync\(siteReleasesPath\)/);
});

test('active product-facing docs use V2.0 identity', () => {
  const development = read('docs/DEVELOPMENT.md');
  const privacyDoc = read('docs/PRIVACY-AND-FEEDBACK.md');
  assert.match(development, /Current Community version: \*\*2\.0\.0\*\*/);
  assert.match(privacyDoc, /^# FrostByte 2\.0 privacy and feedback/m);
  assert.match(privacyDoc, /FrostByte 2\.0\.0 does not collect/);
  assert.doesNotMatch(development, /Community 1\.0 downloads/);
  assert.doesNotMatch(privacyDoc, /^# FrostByte 1\.0/m);
});

test('versioned legal acceptance record is preserved, not silently rewritten', () => {
  const legal = JSON.parse(read('src/shared/legal.json'));
  assert.equal(legal.termsVersion, 'frostbyte-terms-2026-11-23-v1');
  assert.equal(legal.privacyVersion, 'frostbyte-privacy-2026-10-12-v1');
  assert.match(legal.terms, /FrostByte 1\.0 Terms/);
  const nativeReview = read('src/main/native-review.js');
  assert.match(nativeReview, /Accept the FrostByte 1\.0 terms and privacy notice\?/, 'legal acceptance dialog remains bound to the versioned notice');
});

test('active user-facing product versions are runtime-derived rather than pinned', () => {
  const html = read('src/renderer/index.html');
  const app = read('src/renderer/app.js');
  const privacy = read('src/main/privacy.js');
  const cli = read('src/cli/index.js');

  assert.doesNotMatch(html, /Welcome to FrostByte 1\.0|VERSION 1\.0/);
  assert.match(html, /id="welcome-version-number"/);
  assert.match(app, /const PACKAGE_VERSION = '2\.0\.0'/);
  assert.match(app, /function renderProductVersion\(version\)/);
  assert.match(app, /renderProductVersion\(PACKAGE_VERSION\)/);
  assert.match(app, /welcomeVersionNumber\.textContent = activeVersion/);
  assert.match(app, /aboutProductLine\.textContent = `FrostByte \$\{activeVersion\} · Built for the swarm`/);
  assert.match(app, /privacyNote\.textContent = `FrostByte \$\{activeVersion\} does not collect/);
  assert.match(app, /#updates-version[\s\S]{0,300}?state\.version/);
  assert.match(privacy, /version\s*=\s*'0\.0\.0'/);
  assert.match(privacy, /FrostByte \$\{version\}/);
  assert.match(read('src/main/index.js'), /new PrivacyService\(\{[^}]*version: app\.getVersion\(\)/);
  assert.doesNotMatch(privacy, /FrostByte 1\.0/);
  assert.match(cli, /packageVersion\(\)/);
});
