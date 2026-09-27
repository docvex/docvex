import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './Anaf.css';
import PageMasthead from '../components/PageMasthead';
import LegalTabs, { LegalSearchBox } from '../components/LegalTabs';
import LegalWorkspace, { WorkspaceSearch, WorkspaceClear, SourceStatus, KeptFigures } from '../components/LegalWorkspace';
import { BinIcon } from '../components/HistoryMenu';
import { LegalBar, BarDice, BarNote, BarGo } from '../components/LegalBar';
import Tooltip from '../components/Tooltip';
import { isElectron } from '../lib/platform';
import { recallPage, usePageMemory } from '../lib/pageMemory';
import { logHistory } from '../lib/tabHistory';
import CaenModal from '../components/CaenModal';
import {
  lookupCompanies, lookupCompaniesKept, checkCompany, keptStats, clearKept, onKeptChange, parseCuis, fmtDate, ANAF_MAX, companyBilant, euidOf, longDate, ageOf } from '../lib/anaf';
import MapDrawer, { PinIcon } from '../components/MapDrawer';

// ANAF — a company's fiscal record, in the app.
//
// The one question a contract turns on before it is signed: who is this
// company, is it registered, is it a VAT payer, has it been declared inactive.
// ANAF's public service answers all of it for a CUI, as of today, and this
// page asks it — for one CUI or a list pasted from a spreadsheet (up to 100
// in one go). Desktop only: the service sends no CORS headers, so main.js
// makes the call (`anaf:lookup`). A CAEN code in the answer opens in the CAEN
// tab.
//
// As the Legislation tab keeps its acts, this tab keeps every company ANAF
// describes (lib/anaf → lib/sourceCache). ANAF is asked first; when it cannot
// be reached a lookup is answered from the copy for the CUIs it holds, and
// the pill in the tab bar says which. A company opened from the copy is
// checked against ANAF in the background — "Differs from ANAF · Sync".
//
// `?cui=…` looks a company up straight away (the identity record links here).

const CopyIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </svg>
);
const CheckIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
// A gavel — the Court files tab.
const GavelIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4l6 6" /><path d="M11 7l6 6" /><path d="M13 9l-9 9" /><path d="M4 20h9" />
  </svg>
);

const ERRORS = {
  unreachable: 'ANAF could not be reached — check the connection and try again.',
  timeout: 'ANAF took too long to answer.',
  stale_app: 'This window is newer than the app running behind it — restart Docvex (npm start) to load the ANAF lookup.',
  rate_limited: 'ANAF allows one request a second — wait a moment and try again.',
  empty_query: 'Give it a CUI (the fiscal code, with or without RO).',
  bad_answer: 'ANAF answered with something this app could not read.',
};
const errorText = (code) => ERRORS[code] || (String(code || '').startsWith('http_') ? `ANAF answered with an error (${code.slice(5)}).` : 'The lookup failed.');

