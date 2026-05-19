#!/usr/bin/env node
// scripts/sync-readme-version.mjs
//
// Runs in the npm `version` lifecycle hook (see package.json), which fires
// AFTER package.json has been bumped but BEFORE `npm version` makes its
// release commit. That ordering means anything we `git add` here gets folded
// into the same commit + tag that `npm version` is about to create — no
// commit amends, no separate "bump README" follow-up commit.
//
// Rewrites version-pinned references in README.md so the direct download
// link always points at the current release. Two patterns are touched:
//
//   - `v<MAJOR>.<MINOR>.<PATCH>` — release tag form, e.g. v2.1.0
//   - `docvex-<MAJOR>.<MINOR>.<PATCH>.Setup.exe` — installer filename form
//
// The patterns are specific enough to leave things like "Node 22+",
// "Electron 42", "React 19" untouched. Anything else version-bearing
// you add to the README, match one of these two shapes and it'll be
// kept in sync automatically.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PREFIX = '[sync-readme]';
const log = (...args) => console.log(PREFIX, ...args);

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const newVersion = pkg.version;
log(`bumping README references to v${newVersion}`);

const readmeUrl = new URL('../README.md', import.meta.url);
const before = readFileSync(readmeUrl, 'utf8');

const after = before
  .replace(/v\d+\.\d+\.\d+/g, `v${newVersion}`)
  .replace(/docvex-\d+\.\d+\.\d+\.Setup\.exe/g, `docvex-${newVersion}.Setup.exe`)
  // macOS zip filenames produced by scripts/make-mac-zips.mjs +
  // attached to the GitHub release by scripts/publish-mac-zips.mjs.
  // Shape: docvex-darwin-{x64|arm64}-X.Y.Z.zip
  .replace(/docvex-darwin-(x64|arm64)-\d+\.\d+\.\d+\.zip/g, `docvex-darwin-$1-${newVersion}.zip`);

if (after === before) {
  log('no version-pinned references found in README — nothing to do');
  process.exit(0);
}

writeFileSync(readmeUrl, after, 'utf8');
log('rewrote README.md');

// Stage the change so it lands in the release commit `npm version` is about
// to create. Without `git add`, the dirty README would be left in the
// working tree and the release commit would only contain package.json.
execSync('git add README.md', { stdio: 'inherit' });
log('staged README.md for the release commit');
