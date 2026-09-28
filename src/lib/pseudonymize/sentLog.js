// WHAT WAS SENT — the last calls this window made to the AI, so the user can
// see what actually left the computer and check that masking worked. In
// memory only (a restart forgets it), capped at MAX calls.
//
// A record keeps the MASKED text that went out, and nothing when a call went
// out unmasked or was refused: the log must never become a second copy of
// the real data.

const MAX = 30;
const PREVIEW = 4000;
let log = [];
const listeners = new Set();

/**
 * @typedef {{ at: number, usageAction: string, projectId: string|null, masked: boolean, sent: boolean, reason?: string, bodyPreview: string|null }} SentRecord
 */

/**
 * @param {{ usageAction: string, projectId?: string|null, masked: boolean, sent?: boolean, reason?: string, preview?: string|null }} rec
 */
export function recordSent({ usageAction, projectId = null, masked, sent = true, reason = '', preview = null }) {
  const text = masked && typeof preview === 'string' ? preview : null;
  /** @type {SentRecord} */
  const entry = {
    at: Date.now(),
    usageAction: String(usageAction || 'chat'),
    projectId: projectId || null,
    masked: !!masked,
    sent: !!sent,
    ...(reason ? { reason: String(reason) } : {}),
    bodyPreview: text == null ? null : (text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text),
  };
  log = [entry, ...log].slice(0, MAX);
  listeners.forEach((fn) => { try { fn(); } catch { /* its own problem */ } });
  return entry;
}

/** Newest first. @returns {SentRecord[]} */
export function getSentLog() { return log; }
export function clearSentLog() { log = []; listeners.forEach((fn) => fn()); }
export function subscribeSentLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
