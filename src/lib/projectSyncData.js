// ── Sync a project's DATA with the account ───────────────────────────────────
// lib/projectSync carries a synced project's FILES. Everything DocVex keeps
// ABOUT them lives in this device's localStorage, keyed by absolute path, and
// would otherwise stay behind: the AI data (extracted text, identity readings),
// metadata snapshots, captions, OCR snippets, AI file descriptions, timeline
// scan readings, each Word file's document theme, folder colours, the case
// timeline, the Doc Viewer advisor threads and the Advisor chats.
//
// It travels as TWO JSON bundles beside the files, written after every sync:
//
//   project-sync/<project id>/.docvex-data.json     SHARED — worked out from the
//       files (text, metadata, captions, colours, timeline). Any project member
//       can read it, exactly like the files it describes.
//   project-sync/user-<user id>/<project id>.json   PRIVATE — the user's own
//       conversations (Doc Viewer advisor threads, Advisor chats). Migration 036
//       limits that folder to its owner; before it is applied every policy on
//       the bucket refuses the path, so the private bundle fails CLOSED (it is
//       reported, never written somewhere teammates could read it).
//
// Inside a bundle a file is named by its path INSIDE THE PROJECT, never by this
// machine's absolute path, and anything stamped with a file's size + modified
// time is re-stamped with the MANIFEST's version on the way up and with this
// device's stat on the way down — so data made from the version both devices
// now hold is recognised as current on both.
//
// WHICH COPY WINS: per entry, the newer — each store says what "when" means
// (a facet's `at`, a thread's `updatedAt`, the sync clock for stores with no
// timestamp of their own, see lib/syncClock). Some merge finer than that: AI
// data per facet, OCR snippets and chats per item.
import { supabase } from './supabaseClient';
import { localFolderApi } from './localFolder';
import { AI_DATA_PREFIX } from './aiData';
import { METADATA_PREFIX } from './metadataHistory';
import { CAPTIONS_PREFIX } from './captionsHistory';
import { OCR_HISTORY_PREFIX } from './extractionHistory';
import { CONVERSATION_PREFIX } from './conversationHistory';
import { DOC_THEME_PREFIX } from './docThemes';
import { folderColorsKey } from './folderColors';
import { timelineKeyFor } from './caseTimeline';
import { fileIndexRecord, adoptFileIndexRecord } from './aiFileIndex';
import { loadExtract, saveExtract } from './scanExtractCache';
import { touch, touchedAt, touchedUnder, goneFor, setGone } from './syncClock';

export const DATA_NAME = '.docvex-data.json';
export const privateDataPath = (userId, projectId) => `user-${userId}/${projectId}.json`;
// ProjectAI.jsx's STORAGE_PREFIX — keep the two in step.
const AI_CHAT_PREFIX = 'docvex.aichat.v3.';
const OCR_MAX = 30;           // lib/extractionHistory's MAX_ENTRIES
const MTIME_SLACK_MS = 2000;  // lib/projectSync's — the same file, a copy apart

const bucket = () => supabase.storage.from('project-sync');

// ── Paths ───────────────────────────────────────────────────────────────────
const slashed = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const folded = (p) => slashed(p).toLowerCase();
const relPathOf = (f) => (f.folderPath ? `${f.folderPath}/${f.name}` : f.name);

