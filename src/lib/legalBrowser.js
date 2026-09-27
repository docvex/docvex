// THE LEGISLATION TAB AS A BROWSER — its state, outside React so it outlives
// the platform pages (each platform is a route of its own: /legislation,
// /portal-just, /anaf, /caen) and so the app sidebar can list it too.
//
// A TAB holds a history STACK of PAGES and an index into it (back / forward),
// a DRAFT (the address bar being typed in), a PINNED flag and a LOADING flag.
// A PAGE is one of:
//
//   { type: 'new' }                          the new-tab page
//   { type: 'history' }                      every visit, in every tab
//   { type: 'serp', q, scope }               one search, every platform at once
//                                            (scope 'all' or a platform id)
//   { type: 'item', route, url, itemId,      something a platform page shows —
//     kind, title, tip, addr, pending,       an act, a court file, a company, a
//     baseline }                             CAEN class. `itemId` is the page's
//                                            own item id (lib/workspaceItems)
//                                            once bound; `url` is how to reach
//                                            it again when the page no longer
//                                            has it (after a restart);
//                                            `pending` while the page is still
//                                            opening it (`baseline` = the item
//                                            it had on show before).
//
// Showing an item page = selecting that item in its platform page (at once if
// the page still has it — lib/workspaceItems' request — else by its `url`,
// which the page answers as it always did: `?tip&nr&an&open=1`, `?nr=`,
// `?cui=`, `?code=&open=1`, or `?rid=` for a record handed over in memory).
// The pages keep their own items, as ever; the tabs sit on top.
//
// Kept per device (localStorage): the tabs, the recently closed, the history
// and the layout. Nothing here renders.

import { startTransition } from 'react';
import { requestWorkspace, workspacesSnapshot } from './workspaceItems';
import { detectQuery } from './legalOmni';

const KEY = 'docvex:legal-browser:v1';
const MAX_CLOSED = 20;
const MAX_HIST = 300;
const PENDING_MS = 4000;

// The platforms, as the tabs name and colour them.
export const PLATFORMS = {
  legislation: { id: 'legislation', route: '/legislation', site: 'legislatie.just.ro', short: 'Legislație', name: 'Legislation', tone: 'var(--cat-update)' },
  'portal-just': { id: 'portal-just', route: '/portal-just', site: 'portal.just.ro', short: 'Dosar', name: 'Court files', tone: 'var(--info)' },
  anaf: { id: 'anaf', route: '/anaf', site: 'anaf.ro', short: 'ANAF', name: 'Companies', tone: 'var(--success)' },
  caen: { id: 'caen', route: '/caen', site: 'insse.ro', short: 'CAEN', name: 'CAEN codes', tone: 'var(--warning)' },
};
export const PLATFORM_ORDER = ['legislation', 'portal-just', 'anaf', 'caen'];
export const platformOfRoute = (route) => Object.values(PLATFORMS).find((p) => p.route === route) || null;
export const LEGAL_ROUTES = PLATFORM_ORDER.map((k) => PLATFORMS[k].route);

let seq = Date.now() % 100000;
const uid = (p) => `${p}${(seq++).toString(36)}`;
const newPage = () => ({ type: 'new' });
const mkTab = (page = newPage(), o = {}) => ({ id: uid('t'), stack: [page], idx: 0, draft: null, loading: false, pinned: false, ...o });

// ── The store ──
const load = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) {
      // Item ids are the pages' own, and the pages start empty after a
      // restart: every item page is reached again by its url.
      const clean = (p) => {
        if (p?.type !== 'item') return p;
        const q = { ...p, itemId: null, pending: false, pid: null, settled: false, baseline: null };
        if (p.asked) { q.loaded = { kind: p.kind || '', title: p.title || '' }; q.title = p.asked; delete q.asked; }
        delete q.resolved;
        return q;
      };
      const tabs = raw.tabs.map((t) => ({ ...t, stack: t.stack.map(clean), draft: null, loading: false }));
      return {
        tabs,
        active: tabs.some((t) => t.id === raw.active) ? raw.active : tabs[0].id,
        closed: Array.isArray(raw.closed) ? raw.closed.slice(0, MAX_CLOSED) : [],
        hist: Array.isArray(raw.hist) ? raw.hist.slice(0, MAX_HIST) : [],
        layout: raw.layout === 'strip' ? 'strip' : 'rail',
      };
    }
  } catch { /* storage refused or garbage — start fresh */ }
  const first = mkTab();
  return { tabs: [first], active: first.id, closed: [], hist: [], layout: 'rail' };
};

