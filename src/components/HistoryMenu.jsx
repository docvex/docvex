import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './HistoryMenu.css';
import Tooltip from './Tooltip';
import { toLayoutPx } from '../lib/appZoom';
import { listHistory, clearHistory } from '../lib/tabHistory';

// The History button and its dropdown — every tab of the Legislation family
// has one at its bar's far right, past the search (LegalTabs' `trailing`
// slot): a tool button that hangs a compact DROPDOWN under itself
// (portalled to <body>, placed from the button's rect with its right edge
// on the button's, on the bar's dropdown ground). The list is the tab's own
// log (lib/tabHistory), laid out as the Advisor's thread — in the order
// things happened, oldest at the top and opened scrolled to the newest, so
// a search stands ABOVE what it opened; searches as the user's bubbles at
// the right with the time under, things opened as the answers at the left,
// day dividers. Each entry is a button (`onPick(entry)`: a search runs
// again, a thing opens again). Clear in its head forgets the log; `extra`
// puts a tab's own head buttons beside it (the Legislation tab's "Kept
// acts"). A click elsewhere, Escape or a page scroll closes it — not a modal.
//
// An entry is drawn from its `label` and `detail`; a tab whose entries need
// more (the Legislation tab's form fields) passes `renderEntry(entry)`.

const ClockIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
  </svg>
);
const CrossIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const BinIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" />
  </svg>
);

export const formatHM = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayLabel = (ts) => {
  const d = new Date(ts); const now = new Date(); const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};

const defaultRender = (e) => (e.kind === 'search' ? (
  <>
    {e.label || 'Everything'}
    {e.detail ? <span className="lg-hist-dim"> · {e.detail}</span> : null}
  </>
) : (
  <>
    <span className="lg-hist-kind">{e.label}</span>
    {e.detail ? <span className="lg-hist-dim"> — {e.detail}</span> : null}
  </>
));

export function HistoryMenu({ tab, anchor, onClose, onPick, renderEntry = defaultRender, extra = null, emptyText }) {
  const [entries, setEntries] = useState(() => listHistory(tab));
  const menuRef = useRef(null);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const away = (e) => { if (menuRef.current?.contains(e.target) || anchor?.contains(e.target)) return; onClose(); };
    const gone = (e) => { if (menuRef.current?.contains(e.target)) return; onClose(); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', away);
    window.addEventListener('scroll', gone, { capture: true, passive: true });
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', gone, { capture: true });
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, anchor]);
  const rows = entries;
  const listRef = useRef(null);
  useLayoutEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, []);
  const rect = anchor?.getBoundingClientRect?.() || { bottom: 48, right: window.innerWidth - 16 };
  return createPortal(
    <div
      ref={menuRef}
      className="lg-hist"
      role="dialog"
      aria-labelledby="lg-hist-title"
      style={{ top: toLayoutPx(rect.bottom + 4), right: toLayoutPx(Math.max(8, window.innerWidth - rect.right)) }}
    >
      <header className="lg-hist-head">
        <p className="lg-hist-title" id="lg-hist-title">History{entries.length ? <small>{entries.length}</small> : null}</p>
        <Tooltip content={entries.length ? 'Forget everything listed here' : 'Nothing listed yet'}>
          <button type="button" className="lgt-tool-btn is-danger" disabled={!entries.length} onClick={() => { clearHistory(tab); setEntries([]); }}>
            <span className="lgt-tool-ico">{BinIcon}</span><span>Clear</span>
          </button>
        </Tooltip>
        {extra}
        <button type="button" className="lgt-tool-btn" aria-label="Close" onClick={onClose}><span className="lgt-tool-ico">{CrossIcon}</span></button>
      </header>
      <div className="lg-hist-list" ref={listRef}>
        {!rows.length ? <p className="lg-hist-empty">{emptyText || 'Nothing yet. Every search you run and everything you open is listed here.'}</p> : null}
        {rows.map((e, i) => {
          const prev = rows[i - 1];
          const showDay = !prev || !sameDay(new Date(prev.at), new Date(e.at));
          return (
            <React.Fragment key={e.id}>
              {showDay ? <div className="lg-hist-day" role="separator"><span className="lg-hist-day-label">{dayLabel(e.at)}</span></div> : null}
              <div className={`lg-hist-row ${e.kind === 'search' ? 'is-search' : 'is-open'}`}>
                <button type="button" className="lg-hist-item" onClick={() => onPick(e)}>
                  <span className="lg-hist-msg">{renderEntry(e)}</span>
                  <span className="lg-hist-time">{e.kind === 'search' ? '' : 'Opened '}{formatHM(e.at)}</span>
                </button>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

/** The tool button that owns the dropdown — drop it in LegalTabs' `trailing`. */
export default function HistoryButton({ tab, onPick, renderEntry, extra, emptyText, tip = 'Every search run and everything opened here, with the time' }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Tooltip content={tip}>
        <button
          type="button"
          ref={btnRef}
          className={`lgt-tool-btn${open ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="lgt-tool-ico">{ClockIcon}</span><span>History</span>
        </button>
      </Tooltip>
      {open ? (
        <HistoryMenu
          tab={tab}
          anchor={btnRef.current}
          onClose={close}
          onPick={(e) => { setOpen(false); onPick(e); }}
          renderEntry={renderEntry}
          extra={extra}
          emptyText={emptyText}
        />
      ) : null}
    </>
  );
}
