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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const APP_NAME = pkg.productName || pkg.name;

const ARCHES = ['x64', 'arm64'];

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
          // mode preserves the executable bit on Mach-O binaries
          // (Electron, Helper apps, codesign signatures) — without
          // this the unzipped .app would have non-executable
          // binaries and macOS would refuse to launch it.
          archive.file(abs, { name: rel, mode: stat.mode });
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
