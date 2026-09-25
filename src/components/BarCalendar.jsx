import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toLayoutPx } from '../lib/appZoom';
import './LegalBar.css';
import './BarCalendar.css';

// THE CALENDAR of the Legislation bar — the app's own date picker, not the
// browser's (a native <input type="date"> shows its month in the OS's own
// look and, on an English Windows, month-first; it takes neither the bar's
// frost nor its type). Two fields built on the bar's recipe (LegalBar.css):
//
//   <BarDatePicker value="2024-03-15" onChange={(iso) => …} />
//   <BarDateRange from="2024-01-01" to="2024-03-31" onChange={({ from, to }) => …} />
//
// A field shows the date the Romanian way, zz.ll.aaaa (the order an act and
// a court file write it), with a calendar mark; pressing it hangs the
// CALENDAR under it, as the Kind picker hangs its list — on the bar's ground,
// an accent hairline round both, the foot rounded, portalled to <body> and
// placed from the field's rect. The calendar: the month and year with the
// previous / next month, the weekdays from MONDAY (the Romanian week), six
// rows of days — today ringed, the chosen day filled in the accent, days of
// the months either side faded but pickable. The range picker takes two
// presses (from, then to; a second press earlier than the first swaps
// them), shows the span as it is hovered, and offers the usual spans at its
// foot. Keys: ←/→ a day, ↑/↓ a week, PageUp/PageDown a month, Enter picks,
// Escape closes. Values are ISO dates (YYYY-MM-DD) in and out.
//
// Only in the Design system's gallery for now — no tab uses them yet.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOf = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
/** An ISO date as a Romanian document writes it: 15.03.2024. */
export const roDate = (iso) => {
  const d = dateOf(iso);
  return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}` : '';
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

const CalendarGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17" /><path d="M8 3v4M16 3v4" />
  </svg>
);
const PrevGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
);
const NextGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);

/**
 * The calendar itself. `mode` 'single' (`value`) or 'range' (`from`, `to`);
 * `onPick(iso)` for a day pressed; `presets` [{ label, from, to }] for the
 * range's foot; `onClear`.
 */
export function Calendar({ mode = 'single', value = '', from = '', to = '', onPick, onPreset, onClear, onClose, presets = null }) {
  const today = useMemo(() => isoOf(new Date()), []);
  const anchor = dateOf(mode === 'range' ? (to || from) : value) || new Date();
  const [month, setMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const [focus, setFocus] = useState(() => (mode === 'range' ? (to || from) : value) || today);
  const [hover, setHover] = useState('');
  const gridRef = useRef(null);

  // The six weeks on show, Monday first.
  const days = useMemo(() => {
    const lead = (month.getDay() + 6) % 7;
    const start = addDays(month, -lead);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);

  // A range being made (from chosen, to not yet): the span follows the
  // pointer, or the keyboard's day.
  const pending = mode === 'range' && from && !to;
  const spanEnd = pending ? (hover || focus) : to;
  const [lo, hi] = mode === 'range' && from && spanEnd ? [from, spanEnd].sort() : [from, to];

  const move = (iso) => {
    setFocus(iso);
    const d = dateOf(iso);
    if (d && (d.getMonth() !== month.getMonth() || d.getFullYear() !== month.getFullYear())) setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };
  const keyed = useRef(false);   // focus follows the day only while the keys are in use
  const onKey = (e) => {
    keyed.current = true;
    const d = dateOf(focus) || new Date();
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) { e.preventDefault(); move(isoOf(addDays(d, step))); return; }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const m = addMonths(d, e.key === 'PageUp' ? -1 : 1);
      move(isoOf(new Date(m.getFullYear(), m.getMonth(), Math.min(d.getDate(), new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()))));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick?.(focus); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose?.(); }
  };
  useEffect(() => {
    if (keyed.current) gridRef.current?.querySelector('.bc-day.is-focus')?.focus({ preventScroll: true });
  }, [focus, month]);

  return (
    <div className={`bc${mode === 'range' ? ' is-range' : ''}`}>
      <div className="bc-head">
        <button type="button" className="bc-nav" aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>{PrevGlyph}</button>
        <span className="bc-title" aria-live="polite">{MONTHS[month.getMonth()]} <span className="bc-year">{month.getFullYear()}</span></span>
        <button type="button" className="bc-nav" aria-label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))}>{NextGlyph}</button>
      </div>
      <div className="bc-week" aria-hidden="true">{WEEKDAYS.map((w, i) => <span key={w} className={i > 4 ? 'is-weekend' : ''}>{w}</span>)}</div>
      <div className="bc-grid" role="grid" ref={gridRef} onKeyDown={onKey} onMouseLeave={() => setHover('')}>
        {days.map((d) => {
          const iso = isoOf(d);
          const out = d.getMonth() !== month.getMonth();
          const chosen = mode === 'single' ? iso === value : (iso === from || iso === to);
          const inSpan = mode === 'range' && lo && hi && iso > lo && iso < hi;
          const edge = mode === 'range' && lo && hi && lo !== hi ? (iso === lo ? ' is-start' : iso === hi ? ' is-end' : '') : '';
          return (
            <button
              key={iso}
              type="button"
              role="gridcell"
              aria-selected={chosen}
              aria-label={roDate(iso)}
              tabIndex={iso === focus ? 0 : -1}
              className={`bc-day${out ? ' is-out' : ''}${iso === today ? ' is-today' : ''}${chosen ? ' is-on' : ''}${inSpan ? ' is-span' : ''}${edge}${iso === focus ? ' is-focus' : ''}${(d.getDay() + 6) % 7 > 4 ? ' is-weekend' : ''}`}
              onClick={() => { setFocus(iso); onPick?.(iso); }}
              onMouseEnter={() => setHover(iso)}
            >
              <span>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
      <div className="bc-foot">
        {mode === 'range' && presets ? (
          <div className="bc-presets">
            {presets.map((p) => (
              <button type="button" key={p.label} className={`bc-preset${p.from === from && p.to === to ? ' is-on' : ''}`} onClick={() => onPreset?.(p)}>{p.label}</button>
            ))}
          </div>
        ) : (
          <button type="button" className="bc-link" onClick={() => { move(today); onPick?.(today); }}>Today</button>
        )}
        <button type="button" className="bc-link is-muted" onClick={onClear}>Clear</button>
      </div>
      {mode === 'range' ? (
        <p className="bc-hint">{pending ? 'Now the last day.' : 'Press the first day, then the last.'}</p>
      ) : null}
    </div>
  );
}

// The common spans a search by date wants, ending today.
function rangePresets() {
  const t = new Date();
  const back = (n) => isoOf(addDays(t, -n));
  return [
    { label: 'Last 7 days', from: back(6), to: isoOf(t) },
    { label: 'Last 30 days', from: back(29), to: isoOf(t) },
    { label: 'This year', from: `${t.getFullYear()}-01-01`, to: isoOf(t) },
    { label: 'Last year', from: `${t.getFullYear() - 1}-01-01`, to: `${t.getFullYear() - 1}-12-31` },
  ];
}

// The popover both fields share: hung under the field (portalled, placed from
// its rect), closed by a press elsewhere, Escape or a scroll of the page —
// or, `inline`, simply drawn under the field (the gallery shows it open).
function useCalendarPopover(inline) {
  const [open, setOpen] = useState(!!inline);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => {
    if (!open || inline) return undefined;
    const away = (e) => { if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return; setOpen(false); };
    const gone = (e) => { if (panelRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('mousedown', away);
    window.addEventListener('scroll', gone, { capture: true, passive: true });
    window.addEventListener('resize', gone);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', gone, { capture: true });
      window.removeEventListener('resize', gone);
    };
  }, [open, inline]);
  const toggle = () => {
    if (inline) return;
    if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  };
  const close = () => { if (!inline) { setOpen(false); btnRef.current?.focus(); } };
  const panel = (children) => {
    if (!open) return null;
    if (inline) return <div className="lg-menu bc-pop is-inline" ref={panelRef}>{children}</div>;
    if (!rect) return null;
    return createPortal(
      <div className="lg-menu bc-pop" ref={panelRef} style={{ top: toLayoutPx(rect.bottom), left: toLayoutPx(rect.left), minWidth: toLayoutPx(rect.width) }}>
        {children}
      </div>,
      document.body,
    );
  };
  return { open, btnRef, toggle, close, panel };
}

/** One date — a field in the bar showing zz.ll.aaaa, the calendar under it. */
export function BarDatePicker({ value = '', onChange, placeholder = 'zz.ll.aaaa', label = 'Date', inline = false }) {
  const pop = useCalendarPopover(inline);
  return (
    <span className={`bc-wrap${inline ? ' is-inline' : ''}`}>
      <button
        type="button"
        ref={pop.btnRef}
        className={`lg-input bc-field${pop.open ? ' is-open' : ''}${value ? '' : ' is-empty'}`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-label={value ? `${label}: ${roDate(value)}` : label}
        onClick={pop.toggle}
      >
        <span className="bc-field-ico">{CalendarGlyph}</span>
        <span className="bc-field-text">{value ? roDate(value) : placeholder}</span>
      </button>
      {pop.panel(
        <Calendar
          mode="single"
          value={value}
          onPick={(iso) => { onChange?.(iso); pop.close(); }}
          onClear={() => { onChange?.(''); pop.close(); }}
          onClose={pop.close}
        />,
      )}
    </span>
  );
}

/** A span — one field, "from – to", the calendar taking two presses. */
export function BarDateRange({ from = '', to = '', onChange, label = 'Period', inline = false }) {
  const pop = useCalendarPopover(inline);
  const presets = useMemo(rangePresets, []);
  const pick = (iso) => {
    if (!from || to) { onChange?.({ from: iso, to: '' }); return; }
    const [a, b] = [from, iso].sort();
    onChange?.({ from: a, to: b });
    pop.close();
  };
  return (
    <span className={`bc-wrap${inline ? ' is-inline' : ''}`}>
      <button
        type="button"
        ref={pop.btnRef}
        className={`lg-input bc-field is-range${pop.open ? ' is-open' : ''}${from ? '' : ' is-empty'}`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-label={from ? `${label}: ${roDate(from)} – ${to ? roDate(to) : '…'}` : label}
        onClick={pop.toggle}
      >
        <span className="bc-field-ico">{CalendarGlyph}</span>
        <span className={`bc-field-text${from ? '' : ' is-ph'}`}>{from ? roDate(from) : 'From'}</span>
        <span className="bc-field-dash" aria-hidden="true">–</span>
        <span className={`bc-field-text${to ? '' : ' is-ph'}`}>{to ? roDate(to) : 'To'}</span>
      </button>
      {pop.panel(
        <Calendar
          mode="range"
          from={from}
          to={to}
          presets={presets}
          onPick={pick}
          onPreset={(p) => { onChange?.({ from: p.from, to: p.to }); pop.close(); }}
          onClear={() => onChange?.({ from: '', to: '' })}
          onClose={pop.close}
        />,
      )}
    </span>
  );
}
