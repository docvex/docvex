// Per-file cache of the DocViewer AI-advisor conversation (and, for generated
// documents, the version iterations), keyed by the file's on-disk path so
// reopening the same file restores the whole thread — matching how
// lib/extractionHistory.js (OCR snippets) and lib/captionsHistory.js (audio
// captions) persist their interactions per file.
//
// WHERE IT LIVES: the project index's PRIVATE store (lib/projectIndexClient;
// src/projectIndex/README.md) — per signed-in user, on this machine only. A
// conversation is the user's own, not knowledge about the file, so it is never
// written to `.docvex/` where it would travel with the case folder to whoever
// else opens it; the account sync's private bundle (lib/projectSyncData) is the
// only thing that carries it, between the user's own devices.
//
// It is kept under projectId null (main's `_loose.db`) and keyed by the folded
// absolute path, whatever project the file is in: a Doc Viewer window can read
// a conversation before anyone has told it which project the file belongs to,
// and one key per file, in one place, is what makes that read deterministic.
// Every conversation of the user is loaded once (`privateList`) and served from
// memory, so the reads stay synchronous.
//
// Without main's side it is the per-file key store it was — now the ENCRYPTED
// secure store (lib/secureStore), never localStorage (V5); those keys are moved
// into the private table on the first load and removed once main has them.
import { supabase } from './supabaseClient';
import { privateAvailable, privateList, privatePut, registerPathHydrator } from './projectIndexClient';
import { secureStorage, secureKeys, subscribeSecureStore } from './secureStore';

const KEY_PREFIX = 'docvex:doc-viewer:conversation:';
const PRIVATE_PREFIX = 'conversation:';

// Exposed so other surfaces can recognise the old keys (lib/projectDataWipe).
export const CONVERSATION_PREFIX = KEY_PREFIX;

