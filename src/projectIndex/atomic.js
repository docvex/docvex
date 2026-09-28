// Small file helpers shared by the project-data modules. Everything this
// layer writes goes through a temp file + rename, because the files sit in
// folders that OneDrive / Dropbox are watching: a half-written ids.json or
// knowledge shard picked up mid-write would be synced to every other machine
// as a corrupt file. A rename is atomic on the same volume, so a reader (or a
// sync client) sees the old bytes or the new ones, never a mix.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// The temp name starts with a dot and ends in .tmp, so the Files listing's
// filters (dotfiles, *.tmp) never surface it even when it sits in the case
// folder itself (the project file is written beside the documents).
const tempNameFor = (file) => path.join(
  path.dirname(file),
  `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
);

// Windows refuses a rename over a file another process has open without
// FILE_SHARE_DELETE (antivirus and sync clients do, briefly). A few short
// retries clear almost every such collision.
async function renameWithRetry(from, to) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try { await fsp.rename(from, to); return; } catch (err) {
      lastErr = err;
      if (err?.code !== 'EPERM' && err?.code !== 'EACCES' && err?.code !== 'EBUSY') break;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tempNameFor(file);
  try {
    await fsp.writeFile(tmp, data);
    await renameWithRetry(tmp, file);
  } catch (err) {
    fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

export const writeJsonAtomic = (file, value) => writeFileAtomic(file, JSON.stringify(value, null, 1));

// The synchronous twin, for the few writes that must land before the process
// exits (flushing ids.json on quit).
export function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempNameFor(file);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

// Parsed JSON, or null when the file is missing or not valid JSON — callers
// treat a corrupt file exactly like an absent one and rebuild it.
export async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

export function readJsonSync(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Is `target` inside `root`? path.relative rather than startsWith, so a
// sibling folder sharing the root's name prefix ("Case" / "Case 2") is not
// taken for a child. The root itself counts only with allowRoot.
export function isInside(root, target, { allowRoot = false } = {}) {
  const rel = path.relative(root, target);
  if (rel === '') return allowRoot;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// A path relative to the project folder, always with forward slashes — the
// form every record (index rows, ids.json, deltas) uses on every platform.
export const toRel = (root, full) => path.relative(root, full).split(path.sep).join('/');
