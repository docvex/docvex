import React, { useEffect, useMemo, useRef, useState } from 'react';
import './CourtMap.css';
import MAP from '../lib/roCountiesMap.json';
import { CIRCUMSCRIPTIONS, circumscriptionOf, circumscriptionCourts, countyName, nationalCourts } from '../lib/courtMap';

// THE COURTS ON A MAP — portal.just.ro's own map of the counties, in the
// Court files tab. Romania's counties (lib/roCountiesMap.json, Natural Earth,
// built by scripts/build-ro-map.mjs) shaded by the court of appeal they answer
// to, each with its plate. Pressing a county brings its court of appeal's
// CIRCUMSCRIPTION forward — the map glides in on those counties, the rest
// fading out — and lists, beside it, every court there county by county, the
// pressed county first (as the portal's dropdown does). Pressing a court hands
// it to the page (`onPick(court)`); Close, Escape or a press on the empty sea
// goes back to the whole country.

// A shade per circumscription, chosen so no two neighbours share one (the
// portal's alternating blues, in the app's accent).
const SHADE = {
  'Alba Iulia': 0, 'Bacău': 2, 'Brașov': 1, 'București': 2, 'Cluj': 2, 'Constanța': 1, 'Craiova': 1,
  'Galați': 3, 'Iași': 1, 'Oradea': 1, 'Pitești': 3, 'Ploiești': 0, 'Suceava': 0, 'Târgu Mureș': 3, 'Timișoara': 2,
};

// Each county's bounding box, read once off its path.
const BOXES = new Map(MAP.counties.map((c) => {
  const nums = c.d.match(/-?\d+(\.\d+)?/g).map(Number);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i < nums.length; i += 2) {
    x0 = Math.min(x0, nums[i]); x1 = Math.max(x1, nums[i]);
    y0 = Math.min(y0, nums[i + 1]); y1 = Math.max(y1, nums[i + 1]);
  }
  return [c.code, { x0, y0, x1, y1 }];
}));
const WHOLE = [-8, -8, MAP.w + 16, MAP.h + 16];

// The view that frames a set of counties, with a margin, keeping the map's
// proportions (so nothing is stretched).
function frame(codes) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const k of codes) {
    const b = BOXES.get(k);
    if (!b) continue;
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  const pad = 24;
  let w = x1 - x0 + pad * 2; let h = y1 - y0 + pad * 2;
  const ratio = WHOLE[2] / WHOLE[3];
  if (w / h < ratio) w = h * ratio; else h = w / ratio;
  return [(x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - h / 2, w, h];
}

const reduceMotion = () => document.documentElement.dataset.reduceMotion === 'true'
  || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function CourtMap({ onPick, selectedCourt = '' }) {
  const [county, setCounty] = useState('');
  const circ = county ? circumscriptionOf(county) : null;
  const list = useMemo(() => (county ? circumscriptionCourts(county) : null), [county]);
  const [hover, setHover] = useState('');

  // The camera: the viewBox, eased toward the target over ~420ms.
  const [view, setView] = useState(WHOLE);
  const viewRef = useRef(WHOLE);
  useEffect(() => {
    const to = circ ? frame(circ.counties) : WHOLE;
    const from = viewRef.current;
    if (reduceMotion()) { viewRef.current = to; setView(to); return undefined; }
    const t0 = performance.now(); const D = 420;
    let raf = 0;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / D);
      const e = ease(t);
      const v = from.map((a, i) => a + (to[i] - a) * e);
      viewRef.current = v; setView(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [circ]);

  useEffect(() => {
    if (!county) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setCounty(''); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [county]);

  // Labels keep one on-screen size however far the map is zoomed in.
  const scale = view[2] / WHOLE[2];
  const hoverCirc = hover ? circumscriptionOf(hover) : null;

  return (
    <section className={`cmap${county ? ' is-open' : ''}`} aria-label="Courts by county">
      <div className="cmap-stage">
        <svg
          className="cmap-svg"
          viewBox={view.join(' ')}
          role="img"
          aria-label="Map of Romania's counties"
          onClick={(e) => { if (e.target === e.currentTarget) setCounty(''); }}
        >
          {MAP.counties.map((c) => {
            const cc = circumscriptionOf(c.code);
            const inCirc = !circ || circ === cc;
            const lit = hover === c.code || county === c.code || (!circ && hoverCirc && hoverCirc === cc);
            return (
              <g
                key={c.code}
                className={`cmap-county shade-${SHADE[cc?.seat] ?? 0}${inCirc ? '' : ' is-out'}${lit ? ' is-lit' : ''}${county === c.code ? ' is-on' : ''}`}
                onMouseEnter={() => setHover(c.code)}
                onMouseLeave={() => setHover((h) => (h === c.code ? '' : h))}
                onClick={() => { if (inCirc || !circ) setCounty(c.code); else setCounty(c.code); }}
                role="button"
                tabIndex={inCirc ? 0 : -1}
                aria-label={`${countyName(c.code)} — Curtea de Apel ${cc?.seat || ''}`}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCounty(c.code); } }}
              >
                <path d={c.d} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
                <text x={c.x} y={c.y} style={{ fontSize: `${(c.code === 'B' ? 9 : 13) * scale}px` }}>{c.code}</text>
              </g>
            );
          })}
        </svg>
        {/* The circumscription hovered, named — before anything is pressed. */}
        {!circ ? (
          <p className="cmap-caption">
            {hover ? <>{countyName(hover)} · <span>Curtea de Apel {circumscriptionOf(hover)?.seat}</span></> : 'Press a county to see its courts'}
          </p>
        ) : null}
      </div>

      {list ? (
        // The dropdown: the circumscription's courts, county by county.
        <div className="cmap-panel" role="dialog" aria-label={`Courts under Curtea de Apel ${list.seat}`}>
          <div className="cmap-panel-head">
            <span className="cmap-panel-title">Curtea de Apel {list.seat}</span>
            <button type="button" className="cmap-close" onClick={() => setCounty('')}>Close</button>
          </div>
          <div className="cmap-panel-list">
            {list.counties.map((k) => (
              <div key={k.code} className="cmap-group">
                <button type="button" className={`cmap-group-name${k.code === county ? ' is-on' : ''}`} onClick={() => setCounty(k.code)}>{k.name}</button>
                <ul>
                  {k.courts.map((c) => (
                    <li key={c.id}>
                      <button type="button" className={`cmap-court${c.id === selectedCourt ? ' is-on' : ''}`} onClick={() => onPick?.(c)}>{c.label}</button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The courts with no county (the military courts) — for a page that wants
 *  to list them beside the map. */
export { nationalCourts, CIRCUMSCRIPTIONS };