let state = load();
const listeners = new Set();
let saveTimer = 0;
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const strip = (t) => ({ ...t, draft: null, loading: false });
      localStorage.setItem(KEY, JSON.stringify({
        tabs: state.tabs.map(strip), active: state.active,
        closed: state.closed.map((c) => ({ ...c, tab: strip(c.tab) })), hist: state.hist, layout: state.layout,
      }));
    } catch { /* full or refused */ }
  }, 250);
};
const set = (next) => {
  state = typeof next === 'function' ? next(state) : { ...state, ...next };
  persist();
  listeners.forEach((fn) => fn());
};
export const subscribeBrowser = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** Write the tabs to storage NOW (a window about to open reads them). */
export function flushBrowser() {
  clearTimeout(saveTimer);
  try {
    const strip = (t) => ({ ...t, draft: null, loading: false });
    localStorage.setItem(KEY, JSON.stringify({
      tabs: state.tabs.map(strip), active: state.active,
      closed: state.closed.map((c) => ({ ...c, tab: strip(c.tab) })), hist: state.hist, layout: state.layout,
    }));
  } catch { /* full or refused */ }
}
export const browserState = () => state;

export const curPage = (t) => t?.stack?.[t.idx] || newPage();
export const activeTab = () => state.tabs.find((t) => t.id === state.active) || state.tabs[0];
const mapTab = (id, fn) => state.tabs.map((t) => (t.id === id ? fn(t) : t));

// ── What a page is called ──
// A company's LEGAL FORM as it is written short — ANAF answers it in full
// ("SOCIETATE CU RĂSPUNDERE LIMITATĂ"), which a sidebar row has no room for.
const LEGAL_FORMS = [
  [/raspundere limitata.*debutant/, 'SRL-D'],
  [/raspundere limitata/, 'SRL'],
  [/^societate pe actiuni|^societate anonima/, 'SA'],
  [/nume colectiv/, 'SNC'],
  [/comandita pe actiuni/, 'SCA'],
  [/comandita simpla/, 'SCS'],
  [/persoana fizica autorizata/, 'PFA'],
  [/intreprindere individuala/, 'II'],
  [/intreprindere familiala/, 'IF'],
  [/cooperativ/, 'SCOP'],
  [/organizatie non-?guvernamentala|^asociatie/, 'Asociație'],
  [/^fundatie/, 'Fundație'],
];
const foldForm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function shortLegalForm(kind) {
  const f = foldForm(kind);
  for (const [re, short] of LEGAL_FORMS) if (re.test(f)) return short;
  return kind;
}
const ACT_SHORT = { LEGE: 'Legea', 'ORDONANȚĂ DE URGENȚĂ': 'OUG', 'ORDONANȚĂ': 'OG', 'HOTĂRÂRE': 'HG', ORDIN: 'Ordinul', DECRET: 'Decretul', DECIZIE: 'Decizia' };
export function pageMeta(p) {
  if (!p || p.type === 'new') return { kind: 'New tab', title: 'Search everything', tone: 'var(--text-muted)', addr: '', site: 'DocVex' };
  if (p.type === 'history') return { kind: 'DocVex', title: 'History', tone: 'var(--text-muted)', addr: '', site: 'DocVex' };
  if (p.type === 'serp') {
    const sc = p.scope || 'all';
    const pl = PLATFORMS[sc];
    return { kind: `Search · ${pl ? pl.name : 'All platforms'}`, title: `“${p.q}”`, tone: pl ? pl.tone : 'var(--text-secondary)', addr: p.q, site: pl ? pl.site : 'All platforms', strip: p.q };
  }
  const pl = platformOfRoute(p.route);
  // A CAEN tab names its REVISION after insse.ro, not "Class" (older tabs
  // stored "Class" / "Class · Rev. 2").
  if (p.route === '/caen' && /^Class\b/.test(p.kind || '')) p = { ...p, kind: `Rev. ${(/Rev\. (\d)/.exec(p.kind) || [])[1] || 3}` };
  const kind = p.kind ? `${pl?.short || ''}${pl ? ' · ' : ''}${p.kind}` : (pl?.short || 'Legislation');
  return {
    kind, title: p.title || 'Opening…', tone: pl?.tone || 'var(--accent)', addr: p.addr || '', site: pl?.site || '',
    // The kind line with the platform named by its SOURCE ADDRESS instead of
    // its short name ("anaf.ro · SRL", "legislatie.just.ro · LEGE") — the
    // app sidebar's list.
    siteKind: pl ? [pl.site, p.kind].filter(Boolean).join(' · ') : kind,
    siteName: pl?.site || '', ownKind: pl ? (p.route === '/anaf' ? shortLegalForm(p.kind || '') : (p.kind || '')) : '',
    // What the page loaded for the item, kept for good (see `named`) — the tooltip.
    loadedTip: p.loaded?.title ? [p.loaded.kind, p.loaded.title].filter(Boolean).join(' — ') : '',
    tip: p.tip || [p.kind, p.title].filter(Boolean).join(' — '), strip: p.strip || p.title,
  };
}

