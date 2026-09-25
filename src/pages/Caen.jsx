import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { recallPage, usePageMemory } from '../lib/pageMemory';
import './Caen.css';
import PageMasthead from '../components/PageMasthead';
import LegalTabs, { DiceGlyph } from '../components/LegalTabs';
import Tooltip from '../components/Tooltip';
import CaenPicker, { CaenPickerHints } from './CaenPicker';
import CaenCard, { codeLabel } from '../components/CaenCard';
import HistoryButton from '../components/HistoryMenu';
import { logHistory } from '../lib/tabHistory';
import { miniHeaderSpot } from '../lib/miniHeaderSpot';
import {
  loadCaenRev, caenEntry, caenChildren, searchCaen, normCode, sentenceCase, LEVEL_LABEL, REVS_ALL,
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

// Two views of the same nomenclature: the list (tree + entry card) and the
// letter picker (pages/CaenPicker). Remembered per device.
const VIEW_KEY = 'docvex:caen:view';
const VIEWS = [{ id: 'list', label: 'List' }, { id: 'picker', label: 'Picker' }];
const loadView = () => { try { return localStorage.getItem(VIEW_KEY) === 'picker' ? 'picker' : 'list'; } catch { return 'list'; } };
const saveView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };

// Which revision the page reads — each a whole tree (lib/caen: Rev. 3, the
// law since 2025; Rev. 2, 2008–2024; Rev. 1, 2003–2007), read alike by the
// tree, the picker and the card — or all three at once, where the search
// answers from every one and the tree and the picker walk Rev. 3. Remembered
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


