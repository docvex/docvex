import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Tooltip from './Tooltip';
import './RuleOptions.css';

// The Playbook's Word settings control, made a component so other surfaces
// can use it (the Import window's route switch).
// `field` = { label, options: [{ id, label, example? }] } — `example` is the
// tooltip (the label otherwise).
// A rule's choices as ONE SEGMENTED CONTROL: a ground wrapping them all,
// faint dividers between neighbours, and the selection a pill that SLIDES
// to the choice picked (measured off the chosen button — the labels differ
// in width, and a long row wraps, so it moves in both directions).
export default function RuleOptions({ field, value, onPick, className = '' }) {
  const boxRef = useRef(null);
  const [pill, setPill] = useState(null);   // { x, y, w, h } in the box's px
  const [ready, setReady] = useState(false); // no slide on the first placing
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const place = () => {
      const on = box.querySelector('.pbk-rule-opt.is-on');
      if (!on) { setPill(null); return; }
      const next = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
      setPill((cur) => (cur && cur.x === next.x && cur.y === next.y && cur.w === next.w && cur.h === next.h ? cur : next));
    };
    place();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => ro.disconnect();
  }, [value]);
  useEffect(() => {
    if (!pill || ready) return undefined;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [pill, ready]);
  return (
    <div ref={boxRef} className={`pbk-rule-opts${ready ? ' is-ready' : ''}${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={field.label}>
      {pill ? (
        <span
          className="pbk-rule-pill"
          aria-hidden="true"
          style={{ width: pill.w, height: pill.h, transform: `translate(${pill.x}px, ${pill.y}px)` }}
        />
      ) : null}
      {field.options.map((o) => (
        <Tooltip content={o.example || o.label} key={o.id}>
          <button
            type="button"
            role="radio"
            aria-checked={value === o.id}
            // `empty`: a choice with nothing behind it — drawn faded, still pickable.
            className={`pbk-rule-opt${value === o.id ? ' is-on' : ''}${o.empty ? ' is-empty' : ''}`}
            // An EMPTY choice (nothing behind it) cannot be picked.
            aria-disabled={o.empty || undefined}
            onClick={() => { if (!o.empty) onPick(o.id); }}
          >
            {o.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
