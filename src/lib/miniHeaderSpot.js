// Shared mousemove handler for compact bars carrying the `.mini-glow`
// sidebar-style spotlight (styles/miniHeader.css). Writes the bar-relative
// --spot-x/--spot-y vars (layout px — toLayoutPx compensates the web
// display-scale zoom) that the glow gradients track. Snap, not eased: the
// bars are thin strips, a trailing chase would mostly read as lag.
import { toLayoutPx } from './appZoom';

export function miniHeaderSpot(e) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--spot-x', `${toLayoutPx(e.clientX - r.left)}px`);
  el.style.setProperty('--spot-y', `${toLayoutPx(e.clientY - r.top)}px`);
}
