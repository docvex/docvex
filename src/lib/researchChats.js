// RESEARCH'S CHATS AS TABS — the Advisor's chat store (lib/advisorChats
// `createChatStore`) for the Research page, so the page's rail and the APP
// SIDEBAR's Research dropdown read one list and behave as the Advisor's do.
// THE CHATS BELONG TO THE PROJECT (2026-10-03, at the user's request — they
// are part of its work): kept per user AND project,
// `docvex.research.v1.<user>.<project id>` (`.none` with no project
// selected), and synced with the project's private data bundle like the
// Advisor's chats were (lib/projectSyncData). The list they used to be kept
// in, per user only (`.all`), is MOVED into the first project bound after
// this change (merged, never over what is there) — nothing is lost.
import { createChatStore, mergeThreads } from './advisorChats';
import { secureStorage, isSecureStoreReady, whenSecureStoreReady, secureStoreUser } from './secureStore';
import { pageMeta, platformOfRoute } from './legalBrowser';

// WHAT A CHAT IS (2026-09-28), for the app sidebar and the page's rail. A
// chat that holds a DIRECT SEARCH (a fixed answer — the portal's own) is drawn
// as the Legislation tab drew its tabs — the platform's source address in its
// colour, the item's kind, the item's name — from its latest direct search,
// AND STAYS SO while the AI conversation after it is still about that item.
// It turns into an AI conversation (the ACCENT — null here) when there is no
// direct search, or when a later question names ANOTHER item: an identifier
// (a number/year, a court file number, a CUI, a CAEN code) the search did not
// hold. Light patterns, on purpose: lib/lawRefs must stay out of the
// sidebar's startup bundle.
const IDS = /\b\d{1,6}\s*\/\s*\d{1,4}(?:\s*\/\s*\d{2,4})*\b|\b(?:RO)?\d{4,10}\b/gi;
const idsIn = (text) => new Set((String(text || '').match(IDS) || []).map((x) => x.replace(/\s+/g, '').replace(/^RO/i, '')));

function describeResearch(t) {
  // An item a source tab opened (lib/legislationEntries): drawn as that
  // platform's tab — its address in its colour, the item's kind, its name.
  if (t?.source) {
    const pl = platformOfRoute(t.source.route) || null;
    return {
      tone: pl?.tone || 'var(--text-secondary)',
      siteName: pl?.site || '',
      ownKind: t.source.kind || '',
      title: t.source.title || t.title,
      direct: true,
      source: true,
    };
  }
  const msgs = t?.messages || [];
  let at = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) { if (msgs[i].fixed && !msgs[i].isError) { at = i; break; } }
  if (at < 0) return null;
  const fixed = msgs[at];
  const legal = fixed.legal || {};
  const pl = platformOfRoute(legal.direct?.route) || null;
  const row = (pl && legal.answers?.[pl.id]?.rows?.[0]) || null;
  const page = row?.page || (legal.direct?.type === 'item' ? legal.direct : null);
  // Still about that item? Every identifier asked about since must be its own.
  const own = idsIn(`${fixed.q || legal.q || ''} ${page?.title || ''} ${page?.addr || ''} ${row?.title || ''}`);
  for (const m of msgs.slice(at + 1)) {
    if (m.who !== 'me') continue;
    for (const id of idsIn(m.text)) if (!own.has(id)) return null;
  }
  if (page) {
    const m = pageMeta(page);
    return { tone: m.tone, siteName: m.siteName || pl?.site || '', ownKind: m.ownKind || '', title: page.title || t.title, direct: true };
  }
  return { tone: pl?.tone || 'var(--text-secondary)', siteName: pl?.site || legal.site || '', ownKind: '', title: t.title, direct: true };
}

export const RESEARCH_PREFIX = 'docvex.research.v1.';
const LEGACY_SCOPE = 'all';
export const researchScope = (projectId) => (projectId ? String(projectId) : 'none');
export const researchStore = createChatStore({
  prefix: RESEARCH_PREFIX,
  activePrefix: 'docvex.research.active.v1.',
  label: 'Research',
  describe: describeResearch,
});

// The per-user list of before → this project's list, once.
function moveLegacy(user, scope) {
  if (!user || user === '_anonymous' || scope === 'none' || !isSecureStoreReady()) return false;
  if (secureStoreUser() !== user) return false;
  const from = `${RESEARCH_PREFIX}${user}.${LEGACY_SCOPE}`;
  const raw = secureStorage.getItem(from);
  if (raw == null) return false;
  let old = [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) old = v.filter((t) => t && t.id); } catch { return false; }
  const to = `${RESEARCH_PREFIX}${user}.${scope}`;
  if (old.length) {
    let cur = [];
    try { const v = JSON.parse(secureStorage.getItem(to) || '[]'); if (Array.isArray(v)) cur = v.filter((t) => t && t.id); } catch { cur = []; }
    secureStorage.setItem(to, JSON.stringify(mergeThreads(cur, old)));
  }
  secureStorage.removeItem(from);
  return true;
}

/** Bind Research's chats to this user's project (the page and the sidebar). */
export function bindResearch(user, projectId) {
  const u = user || '_anonymous';
  const scope = researchScope(projectId);
  const moved = moveLegacy(u, scope);
  researchStore.bind(u, scope);
  if (moved) researchStore.refresh();
  if (!isSecureStoreReady() && scope !== 'none') {
    void whenSecureStoreReady().then(() => {
      const st = researchStore.getState();
      if (st.key === `${u}.${scope}` && moveLegacy(u, scope)) researchStore.refresh();
    });
  }
}

// The Legislation source pages are gone (2026-10-03), so the items they put in
// this list (`source` entries, once lib/legislationEntries) are closed —
// with their tombstones, so a merge or another window cannot bring them back.
let purging = false;
researchStore.subscribe(() => {
  if (purging) return;
  const gone = (researchStore.getState().threads || []).filter((t) => t?.source);
  if (!gone.length) return;
  purging = true;
  queueMicrotask(() => {
    try { for (const t of gone) researchStore.close(t.id); } finally { purging = false; }
  });
});
