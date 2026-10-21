#!/usr/bin/env node
// Cut a release from CHANGELOG.md's "Unreleased" section.
//
//   npm run release -- patch    bug fixes and small tweaks
//   npm run release -- minor    new features
//   npm run release -- major    architectural changes
//
// Bumps the version in package.json, package-lock.json and
// extension/manifest.json, turns
// "## Unreleased" into "## [X.Y.Z] — <date>" (with a fresh empty Unreleased
// above it), commits "Release vX.Y.Z" and adds an annotated tag vX.Y.Z whose
// message is that changelog section. Push with: git push lab main --follow-tags

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!m) throw new Error(`not a MAJOR.MINOR.PATCH version: ${version}`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error('say patch, minor or major');
}

/** The changelog with Unreleased turned into `version`, and that section's text. */
export function cutChangelog(md, version, date) {
  const start = md.indexOf('\n## Unreleased');
  if (start < 0) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  const bodyStart = md.indexOf('\n', start + 1) + 1;
  const next = md.indexOf('\n## ', bodyStart - 1);
  const body = md.slice(bodyStart, next < 0 ? md.length : next + 1).trim();
  if (!body) throw new Error('Nothing under "## Unreleased": add what changed first');
  const rest = next < 0 ? '' : md.slice(next + 1);
  return {
    md: `${md.slice(0, start)}\n## Unreleased\n\n## [${version}] — ${date}\n\n${body}\n\n${rest}`.replace(/\n{3,}/g, '\n\n'),
    notes: body,
  };
}

function main() {
  const kind = process.argv[2];
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Commit or stash your changes first; a release commit holds only the version bump.');

  const pkgFile = resolve(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const version = bump(pkg.version, kind);
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  const clFile = resolve(ROOT, 'CHANGELOG.md');
  const { md, notes } = cutChangelog(readFileSync(clFile, 'utf8'), version, date);
  writeFileSync(clFile, md);
  pkg.version = version;
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  // The lock file names the version twice: at the top and for the root package.
  const lockFile = resolve(ROOT, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  const manFile = resolve(ROOT, 'extension/manifest.json');
  writeFileSync(manFile, readFileSync(manFile, 'utf8').replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));

  git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'extension/manifest.json');
  git('commit', '-q', '-m', `Release v${version}`);
  // verbatim: keep the changelog's "### Fixed" headings (git would strip them as comments).
  git('tag', '-a', `v${version}`, '--cleanup=verbatim', '-m', `v${version}\n\n${notes}`);
  console.log(`v${version} committed and tagged. Push with: git push lab main --follow-tags`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
