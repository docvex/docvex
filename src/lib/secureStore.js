// The ENCRYPTED key-value store for everything DocVex keeps on this computer
// that is CONTENT or PERSONAL DATA (V5).
//
// Why: Chromium's localStorage is an unencrypted LevelDB under userData. Any
// process running as the user (or anyone holding a copy of the profile) reads
// it in the clear. The app used to keep the text read off ID cards, advisor
// conversations, captions, the party names and CUIs typed into the Legislation
// tab, cached ANAF / court answers… there. None of that may be in localStorage
// any more: it lives here.
//
// SHAPE: the same synchronous get / set / remove the stores were written
// against (`secureStorage` is a drop-in for `localStorage` — getItem, setItem,
// removeItem, key(i), length), answered from an IN-MEMORY cache that is
// HYDRATED once the user is known (`hydrateSecureStore(userId)`, called by
// AuthContext in every window) and persisted in the background — debounced,
// serialised, never on the caller's time.
//
// BACKENDS, first that works:
//   1. the machine index's per-user PRIVATE table (lib/projectIndexClient's
//      privateGet / privatePut / privateList with no project — `_loose.db`,
//      namespace `_secure`), sealed with AES-256-GCM under the index key that
//      safeStorage protects;
//   2. the pseudonymisation vault's file store (`vaultGet` / `vaultPut`:
//      <userData>/vault/<id>.bin, safeStorage-encrypted), one file per user;
//   3. MEMORY ONLY. Never localStorage. Used when there is no encrypted
//      backend (safeStorage unavailable — a Linux box without a keyring — or an
//      old preload): the data lasts until the window closes, and a warning is
//      logged once.
// Whether encryption is really there is ASKED (a `vaultGet` probe answers
// `no_encryption` when safeStorage is unavailable) — the index writes rows in
// the clear when it has no key, so "the index answers" alone proves nothing.
//
// CROSS-WINDOW: each window keeps its own cache. A persisted change is
// announced on the BroadcastChannel 'docvex-secure-store' carrying the KEYS
// only (never a value); the other windows re-read those keys from their
// backend. Stores that used the `storage` event subscribe here instead
// (`subscribeSecureStore`) — or listen for the window event
// 'docvex:secure-store' (`detail: { key, source }`, key null = everything).
//
// MIGRATION: on hydrate, every class-(b) key still in localStorage is moved
// into the store and — once the backend has it — deleted from localStorage.
//
// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY of the keys DocVex keeps in localStorage / sessionStorage
// (2026-09-29, `grep -rn "localStorage\|sessionStorage" src`).
//
// (b) CONTENT / PERSONAL DATA → this store (SECURE_PREFIXES)
// | key / prefix                                   | module                     | holds
// |------------------------------------------------|----------------------------|-------------------------------------------
// | docvex:ai-data:v1:<path>                        | lib/aiData                 | OCR / extracted text, identity readings
// | docvex:doc-viewer:conversation:<path>           | lib/conversationHistory    | Doc Viewer advisor threads (fallback)
// | docvex:doc-viewer:captions:<path>               | lib/captionsHistory        | transcripts
// | docvex:doc-viewer:ocr-history:<path>            | lib/extractionHistory      | OCR snippets
// | docvex:doc-viewer:metadata:<path>               | lib/metadataHistory        | file metadata (authors, GPS…)
// | docvex:doc-viewer:envelope:(index|<id>)         | lib/audioEnvelopeCache     | waveforms, ids built from paths
// | docvex:doc-viewer:doc-theme:<path>              | lib/docThemes              | theme by file path
// | docvex:ai-file-index:v1                         | lib/aiFileIndex            | AI descriptions of every file
// | docvex:ai-search-answers:v1                     | lib/aiSearchCache          | AI search queries + hits
// | docvex:insights:signatures:v1:<dir>             | lib/caseInsights           | signature comparison report
// | docvex:insight-resolutions:v1:<dir>             | lib/caseInsights           | contradiction decisions (CNPs…)
// | docvex:insights:case:v1:<dir>                   | components/CaseInsights    | kind of case, keyed by folder path
// | docvex:history:<tab>:v1, docvex:legislation:history:v1 | lib/tabHistory     | searched party names, CUIs, files opened
// | docvex:source-cache:<tab>:v1                    | lib/sourceCache            | cached ANAF / court answers
// | docvex.aichat.v3.*, docvex.aichat.active.v1.*   | lib/advisorChats           | Advisor chats
// | docvex.research.v1.*, docvex.research.active.v1.* | lib/researchChats        | Research chats
// | docvex:files:opened:v1                          | lib/recentFiles            | paths of files opened
// | docvex:scan-tags:v1:<dir>                       | lib/scanTags               | paths tagged for the AI scan
// | docvex:case-timeline:v1:<project>               | lib/caseTimeline           | the case timeline
// | docvex:timeline:extract:(v1:|index:v1)          | lib/scanExtractCache       | extracted text / transcripts
// | docvex:collections:v1:<dir>                     | lib/fileGroups             | file collections (paths)
// | docvex.folderColors.<project>                   | lib/folderColors           | folder ids / paths
// | docvex:live-network:(v1|pending:v1|asked:v1):<dir> | lib/liveNetwork         | pending file paths, keyed by folder
// | docvex:brief-network:(suggest|prefill):v1:      | lib/briefFromNetwork       | AI read of the case (parties, facts)
// | docvex.chat.cache.*                             | lib/chatCache              | team chat messages
// | docvex:legal-browser:v1                         | lib/legalBrowser           | Legislation tabs: queries, companies, CUIs
// | docvex.projects.cache.<user>                    | lib/projectListCache       | project names (client names)
// | docvex.notifications.v1.<user>                  | context/NotificationsContext | notification history (file names)
// | docvex.activityLog.v1.<user>                    | lib/activityLog            | file actions, file names / paths
// | docvex:sync:clock:v1, docvex:sync:gone:v1:*     | lib/syncClock              | keyed by the above keys (paths)
// | docvex:sync:ledger:<project>                    | lib/projectSync (NOT MOVED — other owner) | synced paths
// | docvex:data-web:v1:<dir>                        | lib/dataCollections (NOT MOVED — other owner) | scan understanding of every file
// | docvex:phone-upload:(local:v2|cloud:v1):*       | lib/phoneUpload* (NOT MOVED — other owner) | upload tokens
// | docvex:pseudonymize:(v1|guess:v1):<project>     | lib/pseudonymizeSetting (NOT MOVED — other owner) | per-project setting
//
// (a) UI PREFERENCES / DEVICE STATE, no personal data → may stay in localStorage
//     (ALLOWED_LOCALSTORAGE_PREFIXES): theme, app prefs, sidebar / rail / drawer
//     widths and folds, view modes (Files view, CAEN view / rev, graph lens,
//     collection view, insights section, legal view mode, Research rail),
//     Doc Viewer layout / page rail / law refs / caption position / caption
//     settings / reading mode / doc engine, design-system overrides, perf
//     preset + detection, AI model / style / project-files switch / server
//     features / jurisdiction, scan features, cloud-media switch (project id →
//     bool), maps + AI-search consent, Playbook rules / presets / word-doc
//     cache / drawer width, constructor language, selected project id, recent
//     project ids, chat last-read times, newsletter last visit, legal feed sync
//     time, projects folder, sync app-version stamp, debug toggles, releases
//     cache (sessionStorage), legal digest (sessionStorage — public law).
//
// KNOWN EXCEPTIONS still in web storage (reported, not moved here):
//   - `sb-*` — the Supabase session (refresh token). Needed BEFORE the user is
//     known (this store hydrates after auth), so it needs a safeStorage-backed
//     auth storage adapter in lib/supabaseClient + main — a separate change.
//   - sessionStorage `docvex.prefillEmail` / `docvex.prefillPassword` (dev
//     account switch), `docvex.pendingInviteToken`, `docvex.oauth.initiator`,
//     `docvex.mail.pendingProvider` — per-window, short-lived.
// ─────────────────────────────────────────────────────────────────────────────

