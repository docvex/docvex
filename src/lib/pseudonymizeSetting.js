// Whether TEXT sent to the AI is pseudonymised (lib/pseudonymize), per project
// and per device. Modes:
//   'default' — EVERY AI call made in a project (data protection by default,
//               GDPR Art. 25; CNPs in particular — Law 190/2018 art. 4);
//   'all'     — the same as 'default' (kept so a stored choice still reads);
//   'off'     — none: the user's explicit choice for that project.
// Masking hides real values from the AI, so it can no longer notice a
// misspelled name or a CNP that doesn't match a birth date — a trade the user
// may make per project by switching it off, never one made for them.

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
  // Outside a project (Mail, the Playbook, Research with nothing selected) the
  // user's PERSONAL vault masks the call — always on; there is no project
  // setting to switch it off.
  if (!projectId) return true;
  const mode = getPseudonymizeMode(projectId);
  if (mode === 'off') return false;
  return true; // 'default' and 'all' both mask every call (usageAction kept for callers)
}

// ── Guessing names the project doesn't know (lib/pseudonymize/detectorLayer3)
// On by default in EVERY masked call (a name after "Subsemnatul", "domnul",
// "Reclamant:", a company before SRL…) — without it, third parties named in
// chat, Research and advisor turns went out in clear. The user may switch it
// off per project (a guess can over-reach and hide a word the AI needed).
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
  if (!projectId) return true;
  return getGuessNames(projectId) && isPseudonymizeOn(projectId, usageAction);
}
