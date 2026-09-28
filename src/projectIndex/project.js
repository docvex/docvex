// One open project: its machine index, its portable ids, the background
// reconcile that keeps the index equal to the folder, and the watcher that
// keeps it so while the project is in use. See README.md, "Loading,
// reconciling, watching".
//
// Every reconcile — the full one after opening and the small ones the watcher
// asks for — is the same routine over a set of SCOPES: whole subtrees
// (`trees`, '' = the project root) and single paths (`files`). Only rows
// inside the scopes can be judged gone; a file found inside them is matched to
// the index by its machine id first, so a rename or a move is one row whose
// path changed, not a delete and an add. The routines are queued one after
// another per project, and scopes asked for while one runs are merged into
// the next.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDirLevel, isIgnoredLocalFilename, guessMimeFromName } from './walk.js';
import { readJson } from './atomic.js';
import { IdStore, sidecarEntries, sidecarPath } from './ids.js';
import { hashFile } from './knowledge.js';

const WATCH_DEBOUNCE_MS = 150;
// A file whose row was dropped keeps its id this long in memory, so a move
// reported in two watcher batches (source now, destination a moment later)
// is still the same file.
const REMOVED_GRACE_MS = 15000;

const yieldToLoop = () => new Promise((r) => setImmediate(r));

// Machine file id. NTFS / APFS / ext4 give a stable inode; some network and
// FAT volumes report 0, and there a path-based id is the honest fallback
// (renames there look like delete + add, which is still correct, just slower
// to recognise).
export const fidOf = (st, rel) => (st.ino && st.ino !== 0n ? String(st.ino) : `p:${rel}`);

const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};
const parentOf = (rel) => {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
};
const underAny = (rel, prefixes) => {
  for (const p of prefixes) {
    if (p === '' || rel === p || rel.startsWith(`${p}/`)) return true;
  }
  return false;
};
const hasDotSegment = (rel) => rel.split('/').some((s) => !s || s.startsWith('.'));

export class Project {
  constructor({ projectId, dir, projectFile, name, db, service }) {
    this.projectId = projectId;
    this.dir = dir;
    this.projectFile = projectFile;
    this.name = name;
    this.db = db;
    this.service = service;
    this.ids = new IdStore(dir);
    this.idsLoaded = null;
    this.rev = Number(db.getMeta('rev')) || 0;
    this.chain = Promise.resolve();
    this.pending = null;
    this.pendingPromise = null;
    this.running = false;
    this.reconciledOnce = false;
    this.recentlyRemoved = new Map(); // fid → { id, at }
    this.watcher = null;
    this.watchTimer = null;
    this.watchPaths = new Set();
    this.watchFull = false;
    this.lastUsed = Date.now();
    this.shardsChecked = new Set(); // content hashes whose shard was read this session
    this.shardMtimes = new Map();   // sha → shard mtime last imported by knowledgeList
  }

  abs(rel) { return path.join(this.dir, ...rel.split('/')); }
  rel(abs) { return path.relative(this.dir, abs).split(path.sep).join('/'); }

  get reconciling() { return this.running || !!this.pending; }

  toRow(r) {
    return {
      name: r.name,
      path: this.abs(r.rel),
      folderPath: r.dir,
      sizeBytes: r.size,
      mtimeIso: new Date(r.mtime).toISOString(),
      mimeType: guessMimeFromName(r.name),
      id: r.id,
      fid: r.fid,
      rel: r.rel,
      dir: r.dir,
      ext: r.ext,
      mtimeMs: r.mtime,
    };
  }

  loadIds() {
    if (!this.idsLoaded) this.idsLoaded = this.ids.load().catch(() => this.ids);
    return this.idsLoaded;
  }

  // ── queueing ──────────────────────────────────────────────────────────
  enqueue({ trees = [], files = [], full = false } = {}) {
    if (!this.pending) {
      const batch = { trees: new Set(), files: new Set(), full: false };
      this.pending = batch;
      this.pendingPromise = this.chain = this.chain.then(async () => {
        if (this.pending === batch) this.pending = null;
        this.running = true;
        try { return await this.applyScopes(batch); } catch (err) {
          return { ok: false, error: err?.message || String(err), changed: 0 };
        } finally { this.running = false; }
      });
    }
    const b = this.pending;
    if (full) { b.full = true; b.trees.add(''); }
    for (const t of trees) b.trees.add(t);
    for (const f of files) b.files.add(f);
    return this.pendingPromise;
  }

  reconcileFull() { return this.enqueue({ full: true }); }

