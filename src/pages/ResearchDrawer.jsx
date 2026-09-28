import React, { useEffect, useRef, useState } from 'react';
import SideDrawer from '../components/SideDrawer';
// The drawer also opens APP-WIDE (components/LawDetect, a legislation
// reference pressed anywhere), outside the Research page: it carries the
// stylesheets its views are drawn with.
import './Legislation.css';
import '../components/LegalBrowser.css';
import './Research.css';
import { takeRecord, PLATFORMS } from '../lib/legalBrowser';

// RESEARCH'S DRAWER — everything Research opens, it opens HERE, in the shared
// SIDE DRAWER (components/SideDrawer, sliding in from the right): the whole act,
// a court file, a company, a CAEN code, every result of a search. Research
// never sends the reader to another tab.
//
// A VIEW is one of:
//   { type: 'act', row? | q?, label }   — an act: the search row that found it
//                                          (its handed record, `rid`), or a
//                                          query { tip, numar, an, titlu }
//   { type: 'file', row }               — a court file (portal.just.ro)
//   { type: 'company', row }            — a company (anaf.ro)
//   { type: 'caen', row | code }        — a CAEN code (insse.ro)
//   { type: 'results', legal }          — every result of a search
// The drawer keeps a stack: opening from inside it goes one deeper, Back
// returns.

import { withTimeout, paramsOf, viewForRow, findAct, recordText } from '../lib/portalRecords';

// The record helpers live in lib/portalRecords (the AI engine reads the
// portals through them too); re-exported for the page.
export { viewForRow, findAct, recordText };

function Loading({ children }) {
  return <p className="lg-loading rs-drawer-note" role="status"><span className="lg-spinner" aria-hidden="true" /><span>{children}</span></p>;
}

function ActView({ view }) {
  const [state, setState] = useState({ loading: true });
  const [n, setN] = useState(80);
  useEffect(() => {
    let dead = false;
    setState({ loading: true });
    setN(80);
    findAct(view).then((r) => { if (!dead) setState(r || { error: 'The act could not be read.' }); }, (e) => { if (!dead) setState({ error: e?.message || 'The act could not be read.' }); });
    return () => { dead = true; };
  }, [view]);
  // A long act is drawn in slices, so opening it never stalls the window.
  const total = state.blocks?.length || 0;
  useEffect(() => {
    if (!total || n >= total) return undefined;
    const t = setTimeout(() => setN((x) => x + 240), 30);
    return () => clearTimeout(t);
  }, [n, total]);
  if (state.loading) return <Loading>Reading the act…</Loading>;
  if (state.error) return <p className="rs-drawer-note is-bad">{state.error}</p>;
  const { head, blocks, source } = state;
  return (
    <article className="lg-act rs-drawer-act">
      <header className="lg-act-head">
        <div className="lg-act-kindrow"><div className="lg-act-kind">{head.label}</div></div>
        <h1 className="lg-act-title">{head.title}</h1>
        <div className="lg-act-meta">
          {head.issued ? <span>din {head.issued}</span> : null}
          {head.emitent ? <span>{head.emitent}</span> : null}
          {head.publicatie ? <span>{head.publicatie}</span> : null}
          {head.inForce ? <span>în vigoare {head.inForce}</span> : null}
          {head.republished ? <span className="lg-tag">republicată</span> : null}
          {source === 'archive' ? <span className="lg-tag">from your copy on this machine</span> : null}
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
      <div className="lg-body">
        {blocks.slice(0, n).map((b, i) => {
          // eslint-disable-next-line react/no-array-index-key
          if (b.kind === 'unit') return <h2 key={i} className={`lg-unit is-l${b.level}`}>{b.text}</h2>;
          // eslint-disable-next-line react/no-array-index-key
          if (b.kind === 'note') return <p key={i} className="lg-actnote">{b.text}</p>;
          // eslint-disable-next-line react/no-array-index-key
          if (b.kind === 'table') return <pre key={i} className="lg-table rs-drawer-table">{(b.rows || []).join('\n')}</pre>;
          if (b.kind === 'article') {
            return (
              // eslint-disable-next-line react/no-array-index-key
              <section key={i} className="lg-art">
                <h3 className="lg-art-label">{b.label}</h3>
                {/* eslint-disable-next-line react/no-array-index-key */}
                {b.body.map((p, j) => <p className="lg-para" key={j}>{p.num ? <span className="lg-para-num">({p.num})</span> : null}{p.text}</p>)}
              </section>
            );
          }
          // eslint-disable-next-line react/no-array-index-key
          return <React.Fragment key={i}>{(b.body || []).map((p, j) => <p className="lg-para" key={j}>{p.text}</p>)}</React.Fragment>;
        })}
      </div>
      {n < total ? <Loading>Laying out the rest of the act…</Loading> : null}
    </article>
  );
}

