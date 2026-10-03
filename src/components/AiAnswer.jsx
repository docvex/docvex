import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SAFE_MD, SafeLink } from '../lib/safeMarkdown';
import { CiteLink, sourceIndex } from './WebSources';

// AN AI ANSWER — the one reply body both AIs draw (Research and the Doc
// Viewer advisor): Markdown, the answer's web citations, and the typewriter.
// (The legislation marks drawn over answers were removed on 2026-10-03.)
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
const REVEAL = new Map(); // revealKey → the text shown so far

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
export default function AiAnswer({ text = '', typing = false, streaming = false, revealKey, onTyped, onTick, className = '', sources = null }) {
  // Resuming: a stream under this key left the answer part-way typed.
  const kept = revealKey ? REVEAL.get(revealKey) : null;
  const resuming = kept != null && text.startsWith(kept) && kept.length < text.length;
  const on = streaming || typing || resuming;
  const n = useReveal(text, { on, streaming, revealKey, onTick, onDone: onTyped });
  const shown = on ? text.slice(0, n) : text;

  // The Markdown is parsed only when the SHOWN
  // text changes. It used to be re-parsed on every render of the thread — a
  // keystroke in the composer re-parsed every past answer. Reusing the same
  // element makes React skip ReactMarkdown.
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
  const md = useMemo(
    () => <ReactMarkdown {...SAFE_MD} components={cites || SAFE_MD.components} remarkPlugins={REMARK}>{shown}</ReactMarkdown>,
    [shown, cites],
  );
  return (
    <div className={`aichat-md${on ? ' aichat-typing' : ''}${className ? ` ${className}` : ''}`}>
      {md}
      {on ? <span className="aichat-caret" aria-hidden="true" /> : null}
    </div>
  );
}
