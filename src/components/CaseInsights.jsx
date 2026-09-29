import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Tooltip from './Tooltip';
import RuleOptions from './RuleOptions';
import { ExtGlyph } from './fileGlyph';
import { useScanState } from '../lib/scanRunner';
import { openExternal, notifyFilesChanged } from '../lib/platform';
import { localFolderApi } from '../lib/localFolder';
import {
  loadCaseData, scopeToCollection, loadTexts, findContradictions, checkAuthenticity, checkCuisWithAnaf, findVehicles,
  readPhotoPlaces, checklist, CASE_TYPES, findDuplicates, compareSignatures, loadSignatureReport,
  claimKindLabel, showDate, mapUrl,
  loadResolutions, resolutionFor, resolveContradiction, unresolveContradiction, suggestResolution, checkCnp,
} from '../lib/caseInsights';
import { analyzeLegalHistory, convertHistoricalLandToMetric, LEGAL_ERAS } from '../lib/legalHistory';
import './CaseInsights.css';
import { storageFor } from '../lib/secureStore';

// THE FILES TAB'S INSIGHTS VIEW — what can be worked out from what the AI scan
// read (lib/caseInsights): a question box over the whole case, then one
// section at a time — contradictions, authenticity, missing documents,
// duplicates, signatures and stamps, plates and places. Everything is local
// and free except Ask and Signatures (they say so), and ANAF (the network).
// Drawn on the Design system's rules: rows on the page ground with hairlines,
// soft status pills, the Segmented choice for the sections.

const SECTION_KEY = 'docvex:insights:section:v1';
const CASE_KEY = 'docvex:insights:case:v1:';
const extOf = (name) => (/\.([a-z0-9]{1,8})$/i.exec(name || '')?.[1] || '').toLowerCase();
// The kind of case is keyed by the folder's path, so it goes to the ENCRYPTED
// store (lib/secureStore); the section on show stays in localStorage.
const read = (k, d) => storageFor(k).getItem(k) || d;
const write = (k, v) => { storageFor(k).setItem(k, v); };

const STATUS_LABEL = { error: 'Problem', warn: 'Check', ok: 'Fine' };

function Mark({ name }) {
  const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const paths = {
    ask: <><path d="M8 12a16 14 0 1 1 6 11l-6 3 1.6-5.2A13 13 0 0 1 8 12z" {...P} /><path d="M20 15.5a3.4 3.4 0 1 1 4.6 3.2c-.9.4-1.6 1.1-1.6 2.1v.7M23 25.2v.2" {...P} /></>,
    empty: <><circle cx="24" cy="24" r="15" {...P} /><path d="M17 24h14M24 17v14" {...P} opacity="0.4" /></>,
  };
  return <svg className="ci-mark" viewBox="0 0 48 48" aria-hidden="true">{paths[name] || paths.empty}</svg>;
}

function Spinner() { return <span className="ci-spin" aria-hidden="true" />; }

// The files named by a finding, as chips that open them.
const FilesCtx = createContext({ fileOf: (rel) => ({ rel, name: String(rel).split('/').pop(), path: '' }), open: () => {} });
function Chips({ rels, dim = false }) {
  const { fileOf, open } = useContext(FilesCtx);
  return (
    <span className="ci-chips">
      {[...new Set(rels)].map((rel) => {
        const f = fileOf(rel);
        return (
          <Tooltip key={rel} content={f.path ? `Open ${rel}` : rel}>
            <button type="button" className={`ci-chip${dim ? ' is-dim' : ''}`} onClick={() => open(rel)} disabled={!f.path}>
              <span className="ci-chip-glyph"><ExtGlyph ext={extOf(f.name)} /></span>
              <span className="ci-chip-name">{f.name}</span>
            </button>
          </Tooltip>
        );
      })}
    </span>
  );
}

