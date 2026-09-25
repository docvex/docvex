import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './Legislation.css';
import PageMasthead from '../components/PageMasthead';
import LegalTabs from '../components/LegalTabs';
import { LegalBar, BarDice, BarPicker, BarInput, BarGo } from '../components/LegalBar';
import Tooltip from '../components/Tooltip';
import CaenModal from '../components/CaenModal';
import { findFollowableRefs, lawRefDetails, lawRefLabel } from '../lib/lawRefs';
import { isElectron, openExternal } from '../lib/platform';
import { askProjectAi } from '../lib/projectAi';
import { recallPage, usePageMemory } from '../lib/pageMemory';
import { logSearch, logOpen } from '../lib/legislationHistory';
import HistoryButton, { BinIcon } from '../components/HistoryMenu';
import {
  LEGIS_TYPES, searchLegislation, searchLegislationPlain, loadAct, keepAct, listArchive, clearArchive, fetchActLive, sameAct,
  loadActPage, parseActHtml, actTreeStrings, legislationQueryFor,
  parseActText, parseBoxTable, parseBoxDiagram, diagramStrings, actHeading, actLabel, formatBytes, fold,
} from '../lib/legislation';

// Legislation — the national legislative portal, inside the app.
//
// legislatie.just.ro is where Romanian law actually lives, and until now
// reaching it meant leaving the app for a browser, losing the case you were
// reading and everything the app knows about it. This is the same body of law,
// through the portal's own free web service, laid out in DocVex's typography
// rather than the portal's: the point is not a copy of a website, it is the
// legislation where the work is.
//
// TWO THINGS MAKE IT MORE THAN A FRONT END.
//
// 1. It keeps what it reads. Every result is indexed on disk and every act that
//    is opened is saved whole, so the tab answers with the ministry's server
//    down, mid-flight, or on a train. That is not a nicety: a hearing does not
//    move because a portal is in maintenance. The answer always says which of
//    the two it came from — "live" or "from your copy" — because "no results"
//    means something very different offline.
// 2. It is honest about authority. The portal's consolidated text is not the
//    official one; only the Monitorul Oficial print is. The reader says so,
//    every time, rather than letting a lawyer quote a convenience copy.
//
// The model, the fallback and the on-disk archive are lib/legislation.js; the
// service itself is reached from the main process (it sends no CORS headers).

// ── Icons ────────────────────────────────────────────────────────────────
const KeepIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v11" /><path d="M8 10.5l4 3.5 4-3.5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);
const ExternalIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6" /><path d="M20 4l-8.5 8.5" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </svg>
);
const BackIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
const LibraryIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5h5v15H4z" /><path d="M10 5h4v15h-4z" /><path d="M15.5 5.6l4 1.2-3.6 13.4-4-1.2z" />
  </svg>
);
const KeptGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
const SyncGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 12a8 8 0 0 1-14.2 5" /><path d="M4 12a8 8 0 0 1 14.2-5" /><path d="M18 3v4h-4" /><path d="M6 21v-4h4" />
  </svg>
);
// The rail's glyphs: an act, the search, close.
const RailActIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" />
  </svg>
);
const RailSearchIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
  </svg>
);
const RailCloseIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const YEAR_NOW = new Date().getFullYear();
// The last archive listing, so the masthead's figures are right from the
// first paint on the next visit (they are refreshed on mount all the same).
let libraryCache = { acts: [], bytes: 0 };

// A search worth running: the service needs SOMETHING, and an empty form would
// ask it for the whole of Romanian law.
const hasQuery = (q) => !!(q.numar.trim() || q.an.trim() || q.titlu.trim());

// What a Romanian act about this would be called — up to three short phrases
// in the portal's own vocabulary, from the project AI. A JSON array back.
async function suggestTerms(words) {
  const prompt = 'A user is searching Romanian national legislation (legislatie.just.ro) and typed, in plain words: «' + words + '». '
    + 'Give up to 3 short Romanian phrases (2 to 5 words each) that the TITLE or TEXT of the acts they want would actually contain — legal terms as the law writes them, with diacritics, most likely first. '
    + 'Answer with a JSON array of strings only, nothing else.';
  const res = await askProjectAi({ messages: [{ role: 'user', content: prompt }], tools: false, model: 'claude-sonnet-4-6', usageAction: 'legislation-search' });
  const m = /\[[\s\S]*\]/.exec(res?.text || '');
  if (!m) return [];
  try { const arr = JSON.parse(m[0]); return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []; } catch { return []; }
}



// The Kind field is the shared BarPicker (components/LegalBar) over LEGIS_TYPES.

// The Kind of a history entry, as the form names it.
const kindLabel = (tip) => LEGIS_TYPES.find((t) => t.id === tip)?.label || '';

