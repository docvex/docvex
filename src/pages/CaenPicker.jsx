import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useReducer, useRef } from 'react';
import './CaenPicker.css';
import Tooltip from '../components/Tooltip';
import {
  LEVEL_RO_PLURAL, pickerTree, stageOptions, previewChain, codeTail, makePickerReducer, initialPickerState, keyToAction,
} from '../lib/caenPicker';
import { sentenceCase } from '../lib/caen';

// CAEN search in the manner of the PS3 PlayStation Store's letter picker —
// in STAGES, down the nomenclature's own structure. On the left, the row of
// columns: the stages passed (faded, the entry chosen held in each box), the
// column of what this level holds with the highlighted entry in a box (it is
// the cursor), and the levels ahead previewed; to the right, the highlighted
// entry's card (`children`).
// ↑/↓ (or the wheel) move the cursor, → / Enter step into the entry (a class
// is picked instead), ←/⌫ step back a stage, Space picks. The other view of
// the CAEN page (pages/Caen.jsx switches between the two); the logic is
// lib/caenPicker.js.
//
// Its strings are Romanian without diacritics, as the original's are. Its
// colours are its own (a dark blue in both themes — see the CSS).

// One entry of the column, in px. CSS `--cp-ch` must agree.
const ROW_H = 36;
// A column is as tall as ALL its entries: the list stands still, whole and
// unfaded from its first entry to its last, and the BOX glides down it to
// the selection (a fixed box with the list sliding under it could only ever
// show a few entries above itself).
const colHeight = (count) => `${count * ROW_H}px`;
const boxAt = (sel) => ({ transform: `translateY(${Math.max(0, sel) * ROW_H}px)` });

// An entry's tooltip: its level and code on one line ("SECTION C", as the
// trail's pills say it), its name under them. The level is read off the
// code's shape: a letter is a section, then two, three, four digits.
const levelName = (code) => {
  const c = String(code || '');
  return /^[A-Z]$/i.test(c) ? 'Section' : c.length === 2 ? 'Division' : c.length === 3 ? 'Group' : 'Class';
};
const tip = (o) => (
  <>
    <span className="cp-tip-head">
      <span className="cp-tip-kind">{levelName(o.code)}</span>
      <span className="cp-tip-code">{o.code}</span>
    </span>
    <span className="cp-tip-name">{sentenceCase(o.name)}</span>
  </>
);
// The nomenclature's levels: section, division, group, class — the row's slots.
const LEVELS = 4;
// Wheel travel per entry, in px, for a TRACKPAD's small deltas; a mouse
// wheel's notch (one event at or past this) is one entry regardless.
const WHEEL_STEP = 40;
// The least time between two wheel steps, in ms — a notch split into
// several events by the mouse or its driver still moves one entry.
const WHEEL_GAP = 90;

/**
 * `data` is the loaded nomenclature; `onPick(code, description)` is the
 * caller's — what it does with the pick is its own. `onHighlight(code)` is
 * told every entry the cursor lands on, section to class, as it moves.
 * `children` is what the picker holds to the RIGHT of its columns — the CAEN
 * page puts the highlighted entry's card there, so the picker and the entry
 * are one section. The ref offers `goTo(code)` — the page's pills above the
 * section use it to take the picker to an ancestor.
 */
