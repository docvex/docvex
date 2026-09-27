import React, { useEffect, useMemo, useState } from 'react';
import Tooltip from '../components/Tooltip';
import CaenCard from '../components/CaenCard';
import { sentenceCase, fold } from '../lib/caen';

// Two more ways to read the CAEN tab's tree, beside the list (Caen.jsx's
// View dropdown):
//
//   OUTLINE — the sections as a fixed rail; the chosen section reads like a
//             table of contents (hierarchy by type size, not indentation),
//             the entry card beside it.
//   ATLAS   — the whole economy on one screen: the sections as tiles sized
//             by weight, then the chosen section's divisions as cards
//             holding their classes; the entry floats in over the side.
//
// Both read ONE tree (the revision on show; Rev. 3 under 'All revs') and
// select through the page's own `onPick`, so the URL, the history and the
// card behave as they do in the list.

const nameOf = (it) => {
  const n = it?.n || '';
  return n && n === n.toUpperCase() ? sentenceCase(n) : n;
};
const byCode = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// Children per code and the classes under every code, worked out once per tree.
function useCaenIndex(data) {
  return useMemo(() => {
    const kids = {};
    for (const [k, v] of Object.entries(data?.items || {})) if (v.p) (kids[v.p] = kids[v.p] || []).push(k);
    for (const k of Object.keys(kids)) kids[k].sort(byCode);
    const memo = {};
    const classes = (c) => {
      if (memo[c]) return memo[c];
      const it = data?.items?.[c];
      const out = it?.l === 'c' ? [c] : (kids[c] || []).flatMap(classes);
      memo[c] = out;
      return out;
    };
    const sectionOf = (c) => {
      let k = c;
      while (data?.items?.[k]?.p) k = data.items[k].p;
      return data?.items?.[k]?.l === 's' ? k : null;
    };
    return { kids, classes, sectionOf };
  }, [data]);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The section on show follows the selected code; otherwise the first section
// that has anything in it.
function useSection(data, idx, selected) {
  const first = useMemo(() => (data?.sections || []).find((s) => idx.kids[s]?.length) || data?.sections?.[0] || '', [data, idx]);
  const [sec, setSec] = useState(() => idx.sectionOf(selected) || first);
  useEffect(() => {
    const s = idx.sectionOf(selected);
    if (s) setSec(s);
  }, [selected, idx]);
  useEffect(() => { if (!data?.items?.[sec]) setSec(first); }, [data, sec, first]);
  return [sec, setSec];
}

function sectionMeta(idx, s) {
  return `${plural((idx.kids[s] || []).length, 'division', 'divisions')} · ${plural(idx.classes(s).length, 'class', 'classes')}`;
}

// ── Outline ────────────────────────────────────────────────────────────────
export function CaenOutline({ data, trees, rev, selected, onPick, cardRef }) {
  const idx = useCaenIndex(data);
  const [sec, setSec] = useSection(data, idx, selected);
  const cls = selected && data.items[selected]?.l === 'c' ? selected : '';
  const secIt = data.items[sec];

  return (
    <div className="cn-ol">
      <nav className="cn-ol-rail" aria-label="Sections">
        {data.sections.map((s) => {
          const on = s === sec;
          const n = idx.classes(s).length;
          return (
            <Tooltip key={s} content={`Section ${s} — ${nameOf(data.items[s])}`}>
              <button
                type="button"
                className={`cn-ol-sec${on ? ' is-on' : ''}`}
                disabled={!idx.kids[s]?.length}
                onClick={() => { setSec(s); const first = idx.classes(s)[0]; if (first) onPick(first); }}
              >
                <span className="cn-ol-sec-code">{s}</span>
                <span className="cn-ol-sec-name">{nameOf(data.items[s])}</span>
                <span className="cn-ol-sec-n">{n}</span>
              </button>
            </Tooltip>
          );
        })}
      </nav>

      <main className="cn-ol-main">
        {secIt ? (
          <>
            <div className="cn-ol-head">
              <div className="cn-ol-eyebrow">Section {sec}</div>
              <h2 className="cn-ol-title">{nameOf(secIt)}</h2>
              <div className="cn-ol-meta">{sectionMeta(idx, sec)}</div>
            </div>
            {(idx.kids[sec] || []).map((d) => (
              <section key={d} className="cn-ol-div">
                <div className="cn-ol-divhead">
                  <span className="cn-ol-divcode">{d}</span>
                  <span className="cn-ol-divname">{nameOf(data.items[d])}</span>
                  <span className="cn-ol-divmeta">{plural(idx.classes(d).length, 'class', 'classes')}</span>
                </div>
                {(idx.kids[d] || []).map((g) => {
                  const cl = idx.kids[g] || [];
                  // A group holding one class of the same name says nothing
                  // the class does not: its label is left out.
                  const solo = cl.length === 1 && fold(data.items[cl[0]].n) === fold(data.items[g].n);
                  return (
                    <div key={g} className="cn-ol-group">
                      {!solo ? <div className="cn-ol-grouplabel">{g} · {nameOf(data.items[g])}</div> : null}
                      {cl.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`cn-ol-class${c === cls ? ' is-on' : ''}`}
                          onClick={() => onPick(c)}
                        >
                          <span className="cn-ol-classcode">{c}</span>
                          <span>{nameOf(data.items[c])}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </section>
            ))}
          </>
        ) : null}
      </main>

      <aside className="cn-ol-side" ref={cardRef}>
        {cls ? (
          <CaenCard trees={trees} code={cls} rev={rev} onPick={onPick} crumbs={false} kids={false} />
        ) : (
          <div className="cn-card cn-ol-empty">
            <p className="cn-empty-title">Pick a class</p>
            <p className="cn-empty-sub">Its notes — what it includes and what it leaves out — show here.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

// ── Atlas ──────────────────────────────────────────────────────────────────
export function CaenAtlas({ data, trees, rev, selected, onPick, onClose }) {
  const idx = useCaenIndex(data);
  const [sec, setSec] = useSection(data, idx, selected);
  const cls = selected && data.items[selected]?.l === 'c' ? selected : '';
  const secIt = data.items[sec];
  const max = useMemo(() => Math.max(1, ...data.sections.map((s) => idx.classes(s).length)), [data, idx]);

  return (
    <div className={`cn-at${cls ? ' has-card' : ''}`}>
      <div className="cn-at-tiles">
        {data.sections.map((s) => {
          const on = s === sec;
          const n = idx.classes(s).length;
          return (
            <Tooltip key={s} content={`Section ${s} — ${nameOf(data.items[s])}`}>
              <button
                type="button"
                className={`cn-at-tile${on ? ' is-on' : ''}`}
                disabled={!idx.kids[s]?.length}
                onClick={() => { setSec(s); if (cls) onClose(); }}
              >
                <span className="cn-at-tilehead">
                  <span className="cn-at-tilecode">{s}</span>
                  <span className="cn-at-tilen">{plural(n, 'class', 'classes')}</span>
                </span>
                <span className="cn-at-tilename">{nameOf(data.items[s])}</span>
                <span className="cn-at-bar"><span style={{ width: `${Math.max(4, Math.round((n / max) * 100))}%` }} /></span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      {secIt ? (
        <>
          <div className="cn-at-head">
            <div className="cn-ol-eyebrow">Section {sec} · {sectionMeta(idx, sec)}</div>
            <h2 className="cn-ol-title">{nameOf(secIt)}</h2>
          </div>
          <div className="cn-at-cards">
            {(idx.kids[sec] || []).map((d) => (
              <div key={d} className="cn-at-card">
                <div className="cn-at-cardhead">
                  <span className="cn-at-cardcode">{d}</span>
                  <span className="cn-at-cardname">{nameOf(data.items[d])}</span>
                </div>
                {idx.classes(d).map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`cn-at-class${c === cls ? ' is-on' : ''}`}
                    onClick={() => onPick(c)}
                  >
                    <span className="cn-at-classcode">{c}</span>
                    <span>{nameOf(data.items[c])}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* The entry floats in over the right side, sticky under the tab bar
          while the atlas scrolls beneath it. */}
      {cls ? (
        <div className="cn-at-float">
          <div className="cn-at-entry">
            <div className="cn-at-entrybar">
              <button type="button" className="cn-btn" onClick={onClose}>Close</button>
            </div>
            <CaenCard trees={trees} code={cls} rev={rev} onPick={onPick} crumbs={false} kids={false} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
