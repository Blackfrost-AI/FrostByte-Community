#!/usr/bin/env node
/**
 * FrostByte version synchronization check.
 *
 * package.json is the single product-version source of truth. This script is
 * deliberately a check (not a silent rewriter): CI and release checks can prove
 * that lockfile metadata, release notes, runtime UI wiring, and website source
 * agree on the active product version without mutating a dirty worktree.
 *
 * Frozen release records (old release-note sections, site release manifests,
 * dependency versions, protocol versions, and historical logs) are intentionally
 * excluded. They describe an artifact that was shipped, not the active source.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

const version = pkg.version;
assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'package.json version must be semver');
assert.equal(lock.version, version, 'package-lock.json root version must match package.json');
assert.equal(lock.packages['']?.version, version, 'package-lock.json root package version must match package.json');

const notes = read('docs/RELEASE-NOTES.md');
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
assert.ok(
  new RegExp(`^# FrostByte ${escapedVersion}(?:\\s|$)`, 'm').test(notes),
  `docs/RELEASE-NOTES.md must lead with a ${version} entry`,
);

const html = read('src/renderer/index.html');
const elementText = (id) => {
  const match = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>([^<]*)<`));
  return match?.[1]?.trim() ?? '';
};
assert.equal(elementText('welcome-version'), 'VERSION', 'welcome version label must be dynamically populated');
assert.match(html, /id="welcome-version-number"[^>]*><\/span>/, 'welcome title must contain an empty runtime version slot');
assert.match(html, /Welcome to FrostByte\s*<span id="welcome-version-number"><\/span>/, 'welcome title must be dynamically populated');
assert.doesNotMatch(html, /VERSION 1\.0|Welcome to FrostByte 1\.0/, 'active welcome UI must not hard-code a stale product version');
assert.match(html, /id="about-product-version-line"[^>]*>FrostByte · Built for the swarm</, 'active About line must be a runtime version slot');
assert.match(html, /id="privacy-product-version-note"[^>]*>FrostByte does not collect/, 'active privacy note must be a runtime version slot');

const renderer = read('src/renderer/app.js');
assert.ok(renderer.includes(`const PACKAGE_VERSION = '${version}'`), 'renderer fallback must match the active package version');
assert.match(renderer, /function renderProductVersion\(version\)[\s\S]{0,500}?String\(version \|\| PACKAGE_VERSION\)\.trim\(\)/, 'renderer must derive an active version from runtime state with a package fallback');
assert.match(renderer, /renderProductVersion\(PACKAGE_VERSION\);/, 'renderer must populate the welcome before first-run consent');
assert.match(renderer, /welcomeVersionNumber\.textContent = activeVersion/, 'renderer must populate the welcome title from runtime state');
assert.match(renderer, /welcomeVersion\.textContent = `VERSION \$\{activeVersion\}`/, 'renderer must populate the welcome version from runtime state');
assert.match(renderer, /aboutProductLine\.textContent = `FrostByte \$\{activeVersion\} · Built for the swarm`/, 'renderer must populate About from runtime state');
assert.match(renderer, /privacyNote\.textContent = `FrostByte \$\{activeVersion\} does not collect/, 'renderer must populate the privacy note from runtime state');
assert.match(renderer, /#updates-version[\s\S]{0,300}?state\.version/, 'settings Updates must show the runtime version');

const legal = JSON.parse(read('src/shared/legal.json'));
assert.equal(legal.termsVersion, 'frostbyte-terms-2026-10-13-v1', 'versioned legal acceptance record must remain immutable until a legal revision');
assert.equal(legal.privacyVersion, 'frostbyte-privacy-2026-10-12-v1', 'versioned legal acceptance record must remain immutable until a legal revision');
assert.ok(legal.terms.includes('FrostByte 1.0 Terms'), 'legal notice text is a frozen acceptance record, not an active product label');

const mainSource = read('src/main/index.js');
assert.match(mainSource, /version:\s*app\.getVersion\(\)/, 'main process must expose app.getVersion() as runtime state version');

const privacy = read('src/main/privacy.js');
assert.match(privacy, /version\s*=\s*'0\.0\.0'/, 'privacy diagnostics must accept the runtime product version through its constructor');
assert.match(privacy, /FrostByte \$\{version\}/, 'privacy diagnostics must derive product-version text from the supplied runtime version');
assert.doesNotMatch(privacy, /FrostByte 1\.0/, 'privacy diagnostics must not hard-code a stale product version');

assert.match(mainSource, /new PrivacyService\(\{[\s\S]{0,200}?version:\s*app\.getVersion\(\)/, 'main process must pass app.getVersion() into privacy diagnostics');

// The website is a separate repository (migration in progress). When a site
// checkout is present alongside this repo, its release identity must agree;
// when absent (standalone source checkout / CI), website checks are skipped.
const siteReleasesPath = path.join(root, 'site/src/lib/releases.ts');
const websitePresent = existsSync(siteReleasesPath);
if (websitePresent) {
  const websiteReleases = read('site/src/lib/releases.ts');
  assert.ok(
    websiteReleases.includes(`PRODUCT_VERSION = '${version}'`),
    'site release identity must declare the same active product version',
  );
  assert.ok(
    websiteReleases.includes(`current: true`),
    'site must keep a verified current public release for downloads',
  );
}

for (const activeDoc of ['docs/DEVELOPMENT.md', 'docs/PRIVACY-AND-FEEDBACK.md']) {
  const text = read(activeDoc);
  assert.ok(
    text.includes(`FrostByte Community ${version}`) ||
      text.includes(`FrostByte ${version}`) ||
      text.includes(`FrostByte v${version}`),
    `${activeDoc} must identify the active product version`,
  );
  assert.doesNotMatch(text, /(?:^|\n)# FrostByte 1\.0|FrostByte 1\.0 does not/, `${activeDoc} must not contain stale 1.0 product wording`);
}

if (websitePresent) {
  const websitePackage = JSON.parse(read('site/package.json'));
  assert.notEqual(
    websitePackage.name,
    pkg.name,
    'site/package.json is a private application version, not the desktop product version',
  );
}

console.log(`VERSION_SYNC: PASS ${version}`);
console.log('  source: package.json');
console.log('  derived: package-lock.json, release notes, runtime UI, diagnostics' + (websitePresent ? ', site release identity' : ''));
console.log('  frozen: historical release notes and published artifact records preserved');
console.log('  website: ' + (websitePresent ? 'checked against local site checkout' : 'separate repository; checks skipped (no site checkout)'));
