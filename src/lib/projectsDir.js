// Per-user "projects folder" preference — the directory under which Docvex
// makes a folder for each NEW project. It no longer decides where an existing
// project is: that is its project file (`<Project name>.docvex`, see
// src/projectIndex/README.md), found through main's machine registry. It is
// still read when a project that has never been opened on this machine is
// linked for the first time (lib/localFolder → legacyProjectDir). There's no
// backend for this; it lives in localStorage alongside the other docvex.* keys.

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
