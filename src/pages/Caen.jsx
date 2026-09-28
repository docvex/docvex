import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { recallPage, usePageMemory } from '../lib/pageMemory';
import './Caen.css';
import PageMasthead from '../components/PageMasthead';
import { DiceGlyph, LegalSearchBox } from '../components/LegalTabs';
import { useTabSetting, tabKeyFor, useSearchTabs } from '../components/LegalOmnibox';
import LegalWorkspace, { WorkspaceSearch, WorkspaceClear, SourceStatus } from '../components/LegalWorkspace';
import Tooltip from '../components/Tooltip';
import CaenCard, { codeLabel } from '../components/CaenCard';
import { logHistory } from '../lib/tabHistory';
import { BarPicker } from '../components/LegalBar';
import { CaenOutline, CaenAtlas } from './CaenViews';
import {
  loadCaenRev, peekCaenTrees, peekCaenNotes, caenEntry, caenChildren, searchCaen, normCode, sentenceCase, REVS_ALL,
} from '../lib/caen';

// CAEN — the nomenclature of economic activities, in the app.
//
// A company's object of activity is written in CAEN codes: the articles of
// association, the trade-register extract, the recitals of half the contracts
// a firm signs. Until now a code in a document was a number to look up in a
// browser. This page is the nomenclature itself — the National Institute of
// Statistics' own structure and explanatory notes, bundled with the app so it
// answers offline (lib/caen.js, built by scripts/build-caen.mjs).
//
// It is Rev. 3 first, because that is the law since 1 January 2025 — but it
// never pretends Rev. 2 is gone: every document older than that cites it, and a
// number that meant one activity then can mean another now (or nothing). So a
// Rev. 2 code can be opened as what it WAS, with where it went, and a Rev. 3
// code whose number meant something else in Rev. 2 says so on its face.
//
// Reached from the sidebar, and from the Doc Viewer: a paragraph that cites a
// code lists it with its name, and "Read here" opens it on this page
// (`/caen?code=4100`, `&rev=2` for an old one).

const ChevronIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

// Which revision the page reads — each a whole tree (lib/caen: Rev. 3, the
// law since 2025; Rev. 2, 2008–2024; Rev. 1, 2003–2007), read alike by the
// tree and the card — or all three at once, where the search answers from
// every one and the tree walks Rev. 3. Remembered
// per device.
const REV_KEY = 'docvex:caen:rev';
const REVS = [
  { id: 1, label: 'Rev. 1' },
  { id: 2, label: 'Rev. 2' },
  { id: 3, label: 'Rev. 3' },
  { id: 'all', label: 'All revs' },
];
const loadRev = () => { try { const v = localStorage.getItem(REV_KEY); return v === '1' ? 1 : v === '2' ? 2 : v === 'all' ? 'all' : 3; } catch { return 3; } };
const revOf = (v) => (v === '1' ? 1 : v === '2' ? 2 : 3);
const saveRev = (v) => { try { localStorage.setItem(REV_KEY, String(v)); } catch { /* storage unavailable */ } };

// How the tree is read (pages/CaenViews): the LIST (search + tree + card),
// the OUTLINE (a section rail and the section as a table of contents) or the
// ATLAS (the sections as tiles, the divisions as cards). Remembered per device.
const VIEW_KEY = 'docvex:caen:layout';
const VIEWS = [
  { id: 'list', label: 'List' },
  { id: 'outline', label: 'Outline' },
  { id: 'atlas', label: 'Atlas' },
];
const loadView = () => { try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.some((x) => x.id === v) ? v : 'list'; } catch { return 'list'; } };
const saveView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };


export default function Caen() {
  // The trees loaded so far, by revision; the one the page reads is `data`.
  const [trees, setTrees] = useState(peekCaenTrees);
  const [loadError, setLoadError] = useState(false);
  const [params, setParams] = useSearchParams();
  // What the page had on it when it was last left (lib/pageMemory): the
  // words typed and the code on the URL — a route
  // change drops `?code=`, so it is put back on the first render here.
  const saved = recallPage('caen');
  const [query, setQuery] = useState(saved?.query || '');
  // View and Revision belong to the TAB they are set in (the open class, the
  // search tab, the page's own search) — not to the whole page.
  const [opened, setOpened] = useState(saved?.opened || []);        // [{ id, code, rev }]
  const [activeCode, setActiveCode] = useState(saved?.activeCode ?? null);
  useSearchTabs();
  const tabKey = tabKeyFor('/caen', activeCode);
  const [rev, setRev] = useTabSetting(tabKey, 'rev', 3);
  const [view, setView] = useTabSetting(tabKey, 'view', 'list');
  // The CLASSES opened, one rail item each (components/LegalWorkspace), and
  // the one on show — null = the search / browse view (the tree).
  // Browsing — a section, a division, a group — stays in that view; a class
  // is where browsing ends, and opens as an item of its own.
  const shown = opened.find((o) => o.id === activeCode) || null;
  const pageRef = useRef(null);
  const restoredCode = useRef(false);
  useEffect(() => {
    if (restoredCode.current) return;
    restoredCode.current = true;
    if (!params.get('code') && saved?.code) {
      const next = { code: saved.code };
      if (saved.rev) next.rev = saved.rev;
      // The page's OWN address write (`internal`): the tabs must not read
      // it as a link arriving — that opened a new page in the tab and
      // re-opened the code on every entry into the tab.
      setParams(next, { replace: true, state: { internal: true } });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const remembered = useMemo(
    () => ({ query, code: params.get('code') || '', rev: params.get('rev') || '', opened, activeCode }),
    [query, params, opened, activeCode],
  );
  usePageMemory('caen', remembered, pageRef);
  const detailRef = useRef(null);

  const selected = normCode(params.get('code') || '');
  const selectedRev = revOf(params.get('rev'));
  // The tree the page reads: the chosen revision's; under 'All revs', Rev. 3's.
  const activeRev = rev === 'all' ? 3 : rev;
  const data = trees[activeRev] || null;

  // Load what the choice needs: the active tree, the selected code's, and —
  // under 'All revs' — every one. Each is fetched once and kept.
  useEffect(() => {
    let live = true;
    const wanted = rev === 'all' ? REVS_ALL : [...new Set([activeRev, selectedRev, shown?.rev || 3, 3])];
    for (const r of wanted) {
      if (trees[r]) continue;
      loadCaenRev(r)
        .then((t) => { if (live) setTrees((prev) => (prev[r] ? prev : { ...prev, [r]: t })); })
        .catch(() => { if (live) setLoadError(true); });
    }
    return () => { live = false; };
  }, [rev, activeRev, selectedRev, shown?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // `r` is the revision the code belongs to; left out, it is the tree on show.
  const select = useCallback((code, r) => {
    const next = { code: normCode(code) };
    const rr = r || activeRev;
    if (rr === 1 || rr === 2) next.rev = String(rr);
    setParams(next, { replace: false, state: { internal: true } });
    detailRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    // The tab's history: the code opened, with its name and revision.
    const it = trees[rr]?.items?.[normCode(code)];
    logHistory('caen', { kind: 'open', label: normCode(code), detail: `${it?.n || ''}${rr !== 3 ? ` · Rev. ${rr}` : ''}`.replace(/^ · /, ''), data: { code: normCode(code), rev: rr }, dedupe: `o:${rr}:${normCode(code)}` });
  }, [setParams, activeRev, trees]);

  // Opening a CLASS: selected as ever (the tree follows it)
  // and put in the rail — the one already there is switched to. Anything
  // above a class is browsed, in the search view.
  const openCode = useCallback((code, r) => {
    const c = normCode(code);
    const rr = r || activeRev;
    const level = trees[rr]?.items?.[c]?.l;
    select(c, rr);
    if (level && level !== 'c') { setActiveCode(null); return; }
    const id = `${rr}:${c}`;
    setOpened((list) => (list.some((o) => o.id === id) ? list : [...list, { id, code: c, rev: rr }]));
    setActiveCode(id);
  }, [select, activeRev, trees]);


  // From the Legislation tab's one search (lib/legalOmni): `?q=` is words to
  // look for here, `?code=…&open=1` a code to open — a class as an item of
  // its own, anything above it selected in the tree. Waits for the tree the
  // code belongs to, since what it is decides how it opens.
  useEffect(() => {
    if (!params.get('_')) return;
    const q = params.get('q');
    if (q != null) { setQuery(q); setActiveCode(null); setParams({}, { replace: true }); return; }
    const code = params.get('code');
    if (params.get('open') !== '1' || !code) return;
    const r = revOf(params.get('rev'));
    if (!trees[r]) return;
    if (r !== activeRev && rev !== 'all') setRev(r);
    setQuery('');
    openCode(code, r);
  }, [params, trees]); // eslint-disable-line react-hooks/exhaustive-deps

  // Under 'All revs' every loaded tree answers, newest first, each hit tagged
  // with its revision.
  const results = useMemo(() => {
    if (!data || !query.trim()) return null;
    if (rev !== 'all') return searchCaen(data, query);
    return [3, 2, 1].flatMap((r) => (trees[r] ? searchCaen(trees[r], query, { limit: 60 }) : []));
  }, [data, trees, rev, query]);

  const counts = useMemo(() => {
    const c = { s: 0, d: 0, g: 0, c: 0 };
    for (const it of Object.values(data?.items || {})) c[it.l] += 1;
    return c;
  }, [data]);

  // THE SEARCH, drawn as every source tab draws it (WorkspaceSearch): the
  // words box — a code or the words of an activity: the
  // start screen until something is typed or picked, one compact row after.
  const wordsBox = (
    <LegalSearchBox
      className="lg-words"
      search={{
        value: query,
        placeholder: 'A code or an activity',
        onChange: (v) => {
          setQuery(v);
          setActiveCode(null);
        },
      }}
    />
  );
  const searchView = (
    <WorkspaceSearch
      asked={!!query.trim() || !!selected}
      title="Find a CAEN code"
      sub="Search the nomenclature by a code or by the words of an activity, or browse its sections below. Every class you open stays in the list on the left."
      modes={[
        { id: 'words', label: 'By code or activity', hint: 'A number (“6210”, “62”, “J”) or words (“software”). Pick a revision above for an older document.', node: wordsBox },
      ]}
      foot={(
        <WorkspaceClear
          tip="Clear the search"
          disabled={!query}
          onClick={() => setQuery('')}
        />
      )}
    />
  );

  // The page stands in the Legislation tabs' workspace: Search + History head
  // the bar's second line, every class opened is an item in the rail; the
  // search view is the tree and the card beside it.
  return (
    <LegalWorkspace
      className="cn-page"
      rootRef={pageRef}
      // The open code AS THE DATA HOLDS IT (the Source view): its entry in the
      // nomenclature bundled from the INS files (l = level, n = name, p =
      // parent), with the INS explanatory notes for Rev. 3.
      source={shown ? {
        site: 'insse.ro',
        service: `CAEN Rev. ${shown.rev || 3} — the INS nomenclature, bundled with DocVex`,
        data: {
          code: shown.code,
          ...(trees[shown.rev || 3]?.items?.[shown.code] || {}),
          ...((shown.rev || 3) === 3 && peekCaenNotes()?.[shown.code] ? { notes: peekCaenNotes()[shown.code] } : {}),
        },
      } : null}
      items={opened.map((o) => {
        const it = trees[o.rev]?.items?.[o.code];
        return {
          id: o.id,
          kind: `Rev. ${o.rev || 3}`,
          title: it?.n ? `${o.code} ${sentenceCase(it.n)}` : o.code,
          tip: it?.n ? `${o.code} — ${it.n}${o.rev !== 3 ? ` (Rev. ${o.rev})` : ''}` : o.code,
        };
      })}
      activeId={activeCode}
      onSelect={(id) => { const o = opened.find((x) => x.id === id); if (o) { select(o.code, o.rev); setActiveCode(id); } }}
      onClose={(id) => { setOpened((list) => list.filter((o) => o.id !== id)); if (id === activeCode) setActiveCode(null); }}
      onSearch={() => setActiveCode(null)}
      railLabel="Codes open in this tab"
      // History — this tab's log (components/HistoryMenu): every code
      // opened; picking one opens it again.
      history={{
        tab: 'caen',
        tip: 'Every code opened, with the time',
        emptyText: 'Nothing yet. Every code you open is listed here.',
        onPick: (e) => {
          const d = e.data || {};
          if (!d.code) return;
          if (d.rev && d.rev !== rev && rev !== 'all') setRev(d.rev);
          openCode(d.code, d.rev || 3);
        },
      }}
      masthead={(
        <PageMasthead
          eyebrow="Nomenclatorul CAEN"
          eyebrowMuted="source: insse.ro/cms/ro/caen"
          title="CAEN codes"
          compact={false}
          actions={data ? (
            <div className="cn-mast-meta">
              <div>
                <div className="cn-mast-num">{counts.c}</div>
                <div>Classes</div>
              </div>
              <span className="cn-mast-sep" />
              <div>
                <div className="cn-mast-num">{counts.s}</div>
                <div>Sections</div>
              </div>
            </div>
          ) : null}
        >
          The classification of economic activities a company’s object of activity is written in —
          every section, division, group and class of Rev. 3 with the National Institute of
          Statistics’ own notes, and where each Rev. 2 code went.
        </PageMasthead>
      )}
      // Typing in the search goes back to the search view.
      bar={{
        // No find in this tab: the words box is the search view's (below);
        // the dice stays here, the revision dropdown at the far right.
        noSearch: true,
        // Where it comes from: nothing is fetched — the INS nomenclature is
        // bundled with the app, so it is always here, offline included. The
        // pill says so and is the way out to the INS page.
        status: (
          <SourceStatus
            source="live"
            liveLabel="Bundled with the app · INS"
            href="https://insse.ro/cms/ro/caen"
            tip="Open the National Institute of Statistics’ CAEN page"
          />
        ),
        // The revision — a dropdown standing on its own, at the far RIGHT of
        // the bar's second line (LegalTabs' `trailing`, past the search).
        // Only on a tab that browses: an open class is read in its own
        // revision, and there is no tree to view another way.
        trailing: shown ? null : (
          <>
            <BarPicker
              solo
              label="View"
              options={VIEWS}
              value={view}
              onChange={setView}
            />
            <BarPicker
              solo
              label="Revision"
              options={REVS}
              value={rev}
              onChange={setRev}
            />
          </>
        ),
      }}
    >
      {loadError ? (
        <p className="cn-note is-bad">The nomenclature could not be loaded.</p>
      ) : !data ? (
        <p className="cn-note">Loading…</p>
      ) : shown ? (
        // ── One class open ───────────────────────────────────────────────
        // A code pressed in the card opens in its turn: a class as an item
        // of its own, anything above it back in the search view.
        <main className="cn-detail is-open" ref={detailRef}>
          <CaenCard trees={trees} code={shown.code} rev={shown.rev} onPick={openCode} />
        </main>
      ) : view === 'outline' || view === 'atlas' ? (
        // ── Outline / Atlas: the tree on show, read another way. A class
        // picked here is selected (the URL, the history), not opened as an
        // item — the card stands beside it.
        (() => {
          const tree = data;
          const r = tree.rev || activeRev;
          const sel = selectedRev === r ? selected : '';
          const pick = (c, rr) => select(c, rr || r);
          return view === 'outline'
            ? <CaenOutline data={tree} trees={trees} rev={r} selected={sel} onPick={pick} cardRef={detailRef} />
            : <CaenAtlas data={tree} trees={trees} rev={r} selected={sel} onPick={pick} onClose={() => setParams({}, { replace: false, state: { internal: true } })} />;
        })()
      ) : (
        <>
        {searchView}
        <div className="cn-body">
          <aside className="cn-side">
            {/* The search box is in the tab bar above (LegalTabs). */}
            {results ? (
              <SearchResults results={results} selected={selected} selectedRev={selectedRev} onPick={openCode} />
            ) : (
              <Tree data={data} selected={selected} selectedRev={selectedRev} onPick={openCode} />
            )}
          </aside>
          <main className="cn-detail" ref={detailRef}>
            {selected ? (
              <CaenCard trees={trees} code={selected} rev={selectedRev} onPick={select} />
            ) : (
              <div className="cn-empty">
                <p className="cn-empty-title">Pick a code</p>
                <p className="cn-empty-sub">
                  Search by number or by the words of an activity, or browse the sections on the left.
                  A number from an older document works too: pick its revision above, or “All revs”, and
                  it opens as what it was — and where it went.
                </p>
              </div>
            )}
          </main>
        </div>
        </>
      )}
    </LegalWorkspace>
  );
}

function SearchResults({ results, selected, selectedRev, onPick }) {
  if (!results.length) return <p className="cn-note">Nothing in the nomenclature matches that.</p>;
  return (
    <ul className="cn-list">
      {results.map((r) => {
        const on = r.code === selected && r.rev === selectedRev;
        return (
          <li key={`${r.rev}-${r.code}`}>
            <button type="button" className={`cn-row${on ? ' is-on' : ''}`} onClick={() => onPick(r.code, r.rev)}>
              <span className={`cn-row-code is-${r.level}`}>{codeLabel(r.code, r.level)}</span>
              <span className="cn-row-name">{r.name}</span>
              {r.rev !== 3 ? <span className="cn-tag is-old">Rev. {r.rev}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// The browse tree. Only the branch leading to the selected code is open — the
// whole nomenclature at once is a thousand rows nobody reads.
function Tree({ data, selected, selectedRev, onPick }) {
  const openPath = useMemo(() => {
    const e = selectedRev === (data.rev || 3) ? caenEntry(data, selected) : null;
    return new Set(e ? [...e.path.map((p) => p.code), e.code] : []);
  }, [data, selected, selectedRev]);

  const branch = (list, depth) => (
    <ul className="cn-list" style={{ '--depth': depth }}>
      {list.map((it) => {
        const open = openPath.has(it.code);
        const on = it.code === selected && selectedRev === (data.rev || 3);
        return (
          <li key={it.code}>
            <button type="button" className={`cn-row${on ? ' is-on' : ''}${open ? ' is-open' : ''}`} onClick={() => onPick(it.code, data.rev || 3)}>
              {it.level !== 'c' ? <span className="cn-chev">{ChevronIcon}</span> : <span className="cn-chev-pad" />}
              <span className={`cn-row-code is-${it.level}`}>{it.code}</span>
              <span className="cn-row-name">{it.name}</span>
            </button>
            {open && it.level !== 'c' ? branch(caenChildren(data, it.code), depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );
  const sections = data.sections.map((s) => ({ code: s, level: 's', name: data.items[s].n }));
  return <div className="cn-tree">{branch(sections, 0)}</div>;
}
