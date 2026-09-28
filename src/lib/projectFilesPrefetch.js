// Background warm-cache for the Files page, keyed by project id.
//
// While the user is elsewhere (the Hub, another tab), <App>'s ProjectPrefetch
// calls prefetchProjectFiles() for the selected project, so that when Files
// opens it paints its grid on the first frame instead of flashing the
// folder-resolve and "Loading…" placeholders.
//
// With the project index (src/projectIndex/README.md) this is cheap: the
// project is opened from its project file and its whole listing comes out of
// the machine index — no walk of the folder. ProjectFiles seeds from the
// bundle and then asks the index again itself (anything that changed in
// between arrives as the same rows). Before the index existed in main, the
// bundle is the old recursive listing plus the root folder's listing.

import { localFolderApi, isElectronBranch, hasProjectIndex, projectIndexApi } from './localFolder';
import { readProjectsDir } from './projectsDir';

// projectId -> { folder, localFiles, rootListing: { files, dirs }, index? }
//   index = { rev, files: Row[], dirs: rel[] } when read from the project index
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
      if (hasProjectIndex()) {
        // Only a project this machine already knows is opened here: linking a
        // folder for the first time (and asking where a moved one went) is the
        // Files page's job, with the user looking at it.
        const loc = await projectIndexApi.locate(projectId);
        if (!loc?.dir) return null;
        const opened = await projectIndexApi.open({ projectId });
        if (!opened?.ok) return null;
        const res = await projectIndexApi.files({ projectId });
        if (!res?.ok) return null;
        const bundle = {
          folder: res.dir || opened.dir,
          localFiles: res.files || [],
          rootListing: null,
          index: { rev: res.rev || 0, files: res.files || [], dirs: res.dirs || [] },
        };
        cache.set(projectId, bundle);
        return bundle;
      }
      const baseDir = readProjectsDir(userId) || undefined;
      const { path } = await localFolderApi.projectDir(projectId, projectName, baseDir);
      if (!path) return null;
      const [listAllRes, rootRes] = await Promise.all([
        localFolderApi.listAll(path).catch(() => ({ files: [] })),
        localFolderApi.list(path).catch(() => ({ files: [], dirs: [] })),
      ]);
      const bundle = {
        folder: path,
        localFiles: listAllRes?.files || [],
        rootListing: { files: rootRes?.files || [], dirs: rootRes?.dirs || [] },
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
// cache for its initial seed and then asks the disk / index itself, so a
// stale entry self-corrects; this is just an explicit eviction hook.
export function clearPrefetchedProjectFiles(projectId) {
  if (projectId) cache.delete(projectId);
  else cache.clear();
}
