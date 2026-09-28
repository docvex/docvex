import React, { useMemo, useState } from 'react';
import RuleOptions from '../components/RuleOptions';
import Tooltip from '../components/Tooltip';
import { LEGAL_DETECTION_ARCHIVE as A } from '../lib/legalDetectionArchive';
import { LAW_REF_REGEXES, REF_CATALOGUE } from '../lib/lawRefs';

// THE LEGISLATION-DETECTION ARCHIVE (lib/legalDetectionArchive) — everything
// given about recognising Romanian legislation, kept VERBATIM and frozen, so
// it is never lost: the source texts, the instructions, the rules as
// documented, every regex, the catalogue and a copy of the detector's code.
// The regexes and the catalogue are compared with what the code runs TODAY,
// so a pattern that changed or disappeared since the copy is flagged.

const VIEWS = {
  label: 'Show',
  options: [
    { id: 'sources', label: `Your texts · ${A.sources.length}` },
    { id: 'instructions', label: `Your instructions · ${A.instructions.length}` },
    { id: 'docs', label: `Rules as documented · ${A.docs.length}` },
    { id: 'regex', label: `Regex · ${A.regexes.length}` },
    { id: 'catalogue', label: `Catalogue · ${A.catalogue.length}` },
    { id: 'code', label: `Code · ${A.code.length}` },
  ],
};

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const reText = (r) => `/${r.source}/${r.flags}`;

function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="debug-arc-btn"
      onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {}); }}
    >{done ? 'Copied' : 'Copy'}</button>
  );
}

// Frozen vs today: same / changed / not in the code any more / new since.
function Status({ frozen, live }) {
  if (!live) return <Tooltip content="This pattern is no longer in the code — the frozen copy is the only one left."><span className="debug-ref-pill is-gone">Not in the code now</span></Tooltip>;
  if (!frozen) return <Tooltip content="Added to the code after the archive was frozen."><span className="debug-ref-pill is-keyword">New since the copy</span></Tooltip>;
  const same = frozen.length === live.length && frozen.every((f, i) => f.source === live[i].source && f.flags === live[i].flags);
  return same
    ? <span className="debug-ref-pill is-live">Same as the code</span>
    : <Tooltip content="The code runs a different pattern now — both are shown."><span className="debug-ref-pill is-keyword">Changed since the copy</span></Tooltip>;
}

