// A DRAFT — DocVex's own document file (`.dvdraft`, 2026-10-03). It replaces the
// Create menu's "Document": instead of an empty Office file the AI rebuilds on
// every turn, a draft is ONE file holding everything about the document being
// written —
//   text          the document itself (the line-based source the AI writes and
//                 the viewer's editor shows; the user types into it too)
//   versions      every version the AI wrote: [{ n, text, instructions, at }]
//   active        which version the text was last taken from
//   conversation  the AI thread that made it: { messages, branches, activeBranchId }
// — and the Word file is made FROM it on request (the viewer's "To Word" quick
// action), as often as wanted, beside the draft.
//
// The conversation travels WITH THE FILE (unlike other files' advisor threads,
// which stay in this machine's private store): that is the point of a draft —
// whoever opens it continues where it was left.
//
// Two writers share a draft — the editor (text) and the advisor (versions and
// the conversation) — so writes are PATCHES merged into the latest copy (kept
// in memory per path) and written one at a time, coalesced, never a whole
// object built from a stale read.
import { localFolderApi, readLocalBlob } from './localFolder';

export const DRAFT_EXT = 'dvdraft';
export const DRAFT_MIME = 'application/vnd.docvex.draft+json';
export const DRAFT_TYPE = 'docvex/draft';

export const isDraftName = (name) => new RegExp(`\\.${DRAFT_EXT}$`, 'i').test(String(name || ''));

export function emptyDraft() {
  return { type: DRAFT_TYPE, v: 1, text: '', versions: [], active: null, conversation: null, updatedAt: Date.now() };
}

export function parseDraft(raw) {
  let d = null;
  try { d = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw; } catch { d = null; }
  if (!d || typeof d !== 'object') return emptyDraft();
  return {
    type: DRAFT_TYPE,
    v: 1,
    text: typeof d.text === 'string' ? d.text : '',
    versions: Array.isArray(d.versions) ? d.versions.filter((x) => x && typeof x.text === 'string') : [],
    active: Number.isFinite(d.active) ? d.active : null,
    conversation: d.conversation && typeof d.conversation === 'object' ? d.conversation : null,
    updatedAt: Number(d.updatedAt) || 0,
  };
}

export const draftBlob = (draft) => new Blob([JSON.stringify(draft, null, 1)], { type: DRAFT_MIME });

const fold = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const cache = new Map();   // folded path → the latest draft (read or written)
const queue = new Map();   // folded path → { patch, timer, running, waiters }
const listeners = new Set();

/** The draft as last read or written in this window (sync), or null. */
export const peekDraft = (path) => cache.get(fold(path)) || null;

