import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import PageMasthead from '../components/PageMasthead';
import LegalTabs, { RailToggle } from '../components/LegalTabs';
import { BarPicker } from '../components/LegalBar';
import Tooltip from '../components/Tooltip';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { askProjectAi } from '../lib/projectAi';
import { exactMatchPage, chooseModel, projectContext, prepareTurn, askAi, historyTurns, withData, withStyle, warmTurn, withLimit, TIMEOUT, aiModel, modelName, viewForRef, AI_PROMPTS, AI_MANNERS } from '../lib/aiEngine';
import AiControls, { useAiSettings } from '../components/AiControls';
import AiAnswer, { AiRefPill } from '../components/AiAnswer';
import { useMultilinePills } from '../components/AiChoices';
import SourcesModal from '../components/SourcesModal';
import { localFolderApi } from '../lib/localFolder';
import { readProjectsDir } from '../lib/projectsDir';
import { toLayoutPx } from '../lib/appZoom';
import { platformsFor, searchPlatform } from '../lib/legalSearch';
import { PLATFORMS, takeRecord } from '../lib/legalBrowser';
import ResearchDrawer, { viewForRow, recordText } from './ResearchDrawer';
import { setLawRefOpener } from '../lib/lawDrawer';
import RuleOptions from '../components/RuleOptions';
import ThinkingStatus from '../components/AiThinking';
import { useItemSpots } from '../components/DocRibbon';
import { useRailSpotlight } from '../lib/pointerSpots';
import { useChatFind } from '../lib/useChatFind';
import '../lib/useChatFind.css';
import { researchStore, RESEARCH_SCOPE } from '../lib/researchChats';
import { subscribeRunner, runnerState, setTurn, setSummarizing, setTyping, setStream, beginTurn, isLive, stopTurn, isThreadBusy, turnSignal } from '../lib/researchRunner';
import { isBlankChat } from '../lib/advisorChats';
import { ICONS as I } from './Projects/aiHub';
import '../components/LegalTabs.css';
import '../components/LegalBar.css';
import '../components/LegalWorkspace.css';
import '../components/LegalBrowser.css';
import './Projects/ProjectScoped.css';
import './Projects/ProjectAI.css';
import './LegalSourceStub.css';
import './Projects/ProjectChatVariantB.css';
import './Projects/ProjectAIChat.css';
import './Legislation.css';
import './Research.css';

// RESEARCH — a search engine of its OWN over Romanian law and the user's case:
// it asks the same portals the Legislation tab reads and answers with the AI as
// the Advisor does, but it never sends the reader to either tab — everything it
// opens (the whole act, a court file, a company, a CAEN code, every result)
// opens in ITS drawer on the right (pages/ResearchDrawer). Laid out as the
// Advisor is: the masthead, the mini header (the
// conversations toggle, a search over the chats), the chats as TABS in a rail
// (lib/researchChats — the Advisor's chat store; the app sidebar's Research
// entry lists the same tabs in its dropdown), the thread, and the Advisor's
// bottom-bar composer with the shared AI controls (components/AiControls:
// the model picker with Auto, and the Project files switch).
//
// THE AI is the shared engine (lib/aiEngine, surface `research`) — the same one
// the Doc Viewer's advisor runs on: Auto, the portal records the question names
// (acts, court files, companies, CAEN codes), the project's files, legislation
// marked in the answer (components/AiAnswer). It may NOT create or edit files.
// No standing rules; every step has a time limit, so a turn always ends.
// A FIXED search — an exact act, court file, CUI or CAEN code (exactMatchPage
// opens it straight away) — asks no AI at all: the answer IS the portal's, laid
// out as the Legislation tab lays it out (the act's head, the authenticity
// note, its first articles), the whole act a press away in the drawer.
// Under every answer: which model answered (and, under Auto, why), or the
// platform the answer came from.

const LEGAL_WAIT_MS = 15_000;   // how long an exact match waits for its portal
const ROWS_KEPT = 5;            // result rows kept per platform in a message
const ROWS_SHOWN = 3;
const ACT_BLOCKS = 18;          // an act's first blocks shown in the answer
const ACT_CHARS = 9000;

const RAIL_WIDTH_KEY = 'docvex.research.railWidth';
const RAIL_HIDDEN_KEY = 'docvex.research.railHidden';
const RAIL_DIVIDER_W = 9.6;
const RAIL_MIN = 168;
const RAIL_MAX = 384;
const RAIL_DEFAULT = 216;

const STARTERS = [
  'Care este termenul de prescripție pentru o factură neplătită?',
  'Legea 31/1990',
  'Ce acte îmi trebuie pentru înființarea unui SRL?',
  'Cod CAEN pentru dezvoltare software',
  'Ce spune Codul muncii despre perioada de probă?',
  'OUG 195/2002',
  'Cum se face o notificare de reziliere a unui contract de închiriere?',
  'Ce riscuri are clauza penală într-un contract comercial?',
];

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
const platformOfRoute = (route) => Object.values(PLATFORMS).find((p) => p.route === route) || null;

