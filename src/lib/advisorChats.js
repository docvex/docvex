// THE ADVISOR'S CHATS AS TABS — a store outside React, as the Legislation
// tab's browser tabs are (lib/legalBrowser), so the Advisor page (/ai) and the
// APP SIDEBAR's Advisor dropdown read one list and behave alike: tabs in their
// order, pinned first, drag to reorder, × closes (and Ctrl+Shift+T brings it
// back), ONE blank "New chat" tab at a time (the Search tab's twin).
//
// A tab IS a chat thread (`{ id, title, messages, createdAt, updatedAt,
// pinned?, unreadAt? }`). The list is kept where it always was —
// `docvex.aichat.v3.<user>.<project>`, a JSON array, which account sync reads
// (lib/projectSyncData) — its ORDER now being the tabs' order; the chat on show
// is kept beside it (`docvex.aichat.active.v1.<user>.<project>`).
//
// The store itself is a FACTORY (`createChatStore`) so another page can keep
// chats that behave the same way (pages/Research, lib/researchChats); the
// named exports at the foot are the Advisor's instance, as they always were.

import { markGone, goneFor, setGone } from './syncClock';
import { secureStorage, isSecureStoreReady, whenSecureStoreReady, subscribeSecureKeys, registerSecureMerge, secureStoreUser } from './secureStore';

export const CHATS_PREFIX = 'docvex.aichat.v3.';
const ACTIVE_PREFIX = 'docvex.aichat.active.v1.';

const uid = () => {
  try { return crypto.randomUUID(); } catch { return `t_${Date.now()}_${Math.round(Math.random() * 1e9)}`; }
};
export function makeChat() {
  const now = Date.now();
  return { id: uid(), title: 'Unnamed chat', messages: [], createdAt: now, updatedAt: now };
}
// The blank chat — nothing said in it yet. There is one at most; it is not
// listed as a tab (the "New chat" item stands for it).
// An ENTRY that is not a conversation (`source`: an item a Legislation
// source tab opened — lib/legislationEntries) is never blank and never the
// chat on show.
export const isBlankChat = (t) => !!t && !t.source && !(t.messages || []).length;
const isChat = (t) => !!t && !t.source;
const firstChat = (threads) => threads.find((t) => isChat(t) && !isBlankChat(t))?.id || threads.find(isChat)?.id || null;

const pinnedFirst = (ts) => [...ts.filter((t) => t.pinned), ...ts.filter((t) => !t.pinned)];

// ── NO CHAT IS EVER LOST BY A WRITE (2026-10-03) ──
// The chats are users' research: a list is never written OVER what is stored,
// it is MERGED with it. A chat leaves the stored list only when it was closed
// (a tombstone, `markGone`) — never because some window, or a moment before
// the encrypted store had loaded, held a shorter list. Each window's copy
// follows the others' writes too. (Chats used to vanish: a window with a stale
// or still-empty list wrote it over the stored one, and a write made before
// the store landed won over everything it held.)
const parseList = (raw) => {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter((t) => t && t.id) : []; } catch { return []; }
};
const stamp = (t) => Number(t?.updatedAt) || Number(t?.createdAt) || 0;
function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (stamp(a) !== stamp(b)) return stamp(a) > stamp(b) ? a : b;
  return (b.messages?.length || 0) > (a.messages?.length || 0) ? b : a;
}
/** `mine` (this window's list, its order kept) merged with `stored`: the
 *  newer copy of each chat, the stored-only ones after, closed ones left out
 *  (unless touched since they were closed), one blank chat at most. */
