#!/usr/bin/env node
// scripts/finalize-release.mjs
//
// Runs at the very end of post-release.mjs, AFTER electron-forge publish +
// publish-mac-zips + generate-release-notes have all done their thing. Its
// only job is to turn the draft release into a real, properly-tagged one so
// the user doesn't have to click "Publish release" on github.com by hand.
//
// Why this matters:
//   forge.config.js sets `draft: true` on the GitHub publisher so the
//   release stays hidden while assets stream in (avoids users seeing a
//   half-uploaded release). The intended workflow was for the developer
//   to click Publish in the UI once everything looked right — but that
//   step gets skipped, and when it does the release stays at GitHub's
//   `untagged-<sha>` pseudo-tag instead of `v<version>`. Consequences:
//     - README's /releases/download/v<version>/... URLs 404
//     - update.electronjs.org returns 204 (no update served)
//     - GitHub's "Latest release" sidebar lags
//
// This script PATCHes the release to:
//   { tag_name: 'v<version>', name: 'v<version>', draft: false }
// GitHub then binds to the existing git tag (which `npm version` already
// pushed via post-release.mjs's `git push --follow-tags`) and the release
// goes live.
//
// Best-effort: failures here log a warning and exit 0, so the release
// still ships even if this step hiccups — the manual UI fallback always
// works.

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '[finalize-release]';
const log = (...a) => console.log(PREFIX, ...a);
const warn = (...a) => console.warn(PREFIX, ...a);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    warn('GITHUB_TOKEN not set — skipping. Publish the draft manually on github.com.');
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

  // electron-forge's publisher creates the draft with name=v<version> but
  // leaves tag_name="untagged-<sha>" until publish. Match by name so we
  // find it before the tag is bound.
  const listRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`,
    { headers },
  );
  if (!listRes.ok) {
    warn('Failed to list releases:', listRes.status, await listRes.text());
    return;
  }
  const releases = await listRes.json();
  const release = releases.find((r) => r.tag_name === TAG || r.name === TAG);
  if (!release) {
    warn(`No release found for ${TAG}. Did electron-forge publish complete?`);
    return;
  }

  // Idempotent: if it's already bound to the right tag AND already published,
  // there's nothing to do. Saves a no-op PATCH on re-runs.
  if (release.tag_name === TAG && release.draft === false) {
    log(`Release ${TAG} already finalized — nothing to do.`);
    return;
  }

  log(`Finalizing release id=${release.id}: tag_name=${release.tag_name} → ${TAG}, draft=${release.draft} → false`);

  const patchRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: TAG, name: TAG, draft: false }),
    },
  );
  if (!patchRes.ok) {
    warn(`PATCH failed: ${patchRes.status} ${await patchRes.text()}`);
    return;
  }
  const updated = await patchRes.json();
  log(`Done — ${updated.html_url}`);
}

main().catch((err) => warn('Unhandled error:', err));
