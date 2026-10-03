import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SAFE_MD, SafeLink } from '../lib/safeMarkdown';
import { CiteLink, sourceIndex } from './WebSources';
import { findFollowableRefs, caenContextOf, findLawRefs, dropOverlaps } from '../lib/lawRefs';
import { useMorphPill } from './useMorphPill';
import { refHitPill } from './RefHitPill';
import './AiAnswer.css';

// AN AI ANSWER, with ROMANIAN LEGISLATION MARKED — the one reply body both AIs
// draw (Research and the Doc Viewer advisor; lib/aiEngine's `legalHighlight`
// capability). Every act, code, CAEN code, court file and CUI is wrapped in
// its PLATFORM's colour (`.ai-lref`, the Legislation tab's reference look) and
// is a control: `onRef(hit)` says what was pressed (the surface decides where
// it opens). The marks are made IN THE RENDER (a rehype pass over the
// Markdown's tree), so they appear WHILE THE ANSWER TYPES, not only after.
// Code blocks and links are left alone.
//
// THE TYPEWRITER (2026-09-28): one reveal for every way an answer arrives —
// `streaming` (the text still growing: the reveal chases it at an even pace
// instead of jumping by the network's chunks), `typing` (a whole answer
// replayed), and `revealKey`: the stream's bubble and the message that
// replaces it once complete share a key, so the typing CONTINUES where the
// stream's reveal was instead of jumping to the end or starting again.
// Pace: ≥90 characters a second, faster the further behind (a backlog is
// eaten ~1.5× a second), so a long answer never crawls. Reduced motion: none.
const REMARK = [remarkGfm];
const SKIP = new Set(['code', 'pre', 'a', 'button']);
const REVEAL = new Map(); // revealKey → the text shown so far

// Every mark carries `data-ref-hit` — an id for its hit, so ONE hover pill
// per page (AiRefPill) can say what it is. Keyed by what the hit IS (kind +
// the words), so re-rendering while typing reuses ids; bounded.
const HIT_BY_ID = new Map();
function hitId(h) {
  const id = `${h.kind}|${h.raw || ''}|${h.cui || ''}|${(h.codes || []).join(',')}`;
  if (!HIT_BY_ID.has(id)) {
    HIT_BY_ID.set(id, h);
    if (HIT_BY_ID.size > 600) HIT_BY_ID.delete(HIT_BY_ID.keys().next().value);
  }
  return id;
}

function refsIn(text, ctx) {
  const all = findFollowableRefs(text);
  // A CAEN list line ("6210 - Activități…") needs the whole answer's context.
  const caen = ctx.on ? findLawRefs(text, { caenContext: ctx }).filter((h) => h.kind === 'caen') : [];
  return caen.length ? dropOverlaps([...all, ...caen]) : all;
}

// The rehype pass: split every text node (outside code / links) around the
// references it holds; each becomes a span carrying its index into `hits`.
function rehypeLegalRefs({ ctx, hits }) {
  const walk = (node) => {
    if (!node.children) return;
    if (node.type === 'element' && SKIP.has(node.tagName)) return;
    const out = [];
    for (const child of node.children) {
      if (child.type !== 'text' || !child.value || child.value.length <= 3) {
        walk(child);
        out.push(child);
        continue;
      }
      const text = child.value;
      let found = [];
      try { found = refsIn(text, ctx); } catch { found = []; }
      if (!found.length) { out.push(child); continue; }
      let at = 0;
      for (const h of found) {
        if (h.start < at) continue;
        if (h.start > at) out.push({ type: 'text', value: text.slice(at, h.start) });
        out.push({
          type: 'element',
          tagName: 'span',
          properties: { className: ['ai-lref', `is-${h.kind}`], role: 'button', tabIndex: 0, dataRef: String(hits.length), dataRefHit: hitId(h) },
          children: [{ type: 'text', value: text.slice(h.start, h.end) }],
        });
        hits.push(h);
        at = h.end;
      }
      if (at < text.length) out.push({ type: 'text', value: text.slice(at) });
    }
    node.children = out;
  };
  return (tree) => { walk(tree); };
}

