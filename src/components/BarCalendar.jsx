import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toLayoutPx } from '../lib/appZoom';
import { useOneOpen } from '../lib/oneOpen';
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
// the months either side faded but pickable. The range picker opens TWO
// calendars side by side — FROM on the left, TO on the right, each headed by
// the date it holds — a press in either sets THAT END and nothing else (no
// "first press from, second press to", no swapping, no closing on a pick),
// both show the span, hovering a day previews it, and the usual spans sit
// under both. Keys: ←/→ a day, ↑/↓ a week, PageUp/PageDown a month, Enter picks,
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
// Which end of a span a press on `iso` moves, in the one-calendar span:
// before FROM → FROM, after TO → TO, inside → whichever end is nearer (a
// tie goes to FROM).
export function nearestEnd(iso, from, to) {
  if (!from || iso <= from) return 'from';
  if (!to || iso >= to) return 'to';
  const day = (x) => dateOf(x).getTime();
  return day(iso) - day(from) <= day(to) - day(iso) ? 'from' : 'to';
}
// How long the expanded calendar takes to fade out (keep in step with
// `bc-fade-out` in BarCalendar.css).
const FOLD_MS = 150;

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
 * range's foot; `onClear`. `side` ('from' | 'to'): one of the range picker's
 * TWO calendars — it sets that end, opens on that end's month (`anchor`
 * when the end is empty), and draws no foot (the pair shares one).
 */
