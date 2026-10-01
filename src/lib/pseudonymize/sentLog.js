// WHAT WAS SENT — the last calls this window made to the AI, so the user can
// see what actually left the computer and check that masking worked. In
// memory only (a restart forgets it), capped at MAX calls.
//
// A record keeps the MASKED text that went out, and nothing when a call went
// out unmasked or was refused: the log must never become a second copy of
// the real data.

const MAX = 30;

// SPECIAL CATEGORIES (V8): what the text sent is ABOUT, flagged by words —
// GDPR Art. 9 (health, biometrics, sexual life, religion, ethnicity, politics,
// unions) and Art. 10 (criminal matters). Masking hides WHO, not WHAT; these
// flags tell the user a call carried sensitive subject matter. Only the
// category is kept, never the words that raised it.
const SPECIAL = [
  ['health', /\b(?:diagnostic\w*|boal[aăe]\w*|medical\w*|spital\w*|tratament\w*|handicap\w*|dizabilit\w*|psihiatr\w*|psiholog\w*|sarcin[aăi]\w*|HIV|cancer\w*|certificat\w* medical\w*|expertiz\w* medico\w*|concediu\w* medical\w*|health|diagnos\w*|disease|pregnan\w*)\b/iu],
  ['criminal', /\b(?:penal\w*|infrac[tț]\w*|condamn\w*|cazier\w*|urm[aă]rire\w* penal\w*|inculpat\w*|suspect\w*|arest\w*|re[tț]inere\w*|deten[tț]i\w*|DIICOT|DNA|parchet\w*|criminal\w*|convict\w*)\b/iu],
  ['biometric', /\b(?:amprent\w*|biometric\w*|recunoa[sș]tere facial\w*|fingerprint\w*|facial recognition)\b/iu],
  ['beliefs-origin', /\b(?:religi\w*|confesiun\w*|etni\w*|orientare\w* sexual\w*|partid\w* politic\w*|sindicat\w*|religio\w*|ethnic\w*|sexual orientation|trade union)\b/iu],
];
export function specialCategories(text) {
  const t = String(text || '');
  if (!t) return [];
  return SPECIAL.filter(([, re]) => re.test(t)).map(([id]) => id);
}
const PREVIEW = 4000;
let log = [];
const listeners = new Set();

/**
 * @typedef {{ at: number, usageAction: string, projectId: string|null, masked: boolean, sent: boolean, reason?: string, bodyPreview: string|null, flags: string[] }} SentRecord
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
    flags: specialCategories(preview),
  };
  log = [entry, ...log].slice(0, MAX);
  listeners.forEach((fn) => { try { fn(); } catch { /* its own problem */ } });
  return entry;
}

/** Newest first. @returns {SentRecord[]} */
export function getSentLog() { return log; }
export function clearSentLog() { log = []; listeners.forEach((fn) => fn()); }
export function subscribeSentLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
