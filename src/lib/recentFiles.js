// When each file was last OPENED on this device — the Files tab's
// "Recently opened" sort. Keyed by the file's path (absolute, so one map
// serves every project), newest kept, oldest dropped past the cap.
const KEY = 'docvex:files:opened:v1';
const CAP = 2000;
const EVENT = 'docvex:files-opened';

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { cache = {}; }
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
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* full or unavailable */ }
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* no window */ }
}

// Calls `fn` whenever a file is opened — in this window or another.
export function subscribeOpened(fn) {
  const onStorage = (e) => { if (e.key === KEY) { cache = null; fn(); } };
  window.addEventListener(EVENT, fn);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener('storage', onStorage);
  };
}
