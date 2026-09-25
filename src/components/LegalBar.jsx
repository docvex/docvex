import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toLayoutPx } from '../lib/appZoom';
import './LegalBar.css';

// THE SEARCH BAR of the Legislation tabs — first drawn for legislatie.just.ro
// (the dice, Kind, Number, Year, Search) and now shared, so Court files and
// ANAF draw their own fields the same way: one row in the tab bar's second
// line, at the left (LegalTabs' `tools` slot), drawn as the words box beside
// it — 24px tall, the same hairline, radius, frost and type — the segments
// joined by hairlines, the dice as the left end and the go button as the
// right end, both accent-filled. No labels: placeholders, as the words box
// has. Focus is an inset outline, so nothing in the row moves a pixel.
//
//   <LegalBar onSubmit={…}>
//     <BarDice onClick={…} />
//     <BarSwitch value options onChange />     a two-way choice, as segments
//     <BarPicker value options|groups onChange />  the app's own dropdown
//     <BarInput … />                              a text / number / date field
//     <BarNote>3 CUIs · one request</BarNote>     a still segment of text
//     <BarGo busy>Search</BarGo>
//   </LegalBar>

const SearchGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
  </svg>
);
export const BarDiceGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <circle cx="8.2" cy="8.2" r="1.1" fill="currentColor" /><circle cx="15.8" cy="8.2" r="1.1" fill="currentColor" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" />
    <circle cx="8.2" cy="15.8" r="1.1" fill="currentColor" /><circle cx="15.8" cy="15.8" r="1.1" fill="currentColor" />
  </svg>
);

/** The row itself — a form, so Enter in any field submits. */
export function LegalBar({ onSubmit, className = '', children, ...rest }) {
  return (
    <form
      className={`lg-bar${className ? ` ${className}` : ''}`}
      onSubmit={(e) => { e.preventDefault(); onSubmit?.(e); }}
      {...rest}
    >
      {children}
    </form>
  );
}

/** The dice — the left end of the bar, the go button's twin. */
export function BarDice({ label = 'A random one', ...rest }) {
  return (
    <button type="button" className="lg-random" aria-label={label} {...rest}>
      <span className="lg-ico">{BarDiceGlyph}</span>
    </button>
  );
}

/** The go button — the right end of the bar. */
export function BarGo({ busy = false, busyLabel = 'Searching…', glyph = SearchGlyph, children, ...rest }) {
  return (
    <button type="submit" className="lg-go" disabled={busy} {...rest}>
      <span className="lg-ico">{glyph}</span>
      <span>{busy ? busyLabel : children}</span>
    </button>
  );
}

/** A text / number / date field. `size`: 'num' (66px) · 'text' (120px) · 'wide' (160px) · 'date' (104px). */
export function BarInput({ size = 'text', className = '', ...rest }) {
  return <input className={`lg-input is-${size}${className ? ` ${className}` : ''}`} {...rest} />;
}

/** A still segment of text — a count, a hint — in the field's style. */
export function BarNote({ children, className = '' }) {
  return <span className={`lg-input lg-note${className ? ` ${className}` : ''}`}>{children}</span>;
}

/**
 * A two-way (or three-way) choice drawn as SEGMENTS of the bar — each option
 * a field-shaped button, the chosen one in the focused field's accent tint.
 * (The Case files / A court's day switch.)
 */