// Everything the stores need to know about the project on THIS device.
function makeContext({ projectId, userId, dir, files, manifest }) {
  const root = slashed(dir);
  const sep = String(dir).includes('\\') ? '\\' : '/';
  const byRel = new Map();
  const relByPath = new Map();
  for (const f of files) {
    const rel = relPathOf(f);
    byRel.set(rel, f);
    relByPath.set(folded(f.path || rel), rel);
  }
  const manifestByRel = new Map(Object.values(manifest?.files || {}).map((m) => [m.path, m]));
  return {
    projectId,
    userId,
    byRel,
    manifestByRel,
    // A file's path inside the project, or null when it isn't one of the
    // project's files on this device.
    relOfFile: (abs) => relByPath.get(folded(abs)) || null,
    // The project's file called `name` — the one at the top of the folder, else
    // the only one of that name anywhere in it. null when it is ambiguous.
    relOfName: (name) => {
      if (!name) return null;
      if (byRel.has(name)) return name;
      const hits = [...byRel.keys()].filter((rel) => rel.split('/').pop() === name);
      return hits.length === 1 ? hits[0] : null;
    },
    // A FOLDER's path inside the project (folders aren't in the listing).
    relOfDir: (abs) => {
      const a = slashed(abs);
      if (!root || a.toLowerCase() === root.toLowerCase()) return null;
      return a.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? a.slice(root.length + 1) : null;
    },
    dirOfRel: (rel) => (root ? `${String(dir).replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}` : null),
    // Stamps: this device's stat ⇄ the manifest's version of the file.
    toCanonical(stamp, rel) {
      const f = byRel.get(rel);
      const m = manifestByRel.get(rel);
      if (!stamp || !f || !m || !sameVersion(stamp, { size: f.sizeBytes, mtime: f.mtimeIso })) return stamp;
      return { size: m.size, mtime: m.mtime };
    },
    toLocal(stamp, rel) {
      const f = byRel.get(rel);
      const m = manifestByRel.get(rel);
      if (!stamp || !f || !m || !sameVersion(stamp, { size: m.size, mtime: m.mtime })) return stamp;
      if (!sameVersion({ size: m.size, mtime: m.mtime }, { size: f.sizeBytes, mtime: f.mtimeIso })) return stamp;
      return { size: f.sizeBytes ?? null, mtime: f.mtimeIso ?? null };
    },
  };
}

function sameVersion(a, b) {
  if (a?.size != null && b?.size != null && Number(a.size) !== Number(b.size)) return false;
  if (a?.mtime && b?.mtime) {
    return Math.abs(new Date(a.mtime).getTime() - new Date(b.mtime).getTime()) <= MTIME_SLACK_MS;
  }
  return true;
}

// ── localStorage ────────────────────────────────────────────────────────────
function readRaw(key) { try { return localStorage.getItem(key); } catch { return null; } }
function readJson(key) {
  const raw = readRaw(key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function writeRaw(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch { return false; }
}
function allKeys() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); if (k) out.push(k); } } catch { /* none */ }
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Per-file stores kept under `<prefix><path>` ────────────────────────────
// `read(raw, rel, ctx)` → { at, value } in the bundle's form (canonical stamps),
// `write(value, rel, ctx)` → the string stored on this device,
// `merge(local, remote)` (optional) → a value combining both.
const maxAt = (xs) => Math.max(0, ...xs.map((x) => Number(x) || 0));

