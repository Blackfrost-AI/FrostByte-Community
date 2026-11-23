import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EDITIONS } from '../src/shared/edition-manifest.cjs';
import { builderConfigFor } from './helpers/builder-config.mjs';
import { sparkCompanionSources } from '../scripts/spark-companion-files.js';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('Community 1.0 grants Apache-2.0 without relicensing historical Founders', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(lock.packages[''].license, pkg.license);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(pkg.private, true, 'npm publication remains disabled');
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.doesNotMatch(license, /Beta permission|may not publish/);
  assert.match(read('NOTICE'), /Private historical Founders/);
  const legal = JSON.parse(read('src/shared/legal.json'));
  assert.match(legal.terms, /do not add restrictions to, or revoke, rights granted by Apache-2.0/);
  assert.match(legal.terms, /Friday 16 October 2026/);
});

test('desktop and companion include the Community license and notice', () => {
  const config = builderConfigFor('community');
  assert.equal(config.extraMetadata.license, EDITIONS.community.packageFields.license);
  assert.ok(config.files.includes(EDITIONS.community.licenseFile));
  assert.deepEqual(config.extraResources.find(file => file.to === 'Legal/LICENSE.txt'), { from: EDITIONS.community.licenseFile, to: 'Legal/LICENSE.txt' });
  assert.equal(config.files.includes('NOTICE'), true);
  assert.ok(sparkCompanionSources.includes('LICENSE'));
  assert.ok(sparkCompanionSources.includes('NOTICE'));
});