// What to type to come back to an item: its number and year, its file
// number, its CUI, its code.
export function addrOfItem(route, it) {
  const kind = String(it?.kind || ''); const title = String(it?.title || '');
  if (route === '/legislation') {
    const m = /(\d+)\s*\/\s*(\d{4})/.exec(title);
    return m ? `${ACT_SHORT[kind.toUpperCase()] || kind} ${m[1]}/${m[2]}`.trim() : title;
  }
  if (route === '/portal-just') return title;
  if (route === '/anaf') { const m = /(\d{2,10})/.exec(`${String(it?.tip || '')} ${kind}`); return m ? m[1] : title; }
  if (route === '/caen') { const m = /^(\d{2,4}|[A-V])\b/.exec(title); return m ? `caen ${m[1]}` : title; }
  return title;
}

// ── Records handed to a platform page in memory (`?rid=`) ──
const handed = new Map();
export function handRecord(rec) {
  const id = uid('r');
  handed.set(id, rec);
  if (handed.size > 50) handed.delete(handed.keys().next().value);
  return id;
}
export const takeRecord = (id) => handed.get(id) || null;

// ── Driving the router ──
// The url a navigation expects to arrive at: that arrival is ours, not a link
// from elsewhere (which becomes a page of its own).
let expected = null;
export function consumeExpected(pathWithSearch) {
  if (expected && expected === pathWithSearch) { expected = null; return true; }
  return false;
}
const freshUrl = (url) => {
  const [path, qs = ''] = String(url).split('?');
  const p = new URLSearchParams(qs);
  p.set('_', String(Date.now()));
  return `${path}?${p.toString()}`;
};
const urlOf = (page) => {
  if (page.url) return freshUrl(page.url);
  const d = detectQuery(page.addr || '');
  return d ? d.to : page.route;
};

// CLICKING IS INSTANT. A tab's selection is the store's (updated at once —
// the rail, the strip and the app sidebar move on that very frame); putting
// its page on screen (the route change, the platform page showing its item —
// the heavy part) is SCHEDULED after that frame and run as a TRANSITION, so
// React renders it in the background, interruptibly, the old page staying
// up meanwhile. `switching` says a page is on its way: LegalWorkspace fades
// the content and shows a spinner (after a moment) until the page shows it
// (`endSwitch`). Only the latest request runs — clicking through several
// tabs quickly does the work once.
let applySeq = 0;
let switchTimer = 0;
export function endSwitch() {
  clearTimeout(switchTimer);
  if (state.switching) set({ switching: false });
}
/** Put a page on screen: the router is moved to the platform it lives on, and
 *  that platform shows the item. `go = { navigate, pathname }`. */