export function mergeThreads(mine, stored, gone = {}) {
  const storedById = new Map((stored || []).map((t) => [t.id, t]));
  const isGone = (t) => gone[t.id] && !(stamp(t) > Number(gone[t.id]));
  const out = [];
  const seen = new Set();
  for (const t of mine || []) {
    if (!t?.id || seen.has(t.id)) continue;
    seen.add(t.id);
    const best = newer(t, storedById.get(t.id));
    if (!isGone(best)) out.push(best);
  }
  for (const t of stored || []) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (!isGone(t)) out.push(t);
  }
  let blank = false;
  return pinnedFirst(out.filter((t) => {
    if (!isBlankChat(t)) return true;
    if (blank) return false;
    blank = true;
    return true;
  }));
}
const sameList = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 60e3) return 'now';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} min`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} h`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} d`;
  try { return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); } catch { return ''; }
}

/**
 * A chat store: `{ label, subscribe, getState, storageKey, bind, setChats,
 * select, openNew, close, closeOthers, reopenClosed, togglePin, move, meta }`.
 * `prefix` / `activePrefix` are the localStorage keys, `label` the word a
 * tab's first line starts with ("Advisor", "Research").
 */
export function createChatStore({ prefix, activePrefix, label, describe }) {
  let state = { key: '', threads: [], active: null, closed: [] };
  const listeners = new Set();
  let saveTimer = 0;

  // A write made before the store landed is merged with what it held, never
  // put in its place (secureStore lets a pre-landing write win otherwise).
  registerSecureMerge(prefix, (written, stored) => JSON.stringify(mergeThreads(parseList(written), parseList(stored))));

  const goneOf = (key) => { try { return goneFor(prefix + key) || {}; } catch { return {}; } };

  // Write `threads` under `key` MERGED with what is stored there; returns the
  // merged list (what the store now holds). Nothing is written before the
  // encrypted store has landed — what is in memory then is not the list.
  function writeList(key, threads, active) {
    if (!key || !isSecureStoreReady()) return null;
    // The key starts with its user's id: a list is only written into THAT
    // user's store (after a sign-out / sign-in the old list is still in memory).
    const owner = secureStoreUser();
    if (owner && !key.startsWith(`${owner}.`)) return null;
    const merged = mergeThreads(threads, parseList(secureStorage.getItem(prefix + key)), goneOf(key));
    try { secureStorage.setItem(prefix + key, JSON.stringify(merged)); } catch { /* quota */ }
    if (active !== undefined) { try { secureStorage.setItem(activePrefix + key, active || ''); } catch { /* quota */ } }
    return merged;
  }

  // Take a merged list in without writing it again.
  function adopt(threads) {
    let { active } = state;
    if (!threads.some((t) => t.id === active && isChat(t))) active = firstChat(threads);
    state = { ...state, threads, active };
    listeners.forEach((fn) => { try { fn(); } catch { /* a listener's own trouble */ } });
  }

  function persist() {
    if (!state.key) return;
    if (!isSecureStoreReady()) { void whenSecureStoreReady().then(() => persist()); return; }
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const { key, threads, active } = state;
      const merged = writeList(key, threads, active);
      // The store held chats this window did not (another window's): show them.
      if (merged && key === state.key && !sameList(merged, state.threads)) adopt(merged);
    }, 120);
  }
  // Which list each chat lives in (its key), so a turn still running in a
  // chat writes into ITS list after the store was bound to another (Research
  // is per project: the user may switch project while an answer arrives).
  const homes = new Map();
  const remember = (key, threads) => { if (key) for (const t of threads) if (t?.id) homes.set(t.id, key); };

  function set(next, { save = true } = {}) {
    state = { ...state, ...next };
    remember(state.key, state.threads);
    if (save) persist();
    listeners.forEach((fn) => { try { fn(); } catch { /* a listener's own trouble */ } });
  }

  // The store landing (sign-in, `k` null) or ANOTHER WINDOW writing this list
  // (`k` its key): merge what is stored into this window's copy. Chats made
  // here meanwhile stay; nothing is dropped but what was closed.
  function onStored(k) {
    if (!state.key) return;
    const owner = secureStoreUser();
    if (!owner || !state.key.startsWith(`${owner}.`)) return;   // another user's store (or none)
    if (k != null && k !== prefix + state.key) return;
    const stored = parseList(secureStorage.getItem(prefix + state.key));
    const threads = mergeThreads(state.threads, stored, goneOf(state.key));
    let { active } = state;
    if (!active) { try { active = secureStorage.getItem(activePrefix + state.key) || null; } catch { active = null; } }
    if (!threads.some((t) => t.id === active && isChat(t))) active = firstChat(threads);
    if (sameList(threads, state.threads) && active === state.active) return;
    // Written back only when this window held chats the store lacked.
    const storedIds = new Set(stored.map((t) => t.id));
    const mineExtra = threads.some((t) => !storedIds.has(t.id) && !isBlankChat(t));
    set({ threads, active }, { save: mineExtra });
  }
  subscribeSecureKeys(prefix, onStored);

  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const getState = () => state;

  /** A chat by id, from the bound list or the list it lives in. */
  function getChat(id) {
    const here = state.threads.find((t) => t.id === id);
    if (here) return here;
    const key = homes.get(id);
    if (!key || !isSecureStoreReady()) return null;
    return parseList(secureStorage.getItem(prefix + key)).find((t) => t.id === id) || null;
  }
  /** Change one chat wherever it lives (merged write, never over the list). */
  function patchChat(id, fn) {
    if (state.threads.some((t) => t.id === id)) {
      setChats((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
      return;
    }
    const key = homes.get(id);
    if (!key || !isSecureStoreReady()) return;
    const list = parseList(secureStorage.getItem(prefix + key));
    if (!list.some((t) => t.id === id)) return;
    writeList(key, list.map((t) => (t.id === id ? fn(t) : t)));
  }
  /** Read the bound list from the store again (after a write made outside
   *  the store, e.g. a migration), merged with what is in memory. */
  function refresh() { onStored(null); }
  const storageKey = () => (state.key ? prefix + state.key : '');

  // Point the store at one user's project (or any scope). Called by the page
  // and the sidebar alike; a second call with the same key does nothing.
  function bind(userKey, scope) {
    const key = scope ? `${userKey || '_anonymous'}.${scope}` : '';
    if (key === state.key) return;
    // The list being left is saved (merged, and only once the store has landed
    // — before that it is not the user's list, and writing it would wipe theirs).
    if (state.key) { window.clearTimeout(saveTimer); writeList(state.key, state.threads, state.active); }
    let threads = [];
    let active = null;
    if (key) {
      threads = parseList(secureStorage.getItem(prefix + key));
      try { active = secureStorage.getItem(activePrefix + key) || null; } catch { active = null; }
    }
    threads = pinnedFirst(threads);
    if (!threads.some((t) => t.id === active && isChat(t))) active = firstChat(threads);
    set({ key, threads, active, closed: [] }, { save: false });
    // Not loaded yet (the encrypted store lands later): the landing merges.
  }

  // The page's own writes (a message sent, a reply landed, a title set).
  function setChats(fnOrList) {
    const next = typeof fnOrList === 'function' ? fnOrList(state.threads) : fnOrList;
    if (next === state.threads) return;
    set({ threads: next });
  }
  function select(id) {
    if (!id || id === state.active) return;
    if (!isChat(state.threads.find((t) => t.id === id))) return;
    set({ active: id });
  }
  // ── The tab operations (the legalBrowser twins) ──
  // New chat: the blank one if there is one, else a new blank tab at the end.
  function openNew() {
    const blank = state.threads.find(isBlankChat);
    if (blank) { set({ active: blank.id }); return blank.id; }
    const t = makeChat();
    set({ threads: [...state.threads, t], active: t.id });
    return t.id;
  }
  function close(id) {
    const i = state.threads.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = state.threads[i];
    const threads = state.threads.filter((x) => x.id !== id);
    // Remembered so account sync doesn't bring it back from another device.
    if (state.key) markGone(prefix + state.key, id);
    let { active } = state;
    if (active === id) {
      const listed = threads.filter((x) => isChat(x) && !isBlankChat(x));
      active = (listed[Math.min(i, listed.length - 1)] || threads.find(isChat) || null)?.id || null;
    }
    const closed = isBlankChat(t) ? state.closed : [{ tab: t, index: i }, ...state.closed].slice(0, 20);
    set({ threads, active, closed });
  }
  function closeOthers(id) {
    state.threads.filter((t) => t.id !== id && !t.pinned && !isBlankChat(t)).forEach((t) => close(t.id));
    select(id);
  }
  function reopenClosed() {
    const [first, ...rest] = state.closed;
    if (!first) return;
    // Its tombstone goes, so no merge leaves it out again.
    if (state.key) {
      try { const gone = goneOf(state.key); if (gone[first.tab.id]) { delete gone[first.tab.id]; setGone(prefix + state.key, gone); } } catch { /* its newer stamp still wins */ }
    }
    const threads = [...state.threads];
    threads.splice(Math.min(first.index, threads.length), 0, { ...first.tab, updatedAt: Date.now() });
    set({ threads: pinnedFirst(threads), active: isChat(first.tab) ? first.tab.id : state.active, closed: rest });
  }
  function togglePin(id) {
    set({ threads: pinnedFirst(state.threads.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))) });
  }
  // Drag: `from` goes before `to` (null = the end), taking the pinned state of
  // the place it lands in — as the Legislation tabs do.
  function move(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const list = [...state.threads];
    const at = list.findIndex((t) => t.id === fromId);
    if (at < 0) return;
    const [t] = list.splice(at, 1);
    let to = toId ? list.findIndex((x) => x.id === toId) : list.length;
    if (to < 0) to = list.length;
    list.splice(to, 0, { ...t, pinned: toId ? !!list[to]?.pinned : false });
    set({ threads: pinnedFirst(list) });
  }
  // The two lines a tab shows (the sidebar's and the rail's): what it is and
  // when, then its title.
  // `describe(t)` (optional) may say what a chat IS — { tone, siteName,
  // ownKind, title } (Research: a direct search drawn as a Legislation tab).
  function meta(t, { busy = false } = {}) {
    const when = t?.updatedAt ? relTime(t.updatedAt) : '';
    const base = {
      kind: busy ? `${label} · thinking…` : `${label}${when ? ` · ${when}` : ''}`,
      title: t?.title || 'Unnamed chat',
      tone: 'var(--accent)',
    };
    const own = describe ? describe(t) : null;
    if (!own) return base;
    return {
      ...base,
      ...own,
      kind: busy ? `${own.siteName || label} · searching…` : [own.siteName, own.ownKind].filter(Boolean).join(' · ') || base.kind,
    };
  }

  return { label, prefix, subscribe, getState, getChat, patchChat, refresh, storageKey, bind, setChats, select, openNew, close, closeOthers, reopenClosed, togglePin, move, meta };
}

// ── The Advisor's chats (the names every caller already uses) ──
// (The Advisor tab's own store was removed with the tab on 2026-09-28; the
// factory above is what Research's chats are made of — lib/researchChats.)
