import React, { useLayoutEffect, useRef } from 'react';
import './FilterTabs.css';

// ── Filter tab strip ──────────────────────────────────────────────────────
// Flat tabs with ONE shared underline element that SLIDES to the active tab
// (transform + width transition in CSS). Built for the Activity feed's mini
// header, then lifted here when the project Settings tab needed the same
// treatment — sharing the component rather than copying it is what keeps the
// two literally identical instead of merely similar.
//
// Hosted inside a sticky mini header, the chain stretches to the bar's height
// so the underline straddles the bar's bottom edge. Standalone (the Settings
// strip), the host gives it a height and the underline rides its own bottom.
//
// `tabs` is [{ id, label, unavailable? }]. A tab marked `unavailable` is still
// SHOWN — faded and inert — so the strip says what exists rather than only
// what applies here, the way the Quick actions card does with its catalogue.
// `underlineCat` tints the bar via data-cat — the
// Activity feed passes the active category so the line takes that category's
// colour; callers with no categories leave it out and get the accent.
// `fromId`: a tab to start the underline FROM on mount — it snaps there and
// then slides to the active tab. For a strip that is remounted on every
// change (the Legislation tab bar: each tab is a route, so the page and the
// bar mount afresh), this is what keeps the slide the Activity strip gets
// for free by staying mounted.
export default function FilterTabs({ tabs, active, onSelect, className = '', underlineCat, ariaLabel = 'Filter', fromId = null }) {
  const stripRef = useRef(null);
  const underlineRef = useRef(null);
  // False until the underline has been positioned once. The very first
  // placement (entering the tab) SNAPS into place — the bar starts at the CSS
  // initial width:0 / no transform, so letting the transition run would show
  // it sliding in from the strip's top-left corner on every mount.
  const placedRef = useRef(false);

  // Place the underline under the active tab. Re-runs when the active tab or
  // the tab set changes; a ResizeObserver re-places on width shifts (count
  // digits changing, the bar resizing).
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const bar = underlineRef.current;
    if (!strip || !bar) return undefined;
    // Which tabs END a row. A strip that WRAPS (the Doc Viewer's side panel)
    // draws a hairline between neighbours, and the one at the end of a row must
    // not carry it — where the wrap fell is not something CSS can ask, so it is
    // measured, the same way DocQuickActions marks its tiles. The mark changes
    // nothing about layout (the divider is an absolutely-placed ::after), so
    // this cannot feed the ResizeObserver below.
    const markRowEnds = () => {
      const btns = Array.from(strip.querySelectorAll('.activity-filter'));
      btns.forEach((b, i) => {
        const next = btns[i + 1];
        b.classList.toggle('is-rowend', !next || next.offsetTop > b.offsetTop);
      });
    };
    // Where the underline sits for a button. Wrap the label text with a
    // symmetric overhang on each side so the bar reads wider than the word
    // and stays centred under it. No clamp to the button's box: the first
    // tab has no leading padding, so its underline deliberately pokes past
    // the tab's left edge (the strip's overflow is visible). Offsets are
    // relative to the button (position: relative). Vertically it rides the
    // host bar's bottom edge like the chat toolbar's tab line
    // (.dvx-tab.is-active::after): the tabs stretch to the bar's full
    // height, so the button's bottom IS the bar's bottom border — the line
    // straddles it, nudged the same 40% past the midpoint as chat (line
    // half-height 1.6px − 40%-of-height 1.28px = 0.32px above the edge for
    // the line's top).
    const EXT = 8;
    const spot = (btn) => {
      const label = btn.querySelector('.activity-filter-label');
      const start = (label ? label.offsetLeft : 0) - EXT;
      const end = (label ? label.offsetLeft + label.offsetWidth : btn.offsetWidth) + EXT;
      return { x: btn.offsetLeft + start, y: btn.offsetTop + btn.offsetHeight - 0.32, w: Math.max(end - start, 0) };
    };
    const put = (s) => {
      bar.style.width = `${s.w}px`;
      bar.style.transform = `translate(${s.x}px, ${s.y}px)`;
    };
    const place = () => {
      markRowEnds();
      const btn = strip.querySelector(`[data-tab-id="${active}"]`);
      if (!btn) { bar.style.width = '0px'; return; }
      if (!placedRef.current) {
        // First placement: snap — to the tab the underline is said to come
        // from, and then slide on to the active one; else straight to the
        // active one, and the stylesheet transition takes over from there.
        const from = fromId && fromId !== active ? strip.querySelector(`[data-tab-id="${fromId}"]`) : null;
        bar.style.transition = 'none';
        put(spot(from || btn));
        void bar.offsetWidth;
        bar.style.transition = '';
        if (!from) { placedRef.current = true; return; }
      }
      put(spot(btn));
      placedRef.current = true;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [active, tabs]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`activity-filters${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      ref={stripRef}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        // aria-disabled, not `disabled`: a disabled button fires no mouse
        // events, so it could carry no tooltip and no hover at all.
        const off = !!tab.unavailable;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={off || undefined}
            data-cat={tab.id}
            data-tab-id={tab.id}
            className={`activity-filter${isActive ? ' is-active' : ''}${off ? ' is-unavailable' : ''}`}
            onClick={() => { if (!off) onSelect(tab.id); }}
          >
            <span className="activity-filter-label">{tab.label}</span>
          </button>
        );
      })}
      <span
        className="activity-filter-underline"
        data-cat={underlineCat ?? active}
        ref={underlineRef}
        aria-hidden="true"
      />
    </div>
  );
}