function safeRead(key) {
  try { return secureStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { secureStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { secureStorage.removeItem(key); return true; } catch { return false; }
}

// Normalise a file path into a STABLE key. The same file can reach us with
// different path text depending on where it came from — the create flow
// (writeFiles result), a later double-click (directory listing), or a
// generate-time rename — which on Windows can differ in separator (\ vs /),
// drive-letter casing, or a trailing slash. Folding those out means a file
// always maps to the same conversation, so reopening it shows the saved chat.
const folded = (filePath) => String(filePath || '')
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
  .toLowerCase();
function keyFor(filePath) {
  return KEY_PREFIX + folded(filePath);
}

// ── The private store's copy ────────────────────────────────────────────────
// folded path → record; loaded once per user.
let userId = null;
let loadedFor = null;
let loading = null;
const store = new Map();

async function currentUser() {
  try { return (await supabase.auth.getSession()).data.session?.user?.id || null; } catch { return null; }
}
try {
  supabase.auth.onAuthStateChange((_e, session) => {
    const next = session?.user?.id || null;
    if (next === userId) return;
    userId = next;
    loadedFor = null;
    store.clear();
    if (next) void ensureLoaded();
  });
} catch { /* no auth in this context */ }

const usingPrivate = () => !!(privateAvailable() && userId && loadedFor === userId);

// Load every conversation of the user from the private store, then move the
// old localStorage keys across (each removed only once main has it).
export function ensureLoaded() {
  if (!privateAvailable()) return Promise.resolve(false);
  if (loading) return loading;
  loading = (async () => {
    if (!userId) userId = await currentUser();
    if (!userId) return false;
    if (loadedFor === userId) return true;
    const who = userId;
    const items = await privateList({ projectId: null, userId: who, prefix: PRIVATE_PREFIX });
    if (!items || who !== userId) return false;
    store.clear();
    for (const { key, value } of items) {
      const rec = parseRecord(value);
      if (rec && String(key).startsWith(PRIVATE_PREFIX)) store.set(String(key).slice(PRIVATE_PREFIX.length), { ...rec, raw: value });
    }
    loadedFor = who;
    await migrateLegacy(who);
    return true;
  })().finally(() => { loading = null; });
  return loading;
}
// A Doc Viewer window awaits hydratePath before its first read; this makes
// that include the conversations.
registerPathHydrator(() => ensureLoaded());
// The secure store lands after sign-in (and brings any keys moved out of
// localStorage): fold those into the private table too.
subscribeSecureStore(({ source }) => {
  if (source === 'hydrate' && userId && loadedFor === userId) void migrateLegacy(userId);
});

async function migrateLegacy(who) {
  let keys = [];
  try { keys = secureKeys(KEY_PREFIX); } catch { return; }
  for (const k of keys) {
    const raw = safeRead(k);
    const rec = parseRecord(raw);
    if (!rec) { safeRemove(k); continue; }
    const f = folded(k.slice(KEY_PREFIX.length));
    const cur = store.get(f);
    // The newer of the two stands; an older local copy is simply dropped.
    if (!cur || (rec.updatedAt || 0) > (cur.updatedAt || 0)) {
      const value = JSON.parse(raw);
      if (!(await privatePut({ projectId: null, userId: who, key: PRIVATE_PREFIX + f, value }))) continue;
      store.set(f, { ...rec, raw: value });
    }
    safeRemove(k);
  }
}

function readRaw(filePath) {
  if (usingPrivate()) {
    const hit = store.get(folded(filePath));
    if (hit) return hit.raw;
  } else if (privateAvailable()) {
    void ensureLoaded();
  }
  // Prefer the normalised key; fall back to the legacy raw-path key so chats
  // saved before this normalisation still surface.
  const raw = safeRead(keyFor(filePath)) || safeRead(KEY_PREFIX + filePath);
  return raw == null ? null : raw;
}

function writeRecord(filePath, record) {
  const f = folded(filePath);
  if (usingPrivate()) {
    store.set(f, { ...parseRecord(record), raw: record });
    const who = userId;
    privatePut({ projectId: null, userId: who, key: PRIVATE_PREFIX + f, value: record }).then((ok) => {
      // Refused: keep it the old way, so it is not lost; the next load moves it.
      if (!ok) safeWrite(keyFor(filePath), JSON.stringify(record));
    });
    safeRemove(keyFor(filePath));
    return true;
  }
  return safeWrite(keyFor(filePath), JSON.stringify(record));
}

function removeRecord(filePath) {
  const f = folded(filePath);
  let had = false;
  if (usingPrivate() && store.has(f)) {
    store.delete(f);
    had = true;
    // The contract has no delete: a null value is the removal.
    void privatePut({ projectId: null, userId, key: PRIVATE_PREFIX + f, value: null });
  }
  safeRemove(KEY_PREFIX + filePath); // legacy raw key, if any
  return safeRemove(keyFor(filePath)) || had;
}

function parseRecord(raw) {
  if (raw == null) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      versions: Array.isArray(parsed.versions) ? parsed.versions : [],
      // Branch set for the advisor's split conversations; undefined for older
      // records (pre-branching) so the caller falls back to a single "Main".
      branches: Array.isArray(parsed.branches) ? parsed.branches : undefined,
      activeBranchId: parsed.activeBranchId || undefined,
      // Per-paragraph conversations, keyed `para:<indices>`. Each is isolated
      // from the document thread and from every other paragraph's, so reopening
      // a file has to restore them all — not just the one that was on screen.
      paraThreads: (parsed.paraThreads && typeof parsed.paraThreads === 'object'
        && !Array.isArray(parsed.paraThreads)) ? parsed.paraThreads : undefined,
      updatedAt: parsed.updatedAt || 0,
    };
  } catch {
    return null;
  }
}

// ── A conversation FOLLOWS a generate-time rename ──────────────────────────
// A new document is a wildcard ("Untitled 3") that the AI renames once it knows
// the kind ("Untitled 3.docx"). The viewer goes on showing — and saving under —
// the old path for a moment after the rename, so the messages landed under the
// old name and the new name kept only the version: reopening the file showed an
// empty thread (2026-10-03). Now the old path REDIRECTS to the new one for the
// rest of the session, and a record found split that way is joined back.
const renamedTo = new Map(); // folded old path → new path
function resolvePath(filePath) {
  let p = filePath;
  for (let i = 0; i < 8; i += 1) {
    const next = renamedTo.get(folded(p));
    if (!next || folded(next) === folded(p)) break;
    p = next;
  }
  return p;
}
const threadOf = (rec) => !!rec && (rec.messages.length
  || (rec.branches || []).some((b) => Array.isArray(b.messages) && b.messages.length));

