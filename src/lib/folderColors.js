// Per-folder icon colour, like Finder tags. Keyed by project + folder id.
//
// WHERE IT LIVES: the project's settings store `folder-colors`
// (`.docvex/settings/folder-colors.json`, lib/projectIndexClient), so the
// colours travel with the case. There a folder is named by its path INSIDE the
// project (`{ dirs: { rel: colour }, other: { id: colour } }`); on this machine
// the Files tab names it `dir:<absolute path>`, so the two are converted with
// the project's folder, once the client knows it (hydrateProject). The old
// localStorage map is kept as this machine's mirror — it answers the first
// paint before the settings have been read, and on a machine without main's
// side it is the whole store, as before.
import { setIfChanged } from './syncClock';
import {
  SETTINGS_STORES, peekSetting, putSetting, projectDirOf, folderColorsToRel, folderColorsFromRel, subscribeIndex,
} from './projectIndexClient';
import { secureStorage } from './secureStore';

// Swatches offered in the folder context menu. `value: null` is the "Default"
// entry that clears the override and falls back to the theme accent.
export const FOLDER_COLOR_PRESETS = [
  { id: 'default', label: 'Default', value: null },
  { id: 'red', label: 'Red', value: '#ef4444' },
  { id: 'orange', label: 'Orange', value: '#f97316' },
  { id: 'amber', label: 'Amber', value: '#f59e0b' },
  { id: 'green', label: 'Green', value: '#22c55e' },
  { id: 'teal', label: 'Teal', value: '#14b8a6' },
  { id: 'blue', label: 'Blue', value: '#3b82f6' },
  { id: 'violet', label: 'Violet', value: '#8b5cf6' },
  { id: 'pink', label: 'Pink', value: '#ec4899' },
];

const STORE = SETTINGS_STORES.folderColors;
export const folderColorsKey = (projectId) => `docvex.folderColors.${projectId || '_'}`;
const keyFor = folderColorsKey;

function loadMirror(projectId) {
  try {
    const raw = secureStorage.getItem(keyFor(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function loadFolderColors(projectId) {
  const mirror = loadMirror(projectId);
  const dir = projectDirOf(projectId);
  const value = projectId && dir ? peekSetting(projectId, STORE) : undefined;
  if (value && typeof value === 'object') return folderColorsFromRel(value, dir, mirror);
  return mirror;
}

export function persistFolderColors(projectId, map) {
  setIfChanged(keyFor(projectId), JSON.stringify(map || {}));
  const dir = projectDirOf(projectId);
  if (projectId && dir) void putSetting(projectId, STORE, folderColorsToRel(map || {}, dir));
}

// `fn()` when a project's colours change in the store (read for the first
// time, or arriving from another machine). Returns the unsubscribe.
export function subscribeFolderColors(projectId, fn) {
  return subscribeIndex((ev) => {
    if ((ev.type === 'settings' && ev.store === STORE && ev.projectId === projectId)
      || (ev.type === 'project' && ev.projectId === projectId)) fn();
  });
}
