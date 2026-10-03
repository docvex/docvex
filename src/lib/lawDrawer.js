// THE LAW DRAWER — the side drawer that shows a portal record (an act, a CAEN
// code, a court file, a company: the views of pages/ResearchDrawer), opened with
// `openLawView(view)` — e.g. the Newsletter's "Read the act". Rendered by
// components/LawDrawerHost. Opened while open, it goes one view deeper (Back
// returns). (Opening it from a highlighted legislation reference was removed
// with the highlighting on 2026-10-03.)
const listeners = new Set();
let stack = [];

const emit = () => { for (const fn of listeners) fn(); };

export function subscribeLawDrawer(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const getLawDrawer = () => stack;

/** Open a drawer view — one deeper when the drawer is already open. */
export function openLawView(v) {
  if (!v) return;
  stack = stack.length ? [...stack, v] : [v];
  emit();
}
export function backLawDrawer() { stack = stack.slice(0, -1); emit(); }
export function closeLawDrawer() { if (!stack.length) return; stack = []; emit(); }
