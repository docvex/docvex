import React, { useEffect, useState } from 'react';
import '../pages/Legislation.css';

// A spinner with a line of text, shown only once something has taken longer
// than `delay` (a quick answer shows no spinner at all). Moved here from the
// deleted pages/Legislation (its `.lg-loading` / `.lg-spinner` styles are still
// in pages/Legislation.css).
export function LoadingNote({ children, delay = 180, className = '' }) {
  const [on, setOn] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) return undefined;
    const id = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(id);
  }, [delay]);
  if (!on) return null;
  return (
    <p className={`lg-loading${className ? ` ${className}` : ''}`} role="status">
      <span className="lg-spinner" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export default LoadingNote;