const reducedMotion = () => {
  try {
    return document.documentElement.getAttribute('data-reduce-motion') === 'true'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
};

// How much of `text` is shown. `on` = revealing; returns the count.
function useReveal(text, { on, streaming, revealKey, onTick, onDone }) {
  const resumeAt = () => {
    const s = revealKey ? REVEAL.get(revealKey) : null;
    return s != null && text.startsWith(s) ? s.length : 0;
  };
  const [n, setN] = useState(() => (on ? resumeAt() : text.length));
  const nRef = useRef(n);
  const live = useRef({});
  live.current = { text, streaming, revealKey, onTick, onDone };
  const wasOn = useRef(on);
  useLayoutEffect(() => {
    if (on && !wasOn.current) { const s = resumeAt(); nRef.current = s; setN(s); }
    wasOn.current = on;
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on) return undefined;
    const finish = () => {
      const { revealKey: key, onDone: done } = live.current;
      if (key) REVEAL.delete(key);
      done?.();
    };
    if (reducedMotion()) {
      nRef.current = live.current.text.length;
      setN(nRef.current);
      if (!live.current.streaming) finish();
      return undefined;
    }
    let raf = 0;
    let last = 0;
    let pos = nRef.current;
    const step = (ts) => {
      const dt = last ? Math.min(ts - last, 100) / 1000 : 0;
      last = ts;
      const { text: all, streaming: still, revealKey: key, onTick: tick } = live.current;
      const total = all.length;
      if (pos < total) {
        pos = Math.min(total, pos + Math.max(90, (total - pos) * 1.5) * dt);
        const k = Math.floor(pos);
        if (k !== nRef.current) {
          nRef.current = k;
          setN(k);
          if (key) REVEAL.set(key, all.slice(0, k));
          tick?.();
        }
      }
      if (!still && nRef.current >= total) { finish(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  return on ? Math.min(n, text.length) : text.length;
}

// `sources` — the answer's web sources (project-ai web search): its [n](url)
// links to one of them are drawn as citation chips that open at once; every
// other link still asks first (lib/safeMarkdown).
export default function AiAnswer({ text = '', typing = false, streaming = false, revealKey, onTyped, onTick, onRef, highlight = true, className = '', sources = null }) {
  const hitsRef = useRef([]);
  // Resuming: a stream under this key left the answer part-way typed.
  const kept = revealKey ? REVEAL.get(revealKey) : null;
  const resuming = kept != null && text.startsWith(kept) && kept.length < text.length;
  const on = streaming || typing || resuming;
  const n = useReveal(text, { on, streaming, revealKey, onTick, onDone: onTyped });
  const shown = on ? text.slice(0, n) : text;

  // The Markdown is parsed (and the legislation marked) only when the SHOWN
  // text changes. It used to be re-parsed on every render of the thread — a
  // keystroke in the composer re-parsed every past answer. Reusing the same
  // element makes React skip ReactMarkdown, and the rehype pass's `hits` stay
  // the ones it filled.
  // The answer's own citation links: [n] pointing at one of its sources.
  const cites = useMemo(() => {
    const byUrl = sourceIndex(sources);
    if (!byUrl.size) return null;
    const A = ({ href, children }) => {
      const s = byUrl.get(String(href || ''));
      const label = React.Children.toArray(children).join('');
      return s && /^\d+$/.test(label) ? <CiteLink source={s}>{label}</CiteLink> : <SafeLink href={href}>{children}</SafeLink>;
    };
    return { ...SAFE_MD.components, a: A };
  }, [sources]);
  const md = useMemo(() => {
    const hits = [];
    const rehype = highlight ? [[rehypeLegalRefs, { ctx: caenContextOf(shown), hits }]] : [];
    return { hits, el: <ReactMarkdown {...SAFE_MD} components={cites || SAFE_MD.components} remarkPlugins={REMARK} rehypePlugins={rehype}>{shown}</ReactMarkdown> };
  }, [shown, highlight, cites]);
  hitsRef.current = md.hits;

  const fire = (e) => {
    const el = e.target.closest?.('.ai-lref');
    if (!el || !e.currentTarget.contains(el)) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    const sel = window.getSelection?.();
    if (e.type === 'click' && sel && !sel.isCollapsed) return; // ending a text selection
    const hit = hitsRef.current[Number(el.dataset.ref)];
    if (!hit) return;
    e.preventDefault();
    onRef?.(hit);
  };
  return (
    // The keys and clicks belong to the marks inside (role=button, tabIndex 0).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className={`aichat-md${on ? ' aichat-typing' : ''}${className ? ` ${className}` : ''}`} onClick={fire} onKeyDown={fire}>
      {md.el}
      {on ? <span className="aichat-caret" aria-hidden="true" /> : null}
    </div>
  );
}

// THE HOVER PILL over an answer's legislation (2026-09-28): hovering a mark
// inside `hostRef` shows the highlight pill the Legislation tab and the Doc
// Viewer show (components/RefHitPill — the platform in its colour, what is
// cited, the act's title / CAEN name, what a click does). A click is the
// answer's own (AiAnswer's `onRef` — Research opens its side drawer); the
// pill just steps aside. One per page, native listeners delegated on the host.
export function AiRefPill({ hostRef }) {
  const [hover, setHover] = useState(null);
  const [, setTick] = useState(0);
  const morph = useMorphPill({
    hoverContent: hover ? refHitPill(hover, { onLoaded: () => setTick((k) => k + 1) }) : '',
    menuItems: [],
  });
  const morphRef = useRef(morph);
  morphRef.current = morph;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let on = null;
    const markOf = (e) => e.target?.closest?.('.ai-lref[data-ref-hit]') || null;
    const onMove = (e) => {
      const m = morphRef.current;
      const mark = markOf(e);
      if (!mark) { if (on) { on = null; m.handleMouseLeave(); } return; }
      if (mark !== on) { on = mark; setHover(HIT_BY_ID.get(mark.dataset.refHit) || null); }
      m.handleMouseMove(e);
    };
    const hide = () => { if (on) { on = null; morphRef.current.handleMouseLeave(); } };
    const onDown = (e) => { if (markOf(e)) hide(); };
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', hide);
    host.addEventListener('mousedown', onDown, true);
    return () => {
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('mouseleave', hide);
      host.removeEventListener('mousedown', onDown, true);
    };
  }, [hostRef]);
  return morph.node;
}
