// The project-data service main.js wires to IPC. It owns the registry, the
// open projects (their indexes, ids and watchers), `_loose.db`, and the
// knowledge / settings / private stores. It knows nothing about Electron: the
// caller hands it where userData is and how to broadcast, which is what lets
// the tests run it under plain Node. See README.md for the contract.
//
// Nothing here runs until the first call: creating the service opens no file.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { IndexDb, Registry } from './db.js';
import { Project } from './project.js';
import { isInside, readJson, writeJsonAtomic } from './atomic.js';
import { findProjectFiles, linkProjectFile, readProjectFile } from './projectFile.js';
import {
  LOCAL_KINDS, hashFile, hasShardFile, isShaHex, listShards, normalizeFacet, readShard, writeShardFacet,
} from './knowledge.js';
import {
  SEALED_EXT, folderKeyFromBase64, isFolderKey, isSealedFolderJson, openFromFolder, sealForFolder,
} from './folderSeal.js';
import { openJson, sealJson } from './seal.js';

// Watchers are cheap on Windows / macOS (one handle per tree) but not free.
// Projects opened this session stay watched, up to this many, least recently
// used out first.
const MAX_WATCHED = 4;
// A watcher event for a file this process wrote itself within this window is
// our own echo, not news from a sync client.
const OWN_WRITE_MS = 2500;

const KIND_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const errorOf = (err) => err?.message || String(err || 'error');

// A store name as a file name: percent-encoded (and the few characters
// encodeURIComponent leaves alone that a file name shouldn't lead with or
// Windows refuses), so every name maps to one file and decodes back.
export const storeFileName = (store) => encodeURIComponent(String(store))
  .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  .replace(/^\./, '%2E');

