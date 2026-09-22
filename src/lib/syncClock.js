// When a piece of project data was last CHANGED on this device — what account
// sync (lib/projectSyncData) needs to decide which of two copies is newer, for
// stores whose values carry no timestamp of their own (a folder colour, a
// document's theme, the case timeline, the AI chat list).
//
// `touch(key)` is called by the store's own save function, and only when the
// value actually changed — a save that rewrites what is already there must not
// make this device's copy look newer than a genuinely newer one elsewhere.
//
// Tombstones (`markGone`) are the same idea for things REMOVED from a list
// (an AI chat deleted): without them the other device's copy would bring the
// deleted item straight back on the next sync.

const CLOCK_KEY = 'docvex:sync:clock:v1';
const GONE_PREFIX = 'docvex:sync:gone:v1:';

function readJson(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ }
}

export function touch(key, at = Date.now()) {
  if (!key) return;
  const clock = readJson(CLOCK_KEY);
  clock[key] = at;
  writeJson(CLOCK_KEY, clock);
}

export function touchedAt(key) {
  return Number(readJson(CLOCK_KEY)[key]) || 0;
}

// Every clock entry whose key starts with `prefix` → { [key]: at }.
export function touchedUnder(prefix) {
  const out = {};
  for (const [k, at] of Object.entries(readJson(CLOCK_KEY))) {
    if (k.startsWith(prefix)) out[k] = Number(at) || 0;
  }
  return out;
}

// Write `value` (a string) to localStorage and touch its clock — only when it
// differs from what is stored. Returns whether it was written.
export function setIfChanged(key, value) {
  try {
    if (localStorage.getItem(key) === value) return false;
    localStorage.setItem(key, value);
  } catch { return false; }
  touch(key);
  return true;
}

// Remove `key` and touch its clock, so the removal itself travels.
export function removeAndTouch(key) {
  try {
    if (localStorage.getItem(key) == null) return false;
    localStorage.removeItem(key);
  } catch { return false; }
  touch(key);
  return true;
}

// ── Tombstones: ids removed from a list stored under `listKey` ──
export function markGone(listKey, id, at = Date.now()) {
  if (!listKey || !id) return;
  const gone = readJson(GONE_PREFIX + listKey);
  gone[id] = at;
  writeJson(GONE_PREFIX + listKey, gone);
}
export function goneFor(listKey) {
  return readJson(GONE_PREFIX + listKey);
}
export function setGone(listKey, gone) {
  writeJson(GONE_PREFIX + listKey, gone || {});
}
