#!/usr/bin/env node
// scripts/fix-mac-release.mjs
//
// One-shot: rebuild the macOS artifacts for an EXISTING GitHub release ON A MAC
// (so they're validly ad-hoc signed) and replace that release's broken .zip
// assets in place.
//
// Why this exists
// ---------------
// macOS builds packaged on a NON-Mac host have their Electron fuses flipped
// AFTER the bundle is signed (forge.config.js's resetAdHocDarwinSignature can
// only re-sign on darwin). That leaves the Electron Framework's signature
// invalid, and on Apple Silicon the kernel SIGKILLs the app at launch
// ("Code Signature Invalid", crashing in fuses::IsRunAsNodeEnabled). Only a Mac
// can produce or repair the signature (codesign is macOS-only), so this script
// must run on a Mac. It packages → ad-hoc re-signs → verifies → zips → uploads,
// replacing the same-named assets on the target release.
//
// Usage
// -----
//   GITHUB_TOKEN=…  npm run fix:mac              # patch the "latest" release
//   GITHUB_TOKEN=…  npm run fix:mac -- v7.2.5    # patch a specific tag
//
// GITHUB_TOKEN needs `public_repo` scope. Only the two darwin .zip assets are
// touched — the Windows Setup.exe / nupkg / RELEASES assets are left alone.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '[fix-mac-release]';
const log = (...a) => console.log(PREFIX, ...a);
const die = (msg) => {
  console.error(PREFIX, 'ERROR:', msg);
  process.exit(1);
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const ARCHES = ['x64', 'arm64'];

if (process.platform !== 'darwin') {
  die('Must run on macOS — codesign is required to produce a launchable bundle.');
}
const token = process.env.GITHUB_TOKEN;
if (!token) die('GITHUB_TOKEN not set (needs public_repo scope).');

const repoUrl = pkg.repository?.url || '';
const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
if (!m) die(`Could not parse owner/repo from package.json repository.url: ${repoUrl}`);
const [, owner, repo] = m;

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'docvex-fix-mac-release',
};

// Run a child command inheriting stdio; abort the whole script on failure so a
// packaging/signing error never silently ships a broken asset.
function run(label, cmd, args, extraEnv = {}) {
  log(`─── ${label} ───`);
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
  });
  if (r.error) die(`${label} threw: ${r.error.message}`);
  if (r.status !== 0) die(`${label} exited with code ${r.status}.`);
}

async function resolveRelease(tagArg) {
  const url = tagArg
    ? `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tagArg)}`
    : `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    die(`Couldn't find ${tagArg ? `release for tag ${tagArg}` : 'the latest release'} (HTTP ${res.status}).`);
  }
  return res.json();
}

async function main() {
  const tagArg = process.argv[2] || null;
  const release = await resolveRelease(tagArg);
  const tag = release.tag_name;
  const version = String(tag).replace(/^v/, '').split('-')[0];
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    die(`Release tag "${tag}" isn't semver — refusing to guess a build version.`);
  }
  log(`Target release ${tag} (id=${release.id}); building bundles stamped v${version}.`);

  // 1 + 2. Package both arches at the release's version. DOCVEX_APP_VERSION is
  //        read by forge.config.js → electron-packager's appVersion, so the
  //        bundle reports v${version} and the updater won't re-prompt.
  for (const arch of ARCHES) {
    run(`electron-forge package darwin/${arch}`, 'electron-forge',
      ['package', '--platform=darwin', `--arch=${arch}`],
      { DOCVEX_APP_VERSION: version });
  }

  // 3. Re-sign (ad-hoc) + verify + zip. MAC_ZIP_VERSION pins the zip filename to
  //    the release version so the produced names match the assets we replace.
  run('make-mac-zips (re-sign + verify + zip)', 'node',
    ['scripts/make-mac-zips.mjs'], { MAC_ZIP_VERSION: version });

  const zips = ARCHES.map((arch) =>
    join(repoRoot, 'out', 'make', 'zip', 'darwin', arch, `${pkg.name}-darwin-${arch}-${version}.zip`),
  );
  for (const z of zips) {
    try { statSync(z); } catch { die(`Expected zip missing: ${z}`); }
  }

  // 4. Replace the release's same-named assets (delete then upload — GitHub
  //    422s on duplicate names).
  const assetsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`,
    { headers },
  );
  const existing = assetsRes.ok ? await assetsRes.json() : [];

  for (const zip of zips) {
    const name = zip.split('/').pop();
    const size = statSync(zip).size;

    const dup = existing.find((a) => a.name === name);
    if (dup) {
      log(`Deleting old asset ${name} (id=${dup.id})`);
      const del = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/releases/assets/${dup.id}`,
        { method: 'DELETE', headers },
      );
      if (!del.ok && del.status !== 404) {
        die(`Failed to delete ${name}: ${del.status} ${await del.text()}`);
      }
    }

    // Use the release's server-provided upload_url (strip the {?name,label}
    // template) rather than a hardcoded uploads.github.com host. If the repo
    // was ever renamed/transferred GitHub 307-redirects the hardcoded host,
    // and Node's fetch can't replay a streamed body across a redirect — so it
    // surfaces the 307 as a failure. The upload_url is already canonical.
    const uploadBase = (release.upload_url || '').replace(/\{[^}]*\}$/, '')
      || `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets`;

    log(`Uploading ${name} (${(size / 1048576).toFixed(1)} MB)…`);
    const up = await fetch(
      `${uploadBase}?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/zip', 'Content-Length': String(size) },
        body: createReadStream(zip),
        duplex: 'half', // Node requires this for a streamed request body.
      },
    );
    if (!up.ok) die(`Upload failed for ${name}: ${up.status} ${await up.text()}`);
    const asset = await up.json();
    log(`Uploaded → ${asset.browser_download_url}`);
  }

  log(`Done — ${tag} now ships working, ad-hoc-signed macOS builds.`);
}

main().catch((e) => die(e?.stack || e?.message || String(e)));
