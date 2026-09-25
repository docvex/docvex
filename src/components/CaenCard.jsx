import React, { useCallback, useEffect, useMemo, useState } from 'react';
import '../pages/Caen.css';
import Tooltip from './Tooltip';
import {
  loadCaenNotes, caenEntry, caenChildren, caenNext, caenPrev, resolveCaen,
  noteLines, normCode, LEVEL_LABEL, REV_INFO,
} from '../lib/caen';

// The CAEN entry card — a code's kind, name, where it sits, what it holds,
// the institute's notes, and where it came from / went between revisions.
// Shared: the CAEN tab shows it beside its list and under its picker, and
// the CAEN MODAL (components/CaenModal) shows it in any other tab that
// recognises a code — an act in the Legislation reader, an ANAF answer.
// Its styles are the CAEN page's (`cn-`, Caen.css).

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
const ArrowIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h13" /><path d="M13 6l6 6-6 6" />
  </svg>
);

// A code as it is written in a document: sections by letter, the rest by number.
export const codeLabel = (code, level) => (level === 's' ? `Secțiunea ${code}` : code);
const SINGULAR = { s: 'section', d: 'division', g: 'group', c: 'class' };
const PLURAL = { s: 'sections', d: 'divisions', g: 'groups', c: 'classes' };

// `foot`: something for the very foot of the card (the picker's key hints);
// `crumbs` / `kids` / `head`: whether the card lists the entry's ancestors,
// what it contains, and its own header (kind, code, name, Copy) — the
// picker's columns and pills show all three, so off there.
export default function CaenCard({ trees, code, rev, onPick, foot = null, crumbs = true, kids = true, head = true }) {
  // The card reads the tree of the code's OWN revision; a code pressed in it
  // stays in that revision unless the row says otherwise (a "where it went"
  // row names the next one).
  const data = trees[rev] || null;
  const pick = useCallback((c, r = rev) => onPick(c, r), [onPick, rev]);
  const entry = useMemo(() => (data ? caenEntry(data, code) : null), [data, code]);
  const children = useMemo(() => (entry && entry.level !== 'c' ? caenChildren(data, entry.code) : []), [data, entry]);
  // Rev. 3 only: a number that meant something else in Rev. 2.
  const r3 = useMemo(() => (rev === 3 && data ? resolveCaen(data, code, 3) : null), [rev, data, code]);
  const went = useMemo(() => (entry?.level === 'c' ? caenNext(trees, rev, code) : []), [trees, rev, code, entry]);
  const same3 = rev !== 3 && trees[3]?.items?.[normCode(code)] ? { code: normCode(code), name: trees[3].items[normCode(code)].n } : null;
  const [notes, setNotes] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!entry || rev !== 3) return undefined;
    let live = true;
    loadCaenNotes().then((n) => { if (live) setNotes(n[entry.code] || {}); }).catch(() => { if (live) setNotes({}); });
    return () => { live = false; setNotes(null); };
  }, [entry?.code, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setCopied(false); }, [code, rev]);

  if (!data) return <p className="cn-note">Loading CAEN Rev. {rev}…</p>;
  if (!entry) {
    return (
      <div className="cn-empty">
        <p className="cn-empty-title">No such code</p>
        <p className="cn-empty-sub">{code} is not a code of CAEN Rev. {rev}.</p>
      </div>
    );
  }

  const { name, level } = entry;
  const info = REV_INFO[rev];
  const copy = async () => {
    // As a clause writes it: "4100 – Lucrări de construcții…".
    const text = level === 's' ? `Secțiunea ${code} – ${name}` : `${code} – ${name}`;
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard refused */ }
  };

  return (
    <article className="cn-card">
      {crumbs && entry.path.length ? (
        <nav className="cn-crumbs" aria-label="Where this code sits">
          {entry.path.map((p) => (
            <button type="button" key={p.code} className="cn-crumb" onClick={() => pick(p.code)}>
              <span className="cn-crumb-code">{codeLabel(p.code, p.level)}</span>
              <span className="cn-crumb-name">{p.name}</span>
            </button>
          ))}
        </nav>
      ) : null}

      {head ? (
      <header className="cn-head">
        <div className="cn-kind">{LEVEL_LABEL[level]} · CAEN Rev. {rev}</div>
        <div className="cn-title-row">
          <span className="cn-code">{code}</span>
          <h1 className="cn-title">{name}</h1>
        </div>
        <div className="cn-actions">
          <Tooltip content="Copy the code and its name, as a clause writes them">
            <button type="button" className="cn-btn" onClick={copy}>
              <span className="cn-ico">{copied ? CheckIcon : CopyIcon}</span>
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </Tooltip>
        </div>
      </header>
      ) : null}

      {/* An old revision: what it was, and where the activity is now. Said
          first, because an old code in a new document is a mistake to fix. */}
      {rev !== 3 ? (
        <section className="cn-callout is-old">
          <p className="cn-callout-title">No longer in force</p>
          <p className="cn-callout-body">
            CAEN Rev. {rev} was in force {info.years} ({info.act}) and was replaced by Rev. {rev + 1} on{' '}
            {REV_INFO[rev + 1].from}.{went.length ? ` A document written since cites the code${went.length > 1 ? 's' : ''} below instead.` : ''}
          </p>
          {went.length ? (
            <CodeList items={went} onPick={pick} label={went.length > 1 ? `Now split over (Rev. ${rev + 1})` : `Now (Rev. ${rev + 1})`} tagRev={rev + 1} />
          ) : null}
          {same3 && same3.name !== name ? (
            <button type="button" className="cn-link" onClick={() => pick(code, 3)}>
              {code} in Rev. 3 is a different class: {same3.name} <span className="cn-ico">{ArrowIcon}</span>
            </button>
          ) : null}
        </section>
      ) : null}

      {/* A Rev. 3 code whose number meant something else in Rev. 2: an older
          document citing it meant THAT. */}
      {r3?.changed ? (
        <section className="cn-callout">
          <p className="cn-callout-title">In a document from before 2025, {code} meant something else</p>
          <p className="cn-callout-body">In CAEN Rev. 2, {code} was “{r3.rev2.name}”.</p>
          <button type="button" className="cn-link" onClick={() => pick(code, 2)}>
            Open {code} as it was in Rev. 2 <span className="cn-ico">{ArrowIcon}</span>
          </button>
        </section>
      ) : null}

      {kids && children.length ? (
        <CodeList items={children} onPick={pick} label={`${children.length} ${(children.length > 1 ? PLURAL : SINGULAR)[children[0].level]} in it`} />
      ) : null}

      {level === 'c' ? <PrevCodes trees={trees} rev={rev} code={code} onPick={pick} /> : null}

      {rev === 3 ? (
        notes == null ? <p className="cn-note">Reading the notes…</p> : (
          <div className="cn-notes">
            <Note title="Includes" text={notes.i} data={data} onPick={pick} />
            <Note title="Also includes" text={notes.a} data={data} onPick={pick} />
            <Note title="Excludes" text={notes.e} data={data} onPick={pick} tone="exclude" />
            {!notes.i && !notes.a && !notes.e ? <p className="cn-note">The nomenclature gives no notes for this entry.</p> : null}
          </div>
        )
      ) : (
        <p className="cn-note">Only Rev. 3’s explanatory notes are bundled; Rev. {rev} is its structure and names.</p>
      )}

      <footer className="cn-source">
        {rev === 3 ? (
          <>
            {data.source}. CAEN Rev. 3 is in force since 1 January 2025 (Ordinul INS nr. 377/2024);
            the explanatory notes are the institute’s own working edition. For a filing with the trade
            register, check the code against the ONRC’s list.
          </>
        ) : (
          <>{data.source}. CAEN Rev. {rev} was in force from {info.from} to {info.to} ({info.act}).</>
        )}
      </footer>
      {foot}
    </article>
  );
}

