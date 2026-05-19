#!/usr/bin/env node
// scripts/publish-mac-zips.mjs
//
// Release-time companion to make-mac-zips.mjs. Wired into post-release.mjs
// so `npm run release:*` uploads macOS artifacts alongside the Windows
// installer that electron-forge publish already drops on the draft GitHub
// release.
//
// Why this is a separate script (and not just a maker run by
// `electron-forge publish`):
//   1. The bundled zip maker (`@electron-forge/maker-zip`) uses cross-zip
//      under the hood, which can't traverse the symlinks inside
//      `Electron Framework.framework` on Windows hosts and aborts the
//      whole `make` run. `make-mac-zips.mjs` already works around that
//      with the `archiver` library — we just call it.
//   2. The GitHub publisher only uploads artifacts produced in the same
//      `electron-forge publish` invocation. To attach extra files we
//      have to PATCH/POST to the GitHub API directly.
//
// Run order this script assumes:
//   1. `electron-forge publish` already ran and created the draft release
//      for v${pkg.version}. (post-release.mjs guarantees this.)
//   2. GITHUB_TOKEN is set (already required for publish).
//
// Steps:
//   1. `electron-forge package --platform=darwin --arch=x64`
//   2. `electron-forge package --platform=darwin --arch=arm64`
//   3. `node scripts/make-mac-zips.mjs` — produces the two .zip files.
//   4. Look up the draft release on GitHub, delete any pre-existing assets
//      with the same names (so re-runs are idempotent), then upload.
//
// Failures here are non-fatal at the post-release.mjs level — they get
// logged and the release ships without Mac builds rather than rolling
// back the Windows release.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '[publish-mac-zips]';
const log = (...args) => console.log(PREFIX, ...args);
const warn = (...args) => console.warn(PREFIX, ...args);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const ARCHES = ['x64', 'arm64'];

function run(label, cmd, args) {
  log(`─── ${label} ───`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: repoRoot,
    // shell:true on Windows for .cmd shim resolution (CVE-2024-27980).
    shell: process.platform === 'win32',
  });
  if (result.error) {
    warn(`${label} threw:`, result.error.message);
    return false;
  }
  if (result.status !== 0) {
    warn(`${label} exited with code ${result.status}.`);
    return false;
  }
  return true;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    warn('GITHUB_TOKEN not set — cannot upload Mac zips. Skipping.');
    return;
  }

  // 1 + 2. Package darwin .app bundles for both arches. Use `package`
  //         instead of `make` so we don't fight the broken zip maker.
  for (const arch of ARCHES) {
    const ok = run(
      `electron-forge package darwin ${arch}`,
      'electron-forge',
      ['package', '--platform=darwin', `--arch=${arch}`],
    );
    if (!ok) {
      warn(`Packaging darwin/${arch} failed — skipping Mac upload.`);
      return;
    }
  }

  // 3. Zip the .app bundles using the symlink-aware archiver script.
  if (!run('make-mac-zips', 'node', ['scripts/make-mac-zips.mjs'])) {
    warn('make-mac-zips failed — skipping upload.');
    return;
  }

  // Collect the produced zip paths.
  const zipPaths = ARCHES.map((arch) =>
    join(repoRoot, 'out', 'make', 'zip', 'darwin', arch, `${pkg.name}-darwin-${arch}-${VERSION}.zip`),
  ).filter((p) => {
    try {
      statSync(p);
      return true;
    } catch {
      warn(`Missing expected zip: ${p}`);
      return false;
    }
  });
  if (zipPaths.length === 0) {
    warn('No Mac zips produced — nothing to upload.');
    return;
  }

  // 4. Find the draft release and upload.
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

  // electron-forge's GitHub publisher creates the draft with name=v1.2.3
  // but leaves tag_name="untagged-..." until the user clicks Publish.
  // Match on either so this works pre- and post-publish.
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
    warn(`No release found for tag ${TAG}. Did electron-forge publish complete?`);
    return;
  }

  // Pull the existing asset list so we can delete same-named assets first
  // (GitHub returns 422 on duplicate names). Lets the script be re-run
  // after a partial failure without manual cleanup.
  const assetsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`,
    { headers },
  );
  const existingAssets = assetsRes.ok ? await assetsRes.json() : [];

  for (const zipPath of zipPaths) {
    const name = zipPath.split(/[\\/]/).pop();
    const size = statSync(zipPath).size;

    const dup = existingAssets.find((a) => a.name === name);
    if (dup) {
      log(`Deleting existing asset ${name} (id=${dup.id}) before re-upload`);
      const delRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/releases/assets/${dup.id}`,
        { method: 'DELETE', headers },
      );
      if (!delRes.ok && delRes.status !== 404) {
        warn(`Failed to delete existing asset ${name}:`, delRes.status, await delRes.text());
        continue;
      }
    }

    log(`Uploading ${name} (${(size / (1024 * 1024)).toFixed(1)} MB)…`);
    const uploadRes = await fetch(
      `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/zip',
          'Content-Length': String(size),
        },
        body: createReadStream(zipPath),
        // Node fetch requires duplex:'half' for streamed request bodies.
        duplex: 'half',
      },
    );
    if (!uploadRes.ok) {
      warn(`Upload failed for ${name}:`, uploadRes.status, await uploadRes.text());
      continue;
    }
    const asset = await uploadRes.json();
    log(`Uploaded ${name} → ${asset.browser_download_url}`);
  }

  log(`Done — Mac builds attached to ${TAG}.`);
}

main().catch((err) => {
  // Best-effort — never block the rest of the release.
  warn('Unhandled error:', err);
});
