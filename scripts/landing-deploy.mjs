#!/usr/bin/env node
// scripts/landing-deploy.mjs
//
// Assembles docs/ — the GitHub Pages root that serves docvex.ro — from two
// independently-authored marketing surfaces:
//
//   • landing/home/      → the CURRENT static homepage, served at the ROOT
//                          (docvex.ro/). Plain HTML/CSS/JS, no build step.
//   • landing/dist/      → the PREVIOUS React marketing site (built by
//                          `npm run landing:build`, base "/old/"), served at
//                          docvex.ro/old/.
//
// docs/ also hosts things this script must never touch:
//   • app/         — the React web app SPA (scripts/web-deploy.mjs)
//   • CNAME, .nojekyll, 404.html, invite.html, favicon.ico, favicon_old.ico
//
// Strategy: wipe + repopulate docs/old/ from the React build, then wipe the
// non-protected top-level entries and repopulate the root from landing/home/.

import { spawnSync } from 'node:child_process';
import { readdir, rm, mkdir, cp, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const HOME_SRC = join(root, 'landing', 'home');   // → docs/ (root)
const OLD_SRC = join(root, 'landing', 'dist');     // → docs/old/
const DEST = join(root, 'docs');
const OLD_DEST = join(DEST, 'old');
const PREFIX = '[landing-deploy]';

// Top-level docs/ entries owned by something other than the root homepage.
// Never removed, never overwritten by the root copy step.
const PROTECTED = new Set([
  'app',            // the React web SPA (scripts/web-deploy.mjs)
  'old',            // the previous marketing site (populated below)
  'CNAME',          // GitHub Pages custom domain
  '.nojekyll',      // lets _next/ + underscore files be served
  'invite.html',    // standalone invite-accept page
  '404.html',       // root SPA fallback (routes /app/* to the SPA, else → /)
  'favicon.ico',    // shared favicon (invite.html references it)
  'favicon_old.ico',
]);

// Never copy these from a source into docs/ (would clobber protected files).
const SKIP_FROM_SRC = new Set(['404.html', 'CNAME', '.nojekyll', '.DS_Store']);

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function copyTree(src, dest) {
  const entries = await readdir(src);
  let copied = 0;
  for (const name of entries) {
    if (SKIP_FROM_SRC.has(name)) continue;
    await cp(join(src, name), join(dest, name), { recursive: true });
    copied += 1;
  }
  return copied;
}

async function main() {
  if (!(await exists(HOME_SRC))) {
    console.error(`${PREFIX} ${HOME_SRC} does not exist.`);
    process.exit(1);
  }
  if (!(await exists(OLD_SRC))) {
    console.error(`${PREFIX} ${OLD_SRC} does not exist — run \`npm run landing:build\` first.`);
    process.exit(1);
  }

  // 1. Rebuild docs/old/ from the React build.
  await rm(OLD_DEST, { recursive: true, force: true });
  await mkdir(OLD_DEST, { recursive: true });
  const oldCopied = await copyTree(OLD_SRC, OLD_DEST);
  console.log(`${PREFIX} copied ${oldCopied} entries → docs/old/`);

  // 2. Wipe non-protected top-level entries, then repopulate the root from
  //    landing/home/.
  const current = await readdir(DEST);
  for (const name of current) {
    if (PROTECTED.has(name)) continue;
    console.log(`${PREFIX} removing stale ${name}`);
    await rm(join(DEST, name), { recursive: true, force: true });
  }
  const homeCopied = await copyTree(HOME_SRC, DEST);
  console.log(`${PREFIX} copied ${homeCopied} entries → docs/ (root)`);

  // Safety net: docs/ MUST keep these for the site to work at all.
  for (const must of ['app', 'CNAME', '.nojekyll', 'index.html']) {
    if (!(await exists(join(DEST, must)))) {
      console.warn(`${PREFIX} WARNING: docs/${must} is missing after deploy!`);
    }
  }

  // 3. Stage so a subsequent commit picks up the artifacts. Non-fatal.
  const addResult = spawnSync('git', ['add', 'docs'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (addResult.status !== 0) {
    console.warn(`${PREFIX} git add docs exited with code ${addResult.status} — stage manually if needed`);
  }

  console.log(`${PREFIX} done.`);
}

main().catch((err) => {
  console.error(`${PREFIX} fatal:`, err);
  process.exit(1);
});