  // ── the reconcile routine ─────────────────────────────────────────────
  async applyScopes(batch) {
    // The folder itself gone (deleted, renamed, a drive unplugged): nothing
    // is judged, or the index would be emptied and ids.json rewritten into a
    // freshly re-created folder.
    try {
      if (!(await fsp.stat(this.dir)).isDirectory()) return { ok: false, error: 'not_found', changed: 0 };
    } catch { return { ok: false, error: 'not_found', changed: 0 }; }
    await this.loadIds();
    const trees = new Set(batch.trees.has('') ? [''] : batch.trees);
    const goneTrees = new Set();
    const seen = new Map();     // rel → { fid, size, mtime, name }
    const seenDirs = new Set(); // subfolder rels found inside the scopes
    const sidecarDirs = [];
    // Paths that exist but could not be read just now (a file locked mid-
    // write): their rows are kept as they are rather than judged gone.
    const unsure = new Set();
    const unsureTrees = [];

    const statInfo = async (rel) => {
      try { return await fsp.stat(this.abs(rel), { bigint: true }); } catch (err) {
        return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? null : undefined;
      }
    };

    // Single paths first: a path that is now a folder becomes a subtree, a
    // path that is gone may have been a file OR a folder, so it is judged as
    // a subtree with nothing in it.
    for (const rel of batch.files) {
      if (!rel || hasDotSegment(rel) || underAny(rel, trees)) continue;
      const st = await statInfo(rel);
      if (st === undefined) { unsure.add(rel); continue; } // unreadable right now
      if (st === null) { goneTrees.add(rel); continue; }
      if (st.isDirectory()) { trees.add(rel); continue; }
      if (!st.isFile()) continue;
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (isIgnoredLocalFilename(name)) continue;
      seen.set(rel, { fid: fidOf(st, rel), size: Number(st.size), mtime: Number(st.mtimeMs), name });
      for (let p = parentOf(rel); p; p = parentOf(p)) seenDirs.add(p);
    }

    // Then the subtrees, one directory per turn of the event loop.
    for (const tree of trees) {
      if (tree) {
        if (hasDotSegment(tree)) continue;
        const st = await statInfo(tree);
        if (!st || !st.isDirectory()) { goneTrees.add(tree); continue; }
        seenDirs.add(tree);
        for (let p = parentOf(tree); p; p = parentOf(p)) seenDirs.add(p);
      }
      const queue = [tree];
      while (queue.length) {
        const rel = queue.shift();
        const level = await readDirLevel(this.dir, rel);
        if (!level) {
          // A folder that is there but can't be listed right now keeps what
          // the index has under it.
          if ((await statInfo(rel)) !== null) unsureTrees.push(rel);
          continue;
        }
        if (level.legacySidecar) sidecarDirs.push(rel);
        for (const d of level.dirs) { seenDirs.add(d.rel); queue.push(d.rel); }
        for (const f of level.files) {
          try {
            const st = await fsp.stat(f.full, { bigint: true });
            if (!st.isFile()) continue;
            seen.set(f.rel, { fid: fidOf(st, f.rel), size: Number(st.size), mtime: Number(st.mtimeMs), name: f.name });
          } catch (err) {
            // Gone between readdir and stat is simply gone; anything else
            // (locked, access denied for a moment) keeps its row.
            if (err?.code !== 'ENOENT') unsure.add(f.rel);
          }
        }
        await yieldToLoop();
      }
    }

    return this.#commit({ batch, trees, goneTrees, seen, seenDirs, sidecarDirs, unsure, unsureTrees });
  }

  async #commit({ batch, trees, goneTrees, seen, seenDirs, sidecarDirs, unsure, unsureTrees }) {
    const now = Date.now();
    for (const [fid, r] of this.recentlyRemoved) if (now - r.at > REMOVED_GRACE_MS) this.recentlyRemoved.delete(fid);

    const all = this.db.allFiles();
    const byFid = new Map(all.map((r) => [r.fid, r]));
    const byRel = new Map(all.map((r) => [r.rel, r]));
    const seenFids = new Set([...seen.values()].map((s) => s.fid));
    const scopes = new Set([...trees, ...goneTrees]);
    const inScope = (rel) => batch.files.has(rel) || underAny(rel, scopes);

    const upserts = [];
    const removed = [];        // rows dropped (their paths go out in the delta)
    const movedFrom = [];      // old paths of rows that moved
    const handled = new Set(); // seen rels already matched to a row
    const replacedFids = new Set();

