// What the Files tab's AI scan does - one switch per kind of file read or step
// run (the scan button's card, components/ScanGauges; read by lib/dataCollections).
// Kept out of dataCollections so the button doesn't load the whole scan.
// Each switch is one kind of file read or one step run. A kind switched off is
// LEFT AS IT IS — what earlier scans made of those files stays in the
// collections; only new reading is held back.
export const SCAN_FEATURES = [
  { id: 'documents', label: 'Documents', note: 'PDFs, Word, spreadsheets and text files' },
  { id: 'pictures', label: 'Pictures\u2019 text', note: 'Read on this computer, as Extract text reads them' },
  { id: 'recordings', label: 'Audio & video', note: 'Read from the captions already saved for them \u2014 nothing is transcribed' },
  { id: 'faces', label: 'Facial recognition', note: 'Faces in pictures matched with identity documents \u2014 on this computer' },
  { id: 'links', label: 'Cross-reference', note: 'Typed links between files: amends, contradicts, same party\u2026' },
];
export const DEFAULT_SCAN_FEATURES = { documents: true, pictures: true, recordings: true, faces: false, links: true };
const FEATURES_KEY = 'docvex:scan-features:v1';
export function loadScanFeatures() {
  try { return { ...DEFAULT_SCAN_FEATURES, ...(JSON.parse(localStorage.getItem(FEATURES_KEY) || 'null') || {}) }; } catch { return { ...DEFAULT_SCAN_FEATURES }; }
}
export function saveScanFeatures(f) {
  try { localStorage.setItem(FEATURES_KEY, JSON.stringify(f)); } catch { /* per device, harmless */ }
}