// Class (b): content or personal data — never in localStorage.
export const SECURE_PREFIXES = Object.freeze([
  'docvex:ai-data:v1:',
  'docvex:doc-viewer:conversation:',
  'docvex:doc-viewer:captions:',
  'docvex:doc-viewer:ocr-history:',
  'docvex:doc-viewer:metadata:',
  'docvex:doc-viewer:envelope:',
  'docvex:doc-viewer:doc-theme:',
  'docvex:ai-file-index:v1',
  'docvex:ai-search-answers:v1',
  'docvex:insights:signatures:v1:',
  'docvex:insight-resolutions:v1:',
  'docvex:insights:case:v1:',
  'docvex:history:',
  'docvex:legislation:history:v1',
  'docvex:source-cache:',
  'docvex.aichat.v3.',
  'docvex.aichat.active.v1.',
  'docvex.research.v1.',
  'docvex.research.active.v1.',
  'docvex:files:opened:v1',
  'docvex:scan-tags:v1:',
  'docvex:case-timeline:v1:',
  'docvex:timeline:extract:',
  'docvex:collections:v1:',
  'docvex.folderColors.',
  'docvex:live-network:',
  'docvex:brief-network:',
  'docvex.chat.cache.',
  'docvex:legal-browser:v1',
  'docvex.projects.cache.',
  'docvex.notifications.v1.',
  'docvex.activityLog.v1.',
  'docvex:sync:clock:v1',
  'docvex:sync:gone:v1:',
  'docvex:data-web:v1:',            // what the scan understood of every file
  'docvex:phone-upload:local:v2:',  // upload address tokens
  'docvex:phone-upload:cloud:v1:',
  'docvex:phone-upload-key:',       // upload encryption keys (V6)
]);