// ── A court file ──
function FileView({ view }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let dead = false;
    (async () => {
      const C = await import('../lib/courts');
      const p = paramsOf(view.row?.page?.url);
      let rec = p.get('rid') ? takeRecord(p.get('rid')) : null;
      if (!rec && p.get('nr')) {
        const res = await withTimeout(C.searchCasesKept({ numar: p.get('nr') }), 20_000);
        rec = res?.ok ? (res.dosare || [])[0] || null : null;
      }
      if (!dead) setState(rec ? { rec, C } : { error: 'The court file could not be read from portal.just.ro.' });
    })().catch((e) => { if (!dead) setState({ error: e?.message || 'The court file could not be read.' }); });
    return () => { dead = true; };
  }, [view]);
  if (state.loading) return <Loading>Reading the court file…</Loading>;
  if (state.error) return <p className="rs-drawer-note is-bad">{state.error}</p>;
  const { rec, C } = state;
  return (
    <div className="rs-rec">
      <p className="rs-rec-kind" style={{ color: PLATFORMS['portal-just'].tone }}>{C.courtLabel(rec.institutie)}{rec.departament ? ` · ${rec.departament}` : ''}</p>
      <h1 className="rs-rec-title">Dosar {rec.numar}</h1>
      <dl className="rs-rec-facts">
        {rec.obiect ? <><dt>Object</dt><dd>{rec.obiect}</dd></> : null}
        {rec.categorie ? <><dt>Category</dt><dd>{rec.categorie}</dd></> : null}
        {rec.stadiu ? <><dt>Stage</dt><dd>{rec.stadiu}</dd></> : null}
      </dl>
      {C.partiesByRole(rec).length ? (
        <section className="rs-rec-sec">
          <h2 className="rs-rec-h">Parties</h2>
          <dl className="rs-rec-facts">
            {C.partiesByRole(rec).map((g) => <React.Fragment key={g.role}><dt>{g.role}</dt><dd>{g.names.join(', ')}</dd></React.Fragment>)}
          </dl>
        </section>
      ) : null}
      {(rec.sedinte || []).length ? (
        <section className="rs-rec-sec">
          <h2 className="rs-rec-h">Hearings</h2>
          <ul className="rs-rec-list">
            {C.hearingsSorted(rec).map((s, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}>
                <span className="rs-rec-when">{C.fmtDate(s.data)}{s.ora ? ` ${s.ora}` : ''}{s.complet ? ` · ${s.complet}` : ''}</span>
                {s.solutie ? <span className="rs-rec-sol">{s.solutie}</span> : <span className="rs-rec-sol is-muted">No solution yet</span>}
                {s.solutieSumar ? <span className="rs-rec-sum">{s.solutieSumar}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ── A company ──
function CompanyView({ view }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let dead = false;
    (async () => {
      const A = await import('../lib/anaf');
      const cui = paramsOf(view.row?.page?.url).get('cui');
      const res = cui ? await withTimeout(A.lookupCompaniesKept(cui), 20_000) : null;
      const c = res?.ok ? res.companies?.[0] : null;
      if (!dead) setState(c ? { c, source: res.source } : { error: 'The company could not be read from anaf.ro.' });
    })().catch((e) => { if (!dead) setState({ error: e?.message || 'The company could not be read.' }); });
    return () => { dead = true; };
  }, [view]);
  if (state.loading) return <Loading>Reading the company from ANAF…</Loading>;
  if (state.error) return <p className="rs-drawer-note is-bad">{state.error}</p>;
  const { c } = state;
  const hq = typeof c.hq === 'string' ? c.hq : (c.address || '');
  const rows = [
    ['CUI', `${c.vat?.registered ? 'RO' : ''}${c.cui}`],
    ['Trade register', c.regCom],
    ['Registered office', hq],
    ['Legal form', c.legalForm],
    ['Registered', c.registered],
    ['Status', c.registration],
    ['Main CAEN', c.caen],
    ['VAT payer', c.vat?.registered ? 'Yes' : 'No'],
    ['VAT on collection', c.vatCash?.on ? 'Yes' : 'No'],
    ['Inactive', c.inactive?.on ? `Yes${c.inactive.since ? `, since ${c.inactive.since}` : ''}` : 'No'],
    ['e-Factura', c.eFactura ? `Yes${c.eFacturaSince ? `, since ${c.eFacturaSince}` : ''}` : 'No'],
    ['Phone', c.phone],
    ['Fiscal office', c.fiscalOrgan],
  ].filter(([, v]) => v);
  return (
    <div className="rs-rec">
      <p className="rs-rec-kind" style={{ color: PLATFORMS.anaf.tone }}>anaf.ro{c.asOf ? ` · as of ${c.asOf}` : ''}{state.source === 'archive' ? ' · from your copy on this machine' : ''}</p>
      <h1 className="rs-rec-title">{c.name || `CUI ${c.cui}`}</h1>
      <dl className="rs-rec-facts">
        {rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
      </dl>
    </div>
  );
}

// ── A CAEN code ──
function CaenView({ view, onOpen }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let dead = false;
    (async () => {
      const K = await import('../lib/caen');
      const data = await K.loadCaen();
      const code = view.code || paramsOf(view.row?.page?.url).get('code') || '';
      const entry = K.caenEntry(data, code);
      if (!dead) setState(entry ? { entry, kids: K.caenChildren(data, entry.code), K } : { error: 'That CAEN code is not in Rev. 3.' });
    })().catch((e) => { if (!dead) setState({ error: e?.message || 'The CAEN code could not be read.' }); });
    return () => { dead = true; };
  }, [view]);
  if (state.loading) return <Loading>Reading the CAEN code…</Loading>;
  if (state.error) return <p className="rs-drawer-note is-bad">{state.error}</p>;
  const { entry, kids, K } = state;
  const name = (s) => (K.sentenceCase ? K.sentenceCase(s) : s);
  return (
    <div className="rs-rec">
      <p className="rs-rec-kind" style={{ color: PLATFORMS.caen.tone }}>insse.ro · CAEN Rev. 3</p>
      <h1 className="rs-rec-title">{entry.code} — {name(entry.name)}</h1>
      {entry.path.length ? (
        <div className="rs-rec-path">
          {entry.path.map((p) => (
            <button key={p.code} type="button" className="rs-rec-chip" onClick={() => onOpen({ type: 'caen', code: p.code, label: p.code })}>{p.code} {name(p.name)}</button>
          ))}
        </div>
      ) : null}
      {kids.length ? (
        <section className="rs-rec-sec">
          <h2 className="rs-rec-h">In it</h2>
          <ul className="rs-rec-list">
            {kids.map((k) => (
              <li key={k.code}><button type="button" className="rs-rec-link" onClick={() => onOpen({ type: 'caen', code: k.code, label: k.code })}><b>{k.code}</b> {name(k.name)}</button></li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ── Every result of a search ──
function ResultsView({ view, onOpen }) {
  const { legal } = view;
  const plats = (legal?.plats || []).filter((p) => legal.answers?.[p]);
  if (!plats.length) return <p className="rs-drawer-note">Nothing was found.</p>;
  return (
    <div className="lgb-serp rs-serp">
      {plats.map((p) => {
        const a = legal.answers[p];
        const pl = PLATFORMS[p];
        return (
          <section key={p} className="lgb-group">
            <div className="lgb-group-head">
              <span className="lgb-group-dot" style={{ '--tone': pl.tone }} />
              <span className="lgb-group-name">{pl.name}</span>
              <span className="lgb-group-meta">{pl.site} · {a.ok ? `${a.total} ${a.total === 1 ? 'result' : 'results'}${a.total > a.rows.length ? ` (${a.rows.length} kept)` : ''}` : 'did not answer'}</span>
            </div>
            {!a.ok ? <p className="lgb-empty">{pl.site} could not be reached.</p> : !a.rows.length ? <p className="lgb-empty">Nothing on {pl.site}.</p> : (
              <ul className="lgb-rows">
                {a.rows.map((r, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={i} className="lgb-row">
                    <button type="button" className="lgb-row-main" onClick={() => onOpen(viewForRow(r))}>
                      <span className="lgb-row-kind" style={{ color: pl.tone }}>{r.kind}</span>
                      <span className="lgb-row-title">{r.title}</span>
                      {r.meta?.length ? <span className="lgb-row-meta">{r.meta.map((m) => <span key={m}>{m}</span>)}</span> : null}
                    </button>
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

const TITLES = { act: 'Act', file: 'Court file', company: 'Company', caen: 'CAEN code', results: 'All results' };

export default function ResearchDrawer({ stack, onClose, onBack, onOpen, widthKey = 'docvex:research:drawer-w', keepOpenWithin = '.rs-page', ariaLabel = 'Research preview' }) {
  const view = stack[stack.length - 1] || null;
  // The last view stays drawn while the drawer slides out.
  const lastRef = useRef(null);
  if (view) lastRef.current = view;
  const shownView = view || lastRef.current;
  return (
    <SideDrawer
      open={stack.length > 0}
      onClose={onClose}
      onBack={stack.length > 1 ? onBack : null}
      title={shownView ? (TITLES[shownView.type] || '') : ''}
      subtitle={shownView?.label || ''}
      widthKey={widthKey}
      keepOpenWithin={keepOpenWithin}
      contentKey={shownView}
      ariaLabel={ariaLabel}
    >
      {!shownView ? null
        : shownView.type === 'act' ? <ActView view={shownView} />
          : shownView.type === 'file' ? <FileView view={shownView} />
            : shownView.type === 'company' ? <CompanyView view={shownView} />
              : shownView.type === 'caen' ? <CaenView view={shownView} onOpen={onOpen} />
                : shownView.type === 'results' ? <ResultsView view={shownView} onOpen={onOpen} />
                  : null}
    </SideDrawer>
  );
}
