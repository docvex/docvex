import { createContext, useContext, useEffect, useRef } from 'react';
import Tooltip from './Tooltip';
import { toLayoutPx } from '../lib/appZoom';
import './DocRibbon.css';
import { perfAllows } from '../lib/perf';
import { subscribePointer } from '../lib/pointer';

// The Word document's tools, as they appear in the Doc Viewer's SIDE PANEL (the
// one with Advisor and Metadata). They used to be a Word-style ribbon floating
// across the top of the preview; the ribbon is gone and its contents moved in:
//
//  • DocQuickActions — the section under the panel's tab strip: whole-document
//    actions (Counters, Open in Word) as a grid of tiles.
//
// (The Theme and Add tabs were removed on 2026-10-02.) Driven by props — the
// Word preview pane owns the state and publishes it to the panel through the
// advisor context (`docTools`).

// The sidebar tabs' cursor-tracked wash: every `selector` button under the node
// gets its own --item-spot-x/y (layout px) as the pointer moves over the node.
// Driven by the app's one pointer (lib/pointer): the node is judged by the DOM
// element under the pointer, so it follows the DOM rather than the React tree
// (the tooltips portal elsewhere), and every button's rect is read in the
// frame's read pass, before any frame's writes.
// Flash a quick-action tile — the answer to a command run by gesture rather
// than by pressing it. The tile is found in the DOM rather than driven through
// React state: the actions are memoised in the pane that owns them, and
// re-building that list to carry a transient flag would re-render the document
// pane on every flash.
export function flashQuickAction(id) {
  if (typeof document === 'undefined') return;
  const btn = document.querySelector(`.drb-action[data-action-id="${id}"]`);
  if (!btn) return;
  btn.classList.remove('is-flash');
  // Reading offsetWidth commits the removal, so a second flash inside the
  // animation's own length restarts it instead of being swallowed.
  void btn.offsetWidth;
  btn.classList.add('is-flash');
  window.setTimeout(() => btn.classList.remove('is-flash'), 640);
}

export function useItemSpots(selector, live = true) {
  const ref = useRef(null);
  useEffect(() => subscribePointer({
    read(p) {
      if (!p.moved) return null;
      const node = ref.current;
      if (!node || !p.target || !node.contains(p.target)) return null;
      if (!perfAllows('spotlight')) return null; // graphics preset (lib/perf)
      const btns = [...node.querySelectorAll(selector)];
      return { btns, rects: btns.map((b) => b.getBoundingClientRect()) };
    },
    write(p, got) {
      if (!got) return;
      got.btns.forEach((btn, i) => {
        btn.style.setProperty('--item-spot-x', `${toLayoutPx(p.x - got.rects[i].left)}px`);
        btn.style.setProperty('--item-spot-y', `${toLayoutPx(p.y - got.rects[i].top)}px`);
      });
    },
  }), [selector, live]);
  return ref;
}

// The section under the panel's tabs. `actions`: [{ id, label, tooltip?, icon,
// onClick, pressed? }] — `pressed` (a boolean) makes the tile a toggle.
// `disabled`: a paragraph is open, and none of these is about the paragraph.
// Quick actions that belong to the VIEWER, not to a file (the files strip's
// toggle): provided once at the viewer's root and added to whatever card a
// pane draws, so they are on the card for every kind of file.
export const QuickExtrasContext = createContext([]);

export function DocQuickActions({ actions: own = [], disabled = false, catalogue = [], always = false }) {
  const extras = useContext(QuickExtrasContext);
  const actions = extras.length ? own.concat(extras.filter((x) => !own.some((a) => a.id === x.id))) : own;
  // No pointer-following light here (2026-10-03): the card sits on a 32px
  // backdrop blur, and redrawing a tile per mouse move (plus writing the
  // light's position onto EVERY tile) re-blurred the document behind it on
  // every frame — hovering the tiles lagged badly. The hover is a flat wash.
  const rootRef = useRef(null);
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
        // The grid WRAPS, so which tile ends a row and which sits on the last
        // row are facts about the layout, not the list — CSS cannot ask either.
        // A divider is drawn on the sides that have a neighbour: none hangs off
        // the card's edge, and none is drawn under the bottom row.
        const last = tiles.length ? Math.max(...tiles.map((el) => el.offsetTop)) : 0;
        tiles.forEach((el, i) => {
          const next = tiles[i + 1];
          el.classList.toggle('is-rowend', !next || next.offsetTop > el.offsetTop + 1);
          el.classList.toggle('is-lastrow', el.offsetTop >= last - 1);
        });
      });
    };
    mark();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(mark);
    ro.observe(root);
    return () => ro.disconnect();
  }, [shape]);
  // A pane with no actions renders nothing — unless the viewer asks for the
  // catalogue anyway (`always`: the card is drawn for every kind of file).
  if (!actions.length && !(always && merged.length)) return null;
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
                    // Lets an action fired from ELSEWHERE — double-clicking the
                    // document to fit it — find its own tile and flash it, so
                    // the gesture says which command it just ran.
                    data-action-id={a.id}
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
