// Case-timeline persistence — one saved timeline per project, in localStorage.
// Shared between the Timeline tab (ProjectEvents.jsx, which generates and
// saves the story) and the Files tab (ProjectFiles.jsx, which surfaces the
// files the timeline references as a virtual "Timeline" folder).
//
// Persisted shape (see ProjectEvents' normalizeTimeline):
//   { lede, events: [{ d, y, cat, kind, title, body, files: [filename], … }],
//     flags, meta: { fileCount, generatedAt },
//     fileRefs: { [filename]: { path, mime } } }
// Events reference files by EXACT filename; `fileRefs` maps each filename to
// the on-disk path captured when the timeline was built.

const TIMELINE_KEY_PREFIX = 'docvex:case-timeline:v1:';

export function timelineKeyFor(projectId) {
  return `${TIMELINE_KEY_PREFIX}${projectId}`;
}

// Load the saved timeline for a project — null when absent, corrupt, or
// empty (no events), so callers can treat "no usable timeline" as one case.
export function loadCaseTimeline(projectId) {
  if (!projectId) return null;
  try {
    const raw = localStorage.getItem(timelineKeyFor(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.events) && parsed.events.length > 0) return parsed;
  } catch { /* corrupt entry — treat as absent */ }
  return null;
}

// Persist a built timeline. Quota errors are swallowed — the in-memory
// timeline still renders; it just won't survive a reload.
export function saveCaseTimeline(projectId, timeline) {
  if (!projectId) return;
  try {
    localStorage.setItem(timelineKeyFor(projectId), JSON.stringify(timeline));
  } catch { /* quota — best-effort */ }
}
