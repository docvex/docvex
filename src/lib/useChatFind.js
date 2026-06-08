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
  }, [containerRef, query, scope, clearHighlights]);

  // A fresh query resets the active match to the first hit.
  useEffect(() => { setIndex(0); navigatedRef.current = false; }, [query]);

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
  }, [total, index, HL, HL_ACTIVE, clearHighlights]);

  // Drop the global highlights when this thread unmounts.
  useEffect(() => clearHighlights, [clearHighlights]);

  const scrollToIndex = useCallback((i) => {
    const r = rangesRef.current[i];
    const el = r?.startContainer?.parentElement;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
