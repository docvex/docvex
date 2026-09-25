import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import './CaenModal.css';
import CaenCard from './CaenCard';
import Tooltip from './Tooltip';
import { loadCaenRev, searchCaen, normCode, caenHref } from '../lib/caen';

// The CAEN nomenclature as a MODAL — the insse.ro tab, brought to wherever a
// code turned up: a CAEN code in an act read in the Legislation tab, the code
// on a company's ANAF record. The tabs are meant to answer each other, and a
// reader who meets "cod CAEN 6201" in the middle of an ordinance should not
// have to leave the ordinance to learn what it is.
//
// It opens ALREADY SEARCHED: the code is in the words box and its card is
// open; typing searches the nomenclature like the CAEN tab does (a code
// prefix or words of a name), a row opens that entry, and "Open in the CAEN
// tab" goes to the tab itself, on the same code. A citation naming several
// codes ("CAEN 6201, 6202 și 6209") shows them as chips to switch between.
//
// `open`: `{ code, codes?, rev? }` (rev 2 / 1 for an old-revision citation,
// else Rev. 3) or null.

const CloseIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12" /><path d="M18 6L6 18" />
  </svg>
);
const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
  </svg>
);
const ExternalIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6" /><path d="M20 4l-8.5 8.5" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </svg>
);

const revOf = (r) => (r === 1 || r === 2 ? r : 3);

export default function CaenModal({ open, onClose }) {
  const navigate = useNavigate();
  const [trees, setTrees] = useState({});
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null);   // { code, rev }
  const inputRef = useRef(null);

  // Opening on a code: the words box holds it and its card is open.
  useEffect(() => {
    if (!open) return;
    const code = normCode(open.code || '');
    setQuery(code);
    setPicked({ code, rev: revOf(open.rev) });
  }, [open]);

  // The tree of the revision on show, and Rev. 3 always (a card of an old
  // code says where it went).
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const wanted = [...new Set([revOf(open.rev), picked?.rev || 3, 3])];
    for (const r of wanted) {
      if (trees[r]) continue;
      loadCaenRev(r).then((t) => { if (live) setTrees((s) => (s[r] ? s : { ...s, [r]: t })); }).catch(() => {});
    }
    return () => { live = false; };
  }, [open, picked?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const rev = picked?.rev || revOf(open?.rev);
  const data = trees[rev] || null;
  const results = useMemo(() => (data && query.trim() ? searchCaen(data, query, { limit: 40 }) : []), [data, query]);
  const codes = useMemo(() => (open?.codes?.length ? open.codes.map(normCode) : []), [open]);

  if (!open) return null;

  const pick = (code, r) => setPicked({ code: normCode(code), rev: revOf(r ?? rev) });
  const goTab = () => { if (picked) navigate(caenHref(picked.code, picked.rev)); onClose?.(); };
  const onBackdrop = (e) => { if (e.target === e.currentTarget) onClose?.(); };

  return createPortal(
    <div className="cm-backdrop" onMouseDown={onBackdrop}>
      <div className="cm-card" role="dialog" aria-modal="true" aria-label="CAEN code">
        <header className="cm-head">
          <div className="cm-titles">
            <div className="cm-eyebrow">insse.ro · CAEN Rev. {rev}</div>
            <h2 className="cm-title">CAEN code</h2>
          </div>
          <label className="cm-search">
            <span className="cm-search-glyph">{SearchIcon}</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="A code, or words from its name"
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) pick(results[0].code, results[0].rev); }}
            />
          </label>
          <Tooltip content="Open this code in the CAEN tab">
            <button type="button" className="cm-btn" onClick={goTab} disabled={!picked}>
              <span className="cm-ico">{ExternalIcon}</span><span>Open in the CAEN tab</span>
            </button>
          </Tooltip>
          <Tooltip content="Close (Esc)">
            <button type="button" className="cm-close" onClick={onClose} aria-label="Close">{CloseIcon}</button>
          </Tooltip>
        </header>

        {codes.length > 1 ? (
          <div className="cm-chips" aria-label="The codes the citation names">
            {codes.map((c) => (
              <button type="button" key={c} className={`cm-chip${picked?.code === c ? ' is-on' : ''}`} onClick={() => { setQuery(c); pick(c, revOf(open.rev)); }}>{c}</button>
            ))}
          </div>
        ) : null}

        <div className="cm-body">
          <aside className="cm-list" aria-label="Search results">
            {!data ? <p className="cn-note">Loading CAEN Rev. {rev}…</p>
              : !query.trim() ? <p className="cn-note">Type a code or a few words of a name.</p>
              : !results.length ? <p className="cn-note">Nothing in CAEN Rev. {rev} matches “{query.trim()}”.</p>
              : (
                <ul className="cn-list">
                  {results.map((r) => (
                    <li key={r.code}>
                      <button type="button" className={`cn-row${picked?.code === r.code ? ' is-on' : ''}`} onClick={() => pick(r.code, r.rev)}>
                        <span className={`cn-row-code is-${r.level}`}>{r.code}</span>
                        <span className="cn-row-name">{r.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </aside>
          <div className="cm-detail">
            {picked ? <CaenCard trees={trees} code={picked.code} rev={picked.rev} onPick={pick} /> : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
