import React, { useEffect, useState } from 'react';
import Tooltip from './Tooltip';
import './FpsMeter.css';

// Lightweight FPS indicator pinned to the top-centre of the window — a quick
// read on render performance. Counts requestAnimationFrame ticks over a
// rolling ~500ms window. Colour-coded: green ≥50, amber ≥30, red below.
export default function FpsMeter() {
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (now) => {
      frames += 1;
      const elapsed = now - last;
      if (elapsed >= 500) {
        setFps(Math.round((frames * 1000) / elapsed));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const tier = fps >= 50 ? 'good' : fps >= 30 ? 'ok' : 'bad';
  return (
    <Tooltip content="Frames per second">
      <div className={`fps-meter is-${tier}`} aria-hidden="true">
        {fps} FPS
      </div>
    </Tooltip>
  );
}
