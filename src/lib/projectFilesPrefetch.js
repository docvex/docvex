// Background warm-cache for the Files page, keyed by project id.
//
// The app boots on the Hub (/projects). While the user is on the Hub, <App>'s
// ProjectPrefetch effect calls prefetchProjectFiles() for the currently-
// selected (most-recently-worked-on) project, resolving its on-disk folder and
// reading the listings + sidecar up-front. When the user then clicks the
// "Project" tab (→ /files), ProjectFiles seeds its initial state from this
// cache so the grid paints on the first frame instead of flashing the
// folder-resolve + "Loading…" placeholders.
//
// Electron only: the web build has no ambient per-project folder (it tracks a
// single FileSystemDirectoryHandle that needs a per-session permission
// re-grant), so prefetch is a no-op there and ProjectFiles falls back to its
// normal cold path.

import { localFolderApi, isElectronBranch } from './localFolder';
import { readProjectsDir } from './projectsDir';
import { loadSidecar } from './localBranchMeta';

// projectId -> { folder, localFiles, rootListing: { files, dirs }, sidecar }
const cache = new Map();
// projectId -> in-flight Promise, so overlapping triggers (id then name
// resolving) coalesce into one resolution instead of racing.
const inflight = new Map();

// Synchronous read of the warm bundle for a project, or null. ProjectFiles
// calls this in its state initializers, so it must not do any async work.
export function getPrefetchedProjectFiles(projectId) {
  if (!projectId) return null;
  return cache.get(projectId) || null;
}

// Resolve + read everything ProjectFiles needs for its first paint and stash
// it in the cache. Idempotent: a second call for an already-cached project
// returns the cached bundle; concurrent calls share one in-flight promise.
// Never throws — a failed prefetch just means ProjectFiles takes the cold path.
export async function prefetchProjectFiles({ projectId, projectName = null, userId = null }) {
  if (!isElectronBranch || !projectId) return null;
  if (cache.has(projectId)) return cache.get(projectId);
  if (inflight.has(projectId)) return inflight.get(projectId);

  const run = (async () => {
    try {
      const baseDir = readProjectsDir(userId) || undefined;
      const { path } = await localFolderApi.projectDir(projectId, projectName, baseDir);
      if (!path) return null;
      const [listAllRes, rootRes, sidecar] = await Promise.all([
        localFolderApi.listAll(path).catch(() => ({ files: [] })),
        localFolderApi.list(path).catch(() => ({ files: [], dirs: [] })),
        loadSidecar(projectId, path).catch(() => null),
      ]);
      const bundle = {
        folder: path,
        localFiles: listAllRes?.files || [],
        rootListing: { files: rootRes?.files || [], dirs: rootRes?.dirs || [] },
        sidecar,
      };
      cache.set(projectId, bundle);
      return bundle;
    } catch {
      return null;
    } finally {
      inflight.delete(projectId);
    }
  })();

  inflight.set(projectId, run);
  return run;
}

// Drop a project's warm bundle (e.g. when its data is known to have gone
// stale). Pass no id to clear everything. ProjectFiles only ever reads the
// cache for its initial seed, so a stale entry self-corrects via the page's
// own listing effects + folder watcher; this is just an explicit eviction hook.
export function clearPrefetchedProjectFiles(projectId) {
  if (projectId) cache.delete(projectId);
  else cache.clear();
}
