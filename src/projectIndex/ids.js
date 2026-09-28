// `.docvex/ids.json` — the PORTABLE file ids. The machine index knows a file
// by its inode, which means nothing on another computer; records that must
// survive the folder travelling (chat attachments, timelines, Supabase rows)
// point at the uuid kept here instead. See README.md.
//
// The file is shared through OneDrive / Dropbox, so every write merges with
// what is on disk first (union by uuid, the newest `at` wins), and conflict
// copies a sync client leaves beside it are folded in and removed. Writes are
// debounced: a reconcile that renames forty files writes the file once.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, readJsonSync, writeJsonAtomic, writeJsonAtomicSync } from './atomic.js';

const WRITE_DEBOUNCE_MS = 400;

// "ids-DESKTOP-1.json" (OneDrive), "ids (1).json", "ids (X's conflicted copy …).json".
export const isIdsConflictCopy = (name) => /^ids[\s\-(].*\.json$/i.test(name) && name.toLowerCase() !== 'ids.json';

const filesOf = (json) => (json && typeof json === 'object' && json.files && typeof json.files === 'object' ? json.files : {});

// Union of two id maps; for a uuid in both, the entry with the later `at`.
export function mergeIdMaps(a, b) {
  const out = { ...a };
  for (const [id, e] of Object.entries(b || {})) {
    if (!e || typeof e.rel !== 'string') continue;
    if (!out[id] || (Number(e.at) || 0) > (Number(out[id].at) || 0)) out[id] = e;
  }
  return out;
}

export class IdStore {
  constructor(dir) {
    this.dir = dir;
    this.folder = path.join(dir, '.docvex');
    this.file = path.join(this.folder, 'ids.json');
    this.files = {};
    // Ids removed this session. Kept so a merge with the file on disk (which
    // still lists them until our write lands) doesn't bring them back.
    this.deleted = new Set();
    this.timer = null;
    this.dirty = false;
    this.lastWriteAt = 0;
  }

  async load() {
    let merged = filesOf(await readJson(this.file));
    let copies = [];
    try { copies = (await fsp.readdir(this.folder)).filter(isIdsConflictCopy); } catch { /* no .docvex yet */ }
    for (const name of copies) merged = mergeIdMaps(merged, filesOf(await readJson(path.join(this.folder, name))));
    for (const id of this.deleted) delete merged[id];
    this.files = mergeIdMaps(this.files, merged);
    if (copies.length) {
      await this.flush();
      for (const name of copies) await fsp.unlink(path.join(this.folder, name)).catch(() => {});
    }
    return this;
  }

  get(id) { return this.files[id] || null; }
  entries() { return Object.entries(this.files); }

  set(id, { rel, size = null, mtimeMs = null, hash = null }) {
    const prev = this.files[id];
    if (prev && prev.rel === rel && prev.size === size && prev.mtimeMs === mtimeMs && (prev.hash || null) === (hash || null)) return;
    this.files[id] = { rel, size, mtimeMs, hash: hash || null, at: Date.now() };
    this.deleted.delete(id);
    this.schedule();
  }

  remove(id) {
    if (!this.files[id]) return;
    delete this.files[id];
    this.deleted.add(id);
    this.schedule();
  }

  schedule() {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, WRITE_DEBOUNCE_MS);
  }

  #mergedWithDisk(diskJson) {
    const disk = filesOf(diskJson);
    for (const id of this.deleted) delete disk[id];
    return mergeIdMaps(disk, this.files);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.files = this.#mergedWithDisk(await readJson(this.file));
    this.lastWriteAt = Date.now();
    await writeJsonAtomic(this.file, { v: 1, files: this.files });
  }

  // On quit: the debounced write must not be lost with the process.
  flushSync() {
    if (!this.dirty) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    try {
      this.files = this.#mergedWithDisk(readJsonSync(this.file));
      writeJsonAtomicSync(this.file, { v: 1, files: this.files });
    } catch { /* the index still has the ids; the next session rewrites the file */ }
  }

  // Which recorded id might a file the index has never seen carry? The file
  // is unknown by inode (another machine, a restored copy, an atomic save),
  // so it is matched by what travels: path + size + modified time (`exact`),
  // then the content hash (`bySize` = the free entries with a hash and the
  // same size — only those are worth hashing the file for), then — beyond
  // the README's two steps, and noted there — the path alone (`byRel`),
  // provided no file on this machine holds that id. Without the last step a
  // document edited on another machine (new size, time and hash) would lose
  // its id the moment the edit synced over. `claimed` = ids already held.
  candidatesFor({ rel, size, mtimeMs }, claimed) {
    let exact = null;
    let byRel = null;
    const bySize = [];
    for (const [id, e] of Object.entries(this.files)) {
      if (claimed.has(id)) continue;
      if (e.rel === rel) {
        if (e.size === size && e.mtimeMs === mtimeMs) { exact = id; break; }
        if (!byRel) byRel = id;
      }
      if (e.hash && e.size === size) bySize.push([id, e.hash]);
    }
    return { exact, bySize, byRel };
  }
}

// Legacy `.docvex.json` sidecars: `{ version: 1, projectId, entries: { [fileId]:
// { filename, contentHash, mtime } } }`, one per folder, keyed by the file's
// name inside THAT folder (lib/localBranchMeta.js). Returns the entries as
// project-relative paths. A sidecar naming a different project is not ours to
// import (the old code ignored those too).
export function sidecarEntries(json, dirRel, projectId) {
  if (!json || json.version !== 1 || typeof json.entries !== 'object' || !json.entries) return [];
  if (json.projectId && projectId && json.projectId !== projectId) return [];
  const out = [];
  for (const [id, e] of Object.entries(json.entries)) {
    if (!e?.filename || typeof e.filename !== 'string') continue;
    out.push({ id, rel: dirRel ? `${dirRel}/${e.filename}` : e.filename, hash: e.contentHash || null });
  }
  return out;
}

export function sidecarPath(dir, dirRel) {
  return path.join(dir, ...(dirRel ? dirRel.split('/') : []), '.docvex.json');
}