export function createProjectIndexService({ userDataDir, broadcast = () => {}, onProjectDir = () => {} }) {
  const root = path.join(userDataDir, 'project-index');
  let registry = null;
  let loose = null;
  const projects = new Map(); // projectId → Project
  const ownWrites = new Map(); // absolute path → time written
  const hashing = new Map();  // `${path}|${size}|${mtime}` → Promise<sha>

  const reg = () => (registry ||= new Registry(path.join(root, 'registry.json')));
  const looseDb = () => (loose ||= new IndexDb(path.join(root, '_loose.db')));
  const markOwnWrite = (file) => {
    ownWrites.set(path.resolve(file), Date.now());
    if (ownWrites.size > 500) {
      const cutoff = Date.now() - OWN_WRITE_MS;
      for (const [k, t] of ownWrites) if (t < cutoff) ownWrites.delete(k);
    }
  };
  const isOwnEcho = (file) => {
    const t = ownWrites.get(path.resolve(file));
    return !!t && Date.now() - t < OWN_WRITE_MS;
  };

  // The project's folder key (folderSeal.js): given by the renderer, kept in
  // the project's database (sealed with the machine's index key) so it is
  // there offline. undefined = not looked up yet, null = none.
  const keyOf = (p) => {
    if (!p) return null;
    if (p.folderKey === undefined) {
      p.folderKey = null;
      try {
        const stored = p.db.getMeta('folderKey');
        if (stored) p.folderKey = folderKeyFromBase64(openJson(stored)) || null;
      } catch { p.folderKey = null; }
    }
    return p.folderKey;
  };

  const service = {
    broadcast: (channel, payload) => { try { broadcast(channel, payload); } catch { /* a window closing */ } },

    // One hash computation per (file, size, mtime) at a time, however many
    // callers ask for it at once.
    hashOnce(abs, size, mtime) {
      const key = `${abs}|${size}|${mtime}`;
      let p = hashing.get(key);
      if (!p) {
        p = hashFile(abs).finally(() => hashing.delete(key));
        hashing.set(key, p);
      }
      return p;
    },

    // A change under `.docvex/`, seen by a project's watcher. Only what a
    // sync client delivers matters — our own writes echo back and are skipped.
    onDocvexChange(project, rel) {
      const abs = project.abs(rel);
      if (isOwnEcho(abs)) return;
      const parts = rel.split('/');
      const name = parts[parts.length - 1];
      if (!name || name.startsWith('.')) return; // our temp files
      if (rel === '.docvex/ids.json' || (parts.length === 2 && /^ids[\s\-(].*\.json$/i.test(name))) {
        project.ids.load().catch(() => {});
        return;
      }
      if (parts[1] === 'settings' && parts.length === 3 && (name.endsWith('.json') || name.endsWith(SEALED_EXT))) {
        refreshSettingFromDisk(project, abs).catch(() => {});
        return;
      }
      if (parts[1] === 'knowledge' && parts.length === 4) {
        const sha = name.slice(0, 64);
        if (isShaHex(sha)) importShard(project, sha, { announce: true }).catch(() => {});
      }
    },
  };

  // ── projects ─────────────────────────────────────────────────────────
  function load(projectId, { dir, projectFile, name }) {
    let p = projects.get(projectId);
    if (p && path.resolve(p.dir) !== path.resolve(dir)) {
      p.close();
      projects.delete(projectId);
      p = null;
    }
    if (!p) {
      const db = new IndexDb(path.join(root, `${projectId}.db`));
      p = new Project({ projectId, dir, projectFile, name, db, service });
      projects.set(projectId, p);
    }
    p.projectFile = projectFile || p.projectFile;
    p.name = name || p.name;
    p.lastUsed = Date.now();
    return p;
  }

  // A project already known on this machine (the registry), without touching
  // its folder. null when it isn't.
  function loaded(projectId) {
    if (typeof projectId !== 'string' || !projectId) return null;
    const p = projects.get(projectId);
    if (p) { p.lastUsed = Date.now(); return p; }
    const e = reg().get(projectId);
    if (!e?.dir) return null;
    return load(projectId, e);
  }

  function watchWithCap(p) {
    p.watch();
    const watched = [...projects.values()].filter((x) => x.watcher).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const x of watched.slice(MAX_WATCHED)) x.unwatch();
  }

  // Which project a path belongs to — the innermost registered folder
  // holding it. null → the loose store.
  function projectForPath(abs) {
    let best = null;
    const consider = (projectId, dir) => {
      if (!dir || !isInside(dir, abs)) return;
      if (!best || dir.length > best.dir.length) best = { projectId, dir };
    };
    for (const p of projects.values()) consider(p.projectId, path.resolve(p.dir));
    for (const [projectId, e] of reg().entries()) consider(projectId, e?.dir && path.resolve(e.dir));
    return best ? loaded(best.projectId) : null;
  }

  async function projectOpen({ projectId, name, dir } = {}) {
    if (typeof projectId !== 'string' || !projectId) return { ok: false, error: 'bad_project_id' };
    let target = dir ? path.resolve(String(dir)) : reg().get(projectId)?.dir;
    if (!target) return { ok: false, error: 'not_found' };
    try {
      if (!(await fsp.stat(target)).isDirectory()) return { ok: false, error: 'not_found' };
    } catch { return { ok: false, error: 'not_found' }; }
    // With a folder: link it (write or check the project file). Without one:
    // the registry's folder must still hold THIS project — and if its project
    // file was deleted by hand it is quietly written again.
    const linkName = name || reg().get(projectId)?.name || 'Project';
    const link = await linkProjectFile(target, { projectId, name: linkName });
    if (!link.ok) return { ok: false, error: link.error, dir: target, projectFile: link.projectFile };
    if (link.created) markOwnWrite(link.projectFile);
    const projectName = link.json?.name || linkName;
    reg().set(projectId, { dir: target, projectFile: link.projectFile, name: projectName, lastOpened: Date.now() });
    const p = load(projectId, { dir: target, projectFile: link.projectFile, name: projectName });
    onProjectDir(target);
    const wasWatched = !!p.watcher;
    watchWithCap(p);
    // The listing is served from the index at once; the folder is checked
    // behind it — on the first open this session, and whenever the project
    // wasn't being watched (changes may have been missed).
    if (!p.reconciledOnce || !wasWatched) setImmediate(() => { p.reconcileFull(); });
    return { ok: true, dir: target, projectFile: link.projectFile, rev: p.rev };
  }

  // A `.docvex` file handed over by the OS: register the folder it sits in
  // as that project's, wherever it has been moved to.
  async function registerProjectFile(file) {
    const abs = path.resolve(String(file || ''));
    const json = await readProjectFile(abs);
    if (!json) return { ok: false, error: 'not_a_project_file' };
    const dir = path.dirname(abs);
    const name = json.name || path.basename(abs, path.extname(abs));
    reg().set(json.projectId, { dir, projectFile: abs, name, lastOpened: Date.now() });
    const p = projects.get(json.projectId);
    if (p && path.resolve(p.dir) !== dir) { p.close(); projects.delete(json.projectId); }
    onProjectDir(dir);
    return { ok: true, projectId: json.projectId, dir, name };
  }

  function projectLocate(projectId) {
    const e = typeof projectId === 'string' ? reg().get(projectId) : null;
    return e?.dir ? { dir: e.dir, projectFile: e.projectFile || null } : { dir: null };
  }

  function projectFiles({ projectId } = {}) {
    const p = loaded(projectId);
    if (!p) return { ok: false, error: 'not_found' };
    onProjectDir(p.dir);
    return {
      ok: true,
      dir: p.dir,
      rev: p.rev,
      files: p.db.allFiles().map((r) => p.toRow(r)),
      dirs: p.db.allDirs(),
      reconciling: p.reconciling,
    };
  }

  async function projectReconcile({ projectId } = {}) {
    const p = loaded(projectId);
    if (!p) return { ok: false, error: 'not_found' };
    const res = await p.reconcileFull();
    // `.docvex/` too: account sync writes these through the ordinary folder
    // IPC, and a project that isn't being watched would never notice them.
    // ids.json and the settings are re-read here; knowledge shards are
    // imported by the next knowledgeList (which the renderer's re-hydrate calls).
    await p.ids.load().catch(() => {});
    try {
      const dir = path.join(p.dir, '.docvex', 'settings');
      for (const n of await fsp.readdir(dir)) {
        if ((n.endsWith('.json') || n.endsWith(SEALED_EXT)) && !n.startsWith('.')) await refreshSettingFromDisk(p, path.join(dir, n)).catch(() => {});
      }
    } catch { /* no settings yet */ }
    return res?.ok === false ? res : { ok: true, changed: res?.changed || 0 };
  }

  async function projectFileId({ path: file } = {}) {
    if (!file) return { ok: false, error: 'no_path', id: null };
    const abs = path.resolve(String(file));
    const p = projectForPath(abs);
    if (!p) return { ok: true, id: null };
    const rel = p.rel(abs);
    let row = p.db.fileByRel(rel);
    if (!row) {
      await p.enqueue({ files: [rel] });
      row = p.db.fileByRel(rel);
    }
    return { ok: true, id: row?.id || null };
  }

  async function projectPathForId({ projectId, id } = {}) {
    const p = loaded(projectId);
    if (!p || !id) return { ok: true, path: null };
    const row = p.db.fileById(String(id));
    if (row) return { ok: true, path: p.abs(row.rel) };
    await p.loadIds();
    const e = p.ids.get(String(id));
    if (e?.rel) {
      const abs = p.abs(e.rel);
      try { if ((await fsp.stat(abs)).isFile()) return { ok: true, path: abs }; } catch { /* not here (yet) */ }
    }
    return { ok: true, path: null };
  }

  // ── knowledge ────────────────────────────────────────────────────────
  // The content hash of a loose file, cached in `_loose.db` by machine id.
  async function looseHash(abs) {
    const st = await fsp.stat(abs, { bigint: true });
    if (!st.isFile()) throw new Error('not_a_file');
    const fid = st.ino && st.ino !== 0n ? String(st.ino) : `p:${abs}`;
    const size = Number(st.size);
    const mtime = Number(st.mtimeMs);
    const db = looseDb();
    const row = db.fileByFid(fid);
    if (row && row.rel === abs && row.size === size && row.mtime === mtime && row.hash) return row.hash;
    const hash = await service.hashOnce(abs, size, mtime);
    const name = path.basename(abs);
    const i = name.lastIndexOf('.');
    db.upsertFile({
      fid, id: null, rel: abs, name, dir: path.dirname(abs), ext: i > 0 ? name.slice(i + 1).toLowerCase() : '',
      size, mtime, hash, seen: Date.now(),
    });
    return hash;
  }

  async function contextFor(file) {
    const abs = path.resolve(String(file));
    const p = projectForPath(abs);
    if (p) return { abs, project: p, db: p.db, hash: await p.hashFor(abs) };
    return { abs, project: null, db: looseDb(), hash: await looseHash(abs) };
  }

  // Fold a shard from the folder into the index — facets newer than the
  // index's win. With `announce`, every file with that content is told.
  async function importShard(p, sha, { announce = false } = {}) {
    const shard = await readShard(p.dir, sha, markOwnWrite, keyOf(p));
    p.shardsChecked.add(sha);
    if (!shard) return [];
    const have = p.db.knowledgeFor(sha);
    const changed = [];
    p.db.tx(() => {
      for (const [kind, facet] of Object.entries(shard.facets)) {
        if (!KIND_RE.test(kind) || LOCAL_KINDS.has(kind)) continue;
        const mine = have[kind];
        if (mine && (Number(mine.facet?.at) || 0) >= (Number(facet?.at) || 0)) continue;
        p.db.putKnowledge(sha, kind, facet, false);
        changed.push(kind);
      }
    });
    if (announce && changed.length) {
      for (const row of p.db.filesByHash(sha)) {
        for (const kind of changed) service.broadcast('knowledge:changed', { path: p.abs(row.rel), kind, projectId: p.projectId });
      }
    }
    return changed;
  }

  async function knowledgeGet({ path: file, kinds } = {}) {
    if (!file) return { ok: false, error: 'no_path', facets: {} };
    const ctx = await contextFor(file);
    if (ctx.project && !ctx.project.shardsChecked.has(ctx.hash)) await importShard(ctx.project, ctx.hash);
    const want = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
    const facets = {};
    for (const [kind, { facet }] of Object.entries(ctx.db.knowledgeFor(ctx.hash))) {
      if (!want || want.has(kind)) facets[kind] = facet;
    }
    return { ok: true, facets };
  }

  async function knowledgePut({ path: file, kind, facet } = {}) {
    if (!file) return { ok: false, error: 'no_path' };
    if (!KIND_RE.test(String(kind || ''))) return { ok: false, error: 'bad_kind' };
    const ctx = await contextFor(file);
    const f = normalizeFacet(kind, facet);
    const local = LOCAL_KINDS.has(kind) || f.local === true;
    ctx.db.putKnowledge(ctx.hash, kind, f, local);
    if (ctx.project && !local) {
      await writeShardFacet(ctx.project.dir, ctx.hash, { name: path.basename(ctx.abs), kind, facet: f }, markOwnWrite, keyOf(ctx.project));
    }
    service.broadcast('knowledge:changed', { path: ctx.abs, kind, projectId: ctx.project?.projectId || null });
    return { ok: true };
  }

  async function knowledgeClear({ path: file, kind } = {}) {
    if (!file) return { ok: false, error: 'no_path' };
    if (!KIND_RE.test(String(kind || ''))) return { ok: false, error: 'bad_kind' };
    const ctx = await contextFor(file);
    ctx.db.clearKnowledge(ctx.hash, kind);
    if (ctx.project && !LOCAL_KINDS.has(kind)) {
      await writeShardFacet(ctx.project.dir, ctx.hash, { kind, facet: null }, markOwnWrite, keyOf(ctx.project));
    }
    service.broadcast('knowledge:changed', { path: ctx.abs, kind, projectId: ctx.project?.projectId || null });
    return { ok: true };
  }

  // Everything known about the project's files. Shards that arrived with the
  // folder (another machine, a sync) are imported first; a shard whose
  // content no indexed file is known to have is matched by the file NAME it
  // records, and only those candidates are hashed — never the whole folder.
  async function knowledgeList({ projectId, kinds } = {}) {
    const p = loaded(projectId);
    if (!p) return { ok: false, error: 'not_found', items: [] };
    const shards = await listShards(p.dir);
    for (const { sha, mtimeMs } of shards) {
      if (p.shardMtimes.get(sha) === mtimeMs) continue;
      await importShard(p, sha);
      p.shardMtimes.set(sha, mtimeMs);
    }
    const rows = p.db.allFiles();
    const knownHashes = new Set(rows.map((r) => r.hash).filter(Boolean));
    const orphanShas = shards.map((s) => s.sha).filter((sha) => !knownHashes.has(sha));
    if (orphanShas.length) {
      const names = new Set();
      for (const sha of orphanShas) {
        const shard = await readShard(p.dir, sha, markOwnWrite, keyOf(p));
        if (shard?.name) names.add(shard.name);
      }
      for (const r of rows) {
        if (r.hash || !names.has(r.name)) continue;
        try { await p.hashFor(p.abs(r.rel)); } catch { /* unreadable */ }
      }
    }
    const want = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
    const byHash = new Map();
    for (const k of p.db.knowledgeAll()) {
      if (want && !want.has(k.kind)) continue;
      if (!byHash.has(k.hash)) byHash.set(k.hash, {});
      byHash.get(k.hash)[k.kind] = k.facet;
    }
    const items = [];
    for (const r of p.db.allFiles()) {
      const facets = r.hash && byHash.get(r.hash);
      if (facets) items.push({ path: p.abs(r.rel), rel: r.rel, id: r.id, facets });
    }
    return { ok: true, items };
  }

  // ── settings ─────────────────────────────────────────────────────────
  // In the folder a setting is `.docvex/settings/<store>.dvxe`, sealed with the
  // project's folder key; a plain `<store>.json` from an older build is still
  // read, and replaced by the sealed file on the next write (or sealFolder).
  // Without the key the index keeps the value and nothing goes into the folder.
  const settingsFile = (p, store) => path.join(p.dir, '.docvex', 'settings', `${storeFileName(store)}.json`);
  const sealedSettingsFile = (p, store) => path.join(p.dir, '.docvex', 'settings', `${storeFileName(store)}${SEALED_EXT}`);

  // { value, at } from one settings file, or null (missing, unreadable, or
  // sealed without the key).
  async function readSettingFile(p, abs) {
    const json = await readJson(abs);
    if (!json || typeof json !== 'object') return null;
    if (isSealedFolderJson(json)) {
      try { const v = openFromFolder(keyOf(p), json); return v && typeof v === 'object' ? v : null; } catch { return null; }
    }
    return json;
  }
  // The newer of the sealed and the plain file.
  async function readSettingDisk(p, store) {
    const a = await readSettingFile(p, sealedSettingsFile(p, store));
    const b = await readSettingFile(p, settingsFile(p, store));
    if (!a) return b;
    if (!b) return a;
    return (Number(b.at) || 0) > (Number(a.at) || 0) ? b : a;
  }
  async function writeSettingDisk(p, store, value, at) {
    const key = keyOf(p);
    if (!isFolderKey(key)) return false;
    const file = sealedSettingsFile(p, store);
    markOwnWrite(file);
    await writeJsonAtomic(file, sealForFolder(key, { v: 1, at, value: value ?? null }));
    const plain = settingsFile(p, store);
    markOwnWrite(plain);
    await fsp.unlink(plain).catch(() => {});
    return true;
  }

  async function refreshSettingFromDisk(p, abs) {
    const ext = abs.endsWith(SEALED_EXT) ? SEALED_EXT : '.json';
    const base = path.basename(abs, ext);
    let store;
    try { store = decodeURIComponent(base); } catch { return; }
    const disk = await readSettingFile(p, abs);
    if (!disk || typeof disk !== 'object') return;
    const idx = p.db.getSetting(store);
    if (idx && idx.at >= (Number(disk.at) || 0)) return;
    p.db.putSetting(store, disk.value ?? null, Number(disk.at) || 0);
    service.broadcast('settings:changed', { projectId: p.projectId, store });
  }

  async function settingsGet({ projectId, store } = {}) {
    if (typeof store !== 'string' || !store) return { ok: false, error: 'bad_store', value: null };
    const p = loaded(projectId);
    if (!p) {
      const r = looseDb().getSetting(`${projectId || ''}\u0000${store}`);
      return { ok: true, value: r ? r.value : null };
    }
    const idx = p.db.getSetting(store);
    const disk = await readSettingDisk(p, store);
    if (disk && typeof disk === 'object' && (!idx || (Number(disk.at) || 0) > idx.at)) {
      p.db.putSetting(store, disk.value ?? null, Number(disk.at) || 0);
      return { ok: true, value: disk.value ?? null, at: Number(disk.at) || 0 };
    }
    return { ok: true, value: idx ? idx.value : null, at: idx?.at || 0 };
  }

  async function settingsPut({ projectId, store, value } = {}) {
    if (typeof store !== 'string' || !store) return { ok: false, error: 'bad_store' };
    const p = loaded(projectId);
    if (!p) {
      looseDb().putSetting(`${projectId || ''}\u0000${store}`, value ?? null, Date.now());
      service.broadcast('settings:changed', { projectId: projectId || null, store });
      return { ok: true };
    }
    // Strictly later than whatever is recorded, so two writes in one
    // millisecond still order.
    const prev = p.db.getSetting(store);
    const at = Math.max(Date.now(), (prev?.at || 0) + 1);
    p.db.putSetting(store, value ?? null, at);
    await writeSettingDisk(p, store, value, at);
    service.broadcast('settings:changed', { projectId: p.projectId, store });
    return { ok: true };
  }

  // ── the folder key ───────────────────────────────────────────────────
  // The renderer hands in the project's key (base64, 32 bytes). Kept in the
  // project's database, then the folder is brought in line in the background:
  // plain shards and settings are sealed, and what the index knows but the
  // folder doesn't (written while there was no key) is written out.
  async function projectFolderKey({ projectId, key } = {}) {
    const buf = folderKeyFromBase64(key);
    if (!buf) return { ok: false, error: 'bad_key' };
    const p = loaded(projectId);
    if (!p) return { ok: false, error: 'not_found' };
    const had = keyOf(p);
    if (had && had.equals(buf)) return { ok: true, changed: false };
    p.folderKey = buf;
    p.db.setMeta('folderKey', sealJson(buf.toString('base64')));
    p.sealing = (p.sealing || Promise.resolve()).then(() => sealFolder(p)).catch(() => {});
    return { ok: true, changed: true };
  }

  async function sealFolder(p) {
    const key = keyOf(p);
    if (!isFolderKey(key)) return;
    // Knowledge: reading a shard with the key seals it (readShard).
    const shards = await listShards(p.dir);
    const inFolder = new Set();
    for (const { sha } of shards) {
      await readShard(p.dir, sha, markOwnWrite, key).catch(() => {});
      inFolder.add(sha);
    }
    // What only the index knows.
    const byHash = new Map();
    for (const k of p.db.knowledgeAll()) {
      if (k.local || LOCAL_KINDS.has(k.kind) || k.facet?.local === true) continue;
      if (inFolder.has(k.hash) || !isShaHex(k.hash)) continue;
      if (!byHash.has(k.hash)) byHash.set(k.hash, []);
      byHash.get(k.hash).push(k);
    }
    for (const [hash, rows] of byHash) {
      if (await hasShardFile(p.dir, hash)) continue;
      const name = p.db.filesByHash(hash)[0]?.name || null;
      for (const k of rows) {
        await writeShardFacet(p.dir, hash, { name, kind: k.kind, facet: k.facet }, markOwnWrite, key).catch(() => {});
      }
    }
    // Settings: every store the folder or the index holds, written sealed.
    const dir = path.join(p.dir, '.docvex', 'settings');
    const stores = new Set();
    try {
      for (const n of await fsp.readdir(dir)) {
        if (n.startsWith('.')) continue;
        const ext = n.endsWith(SEALED_EXT) ? SEALED_EXT : n.endsWith('.json') ? '.json' : null;
        if (!ext) continue;
        try { stores.add(decodeURIComponent(path.basename(n, ext))); } catch { /* not ours */ }
      }
    } catch { /* no settings folder yet */ }
    for (const store of p.db.settingStores()) stores.add(store);
    for (const store of stores) {
      const disk = await readSettingDisk(p, store);
      const idx = p.db.getSetting(store);
      const best = idx && (!disk || idx.at >= (Number(disk.at) || 0))
        ? { value: idx.value, at: idx.at }
        : disk && { value: disk.value ?? null, at: Number(disk.at) || 0 };
      if (best) await writeSettingDisk(p, store, best.value, best.at).catch(() => {});
    }
  }

  // ── private (machine-local, per user) ─────────────────────────────────
  const privateDb = (projectId) => loaded(projectId)?.db || looseDb();
  // In the loose store every project's keys share one table, so they are
  // prefixed with the project id they were asked under.
  const privateKey = (projectId, key) => (loaded(projectId) ? key : `${projectId || ''}\u0000${key}`);

  function privateGet({ projectId, userId, key } = {}) {
    if (!userId || typeof key !== 'string') return { ok: false, error: 'bad_args', value: null };
    const r = privateDb(projectId).getPrivate(String(userId), privateKey(projectId, key));
    return { ok: true, value: r ? r.value : null, at: r?.at || 0 };
  }

  function privatePut({ projectId, userId, key, value } = {}) {
    if (!userId || typeof key !== 'string') return { ok: false, error: 'bad_args' };
    privateDb(projectId).putPrivate(String(userId), privateKey(projectId, key), value, Date.now());
    return { ok: true };
  }

  function privateList({ projectId, userId, prefix = '' } = {}) {
    if (!userId) return { ok: false, error: 'bad_args', items: [] };
    const isLoose = !loaded(projectId);
    const lead = isLoose ? `${projectId || ''}\u0000` : '';
    const items = privateDb(projectId).listPrivate(String(userId), lead + String(prefix || ''))
      .map((it) => ({ ...it, key: it.key.slice(lead.length) }));
    return { ok: true, items };
  }

  function close() {
    for (const p of projects.values()) { try { p.close(); } catch { /* closing anyway */ } }
    projects.clear();
    if (loose) loose.close();
    loose = null;
  }

  // Every call answers `{ ok: false, error }` instead of throwing, so a bad
  // path or a locked file never turns into an unhandled rejection in an IPC
  // handler.
  const safe = (fn) => async (...args) => {
    try { return await fn(...args); } catch (err) { return { ok: false, error: errorOf(err) }; }
  };

  return {
    projectOpen: safe(projectOpen),
    projectLocate: safe(projectLocate),
    projectFiles: safe(projectFiles),
    projectReconcile: safe(projectReconcile),
    projectFileId: safe(projectFileId),
    projectPathForId: safe(projectPathForId),
    knowledgeGet: safe(knowledgeGet),
    knowledgePut: safe(knowledgePut),
    knowledgeClear: safe(knowledgeClear),
    knowledgeList: safe(knowledgeList),
    settingsGet: safe(settingsGet),
    settingsPut: safe(settingsPut),
    projectFolderKey: safe(projectFolderKey),
    privateGet: safe(privateGet),
    privatePut: safe(privatePut),
    privateList: safe(privateList),
    registerProjectFile: safe(registerProjectFile),
    // The folder a project file sits in, if it claims one — main.js's old
    // project-dir resolution asks this where it used to read `.docvex.json`.
    projectIdOfFolder: async (dir) => (await findProjectFiles(dir))[0]?.json.projectId || null,
    close,
    // For tests.
    _projects: projects,
  };
}