// `collection` = the data collection (its path inside the project) the view
// is about: every check runs on that collection's files only, and every
// action (a resolution, a merge) acts inside it. It lives in the collection's
// page in the Doc Viewer (components/DataCollectionView).
export default function CaseInsightsView({ dir, projectId, collection = null, onOpenPath }) {
  // Choices kept per collection (the kind of case, the signatures report).
  const scopeKey = collection ? `${dir}#${collection}` : dir;
  const [data, setData] = useState(null);
  const [texts, setTexts] = useState(null);
  const [textProgress, setTextProgress] = useState(null);
  const [section, setSection] = useState(() => { const v = read(SECTION_KEY, 'contradictions'); return v === 'ask' ? 'contradictions' : v; });
  const pick = (id) => { setSection(id); write(SECTION_KEY, id); };
  const scan = useScanState(dir);
  const running = !!scan && !scan.finished;
  const wasScanning = useRef(running);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setTexts(null);
    const whole = await loadCaseData(dir, { projectId }).catch(() => null);
    const d = whole && collection ? scopeToCollection(whole, collection) : whole;
    if (seq !== loadSeq.current) return;
    setData(d || { dir, files: [], all: [], collections: [], timeline: [], links: [], scanned: 0 });
    if (!d?.files.length) { setTexts({}); return; }
    setTextProgress({ done: 0, total: d.files.length });
    const t = await loadTexts(d, {
      isCancelled: () => seq !== loadSeq.current,
      onProgress: (done, total) => { if (seq === loadSeq.current) setTextProgress({ done, total }); },
    });
    if (seq !== loadSeq.current) return;
    setTexts(t);
    setTextProgress(null);
  }, [dir, projectId, collection]);
  useEffect(() => { setData(null); load(); return () => { loadSeq.current += 1; }; }, [load]);
  useEffect(() => {
    if (wasScanning.current && !running) load();
    wasScanning.current = running;
  }, [running, load]);

  // Duplicates found (the Duplicates section) — copies they name are one
  // document to the contradictions too.
  const [dupes, setDupes] = useState(null);
  useEffect(() => { setDupes(null); }, [data]);
  const contradictions = useMemo(() => (data && texts ? findContradictions(data, texts, { dupes }) : null), [data, texts, dupes]);
  // How the user settled each contradiction (kept with the project).
  const [resolutions, setResolutions] = useState({});
  useEffect(() => { if (data?.dir) loadResolutions(data.dir, projectId).then(setResolutions).catch(() => {}); }, [data, projectId]);
  const openContradictions = contradictions ? contradictions.filter((r) => !r.copiesOnly && !resolutionFor(resolutions, r)).length : null;
  const authenticity = useMemo(() => (data && texts ? checkAuthenticity(data, texts) : null), [data, texts]);
  const vehicles = useMemo(() => (data && texts ? findVehicles(data, texts) : null), [data, texts]);
  // Each file read in its legal era (lib/legalHistory) — those with anything
  // historical: an era before today's law, a title risk, an old land measure.
  const history = useMemo(() => {
    if (!data || !texts) return null;
    return data.files.map((f) => ({ f, a: analyzeLegalHistory(texts[f.rel] || '') }))
      .filter(({ a }) => a.historical || a.property_status_risks.length || a.surface_conversions.some((x) => x.parts.some((p) => !['hectar', 'ar', 'm²'].includes(p.unit))))
      .sort((x, y) => (y.a.property_status_risks.length - x.a.property_status_risks.length) || ((x.a.year || 9999) - (y.a.year || 9999)));
  }, [data, texts]);
  const [anafRows, setAnafRows] = useState(null);
  useEffect(() => { setAnafRows(null); }, [authenticity]);

  const fileOf = useCallback((rel) => {
    const f = data?.all.find((x) => x.rel === rel) || data?.files.find((x) => x.rel === rel) || data?.collections.find((x) => x.rel === rel);
    return f || { rel, name: String(rel).split('/').pop(), path: '' };
  }, [data]);
  const openRef = useRef(onOpenPath);
  openRef.current = onOpenPath;
  const files = useMemo(() => ({
    fileOf,
    open: (rel) => { const f = fileOf(rel); if (f.path) openRef.current?.(f.path, f.name); },
  }), [fileOf]);

  const authRows = anafRows || authenticity;
  const problems = (rows) => (rows || []).filter((r) => r.status !== 'ok').length;
  const count = (n) => (n == null ? '' : ` · ${n}`);
  const field = {
    label: 'Insights',
    options: [
      { id: 'contradictions', label: `Contradictions${count(openContradictions)}`, example: 'Where two files disagree about the same person or matter' },
      { id: 'authenticity', label: `Authenticity${count(authRows ? problems(authRows) : null)}`, example: 'CNPs, identity documents’ machine-readable strip, expiry dates and CUIs' },
      { id: 'missing', label: 'Missing documents', example: 'What a file for this kind of case normally holds, and what is not here' },
      { id: 'duplicates', label: 'Duplicates', example: 'The same file saved twice, near-identical pictures, later versions of a text' },
      { id: 'signatures', label: 'Signatures & stamps', example: 'Signatures and stamps compared across documents (AI)' },
      { id: 'places', label: `Plates & places${count(vehicles?.length)}`, example: 'Number plates in the files, and when and where the photos were taken' },
      { id: 'history', label: `Legal history${count(history?.length)}`, example: 'Documents read in the law of their own time: era, archaic terms, expropriation decrees, title risks, old land measures converted' },
    ],
  };

  let body;
  if (!data) {
    body = <div className="ci-empty"><Spinner /><p className="ci-empty-sub">Reading what the scan found…</p></div>;
  } else if (!data.scanned) {
    body = (
      <div className="ci-empty">
        <Mark name="empty" />
        <p className="ci-empty-title">Nothing scanned yet</p>
        <p className="ci-empty-sub">Tag files for the AI scan and run it. The checks here work on what the scan read from them.</p>
      </div>
    );
  } else if (!texts) {
    body = (
      <div className="ci-empty">
        <Spinner />
        <p className="ci-empty-sub">Reading the files&rsquo; text{textProgress ? ` · ${textProgress.done} of ${textProgress.total}` : ''}…</p>
      </div>
    );
  } else if (section === 'contradictions') {
    body = <ContradictionsSection rows={contradictions} data={data} projectId={projectId} resolutions={resolutions} onResolutions={setResolutions} Chips={Chips} />;
  } else if (section === 'authenticity') {
    body = <AuthenticitySection rows={authRows} onAnaf={setAnafRows} Chips={Chips} />;
  } else if (section === 'missing') {
    body = <MissingSection data={data} dir={scopeKey} Chips={Chips} />;
  } else if (section === 'duplicates') {
    body = <DuplicatesSection data={data} texts={texts} Chips={Chips} onFound={setDupes} />;
  } else if (section === 'signatures') {
    body = <SignaturesSection data={data} dir={scopeKey} projectId={projectId} Chips={Chips} />;
  } else if (section === 'history') {
    body = <HistorySection rows={history} />;
  } else {
    body = <PlacesSection data={data} vehicles={vehicles} Chips={Chips} />;
  }

  return (
    <div className="ci-view">
      <div className="ci-bar">
        <RuleOptions field={field} value={section} onPick={pick} className="ci-sections" />
        <div className="ci-bar-tools">
          {data?.scanned > 0 && <span className="ci-note">{collection ? `${data.scanned} file${data.scanned === 1 ? '' : 's'} in this collection` : `${data.scanned} file${data.scanned === 1 ? '' : 's'} read · ${data.collections.length} collection${data.collections.length === 1 ? '' : 's'}`}</span>}
          <Tooltip content="Read the scan again">
            <button type="button" className="ci-tool" onClick={load} aria-label="Refresh">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>
            </button>
          </Tooltip>
        </div>
      </div>
      <FilesCtx.Provider value={files}><div className="ci-body">{body}</div></FilesCtx.Provider>
    </div>
  );
}

function SectionHead({ title, sub, children }) {
  return (
    <div className="ci-head">
      <div className="ci-head-text">
        <h3 className="ci-title">{title}</h3>
        {sub && <p className="ci-sub">{sub}</p>}
      </div>
      {children && <div className="ci-head-tools">{children}</div>}
    </div>
  );
}

