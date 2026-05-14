#!/usr/bin/env node
// scripts/upload-release-notes.mjs
//
// One-off uploader: takes a markdown file + a tag, finds the GitHub release
// with that tag (draft or published), and PATCHes its body with the file's
// contents. Companion to generate-release-notes.mjs but reads the body from
// disk instead of generating it.
//
// Usage:
//   node scripts/upload-release-notes.mjs <tag> <path-to-markdown>
//
// Requires GITHUB_TOKEN in env (same scope as electron-forge publish).

import { readFileSync } from 'node:fs';

const PREFIX = '[upload-release-notes]';
const log  = (...a) => console.log(PREFIX, ...a);
const warn = (...a) => console.warn(PREFIX, ...a);

const [tag, notesPath] = process.argv.slice(2);
if (!tag || !notesPath) {
  console.error(`Usage: node ${process.argv[1]} <tag> <path-to-markdown>`);
  process.exit(2);
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error(`${PREFIX} GITHUB_TOKEN not set; cannot update release body.`);
  process.exit(2);
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const repoUrl = pkg.repository?.url || '';
const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
if (!m) {
  console.error(`${PREFIX} Could not parse owner/repo from package.json repository.url:`, repoUrl);
  process.exit(2);
}
const [, owner, repo] = m;

const notes = readFileSync(notesPath, 'utf8');
if (!notes.trim()) {
  console.error(`${PREFIX} Notes file is empty: ${notesPath}`);
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'docvex-release-script',
};

// Draft releases aren't reliably reachable via /releases/tags/:tag, so list
// recent releases and match by tag_name OR name (electron-forge's GitHub
// publisher leaves tag_name="untagged-..." on drafts but sets name=v1.2.3).
const listRes = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`,
  { headers },
);
if (!listRes.ok) {
  console.error(`${PREFIX} Failed to list releases:`, listRes.status, await listRes.text());
  process.exit(1);
}
const releases = await listRes.json();
const release = releases.find((r) => r.tag_name === tag || r.name === tag);
if (!release) {
  console.error(`${PREFIX} No release found for tag ${tag}.`);
  console.error(`${PREFIX} Recent releases:`, releases.map((r) => `${r.name || r.tag_name} (id=${r.id}, draft=${r.draft})`).join(', '));
  process.exit(1);
}

log(`Found release id=${release.id}, draft=${release.draft}, name=${release.name}, tag_name=${release.tag_name}`);
log(`Uploading ${notes.length} chars from ${notesPath}…`);

const patchRes = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`,
  {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: notes }),
  },
);
if (!patchRes.ok) {
  console.error(`${PREFIX} Failed to patch release body:`, patchRes.status, await patchRes.text());
  process.exit(1);
}
const updated = await patchRes.json();
log(`Updated release ${updated.name || updated.tag_name} (${updated.html_url}).`);
