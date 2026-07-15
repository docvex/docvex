import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import './SnipCountdown.css';

// Delayed-capture countdown badge (?snipCountdown=1&n=<seconds>) — a small
// TRANSPARENT, click-through, non-focusable window main.js centres on every
// display about to be frozen. It only animates the numbers; the actual timing
// lives in main.js (snip:new's delay timer), which destroys this window right
// before the screenshot so the badge never captures itself.

export default function SnipCountdown() {
  const [params] = useSearchParams();
  const total = Math.max(1, Math.min(10, parseInt(params.get('n') || '3', 10) || 3));
  const [left, setLeft] = useState(total);

  useEffect(() => {
    const iv = setInterval(() => setLeft((v) => Math.max(1, v - 1)), 1000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="sc-root">
      <div className="sc-badge">
        {/* key remount restarts the pop animation on every tick */}
        <span key={left} className="sc-num">{left}</span>
        <span className="sc-label">Capturing…</span>
      </div>
    </div>
  );
}