export default function Caen() {
  // The trees loaded so far, by revision; the one the page reads is `data`.
  const [trees, setTrees] = useState({});
  const [loadError, setLoadError] = useState(false);
  const [params, setParams] = useSearchParams();
  // What the page had on it when it was last left (lib/pageMemory): the
  // words typed, the picker's preview and the code on the URL — a route
  // change drops `?code=`, so it is put back on the first render here.
  const saved = recallPage('caen');
  const [query, setQuery] = useState(saved?.query || '');
  const [view, setViewState] = useState(loadView);
  const setView = (v) => { setViewState(v); saveView(v); };
  const [rev, setRevState] = useState(loadRev);
  const setRev = (v) => { setRevState(v); saveRev(v); };
  // The entry under the picker's cursor — its card shows under the picker
  // live, for every level, without a pick (a pick still sets `?code=`).
  const [previewCode, setPreviewCode] = useState(saved?.previewCode || '');
  const pickerRef = useRef(null);
  const pageRef = useRef(null);
  const restoredCode = useRef(false);
  useEffect(() => {
    if (restoredCode.current) return;
    restoredCode.current = true;
    if (!params.get('code') && saved?.code) {
      const next = { code: saved.code };
      if (saved.rev) next.rev = saved.rev;
      setParams(next, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const remembered = useMemo(
    () => ({ query, previewCode, code: params.get('code') || '', rev: params.get('rev') || '' }),
    [query, previewCode, params],
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
    const wanted = rev === 'all' ? REVS_ALL : [...new Set([activeRev, selectedRev, 3])];
    for (const r of wanted) {
      if (trees[r]) continue;
      loadCaenRev(r)
        .then((t) => { if (live) setTrees((prev) => (prev[r] ? prev : { ...prev, [r]: t })); })
        .catch(() => { if (live) setLoadError(true); });
    }
    return () => { live = false; };
  }, [rev, activeRev, selectedRev]); // eslint-disable-line react-hooks/exhaustive-deps

  // `r` is the revision the code belongs to; left out, it is the tree on show.
  const select = useCallback((code, r) => {
    const next = { code: normCode(code) };
    const rr = r || activeRev;
    if (rr === 1 || rr === 2) next.rev = String(rr);
    setParams(next, { replace: false });
    detailRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    // The tab's history: the code opened, with its name and revision.
    const it = trees[rr]?.items?.[normCode(code)];
    logHistory('caen', { kind: 'open', label: normCode(code), detail: `${it?.n || ''}${rr !== 3 ? ` · Rev. ${rr}` : ''}`.replace(/^ · /, ''), data: { code: normCode(code), rev: rr }, dedupe: `o:${rr}:${normCode(code)}` });
  }, [setParams, activeRev, trees]);

  // The card under the picker follows the picker's cursor; a new tree starts
  // it afresh.
  useEffect(() => { setPreviewCode(''); }, [activeRev]);

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

  return (
    <div className={`cn-page${view === 'picker' ? ' is-picker' : ''}`} ref={pageRef}>
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
      {/* The Legislation tab bar — shared with the Newsletter and the portal;
          the search sits in it: the list's, in list view; in picker view a
          typed code takes the picker to it. The view switch — the list, or
          the letter picker — stands at the bar's right end, past the
          divider after the search. */}
      <LegalTabs
        search={{
          value: query,
          placeholder: 'A code or an activity',
          onChange: (v) => {
            setQuery(v);
            if (view === 'picker' && /^\d{2,4}$|^[A-Va-v]$/.test(v.trim())) pickerRef.current?.goTo(v.trim().toUpperCase());
          },
        }}
        // History — this tab's log (components/HistoryMenu): every code
        // opened; picking one opens it again (the picker walks to it).
        trailing={(
          <HistoryButton
            tab="caen"
            tip="Every code opened, with the time"
            emptyText="Nothing yet. Every code you open is listed here."
            onPick={(e) => {
              const d = e.data || {};
              if (!d.code) return;
              if (d.rev && d.rev !== rev && rev !== 'all') setRev(d.rev);
              if (view === 'picker' && (d.rev || 3) === activeRev) pickerRef.current?.goTo(d.code); else select(d.code, d.rev);
            }}
          />
        )}
        tools={(
          <>
            {/* The dice: a random class of the revision on show — the list
                opens its card, the picker walks to it. */}
            <Tooltip content="A random class">
              <button
                type="button"
                className="lgt-dice"
                aria-label="Open a random class"
                disabled={!data}
                onClick={() => {
                  const classes = Object.keys(data?.items || {}).filter((k) => data.items[k].l === 'c');
                  if (!classes.length) return;
                  const code = classes[Math.floor(Math.random() * classes.length)];
                  if (view === 'picker') pickerRef.current?.goTo(code); else select(code);
                }}
              >
                {DiceGlyph}
              </button>
            </Tooltip>
            <div className="lgt-toggle" role="tablist" aria-label="View">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  aria-selected={view === v.id}
                  className={`lgt-toggle-btn${view === v.id ? ' is-on' : ''}`}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {/* The revision — beside the view switch. */}
            <div className="lgt-toggle" role="tablist" aria-label="Revision">
              {REVS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  aria-selected={rev === r.id}
                  className={`lgt-toggle-btn${rev === r.id ? ' is-on' : ''}`}
                  onClick={() => setRev(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </>
        )}
      />

      {loadError ? (
        <p className="cn-note is-bad">The nomenclature could not be loaded.</p>
      ) : !data ? (
        <p className="cn-note">Loading…</p>
      ) : view === 'picker' ? (
        // The letter picker, holding the card of the entry under its cursor
        // — section, division, group or class — live, beside its columns; a
        // pick selects the code (the same `?code=` the list view reads).
        // Above both, the entry's ancestors as pills (the card's own
        // breadcrumbs are off here), each taking the picker to that stage.
        <>
          <Trail data={data} code={previewCode || (selectedRev === activeRev && selected) || data.sections[0]} onGo={(c) => pickerRef.current?.goTo(c)} />
          <CaenPicker key={activeRev} ref={pickerRef} data={data} onPick={(code) => select(code)} onHighlight={setPreviewCode}>
            <main className="cn-detail" ref={detailRef}>
              <CaenCard
                trees={trees}
                code={previewCode || (selectedRev === activeRev && selected) || data.sections[0]}
                rev={previewCode || selectedRev !== activeRev ? activeRev : selectedRev}
                // A code pressed in the card (a child in "N divisions in it",
                // a former Rev. 2 code, a code in the notes) TAKES THE PICKER
                // THERE — the card follows the picker's cursor, so setting
                // the URL alone changed nothing on screen. A Rev. 2 code has
                // no place in the picker and opens as the list would open it.
                onPick={(code, r) => { if (r && r !== activeRev) select(code, r); else pickerRef.current?.goTo(code); }}
                crumbs={false}
                head={false}
              />
            </main>
          </CaenPicker>
          {/* The keys, in a footer — the Files tab's bottom bar, to the
              letter: a rounded floating section docked a chrome-inset above
              the window's bottom edge while the page scrolls behind it. */}
          <div className="cn-bottombar mini-glow" onMouseMove={miniHeaderSpot}>
            <CaenPickerHints atClass={data.items[previewCode || (selectedRev === activeRev && selected)]?.l === 'c'} />
          </div>
        </>
      ) : (
        <div className="cn-body">
          <aside className="cn-side">
            {/* The search box is in the tab bar above (LegalTabs). */}
            {results ? (
              <SearchResults results={results} selected={selected} selectedRev={selectedRev} onPick={select} />
            ) : (
              <Tree data={data} selected={selected} selectedRev={selectedRev} onPick={select} />
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
      )}
    </div>
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

// The entry's ancestors as pills, above the picker section — each a button
// that takes the picker to that stage.
function Trail({ data, code, onGo }) {
  const entry = caenEntry(data, code);
  const path = entry ? [...entry.path, { code: entry.code, level: entry.level, name: entry.name }] : [];
  if (!path.length) return null;
  return (
    <nav className="cn-trail" aria-label="Where this code sits">
      {path.map((p, i) => (
        <React.Fragment key={p.code}>
          {i ? <span className="cn-trail-sep" aria-hidden="true">›</span> : null}
          <button
            type="button"
            className={`cn-pill${i === path.length - 1 ? ' is-live' : ''}`}
            onClick={() => onGo(p.code)}
          >
            <span className="cn-pill-kind">{LEVEL_LABEL[p.level]}</span>
            <span className="cn-pill-code">{p.code}</span>
            <span className="cn-pill-name">{sentenceCase(p.name)}</span>
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
}
