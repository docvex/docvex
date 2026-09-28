// The renderer's side of the project index (src/projectIndex/README.md is the
// contract — read it first).
//
// What the app KNOWS about a file (AI readings, metadata, captions, OCR
// snippets, descriptions, waveforms…) used to sit in localStorage: synchronous,
// ~10 MB for every project together, oldest silently evicted, one machine only.
// It now lives in the main process's index and, portably, in `.docvex/` beside
// the documents. Main is asynchronous; the stores that read this knowledge are
// not (getAiFacet, loadMetadata, loadCaptions… are called in render). So this
// module keeps an IN-MEMORY COPY per file and per project, filled by
// hydration, and serves every read from it:
//
//   hydrateProject(projectId)  the whole project's knowledge + its settings, in
//                              one call — done when a project is selected.
//   hydratePath(path)          one file — what a Doc Viewer window awaits before
//                              its first read, and what a sync read of a file
//                              nobody hydrated yet starts in the background.
//
// Writes change the copy at once (the UI never waits on disk) and go to main in
// the background. Main's events keep every window's copy current:
// `knowledge:changed` re-reads that file, `settings:changed` that store, and
// `project:delta` marks the files whose contents moved as worth re-reading.
//
// THE TRANSITION: main's side may not be there (an older preload, a window
// opened before an update). Every read then answers `undefined` — "the index
// isn't answering" — and every store falls back to exactly what it did before,
// localStorage. Nothing here ever throws at a caller.
//
// MIGRATION: existing localStorage data is moved across once, per file on its
// first hydration and per project on `hydrateProject`. A key is only removed
// after main has confirmed the put, so a failed or absent main loses nothing.

// ── The catalogue ───────────────────────────────────────────────────────────
// Every kind of per-file knowledge, in one place. `local` kinds never leave
// this machine (main keeps them out of `.docvex/`, account sync leaves them
// out) — the face descriptions are biometric data.
export const KNOWLEDGE_KINDS = {
  text: { store: 'aiData' },          // a picture's text with positions (lib/textRegions)
  ocr: { store: 'aiData' },           // the paid Claude transcription (lib/identityExtract)
  identity: { store: 'aiData' },      // record details read out of the file
  understanding: { store: 'aiData' }, // what the Files scan understood (lib/dataCollections)
  faces: { store: 'aiData', local: true }, // face descriptors (lib/faceMatch)
  metadata: { store: 'metadataHistory' },
  captions: { store: 'captionsHistory' },
  extraction: { store: 'extractionHistory' }, // the Doc Viewer's OCR snippet list
  description: { store: 'aiFileIndex' },      // the one-line AI search description
  envelope: { store: 'audioEnvelopeCache' },  // the audio waveform, 8-bit base64 per sample rate
  theme: { store: 'docThemes' },              // a Word file's chosen document theme
};
export const isLocalKind = (kind) => !!KNOWLEDGE_KINDS[kind]?.local;

// Project-level stores kept in `.docvex/settings/<store>.json`.
export const SETTINGS_STORES = {
  scanTags: 'scan-tags',
  folderColors: 'folder-colors',
  web: 'web',
  fileGroups: 'collections',
};

// ── The bridge ──────────────────────────────────────────────────────────────
const bridge = () => (typeof window !== 'undefined' && window.electronAPI) || null;
const has = (name) => typeof bridge()?.[name] === 'function';
export const indexAvailable = () => has('knowledgeGet') && has('knowledgePut');
export const settingsAvailable = () => has('settingsGet') && has('settingsPut');
export const privateAvailable = () => has('privateGet') && has('privatePut');

// One call to main, never throwing: a missing handler (main not rebuilt yet —
// `stale_app`) or a failed call answers null.
async function call(name, payload) {
  if (!has(name)) return null;
  try {
    const res = await bridge()[name](payload);
    return res ?? null;
  } catch { return null; }
}

// Typed wrappers for every call in the contract.
export const ipc = {
  projectOpen: (args) => call('projectOpen', args),
  projectLocate: (projectId) => call('projectLocate', projectId),
  projectFiles: (args) => call('projectFiles', args),
  projectReconcile: (args) => call('projectReconcile', args),
  projectFileId: (args) => call('projectFileId', args),
  projectPathForId: (args) => call('projectPathForId', args),
  knowledgeGet: (args) => call('knowledgeGet', args),
  knowledgePut: (args) => call('knowledgePut', args),
  knowledgeClear: (args) => call('knowledgeClear', args),
  knowledgeList: (args) => call('knowledgeList', args),
  settingsGet: (args) => call('settingsGet', args),
  settingsPut: (args) => call('settingsPut', args),
  privateGet: (args) => call('privateGet', args),
  privatePut: (args) => call('privatePut', args),
  privateList: (args) => call('privateList', args),
};
const okOf = (res) => !!res && res.ok !== false && !res.error;

