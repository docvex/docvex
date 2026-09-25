import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import './PortalJust.css';
import PageMasthead from '../components/PageMasthead';
import LegalTabs from '../components/LegalTabs';
import { LegalBar, BarDice, BarPicker, BarInput, BarGo } from '../components/LegalBar';
import Tooltip from '../components/Tooltip';
import { isElectron, openExternal } from '../lib/platform';
import { recallPage, usePageMemory } from '../lib/pageMemory';
import { logHistory } from '../lib/tabHistory';
import HistoryButton from '../components/HistoryMenu';
import {
  COURTS, KIND_LABEL, courtLabel, hasCaseQuery, searchCases, listHearings,
  fmtDate, todayIso, hearingsSorted, nextHearing, lastSolution, partiesByRole, casesSorted, portalCaseUrl,
} from '../lib/courts';

// Court files — portal.just.ro, in the app.
//
// The courts' portal publishes a free web service that answers a case file
// whole: the parties, every hearing with what the court decided, the appeals.
// A file is found by its number, by a party's name or by its object, narrowed
// to a court and a period; a court's docket for a day is the other question
// the service takes. Desktop only: the service is SOAP with no CORS headers,
// so main.js makes the call (`courts:*`). Nothing is kept on disk yet — a
// file's state is what the court says today.
//
// `?nr=…` opens straight on a file (a chat or a note will link here).

const BackIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
const ExternalIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 5h5v5" /><path d="M19 5l-8 8" /><path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" />
  </svg>
);

const ERRORS = {
  unreachable: 'The portal could not be reached — check the connection and try again.',
  timeout: 'The portal took too long to answer.',
  stale_app: 'This window is newer than the app running behind it — restart Docvex (npm start) to load the courts’ portal.',
  service_fault: 'The portal refused the search — check the case number’s form (1234/3/2026).',
  empty_query: 'Give it a case number, a party or an object.',
};
const errorText = (code) => ERRORS[code] || (String(code || '').startsWith('http_') ? `The portal answered with an error (${code.slice(5)}).` : 'The search failed.');

// A panel as the file names it ("C2S"); the docket call gives an internal
// number instead, which is nothing to a reader.
const panelName = (s) => (s && !/^\d{7,}$/.test(String(s)) ? `Panel ${s}` : '');

// The two questions the service takes, as the bar's first dropdown.
const MODES = [{ id: 'cases', label: 'Case files' }, { id: 'docket', label: 'A court’s day' }];

const groupedCourts = () => {
  const out = [];
  for (const kind of ['iccj', 'ca', 'trib', 'jud', 'other']) {
    const list = COURTS.filter((c) => c.kind === kind);
    if (list.length) out.push({ kind, label: KIND_LABEL[kind], list });
  }
  return out;
};