function download() {
  const blob = new Blob([JSON.stringify(A, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `docvex-legislation-detection-${A.frozenAt}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function LegalDetectionArchive() {
  const [view, setView] = useState('sources');
  const liveRegex = useMemo(() => new Map(LAW_REF_REGEXES.map((r) => [r.name, [{ source: r.re.source, flags: r.re.flags }]])), []);
  const liveCat = useMemo(() => new Map(REF_CATALOGUE.map((e) => [e.id, (e.res || []).map((re) => ({ source: re.source, flags: re.flags }))])), []);
  const newRegex = LAW_REF_REGEXES.filter((r) => !A.regexes.some((f) => f.name === r.name));
  const newCat = REF_CATALOGUE.filter((e) => !A.catalogue.some((f) => f.id === e.id));

  return (
    <section className="debug-icons debug-arc">
      <div className="debug-icons-head">
        <div>
          <h2 className="debug-card-title">Legislation detection — the archive</h2>
          <p className="debug-card-body">
            Everything you gave about recognising Romanian legislation, kept word for word so it is
            never lost: your texts, your instructions, the rules as documented, every regex, the
            identifier catalogue and a copy of the detector’s code — frozen on {A.frozenAt}. Regexes
            and catalogue entries are checked against what the code runs today.
          </p>
        </div>
        <button type="button" className="debug-card-btn" onClick={download}>Download archive</button>
      </div>

      <div className="debug-arc-switch"><RuleOptions field={VIEWS} value={view} onPick={setView} /></div>

      {view === 'sources' && A.sources.map((s) => (
        <article key={s.id} className="debug-arc-item">
          <header className="debug-arc-head">
            <h3 className="debug-arc-title">{s.title}</h3>
            <span className="debug-arc-when">{when(s.at)}</span>
            <CopyBtn text={s.text} />
          </header>
          <pre className="debug-arc-text">{s.text}</pre>
        </article>
      ))}

      {view === 'instructions' && (
        <ol className="debug-arc-list">
          {A.instructions.map((s) => (
            <li key={s.id}><span className="debug-arc-when">{when(s.at)}</span><span className="debug-arc-quote">{s.text}</span></li>
          ))}
        </ol>
      )}

      {view === 'docs' && A.docs.map((d) => (
        <article key={d.title} className="debug-arc-item">
          <header className="debug-arc-head">
            <h3 className="debug-arc-title">{d.title}</h3>
            <span className="debug-arc-when">CLAUDE.md, {A.frozenAt}</span>
            <CopyBtn text={d.text} />
          </header>
          <pre className="debug-arc-text">{d.text}</pre>
        </article>
      ))}

      {view === 'regex' && (
        <div className="debug-ref-list">
          {A.regexes.map((r) => {
            const live = liveRegex.get(r.name);
            const changed = live && reText(live[0]) !== reText(r);
            return (
              <article key={r.name} className="debug-ref">
                <header className="debug-ref-head">
                  <h4 className="debug-ref-name">{r.name}</h4>
                  <Status frozen={[r]} live={live} />
                  <CopyBtn text={reText(r)} />
                </header>
                <p className="debug-ref-what">{r.what}</p>
                <code className="debug-arc-re">{reText(r)}</code>
                {changed ? <><p className="debug-arc-sub">Today</p><code className="debug-arc-re">{reText(live[0])}</code></> : null}
              </article>
            );
          })}
          {newRegex.map((r) => (
            <article key={r.name} className="debug-ref">
              <header className="debug-ref-head"><h4 className="debug-ref-name">{r.name}</h4><Status frozen={null} live /></header>
              <p className="debug-ref-what">{r.what}</p>
              <code className="debug-arc-re">/{r.re.source}/{r.re.flags}</code>
            </article>
          ))}
        </div>
      )}

      {view === 'catalogue' && A.groups.map((g) => {
        const entries = A.catalogue.filter((e) => e.group === g.id);
        if (!entries.length) return null;
        return (
          <div key={g.id} className="debug-icons-group">
            <h3 className="debug-icons-file">{g.id}. {g.name} <span>{entries.length}</span></h3>
            <div className="debug-ref-list">
              {entries.map((e) => (
                <article key={e.id} className="debug-ref">
                  <header className="debug-ref-head">
                    <h4 className="debug-ref-name">{e.name}</h4>
                    <Status frozen={e.res} live={liveCat.get(e.id)} />
                    <span className="debug-ref-kind">{e.id} · {e.via}</span>
                  </header>
                  <p className="debug-ref-what">{e.what}</p>
                  {e.ai ? <p className="debug-ref-ai"><span>AI</span>{e.ai}</p> : null}
                  {e.phrases.length ? <div className="debug-ref-phrases">{e.phrases.map((p) => <code key={p}>{p}</code>)}</div> : null}
                  {e.examples.length ? <ul className="debug-ref-examples">{e.examples.map((x) => <li key={x}>{x}</li>)}</ul> : null}
                  {e.res.map((re, i) => <code key={i} className="debug-arc-re">{reText(re)}</code>)}
                </article>
              ))}
            </div>
          </div>
        );
      })}
      {view === 'catalogue' && newCat.length ? (
        <p className="debug-icons-count">Added to the code since the copy: {newCat.map((e) => e.name).join(', ')}.</p>
      ) : null}

      {view === 'code' && A.code.map((c) => (
        <details key={c.file} className="debug-arc-item debug-arc-code">
          <summary className="debug-arc-head">
            <h3 className="debug-arc-title">{c.file}</h3>
            <span className="debug-arc-when">{c.text.split('\n').length} lines, as of {A.frozenAt}</span>
            <CopyBtn text={c.text} />
          </summary>
          <pre className="debug-arc-text is-code">{c.text}</pre>
        </details>
      ))}
    </section>
  );
}
