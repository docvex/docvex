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
  const commitLog = sh(
    `git log ${range} --no-merges --pretty=format:"- %s%n%b"`,
  );
  if (!commitLog) {
    log(`No commits since ${prevTag || 'initial commit'} — skipping summary.`);
    return;
  }

  log(`Summarising ${prevTag || '(initial)'} → ${tag}`);

  const prompt = `You are writing user-facing release notes for the Docvex desktop app.
The new release is ${tag} (previous: ${prevTag || 'first release'}).
Below are the git commits since the previous release. Group changes into
"### Added", "### Changed", and "### Fixed" sections (omit a section if
empty). Skip purely internal/chore/CI commits unless they're the only
content. Write one bullet per change, plain English, present tense.
Output Markdown only — no preamble, no closing sign-off.

Commits:
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