// ── Paths ───────────────────────────────────────────────────────────────────
// Windows paths reach us spelt several ways (\ or /, drive letter case, a
// trailing slash); one file must be one entry.
export const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export function isInsideDir(dir, path) {
  const d = normPath(dir);
  const p = normPath(path);
  return !!d && (p === d || p.startsWith(`${d}/`));
}
export function relInDir(dir, path) {
  if (!isInsideDir(dir, path)) return null;
  const root = String(dir).replace(/[\\/]+$/, '');
  return String(path).slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}
export function joinRel(dir, rel) {
  const root = String(dir || '').replace(/[\\/]+$/, '');
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root}${sep}${String(rel || '').split('/').join(sep)}`;
}

// ── State ───────────────────────────────────────────────────────────────────
// files:    norm path → { path, projectId, facets, ready, stale, loading, pending: { kind: n }, written: Set }
// projects: projectId → { dir, spellings: Set, ready, loading }
// settings: `${projectId}|${store}` → { value, ready, loading, pending }
const files = new Map();
const projects = new Map();
const settings = new Map();
const listeners = new Set();
const pathHydrators = new Set();

function entryFor(path, create = true) {
  const key = normPath(path);
  if (!key) return null;
  let e = files.get(key);
  if (!e && create) {
    e = { path: String(path), projectId: null, facets: {}, ready: false, stale: false, loading: null, pending: {}, written: new Set() };
    files.set(key, e);
  }
  return e || null;
}

function projectCovering(path) {
  for (const [id, p] of projects) if (p.dir && p.ready && isInsideDir(p.dir, path)) return { projectId: id, ...p };
  return null;
}

// Tell whoever listens. `ev` = { type: 'knowledge', path, kind } |
// { type: 'settings', projectId, store } | { type: 'project', projectId }.
function emit(ev) {
  for (const fn of [...listeners]) { try { fn(ev); } catch { /* one listener can't stop the rest */ } }
}
export function subscribeIndex(fn) {
  listeners.add(fn);
  ensureEvents();
  return () => listeners.delete(fn);
}

// Stores with data that is not per-file knowledge (the private conversations)
// register what hydrating a path means for them, so a Doc Viewer window that
// awaits `hydratePath` has everything it will read.
export function registerPathHydrator(fn) {
  pathHydrators.add(fn);
  return () => pathHydrators.delete(fn);
}

// ── Knowledge: reads ────────────────────────────────────────────────────────
// Every facet the index holds for `path`, or undefined when the index isn't
// answering for it yet (unavailable, or not hydrated — which starts hydration,
// and a `knowledge` event follows). Stale entries are served while they are
// re-read: a file whose contents may have moved keeps its old facets for the
// few milliseconds it takes, rather than blinking to "nothing known".
export function peekFacets(path) {
  if (!path || !indexAvailable()) return undefined;
  ensureEvents();
  const e = entryFor(path, false);
  const covered = projectCovering(path);
  if (e?.ready || (covered && !e)) {
    if (e?.stale) void hydratePath(path, { force: true });
    // Nothing listed for a file of a listed project: usually nothing is known,
    // but a file whose modified time moved (a sync client, an antivirus, a
    // copy) has its content hash forgotten until it is hashed again, and the
    // project's listing leaves it out — its readings are still there, filed
    // under that content. Asked once per session, in the background, so they
    // come back (the "extracted text keeps disappearing" bug).
    if (!e) probeUnlisted(path);
    return e?.facets || {};
  }
  if (covered && e) {
    // Created by a write before the project was listed — the listing has
    // already been applied to it if it had anything.
    return e.facets;
  }
  void hydratePath(path);
  // What this window itself wrote is known even before the read comes back.
  if (e && e.written.size) {
    const out = {};
    for (const k of e.written) if (e.facets[k]) out[k] = e.facets[k];
    return out;
  }
  return undefined;
}

// The background checks above: a few at a time, each path once per session.
const probed = new Set();
const probeQueue = [];
let probing = 0;
function probeUnlisted(path) {
  const key = normPath(path);
  if (!key || probed.has(key)) return;
  probed.add(key);
  probeQueue.push(path);
  pumpProbes();
}
function pumpProbes() {
  while (probing < 3 && probeQueue.length) {
    const path = probeQueue.shift();
    probing += 1;
    const e = entryFor(path);
    ipc.knowledgeGet({ path }).then((res) => {
      if (res && res.ok !== false && res.facets && Object.keys(res.facets).length) {
        applyFacets(e, res.facets);
        if (res.projectId) e.projectId = res.projectId;
        emit({ type: 'knowledge', path: e.path, kind: '*' });
      }
      e.ready = true;
    }).catch(() => {}).finally(() => { probing -= 1; pumpProbes(); });
  }
}

// One facet: the facet, null (the index knows the file and has none), or
// undefined (the index isn't answering — use the old store).
export function peekFacet(path, kind) {
  const facets = peekFacets(path);
  if (facets === undefined) return undefined;
  return facets[kind] || null;
}

// Every file this window knows something about: [{ path, projectId, facets }].
export function cachedEntries() {
  const out = [];
  for (const e of files.values()) if (Object.keys(e.facets).length) out.push({ path: e.path, projectId: e.projectId, facets: e.facets });
  return out;
}

// Main answers only for the file's CURRENT content; a stamp saved with a
// facet is compared by SIZE only — modified times differ between machines for
// the same bytes, sizes don't, and a changed size is certainly a changed file.
export function sameSize(saved, now) {
  if (!saved || !now) return true;
  if (saved.size != null && now.size != null && Number(saved.size) !== Number(now.size)) return false;
  return true;
}

// Merge a facet set read from main into an entry. A kind this window has a
// write in flight for keeps this window's value: the read may have been
// answered before the write landed.
export function applyFacets(e, facets) {
  const next = {};
  for (const [k, f] of Object.entries(facets || {})) if (f && f.data != null) next[k] = f;
  for (const k of Object.keys(e.pending)) {
    if (e.pending[k] > 0) {
      if (e.facets[k]) next[k] = e.facets[k];
      else delete next[k];
    }
  }
  e.facets = next;
}

// ── Knowledge: hydration ────────────────────────────────────────────────────
export function hydratePath(path, { force = false } = {}) {
  if (!path) return Promise.resolve();
  const hooks = [...pathHydrators].map((fn) => Promise.resolve().then(() => fn(path)).catch(() => {}));
  if (!indexAvailable()) return Promise.all(hooks).then(() => {});
  ensureEvents();
  const e = entryFor(path);
  if (e.loading) return Promise.all([e.loading, ...hooks]).then(() => {});
  if (e.ready && !e.stale && !force) return Promise.all(hooks).then(() => {});
  e.loading = (async () => {
    const res = await ipc.knowledgeGet({ path });
    if (res && res.ok !== false) {
      applyFacets(e, res.facets);
      if (res.projectId) e.projectId = res.projectId;
    }
    e.ready = true;
    e.stale = false;
    // Whatever localStorage still holds about this one file moves across now.
    const moved = await migrateLegacy({ onlyPath: path });
    if (moved) {
      const again = await ipc.knowledgeGet({ path });
      if (again && again.ok !== false) applyFacets(e, again.facets);
    }
  })().finally(() => {
    e.loading = null;
    emit({ type: 'knowledge', path: e.path, kind: '*' });
  });
  return Promise.all([e.loading, ...hooks]).then(() => {});
}

// Several files — before a sweep that reads each synchronously (metadata
// prefetch, AI indexing). Files already covered cost nothing.
export async function hydratePaths(paths, { concurrency = 6 } = {}) {
  if (!indexAvailable()) return;
  const todo = (paths || []).filter((p) => {
    if (!p) return false;
    const e = entryFor(p, false);
    if (e?.ready && !e.stale) return false;
    return !(projectCovering(p) && !e);
  });
  const queue = [...todo];
  const worker = async () => { while (queue.length) await hydratePath(queue.shift()); };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

// Record where a project lives without loading it (a caller that learnt the
// folder from projectOpen / the listing).
export function rememberProjectDir(projectId, dir) {
  if (!projectId || !dir) return;
  let p = projects.get(projectId);
  if (!p) { p = { dir, spellings: new Set(), ready: false, loading: null }; projects.set(projectId, p); }
  p.dir = p.dir || dir;
  p.spellings.add(String(dir));
}
export function projectDirOf(projectId) { return projects.get(projectId)?.dir || null; }
export function projectIdForDir(dir) {
  const d = normPath(dir);
  if (!d) return null;
  for (const [id, p] of projects) {
    if (normPath(p.dir) === d) return id;
    for (const s of p.spellings) if (normPath(s) === d) return id;
  }
  return null;
}
export function projectDirSpellings(projectId) {
  const p = projects.get(projectId);
  return p ? [...new Set([p.dir, ...p.spellings].filter(Boolean))] : [];
}
export const projectOfPath = (path) => {
  const p = projectCovering(path);
  if (p) return { projectId: p.projectId, dir: p.dir, rel: relInDir(p.dir, path) };
  for (const [id, q] of projects) if (q.dir && isInsideDir(q.dir, path)) return { projectId: id, dir: q.dir, rel: relInDir(q.dir, path) };
  return null;
};

// The whole project: its knowledge, its settings, and the one-time move of
// whatever localStorage holds for files inside its folder. Awaited when a
// project is selected; cheap to call again (`force` re-reads).
export function hydrateProject(projectId, { force = false, dir: knownDir = null } = {}) {
  if (!projectId) return Promise.resolve({ dir: null });
  if (knownDir) rememberProjectDir(projectId, knownDir);
  if (!indexAvailable() && !settingsAvailable()) return Promise.resolve({ dir: projectDirOf(projectId) });
  ensureEvents();
  let p = projects.get(projectId);
  if (!p) { p = { dir: null, spellings: new Set(), ready: false, loading: null }; projects.set(projectId, p); }
  if (p.loading) return p.loading;
  if (p.ready && !force) return Promise.resolve({ dir: p.dir });
  p.loading = (async () => {
    if (!p.dir) {
      const loc = await ipc.projectLocate(projectId);
      if (loc?.dir) p.dir = loc.dir;
    }
    if (p.dir) p.spellings.add(String(p.dir));
    await Promise.all(Object.values(SETTINGS_STORES).map((store) => loadSetting(projectId, store, { force })));
    if (p.dir) {
      await migrateLegacy({ dir: p.dir, projectId });
      await migrateLegacySettings(projectId, p.dir);
      await markMigrated(projectId, p.dir);
    }
    if (indexAvailable()) {
      const res = await ipc.knowledgeList({ projectId });
      if (res && Array.isArray(res.items)) {
        for (const item of res.items) {
          const path = item.path || (p.dir && item.rel ? joinRel(p.dir, item.rel) : null);
          if (!path) continue;
          const e = entryFor(path);
          e.projectId = projectId;
          applyFacets(e, item.facets);
          e.ready = true;
          e.stale = false;
        }
        // Only a listing that answered counts as covering the folder — else
        // every file would read as "known, nothing saved".
        p.ready = !!p.dir;
      }
    } else {
      p.ready = false;
    }
    for (const e of files.values()) {
      if (p.dir && isInsideDir(p.dir, e.path)) emit({ type: 'knowledge', path: e.path, kind: '*' });
    }
    emit({ type: 'project', projectId });
    return { dir: p.dir };
  })().finally(() => { p.loading = null; });
  return p.loading;
}

// ── Knowledge: writes ───────────────────────────────────────────────────────
// Store one facet. Returns false when the index isn't there (the caller keeps
// its old storage); otherwise true at once, the put running in the background.
// `onFail` runs if main refuses — the caller then keeps a copy the old way so
// the work is not lost (the next hydration migrates it).
export function putFacet(file, kind, facet, { onFail } = {}) {
  const path = file?.path;
  if (!path || !kind || !facet || !indexAvailable()) return false;
  ensureEvents();
  const e = entryFor(path);
  if (file.projectId) e.projectId = file.projectId;
  const full = { ...facet, kind, at: Number(facet.at) || Date.now() };
  e.facets = { ...e.facets, [kind]: full };
  e.written.add(kind);
  e.pending[kind] = (e.pending[kind] || 0) + 1;
  emit({ type: 'knowledge', path: e.path, kind });
  ipc.knowledgePut({ path, kind, facet: full }).then((res) => {
    e.pending[kind] -= 1;
    if (!okOf(res)) { try { onFail?.(res); } catch { /* the in-memory copy still serves */ } }
  });
  return true;
}

export function clearFacet(path, kind) {
  if (!path || !kind || !indexAvailable()) return false;
  const e = entryFor(path);
  const had = !!e.facets[kind];
  const next = { ...e.facets };
  delete next[kind];
  e.facets = next;
  e.written.delete(kind);
  e.pending[kind] = (e.pending[kind] || 0) + 1;
  emit({ type: 'knowledge', path: e.path, kind });
  ipc.knowledgeClear({ path, kind }).then(() => { e.pending[kind] -= 1; });
  return had;
}

// ── Settings ────────────────────────────────────────────────────────────────
const skey = (projectId, store) => `${projectId}|${store}`;

// The store's value, null (nothing saved), or undefined (not loaded — starts
// loading, a `settings` event follows).
export function peekSetting(projectId, store) {
  if (!projectId || !settingsAvailable()) return undefined;
  const s = settings.get(skey(projectId, store));
  if (s?.ready) return s.value;
  void loadSetting(projectId, store);
  return undefined;
}

export function loadSetting(projectId, store, { force = false } = {}) {
  if (!projectId || !settingsAvailable()) return Promise.resolve(undefined);
  ensureEvents();
  const k = skey(projectId, store);
  let s = settings.get(k);
  if (!s) { s = { value: null, ready: false, loading: null, pending: 0 }; settings.set(k, s); }
  if (s.loading) return s.loading;
  if (s.ready && !force) return Promise.resolve(s.value);
  s.loading = (async () => {
    const res = await ipc.settingsGet({ projectId, store });
    if (res && !res.error && s.pending === 0) s.value = res.value ?? null;
    if (res && !res.error) s.ready = true;
    return s.ready ? s.value : undefined;
  })().finally(() => {
    s.loading = null;
    emit({ type: 'settings', projectId, store });
  });
  return s.loading;
}

// Resolves with whether main took it. The copy changes at once either way.
export function putSetting(projectId, store, value) {
  if (!projectId || !settingsAvailable()) return Promise.resolve(false);
  ensureEvents();
  const k = skey(projectId, store);
  let s = settings.get(k);
  if (!s) { s = { value: null, ready: false, loading: null, pending: 0 }; settings.set(k, s); }
  s.value = value ?? null;
  s.ready = true;
  s.pending += 1;
  emit({ type: 'settings', projectId, store });
  return ipc.settingsPut({ projectId, store, value: value ?? null }).then((res) => {
    s.pending -= 1;
    return okOf(res);
  });
}

// ── Private (machine-local, per user) ───────────────────────────────────────
// Thin: the one store using it (lib/conversationHistory) keeps its own copy.
// privateList's answer is not pinned down by the contract — an array, or
// `{ items }` / `{ entries }` of `{ key, value }`, or a `{ key: value }` map.
export function normalizePrivateList(res) {
  if (!res) return [];
  const list = Array.isArray(res) ? res : (res.items || res.entries || null);
  if (Array.isArray(list)) return list.filter((x) => x && x.key).map((x) => ({ key: x.key, value: x.value, at: x.at || 0 }));
  const map = res.values || res.map || (typeof res === 'object' && !('ok' in res) ? res : null);
  if (map && typeof map === 'object') return Object.entries(map).map(([key, value]) => ({ key, value, at: 0 }));
  return [];
}
export async function privateList({ projectId = null, userId, prefix = '' }) {
  if (!userId || !has('privateList')) return null;
  const res = await ipc.privateList({ projectId, userId, prefix });
  if (!res || res.error || res.ok === false) return null;
  return normalizePrivateList(res).map((x) => ({ ...x, value: parseMaybe(x.value) }));
}
export async function privatePut({ projectId = null, userId, key, value }) {
  if (!userId || !key || !privateAvailable()) return false;
  return okOf(await ipc.privatePut({ projectId, userId, key, value }));
}
function parseMaybe(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// ── Events from main ────────────────────────────────────────────────────────
let eventsOn = false;
const refetchTimers = new Map();
function ensureEvents() {
  if (eventsOn || !bridge()) return;
  const b = bridge();
  const sub = (name, fn) => { if (typeof b[name] === 'function') { try { b[name](fn); } catch { /* not wired */ } } };
  if (!['onKnowledgeChanged', 'onSettingsChanged', 'onProjectDelta'].some((n) => typeof b[n] === 'function')) return;
  eventsOn = true;
  sub('onKnowledgeChanged', (ev) => {
    const path = ev?.path;
    if (!path) return;
    const e = entryFor(path, false);
    if (!e && !projectCovering(path)) return;    // nobody here has read it
    const key = normPath(path);
    clearTimeout(refetchTimers.get(key));
    refetchTimers.set(key, setTimeout(() => {
      refetchTimers.delete(key);
      void hydratePath(e?.path || path, { force: true });
    }, 60));
  });
  sub('onSettingsChanged', (ev) => {
    if (!ev?.projectId || !ev.store) return;
    if (!settings.has(skey(ev.projectId, ev.store))) return;
    void loadSetting(ev.projectId, ev.store, { force: true });
  });
  sub('onProjectDelta', (ev) => applyDelta(ev));
}

// A file whose contents moved has knowledge for its OLD content; marking it
// stale re-reads it on the next read. A removed file's entry goes. A large
// delta (a reconcile) re-lists the whole project instead, once.
const relistTimers = new Map();
export function applyDelta(ev) {
  const projectId = ev?.projectId;
  if (!projectId) return;
  const p = projects.get(projectId);
  const up = Array.isArray(ev.upserted) ? ev.upserted : [];
  const gone = Array.isArray(ev.removed) ? ev.removed : [];
  if (p?.ready && up.length > 40) {
    clearTimeout(relistTimers.get(projectId));
    relistTimers.set(projectId, setTimeout(() => { relistTimers.delete(projectId); void hydrateProject(projectId, { force: true }); }, 500));
    return;
  }
  for (const row of up) {
    const path = row?.path || (p?.dir && row?.rel ? joinRel(p.dir, row.rel) : null);
    const e = path && entryFor(path, false);
    if (!e) continue;
    e.stale = true;
    emit({ type: 'knowledge', path: e.path, kind: '*' });
  }
  if (p?.dir) {
    for (const rel of gone) {
      const key = normPath(joinRel(p.dir, rel));
      const e = files.get(key);
      if (!e) continue;
      files.delete(key);
      emit({ type: 'knowledge', path: e.path, kind: '*' });
    }
  }
}

// ── Migration from localStorage ─────────────────────────────────────────────
// The old per-file keys, and how each becomes a facet. A value that no longer
// describes the file (its stamp disagrees with the file's size / modified
// time now) is the same thing the old stores already refused to serve — it is
// dropped rather than attached to content it wasn't made from.
export const LEGACY = {
  aiData: 'docvex:ai-data:v1:',
  metadata: 'docvex:doc-viewer:metadata:',
  captions: 'docvex:doc-viewer:captions:',
  extraction: 'docvex:doc-viewer:ocr-history:',
  envelope: 'docvex:doc-viewer:envelope:',
  envelopeIndex: 'docvex:doc-viewer:envelope:index',
  theme: 'docvex:doc-viewer:doc-theme:',
  fileIndex: 'docvex:ai-file-index:v1',
};

// `localfile://local/<encoded path>` → the path, or null.
export function pathOfLocalUrl(url) {
  const m = /^localfile:\/\/local\/([^?#]+)/.exec(String(url || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}
// The envelope cache's id — `localfile://local/<encoded path>:<hz>`.
export function parseEnvelopeId(id) {
  const m = /^(localfile:\/\/local\/.+):(\d+)$/.exec(String(id || ''));
  if (!m) return null;
  const path = pathOfLocalUrl(m[1]);
  return path ? { path, hz: Number(m[2]) } : null;
}

// Parse every legacy key into the facets it becomes. Pure — `read(key)` and
// `keys` stand in for localStorage, so the tests can drive it.
//   → [{ path, kind, facet, stamp, key, drop?: fn }]
export function collectLegacy(keys, read, { inside = null, onlyPath = null } = {}) {
  const want = (path) => {
    if (!path) return false;
    if (onlyPath) return normPath(path) === normPath(onlyPath);
    if (inside) return isInsideDir(inside, path);
    return true;
  };
  const json = (k) => { try { return JSON.parse(read(k) || 'null'); } catch { return null; } };
  const out = [];
  for (const key of keys) {
    if (key.startsWith(LEGACY.aiData)) {
      const path = key.slice(LEGACY.aiData.length);
      const rec = want(path) && json(key);
      if (!rec?.facets) continue;
      for (const [kind, f] of Object.entries(rec.facets)) {
        if (f && f.data != null) out.push({ path, kind, key, stamp: f.stamp || null, facet: { ...f, kind } });
      }
      if (!Object.keys(rec.facets).length) out.push({ path, kind: null, key });
    } else if (key.startsWith(LEGACY.metadata)) {
      const path = key.slice(LEGACY.metadata.length);
      const v = want(path) && json(key);
      if (!v || !Array.isArray(v.groups)) continue;
      const stamp = { size: v.size ?? null, mtime: v.mtime ?? null };
      out.push({ path, kind: 'metadata', key, stamp, facet: { kind: 'metadata', at: Number(v.extractedAt) || Date.now(), engine: 'local', paid: false, stamp, data: { groups: v.groups, warnings: v.warnings || [], extractedAt: v.extractedAt || 0 } } });
    } else if (key.startsWith(LEGACY.captions)) {
      const path = key.slice(LEGACY.captions.length);
      const v = want(path) && json(key);
      if (!v || typeof v.text !== 'string') continue;
      out.push({ path, kind: 'captions', key, stamp: null, facet: { kind: 'captions', at: Number(v.updatedAt || v.createdAt) || Date.now(), engine: 'whisper', paid: true, data: v } });
    } else if (key.startsWith(LEGACY.extraction)) {
      const path = key.slice(LEGACY.extraction.length);
      const v = want(path) && json(key);
      if (!Array.isArray(v) || !v.length) continue;
      out.push({ path, kind: 'extraction', key, stamp: null, facet: { kind: 'extraction', at: Math.max(0, ...v.map((x) => Number(x?.createdAt) || 0)) || Date.now(), engine: 'claude', paid: true, data: v } });
    } else if (key.startsWith(LEGACY.theme)) {
      const path = pathOfLocalUrl(key.slice(LEGACY.theme.length));
      const id = want(path) && read(key);
      if (!id) continue;
      out.push({ path, kind: 'theme', key, stamp: null, facet: { kind: 'theme', at: Date.now(), engine: 'user', paid: false, data: { id } } });
    } else if (key.startsWith(LEGACY.envelope) && key !== LEGACY.envelopeIndex) {
      let id = '';
      try { id = decodeURIComponent(key.slice(LEGACY.envelope.length)); } catch { continue; }
      const parsed = parseEnvelopeId(id);
      if (!parsed || !want(parsed.path)) continue;
      const b64 = read(key);
      if (!b64) continue;
      out.push({ path: parsed.path, kind: 'envelope', key, stamp: null, hz: parsed.hz, facet: { kind: 'envelope', at: Date.now(), engine: 'local', paid: false, data: { [parsed.hz]: b64 } } });
    } else if (key === LEGACY.fileIndex) {
      const map = json(key) || {};
      for (const [path, hit] of Object.entries(map)) {
        if (!want(path) || !hit?.desc) continue;
        // `size:mtime:cap` — the modified time is ISO and has colons of its
        // own, so size is up to the first colon and cap after the last.
        const vk = String(hit.key || '');
        const size = vk.slice(0, vk.indexOf(':'));
        const cap = vk.slice(vk.lastIndexOf(':') + 1);
        const mtime = vk.slice(vk.indexOf(':') + 1, vk.lastIndexOf(':'));
        const stamp = { size: size && size !== '?' ? Number(size) : null, mtime: mtime && mtime !== '?' ? mtime : null };
        out.push({ path, kind: 'description', key, stamp, mapKey: path, facet: { kind: 'description', at: Number(hit.at) || Date.now(), engine: 'claude-haiku', paid: true, data: { desc: hit.desc, size: stamp.size, cap: cap || '' } } });
      }
    }
  }
  // Several sample rates of one waveform are one facet.
  const merged = [];
  const envByPath = new Map();
  for (const item of out) {
    if (item.kind !== 'envelope') { merged.push(item); continue; }
    const k = normPath(item.path);
    const cur = envByPath.get(k);
    if (cur) { Object.assign(cur.facet.data, item.facet.data); cur.keys.push(item.key); continue; }
    const first = { ...item, keys: [item.key] };
    envByPath.set(k, first);
    merged.push(first);
  }
  return merged;
}

// Has the old stamp gone stale against the file as it is now?
// By SIZE only: a modified time that moved is not new content (see aiData's
// stampMatches) — comparing it made the migration throw good readings away.
export function legacyStampStale(stamp, now) {
  if (!stamp || !now) return false;
  if (stamp.size != null && now.size != null && Number(stamp.size) !== Number(now.size)) return true;
  return false;
}

function lsKeys() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); if (k) out.push(k); } } catch { /* none */ }
  return out;
}
const lsRead = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsRemove = (k) => { try { localStorage.removeItem(k); } catch { /* keep going */ } };