function Row({ status = 'warn', title, tag, children }) {
  return (
    <div className={`ci-row is-${status}`}>
      <span className="ci-dot" aria-hidden="true" />
      <div className="ci-row-main">
        <div className="ci-row-title">
          <span>{title}</span>
          {tag && <span className={`ci-pill is-${status}`}>{tag}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

function Nothing({ text }) {
  return <p className="ci-nothing"><span className="ci-dot is-ok" aria-hidden="true" />{text}</p>;
}

// ── Contradictions ─────────────────────────────────────────────────────
// ── Explaining a contradiction in plain words ──────────────────────────
const LETTER = (i) => String.fromCharCode(65 + i);
const plural = (n, one, many) => (n === 1 ? one : many);
// The headline and why it matters, per kind of detail.
function explainLocal(r, docOf) {
  const who = r.subject;
  const n = r.values.length;
  const bad = r.kind === 'cnp' ? r.values.filter((v) => !checkCnp(v.value).valid) : [];
  switch (r.kind) {
    case 'cnp': return {
      headline: `The files give ${who} ${n} different CNPs`,
      why: `A person has only one CNP (personal numeric code), so at least one of these is wrong — usually a typing mistake. It matters: a contract or a statement with the wrong CNP legally points to someone else.${bad.length ? ` ${bad.map((v) => `${v.value}`).join(' and ')} ${plural(bad.length, 'fails', 'fail')} the CNP check digit, so ${plural(bad.length, 'it is', 'they are')} certainly mistyped.` : ''}`,
    };
    case 'birth': return {
      headline: `The files give ${who} ${n} different dates of birth`,
      why: 'A person has one date of birth, so one of these is a mistake. The identity document is normally the one to trust.',
    };
    case 'address': return {
      headline: `The files give ${who} ${n} different addresses`,
      why: 'This is either a move (an older document still shows the old address) or a mistake. A new document should use the address on the current identity card.',
    };
    case 'amount': return {
      headline: `The documents about ${who} state different amounts`,
      why: `They disagree on ${r.values[0]?.said?.[0]?.label ? `“${r.values[0].said[0].label}”` : 'an amount'}. That can be a renegotiation (an addendum changing the price) or an error in one of them.`,
    };
    case 'signDate': return {
      headline: `The documents about ${who} give different signature dates`,
      why: 'The same act is dated differently in two files. It may be two different acts (a contract and its addendum) or a mistake in one of them.',
    };
    default: return { headline: `The files disagree about ${who}`, why: '' };
  }
}
// The characters (or, for an address, the words) of `value` that differ
// from the other values — drawn highlighted, so the difference is seen at once.
function DiffText({ value, others, words = false }) {
  const v = String(value);
  if (words) {
    const fold = (w) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const elsewhere = new Set(others.flatMap((o) => String(o).split(/\s+/).map(fold)));
    return <>{v.split(/(\s+)/).map((w, i) => (/\S/.test(w) && fold(w) && !elsewhere.has(fold(w)) ? <mark key={i} className="ci-diff">{w}</mark> : <span key={i}>{w}</span>))}</>;
  }
  const other = others.find((o) => String(o).length === v.length);
  if (!other) return <>{v}</>;
  const o = String(other);
  return <>{v.split('').map((ch, i) => (ch !== o[i] ? <mark key={i} className="ci-diff">{ch}</mark> : <span key={i}>{ch}</span>))}</>;
}

function ContradictionsSection({ rows, data, projectId, resolutions, onResolutions, Chips }) {
  const [busy, setBusy] = useState('');            // the row being written
  const [error, setError] = useState({});           // row id → message
  const [advice, setAdvice] = useState({});         // row id → 'busy' | { answer, sources } | { error }
  // Differences between COPIES of one document are misreadings, not
  // contradictions — folded away under their own heading.
  const copies = rows.filter((r) => r.copiesOnly && !resolutionFor(resolutions, r));
  const open = rows.filter((r) => !r.copiesOnly && !resolutionFor(resolutions, r));
  const done = rows.filter((r) => resolutionFor(resolutions, r));
  const nameOf = (rel) => String(rel).split('/').pop();
  // What a file is, in words ("sale contract", "identity card").
  const docOf = (rel) => data?.files?.find((f) => f.rel === rel)?.u?.documentType || '';
  const act = async (r, fn) => {
    setBusy(r.id); setError((e) => ({ ...e, [r.id]: '' }));
    try { onResolutions(await fn()); } catch (err) { setError((e) => ({ ...e, [r.id]: err?.message === 'write_failed' ? 'A data collection couldn’t be written — it may be open elsewhere.' : 'Couldn’t save that.' })); }
    setBusy('');
  };
  const resolve = (r, choice) => act(r, () => resolveContradiction(data, r, choice, { projectId }));
  const undo = (r) => act(r, () => unresolveContradiction(data, r, { projectId }));
  const suggest = async (r) => {
    setAdvice((a) => ({ ...a, [r.id]: 'busy' }));
    const res = await suggestResolution(data, r, { projectId }).catch((e) => ({ error: e?.message || 'failed' }));
    setAdvice((a) => ({ ...a, [r.id]: res }));
  };
  const Advice = ({ r }) => {
    const a = advice[r.id];
    if (!a) return null;
    if (a === 'busy') return <p className="ci-row-note"><span className="ci-spin" /> Weighing the files…</p>;
    if (a.error) return <p className="ci-row-note is-error">The AI couldn’t answer: {a.error}</p>;
    return (
      <div className="ci-advice">
        <span className="ci-label">The AI’s view</span>
        <p className="ci-row-detail">{a.answer}</p>
        {a.sources?.length > 0 && <Chips rels={a.sources.map((x) => x.rel)} dim />}
      </div>
    );
  };
  const tools = (r, extra) => (
    <div className="ci-resolve">
      {extra}
      <Tooltip content="Ask the AI which is right, from the files (uses AI tokens)">
        <button type="button" className="ci-btn is-small" onClick={() => suggest(r)} disabled={advice[r.id] === 'busy'}>Suggest</button>
      </Tooltip>
    </div>
  );
  const decision = (r) => {
    const x = resolutionFor(resolutions, r);
    const c = x?.choice || {};
    if (c.type === 'value') return `Confirmed: ${c.value}${x.changed?.length ? ` — written into ${x.changed.length} data collection${x.changed.length === 1 ? '' : 's'}` : ''}`;
    if (c.type === 'file') return `${nameOf(c.rel)} is correct${x.changed?.length ? ` — noted in ${x.changed.length} data collection${x.changed.length === 1 ? '' : 's'}` : ''}`;
    if (c.type === 'both') return 'Both are right — the change was intended';
    return 'Not a contradiction';
  };
  return (
    <div className="ci-section">
      <SectionHead title="Contradictions" sub="Places where your files disagree about the same thing — a person's CNP, date of birth or address, an amount, a signature date. Each shows the versions side by side, with what differs highlighted and which files say what. Pick the version that is right: it is saved as confirmed in the Data collections. Or say both are right when the change was intended." />
      {!rows.length && <Nothing text="No file contradicts another on what the scan read." />}
      {rows.length > 0 && !open.length && <Nothing text={copies.length ? 'No real contradiction — only copies of one file read differently (below).' : 'Every contradiction is resolved.'} />}
      {open.filter((r) => r.source === 'local').map((r) => (
        <Row key={r.id} status={r.severity} title={explainLocal(r, docOf).headline} tag={`${claimKindLabel(r.kind)} · ${r.severity === 'error' ? 'Conflict' : 'Differs'}`}>
          <p className="ci-row-detail">{explainLocal(r, docOf).why}</p>
          {/* One card per version: what it says (the difference marked), and
              every file that says it — what kind of document, and in its own words. */}
          <div className="ci-compare">
            {r.values.map((v, i) => (
              <div key={i} className="ci-version">
                <span className="ci-label">
                  Version {LETTER(i)} · {v.files.length} {plural(v.files.length, 'file', 'files')}
                  {v.documents && v.documents < v.files.length ? ` (${v.documents} ${plural(v.documents, 'document', 'documents')} — the rest are copies)` : ''}
                  {v.authority ? ` · ${v.authority.label}` : ''}
                </span>
                {i === 0 && v.authority && r.values.length > 1 && v.authority.score > (r.values[1]?.authority?.score || 0) && (
                  <Tooltip content="Backed by the most official document here (identity document > state record > notarised act > contract > anything else) — usually the one to trust">
                    <span className="ci-pill is-ok ci-official">Most official source</span>
                  </Tooltip>
                )}
                <div className="ci-version-value">
                  <DiffText value={v.value} others={r.values.filter((x) => x !== v).map((x) => x.value)} words={r.kind === 'address'} />
                </div>
                <ul className="ci-said">
                  {(v.said?.length ? v.said : v.files.map((rel) => ({ rel }))).map((x, k) => (
                    <li key={k}>
                      <Chips rels={[x.rel]} />
                      <span className="ci-said-text">
                        {docOf(x.rel) ? <b>{docOf(x.rel)}</b> : null}
                        {x.label ? <>{docOf(x.rel) ? ' — ' : ''}says “{x.label}: {x.raw}”</> : null}
                      </span>
                    </li>
                  ))}
                </ul>
                <Tooltip content="This version is right — confirm it, and write it into the data collections">
                  <button type="button" className="ci-btn is-small ci-pick" disabled={busy === r.id} onClick={() => resolve(r, { type: 'value', value: v.value, files: v.files })}>Version {LETTER(i)} is right</button>
                </Tooltip>
              </div>
            ))}
          </div>
          {r.note && <p className="ci-row-note">{r.note}</p>}
          {tools(r, (
            <Tooltip content="Both values are right (the detail changed on purpose) — close it without changing anything">
              <button type="button" className="ci-btn is-small" disabled={busy === r.id} onClick={() => resolve(r, { type: 'both' })}>Both are right</button>
            </Tooltip>
          ))}
          <Advice r={r} />
          {error[r.id] && <p className="ci-row-note is-error">{error[r.id]}</p>}
        </Row>
      ))}
      {open.some((r) => r.source === 'ai') && <div className="ci-subhead">Found by the AI scan&rsquo;s cross-reference</div>}
      {open.filter((r) => r.source === 'ai').map((r) => (
        <Row key={r.id} status="warn" title={`${nameOf(r.files[0])} and ${nameOf(r.files[1])} may contradict each other`} tag={r.confidence ? `AI · ${Math.round(r.confidence * 100)}% sure` : 'AI'}>
          <p className="ci-row-detail"><b>What the AI noticed:</b> {r.why || 'the two files state incompatible things.'}</p>
          <div className="ci-compare">
            {r.files.map((rel, i) => (
              <div key={rel} className="ci-version">
                <span className="ci-label">File {LETTER(i)}{docOf(rel) ? ` · ${docOf(rel)}` : ''}{r.authorities?.[rel] ? ` · ${r.authorities[rel].label}` : ''}</span>
                {r.authorities && Math.max(...Object.values(r.authorities).map((x) => x.score)) === r.authorities[rel]?.score
                  && new Set(Object.values(r.authorities).map((x) => x.score)).size > 1 && (
                  <Tooltip content="The more official document of the two (identity document > state record > notarised act > contract > anything else) — usually the one to trust">
                    <span className="ci-pill is-ok ci-official">Most official source</span>
                  </Tooltip>
                )}
                <Chips rels={[rel]} />
                {r.evidence?.[i] && <p className="ci-said-text">Says: “{r.evidence[i]}”</p>}
              </div>
            ))}
          </div>
          {r.evidence?.length > 2 && <ul className="ci-evidence">{r.evidence.slice(2).map((e, i) => <li key={i}>{e}</li>)}</ul>}
          {tools(r, (
            <>
              {r.files.map((rel) => (
                <Tooltip key={rel} content={`${nameOf(rel)} is the one that is right — noted in the data collections`}>
                  <button type="button" className="ci-btn is-small" disabled={busy === r.id} onClick={() => resolve(r, { type: 'file', rel })}>{nameOf(rel)} is right</button>
                </Tooltip>
              ))}
              <Tooltip content="The files don’t really contradict each other — close it">
                <button type="button" className="ci-btn is-small" disabled={busy === r.id} onClick={() => resolve(r, { type: 'dismiss' })}>Not a contradiction</button>
              </Tooltip>
            </>
          ))}
          <Advice r={r} />
          {error[r.id] && <p className="ci-row-note is-error">{error[r.id]}</p>}
        </Row>
      ))}
      {copies.length > 0 && (
        <details className="ci-fold">
          <summary>{copies.length} {plural(copies.length, 'difference', 'differences')} between copies of the same file — not contradictions</summary>
          {copies.map((r) => (
            <Row key={r.id} status="ok" title={r.source === 'ai' ? `${nameOf(r.files[0])} and ${nameOf(r.files[1])}` : `${claimKindLabel(r.kind)} · ${r.subject}`} tag="Copies">
              <p className="ci-row-detail">{r.note}</p>
              {r.values?.length > 0 && (
                <ul className="ci-said">
                  {r.values.map((v, i) => (
                    <li key={i}><Chips rels={v.files} dim /><span className="ci-said-text">read as “{v.value}”</span></li>
                  ))}
                </ul>
              )}
              {r.source === 'ai' && <Chips rels={r.files} dim />}
              <div className="ci-resolve">
                {(r.values || []).map((v, i) => (
                  <Tooltip key={i} content="This reading is right — confirm it, and write it into the data collections">
                    <button type="button" className="ci-btn is-small" disabled={busy === r.id} onClick={() => resolve(r, { type: 'value', value: v.value, files: v.files })}>“{v.value}” is right</button>
                  </Tooltip>
                ))}
              </div>
            </Row>
          ))}
        </details>
      )}
      {done.length > 0 && (
        <details className="ci-fold">
          <summary>{done.length} resolved</summary>
          {done.map((r) => (
            <Row key={r.id} status="ok" title={r.source === 'ai' ? (r.why || 'Contradiction') : `${claimKindLabel(r.kind)} · ${r.subject}`} tag="Resolved">
              <p className="ci-row-detail">{decision(r)}</p>
              <div className="ci-resolve">
                <Chips rels={r.files} dim />
                <Tooltip content="Open it again — and put the data collections back as they were">
                  <button type="button" className="ci-btn is-small" disabled={busy === r.id} onClick={() => undo(r)}>Undo</button>
                </Tooltip>
              </div>
              {error[r.id] && <p className="ci-row-note is-error">{error[r.id]}</p>}
            </Row>
          ))}
        </details>
      )}
    </div>
  );
}

// ── Authenticity ───────────────────────────────────────────────────────
function AuthenticitySection({ rows, onAnaf, Chips }) {
  const [anaf, setAnaf] = useState(null);   // null | 'busy' | { asked, error }
  const cuis = rows.filter((r) => r.kind === 'cui' && r.status === 'ok' && !r.anaf).length;
  const checkAnaf = async () => {
    setAnaf('busy');
    const res = await checkCuisWithAnaf(rows).catch((e) => ({ rows, error: e?.message || 'failed' }));
    onAnaf(res.rows);
    setAnaf(res);
  };
  const groups = [
    ['cnp', 'CNP'], ['mrz', 'Machine-readable strip'], ['expiry', 'Expiry'], ['cui', 'CUI'],
  ].map(([k, label]) => [label, rows.filter((r) => r.kind === k)]).filter(([, list]) => list.length);
  return (
    <div className="ci-section">
      <SectionHead title="Authenticity" sub="Every CNP's check digit and birth date, the machine-readable strip on the back of an identity card or passport against what is printed, expired documents, and every CUI's check digit — and, on request, ANAF.">
        {cuis > 0 && (
          <Tooltip content="Ask ANAF whether each company exists, is active and has the name the files give it">
            <button type="button" className="ci-btn" onClick={checkAnaf} disabled={anaf === 'busy'}>
              {anaf === 'busy' ? <><Spinner /> Asking ANAF…</> : `Check ${cuis} CUI${cuis === 1 ? '' : 's'} with ANAF`}
            </button>
          </Tooltip>
        )}
      </SectionHead>
      {anaf?.error && <p className="ci-row-note is-error">ANAF couldn&rsquo;t be reached ({anaf.error}).</p>}
      {!rows.length && <Nothing text="No CNP, identity document or CUI was found in the scanned files." />}
      {groups.map(([label, list]) => (
        <React.Fragment key={label}>
          <div className="ci-subhead">{label}</div>
          {list.map((r) => (
            <Row key={r.id} status={r.status} title={r.title} tag={STATUS_LABEL[r.status]}>
              <p className="ci-row-detail">{r.detail}</p>
              {r.lines && <pre className="ci-mrz">{r.lines.join('\n')}</pre>}
              <Chips rels={r.files} />
            </Row>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Missing documents ──────────────────────────────────────────────────
function MissingSection({ data, dir, Chips }) {
  const [typeId, setTypeId] = useState(() => read(CASE_KEY + dir, ''));
  const res = useMemo(() => checklist(data, typeId || null), [data, typeId]);
  const choose = (id) => { setTypeId(id); write(CASE_KEY + dir, id); };
  const missing = res.items.filter((i) => !i.found.length && !i.optional);
  const field = { label: 'Kind of case', options: CASE_TYPES.map((t) => ({ id: t.id, label: t.label })) };
  return (
    <div className="ci-section">
      <SectionHead
        title="Missing documents"
        sub={`${res.guessed ? `This looks like a ${res.type.label.toLowerCase()} — pick another kind if it isn’t. ` : ''}${missing.length ? `${missing.length} document${missing.length === 1 ? '' : 's'} a file like this normally holds ${missing.length === 1 ? 'is' : 'are'} not among the scanned files.` : 'Everything a file like this normally holds is here.'}`}
      />
      <RuleOptions field={field} value={res.type.id} onPick={choose} className="ci-cases" />
      <div className="ci-checklist">
        {res.items.map((it) => {
          const status = it.found.length ? 'ok' : it.optional ? 'idle' : 'error';
          return (
            <Row key={it.label} status={status} title={it.found.length ? it.label : `No ${it.label.charAt(0).toLowerCase()}${it.label.slice(1)}`} tag={it.found.length ? 'Here' : it.optional ? 'If it applies' : 'Missing'}>
              {it.hint && <p className="ci-row-detail">{it.hint}</p>}
              {it.found.length > 0 && <Chips rels={it.found.slice(0, 8)} />}
            </Row>
          );
        })}
      </div>
    </div>
  );
}

// ── Duplicates ─────────────────────────────────────────────────────────
function DuplicatesSection({ data, texts, Chips, onFound }) {
  const [res, setRes] = useState(null);
  const [progress, setProgress] = useState(null);
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  const run = async () => {
    stop.current = false;
    setProgress({ step: 'Starting', frac: 0 });
    const r = await findDuplicates(data, texts, { onProgress: (step, frac) => setProgress({ step, frac }), isCancelled: () => stop.current }).catch(() => null);
    setProgress(null);
    if (r) { setRes(r); onFound?.(r); }
  };
  const total = res ? res.exact.length + res.similar.length + res.versions.length : 0;
  return (
    <div className="ci-section">
      <SectionHead title="Duplicates" sub={`The same file saved twice, the same photo or scan kept twice (even resized or re-saved), and later versions of one text — across all ${data.all.length} files in the folder. Nothing leaves this computer.`}>
        <button type="button" className="ci-btn" onClick={progress ? () => { stop.current = true; } : run}>
          {progress ? 'Stop' : res ? 'Look again' : 'Find duplicates'}
        </button>
      </SectionHead>
      {progress && (
        <div className="ci-progress">
          <span className="ci-progress-bar"><span style={{ width: `${Math.round(progress.frac * 100)}%` }} /></span>
          <span className="ci-progress-step">{progress.step}</span>
        </div>
      )}
      {res && !total && <Nothing text="No duplicates or versions found." />}
      {res?.exact.length > 0 && <div className="ci-subhead">Identical files</div>}
      {res?.exact.map((g) => (
        <IdenticalRow
          key={g.map((f) => f.rel).join('|')}
          group={g}
          dir={data.dir}
          onMerged={(kept) => setRes((r) => ({ ...r, exact: r.exact.filter((x) => x !== g), merged: [...(r.merged || []), kept] }))}
        />
      ))}
      {res?.merged?.length > 0 && (
        <p className="ci-row-note">Merged {res.merged.length} group{res.merged.length === 1 ? '' : 's'} — the extra copies are in the Trash, where they can be restored.</p>
      )}
      {res?.similar.length > 0 && <div className="ci-subhead">Near-identical pictures</div>}
      {res?.similar.map((s, i) => (
        <Row key={`s${i}`} status="warn" title={`${s.files[0].name} and ${s.files[1].name}`} tag={s.distance <= 2 ? 'Same picture' : 'Very similar'}>
          <p className="ci-row-detail">The same photo or scan, resized, re-saved or lightly edited.</p>
          <Chips rels={s.files.map((f) => f.rel)} />
        </Row>
      ))}
      {res?.versions.length > 0 && <div className="ci-subhead">Versions of one text</div>}
      {res?.versions.map((v, i) => (
        <Row key={`v${i}`} status={v.likeness > 0.97 ? 'warn' : 'idle'} title={v.likeness > 0.97 ? `${v.newer.name} repeats ${v.older.name}` : `${v.newer.name} is a later version of ${v.older.name}`} tag={`${Math.round(v.likeness * 100)}% the same`}>
          <p className="ci-row-detail">{v.likeness > 0.97 ? 'The same text in two files.' : 'Most of the text is shared; the newer file (by date modified) is second.'}</p>
          <Chips rels={[v.older.rel, v.newer.rel]} />
        </Row>
      ))}
    </div>
  );
}

// Identical files: pick the copy to keep (the oldest by default); MERGE moves
// every other copy to the project's Trash (restorable), pressed twice.
function IdenticalRow({ group, dir, onMerged }) {
  const [keep, setKeep] = useState(group[0].rel);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!confirm) return undefined;
    const t = window.setTimeout(() => setConfirm(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirm]);
  const others = group.filter((f) => f.rel !== keep);
  const field = {
    label: 'Keep',
    options: group.map((f, i) => ({ id: f.rel, label: f.rel, example: `${i === 0 ? 'The oldest copy. ' : ''}Keep this one` })),
  };
  const merge = async () => {
    if (!confirm) { setConfirm(true); return; }
    setConfirm(false);
    setBusy(true);
    setError('');
    const failed = [];
    for (const f of others) {
      try {
        const r = await localFolderApi.trashFile({ dir, path: f.path });
        if (r?.error) failed.push(f.name);
      } catch { failed.push(f.name); }
    }
    notifyFilesChanged();
    setBusy(false);
    if (failed.length) setError(`${failed.length === others.length ? 'Nothing was' : `${failed.length} cop${failed.length === 1 ? 'y wasn\u2019t' : 'ies weren\u2019t'}`} moved to the Trash: ${failed.join(', ')}.`);
    else onMerged(keep);
  };
  return (
    <Row status="warn" title={`${group.length} copies of ${group[0].name}`} tag="Identical">
      <p className="ci-row-detail">Byte for byte the same. Merging keeps the copy picked below and moves the other {others.length} to the Trash, where {others.length === 1 ? 'it' : 'they'} can be restored.</p>
      <div className="ci-keep">
        <span className="ci-label">Keep</span>
        <RuleOptions field={field} value={keep} onPick={setKeep} className="ci-keep-opts" />
      </div>
      <div className="ci-rowtools">
        <Chips rels={group.map((f) => f.rel)} />
        <Tooltip content={confirm ? 'Press again to merge' : `Keep ${keep} and move the other ${others.length === 1 ? 'copy' : `${others.length} copies`} to the Trash`}>
          <button type="button" className={`ci-btn is-small${confirm ? ' is-danger' : ''}`} onClick={merge} disabled={busy}>
            {busy ? <><Spinner /> Merging…</> : confirm ? `Move ${others.length} to the Trash?` : 'Merge'}
          </button>
        </Tooltip>
      </div>
      {error && <p className="ci-row-note is-error">{error}</p>}
    </Row>
  );
}

// ── Signatures and stamps ──────────────────────────────────────────────
function SignaturesSection({ data, dir, projectId, Chips }) {
  const [report, setReport] = useState(() => loadSignatureReport(dir));
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  const run = async () => {
    stop.current = false;
    setError('');
    setProgress({ step: 'Choosing the pages', frac: 0 });
    const r = await compareSignatures(data, { projectId, onProgress: (step, frac) => setProgress({ step, frac }), isCancelled: () => stop.current })
      .catch((e) => ({ error: e?.message || 'failed' }));
    setProgress(null);
    if (!r) return;
    if (r.error) setError(r.error === 'nothing' ? 'No scanned picture or PDF looks like a signed document.' : r.error);
    else setReport(r);
  };
  const unmatched = report ? report.marks.filter((m) => !report.groups.some((g) => g.marks.some((x) => x.rel === m.rel && x.kind === m.kind && x.owner === m.owner))) : [];
  return (
    <div className="ci-section">
      <SectionHead title="Signatures and stamps" sub="Every signature and stamp on the scanned pictures and PDFs is found and described, then those of one person or company are compared side by side, and any that look different from the rest are flagged. A first look to guide you, not an expert opinion. Uses AI tokens: the pages are sent to the AI.">
        <button type="button" className="ci-btn" onClick={progress ? () => { stop.current = true; } : run}>
          {progress ? 'Stop' : report ? 'Compare again' : 'Compare signatures and stamps'}
        </button>
      </SectionHead>
      {progress && (
        <div className="ci-progress">
          <span className="ci-progress-bar"><span style={{ width: `${Math.round(progress.frac * 100)}%` }} /></span>
          <span className="ci-progress-step">{progress.step}</span>
        </div>
      )}
      {error && <p className="ci-row-note is-error">{error}</p>}
      {report && (
        <p className="ci-note">{report.marks.length} mark{report.marks.length === 1 ? '' : 's'} on {report.pages} page{report.pages === 1 ? '' : 's'} · compared {new Date(report.at).toLocaleString()}</p>
      )}
      {report && !report.groups.length && <Nothing text="No person or company has a signature or stamp in more than one document, so there was nothing to compare." />}
      {report?.groups.map((g) => (
        <Row key={g.key} status={g.consistent === false ? 'error' : g.consistent ? 'ok' : 'warn'} title={`${g.kind === 'stamp' ? 'Stamp' : 'Signature'} of ${g.owner}`} tag={g.consistent === false ? 'Looks different' : g.consistent ? 'Consistent' : 'Not compared'}>
          {g.note && <p className="ci-row-detail">{g.note}</p>}
          {g.outliers.map((o) => (
            <div key={o.label} className="ci-value is-outlier">
              <span className="ci-value-text">{o.why}</span>
              <Chips rels={[o.rel]} />
            </div>
          ))}
          <div className="ci-marks">
            {g.marks.map((m) => (
              <div key={m.label} className="ci-markrow">
                <Chips rels={[m.rel]} dim />
                <span className="ci-markdesc">{m.page ? `Page ${m.page}. ` : ''}{m.stampText ? `“${m.stampText}”. ` : ''}{m.description}</span>
              </div>
            ))}
          </div>
        </Row>
      ))}
      {unmatched.length > 0 && (
        <details className="ci-fold">
          <summary>{unmatched.length} other mark{unmatched.length === 1 ? '' : 's'} (seen once, or whose owner isn&rsquo;t stated)</summary>
          {unmatched.map((m, i) => (
            <div key={i} className="ci-markrow">
              <Chips rels={[m.rel]} dim />
              <span className="ci-markdesc"><b>{m.kind === 'stamp' ? 'Stamp' : 'Signature'}{m.owner ? ` · ${m.owner}` : ''}.</b> {m.stampText ? `“${m.stampText}”. ` : ''}{m.description}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// ── Legal history ──────────────────────────────────────────────────────
const ERA_SHORT = {
  ERA_1_FEUDAL: 'Feudal · before 1831', ERA_2_TRANSITIONAL: 'Organic Regulations · 1831–1864', ERA_3_INTERWAR: 'Civil Code 1864 · 1864–1947',
  ERA_4_COMMUNIST: 'Communist · 1948–1989', ERA_5_POSTCOMMUNIST: 'Post-1989 · 1990–2006', ERA_6_EU: 'EU · 2007–',
};
const RISK_LABEL = {
  DOTAL_RESTRICTION: 'Dotal property', SOCIALIST_USE_ONLY: 'Land in use only', UNREGULATED_PREEMPTION_PROTIMISIS: 'Protimisis', EXPROPRIATION_DECREE: 'Taken by the state',
  COOPERATIVIZED_LAND: 'Collectivised land', LAND_ALIENATION_BAN_1974: '1974 land-sale ban', UNAUTHENTICATED_TITLE: 'Unauthenticated title',
  EMPHYTEUSIS: 'Emphyteusis', UNREGISTERED_OLD_REGISTRY: 'Old transcription register', CO_OWNERSHIP_DEVALMASIE: 'Undivided co-ownership',
};
const UNIT_OPTIONS = [['pogon', 'pogoane'], ['falcie', 'fălci'], ['prajina', 'prăjini'], ['stanjen_patrat', 'stânjeni pătrați'], ['jugar', 'jugăre'], ['jugar_unguresc', 'jugăre unguresti'], ['lant', 'lanțuri']];
function LandConverter() {
  const [value, setValue] = useState('1');
  const [unit, setUnit] = useState('pogon');
  const [region, setRegion] = useState('');
  const res = convertHistoricalLandToMetric(Number(String(value).replace(',', '.')), unit, region || null);
  return (
    <div className="ci-convert">
      <input className="ci-convert-num" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" aria-label="Amount" />
      <select className="ci-convert-sel" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit">
        {UNIT_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <select className="ci-convert-sel" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region">
        <option value="">its own region</option>
        <option value="tara_romaneasca">Țara Românească</option>
        <option value="moldova">Moldova</option>
        <option value="transilvania">Transilvania</option>
      </select>
      <span className="ci-convert-out">= <b>{res ? res.square_meters.toLocaleString('ro-RO') : '—'} m²</b>{res ? ` · ${res.hectares.toLocaleString('ro-RO')} ha` : ''}</span>
    </div>
  );
}
function HistorySection({ rows }) {
  return (
    <div className="ci-section">
      <SectionHead title="Legal history" sub="Every scanned document read in the law of its own time: the era it was written in and the codes that applied, its archaic terms mapped to today's concepts, the decrees it cites (for restitution claims), the title risks a lawyer must check, and its old land measures converted to m². Worked out on this computer.">
        <LandConverter />
      </SectionHead>
      {!rows.length && <Nothing text="No scanned document is from an earlier legal era, cites a taking of property or uses an old land measure." />}
      {rows.map(({ f, a }) => (
        <Row key={f.rel} status={a.property_status_risks.length ? 'warn' : 'idle'} title={f.name} tag={a.detected_era ? ERA_SHORT[a.detected_era] : 'Era unclear'}>
          <p className="ci-row-detail">
            {a.year ? `Dated ${a.year}. ` : ''}{a.script !== 'latin' ? (a.script === 'cyrillic' ? 'Cyrillic script. ' : 'Transitional alphabet. ') : ''}
            {a.applicable_historical_code ? `Law then: ${a.applicable_historical_code}.` : ''}
          </p>
          {a.property_status_risks.map((r) => (
            <div key={r.risk_type} className="ci-value">
              <span className="ci-value-text"><b>{RISK_LABEL[r.risk_type] || r.risk_type}.</b> {r.legal_explanation_for_lawyer}{r.evidence.length ? ` (${r.evidence.join('; ')})` : ''}</span>
            </div>
          ))}
          {a.decrees.length > 0 && (
            <ul className="ci-evidence">{a.decrees.map((d) => <li key={d.key}><b>{d.key}</b>{d.what ? ` — ${d.what}` : ''}{d.claim ? `. Claim under: ${d.claim}` : ''}</li>)}</ul>
          )}
          {a.surface_conversions.length > 0 && (
            <ul className="ci-evidence">{a.surface_conversions.map((x, i) => (
              <li key={i}>{x.original_value} {x.calculated_square_meters != null ? <>≈ <b>{x.calculated_square_meters.toLocaleString('ro-RO')} m²</b> ({x.hectares.toLocaleString('ro-RO')} ha)</> : '— a width, not an area'}{x.assumptions.length ? ` · ${x.assumptions.join(' ')}` : ''}</li>
            ))}</ul>
          )}
          {a.terms.length > 0 && (
            <details className="ci-fold">
              <summary>{a.terms.length} historical term{a.terms.length === 1 ? '' : 's'}</summary>
              <ul className="ci-evidence">{a.terms.map((t) => <li key={t.id}><b>{t.term}</b> = {t.modern}{t.implication ? `. ${t.implication}` : ''}</li>)}</ul>
            </details>
          )}
          <Chips rels={[f.rel]} />
        </Row>
      ))}
      <details className="ci-fold">
        <summary>The eras</summary>
        <ul className="ci-evidence">{LEGAL_ERAS.map((e) => <li key={e.id}><b>{e.label}</b> — {e.codes}</li>)}</ul>
      </details>
    </div>
  );
}

// ── Plates and places ──────────────────────────────────────────────────
function PlacesSection({ data, vehicles, Chips }) {
  const [photos, setPhotos] = useState(null);
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    let dead = false;
    setPhotos(null);
    readPhotoPlaces(data, { isCancelled: () => dead, onProgress: (done, total) => { if (!dead) setProgress({ done, total }); } })
      .then((p) => { if (!dead) { setPhotos(p); setProgress(null); } })
      .catch(() => { if (!dead) setPhotos([]); });
    return () => { dead = true; };
  }, [data]);
  return (
    <div className="ci-section">
      <SectionHead title="Number plates" sub="Romanian number plates read in the files and pictures, with the people, collections and dates they appear with." />
      {!vehicles.length && <Nothing text="No number plate was read in the scanned files." />}
      {vehicles.map((v) => (
        <Row key={v.plate} status="idle" title={<span className="ci-plate">{v.plate}</span>} tag={`${v.files.length} file${v.files.length === 1 ? '' : 's'}`}>
          {v.people.length > 0 && <p className="ci-row-detail">With {v.people.slice(0, 6).join(', ')}{v.people.length > 6 ? ` and ${v.people.length - 6} more` : ''}.</p>}
          {v.collections.length > 0 && <p className="ci-row-detail">In {v.collections.join(', ')}.</p>}
          {v.dates.length > 0 && (
            <ul className="ci-evidence">{v.dates.slice(0, 5).map((d, i) => <li key={i}><b>{showDate(d.date)}</b> {d.event}</li>)}</ul>
          )}
          <Chips rels={v.files} />
        </Row>
      ))}
      <SectionHead title="Photos: when and where" sub="The date and GPS position a phone or camera writes into a photo, linked to the case's timeline and to photos taken at the same spot. Read on this computer." />
      {!photos && <div className="ci-progress"><Spinner /><span className="ci-progress-step">Reading the photos{progress ? ` · ${progress.done} of ${progress.total}` : ''}…</span></div>}
      {photos && !photos.length && <Nothing text="No photo carries a date or a position." />}
      {photos?.map((p) => (
        <Row key={p.rel} status="idle" title={p.name} tag={p.lat != null ? 'Has a position' : 'Date only'}>
          <p className="ci-row-detail">
            {p.taken ? `Taken ${showDate(p.taken)}${p.time ? ` at ${p.time}` : ''}` : 'No date'}
            {p.camera ? ` · ${p.camera}` : ''}
            {p.lat != null ? ` · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : ''}
          </p>
          {p.sameDay.length > 0 && (
            <ul className="ci-evidence">{p.sameDay.map((t, i) => <li key={i}>Same day: {t.event}{t.collection ? ` (${t.collection})` : ''}</li>)}</ul>
          )}
          <div className="ci-rowtools">
            <Chips rels={[p.rel]} />
            {p.lat != null && <button type="button" className="ci-btn is-small" onClick={() => openExternal(mapUrl(p.lat, p.lon))}>Open map</button>}
          </div>
          {p.near.length > 0 && (<><span className="ci-label">Taken at the same spot</span><Chips rels={p.near} dim /></>)}
        </Row>
      ))}
    </div>
  );
}
