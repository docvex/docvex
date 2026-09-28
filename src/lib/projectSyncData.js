// ── Sync a project's DATA with the account ───────────────────────────────────
// lib/projectSync carries a synced project's FILES — and with them the
// project's `.docvex/` folder (src/projectIndex/README.md): the project file,
// `ids.json`, every `knowledge/**` shard and every `settings/**` store. That is
// where everything DocVex WORKS OUT about the files now lives (AI data,
// metadata, captions, OCR snippets, AI file descriptions, waveforms, document
// themes) and the project-level stores (scan tags, folder colours, the Data
// collections' web). So none of that travels here any more.
//
// What is left is what the project index does not hold, as TWO JSON bundles
// beside the files, written after every sync:
//
//   project-sync/<project id>/.docvex-data.json     SHARED — the timeline scan's
//       readings and the case timeline. Any project member can read it,
//       exactly like the files it describes.
//   project-sync/user-<user id>/<project id>.json   PRIVATE — the user's own
//       conversations (Doc Viewer advisor threads, from the index's private
//       store via lib/conversationHistory; Advisor chats). Migration 036 limits
//       that folder to its owner; before it is applied every policy on the
//       bucket refuses the path, so the private bundle fails CLOSED (it is
//       reported, never written somewhere teammates could read it).
//
// Inside a bundle a file is named by its path INSIDE THE PROJECT, never by this
// machine's absolute path.
//
// A bundle written by an older version still carries the slots that moved to
// `.docvex/` (aiData, metadata, captions, ocr, index, folderColors). Whatever
// this device has nothing for is ADOPTED into the new stores — only when it was
// made from the version of the file this device holds — and the next upload
// leaves those slots out.
//
// WHICH COPY WINS: per entry, the newer — each store says what "when" means
// (a thread's `updatedAt`, the sync clock for stores with no timestamp of their
// own, see lib/syncClock). The Advisor's chats merge per chat.
import { supabase } from './supabaseClient';
import { localFolderApi } from './localFolder';
import { AI_FACETS, getAiFacet, saveAiFacet } from './aiData';
import { loadMetadata, saveMetadata } from './metadataHistory';
import { loadCaptions, saveCaptions } from './captionsHistory';
import { loadOcrHistory, saveOcrHistory } from './extractionHistory';
import { listConversations, putConversationRecord } from './conversationHistory';
import { loadFolderColors, persistFolderColors } from './folderColors';
import { timelineKeyFor } from './caseTimeline';
import { adoptFileIndexRecord } from './aiFileIndex';
import { loadExtract, saveExtract } from './scanExtractCache';
import { touch, touchedAt, goneFor, setGone } from './syncClock';
import { hydratePaths } from './projectIndexClient';
import { isSealedBundle, openBundle, projectFolderKey, sealBundle } from './projectFolderKey';