// ── A box-drawn diagram, as a chart ──
// The drawing read as boxes and lines (lib/legislation `parseBoxDiagram`)
// drawn as an SVG in DocVex's own idiom: each character cell is CW × CH
// px, a box is a rounded card at its cells (the corner cells' centres are
// its corners), a frame a dashed outline, a connector a muted stroke; a
// box's words are real HTML over it (a foreignObject), centred, so the
// find marks them like any other text. The whole chart scales down to the
// column's width and never up past its own size.
const DIAG_CW = 8;
const DIAG_CH = 17;
function BoxDiagram({ d, marked, counter }) {
  const W = d.w * DIAG_CW; const H = d.h * DIAG_CH;
  const cx = (x) => (x + 0.5) * DIAG_CW;
  const cy = (y) => (y + 0.5) * DIAG_CH;
  // Half-segments run from a cell's centre (x + 0.5) to its edge (x or
  // x + 1), so a coordinate is simply its value in cells times the cell.
  const hpath = d.hseg.map((s) => `M${s.x1 * DIAG_CW} ${cy(s.y)}H${s.x2 * DIAG_CW}`).join('');
  const vpath = d.vseg.map((s) => `M${cx(s.x)} ${s.y1 * DIAG_CH}V${s.y2 * DIAG_CH}`).join('');
  return (
    <div className="lg-diagram">
      <svg className="lg-diag" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: `${W}px` }} role="img" aria-label="Diagram">
        <path className="lg-diag-lines" d={hpath + vpath} />
        {d.boxes.map((b, i) => {
          const x = cx(b.x); const y = cy(b.y); const w = (b.x2 - b.x) * DIAG_CW; const h = (b.y2 - b.y) * DIAG_CH;
          return (
            <g key={i} className={`lg-diag-box${b.frame ? ' is-frame' : ''}`}>
              <rect x={x} y={y} width={w} height={h} rx={b.frame ? 7 : 5} />
              {b.lines.length ? (
                <foreignObject x={x} y={y} width={w} height={h}>
                  <div className="lg-diag-text" xmlns="http://www.w3.org/1999/xhtml">
                    {b.lines.map((l, k) => <span className="lg-diag-line" key={k}>{marked(l, counter)}</span>)}
                  </div>
                </foreignObject>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// One act as a row — a search result or a kept act alike: its kind, number
// and year, its title, then the issuer, the gazette, the date in force, and
// whether its text is kept here. Kept acts also get their forget button.
function ActRow({ r, kept, onOpen, onForget }) {
  return (
    <li className="lg-row">
      <button type="button" className="lg-row-main" onClick={() => onOpen(r)}>
        <span className="lg-row-kind">
          {r.tipAct}{r.numar ? ` nr. ${r.numar}` : ''}{r.year ? `/${r.year}` : ''}
        </span>
        <span className="lg-row-title">{r.title || r.titlu}</span>
        <span className="lg-row-meta">
          {r.emitent ? <span>{r.emitent}</span> : null}
          {r.publicatie ? <span>{r.publicatie}</span> : null}
          {r.dataVigoare ? <span>în vigoare {r.dataVigoare}</span> : null}
          {r.republished ? <span className="lg-tag">republicată</span> : null}
        </span>
      </button>
      {r.link ? (
        <Tooltip content="Open on the ministry’s portal">
          <button type="button" className="lg-icobtn" aria-label="Open on the portal" onClick={() => openExternal(r.link)}>
            {ExternalIcon}
          </button>
        </Tooltip>
      ) : null}
      {onForget ? (
        <Tooltip content="Forget this act on this machine">
          <button type="button" className="lg-icobtn" aria-label={`Forget ${actLabel(r)}`} onClick={() => onForget(r.id)}>
            {BinIcon}
          </button>
        </Tooltip>
      ) : null}
    </li>
  );
}

export default function Legislation() {
  // What the page had on it when it was last left (lib/pageMemory): the
  // form, the answer, the act being read and the find — back on return.
  const saved = recallPage('legislation');
  const [query, setQuery] = useState(saved?.query || { tip: '', numar: '', an: '', titlu: '', text: '' });
  // How the last search found its answer ('title' | 'text' | 'ai' | 'none') and
  // the phrases the AI tried — said in the strip.
  const [found, setFound] = useState(saved?.found ?? null);
  const [results, setResults] = useState(saved?.results ?? null);   // null = nothing asked yet
  const [source, setSource] = useState(saved?.source || '');       // 'live' | 'archive' — the last search's
  const [actSource, setActSource] = useState(saved?.actSource || '');  // the open act's own
  const [portalError, setPortalError] = useState(saved?.portalError || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [act, setAct] = useState(saved?.act ?? null);           // the act being read
  // Whether the kept act is what the PORTAL has now: 'same' | 'differs'
  // (with the portal's version in hand, to sync to) | '' (not known — not
  // kept, still being asked, or the portal unreachable).
  const [actSync, setActSync] = useState(saved?.actSync || { state: '', live: null });
  // The act's PAGE on the portal — its structure, which the act is laid
  // out from (`parseActHtml`); empty until fetched, and the plain text is
  // laid out instead (`parseActText`) until then or when it cannot be had.
  const [actHtml, setActHtml] = useState(saved?.actHtml || '');
  const pageSeq = useRef(0);
  const fetchPage = useCallback((rec, fresh) => {
    const mine = ++pageSeq.current;
    setActHtml('');
    loadActPage(rec, { fresh }).then((p) => { if (mine === pageSeq.current && p?.ok) setActHtml(p.html); }).catch(() => {});
  }, []);
  const [actBusy, setActBusy] = useState(false);
  const [actError, setActError] = useState('');
  // The archive's figures, kept across visits (a module-level copy): with
  // them in from the first paint the masthead does not grow as they arrive.
  const [library, setLibraryState] = useState(() => libraryCache);
  const setLibrary = useCallback((v) => { libraryCache = v; setLibraryState(v); }, []);
  const [find, setFind] = useState(saved?.find || '');           // the words looked for INSIDE the open act
  const [findAt, setFindAt] = useState(saved?.findAt || 0);        // which of their occurrences is current
  const readerRef = useRef(null);
  const pageRef = useRef(null);
  // The TABS — a rail down the page's left, like the Advisor's list of
  // chats: every act opened from the results (or History, or a citation
  // arriving from the Doc Viewer) starts a READING SESSION that stands in
  // the rail as an item; the active one's reading state is the live state
  // (act, its page, the find, the table switches, the scroll), the others
  // hold theirs as snapshots and get them back when pressed. A citation
  // followed INSIDE an act opens as a session of its own, the act it was
  // cited in staying open in its; an act already open in a session is
  // switched to, not opened twice. The rail shows once there is a session;
  // with none active the page is the search and its results, as it was.
  const [tabs, setTabs] = useState(saved?.tabs || []);
  const [activeTab, setActiveTabState] = useState(saved?.activeTab ?? null);
  const activeTabRef = useRef(activeTab);
  const setActiveTab = (id) => { activeTabRef.current = id; setActiveTabState(id); };
  const remembered = useMemo(
    () => ({ query, found, results, source, actSource, portalError, act, actSync, actHtml, find, findAt, tabs, activeTab }),
    [query, found, results, source, actSource, portalError, act, actSync, actHtml, find, findAt, tabs, activeTab],
  );
  usePageMemory('legislation', remembered, pageRef);
  const seq = useRef(0);
  // Arriving from a citation. A paragraph in the Doc Viewer lists the acts it
  // cites, and "Read here" sends the MAIN window to this tab with the citation
  // in the query — `?tip&nr&an&titlu&open=1` (built by `legislationHref`, so the
  // two ends cannot drift). The search runs itself, and with `open=1` the act
  // opens too when the answer is unambiguous: the reader pressed a citation,
  // not a search button, and being dropped on a result list to press again is
  // the app making them ask twice.
  const [params, setParams] = useSearchParams();
  const arrived = useRef('');
  const navigate = useNavigate();
  // A CAEN code pressed in the act — the nomenclature opens over the page
  // (components/CaenModal), searched on that code.
  const [caenModal, setCaenModal] = useState(null);
  const closeCaen = useCallback(() => setCaenModal(null), []);

  const set = (k) => (e) => setQuery((q) => ({ ...q, [k]: e.target.value }));

  const refreshLibrary = useCallback(async () => {
    const res = await listArchive();
    if (res?.ok) setLibrary({ acts: res.acts || [], bytes: res.bytes || 0 });
  }, []);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  const kept = useMemo(() => {
    const m = new Map();
    for (const a of library.acts) m.set(a.id, a);
    return m;
  }, [library.acts]);

  // Returns what it found, so an arrival from a citation can act on it; the
  // form ignores the answer and reads the state instead.
  const openRef = useRef(null);
  const runNow = useCallback(async (q) => {
    if (!hasQuery(q)) { setError('Give it a number, a year, or some words from the title.'); return null; }
    const mine = ++seq.current;
    setBusy(true); setError(''); setPortalError('');
    const res = await searchLegislationPlain({ tip: q.tip, numar: q.numar, an: q.an, words: q.titlu, perPage: 30 }, { ai: suggestTerms });
    if (mine !== seq.current) return null;
    setBusy(false);
    if (!res?.ok) { setError('Nothing could be searched — the portal is unreachable and this machine has no copy yet.'); setResults([]); return null; }
    setResults(res.records);
    setSource(res.source);
    setPortalError(res.portalError || '');
    setFound(res.mode ? { mode: res.mode, terms: res.terms || [] } : null);
    logSearch({ tip: q.tip, numar: q.numar, an: q.an, words: q.titlu, count: res.records.length, source: res.source });
    refreshLibrary();
    // A FIXED search — kind, number and year all given — names one act, so
    // its answer is opened at once rather than listed: one act, or several
    // versions of one (the newest in force is the one wanted; the rest are
    // its history, still in the list behind Back).
    if (q.tip && q.numar.trim() && q.an.trim() && res.records.length) {
      const first = res.records[0];
      if (res.records.every((r) => r.numar === first.numar && r.tipAct === first.tipAct)) {
        // Through the ref: `open` is remade every render (it reads the
        // sessions), and this callback is not.
        openRef.current?.([...res.records].sort((x, y) => (y.dataVigoare || '').localeCompare(x.dataVigoare || ''))[0]);
      }
    }
    return res;
  }, [refreshLibrary]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = runNow;

  const onSubmit = (e) => { e.preventDefault(); leaveToResults(); run(query); };
  // A random act THAT EXISTS: a year is drawn, and a word that almost every
  // title carries ("privind", "pentru"…), and the portal is asked for that —
  // a search that nearly always answers a page of acts — and one of them
  // FILLS THE FORM (its kind, number, year). Nothing else moves: the act is
  // not searched for or opened, the list stays as it was — pressing Search
  // is the user's (at their request). A draw that finds nothing is drawn
  // again, up to six times.
  const randomAct = async () => {
    const mine = ++seq.current;
    setBusy(true); setError('');
    const WORDS = ['privind', 'pentru', 'aprobarea', 'modificarea', 'completarea', 'organizarea', 'unor', 'masuri'];
    for (let tries = 0; tries < 6; tries++) {
      const an = String(1990 + Math.floor(Math.random() * (YEAR_NOW - 1990 + 1)));
      const titlu = WORDS[Math.floor(Math.random() * WORDS.length)];
      const res = await searchLegislation({ tip: '', numar: '', an, titlu, text: '', perPage: 30 });
      if (mine !== seq.current) return;
      if (!res?.ok) break;
      if (!res.records.length) continue;
      const r = res.records[Math.floor(Math.random() * res.records.length)];
      const kindOf = String(r.tipAct || '').toUpperCase();
      const tip = LEGIS_TYPES.find((t) => t.id && kindOf.startsWith(t.id))?.id || '';
      setQuery((q) => ({ ...q, tip, numar: String(r.numar || ''), an: String(r.year || an) }));
      setBusy(false);
      return;
    }
    if (mine !== seq.current) return;
    setBusy(false);
    setError('The portal answered nothing to six draws — try the dice again.');
  };

  useEffect(() => {
    if (!isElectron) return;
    const sig = params.toString();
    if (!sig || arrived.current === sig) return;
    arrived.current = sig;
    const q = {
      tip: params.get('tip') || '',
      numar: params.get('nr') || '',
      an: params.get('an') || '',
      titlu: params.get('titlu') || '',
      text: '',
    };
    if (!hasQuery(q)) return;
    setQuery(q);
    leaveToResults();
    // The query is spent once it has been run: a later manual search must not
    // be undone by a back-navigation replaying the citation that started this.
    setParams({}, { replace: true });
    (async () => {
      const res = await runNow(q);
      if (params.get('open') === '1') openIfUnambiguous(res);
    })();
    // `params` is the only real input; the rest are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Unambiguous means ONE act — or several versions of one act, in which
  // case the newest in force is the one a reader wants and the rest are its
  // history, reachable from the results by going back.
  const openIfUnambiguous = (res) => {
    if (!res?.records?.length) return false;
    const first = res.records[0];
    const same = res.records.every((r) => r.numar === first.numar && r.tipAct === first.tipAct);
    if (res.records.length !== 1 && !same) return false;
    openRef.current?.([...res.records].sort((a, b) => (b.dataVigoare || '').localeCompare(a.dataVigoare || ''))[0]);
    return true;
  };

  // What a citation gives the FORM: its kind, number and year, all three —
  // "Legea nr. 287/2009", "art. 5 din O.U.G. nr. 195/2002" — read apart
  // (lawRefDetails) and turned into the portal's own kind (legislationQueryFor).
  // A citation short of any of the three ("Codul muncii", a directive the
  // portal has no kind for) is NOT made a control: it could only be looked
  // for by words, and the words search — with the AI behind it — is the
  // user's to run, not something a click in the text sets off.
  const fixedQueryOf = (hit) => {
    const q = legislationQueryFor(lawRefDetails(hit));
    return q?.tip && q.numar && q.an ? { tip: q.tip, numar: q.numar, an: q.an } : null;
  };
  // A citation pressed INSIDE an act fills the bar's Kind, Number and Year
  // with it and runs that FIXED search — nothing else: no title words, no
  // AI — and the act opens as a NEW SESSION in the rail, the act it was
  // cited in staying open in its own; several versions of it open the
  // newest in force; anything else shows the results.
  const followCitation = async (hit) => {
    const fixed = fixedQueryOf(hit);
    if (!fixed) return;
    const next = { ...fixed, titlu: '', text: '' };
    setQuery(next);
    const res = await runNow(next);
    if (!openIfUnambiguous(res)) leaveToResults();
  };

  // ── The sessions ──
  const scroller = () => pageRef.current?.closest?.('.sv-single-scroll, .main-content') || null;
  const EMPTY_READER = { act: null, actSource: '', actHtml: '', actSync: { state: '', live: null }, find: '', findAt: 0, drawn: [], scroll: 0 };
  const readerSnapshot = () => ({ act, actSource, actHtml, actSync, find, findAt, drawn: [...drawnTables], scroll: scroller()?.scrollTop || 0 });
  // The active session's reading state, put away in its item.
  const stashActive = () => {
    const id = activeTabRef.current;
    if (id == null) return;
    const s = readerSnapshot();
    setTabs((t) => t.map((x) => (x.id === id ? { ...x, state: s } : x)));
  };
  // A reading state made the live one (anything still on its way for the
  // state being left is dropped; a session whose page never arrived asks
  // for it again).
  const applyReader = (s) => {
    ++pageSeq.current;
    setActBusy(false); setActError('');
    setAct(s.act); setActSource(s.actSource); setActSync(s.actSync); setActHtml(s.actHtml);
    setFind(s.find); setFindAt(s.findAt); setDrawnTables(new Set(s.drawn || []));
    if (s.act?.text && !s.actHtml) fetchPage(s.act, true);
    requestAnimationFrame(() => requestAnimationFrame(() => { const el = scroller(); if (el) el.scrollTop = s.scroll || 0; }));
  };
  const showTab = (id) => {
    if (id === activeTabRef.current) return;
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    stashActive();
    setActiveTab(id);
    applyReader(t.state);
  };
  // Back to the search and its results; the session keeps its place in the rail.
  const leaveToResults = () => {
    if (activeTabRef.current == null) { setAct(null); setActError(''); return; }
    stashActive();
    setActiveTab(null);
    applyReader(EMPTY_READER);
  };
  const closeTab = (id) => {
    setTabs((t) => t.filter((x) => x.id !== id));
    if (id === activeTabRef.current) { setActiveTab(null); applyReader(EMPTY_READER); }
  };
  // What a session is called in the rail: its current act.
  const tabAct = (t) => (t.id === activeTab ? act : t.state?.act);

  // Opening an act: the PORTAL first, the copy on disk only when the portal
  // cannot answer (lib/legislation decides), and whatever the portal sends
  // is kept — so the copy is always there for when it cannot.
  //
  // Where it opens: an act already open in a session → that session is
  // shown; otherwise a NEW session, the active one put away first. An answer arriving after the reader has
  // moved to another session lands in its own item, not on screen.
  const open = async (rec) => {
    const already = tabs.find((t) => tabAct(t)?.id === rec?.id);
    if (already) { showTab(already.id); return; }
    stashActive();
    const id = `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    setTabs((t) => [...t, { id, state: { ...EMPTY_READER, act: rec } }]);
    setActiveTab(id);
    ++pageSeq.current;
    setActHtml(''); setDrawnTables(new Set());
    setActBusy(true); setActError(''); setAct(rec); setFind(''); setFindAt(0);
    const res = await loadAct(rec);
    const failed = !res?.ok ? (res?.error === 'not_kept' || res?.error === 'not_found' || res?.error === 'unreachable' || res?.error === 'timeout'
      ? 'The portal could not be reached and this act has not been saved on this machine.'
      : 'The act could not be read.') : '';
    if (activeTabRef.current !== id) {
      // The reader has moved on: the answer goes into the session's item.
      if (res?.ok) {
        setTabs((t) => t.map((x) => (x.id === id ? { ...x, state: { ...x.state, act: res.act, actSource: res.source || '', actSync: { state: res.source === 'live' ? 'same' : '', live: null }, actHtml: '' } } : x)));
        logOpen(res.act);
        if (res.source === 'live') { await keepAct(res.act); refreshLibrary(); }
      }
      return;
    }
    setActBusy(false);
    if (failed) { setActError(failed); return; }
    setAct(res.act);
    setActSource(res.source || '');
    setActSync({ state: res.source === 'live' ? 'same' : '', live: null });
    // The page too — the portal's, this machine's copy when it cannot answer.
    fetchPage(res.act, true);
    logOpen(res.act);
    if (res.source === 'live') { await keepAct(res.act); refreshLibrary(); }
    readerRef.current?.scrollTo?.({ top: 0 });
  };
  openRef.current = open;

  // An act read from this machine's copy is checked against the portal in
  // the background: the same text and in-force date → "Matches the portal";
  // otherwise the portal's version is kept in hand for Sync. One just read
  // live is the portal's by definition.
  useEffect(() => {
    if (!act?.id || !act.text || actSource !== 'archive' || actSync.state) return undefined;
    let live = true;
    fetchActLive(act).then((res) => {
      if (!live || !res?.ok) return;
      setActSync(sameAct(act, res.act) ? { state: 'same', live: null } : { state: 'differs', live: res.act });
    }).catch(() => {});
    return () => { live = false; };
  }, [act?.id, actSource]); // eslint-disable-line react-hooks/exhaustive-deps
  // Sync: the portal's version takes the kept one's place, on screen and on disk.
  const syncAct = async () => {
    const live = actSync.live;
    if (!live) return;
    setAct(live); setActSource('live'); setActSync({ state: 'same', live: null });
    fetchPage(live, true);
    await keepAct(live); refreshLibrary();
  };

  const blocks = useMemo(() => (act?.text ? parseActText(act.text) : []), [act?.text]);
  // Each box-drawn table read as a grid (null where it is not one), and
  // which of them the reader has switched back to the portal's drawing —
  // DocVex's table is the default wherever the drawing could be read.
  const diagrams = useMemo(() => blocks.map((b) => (b.kind === 'table' ? parseBoxDiagram(b.rows) : null)), [blocks]);
  const grids = useMemo(() => blocks.map((b, i) => (b.kind === 'table' && !diagrams[i] ? parseBoxTable(b.rows) : null)), [blocks, diagrams]);
  const [drawnTables, setDrawnTables] = useState(() => new Set());
  const tableText = (b, i) => (drawnTables.has(i) || (!grids[i] && !diagrams[i]) ? b.rows
    : diagrams[i] ? diagramStrings(diagrams[i]) : grids[i].rows.flat().flatMap((c) => c.lines || [c.text]));
  // The act as the portal lays it out — the tree read off its page. With
  // it, the plain-text blocks above are not drawn; the find and the table
  // switches work over the tree instead (its tables are keyed `t:<id>`).
  const actTree = useMemo(() => (actHtml ? parseActHtml(actHtml) : null), [actHtml]);
  const treeStrings = useMemo(() => (actTree ? actTreeStrings(actTree, (id) => drawnTables.has(`t:${id}`)) : null), [actTree, drawnTables]);

  // ── Find in the act ──
  // With an act open, the tab bar's words box searches INSIDE it: every
  // occurrence is marked where it stands (the act is never filtered down to
  // matching passages — a match is read in its context), one of them is
  // current and scrolled to the middle of the window; Enter or Tab steps to
  // the next, Shift+Enter or Shift+Tab to the one before, and the count
  // stands beside the box. `fold` maps one character to one, so an index
  // into the folded text is an index into the act's own.
  const needle = fold(find.trim());
  const countIn = (s) => {
    if (!needle) return 0;
    const f = fold(s); let n = 0; let i = f.indexOf(needle);
    while (i >= 0) { n++; i = f.indexOf(needle, i + needle.length); }
    return n;
  };
  const total = useMemo(() => (
    treeStrings
      ? treeStrings.reduce((n, s) => n + countIn(s), 0)
      : blocks.reduce((n, b, i) => n + countIn(b.text || b.label || '') + (b.body || []).reduce((m, p) => m + countIn(p.text), 0) + (b.kind === 'table' ? tableText(b, i).reduce((m, r) => m + countIn(r), 0) : 0), 0)
  ), [blocks, needle, grids, drawnTables, treeStrings]); // eslint-disable-line react-hooks/exhaustive-deps
  const at = total ? ((findAt % total) + total) % total : 0;
  const step = (d) => { if (total) setFindAt((k) => (((k + d) % total) + total) % total); };
  useEffect(() => {
    if (!needle || !total) return;
    const el = readerRef.current?.querySelector('.lg-hit.is-current');
    el?.scrollIntoView?.({ block: 'center', behavior: document.documentElement.dataset.reduceMotion === 'true' ? 'auto' : 'smooth' });
  }, [needle, at, total]);
  // The text of one block with its occurrences marked; `counter` runs across
  // the whole act so each mark knows whether it is the current one.
  const markFind = (s, counter) => {
    if (!needle || !s) return s;
    const f = fold(s); const out = []; let last = 0; let i = f.indexOf(needle);
    while (i >= 0) {
      if (i > last) out.push(s.slice(last, i));
      const k = counter.n++;
      out.push(<mark key={`${k}`} className={`lg-hit${k === at ? ' is-current' : ''}`}>{s.slice(i, i + needle.length)}</mark>);
      last = i + needle.length;
      i = f.indexOf(needle, last);
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  // ── The references in the act, as controls ──
  // The tabs answer each other: what an act CITES is made pressable where it
  // stands — another act or a code (→ opened here, `followCitation`), a CAEN
  // code (→ the nomenclature in a modal, on that code), a court file number
  // (→ the Court files tab, on that file). The same detector as the Doc
  // Viewer's (lib/lawRefs), so the two read a citation the same way. Found
  // once per string and remembered for the act — the find re-renders on
  // every keystroke, and an act is thousands of strings.
  const refCache = useMemo(() => new Map(), [act?.id, actHtml]); // eslint-disable-line react-hooks/exhaustive-deps
  const refsOf = (s) => {
    let r = refCache.get(s);
    if (!r) {
      // An act is a control only when it fills the form whole (kind,
      // number, year — `fixedQueryOf`); the query is kept on the hit.
      r = findFollowableRefs(s).flatMap((h) => {
        if (h.kind !== 'act' && h.kind !== 'code') return [h];
        const fixed = fixedQueryOf(h);
        return fixed ? [{ ...h, fixed }] : [];
      });
      refCache.set(s, r);
    }
    return r;
  };
  const kindLabelOf = (tip) => LEGIS_TYPES.find((t) => t.id === tip)?.label || tip;
  const refTip = (h) => (h.kind === 'caen' ? `${lawRefLabel(h)} — open in the CAEN nomenclature`
    : h.kind === 'case' ? `Court file ${h.number} — open in Court files`
      : `Search ${kindLabelOf(h.fixed.tip)} nr. ${h.fixed.numar}/${h.fixed.an} and open it here`);
  const marked = (s, counter) => {
    if (!s) return s;
    const refs = refsOf(s);
    if (!refs.length) return markFind(s, counter);
    const out = []; let last = 0;
    refs.forEach((h, i) => {
      if (h.start > last) out.push(<React.Fragment key={`t${i}`}>{markFind(s.slice(last, h.start), counter)}</React.Fragment>);
      const inner = markFind(s.slice(h.start, h.end), counter);
      const go = h.kind === 'caen' ? () => setCaenModal({ code: h.codes[0], codes: h.codes, rev: h.rev || 0 })
        : h.kind === 'case' ? () => navigate(`/portal-just?nr=${encodeURIComponent(h.number)}`)
          : () => followCitation(h);
      out.push(
        <Tooltip key={`r${i}`} content={refTip(h)}>
          <button type="button" className={`lg-ref is-${h.kind}`} onClick={go}>{inner}</button>
        </Tooltip>,
      );
      last = h.end;
    });
    if (last < s.length) out.push(<React.Fragment key="tail">{markFind(s.slice(last), counter)}</React.Fragment>);
    return out;
  };

  const head = act ? actHeading(act) : null;

  // ── The browser build has neither the service nor the archive ──────────
  if (!isElectron) {
    return (
      <div className="lg-page" ref={pageRef}>
        <PageMasthead eyebrow="Portalul legislativ" eyebrowMuted="source: legislatie.just.ro" title="Legislation" compact={false} />
        <LegalTabs />
        <div className="lg-empty">
          <p className="lg-empty-title">Only in the desktop app</p>
          <p className="lg-empty-sub">
            The portal’s web service refuses browser requests, and the offline copy is a folder on
            your computer. Both need the desktop app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="lg-page" ref={pageRef}>
      <PageMasthead
        eyebrow="Portalul legislativ"
        eyebrowMuted="source: legislatie.just.ro"
        title="Legislation"
        compact={false}
        actions={(
          <div className="lg-mast-meta">
            <div>
              <div className="lg-mast-num">{library.acts.length}</div>
              <div>Kept here</div>
            </div>
            <span className="lg-mast-sep" />
            <div>
              <div className="lg-mast-num">{formatBytes(library.bytes)}</div>
              <div>On this machine</div>
            </div>
          </div>
        )}
      >
        Romanian legislation, searched through the Ministry of Justice’s own web service and read
        here as a laid-out document — every act you open is kept on this machine, so it is still
        there when the portal is not.
      </PageMasthead>
      {/* The Legislation tab bar — shared with the Newsletter and the CAEN
          page; the title search sits in it (Enter searches). */}
      {/* The mini header's second line holds the whole search: at the left
          the act's identity — the dice, Kind, Number, Year, Search — as one
          row drawn like the search box beside it (no labels: placeholders,
          as the search box has), and at the right the words box. WITH AN ACT
          OPEN the line is the act's: the words box finds inside its text
          (the only find there is — the act has no box of its own), and at
          the left stand the way back and the match count with its arrows. */}
      <LegalTabs
        // History — the bar's far right, past the search: the shared tool
        // button (components/HistoryMenu) over this tab's log; a search
        // entry runs again, an act entry opens again; "Kept acts" in its
        // head forgets the archive's whole acts.
        trailing={(
          <HistoryButton
            tab="legislation"
            tip="Every search run and every act opened, with the time"
            emptyText="Nothing yet. Every search you run and every act you open is listed here."
            renderEntry={(e) => (e.kind === 'search' ? (
              <>
                {kindLabel(e.tip) ? <span className="lg-hist-kind">{kindLabel(e.tip)} </span> : null}
                {e.numar ? `nr. ${e.numar}` : ''}{e.an ? `${e.numar ? '/' : 'din '}${e.an}` : ''}
                {e.words ? `${e.numar || e.an || kindLabel(e.tip) ? ' · ' : ''}“${e.words}”` : ''}
                {!e.numar && !e.an && !e.words && !kindLabel(e.tip) ? 'Everything' : ''}
                <span className="lg-hist-dim"> · {e.count} {e.count === 1 ? 'result' : 'results'}{e.source === 'archive' ? ' · from this machine' : ''}</span>
              </>
            ) : (
              <>
                <span className="lg-hist-kind">{actLabel(e.rec)}</span>
                {e.rec?.title ? <span className="lg-hist-dim"> — {e.rec.title}</span> : null}
              </>
            ))}
            onPick={(e) => {
              if (e.kind === 'search') {
                const q = { tip: e.tip || '', numar: e.numar || '', an: e.an || '', titlu: e.words || '', text: '' };
                setQuery(q); leaveToResults();
                run(q);
              } else if (e.rec) open(e.rec);
            }}
            extra={(
              <Tooltip content={library.acts.length ? 'Forget every act kept whole on this machine' : 'No act is kept on this machine'}>
                <button type="button" className="lgt-tool-btn is-danger" disabled={!library.acts.length} onClick={async () => { await clearArchive(); refreshLibrary(); }}>
                  <span className="lgt-tool-ico">{BinIcon}</span><span>Kept acts</span>
                </button>
              </Tooltip>
            )}
          />
        )}
        // Where the last answer came from — at the tabs row's right end,
        // above the hairline, as a filled pill.
        // ONE pill for both: where what is on show came from (the open
        // act's own source, else the last search's) AND the way out to the
        // portal — a button: with an act open it opens THAT act on the
        // portal, otherwise the portal itself.
        status={(act ? actSource : results && source) ? (() => {
          // A kept copy that IS what the portal has is as good as live, and
          // says so with the one pill; only a copy that differs (or one not
          // yet checked) is called "your copy", with Sync beside it.
          const src = act ? (actSync.state === 'same' ? 'live' : actSource) : source;
          const href = act?.link || 'https://legislatie.just.ro/';
          return (
            <>
              <Tooltip content={act?.link ? 'Open this act on the ministry’s portal' : 'Open the ministry’s portal'}>
                <button type="button" className={`lgt-status-pill is-${src}`} onClick={() => openExternal(href)}>
                  {act && actSync.state === 'same' ? <span className="lgt-status-ico">{KeptGlyph}</span> : null}
                  <span>{src === 'live' ? 'Live from the portal' : 'From your copy on this machine'}</span>
                  <span className="lgt-status-ico">{ExternalIcon}</span>
                </button>
              </Tooltip>
              {/* A kept act that differs from the portal's: Sync takes the
                  portal's version. */}
              {act && actSync.state === 'differs' ? (
                <Tooltip content="The portal's text has changed since this copy was kept — take the portal's">
                  <button type="button" className="lgt-status-pill is-differs" onClick={syncAct}>
                    <span>Differs from the portal</span><span className="lgt-status-ico">{SyncGlyph}</span><span>Sync</span>
                  </button>
                </Tooltip>
              ) : null}
            </>
          );
        })() : null}
        search={act ? {
          value: find,
          placeholder: 'Find in this act',
          onChange: (v) => { setFind(v); setFindAt(0); },
          onSubmit: () => step(1),
          onKeyDown: (e) => {
            if (e.key === 'Tab' && needle) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); step(-1); }
          },
        } : {
          value: query.titlu,
          placeholder: 'Any words',
          onChange: (v) => setQuery((q) => ({ ...q, titlu: v })),
          onSubmit: () => { leaveToResults(); run(query); },
        }}
        tools={(
          <>
            {/* Always there, so the bar never shifts: with an act open it
                closes it back to the results (the act keeps its place in
                the rail); faded and inert otherwise. */}
            <Tooltip content={act ? 'Back to the results' : 'Open an act to go back from it'}>
              <button type="button" className="lgt-tool-btn" aria-label="Back" disabled={!act} onClick={leaveToResults}>
                <span className="lgt-tool-ico">{BackIcon}</span>
              </button>
            </Tooltip>
            <LegalBar onSubmit={onSubmit}>
              <Tooltip content="A random act — a number and a year drawn at random">
                <BarDice label="Search a random act" onClick={randomAct} disabled={busy} />
              </Tooltip>
              <BarPicker label="Kind of act" options={LEGIS_TYPES} value={query.tip} onChange={(v) => setQuery((q) => ({ ...q, tip: v }))} />
              <BarInput size="num" aria-label="Number" value={query.numar} onChange={set('numar')} placeholder="Number" inputMode="numeric" />
              <BarInput size="num" aria-label="Year" value={query.an} onChange={set('an')} placeholder="Year" inputMode="numeric" />
              <BarGo busy={busy}>Search</BarGo>
            </LegalBar>
            {/* What the bar has to say about the last press — an empty form,
                a dead portal, a dice that drew nothing — on its own line,
                beside it. */}
            {error ? <span className="lg-warn lg-barnote">{error}</span> : null}
            {act && needle && act.text ? (
              <div className="lgt-toggle lg-findnav" role="group" aria-label="Matches in this act">
                <Tooltip content="The match before (Shift+Enter)">
                  <button type="button" className="lgt-toggle-btn" aria-label="Previous match" disabled={!total} onClick={() => step(-1)}>‹</button>
                </Tooltip>
                <span className="lg-findnav-count" aria-live="polite">{total ? `${at + 1} of ${total}` : 'No match'}</span>
                <Tooltip content="The next match (Enter)">
                  <button type="button" className="lgt-toggle-btn" aria-label="Next match" disabled={!total} onClick={() => step(1)}>›</button>
                </Tooltip>
              </div>
            ) : null}
          </>
        )}
      />

      <div className={`lg-shell${tabs.length ? ' has-rail' : ''}`}>
      {/* The rail — the Advisor's list of chats, for acts: one item per
          reading session, the active one lit; "Search" above them is the
          way back to the search and its results. Only once there is a
          session; the page is otherwise as it was. */}
      {tabs.length ? (
        <aside className="lg-rail" aria-label="Acts open in this tab">
          <div className="lg-rail-head">
            <button type="button" className={`lg-rail-item is-head${activeTab == null ? ' is-active' : ''}`} onClick={leaveToResults}>
              <span className="lg-rail-ico">{RailSearchIcon}</span>
              <span className="lg-rail-title">Search</span>
            </button>
          </div>
          <div className="lg-rail-list">
            {tabs.map((t) => {
              const a = tabAct(t);
              const label = a ? actLabel(a) : 'Opening…';
              return (
                <div
                  key={t.id}
                  className={`lg-rail-item${t.id === activeTab ? ' is-active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => showTab(t.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') showTab(t.id); }}
                >
                  <span className="lg-rail-ico">{RailActIcon}</span>
                  <Tooltip content={a?.title ? `${label} — ${a.title}` : label}>
                    <span className="lg-rail-title">{label}{a?.title ? <span className="lg-rail-sub"> — {a.title}</span> : null}</span>
                  </Tooltip>
                  <span className="lg-rail-actions">
                    <Tooltip content="Close">
                      <button type="button" aria-label={`Close ${label}`} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>{RailCloseIcon}</button>
                    </Tooltip>
                  </span>
                </div>
              );
            })}
          </div>
        </aside>
      ) : null}
      <div className="lg-shell-main">
      {act ? (
        // ── Reading one act ────────────────────────────────────────────
        <div className="lg-reader" ref={readerRef}>
          <article className="lg-act">
            <header className="lg-act-head">
              {/* The act's kind ("LEGE nr. 133/2026") with its actions on the
                  same line, at the right: Save offline (an act already kept
                  says nothing — the "Saved here" pill was removed) and On
                  the portal. */}
              <div className="lg-act-kindrow">
                <div className="lg-act-kind">{head.label}</div>
                <div className="lg-reader-tools">
                  {kept.has(act.id) ? null : act.text ? (
                    <Tooltip content="Keep the full text on this machine">
                      <button type="button" className="lgt-tool-btn" onClick={async () => { await keepAct(act); refreshLibrary(); }}>
                        <span className="lgt-tool-ico">{KeepIcon}</span><span>Save offline</span>
                      </button>
                    </Tooltip>
                  ) : null}
                  {/* "On the portal" is the status pill above the hairline now. */}
                </div>
              </div>
              <h1 className="lg-act-title">{head.title}</h1>
              <div className="lg-act-meta">
                {head.issued ? <span>din {head.issued}</span> : null}
                {head.emitent ? <span>{head.emitent}</span> : null}
                {head.publicatie ? <span>{head.publicatie}</span> : null}
                {head.inForce ? <span>în vigoare {head.inForce}</span> : null}
                {head.republished ? <span className="lg-tag">republicată</span> : null}
              </div>
              {/* Said on every act, not buried in an About page: a consolidated
                  text is a convenience, and quoting it as the law is the
                  mistake this line exists to prevent. */}
              <div className="lg-act-warn" role="note">
                <span className="lg-act-warn-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" />
                  </svg>
                </span>
                <div>
                  <p className="lg-act-warn-title">Not the authentic text</p>
                  <p className="lg-act-warn-body">
                    Consolidated text from the legislative portal. Only the version printed in Monitorul
                    Oficial is authentic — check it before relying on this in a filing.
                  </p>
                </div>
              </div>
            </header>

            {actBusy ? <p className="lg-note">Reading…</p> : null}
            {actError ? <p className="lg-note is-bad">{actError}</p> : null}
            {!actBusy && !actError && !act.text ? <p className="lg-note">This act has no text.</p> : null}
            {needle && act.text && !total ? (
              <p className="lg-note">Nothing in this act matches “{find.trim()}”.</p>
            ) : null}

            <div className={`lg-body${actTree ? ' is-tree' : ''}`}>
              {(() => {
                const counter = { n: 0 };
                // A box-drawn table (a form, a schedule), with a switch above
                // it: DocVex's table (the drawing read as a grid, merged cells
                // and all) or the portal's drawing as it is, in a monospace
                // block where the boxes line up. A drawing that could not be
                // read as a grid has only the drawing. The find marks inside
                // either like anywhere else.
                const renderTable = (key, rows, grid, diagram = null) => {
                  const readable = !!(grid || diagram);
                  const drawn = !readable || drawnTables.has(key);
                  const setDrawn = (on) => setDrawnTables((s) => { const next = new Set(s); if (on) next.add(key); else next.delete(key); return next; });
                  return (
                    <div className="lg-tblwrap" key={key}>
                      {/* The view switch over the table. */}
                      <div className="lg-tblbar">
                        <div className="lgt-toggle" role="tablist" aria-label={diagram ? 'How the diagram is drawn' : 'How the table is drawn'}>
                          <button type="button" role="tab" aria-selected={!drawn} className={`lgt-toggle-btn${!drawn ? ' is-on' : ''}${readable ? '' : ' is-off'}`} aria-disabled={!readable} onClick={() => { if (readable) setDrawn(false); }}>DocVex</button>
                          <button type="button" role="tab" aria-selected={drawn} className={`lgt-toggle-btn${drawn ? ' is-on' : ''}`} onClick={() => setDrawn(true)}>Source</button>
                        </div>
                      </div>
                      {drawn ? (
                        <pre className="lg-table">
                          {rows.map((r, j) => <React.Fragment key={j}>{marked(r, counter)}{j < rows.length - 1 ? '\n' : ''}</React.Fragment>)}
                        </pre>
                      ) : diagram ? (
                        <BoxDiagram d={diagram} marked={marked} counter={counter} />
                      ) : (
                        <div className="lg-tblbox">
                        <table className="lg-tbl">
                          <tbody>
                            {grid.rows.map((row, j) => (
                              <tr key={j}>
                                {row.map((c) => (
                                  <td key={c.c} colSpan={c.colSpan > 1 ? c.colSpan : undefined} rowSpan={c.rowSpan > 1 ? c.rowSpan : undefined} className={c.text ? '' : 'is-empty'}>
                                    {/* The cell's lines — one per item the drawing set
                                        on its own row (a bullet, a number, a letter),
                                        each on a line of its own. */}
                                    {(c.lines || [c.text]).map((l, k) => <span className="lg-tbl-line" key={k}>{marked(l, counter)}</span>)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        </div>
                      )}
                    </div>
                  );
                };
                // ── The act as the portal lays it out (the tree) ──
                // Each node drawn in DocVex's own type by the portal's rule:
                // an article with its number as a heading, a paragraph with
                // its "(1)", a letter with its "a)" indented under it, a point
                // with its "1.", quoted text (an amendment's new wording) as a
                // rule-marked block, a note, an annex as a section, the
                // signatures right-aligned, a preformatted block as its rows
                // with each table it draws switchable.
                const UNIT_LEVEL_OF = { prt: 1, crt: 1, ttl: 2, cap: 2, sec: 3, sbs: 3, anx: 2 };
                const renderNode = (b, key) => {
                  const kids = (b.children || []).map((c, i) => renderNode(c, `${key}.${i}`));
                  switch (b.kind) {
                    case 'par': {
                      const amend = /^\(la \d/.test(b.text || '');
                      return (
                        <React.Fragment key={key}>
                          {b.text ? <p className={`lg-para${amend ? ' lg-amend' : ''}`}>{marked(b.text, counter)}</p> : null}
                          {kids}
                        </React.Fragment>
                      );
                    }
                    case 'art':
                      return (
                        <section className="lg-art" key={key}>
                          <h3 className="lg-art-label">{marked(b.title, counter)}{b.den ? <span className="lg-art-den"> {marked(b.den, counter)}</span> : null}</h3>
                          {b.text ? <p className="lg-para">{marked(b.text, counter)}</p> : null}
                          {kids}
                        </section>
                      );
                    case 'aln':
                    case 'lit':
                    case 'pct':
                      return (
                        <div className={`lg-${b.kind}`} key={key}>
                          <span className="lg-para-num">{marked(b.title, counter)}</span>
                          <div className="lg-inner">
                            {b.text ? <p className="lg-para">{marked(b.text, counter)}</p> : null}
                            {kids}
                          </div>
                        </div>
                      );
                    case 'cit':
                      return <blockquote className="lg-cit" key={key}>{kids}</blockquote>;
                    case 'nta':
                      return (
                        <p className="lg-actnote" key={key}>
                          {b.title ? <b>{marked(b.title, counter)} </b> : null}{marked(b.text, counter)}
                          {kids}
                        </p>
                      );
                    case 'smn':
                      return <div className="lg-smn" key={key}>{b.lines.map((l, i) => <span key={i}>{marked(l, counter)}</span>)}</div>;
                    case 'pre':
                      return (
                        <div className="lg-pre" key={key}>
                          {b.segs.map((s, i) => (s.type === 'table'
                            ? renderTable(`t:${s.id}`, s.rows, s.grid, s.diagram)
                            : <pre className="lg-preline" key={i}>{s.rows.map((r, j) => <React.Fragment key={j}>{marked(r, counter)}{j < s.rows.length - 1 ? '\n' : ''}</React.Fragment>)}</pre>))}
                        </div>
                      );
                    default: {
                      // A unit: annex, chapter, title, section… — a heading, then what it holds.
                      const level = UNIT_LEVEL_OF[b.tag] || 3;
                      return (
                        <section className={`lg-unitsec is-${b.tag || 'unit'}`} key={key}>
                          {b.title || b.den ? <h2 className={`lg-unit is-l${level}`}>{marked(b.title, counter)}{b.den ? <span className="lg-unit-den"> {marked(b.den, counter)}</span> : null}</h2> : null}
                          {b.text ? <p className="lg-para">{marked(b.text, counter)}</p> : null}
                          {kids}
                        </section>
                      );
                    }
                  }
                };
                if (actTree) return actTree.blocks.map((b, i) => renderNode(b, String(i)));
                // ── Without the page: the plain text's shape ──
                return blocks.map((b, i) => {
                  if (b.kind === 'unit') return <h2 className={`lg-unit is-l${b.level}`} key={i}>{marked(b.text, counter)}</h2>;
                  if (b.kind === 'note') return <p className="lg-actnote" key={i}>{marked(b.text, counter)}</p>;
                  if (b.kind === 'table') return renderTable(i, b.rows, grids[i], diagrams[i]);
                  if (b.kind === 'article') {
                    return (
                      <section className="lg-art" key={i}>
                        <h3 className="lg-art-label">{marked(b.label, counter)}</h3>
                        {b.body.map((p, j) => (
                          <p className="lg-para" key={j}>
                            {p.num ? <span className="lg-para-num">({p.num})</span> : null}
                            {marked(p.text, counter)}
                          </p>
                        ))}
                      </section>
                    );
                  }
                  return b.body.map((p, j) => <p className="lg-para" key={`${i}-${j}`}>{marked(p.text, counter)}</p>);
                });
              })()}
            </div>
          </article>
        </div>
      ) : (
        // ── Searching ──────────────────────────────────────────────────
        <div className="lg-main">
          {/* The portal has no act-type filter, so a number and a year answer
              with every act of that number in force that year — the Kind
              picker is applied here, after the fact. Worth saying: it is why
              a search can come back with fewer rows than the portal found. */}
          <div className="lg-strip">
            <div className="lg-strip-left">
              {/* Where the answer came from is the pill at the tabs row's
                  right end (LegalTabs' `status`), not here. */}
              {portalError ? (
                <span className="lg-warn">
                  {portalError === 'stale_app'
                    ? 'This window is newer than the app running behind it — restart Docvex (npm start) to search the portal; this is what you already had.'
                    : `The portal could not be reached${portalError === 'timeout' ? ' (it timed out)' : ''} — this is what you already had.`}
                </span>
              ) : null}
              {results && found?.mode === 'text' ? <span className="lg-found">Found in the text of the acts, not their titles.</span> : null}
              {results && found?.mode === 'ai' ? <span className="lg-found">Found by asking for “{found.terms[found.terms.length - 1]}”.</span> : null}
              {results && found?.mode === 'none' && found.terms.length ? <span className="lg-found">Also tried: {found.terms.map((t) => `“${t}”`).join(', ')}.</span> : null}
            </div>
          </div>

          {/* The last search's results — only once one has run (what was
              searched and opened before is the History modal's). A result
              that is also kept whole on this machine says so. */}
          {results ? (
            <section className="lg-lib">
              <header className="lg-lib-head">
                <div>
                  <p className="lg-lib-title">
                    <span className="lg-ico">{LibraryIcon}</span>
                    {`Results · ${results.length}`}
                  </p>
                  <p className="lg-lib-sub">
                    {source === 'archive'
                      ? 'Answered from this machine’s copy — the portal could not be reached.'
                      : 'Answered live by the portal. Every act you open is kept whole on this machine.'}
                  </p>
                </div>
              </header>

              {!results.length && !busy ? (
                <p className="lg-note">
                  {source === 'archive'
                    ? 'Nothing on this machine matches. With the portal back, the same search will reach all of it.'
                    : 'The portal found nothing for that.'}
                </p>
              ) : null}

              <ul className="lg-results">
                {results.map((r) => (
                  <ActRow key={r.id || r.titlu} r={r} kept={kept.get(r.id) || null} onOpen={open} onForget={null} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
      </div>
      </div>
      <CaenModal open={caenModal} onClose={closeCaen} />
    </div>
  );
}
