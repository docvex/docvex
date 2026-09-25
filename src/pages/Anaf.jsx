import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './Anaf.css';
import PageMasthead from '../components/PageMasthead';
import LegalTabs from '../components/LegalTabs';
import { LegalBar, BarDice, BarNote, BarGo } from '../components/LegalBar';
import Tooltip from '../components/Tooltip';
import { isElectron } from '../lib/platform';
import { recallPage, usePageMemory } from '../lib/pageMemory';
import { logHistory } from '../lib/tabHistory';
import HistoryButton from '../components/HistoryMenu';
import CaenModal from '../components/CaenModal';
import { lookupCompanies, parseCuis, fmtDate, ANAF_MAX } from '../lib/anaf';

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
  const seq = useRef(0);
  const pageRef = useRef(null);
  const remembered = useMemo(() => ({ text, answer, error }), [text, answer, error]);
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
    const res = await lookupCompanies(raw);
    if (mine !== seq.current) return;
    setBusy(false);
    if (!res.ok) { setError(errorText(res.error)); setAnswer(null); return; }
    setAnswer(res);
    // The tab's history: the lookup, then — for a short list — each company
    // it found, as the answers (a hundred at once would drown the log).
    const n = res.companies.length;
    logHistory('anaf', { kind: 'search', label: cuis.length === 1 ? `CUI ${cuis[0]}` : `${cuis.length} CUIs`, detail: `${n} ${n === 1 ? 'company' : 'companies'}`, data: { text: cuis.join(' ') } });
    if (n <= 5) for (const c of res.companies) logHistory('anaf', { kind: 'open', label: c.name || String(c.cui), detail: `CUI ${c.cui}`, data: { text: String(c.cui) }, dedupe: `o:${c.cui}` });
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    const cui = params.get('cui') || '';
    if (!cui || arrived.current === cui) return;
    arrived.current = cui;
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
        setBusy(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 1100));
    }
    if (mine !== seq.current) return;
    setBusy(false);
    setError('No company turned up in three draws — try the dice again.');
  }, []);

  const count = parseCuis(text).length;

  const masthead = (
    <PageMasthead
      eyebrow="Company tax data"
      eyebrowMuted="source: anaf.ro"
      title="ANAF"
      compact={false}
      actions={answer ? (
        <div className="an-mast-meta">
          <div>
            <div className="an-mast-num">{answer.companies.length}</div>
            <div>{answer.companies.length === 1 ? 'Company' : 'Companies'}</div>
          </div>
          <span className="an-mast-sep" />
          <div>
            <div className="an-mast-num">{fmtDate(answer.asOf)}</div>
            <div>As of</div>
          </div>
        </div>
      ) : null}
    >
      A company’s record as ANAF holds it today — registration, registered office, CAEN code,
      VAT and inactivity states — for one CUI or a list pasted from a spreadsheet, so you know
      who you are signing with.
    </PageMasthead>
  );

  if (!isElectron) {
    return (
      <div className="an-page">
        {masthead}
        <LegalTabs />
        <div className="an-empty">
          <p className="an-empty-title">Only in the desktop app</p>
          <p className="an-empty-sub">ANAF’s service refuses browser requests; the desktop app reads it for you.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="an-page" ref={pageRef}>
      {masthead}
      {/* The CUI — one, or a list pasted from a spreadsheet — is the tab
          bar's words box (Enter looks up; a pasted list's line breaks, which
          a text field would strip, are turned into spaces); the dice, the
          count and Look up are the Legislation tab's bar (components/LegalBar),
          drawn the same way. */}
      <LegalTabs
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
        tools={(
          <LegalBar onSubmit={() => run(text)}>
            <Tooltip content="A random company — a hundred well-formed CUIs drawn, one that exists kept">
              <BarDice label="Open a random company" disabled={busy} onClick={randomCompany} />
            </Tooltip>
            <BarNote>
              {count > ANAF_MAX ? `The first ${ANAF_MAX} of ${count}` : count > 1 ? `${count} CUIs · one request` : count === 1 ? '1 CUI' : 'One CUI, or a list'}
            </BarNote>
            <BarGo busy={busy} busyLabel="Asking ANAF…">Look up</BarGo>
          </LegalBar>
        )}
        // History — this tab's log (components/HistoryMenu): a lookup runs
        // again, a company is looked up again by its CUI.
        trailing={(
          <HistoryButton
            tab="anaf"
            tip="Every lookup run and every company found, with the time"
            emptyText="Nothing yet. Every lookup you run and every company it finds is listed here."
            onPick={(e) => { const t = e.data?.text || ''; if (!t) return; setText(t); run(t); }}
          />
        )}
      />

      {error ? <p className="an-note is-bad">{error}</p> : null}

      {answer ? (
        <>
          {answer.notFound.length ? (
            <p className="an-note is-warn">
              Not in ANAF’s register: {answer.notFound.join(', ')}. A CUI that does not exist, or a number mistyped.
            </p>
          ) : null}
          <div className="an-cards">
            {answer.companies.map((c) => (
              <Company
                key={c.cui}
                c={c}
                onCaen={(code) => setCaenModal({ code })}
                onCourtFiles={(name) => navigate(`/portal-just?parte=${encodeURIComponent(name)}`)}
              />
            ))}
          </div>
          <CaenModal open={caenModal} onClose={closeCaen} />
        </>
      ) : !error ? (
        <p className="an-note">
          The CUI is on any invoice and in the trade-register extract; “RO” in front of it only says the company is a VAT payer,
          and is ignored here. The answer is ANAF’s state of today — the service is asked every time.
        </p>
      ) : null}
    </div>
  );
}

function Company({ c, onCaen, onCourtFiles }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [c.cui]);
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
            <Tooltip content="Copy the company as a contract names it">
              <button type="button" className="an-btn" onClick={copy}>
                <span className="an-ico">{copied ? CheckIcon : CopyIcon}</span>
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="an-flags">
          {flags.map((f) => <span key={f.text} className={`an-flag is-${f.tone}`}>{f.text}</span>)}
        </div>
      </header>

      <dl className="an-facts">
        <Fact label="CUI">{c.vat.registered ? `RO${c.cui}` : String(c.cui)}</Fact>
        <Fact label="Trade register">{c.regCom || '—'}</Fact>
        <Fact label="Registration">{[c.registration, c.registered ? `(${fmtDate(c.registered)})` : ''].filter(Boolean).join(' ') || '—'}</Fact>
        <Fact label="CAEN">
          {c.caen ? (
            <button type="button" className="an-link" onClick={() => onCaen(c.caen)}>{c.caen} — what it is</button>
          ) : '—'}
        </Fact>
        <Fact label="Registered office">{c.hq || c.address || '—'}</Fact>
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
