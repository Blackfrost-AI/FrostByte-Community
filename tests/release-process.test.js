import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseConfig, releaseProfile, assemble, fingerprint, targets, begin, generatedChanges } from '../scripts/release.mjs';
import { compareVersions, validateRelease } from '../src/main/updates.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.3.0', packages: { '': { version: '0.3.0' } } }));
  await fs.writeFile(path.join(root, 'docs/RELEASE-NOTES.md'),
    '# FrostByte 0.3.0 — fixture\n\nTest release notes.\n');
  return root;
}

test('release versions stay aligned and older beta clients recognize 0.3.0', async t => {
  const root = await fixture(t);
  const config = await releaseConfig(root);
  assert.equal(config.edition, 'community');
  assert.equal(config.channel, 'beta');
  assert.deepEqual(await releaseProfile(root), {
    edition: 'community', channel: 'beta', notesFile: 'docs/RELEASE-NOTES.md', notesTitle: 'FrostByte',
    outputDirectory: 'dist', artifactPrefix: 'FrostByte', macApp: 'FrostByte.app',
    packagedTestArgument: '--community-build', tagPrefix: 'v',
  });
  assert.equal(validateRelease(config).version, '0.3.0');
  assert.equal(compareVersions('0.2.0-beta.16', config.version), -1);
  assert.equal(compareVersions(config.version, '0.3.0'), 0);
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.2.0-beta.16' }));
  await assert.rejects(releaseConfig(root), /versions differ/);
});

test('private package workflows consume the package release profile', async () => {
  for (const name of ['package-macos.yml', 'package-windows.yml', 'package-linux.yml']) {
    const workflow = await fs.readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert.match(workflow, /node scripts\/release\.mjs profile >> "\$GITHUB_OUTPUT"/);
    assert.match(workflow, /steps\.release\.outputs\.directory/);
    assert.match(workflow, /steps\.release\.outputs\.artifact_prefix/);
    assert.match(workflow, /steps\.release\.outputs\.packaged_test_argument/);
    assert.doesNotMatch(workflow, /--community-build/);
    assert.doesNotMatch(workflow, /release:begin -- dist(?:\s|$)/);
    assert.match(workflow, /workflow_call:/);
    assert.match(workflow, /ref: \$\{\{ inputs\.source_commit \}\}/);
    assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_COMMIT"/);
    assert.match(workflow, /if: github\.event\.repository\.private == true/);
    assert.match(workflow, /contents: read/);
    // Workflow-level concurrency is evaluated before jobs/matrices exist.
    // A matrix reference here invalidates this reusable workflow and its caller.
    const workflowConcurrency = workflow.match(/^concurrency:\n((?:[ \t]+.*\n)+)/m)?.[1];
    assert.ok(workflowConcurrency, 'Package runs must retain their concurrency guard');
    assert.doesNotMatch(workflowConcurrency, /matrix\./);
    assert.match(workflowConcurrency, /github\.ref/);
    assert.doesNotMatch(workflow, /gh release|npm publish|firebase deploy|gcloud storage/);
    // Founders is retired (private handoff, 2026-11-09): the founders-only
    // studio-v2 leg is gone; the community leg still runs the model-scan spec.
    assert.doesNotMatch(workflow, /studio-v2/);
    assert.match(workflow, /tests\/e2e\/model-scan\.spec\.js/);
  }
});

test('package dispatch builds every native package from the same source without publishing', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const platform of ['macos', 'windows', 'linux']) {
    assert.match(workflow, new RegExp(`uses: \\.\\/\\.github\\/workflows\\/package-${platform}\\.yml\\n    with:\\n      source_commit: \\$\\{\\{ github\\.sha \\}\\}`));
  }
  assert.doesNotMatch(workflow, /contents: write|gh release|firebase deploy|gcloud storage/);
});

test('release assembly requires every native receipt from one source and verifies every artifact', async t => {
  const root = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('add', '.');
  git('-c', 'user.name=Release fixture', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Release fixture');
  const sourceCommit = git('rev-parse', 'HEAD'), sourceTree = git('rev-parse', 'HEAD^{tree}');
  const output = path.join(root, 'dist'); await fs.mkdir(output);
  const input = await begin(root, output);
  await fs.writeFile(path.join(root, 'LICENSES.third-party.txt'), 'Generated native license fixture.');
  assert.equal((await generatedChanges(root, input))[0].filename, 'LICENSES.third-party.txt');
  await fs.writeFile(path.join(root, 'unreviewed-runtime.js'), 'export const fixture = true;');
  await assert.rejects(generatedChanges(root, input), /Application source changed/);
  await fs.rm(path.join(root, 'unreviewed-runtime.js'));
  for (const [platform, entries] of Object.entries(targets)) {
    const artifacts = [];
    for (const [format, suffix] of entries) {
      const filename = `FrostByte-0.3.0-${suffix}`;
      await fs.writeFile(path.join(output, filename), `Harmless ${platform} artifact fixture, ${format}.`);
      artifacts.push({ format, filename, ...await fingerprint(path.join(output, filename)) });
    }
    await fs.writeFile(path.join(output, `build-info-${platform}.json`), JSON.stringify({ schemaVersion: 1, version: '0.3.0', platform, sourceCommit, sourceTree, artifacts }));
  }
  const receiptFile = path.join(output, 'build-info-win32-x64.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile));
  await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, sourceCommit: 'f'.repeat(40) }));
  await assert.rejects(assemble(root, output), /different source revisions/);
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  const manifest = await assemble(root, output);
  assert.equal(manifest.artifacts.length, 7);
  assert.equal(manifest.sourceCommit, sourceCommit);
  assert.equal(manifest.sourceTag, 'v0.3.0');
  assert.deepEqual(await assemble(root, output), manifest, 'same bytes are idempotent');
  await fs.appendFile(path.join(output, receipt.artifacts[0].filename), 'changed');
  await assert.rejects(assemble(root, output), /does not match/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'release-manifest.json'))), manifest, 'published metadata remains unchanged on failure');
});