// `band`: whether the span between the ends is shaded (off, only the chosen
// days are marked); `min` / `max`: days outside them can't be picked (the TO
// calendar can't go before FROM, nor FROM after TO).
// `nearest`: the one-calendar span — a press moves whichever end is nearer
// (`nearestEnd`), and the hover previews exactly that.
export function Calendar({ mode = 'single', value = '', from = '', to = '', onPick, onPreset, onClear, onClose, presets = null, side = '', anchor: anchorIso = '', band = true, min = '', max = '', nearest = false, reveal = false }) {
  // `reveal`: the span and the chosen days FADE IN as the calendar first
  // appears (the range picker's last step) — for a moment only, so a hover
  // afterwards redraws the preview at once, not in a fade.
  // The same fade plays when the band is switched ON (the range picker's
  // second end chosen): the line joining the two days fades in.
  const [revealing, setRevealing] = useState(!!reveal);
  const bandWas = useRef(band);
  useEffect(() => {
    if (band && !bandWas.current) setRevealing(true);
    bandWas.current = band;
  }, [band]);
  useEffect(() => {
    if (!revealing) return undefined;
    const t = window.setTimeout(() => setRevealing(false), 420);
    return () => window.clearTimeout(t);
  }, [revealing]);
  const today = useMemo(() => isoOf(new Date()), []);
  const own = side === 'from' ? from : side === 'to' ? to : '';
  const startIso = side ? (own || anchorIso) : (mode === 'range' ? (to || from) : value);
  const anchor = dateOf(startIso) || new Date();
  const [month, setMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const [focus, setFocus] = useState(() => (side ? own : (mode === 'range' ? (to || from) : value)) || startIso || today);
  const [hover, setHover] = useState('');
  const gridRef = useRef(null);

  // A side calendar follows its end when it is set from outside (a preset,
  // the other calendar swapping the two): turned to that month unless it is
  // already on show.
  useEffect(() => {
    if (!side || !own) return;
    const d = dateOf(own);
    if (d && (d.getMonth() !== month.getMonth() || d.getFullYear() !== month.getFullYear())) {
      setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    setFocus(own);
  }, [side, own]); // eslint-disable-line react-hooks/exhaustive-deps

  // The six weeks on show, Monday first.
  const days = useMemo(() => {
    const lead = (month.getDay() + 6) % 7;
    const start = addDays(month, -lead);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);

  // The span: a SIDE calendar previews its own end at the hovered day
  // against the other end, as it stands. (The old one-calendar range, where
  // the first press was FROM and the second TO, is gone.)
  let lo = from; let hi = to;
  if (side || nearest) {
    const hs = hover ? (nearest ? nearestEnd(hover, from, to) : side) : '';
    const a = hs === 'from' ? hover : from;
    const b = hs === 'to' ? hover : to;
    [lo, hi] = a && b ? [a, b].sort() : [a || b, a || b];
  }

  // `min` / `max` also bound the NAVIGATION: the TO calendar can't be paged
  // to a month before FROM's (nor the FROM one past TO's), and the keys stop
  // at the bound instead of walking past it.
  const minMonth = min ? min.slice(0, 7) : '';
  const maxMonth = max ? max.slice(0, 7) : '';
  const monthKey = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
  // Changing month SLIDES the page in, as the Activity feed enters under its
  // tabs: a later month from the right, an earlier one from the left (the
  // title and the day grid are keyed by month, so the remount replays it).
  // The first month drawn doesn't move.
  const lastMonth = useRef(monthKey);
  const [slide, setSlide] = useState('');
  if (lastMonth.current !== monthKey) {
    setSlide(monthKey > lastMonth.current ? 'right' : 'left');
    lastMonth.current = monthKey;
  }
  const canPrev = !minMonth || monthKey > minMonth;
  const canNext = !maxMonth || monthKey < maxMonth;
  // The month on show is kept inside the bounds (a bound that moves, or a
  // month opened outside it).
  useEffect(() => {
    if (minMonth && monthKey < minMonth) setMonth(new Date(Number(minMonth.slice(0, 4)), Number(minMonth.slice(5, 7)) - 1, 1));
    else if (maxMonth && monthKey > maxMonth) setMonth(new Date(Number(maxMonth.slice(0, 4)), Number(maxMonth.slice(5, 7)) - 1, 1));
  }, [minMonth, maxMonth, monthKey]);
  const move = (target) => {
    let iso = target;
    if (min && iso < min) iso = min;
    if (max && iso > max) iso = max;
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
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!(min && focus < min) && !(max && focus > max)) onPick?.(focus);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose?.(); }
  };
  useEffect(() => {
    if (keyed.current) gridRef.current?.querySelector('.bc-day.is-focus')?.focus({ preventScroll: true });
  }, [focus, month]);

  return (
    <div className={`bc${mode === 'range' ? ' is-range' : ''}${revealing ? ' is-reveal' : ''}`}>
      <div className="bc-head">
        <button type="button" className="bc-nav" aria-label="Previous month" disabled={!canPrev} onClick={() => { if (canPrev) setMonth((m) => addMonths(m, -1)); }}>{PrevGlyph}</button>
        <span key={monthKey} className={`bc-title${slide ? ` is-enter-${slide}` : ''}`} aria-live="polite">{MONTHS[month.getMonth()]} <span className="bc-year">{month.getFullYear()}</span></span>
        <button type="button" className="bc-nav" aria-label="Next month" disabled={!canNext} onClick={() => { if (canNext) setMonth((m) => addMonths(m, 1)); }}>{NextGlyph}</button>
      </div>
      <div className="bc-week" aria-hidden="true">{WEEKDAYS.map((w, i) => <span key={w} className={i > 4 ? 'is-weekend' : ''}>{w}</span>)}</div>
      <div key={monthKey} className={`bc-grid${slide ? ` is-enter-${slide}` : ''}`} role="grid" ref={gridRef} onKeyDown={onKey} onMouseLeave={() => setHover('')}>
        {days.map((d) => {
          const iso = isoOf(d);
          const out = d.getMonth() !== month.getMonth();
          // A SIDE calendar sets one end; the OTHER end, when it shows on this
          // page (FROM in the TO calendar, TO in the FROM one), is drawn
          // faded — marked, but plainly not what a press here sets.
          const otherEnd = side === 'to' ? from : side === 'from' ? to : '';
          const ghost = !!otherEnd && iso === otherEnd && iso !== (side === 'to' ? to : from);
          const chosen = !ghost && (mode === 'single' ? iso === value : (iso === from || iso === to));
          const inSpan = band && mode === 'range' && lo && hi && iso > lo && iso < hi;
          const edge = band && mode === 'range' && lo && hi && lo !== hi ? (iso === lo ? ' is-start' : iso === hi ? ' is-end' : '') : '';
          const off = (min && iso < min) || (max && iso > max);
          return (
            <button
              key={iso}
              type="button"
              role="gridcell"
              aria-selected={chosen}
              aria-disabled={off || undefined}
              aria-label={roDate(iso)}
              tabIndex={iso === focus ? 0 : -1}
              className={`bc-day${out ? ' is-out' : ''}${iso === today ? ' is-today' : ''}${chosen ? ' is-on' : ''}${ghost ? ' is-ghost' : ''}${inSpan ? ' is-span' : ''}${edge}${iso === focus ? ' is-focus' : ''}${(d.getDay() + 6) % 7 > 4 ? ' is-weekend' : ''}${off ? ' is-off' : ''}`}
              onClick={() => { if (off) return; setFocus(iso); onPick?.(iso); }}
              onMouseEnter={() => setHover(off ? '' : iso)}
            >
              <span>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
      {side || nearest ? null : (
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
      )}
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
// `relayout`: anything that changes the panel's size while it is open (the
// range's steps — one calendar, then another, then two) — it is fitted to
// the window again when it changes.
function useCalendarPopover(inline, relayout = '') {
  // Closed to begin with — in the gallery too.
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  // CLOSING fades: the expanded folder fades out over the field
  // (`is-closing`, FOLD_MS) and only then is it taken away. A scroll or a
  // resize still closes at once — the field has moved under it — and so does
  // everything under reduced motion.
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const shut = (refocus) => {
    window.clearTimeout(closeTimer.current);
    setClosing(false);
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };
  // One open at a time: another dropdown or calendar opening shuts this
  // one at once (no fade — the two would overlap while it played).
  useOneOpen(open, () => shut(false));
  const reduced = () => {
    try {
      return document.documentElement.getAttribute('data-reduce-motion') === 'true'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return false; }
  };
  const fold = (refocus) => {
    if (reduced()) { shut(refocus); return; }
    setClosing(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => shut(refocus), FOLD_MS);
  };
  // A press outside the field and its calendar folds it — drawn in place
  // (the gallery) as well. A scroll / resize shuts a portalled one only.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return; fold(false); };
    if (inline) {
      window.addEventListener('mousedown', away);
      return () => window.removeEventListener('mousedown', away);
    }
    const gone = (e) => { if (panelRef.current?.contains(e.target)) return; shut(false); };
    window.addEventListener('mousedown', away);
    window.addEventListener('scroll', gone, { capture: true, passive: true });
    window.addEventListener('resize', gone);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', gone, { capture: true });
      window.removeEventListener('resize', gone);
    };
  }, [open, inline]); // eslint-disable-line react-hooks/exhaustive-deps
  // `inline` (the gallery) starts closed and expands and collapses as a real
  // one does — the field toggles it, a pick / Escape folds it, another
  // dropdown opening shuts it. It just isn't portalled or closed by a press
  // elsewhere.
  const toggle = () => {
    if (open && !closing) { fold(true); return; }
    if (!inline && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    window.clearTimeout(closeTimer.current);
    setClosing(false);
    setOpen(true);
  };
  const close = () => { if (open && !closing) fold(true); };
  // TWO SECTIONS: the FIELD (the button, in the bar, never changing) and,
  // open, the CALENDAR — a box of its own a little below the field, not
  // joined to it. It is made to FIT THE WINDOW, measured once drawn: wider
  // than the room right of its field (the range's two calendars) → pulled
  // left; taller than the room below → opened ABOVE the field when that has
  // the room, else raised just enough to fit (the calendar then scrolls
  // inside).
  const GAP = 6;
  const [place, setPlace] = useState(null);   // layout px: { left, top, above, maxH }
  useLayoutEffect(() => {
    if (!open || inline || !rect) { setPlace(null); return; }
    const el = panelRef.current;
    if (!el) return;
    const M = 16;
    const vw = window.innerWidth; const vh = window.innerHeight;
    const w = el.offsetWidth; const h = el.scrollHeight;
    const zoom = el.getBoundingClientRect().width / (w || 1) || 1;   // viewport px per layout px
    const W = w * zoom; const H = h * zoom; const G = GAP * zoom;
    const left = Math.max(M, Math.min(rect.left, vw - M - W));
    let top = rect.bottom + G; let above = false;
    if (top + H > vh - M) {
      if (rect.top - G - H >= M) { top = rect.top - G - H; above = true; }
      else top = Math.max(M, vh - M - H);
    }
    const next = { left: toLayoutPx(left), top: toLayoutPx(top), above, maxH: toLayoutPx(vh - 2 * M) };
    setPlace((p) => (p && Object.keys(next).every((k) => p[k] === next[k]) ? p : next));
  }, [open, inline, rect, relayout]);
  const panel = (children, extra = '') => {
    if (!open) return null;
    const cls = `lg-menu bc-pop${extra ? ` ${extra}` : ''}${place?.above ? ' is-above' : ''}${closing ? ' is-closing' : ''}${place || inline ? ' is-placed' : ''}`;
    // Drawn in place (the gallery), it floats under its field over the
    // content — opening moves nothing.
    if (inline) return <div className={`${cls} is-inline`} ref={panelRef}>{children}</div>;
    if (!rect) return null;
    // Until measured it is drawn where it would stand, hidden, so the first
    // frame never shows it cut off.
    const style = place
      ? { top: place.top, left: place.left, maxHeight: place.maxH, overflowY: 'auto' }
      : { top: toLayoutPx(rect.bottom) + GAP, left: toLayoutPx(rect.left), visibility: 'hidden' };
    return createPortal(
      <div className={cls} ref={panelRef} style={style}>{children}</div>,
      document.body,
    );
  };
  return { open, btnRef, toggle, close, panel };
}

/** One date — a field in the bar showing zz.ll.aaaa, the calendar under it. */
export function BarDatePicker({ value = '', onChange, placeholder = 'zz.ll.aaaa', label = 'Date', inline = false }) {
  const pop = useCalendarPopover(inline);
  const inner = (
    <>
      <span className="bc-field-ico">{CalendarGlyph}</span>
      <span className={`bc-field-text${value ? '' : ' is-ph'}`}>{value ? roDate(value) : placeholder}</span>
      {/* The dropdown's chevron (LegalBar's .lg-kind-chev), turning over when open. */}
      <span className="lg-kind-chev bc-field-chev" aria-hidden="true" />
    </>
  );
  return (
    <span className={`bc-wrap${inline ? ' is-inline' : ''}`}>
      {/* Drawn in place (the gallery), the field keeps its place; the open shape floats over it. */}
      {(
        <button
          type="button"
          ref={pop.btnRef}
          className={`lg-input bc-field${pop.open ? ' is-open' : ''}${value ? '' : ' is-empty'}`}
          aria-haspopup="dialog"
          aria-expanded={pop.open}
          aria-label={value ? `${label}: ${roDate(value)}` : label}
          onClick={pop.toggle}
        >
          {inner}
        </button>
      )}
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

/** A span — one field, "from – to". Open, it is ALWAYS TWO CALENDARS side by
 *  side: FROM on the left, TO on the right. A press in either sets that end
 *  (TO can't go before FROM, FROM can't go after TO — days nor months).
 *  Once both ends are chosen the span is drawn as ONE CONTINUOUS BAND joining
 *  them, on both pages (across two months it runs to FROM's page edge and on
 *  from TO's); hovering a day previews moving that end, band and all.
 *
 *  The quick picks stand under it all, Clear at their right end — the
 *  bottom-right corner. */
export function BarDateRange({ from = '', to = '', onChange, label = 'Period', inline = false }) {
  const pop = useCalendarPopover(inline, `${from ? 1 : 0}${to ? 1 : 0}`);
  const presets = useMemo(rangePresets, []);
  // Each calendar sets ITS end and nothing else, and the panel stays open
  // (a press elsewhere, Escape or a preset closes it).
  const pickFrom = (iso) => onChange?.({ from: iso, to });
  const pickTo = (iso) => onChange?.({ from, to: iso });
  // The label over a calendar: just the end it sets — "From" or "To".
  const endLabel = (name) => <p className="bc-range-label">{name}</p>;
  // Where each calendar opens: TO on its day, else FROM's month, else this
  // month; FROM on its day, else the month before TO's page.
  const toAnchor = to || from || isoOf(new Date());
  const fromAnchor = from || isoOf(addMonths(dateOf(toAnchor), -1));
  // The band joins the two ends only once BOTH are chosen.
  const band = !!(from && to);
  const inner = (
    <>
      <span className="bc-field-ico">{CalendarGlyph}</span>
      <span className={`bc-field-text${from ? '' : ' is-ph'}`}>{from ? roDate(from) : 'From'}</span>
      <span className="bc-field-dash" aria-hidden="true">–</span>
      <span className={`bc-field-text${to ? '' : ' is-ph'}`}>{to ? roDate(to) : 'To'}</span>
      <span className="lg-kind-chev bc-field-chev" aria-hidden="true" />
    </>
  );
  return (
    <span className={`bc-wrap${inline ? ' is-inline' : ''}`}>
      <button
        type="button"
        ref={pop.btnRef}
        className={`lg-input bc-field is-range${pop.open ? ' is-open' : ''}${from ? '' : ' is-empty'}`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-label={from || to ? `${label}: ${from ? roDate(from) : '…'} – ${to ? roDate(to) : '…'}` : label}
        onClick={pop.toggle}
      >
        {inner}
      </button>
      {pop.panel(
        <div className="bc-range">
          <div className="bc-range-cals">
            <div className="bc-range-col">
              {endLabel('From')}
              <Calendar key="from" mode="range" side="from" from={from} to={to} anchor={fromAnchor} band={band} max={to} onPick={pickFrom} onClose={pop.close} />
            </div>
            <span className="bc-range-sep" aria-hidden="true" />
            <div className="bc-range-col">
              {endLabel('To')}
              <Calendar key="to" mode="range" side="to" from={from} to={to} anchor={toAnchor} band={band} min={from} onPick={pickTo} onClose={pop.close} />
            </div>
          </div>
          <div className="bc-foot bc-range-foot">
            <p className="bc-quick-label">Quick picks</p>
            <div className="bc-presets" role="group" aria-label="Quick picks">
              {presets.map((p) => (
                <button
                  type="button"
                  key={p.label}
                  className={`bc-preset${p.from === from && p.to === to ? ' is-on' : ''}`}
                  onClick={() => { onChange?.({ from: p.from, to: p.to }); pop.close(); }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {/* Clear, in the bottom-right corner — back to the first step. */}
            <button type="button" className="bc-link is-muted" disabled={!from && !to} onClick={() => onChange?.({ from: '', to: '' })}>Clear</button>
          </div>
        </div>,
        'is-range',
      )}
    </span>
  );
}
