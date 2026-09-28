// The machine index: one SQLite file per project under
// <userData>/project-index/, plus `_loose.db` for files that belong to no
// project, plus registry.json (projectId → folder). See README.md.
//
// The index is a CACHE of the folder and its `.docvex/` data — anything wrong
// with it is fixed by throwing it away and rescanning — with one exception,
// the `private` table (per-user data that must not travel with the folder).
// So a database that fails to open is renamed aside (not deleted: the
// private rows may still be recoverable by hand) and a fresh one is built.
//
// node:sqlite is reached through process.getBuiltinModule rather than an
// import: the main bundle is built by Vite, whose Node-builtin list predates
// the prefix-only `node:sqlite`, and a bundler that tries to resolve it breaks
// the build. The runtime (Electron 42's Node 24) always has it.

import fs from 'node:fs';
import path from 'node:path';
import { readJsonSync, writeJsonAtomicSync } from './atomic.js';
import { sealJson, openJson, hasIndexKey } from './seal.js';
import { RETIRED_KINDS } from './knowledge.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files(
  fid TEXT PRIMARY KEY, id TEXT, rel TEXT UNIQUE, name TEXT, dir TEXT, ext TEXT,
  size INTEGER, mtime INTEGER, hash TEXT, seen INTEGER);
CREATE INDEX IF NOT EXISTS files_id ON files(id);
CREATE INDEX IF NOT EXISTS files_hash ON files(hash);
CREATE TABLE IF NOT EXISTS dirs(rel TEXT PRIMARY KEY, name TEXT, parent TEXT);
CREATE TABLE IF NOT EXISTS knowledge(hash TEXT, kind TEXT, facet TEXT, local INTEGER, PRIMARY KEY(hash, kind));
CREATE TABLE IF NOT EXISTS settings(store TEXT PRIMARY KEY, value TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS private(user TEXT, key TEXT, value TEXT, at INTEGER, PRIMARY KEY(user, key));
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
`;

let sqlite = null;
function sqliteModule() {
  if (!sqlite) sqlite = process.getBuiltinModule('node:sqlite');
  return sqlite;
}

// Move a broken database (and its WAL / shared-memory files) out of the way.
function setAside(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.renameSync(file + suffix, `${file}.corrupt-${stamp}${suffix}`); } catch { /* not there */ }
  }
}

function openRaw(file) {
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
    db.exec(SCHEMA);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (!row) db.prepare("INSERT INTO meta(key, value) VALUES('schema', ?)").run(String(SCHEMA_VERSION));
    else if (Number(row.value) > SCHEMA_VERSION) throw new Error(`index schema ${row.value} is newer than this app`);
    // Touch every table once: a damaged page usually shows up here rather
    // than on some later write in the middle of a reconcile.
    db.prepare('SELECT count(*) AS n FROM files').get();
    return db;
  } catch (err) {
    try { db.close(); } catch { /* already unusable */ }
    throw err;
  }
}

export class IndexDb {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.db = openRaw(file);
    } catch (err) {
      // A newer app's schema is not corruption — refuse rather than wipe it.
      if (/newer than this app/.test(String(err?.message))) throw err;
      setAside(file);
      this.db = openRaw(file);
      this.rebuilt = true;
    }
    const q = (sql) => this.db.prepare(sql);
    this.s = {
      allFiles: q('SELECT * FROM files'),
      fileByRel: q('SELECT * FROM files WHERE rel = ?'),
      fileByFid: q('SELECT * FROM files WHERE fid = ?'),
      fileById: q('SELECT * FROM files WHERE id = ? LIMIT 1'),
      filesByHash: q('SELECT * FROM files WHERE hash = ?'),
      upsertFile: q(`INSERT INTO files(fid, id, rel, name, dir, ext, size, mtime, hash, seen)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fid) DO UPDATE SET id = excluded.id, rel = excluded.rel, name = excluded.name,
          dir = excluded.dir, ext = excluded.ext, size = excluded.size, mtime = excluded.mtime,
          hash = excluded.hash, seen = excluded.seen`),
      deleteFileByFid: q('DELETE FROM files WHERE fid = ?'),
      deleteFileByRel: q('DELETE FROM files WHERE rel = ?'),
      setHash: q('UPDATE files SET hash = ? WHERE fid = ? AND size = ? AND mtime = ?'),
      allDirs: q('SELECT rel FROM dirs ORDER BY rel'),
      upsertDir: q('INSERT INTO dirs(rel, name, parent) VALUES(?, ?, ?) ON CONFLICT(rel) DO NOTHING'),
      deleteDir: q('DELETE FROM dirs WHERE rel = ?'),
      knowledgeForHash: q('SELECT kind, facet, local FROM knowledge WHERE hash = ?'),
      knowledgeAll: q('SELECT hash, kind, facet, local FROM knowledge'),
      putKnowledge: q(`INSERT INTO knowledge(hash, kind, facet, local) VALUES(?, ?, ?, ?)
        ON CONFLICT(hash, kind) DO UPDATE SET facet = excluded.facet, local = excluded.local`),
      clearKnowledge: q('DELETE FROM knowledge WHERE hash = ? AND kind = ?'),
      getSetting: q('SELECT value, at FROM settings WHERE store = ?'),
      putSetting: q(`INSERT INTO settings(store, value, at) VALUES(?, ?, ?)
        ON CONFLICT(store) DO UPDATE SET value = excluded.value, at = excluded.at`),
      getPrivate: q('SELECT value, at FROM private WHERE user = ? AND key = ?'),
      putPrivate: q(`INSERT INTO private(user, key, value, at) VALUES(?, ?, ?, ?)
        ON CONFLICT(user, key) DO UPDATE SET value = excluded.value, at = excluded.at`),
      deletePrivate: q('DELETE FROM private WHERE user = ? AND key = ?'),
      listPrivate: q("SELECT key, value, at FROM private WHERE user = ? AND substr(key, 1, length(?)) = ? ORDER BY key"),
      getMeta: q('SELECT value FROM meta WHERE key = ?'),
      setMeta: q('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
    this.sealExisting();
    this.purgeRetired();
  }

  // Delete every facet of a retired kind (lib/projectIndex/knowledge.js
  // RETIRED_KINDS — the face descriptors of the removed face matching), then
  // VACUUM so the deleted rows don't linger in freed pages or the WAL. Cheap
  // when there is nothing to delete, so it runs on every open.
  purgeRetired() {
    try {
      const kinds = [...RETIRED_KINDS];
      if (!kinds.length) return;
      const marks = kinds.map(() => '?').join(', ');
      const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM knowledge WHERE kind IN (${marks})`).get(...kinds);
      if (!n) return;
      this.db.prepare(`DELETE FROM knowledge WHERE kind IN (${marks})`).run(...kinds);
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); } catch { /* next open */ }
    } catch { /* retried next open */ }
  }

  // Once a key is available, seal the rows an older build wrote in the clear
  // (they would otherwise stay readable until next rewritten). Once per file.
  sealExisting() {
    if (!hasIndexKey() || this.getMeta('sealed') === '1') return;
    try {
      this.tx(() => {
        const plain = (v) => !String(v ?? '').startsWith('enc1:');
        for (const r of this.db.prepare('SELECT user, key, value FROM private').all()) {
          if (plain(r.value)) this.db.prepare('UPDATE private SET value = ? WHERE user = ? AND key = ?').run(sealJson(JSON.parse(r.value)), r.user, r.key);
        }
        for (const r of this.db.prepare('SELECT hash, kind, facet FROM knowledge').all()) {
          if (plain(r.facet)) this.db.prepare('UPDATE knowledge SET facet = ? WHERE hash = ? AND kind = ?').run(sealJson(JSON.parse(r.facet)), r.hash, r.kind);
        }
        for (const r of this.db.prepare('SELECT store, value FROM settings').all()) {
          if (plain(r.value)) this.db.prepare('UPDATE settings SET value = ? WHERE store = ?').run(sealJson(JSON.parse(r.value)), r.store);
        }
        this.setMeta('sealed', '1');
      });
      // The cleartext may still sit in freed pages and the WAL.
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); } catch { /* next open */ }
    } catch { /* a bad row: leave it, retried next open */ }
  }

  // Run `fn` inside one transaction — a reconcile's hundred upserts cost one
  // fsync instead of a hundred. Nested calls just join the outer one.
  tx(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN');
    this.inTx = true;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to undo */ }
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  allFiles() { return this.s.allFiles.all(); }
  allDirs() { return this.s.allDirs.all().map((r) => r.rel); }
  fileByRel(rel) { return this.s.fileByRel.get(rel) || null; }
  fileByFid(fid) { return this.s.fileByFid.get(fid) || null; }
  fileById(id) { return this.s.fileById.get(id) || null; }
  filesByHash(hash) { return this.s.filesByHash.all(hash); }

  // `rel` is UNIQUE while the key is the machine file id, so a row taking over
  // a path another row still holds (a file replaced by a save-and-rename)
  // clears the old holder first.
  upsertFile(r) {
    const holder = this.s.fileByRel.get(r.rel);
    if (holder && holder.fid !== r.fid) this.s.deleteFileByFid.run(holder.fid);
    this.s.upsertFile.run(r.fid, r.id, r.rel, r.name, r.dir, r.ext, r.size, r.mtime, r.hash ?? null, r.seen ?? 0);
  }
  deleteFileByFid(fid) { this.s.deleteFileByFid.run(fid); }
  // Store a hash only if the row still describes the bytes that were hashed.
  setHash(fid, size, mtime, hash) { this.s.setHash.run(hash, fid, size, mtime); }

  upsertDir(rel) {
    const i = rel.lastIndexOf('/');
    this.s.upsertDir.run(rel, i < 0 ? rel : rel.slice(i + 1), i < 0 ? '' : rel.slice(0, i));
  }
  deleteDir(rel) { this.s.deleteDir.run(rel); }

  knowledgeFor(hash) {
    const out = {};
    for (const r of this.s.knowledgeForHash.all(hash)) {
      try { out[r.kind] = { facet: openJson(r.facet), local: !!r.local }; } catch { /* skip a bad row */ }
    }
    return out;
  }
  // Rows with their facet already opened; a row that can't be read is left out.
  knowledgeAll() {
    const out = [];
    for (const r of this.s.knowledgeAll.all()) {
      try { out.push({ ...r, facet: openJson(r.facet) }); } catch { /* skip a bad row */ }
    }
    return out;
  }
  putKnowledge(hash, kind, facet, local) { this.s.putKnowledge.run(hash, kind, sealJson(facet), local ? 1 : 0); }
  clearKnowledge(hash, kind) { this.s.clearKnowledge.run(hash, kind); }

  getSetting(store) {
    const r = this.s.getSetting.get(store);
    if (!r) return null;
    try { return { value: openJson(r.value), at: Number(r.at) || 0 }; } catch { return null; }
  }
  putSetting(store, value, at) { this.s.putSetting.run(store, sealJson(value ?? null), at); }

  getPrivate(user, key) {
    const r = this.s.getPrivate.get(user, key);
    if (!r) return null;
    try { return { value: openJson(r.value), at: Number(r.at) || 0 }; } catch { return null; }
  }
  // An undefined value removes the key, which is how a caller deletes one.
  putPrivate(user, key, value, at) {
    // undefined OR null deletes: the renderer's stores delete by putting null.
    if (value === undefined || value === null) this.s.deletePrivate.run(user, key);
    else this.s.putPrivate.run(user, key, sealJson(value), at);
  }
  listPrivate(user, prefix = '') {
    return this.s.listPrivate.all(user, prefix, prefix).map((r) => {
      let value = null;
      try { value = openJson(r.value); } catch { /* leave null */ }
      return { key: r.key, value, at: Number(r.at) || 0 };
    });
  }

  getMeta(key) { return this.s.getMeta.get(key)?.value ?? null; }
  setMeta(key, value) { this.s.setMeta.run(key, String(value)); }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

// ── registry.json ──────────────────────────────────────────────────────────
// projectId → { dir, projectFile, name, lastOpened }. Tiny and read on every
// lookup of an unloaded project, so it is kept in memory and written through.

export class Registry {
  constructor(file) {
    this.file = file;
    const raw = readJsonSync(file);
    this.map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }
  get(projectId) { return this.map[projectId] || null; }
  entries() { return Object.entries(this.map); }
  set(projectId, entry) {
    this.map[projectId] = { ...(this.map[projectId] || {}), ...entry };
    this.save();
  }
  save() {
    try { writeJsonAtomicSync(this.file, this.map); } catch { /* next change retries */ }
  }
}
