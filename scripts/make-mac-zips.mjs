#!/usr/bin/env node
// scripts/make-mac-zips.mjs
//
// Cross-platform macOS .app → .zip post-build step. Replaces the
// PowerShell-based zipper that `@electron-forge/maker-zip` invokes on
// Windows hosts (via cross-zip → [IO.Compression.ZipFile]), which
// cannot traverse the symlinks inside `Electron Framework.framework`
// and fails with:
//
//   Access to the path '...\Electron Framework.framework\Resources'
//   is denied.
//
// Reads the `.app` bundles electron-packager wrote to
// `out/docvex-darwin-<arch>/docvex.app` and produces:
//
//   out/make/zip/darwin/<arch>/docvex-darwin-<arch>-<version>.zip
//
// using the `archiver` library, which stores symlinks AS symlinks
// (mode bits + linkname recorded inside the zip's Unix extra field).
// macOS's Finder + Squirrel unpack honor those so the unzipped .app
// has its framework symlinks intact and the binary runs.
//
// Invoked manually after `npm run make -- --platform=darwin` succeeds
// at packaging but fails at zipping. Safe to re-run idempotently —
// existing zips are overwritten.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
// MAC_ZIP_VERSION lets the release-patch flow (scripts/fix-mac-release.mjs) pin
// the zip filename to the release being fixed, which may differ from
// package.json#version. Defaults to package.json for the normal release flow.
const VERSION = process.env.MAC_ZIP_VERSION || pkg.version;
const APP_NAME = pkg.productName || pkg.name;

const ARCHES = ['x64', 'arm64'];

// On non-macOS hosts, Node's `fs.lstatSync(...).mode` reports 0o666 for every
// regular file because Windows / Linux file systems don't track macOS-style
// executable bits the way HFS+/APFS do. If we forward those modes straight
// into the zip, the unpacked .app on macOS has no +x on its Mach-O binaries,
// Launch Services refuses to treat the folder as a launchable bundle, and
// Safari shows "no available application can open it" — even though the
// bundle's directory structure is correct. This helper restores +x for the
// files macOS actually needs to execute.
const isMacHost = process.platform === 'darwin';

// When APPLE_SIGNING_IDENTITY is set, forge.config.js had electron-packager
// sign the app with a Developer ID cert + Hardened Runtime and (creds allowing)
// notarize + staple it. In that case we must NOT ad-hoc re-sign here — that
// would strip the Developer ID signature and invalidate the notarization,
// re-triggering the "Apple could not verify …" Gatekeeper block. Instead we
// just verify the Developer ID signature + stapled ticket, then zip as-is.
const DEVELOPER_ID_SIGNED = isMacHost && !!process.env.APPLE_SIGNING_IDENTITY;

function modeForFile(rel, statMode) {
  if (isMacHost) return statMode;
  const needsExec =
    // Main executable + Squirrel/CrashHelper/etc under Contents/MacOS/.
    /(^|\/)Contents\/MacOS\//.test(rel) ||
    // Shared libraries — dyld requires +x to map them.
    rel.endsWith('.dylib') ||
    // Framework binary `<Foo>.framework/Versions/<v>/<Foo>` AND the bare
    // helpers under `<Foo>.framework/Versions/<v>/Helpers/<exe>` such as
    // chrome_crashpad_handler — both are extension-less Mach-O binaries.
    /\.framework\/Versions\/[^/]+\/(Helpers\/)?[^/.]+$/.test(rel);
  // Use the file-type bits (0o100000) so unzip on macOS interprets the entry
  // as a regular file rather than guessing from the lower 9 bits alone.
  return needsExec ? 0o100755 : 0o100644;
}