export function BarSwitch({ value, options, onChange, label }) {
  return (
    <div className="lg-switch" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          className={`lg-input lg-seg${o.id === value ? ' is-on' : ''}`}
          onClick={() => { if (o.id !== value) onChange(o.id); }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The app's own dropdown, not the browser's — a native <select> cannot take
 * the bar's frost or a rounded foot. The field is a button; open, a list
 * hangs under it (portalled to <body>, placed from the button's rect), on the
 * bar's ground, its bottom corners rounded, the chosen entry faded. Escape, a
 * click elsewhere or a scroll closes it. `options` = [{ id, label }], or
 * `groups` = [{ label, list: [{ id, label }] }] for a long list under
 * headings — a long list scrolls and gets a filter box at its head.
 */
// How narrow and how wide a picker's field may get as it fits its choice.
const PICKER_MIN = 56;
const PICKER_MAX = 460;

export function BarPicker({ value, onChange, options = null, groups = null, label, placeholder = '', width = 'kind', filter = null }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [q, setQ] = useState('');
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const findRef = useRef(null);
  const all = useMemo(() => (groups ? groups.flatMap((g) => g.list) : options || []), [groups, options]);
  const current = all.find((t) => t.id === value);
  const text = current?.label ?? placeholder ?? all[0]?.label ?? '';
  const filtering = filter ?? all.length > 12;
  // The field is as wide as what is CHOSEN, and glides to the new width
  // when the choice changes ("Hotărâre" → "Ordonanță de urgență"): the
  // label's own width (a hidden copy, `.lg-kind-measure`) plus the field's
  // padding, border, gap and chevron, clamped. The first width is set
  // without motion; the glide is the CSS transition on `.lg-kind`.
  const labelRef = useRef(null);
  const measureRef = useRef(null);
  const sized = useRef(false);
  const fit = () => {
    const btn = btnRef.current; const m = measureRef.current; const chev = btn?.querySelector('.lg-kind-chev');
    if (!btn || !m || !chev) return;
    const bs = getComputedStyle(btn); const cs = getComputedStyle(chev);
    const px = (v) => parseFloat(v) || 0;
    const chrome = (btn.offsetWidth - btn.clientWidth) + px(bs.paddingLeft) + px(bs.paddingRight)
      + px(bs.columnGap || bs.gap) + chev.offsetWidth + px(cs.marginLeft) + px(cs.marginRight);
    const w = Math.min(PICKER_MAX, Math.max(PICKER_MIN, Math.ceil(m.getBoundingClientRect().width / (btn.getBoundingClientRect().width / btn.offsetWidth || 1) + chrome + 1)));
    if (!sized.current) {
      sized.current = true;
      btn.style.transition = 'none';
      btn.style.width = `${w}px`;
      void btn.offsetWidth;                   // commit the first width with no glide
      btn.style.transition = '';
    } else {
      btn.style.width = `${w}px`;
    }
  };
  useLayoutEffect(fit, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  // …and again whenever the label's REAL width changes with no change of
  // choice: the app's font arriving after the first paint, a larger size
  // where the field is drawn bigger (the Legislation start screen).
  useEffect(() => {
    const m = measureRef.current;
    if (!m || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => fit());
    ro.observe(m);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => {
    if (!open && btnRef.current) { setRect(btnRef.current.getBoundingClientRect()); setQ(''); }
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const key = (e) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    // A scroll INSIDE the list is the list's own; any other closes it.
    const gone = (e) => { if (menuRef.current && menuRef.current.contains(e.target)) return; setOpen(false); };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', gone, { capture: true, passive: true });
    window.addEventListener('resize', gone);
    if (filtering) findRef.current?.focus();
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', gone, { capture: true });
      window.removeEventListener('resize', gone);
    };
  }, [open, filtering]);

  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hit = (o) => !q || fold(o.label).includes(fold(q));
  // A group whose entries all open with the same words ("Curtea de Apel …",
  // "Tribunalul …", "Judecătoria …") is headed by those words and its
  // entries show only what follows them — the prefix said once, in a head
  // that STAYS at the top while the group scrolls, instead of on every row.
  // The prefix is what MOST of the group opens with (two entries in three
  // at least) — one odd entry ("Curtea Militară de Apel …" among the
  // "Curtea de Apel …") must not shorten the head to "Curtea" for all the
  // rest; the odd one shows its whole name. Only while something is left
  // after it on every entry that has it.
  const headed = useMemo(() => (groups || []).map((g) => {
    if (g.list.length < 2) return { ...g, prefix: '' };
    const words = g.list.map((o) => String(o.label || '').split(' '));
    let prefix = '';
    for (let n = 1; ; n++) {
      const tally = new Map();
      for (const w of words) {
        if (w.length <= n) continue;
        const k = w.slice(0, n).map(fold).join(' ');
        tally.set(k, (tally.get(k) || 0) + 1);
      }
      let best = null; let count = 0;
      for (const [k, c] of tally) if (c > count) { best = k; count = c; }
      if (!best || count * 3 < words.length * 2) break;
      prefix = words.find((w) => w.slice(0, n).map(fold).join(' ') === best).slice(0, n).join(' ');
    }
    return { ...g, prefix };
  }), [groups]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = groups
    ? headed.map((g) => ({ ...g, list: g.list.filter(hit) })).filter((g) => g.list.length)
    : [{ label: null, list: all.filter(hit) }];
  const short = (t, g) => (g?.prefix && fold(t.label).startsWith(fold(g.prefix) + ' ') ? t.label.slice(g.prefix.length + 1) : t.label);

  // The entry chosen is marked by a filled circle at the row's right end;
  // it is as clickable as the rest (picking it again just closes the list).
  const item = (t, g) => (
    <li key={t.id}>
      <button
        type="button"
        role="option"
        aria-selected={t.id === value}
        aria-label={t.label}
        className={`lg-menu-item${t.id === value ? ' is-on' : ''}`}
        onClick={() => { onChange(t.id); setOpen(false); }}
      >
        <span className="lg-menu-item-label">{short(t, g)}</span>
        {t.id === value ? <span className="lg-menu-mark" aria-hidden="true" /> : null}
      </button>
    </li>
  );

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`lg-input is-${width} lg-kind${open ? ' is-open' : ''}${current ? '' : ' is-empty'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={toggle}
      >
        <span className="lg-kind-label" ref={labelRef}>{text}</span>
        <span className="lg-kind-chev" aria-hidden="true" />
        <span className="lg-kind-measure" ref={measureRef} aria-hidden="true">{text}</span>
      </button>
      {open && rect ? createPortal(
        <div
          ref={menuRef}
          className={`lg-menu${filtering ? ' is-long' : ''}`}
          // At least the field's width, and as wide as its longest entry
          // needs (`width: max-content` in the CSS), within the window.
          style={{ top: toLayoutPx(rect.bottom), left: toLayoutPx(rect.left), minWidth: toLayoutPx(Math.max(rect.width, filtering ? 240 : 0)) }}
        >
          {filtering ? (
            <input
              ref={findRef}
              className="lg-menu-find"
              value={q}
              placeholder="Type to narrow"
              aria-label={`Narrow ${label || 'the list'}`}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const first = shown[0]?.list[0];
                  if (first) { e.preventDefault(); onChange(first.id); setOpen(false); }
                }
              }}
            />
          ) : null}
          <ul className="lg-menu-list" role="listbox" aria-label={label}>
            {shown.map((g, i) => (
              <React.Fragment key={g.label ?? i}>
                {g.prefix || g.label ? <li className="lg-menu-head" role="presentation">{g.prefix || g.label}</li> : null}
                {g.list.map((t) => item(t, g))}
              </React.Fragment>
            ))}
            {!shown.length ? <li className="lg-menu-none">Nothing matches</li> : null}
          </ul>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
