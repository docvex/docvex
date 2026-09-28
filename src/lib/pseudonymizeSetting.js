// Whether TEXT sent to the AI is pseudonymised (lib/pseudonymize), per project
// and per device. Three modes:
//   'default' — the AI scan and the MRZ reader only (what reads documents in
//               bulk, where nobody is looking at the answer);
//   'all'     — every AI call, the advisor and Research included;
//   'off'     — none.
// Masking hides real values from the AI, so it can no longer notice a
// misspelled name or a CNP that doesn't match a birth date — which is why the
// conversational surfaces are left to the user's choice.

/** @typedef {'default'|'all'|'off'} PseudonymizeMode */

const KEY = 'docvex:pseudonymize:v1:';
const EVENT = 'docvex:pseudonymize-changed';
export const PSEUDONYMIZE_BY_DEFAULT = new Set(['files-scan', 'mrz']);
/** The calls that must NOT go out unmasked when masking is on (fail closed). */
export const FAIL_CLOSED = new Set(['files-scan', 'mrz']);

/** @returns {PseudonymizeMode} */
export function getPseudonymizeMode(projectId) {
  if (!projectId) return 'default';
  try {
    const v = localStorage.getItem(KEY + projectId);
    return v === 'all' || v === 'off' ? v : 'default';
  } catch { return 'default'; }
}

/** @param {string} projectId @param {PseudonymizeMode} mode */
export function setPseudonymizeMode(projectId, mode) {
  if (!projectId) return;
  try {
    if (mode === 'all' || mode === 'off') localStorage.setItem(KEY + projectId, mode);
    else localStorage.removeItem(KEY + projectId);
  } catch { /* storage unavailable: the default holds */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } })); } catch { /* no window */ }
}

export function subscribePseudonymize(fn) {
  const onStorage = (e) => { if (e.key && e.key.startsWith(KEY)) fn(); };
  window.addEventListener(EVENT, fn);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(EVENT, fn); window.removeEventListener('storage', onStorage); };
}

/** Is this call's text masked? @param {string|null} projectId @param {string} usageAction */
export function isPseudonymizeOn(projectId, usageAction) {
  if (!projectId) return false;
  const mode = getPseudonymizeMode(projectId);
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return PSEUDONYMIZE_BY_DEFAULT.has(usageAction);
}

// ── Guessing names the project doesn't know (lib/pseudonymize/detectorLayer3)
// On (the default) it runs in the calls masked by default — the AI scan and
// the MRZ reader; the user may switch it off (a guess can over-reach and hide
// a word the AI needed). It only ever adds to a call that is masked at all.
const GUESS_KEY = 'docvex:pseudonymize:guess:v1:';
export const GUESS_BY_DEFAULT = new Set(['files-scan', 'mrz']);

/** Is guessing switched on for this project (the stored choice)? */
export function getGuessNames(projectId) {
  if (!projectId) return true;
  try { return localStorage.getItem(GUESS_KEY + projectId) !== 'off'; } catch { return true; }
}
export function setGuessNames(projectId, on) {
  if (!projectId) return;
  try {
    if (on) localStorage.removeItem(GUESS_KEY + projectId);
    else localStorage.setItem(GUESS_KEY + projectId, 'off');
  } catch { /* storage unavailable: the default holds */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } })); } catch { /* no window */ }
}

/** Does this call also guess unknown names? @param {string|null} projectId @param {string} usageAction */
export function isGuessNamesOn(projectId, usageAction) {
  return !!projectId && getGuessNames(projectId) && GUESS_BY_DEFAULT.has(usageAction) && isPseudonymizeOn(projectId, usageAction);
}
