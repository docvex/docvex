// Per-user "projects folder" preference — the directory under which Docvex
// auto-creates a folder for each new project (and where the Files page / Title
// bar resolve a project's local folder). There's no backend for this; it lives
// in localStorage alongside the other docvex.* keys.
//
// This used to be duplicated inline in the launch hub, the Title bar, the Files
// page and the AI-chat page. The hub is gone (its project-launcher merged into
// the main app), so the read/write helpers live here as the single source of
// truth. Electron-only in effect — on web `localFolderApi.projectDir` returns
// null (no ambient filesystem path), so the readers no-op gracefully.

const projectsDirKey = (uid) => `docvex.projectsDir.${uid || '_anonymous'}`;

export function readProjectsDir(uid) {
  try {
    return localStorage.getItem(projectsDirKey(uid)) || '';
  } catch {
    return '';
  }
}

export function writeProjectsDir(uid, val) {
  try {
    if (val) localStorage.setItem(projectsDirKey(uid), val);
    else localStorage.removeItem(projectsDirKey(uid));
  } catch {
    /* private mode / quota — non-fatal */
  }
}
