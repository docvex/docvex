import { useEffect, useRef } from 'react';

// ONE OPEN AT A TIME — the app's dropdowns and calendar pickers (LegalBar's
// BarPicker, BarCalendar's date fields, the Design system's samples) share
// this: when one opens it says so, and every other one that is open closes.
// Two lists hanging open at once only ever cover each other.
//
//   useOneOpen(open, () => setOpen(false), [fieldRef, listRef]);
//
// With `refs` (the field and what it opens), a press OUTSIDE all of them
// closes it too.

const EVENT = 'docvex:one-open';

export function useOneOpen(open, close, refs = null) {
  const id = useRef(null);
  if (!id.current) id.current = Symbol('dropdown');
  const openRef = useRef(open);
  openRef.current = open;
  const closeRef = useRef(close);
  closeRef.current = close;

  // Opening: tell the others.
  useEffect(() => {
    if (open) window.dispatchEvent(new CustomEvent(EVENT, { detail: id.current }));
  }, [open]);

  // Another one opening: close this one.
  useEffect(() => {
    const on = (e) => { if (e.detail !== id.current && openRef.current) closeRef.current?.(); };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  // A press outside the field and what it opened: close.
  const refsRef = useRef(refs);
  refsRef.current = refs;
  useEffect(() => {
    if (!open || !refsRef.current) return undefined;
    const away = (e) => {
      const inside = (refsRef.current || []).some((r) => r?.current?.contains(e.target));
      if (!inside) closeRef.current?.();
    };
    window.addEventListener('mousedown', away, true);
    return () => window.removeEventListener('mousedown', away, true);
  }, [open]);
}
