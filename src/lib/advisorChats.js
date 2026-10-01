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

import { markGone } from './syncClock';
import { secureStorage, isSecureStoreReady, whenSecureStoreReady, subscribeSecureKeys } from './secureStore';

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
export const isBlankChat = (t) => !!t && !(t.messages || []).length;

const pinnedFirst = (ts) => [...ts.filter((t) => t.pinned), ...ts.filter((t) => !t.pinned)];

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

  function persist() {
    const { key, threads, active } = state;
    if (!key) return;
    // The chats are in the ENCRYPTED store (lib/secureStore), which lands once
    // the user is known. A write before that would replace the stored list
    // with what little is in memory: wait for it (the landing merges).
    if (!isSecureStoreReady()) { void whenSecureStoreReady().then(() => persist()); return; }
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try { secureStorage.setItem(prefix + key, JSON.stringify(threads)); } catch { /* quota */ }
      try { secureStorage.setItem(activePrefix + key, active || ''); } catch { /* quota */ }
    }, 120);
  }
  function set(next, { save = true } = {}) {
    state = { ...state, ...next };
    if (save) persist();
    listeners.forEach((fn) => { try { fn(); } catch { /* a listener's own trouble */ } });
  }

  // The store landing (sign-in): read the bound list again; chats made here
  // meanwhile are kept on top of it.
  subscribeSecureKeys(prefix, (k) => {
    if (!state.key || k != null) return;
    let stored = [];
    try { const v = JSON.parse(secureStorage.getItem(prefix + state.key) || '[]'); if (Array.isArray(v)) stored = v.filter((t) => t && t.id); } catch { stored = []; }
    const ids = new Set(stored.map((t) => t.id));
    const mine = state.threads.filter((t) => !ids.has(t.id));
    const threads = pinnedFirst([...mine, ...stored]);
    let { active } = state;
    if (!active) { try { active = secureStorage.getItem(activePrefix + state.key) || null; } catch { active = null; } }
    if (!threads.some((t) => t.id === active)) active = threads[0]?.id || null;
    set({ threads, active }, { save: mine.length > 0 });
  });

  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const getState = () => state;
  const storageKey = () => (state.key ? prefix + state.key : '');

  // Point the store at one user's project (or any scope). Called by the page
  // and the sidebar alike; a second call with the same key does nothing.
  function bind(userKey, scope) {
    const key = scope ? `${userKey || '_anonymous'}.${scope}` : '';
    if (key === state.key) return;
    if (state.key) { window.clearTimeout(saveTimer); try { secureStorage.setItem(prefix + state.key, JSON.stringify(state.threads)); } catch { /* quota */ } }
    let threads = [];
    let active = null;
    if (key) {
      try { const v = JSON.parse(secureStorage.getItem(prefix + key) || '[]'); if (Array.isArray(v)) threads = v.filter((t) => t && t.id); } catch { threads = []; }
      try { active = secureStorage.getItem(activePrefix + key) || null; } catch { active = null; }
    }
    threads = pinnedFirst(threads);
    if (!threads.some((t) => t.id === active)) active = threads[0]?.id || null;
    set({ key, threads, active, closed: [] }, { save: false });
  }

  // The page's own writes (a message sent, a reply landed, a title set).
  function setChats(fnOrList) {
    const next = typeof fnOrList === 'function' ? fnOrList(state.threads) : fnOrList;
    if (next === state.threads) return;
    set({ threads: next });
  }
  function select(id) {
    if (!id || id === state.active) return;
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
      const listed = threads.filter((x) => !isBlankChat(x));
      active = (listed[Math.min(i, listed.length - 1)] || threads[0] || null)?.id || null;
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
    const threads = [...state.threads];
    threads.splice(Math.min(first.index, threads.length), 0, { ...first.tab, updatedAt: Date.now() });
    set({ threads: pinnedFirst(threads), active: first.tab.id, closed: rest });
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

  return { label, subscribe, getState, storageKey, bind, setChats, select, openNew, close, closeOthers, reopenClosed, togglePin, move, meta };
}

// ── The Advisor's chats (the names every caller already uses) ──
// (The Advisor tab's own store was removed with the tab on 2026-09-28; the
// factory above is what Research's chats are made of — lib/researchChats.)
