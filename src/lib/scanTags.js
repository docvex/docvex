// Which files the Files tab's AI scan reads (lib/dataCollections). The user
// TAGS files for the scan (right-click → Tag for AI scan); a tagged file wears
// the AI mark in the listing, and the scan reads only tagged files — a folder
// full of gameplay videos and screenshots should not be sent through OCR,
// captions and the AI just because it sits in the project.
//
// Kept per project folder as paths INSIDE the project (forward slashes), in
// localStorage — one list per project on this machine. Untagging a file takes
// it out of the Data collections on the next scan, as if it had been removed.
const KEY = 'docvex:scan-tags:v1:';
const EVENT = 'docvex:scan-tags-changed';

export function relInProject(projectDir, path) {
  const root = String(projectDir || '').replace(/[\\/]+$/, '');
  const p = String(path || '');
  if (root && p.toLowerCase().startsWith(root.toLowerCase())) return p.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return p.split(/[\\/]/).pop();
}

export function loadScanTags(projectDir) {
  if (!projectDir) return new Set();
  try {
    const list = JSON.parse(localStorage.getItem(KEY + projectDir) || '[]');
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch { return new Set(); }
}

function save(projectDir, set) {
  try { localStorage.setItem(KEY + projectDir, JSON.stringify([...set])); } catch { /* full — the tags stay as they were */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectDir } })); } catch { /* no window */ }
}

// Tag (`on`) or untag entries — each a path inside the project: a file's, or
// a FOLDER's ending in "/" (everything under it). Returns the new set.
export function setScanTags(projectDir, rels, on) {
  const set = loadScanTags(projectDir);
  for (const rel of rels || []) {
    if (!rel) continue;
    if (on) { set.delete(`!${rel}`); set.add(rel); continue; }
    set.delete(rel);
    // Still tagged through a tagged folder: kept out by an exclusion ("!rel").
    if (isScanTagged(set, rel)) set.add(`!${rel}`);
  }
  save(projectDir, set);
  return set;
}

// Is the file (or folder, with a trailing "/") at `rel` tagged — itself or by
// a folder it sits in (and not excluded from it)?
export function isScanTagged(set, rel) {
  if (!set?.size || !rel) return false;
  // The nearest mark wins: the entry itself, then its folders inward-out.
  const parts = rel.replace(/\/$/, '').split('/');
  const chain = [rel];
  for (let i = parts.length - 1; i >= 1; i -= 1) chain.push(`${parts.slice(0, i).join('/')}/`);
  for (const x of chain) {
    if (set.has(`!${x}`)) return false;
    if (set.has(x)) return true;
  }
  return false;
}

export function clearScanTags(projectDir) { save(projectDir, new Set()); }

export function subscribeScanTags(fn) {
  const onLocal = (e) => fn(e.detail?.projectDir || '');
  const onStorage = (e) => { if (e.key && e.key.startsWith(KEY)) fn(e.key.slice(KEY.length)); };
  window.addEventListener(EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(EVENT, onLocal); window.removeEventListener('storage', onStorage); };
}