const FILE_STORES = [
  {
    slot: 'aiData',
    bundle: 'shared',
    prefix: AI_DATA_PREFIX,
    read(raw, rel, ctx) {
      const rec = safeParse(raw);
      if (!rec?.facets || typeof rec.facets !== 'object') return null;
      const facets = {};
      for (const [k, f] of Object.entries(rec.facets)) {
        if (f && f.data != null) facets[k] = { ...f, stamp: ctx.toCanonical(f.stamp, rel) };
      }
      if (!Object.keys(facets).length) return null;
      return { at: maxAt(Object.values(facets).map((f) => f.at)), value: { name: rec.name || '', facets } };
    },
    merge(local, remote) {
      const facets = { ...(local.value.facets || {}) };
      for (const [k, f] of Object.entries(remote.value.facets || {})) {
        if (!facets[k] || (Number(f?.at) || 0) > (Number(facets[k].at) || 0)) facets[k] = f;
      }
      const value = { name: local.value.name || remote.value.name, facets };
      return { at: maxAt(Object.values(facets).map((f) => f.at)), value };
    },
    write(value, rel, ctx) {
      const f = ctx.byRel.get(rel);
      const facets = {};
      for (const [k, facet] of Object.entries(value.facets || {})) facets[k] = { ...facet, stamp: ctx.toLocal(facet.stamp, rel) };
      return JSON.stringify({ path: f.path, name: value.name || f.name, projectId: ctx.projectId, facets });
    },
  },
  {
    slot: 'metadata',
    bundle: 'shared',
    prefix: METADATA_PREFIX,
    read(raw, rel, ctx) {
      const v = safeParse(raw);
      if (!v || !Array.isArray(v.groups)) return null;
      const stamp = ctx.toCanonical({ size: v.size, mtime: v.mtime }, rel);
      return { at: Number(v.extractedAt) || 0, value: { ...v, size: stamp?.size ?? null, mtime: stamp?.mtime ?? null } };
    },
    write(value, rel, ctx) {
      const stamp = ctx.toLocal({ size: value.size, mtime: value.mtime }, rel);
      return JSON.stringify({ ...value, size: stamp?.size ?? null, mtime: stamp?.mtime ?? null });
    },
  },
  {
    // Before the AI file index: a description's version key includes the
    // file's transcript, so the transcript has to be in place first.
    slot: 'captions',
    bundle: 'shared',
    prefix: CAPTIONS_PREFIX,
    read(raw) {
      const v = safeParse(raw);
      if (!v || typeof v.text !== 'string') return null;
      return { at: Number(v.updatedAt || v.createdAt) || 0, value: v };
    },
    write: (value) => JSON.stringify(value),
  },
  {
    slot: 'ocr',
    bundle: 'shared',
    prefix: OCR_HISTORY_PREFIX,
    read(raw) {
      const v = safeParse(raw);
      if (!Array.isArray(v) || !v.length) return null;
      return { at: maxAt(v.map((e) => e?.createdAt)), value: v };
    },
    merge(local, remote) {
      const byId = new Map();
      for (const e of [...remote.value, ...local.value]) if (e?.id) byId.set(e.id, e);
      const value = [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, OCR_MAX);
      return { at: maxAt(value.map((e) => e.createdAt)), value };
    },
    write: (value) => JSON.stringify(value),
  },
  {
    // The document's theme, keyed by the preview's `localfile://` url.
    slot: 'theme',
    bundle: 'shared',
    prefix: DOC_THEME_PREFIX,
    pathOf(rest) {
      const m = /^localfile:\/\/local\/(.+)$/.exec(rest);
      if (!m) return null;
      try { return decodeURIComponent(m[1]); } catch { return null; }
    },
    keyOf: (path) => `${DOC_THEME_PREFIX}localfile://local/${encodeURIComponent(path)}`,
    read(raw, rel, ctx, key) {
      // A theme set back to the default is REMOVED — the clock still says when.
      return { at: touchedAt(key), value: raw == null ? null : raw };
    },
    write: (value) => value,
    clocked: true,
  },
  {
    // The audio waveform (lib/audioEnvelopeCache) — keyed by the preview's
    // `localfile://` url + sample rate, stored 8-bit base64, LRU-indexed.
    slot: 'waveform',
    bundle: 'shared',
    prefix: 'docvex:doc-viewer:envelope:',
    pathOf(rest) {
      let id;
      try { id = decodeURIComponent(rest); } catch { return null; }
      const m = /^localfile:\/\/local\/(.+):(\d+)$/.exec(id);
      if (!m) return null;
      try { return decodeURIComponent(m[1]); } catch { return null; }
    },
    read(raw, rel, ctx, key) {
      if (!raw || key.endsWith(':index')) return null;
      let id = '';
      try { id = decodeURIComponent(key.slice('docvex:doc-viewer:envelope:'.length)); } catch { return null; }
      const hz = Number(/:(\d+)$/.exec(id)?.[1]) || 120;
      // A waveform is the file's, made once — any copy is as good as another.
      return { at: 0, value: { hz, data: raw } };
    },
    keyOf: (path, value) => `docvex:doc-viewer:envelope:${encodeURIComponent(`localfile://local/${encodeURIComponent(path)}:${value?.hz || 120}`)}`,
    write: (value) => value.data,
    // Keep it in the cache's own LRU index, or it would never be evicted.
    afterWrite(key) {
      try {
        const id = decodeURIComponent(key.slice('docvex:doc-viewer:envelope:'.length));
        const idx = (JSON.parse(localStorage.getItem('docvex:doc-viewer:envelope:index') || '[]') || []).filter((k) => k !== id);
        idx.push(id);
        localStorage.setItem('docvex:doc-viewer:envelope:index', JSON.stringify(idx));
      } catch { /* the cache rebuilds its index as it goes */ }
    },
  },
  {
    slot: 'conversation',
    bundle: 'private',
    prefix: CONVERSATION_PREFIX,
    // lib/conversationHistory folds the path (slashes, lower case) into its key.
    keyOf: (path) => CONVERSATION_PREFIX + folded(path),
    read(raw) {
      const v = safeParse(raw);
      if (!v || typeof v !== 'object') return null;
      return { at: Number(v.updatedAt) || 0, value: v };
    },
    write: (value) => JSON.stringify(value),
  },
];