export default function PortalJust() {
  // What the page had on it when it was last left (lib/pageMemory).
  const saved = recallPage('portal-just');
  const [mode, setMode] = useState(saved?.mode || 'cases');           // 'cases' | 'docket'
  const [query, setQuery] = useState(saved?.query || { numar: '', parte: '', obiect: '', institutie: '', from: '', to: '' });
  const [docket, setDocket] = useState(saved?.docket || { institutie: '', day: todayIso() });
  const [results, setResults] = useState(saved?.results ?? null);        // { total, dosare } | null
  const [sedinte, setSedinte] = useState(saved?.sedinte ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(saved?.error || '');
  const [open, setOpen] = useState(saved?.open ?? null);              // the file being read
  const seq = useRef(0);
  const pageRef = useRef(null);
  const remembered = useMemo(() => ({ mode, query, docket, results, sedinte, error, open }), [mode, query, docket, results, sedinte, error, open]);
  usePageMemory('portal-just', remembered, pageRef);
  const [params, setParams] = useSearchParams();
  const arrived = useRef('');
  const courts = useMemo(groupedCourts, []);
  // The court picker's list: every court under its kind; the case search
  // also takes "Any court" at the head.
  const courtGroups = useMemo(() => courts.map((g) => ({ label: g.label, list: g.list.map((c) => ({ id: c.id, label: c.label })) })), [courts]);
  const anyCourtGroups = useMemo(() => [{ label: null, list: [{ id: '', label: 'Any court' }] }, ...courtGroups], [courtGroups]);

  const set = (k) => (e) => setQuery((q) => ({ ...q, [k]: e.target.value }));

  const runCases = useCallback(async (q) => {
    if (!hasCaseQuery(q)) { setError(ERRORS.empty_query); return null; }
    const mine = ++seq.current;
    setBusy(true); setError(''); setSedinte(null);
    const res = await searchCases(q);
    if (mine !== seq.current) return null;
    setBusy(false);
    if (!res?.ok) { setError(errorText(res?.error)); setResults({ total: 0, dosare: [] }); return null; }
    setResults({ total: res.total, dosare: casesSorted(res.dosare) });
    // The tab's history: the search as it was asked, and what it found.
    const label = [q.numar ? `File ${q.numar}` : '', q.parte ? `“${q.parte}”` : '', q.obiect ? `object “${q.obiect}”` : '', q.institutie ? courtLabel(q.institutie) : '']
      .filter(Boolean).join(' · ') || 'Everything';
    logHistory('portal-just', { kind: 'search', label, detail: `${res.total} ${res.total === 1 ? 'file' : 'files'}`, data: { mode: 'cases', query: q } });
    return res;
  }, []);

  // A random case THAT EXISTS: a court and a recent working day are drawn,
  // the court's docket for that day is asked for, one of its files is
  // searched by number and opened. A day with no sittings is drawn again,
  // up to four times.
  const randomCase = useCallback(async () => {
    const mine = ++seq.current;
    setBusy(true); setError(''); setOpen(null); setSedinte(null);
    const pool = COURTS.filter((c) => c.kind === 'jud' || c.kind === 'trib' || c.kind === 'ca');
    for (let tries = 0; tries < 4; tries++) {
      const court = pool[Math.floor(Math.random() * pool.length)];
      const d = new Date();
      d.setDate(d.getDate() - Math.floor(Math.random() * 45));
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const res = await listHearings({ institutie: court.id, day });
      if (mine !== seq.current) return;
      if (!res?.ok) break;
      const numbers = (res.sedinte || []).flatMap((s) => (s.dosare || []).map((x) => x.numar)).filter(Boolean);
      if (!numbers.length) continue;
      const numar = numbers[Math.floor(Math.random() * numbers.length)];
      const found = await searchCases({ numar, institutie: court.id });
      if (mine !== seq.current) return;
      if (!found?.ok || !found.dosare?.length) continue;
      setMode('cases');
      setQuery((q) => ({ ...q, numar, parte: '', obiect: '', institutie: court.id }));
      setResults({ total: found.total, dosare: found.dosare });
      setBusy(false);
      openFile(found.dosare[Math.floor(Math.random() * found.dosare.length)]);
      return;
    }
    if (mine !== seq.current) return;
    setBusy(false);
    setError('No sitting turned up in four draws — try the dice again.');
  }, []);

  const runDocket = useCallback(async (q) => {
    if (!q.institutie || !q.day) { setError('Pick a court and a day.'); return; }
    const mine = ++seq.current;
    setBusy(true); setError(''); setResults(null);
    const res = await listHearings(q);
    if (mine !== seq.current) return;
    setBusy(false);
    if (!res?.ok) { setError(errorText(res?.error)); setSedinte([]); return; }
    setSedinte(res.sedinte);
    const n = (res.sedinte || []).reduce((m, s) => m + (s.dosare || []).length, 0);
    logHistory('portal-just', { kind: 'search', label: `${courtLabel(q.institutie)} · ${fmtDate(q.day)}`, detail: `${n} ${n === 1 ? 'hearing' : 'hearings'}`, data: { mode: 'docket', docket: q } });
  }, []);

  // A file opened is logged too (once, however often it is reopened in a
  // row), by number and court, which is enough to find it again.
  const openFile = useCallback((d) => {
    setOpen(d);
    if (!d) return;
    logHistory('portal-just', { kind: 'open', label: d.numar, detail: [courtLabel(d.institutie), d.obiect].filter(Boolean).join(' — '), data: { numar: d.numar, institutie: d.institutie }, dedupe: `o:${d.institutie}:${d.numar}` });
  }, []);

  // A link in: `?nr=1234/3/2026` searches that number and opens the file when
  // it is the only answer (an appeal carries the same number at another
  // court); `?parte=…` searches a party's name (ANAF's "Court files" button
  // sends a company's name here).
  useEffect(() => {
    if (!isElectron) return;
    const nr = params.get('nr') || '';
    const parte = params.get('parte') || '';
    const sig = nr ? `nr:${nr}` : parte ? `parte:${parte}` : '';
    if (!sig || arrived.current === sig) return;
    arrived.current = sig;
    setQuery((q) => ({ ...q, numar: nr, parte }));
    setMode('cases');
    setOpen(null); setSedinte(null);
    setParams({}, { replace: true });
    (async () => {
      const res = await runCases(nr ? { numar: nr } : { parte });
      if (nr && res?.dosare?.length === 1) openFile(res.dosare[0]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // From a docket row: the file itself, by number.
  const openNumber = async (numar) => {
    setMode('cases');
    setQuery((q) => ({ ...q, numar }));
    const res = await runCases({ numar });
    if (res?.dosare?.length === 1) openFile(res.dosare[0]);
  };

  const masthead = (
    <PageMasthead
      eyebrow="Court files and courts"
      eyebrowMuted="source: portal.just.ro"
      title="Court files"
      compact={false}
      actions={results ? (
        <div className="pj-mast-meta">
          <div>
            <div className="pj-mast-num">{results.total}</div>
            <div>{results.total === 1 ? 'File found' : 'Files found'}</div>
          </div>
        </div>
      ) : null}
    >
      Case files as the courts publish them — the parties, every hearing with its solution, and
      the appeals — read live from the courts’ own service by number, party or object, or as a
      court’s docket for a day.
    </PageMasthead>
  );

  if (!isElectron) {
    return (
      <div className="pj-page">
        {masthead}
        <LegalTabs />
        <div className="pj-empty">
          <p className="pj-empty-title">Only in the desktop app</p>
          <p className="pj-empty-sub">The courts’ web service refuses browser requests; the desktop app reads it for you.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pj-page" ref={pageRef}>
      {masthead}
      {/* The party search sits in the tab bar's words box (Enter searches);
          everything else — the dice, the Case files / A court's day switch,
          the number, the object, the court, the period, Search — is the
          Legislation tab's bar (components/LegalBar), drawn the same way.
          It is there whatever is shown, an open file included; submitting
          closes the file. */}
      <LegalTabs
        search={mode === 'cases' ? {
          value: query.parte,
          placeholder: 'A party, as the file writes it',
          onChange: (v) => setQuery((q) => ({ ...q, parte: v })),
          onSubmit: () => { setOpen(null); runCases(query); },
        } : null}
        // History — this tab's log (components/HistoryMenu): a search runs
        // again (a docket lists again), a file opens again by its number.
        trailing={(
          <HistoryButton
            tab="portal-just"
            tip="Every search run and every file opened, with the time"
            emptyText="Nothing yet. Every search you run and every file you open is listed here."
            onPick={async (e) => {
              const d = e.data || {};
              setOpen(null);
              if (e.kind === 'search' && d.mode === 'docket') { setMode('docket'); setDocket(d.docket); runDocket(d.docket); return; }
              if (e.kind === 'search') { setMode('cases'); setQuery((q) => ({ ...q, ...d.query })); runCases(d.query); return; }
              setMode('cases'); setQuery((q) => ({ ...q, numar: d.numar || '', institutie: d.institutie || '' }));
              const res = await runCases({ numar: d.numar, institutie: d.institutie });
              const hit = res?.dosare?.find((x) => x.numar === d.numar && x.institutie === d.institutie) || (res?.dosare?.length === 1 ? res.dosare[0] : null);
              if (hit) setOpen(hit);
            }}
          />
        )}
        tools={(
          <LegalBar onSubmit={() => { setOpen(null); if (mode === 'cases') runCases(query); else runDocket(docket); }}>
            <Tooltip content="A random case — a court and a day drawn at random, one file of that day's docket">
              <BarDice label="Open a random case" disabled={busy} onClick={randomCase} />
            </Tooltip>
            <BarPicker label="What to search" options={MODES} value={mode} onChange={(m) => { setOpen(null); setMode(m); }} />
            {mode === 'cases' ? (
              <>
                <BarInput size="text" aria-label="Case number" value={query.numar} onChange={set('numar')} placeholder="Number 1234/3/2026" />
                <BarInput size="text" aria-label="The object" value={query.obiect} onChange={set('obiect')} placeholder="Object" />
                <BarPicker label="Court" width="wide" groups={anyCourtGroups} value={query.institutie} onChange={(v) => setQuery((q) => ({ ...q, institutie: v }))} placeholder="Any court" />
                <Tooltip content="Registered from">
                  <BarInput size="date" type="date" aria-label="Registered from" value={query.from} onChange={set('from')} />
                </Tooltip>
                <Tooltip content="Registered up to">
                  <BarInput size="date" type="date" aria-label="Registered up to" value={query.to} onChange={set('to')} />
                </Tooltip>
                <BarGo busy={busy}>Search</BarGo>
              </>
            ) : (
              <>
                <BarPicker label="Court" width="wide" groups={courtGroups} value={docket.institutie} onChange={(v) => setDocket((d) => ({ ...d, institutie: v }))} placeholder="Pick a court" />
                <Tooltip content="The day">
                  <BarInput size="date" type="date" aria-label="Day" value={docket.day} onChange={(e) => setDocket((d) => ({ ...d, day: e.target.value }))} />
                </Tooltip>
                <BarGo busy={busy} busyLabel="Reading…">List the hearings</BarGo>
              </>
            )}
          </LegalBar>
        )}
      />

      {open ? (
        <CaseFile dosar={open} onBack={() => setOpen(null)} />
      ) : (
        <div className="pj-main">
          {error ? <p className="pj-note is-bad">{error}</p> : null}

          {results ? (
            results.dosare.length ? (
              <>
                {results.total > results.dosare.length ? (
                  <p className="pj-note">The portal found {results.total} files; the newest {results.dosare.length} are shown. Narrow the search by court or period for the rest.</p>
                ) : (
                  <p className="pj-note">{results.total} {results.total === 1 ? 'file' : 'files'}, newest change first. Live from the portal.</p>
                )}
                <ul className="pj-results">
                  {results.dosare.map((d) => <CaseRow key={`${d.institutie}-${d.numar}`} dosar={d} onOpen={() => openFile(d)} />)}
                </ul>
              </>
            ) : !busy && !error ? <p className="pj-note">The portal found no file for that.</p> : null
          ) : null}

          {sedinte ? (
            sedinte.length ? (
              <div className="pj-docket">
                {sedinte.map((s, i) => (
                  <section className="pj-sitting" key={i}>
                    <header className="pj-sitting-head">
                      <span className="pj-sitting-dept">{s.departament || 'Court'}</span>
                      <span className="pj-sitting-meta">{[panelName(s.complet), s.ora, `${s.dosare.length} ${s.dosare.length === 1 ? 'file' : 'files'}`].filter(Boolean).join(' · ')}</span>
                    </header>
                    <ul className="pj-sitting-list">
                      {s.dosare.map((d) => (
                        <li key={`${d.numar}-${d.ora}`}>
                          <button type="button" className="pj-sitting-row" onClick={() => openNumber(d.numar)}>
                            <span className="pj-sitting-hour">{d.ora}</span>
                            <span className="pj-sitting-nr">{d.numar}</span>
                            <span className="pj-sitting-kind">{[d.categorie, d.stadiu].filter(Boolean).join(' · ')}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : !busy && !error ? <p className="pj-note">No hearings listed for that court on that day.</p> : null
          ) : null}

          {!results && !sedinte && !error ? (
            <p className="pj-note">
              A number finds one file (and its appeals, under the same number at the higher court); a name finds every file the
              party is in, which for a company can run to hundreds — a court or a period narrows it.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CaseRow({ dosar, onOpen }) {
  const next = nextHearing(dosar);
  const last = lastSolution(dosar);
  return (
    <li className="pj-row">
      <button type="button" className="pj-row-main" onClick={onOpen}>
        <span className="pj-row-top">
          <span className="pj-row-nr">{dosar.numar}</span>
          <span className="pj-row-court">{courtLabel(dosar.institutie)}{dosar.departament ? ` · ${dosar.departament}` : ''}</span>
        </span>
        <span className="pj-row-obj">{dosar.obiect || '—'}</span>
        <span className="pj-row-meta">
          {dosar.categorie ? <span className="pj-tag">{dosar.categorie}</span> : null}
          {dosar.stadiu ? <span className="pj-tag is-stage">{dosar.stadiu}</span> : null}
          <span>{dosar.parti.length} {dosar.parti.length === 1 ? 'party' : 'parties'}</span>
          {next ? <span className="pj-next">Next hearing {fmtDate(next.data)}{next.ora ? ` ${next.ora}` : ''}</span> : null}
          {last ? <span>Last: {last.solutie}</span> : null}
          {dosar.modificat ? <span>Changed {fmtDate(dosar.modificat)}</span> : null}
        </span>
      </button>
    </li>
  );
}

function CaseFile({ dosar, onBack }) {
  const parties = partiesByRole(dosar);
  const hearings = hearingsSorted(dosar);
  return (
    <div className="pj-reader">
      <div className="pj-reader-bar">
        <button type="button" className="pj-btn" onClick={onBack}>
          <span className="pj-ico">{BackIcon}</span><span>Back to results</span>
        </button>
        <Tooltip content="Search this number on the courts’ portal">
          <button type="button" className="pj-btn" onClick={() => openExternal(portalCaseUrl(dosar.numar))}>
            <span className="pj-ico">{ExternalIcon}</span><span>On the portal</span>
          </button>
        </Tooltip>
      </div>

      <article className="pj-file">
        <header className="pj-file-head">
          <div className="pj-file-kind">{courtLabel(dosar.institutie)}{dosar.departament ? ` · ${dosar.departament}` : ''}</div>
          <h1 className="pj-file-nr">{dosar.numar}</h1>
          <p className="pj-file-obj">{dosar.obiect || 'No object stated'}</p>
          <div className="pj-file-meta">
            {dosar.categorie ? <span className="pj-tag">{dosar.categorie}</span> : null}
            {dosar.stadiu ? <span className="pj-tag is-stage">{dosar.stadiu}</span> : null}
            {dosar.data ? <span>Registered {fmtDate(dosar.data, true)}</span> : null}
            {dosar.numarVechi ? <span>Former number {dosar.numarVechi}</span> : null}
            {dosar.modificat ? <span>Last change {fmtDate(dosar.modificat, true)}</span> : null}
          </div>
        </header>

        <section className="pj-sec">
          <p className="pj-sec-title">Parties · {dosar.parti.length}</p>
          {parties.length ? parties.map((g) => (
            <div className="pj-parties" key={g.role}>
              <span className="pj-role">{g.role}</span>
              <ul className="pj-names">
                {g.names.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )) : <p className="pj-note">The file lists no parties.</p>}
        </section>

        <section className="pj-sec">
          <p className="pj-sec-title">Hearings · {hearings.length}</p>
          {hearings.length ? (
            <ol className="pj-hearings">
              {hearings.map((h, i) => {
                const ahead = String(h.data).slice(0, 10) >= todayIso();
                return (
                  <li className={`pj-hearing${ahead ? ' is-ahead' : ''}`} key={i}>
                    <div className="pj-hearing-when">
                      <span className="pj-hearing-date">{fmtDate(h.data)}</span>
                      <span className="pj-hearing-sub">{[h.ora, panelName(h.complet)].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div className="pj-hearing-body">
                      {h.solutie ? <p className="pj-hearing-sol">{h.solutie}</p> : <p className="pj-hearing-sol is-none">{ahead ? 'Scheduled' : 'No solution recorded'}</p>}
                      {h.sumar ? <p className="pj-hearing-sum">{h.sumar}</p> : null}
                      {(h.pronuntare || h.document || h.numarDocument) ? (
                        <p className="pj-hearing-doc">
                          {h.pronuntare ? `Pronounced ${fmtDate(h.pronuntare)}` : ''}
                          {h.document ? `${h.pronuntare ? ' · ' : ''}${h.document}${h.numarDocument ? ` nr. ${h.numarDocument}` : ''}${h.dataDocument ? ` din ${fmtDate(h.dataDocument)}` : ''}` : ''}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="pj-note">No hearings yet.</p>}
        </section>

        {dosar.caiAtac.length ? (
          <section className="pj-sec">
            <p className="pj-sec-title">Appeals · {dosar.caiAtac.length}</p>
            <ul className="pj-appeals">
              {dosar.caiAtac.map((c, i) => (
                <li className="pj-appeal" key={i}>
                  <span className="pj-appeal-type">{c.tip || 'Appeal'}</span>
                  <span className="pj-appeal-by">{c.parte || '—'}</span>
                  <span className="pj-appeal-date">{c.data ? fmtDate(c.data) : ''}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="pj-source">
          Read live from portal.just.ro, as the court has entered it. The portal’s data is informative;
          the file at the registry is the authentic one.
        </footer>
      </article>
    </div>
  );
}