const CaenPicker = forwardRef(function CaenPicker({ data, onPick, onHighlight, children }, ref) {
  const tree = useMemo(() => pickerTree(data), [data]);
  const reducer = useMemo(() => makePickerReducer(tree), [tree]);
  const [state, dispatch] = useReducer(reducer, undefined, initialPickerState);
  useImperativeHandle(ref, () => ({ goTo: (code) => dispatch({ type: 'goto', code }) }), []);

  // A list taller than the window scrolls inside the columns area (the wheel
  // over it selects, so it cannot be scrolled by hand): the box is kept in
  // view by scrolling that area the least that shows it.
  useEffect(() => {
    const stage = rootRef.current?.querySelector('.cp-stage');
    if (!stage || stage.scrollHeight <= stage.clientHeight) return;
    const top = state.index * ROW_H;
    const bottom = top + ROW_H;
    if (top < stage.scrollTop) stage.scrollTo({ top: Math.max(0, top - ROW_H), behavior: 'smooth' });
    else if (bottom > stage.scrollTop + stage.clientHeight) stage.scrollTo({ top: bottom + ROW_H - stage.clientHeight, behavior: 'smooth' });
  }, [state.path, state.index]);
  const { path, index, focus } = state;
  const colRef = useRef(null);
  const rootRef = useRef(null);

  const options = stageOptions(tree, path);
  const idx = Math.min(index, Math.max(0, options.length - 1));
  const current = options[idx] || null;

  // Whoever is listening hears every entry the cursor lands on.
  const highlightRef = useRef(onHighlight);
  highlightRef.current = onHighlight;
  useEffect(() => { highlightRef.current?.(current?.code || ''); }, [current?.code]);

  // The levels still to come, PREVIEWED: a faded column for each, in the very
  // slot that stage will take, showing what the previous column's selection
  // contains — the entry under the cursor for the first, the first entry of
  // each preview for the next — so the row already shows the road ahead and
  // entering an entry moves nothing: the box steps into the first preview.
  // (`previewChain` centres each on the entry remembered from before a step
  // back, when there is one — so going back and forth loses nothing.)
  const previews = useMemo(() => previewChain(tree, state), [tree, state]);
  // A click on a preview's entry: down through the previews to it.
  const jumpPreview = (depth, i) => {
    for (let k = 0; k <= depth; k += 1) dispatch({ type: 'enter' });
    dispatch({ type: 'char', index: i });
  };

  // Keys the live column by the stage, so a new stage mounts afresh. (The
  // status line that said "loading" and counted the entries is gone — the
  // columns carry no text but the codes.)
  const stageKey = path.join('/');
  // The column has the keys (the model's `list` focus is not offered by
  // this view — see the note by the label below).
  useEffect(() => { colRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (focus === 'list') dispatch({ type: 'focus', focus: 'col' }); }, [focus]);

  // The wheel over the column moves the cursor — the entry scrolled into the
  // box is the one selected. A NATIVE listener: React's wheel handlers are
  // passive, and the page underneath must not scroll along. Wheel deltas
  // come in all sizes (a notch, a trackpad's stream), so they accumulate
  // and every WHEEL_STEP px is one entry.
  useEffect(() => {
    // Only with the pointer OVER A COLUMN: there the wheel moves the
    // selection and never scrolls the page (preventDefault, on a non-passive
    // listener); anywhere else in the picker — the card — it scrolls as usual.
    const el = rootRef.current;
    if (!el) return undefined;
    let acc = 0;
    let lastStep = 0;
    const onWheel = (e) => {
      const col = e.target.closest?.('.cp-col');
      if (!col || col.classList.contains('is-disabled')) return;
      e.preventDefault();
      // ONE ENTRY PER NOTCH. A mouse wheel's notch arrives as one event of
      // ~100px (Chromium; 3 lines in line mode) — that is one step, whatever
      // its size, or a notch would skip an entry. Only a trackpad's stream
      // of small deltas is accumulated up to a step.
      // …and a notch that some mice and drivers deliver as SEVERAL events
      // in quick succession is still one step: a step is taken at most
      // once per WHEEL_GAP ms.
      let steps = 0;
      const now = performance.now();
      const big = e.deltaMode !== 0 || Math.abs(e.deltaY) >= WHEEL_STEP;
      if (big) {
        if (now - lastStep < WHEEL_GAP) return;
        steps = Math.sign(e.deltaY); acc = 0;
      } else {
        acc += e.deltaY;
        if (Math.abs(acc) >= WHEEL_STEP && now - lastStep >= WHEEL_GAP) { steps = Math.sign(acc); acc = 0; }
      }
      if (!steps) return;
      lastStep = now;
      // Over a column that is not the live one, the first step only makes
      // it live — a passed stage is gone back to, a preview is stepped into
      // — and moves nothing; the next steps, on what is then the live
      // column, move its cursor.
      if (col.dataset.passed != null) { dispatch({ type: 'jump', depth: Number(col.dataset.passed) }); return; }
      if (col.dataset.preview != null) {
        for (let k = 0; k <= Number(col.dataset.preview); k += 1) dispatch({ type: 'enter' });
        return;
      }
      dispatch({ type: steps > 0 ? 'down' : 'up' });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const pick = (e) => { if (e && e.level === 'c') onPick(e.code, e.name); };
  const enterOrPick = (e) => { if (!e) return; if (e.level === 'c') pick(e); else dispatch({ type: 'char', index: options.indexOf(e) }); };

  const onKeyDown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === ' ') { e.preventDefault(); pick(current); return; }
    if (e.key === 'Enter' && current?.level === 'c') { e.preventDefault(); pick(current); return; }
    const action = keyToAction(e.key);
    if (!action) return;
    e.preventDefault();
    dispatch(action);
  };

  // The keys work from ANYWHERE on the page while the picker is open — the
  // view switch, the tab bar, the confirmation button — not only once the
  // column has been clicked. One window listener (the handler kept in a ref
  // so it sees the latest state); a field being typed in keeps its keys.
  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      keyRef.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const levelOf = options[0]?.level || 's';

  return (
    <div className="cp-root" ref={rootRef}>
      {/* The body: the row of columns fills it and centres in it; the status
          line is laid OVER its top, out of its flow, so the box stays at the
          section's vertical middle. (The entry under the cursor is named by
          the card this picker sits in — its header is right above.) */}
      <div className="cp-body">

      {/* The row: the live column and the previews of the levels ahead,
          centred in the height left under the trail. The stages passed are
          the trail's chips (and the highlighted entry's name is its live
          chip) — nothing else names them here. */}
      <div className="cp-stage">
        {/* The stages passed: each level's column stays, faded further than
            the previews, the entry chosen there held in its box — a click on
            another entry goes back to that stage and onto it. */}
        {path.map((code, d) => {
          const list = stageOptions(tree, path.slice(0, d));
          const sel = Math.max(0, list.findIndex((o) => o.code === code));
          return (
            <div key={`passed-${d}-${code}`} className="cp-col is-passed" data-passed={d} aria-hidden="true" style={{ height: colHeight(list.length) }}>
              <span className="cp-col-rails" aria-hidden="true" />
              <div className="cp-col-box" style={boxAt(sel)} />
              <div className="cp-strip">
                {list.map((o, i) => (
                  <Tooltip key={o.code} content={tip(o)} className="cp-tip">
                    <div
                      className={`cp-ch${i === sel ? ' is-on' : ''}`}
                      onClick={() => { dispatch({ type: 'jump', depth: d }); dispatch({ type: 'char', index: i }); }}
                    >
                      {codeTail(o)}
                    </div>
                  </Tooltip>
                ))}
              </div>
            </div>
          );
        })}

        {/* The column: this level's entries, all of them, still; the box
            glides to the highlighted one. */}
        <div
          className="cp-col is-focus"
          role="listbox"
          aria-label={LEVEL_RO_PLURAL[levelOf]}
          tabIndex={0}
          aria-activedescendant={current ? `cp-ch-${current.code}` : undefined}
          ref={colRef}
          style={{ height: colHeight(options.length) }}
        >
          <span className="cp-col-rails" aria-hidden="true" />
          <div className="cp-col-box" aria-hidden="true" style={boxAt(idx)} />
          {/* Keyed by the stage: a new stage mounts afresh (no animation —
              the box above stays where it is and the level appears under it). */}
          <div key={stageKey} className="cp-col-anim">
          <div className="cp-strip">
            {options.map((o, i) => (
              <Tooltip key={o.code} content={tip(o)} className="cp-tip">
                <div
                  id={`cp-ch-${o.code}`}
                  role="option"
                  aria-selected={i === idx}
                  aria-label={`${o.code} ${o.name}`}
                  className={`cp-ch${i === idx ? ' is-on' : ''}`}
                  onClick={() => (i === idx ? enterOrPick(o) : dispatch({ type: 'char', index: i }))}
                  onDoubleClick={() => enterOrPick(o)}
                >
                  {codeTail(o)}
                </div>
              </Tooltip>
            ))}
          </div>
          </div>
        </div>

        {/* The previews — the levels ahead, faded, each in its own slot. */}
        {previews.map(({ list, sel }, d) => (
          <div key={`${current?.code}/${d}`} className="cp-col is-preview" data-preview={d} aria-hidden="true" style={{ height: colHeight(list.length) }}>
            <span className="cp-col-rails" aria-hidden="true" />
            <div className="cp-col-box" style={boxAt(sel)} />
            <div className="cp-strip">
              {list.map((o, i) => (
                <Tooltip key={o.code} content={tip(o)} className="cp-tip">
                  <div
                    className="cp-ch"
                    onClick={() => jumpPreview(d, i)}
                  >
                    {codeTail(o)}
                  </div>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}

        {/* Levels that cannot be reached from here (the nomenclature runs
            out): their slots, disabled, so the row keeps its four. */}
        {Array.from({ length: Math.max(0, LEVELS - path.length - 1 - previews.length) }, (_, d) => (
          <div key={`off-${d}`} className="cp-col is-disabled" aria-hidden="true">
            <span className="cp-col-rails" aria-hidden="true" />
            <div className="cp-col-box" />
          </div>
        ))}
      </div>
      </div>

      {/* To the right of the columns: the entry's card. */}
      {children ? <div className="cp-side">{children}</div> : null}
    </div>
  );
});
export default CaenPicker;

/** The keys, as a row — the CAEN page puts it in a bottom bar (the Files
 *  tab's). In English, like the page chrome around it. `atClass`: the
 *  cursor is on a class, so → / Enter do nothing there. */
export function CaenPickerHints({ atClass }) {
  return (
    <div className="cn-hints" aria-hidden="true">
      <span><kbd>↑</kbd><kbd>↓</kbd> Select</span>
      <span className="cn-hints-sep" />
      <span className={atClass ? 'is-off' : ''}><kbd>→</kbd><kbd>Enter</kbd> Forward</span>
      <span className="cn-hints-sep" />
      <span><kbd>←</kbd><kbd>Backspace</kbd> Back</span>
      <span className="cn-hints-sep" />
      <span><kbd>0-9</kbd> Type a code to select it</span>
    </div>
  );
}