// Where a class came from in the revision before — Rev. 2 for a Rev. 3
// class, Rev. 1 for a Rev. 2 one. A Rev. 1 class has no before.
function PrevCodes({ trees, rev, code, onPick }) {
  const from = useMemo(() => caenPrev(trees, rev, code), [trees, rev, code]);
  if (rev === 1) return null;
  if (!from.length) {
    return <p className="cn-note">A new class in Rev. {rev} — no Rev. {rev - 1} class became it.</p>;
  }
  // The same number, unchanged, needs no saying.
  if (from.length === 1 && from[0].code === code) return null;
  return <CodeList items={from} onPick={onPick} label={`Formerly, in Rev. ${rev - 1}`} tagRev={rev - 1} />;
}

// `tagRev`: the rows belong to ANOTHER revision — each says so, and a press
// carries it.
function CodeList({ items, onPick, label, tagRev = null }) {
  if (!items.length) return null;
  return (
    <section className="cn-sub">
      <p className="cn-sub-title">{label}</p>
      <ul className="cn-codes">
        {items.map((it) => (
          <li key={it.code}>
            <button type="button" className="cn-coderow" onClick={() => (tagRev ? onPick(it.code, it.rev || tagRev) : onPick(it.code))}>
              <span className="cn-coderow-code">{it.code}</span>
              <span className="cn-coderow-name">{it.name}</span>
              {tagRev ? <span className="cn-tag is-old">Rev. {it.rev || tagRev}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// A note is the institute's text as written — its own list dashes and all —
// with the codes it points at ("vezi 0163") made into links.
function Note({ title, text, data, onPick, tone }) {
  if (!text) return null;
  const lines = noteLines(text, data)
    // The notes open by restating their own heading ("Această clasă include:").
    .filter((parts, i) => !(i === 0 && parts.length === 1 && /^\s*Aceast[ăa]\s.*(include|exclude).*:\s*$/i.test(parts[0].text || '')));
  return (
    <section className={`cn-sub cn-notebox${tone ? ` is-${tone}` : ''}`}>
      <p className="cn-sub-title">{title}</p>
      <div className="cn-notetext">
        {lines.map((parts, i) => {
          const raw = parts.map((p) => p.text || p.code).join('');
          const depth = Math.min(3, Math.floor((/^\s*/.exec(raw)[0].length) / 4));
          return (
            <p key={i} className="cn-noteline" style={{ '--indent': depth }}>
              {parts.map((p, j) => (p.code ? (
                <button type="button" key={j} className="cn-inline-code" onClick={() => onPick(p.code)}>{p.code}</button>
              ) : <React.Fragment key={j}>{j === 0 ? p.text.replace(/^\s+/, '') : p.text}</React.Fragment>))}
            </p>
          );
        })}
      </div>
    </section>
  );
}