    // 1. Files the index knows by machine id: unchanged, edited, or moved.
    for (const [rel, s] of seen) {
      const ex = byFid.get(s.fid);
      if (!ex) continue;
      handled.add(rel);
      const moved = ex.rel !== rel;
      const edited = ex.size !== s.size || ex.mtime !== s.mtime;
      if (!moved && !edited && ex.id) continue;
      if (moved) movedFrom.push(ex.rel);
      upserts.push({
        fid: s.fid, id: ex.id, rel, name: s.name, dir: parentOf(rel), ext: extOf(s.name),
        size: s.size, mtime: s.mtime, hash: edited ? null : ex.hash, seen: now,
      });
    }

    // 2. New machine ids at a path whose previous file is gone from it: an
    //    atomic save (Word writes a temp file and renames it over the
    //    original, so the "same" document has a new inode) — same file, same id.
    const fresh = [];
    for (const [rel, s] of seen) {
      if (handled.has(rel)) continue;
      const holder = byRel.get(rel);
      if (holder && !seenFids.has(holder.fid)) {
        replacedFids.add(holder.fid);
        upserts.push({
          fid: s.fid, id: holder.id, rel, name: s.name, dir: parentOf(rel), ext: extOf(s.name),
          size: s.size, mtime: s.mtime, hash: null, seen: now,
        });
        continue;
      }
      fresh.push([rel, s]);
    }

    // 3. Rows inside the scopes whose file was not found: gone.
    for (const r of all) {
      if (seenFids.has(r.fid) || replacedFids.has(r.fid)) continue;
      if (!inScope(r.rel) || unsure.has(r.rel) || (unsureTrees.length && underAny(r.rel, unsureTrees))) continue;
      removed.push(r);
    }
    const removedFids = new Set(removed.map((r) => r.fid));

    // Ids held by files that are still here (or just matched) can't be given
    // to a newcomer; ids of rows being dropped are free again.
    const claimed = new Set();
    for (const r of all) if (r.id && !removedFids.has(r.fid) && !replacedFids.has(r.fid)) claimed.add(r.id);
    for (const u of upserts) if (u.id) claimed.add(u.id);

    // Legacy per-folder sidecars: their ids are what older records point at,
    // so they go into ids.json before any newcomer is given an id.
    const importedSidecars = [];
    for (const dirRel of sidecarDirs) {
      const file = sidecarPath(this.dir, dirRel);
      const json = await readJson(file);
      const entries = sidecarEntries(json, dirRel, this.projectId);
      for (const e of entries) {
        if (claimed.has(e.id) || this.ids.get(e.id)) continue;
        const holder = byRel.get(e.rel);
        if (holder && holder.id && !removedFids.has(holder.fid)) continue; // the index already named it
        this.ids.set(e.id, { rel: e.rel, hash: e.hash });
      }
      // A sidecar that names another project is left where it is.
      if (json && (!json.projectId || json.projectId === this.projectId)) importedSidecars.push(file);
    }

    // 4. Genuinely new files: an id from a moment ago, from ids.json, or new.
    for (const [rel, s] of fresh) {
      let id = null;
      let hash = null;
      const recent = this.recentlyRemoved.get(s.fid);
      if (recent && !claimed.has(recent.id)) id = recent.id;
      if (!id) {
        const c = this.ids.candidatesFor({ rel, size: s.size, mtimeMs: s.mtime }, claimed);
        if (c.exact) id = c.exact;
        if (!id && c.bySize.length) {
          try { hash = await hashFile(this.abs(rel)); } catch { hash = null; }
          const hit = hash && c.bySize.find(([, h]) => h === hash);
          if (hit) id = hit[0];
        }
        if (!id && c.byRel) id = c.byRel;
      }
      if (!id) id = crypto.randomUUID();
      claimed.add(id);
      upserts.push({
        fid: s.fid, id, rel, name: s.name, dir: parentOf(rel), ext: extOf(s.name),
        size: s.size, mtime: s.mtime, hash, seen: now,
      });
    }

    // Folders.
    const knownDirs = this.db.allDirs();
    const knownDirSet = new Set(knownDirs);
    const dirsAdded = [...seenDirs].filter((d) => !knownDirSet.has(d) && !hasDotSegment(d)).sort();
    const dirsRemoved = knownDirs.filter((d) => !seenDirs.has(d) && underAny(d, scopes) && !trees.has(d)
      && !(unsureTrees.length && underAny(d, unsureTrees)));
    // A subtree root that is gone takes itself with it too.
    for (const d of knownDirs) if (goneTrees.has(d) && !dirsRemoved.includes(d)) dirsRemoved.push(d);

    const upsertRels = new Set(upserts.map((u) => u.rel));
    const removedRels = [...new Set([...removed.map((r) => r.rel), ...movedFrom])].filter((r) => !upsertRels.has(r));
    const changed = upserts.length + removedRels.length + dirsAdded.length + dirsRemoved.length;