/** Told `(path, draft)` whenever a draft changes in this window. */
export function subscribeDrafts(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Read a draft from disk (and remember it). A missing / empty file is an empty draft. */
export async function readDraft(path) {
  let raw = '';
  try { raw = await (await readLocalBlob(path))?.text?.() || ''; } catch { raw = ''; }
  const d = parseDraft(raw);
  // A write still queued here is newer than the disk.
  const q = queue.get(fold(path));
  const merged = q?.patch ? { ...d, ...q.patch } : d;
  cache.set(fold(path), merged);
  return merged;
}

function splitPath(path) {
  const p = String(path || '');
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return { dir: cut >= 0 ? p.slice(0, cut) : '', name: cut >= 0 ? p.slice(cut + 1) : p };
}

async function flush(path) {
  const k = fold(path);
  const q = queue.get(k);
  if (!q || q.running || !q.patch) return;
  q.running = true;
  const patch = q.patch;
  q.patch = null;
  const waiters = q.waiters.splice(0);
  let ok = false;
  try {
    const base = cache.get(k) || await readDraft(path);
    const next = { ...base, ...patch, type: DRAFT_TYPE, v: 1, updatedAt: Date.now() };
    cache.set(k, next);
    const { dir, name } = splitPath(path);
    const res = await localFolderApi.writeFiles({ dir, files: [{ filename: name, blob: draftBlob(next) }] });
    ok = !res?.error && res?.results?.[0]?.ok !== false;
  } catch { ok = false; }
  q.running = false;
  waiters.forEach((w) => w(ok));
  if (q.patch) void flush(path); else queue.delete(k);
}

/**
 * Merge `patch` into the draft at `path` and write it (coalesced: patches made
 * within `delay` ms go out as one write). Resolves true once written.
 */
export function writeDraft(path, patch, { delay = 250 } = {}) {
  const k = fold(path);
  // The in-memory copy moves at once, so a read right after sees the change.
  const cur = cache.get(k) || emptyDraft();
  const next = { ...cur, ...patch };
  cache.set(k, next);
  listeners.forEach((fn) => { try { fn(path, next); } catch { /* a listener's problem */ } });
  let q = queue.get(k);
  if (!q) { q = { patch: null, timer: 0, running: false, waiters: [] }; queue.set(k, q); }
  q.patch = { ...(q.patch || {}), ...patch };
  return new Promise((resolve) => {
    q.waiters.push(resolve);
    clearTimeout(q.timer);
    q.timer = setTimeout(() => void flush(path), delay);
  });
}

// ── The document AS THE AI WRITES IT (memory only) ───────────────────────
// A draft is written in a DIALOG: while a reply streams, the document part of
// it is shown on the page as it arrives. That text is not the draft yet —
// nothing is written to disk until the reply is complete (then the advisor
// writes it as a version) — so it travels apart: `setDraftLive(path, text)`
// while streaming, `setDraftLive(path, null)` when the reply has landed or
// was stopped.
const live = new Map();        // folded path → the document so far
const liveListeners = new Set();

export const peekDraftLive = (path) => (live.has(fold(path)) ? live.get(fold(path)) : null);

export function setDraftLive(path, text) {
  const k = fold(path);
  if (text == null) { if (!live.has(k)) return; live.delete(k); } else live.set(k, String(text));
  liveListeners.forEach((fn) => { try { fn(path, text == null ? null : String(text)); } catch { /* a listener's problem */ } });
}

/** Told `(path, text | null)` as a reply's document streams in. */
export function subscribeDraftLive(fn) { liveListeners.add(fn); return () => liveListeners.delete(fn); }

/**
 * Split a (partial) reply into what is SAID and the DOCUMENT it carries:
 * `<document>…</document>` holds the document, everything else is the chat
 * message. `doc` is null while no document has started; `done` once it closed.
 */
export function splitDraftReply(all) {
  const s = String(all || '');
  const OPEN = '<document>';
  const CLOSE = '</document>';
  const at = s.indexOf(OPEN);
  // A tag half-arrived at the very end is not shown as chat.
  const trimTail = (t) => t.replace(/<\/?[a-z]{0,9}$/i, '');
  if (at < 0) return { chat: trimTail(s).trim(), doc: null, done: false };
  const rest = s.slice(at + OPEN.length);
  const end = rest.indexOf(CLOSE);
  const doc = (end < 0 ? trimTail(rest) : rest.slice(0, end)).replace(/^\r?\n/, '');
  const after = end < 0 ? '' : rest.slice(end + CLOSE.length);
  return { chat: `${s.slice(0, at)}${after}`.trim(), doc: end < 0 ? doc : doc.replace(/\s+$/, ''), done: end >= 0 };
}

/** The conversation record a draft holds, in lib/conversationHistory's shape. */
export function draftConversation(d) {
  const c = d?.conversation || {};
  return {
    messages: Array.isArray(c.messages) ? c.messages : [],
    versions: Array.isArray(d?.versions) ? d.versions : [],
    branches: Array.isArray(c.branches) ? c.branches : undefined,
    activeBranchId: c.activeBranchId || undefined,
    updatedAt: d?.updatedAt || 0,
  };
}

/** A free "<stem>.docx" name beside the draft (never over an existing file). */
export function wordNameFor(draftName, taken = new Set()) {
  const stem = String(draftName || 'Draft').replace(new RegExp(`\\.${DRAFT_EXT}$`, 'i'), '') || 'Draft';
  let name = `${stem}.docx`;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${stem} (${n}).docx`;
  return name;
}