async function statOf(path) {
  if (!has('stat')) return undefined;
  try {
    const st = await bridge().stat(path);
    if (!st || st.error) return null;          // gone
    return { size: st.sizeBytes ?? null, mtime: st.mtimeIso ?? null };
  } catch { return undefined; }
}

// Move what localStorage holds for files inside `dir` (or just `onlyPath`)
// into the index. Returns how many facets went across. Idempotent: a key goes
// only once every facet from it has been accepted, so running it again picks
// up exactly what failed before.
let migrating = Promise.resolve();
export function migrateLegacy({ dir = null, onlyPath = null, projectId = null } = {}) {
  if (!indexAvailable() || typeof localStorage === 'undefined') return Promise.resolve(0);
  const run = migrating.then(() => migrateNow({ dir, onlyPath, projectId })).catch(() => 0);
  migrating = run;
  return run;
}
// Which files localStorage still holds anything for — so hydrating one file
// (which happens per file, often hundreds at a time) doesn't parse every key.
// Re-read at most every few seconds: the stores add keys only when a put fails.
// Kept for as long as the SET OF KEYS is unchanged (it was rebuilt every 5s,
// parsing every legacy blob each time while files hydrated); a minute at most,
// in case a key's content changed under the same name.
let legacyPaths = null;
let legacyAt = 0;
let legacySig = '';
function legacyPathSet(keys) {
  const sig = keys.join('\n');
  if (legacyPaths && sig === legacySig && Date.now() - legacyAt < 60_000) return legacyPaths;
  const set = new Set();
  for (const item of collectLegacy(keys, lsRead)) set.add(normPath(item.path));
  legacyPaths = set;
  legacyAt = Date.now();
  legacySig = sig;
  return set;
}
async function migrateNow({ dir, onlyPath }) {
  const keys = lsKeys().filter((k) => Object.values(LEGACY).some((p) => k.startsWith(p)));
  if (!keys.length) return 0;
  if (onlyPath && !legacyPathSet(keys).has(normPath(onlyPath))) return 0;
  legacyAt = 0;
  const items = collectLegacy(keys, lsRead, { inside: dir, onlyPath });
  if (!items.length) return 0;
  const stats = new Map();
  const keyOk = new Map();            // key → still all fine
  const mapDone = [];                 // ai-file-index entries that went across
  let moved = 0;
  for (const item of items) {
    const keysOf = item.keys || [item.key];
    if (!item.kind) { for (const k of keysOf) if (!keyOk.has(k)) keyOk.set(k, true); continue; }
    const pk = normPath(item.path);
    if (!stats.has(pk)) stats.set(pk, await statOf(item.path));
    const now = stats.get(pk);
    // The file isn't there (moved, deleted, another drive not plugged in) —
    // leave the key; a later hydration of wherever it is now may still want it.
    if (now === null || now === undefined) { for (const k of keysOf) keyOk.set(k, false); continue; }
    let ok = true;
    // A reading for content the file no longer has is NOT moved — and not
    // deleted either: it stays where it is (it used to be removed here with
    // the rest of its key, which is how old readings were lost for good).
    if (legacyStampStale(item.stamp, now)) ok = false;
    else {
      const existing = entryFor(item.path, false)?.facets?.[item.kind];
      // Never overwrite something the index already has that is newer.
      if (!existing || (Number(existing.at) || 0) < (Number(item.facet.at) || 0)) {
        const res = await ipc.knowledgePut({ path: item.path, kind: item.kind, facet: { ...item.facet, stamp: item.stamp || item.facet.stamp || now } });
        ok = okOf(res);
        if (ok) moved += 1;
      }
    }
    for (const k of keysOf) keyOk.set(k, (keyOk.get(k) ?? true) && ok);
    if (item.mapKey && ok) mapDone.push(item.mapKey);
  }
  for (const [k, ok] of keyOk) {
    if (!ok) continue;
    if (k === LEGACY.fileIndex) continue;     // one key holding every file — trimmed below
    lsRemove(k);
  }
  if (mapDone.length) {
    try {
      const map = JSON.parse(lsRead(LEGACY.fileIndex) || '{}') || {};
      for (const p of mapDone) delete map[p];
      if (Object.keys(map).length) localStorage.setItem(LEGACY.fileIndex, JSON.stringify(map));
      else lsRemove(LEGACY.fileIndex);
    } catch { /* stays; it is only read as a fallback */ }
  }
  // The waveform cache's LRU index may now list ids that are gone — trim it.
  try {
    const idx = JSON.parse(lsRead(LEGACY.envelopeIndex) || '[]');
    if (Array.isArray(idx)) {
      const left = idx.filter((id) => lsRead(LEGACY.envelope + encodeURIComponent(id)) != null);
      if (left.length !== idx.length) localStorage.setItem(LEGACY.envelopeIndex, JSON.stringify(left));
    }
  } catch { /* the cache rebuilds its index as it goes */ }
  return moved;
}