// Class (a): what may be written to localStorage. scripts/check-localstorage.mjs
// fails the build on a `localStorage.setItem(` whose key starts with none of
// these (or is one of the secure prefixes).
export const ALLOWED_LOCALSTORAGE_PREFIXES = Object.freeze([
  'docvex.theme.',
  'docvex.appPrefs.',
  'docvex.selectedProject.',
  'docvex.recentProjects.',
  'docvex.chat.lastRead.',
  'docvex.newsletter.lastVisit.',
  'docvex.projectsDir.',
  'docvex.filesView.',
  'docvex.aiSearchConsent',
  'docvex.sidebar',
  'docvex.research.railWidth',
  'docvex.research.railHidden',
  'docvex.debug.',
  'docvex.docRules.',
  'docvex.constructor.lang',
  'docvex.perf.',
  'docvex.ai.tokens.v1',
  'docvex.ai.jurisdiction',
  'docvex:ai:',
  'docvex:research:',
  'docvex:design-system:',
  'docvex:doc-viewer:layout:',
  'docvex:doc-viewer:page-rail',
  'docvex:doc-viewer:law-refs',
  'docvex:doc-viewer:caption-settings:',
  'docvex:doc-viewer:text-reading-mode',
  'docvex:doc-engine',
  'docvex:legislation:rail-',
  'docvex:legal-view:',
  'docvex:caen:',
  'docvex:graph:lens:',
  'docvex:collection:view:',
  'docvex:insights:section:',
  'docvex:scan-features:',
  'docvex:cloud-media:v1:',
  'docvex:maps-consent:',
  'docvex:playbook:',
  'docvex:debug:',
  'docvex:legal-feed-sync:',
  'docvex:sync:app-version:',
  'docvex:sync:e2e-seen:',            // { e2e, seq } per project (lib/projectSync)
  'docvex:law-drawer-w',
  'docvex:design:drawer-w',
  'docvex:my:drawer-w',
  // Owned by other modules, pending their move (see the inventory above).
  'docvex:sync:ledger:',
  'docvex:pseudonymize:',           // a mode per project ('off' / 'all'), no data
]);

