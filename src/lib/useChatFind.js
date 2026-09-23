import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
// Co-located styling for the ::highlight() pseudos + the count chip.
import './useChatFind.css';

// VS-Code-style "find in conversation" for a scrollable message thread.
//
// Highlights EVERY occurrence of `query` across the rendered message text,
// reports how many were found + which one is active, and scrolls the active
// match into view on goNext()/goPrev() (wired to Enter / Shift+Enter).
//
// Implementation uses the CSS Custom Highlight API (`CSS.highlights` +
// `Highlight` + `Range`) so we never mutate the React-rendered DOM — critical
// because message bodies are produced by ReactMarkdown / realtime renders that
// React owns. We just point Ranges at existing text nodes and style them via
// `::highlight(<name>)`. A MutationObserver rebuilds the ranges whenever the
// thread changes (new messages, typewriter reveal, edits) while a query is live.
//
// `name` must be unique per mounted thread so two threads (e.g. a split view
// with both chats) don't fight over the same global highlight registry. The
// matching `::highlight()` rules live in useChatFind.css.
//
// `scope` is a CSS selector for the message-body elements within the container
// (e.g. `.vb-msg-text`); only text inside those is searched, so surrounding
// chrome — timestamps, author names, day dividers, action buttons — is never
// matched. Omit it to search the whole container.
const SUPPORTED = typeof CSS !== 'undefined'
  && !!CSS.highlights
  && typeof Highlight !== 'undefined'
  && typeof Range !== 'undefined';