function safeParse(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Every file store's entries on this device: { [bundle]: { [rel]: { [slot]: { at, value, key } } } }.
function collectFileStores(ctx) {
  const out = { shared: {}, private: {} };
  const put = (store, rel, entry, key) => {
    if (!entry) return;
    const files = out[store.bundle];
    const cur = files[rel]?.[store.slot];
    // The same file under two spellings of its path (an older raw-path key):
    // the newer one speaks for it.
    if (cur && (cur.at || 0) >= (entry.at || 0)) return;
    (files[rel] ||= {})[store.slot] = { ...entry, key };
  };
  const keys = allKeys();
  for (const store of FILE_STORES) {
    const seen = new Set();
    for (const key of keys) {
      if (!key.startsWith(store.prefix)) continue;
      const rest = key.slice(store.prefix.length);
      const path = store.pathOf ? store.pathOf(rest) : rest;
      const rel = path && ctx.relOfFile(path);
      if (!rel) continue;
      seen.add(key);
      put(store, rel, store.read(readRaw(key), rel, ctx, key), key);
    }
    if (store.clocked) {
      // Cleared entries: nothing stored, only the clock remembers.
      for (const [key] of Object.entries(touchedUnder(store.prefix))) {
        if (seen.has(key)) continue;
        const path = store.pathOf ? store.pathOf(key.slice(store.prefix.length)) : key.slice(store.prefix.length);
        const rel = path && ctx.relOfFile(path);
        if (rel) put(store, rel, store.read(null, rel, ctx, key), key);
      }
    }
  }
  // Not prefix-keyed: the AI file index and the timeline scan's readings.
  for (const [rel, f] of ctx.byRel) {
    const idx = fileIndexRecord(f);
    if (idx) (out.shared[rel] ||= {}).index = { at: idx.at, value: { desc: idx.desc } };
    const scan = loadExtract(scanFileOf(f));
    if (scan) (out.shared[rel] ||= {}).scan = { at: Number(scan.at) || 0, value: scan };
  }
  return out;
}

// lib/scanExtractCache keys a reading by name | size | lastModified.
const scanFileOf = (f) => ({ name: f.name, size: f.sizeBytes, lastModified: f.mtimeIso ? new Date(f.mtimeIso).getTime() : 0 });

// Store `value` for `rel` on this device. Returns whether anything changed.
function applyFileSlot(slot, rel, entry, localEntry, ctx) {
  const f = ctx.byRel.get(rel);
  if (!f) return false;   // not on this device: nothing to attach it to
  if (slot === 'index') return adoptFileIndexRecord(f, { desc: entry.value?.desc, at: entry.at });
  if (slot === 'scan') {
    if (loadExtract(scanFileOf(f))) return false;
    saveExtract(scanFileOf(f), entry.value);
    return true;
  }
  const store = FILE_STORES.find((s) => s.slot === slot);
  if (!store) return false;
  const key = localEntry?.key || (store.keyOf ? store.keyOf(f.path, entry.value) : store.prefix + f.path);
  const next = entry.value == null ? null : store.write(entry.value, rel, ctx);
  if (readRaw(key) === next) return false;
  if (!writeRaw(key, next)) return false;
  if (store.clocked) touch(key, entry.at);
  store.afterWrite?.(key);
  return true;
}

// ── Project-wide stores ─────────────────────────────────────────────────────
const PROJECT_STORES = [
  {
    slot: 'folderColors',
    bundle: 'shared',
    key: (ctx) => folderColorsKey(ctx.projectId),
    read(ctx, key) {
      const map = readJson(key);
      if (!map && !touchedAt(key)) return null;
      const value = {};
      for (const [id, color] of Object.entries(map || {})) {
        const rel = id.startsWith('dir:') ? ctx.relOfDir(id.slice(4)) : null;
        if (rel) value[rel] = color;
      }
      return { at: touchedAt(key), value };
    },
    write(ctx, key, value) {
      // Colours of folders outside the project's folder (none, normally) stay.
      const next = {};
      for (const [id, color] of Object.entries(readJson(key) || {})) {
        if (!(id.startsWith('dir:') && ctx.relOfDir(id.slice(4)))) next[id] = color;
      }
      for (const [rel, color] of Object.entries(value || {})) {
        const abs = ctx.dirOfRel(rel);
        if (abs) next[`dir:${abs}`] = color;
      }
      return JSON.stringify(next);
    },
    clocked: true,
  },
  {
    slot: 'timeline',
    bundle: 'shared',
    key: (ctx) => timelineKeyFor(ctx.projectId),
    read(ctx, key) {
      const t = readJson(key);
      if (!t) return null;
      const fileRefs = {};
      for (const [name, ref] of Object.entries(t.fileRefs || {})) {
        // A file dropped onto the Timeline is remembered by where it was dropped
        // FROM (Downloads, a USB stick…); the Timeline then files a copy into the
        // project. That copy is what another device has, so fall back to it.
        const rel = (ref?.path && ctx.relOfFile(ref.path))
          || ctx.relOfName(String(ref?.path || '').split(/[\\/]/).pop() || name)
          || ref?.rel || null;
        fileRefs[name] = { ...ref, path: undefined, rel };
      }
      const at = touchedAt(key) || new Date(t.meta?.generatedAt || 0).getTime() || 0;
      return { at, value: { ...t, fileRefs } };
    },
    write(ctx, key, value) {
      const fileRefs = {};
      for (const [name, ref] of Object.entries(value.fileRefs || {})) {
        const f = ref?.rel ? ctx.byRel.get(ref.rel) : null;
        fileRefs[name] = { ...ref, path: f?.path || ref?.path || null };
      }
      return JSON.stringify({ ...value, fileRefs });
    },
    clocked: true,
  },
  {
    // The Advisor's saved chats: merged per thread (newest `updatedAt`), with
    // deleted threads remembered so another device's copy can't revive them.
    slot: 'aiChats',
    bundle: 'private',
    key: (ctx) => `${AI_CHAT_PREFIX}${ctx.userId}.${ctx.projectId}`,
    read(ctx, key) {
      const threads = readJson(key);
      const gone = goneFor(key);
      if (!Array.isArray(threads) && !Object.keys(gone).length) return null;
      const list = Array.isArray(threads) ? threads : [];
      return { at: maxAt(list.map((t) => t?.updatedAt)), value: { threads: list, gone } };
    },
    merge(local, remote) {
      const gone = { ...(remote.value.gone || {}) };
      for (const [id, at] of Object.entries(local.value.gone || {})) gone[id] = Math.max(Number(gone[id]) || 0, Number(at) || 0);
      const byId = new Map();
      for (const t of [...(remote.value.threads || []), ...(local.value.threads || [])]) {
        if (!t?.id) continue;
        const cur = byId.get(t.id);
        if (!cur || (t.updatedAt || 0) >= (cur.updatedAt || 0)) byId.set(t.id, t);
      }
      const threads = [...byId.values()]
        .filter((t) => !(Number(gone[t.id]) >= (t.updatedAt || 0)))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { at: maxAt(threads.map((t) => t.updatedAt)), value: { threads, gone } };
    },
    write(ctx, key, value) {
      setGone(key, value.gone);
      return JSON.stringify(value.threads || []);
    },
  },
];

// ── Bundles in the account ──────────────────────────────────────────────────
const emptyBundle = (projectId) => ({ version: 1, projectId, at: null, files: {}, project: {} });

async function downloadBundle(path) {
  const { data, error } = await bucket().download(path);
  if (error) return { bundle: null, error };
  try {
    const parsed = JSON.parse(await data.text());
    return { bundle: parsed && typeof parsed === 'object' ? parsed : null, error: null };
  } catch (err) {
    return { bundle: null, error: err };
  }
}

async function uploadBundle(path, bundle) {
  const body = new Blob([JSON.stringify({ ...bundle, at: new Date().toISOString() })], { type: 'application/json' });
  const { error } = await bucket().upload(path, body, { upsert: true, contentType: 'application/json' });
  return { error };
}

// Merge one bundle (the account's) with this device's entries. Writes what is
// newer in the account onto this device and returns the bundle to upload.
function mergeBundle({ which, remote, local, ctx, removedRels }) {
  let applied = 0;
  const files = {};

  // Files: every rel either side knows, minus the ones this sync deleted.
  const rels = new Set([...Object.keys(remote.files || {}), ...Object.keys(local.files || {})]);
  const order = ['aiData', 'metadata', 'captions', 'ocr', 'theme', 'waveform', 'conversation', 'index', 'scan'];
  for (const rel of rels) {
    if (removedRels.has(rel)) continue;
    const r = remote.files?.[rel] || {};
    const l = local.files?.[rel] || {};
    const slots = {};
    for (const slot of order) {
      const re = r[slot];
      const le = l[slot];
      if (!re && !le) continue;
      let win;
      const store = FILE_STORES.find((s) => s.slot === slot);
      if (re && le && store?.merge && re.value != null && le.value != null) win = store.merge(le, re);
      else if (!le || (re && (re.at || 0) > (le.at || 0))) win = re;
      else win = le;
      if (!le || !same(stripKey(win), stripKey(le))) {
        if (applyFileSlot(slot, rel, win, le, ctx)) applied += 1;
      }
      slots[slot] = { at: win.at || 0, value: win.value ?? null };
    }
    if (Object.keys(slots).length) files[rel] = slots;
  }

  // Project-wide.
  const project = {};
  for (const store of PROJECT_STORES) {
    if (store.bundle !== which) continue;
    const key = store.key(ctx);
    const le = store.read(ctx, key);
    const re = remote.project?.[store.slot];
    if (!le && !re) continue;
    let win;
    if (le && re && store.merge) win = store.merge(le, re);
    else if (!le || (re && (re.at || 0) > (le.at || 0))) win = re;
    else win = le;
    if (!le || !same(win, le)) {
      const next = store.write(ctx, key, win.value);
      if (readRaw(key) !== next) {
        writeRaw(key, next);
        if (store.clocked) touch(key, win.at);
        applied += 1;
      }
    }
    project[store.slot] = { at: win.at || 0, value: win.value };
  }

  return { bundle: { ...remote, version: 1, projectId: ctx.projectId, files, project }, applied };
}
const stripKey = (e) => (e ? { at: e.at || 0, value: e.value ?? null } : null);

// ── The data sync ───────────────────────────────────────────────────────────
// Run by lib/projectSync after the files are in step (`manifest` = the one it
// just wrote, `removedPaths` = the files it removed from the account).
export async function syncProjectData({ projectId, dir, manifest, removedPaths = [] }) {
  const userId = (await supabase.auth.getSession()).data.session?.user?.id || null;
  const { files, error: lErr } = await localFolderApi.listAll(dir);
  if (lErr) return { ok: false, error: String(lErr) };
  const ctx = makeContext({ projectId, userId, dir, files: files || [], manifest });
  const local = collectFileStores(ctx);
  const removedRels = new Set(removedPaths);
  const result = { ok: true, error: null, applied: 0, privateError: null };

  // Shared.
  const sharedPath = `${projectId}/${DATA_NAME}`;
  const { bundle: sharedRemote } = await downloadBundle(sharedPath);   // missing = first time
  const shared = mergeBundle({
    which: 'shared',
    remote: sharedRemote || emptyBundle(projectId),
    local: { files: local.shared },
    ctx,
    removedRels,
  });
  result.applied += shared.applied;
  const { error: sErr } = await uploadBundle(sharedPath, shared.bundle);
  if (sErr) { result.ok = false; result.error = sErr.message || String(sErr); }

  // Private — only with a signed-in user, and only where migration 036 lets it.
  if (userId) {
    const privPath = privateDataPath(userId, projectId);
    const { bundle: privRemote } = await downloadBundle(privPath);
    const priv = mergeBundle({
      which: 'private',
      remote: privRemote || emptyBundle(projectId),
      local: { files: local.private },
      ctx,
      removedRels,
    });
    result.applied += priv.applied;
    const { error: pErr } = await uploadBundle(privPath, priv.bundle);
    if (pErr) result.privateError = pErr.message || String(pErr);
  }
  return result;
}

// Switching sync off: both bundles go with the files.
export async function removeProjectData(projectId) {
  const userId = (await supabase.auth.getSession()).data.session?.user?.id || null;
  const paths = [`${projectId}/${DATA_NAME}`];
  const { error } = await bucket().remove(paths);
  if (userId) await bucket().remove([privateDataPath(userId, projectId)]);   // best effort
  return { error };
}
