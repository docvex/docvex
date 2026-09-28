// The project file — `<Project name>.docvex` in the case folder's root. It is
// the folder's claim to belong to one project (so the folder can be moved,
// renamed, synced to another machine and still be recognised) and the thing a
// user double-clicks to open the project. See README.md.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './atomic.js';

export const PROJECT_FILE_TYPE = 'docvex/project';
export const PROJECT_EXT = '.docvex';

// A name Windows, macOS and every sync client accept as a file name.
export function sanitizeProjectName(name) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  // Reserved device names can't be file names on Windows even with an extension.
  if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) return 'Project';
  return clean;
}

export const isProjectFileName = (name) => typeof name === 'string'
  && name.toLowerCase().endsWith(PROJECT_EXT) && !name.startsWith('.');

export function isValidProjectFile(json) {
  return !!json && typeof json === 'object' && json.type === PROJECT_FILE_TYPE
    && typeof json.projectId === 'string' && json.projectId.length > 0;
}

export async function readProjectFile(file) {
  const json = await readJson(file);
  return isValidProjectFile(json) ? json : null;
}

// Every valid project file in the folder's root — normally one.
export async function findProjectFiles(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter(isProjectFileName)) {
    const file = path.join(dir, name);
    const json = await readProjectFile(file);
    if (json) out.push({ file, json });
  }
  return out;
}

// Link a folder to a project: find its project file, or write one. A folder
// already claimed by a DIFFERENT project is refused — two projects sharing a
// folder would share their ids and knowledge, which is how data leaks between
// cases.
export async function linkProjectFile(dir, { projectId, name }) {
  const found = await findProjectFiles(dir);
  const mine = found.find((f) => f.json.projectId === projectId);
  if (mine) return { ok: true, projectFile: mine.file, json: mine.json };
  if (found.length) {
    return { ok: false, error: 'project_mismatch', projectFile: found[0].file, otherProjectId: found[0].json.projectId };
  }
  const base = sanitizeProjectName(name);
  // Never write over a file that is there already (a document that happens to
  // be called "X.docvex" is the user's, not ours).
  let file = path.join(dir, base + PROJECT_EXT);
  for (let n = 2; n < 100; n++) {
    try { await fsp.access(file); } catch { break; }
    file = path.join(dir, `${base} (${n})${PROJECT_EXT}`);
  }
  const json = {
    type: PROJECT_FILE_TYPE,
    version: 1,
    projectId,
    name: String(name || base),
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(file, json);
  return { ok: true, projectFile: file, json, created: true };
}
