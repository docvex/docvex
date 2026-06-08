// Per-folder icon colour, a local UI preference (like Finder tags). Keyed by
// project + folder id and persisted to localStorage so a chosen colour survives
// reloads. Purely cosmetic — never synced to Supabase.

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

const keyFor = (projectId) => `docvex.folderColors.${projectId || '_'}`;

export function loadFolderColors(projectId) {
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function persistFolderColors(projectId, map) {
  try { localStorage.setItem(keyFor(projectId), JSON.stringify(map || {})); } catch { /* ignore quota / private mode */ }
}