    if (changed) {
      this.db.tx(() => {
        for (const r of removed) this.db.deleteFileByFid(r.fid);
        for (const d of dirsRemoved) this.db.deleteDir(d);
        for (const u of upserts) this.db.upsertFile(u);
        for (const d of dirsAdded) this.db.upsertDir(d);
        this.rev += 1;
        this.db.setMeta('rev', this.rev);
      });
    }

    // ids.json follows the index. A dropped row's entry goes only while it
    // still describes that path — if another machine has since recorded the
    // file somewhere else, the entry is theirs to keep.
    for (const r of removed) {
      if (r.id) this.recentlyRemoved.set(r.fid, { id: r.id, at: now });
      const e = r.id && this.ids.get(r.id);
      if (e && e.rel === r.rel && !claimed.has(r.id)) this.ids.remove(r.id);
    }
    for (const u of upserts) this.ids.set(u.id, { rel: u.rel, size: u.size, mtimeMs: u.mtime, hash: u.hash });
    // A full pass also rewrites entries lost from ids.json (deleted by hand,
    // an older copy synced over it).
    if (batch.full) {
      for (const r of this.db.allFiles()) {
        if (r.id && !this.ids.get(r.id)) this.ids.set(r.id, { rel: r.rel, size: r.size, mtimeMs: r.mtime, hash: r.hash });
      }
    }
    if (importedSidecars.length) {
      // The ids must be safely in ids.json before the files they came from go.
      try {
        await this.ids.flush();
        for (const f of importedSidecars) await fsp.unlink(f).catch(() => {});
      } catch { /* keep the sidecars; the next pass imports them again */ }
    }

    if (batch.full) this.reconciledOnce = true;
    if (changed || batch.full) {
      this.service.broadcast('project:delta', {
        projectId: this.projectId,
        rev: this.rev,
        upserted: upserts.map((u) => this.toRow(u)),
        removed: removedRels,
        dirsAdded,
        dirsRemoved,
        ...(batch.full ? { reconciled: true } : {}),
      });
    }
    return { ok: true, changed };
  }

  // ── hashing ───────────────────────────────────────────────────────────
  // The content hash of a file in this project, from the index when it still
  // describes the file on disk (same machine id, size and modified time),
  // otherwise computed and — when the row agrees — cached.
  async hashFor(abs) {
    const rel = this.rel(abs);
    const st = await fsp.stat(abs, { bigint: true });
    if (!st.isFile()) throw new Error('not_a_file');
    const fid = fidOf(st, rel);
    const size = Number(st.size);
    const mtime = Number(st.mtimeMs);
    const row = this.db.fileByRel(rel);
    if (row && row.fid === fid && row.size === size && row.mtime === mtime && row.hash) return row.hash;
    const hash = await this.service.hashOnce(abs, size, mtime);
    if (row && row.fid === fid) {
      this.db.setHash(fid, size, mtime, hash);
      const e = row.id && this.ids.get(row.id);
      if (e && e.rel === rel && row.size === size && row.mtime === mtime) this.ids.set(row.id, { ...e, mtimeMs: e.mtimeMs, hash });
    } else if (!hasDotSegment(rel)) {
      // Not indexed yet (the reconcile hasn't reached it): index it now.
      this.enqueue({ files: [rel] });
    }
    return hash;
  }

  // ── watching ──────────────────────────────────────────────────────────
  watch() {
    if (this.watcher) return true;
    try {
      this.watcher = fs.watch(this.dir, { persistent: false, recursive: true }, (_event, filename) => {
        if (filename == null) this.watchFull = true;
        else this.watchPaths.add(String(filename).split(path.sep).join('/').replace(/\/+$/, ''));
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.#flushWatch(), WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => this.unwatch());
      return true;
    } catch {
      this.watcher = null;
      return false;
    }
  }

  unwatch() {
    clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.watcher) { try { this.watcher.close(); } catch { /* closed */ } }
    this.watcher = null;
  }

  #flushWatch() {
    this.watchTimer = null;
    const paths = [...this.watchPaths];
    this.watchPaths.clear();
    const full = this.watchFull;
    this.watchFull = false;
    const files = [];
    for (const rel of paths) {
      if (!rel) continue;
      if (rel.startsWith('.docvex/')) { this.service.onDocvexChange(this, rel); continue; }
      if (hasDotSegment(rel)) continue;
      files.push(rel);
    }
    if (full) this.enqueue({ full: true });
    else if (files.length) this.enqueue({ files });
  }

  close() {
    this.unwatch();
    this.ids.flushSync();
    this.db.close();
  }
}
