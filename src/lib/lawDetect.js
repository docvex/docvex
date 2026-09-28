// LEGISLATION DETECTION, APP-WIDE (2026-09-28 — the app's main feature).
// Every text on screen, in every tab and window, is read for Romanian law —
// acts, codes, CAEN codes, court files, CUIs (lib/lawRefs
// `findFollowableRefs`) — and every reference found is HIGHLIGHTED in its
// platform's colour with the CSS Custom Highlight API: nothing is written into
// the page (React owns those text nodes), only Ranges are registered
// (`::highlight(lawref-<kind>)`, components/LawDetect.css). `hitAt(x, y)`
// says which reference is under a point — the hover tooltip and the click
// (components/LawDetect) read it.
//
// It watches the document (a MutationObserver) and re-reads only what
// changed, a slice at a time on idle. Text is skipped where it cannot be a
// reading surface or is already marked by its own renderer (SKIP): fields,
// code, links and buttons, the Word preview / PDF / picture text layers (they
// mark their own), the Legislation tab's and the AI answers' marks, tooltips,
// the sidebar and the title bar, and anything under `[data-no-lawdetect]`.
// lib/lawRefs is loaded lazily, after start-up (it is kept out of the boot
// bundle on purpose).

export const LAW_KINDS = ['act', 'code', 'caen', 'case', 'cui'];
const SKIP = [
  'input', 'textarea', 'select', 'option', '[contenteditable=""]', '[contenteditable="true"]',
  'code', 'pre', 'script', 'style', 'noscript', 'svg', 'a', 'button', '[role="button"]', '[role="link"]',
  '.ai-lref', '.lg-ref', '.dv-ref', 'dv-mark', '.dv-docx', '.file-preview-pdf-text', '.dv-textlayer', '.dv-textmarks',
  '.tooltip', '.dv-refpill', '.sidebar', '.tb-bar', '[data-no-lawdetect]',
].join(', ');
// A text worth reading at all: a digit (a number, a year, a code) or a code's name.
const MAYBE = /\d|\bcod/i;

let refs = null;              // lib/lawRefs, once loaded
let started = false;
let observer = null;
const nodes = new Map();      // Text → { value, items: [{ start, end, hit, range }], host }
// Elements that directly hold a text with a reference, counted. The hover
// test asks this first: a pointer over an element with no reference in it
// (almost always) costs a Map lookup instead of a caret hit-test + rect reads.
const hosts = new Map();      // Element → number of its texts with references
const highlights = {};        // kind → Highlight
let hot = null;               // the Highlight of the hovered reference
const pendingRoots = new Set();
const pendingText = new Set();
let queue = [];               // text nodes to read, in order
let scheduled = 0;
let prune = false;

const hasHighlights = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 600 }) : setTimeout(() => fn({ timeRemaining: () => 8 }), 60));

function schedule() {
  if (scheduled) return;
  scheduled = idle(pass);
}

function skipped(node) {
  const el = node.parentElement;
  return !el || !!el.closest(SKIP);
}

function addHost(el) { if (el) hosts.set(el, (hosts.get(el) || 0) + 1); }
function removeHost(el) {
  if (!el) return;
  const n = (hosts.get(el) || 0) - 1;
  if (n > 0) hosts.set(el, n); else hosts.delete(el);
}

function drop(node) {
  const e = nodes.get(node);
  if (!e) return;
  for (const it of e.items) highlights[it.hit.kind]?.delete(it.range);
  if (e.items.length) removeHost(e.host);
  nodes.delete(node);
}

function read(node) {
  if (!node.isConnected) { drop(node); return; }
  const value = node.nodeValue || '';
  const prev = nodes.get(node);
  if (prev && prev.value === value) return;
  if (prev) drop(node);
  if (value.length < 4 || !MAYBE.test(value) || skipped(node)) return;
  let hits = [];
  try { hits = refs.findFollowableRefs(value).filter((h) => LAW_KINDS.includes(h.kind)); } catch { hits = []; }
  if (!hits.length) { nodes.set(node, { value, items: [] }); return; }
  const items = [];
  for (const h of hits) {
    const range = document.createRange();
    try { range.setStart(node, h.start); range.setEnd(node, h.end); } catch { continue; }
    highlights[h.kind].add(range);
    items.push({ start: h.start, end: h.end, hit: h, range });
  }
  const host = items.length ? node.parentElement : null;
  if (host) addHost(host);
  nodes.set(node, { value, items, host });
}

function collect(root) {
  if (root.nodeType === Node.TEXT_NODE) { queue.push(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue;
    if (v && v.length >= 4 && MAYBE.test(v)) queue.push(n);
    else if (nodes.has(n)) drop(n);
  }
}

function pass(deadline) {
  scheduled = 0;
  if (!refs) return;
  if (prune) {
    prune = false;
    for (const n of [...nodes.keys()]) if (!n.isConnected) drop(n);
  }
  for (const r of pendingRoots) if (r.isConnected) collect(r);
  pendingRoots.clear();
  for (const t of pendingText) queue.push(t);
  pendingText.clear();
  const until = () => (deadline?.timeRemaining ? deadline.timeRemaining() > 2 : true);
  let done = 0;
  while (queue.length && (until() || done < 20)) { read(queue.shift()); done += 1; }
  if (queue.length) schedule();
}

/** Start reading the document (idempotent). */
export async function startLawDetection() {
  if (started || !hasHighlights()) return;
  started = true;
  refs = await import('./lawRefs');
  for (const k of LAW_KINDS) {
    highlights[k] = new Highlight();
    CSS.highlights.set(`lawref-${k}`, highlights[k]);
  }
  hot = new Highlight();
  hot.priority = 1;
  CSS.highlights.set('lawref-hot', hot);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') pendingText.add(r.target);
      else {
        for (const n of r.addedNodes) pendingRoots.add(n);
        if (r.removedNodes.length) prune = true;
      }
    }
    schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  pendingRoots.add(document.body);
  schedule();
}

/** The reference under a viewport point → { hit, range } or null. `target`
 *  (the element under the pointer, when known) lets the common case — no
 *  reference there — answer without a hit-test. */
export function hitAt(x, y, target) {
  if (!started || !hosts.size) return null;
  if (target && !hosts.has(target)) return null;
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  }
  const e = node && nodes.get(node);
  if (!e || !e.items.length) return null;
  for (const it of e.items) {
    if (offset < it.start || offset > it.end) continue;
    // The caret lands on the nearest text even past a line's end: the point
    // must be ON the reference.
    for (const rc of it.range.getClientRects()) {
      if (x >= rc.left - 1 && x <= rc.right + 1 && y >= rc.top - 1 && y <= rc.bottom + 1) return it;
    }
  }
  return null;
}

/** Light the hovered reference (null = none). */
export function setHotRange(range) {
  if (!hot) return;
  hot.clear();
  if (range) hot.add(range);
}
