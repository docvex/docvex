#!/usr/bin/env node
// scripts/landing-deploy.mjs
//
// Runs after `vite build` produces landing/dist/. Merges that static marketing
// site into docs/ — the GitHub Pages root that serves docvex.ro — WITHOUT
// clobbering the web SPA or its routing.
//
// docs/ is shared between two independently-built things:
//   • the marketing landing page (this script's payload, at the root)
//   • the React web app SPA (scripts/web-deploy.mjs, under docs/app/)
// plus a handful of hand-maintained files (CNAME, the invite page, the
// SPA-fallback 404.html, .nojekyll). Those are PROTECTED below and never
// touched here.
//
// Strategy: everything at the top level of docs/ that ISN'T protected is
// considered "landing-owned" and is wiped before each deploy, then
// repopulated from out/. That keeps stale hashed _next/ chunks and removed
// public assets from accumulating, while leaving the SPA + config intact.

import { spawnSync } from 'node:child_process';
import { readdir, rm, mkdir, cp, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const SRC = join(root, 'landing', 'dist');
const DEST = join(root, 'docs');
const PREFIX = '[landing-deploy]';

// Top-level docs/ entries owned by something other than the landing build.
// Never removed, never overwritten.
const PROTECTED = new Set([
  'app',            // the React web SPA (scripts/web-deploy.mjs)
  'CNAME',          // GitHub Pages custom domain
  '.nojekyll',      // lets _next/ + underscore files be served
  'invite.html',    // standalone invite-accept page
  '404.html',       // root SPA fallback (routes /app/* to the SPA, else → /)
  'favicon_old.ico',
]);

// Entries we must NOT copy into docs/ if a build ever emits them:
//   404.html — would clobber the protected SPA-fallback above. (Vite doesn't
//   emit one, but guard anyway so a stray build output can't break routing.)
const SKIP_FROM_OUT = new Set(['404.html']);

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function main() {
  if (!(await exists(SRC))) {
    console.error(`${PREFIX} ${SRC} does not exist — run \`npm run landing:build\` first.`);
    process.exit(1);
  }

  // 1. Wipe landing-owned top-level entries from docs/ (keep PROTECTED).
  const current = await readdir(DEST);
  for (const name of current) {
    if (PROTECTED.has(name)) continue;
    console.log(`${PREFIX} removing stale ${name}`);
    await rm(join(DEST, name), { recursive: true, force: true });
  }

  // 2. Copy the export into docs/ (skip the not-found artifacts).
  const produced = await readdir(SRC);
  let copied = 0;
  for (const name of produced) {
    if (SKIP_FROM_OUT.has(name)) continue;
    await cp(join(SRC, name), join(DEST, name), { recursive: true });
    copied += 1;
  }
  console.log(`${PREFIX} copied ${copied} top-level entries from out/ → docs/`);

  // Safety net: docs/ MUST keep these for the site to work at all.
  for (const must of ['app', 'CNAME', '.nojekyll']) {
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
