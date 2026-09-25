// HISTORY, per tab — every search run and every thing opened in one of the
// Legislation family's tabs, on this device, with the moment it happened.
// Shown by each tab bar's History button (components/HistoryMenu) as a
// dropdown laid out like the Advisor's thread: what was asked as the user's
// own bubbles, what was opened as the answers, day by day. Kept in
// localStorage, one log per tab (`docvex:history:<tab>:v1`; the Legislation
// tab keeps the key it had before the log was shared), newest last, capped
// at HISTORY_CAP entries — a log, not an archive.
//
// An entry: `{ id, at, kind: 'search' | 'open', label, detail?, data? }` plus
// whatever the tab adds (the Legislation tab keeps its form fields on the
// entry and draws them itself). `label` / `detail` are what the menu shows
// by default; `data` is what the tab needs to run or open the entry again.

export const HISTORY_CAP = 400;

const keyFor = (tab) => (tab === 'legislation' ? 'docvex:legislation:history:v1' : `docvex:history:${tab}:v1`);

const read = (tab) => {
  try {
    const arr = JSON.parse(localStorage.getItem(keyFor(tab)) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
};
const write = (tab, arr) => {
  try { localStorage.setItem(keyFor(tab), JSON.stringify(arr.slice(-HISTORY_CAP))); } catch { /* full or refused — the log is a convenience */ }
};

/** Every entry of a tab's log, oldest first. */
export const listHistory = (tab) => read(tab);

/**
 * Adds an entry. `dedupe`: a key under which the same thing logged twice
 * running is ONE line, at the later time (an act opened, closed and opened
 * again is one opening).
 */
export function logHistory(tab, { kind = 'open', dedupe = '', ...rest }) {
  const arr = read(tab);
  const last = arr[arr.length - 1];
  if (dedupe && last && last.dedupe === dedupe) { last.at = new Date().toISOString(); write(tab, arr); return; }
  arr.push({
    id: `${kind[0]}${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    kind,
    ...(dedupe ? { dedupe } : {}),
    ...rest,
  });
  write(tab, arr);
}

export function clearHistory(tab) { write(tab, []); }
