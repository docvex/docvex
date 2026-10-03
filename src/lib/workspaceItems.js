// What each Legislation source tab has OPEN — the acts, CAEN classes, court
// files and companies that used to stand in the tab's own rail — published
// for the APP SIDEBAR, which lists them under its Legislation entry (a
// dropdown, one block per tab). The tabs are separate pages that unmount as
// the user moves between them, so their lists live here, module-level, and
// survive the page that wrote them.
//
// A page (components/LegalWorkspace) PUBLISHES `{ items, activeId }` under its
// route on every render and REGISTERS its handlers while mounted. The sidebar
// asks for a select / close with `requestWorkspace`: a mounted page answers at
// once; an unmounted one gets the request QUEUED and answers when it mounts
// again (its list comes back from lib/pageMemory first, so the id it is asked
// about is there). A close on an unmounted page is also taken off the list
// here at once, so the sidebar doesn't keep showing it until the page mounts.

const lists = new Map();      // route → { items, activeId }
const handlers = new Map();   // route → { onSelect, onClose }
const pending = new Map();    // route → [{ type, id }]
const listeners = new Set();

// SIMULATED items (Debug → "Simulate items in the Legislation list"): sample
// entries added after each tab's real ones, so the sidebar's dropdown can be
// looked at without opening anything. Their ids start `sim:`; selecting one
// only marks it active, closing one only drops it — no tab is asked.
const SIM_KEY = 'docvex:debug:simulate-workspace';
const SIM_SAMPLE = {
  '/legislation': [
    { id: 'sim:l1', kind: 'Lege', title: 'nr. 287/2009' },
    { id: 'sim:l2', kind: 'Ordonanță de urgență', title: 'nr. 195/2002' },
    { id: 'sim:l3', kind: 'Hotărâre', title: 'nr. 1383/2022' },
  ],
  '/caen': [
    { id: 'sim:c1', kind: 'Clasa CAEN', title: '6210' },
    { id: 'sim:c2', kind: 'Clasa CAEN', title: '4711' },
  ],
  '/portal-just': [
    { id: 'sim:p1', kind: 'Dosar', title: '1234/3/2026' },
  ],
  '/anaf': [
    { id: 'sim:a1', kind: 'CUI 14399840', title: 'Exemplu SRL' },
    { id: 'sim:a2', kind: 'CUI 6859662', title: 'Model Construct SA' },
  ],
};
let simOn = (() => { try { return localStorage.getItem(SIM_KEY) === '1'; } catch { return false; } })();
let sim = {};                 // route → { items, activeId } while simulating
const resetSim = () => {
  sim = Object.fromEntries(Object.entries(SIM_SAMPLE).map(([r, items]) => [r, { items: items.map((t) => ({ ...t, tip: `${t.kind} ${t.title} (simulated)` })), activeId: null }]));
};
if (simOn) resetSim();

let snapshot = {};
const buildSnapshot = () => {
  const out = Object.fromEntries(lists);
  if (simOn) {
    for (const [route, s] of Object.entries(sim)) {
      const real = out[route] || { items: [], activeId: null };
      out[route] = { items: [...real.items, ...s.items], activeId: s.activeId || real.activeId };
    }
  }
  return out;
};
const emit = () => {
  snapshot = buildSnapshot();
  listeners.forEach((fn) => fn());
};

/** Debug: add (or take away) the sample items. Kept per device. */
export function setWorkspaceSimulation(on) {
  simOn = !!on;
  try { localStorage.setItem(SIM_KEY, simOn ? '1' : '0'); } catch { /* ignore */ }
  if (simOn) resetSim(); else sim = {};
  emit();
}
export const workspaceSimulation = () => simOn;

const sameItems = (a, b) => a.length === b.length
  && a.every((x, i) => x.id === b[i].id && x.kind === b[i].kind && x.title === b[i].title && x.tip === b[i].tip && x.href === b[i].href);

/** A tab's current list. Cheap when nothing changed (no emit). */
export function publishWorkspace(route, { items = [], activeId = null }) {
  const prev = lists.get(route);
  if (prev && prev.activeId === activeId && sameItems(prev.items, items)) return;
  lists.set(route, { items: items.map(({ id, kind, title, tip, href }) => ({ id, kind, title, tip, href })), activeId });
  emit();
}

/** While a tab is mounted, how it answers the sidebar. Returns the unregister. */
export function registerWorkspace(route, h) {
  handlers.set(route, h);
  const queued = pending.get(route);
  if (queued?.length) {
    pending.delete(route);
    for (const r of queued) (r.type === 'close' ? h.onClose : h.onSelect)?.(r.id);
  }
  return () => { if (handlers.get(route) === h) handlers.delete(route); };
}

/** Ask a tab to open / close one of its items; `true` if it answered now. */
export function requestWorkspace(route, type, id) {
  if (String(id).startsWith('sim:')) {
    const cur = sim[route];
    if (!cur) return true;
    sim[route] = type === 'close'
      ? { items: cur.items.filter((t) => t.id !== id), activeId: cur.activeId === id ? null : cur.activeId }
      : { ...cur, activeId: id };
    emit();
    return true;
  }
  // A real item picked: a simulated one stops being the active one there.
  if (type === 'select' && sim[route]?.activeId) { sim[route] = { ...sim[route], activeId: null }; emit(); }
  const h = handlers.get(route);
  if (h) { (type === 'close' ? h.onClose : h.onSelect)?.(id); return true; }
  pending.set(route, [...(pending.get(route) || []).filter((r) => r.id !== id || r.type !== type), { type, id }]);
  if (type === 'close') {
    const cur = lists.get(route);
    if (cur) {
      lists.set(route, { items: cur.items.filter((t) => t.id !== id), activeId: cur.activeId === id ? null : cur.activeId });
      emit();
    }
  }
  return false;
}

export function subscribeWorkspaces(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** `{ [route]: { items, activeId } }` — stable between changes (useSyncExternalStore). */
export const workspacesSnapshot = () => snapshot;
if (simOn) snapshot = buildSnapshot();
