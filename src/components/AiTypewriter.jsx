import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// THE TYPEWRITER — reveals an AI answer character by character, rendered
// through Markdown as it grows so formatting appears live, with a blinking
// caret at its end (`.aichat-typing` / `.aichat-caret`, pages/Projects/
// ProjectAIChat.css, under `.ai-chat-page`). ~90 characters a second, eased,
// never under 0.4 s nor over 6 s whatever the length. `onTick` fires every
// frame (keep the thread scrolled to the bottom), `onDone` once at the end.
// Shared by the Advisor (pages/Projects/ProjectAI) and Research.
const REMARK_PLUGINS = [remarkGfm];

export default function AiTypewriter({ text, onDone, onTick, className = '' }) {
  const [n, setN] = React.useState(0);
  const doneRef = React.useRef(onDone);
  const tickRef = React.useRef(onTick);
  doneRef.current = onDone;
  tickRef.current = onTick;
  React.useEffect(() => {
    const total = text.length;
    if (!total) { doneRef.current && doneRef.current(); return undefined; }
    let reduced = false;
    try {
      reduced = document.documentElement.getAttribute('data-reduce-motion') === 'true'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { /* no matchMedia */ }
    if (reduced) { setN(total); doneRef.current && doneRef.current(); return undefined; }
    let raf = 0;
    let start = 0;
    const dur = Math.min(Math.max(total / 90, 0.4), 6) * 1000; // ~90 chars/s, 0.4–6s
    const step = (ts) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 2);
      setN(Math.floor(eased * total));
      tickRef.current && tickRef.current();
      if (p < 1) { raf = requestAnimationFrame(step); }
      else { setN(total); doneRef.current && doneRef.current(); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  return (
    <div className={`aichat-md aichat-typing${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text.slice(0, n)}</ReactMarkdown>
      <span className="aichat-caret" aria-hidden="true" />
    </div>
  );
}