// Join an older record (the messages, saved under the wildcard path) into the
// newer one (the versions, saved under the renamed path): messages / branches
// from whichever has them, versions merged by number (the newer wins).
function joinRecords(main, extra) {
  const useExtraThread = !threadOf(main) && threadOf(extra);
  const byN = new Map();
  for (const v of extra.versions || []) byN.set(v.n, v);
  for (const v of main.versions || []) byN.set(v.n, v);
  const out = {
    messages: useExtraThread ? extra.messages : main.messages,
    versions: [...byN.values()].sort((a, b) => (a.n || 0) - (b.n || 0)),
    updatedAt: Date.now(),
  };
  const br = useExtraThread ? extra.branches : main.branches;
  if (br) { out.branches = br; out.activeBranchId = (useExtraThread ? extra.activeBranchId : main.activeBranchId) || undefined; }
  const paras = { ...(extra.paraThreads || {}), ...(main.paraThreads || {}) };
  if (Object.keys(paras).length) out.paraThreads = paras;
  return out;
}

/** The file at `oldPath` is now `newPath` (a generate-time rename): move its
 *  conversation across and send every later save of the old path there. */
export function followRename(oldPath, newPath) {
  if (!oldPath || !newPath || folded(oldPath) === folded(newPath)) return false;
  renamedTo.set(folded(oldPath), newPath);
  const old = parseRecord(readRaw(oldPath));
  if (!old) return false;
  const cur = parseRecord(readRaw(newPath));
  writeRecord(newPath, cur ? joinRecords(cur, old) : { ...old, updatedAt: Date.now() });
  removeRecord(oldPath);
  return true;
}

// A record saved before this fix: the versions under "X.docx", the messages
// under "X" (the same document before its extension). Joined only when the two
// share a version's text, so an unrelated extension-less file is never borrowed.
function recoverSplit(filePath, rec) {
  if (!rec || threadOf(rec)) return rec;
  const stem = String(filePath).replace(/\.[a-z0-9]{2,5}$/i, '');
  if (stem === String(filePath)) return rec;
  const old = parseRecord(readRaw(stem));
  if (!threadOf(old)) return rec;
  const texts = new Set((old.versions || []).map((v) => v.text).filter(Boolean));
  if (!(rec.versions || []).some((v) => v.text && texts.has(v.text))) return rec;
  const joined = joinRecords(rec, old);
  writeRecord(filePath, joined);
  removeRecord(stem);
  return parseRecord(joined);
}

// Returns { messages: [...], versions: [...], updatedAt } | null.
export function loadConversation(filePath) {
  if (!filePath) return null;
  const p = resolvePath(filePath);
  return recoverSplit(p, parseRecord(readRaw(p)));
}

export function saveConversation(filePathIn, { messages, versions, branches, activeBranchId, paraThreads }) {
  if (!filePathIn) return false;
  // A save of a path that was renamed goes to its new name.
  const filePath = resolvePath(filePathIn);
  const msgs = Array.isArray(messages) ? messages : [];
  const vers = Array.isArray(versions) ? versions : [];
  const brs = Array.isArray(branches) ? branches : null;
  // Drop paragraph threads that never got a message — an empty one is just a
  // paragraph somebody clicked on, not a conversation worth storing.
  const paras = {};
  for (const [k, v] of Object.entries(paraThreads || {})) {
    if (Array.isArray(v) && v.length) paras[k] = v;
  }
  const hasParaContent = Object.keys(paras).length > 0;
  // A thread may live only in a non-active branch, so count branch content too.
  const hasBranchContent = !!brs && brs.some((b) => Array.isArray(b.messages) && b.messages.length);
  // Empty → no-op. We must NOT delete here: the provider's save effect fires on
  // mount with the initial empty thread (before the load effect has populated
  // it), and in React StrictMode that empty save runs BEFORE the load re-reads
  // storage — deleting on empty would wipe the saved chat on every reopen. Use
  // clearConversation() to remove a thread on purpose.
  if (!msgs.length && !vers.length && !hasBranchContent && !hasParaContent) return false;

  // NEVER DOWNGRADE. The check above only catches a save that is empty in
  // EVERY respect; a file with paragraph threads (or an in-flight version list)
  // clears it while its document thread is still [] — which is exactly the
  // state the provider is in for one render after a file is opened, before the
  // load effect's setState lands. That save was overwriting real conversations
  // with empty ones, and the next render's correct save only repaired it if the
  // window survived that long. It did not always.
  //
  // So: a stored record that HAS a thread is never replaced by one that has
  // none. Emptying a conversation on purpose goes through clearConversation().
  const prior = parseRecord(readRaw(filePath));
  if (prior) {
    const priorHasThread = prior.messages.length
      || prior.versions.length
      || (prior.branches || []).some((b) => Array.isArray(b.messages) && b.messages.length);
    const nextHasThread = msgs.length || vers.length || hasBranchContent;
    if (priorHasThread && !nextHasThread) return false;
  }

  const record = { messages: msgs, versions: vers, updatedAt: Date.now() };
  // Persist the branch set (split conversations) + which one is active so
  // reopening the file restores every branch, not just the active thread.
  if (brs) {
    record.branches = brs;
    record.activeBranchId = activeBranchId || undefined;
  }
  if (hasParaContent) record.paraThreads = paras;
  return writeRecord(filePath, record);
}

