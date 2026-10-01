// What the Files tab's AI scan does - one switch per kind of file read or step
// run (the scan button's card, components/ScanGauges; read by lib/dataCollections).
// Kept out of dataCollections so the button doesn't load the whole scan.
// Each switch is one kind of file read or one step run. A kind switched off is
// LEFT AS IT IS — what earlier scans made of those files stays in the
// collections; only new reading is held back.
export const SCAN_FEATURES = [
  { id: 'documents', label: 'Documents', note: 'PDFs, Word, spreadsheets and text files' },
  { id: 'pictures', label: 'Pictures\u2019 text', note: 'Read on this computer, as Extract text reads them' },
  { id: 'recordings', label: 'Audio & video', note: 'Transcribed into captions by the AI (slow for long recordings)' },
  { id: 'links', label: 'Cross-reference', note: 'Typed links between files: amends, contradicts, same party\u2026' },
];
export const DEFAULT_SCAN_FEATURES = { documents: true, pictures: true, recordings: true, faces: false, links: true };
const FEATURES_KEY = 'docvex:scan-features:v1';
// Facial recognition was REMOVED (V12, 2026-09-29): matching faces is biometric
// data (GDPR Art. 9) and, done across a set of photos, likely a high-risk
// 'remote biometric identification' system under the AI Act (Annex III 1(a)).
// A lawyer's case work doesn't need it. `faces` is forced off whatever a
// device stored before.
export function loadScanFeatures() {
  let f;
  try { f = { ...DEFAULT_SCAN_FEATURES, ...(JSON.parse(localStorage.getItem(FEATURES_KEY) || 'null') || {}) }; } catch { f = { ...DEFAULT_SCAN_FEATURES }; }
  f.faces = false;
  return f;
}
export function saveScanFeatures(f) {
  try { localStorage.setItem(FEATURES_KEY, JSON.stringify(f)); } catch { /* per device, harmless */ }
}