export function applyPage(page, go) {
  const mine = ++applySeq;
  const item = !!page && page.type === 'item';
  if (item && !state.switching) set({ switching: true });
  if (!item && state.switching) endSwitch();
  clearTimeout(switchTimer);
  if (item) switchTimer = setTimeout(endSwitch, 8000);     // never stuck
  const run = () => {
    if (mine !== applySeq) return;
    // The tab's CURRENT page, not the one captured (a set() in between may
    // have replaced the object).
    const cur = curPage(activeTab());
    const target = cur && cur.type === page?.type && cur.route === page?.route ? cur : page;
    startTransition(() => applyPageNow(target, go));
  };
  // After the frame that shows the new selection.
  requestAnimationFrame(() => setTimeout(run, 0));
}
function applyPageNow(page, go) {
  if (!page || page.type !== 'item' || !go?.navigate) {
    // A tab's own page (new tab, results, history) shows on any of the
    // platforms' routes; from elsewhere, the Legislation one.
    if (go?.navigate && !LEGAL_ROUTES.includes(go.pathname)) go.navigate('/legislation');
    return;
  }
  const ws = workspacesSnapshot()[page.route];
  if (page.itemId && ws?.items?.some((x) => x.id === page.itemId)) {
    const now = requestWorkspace(page.route, 'select', page.itemId);
    if (!now || go.pathname !== page.route) go.navigate(page.route);
    return;
  }
  const url = urlOf(page);
  const baseline = ws?.activeId ?? null;
  // Each opening has its own id (`pid`): the settle below finds THIS page
  // wherever it is, never "whatever tab is active by then".
  const pid = uid('p');
  updatePageWhere((p) => p === page, (p) => ({ ...p, pending: true, pid, settled: false, baseline, pendingAt: Date.now() }));
  expected = url;
  go.navigate(url);
  setTimeout(() => settlePending(page.route, pid), PENDING_MS);
}

// ── Tabs ──
const stamp = () => new Date().toISOString();
export function logVisit(page) {
  if (!page || page.type === 'new' || page.type === 'history') return;
  const entry = { id: uid('h'), at: stamp(), page: { ...page, itemId: null, pending: false, baseline: null } };
  set((s) => ({ ...s, hist: [entry, ...s.hist].slice(0, MAX_HIST) }));
}
export const clearHistory = () => set({ hist: [] });
export const setLayout = (layout) => set({ layout });

/** Open `page` in a new tab after the active one (after the pinned). */
export function openInNewTab(page, go, { background = false } = {}) {
  const t = mkTab(page, { loading: page.type === 'serp' });
  set((s) => {
    const tabs = [...s.tabs];
    let at = tabs.findIndex((x) => x.id === s.active) + 1;
    while (at < tabs.length && tabs[at].pinned) at++;
    tabs.splice(Math.max(at, tabs.filter((x) => x.pinned).length), 0, t);
    return { ...s, tabs, active: background ? s.active : t.id };
  });
  logVisit(page);
  if (!background) applyPage(curPage(activeTab()), go);
  return t.id;
}
export const newTab = (go) => openInNewTab(newPage(), go);

// THE SEARCH TAB. Searching never piles up tabs: there is at most one BLANK
// tab (a tab still on the new-tab page it opened on), it is not listed as a
// tab of its own — the Search button stands for it — and opening the search
// goes to it, making it only when there is none. A search run from it turns
// it into an ordinary tab (it navigates), and the next Search makes a fresh
// blank one.
export const isSearchTab = (t) => !!t && t.stack?.length === 1 && curPage(t).type === 'new';
export const searchTabOf = (s = state) => s.tabs.find(isSearchTab) || null;
export function openSearch(go) {
  const blank = searchTabOf();
  if (blank) selectTab(blank.id, go); else newTab(go);
}

