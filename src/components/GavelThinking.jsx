import React, { useEffect, useState } from 'react';
import gavelLoader from '../gavel-loader.svg';
import './GavelThinking.css';

// Shared "AI is working" indicator — the gavel SVG loader used by the AI
// surfaces (the DocViewer advisor). Optionally cycles through a set of status
// labels.
export default function GavelThinking({ labels, label = 'Thinking', className = '' }) {
  const set = Array.isArray(labels) && labels.length ? labels : [label];
  const [i, setI] = useState(0);
  useEffect(() => {
    if (set.length < 2) return undefined;
    setI(0);
    const id = window.setInterval(() => setI((n) => (n + 1) % set.length), 2000);
    return () => window.clearInterval(id);
  }, [set.length]);
  return (
    <span className={`gv-thinking ${className}`.trim()} role="status" aria-label="AI is working">
      <img className="gv-thinking-gavel" src={gavelLoader} alt="" aria-hidden="true" />
      <span className="gv-thinking-text" key={i}>{set[i]}</span>
      <span className="gv-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
    </span>
  );
}
