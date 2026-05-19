#!/usr/bin/env node
// scripts/post-release.mjs
//
// Orchestrates the "after npm version" steps so a failure in one step
// doesn't cascade and skip the rest. Previously package.json wired these
// up via `&&` chaining, which meant a non-fatal hiccup in
// `electron-forge publish` (asset upload retry, transient 502 from
// GitHub's release API, etc.) silently skipped generate-release-notes
// and the release shipped with an empty body.
//
// This script runs every step regardless of the others' exit codes,
// logs an error per failed step (so dev still sees what went wrong),
// and exits non-zero only if EVERYTHING fails — npm's own postversion
// hook then surfaces that without blocking the release that already
// went out.

import { spawnSync } from 'node:child_process';

const PREFIX = '[post-release]';

function run(label, cmd, args) {
  console.log(`\n${PREFIX} ─── ${label} ───`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    // shell:true on Windows for .cmd shim resolution (CVE-2024-27980).
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`${PREFIX} ${label} threw:`, result.error.message);
    return false;
  }
  if (result.status !== 0) {
    console.warn(`${PREFIX} ${label} exited with code ${result.status} — continuing to next step.`);
    return false;
  }
  return true;
}

// Each step is independent — push doesn't require notes to have run,
// notes don't require publish to have succeeded (publish creates the
// draft release on first asset upload; notes patches the body whether
// later assets uploaded or not).
//
// publish-mac-zips runs AFTER publish (it needs the draft release to
// exist so it has somewhere to upload to) but BEFORE notes (so the
// notes patch is the last thing that touches the release body).
const results = [
  run('git push --follow-tags', 'git', ['push', '--follow-tags']),
  run('electron-forge publish',  'electron-forge', ['publish']),
  run('publish-mac-zips',        'node', ['scripts/publish-mac-zips.mjs']),
  run('generate-release-notes',  'node', ['scripts/generate-release-notes.mjs']),
];

const failures = results.filter((ok) => !ok).length;
if (failures === results.length) {
  console.error(`${PREFIX} All ${results.length} steps failed.`);
  process.exit(1);
}
if (failures > 0) {
  console.warn(`${PREFIX} ${failures}/${results.length} step(s) failed — see above.`);
}
