import { useEffect, useRef } from 'react';
import Tooltip from './Tooltip';
import { toLayoutPx } from '../lib/appZoom';
import './DocRibbon.css';

// The Word document's tools, as they appear in the Doc Viewer's SIDE PANEL (the
// one with Advisor and Metadata). They used to be a Word-style ribbon floating
// across the top of the preview; the ribbon is gone and its contents moved in:
//
//  • DocQuickActions — the section under the panel's tab strip: whole-document
//    actions (Page numbers, Open in Word) as a grid of tiles.
//  • DocThemeGrid    — the body of the panel's **Theme** tab: the document
//    themes (lib/docThemes.js) as a grid of thumbnails, each a little page set
//    in the theme's own fonts and colours over a strip of its palette.
//
// (The **Add** tab has nothing in it yet.) Both are driven by props — the Word
// preview pane owns the state and publishes it to the panel through the
// advisor context (`docTools`).

const CheckGlyph = (
  <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="2.5 6.5 5 9 9.5 3.5" />
  </svg>
);

// The sidebar tabs' cursor-tracked wash: every `selector` button under the node
// gets its own --item-spot-x/y (layout px) as the pointer moves over the node. A
// NATIVE listener, so it follows the DOM rather than the React tree (the
// tooltips portal elsewhere).
export function useItemSpots(selector, live = true) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const onMove = (e) => {
      node.querySelectorAll(selector).forEach((btn) => {
        const br = btn.getBoundingClientRect();
        btn.style.setProperty('--item-spot-x', `${toLayoutPx(e.clientX - br.left)}px`);
        btn.style.setProperty('--item-spot-y', `${toLayoutPx(e.clientY - br.top)}px`);
      });
    };
    node.addEventListener('mousemove', onMove);
    return () => node.removeEventListener('mousemove', onMove);
  }, [selector, live]);
  return ref;
}

function ThemeThumb({ theme, active, lockReason, onPick }) {
  const locked = !!lockReason && !active;
  const { sample, fonts, palette } = theme;
  return (
    <Tooltip content={locked ? lockReason : theme.description}>
      <button
        type="button"
        className={`drb-theme${active ? ' is-active' : ''}${locked ? ' is-locked' : ''}`}
        onClick={() => { if (!locked) onPick?.(theme.id); }}
        // aria-disabled, not `disabled`: a disabled button swallows the hover
        // that has to show WHY it is locked.
        aria-disabled={locked || undefined}
        aria-pressed={active}
        aria-label={`${theme.name} theme`}
      >
        {/* The page sheet is white in both app themes, so the thumbnail is too. */}
        <span className="drb-theme-sheet" aria-hidden="true">
          <span className="drb-theme-page">
            <span className="drb-theme-title" style={{ color: sample.title, fontFamily: fonts.head, borderBottomColor: sample.rule }}>Aa</span>
            <span className="drb-theme-heading" style={{ color: sample.heading, fontFamily: fonts.head }}>Heading</span>
            <span className="drb-theme-lines" style={{ color: sample.body }}>
              <i /><i /><i />
            </span>
          </span>
          <span className="drb-theme-palette">
            {palette.map((hex) => <i key={hex} style={{ background: hex }} />)}
          </span>
        </span>
        <span className="drb-theme-name">
          {active && <span className="drb-theme-check">{CheckGlyph}</span>}
          {theme.name}
        </span>
      </button>
    </Tooltip>
  );
}

// The Theme tab's body: the themes in a grid.
export function DocThemeGrid({ themes = [], themeId = '', onPickTheme = null, lockReason = '' }) {
  const rootRef = useItemSpots('.drb-theme');
  return (
    <div className="drb-themes" ref={rootRef}>
      {themes.map((theme) => (
        <ThemeThumb
          key={theme.id}
          theme={theme}
          active={theme.id === themeId}
          lockReason={lockReason}
          onPick={onPickTheme}
        />
      ))}
    </div>
  );
}

