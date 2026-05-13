#!/usr/bin/env node
// scripts/web-deploy.mjs
//
// Runs after `vite build --config vite.web.config.mjs` produces dist-web/.
// Copies that output into docs/app/ where GitHub Pages serves it from at
// docvex.ro/app/. The web build's Vite config emits index.html at the
// root of dist-web (rolled-up from index.web.html → index.html), so the
// destination layout is docs/app/index.html, docs/app/assets/…, etc.
//
// SPA fallback: GitHub Pages serves 404.html for any path that doesn't
// match a file. We copy index.html → 404.html inside docs/app/ so any
// /app/<unknown> path gets served the SPA shell, and BrowserRouter
// (basename="/app") takes over the routing client-side. No redirector
// script needed — the SPA reads the actual URL from window.location.

import { spawnSync } from 'node:child_process';
import { readdir, rm, mkdir, cp, copyFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const SRC = join(root, 'dist-web');
const DEST = join(root, 'docs', 'app');
const PREFIX = '[web-deploy]';

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function main() {
  if (!(await exists(SRC))) {
    console.error(`${PREFIX} ${SRC} does not exist — did the vite build step run?`);
    process.exit(1);
  }

  // Clear stale docs/app/ contents so removed files don't linger from a
  // previous build. We replace the whole directory rather than rm-then-mkdir
  // so a concurrent reader (rare here, but cheap to handle) sees one of the
  // two consistent states.
  console.log(`${PREFIX} clearing ${DEST}`);
  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });

  // node 16.7+ recursive cp works on Windows + POSIX.
  console.log(`${PREFIX} copying ${SRC} → ${DEST}`);
  await cp(SRC, DEST, { recursive: true });

  // SPA fallback for GitHub Pages — see file header.
  const indexHtml = join(DEST, 'index.html');
  const fallback404 = join(DEST, '404.html');
  if (await exists(indexHtml)) {
    console.log(`${PREFIX} writing SPA fallback ${fallback404}`);
    await copyFile(indexHtml, fallback404);
  } else {
    console.warn(`${PREFIX} no index.html in dist-web — SPA fallback skipped`);
  }

  // Stage in git so a subsequent `git commit` pulls in the build artifacts.
  // Non-fatal — if this is run in a non-git context (preview, CI), just log.
  const addResult = spawnSync('git', ['add', 'docs/app'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (addResult.status !== 0) {
    console.warn(`${PREFIX} git add docs/app exited with code ${addResult.status} — stage manually if needed`);
  }

  // Sanity print — what we shipped.
  const files = await readdir(DEST);
  console.log(`${PREFIX} done — ${files.length} top-level entries in docs/app/`);
}

main().catch((err) => {
  console.error(`${PREFIX} fatal:`, err);
  process.exit(1);
});