// Once nothing in localStorage belongs to a file in the project any more, the
// move is recorded in the project's machine-local private store (under the
// device, not a user: localStorage is per machine). It is a record, not a
// gate — the scan runs on every hydration because it is cheap and idempotent,
// and a put main refused leaves a key behind on purpose for the next run.
const MIGRATION_MARK = 'migration:localStorage:v1';
async function markMigrated(projectId, dir) {
  if (!has('privatePut') || typeof localStorage === 'undefined') return;
  const keys = lsKeys().filter((k) => Object.values(LEGACY).some((pfx) => k.startsWith(pfx)));
  if (collectLegacy(keys, lsRead, { inside: dir }).length) return;
  const seen = await ipc.privateGet({ projectId, userId: '_device', key: MIGRATION_MARK });
  if (seen?.value) return;
  await ipc.privatePut({ projectId, userId: '_device', key: MIGRATION_MARK, value: { at: Date.now(), dir } });
}

// The project-level stores: scan tags (keyed by the folder), folder colours
// (keyed by the project, `dir:<abs>` ids → paths inside the project) and the
// Data collections' web (which lib/dataCollections moves itself, from its
// file). Only a store the index has NOTHING for takes the local copy — a value
// that arrived with the folder from a colleague wins. The small local copies
// stay as this machine's mirror (lib/scanTags, lib/folderColors).
async function migrateLegacySettings(projectId, dir) {
  if (!settingsAvailable()) return;
  const tagsNow = settings.get(skey(projectId, SETTINGS_STORES.scanTags));
  if (tagsNow?.ready && tagsNow.value == null) {
    let list = null;
    for (const spelling of projectDirSpellings(projectId)) {
      try { list = JSON.parse(lsRead(`docvex:scan-tags:v1:${spelling}`) || 'null'); } catch { list = null; }
      if (Array.isArray(list) && list.length) break;
    }
    if (Array.isArray(list) && list.length) await putSetting(projectId, SETTINGS_STORES.scanTags, list.map(String));
  }
  const colNow = settings.get(skey(projectId, SETTINGS_STORES.folderColors));
  if (colNow?.ready && colNow.value == null) {
    let map = null;
    try { map = JSON.parse(lsRead(`docvex.folderColors.${projectId}`) || 'null'); } catch { map = null; }
    const value = folderColorsToRel(map, dir);
    if (value && (Object.keys(value.dirs).length || Object.keys(value.other).length)) {
      await putSetting(projectId, SETTINGS_STORES.folderColors, value);
    }
  }
}

