#!/usr/bin/env node
// scripts/generate-release-notes.mjs
//
// Runs as the last step of `npm run release:*` (wired into the `postversion`
// hook in package.json, after `electron-forge publish`). It:
//   1. Reads the commits between the previous tag and the freshly-created tag.
//   2. Asks Claude — via the local `claude` CLI — for a user-facing changelog.
//   3. PATCHes the body of the draft GitHub release that publish just created.
//
// Best-effort by design: any failure here is logged and swallowed so it
// doesn't block the release. The draft release on GitHub still has to be
// manually published before update.electronjs.org surfaces it.
//
// Requires:
//   - `claude` CLI on PATH (Claude Code installation; no extra API key needed).
//   - GITHUB_TOKEN env var (already required by electron-forge publish).

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PREFIX = '[release-notes]';
const log = (...args) => console.log(PREFIX, ...args);
const warn = (...args) => console.warn(PREFIX, ...args);

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

async function main() {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const tag = `v${pkg.version}`;

  // `npm version` creates a commit + tag at HEAD, so the *previous* release
  // tag is whatever's reachable from HEAD~1.
  let prevTag = '';
  try {
    prevTag = sh('git describe --tags --abbrev=0 HEAD~1');
  } catch {
    // First release ever — fine, fall through to whole-history log.
  }

  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  // --stat gives Claude per-commit file-change context so it can infer which
  // surface each change touches (e.g. files in src/pages/Notifications →
  // "the notification history page") and write richer, more grounded bullets
  // than the bare commit subject alone allows. The `=== %s ===` delimiter
  // makes commit boundaries unambiguous when stat blocks land between them.
  //
  // Pathspec exclusions strip:
  //   - docs/        → the gh-pages web-build artifacts (regenerated every
  //                    release by `web:build`; pure hash-renamed bundles, no
  //                    semantic signal — would otherwise flood the stat with
  //                    50+ "Foo-AbCd1234.js → Foo-Wx9z5678.js" lines)
  //   - package-lock.json → dep-bump churn that Claude can rarely turn into
  //                    a user-facing note; mention it via commit subject if
  //                    it matters
  const commitLog = sh(
    `git log ${range} --no-merges --stat --pretty=format:"%n=== %s ===%n%b" -- . ":(exclude)docs" ":(exclude)package-lock.json"`,
  );
  if (!commitLog) {
    log(`No commits since ${prevTag || 'initial commit'} — skipping summary.`);
    return;
  }

  log(`Summarising ${prevTag || '(initial)'} → ${tag}`);

  const prompt = `You are writing detailed user-facing release notes for Docvex, a desktop document-management app built on Electron + React + Supabase. Users of these notes are the people who run the app, not engineers — they want to know what's new, what's better, and what's fixed, in concrete terms.

The new release is ${tag} (previous: ${prevTag || 'first release'}).

Below are the git commits since the previous release, each followed by the list of files it touched (a "diffstat"). Use the file paths to ground your descriptions — e.g. changes under src/pages/Notifications/ are about the notification history page; src/components/FileDetailModal* is the file-preview modal; supabase/migrations/* is database / backend schema; src/main.js + src/preload.js are the desktop shell.

Produce thorough, informative release notes with this structure:

## Summary
Open with ONE concise sentence (≤ 25 words) capturing the headline theme — what a user would tell a colleague this version is "about." Pick the single strongest through-line; don't enumerate changes, don't list multiple themes, don't pad.

## Sections
Then list the changes under these headings, omitting any that are empty:

### ✨ New features
### 🔧 Improvements
### 🐛 Bug fixes
### 🔒 Security & infrastructure

For each entry:
- Lead with a **short bold phrase** naming the change.
- Follow with 1–3 sentences explaining what changed, where in the app it shows up, and why a user would care. Name UI surfaces concretely ("the notification history page", "the file detail modal", "the DEBUG menu in the menu bar", "the Projects → Roles tab"). When behavior changed, describe the before → after in user terms.
- Merge multiple commits into one bullet when they implement a single user-visible change (e.g. a feature added across several commits).
- Skip purely internal/chore/CI/refactor commits UNLESS they have a user-visible effect (a release-tooling fix that means notes now arrive, a build fix that unbroke a workflow, etc.).

Style rules:
- Plain present-tense English. No release-engineer jargon, no "bumped", no "refactored X to Y". Translate engineering changes into user impact.
- Don't quote commit hashes, filenames, or function names. Refer to features by the name a user would see in the UI.
- Don't pad — but don't be stingy either. If a change is meaningful, give it the 2–3 sentences it deserves.
- Output Markdown only. No preamble like "Here are the notes:", no closing sign-off, no triple-backtick wrapping the whole document.

Commits with file changes:
${commitLog}`;

  // Claude CLI in non-interactive print mode. Two Windows-specific gotchas
  // we have to dodge here:
  //   1. shell: true is required for .cmd shims (Node 22 hardening,
  //      CVE-2024-27980) — direct spawn of claude.cmd returns EINVAL.
  //   2. cmd.exe mangles multi-line argument strings (newlines become
  //      command separators), so the prompt CANNOT be a CLI arg.
  // The fix: keep shell: true so the .cmd shim resolves, but pipe the
  // prompt over stdin so it never hits the shell parser. Only short,
  // safe args (-p, --output-format, text) go through the shell.
  const claude = spawnSync(
    'claude',
    ['-p', '--output-format', 'text'],
    {
      encoding: 'utf8',
      input: prompt,
      shell: process.platform === 'win32',
    },
  );

  if (claude.status !== 0) {
    warn('claude CLI failed:', claude.stderr || claude.error?.message || `exit ${claude.status}`);
    return;
  }
  const notes = (claude.stdout || '').trim();
  if (!notes) {
    warn('Empty summary from claude CLI; leaving release body untouched.');
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    warn('GITHUB_TOKEN not set; cannot update release body. Generated notes:\n' + notes);
    return;
  }

  const repoUrl = pkg.repository?.url || '';
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) {
    warn('Could not parse owner/repo from package.json repository.url:', repoUrl);
    return;
  }
  const [, owner, repo] = m;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'docvex-release-script',
  };

  // Draft releases aren't reliably reachable via /releases/tags/:tag, so list
  // recent releases and match by tag_name.
  const listRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`,
    { headers },
  );
  if (!listRes.ok) {
    warn('Failed to list releases:', listRes.status, await listRes.text());
    return;
  }
  const releases = await listRes.json();
  // electron-forge's GitHub publisher creates the draft with name=v1.2.3 but
  // leaves tag_name="untagged-..." until the user clicks Publish on github.com.
  // Match on either so we patch the right draft pre- and post-publish.
  const release = releases.find((r) => r.tag_name === tag || r.name === tag);
  if (!release) {
    warn(`No release found for tag ${tag}. Did electron-forge publish complete?`);
    return;
  }

  const patchRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: notes }),
    },
  );
  if (!patchRes.ok) {
    warn('Failed to patch release body:', patchRes.status, await patchRes.text());
    return;
  }

  log(`Updated draft release ${tag} with AI-generated notes (${notes.length} chars).`);
}

main().catch((err) => {
  // Best-effort — never fail the release.
  warn('Unhandled error:', err);
});
