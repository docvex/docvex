// When each file was last OPENED on this device — the Files tab's
// "Recently opened" sort. Keyed by the file's path (absolute, so one map
// serves every project), newest kept, oldest dropped past the cap.
import { secureStorage, subscribeSecureKeys, registerSecureMerge } from './secureStore';
const KEY = 'docvex:files:opened:v1';
const CAP = 2000;
const EVENT = 'docvex:files-opened';

// Opened before the encrypted store landed: both maps, the later time wins.
registerSecureMerge(KEY, (mine, stored) => {
  const a = JSON.parse(stored || '{}') || {}; const b = JSON.parse(mine || '{}') || {};
  for (const [p, t] of Object.entries(b)) a[p] = Math.max(Number(a[p]) || 0, Number(t) || 0);
  return JSON.stringify(a);
});

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(secureStorage.getItem(KEY) || '{}') || {}; } catch { cache = {}; }
  return cache;
}

export function openedAt(path) {
  return (path && load()[path]) || 0;
}

export function markOpened(path) {
  if (!path) return;
  const map = load();
  map[path] = Date.now();
  const keys = Object.keys(map);
  if (keys.length > CAP) {
    keys.sort((a, b) => map[a] - map[b]).slice(0, keys.length - CAP).forEach((k) => { delete map[k]; });
  }
  try { secureStorage.setItem(KEY, JSON.stringify(map)); } catch { /* full or unavailable */ }
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* no window */ }
}

// Calls `fn` whenever a file is opened — in this window or another.
export function subscribeOpened(fn) {
  const off = subscribeSecureKeys(KEY, () => { cache = null; fn(); });
  window.addEventListener(EVENT, fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    off();
  };
}