// The Advisor's helpers: the rail's search highlight, the thread's day dividers.
function highlightMatch(text, q) {
  const t = String(text || '');
  if (!q) return t;
  const i = t.toLowerCase().indexOf(q);
  if (i === -1) return t;
  return <>{t.slice(0, i)}<mark>{t.slice(i, i + q.length)}</mark>{t.slice(i + q.length)}</>;
}
function sameLocalDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a); const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}
function formatDayLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameLocalDay(d, now)) return 'Today';
  if (sameLocalDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatHM(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

// An answer kept in a message: only what is drawn (a few rows per platform).
const keepAnswer = (a) => (a ? { ok: !!a.ok, total: a.total ?? a.rows?.length ?? 0, source: a.source || '', error: a.error ? String(a.error) : '', note: a.note || '', rows: (a.rows || []).slice(0, ROWS_KEPT) } : { ok: false, total: 0, error: 'timed out', rows: [] });

// The act a fixed search named, read as the Legislation tab reads it: its
// record (handed over by the search row, `rid`), its text, the text's shape.
async function readAct(row) {
  try {
    const rid = new URLSearchParams(String(row?.page?.url || '').split('?')[1] || '').get('rid');
    const rec = rid ? takeRecord(rid) : null;
    if (!rec) return null;
    const { loadAct, parseActText, actHeading } = await import('../lib/legislation');
    const res = await withTimeout(loadAct(rec), 15_000);
    const act = res?.ok ? res.act : rec;
    const head = actHeading(act);
    let used = 0;
    const blocks = [];
    for (const b of act.text ? parseActText(act.text) : []) {
      if (b.kind === 'table') continue;
      const size = (b.text || b.label || '').length + (b.body || []).reduce((n, p) => n + p.text.length, 0);
      if (blocks.length >= ACT_BLOCKS || used + size > ACT_CHARS) break;
      used += size;
      blocks.push(b);
    }
    return { head, blocks, more: !!act.text && used < act.text.length * 0.95, source: res?.source || '' };
  } catch {
    return null;
  }
}

// The results, drawn as the Legislation tab's rows — opening in the drawer.
function LegalRows({ answers, plats, onOpen, limit = ROWS_SHOWN }) {
  const shown = plats.filter((p) => { const a = answers[p]; return a && (!a.ok || a.rows.length); });
  if (!shown.length) return <p className="rs-muted">Nothing on the connected platforms matched.</p>;
  return (
    <div className="lgb-serp rs-serp">
      {shown.map((p) => {
        const a = answers[p];
        const pl = PLATFORMS[p];
        return (
          <section key={p} className="lgb-group">
            <div className="lgb-group-head">
              <span className="lgb-group-dot" style={{ '--tone': pl.tone }} />
              <span className="lgb-group-name">{pl.name}</span>
              <span className="lgb-group-meta">{pl.site} · {a.ok ? `${a.total} ${a.total === 1 ? 'result' : 'results'}` : 'did not answer'}</span>
              {a.source === 'archive' ? <span className="lgb-pill" style={{ '--pill-tone': 'var(--warning)' }}><span className="lgb-pill-dot" />From your copy on this machine</span> : null}
            </div>
            {!a.ok ? <p className="lgb-empty">{pl.site} could not be reached{a.error ? ` (${a.error})` : ''}.</p> : (
              <ul className="lgb-rows">
                {a.rows.slice(0, limit).map((r, i) => (
                  <li key={`${p}${i}`} className="lgb-row">
                    <Tooltip content="Open in the preview">
                      <button type="button" className="lgb-row-main" onClick={() => onOpen(viewForRow(r))}>
                        <span className="lgb-row-kind" style={{ color: pl.tone }}>{r.kind}</span>
                        <span className="lgb-row-title">{r.title}</span>
                        {r.meta?.length || r.tags?.length ? (
                          <span className="lgb-row-meta">
                            {(r.meta || []).map((m) => <span key={m}>{m}</span>)}
                            {(r.tags || []).map((t) => <span key={t.label} className="lgb-pill" style={{ '--pill-tone': t.tone }}>{t.label}</span>)}
                          </span>
                        ) : null}
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// A FIXED search's answer — the portal's own, as the Legislation tab shows it.
// The byline of a model's work: which model, and why (Auto) or "chosen by you".
function ModelByline({ mi, verb = 'Answered by' }) {
  if (!mi) return null;
  return (
    <>
      {verb} <b>{modelName(mi.id)}</b>
      {mi.substituted ? ` (${mi.substituted} is not enabled yet)` : ''}
      {mi.auto ? <> · Auto{mi.reasoning ? ` — ${mi.reasoning}` : ''}</> : ' · chosen by you'}
    </>
  );
}

// A result's name in the switch — short: the act's kind and number, the file's
// number, the company's name, the CAEN code.
const ITEMS_MAX = 6;
function itemLabel(r) {
  if (!r) return '';
  const cut = (t, n = 28) => { const s = String(t || '').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  if (r.platform === 'legislation') return cut(r.kind, 30);
  if (r.platform === 'portal-just') return cut(r.page?.title || r.title, 24);
  if (r.platform === 'caen') return cut(String(r.title || '').split(' — ')[0], 12);
  return cut(r.title);
}
/** The summary a fixed answer holds for result `idx` (older chats kept one, for the first). */
const fixedSummary = (m, idx) => m?.summaries?.[idx] || (idx === 0 ? m?.summary || null : null);

// A FIXED search's answer: the portal's own, or — the switch on its top edge —
// an AI SUMMARY of the whole act / record, made once on the first press and
// kept in the message, by the model the composer's picker names. With SEVERAL
// results the switch holds one choice per result (≤ ITEMS_MAX; the rest behind
// "all N results"), each colour-coded to its platform, and AI summary
// summarises the result last picked. `mode` = 'item:<n>' | 'ai' ('portal', the
// first version's value, = the first result).
function FixedAnswer({ legal, onOpen, mode = 'portal', pick = 0, onMode, summary = null, summarizing = false, typing = false, onTyped, onTick }) {
  const pl = platformOfRoute(legal.direct?.route);
  const a = legal.answers?.[pl?.id];
  const act = legal.act;
  const rows = a?.ok ? a.rows || [] : [];
  const view = mode === 'portal' ? 'item:0' : mode;
  const idx = view.startsWith('item:') ? Number(view.slice(5)) || 0 : pick;
  const row = rows[idx] || rows[0] || null;
  const multi = rows.length > 1;
  const site = legal.site || pl?.site || 'the portal';
  // A click on the act's card opens the WHOLE act in the drawer — a click that
  // ends a text selection doesn't (the reader was copying a line).
  const openAct = () => {
    try { if (String(window.getSelection?.() || '').trim()) return; } catch { /* no selection API */ }
    // The row picked; failing that, the number and year the query named.
    const qs = new URLSearchParams(String(legal.direct?.url || '').split('?')[1] || '');
    const q = row ? null : { tip: qs.get('tip') || '', numar: qs.get('nr') || '', an: qs.get('an') || '', titlu: '' };
    onOpen({ type: 'act', row, q, label: (idx === 0 && act?.head?.label) || row?.kind || legal.direct?.title || '' });
  };
  // The choices: a result each (or the portal's name when there is one), then
  // AI summary — every one carrying its platform's colour (its dot, and the
  // pill's when it is picked).
  const toneOf = (r) => PLATFORMS[r?.platform]?.tone || pl?.tone || 'var(--accent)';
  const dot = (tone) => <span className="rs-opt-dot" style={{ '--tone': tone }} aria-hidden="true" />;
  const options = multi
    ? rows.slice(0, ITEMS_MAX).map((r, k) => ({ id: `item:${k}`, label: <>{dot(toneOf(r))}{itemLabel(r)}</>, example: `${r.kind} — ${r.title}`, tone: toneOf(r) }))
    : [{ id: 'item:0', label: <>{dot(pl?.tone || 'var(--accent)')}{site}</>, example: `What ${site} says, as it says it`, tone: pl?.tone || 'var(--accent)' }];
  options.push({
    id: 'ai',
    label: 'AI summary',
    example: multi ? `A summary of ${itemLabel(row)}, written by the model the composer names` : 'A summary of the whole record, written by the model the composer names',
    tone: 'var(--accent)',
  });
  const field = { label: 'Show', options };
  const tone = options.find((o) => o.id === view)?.tone || 'var(--accent)';
  const showAct = view === 'item:0' && act && pl?.id === 'legislation';
  return (
    <div className="rs-fixed">
      {/* The switch sits ON the panel's top edge (its vertical middle on the
          border), coloured by the picked choice's platform. */}
      <div className="rs-fixed-switchwrap" style={{ '--scope-tone': tone }}>
        <RuleOptions field={field} value={view} onPick={onMode} className="lgb-scopes rs-fixed-switch" />
      </div>
      {mode === 'ai' ? (
        summarizing ? (
          <ThinkingStatus query="summary" label={summarizing === true ? '' : String(summarizing).replace(/…$/, '')} />
        ) : summary?.error ? (
          <p className="rs-error">{summary.error}</p>
        ) : summary?.text ? (
          <AiAnswer text={summary.text} typing={typing} onTyped={onTyped} onTick={onTick} onRef={(hit) => onOpen(viewForRef(hit))} className="rs-summary" />
        ) : (
          <p className="rs-muted">No summary yet.</p>
        )
      ) : showAct ? (
        // The act's opening is a CARD: a click (or Enter) opens the whole act
        // in the drawer. Cut off, it fades out and says so over the fade.
        <div
          className={`rs-act-card${act.more ? ' is-cut' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`Open ${act.head.label}`}
          onClick={openAct}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAct(); } }}
        >
        <article className="lg-act rs-act">
          <header className="lg-act-head">
            <div className="lg-act-kindrow"><div className="lg-act-kind">{act.head.label}</div></div>
            <h1 className="lg-act-title">{act.head.title}</h1>
            <div className="lg-act-meta">
              {act.head.issued ? <span>din {act.head.issued}</span> : null}
              {act.head.emitent ? <span>{act.head.emitent}</span> : null}
              {act.head.publicatie ? <span>{act.head.publicatie}</span> : null}
              {act.head.inForce ? <span>în vigoare {act.head.inForce}</span> : null}
              {act.head.republished ? <span className="lg-tag">republicată</span> : null}
            </div>
            <div className="lg-act-warn" role="note">
              <span className="lg-act-warn-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" />
                </svg>
              </span>
              <div>
                <p className="lg-act-warn-title">Not the authentic text</p>
                <p className="lg-act-warn-body">Consolidated text from the legislative portal. Only the version printed in Monitorul Oficial is authentic — check it before relying on this in a filing.</p>
              </div>
            </div>
          </header>
          {act.blocks.length ? (
            <div className="lg-body rs-act-body">
              {act.blocks.map((b, i) => {
                if (b.kind === 'unit') return <h2 key={i} className={`lg-unit is-l${b.level}`}>{b.text}</h2>;
                if (b.kind === 'note') return <p key={i} className="lg-actnote">{b.text}</p>;
                if (b.kind === 'article') {
                  return (
                    <section key={i} className="lg-art">
                      <h3 className="lg-art-label">{b.label}</h3>
                      {b.body.map((p, j) => <p className="lg-para" key={j}>{p.num ? <span className="lg-para-num">({p.num})</span> : null}{p.text}</p>)}
                    </section>
                  );
                }
                return <React.Fragment key={i}>{(b.body || []).map((p, j) => <p className="lg-para" key={j}>{p.text}</p>)}</React.Fragment>;
              })}
            </div>
          ) : <p className="rs-muted">The portal sent no text for this act.</p>}
          {act.more ? <div className="rs-act-fade" aria-hidden="true" /> : null}
        </article>
        {act.more ? <span className="rs-act-more">Click to view more</span> : null}
        </div>
      ) : row ? (
        // The picked result as its card — a click on it opens it in the drawer
        // (which is why there is no "Open the details" button).
        <LegalRows answers={{ [pl.id]: { ...a, rows: [row] } }} plats={[pl.id]} onOpen={onOpen} limit={1} />
      ) : (
        <p className="rs-muted">{pl?.site || 'The portal'} {a && !a.ok ? `could not be reached${a.error ? ` (${a.error})` : ''}` : 'found nothing for this'}.</p>
      )}
      {/* The foot: the byline. There is no button — every result is its card,
          and a click on the card opens it. */}
      <div className="rs-fixed-foot">
        <p className="rs-byline">
          {view === 'ai' && summary?.text
            ? <><ModelByline mi={summary.model} verb={multi ? `Summary of ${itemLabel(row)} by` : 'Summary by'} /> · from {site}</>
            : view === 'ai' ? <>AI summary of {multi ? itemLabel(row) : `what ${site} holds`}</>
              : <>From <b>{site}</b> · {multi ? `${a.total ?? rows.length} results for an exact search, so no AI was used` : 'an exact match, so no AI was used'}</>}
          {rows.length > ITEMS_MAX ? (
            <> · <button type="button" className="rs-more rs-more-inline" onClick={() => onOpen({ type: 'results', legal, label: legal.q })}>all {rows.length} results →</button></>
          ) : null}
        </p>
      </div>
    </div>
  );
}

export default function Research() {
  const { session } = useAuth();
  const user = session?.user || null;
  const userKey = user?.id || '_anonymous';
  const { selectedProject } = useSelectedProject();
  const projectId = selectedProject?.id || null;

  useEffect(() => { researchStore.bind(userKey, RESEARCH_SCOPE); }, [userKey]);
  const chats = useSyncExternalStore(researchStore.subscribe, researchStore.getState);
  const threads = chats.threads;
  const activeId = chats.active;
  const activeThread = threads.find((t) => t.id === activeId) || null;
  const messages = activeThread?.messages || [];
  const listed = threads.filter((t) => !isBlankChat(t));

  const [val, setVal] = useState('');
  // The model and the Project files switch are ONE setting shared with the
  // Doc Viewer's advisor (lib/aiEngine, components/AiControls).
  const ai = useAiSettings();
  const model = ai.model;
  const useProject = ai.projectFiles;
  // What runs lives OUTSIDE the page (lib/researchRunner), so it carries on
  // when the reader switches tab; `busy` is the open chat's turn.
  const runner = useSyncExternalStore(subscribeRunner, runnerState);
  const busy = activeId && runner.busy[activeId] ? { threadId: activeId, ...runner.busy[activeId] } : null;
  const summarizing = runner.summarizing;
  const typing = runner.typing;
  const [chatSearch, setChatSearch] = useState('');
  // The "i" right of the search: every platform Research reads, and how.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // The starter pills: one line fully rounded, two or more half the radius.
  const startersRef = useRef(null);
  const [chatMenu, setChatMenu] = useState(null); // { id, x, y } — a chat's right-click menu
  const filesRef = useRef([]);
  const pageRef = useRef(null);
  const threadRef = useRef(null);
  const taRef = useRef(null);
  const listRef = useRef(null);
  // The drawer's views, a stack (Back returns).
  const [drawer, setDrawer] = useState([]);
  const openView = (v) => { if (v) setDrawer((st) => [...st, v]); };
  const openFresh = (v) => { if (v) setDrawer([v]); };
  const closeDrawer = React.useCallback(() => setDrawer([]), []);
  const backDrawer = () => setDrawer((st) => st.slice(0, -1));
  // A legislation reference pressed ANYWHERE while Research is on screen
  // (lib/lawDetect, the app-wide layer) opens in Research's own drawer — one
  // view deeper when it is open.
  useEffect(() => setLawRefOpener((hit) => {
    const v = viewForRef(hit);
    if (v) setDrawer((st) => (st.length ? [...st, v] : [v]));
  }), []);

  // ── The rail (the Advisor's): width, hidden, handed to the app sidebar ──
  const [railWidth, setRailWidth] = useState(() => {
    const n = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(n) && n >= RAIL_MIN && n <= RAIL_MAX ? n : RAIL_DEFAULT;
  });
  const [railResizing, setRailResizing] = useState(false);
  const [railHidden, setRailHidden] = useState(() => { try { return localStorage.getItem(RAIL_HIDDEN_KEY) === '1'; } catch { return false; } });
  const toggleRail = () => setRailHidden((v) => { const n = !v; try { localStorage.setItem(RAIL_HIDDEN_KEY, n ? '1' : '0'); } catch { /* quota */ } return n; });
  const startRailResize = (e) => {
    e.preventDefault();
    setRailResizing(true);
    const startX = e.clientX;
    const startW = railWidth;
    let latest = startW;
    const onMove = (ev) => { latest = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + toLayoutPx(ev.clientX - startX))); setRailWidth(latest); };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setRailResizing(false);
      try { localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(latest))); } catch { /* quota */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const [sidebarLists, setSidebarLists] = useState(() => window.__docvexResearchListed === true && window.__docvexSidebarCollapsed !== true);
  useEffect(() => {
    const read = () => setSidebarLists(window.__docvexResearchListed === true && window.__docvexSidebarCollapsed !== true);
    window.addEventListener('docvex:research-listed', read);
    window.addEventListener('docvex:sidebar-state', read);
    read();
    return () => { window.removeEventListener('docvex:research-listed', read); window.removeEventListener('docvex:sidebar-state', read); };
  }, []);
  const railOff = railHidden || sidebarLists;
  const [chatDrag, setChatDrag] = useState(null);

  // The app sidebar's Research row, clicked on this page: a new chat, caret in the composer.
  useEffect(() => {
    const focus = () => { setVal(''); requestAnimationFrame(() => taRef.current?.focus()); };
    window.addEventListener('docvex:research-focus', focus);
    return () => window.removeEventListener('docvex:research-focus', focus);
  }, []);

  // ── The project's files (the digest reads them, source chips match them) ──
  useEffect(() => {
    filesRef.current = [];
    if (!projectId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const baseDir = readProjectsDir(userKey) || undefined;
        const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
        const { files } = await localFolderApi.listAll(path || undefined);
        if (cancelled) return;
        filesRef.current = (files || []).filter((f) => f?.name).map((f) => ({
          name: f.name, path: f.path || null, folderPath: f.folderPath || '', sizeBytes: f.sizeBytes ?? null, mtimeIso: f.mtimeIso || null,
        }));
      } catch { /* no folder: the AI answers without the files */ }
      // Built ahead, so the first question doesn't wait for it.
      if (!cancelled && selectedProject) projectContext(selectedProject, filesRef.current);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, userKey]);

  // ── Layout (the Advisor's): the rail sticks under the mini header and ends
  // one inset above the window's foot; an empty chat fits the window. ──
  const emptyChat = messages.length === 0 && !busy;
  useMultilinePills(startersRef, [emptyChat, activeId]);
  useEffect(() => {
    const page = pageRef.current;
    const scroller = page?.closest('.sv-single-scroll, .main-content');
    if (!page || !scroller) return undefined;
    const apply = () => {
      const bar = page.querySelector('.lgt-bar');
      const inset = parseFloat(getComputedStyle(page).getPropertyValue('--chrome-inset')) || 6.4;
      const bh = bar ? bar.offsetHeight : 48;
      // The list stands the RAIL GAP under the header — the same gap it keeps
      // from the app sidebar.
      const gap = parseFloat(getComputedStyle(page).getPropertyValue('--rail-gap')) || 6.4;
      const top = inset + bh + gap;
      page.style.setProperty('--airail-top', `${top}px`);
      page.style.setProperty('--airail-h', `${Math.max(240, scroller.clientHeight - top - inset)}px`);
      const shell = page.querySelector('.aichat-shell');
      if (shell) {
        const sr = scroller.getBoundingClientRect();
        const at = shell.getBoundingClientRect().top - sr.top + scroller.scrollTop;
        page.style.setProperty('--aifit-h', `${Math.max(200, scroller.clientHeight - at - inset)}px`);
      }
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(apply);
    ro.observe(scroller);
    const bar = page.querySelector('.lgt-bar');
    if (bar) ro.observe(bar);
    return () => ro.disconnect();
  }, [emptyChat]);
  // The thread keeps clear of the floating composer.
  useEffect(() => {
    const footer = taRef.current?.closest('.vb-composer-wrap');
    const main = threadRef.current;
    if (!footer || !main) return undefined;
    const apply = () => { main.style.paddingBottom = `${Math.max(Math.round(footer.getBoundingClientRect().height) + 24, 88)}px`; };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(footer);
    return () => ro.disconnect();
  }, [activeId]);
  // THE TYPEWRITER: the reply that has just landed types itself out (the
  // Advisor's, components/AiTypewriter) — once; switching chat ends it.
  useEffect(() => { setTyping(null); }, [activeId]);
  const scrollToBottom = () => {
    const el = threadRef.current?.closest('.sv-single-scroll, .main-content');
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(() => { requestAnimationFrame(scrollToBottom); }, [activeId, messages.length, busy?.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!emptyChat) return;
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    if (scroller) scroller.scrollTop = 0;
  }, [emptyChat, activeId]);
  // Auto-grow the composer up to four lines.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 22;
    const maxH = Math.round(lh * 4 + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, [val]);

  // ── A message into a chat ──
  const patchThread = (id, fn) => researchStore.setChats((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
  const patchMessage = (id, index, patch) => patchThread(id, (t) => ({
    ...t,
    messages: (t.messages || []).map((m, k) => (k === index ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)),
  }));
  const push = (id, msg) => patchThread(id, (t) => ({
    ...t,
    messages: [...(t.messages || []), msg],
    updatedAt: Date.now(),
    title: t.messages?.length ? t.title : String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Research',
  }));

  // A turn. An EXACT MATCH (the line is an identifier, nothing more) is the
  // portal's answer; anything else goes to the AI (lib/aiEngine).
  const send = async (textArg) => {
    const query = String(textArg ?? val).trim();
    if (!query) return;
    const tid = activeThread?.id || researchStore.openNew();
    if (runnerState().busy[tid]) return; // one turn at a time in a chat
    const before = (researchStore.getState().threads.find((t) => t.id === tid)?.messages) || [];
    setVal('');
    push(tid, { who: 'me', text: query, at: Date.now() });
    const mine = beginTurn(tid);
    const live = () => isLive(tid, mine);

    try {
      // 1. EXACT MATCH — the portal answers.
      const page = exactMatchPage(query);
      if (page) {
        setTurn(tid, { phase: 'portals' });
        const plats = platformsFor(query);
        const got = await withLimit(Promise.all(plats.map((p) => searchPlatform(p, query))), LEGAL_WAIT_MS);
        if (!live()) return;
        const list = got === TIMEOUT ? [] : got;
        const answers = Object.fromEntries(plats.map((p, i) => [p, keepAnswer(list[i])]));
        const pl = platformOfRoute(page.route);
        const legal = { q: query, plats, answers, direct: page, site: pl?.site || '' };
        if (pl?.id === 'legislation') {
          setTurn(tid, { phase: 'act' });
          const row = list[plats.indexOf('legislation')]?.rows?.[0];
          const act = row ? await withLimit(readAct(row), LEGAL_WAIT_MS) : null;
          legal.act = act === TIMEOUT ? null : act;
          if (!live()) return;
        }
        push(tid, { who: 'ai', fixed: true, legal, q: query, view: 'portal', at: Date.now() });
        return;
      }

      // 2. THE AI.
      if (!session) {
        push(tid, { who: 'ai', text: '', isError: true, errorText: 'Sign in to ask the AI.', at: Date.now() });
        return;
      }
      // The shared engine (lib/aiEngine): Auto, the portal records the
      // question names and the project's files, gathered in parallel.
      setTurn(tid, { phase: aiModel(model).id === 'auto' ? 'route' : 'answer', model: aiModel(model).run });
      const t0 = performance.now();
      const prep = await prepareTurn({
        surface: 'research', question: query, choice: model,
        project: selectedProject, files: filesRef.current, withFiles: useProject && !!projectId,
      });
      if (!live()) return;
      setTurn(tid, { phase: 'answer', model: prep.run });
      const t1 = performance.now();
      const history = historyTurns(before.filter((m) => !m.isError && !m.interrupted && !m.fixed)
        .map((m) => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.text })));
      // STREAMED: the answer shows as it arrives (the runner holds the text
      // so far; the chat gets it once complete). A few updates a second at
      // most — each one re-renders the thread.
      let last = 0;
      const res = await askAi({
        surface: 'research', model: prep.run, projectName: selectedProject?.name,
        context: prep.context,
        messages: [...history, { role: 'user', content: withStyle(withData(query, prep.data), ai.style) }],
        signal: turnSignal(tid),
        onText: (_d, all) => {
          if (!live()) return;
          const now = performance.now();
          if (now - last < 60) return;
          last = now;
          setStream(tid, all);
        },
      });
      if (!live()) return;
      setStream(tid, null);
      const u = res.usage || {};
      const timing = {
        ...prep.timing, answer: performance.now() - t1, total: performance.now() - t0, ttft: res.ttft,
        contextChars: prep.context.length + prep.data.length,
        cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, input: u.input_tokens || 0,
      };
      const note = prep.notes.join(' ');
      const portals = prep.portals.filter((r) => r.ok).map((r) => ({ label: r.label, site: r.site }));
      if (res.error) push(tid, { who: 'ai', text: '', isError: true, errorText: res.error, model: prep.info, timing, at: Date.now() });
      else if (!String(res.text || '').trim()) push(tid, { who: 'ai', text: '', isError: true, errorText: 'The AI sent back an empty answer.', model: prep.info, timing, at: Date.now() });
      else {
        // Already shown as it streamed — no typewriter replay.
        push(tid, { who: 'ai', text: String(res.text).trim(), model: prep.info, withFiles: prep.withFiles, portals, note, timing, at: Date.now() });
      }
    } catch (e) {
      if (live()) push(tid, { who: 'ai', text: '', isError: true, errorText: e?.message || 'Something went wrong.', at: Date.now() });
    } finally {
      if (live()) { setStream(tid, null); setTurn(tid, null); }
    }
  };
  // AI SUMMARY of a fixed answer — made once, kept in the message.
  // One summary per RESULT (`summaries[idx]`), for the result picked last.
  const summarize = async (tid, i, m, idx = 0) => {
    const key = `${tid}:${i}`;
    if (runnerState().summarizing[key] || fixedSummary(m, idx)?.text) return;
    const keep = (val) => patchMessage(tid, i, (cur) => ({ summaries: { ...(cur.summaries || {}), [idx]: val } }));
    if (!session) { keep({ error: 'Sign in to get an AI summary.' }); return; }
    const say = (v) => setSummarizing(key, v);
    try {
      const legal = m.legal || {};
      const pl = platformOfRoute(legal.direct?.route);
      const row = legal.answers?.[pl?.id]?.rows?.[idx] || legal.answers?.[pl?.id]?.rows?.[0] || null;
      const qs = new URLSearchParams(String(legal.direct?.url || '').split('?')[1] || '');
      const view = pl?.id === 'legislation'
        ? { type: 'act', row, q: row ? null : { tip: qs.get('tip') || '', numar: qs.get('nr') || '', an: qs.get('an') || '', titlu: '' } }
        : viewForRow(row);
      if (!view) { keep({ error: 'There is nothing to summarise.' }); return; }
      say(pl?.id === 'legislation' ? 'Reading the whole act…' : 'Reading the record…');
      const rec = await withLimit(recordText(view), 30_000);
      if (rec === TIMEOUT) { keep({ error: 'The record took too long to read.' }); return; }
      if (rec.error) { keep({ error: rec.error }); return; }
      const ask = `Summarise this ${pl?.id === 'legislation' ? 'Romanian normative act' : pl?.id === 'portal-just' ? 'Romanian court file' : pl?.id === 'anaf' ? 'company\'s ANAF fiscal record' : 'CAEN code'} for a lawyer`;
      if (aiModel(model).id === 'auto') say('Auto is picking a model…');
      const { run, info } = await chooseModel(model, `${ask}: ${rec.label || legal.q || ''}`);
      say(`Writing the summary with ${modelName(run)}…`);
      const question = (m.q || legal.q || '').trim();
      const res = await withLimit(askProjectAi({
        messages: [{ role: 'user', content: AI_PROMPTS.summary({ ask, question, site: pl?.site || '', text: rec.text }) }],
        model: run,
        tools: false,
        context: AI_MANNERS,
        usageAction: 'research-summary',
      }), 120_000);
      if (res === TIMEOUT) keep({ error: 'The summary took more than two minutes and was stopped. Try again, or pick a faster model.' });
      else if (res?.error) keep({ error: typeof res.error === 'string' ? res.error : (res.error?.message || 'The AI did not answer.') });
      else {
        keep({ text: res.text || '', model: info, at: Date.now() });
        setTyping(`${tid}:${i}:summary`);
      }
    } catch (e) {
      keep({ error: e?.message || 'The summary could not be written.' });
    } finally {
      setSummarizing(key, null);
    }
  };
  // The switch: a result (remembered as `pick`, the one AI summary is about)
  // or AI summary (made for that result the first time).
  const setFixedMode = (tid, i, m, mode) => {
    if (mode.startsWith('item:')) { patchMessage(tid, i, { view: mode, pick: Number(mode.slice(5)) || 0 }); return; }
    patchMessage(tid, i, { view: mode });
    const idx = m.pick || 0;
    if (mode === 'ai' && !fixedSummary(m, idx)?.text) summarize(tid, i, m, idx);
  };

  const stop = () => {
    if (!busy) return;
    const tid = busy.threadId;
    stopTurn(tid);
    push(tid, { who: 'ai', interrupted: true, text: 'Stopped', at: Date.now() });
  };


  // THE CHAT LIST'S GROUND ONLY WHILE STUCK — as the mini header's: the card
  // (frost, border, shadow) is drawn only once the list is pinned under the
  // header; in the page's flow it stands on the page ground. Measured at most
  // once a frame on scroll, written as a class (no re-render).
  useEffect(() => {
    const rail = tabRailRef.current;
    const scroller = rail?.closest('.sv-single-scroll, .main-content');
    if (!rail || !scroller) return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = parseFloat(getComputedStyle(rail).top) || 0;
      const sr = scroller.getBoundingClientRect();
      const at = toLayoutPx(rail.getBoundingClientRect().top - sr.top);
      rail.classList.toggle('is-stuck', scroller.scrollTop > 0 && at <= top + 0.5);
      // THE LIST RUNS DOWN TO THE PAGE'S BOTTOM, one gap above it (the
      // sidebar's gap rule), wherever it stands — in the flow or stuck.
      const inset = parseFloat(getComputedStyle(rail).getPropertyValue('--rail-gap')) || 6.4;
      rail.style.height = `${Math.max(160, scroller.clientHeight - Math.max(at, top) - inset)}px`;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // The page above it can change height without a scroll (the header, an
    // empty chat filling in): measured again then too.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    ro?.observe(scroller);
    if (rail.parentElement) ro?.observe(rail.parentElement);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); scroller.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
  }, [activeId]);

  // A streaming answer keeps the thread at its foot as it grows.
  const liveText = activeId ? runner.stream[activeId] : null;
  useEffect(() => { if (liveText) scrollToBottom(); }, [liveText]); // eslint-disable-line react-hooks/exhaustive-deps

  // WARM THE PROMPT CACHE while the question is typed: the project's files are
  // written to the cache for the model the question will likely go to, so the
  // answer starts on a warm cache (lib/aiEngine warmTurn — at most once per
  // model and data every few minutes).
  useEffect(() => {
    if (!session || !val.trim() || !useProject || !projectId) return undefined;
    const t = setTimeout(() => {
      warmTurn({ surface: 'research', choice: model, draft: val, project: selectedProject, files: filesRef.current, withFiles: true }).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
  }, [val, model, useProject, projectId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const newChat = () => { researchStore.openNew(); setVal(''); requestAnimationFrame(() => taRef.current?.focus()); };


  // The mini header's search FINDS in the open chat (the Advisor's, lib/useChatFind)
  // and narrows the chat list; Ctrl/⌘+F focuses it (LegalTabs).
  const find = useChatFind({ containerRef: threadRef, query: chatSearch, name: 'aichat', scope: '.bubble-msg' });
  // The rail's pointer lights — the Advisor's / the Legislation rail's.
  const tabRailRef = useItemSpots('.lg-rail-item', true);
  useRailSpotlight(tabRailRef);
  // The tabs' keys — the Advisor's: Ctrl+T new, Ctrl+W close, Ctrl+Shift+T
  // reopen, Ctrl+Tab / Ctrl+Shift+Tab step, Ctrl+1…9 go to.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const st = researchStore.getState();
      const list = st.threads.filter((t) => !isBlankChat(t));
      if (k === 't' && e.shiftKey) { e.preventDefault(); researchStore.reopenClosed(); return; }
      if (k === 't') { e.preventDefault(); newChat(); return; }
      if (k === 'w') { e.preventDefault(); if (st.active) researchStore.close(st.active); return; }
      if (e.key === 'Tab' && list.length) {
        e.preventDefault();
        const i = list.findIndex((t) => t.id === st.active);
        const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
        if (next) researchStore.select(next.id);
        return;
      }
      if (/^[1-9]$/.test(e.key) && list.length) {
        e.preventDefault();
        const n = Number(e.key);
        const t = n === 9 ? list[list.length - 1] : list[n - 1];
        if (t) researchStore.select(t.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // A chat's right-click menu — the Advisor's (the Legislation tabs' .lgb-menu).
  const chatMenuEl = (() => {
    if (!chatMenu) return null;
    const t = threads.find((x) => x.id === chatMenu.id);
    if (!t) return null;
    const close = () => setChatMenu(null);
    const others = threads.some((x) => x.id !== t.id && !x.pinned && !isBlankChat(x));
    const item = (label, kbd, fn, { disabled = false } = {}) => (
      <button type="button" role="menuitem" className="lgb-menu-item" disabled={disabled} onClick={() => { fn(); close(); }}>
        <span>{label}</span>{kbd ? <span className="lgb-menu-kbd">{kbd}</span> : null}
      </button>
    );
    return createPortal(
      <>
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
        <div role="menu" className="lgb-menu" style={{ left: Math.min(chatMenu.x, window.innerWidth - 240), top: Math.min(chatMenu.y, window.innerHeight - 240), zIndex: 9999 }}>
          {item('New research', 'Ctrl+T', newChat)}
          {item(t.pinned ? 'Unpin' : 'Pin', '', () => researchStore.togglePin(t.id))}
          <div className="lgb-menu-sep" />
          {item('Close', 'Ctrl+W', () => researchStore.close(t.id))}
          {item('Close other chats', '', () => researchStore.closeOthers(t.id), { disabled: !others })}
          {item('Reopen closed chat', 'Ctrl+Shift+T', () => researchStore.reopenClosed(), { disabled: !researchStore.getState().closed.length })}
        </div>
      </>,
      document.body,
    );
  })();

  const searchQ = chatSearch.trim().toLowerCase();
  const visibleThreads = searchQ ? listed.filter((t) => String(t.title || '').toLowerCase().includes(searchQ)) : listed;

  // ── The pieces ──
  const header = (
    <>
      <PageMasthead eyebrow="DocVex" eyebrowMuted="Law + your case" title="Research" compact={false}>
        {`One search over Romanian law and your case · ${listed.length} ${listed.length === 1 ? 'conversation' : 'conversations'}${projectId ? ` · ${selectedProject?.name}` : ''}`}
      </PageMasthead>
      <LegalTabs
        standalone
        className="aichat-bar"
        tools={(
          <>
          <RailToggle
            shown={!railOff}
            what="chats"
            onToggle={() => {
              // ONE SWITCH with the app sidebar's Research dropdown (as the
              // Legislation tab's): hiding the chats here hands the list to the
              // sidebar (its dropdown opens); showing them takes it back.
              if (!railOff) {
                toggleRail();
                window.dispatchEvent(new CustomEvent('docvex:research-list-set', { detail: { open: true } }));
                return;
              }
              if (railHidden) toggleRail();
              window.dispatchEvent(new CustomEvent('docvex:research-list-set', { detail: { open: false } }));
            }}
          />
          </>
        )}
        search={{
          value: chatSearch,
          onChange: setChatSearch,
          placeholder: 'Search chats…',
          find: find.supported && find.total ? { current: find.current, total: find.total, prev: find.goPrev, next: find.goNext } : null,
        }}
        trailing={(
          <Tooltip content="Connected platforms">
            <button type="button" className="lgt-tool-btn rs-info-btn" onClick={() => setSourcesOpen(true)} aria-label="Connected platforms">
              <span className="lgt-tool-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><path d="M12 7.5v.01" /></svg>
              </span>
            </button>
          </Tooltip>
        )}
      />
    </>
  );

  const composer = (
    <div className="vb-composer-wrap">
      <div className="dvx-composer">
        <textarea
          ref={taRef}
          className="dvx-composer-textarea"
          rows={1}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask a question, or type an act, a court file, a CUI, a CAEN code…"
          maxLength={4000}
        />
        <div className="dvx-composer-toolbar">
          <AiControls settings={ai} projectName={projectId ? (selectedProject?.name || 'the project') : ''} withStyle />
          <div className="dvx-composer-toolbar-spacer" />
          {busy ? (
            <Tooltip content="Stop"><button type="button" className="dvx-composer-btn dvx-composer-send" onClick={stop} aria-label="Stop">{I.stop({ width: 16, height: 16 })}</button></Tooltip>
          ) : (
            <Tooltip content="Search"><button type="button" className="dvx-composer-btn dvx-composer-send" onClick={() => send()} disabled={!val.trim()} aria-label="Search">{I.arrowUp({ width: 16, height: 16 })}</button></Tooltip>
          )}
        </div>
      </div>
    </div>
  );

  // A fixed step names itself; the answer itself cycles the Advisor's words.
  const busyLabel = !busy ? '' : busy.phase === 'portals' ? 'Searching the portals'
    : busy.phase === 'act' ? 'Reading the act'
      : busy.phase === 'route' ? 'Auto is picking a model' : '';

  // Which model answered — under every AI result.
  const modelLine = (m) => {
    if (m.fixed) return null; // drawn inside the answer's own panel (FixedAnswer)
    if (!m.model) return null;
    const reads = (m.portals || []).map((r) => r.label).join(', ');
    return (
      <p className="rs-byline">
        <ModelByline mi={m.model} />
        {m.withFiles ? <> · with {selectedProject?.name ? `${selectedProject.name}’s` : 'the project’s'} files</> : null}
        {reads ? <> · read from the portals: {reads}</> : null}
      </p>
    );
  };

  const aiBody = (m, i) => {
    if (m.fixed) {
      const key = `${activeId}:${i}`;
      return (
        <FixedAnswer
          legal={m.legal}
          onOpen={openFresh}
          mode={m.view || 'portal'}
          pick={m.pick || 0}
          onMode={(v) => setFixedMode(activeId, i, m, v)}
          summary={fixedSummary(m, m.pick || 0)}
          summarizing={summarizing[key] || false}
          typing={typing === `${key}:summary`}
          onTyped={() => setTyping(null)}
          onTick={i === messages.length - 1 ? scrollToBottom : undefined}
        />
      );
    }
    const body = String(m.text || '');
    const isTyping = typing === `${activeId}:${i}`;
    return (
      <>
        {m.isError ? <p className="rs-error">{m.errorText || 'The AI did not answer.'}</p>
          : (
            <AiAnswer
              text={body}
              typing={isTyping}
              revealKey={i === messages.length - 1 ? `rs:${activeId}` : undefined}
              onTyped={() => setTyping(null)}
              onTick={scrollToBottom}
              onRef={(hit) => openFresh(viewForRef(hit))}
            />
          )}
        {m.note && !isTyping ? <p className="rs-muted rs-note">{m.note}</p> : null}
      </>
    );
  };

  const tabEl = (t) => {
    const tBusy = isThreadBusy(runner, t.id);
    const m = researchStore.meta(t, { busy: tBusy });
    const on = t.id === activeId;
    return (
      <div
        key={t.id}
        role="tab"
        aria-selected={on}
        tabIndex={0}
        className={`lg-rail-item lgb-rtab${on ? ' is-active' : ''}${chatDrag?.id === t.id ? ' is-dragging' : ''}${chatDrag?.over === t.id && chatDrag?.id !== t.id ? ' is-drop' : ''}`}
        onClick={() => researchStore.select(t.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); researchStore.select(t.id); } }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); researchStore.close(t.id); } }}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        onContextMenu={(e) => { e.preventDefault(); setChatMenu({ id: t.id, x: e.clientX, y: e.clientY }); }}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.id); } catch { /* ignore */ } setChatDrag({ id: t.id, over: null }); }}
        onDragOver={(e) => { e.preventDefault(); if (chatDrag?.over !== t.id) setChatDrag((d) => (d ? { ...d, over: t.id } : d)); }}
        onDrop={(e) => { e.preventDefault(); researchStore.move(chatDrag?.id, t.id); setChatDrag(null); }}
        onDragEnd={() => setChatDrag(null)}
      >
        <Tooltip content={t.title}>
          <span className="lg-rail-title">
            <span className="lg-rail-kind lgb-rtab-kind">
              {tBusy ? <span className="lgb-spin" style={{ '--tone': m.tone }} /> : <span className="lgb-dot" style={{ '--tone': m.tone }} />}
              <span className="lgb-rtab-kindtext">{m.kind}</span>
            </span>
            <span className="lg-rail-num">{highlightMatch(t.title, searchQ)}</span>
          </span>
        </Tooltip>
        <span className="lg-rail-actions">
          {!t.pinned ? (
            <Tooltip content="Close chat">
              <button type="button" aria-label="Close chat" onClick={(e) => { e.stopPropagation(); researchStore.close(t.id); }}>{I.x({ width: 12, height: 12 })}</button>
            </Tooltip>
          ) : null}
        </span>
      </div>
    );
  };
  const pinned = visibleThreads.filter((t) => t.pinned);
  const rest = visibleThreads.filter((t) => !t.pinned);
  const blankOn = !activeThread || isBlankChat(activeThread);

  return (
    // THE ADVISOR'S FRAME: the app wraps project pages (the Advisor
    // included) in .project-page-frame, which is what drops the page
    // scroller's padding and lets .ai-chat-page lay out full-bleed — every
    // gap, the sticky rail and the bottom-bar composer are written against
    // it (ProjectAIChat.css, SplitView.css). Research is not a project page,
    // so it wears the same frame itself.
    <div className="project-page-frame">
    <div ref={pageRef} className={`ai-hub ai-chat-page rs-page${emptyChat ? ' is-empty-chat' : ''}`}>
      <ResearchDrawer stack={drawer} onClose={closeDrawer} onBack={backDrawer} onOpen={openView} />
      {chatMenuEl}
      <div className="dvx-scroll-area">
        {header}
        <div className={`aichat-shell aichat-fill${railOff ? ' rail-hidden' : ''}${railResizing ? ' is-resizing' : ''}`}>
          <aside
            ref={tabRailRef}
            className="aichat-rail is-tabrail"
            aria-hidden={railOff}
            style={{
              flexBasis: `calc(${railWidth}px + var(--ds-divider-pull, 11.2px))`,
              marginLeft: railOff
                ? `calc(${-(railWidth + RAIL_DIVIDER_W)}px - 2 * var(--ds-divider-pull, 11.2px))`
                : 'calc(-1 * var(--ds-divider-pull, 11.2px))',
            }}
            inert={railOff || undefined}
          >
            <div className="lgb-rail-head">
              <span className="lgb-rail-label">Open · {listed.length}</span>
              <span className="lgb-rail-headbtns">
                <Tooltip content="Show these chats in the app sidebar">
                  <button type="button" className="lgb-rail-add" aria-label="Show these chats in the app sidebar" onClick={() => window.dispatchEvent(new CustomEvent('docvex:research-list-set', { detail: { open: true } }))}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m15 10-2 2 2 2" /></svg>
                  </button>
                </Tooltip>
              </span>
            </div>
            <div className="lgb-rail-list" role="tablist" aria-orientation="vertical" ref={listRef}>
              <div
                role="tab"
                aria-selected={blankOn}
                tabIndex={0}
                className={`lg-rail-item lgb-rtab lgb-searchtab${blankOn ? ' is-active' : ''}`}
                onClick={newChat}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); newChat(); } }}
              >
                <Tooltip content="New research">
                  <span className="lg-rail-title">
                    <span className="lg-rail-kind lgb-rtab-kind">
                      <span className="lgb-searchtab-ico">{I.plus({ width: 11, height: 11 })}</span>
                      <span className="lgb-rtab-kindtext">New research</span>
                    </span>
                    <span className="lg-rail-num">The law and your case</span>
                  </span>
                </Tooltip>
              </div>
              {visibleThreads.length ? <div className="lgb-rail-div" aria-hidden="true" /> : null}
              {pinned.map(tabEl)}
              {pinned.length && rest.length ? <div className="lgb-rail-div" aria-hidden="true" /> : null}
              {rest.map(tabEl)}
              {searchQ && !visibleThreads.length ? <div className="aichat-rail-noresults">No chats match “{chatSearch.trim()}”.</div> : null}
              <div className="lgb-rail-end" onDragOver={(e) => { e.preventDefault(); setChatDrag((d) => (d ? { ...d, over: '__end' } : d)); }} onDrop={(e) => { e.preventDefault(); researchStore.move(chatDrag?.id, null); setChatDrag(null); }} />
            </div>
          </aside>

          <div
            className={`aichat-resizer${railResizing ? ' is-active' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat list"
            onMouseDown={startRailResize}
            onDoubleClick={() => { setRailWidth(RAIL_DEFAULT); try { localStorage.setItem(RAIL_WIDTH_KEY, String(RAIL_DEFAULT)); } catch { /* quota */ } }}
          />

          <div className="aichat-thread-col">
            <div className="aichat-main" ref={threadRef}>
              {/* Legislation in an answer: its hover pill (a click opens the drawer). */}
              <AiRefPill hostRef={threadRef} />
              {messages.length === 0 && !busy && (
                <div className="aichat-convo-empty">
                  <section className="lss-card">
                    <span className="lss-mark" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.6-4.6" /><path d="M10.5 7.5v6M7.5 10.5h6" />
                      </svg>
                    </span>
                    <p className="lss-title">Search the law and your case at once</p>
                    <p className="lss-plain">
                      Ask anything — the AI answers{projectId ? ` with ${selectedProject?.name}’s files in view while Project files is on` : ''}.
                      Type just an act, a court file number, a CUI or a CAEN code and the portal answers it directly.
                    </p>
                    <div ref={startersRef} className="ai-choices aichat-starters" role="group" aria-label="Things to search">
                      {STARTERS.map((c) => <button key={c} type="button" className="ai-choice" onClick={() => send(c)}>{c}</button>)}
                    </div>
                  </section>
                </div>
              )}
              <div className="chat">
                {messages.map((m, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <React.Fragment key={i}>
                    {m.at && (() => {
                      let prevAt = null;
                      for (let j = i - 1; j >= 0; j--) { if (messages[j].at) { prevAt = messages[j].at; break; } }
                      return !prevAt || !sameLocalDay(prevAt, m.at) ? (
                        <div className="aichat-day-divider" role="separator">
                          <span className="aichat-day-divider-label">{formatDayLabel(m.at)}</span>
                        </div>
                      ) : null;
                    })()}
                    {m.interrupted ? (
                      <div className="aichat-interrupted" role="status">
                        <span className="aichat-interrupted-elbow" aria-hidden="true">⎿</span>
                        <span>{m.text || 'Stopped'}</span>
                      </div>
                    ) : (
                      <div className={`bubble ${m.who === 'me' ? 'me' : ''}`}>
                        <div className="bubble-c">
                          <div className={`bubble-msg${m.fixed ? ' rs-fixed-msg' : ''}`}>
                            {m.who === 'me' ? m.text : aiBody(m, i)}
                          </div>
                          {m.who !== 'me' && typing !== `${activeId}:${i}` && modelLine(m)}
                          {m.who === 'me' && m.at && <span className="aichat-time">{formatHM(m.at)}</span>}
                        </div>
                      </div>
                    )}
                  </React.Fragment>
                ))}
                {busy && busy.threadId === activeId && (
                  <div className="bubble">
                    <div className="bubble-c">
                      <div className="bubble-msg">
                        {runner.stream[activeId]
                          ? <AiAnswer text={runner.stream[activeId]} streaming revealKey={`rs:${activeId}`} onTick={scrollToBottom} onRef={(hit) => openFresh(viewForRef(hit))} />
                          : <ThinkingStatus query={messages.length ? messages[messages.length - 1]?.text : ''} label={busyLabel} />}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {composer}
            <SourcesModal open={sourcesOpen} onClose={() => setSourcesOpen(false)} />
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