export const isSecureKey = (key) => typeof key === 'string' && SECURE_PREFIXES.some((p) => key.startsWith(p));

const NS = '_secure';                    // the private table's "project" for this store
const CHANNEL = 'docvex-secure-store';
const EVENT = 'docvex:secure-store';
const FLUSH_MS = 250;
const RETRY_MS = 5000;
const CHUNK = 24;

// ── State ───────────────────────────────────────────────────────────────────
const cache = new Map();                 // key → string
const dirty = new Map();                 // key → string | null (null = removed)
const migrated = new Set();              // localStorage keys to delete once persisted
const subscribers = new Set();
let userId = null;
let backend = null;                      // 'index' | 'vault' | 'memory' | null (not hydrated)
let ready = false;
let gen = 0;                             // bumped by every hydrate / wipe: stale work stops
let readyWaiters = [];
let flushTimer = null;
let flushing = Promise.resolve();
let warned = false;
let channel = null;
let apiOverride = null;                  // tests

const api = () => apiOverride || (typeof window !== 'undefined' ? window.electronAPI : null) || null;
const fn = (name) => (typeof api()?.[name] === 'function' ? api()[name].bind(api()) : null);
const ls = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

function emit(key, source) {
  for (const f of [...subscribers]) { try { f({ key, source }); } catch { /* a subscriber's problem */ } }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { key, source } }));
    }
  } catch { /* no DOM */ }
}

function warnOnce(why) {
  if (warned) return;
  warned = true;
  try { console.warn(`[secureStore] no encrypted storage (${why}): content is kept in memory only for this session.`); } catch { /* no console */ }
}

// ── The synchronous API ─────────────────────────────────────────────────────
export function secureGet(key) {
  const v = cache.get(String(key));
  return v === undefined ? null : v;
}

export function secureSet(key, value) {
  const k = String(key);
  const v = String(value);
  if (cache.get(k) === v) return;
  cache.set(k, v);
  dirty.set(k, v);
  scheduleFlush();
  emit(k, 'local');
}

export function secureRemove(key) {
  const k = String(key);
  // A plaintext copy left behind (memory-only mode keeps legacy copies) must
  // not bring the value back on the next launch.
  try { ls()?.removeItem(k); } catch { /* storage refused */ }
  if (!cache.has(k)) return;
  cache.delete(k);
  dirty.set(k, null);
  scheduleFlush();
  emit(k, 'local');
}

export function secureKeys(prefix = '') {
  const p = String(prefix || '');
  const out = [];
  for (const k of cache.keys()) if (k.startsWith(p)) out.push(k);
  return out;
}

// A drop-in for `localStorage` over this store. Never throws.
export const secureStorage = {
  getItem: (k) => secureGet(k),
  setItem: (k, v) => secureSet(k, v),
  removeItem: (k) => secureRemove(k),
  key: (i) => [...cache.keys()][i] ?? null,
  get length() { return cache.size; },
  keys: () => [...cache.keys()],
};

// localStorage behind the same never-throwing face, for the (a) keys.
const plainStorage = {
  getItem: (k) => { try { return ls()?.getItem(k) ?? null; } catch { return null; } },
  setItem: (k, v) => { try { ls()?.setItem(k, v); } catch { /* full or refused */ } },
  removeItem: (k) => { try { ls()?.removeItem(k); } catch { /* refused */ } },
  key: (i) => { try { return ls()?.key(i) ?? null; } catch { return null; } },
  get length() { try { return ls()?.length || 0; } catch { return 0; } },
  keys: () => { try { return Object.keys(ls() || {}); } catch { return []; } },
};

// The right store for a key: this one for (b) keys, localStorage for the rest.
export const storageFor = (key) => (isSecureKey(key) ? secureStorage : plainStorage);

