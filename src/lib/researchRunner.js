// RESEARCH'S RUNNING WORK, OUTSIDE THE PAGE — what Research is doing right
// now lives here, not in the page's state, so a search, an answer or a
// summary carries on and lands in its chat when the reader switches to
// another tab, and the page shows it still running on the way back. The
// APP SIDEBAR reads it too: a spinner on the Research row while anything
// runs, and on each chat tab that is working.
//
//   busy         threadId → { phase, model }   a turn running in that chat
//   summarizing  `${threadId}:${index}` → label  an AI summary being written
//   typing       the reply that has just landed and should type itself out
//
// A turn is numbered per chat (`beginTurn`); Stop bumps the number, so a
// turn that comes back after it was stopped writes nothing (`isLive`).

let state = { busy: {}, summarizing: {}, typing: null };
const listeners = new Set();
const seq = new Map();

function set(next) {
  state = { ...state, ...next };
  listeners.forEach((fn) => { try { fn(); } catch { /* a listener's own trouble */ } });
}

export const subscribeRunner = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const runnerState = () => state;

/** A turn in `tid` has started, or moved to a new phase; `null` = it ended. */
export function setTurn(tid, v) {
  const busy = { ...state.busy };
  if (v) busy[tid] = v; else delete busy[tid];
  set({ busy });
}
/** An AI summary being written for message `key` (`${tid}:${index}`); `null` = done. */
export function setSummarizing(key, v) {
  const summarizing = { ...state.summarizing };
  if (v) summarizing[key] = v; else delete summarizing[key];
  set({ summarizing });
}
export function setTyping(v) {
  if (state.typing !== v) set({ typing: v });
}

/** Start a turn in `tid` → its number. */
export function beginTurn(tid) {
  const n = (seq.get(tid) || 0) + 1;
  seq.set(tid, n);
  return n;
}
/** Is turn `n` still the current one in `tid` (not stopped, not replaced)? */
export const isLive = (tid, n) => seq.get(tid) === n;
/** Stop whatever runs in `tid`: its turn writes nothing when it returns. */
export function stopTurn(tid) {
  seq.set(tid, (seq.get(tid) || 0) + 1);
  setTurn(tid, null);
}

/** Is anything running in `tid` (a turn or a summary)? */
export const isThreadBusy = (s, tid) => !!s.busy[tid] || Object.keys(s.summarizing).some((k) => k.startsWith(`${tid}:`));
/** Is anything running at all? */
export const anyRunning = (s) => Object.keys(s.busy).length > 0 || Object.keys(s.summarizing).length > 0;
