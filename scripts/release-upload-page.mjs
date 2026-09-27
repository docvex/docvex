#!/usr/bin/env node
// scripts/release-upload-page.mjs
//
// Runs in the npm `version` lifecycle hook (package.json), beside
// sync-readme-version — so every `npm run release:patch | minor | major`
// also ships the phone upload page (docvex.ro/upload.html, the "Any
// connection" QR code's page) as it is in the source:
//
//   1. rebuilds landing/home/upload.html from src/lib/phoneUploadPage.js
//      (scripts/build-upload-page.mjs);
//   2. copies it — and robots.txt, which keeps it out of search results —
//      into docs/, the GitHub Pages root;
//   3. stages all three, so they land in the release commit `npm version` is
//      about to make; postversion's `git push` then publishes them.
//
// ONLY these files: a full `site:deploy` would also publish whatever else is
// in progress on the website, which a release of the app must not do.

import { copyFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PREFIX = '[release-upload-page]';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

execSync('node scripts/build-upload-page.mjs', { cwd: root, stdio: 'inherit' });
const files = ['upload.html', 'robots.txt'];
for (const f of files) {
  await copyFile(join(root, 'landing', 'home', f), join(root, 'docs', f));
  console.log(`${PREFIX} copied ${f} → docs/`);
}
if (process.argv.includes('--no-stage')) { console.log(`${PREFIX} --no-stage: not staged`); process.exit(0); }
execSync(`git add ${files.map((f) => `landing/home/${f} docs/${f}`).join(' ')}`, { cwd: root, stdio: 'inherit' });
console.log(`${PREFIX} staged for the release commit`);
