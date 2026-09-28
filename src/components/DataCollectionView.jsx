import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import RuleOptions from './RuleOptions';
import { useSelectedProject } from '../context/SelectedProjectContext';
import Tooltip from './Tooltip';
import { glyphForFile } from './fileGlyph';
import { readLocalBlob } from '../lib/localFolder';
import { openDocViewerWindow } from '../lib/platform';
import { parseCollection, resolveInProject, METHOD_LABELS, LINK_TYPES } from '../lib/dataCollections';
import { confidenceLabel } from '../lib/faceMatch';
import { fieldsFor } from '../lib/identities';
import './DataCollectionView.css';

// A Data collection (`.dvc`, lib/dataCollections) in the Doc Viewer: what the
// Files tab's AI scan gathered about ONE subject across the project's files —
// the summary, the facts (each with the files it comes from), the timeline,
// faces matched to an identity document, the sources with what the AI
// understood from each, how the files connect, and the web: the other
// collections this one shares files or names with. Every file named is a
// button that opens it.

const SUBJECTS = {
  person: 'Person', company: 'Company', property: 'Property', vehicle: 'Vehicle',
  contract: 'Contract', case: 'Case', event: 'Event', other: 'Subject',
};
const KIND_LABELS = { image: 'Picture', video: 'Video', audio: 'Audio', doc: 'Document', collection: 'Data collection' };

// Insights about THIS collection's files (components/CaseInsights) — lazy.
const CaseInsightsView = lazy(() => import('./CaseInsights'));
const VIEW_FIELD = {
  label: 'View',
  options: [
    { id: 'collection', label: 'Collection', example: 'What the AI gathered, its sources, timeline and links' },
    { id: 'insights', label: 'Insights', example: 'This collection\u2019s files checked: contradictions, authenticity, missing documents, duplicates, signatures, plates and places, legal history' },
  ],
};
const VIEW_KEY = 'docvex:collection:view:v1';

const dirOf = (p) => {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(0, i) : '';
};
const baseName = (rel) => String(rel || '').split('/').pop();
const thumbUrl = (path, size = 480) => `localfile://local/${encodeURIComponent(path)}?thumb=${size}`;
const pct = (c) => `${Math.round((Number(c) || 0) * 100)}%`;
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// A face cut out of its picture (box = 0…1 of the picture), with a margin.
function FaceCrop({ path, box, size = 88, label }) {
  if (!box) return <span className="dcv-face is-empty" style={{ width: size, height: size }} />;
  const pad = 0.35;
  const w = Math.min(1, box.w * (1 + pad * 2));
  const h = Math.min(1, box.h * (1 + pad * 2));
  const x = Math.max(0, Math.min(1 - w, box.x - box.w * pad));
  const y = Math.max(0, Math.min(1 - h, box.y - box.h * pad));
  const style = {
    width: size, height: size,
    backgroundImage: `url("${thumbUrl(path, 1600)}")`,
    backgroundSize: `${100 / w}% ${100 / h}%`,
    backgroundPosition: `${w >= 1 ? 0 : (x / (1 - w)) * 100}% ${h >= 1 ? 0 : (y / (1 - h)) * 100}%`,
  };
  return <span className="dcv-face" style={style} role="img" aria-label={label || 'Face'} />;
}

// The party's details the AI read into the collection (its `record` — what a
// contract's clauses are filled from, lib/identities) as facts of the same
// shape as the rest: label, value, the files it came from. Nothing of it is
// edited here; it is what the AI gathered, shown with everything else it did.
function recordFacts(doc) {
  const r = doc?.record;
  if (!r || typeof r !== 'object') return [];
  const byName = new Map((doc.sources || []).map((s) => [s.name, s.rel]));
  const from = (key) => {
    const name = r.fieldSources?.[key];
    const rel = name && byName.get(name);
    return rel ? [rel] : [];
  };
  const out = [];
  const shown = new Set(['name', 'representative', 'repCapacity']);
  for (const f of fieldsFor(r.kind === 'org' ? 'org' : 'person')) {
    const v = String(r[f.key] ?? '').trim();
    if (!v || shown.has(f.key)) continue;
    shown.add(f.key);
    out.push({ label: f.label, value: v, sources: from(f.key), fromDetails: true });
  }
  if (String(r.representative || '').trim()) {
    out.push({ label: 'Represented by', value: [r.representative, r.repCapacity].filter(Boolean).join(', '), sources: from('representative'), fromDetails: true });
  }
  for (const p of r.people || []) {
    const bits = [p.name, p.nationalId, p.sharePct ? `${p.sharePct}%` : '', p.shareValue, p.shares ? `${p.shares} shares` : ''].filter(Boolean);
    if (bits.length) out.push({ label: p.role || 'Person', value: bits.join(' · '), sources: [], fromDetails: true });
  }
  for (const c of [...(r.contacts || []), ...(r.custom || [])]) {
    if (String(c.value || '').trim()) out.push({ label: c.label || 'Detail', value: c.value, sources: [], fromDetails: true });
  }
  return out;
}

