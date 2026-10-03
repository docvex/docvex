// THE ONE LIST of the Legislation entry (2026-10-03) — every search kept, on
// every tab, in one place. What a SOURCE tab opens (an act, a court file, a
// company, a CAEN code) becomes an ENTRY of Research's chat store
// (lib/researchChats) beside the chats: `{ id: 'src:<href>', source: { route,
// href, kind, title, tip }, messages: [] }`. So it is kept per user AND
// project, saved through restarts, merged across windows, synced with the
// project's private bundle — and drawn in the same order, by the same rows,
// in the tab's sidebar (components/AskRail) and the app sidebar's dropdown.
//
// `href` is the item's own address on its tab (`/anaf?cui=…`,
// `/legislation?tip&nr&an&open=1`, `/portal-just?nr=…`,
// `/caen?code=…&rev=…&open=1`): it is the entry's identity, and how the item
// is opened again when its page no longer has it (after a restart, after a
// project switch). Opening an entry whose page still has the item just
// selects it there.

import { researchStore } from './researchChats';
import { requestWorkspace, workspacesSnapshot, subscribeWorkspaces } from './workspaceItems';

export const entryIdFor = (href) => `src:${href}`;
export const isSourceEntry = (t) => !!t?.source;

// What each route has published since the list was bound — so switching
// project does not pour the previous project's open items into the new list:
// only items opened AFTER the bind become entries.
let boundKey = null;
const known = new Map();   // route → Set(href)

function seed() {
  known.clear();
  const lists = workspacesSnapshot() || {};
  for (const [route, l] of Object.entries(lists)) {
    known.set(route, new Set((l?.items || []).map((it) => it.href).filter(Boolean)));
  }
}
researchStore.subscribe(() => {
  const key = researchStore.getState().key;
  if (key !== boundKey) { boundKey = key; seed(); }
});

/** A source page's items → entries (called on every publish; cheap). */
export function syncSourceItems(route, items) {
  const st = researchStore.getState();
  if (!st.key) return;
  if (st.key !== boundKey) { boundKey = st.key; seed(); return; }
  // Seen before = published last time; an item closed and opened again is new.
  const seen = known.get(route) || new Set();
  const current = new Set();
  const fresh = [];
  const changed = new Map();
  for (const it of items || []) {
    if (!it?.href) continue;
    const id = entryIdFor(it.href);
    const cur = st.threads.find((t) => t.id === id);
    if (cur) {
      const s = cur.source || {};
      if ((it.title && s.title !== it.title) || (it.kind && s.kind !== it.kind) || (it.tip && s.tip !== it.tip)) changed.set(id, it);
    } else if (!seen.has(it.href)) {
      fresh.push(it);
    }
    current.add(it.href);
  }
  known.set(route, current);
  if (!fresh.length && !changed.size) return;
  const now = Date.now();
  researchStore.setChats((ts) => {
    const next = ts.map((t) => {
      const it = changed.get(t.id);
      if (!it) return t;
      return { ...t, title: it.title || t.title, source: { ...t.source, kind: it.kind || t.source.kind, title: it.title || t.source.title, tip: it.tip || t.source.tip }, updatedAt: now };
    });
    for (const it of fresh) {
      if (next.some((t) => t.id === entryIdFor(it.href))) continue;
      next.push({
        id: entryIdFor(it.href),
        title: it.title || it.kind || it.href,
        messages: [],
        createdAt: now,
        updatedAt: now,
        source: { route, href: it.href, kind: it.kind || '', title: it.title || '', tip: it.tip || '' },
      });
    }
    return next;
  });
}

// The page's item for an entry (by its href), or null.
function pageItem(t, lists = workspacesSnapshot()) {
  const l = lists?.[t.source.route];
  const it = l?.items?.find((x) => x.href === t.source.href);
  return it ? { list: l, item: it } : null;
}

/** Is the entry the item on show? */
export function isEntryActive(t, pathname, lists = workspacesSnapshot()) {
  if (!isSourceEntry(t) || pathname !== t.source.route) return false;
  const hit = pageItem(t, lists);
  return !!hit && hit.list.activeId === hit.item.id;
}

/** Open an entry: select it on its page, or open its address afresh. */
export function openEntry(t, navigate, pathname) {
  if (!isSourceEntry(t)) return;
  const { route, href } = t.source;
  const hit = pageItem(t);
  if (hit) {
    if (pathname !== route) navigate(route);
    requestWorkspace(route, 'select', hit.item.id);
    return;
  }
  // The `_` nonce makes the page treat it as a new arrival every time.
  navigate(`${href}${href.includes('?') ? '&' : '?'}_=${Date.now()}`);
}

/** Close an entry, and the item on its page with it. */
export function closeEntry(t) {
  if (!isSourceEntry(t)) return;
  const hit = pageItem(t);
  if (hit) requestWorkspace(t.source.route, 'close', hit.item.id);
  researchStore.close(t.id);
}

export { subscribeWorkspaces, workspacesSnapshot };