export function useChatFind({ containerRef, query, name, scope }) {
  const HL = `${name}-find`;
  const HL_ACTIVE = `${name}-find-active`;

  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(0);
  // Bumped on every rebuild so the paint effect repaints even when the match
  // COUNT is unchanged — otherwise a mutation that rebuilds the Range objects
  // but keeps `total` the same leaves CSS.highlights pointing at the old
  // (now-corrupted) ranges.
  const [rebuildTick, setRebuildTick] = useState(0);
  const rangesRef = useRef([]);
  // Whether the user has navigated yet for the current query — so the first
  // Enter jumps to the first match (index 0) instead of skipping to the second.
  const navigatedRef = useRef(false);

  const clearHighlights = useCallback(() => {
    if (!SUPPORTED) return;
    CSS.highlights.delete(HL);
    CSS.highlights.delete(HL_ACTIVE);
  }, [HL, HL_ACTIVE]);

  // Re-scan the container for matches and rebuild the Range list.
  const rebuild = useCallback(() => {
    if (!SUPPORTED) return;
    const root = containerRef.current;
    const q = (query || '').trim().toLowerCase();
    if (!root || !q) { rangesRef.current = []; setTotal(0); clearHighlights(); return; }
    const ranges = [];
    // Search only within the message-body elements (when `scope` is given) so
    // surrounding chrome — names, timestamps, day dividers, buttons — is skipped.
    const roots = scope ? Array.from(root.querySelectorAll(scope)) : [root];
    for (const sub of roots) {
      const walker = document.createTreeWalker(sub, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.nodeValue && node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let node = walker.nextNode();
      while (node) {
        const hay = node.nodeValue.toLowerCase();
        let from = 0;
        let at = hay.indexOf(q, from);
        while (at !== -1) {
          const range = new Range();
          range.setStart(node, at);
          range.setEnd(node, at + q.length);
          ranges.push(range);
          from = at + q.length;
          at = hay.indexOf(q, from);
        }
        node = walker.nextNode();
      }
    }
    rangesRef.current = ranges;
    setTotal(ranges.length);
    setIndex((prev) => (ranges.length ? Math.min(prev, ranges.length - 1) : 0));
    setRebuildTick((t) => t + 1);
  }, [containerRef, query, scope, clearHighlights]);

  // A fresh query resets the active match to the first hit.
  useEffect(() => { setIndex(0); navigatedRef.current = false; }, [query]);

  // …and brings it into view without waiting for Enter: typing is a search,
  // and a search that highlights something off-screen looks like no match.
  useEffect(() => {
    if (!query || !total) return undefined;
    const id = requestAnimationFrame(() => scrollToIndex(Math.min(index, total - 1)));
    return () => cancelAnimationFrame(id);
    // Deliberately not keyed on `index`: walking matches scrolls itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, total, rebuildTick]);

  // Build on query change AND keep rebuilding while the thread mutates under an
  // active query (typewriter, new messages, edits). Observer only runs while a
  // query is present so idle threads pay nothing.
  useEffect(() => {
    if (!SUPPORTED) return undefined;
    rebuild();
    const root = containerRef.current;
    const q = (query || '').trim();
    if (!root || !q) return undefined;
    let raf = 0;
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(rebuild);
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { obs.disconnect(); cancelAnimationFrame(raf); };
  }, [containerRef, query, rebuild]);

  // Paint: all matches in the base highlight, the active one in its own so it
  // can read differently (VS Code's orange current-match).
  useLayoutEffect(() => {
    if (!SUPPORTED) return;
    const ranges = rangesRef.current;
    if (!ranges.length) { clearHighlights(); return; }
    const active = ranges[Math.min(index, ranges.length - 1)];
    const rest = ranges.filter((r) => r !== active);
    if (rest.length) CSS.highlights.set(HL, new Highlight(...rest)); else CSS.highlights.delete(HL);
    if (active) CSS.highlights.set(HL_ACTIVE, new Highlight(active)); else CSS.highlights.delete(HL_ACTIVE);
  }, [total, index, rebuildTick, HL, HL_ACTIVE, clearHighlights]);

  // Drop the global highlights when this thread unmounts.
  useEffect(() => clearHighlights, [clearHighlights]);

  // Bring a match into view. `scrollIntoView` on the match's element is not
  // enough in the Doc Viewer: a Word page is laid out inside a host the pane
  // SCALES (the zoom), and an element inside a scaled box reports a layout box
  // the browser scrolls to as if it were unscaled — the view lands short of
  // the match, or doesn't move at all. Measuring the RANGE's on-screen
  // rectangle and scrolling its own scroller by the difference is in screen
  // pixels throughout, so it is right at any zoom.
  const scrollToIndex = useCallback((i) => {
    const r = rangesRef.current[i];
    if (!r) return;
    let node = r.startContainer;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node) return;
    // EVERY scrollable ancestor, innermost first — a document pane scrolls its
    // pages, the page itself may scroll, and the tab scrolls under both. Each
    // is moved by the distance that is left after the one inside it moved, and
    // the match's rect is re-measured between steps, which is what makes this
    // right when a pane is ZOOMED (a scaled box's layout offsets are not screen
    // pixels; its rect always is).
    const centre = (el) => {
      const rect = r.getBoundingClientRect();
      if (!rect || (!rect.height && !rect.width)) return;
      const box = el === document.scrollingElement
        ? { top: 0, height: window.innerHeight }
        : el.getBoundingClientRect();
      const delta = (rect.top + rect.height / 2) - (box.top + box.height / 2);
      if (Math.abs(delta) < 2) return;
      const before = el.scrollTop;
      // Instant, not smooth: several scrollers move in one go here, and a
      // smooth scroll on the outer one would be measured mid-flight by the
      // next step. The eye follows the highlight, which is already painted.
      el.scrollTop = before + delta;
    };
    for (let el = node.parentElement; el; el = el.parentElement) {
      const st = getComputedStyle(el);
      if (/auto|scroll|overlay/.test(`${st.overflowY} ${st.overflow}`) && el.scrollHeight > el.clientHeight + 1) {
        centre(el);
      }
      if (el === document.body || el === document.documentElement) break;
    }
  }, []);

  const goNext = useCallback(() => {
    const n = rangesRef.current.length;
    if (!n) return;
    if (!navigatedRef.current) {
      navigatedRef.current = true;
      scrollToIndex(Math.min(index, n - 1));
      return;
    }
    setIndex((prev) => {
      const next = (prev + 1) % n;
      requestAnimationFrame(() => scrollToIndex(next));
      return next;
    });
  }, [index, scrollToIndex]);

  const goPrev = useCallback(() => {
    const n = rangesRef.current.length;
    if (!n) return;
    navigatedRef.current = true;
    setIndex((prev) => {
      const next = (prev - 1 + n) % n;
      requestAnimationFrame(() => scrollToIndex(next));
      return next;
    });
  }, [scrollToIndex]);

  return {
    supported: SUPPORTED,
    total,
    current: total ? Math.min(index, total - 1) + 1 : 0,
    goNext,
    goPrev,
  };
}
