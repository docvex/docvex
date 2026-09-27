import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './Legislation.css';
import PageMasthead from '../components/PageMasthead';
import LegalTabs, { LegalSearchBox } from '../components/LegalTabs';
import { LegalBar, BarDice, BarPicker, BarInput, BarGo } from '../components/LegalBar';
import Tooltip from '../components/Tooltip';
import CaenModal from '../components/CaenModal';
import { findFollowableRefs, lawRefDetails, lawRefLabel } from '../lib/lawRefs';
import { isElectron, openExternal } from '../lib/platform';
import { askProjectAi } from '../lib/projectAi';
import { recallPage, usePageMemory } from '../lib/pageMemory';
import { logSearch, logOpen } from '../lib/legislationHistory';
import { BinIcon } from '../components/HistoryMenu';
import LegalWorkspace, { WorkspaceSearch } from '../components/LegalWorkspace';
import { takeRecord } from '../lib/legalBrowser';
import {
  LEGIS_TYPES, searchLegislation, searchLegislationPlain, loadAct, keepAct, listArchive, clearArchive, fetchActLive, sameAct, forgetLegislationSession,
  loadActPage, peekActPage, parseActHtml, actTreeStrings, legislationQueryFor,
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
// The search row's Clear: an eraser.
const ClearIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 21h10" /><path d="M5.6 15.4l8.5-8.5a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 19H8.8l-3.2-3.2a1 1 0 0 1 0-1.4z" /><path d="M9.5 11.5l5 5" />
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

// The act's name as the portal writes it, with its state — "(republicată)",
// "(*actualizată*)" — set in bold as the portal sets it.
function denParts(den) {
  const m = /\((\**[\p{L} ]+?\**)\)\s*$/u.exec(den || '');
  if (!m) return den;
  return (
    <>
      {den.slice(0, m.index)}(<strong className="lg-src-state">{m[1]}</strong>){den.slice(m.index + m[0].length)}
    </>
  );
}

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

// ── The act's body, drawn without stopping the app ──
// A consolidated act runs to thousands of articles, paragraphs and letters,
// and every string is read for citations. Drawn in one pass that froze the
// window for as long as it took (on every visit to the tab). Now:
//  · every node is a component of its own, MEMOISED — a find step, a table
//    switch, anything the page re-renders for, redraws only the nodes it
//    touches (a node compares its string, the find, whether the current
//    match is inside it and the table switches);
//  · the act is revealed in SLICES in pre-order — the first FIRST_NODES at
//    once, then STEP_NODES more at a time in a transition, so React yields
//    to the reader between nodes and the app never pauses; a spinner at the
//    foot says the rest is on its way;
//  · the find's matches are numbered the way `actTreeStrings` lists the
//    strings (title → den → text → lines / segs → children), so the count in
//    the field and the marks agree.
const FIRST_NODES = 70;
const STEP_NODES = 180;
const UNIT_LEVEL_OF = { prt: 1, crt: 1, ttl: 2, cap: 2, sec: 3, sbs: 3, anx: 2 };

const refTipOf = (h) => (h.kind === 'cui' ? `CUI ${h.cui} — look the company up at ANAF`
  : h.kind === 'caen' ? `${lawRefLabel(h)} — open in the CAEN nomenclature`
    : h.kind === 'case' ? `Court file ${h.number} — open in Court files`
      : `Search ${LEGIS_TYPES.find((t) => t.id === h.fixed.tip)?.label || h.fixed.tip} nr. ${h.fixed.numar}/${h.fixed.an} and open it here`);

const countHits = (s, needle) => {
  if (!needle || !s) return 0;
  const f = fold(s); let n = 0; let i = f.indexOf(needle);
  while (i >= 0) { n++; i = f.indexOf(needle, i + needle.length); }
  return n;
};

// A string with its references as controls and its find matches marked;
// `c` = { n: the global number of the next match, needle, at: the current }.
function markFindIn(s, c) {
  if (!c.needle || !s) return s;
  const f = fold(s); const out = []; let last = 0; let i = f.indexOf(c.needle);
  while (i >= 0) {
    if (i > last) out.push(s.slice(last, i));
    const k = c.n++;
    out.push(<mark key={`${k}`} className={`lg-hit${k === c.at ? ' is-current' : ''}`}>{s.slice(i, i + c.needle.length)}</mark>);
    last = i + c.needle.length;
    i = f.indexOf(c.needle, last);
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function markString(s, c, refsOf, onRef) {
  if (!s) return s;
  const refs = refsOf(s);
  if (!refs.length) return markFindIn(s, c);
  const out = []; let last = 0;
  refs.forEach((h, i) => {
    if (h.start > last) out.push(<React.Fragment key={`t${i}`}>{markFindIn(s.slice(last, h.start), c)}</React.Fragment>);
    out.push(
      <Tooltip key={`r${i}`} content={refTipOf(h)}>
        <button type="button" className={`lg-ref is-${h.kind}`} onClick={() => onRef(h)}>{markFindIn(s.slice(h.start, h.end), c)}</button>
      </Tooltip>,
    );
    last = h.end;
  });
  if (last < s.length) out.push(<React.Fragment key="tail">{markFindIn(s.slice(last), c)}</React.Fragment>);
  return out;
}

// A box-drawn table with its DocVex / Source switch (see the page's notes).
function ActTable({ tkey, rows, grid, diagram, drawnTables, setDrawnTables, mk, c }) {
  const readable = !!(grid || diagram);
  const drawn = !readable || drawnTables.has(tkey);
  const setDrawn = (on) => setDrawnTables((s) => { const next = new Set(s); if (on) next.add(tkey); else next.delete(tkey); return next; });
  return (
    <div className="lg-tblwrap">
      <div className="lg-tblbar">
        <div className="lgt-toggle" role="tablist" aria-label={diagram ? 'How the diagram is drawn' : 'How the table is drawn'}>
          <button type="button" role="tab" aria-selected={!drawn} className={`lgt-toggle-btn${!drawn ? ' is-on' : ''}${readable ? '' : ' is-off'}`} aria-disabled={!readable} onClick={() => { if (readable) setDrawn(false); }}>DocVex</button>
          <button type="button" role="tab" aria-selected={drawn} className={`lgt-toggle-btn${drawn ? ' is-on' : ''}`} onClick={() => setDrawn(true)}>Source</button>
        </div>
      </div>
      {drawn ? (
        <pre className="lg-table">
          {rows.map((r, j) => <React.Fragment key={j}>{mk(r)}{j < rows.length - 1 ? '\n' : ''}</React.Fragment>)}
        </pre>
      ) : diagram ? (
        <BoxDiagram d={diagram} marked={(s) => mk(s)} counter={c} />
      ) : (
        <div className="lg-tblbox">
          <table className="lg-tbl">
            <tbody>
              {grid.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell) => (
                    <td key={cell.c} colSpan={cell.colSpan > 1 ? cell.colSpan : undefined} rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined} className={cell.text ? '' : 'is-empty'}>
                      {(cell.lines || [cell.text]).map((l, k) => <span className="lg-tbl-line" key={k}>{mk(l)}</span>)}
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
}

// One node of the portal's tree. `meta` (Map node → { i, end, h0, hEnd })
// is read, not compared: it only changes with the find or the tables, and
// those are compared.
const sameNode = (a, b) => a.b === b.b && a.needle === b.needle && a.cur === b.cur && a.cut === b.cut
  && a.drawnTables === b.drawnTables && a.refsOf === b.refsOf;
const ActNode = React.memo(function ActNode({ b, meta, needle, cur, cut, drawnTables, setDrawnTables, refsOf, onRef }) {
  const m = meta.get(b);
  const c = { n: m.h0, needle, at: cur };
  const mk = (s) => markString(s, c, refsOf, onRef);
  // Own strings first (they number the matches before the children's).
  const title = b.title ? mk(b.title) : null;
  const den = b.den ? mk(b.den) : null;
  const text = b.text ? mk(b.text) : null;
  const lines = b.lines ? b.lines.map((l, i) => <span key={i}>{mk(l)}</span>) : null;
  const segs = b.segs ? b.segs.map((s, i) => (s.type === 'table'
    ? <ActTable key={i} tkey={`t:${s.id}`} rows={s.rows} grid={s.grid} diagram={s.diagram} drawnTables={drawnTables} setDrawnTables={setDrawnTables} mk={mk} c={c} />
    : <pre className="lg-preline" key={i}>{s.rows.map((r, j) => <React.Fragment key={j}>{mk(r)}{j < s.rows.length - 1 ? '\n' : ''}</React.Fragment>)}</pre>)) : null;
  const kids = (b.children || []).map((k, i) => {
    const km = meta.get(k);
    if (!km || km.i >= cut) return null;
    return (
      <ActNode
        key={i} b={k} meta={meta} needle={needle}
        cur={cur >= km.h0 && cur < km.hEnd ? cur : -1}
        cut={km.end > cut ? cut : Infinity}
        drawnTables={drawnTables} setDrawnTables={setDrawnTables} refsOf={refsOf} onRef={onRef}
      />
    );
  });
  switch (b.kind) {
    case 'par': {
      const amend = /^\(la \d/.test(b.text || '');
      if (b.list) {
        return (
          <div className={`lg-li is-${b.list}`} style={b.indent ? { '--li-indent': b.indent } : undefined}>
            {title ? <span className="lg-para-num">{title}</span> : null}
            <div className="lg-inner">
              {text ? <p className="lg-para">{text}</p> : null}
              {kids}
            </div>
          </div>
        );
      }
      return <>{text ? <p className={`lg-para${amend ? ' lg-amend' : ''}`}>{text}</p> : null}{kids}</>;
    }
    case 'art':
      return (
        <section className="lg-art">
          <h3 className="lg-art-label">{title}{den ? <span className="lg-art-den"> {den}</span> : null}</h3>
          {text ? <p className="lg-para">{text}</p> : null}
          {kids}
        </section>
      );
    case 'aln':
    case 'lit':
    case 'pct':
      return (
        <div className={`lg-${b.kind}`}>
          <span className="lg-para-num">{title}</span>
          <div className="lg-inner">
            {text ? <p className="lg-para">{text}</p> : null}
            {kids}
          </div>
        </div>
      );
    case 'cit':
      return <blockquote className="lg-cit">{kids}</blockquote>;
    case 'nta':
      return <p className="lg-actnote">{title ? <b>{title} </b> : null}{text}{kids}</p>;
    case 'smn':
      return <div className="lg-smn">{lines}</div>;
    case 'pre':
      return <div className="lg-pre">{segs}</div>;
    default: {
      const level = UNIT_LEVEL_OF[b.tag] || 3;
      return (
        <section className={`lg-unitsec is-${b.tag || 'unit'}`}>
          {title || den ? <h2 className={`lg-unit is-l${level}`}>{title}{den ? <span className="lg-unit-den"> {den}</span> : null}</h2> : null}
          {text ? <p className="lg-para">{text}</p> : null}
          {kids}
        </section>
      );
    }
  }
}, sameNode);

// One block of the plain text's shape (while the page is not in, or cannot be had).
const samePlain = (a, b) => a.b === b.b && a.needle === b.needle && a.cur === b.cur && a.h0 === b.h0
  && a.drawnTables === b.drawnTables && a.refsOf === b.refsOf && a.grid === b.grid && a.diagram === b.diagram;
const PlainBlock = React.memo(function PlainBlock({ b, i, h0, needle, cur, grid, diagram, drawnTables, setDrawnTables, refsOf, onRef }) {
  const c = { n: h0, needle, at: cur };
  const mk = (s) => markString(s, c, refsOf, onRef);
  if (b.kind === 'unit') return <h2 className={`lg-unit is-l${b.level}`}>{mk(b.text)}</h2>;
  if (b.kind === 'note') return <p className="lg-actnote">{mk(b.text)}</p>;
  if (b.kind === 'table') return <ActTable tkey={i} rows={b.rows} grid={grid} diagram={diagram} drawnTables={drawnTables} setDrawnTables={setDrawnTables} mk={mk} c={c} />;
  if (b.kind === 'article') {
    const label = mk(b.label);
    return (
      <section className="lg-art">
        <h3 className="lg-art-label">{label}</h3>
        {b.body.map((p, j) => (
          <p className="lg-para" key={j}>
            {p.num ? <span className="lg-para-num">({p.num})</span> : null}
            {mk(p.text)}
          </p>
        ))}
      </section>
    );
  }
  return <>{b.body.map((p, j) => <p className="lg-para" key={j}>{mk(p.text)}</p>)}</>;
}, samePlain);

// A spinner with a line of text, shown only once something has taken longer
// than `delay` (a quick answer shows no spinner at all).
export function LoadingNote({ children, delay = 180, className = '' }) {
  const [on, setOn] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) return undefined;
    const id = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(id);
  }, [delay]);
  if (!on) return null;
  return (
    <p className={`lg-loading${className ? ` ${className}` : ''}`} role="status">
      <span className="lg-spinner" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function ActBody({ tree, blocks, grids, diagrams, needle, at, drawnTables, setDrawnTables, refsOf, onRef, skipScrollRef, contentKey }) {
  const bodyRef = useRef(null);
  // The strings each node holds, numbered as the find counts them.
  const plainText = (b, i) => (b.kind === 'table'
    ? (drawnTables.has(i) || (!grids[i] && !diagrams[i]) ? b.rows : diagrams[i] ? diagramStrings(diagrams[i]) : grids[i].rows.flat().flatMap((c) => c.lines || [c.text]))
    : [b.text || b.label || '', ...(b.body || []).map((p) => p.text)]);
  const layout = useMemo(() => {
    if (tree) {
      const meta = new Map(); let i = 0; let h = 0;
      const drawn = (id) => drawnTables.has(`t:${id}`);
      const visit = (b) => {
        const m = { i: i++, h0: h, end: 0, hEnd: 0 };
        meta.set(b, m);
        const own = [b.title, b.den, b.text, ...(b.lines || [])];
        for (const s of b.segs || []) {
          if (s.type !== 'table' || drawn(s.id) || (!s.grid && !s.diagram)) own.push(...s.rows);
          else if (s.diagram) own.push(...diagramStrings(s.diagram));
          else own.push(...s.grid.rows.flat().flatMap((c) => c.lines || [c.text]));
        }
        for (const s of own) h += countHits(s, needle);
        (b.children || []).forEach(visit);
        m.end = i; m.hEnd = h;
      };
      tree.blocks.forEach(visit);
      return { meta, count: i };
    }
    const starts = []; let h = 0;
    blocks.forEach((b, i) => { starts.push(h); for (const s of plainText(b, i)) h += countHits(s, needle); starts.push(h); });
    return { starts, count: blocks.length };
  }, [tree, blocks, grids, diagrams, needle, drawnTables]); // eslint-disable-line react-hooks/exhaustive-deps

  // THE REVEAL: a slice at once, the rest in transitions.
  const [prog, setProg] = useState({ key: contentKey, n: FIRST_NODES });
  const limit = prog.key === contentKey ? prog.n : FIRST_NODES;
  const done = limit >= layout.count;
  useEffect(() => {
    if (done) return undefined;
    const step = needle ? STEP_NODES * 4 : STEP_NODES;
    const id = setTimeout(() => startTransition(() => setProg({ key: contentKey, n: limit + step })), 16);
    return () => clearTimeout(id);
  }, [contentKey, limit, done, needle]);

  // The current match to the middle of the window — once it is drawn (the
  // reveal may still be on its way to it). After a switch between the rail's
  // items the page stays at the top until the find is used again.
  useEffect(() => {
    if (!needle || at < 0 || skipScrollRef.current) return;
    const el = bodyRef.current?.querySelector('.lg-hit.is-current');
    el?.scrollIntoView?.({ block: 'center', behavior: document.documentElement.dataset.reduceMotion === 'true' ? 'auto' : 'smooth' });
  }, [needle, at, done]); // eslint-disable-line react-hooks/exhaustive-deps

  let nodes;
  if (tree) {
    const { meta } = layout;
    nodes = tree.blocks.map((b, i) => {
      const m = meta.get(b);
      if (m.i >= limit) return null;
      return (
        <ActNode
          key={i} b={b} meta={meta} needle={needle}
          cur={at >= m.h0 && at < m.hEnd ? at : -1}
          cut={m.end > limit ? limit : Infinity}
          drawnTables={drawnTables} setDrawnTables={setDrawnTables} refsOf={refsOf} onRef={onRef}
        />
      );
    });
  } else {
    const { starts } = layout;
    nodes = blocks.slice(0, limit).map((b, i) => {
      const h0 = starts[i * 2]; const hEnd = starts[i * 2 + 1];
      return (
        <PlainBlock
          key={i} b={b} i={i} h0={h0} needle={needle}
          cur={at >= h0 && at < hEnd ? at : -1}
          grid={grids[i]} diagram={diagrams[i]}
          drawnTables={drawnTables} setDrawnTables={setDrawnTables} refsOf={refsOf} onRef={onRef}
        />
      );
    });
  }
  return (
    <div className={`lg-body${tree ? ' is-tree' : ''}`} ref={bodyRef}>
      {nodes}
      {!done ? <LoadingNote delay={120} className="is-foot">Laying out the rest of the act…</LoadingNote> : null}
    </div>
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
  // `fresh`: the portal's page first (an act just read live); otherwise the
  // copy on disk first. `force` skips the session's memory (a sync). A page
  // this session already has is put up in the same frame.
  // The page arrives in a TRANSITION, parsed first while the window is idle
  // (parseActHtml keeps the tree), so laying a long act out never cuts into
  // typing or scrolling; the plain text is on screen meanwhile.
  const [pageLoading, setPageLoading] = useState(false);
  const fetchPage = useCallback((rec, fresh, force = false) => {
    const mine = ++pageSeq.current;
    const now = !force && peekActPage(rec?.id);
    setActHtml(now || '');
    setPageLoading(!now);
    if (now) return;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
    loadActPage(rec, { fresh, force })
      .then((p) => {
        if (mine !== pageSeq.current) return;
        if (!p?.ok) { setPageLoading(false); return; }
        idle(() => {
          if (mine !== pageSeq.current) return;
          try { parseActHtml(p.html); } catch { /* drawn from the text instead */ }
          startTransition(() => { setActHtml(p.html); setPageLoading(false); });
        }, { timeout: 300 });
      })
      .catch(() => { if (mine === pageSeq.current) setPageLoading(false); });
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
  const skipFindScroll = useRef(false);   // after a switch: stay at the top until the find is used
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
    // The RESULTS SECTION is for a WORDS search. A search by the form alone
    // (Kind, Number, Year — typed, or filled by a citation) names an act, so
    // an answer that is one act — or several versions of one, the newest in
    // force being the one wanted — is OPENED, not listed; only an answer
    // that is several different acts (or none) is listed, since there is
    // nothing else to show it with. A fixed search that has words too is
    // opened AND listed.
    const words = !!(q.titlu || '').trim();
    const first = res.records[0];
    const oneAct = !!first && res.records.every((r) => r.numar === first.numar && r.tipAct === first.tipAct);
    const fixed = !!(q.tip && q.numar.trim() && q.an.trim());
    setResults(words || !oneAct ? res.records : null);
    setSource(res.source);
    setPortalError(res.portalError || '');
    setFound(res.mode ? { mode: res.mode, terms: res.terms || [] } : null);
    logSearch({ tip: q.tip, numar: q.numar, an: q.an, words: q.titlu, count: res.records.length, source: res.source });
    refreshLibrary();
    if (oneAct && (fixed || !words)) {
      // Through the ref: `open` is remade every render (it reads the
      // sessions), and this callback is not.
      openRef.current?.([...res.records].sort((x, y) => (y.dataVigoare || '').localeCompare(x.dataVigoare || ''))[0]);
      return { ...res, opened: true };
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
    // A row of the tabs' results page hands the record itself over
    // (lib/legalBrowser's handRecord): opened as it is, no search run.
    const handed = params.get('rid') ? takeRecord(params.get('rid')) : null;
    if (handed) {
      setParams({}, { replace: true });
      openRef.current?.(handed);
      return;
    }
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
    if (res?.opened) return true;          // `runNow` already opened it
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
  const EMPTY_READER = { act: null, actSource: '', actHtml: '', actSync: { state: '', live: null }, find: '', findAt: 0, drawn: [] };
  // No scroll position is kept: moving between the rail's items always
  // lands at the TOP of the page.
  const readerSnapshot = () => ({ act, actSource, actHtml, actSync, find, findAt, drawn: [...drawnTables] });
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
    setPageLoading(false);
    setActBusy(false); setActError('');
    setAct(s.act); setActSource(s.actSource); setActSync(s.actSync); setActHtml(s.actHtml);
    setFind(s.find); setFindAt(s.findAt); setDrawnTables(new Set(s.drawn || []));
    if (s.act?.text && !s.actHtml) fetchPage(s.act, false);
    // To the top, at once and again once the new content has laid out; the
    // restored find must not pull the page down to its match.
    skipFindScroll.current = true;
    const top = () => { const el = scroller(); if (el) el.scrollTop = 0; };
    top();
    requestAnimationFrame(() => requestAnimationFrame(top));
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
    fetchPage(res.act, res.source === 'live');
    logOpen(res.act);
    if (res.source === 'live') { await keepAct(res.act); refreshLibrary(); }
    { const el = scroller(); if (el) el.scrollTop = 0; }
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
    fetchPage(live, true, true);
    await keepAct(live); refreshLibrary();
  };

  // RELOAD (the tab's button, F5): the open act — and its page — asked of
  // the portal again, whatever this session or the copy has; with no act
  // open, the last search run again.
  const reload = async () => {
    if (act?.id) {
      const tabId = activeTabRef.current;
      const was = act;
      forgetLegislationSession({ id: was.id });
      const res = await fetchActLive(was);
      if (activeTabRef.current !== tabId) return;
      if (!res?.ok) { setActSync({ state: '', live: null }); return; }
      setAct(res.act); setActSource('live'); setActSync({ state: 'same', live: null });
      fetchPage(res.act, true, true);
      await keepAct(res.act); refreshLibrary();
      return;
    }
    if (results && hasQuery(query)) { forgetLegislationSession(); await runNow(query); }
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
  const step = (d) => { skipFindScroll.current = false; if (total) setFindAt((k) => (((k + d) % total) + total) % total); };
  // ── The references in the act, as controls ──
  // The tabs answer each other: what an act CITES is made pressable where it
  // stands — another act or a code (→ opened here, `followCitation`), a CAEN
  // code (→ the nomenclature in a modal, on that code), a court file number
  // (→ the Court files tab, on that file). The same detector as the Doc
  // Viewer's (lib/lawRefs). Found once per string and remembered for the act;
  // `refsOf` and `onRef` are STABLE, so the act's memoised nodes (ActBody)
  // are not redrawn for them.
  const refCache = useMemo(() => new Map(), [act?.id, actHtml]); // eslint-disable-line react-hooks/exhaustive-deps
  const refsOf = useCallback((str) => {
    let r = refCache.get(str);
    if (!r) {
      // An act is a control only when it fills the form whole (kind,
      // number, year — `fixedQueryOf`); the query is kept on the hit.
      r = findFollowableRefs(str).flatMap((h) => {
        if (h.kind !== 'act' && h.kind !== 'code') return [h];
        const q = legislationQueryFor(lawRefDetails(h));
        return q?.tip && q.numar && q.an ? [{ ...h, fixed: { tip: q.tip, numar: q.numar, an: q.an } }] : [];
      });
      refCache.set(str, r);
    }
    return r;
  }, [refCache]);
  const refActRef = useRef(null);
  refActRef.current = (h) => {
    if (h.kind === 'cui') navigate(`/anaf?cui=${encodeURIComponent(h.cui)}&_=${Date.now()}`);
    else if (h.kind === 'caen') setCaenModal({ code: h.codes[0], codes: h.codes, rev: h.rev || 0 });
    else if (h.kind === 'case') navigate(`/portal-just?nr=${encodeURIComponent(h.number)}`);
    else followCitation(h);
  };
  const onRef = useCallback((h) => refActRef.current?.(h), []);

  const head = act ? actHeading(act) : null;

  // ── The browser build has neither the service nor the archive ──────────
  if (!isElectron) {
    return (
      <div className="lws lg-page" ref={pageRef}>
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
    <LegalWorkspace
      className="lg-page"
      rootRef={pageRef}
      // The rail — one item per reading session, the active one lit;
      // Search (the mini header's, at the far left of its second line) is
      // the way back to the search and its results.
      items={tabs.map((t) => {
        const a = tabAct(t);
        const label = a ? actLabel(a) : 'Opening…';
        return {
          id: t.id,
          kind: a ? (a.tipAct || 'Act') : 'Opening…',
          title: a?.numar ? `nr. ${a.numar}${a.year ? `/${a.year}` : ''}` : '',
          tip: a?.title ? `${label} — ${a.title}` : label,
        };
      })}
      activeId={activeTab}
      onSelect={showTab}
      onClose={closeTab}
      onSearch={leaveToResults}
      onReload={reload}
      railLabel="Acts open in this tab"
      masthead={(
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
      )}
      // WITH AN ACT OPEN the mini header's second line is the act's: the
      // words box finds inside its text. The search itself — the bar and the
      // words box — is the Search item's (drawn at the head of the search
      // view, below). The status pill: where what is on show came from AND
      // the way out to the portal.
      bar={{
        status: (act ? actSource : results && source) ? (() => {
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
                  <span>{src === 'live' ? 'Live from legislatie.just.ro' : 'From your copy on this machine'}</span>
                  <span className="lgt-status-ico">{ExternalIcon}</span>
                </button>
              </Tooltip>
              {/* A kept act that differs from the portal's: Sync takes the
                  portal's version. */}
              {act && actSync.state === 'differs' ? (
                <Tooltip content="The portal's text has changed since this copy was kept — take the portal's">
                  <button type="button" className="lgt-status-pill is-differs" onClick={syncAct}>
                    <span>Differs from the portal - click to sync</span>
                  </button>
                </Tooltip>
              ) : null}
            </>
          );
        })() : null,
        // The act's FIND, Windows-style — the Doc Viewer's find bar: every
        // match lit as the words are typed, the position ("3/17", or "No
        // results") and the previous / next / clear buttons INSIDE the
        // field, Enter the next match, Shift+Enter the one before (Tab /
        // Shift+Tab too), Escape clears and leaves the field.
        search: act ? {
          value: find,
          placeholder: 'Find in this act',
          onChange: (v) => { skipFindScroll.current = false; setFind(v); setFindAt(0); },
          onKeyDown: (e) => {
            if (e.key === 'Tab' && needle) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          },
          find: { current: total ? at + 1 : 0, total, prev: () => step(-1), next: () => step(1) },
        } : null,
        noSearch: !act,
      }}
      // History — the shared button over this tab's log; a search entry
      // runs again, an act entry opens again; "Kept acts" in its head
      // forgets the archive's acts.
      history={{
        tab: 'legislation',
        tip: 'Every search run and every act opened, with the time',
        emptyText: 'Nothing yet. Every search you run and every act you open is listed here.',
        renderEntry: (e) => (e.kind === 'search' ? (
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
        )),
        onPick: (e) => {
          if (e.kind === 'search') {
            const q = { tip: e.tip || '', numar: e.numar || '', an: e.an || '', titlu: e.words || '', text: '' };
            setQuery(q); leaveToResults();
            run(q);
          } else if (e.rec) open(e.rec);
        },
        extra: (
          <Tooltip content={library.acts.length ? 'Forget every act kept whole on this machine' : 'No act is kept on this machine'}>
            <button type="button" className="lgt-tool-btn is-danger" disabled={!library.acts.length} onClick={async () => { await clearArchive(); refreshLibrary(); }}>
              <span className="lgt-tool-ico">{BinIcon}</span><span>Kept acts</span>
            </button>
          </Tooltip>
        ),
      }}
    >
      {act ? (
        // ── Reading one act ────────────────────────────────────────────
        <div className="lg-reader" ref={readerRef}>
          <article className="lg-act">
            <header className="lg-act-head">
              {/* The act's kind ("LEGE nr. 133/2026") with its actions on the
                  same line, at the right: Save offline (an act already kept
                  says nothing — the "Saved here" pill was removed) and On
                  the portal. */}
              <div className={`lg-act-kindrow${actTree?.head?.den ? ' is-float' : ''}`}>
                {/* The source head below names the act itself; the kind
                    line is only the record's, until the page arrives. Once
                    it has, the row takes no height of its own — Save offline
                    floats at the head's top right — so the act's name starts
                    right under the tab bar. */}
                {actTree?.head?.den ? <span /> : <div className="lg-act-kind">{head.label}</div>}
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
              {actTree?.head?.den ? (
                // The head AS THE PORTAL SETS IT: the act's name ("LEGE nr.
                // 134 din 1 iulie 2010 (republicată)" — its state in the
                // brackets set in bold), the title under it ("privind Codul
                // de procedură civilă"), then the issuer and the gazette as
                // label / value rows ("EMITENT  PARLAMENTUL", "Publicat în
                // MONITORUL OFICIAL nr. 247 din 10 aprilie 2015").
                <div className="lg-src-head">
                  <h1 className="lg-src-den">{denParts(actTree.head.den)}</h1>
                  {actTree.head.hdr ? <p className="lg-src-hdr">{actTree.head.hdr}</p> : null}
                  {actTree.head.meta.length ? (
                    <dl className="lg-src-meta">
                      {actTree.head.meta.map((m, i) => (
                        <div className={`lg-src-metarow${/^emitent/i.test(m.label) ? ' is-emt' : ''}`} key={i}>
                          <dt>{m.label}</dt>
                          <dd>{m.text}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
              ) : (
                <>
                  <h1 className="lg-act-title">{head.title}</h1>
                  <div className="lg-act-meta">
                    {head.issued ? <span>din {head.issued}</span> : null}
                    {head.emitent ? <span>{head.emitent}</span> : null}
                    {head.publicatie ? <span>{head.publicatie}</span> : null}
                    {head.inForce ? <span>în vigoare {head.inForce}</span> : null}
                    {head.republished ? <span className="lg-tag">republicată</span> : null}
                  </div>
                </>
              )}
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

            {actBusy ? <LoadingNote>Reading the act…</LoadingNote> : null}
            {!actBusy && act.text && !actHtml && pageLoading ? <LoadingNote delay={400}>Getting the portal’s layout — the text is below meanwhile…</LoadingNote> : null}
            {actError ? <p className="lg-note is-bad">{actError}</p> : null}
            {!actBusy && !actError && !act.text ? <p className="lg-note">This act has no text.</p> : null}
            {needle && act.text && !total ? (
              <p className="lg-note">Nothing in this act matches “{find.trim()}”.</p>
            ) : null}

            {act.text ? (
              <ActBody
                tree={actTree} blocks={blocks} grids={grids} diagrams={diagrams}
                needle={needle} at={total ? at : -1}
                drawnTables={drawnTables} setDrawnTables={setDrawnTables}
                refsOf={refsOf} onRef={onRef} skipScrollRef={skipFindScroll}
                contentKey={`${act.id}|${actTree ? 'tree' : 'text'}|${act.text.length}`}
              />
            ) : null}
          </article>
        </div>
      ) : (
        // ── Searching ──────────────────────────────────────────────────
        <div className="lg-main">
          {/* The SEARCH ITEM. Before anything is asked it is the tabs'
              EMPTY STATE (the placeholder tabs' and the Doc Viewer advisor's:
              a bare thin-stroke mark, a title, a line of muted text, centred)
              inviting a search, with the two ways to make one side by side —
              BY NUMBER (the bar: the dice, Kind, Number, Year, Search — a
              fixed search opens its act) or BY WORDS (the words box, Ctrl/⌘+F
              — title words, then the text, then the AI's suggestions).
              Once there is an answer the same fields stand as one compact row
              over it. Either way: Clear, and what the bar has to say about the
              last press — an empty form, a dead portal, a dice that drew
              nothing. */}
          {(() => {
            const formBar = (
              <LegalBar onSubmit={onSubmit}>
                <Tooltip content="A random act — a number and a year drawn at random">
                  <BarDice label="Search a random act" onClick={randomAct} disabled={busy} />
                </Tooltip>
                <BarPicker label="Kind of act" options={LEGIS_TYPES} value={query.tip} onChange={(v) => setQuery((q) => ({ ...q, tip: v }))} />
                <BarInput size="num" aria-label="Number" value={query.numar} onChange={set('numar')} placeholder="Number" inputMode="numeric" />
                <BarInput size="num" aria-label="Year" value={query.an} onChange={set('an')} placeholder="Year" inputMode="numeric" />
                <BarGo busy={busy}>Search</BarGo>
              </LegalBar>
            );
            const wordsBox = (
              <LegalSearchBox
                className="lg-words"
                search={{
                  value: query.titlu,
                  placeholder: 'Any words',
                  onChange: (v) => setQuery((q) => ({ ...q, titlu: v })),
                  onSubmit: () => { leaveToResults(); run(query); },
                }}
              />
            );
            const clearBtn = (
              <Tooltip content="Clear the search — the fields and the results">
                <button
                  type="button"
                  className="lgt-tool-btn"
                  disabled={!hasQuery(query) && !query.tip && !results && !error}
                  onClick={() => {
                    ++seq.current;
                    setQuery({ tip: '', numar: '', an: '', titlu: '', text: '' });
                    setResults(null); setFound(null); setError(''); setPortalError(''); setBusy(false);
                  }}
                >
                  <span className="lgt-tool-ico">{ClearIcon}</span><span>Clear</span>
                </button>
              </Tooltip>
            );
            const note = error ? <span className="lg-warn lg-barnote">{error}</span> : null;
            return (
              <WorkspaceSearch
                asked={!!results}
                title="Search Romanian legislation"
                sub="Look an act up by its kind, number and year, or find it by words from its title or text. Every act you open stays in the list on the left."
                modes={[
                  { id: 'number', label: 'By number', hint: 'Kind, number and year open the act straight away.', node: formBar },
                  { id: 'words', label: 'By words', hint: 'Title words first, then the text of the acts. Press Enter to search.', node: wordsBox },
                ]}
                foot={<>{clearBtn}{note}</>}
              />
            );
          })()}
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
      <CaenModal open={caenModal} onClose={closeCaen} />
    </LegalWorkspace>
  );
}