/** Go to `page` in the active tab (forward history is dropped). */
export function navigateActive(page, go) {
  const id = state.active;
  set((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, stack: [...t.stack.slice(0, t.idx + 1), page], idx: t.idx + 1, draft: null } : t)),
  }));
  logVisit(page);
  applyPage(page, go);
}
/** Change the active tab's current page in place (a SERP's scope). */
export function replaceActive(page) {
  const id = state.active;
  set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, stack: t.stack.map((p, i) => (i === t.idx ? page : p)) } : t)) }));
}
export function selectTab(id, go) {
  if (!state.tabs.some((t) => t.id === id)) return;
  if (id !== state.active) set({ active: id });
  applyPage(curPage(activeTab()), go);
}
export function closeTab(id, go) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const wasActive = id === state.active;
  set((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id);
    const closed = [{ tab: { ...s.tabs[i], loading: false, draft: null }, index: i }, ...s.closed].slice(0, MAX_CLOSED);
    let { active } = s;
    if (wasActive) { const n = tabs[i] || tabs[i - 1]; active = n ? n.id : null; }
    if (!tabs.length) { const t = mkTab(); tabs.push(t); active = t.id; }
    return { ...s, tabs, closed, active };
  });
  if (wasActive) applyPage(curPage(activeTab()), go);
}
export function closeOthers(id, go) {
  set((s) => {
    const gone = s.tabs.map((tab, index) => ({ tab, index })).filter((x) => x.tab.id !== id && !x.tab.pinned);
    return { ...s, tabs: s.tabs.filter((t) => t.id === id || t.pinned), closed: [...gone.reverse(), ...s.closed].slice(0, MAX_CLOSED), active: id };
  });
  applyPage(curPage(activeTab()), go);
}
export function reopenClosed(which = 0, go) {
  const c = state.closed[which];
  if (!c) return;
  set((s) => {
    const tabs = [...s.tabs];
    tabs.splice(Math.min(c.index, tabs.length), 0, c.tab);
    return { ...s, tabs, closed: s.closed.filter((_, k) => k !== which), active: c.tab.id };
  });
  applyPage(curPage(activeTab()), go);
}
export function duplicateTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = { ...state.tabs[i], id: uid('t'), draft: null, loading: false, pinned: false };
  set((s) => { const tabs = [...s.tabs]; tabs.splice(i + 1, 0, t); return { ...s, tabs, active: t.id }; });
}
export function togglePin(id) {
  set((s) => {
    const tabs = s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t));
    return { ...s, tabs: [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)] };
  });
}
/** Drag a tab before `toId` (null = to the end); it takes that place's pinned state. */
export function moveTab(fromId, toId) {
  if (!fromId || fromId === toId) return;
  set((s) => {
    const from = s.tabs.find((t) => t.id === fromId);
    if (!from) return s;
    const rest = s.tabs.filter((t) => t.id !== fromId);
    let at = toId ? rest.findIndex((t) => t.id === toId) : rest.length;
    if (at < 0) at = rest.length;
    const target = toId ? rest[at] : null;
    rest.splice(at, 0, { ...from, pinned: target ? !!target.pinned : false });
    return { ...s, tabs: [...rest.filter((t) => t.pinned), ...rest.filter((t) => !t.pinned)] };
  });
}
export function stepTab(id, d, go) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  const idx = Math.max(0, Math.min(t.stack.length - 1, t.idx + d));
  if (idx === t.idx) return;
  set((s) => ({ ...s, tabs: mapTab(id, (x) => ({ ...x, idx, draft: null })) }));
  if (id === state.active) applyPage(curPage(activeTab()), go);
}
export function setDraft(v) {
  const id = state.active;
  set((s) => ({ ...s, tabs: mapTab(id, (t) => ({ ...t, draft: v })) }));
}
export function setTabLoading(id, loading) {
  if (state.tabs.find((t) => t.id === id)?.loading === loading) return;
  set((s) => ({ ...s, tabs: mapTab(id, (t) => ({ ...t, loading })) }));
}

// ── Reloading a page ──
// A tab's RELOAD asks the source again for what the tab shows, whatever the
// session already has. A results page is re-asked by bumping its `refresh`
// (LegalBrowser's useSerp re-reads); an item page by the platform page's own
// reloader — registered by LegalWorkspace while the page is mounted
// (`registerReloader`); a reload asked of a page that is not mounted yet (a
// tab not on show) waits for it. The tab shows its spinner meanwhile.
const reloaders = new Map();   // route → () => Promise
let pendingReload = null;       // { route, tabId }
function runReload(route, tabId) {
  const fn = reloaders.get(route);
  if (!fn) return;
  setTabLoading(tabId, true);
  Promise.resolve().then(fn).catch(() => {}).finally(() => setTabLoading(tabId, false));
}
export function registerReloader(route, fn) {
  reloaders.set(route, fn);
  if (pendingReload?.route === route) {
    const { tabId } = pendingReload;
    pendingReload = null;
    setTimeout(() => runReload(route, tabId), 0);
  }
  return () => { if (reloaders.get(route) === fn) reloaders.delete(route); };
}
/** Reload tab `id` (the active one when left out). `forget(q)` drops a
 *  results page's answers (lib/legalSearch — passed in, which keeps this
 *  file free of it). */