async function zipApp(arch) {
  const appFolder = path.join(repoRoot, 'out', `${pkg.name}-darwin-${arch}`);
  const appPath = path.join(appFolder, `${APP_NAME}.app`);
  if (!fs.existsSync(appPath)) {
    console.warn(`[make-mac-zips] no .app at ${appPath} — did electron-packager finish for ${arch}?`);
    return null;
  }
  const outDir = path.join(repoRoot, 'out', 'make', 'zip', 'darwin', arch);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${pkg.name}-darwin-${arch}-${VERSION}.zip`);
  // Wipe any half-written prior attempt so we don't append into it.
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  // ── macOS host: ad-hoc re-sign + verify + zip with native tools ──────────
  // electron-forge's FusesPlugin flips fuse bytes AFTER the bundle is (linker)
  // ad-hoc signed, leaving the Electron Framework's signature invalid; on Apple
  // Silicon the kernel SIGKILLs such an app at launch ("Code Signature
  // Invalid", crashing in fuses::IsRunAsNodeEnabled). A full `codesign --deep`
  // re-sign repairs it. We do the work on a copy in a NON-iCloud temp dir
  // because codesign rejects the com.apple.FinderInfo xattr that an
  // iCloud-synced build folder keeps re-applying ("resource fork ... detritus
  // not allowed"). ditto handles the copy + final zip, preserving the framework
  // symlinks and the fresh signature.
  // ── macOS host, Developer ID build: verify + zip AS-IS (no re-sign) ──────
  if (DEVELOPER_ID_SIGNED) {
    // The app is already signed with the Developer ID cert and (if creds were
    // present) notarized + stapled by electron-packager. Confirm both before
    // shipping so a mis-signed or un-notarized bundle fails the build loudly
    // rather than silently reproducing the Gatekeeper prompt for users.
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
    // spctl is the authoritative Gatekeeper check; "source=Notarized Developer
    // ID" is what we want. It's informative (some setups assess differently),
    // so log its verdict but don't hard-fail on a non-zero exit.
    try {
      execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], { stdio: 'inherit' });
    } catch {
      console.warn(`[make-mac-zips] ${arch}: spctl assessment non-clean — check notarization creds were set at package time.`);
    }
    // stapler validate fails if the notarization ticket isn't stapled into the
    // bundle. If notarization was intentionally skipped (sign-only run), this
    // will fail — surface it as a warning rather than blocking a sign-only zip.
    try {
      execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
      console.log(`[make-mac-zips] ${arch}: Developer ID signed + notarization stapled ✓`);
    } catch {
      console.warn(`[make-mac-zips] ${arch}: no stapled notarization ticket — build is signed but NOT notarized; users will still hit Gatekeeper. Set notarization creds and rebuild.`);
    }
    // ditto to a temp copy then zip, so a com.apple.FinderInfo xattr from an
    // iCloud-synced out/ folder doesn't ride along into the archive.
    execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, outPath]);
    const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
    console.log(`[make-mac-zips] wrote ${outPath} (${sizeMB} MB)`);
    return outPath;
  }

  if (isMacHost) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docvex-sign-'));
    try {
      const tmpApp = path.join(work, `${APP_NAME}.app`);
      execFileSync('ditto', [appPath, tmpApp]);
      execFileSync('xattr', ['-cr', tmpApp]); // strip FinderInfo/resource forks
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', tmpApp], { stdio: 'inherit' });
      // Verify before zipping so we NEVER ship a bundle Apple Silicon would
      // kill. --strict rejects the exact modified-signature state the fuse flip
      // produced; this throws (fails the build) on an invalid signature.
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=1', tmpApp], { stdio: 'inherit' });
      console.log(`[make-mac-zips] ${arch}: re-signed ad-hoc + verified ✓`);
      // --keepParent makes the archive's top entry `<AppName>.app/…`, matching
      // what Finder / Squirrel / the auto-updater expect on extraction.
      execFileSync('ditto', ['-c', '-k', '--keepParent', tmpApp, outPath]);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
    console.log(`[make-mac-zips] wrote ${outPath} (${sizeMB} MB)`);
    return outPath;
  }

  // ── Non-macOS host: zip with archiver (can't sign — codesign is mac-only) ──
  // Such a zip WILL be SIGKILLed on Apple Silicon, so always publish the macOS
  // artifacts from a Mac. We still produce it to keep the cross-platform make
  // path unbroken and for CI smoke tests.
  console.warn(`[make-mac-zips] ${arch}: not on macOS — cannot ad-hoc re-sign; this zip will be killed on launch by Apple Silicon. Build/publish macOS artifacts on a Mac.`);
  console.log(`[make-mac-zips] zipping ${arch}: ${appPath} → ${outPath}`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    // Deflate compression at level 6 — a touch slower than store mode
    // but the auto-updater downloads these, so smaller file wins.
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => {
      // ENOENT here usually means a transient lstat race during
      // packaging — non-fatal, log it.
      if (err.code === 'ENOENT') console.warn(`[make-mac-zips] ${err.message}`);
      else reject(err);
    });
    archive.on('error', reject);

    archive.pipe(output);

    // Walk the .app tree ourselves so we can detect symlinks via
    // lstat (archiver's directory() helper follows symlinks instead
    // of preserving them, which is the whole bug we're working
    // around — the framework's Resources/Helpers/Libraries/etc
    // entries MUST stay as symlinks for the .app to function).
    function walk(absDir, relRoot) {
      for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const abs = path.join(absDir, entry.name);
        const rel = path.posix.join(relRoot, entry.name);
        // Use lstat so symlinks are detected BEFORE we'd otherwise
        // resolve through them.
        const stat = fs.lstatSync(abs);
        if (stat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(abs);
          archive.symlink(rel, linkTarget, stat.mode);
        } else if (stat.isDirectory()) {
          walk(abs, rel);
        } else if (stat.isFile()) {
          // On macOS hosts stat.mode is honest; on Windows / Linux it's
          // always 0o666 so we infer +x from the path (see modeForFile).
          archive.file(abs, { name: rel, mode: modeForFile(rel, stat.mode) });
        }
      }
    }

    // Top-level entry inside the zip is `<AppName>.app/...`. macOS's
    // Finder unpacks zips into the SAME directory they live in, so
    // a flat layout would litter the user's Downloads folder.
    walk(appPath, `${APP_NAME}.app`);
    archive.finalize();
  });

  const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[make-mac-zips] wrote ${outPath} (${sizeMB} MB)`);
  return outPath;
}

(async () => {
  const results = [];
  for (const arch of ARCHES) {
    try {
      const out = await zipApp(arch);
      if (out) results.push(out);
    } catch (err) {
      console.error(`[make-mac-zips] ${arch} failed:`, err.message || err);
    }
  }
  if (results.length === 0) {
    console.error('[make-mac-zips] no zips produced.');
    process.exit(1);
  }
  console.log(`\n[make-mac-zips] done — ${results.length} zip(s) ready.`);
})();