// Folder colours travel keyed by the folder's path inside the project; this
// machine keys them by the folder's absolute path (`dir:<abs>`).
export function folderColorsToRel(map, dir) {
  if (!map || typeof map !== 'object') return null;
  const out = { dirs: {}, other: {} };
  for (const [id, color] of Object.entries(map)) {
    const rel = id.startsWith('dir:') && dir ? relInDir(dir, id.slice(4)) : null;
    if (rel) out.dirs[rel] = color;
    else out.other[id] = color;
  }
  return out;
}
export function folderColorsFromRel(value, dir, mirror = {}) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  // Keep this machine's exact id spelling where it has one for the folder.
  const mirrorByRel = new Map();
  for (const id of Object.keys(mirror || {})) {
    const rel = id.startsWith('dir:') && dir ? relInDir(dir, id.slice(4)) : null;
    if (rel) mirrorByRel.set(rel.toLowerCase(), id);
  }
  for (const [rel, color] of Object.entries(value.dirs || {})) {
    if (!dir) continue;
    out[mirrorByRel.get(rel.toLowerCase()) || `dir:${joinRel(dir, rel)}`] = color;
  }
  for (const [id, color] of Object.entries(value.other || {})) out[id] = color;
  return out;
}

// For tests: forget every cached thing.
export function _resetForTests() {
  files.clear(); projects.clear(); settings.clear(); listeners.clear(); pathHydrators.clear();
  eventsOn = false;
}