export const DATA_NAME = '.docvex-data.json';
export const privateDataPath = (userId, projectId) => `user-${userId}/${projectId}.json`;
// ProjectAI.jsx's STORAGE_PREFIX — keep the two in step.
const AI_CHAT_PREFIX = 'docvex.aichat.v3.';
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
    dirOfRel: (rel) => (root ? `${String(dir).replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}` : null),
    // Is the file here the version the account's manifest describes?
    isManifestVersion(rel) {
      const f = byRel.get(rel);
      const m = manifestByRel.get(rel);
      return !!(f && m && sameVersion({ size: m.size, mtime: m.mtime }, { size: f.sizeBytes, mtime: f.mtimeIso }));
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const maxAt = (xs) => Math.max(0, ...xs.map((x) => Number(x) || 0));

// ── Per-file entries on this device ─────────────────────────────────────────
// { [bundle]: { [rel]: { [slot]: { at, value } } } } — the Doc Viewer advisor
// threads (private) and the timeline scan's readings (shared).
const FILE_SLOTS = ['conversation', 'scan'];

async function collectFileStores(ctx) {
  const out = { shared: {}, private: {} };
  for (const { path, record } of await listConversations()) {
    const rel = ctx.relOfFile(path);
    if (!rel || !record || typeof record !== 'object') continue;
    const at = Number(record.updatedAt) || 0;
    const cur = out.private[rel]?.conversation;
    // The same file under two spellings of its path: the newer one speaks for it.
    if (cur && cur.at >= at) continue;
    (out.private[rel] ||= {}).conversation = { at, value: record };
  }
  for (const [rel, f] of ctx.byRel) {
    const scan = loadExtract(scanFileOf(f));
    if (scan) (out.shared[rel] ||= {}).scan = { at: Number(scan.at) || 0, value: scan };
  }
  return out;
}

// lib/scanExtractCache keys a reading by name | size | lastModified.
const scanFileOf = (f) => ({ name: f.name, size: f.sizeBytes, lastModified: f.mtimeIso ? new Date(f.mtimeIso).getTime() : 0 });

// Store `entry` for `rel` on this device. Returns whether anything changed.
async function applyFileSlot(slot, rel, entry, ctx) {
  const f = ctx.byRel.get(rel);
  if (!f || entry?.value == null) return false;   // not on this device: nothing to attach it to
  if (slot === 'scan') {
    if (loadExtract(scanFileOf(f))) return false;
    saveExtract(scanFileOf(f), entry.value);
    return true;
  }
  if (slot === 'conversation') return putConversationRecord(f.path, entry.value);
  return false;
}

// ── Slots an older bundle still carries ────────────────────────────────────
// Adopted into the stores that replaced them — only for a file whose version
// here is the one the data was made from (the manifest's), and only where this
// device has nothing of that kind. Returns how many were adopted.
async function adoptLegacySlots(remote, ctx) {
  const LEGACY = ['aiData', 'metadata', 'captions', 'ocr', 'index'];
  const rels = Object.keys(remote?.files || {})
    .filter((rel) => ctx.byRel.has(rel) && LEGACY.some((s) => remote.files[rel]?.[s]?.value != null));
  let adopted = 0;
  if (rels.length) {
    await hydratePaths(rels.map((rel) => ctx.byRel.get(rel).path));
    for (const rel of rels) {
      if (!ctx.isManifestVersion(rel)) continue;
      const f = ctx.byRel.get(rel);
      const slots = remote.files[rel];
      const stamp = { size: f.sizeBytes ?? null, mtime: f.mtimeIso ?? null };
      for (const [kind, facet] of Object.entries(slots.aiData?.value?.facets || {})) {
        if (!AI_FACETS[kind] || AI_FACETS[kind].local || facet?.data == null) continue;
        if (getAiFacet(f.path, kind)) continue;
        if (saveAiFacet({ path: f.path, name: f.name, projectId: ctx.projectId }, kind, { data: facet.data, engine: facet.engine || '', stamp })) adopted += 1;
      }
      const meta = slots.metadata?.value;
      if (Array.isArray(meta?.groups) && !loadMetadata(f.path) && saveMetadata(f.path, meta, stamp)) adopted += 1;
      const cap = slots.captions?.value;
      if (typeof cap?.text === 'string' && !loadCaptions(f.path) && saveCaptions(f.path, cap)) adopted += 1;
      const ocr = slots.ocr?.value;
      if (Array.isArray(ocr) && ocr.length && !loadOcrHistory(f.path).length && saveOcrHistory(f.path, ocr)) adopted += 1;
      const idx = slots.index;
      if (idx?.value?.desc && adoptFileIndexRecord(f, { desc: idx.value.desc, at: idx.at })) adopted += 1;
    }
  }
  // Folder colours: taken only when this project has none at all here.
  const colours = remote?.project?.folderColors?.value;
  if (colours && typeof colours === 'object' && !Object.keys(loadFolderColors(ctx.projectId)).length) {
    const map = {};
    for (const [rel, color] of Object.entries(colours)) {
      const abs = ctx.dirOfRel(rel);
      if (abs && color) map[`dir:${abs}`] = color;
    }
    if (Object.keys(map).length) { persistFolderColors(ctx.projectId, map); adopted += 1; }
  }
  return adopted;
}

// ── Project-wide stores ─────────────────────────────────────────────────────
const PROJECT_STORES = [
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

// Both bundles are sealed with the project's folder key (lib/projectFolderKey)
// — the copy in the account holds no readable text. A bundle an older build
// uploaded in clear is still read, and goes back sealed. A sealed bundle that
// can't be opened is an ERROR, never "nothing there": merging against an
// empty remote would upload over it and lose the other devices' entries.
async function downloadBundle(path, key) {
  const { data, error } = await bucket().download(path);
  if (error) return { bundle: null, error: null, missing: true };
  try {
    let parsed = JSON.parse(await data.text());
    if (isSealedBundle(parsed)) {
      if (!key) return { bundle: null, error: new Error('The project key is not available — try again when online.') };
      parsed = await openBundle(key, parsed);
    }
    return { bundle: parsed && typeof parsed === 'object' ? parsed : null, error: null };
  } catch (err) {
    return { bundle: null, error: err };
  }
}

async function uploadBundle(path, bundle, key) {
  if (!key) return { error: new Error('The project key is not available — nothing was uploaded.') };
  const sealed = await sealBundle(key, { ...bundle, at: new Date().toISOString() });
  const body = new Blob([JSON.stringify(sealed)], { type: 'application/json' });
  const { error } = await bucket().upload(path, body, { upsert: true, contentType: 'application/json' });
  return { error };
}

// Merge one bundle (the account's) with this device's entries. Writes what is
// newer in the account onto this device and returns the bundle to upload.
async function mergeBundle({ which, remote, local, ctx, removedRels }) {
  let applied = 0;
  const files = {};

  // Files: every rel either side knows, minus the ones this sync deleted.
  const rels = new Set([...Object.keys(remote.files || {}), ...Object.keys(local.files || {})]);
  // Only the slots this bundle still carries — anything else an older bundle
  // holds has been adopted (adoptLegacySlots) and is left out of the upload.
  const order = FILE_SLOTS;
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
      if (!le || (re && (re.at || 0) > (le.at || 0))) win = re;
      else win = le;
      if (!le || !same(stripKey(win), stripKey(le))) {
        if (await applyFileSlot(slot, rel, win, ctx)) applied += 1;
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
  const local = await collectFileStores(ctx);
  const removedRels = new Set(removedPaths);
  const result = { ok: true, error: null, applied: 0, privateError: null };

  const key = await projectFolderKey(projectId);
  if (!key) return { ok: false, error: 'The project key could not be fetched — sign in and try again.' };

  // Shared.
  const sharedPath = `${projectId}/${DATA_NAME}`;
  const { bundle: sharedRemote, error: sdErr } = await downloadBundle(sharedPath, key);   // missing = first time
  if (sdErr) return { ok: false, error: sdErr.message || String(sdErr) };
  try { result.applied += await adoptLegacySlots(sharedRemote, ctx); } catch { /* the rest still syncs */ }
  const shared = await mergeBundle({
    which: 'shared',
    remote: sharedRemote || emptyBundle(projectId),
    local: { files: local.shared },
    ctx,
    removedRels,
  });
  result.applied += shared.applied;
  const { error: sErr } = await uploadBundle(sharedPath, shared.bundle, key);
  if (sErr) { result.ok = false; result.error = sErr.message || String(sErr); }

  // Private — only with a signed-in user, and only where migration 036 lets it.
  if (userId) {
    const privPath = privateDataPath(userId, projectId);
    const { bundle: privRemote, error: pdErr } = await downloadBundle(privPath, key);
    if (pdErr) { result.privateError = pdErr.message || String(pdErr); return result; }
    const priv = await mergeBundle({
      which: 'private',
      remote: privRemote || emptyBundle(projectId),
      local: { files: local.private },
      ctx,
      removedRels,
    });
    result.applied += priv.applied;
    const { error: pErr } = await uploadBundle(privPath, priv.bundle, key);
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
