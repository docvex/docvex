// The copy ON THIS MACHINE of what a source tab has been told — the
// Legislation tab's archive (`userData/legislation`, lib/legislation.js), made
// for the other live sources (the courts' portal, ANAF). The service is a
// SOURCE, not a dependency: every answer is kept here, and when the service
// cannot answer the same question is answered from the copy instead — always
// SAYING which of the two it came from, since "nothing found" offline means
// something very different from the service saying so.
//
// One store per tab, in localStorage (`docvex:source-cache:<tab>:v1`):
// `{ [key]: { at, data } }`, the oldest entries evicted past ~2.5 MB of text.
// Keys are the tab's own ("q:<search>", "f:<court>:<number>", "c:<cui>").

import { secureStorage } from './secureStore';
const CAP = 2_500_000;
const EVENT = 'docvex:source-cache';
const storeKey = (tab) => `docvex:source-cache:${tab}:v1`;

function load(tab) {
  try { return JSON.parse(secureStorage.getItem(storeKey(tab)) || '{}') || {}; } catch { return {}; }
}

function save(tab, map) {
  let entries = Object.entries(map);
  let text = JSON.stringify(map);
  // Over the cap: the oldest out, until it fits (or until nothing is left
  // but the newest, which is always kept).
  if (text.length > CAP) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    while (entries.length > 1 && text.length > CAP) {
      entries = entries.slice(0, Math.max(1, Math.floor(entries.length * 0.85)));
      text = JSON.stringify(Object.fromEntries(entries));
    }
  }
  for (let tries = 0; tries < 4; tries++) {
    try { secureStorage.setItem(storeKey(tab), text); break; } catch {
      // Storage full: give back a quarter and try again.
      entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
      entries = entries.slice(0, Math.max(0, Math.floor(entries.length * 0.75)));
      text = JSON.stringify(Object.fromEntries(entries));
    }
  }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { tab } })); } catch { /* no window */ }
}

/** `{ at, data }` or null. */
export function cacheGet(tab, key) {
  return load(tab)[key] || null;
}

/** Keep `data` under `key` (several at once: `cachePutMany(tab, [[key, data]…])`). */
export function cachePut(tab, key, data) {
  cachePutMany(tab, [[key, data]]);
}
export function cachePutMany(tab, pairs) {
  if (!pairs.length) return;
  const map = load(tab);
  const at = Date.now();
  for (const [k, data] of pairs) map[k] = { at, data };
  save(tab, map);
}

/** Every entry whose key starts with `prefix`, newest first: `[{ key, at, data }]`. */
export function cacheList(tab, prefix = '') {
  return Object.entries(load(tab))
    .filter(([k]) => k.startsWith(prefix))
    .map(([key, v]) => ({ key, at: v.at, data: v.data }))
    .sort((a, b) => b.at - a.at);
}

/** What the copy holds: `{ count, bytes }` — `count` of the entries under `prefix`. */
export function cacheStats(tab, prefix = '') {
  let raw = '';
  try { raw = secureStorage.getItem(storeKey(tab)) || ''; } catch { /* storage refused */ }
  let map = {};
  try { map = JSON.parse(raw || '{}') || {}; } catch { /* unreadable */ }
  return { count: Object.keys(map).filter((k) => k.startsWith(prefix)).length, bytes: raw.length * 2 };
}

export function cacheClear(tab) {
  try { secureStorage.removeItem(storeKey(tab)); } catch { /* storage refused */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { tab } })); } catch { /* no window */ }
}

/** Told whenever `tab`'s copy changes (in this window). */
export function onCacheChange(tab, fn) {
  const h = (e) => { if (!e.detail?.tab || e.detail.tab === tab) fn(); };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/** Whether an error means the service could not be REACHED (so the copy
 *  answers) rather than that it refused the question. */
export const isUnreachable = (error) => ['unreachable', 'timeout', 'stale_app', 'rate_limited'].includes(error)
  || /^http_5/.test(String(error || ''));

/** A stable key for a query object (field order does not matter). */
export const queryKey = (q) => JSON.stringify(Object.keys(q || {}).sort().reduce((o, k) => {
  const v = typeof q[k] === 'string' ? q[k].trim() : q[k];
  if (v !== '' && v != null) o[k] = v;
  return o;
}, {}));

/** Whether two records say the same thing — `ignore` names fields that
 *  change on every answer (an "as of" date) and do not count. */
export function sameRecord(a, b, ignore = []) {
  const strip = (x) => JSON.stringify(x, (k, v) => (ignore.includes(k) ? undefined : v));
  return strip(a) === strip(b);
}

/** ASCII-folded, lower case — Romanian is typed with ș/ț, ş/ţ, or neither. */
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
