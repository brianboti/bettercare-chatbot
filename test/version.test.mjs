// Covers: version numbers: the release script's bump and changelog cut, and that every place showing the version agrees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bump, cutChangelog } from '../tools/release.mjs';
import { VERSION } from '../server/version.mjs';

test('bump: major resets minor and patch, minor resets patch', () => {
  assert.equal(bump('2.5.3', 'patch'), '2.5.4');
  assert.equal(bump('2.5.3', 'minor'), '2.6.0');
  assert.equal(bump('2.5.3', 'major'), '3.0.0');
  assert.throws(() => bump('2.5', 'patch'));
  assert.throws(() => bump('2.5.3', 'huge'));
});

test('release turns Unreleased into the new version and leaves an empty Unreleased', () => {
  const md = '# Changelog\n\nintro\n\n## Unreleased\n\n### Fixed\n- a bug\n\n## [1.0.0] — 2026-01-01\n\n- first\n';
  const { md: out, notes } = cutChangelog(md, '1.0.1', '2026-02-02');
  assert.equal(notes, '### Fixed\n- a bug');
  assert.match(out, /## Unreleased\n\n## \[1\.0\.1\] — 2026-02-02\n\n### Fixed\n- a bug\n\n## \[1\.0\.0\]/);
  assert.throws(() => cutChangelog('# C\n\n## Unreleased\n\n## [1.0.0] — x\n', '1.0.1', 'd'), /Nothing under/);
});

test('package.json, the extension and the changelog agree on the version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, VERSION);
  assert.ok(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').includes(`## [${VERSION}]`));
});

test('the version is MAJOR.MINOR.PATCH', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
