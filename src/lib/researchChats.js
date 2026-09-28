// RESEARCH'S CHATS AS TABS — the Advisor's chat store (lib/advisorChats
// `createChatStore`) for the Research page, so the page's rail and the APP
// SIDEBAR's Research dropdown read one list and behave as the Advisor's do.
// Research is not project work, so the chats are kept per USER
// (`docvex.research.v1.<user>.all`), whatever project is selected.
import { createChatStore } from './advisorChats';
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

export const RESEARCH_SCOPE = 'all';
export const researchStore = createChatStore({
  prefix: 'docvex.research.v1.',
  activePrefix: 'docvex.research.active.v1.',
  label: 'Research',
  describe: describeResearch,
});