// The section under the panel's tabs. `actions`: [{ id, label, tooltip?, icon,
// onClick, pressed? }] — `pressed` (a boolean) makes the tile a toggle.
// `disabled`: a paragraph is open, and none of these is about the paragraph.
export function DocQuickActions({ actions = [], disabled = false, catalogue = [] }) {
  // (Re-bound when the section appears: with no actions it renders nothing.)
  const rootRef = useItemSpots('.drb-action', actions.length > 0);
  // A hairline between neighbouring tiles — but never after the LAST tile of a
  // row, where it would hang in the card's margin. Which tile ends a row depends
  // on how the grid wrapped, and CSS can't ask: a tile whose successor sits
  // lower is a row end, so it is measured (and re-measured on resize).
  // The card shows EVERY quick action the app has: the pane's own, plus the
  // rest of the catalogue greyed out, in the catalogue's order so a tile keeps
  // its place from one file to the next. An entry is satisfied by its own id or
  // any of its `also` ids.
  const merged = catalogue.length ? (() => {
    const byId = new Map(actions.map((a) => [a.id, a]));
    const taken = new Set();
    const out = catalogue.map((c) => {
      const hit = [c.id, ...(c.also || [])].map((id) => byId.get(id)).find(Boolean);
      if (hit) { taken.add(hit.id); return hit; }
      return { ...c, unavailable: true, tooltip: c.why };
    });
    // Anything a pane offers that the catalogue doesn't list still shows.
    return out.concat(actions.filter((a) => !taken.has(a.id)));
  })() : actions;
  const shape = merged.map((a) => a.id).join('|');
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const mark = () => {
      root.querySelectorAll('.drb-actions').forEach((list) => {
        const tiles = Array.from(list.querySelectorAll('.drb-action'));
        tiles.forEach((el, i) => {
          const next = tiles[i + 1];
          el.classList.toggle('is-rowend', !next || next.offsetTop > el.offsetTop + 1);
        });
      });
    };
    mark();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(mark);
    ro.observe(root);
    return () => ro.disconnect();
  }, [shape]);
  if (!actions.length) return null;      // a file with no quick actions gets no card
  const blocks = [];
  for (const a of merged) {
    const title = a.group || '';
    const last = blocks[blocks.length - 1];
    if (last && last.title === title) last.items.push(a); else blocks.push({ title, items: [a] });
  }
  return (
    <section
      ref={rootRef}
      className={`drb-quick${disabled ? ' is-disabled' : ''}`}
      inert={disabled || undefined}
      aria-label="Quick actions"
    >
      {/* Actions may name a `group`: consecutive ones that share it form a block
          with a title of its own (a PDF's "Convert"); the rest stay under the
          card's. Blocks stand SIDE BY SIDE, a hairline between them, each as wide
          as the actions it holds. */}
      <div className="drb-quick-row">
        {blocks.map((block, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div className="drb-quick-block" key={i} style={{ flexGrow: block.items.length }}>
            <h3 className="drb-quick-title">{block.title || 'Quick actions'}</h3>
            {/* Every block is a GRID that wraps — one line each was fine when a
                pane offered two or three actions, but the card now shows the
                whole catalogue and a single row would squeeze them to nothing.
                A block's width is its share of the row (`flexGrow` above), and
                the grid fills it with as many columns as fit. */}
            <div className="drb-actions">
              {block.items.map((a) => (
                <Tooltip key={a.id} content={a.tooltip || a.label}>
                  <button
                    type="button"
                    className={`drb-action${a.pressed ? ' is-pressed' : ''}${a.unavailable ? ' is-unavailable' : ''}`}
                    onClick={a.unavailable ? undefined : a.onClick}
                    // `aria-disabled`, not `disabled`: a disabled button fires no
                    // mouse events, and its tooltip is the only thing that says
                    // WHY it can't be used here.
                    aria-disabled={a.unavailable || undefined}
                    aria-pressed={typeof a.pressed === 'boolean' && !a.unavailable ? a.pressed : undefined}
                  >
                    <span className="drb-action-icon">{a.icon}</span>
                    <span className="drb-action-label">{a.label}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
