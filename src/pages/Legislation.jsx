import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import './Legislation.css';
import PageMasthead from '../components/PageMasthead';
import Tooltip from '../components/Tooltip';
import { isElectron, openExternal } from '../lib/platform';
import {
  LEGIS_TYPES, searchLegislation, loadAct, keepAct, listArchive, forgetAct, clearArchive,
  parseActText, actHeading, actLabel, formatBytes, fold,
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
const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
  </svg>
);
const KeepIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v11" /><path d="M8 10.5l4 3.5 4-3.5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);
const KeptIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
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
const BinIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" />
  </svg>
);

const YEAR_NOW = new Date().getFullYear();

// A search worth running: the service needs SOMETHING, and an empty form would
// ask it for the whole of Romanian law.
const hasQuery = (q) => !!(q.numar.trim() || q.an.trim() || q.titlu.trim() || q.text.trim());

export default function Legislation() {
  const [query, setQuery] = useState({ tip: '', numar: '', an: '', titlu: '', text: '' });
  const [results, setResults] = useState(null);   // null = nothing asked yet
  const [source, setSource] = useState('');       // 'live' | 'archive'
  const [portalError, setPortalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [act, setAct] = useState(null);           // the act being read
  const [actBusy, setActBusy] = useState(false);
  const [actError, setActError] = useState('');
  const [library, setLibrary] = useState({ acts: [], bytes: 0 });
  const [showLibrary, setShowLibrary] = useState(false);
  const [find, setFind] = useState('');
  const readerRef = useRef(null);
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
  const runNow = useCallback(async (q) => {
    if (!hasQuery(q)) { setError('Give it a number, a year, or some words from the title.'); return null; }
    const mine = ++seq.current;
    setBusy(true); setError(''); setPortalError('');
    const res = await searchLegislation({ ...q, perPage: 30 });
    if (mine !== seq.current) return null;
    setBusy(false);
    if (!res?.ok) { setError('Nothing could be searched — the portal is unreachable and this machine has no copy yet.'); setResults([]); return null; }
    setResults(res.records);
    setSource(res.source);
    setPortalError(res.portalError || '');
    refreshLibrary();
    return res;
  }, [refreshLibrary]);
  const run = runNow;

  const onSubmit = (e) => { e.preventDefault(); run(query); };

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
    setAct(null);
    // The query is spent once it has been run: a later manual search must not
    // be undone by a back-navigation replaying the citation that started this.
    setParams({}, { replace: true });
    (async () => {
      const res = await runNow(q);
      if (params.get('open') !== '1' || !res?.records?.length) return;
      // Unambiguous means ONE act — or several versions of one act, in which
      // case the newest in force is the one a reader wants and the rest are its
      // history, reachable from the results by going back.
      const first = res.records[0];
      const same = res.records.every((r) => r.numar === first.numar && r.tipAct === first.tipAct);
      if (res.records.length === 1 || same) {
        const best = [...res.records].sort((a, b) => (b.dataVigoare || '').localeCompare(a.dataVigoare || ''))[0];
        open(best);
      }
    })();
    // `params` is the only real input; the rest are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Opening an act: the copy on disk first, the portal second (lib/legislation
  // decides), and whatever arrives is kept — so the second reading of anything
  // is always offline.
  const open = useCallback(async (rec) => {
    setActBusy(true); setActError(''); setAct(rec); setFind('');
    const res = await loadAct(rec);
    setActBusy(false);
    if (!res?.ok) {
      setActError(res?.error === 'not_kept' || res?.error === 'not_found'
        ? 'The portal could not be reached and this act has not been saved on this machine.'
        : 'The act could not be read.');
      return;
    }
    setAct(res.act);
    if (res.source === 'live') { await keepAct(res.act); refreshLibrary(); }
    readerRef.current?.scrollTo?.({ top: 0 });
  }, [refreshLibrary]);

  const blocks = useMemo(() => (act?.text ? parseActText(act.text) : []), [act?.text]);
  const needle = fold(find.trim());
  const shown = useMemo(() => (
    needle
      ? blocks.filter((b) => fold(b.text || b.label || '').includes(needle)
        || (b.body || []).some((p) => fold(p.text).includes(needle)))
      : blocks
  ), [blocks, needle]);

  const head = act ? actHeading(act) : null;

  // ── The browser build has neither the service nor the archive ──────────
  if (!isElectron) {
    return (
      <div className="lg-page">
        <PageMasthead eyebrow="Portalul legislativ" eyebrowMuted="România" title="Legislation" />
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
    <div className="lg-page">
      <PageMasthead
        eyebrow="Portalul legislativ"
        eyebrowMuted="legislatie.just.ro"
        title="Legislation"
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
        Romanian legislation, searched through the ministry’s own service and kept on this machine
        so it is still here when the portal is not.
      </PageMasthead>

      {act ? (
        // ── Reading one act ────────────────────────────────────────────
        <div className="lg-reader" ref={readerRef}>
          <div className="lg-reader-bar">
            <button type="button" className="lg-btn" onClick={() => { setAct(null); setActError(''); }}>
              <span className="lg-ico">{BackIcon}</span><span>Back to results</span>
            </button>
            <div className="lg-reader-tools">
              {act.text ? (
                <input
                  className="lg-input lg-find"
                  value={find}
                  placeholder="Find in this act"
                  aria-label="Find in this act"
                  onChange={(e) => setFind(e.target.value)}
                />
              ) : null}
              {kept.has(act.id) ? (
                <span className="lg-kept"><span className="lg-ico">{KeptIcon}</span>Saved here</span>
              ) : act.text ? (
                <Tooltip content="Keep the full text on this machine">
                  <button type="button" className="lg-btn" onClick={async () => { await keepAct(act); refreshLibrary(); }}>
                    <span className="lg-ico">{KeepIcon}</span><span>Save offline</span>
                  </button>
                </Tooltip>
              ) : null}
              {act.link ? (
                <Tooltip content="Open this act on the ministry’s portal">
                  <button type="button" className="lg-btn" onClick={() => openExternal(act.link)}>
                    <span className="lg-ico">{ExternalIcon}</span><span>On the portal</span>
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </div>

          <article className="lg-act">
            <header className="lg-act-head">
              <div className="lg-act-kind">{head.label}</div>
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
              <p className="lg-act-warn">
                Consolidated text from the legislative portal. Only the version printed in Monitorul
                Oficial is authentic — check it before relying on this in a filing.
              </p>
            </header>

            {actBusy ? <p className="lg-note">Reading…</p> : null}
            {actError ? <p className="lg-note is-bad">{actError}</p> : null}
            {!actBusy && !actError && !act.text ? <p className="lg-note">This act has no text.</p> : null}
            {needle && act.text ? (
              <p className="lg-note">
                {shown.length ? `${shown.length} of ${blocks.length} passages match “${find.trim()}”.` : `Nothing in this act matches “${find.trim()}”.`}
              </p>
            ) : null}

            <div className="lg-body">
              {shown.map((b, i) => {
                if (b.kind === 'unit') return <h2 className={`lg-unit is-l${b.level}`} key={i}>{b.text}</h2>;
                if (b.kind === 'note') return <p className="lg-actnote" key={i}>{b.text}</p>;
                if (b.kind === 'article') {
                  return (
                    <section className="lg-art" key={i}>
                      <h3 className="lg-art-label">{b.label}</h3>
                      {b.body.map((p, j) => (
                        <p className="lg-para" key={j}>
                          {p.num ? <span className="lg-para-num">({p.num})</span> : null}
                          {p.text}
                        </p>
                      ))}
                    </section>
                  );
                }
                return b.body.map((p, j) => <p className="lg-para" key={`${i}-${j}`}>{p.text}</p>);
              })}
            </div>
          </article>
        </div>
      ) : (
        // ── Searching ──────────────────────────────────────────────────
        <div className="lg-main">
          <form className="lg-form" onSubmit={onSubmit}>
            <div className="lg-field is-kind">
              <label htmlFor="lg-tip">Kind</label>
              <select id="lg-tip" className="lg-input" value={query.tip} onChange={set('tip')}>
                {LEGIS_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="lg-field is-num">
              <label htmlFor="lg-nr">Number</label>
              <input id="lg-nr" className="lg-input" value={query.numar} onChange={set('numar')} placeholder="24" inputMode="numeric" />
            </div>
            <div className="lg-field is-num">
              <label htmlFor="lg-an">Year</label>
              <input id="lg-an" className="lg-input" value={query.an} onChange={set('an')} placeholder={String(YEAR_NOW)} inputMode="numeric" />
            </div>
            <div className="lg-field is-wide">
              <label htmlFor="lg-titlu">Words in the title</label>
              <input id="lg-titlu" className="lg-input" value={query.titlu} onChange={set('titlu')} placeholder="normele de tehnică legislativă" />
            </div>
            <div className="lg-field is-wide">
              <label htmlFor="lg-text">Words anywhere in the text</label>
              <input id="lg-text" className="lg-input" value={query.text} onChange={set('text')} placeholder="contract de mandat" />
            </div>
            <button type="submit" className="lg-go" disabled={busy}>
              <span className="lg-ico">{SearchIcon}</span>
              <span>{busy ? 'Searching…' : 'Search'}</span>
            </button>
          </form>

          {/* The portal has no act-type filter, so a number and a year answer
              with every act of that number in force that year — the Kind
              picker is applied here, after the fact. Worth saying: it is why
              a search can come back with fewer rows than the portal found. */}
          <div className="lg-strip">
            <div className="lg-strip-left">
              {results && (
                <span className={`lg-source is-${source}`}>
                  {source === 'live' ? 'Live from the portal' : 'From your copy on this machine'}
                </span>
              )}
              {portalError ? (
                <span className="lg-warn">
                  The portal could not be reached{portalError === 'timeout' ? ' (it timed out)' : ''} — this is what you already had.
                </span>
              ) : null}
              {error ? <span className="lg-warn">{error}</span> : null}
            </div>
            <button type="button" className={`lg-btn${showLibrary ? ' is-on' : ''}`} onClick={() => setShowLibrary((v) => !v)}>
              <span className="lg-ico">{LibraryIcon}</span>
              <span>Offline library{library.acts.length ? ` · ${library.acts.length}` : ''}</span>
            </button>
          </div>

          {showLibrary ? (
            <section className="lg-lib">
              <header className="lg-lib-head">
                <div>
                  <p className="lg-lib-title">What this machine keeps</p>
                  <p className="lg-lib-sub">
                    Every act you have opened, saved whole; every result you have seen, indexed by its
                    details. With the portal down, a search runs against this.
                  </p>
                </div>
                {library.acts.length ? (
                  <button
                    type="button"
                    className="lg-btn is-danger"
                    onClick={async () => { await clearArchive(); refreshLibrary(); }}
                  >
                    <span className="lg-ico">{BinIcon}</span><span>Empty it</span>
                  </button>
                ) : null}
              </header>
              {library.acts.length ? (
                <ul className="lg-lib-list">
                  {library.acts.slice(0, 200).map((a) => (
                    <li className="lg-lib-row" key={a.id}>
                      <button type="button" className="lg-lib-open" onClick={() => open(a)}>
                        <span className="lg-lib-kind">{actLabel(a)}</span>
                        <span className="lg-lib-name">{a.titlu}</span>
                      </button>
                      <span className={`lg-lib-state${a.hasText ? ' is-full' : ''}`}>
                        {a.hasText ? `full text · ${formatBytes(a.chars)}` : 'details only'}
                      </span>
                      <Tooltip content="Forget this act on this machine">
                        <button type="button" className="lg-icobtn" aria-label={`Forget ${actLabel(a)}`} onClick={async () => { await forgetAct(a.id); refreshLibrary(); }}>
                          {BinIcon}
                        </button>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="lg-note">Nothing kept yet. Open an act and it stays.</p>
              )}
            </section>
          ) : null}

          {results && !results.length && !busy ? (
            <p className="lg-note">
              {source === 'archive'
                ? 'Nothing on this machine matches. With the portal back, the same search will reach all of it.'
                : 'The portal found nothing for that.'}
            </p>
          ) : null}

          <ul className="lg-results">
            {(results || []).map((r) => (
              <li className="lg-row" key={r.id || r.titlu}>
                <button type="button" className="lg-row-main" onClick={() => open(r)}>
                  <span className="lg-row-kind">
                    {r.tipAct}{r.numar ? ` nr. ${r.numar}` : ''}{r.year ? `/${r.year}` : ''}
                  </span>
                  <span className="lg-row-title">{r.title}</span>
                  <span className="lg-row-meta">
                    {r.emitent ? <span>{r.emitent}</span> : null}
                    {r.publicatie ? <span>{r.publicatie}</span> : null}
                    {r.dataVigoare ? <span>în vigoare {r.dataVigoare}</span> : null}
                    {r.republished ? <span className="lg-tag">republicată</span> : null}
                    {kept.get(r.id)?.hasText ? <span className="lg-tag is-kept">saved here</span> : null}
                  </span>
                </button>
                {r.link ? (
                  <Tooltip content="Open on the ministry’s portal">
                    <button type="button" className="lg-icobtn" aria-label="Open on the portal" onClick={() => openExternal(r.link)}>
                      {ExternalIcon}
                    </button>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