export function subscribeSecureStore(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// What the `storage` event was for: `fn(key)` when a key under `prefix` was
// changed by ANOTHER window, or `fn(null)` when the whole store changed under
// this window (hydrated at sign-in, wiped at sign-out). This window's own
// writes are not reported — the stores announce those themselves.
export function subscribeSecureKeys(prefix, fn) {
  return subscribeSecureStore(({ key, source }) => {
    if (source === 'local') return;
    if (key == null) fn(null);
    else if (key.startsWith(prefix)) fn(key);
  });
}

// A value written BEFORE the store landed was made without what the store
// held (an appended log, a map) — by default it wins. A store that can do
// better registers a merge: `merge(written, stored)` → the value to keep.
const merges = [];
export function registerSecureMerge(prefix, merge) { merges.push([prefix, merge]); }
function mergeFor(key) { return merges.find(([p]) => key.startsWith(p))?.[1] || null; }

export const isSecureStoreReady = () => ready;
export const secureStoreBackend = () => backend;
export function whenSecureStoreReady() {
  if (ready) return Promise.resolve(true);
  return new Promise((r) => { readyWaiters.push(r); });
}

// For account sync (lib/projectSyncData): every entry under `prefix`, wherever
// it lives (this store for (b) keys, localStorage for the rest).
export function readStoreForSync(prefix = '') {
  const out = {};
  if (isSecureKey(prefix) || SECURE_PREFIXES.some((p) => p.startsWith(prefix))) {
    for (const k of secureKeys(prefix)) out[k] = secureGet(k);
  }
  for (const k of plainStorage.keys()) {
    if (k.startsWith(prefix) && !isSecureKey(k)) out[k] = plainStorage.getItem(k);
  }
  return out;
}
export function readKeyForSync(key) { return storageFor(key).getItem(key); }
export function writeStoreFromSync(key, value) {
  const s = storageFor(key);
  if (value == null) s.removeItem(key); else s.setItem(key, String(value));
}

// ── Persistence ─────────────────────────────────────────────────────────────
function scheduleFlush(ms = FLUSH_MS) {
  if (!ready || backend === 'memory') return;     // before hydration: kept dirty, flushed then
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flushSecureStore(); }, ms);
}

export function flushSecureStore() {
  flushing = flushing.then(() => flushOnce()).catch(() => {});
  return flushing;
}

async function flushOnce() {
  if (!ready || !dirty.size || backend === 'memory' || !backend) return;
  const myGen = gen;
  const uid = userId;
  const batch = [...dirty.entries()];
  dirty.clear();
  let failed = [];
  if (backend === 'index') {
    const put = fn('privatePut');
    for (let i = 0; i < batch.length; i += CHUNK) {
      const part = batch.slice(i, i + CHUNK);
      const res = await Promise.all(part.map(([key, v]) => Promise.resolve()
        .then(() => put({ projectId: NS, userId: uid, key, value: v == null ? null : { s: v } }))
        .then((r) => !!r && r.ok !== false && !r.error)
        .catch(() => false)));
      part.forEach((entry, j) => { if (!res[j]) failed.push(entry); });
    }
  } else if (backend === 'vault') {
    const ok = await writeVault(uid);
    if (!ok) failed = batch;
  }
  if (myGen !== gen) return;                       // wiped / switched user meanwhile
  for (const [key, v] of failed) if (!dirty.has(key)) dirty.set(key, v);
  const saved = batch.filter(([k]) => !failed.some(([f]) => f === k)).map(([k]) => k);
  // A legacy key leaves localStorage only once the encrypted copy exists.
  for (const k of saved) {
    if (migrated.has(k)) { migrated.delete(k); try { ls()?.removeItem(k); } catch { /* refused */ } }
  }
  if (saved.length) announce(saved);
  if (failed.length) scheduleFlush(RETRY_MS);
}

const vaultId = (uid) => `store-${String(uid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 70)}`;

