// Which files the Files tab's AI scan reads (lib/dataCollections). The user
// TAGS files for the scan (right-click → Tag for AI scan); a tagged file wears
// the AI mark in the listing, and the scan reads only tagged files — a folder
// full of gameplay videos and screenshots should not be sent through OCR,
// captions and the AI just because it sits in the project.
//
// Kept per project as paths INSIDE the project (forward slashes). Untagging a
// file takes it out of the Data collections on the next scan, as if it had
// been removed.
//
// WHERE IT LIVES: the project's settings store `scan-tags`
// (`.docvex/settings/scan-tags.json`, lib/projectIndexClient), so the tags
// travel with the case. Callers name the project by its FOLDER, so the store is
// used once the client knows which project that folder is (hydrateProject /
// rememberProjectDir); until then, and on a machine without main's side, the
// old localStorage list answers. That list is also kept up to date as this
// machine's mirror: it is tiny, and it lets the first paint show the tags
// before the settings have been read.
import {
  SETTINGS_STORES, peekSetting, putSetting, projectIdForDir, projectDirSpellings, subscribeIndex,
} from './projectIndexClient';
import { secureStorage, secureKeys, subscribeSecureKeys } from './secureStore';

const KEY = 'docvex:scan-tags:v1:';
const EVENT = 'docvex:scan-tags-changed';
const STORE = SETTINGS_STORES.scanTags;

export function relInProject(projectDir, path) {
  const root = String(projectDir || '').replace(/[\\/]+$/, '');
  const p = String(path || '');
  if (root && p.toLowerCase().startsWith(root.toLowerCase())) return p.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return p.split(/[\\/]/).pop();
}

function loadMirror(projectDir) {
  try {
    const list = JSON.parse(secureStorage.getItem(KEY + projectDir) || '[]');
    return Array.isArray(list) ? list.map(String) : [];
  } catch { return []; }
}

export function loadScanTags(projectDir) {
  if (!projectDir) return new Set();
  const projectId = projectIdForDir(projectDir);
  const value = projectId ? peekSetting(projectId, STORE) : undefined;
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set(loadMirror(projectDir));
}

function save(projectDir, set) {
  const list = [...set];
  try { secureStorage.setItem(KEY + projectDir, JSON.stringify(list)); } catch { /* full — the store copy still stands */ }
  const projectId = projectIdForDir(projectDir);
  if (projectId) void putSetting(projectId, STORE, list);
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

// `fn(projectDir)` on every change — this window, another window's mirror
// (storage event), or the store (a colleague's tags arriving with the folder,
// the settings being read for the first time). A store change is reported
// under every spelling of the project's folder this window has seen, since
// callers compare the folder they hold.
export function subscribeScanTags(fn) {
  const onLocal = (e) => fn(e.detail?.projectDir || '');
  // Another window's mirror, or the encrypted store landing at sign-in (every
  // folder it holds is reported).
  const offSecure = subscribeSecureKeys(KEY, (k) => {
    if (k) fn(k.slice(KEY.length));
    else for (const kk of secureKeys(KEY)) fn(kk.slice(KEY.length));
  });
  window.addEventListener(EVENT, onLocal);
  const off = subscribeIndex((ev) => {
    if (ev.type !== 'settings' || ev.store !== STORE) return;
    for (const dir of projectDirSpellings(ev.projectId)) fn(dir);
  });
  return () => { window.removeEventListener(EVENT, onLocal); offSecure(); off(); };
}