export function clearConversation(filePath) {
  if (!filePath) return false;
  return removeRecord(filePath);
}

// Move a saved conversation from one path to another so the chat FOLLOWS the
// file across a rename or a move (the key is path-derived, so without this the
// thread would be orphaned under the old path). Call this from the rename/move
// handlers. No-op when there's nothing saved or the destination already has a
// thread (don't clobber).
export function migrateConversation(oldPath, newPath) {
  if (!oldPath || !newPath) return false;
  if (folded(oldPath) === folded(newPath)) return false;
  const raw = readRaw(oldPath);
  if (raw == null) return false;
  if (readRaw(newPath) != null) return false; // a chat already exists at the destination
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  writeRecord(newPath, value);
  removeRecord(oldPath);
  return true;
}

// Migrate every conversation under a folder prefix (used when a FOLDER is
// renamed/moved — all the files inside shift path together).
export function migrateConversationsUnder(oldDir, newDir) {
  if (!oldDir || !newDir) return 0;
  const from = `${folded(oldDir)}/`;
  const to = `${folded(newDir)}/`;
  let moved = 0;
  const paths = new Set();
  if (usingPrivate()) for (const f of store.keys()) if (f.startsWith(from)) paths.add(f);
  for (const k of secureKeys(KEY_PREFIX + from)) paths.add(k.slice(KEY_PREFIX.length));
  for (const f of paths) {
    if (migrateConversation(f, to + f.slice(from.length))) moved += 1;
  }
  return moved;
}

// ── For account sync (lib/projectSyncData's private bundle) ─────────────────
// Every conversation this user has, as [{ path (folded), record }] — whichever
// store holds it. Loads the private store first.
export async function listConversations() {
  await ensureLoaded();
  const out = new Map();
  try {
    for (const k of secureKeys(KEY_PREFIX)) {
      const raw = safeRead(k);
      const rec = raw && JSON.parse(raw);
      if (rec && typeof rec === 'object') out.set(folded(k.slice(KEY_PREFIX.length)), rec);
    }
  } catch { /* none */ }
  if (usingPrivate()) {
    for (const [f, hit] of store) {
      const cur = out.get(f);
      const raw = typeof hit.raw === 'string' ? JSON.parse(hit.raw) : hit.raw;
      if (!cur || (raw?.updatedAt || 0) >= (cur.updatedAt || 0)) out.set(f, raw);
    }
  }
  return [...out.entries()].map(([path, record]) => ({ path, record }));
}

// Store a conversation that came from another of the user's devices, as is.
export async function putConversationRecord(filePath, record) {
  if (!filePath || !record || typeof record !== 'object') return false;
  await ensureLoaded();
  return writeRecord(filePath, record);
}

// Whether this user's saved conversations are in memory yet — and a promise
// for when they are. The Doc Viewer WAITS on it before reading a file's thread:
// read too early (a window opened straight on a file), the private store is
// still loading, the read finds nothing, the file opens on an EMPTY thread —
// and the next message then saved a new thread over the old one.
export function conversationsSettled() {
  return !privateAvailable() || (!!userId && loadedFor === userId);
}
export function whenConversationsReady() {
  if (conversationsSettled()) return Promise.resolve(true);
  return ensureLoaded().catch(() => false);
}
