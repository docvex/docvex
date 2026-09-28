// THE LAW DRAWER — where a legislation reference opens, APP-WIDE (2026-09-28,
// the app's main feature). A reference pressed anywhere (the app-wide layer,
// components/LawDetect; an AI answer; the Doc Viewer's marks) goes through
// `openLawRef(hit)`: the SIDE DRAWER sliding in from the right shows the
// record — the act, the CAEN code, the court file, the company (the views of
// pages/ResearchDrawer). Pressed while the drawer is open, it goes one view
// deeper (Back returns). A page with a drawer of its own (Research) takes the
// press instead while mounted: `setLawRefOpener(fn)` → unregister.
const listeners = new Set();
let stack = [];
const openers = [];

const emit = () => { for (const fn of listeners) fn(); };

export function subscribeLawDrawer(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const getLawDrawer = () => stack;

/** A page's own opener, used instead of the app drawer while registered. */
export function setLawRefOpener(fn) {
  openers.push(fn);
  return () => { const i = openers.lastIndexOf(fn); if (i >= 0) openers.splice(i, 1); };
}

/** Open a lib/lawRefs hit (act, code, caen, case, cui). */
export async function openLawRef(hit) {
  if (!hit) return;
  const own = openers[openers.length - 1];
  if (own) { own(hit); return; }
  const { viewForRef } = await import('./portalRecords');
  openLawView(viewForRef(hit));
}
/** Open a drawer view — one deeper when the drawer is already open. */
export function openLawView(v) {
  if (!v) return;
  stack = stack.length ? [...stack, v] : [v];
  emit();
}
export function backLawDrawer() { stack = stack.slice(0, -1); emit(); }
export function closeLawDrawer() { if (!stack.length) return; stack = []; emit(); }