async function writeVault(uid) {
  const put = fn('vaultPut');
  if (!put) return false;
  try {
    const res = await put(vaultId(uid), JSON.stringify(Object.fromEntries(cache)));
    return !!res && !res.error;
  } catch { return false; }
}

async function readAll(kind, uid) {
  if (kind === 'index') {
    const res = await fn('privateList')({ projectId: NS, userId: uid, prefix: '' });
    if (!res || res.error || res.ok === false) throw new Error(res?.error || 'index_unavailable');
    const list = Array.isArray(res) ? res : (res.items || res.entries || []);
    const out = {};
    for (const it of list) {
      if (!it?.key) continue;
      let v = it.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* plain */ } }
      if (v && typeof v === 'object' && typeof v.s === 'string') out[it.key] = v.s;
    }
    return out;
  }
  if (kind === 'vault') {
    const res = await fn('vaultGet')(vaultId(uid));
    if (res?.error) throw new Error(res.error);
    if (!res?.data) return {};
    const parsed = JSON.parse(res.data);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
  return {};
}

async function readOne(key) {
  if (backend === 'index') {
    const res = await fn('privateGet')({ projectId: NS, userId, key });
    if (!res || res.error || res.ok === false) return undefined;
    let v = res.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* plain */ } }
    return v && typeof v === 'object' && typeof v.s === 'string' ? v.s : null;
  }
  return undefined;
}

// Is there encryption at all? safeStorage answers through the vault's probe.
async function detectBackend() {
  const get = fn('vaultGet');
  if (!get) return { kind: 'memory', why: 'no vault bridge (old preload or not Electron)' };
  let res;
  try { res = await get('secure-probe'); } catch (err) { return { kind: 'memory', why: String(err?.message || err) }; }
  if (res?.error === 'no_encryption') return { kind: 'memory', why: 'safeStorage unavailable' };
  if (res?.error && res.error !== 'bad_id') return { kind: 'memory', why: res.error };
  if (fn('privateGet') && fn('privatePut') && fn('privateList')) return { kind: 'index' };
  if (fn('vaultPut')) return { kind: 'vault' };
  return { kind: 'memory', why: 'no writable backend' };
}

// ── Cross-window ────────────────────────────────────────────────────────────
function ensureChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (ev) => {
      // Another window erased this computer's data: drop ours, write nothing.
      if (ev?.data?.wipe) { dropEverything(); emit(null, 'wipe'); return; }
      void onRemote(ev?.data);
    };
  } catch { channel = null; }
}
function announce(keys) {
  ensureChannel();
  try { channel?.postMessage({ keys }); } catch { /* closed */ }
}
async function onRemote(msg) {
  const keys = Array.isArray(msg?.keys) ? msg.keys.filter((k) => typeof k === 'string') : [];
  if (!ready || !keys.length) return;
  const myGen = gen;
  if (backend === 'index') {
    for (const key of keys) {
      if (dirty.has(key)) continue;                // our own newer write wins
      const v = await readOne(key);
      if (myGen !== gen || v === undefined || dirty.has(key)) continue;
      if (v == null) { if (cache.delete(key)) emit(key, 'remote'); } else if (cache.get(key) !== v) { cache.set(key, v); emit(key, 'remote'); }
    }
  } else if (backend === 'vault') {
    let all;
    try { all = await readAll('vault', userId); } catch { return; }
    if (myGen !== gen) return;
    for (const key of keys) {
      if (dirty.has(key)) continue;
      const v = all[key];
      if (v == null) { if (cache.delete(key)) emit(key, 'remote'); } else if (cache.get(key) !== v) { cache.set(key, v); emit(key, 'remote'); }
    }
  }
}