export function reloadTab(id, go, forget) {
  const t = state.tabs.find((x) => x.id === (id || state.active));
  if (!t) return;
  const page = curPage(t);
  if (t.id !== state.active) selectTab(t.id, go);
  if (page.type === 'serp') {
    Promise.resolve(forget?.(page.q)).finally(() => {
      set((s) => ({ ...s, tabs: mapTab(t.id, (x) => ({ ...x, stack: x.stack.map((p, i) => (i === x.idx ? { ...p, refresh: (p.refresh || 0) + 1 } : p)) })) }));
    });
    return;
  }
  if (page.type !== 'item') return;
  const mounted = reloaders.has(page.route) && go?.pathname === page.route;
  if (mounted && t.id === state.active) runReload(page.route, t.id);
  else pendingReload = { route: page.route, tabId: t.id };
}
export const canReload = (t) => { const p = curPage(t); return p.type === 'serp' || p.type === 'item'; };

// ── Binding the platform pages' items ──
function updatePageWhere(test, fn) {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    let hit = false;
    const stack = t.stack.map((p) => { if (test(p)) { hit = true; return fn(p); } return p; });
    if (!hit) return t;
    changed = true;
    return { ...t, stack };
  });
  if (changed) set((s) => ({ ...s, tabs }));
}

// A TAB'S LABEL IS NEVER TOUCHED. It is what the tab was opened with — what
// was typed ("CUI 2408422"), a link's label, a search result's name — and the
// platform page only fills in what is missing (no kind, no title, or
// "Opening…"). What the page LOADS for the item — its own name (the
// company's, "LEGE · nr. 31/1990") — is kept beside it, ONCE and for good
// (`loaded`, stored with the tabs, so remembered across restarts), and
// shown in the tab's tooltip.
const PLACEHOLDER = /^(|Opening…|Opening\.\.\.)$/;
const named = (p, it) => {
  if (!it) return {};
  const real = (v) => !!v && !PLACEHOLDER.test(v);
  return {
    kind: p.kind || it.kind || '',
    title: PLACEHOLDER.test(p.title || '') ? (it.title || p.title) : p.title,
    tip: p.tip || it.tip,
    loaded: p.loaded || (real(it.title) ? { kind: real(it.kind) ? it.kind : '', title: it.title } : null),
  };
};

/** A platform page reported its items / the one on show (LegalWorkspace,
 *  every render): names follow the items, a pending page binds to what the
 *  page opened, and an item the reader opened INSIDE a page (a citation, a
 *  row of the page's own results) becomes a page of the active tab. */
export function reportItems(route, items, activeId, lastActiveId) {
  const byId = new Map(items.map((it) => [it.id, it]));
  // Names — only what a tab is missing (`named`).
  updatePageWhere(
    (p) => {
      if (p.type !== 'item' || p.route !== route || !p.itemId || !byId.has(p.itemId)) return false;
      const n = named(p, byId.get(p.itemId));
      return n.kind !== p.kind || n.title !== p.title || (!!n.loaded && !p.loaded);
    },
    (p) => { const it = byId.get(p.itemId); return { ...p, ...named(p, it), addr: p.addr || addrOfItem(route, it) }; },
  );
  const t = activeTab();
  const page = curPage(t);
  if (page.type !== 'item' || page.route !== route || activeId == null) return;
  const it = byId.get(activeId);
  if (page.pending) {
    if (activeId !== page.baseline) {
      updatePageWhere((p) => p === page, (p) => ({ ...p, itemId: activeId, pending: false, pid: null, settled: true, baseline: null, ...named(p, it), addr: p.addr || (it ? addrOfItem(route, it) : '') }));
      setTabLoading(t.id, false);
    }
    return;
  }
  if (page.itemId === activeId) return;
  if (lastActiveId === activeId) return;
  // Opened inside the page: a new page of this tab (back returns).
  const next = { type: 'item', route, itemId: activeId, kind: it?.kind || '', title: it?.title || '', tip: it?.tip || '', addr: it ? addrOfItem(route, it) : '', url: null, loaded: it?.title ? { kind: it.kind || '', title: it.title } : null };
  set((s) => ({ ...s, tabs: mapTab(t.id, (x) => ({ ...x, stack: [...x.stack.slice(0, x.idx + 1), next], idx: x.idx + 1, draft: null })) }));
  logVisit(next);
}