export default function Anaf() {
  // What the page had on it when it was last left (lib/pageMemory).
  const saved = recallPage('anaf');
  const [text, setText] = useState(saved?.text || '');
  const [answer, setAnswer] = useState(saved?.answer ?? null);     // { asOf, companies, notFound } | null
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(saved?.error || '');
  // The companies OPEN, one rail item each (components/LegalWorkspace), and
  // the one on show — null = the lookup and its answer.
  const [open, setOpenList] = useState(saved?.open || []);          // [{ id, c, from: 'live' | 'archive' }]
  const [activeCo, setActiveCo] = useState(saved?.activeCo ?? null);
  const shownEntry = open.find((o) => o.id === activeCo) || null;
  const shown = shownEntry?.c || null;
  // Where the last answer came from, and why the copy answered it.
  const [source, setSource] = useState(saved?.source || '');           // 'live' | 'archive'
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const [portalError, setPortalError] = useState(saved?.portalError || '');
  // Whether a company kept here is what ANAF says now: { [id]: { state, live } }.
  const [sync, setSync] = useState({});
  const [kept, setKept] = useState(keptStats);
  useEffect(() => onKeptChange(() => setKept(keptStats())), []);
  // Opening a company: the one already open is switched to (with ANAF's
  // latest answer for it), anything else becomes a new item in the rail.
  // A company from the copy is checked against ANAF in the background.
  const openCompany = useCallback((c) => {
    const id = String(c.cui);
    const from = sourceRef.current || 'live';
    setOpenList((list) => (list.some((o) => o.id === id) ? list.map((o) => (o.id === id ? { id, c, from } : o)) : [...list, { id, c, from }]));
    setActiveCo(id);
    setSync((m) => ({ ...m, [id]: { state: '', live: null } }));
    if (from === 'archive') checkCompany(c).then((r) => setSync((m) => ({ ...m, [id]: r }))).catch(() => {});
  }, []);
  // RELOAD (the tab's button, F5): the company on show asked of ANAF again;
  // with none open, the last lookup run again.
  const reload = async () => {
    if (shown) {
      const id = activeCo;
      const r = await checkCompany(shown);
      if (r?.live) setOpenList((list) => list.map((o) => (o.id === id ? { ...o, c: r.live, from: 'live' } : o)));
      setSync((m) => ({ ...m, [id]: r?.live ? { state: 'same', live: null } : (r || { state: '', live: null }) }));
      return;
    }
    if (answer && text.trim()) await runRef.current?.(text);
  };
  const runRef = useRef(null);
  const seq = useRef(0);
  const pageRef = useRef(null);
  const remembered = useMemo(() => ({ text, answer, error, open, activeCo, source, portalError }), [text, answer, error, open, activeCo, source, portalError]);
  usePageMemory('anaf', remembered, pageRef);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const arrived = useRef('');
  // A CAEN code pressed on a record — the nomenclature opens over the page
  // (components/CaenModal), searched on that code.
  const [caenModal, setCaenModal] = useState(null);
  const closeCaen = useCallback(() => setCaenModal(null), []);

  const run = useCallback(async (raw) => {
    const cuis = parseCuis(raw);
    if (!cuis.length) { setError(ERRORS.empty_query); return; }
    const mine = ++seq.current;
    setBusy(true); setError('');
    const res = await lookupCompaniesKept(raw);
    if (mine !== seq.current) return;
    setBusy(false);
    if (!res.ok) { setError(errorText(res.error)); setAnswer(null); setActiveCo(null); setSource(''); return; }
    setAnswer(res);
    setSource(res.source); sourceRef.current = res.source; setPortalError(res.portalError || '');
    // One company found is opened straight away (as a fixed search opens its
    // act in the Legislation tab); a list is shown to pick from.
    if (res.companies.length === 1) openCompany(res.companies[0]); else setActiveCo(null);
    // The tab's history: the lookup, then — for a short list — each company
    // it found, as the answers (a hundred at once would drown the log).
    const n = res.companies.length;
    logHistory('anaf', { kind: 'search', label: cuis.length === 1 ? `CUI ${cuis[0]}` : `${cuis.length} CUIs`, detail: `${n} ${n === 1 ? 'company' : 'companies'}`, data: { text: cuis.join(' ') } });
    if (n <= 5) for (const c of res.companies) logHistory('anaf', { kind: 'open', label: c.name || String(c.cui), detail: `CUI ${c.cui}`, data: { text: String(c.cui) }, dedupe: `o:${c.cui}` });
  }, [openCompany]);
  runRef.current = run;

  useEffect(() => {
    if (!isElectron) return;
    const cui = params.get('cui') || '';
    const sig = `${cui}:${params.get('_') || ''}`;
    if (!cui || arrived.current === sig) return;
    arrived.current = sig;
    setText(cui);
    setParams({}, { replace: true });
    run(cui);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // A random company THAT EXISTS. ANAF lists nothing, so a hundred numbers
  // are drawn with a valid CUI check digit (the last digit is the sum of the
  // others times 7 5 3 2 1 7 5 3 2, times ten, mod 11) in the range Romanian
  // companies actually have, asked for in ONE request (the service takes a
  // hundred at a time), and one of those that exist is kept. A draw that
  // finds none is drawn again, a second apart (the service allows one
  // request a second), up to three times.
  const randomCompany = useCallback(async () => {
    const mine = ++seq.current;
    setBusy(true); setError('');
    const KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2];
    const withCheck = (base) => {
      const digits = String(base).padStart(9, '0').split('').map(Number);
      const sum = digits.reduce((s, d, i) => s + d * KEY[i], 0);
      const c = (sum * 10) % 11;
      return `${base}${c === 10 ? 0 : c}`;
    };
    for (let tries = 0; tries < 3; tries++) {
      const cuis = [];
      while (cuis.length < 100) cuis.push(withCheck(100000 + Math.floor(Math.random() * 4400000)));
      const res = await lookupCompanies(cuis.join(' '));
      if (mine !== seq.current) return;
      if (!res.ok) { setBusy(false); setError(errorText(res.error)); return; }
      if (res.companies.length) {
        const c = res.companies[Math.floor(Math.random() * res.companies.length)];
        setText(String(c.cui));
        setAnswer({ ...res, companies: [c], notFound: [] });
        setSource('live'); sourceRef.current = 'live'; setPortalError('');
        setBusy(false);
        openCompany(c);
        return;
      }
      await new Promise((r) => setTimeout(r, 1100));
    }
    if (mine !== seq.current) return;
    setBusy(false);
    setError('No company turned up in three draws — try the dice again.');
  }, [openCompany]);

  const count = parseCuis(text).length;

  // Sync: ANAF's record of the open company, on screen (it is kept already).
  const syncCompany = () => {
    const r = sync[activeCo];
    if (!r?.live) return;
    setOpenList((list) => list.map((o) => (o.id === activeCo ? { ...o, c: r.live, from: 'live' } : o)));
    setSync((m) => ({ ...m, [activeCo]: { state: '', live: null } }));
  };
  const status = (
    <SourceStatus
      source={shown ? shownEntry.from || 'live' : answer ? source : ''}
      sync={shown ? sync[activeCo]?.state || '' : ''}
      onSync={syncCompany}
      liveLabel="Live from ANAF"
      differsLabel="Differs from ANAF"
      href="https://www.anaf.ro/RegistruRO/"
      tip="Open ANAF’s public register"
    />
  );

  const masthead = (
    <PageMasthead
      eyebrow="Company tax data"
      eyebrowMuted="source: anaf.ro"
      title="ANAF"
      compact={false}
      actions={(
        <KeptFigures
          count={kept.count}
          bytes={kept.bytes}
          lead={answer ? (
            <>
              <div>
                <div className="lg-mast-num">{fmtDate(answer.asOf)}</div>
                <div>As of</div>
              </div>
              <span className="lg-mast-sep" />
            </>
          ) : null}
        />
      )}
    >
      A company’s record as ANAF holds it today — registration, registered office, CAEN code,
      VAT and inactivity states — for one CUI or a list pasted from a spreadsheet, so you know
      who you are signing with.
    </PageMasthead>
  );

  if (!isElectron) {
    return (
      <div className="lws an-page">
        {masthead}
        <LegalTabs />
        <div className="an-empty">
          <p className="an-empty-title">Only in the desktop app</p>
          <p className="an-empty-sub">ANAF’s service refuses browser requests; the desktop app reads it for you.</p>
        </div>
      </div>
    );
  }

  // THE LOOKUP, drawn as every source tab draws its search
  // (WorkspaceSearch): the CUI box — one, or a list pasted from a
  // spreadsheet (Enter looks up; a pasted list's line breaks, which a text
  // field would strip, are turned into spaces) — and the bar beside it (the
  // dice, the count, Look up); the start screen before anything is asked,
  // one compact row over the answer after.
  const cuiBox = (
    <LegalSearchBox
      className="lg-words"
      search={{
          value: text,
          placeholder: 'A CUI, or a list of them',
          onChange: setText,
          onSubmit: () => run(text),
          onPaste: (e) => {
            const t = e.clipboardData?.getData('text') || '';
            if (!/[\r\n]/.test(t)) return;
            e.preventDefault();
            setText((prev) => `${prev.trim() ? `${prev.trim()} ` : ''}${t.replace(/[\r\n]+/g, ' ').trim()}`);
          },
      }}
    />
  );
  const formBar = (
    <LegalBar onSubmit={() => run(text)}>
      <Tooltip content="A random company — a hundred well-formed CUIs drawn, one that exists kept">
        <BarDice label="Open a random company" disabled={busy} onClick={randomCompany} />
      </Tooltip>
      <BarNote>
        {count > ANAF_MAX ? `The first ${ANAF_MAX} of ${count}` : count > 1 ? `${count} CUIs · one request` : count === 1 ? '1 CUI' : 'One CUI, or a list'}
      </BarNote>
      <BarGo busy={busy} busyLabel="Asking ANAF…">Look up</BarGo>
    </LegalBar>
  );
  const searchView = (
    <WorkspaceSearch
      asked={!!answer}
      title="Look a company up at ANAF"
      sub="A company’s record as ANAF holds it today, for one CUI or a whole list. Every company you open stays in the list on the left."
      modes={[
        {
          id: 'cui',
          label: 'By CUI',
          hint: 'The fiscal code, with or without RO — or up to 100 pasted from a spreadsheet. Press Enter to look up.',
          node: <div className="lg-start-inline">{cuiBox}{formBar}</div>,
        },
      ]}
      foot={(
        <>
          <WorkspaceClear
            disabled={!text && !answer && !error}
            onClick={() => { ++seq.current; setText(''); setAnswer(null); setError(''); setBusy(false); }}
          />
          {error ? <span className="lg-warn lg-barnote">{error}</span> : null}
        </>
      )}
    />
  );

  // The page stands in the Legislation tabs' workspace: Search + History
  // head the bar's second line, every company opened is an item in the rail.
  return (
    <LegalWorkspace
      className="an-page"
      rootRef={pageRef}
      masthead={masthead}
      items={open.map((o) => ({
        id: o.id,
        kind: o.c.legalForm || 'Company',
        title: o.c.name || `CUI ${o.c.cui}`,
        tip: `${o.c.name || '—'} — CUI ${o.c.cui}`,
      }))}
      activeId={activeCo}
      onSelect={setActiveCo}
      onReload={reload}
      onClose={(id) => { setOpenList((list) => list.filter((o) => o.id !== id)); if (id === activeCo) setActiveCo(null); }}
      onSearch={() => setActiveCo(null)}
      railLabel="Companies open in this tab"
      // History — this tab's log (components/HistoryMenu): a lookup runs
      // again, a company is looked up again by its CUI.
      history={{
        tab: 'anaf',
        tip: 'Every lookup run and every company found, with the time',
        extra: (
          <Tooltip content={kept.count ? 'Forget every company kept on this machine' : 'No company is kept on this machine'}>
            <button type="button" className="lgt-tool-btn is-danger" disabled={!kept.bytes} onClick={clearKept}>
              <span className="lgt-tool-ico">{BinIcon}</span><span>Kept companies</span>
            </button>
          </Tooltip>
        ),
        emptyText: 'Nothing yet. Every lookup you run and every company it finds is listed here.',
        onPick: (e) => { const t = e.data?.text || ''; if (!t) return; setText(t); run(t); },
      }}
      // No find in this tab: the lookup is the main column's (below).
      bar={{ noSearch: true, status }}
    >
      {shown ? (
        // ── One company open ─────────────────────────────────────────────
        <Company
          c={shown}
          onCaen={(code) => setCaenModal({ code })}
          onCourtFiles={(name) => navigate(`/portal-just?parte=${encodeURIComponent(name)}`)}
        />
      ) : (
        // ── The lookup and its answer ────────────────────────────────────
        <>
          {searchView}
          {answer && source === 'archive' ? (
            <p className="an-note is-warn">
              {portalError === 'stale_app'
                ? 'This window is newer than the app running behind it — restart Docvex to reach ANAF; this is what you already had.'
                : `ANAF could not be reached${portalError === 'timeout' ? ' (it timed out)' : ''} — this is what you already had.`}
            </p>
          ) : null}
          {answer ? (
            <>
              {answer.notFound.length ? (
                <p className="an-note is-warn">
                  Not in ANAF’s register: {answer.notFound.join(', ')}. A CUI that does not exist, or a number mistyped.
                </p>
              ) : null}
              {answer.companies.length ? (
                <ul className="an-results">
                  {answer.companies.map((c) => <CompanyRow key={c.cui} c={c} onOpen={() => openCompany(c)} />)}
                </ul>
              ) : null}
            </>
          ) : null}
        </>
      )}
      <CaenModal open={caenModal} onClose={closeCaen} />
    </LegalWorkspace>
  );
}

// A company in the answer's list — its name, CUI and flags; pressing it
// opens the whole record (a rail item of its own).
function CompanyRow({ c, onOpen }) {
  return (
    <li className="an-row">
      <button type="button" className="an-row-main" onClick={onOpen}>
        <span className="an-row-top">
          <span className="an-row-name">{c.name || '—'}</span>
          <span className="an-row-cui">{c.vat.registered ? `RO${c.cui}` : c.cui}</span>
        </span>
        <span className="an-row-meta">
          {c.inactive.on ? <span className="an-flag is-bad">Inactive</span> : null}
          {c.inactive.deleted ? <span className="an-flag is-bad">Struck off</span> : null}
          {c.vat.registered ? <span className="an-flag is-good">VAT payer</span> : <span className="an-flag is-muted">Not a VAT payer</span>}
          {c.hq || c.address ? <span>{c.hq || c.address}</span> : null}
        </span>
      </button>
    </li>
  );
}

function Company({ c, onCaen, onCourtFiles }) {
  const [copied, setCopied] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  // The CAEN it declared in its last financial statement (ANAF's balance-
  // sheet service) — may differ from the one it is registered with now.
  const finYear = new Date().getFullYear() - 1;
  const [bilant, setBilant] = useState(null);
  useEffect(() => {
    setCopied(false); setMapOpen(false); setBilant(null);
    let live = true;
    if (c.cui) companyBilant(c.cui, finYear).then((r) => { if (live) setBilant(r || { ok: false }); });
    return () => { live = false; };
  }, [c.cui]); // eslint-disable-line react-hooks/exhaustive-deps
  const office = c.hq || c.address || '';
  const euid = euidOf(c.regCom);
  const age = ageOf(c.registered);
  const copy = async () => {
    // As a contract writes a party.
    const text = `${c.name}, CUI ${c.vat.registered ? 'RO' : ''}${c.cui}${c.regCom ? `, ${c.regCom}` : ''}${c.hq ? `, sediul în ${c.hq}` : ''}`;
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard refused */ }
  };
  const flags = [
    c.inactive.on ? { tone: 'bad', text: `Inactive${c.inactive.since ? ` since ${fmtDate(c.inactive.since)}` : ''}` } : null,
    c.inactive.deleted ? { tone: 'bad', text: `Struck off ${fmtDate(c.inactive.deleted)}` } : null,
    c.vat.registered ? { tone: 'good', text: 'VAT payer' } : { tone: 'muted', text: 'Not a VAT payer' },
    c.vatCash.on ? { tone: 'info', text: 'VAT on collection' } : null,
    c.split.on ? { tone: 'info', text: 'Split VAT' } : null,
    c.eFactura ? { tone: 'info', text: 'RO e-Factura' } : null,
  ].filter(Boolean);
  const vatNow = c.vat.periods.find((p) => !p.to) || c.vat.periods[c.vat.periods.length - 1];

  return (
    <article className="an-card">
      <header className="an-head">
        <div className="an-kind">{c.legalForm || c.organisation || 'Company'}</div>
        <div className="an-title-row">
          <h1 className="an-name">{c.name || '—'}</h1>
          <div className="an-actions">
            {/* The tabs answer each other: the company's court files, by its
                name, in the Court files tab. */}
            {c.name ? (
              <Tooltip content="Search the courts’ portal for files naming this company">
                <button type="button" className="an-btn" onClick={() => onCourtFiles(c.name)}>
                  <span className="an-ico">{GavelIcon}</span>
                  <span>Court files</span>
                </button>
              </Tooltip>
            ) : null}
            <Tooltip content={copied ? 'Copied' : 'Copy the company as a contract names it'}>
              <button type="button" className="an-btn is-icon" aria-label={copied ? 'Copied' : 'Copy the company as a contract names it'} onClick={copy}>
                <span className="an-ico">{copied ? CheckIcon : CopyIcon}</span>
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="an-flags">
          {flags.map((f) => <span key={f.text} className={`an-flag is-${f.tone}`}>{f.text}</span>)}
        </div>
      </header>

      <dl className="an-facts">
        <Fact label="Registered office">
          {office || '—'}
          {office ? (
            <Tooltip content="Show the address on the map">
              <button type="button" className="an-mapbtn" onClick={() => setMapOpen(true)}>
                <span className="an-ico">{PinIcon}</span><span>Map</span>
              </button>
            </Tooltip>
          ) : null}
        </Fact>
        <Fact label="CUI">{c.vat.registered ? `RO${c.cui}` : String(c.cui)}</Fact>
        <Fact label="Trade register">{c.regCom || '—'}</Fact>
        <Fact label="Age">{age || '—'}</Fact>
        <Fact label="Founded">{c.registered ? longDate(c.registered) : '—'}</Fact>
        <Fact label="Main CAEN">
          {c.caen ? (
            <button type="button" className="an-link" onClick={() => onCaen(c.caen)}>{c.caen} — what it is</button>
          ) : '—'}
        </Fact>
        <Fact label={`CAEN, financial year ${finYear}`}>
          {!bilant ? <span className="an-muted">Asking ANAF…</span>
            : !bilant.ok ? <span className="an-muted">ANAF’s balance-sheet service did not answer</span>
              : bilant.caen ? (
                <button type="button" className="an-link" onClick={() => onCaen(bilant.caen)}>{bilant.caen}{bilant.caenName ? ` — ${bilant.caenName}` : ''}</button>
              ) : <span className="an-muted">No financial statement filed for {finYear}</span>}
        </Fact>
        {euid ? <Fact label="EUID">{euid}</Fact> : null}
        <Fact label="Registration">{[c.registration, c.registered ? `(${fmtDate(c.registered)})` : ''].filter(Boolean).join(' ') || '—'}</Fact>
        {c.fiscalAddress && c.fiscalAddress !== c.hq ? <Fact label="Fiscal domicile">{c.fiscalAddress}</Fact> : null}
        {c.phone ? <Fact label="Telephone">{c.phone}</Fact> : null}
        <Fact label="Tax office">{c.fiscalOrgan || '—'}</Fact>
        {c.ownership ? <Fact label="Ownership">{c.ownership}</Fact> : null}
        <Fact label="VAT">
          {c.vat.registered
            ? `Registered${vatNow?.from ? ` since ${fmtDate(vatNow.from)}` : ''}`
            : c.vat.periods.length ? `Not registered now; was ${c.vat.periods.map((p) => `${fmtDate(p.from)}–${p.to ? fmtDate(p.to) : ''}`).join(', ')}` : 'Not registered'}
          {c.vat.periods.length > 1 && c.vat.registered ? ` · ${c.vat.periods.length} periods` : ''}
        </Fact>
        {c.vatCash.on || c.vatCash.from ? (
          <Fact label="VAT on collection">{c.vatCash.on ? `Since ${fmtDate(c.vatCash.from)}` : `Ended ${fmtDate(c.vatCash.to)}`}{c.vatCash.act ? ` · ${c.vatCash.act}` : ''}</Fact>
        ) : null}
        {c.inactive.on || c.inactive.since ? (
          <Fact label="Inactivity">
            {c.inactive.on ? `Declared inactive ${fmtDate(c.inactive.since)}` : `Inactive ${fmtDate(c.inactive.since)}, reactivated ${fmtDate(c.inactive.reactivated)}`}
          </Fact>
        ) : null}
        {c.eFactura ? <Fact label="RO e-Factura">{c.eFacturaSince ? `Enrolled ${fmtDate(c.eFacturaSince)}` : 'Enrolled'}</Fact> : null}
      </dl>

      {mapOpen ? <MapDrawer address={office} title={c.name || 'Registered office'} onClose={() => setMapOpen(false)} /> : null}
      <footer className="an-source">
        ANAF’s public service, as of {fmtDate(c.asOf)}. The record is the register’s summary; the trade-register
        extract and the fiscal certificate remain the documents to file.
      </footer>
    </article>
  );
}

function Fact({ label, children }) {
  return (
    <div className="an-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
