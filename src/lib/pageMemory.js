// PAGE MEMORY — what a page had on it when it was left, so it is there
// again when it is come back to. The Legislation tabs are ROUTES, and a
// route change unmounts the page: the search typed, the results answered,
// the act being read and the scroll position were gone by the time the
// next tab was open. Each page snapshots the state that matters into this
// in-memory map on every change and reads it back as its initial state on
// mount; the scroll position is taken as the page leaves and put back once
// it has painted. In memory only — a restart starts clean (localStorage
// would keep an act's whole text and a results page around for ever).
//
//   const saved = recallPage('legislation');
//   const [query, setQuery] = useState(saved?.query ?? DEFAULT);
//   …
//   usePageMemory('legislation', { query, results, act }, pageRef);

import { useEffect, useLayoutEffect } from 'react';

const mem = new Map();

/** What the page remembered, or null the first time. */
export const recallPage = (key) => mem.get(key)?.state ?? null;

/** Forget one page (or every page with no key). */
export const forgetPage = (key) => { if (key) mem.delete(key); else mem.clear(); };

/**
 * Remembers `state` on every change, and the scroll position of the
 * scroller the page sits in (`rootRef` → the nearest `.sv-single-scroll` /
 * `.main-content`) as the page unmounts — restored on the next mount.
 */
export function usePageMemory(key, state, rootRef) {
  useEffect(() => {
    const cur = mem.get(key) || {};
    mem.set(key, { ...cur, state });
  }, [key, state]);
  useLayoutEffect(() => {
    const el = rootRef?.current?.closest?.('.sv-single-scroll, .main-content') || null;
    const top = mem.get(key)?.scroll || 0;
    let raf = 0;
    if (el && top) {
      // Two frames: the first paint lays the restored content out, the
      // second can scroll to a place that now exists.
      raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { el.scrollTop = top; }); });
    }
    return () => {
      cancelAnimationFrame(raf);
      if (el) { const cur = mem.get(key) || {}; mem.set(key, { ...cur, scroll: el.scrollTop }); }
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
