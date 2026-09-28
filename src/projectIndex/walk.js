// What the Files tab counts as a project's files, in ONE place. The flat and
// recursive listings in main.js and the project index's scanner
// (src/projectIndex/scanner.js) all read the disk through these helpers, so a
// file the listing hides (a dotfile, a lockfile, the .docvex/ folder) can never
// slip into the index, and the other way round.

import path from 'node:path';
import fsp from 'node:fs/promises';

// Map a filename's extension to a best-effort MIME type so the renderer
// can pick the right card icon (PDF / video / image / text / generic).
// Mirrors the categoriser in ProjectFiles.jsx so local + cloud cards
// bucket into the same Photos / Videos / Documents sections.
export function guessMimeFromName(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ext) return '';
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  if (['png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return `image/${ext}`;
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return `video/${ext}`;
  // Audio — WhatsApp voice notes are Ogg-Opus (`.opus`); the rest cover the
  // common shared-audio formats. Without these the localfile handler falls
  // back to octet-stream and Chromium refuses to decode the <audio> element.
  if (['opus', 'ogg', 'oga'].includes(ext)) return 'audio/ogg';
  if (ext === 'mp3') return 'audio/mpeg';
  if (['m4a', 'aac'].includes(ext)) return 'audio/mp4';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'md') return 'text/markdown';
  if (['txt', 'log', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts'].includes(ext)) return 'text/plain';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (['doc', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'application/octet-stream';
  return '';
}

// Filenames that should never surface as "your project's files" — they
// are OS / editor bookkeeping artifacts that materialise transiently
// next to the documents the user actually cares about. Leaving them
// visible causes three classes of bugs:
//   1. Word's `~$report.docx` lockfile appears as a phantom new file
//      every time the user opens a .docx for editing, gets minted a
//      sidecar UUID, and rides into the next commit (the bug the
//      user explicitly hit and reported).
//   2. Vim / IDE swap files (`.swp`, `.swo`, `*~`) flicker in and out
//      of the list, racing the watcher debounce.
//   3. macOS / Windows file managers drop hidden metadata (`.DS_Store`,
//      `desktop.ini`, `Thumbs.db`) the user never agreed to share.
//
// The check is filename-only — we don't try to peek at file headers
// or sizes. Anything matching one of these patterns is dropped from
// the list before it has a chance to be hashed, reconciled with the
// sidecar, or compared against cloud state.
export function isIgnoredLocalFilename(name) {
  if (!name) return true;
  // Dotfiles cover the broadest swath: .DS_Store, .git, .vscode/,
  // .env, the sidecar's own .docvex.json, .Trashes, .Spotlight-V100,
  // etc. The Files tab is for documents, not config.
  if (name.startsWith('.')) return true;
  // Office lockfiles use ~$ prefix — Word, Excel, PowerPoint all do
  // this. The lockfile exists for the duration of the open session
  // and is deleted on clean close. Without this filter, a user
  // editing a .docx gets a phantom "~$Report.docx" card.
  if (name.startsWith('~$')) return true;
  // Vim / classic editor backup files end with ~ — e.g. `report.docx~`.
  if (name.endsWith('~')) return true;
  // Editor swap files — Vim / NeoVim are the dominant offenders.
  if (/\.(swp|swo|swn|swm)$/i.test(name)) return true;
  // Lockfile patterns from various OSes / editors (LibreOffice's
  // `.~lock.report.docx#`, OS-level `.lock`, `.lck`). The dotfile
  // rule catches LibreOffice's because it starts with `.`; the
  // generic `.lock` / `.lck` extension catch covers third parties.
  if (/\.(lock|lck)$/i.test(name)) return true;
  // Generic temp scratch — most apps write `*.tmp` and `*.temp` next
  // to the open file for atomic rename-on-save. They disappear after
  // save but the watcher tick can catch them mid-flight.
  if (/\.(tmp|temp|bak|partial|crdownload|part)$/i.test(name)) return true;
  // Windows folder metadata (capital-T variant for older releases).
  if (name === 'Thumbs.db' || name === 'thumbs.db') return true;
  if (name === 'desktop.ini' || name === 'Desktop.ini') return true;
  if (name === 'ehthumbs.db') return true;
  // macOS quirks not always caught by the dotfile rule.
  if (name === 'Icon\r') return true; // Finder custom-icon marker
  return false;
}

// Recursive listing — every file anywhere under `dir`, each tagged with
// its `folderPath` (relative dir from the root, forward-slash separated,
// '' for root). This is the SYNC source: the branch flow needs to see
// files in subfolders so the folder structure can sync to the team.
// Dotfolders + noise files are skipped, same as the flat list.
// `dirsOut` (optional) collects every subfolder's relative path — account sync
// needs them, or an empty folder would never reach another device.
export async function walkLocalDir(root, rel, out, dirsOut = null) {
  const listing = await readDirLevel(root, rel);
  if (!listing) return;
  for (const d of listing.dirs) {
    if (dirsOut) dirsOut.push(d.rel);
    await walkLocalDir(root, d.rel, out, dirsOut);
  }
  for (const f of listing.files) {
    try {
      const stat = await fsp.stat(f.full);
      out.push(listEntry(f, stat));
    } catch { /* skip unstattable */ }
  }
}

// One directory's worth of the listing: its visible subfolders and files,
// with the listing's exact filters (dot-dirs out; dotfiles, lockfiles, temp
// files and OS clutter out). `legacySidecar` says whether the folder still
// carries a pre-index `.docvex.json` — the scanner imports those ids.
// null when the directory cannot be read.
export async function readDirLevel(root, rel) {
  const dir = rel ? path.join(root, rel) : root;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return null; }
  const dirs = [];
  const files = [];
  let legacySidecar = false;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      dirs.push({ name: entry.name, rel: rel ? `${rel}/${entry.name}` : entry.name });
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === '.docvex.json') legacySidecar = true;
    if (isIgnoredLocalFilename(entry.name)) continue;
    files.push({
      name: entry.name,
      rel: rel ? `${rel}/${entry.name}` : entry.name,
      folderPath: rel || '',
      full: path.join(dir, entry.name),
    });
  }
  return { dirs, files, legacySidecar };
}

// Would the listing show this path (relative, forward slashes)? Every segment
// is checked: a file inside a dot-folder is hidden however ordinary its name.
export function isListedRel(rel) {
  if (!rel) return false;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (!parts[i] || parts[i].startsWith('.')) return false;
  }
  return !isIgnoredLocalFilename(parts[parts.length - 1]);
}

// A `local-folder:list-recursive` entry — the shape every Files consumer
// already reads, which the index's rows extend.
export function listEntry(f, stat) {
  return {
    name: f.name,
    path: f.full,
    folderPath: f.folderPath,
    sizeBytes: Number(stat.size),
    mtimeIso: new Date(Number(stat.mtimeMs)).toISOString(),
    mimeType: guessMimeFromName(f.name),
  };
}
