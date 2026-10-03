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
// rebuildable cache, capped at DISK_MAX entries / DISK_BYTES / DISK_AGE, oldest
// out — the sizes and times live in a small `meta` store so trimming never
// reads pages). Every failure falls back to rendering: this can only make
// opening faster.
//
// ENCRYPTED AT REST (security audit 2026-10-01): the pages ARE the contract —
// names, CNPs, addresses. Each entry is sealed with AES-256-GCM under a key
// main derives from the index key for THIS user (main.js app:cache-key): no
// key (no strong OS key store, an old preload) → memory only, nothing on disk;
// another account on the machine cannot open these entries; Erase data, which
// deletes the index key, makes every one of them unreadable. Database version 2
// dropped the plain-text entries version 1 kept.

import { supabase } from './supabaseClient';

const VERSION = 4;   // 4: paginated again after a short-lived continuous layout (3); 2: empty fields no longer marked — bump when the pagination or the marks change shape
const MEM_MAX = 8;
const DISK_MAX = 60;
const DISK_BYTES = 250 * 1024 * 1024;
const DISK_AGE = 30 * 24 * 60 * 60 * 1000;   // an entry unopened for 30 days goes
const ENTRY_MAX = 30 * 1024 * 1024;
const DB = 'docvex-render-cache';
const DB_VERSION = 2;
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

// ── The key: this user's, from main; null = memory only ─────────────────────
let keyFor = { user: undefined, promise: null };
async function currentUser() {
  try { return (await supabase.auth.getSession())?.data?.session?.user?.id || null; } catch { return null; }
}
async function cacheKey() {
  const user = await currentUser();
  if (!user) return null;
  if (keyFor.user === user && keyFor.promise) return keyFor.promise;
  keyFor = {
    user,
    promise: (async () => {
      try {
        const raw = await window.electronAPI?.cacheKey?.({ purpose: 'render-cache', userId: user });
        if (!raw || raw.byteLength !== 32) return null;
        const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
        return { user, key };
      } catch { return null; }
    })(),
  };
  return keyFor.promise;
}
// Signed out / another account: nothing of the last one's stays in memory.
export function forgetRenderCacheUser() {
  mem.clear();
  keyFor = { user: undefined, promise: null };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
async function seal(k, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k.key, enc.encode(JSON.stringify(value)));
  return { iv, data };
}
async function open(k, row) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv }, k.key, row.data);
  return JSON.parse(dec.decode(plain));
}
// The row id carries the user, so two accounts never share one.
const rowId = (k, key) => `${k.user}|${key}`;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, DB_VERSION);
      req.onupgradeneeded = () => {
        // Version 1 kept the pages in the clear: gone, store and all.
        for (const name of [...req.result.objectStoreNames]) req.result.deleteObjectStore(name);
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
  const k = await cacheKey();
  if (!k) return null;
  const db = await openDb();
  if (!db) return null;
  try {
    const id = rowId(k, key);
    const row = await done(db.transaction(PAGES, 'readonly').objectStore(PAGES).get(id));
    if (!row?.data) return null;
    const value = await open(k, row);
    if (!value?.html) return null;
    // Most recently used (its own transaction: none is held across an await).
    try { db.transaction(META, 'readwrite').objectStore(META).put({ key: id, at: Date.now(), bytes: row.data.byteLength }); } catch { /* order only */ }
    const out = { html: value.html, pageWidth: value.pageWidth };
    remember(key, out);
    return out;
  } catch { return null; }
}

export function putDocxRender(key, html, pageWidth) {
  if (!key || !html || !(pageWidth > 0) || html.length > ENTRY_MAX) return;
  remember(key, { html, pageWidth });
  // Written off the opening's critical path — and only sealed.
  const write = async () => {
    const k = await cacheKey();
    if (!k) return;
    const db = await openDb();
    if (!db) return;
    try {
      const { iv, data } = await seal(k, { html, pageWidth });
      const id = rowId(k, key);
      const tx = db.transaction([PAGES, META], 'readwrite');
      tx.objectStore(PAGES).put({ key: id, iv, data });
      tx.objectStore(META).put({ key: id, at: Date.now(), bytes: data.byteLength });
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
  const old = Date.now() - DISK_AGE;
  const drop = [];
  for (const r of rows) {
    if (count <= DISK_MAX && bytes <= DISK_BYTES && (r.at || 0) >= old) break;
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