// ── Hydrate / wipe ──────────────────────────────────────────────────────────
// Called when the user becomes known (every window). Loads the user's store,
// moves any legacy localStorage copies across, then notifies subscribers
// (`{ key: null, source: 'hydrate' }`). Writes made before this are kept and
// win over what the backend had.
export async function hydrateSecureStore(uid, opts = {}) {
  if (!uid) return false;
  if (opts.api) apiOverride = opts.api;
  if (userId === uid && ready) return true;
  if (userId && userId !== uid && ready) {
    // Another account was signed in: its pending writes go first, then its
    // data leaves memory.
    await flushSecureStore();
    resetMemory();
  }
  const myGen = ++gen;
  userId = uid;
  ready = false;
  const { kind, why } = await detectBackend();
  if (myGen !== gen) return false;
  let loaded = {};
  let use = kind;
  if (kind !== 'memory') {
    try { loaded = await readAll(kind, uid); } catch (err) { use = 'memory'; warnOnce(String(err?.message || err)); }
  } else warnOnce(why);
  if (myGen !== gen) return false;
  backend = use;
  for (const [k, v] of Object.entries(loaded)) {
    if (typeof v !== 'string') continue;
    if (!dirty.has(k)) { cache.set(k, v); continue; }
    const merge = mergeFor(k);
    const mine = dirty.get(k);
    if (!merge || mine == null) continue;
    try {
      const out = merge(mine, v);
      if (typeof out === 'string') { cache.set(k, out); dirty.set(k, out); }
    } catch { /* the written value stands */ }
  }
  migrateLegacy();
  if (backend === 'memory') dirty.clear();          // nowhere to write them
  ready = true;
  ensureChannel();
  const waiters = readyWaiters; readyWaiters = [];
  waiters.forEach((r) => r(true));
  emit(null, 'hydrate');
  if (backend !== 'memory') await flushSecureStore();
  return backend !== 'memory';
}

// Every class-(b) key localStorage still holds moves into the store. In
// memory-only mode the plaintext copy is READ but left (deleting it would lose
// the data at the next launch); it is removed when the value is removed.
function migrateLegacy() {
  const store = ls();
  if (!store) return;
  let keys = [];
  try { keys = Object.keys(store); } catch { return; }
  for (const k of keys) {
    if (!isSecureKey(k)) continue;
    let v = null;
    try { v = store.getItem(k); } catch { v = null; }
    if (v == null) continue;
    if (!cache.has(k) && !dirty.has(k)) {
      cache.set(k, v);
      if (backend !== 'memory') dirty.set(k, v);
    }
    if (backend !== 'memory') {
      if (dirty.has(k)) migrated.add(k);
      else { try { store.removeItem(k); } catch { /* refused */ } }   // the store already had it
    }
  }
}

function resetMemory() {
  clearTimeout(flushTimer); flushTimer = null;
  cache.clear();
  dirty.clear();
  migrated.clear();
}

// Sign-out: pending writes are flushed for the leaving user, then the data
// leaves memory. Erase (`{ persistent: true }`): nothing more is written —
// main deletes the index and the vaults (app:wipe-local-data) — and any
// class-(b) key still in localStorage goes too.
function dropEverything() {
  gen += 1;
  resetMemory();
  userId = null;
  backend = null;
  ready = false;
}

export async function wipeSecureStore({ persistent = false } = {}) {
  if (!persistent && !userId && !ready && !cache.size) return;   // nothing held
  if (!persistent && ready) await flushSecureStore();
  dropEverything();
  if (persistent) {
    ensureChannel();
    try { channel?.postMessage({ wipe: true }); } catch { /* closed */ }
    const store = ls();
    try { for (const k of Object.keys(store || {})) if (isSecureKey(k)) store.removeItem(k); } catch { /* refused */ }
  }
  emit(null, 'wipe');
}

// Tests only.
export function _resetSecureStoreForTests() {
  gen += 1;
  resetMemory();
  userId = null; backend = null; ready = false; warned = false; apiOverride = null;
  readyWaiters = []; flushing = Promise.resolve();
  subscribers.clear();
  try { channel?.close(); } catch { /* closed */ }
  channel = null;
}