// A page still pending when its time runs out: bound to whatever the platform
// has on show (it may have been open already — then nothing changed to bind
// on), else left as the platform's own answer (a list to pick from).
// Settles ONE opening (its `pid`). Bound to what the platform shows only if
// that page is STILL the one on screen (the active tab's current page, its
// route showing) — binding whatever was active once the reader had switched
// tabs gave a tab another tab's item, and from then on selecting it showed
// the wrong content. A page left behind is simply unbound again, so selecting
// its tab opens it afresh.
function settlePending(route, pid) {
  const owner = state.tabs.find((t) => t.stack.some((p) => p.pid === pid && p.pending));
  if (!owner) return;
  const page = owner.stack.find((p) => p.pid === pid);
  const onScreen = owner.id === state.active && curPage(owner) === page;
  const ws = workspacesSnapshot()[route];
  const it = onScreen && ws?.activeId ? ws.items.find((x) => x.id === ws.activeId) : null;
  updatePageWhere((p) => p === page, (p) => (it
    ? { ...p, itemId: it.id, pending: false, pid: null, settled: true, ...named(p, it), addr: p.addr || addrOfItem(route, it) }
    : { ...p, pending: false, pid: null, settled: true }));
  setTabLoading(owner.id, false);
  if (onScreen) endSwitch();
}

/** A link arrived from elsewhere (the Doc Viewer's "Read here", ANAF's Court
 *  files, the Newsletter): a page of the active tab — or of a new one when
 *  `newTab`, or when the active tab is pinned. */
export function arrive(route, url, label, go, { newTab: inNew = false } = {}) {
  const ws = workspacesSnapshot()[route];
  const pl = platformOfRoute(route);
  const pid = uid('p');
  const page = { type: 'item', route, url, itemId: null, kind: '', title: label || pl?.name || '', addr: label || '', pending: true, pid, baseline: ws?.activeId ?? null, pendingAt: Date.now() };
  const t = activeTab();
  if (inNew || t?.pinned) {
    const nt = mkTab(page, { loading: true });
    set((s) => { const tabs = [...s.tabs]; const at = tabs.findIndex((x) => x.id === s.active) + 1; tabs.splice(at, 0, nt); return { ...s, tabs, active: nt.id }; });
  } else {
    set((s) => ({ ...s, tabs: mapTab(t.id, (x) => ({ ...x, stack: [...x.stack.slice(0, x.idx + 1), page], idx: x.idx + 1, draft: null, loading: true })) }));
  }
  logVisit(page);
  setTimeout(() => settlePending(route, pid), PENDING_MS);
  void go;
}

/** A link's label from its query: what the tab will be called while it opens. */
export function arrivalLabel(route, params) {
  const g = (k) => params.get(k) || '';
  if (route === '/legislation' && g('nr')) return `${ACT_SHORT[g('tip')] || g('tip') || 'Act'} ${g('nr')}${g('an') ? `/${g('an')}` : ''}`.trim();
  if (route === '/legislation' && g('titlu')) return `“${g('titlu')}”`;
  if (route === '/portal-just') return g('nr') || (g('parte') ? `Files naming “${g('parte')}”` : '');
  if (route === '/anaf') return g('cui') ? `CUI ${g('cui')}` : '';
  if (route === '/caen') return g('code') ? `caen ${g('code')}` : g('q') ? `caen ${g('q')}` : '';
  return '';
}
