// The Doc Viewer's WORD RENDER CACHE — a Word file opens from the pages it
// was laid out as last time instead of being rendered again.
//
// Opening a .docx is docx-preview parsing the zip and building the flow, the
// fonts loading, then our own pagination measuring every block and dealing it
// onto sheets: seconds for a long contract, every single time. The finished
// pages are plain DOM (images and fonts are base64 — `useBase64URL` — and every
// mark the passes leave is a `data-` attribute), so their HTML is the whole
// result. It is kept under the file's CONTENT hash + the document theme + the
// folded headings, so an edited file, another theme or another fold is simply
// another entry and nothing stale can be shown.
//
// Two levels: memory (this window, last MEM_MAX documents — switching back to a
// tab is instant) and IndexedDB (every Doc Viewer window, across restarts; a
// rebuildable cache, capped at DISK_MAX entries / DISK_BYTES, oldest out — the
// sizes and times live in a small `meta` store so trimming never reads pages).
// Every failure falls back to rendering: this can only make opening faster.

const VERSION = 1;   // bump when the pagination or the marks change shape
const MEM_MAX = 8;
const DISK_MAX = 60;
const DISK_BYTES = 250 * 1024 * 1024;
const ENTRY_MAX = 30 * 1024 * 1024;
const DB = 'docvex-render-cache';
const PAGES = 'docx';
const META = 'meta';

const mem = new Map();   // key → { html, pageWidth }

// SHA-1 of the file's bytes (a few ms for a normal document) + what else
// changes the pages: the theme and the folded headings.
export async function docxContentKey(blob, { theme = '', folds = null } = {}) {
  try {
    const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const foldKey = folds && folds.size ? [...folds].map(String).sort().join('\u0001') : '';
    return `v${VERSION}|${hex}|${theme || ''}|${foldKey}`;
  } catch { return null; }
}

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(PAGES, { keyPath: 'key' });
        req.result.createObjectStore(META, { keyPath: 'key' }).createIndex('at', 'at');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}
const done = (req) => new Promise((resolve) => { req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null); });

function remember(key, value) {
  mem.delete(key);
  mem.set(key, value);
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

// → { html, pageWidth } or null.
export async function getDocxRender(key) {
  if (!key) return null;
  if (mem.has(key)) { const v = mem.get(key); remember(key, v); return v; }
  const db = await openDb();
  if (!db) return null;
  try {
    const row = await done(db.transaction(PAGES, 'readonly').objectStore(PAGES).get(key));
    if (!row?.html) return null;
    // Most recently used (its own transaction: none is held across an await).
    try { db.transaction(META, 'readwrite').objectStore(META).put({ key, at: Date.now(), bytes: row.html.length }); } catch { /* order only */ }
    const value = { html: row.html, pageWidth: row.pageWidth };
    remember(key, value);
    return value;
  } catch { return null; }
}

export function putDocxRender(key, html, pageWidth) {
  if (!key || !html || !(pageWidth > 0) || html.length > ENTRY_MAX) return;
  remember(key, { html, pageWidth });
  // Written off the opening's critical path.
  const write = async () => {
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction([PAGES, META], 'readwrite');
      tx.objectStore(PAGES).put({ key, html, pageWidth });
      tx.objectStore(META).put({ key, at: Date.now(), bytes: html.length });
      await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
      await trim(db);
    } catch { /* full or closed — the memory copy stands */ }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { void write(); }, { timeout: 4000 });
  else setTimeout(() => { void write(); }, 500);
}

async function trim(db) {
  const rows = (await done(db.transaction(META, 'readonly').objectStore(META).index('at').getAll())) || [];   // oldest first
  let bytes = rows.reduce((n, r) => n + (r.bytes || 0), 0);
  let count = rows.length;
  const drop = [];
  for (const r of rows) {
    if (count <= DISK_MAX && bytes <= DISK_BYTES) break;
    drop.push(r.key);
    count -= 1; bytes -= r.bytes || 0;
  }
  if (!drop.length) return;
  const tx = db.transaction([PAGES, META], 'readwrite');
  for (const k of drop) { tx.objectStore(PAGES).delete(k); tx.objectStore(META).delete(k); }
}

// Debug → Clear all cached data.
export async function clearDocxRenders() {
  mem.clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([PAGES, META], 'readwrite');
    tx.objectStore(PAGES).clear();
    tx.objectStore(META).clear();
  } catch { /* nothing to clear */ }
}
