// The Legislation tab's HISTORY — every search run and every act opened, on
// this device, with the moment it happened — one tab's log of the shared
// per-tab history (lib/tabHistory; this tab keeps its older key,
// `docvex:legislation:history:v1`). The page draws its entries itself: a
// search entry carries the form (`tip`, `numar`, `an`, `words`) and what came
// back, an open entry the act's record without its text.

import { listHistory as list, logHistory, clearHistory as clear } from './tabHistory';
export { HISTORY_CAP } from './tabHistory';

const TAB = 'legislation';

/** Every entry, oldest first: `{ id, at, kind: 'search' | 'open', … }`. */
export const listHistory = () => list(TAB);

/** A search that was run: its form (`tip`, `numar`, `an`, `words`) and what came back. */
export function logSearch({ tip = '', numar = '', an = '', words = '', count = 0, source = '' }) {
  logHistory(TAB, { kind: 'search', tip, numar, an, words, count, source });
}

/** An act that was opened: enough of its record to open it again (`loadAct` needs the id and link). */
export function logOpen(rec) {
  if (!rec?.id) return;
  const { text, ...meta } = rec;
  // The same act opened twice running is one line, at the later time.
  logHistory(TAB, { kind: 'open', rec: meta, dedupe: `o:${rec.id}` });
}

export function clearHistory() { clear(TAB); }
