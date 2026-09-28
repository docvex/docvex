import React, { useLayoutEffect, useRef } from 'react';
import './AiChoices.css';

// THE PILL RULE (Design system → Pills): a pill on ONE line has fully rounded
// ends; a pill that wraps to TWO LINES OR MORE takes HALF that corner radius
// (a quarter of the one-line pill's height) — a fully rounded tall pill reads
// as a blob. Measured, not guessed (the wrap depends on the width): every
// `.ai-choice` inside `ref` gets `.is-multiline` while it is taller than one
// line, re-measured whenever it resizes. Each pill keeps its OWN height.
export function useMultilinePills(ref, deps = []) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    const pills = [...box.querySelectorAll('.ai-choice')];
    const judge = () => {
      for (const el of pills) {
        const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
        const pad = el.offsetHeight - el.clientHeight + (parseFloat(getComputedStyle(el).paddingTop) || 0) + (parseFloat(getComputedStyle(el).paddingBottom) || 0);
        el.classList.toggle('is-multiline', el.offsetHeight - pad > line * 1.5);
      }
    };
    judge();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(judge) : null;
    pills.forEach((el) => ro?.observe(el));
    return () => ro?.disconnect();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

// The clickable answers under an AI reply (lib/aiChoices): one pill per
// option; pressing it sends it as the reply. Only the latest reply shows them.
export default function AiChoices({ choices, onPick, disabled = false, className = '', label = 'Suggested answers' }) {
  const ref = useRef(null);
  useMultilinePills(ref, [choices]);
  if (!choices?.length) return null;
  return (
    <div ref={ref} className={`ai-choices${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {choices.map((c, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <button key={i} type="button" className="ai-choice" disabled={disabled} onClick={() => onPick?.(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}