// One row per thing said. The party's details carry the record's (English)
// labels and the scan's facts the document's own ("Data nașterii"), so the
// same value arrived twice under two names. Values are compared by their WORDS
// (case, diacritics and punctuation ignored): equal, or every word of the
// shorter one inside the longer one (at least 4 letters in all — "PETRE" and
// "LUCA-ANDREI" are both in "Petre Luca-Andrei", "Str. 1907 nr. 59" is in
// "Constanța, str. 1907 nr. 59"). One AI fact takes in EVERY detail row it
// covers; the row keeps the AI's label, the fuller value and every file any of
// them came from, in the details' order.
const words = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function sameThing(a, b) {
  const x = words(a); const y = words(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const [short, long] = x.join('').length <= y.join('').length ? [x, y] : [y, x];
  if (short.join('').length < 4) return false;
  const have = new Set(long);
  return short.every((w) => have.has(w));
}
function mergeFacts(details, gathered) {
  let rows = details.map((f) => ({ ...f, sources: [...f.sources] }));
  for (const g of gathered) {
    const hits = rows.filter((r) => sameThing(r.value, g.value));
    if (!hits.length) { rows.push({ ...g, sources: [...(g.sources || [])] }); continue; }
    const [keep, ...rest] = hits;
    const all = [keep, ...rest, g];
    keep.label = g.label;
    keep.value = all.map((r) => r.value).sort((p, q) => words(q).join('').length - words(p).join('').length)[0];
    keep.sources = [...new Set(all.flatMap((r) => r.sources || []))];
    keep.fromDetails = false;
    rows = rows.filter((r) => !rest.includes(r));
  }
  return rows.map(({ fromDetails, ...r }) => r);   // eslint-disable-line no-unused-vars
}

// ONE page, the only way a Data collection is shown: what the AI gathered about
// one subject across the project's files — the party's details it read, the
// facts, face matches, the timeline, the sources and what was understood from
// each, how the files connect and the collections it is linked to. Read-only:
// the AI scan (Files tab) is what makes and updates it. The page reserves the
// floating side panel's footprint (`--dv-doc-inset`), so it follows the panel
// being shown, hidden or resized, and otherwise runs the full width.
export default function DataCollectionView({ file }) {
  const [doc, setDoc] = useState(null);
  const { selectedProjectId } = useSelectedProject() || {};
  const [view, setView] = useState(() => { try { return localStorage.getItem(VIEW_KEY) === 'insights' ? 'insights' : 'collection'; } catch { return 'collection'; } });
  const pickView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ } };
  const [error, setError] = useState('');
  // Re-read when a file changes in this window (an AI edit, a scan) — without
  // blanking the page first.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener('docvex:files-changed', on);
    return () => window.removeEventListener('docvex:files-changed', on);
  }, []);
  useEffect(() => { setDoc(null); setError(''); }, [file.path, file.url]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const blob = await readLocalBlob(file.path);
        const parsed = parseCollection(await blob.text());
        if (cancelled) return;
        if (parsed) setDoc(parsed); else setError('This data collection couldn’t be read.');
      } catch {
        if (!cancelled) setError('This data collection couldn’t be opened.');
      }
    })();
    return () => { cancelled = true; };
  }, [file.path, file.url, tick]);

  // Sources are stored by their path inside the PROJECT; the collection may sit
  // in a subfolder, so the project's root is the file's path less `self`.
  const root = useMemo(() => {
    const own = String(file.path || '').replace(/\\/g, '/');
    const self = String(doc?.self || '').replace(/\\/g, '/');
    if (self && own.toLowerCase().endsWith(`/${self.toLowerCase()}`)) {
      const cut = String(file.path).length - self.length - 1;
      return String(file.path).slice(0, cut);
    }
    return dirOf(file.path);
  }, [file.path, doc?.self]);
  const dir = root;
  const pathOf = (rel) => resolveInProject(dir, rel);
  const byRel = useMemo(() => new Map((doc?.sources || []).map((s) => [s.rel, s])), [doc]);
  const nameOf = (rel) => byRel.get(rel)?.name || baseName(rel);
  const open = (rel, mime = '') => {
    const path = pathOf(rel);
    if (path) openDocViewerWindow({ path, name: baseName(rel), mime });
  };
  const SourceChip = ({ rel }) => (
    <Tooltip content={`Open ${nameOf(rel)}`}>
      <button type="button" className="dcv-chip" onClick={() => open(rel)}>
        <span className="dcv-chip-glyph">{glyphForFile('', nameOf(rel))}</span>
        <span className="dcv-chip-name">{nameOf(rel)}</span>
      </button>
    </Tooltip>
  );

  if (error) return <div className="dcv"><p className="dcv-error">{error}</p></div>;
  if (!doc) return <div className="dcv"><p className="dcv-loading">Opening the data collection…</p></div>;

  const facts = mergeFacts(recordFacts(doc), doc.facts);
  const regular = doc.sources.filter((s) => s.method !== 'face');
  const faceRefs = doc.faceReference || [];
  const faceMatches = doc.faceMatches || [];

  const page = (
      <div className="dcv-inner">
        <header className="dcv-head">
          <p className="dcv-eyebrow">Data collection · {SUBJECTS[doc.subject] || SUBJECTS.other}</p>
          <h1 className="dcv-title">{doc.title}</h1>
          <p className="dcv-meta">
            {doc.sources.length} source{doc.sources.length === 1 ? '' : 's'}
            {doc.related?.length ? ` · linked to ${doc.related.length} other collection${doc.related.length === 1 ? '' : 's'}` : ''}
            {doc.updatedAt || doc.createdAt ? ` · gathered ${when(doc.updatedAt || doc.createdAt)}` : ''}
          </p>
          {doc.summary && <p className="dcv-summary">{doc.summary}</p>}
        </header>


        {facts.length > 0 && (
          <section className="dcv-section">
            <h2 className="dcv-h">What the AI gathered</h2>
            <dl className="dcv-facts">
              {facts.map((f, i) => (
                <div className="dcv-fact" key={`${f.label}-${i}`}>
                  <dt>{f.label}</dt>
                  <dd>
                    <span className="dcv-fact-value">{f.value}</span>
                    {f.sources.length > 0 && (
                      <span className="dcv-chips">{f.sources.map((rel) => <SourceChip key={rel} rel={rel} />)}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {faceMatches.length > 0 && (
          <section className="dcv-section">
            <h2 className="dcv-h">Face matches</h2>
            <p className="dcv-note">
              The photo on the identity document compared with the faces in the project’s pictures — on this computer only;
              no face was sent anywhere. A match is a lead, not an identification: check the two faces yourself.
            </p>
            <ul className="dcv-faces">
              {faceMatches.map((m) => {
                const ref = faceRefs.find((r) => r.rel === m.idRel);
                return (
                  <li className="dcv-facematch" key={`${m.idRel}>${m.rel}`}>
                    <button type="button" className="dcv-facepair" onClick={() => open(m.idRel)}>
                      <FaceCrop path={pathOf(m.idRel)} box={m.idBox || ref?.box} label={`${m.holder} on ${nameOf(m.idRel)}`} />
                      <span className="dcv-facecap">{nameOf(m.idRel)}</span>
                    </button>
                    <span className="dcv-facescore" style={{ '--c': m.confidence }}>
                      <strong>{pct(m.confidence)}</strong>
                      <span>{confidenceLabel(m.confidence)}</span>
                      <span className="dcv-facebar"><span /></span>
                    </span>
                    <button type="button" className="dcv-facepair" onClick={() => open(m.rel)}>
                      <FaceCrop path={pathOf(m.rel)} box={m.box} label={`Face in ${nameOf(m.rel)}`} />
                      <span className="dcv-facecap">{nameOf(m.rel)}</span>
                    </button>
                    <span className="dcv-facewho">
                      {m.kind === 'document' ? `Another identity document of ${m.holder}` : `${m.holder} appears in this picture`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {doc.timeline.length > 0 && (
          <section className="dcv-section">
            <h2 className="dcv-h">Timeline</h2>
            <ol className="dcv-timeline">
              {doc.timeline.map((t, i) => (
                <li key={`${t.date}-${i}`}>
                  <span className="dcv-date">{t.date}</span>
                  <span className="dcv-event">
                    {t.event}
                    {t.sources.length > 0 && <span className="dcv-chips">{t.sources.map((rel) => <SourceChip key={rel} rel={rel} />)}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="dcv-section">
          <h2 className="dcv-h">Sources</h2>
          <ul className="dcv-sources">
            {[...regular, ...doc.sources.filter((s) => s.method === 'face')].map((s) => (
              <li className="dcv-source" key={s.rel}>
                <button type="button" className="dcv-source-thumb" onClick={() => open(s.rel)} aria-label={`Open ${s.name}`}>
                  {s.kind === 'image'
                    ? <img src={thumbUrl(pathOf(s.rel), 240)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                    : <span className="dcv-source-glyph">{glyphForFile('', s.name)}</span>}
                </button>
                <div className="dcv-source-body">
                  <div className="dcv-source-top">
                    <button type="button" className="dcv-source-name" onClick={() => open(s.rel)}>{s.name}</button>
                    <span className="dcv-tag">{KIND_LABELS[s.kind] || 'File'}</span>
                    {s.method && <span className="dcv-tag is-soft">{s.method === 'face' ? `Face match · ${pct(s.confidence)}` : `Read by ${METHOD_LABELS[s.method] || s.method}`}</span>}
                  </div>
                  {s.rel.includes('/') && <span className="dcv-source-path">{s.rel}</span>}
                  {s.role && <p className="dcv-source-role">{s.role}</p>}
                  {s.understood && (
                    <p className="dcv-source-understood"><span>What the AI understood</span>{s.understood}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {doc.links?.length > 0 && (
          <section className="dcv-section">
            <h2 className="dcv-h">How the files connect</h2>
            <ul className="dcv-links">
              {doc.links.map((l, i) => (
                <li key={`${l.from}>${l.to}|${l.type}-${i}`}>
                  <span className="dcv-link-ends">
                    <SourceChip rel={l.from} />
                    <span className={`dcv-link-type is-${l.type}`}>{LINK_TYPES[l.type] || l.type}</span>
                    <SourceChip rel={l.to} />
                    <Tooltip content="How sure the AI is of this link">
                      <span className="dcv-link-conf">{Math.round(l.confidence * 100)}%</span>
                    </Tooltip>
                  </span>
                  <span className="dcv-link-why">{l.why}</span>
                  {l.evidence.length > 0 && (
                    <span className="dcv-link-evidence">{l.evidence.map((e, k) => <span key={k}>{e}</span>)}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {!doc.links?.length && doc.connections.length > 0 && (
          <section className="dcv-section">
            <h2 className="dcv-h">How the files connect</h2>
            <ul className="dcv-links">
              {doc.connections.map((k, i) => (
                <li key={`${k.from}>${k.to}-${i}`}>
                  <span className="dcv-link-ends"><SourceChip rel={k.from} /><span className="dcv-link-arrow" aria-hidden="true">↔</span><SourceChip rel={k.to} /></span>
                  <span className="dcv-link-why">{k.why}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(doc.related?.length > 0 || doc.entities?.length > 0) && (
          <section className="dcv-section">
            <h2 className="dcv-h">The web</h2>
            {doc.related?.length > 0 && (
              <ul className="dcv-related">
                {doc.related.map((r) => (
                  <li key={r.file}>
                    <button type="button" className="dcv-related-btn" onClick={() => open(r.file, 'application/json')}>
                      <span className="dcv-chip-glyph">{glyphForFile('', r.file)}</span>
                      <span className="dcv-related-title">{r.title}</span>
                    </button>
                    <span className="dcv-related-why">
                      {[
                        r.files.length ? `shares ${r.files.length} file${r.files.length === 1 ? '' : 's'}` : '',
                        r.names.length ? `names ${r.names.slice(0, 4).join(', ')}${r.names.length > 4 ? '…' : ''}` : '',
                      ].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {doc.entities?.length > 0 && (
              <div className="dcv-entities">
                {doc.entities.map((e) => (
                  <Tooltip key={e.name} content={`Named in ${e.sources.map(nameOf).join(', ')}`}>
                    <span className="dcv-entity">{e.name}{e.sources.length > 1 && <em>{e.sources.length}</em>}</span>
                  </Tooltip>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
  );

  // Collection · Insights: the Insights checks run on THIS collection's
  // files, and what they settle (a confirmed value, a merge) is written back
  // into it — the page re-reads itself on the change.
  const selfRel = String(file.path || '').slice(String(root).length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return (
    <div className="dcv">
      <div className="dcv-viewbar">
        <RuleOptions field={VIEW_FIELD} value={view} onPick={pickView} className="dcv-views" />
      </div>
      {view === 'insights' ? (
        <div className="dcv-inner dcv-insights">
          <Suspense fallback={<p className="dcv-loading">Loading…</p>}>
            <CaseInsightsView
              dir={root} projectId={selectedProjectId || null} collection={selfRel}
              onOpenPath={(path, name) => openDocViewerWindow({ path, name: name || baseName(path), mime: '' })}
            />
          </Suspense>
        </div>
      ) : page}
    </div>
  );
}
