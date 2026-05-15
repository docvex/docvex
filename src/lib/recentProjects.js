// Per-user, per-device tracking of which project the user most recently
// accessed. Drives the "Most recent" badge + the "show this one first"
// ordering in any list that surfaces projects (the /projects browse page,
// the sidebar's project-picker panel), AND the Sidebar's quick-access
// bookmark row that takes the user back to their most-recent project.
//
// Storage shape — one row per user_id:
//   key:   docvex.recentProjects.<userId>
//   value: JSON { [projectId]: { ts: ISO, name: string|null } }
//
// Earlier versions stored just an ISO string per id. readMap() normalizes
// those legacy entries so a returning user doesn't lose their history when
// the format changes — the name just stays null until the next access
// re-stamps it.
//
// localStorage was chosen over a server-side per-user table because the
// signal is naturally per-device ("the project I was last in *on this
// machine*") and adding a row-per-access to Supabase would amount to a lot
// of cross-region writes for what is purely a UX hint. If we ever want
// cross-device "recent" sync, swap markProjectAccessed for an upsert into
// a new table — the call sites won't change.
//
// All reads/writes are guarded against JSON parse failures + localStorage
// quota/private-browsing errors so the hint never breaks the app.

const STORAGE_KEY = (userId) => `docvex.recentProjects.${userId}`;

// Custom event fired after every successful write. Subscribers (e.g. the
// Sidebar bookmark row) re-read the map on receipt so changes are
// reflected without prop drilling or a context. Window-level dispatch
// (vs. an EventTarget on this module) means listeners can subscribe via
// `window.addEventListener` from anywhere.
export const RECENT_PROJECTS_CHANGED_EVENT = 'docvex:recent-projects-changed';

function readMap(userId) {
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const normalized = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        // Legacy shape: ts only, no remembered name. Carry it forward as
        // a {ts, name:null} record — the next access will fill in name.
        normalized[id] = { ts: value, name: null };
      } else if (value && typeof value === 'object' && typeof value.ts === 'string') {
        normalized[id] = { ts: value.ts, name: value.name ?? null };
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

function writeMap(userId, map) {
  if (!userId) return;
  try {
    localStorage.setItem(STORAGE_KEY(userId), JSON.stringify(map));
  } catch {
    /* private mode / quota — non-fatal, the hint just doesn't persist */
  }
}

// Mark a project as accessed *now*. `projectName` is optional but should
// be passed whenever the caller has it — the sidebar's bookmark row needs
// a name to render. When omitted, the previous name (if any) is preserved
// so a stamp from a code path that only knows the id doesn't blank out
// a name that was stored earlier.
export function markProjectAccessed(userId, projectId, projectName = null) {
  if (!userId || !projectId) return;
  const map = readMap(userId);
  const prev = map[projectId];
  map[projectId] = {
    ts: new Date().toISOString(),
    name: projectName ?? prev?.name ?? null,
  };
  writeMap(userId, map);
  // Fire-and-forget event so subscribers (Sidebar's bookmark row) refresh.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RECENT_PROJECTS_CHANGED_EVENT));
  }
}

// Whole map, for callers that need per-row timestamps (e.g. ordering).
// Returns `{}` rather than null so callers can index without guarding.
export function getRecentMap(userId) {
  return readMap(userId);
}

// id of the single most-recently-accessed project, or null if the user
// has never touched one. Used to drive the "Most recent" badge.
export function getMostRecentProjectId(userId) {
  const map = readMap(userId);
  let best = null;
  let bestTs = '';
  for (const [id, entry] of Object.entries(map)) {
    if (entry.ts > bestTs) {
      best = id;
      bestTs = entry.ts;
    }
  }
  return best;
}

// {id, name} of the most-recent project, or null when none exists yet
// (or only legacy ts-only entries are present and we haven't re-stamped
// with a name). Used by the sidebar bookmark row, which needs the name
// to render meaningful copy.
export function getMostRecentProject(userId) {
  const map = readMap(userId);
  let best = null;
  let bestTs = '';
  for (const [id, entry] of Object.entries(map)) {
    if (entry.ts > bestTs) {
      best = { id, name: entry.name };
      bestTs = entry.ts;
    }
  }
  return best;
}

// Returns a NEW array sorted by recency (most recent first). Projects
// the user has never accessed sort after accessed ones, preserving their
// relative input order — so a brand-new project the user hasn't opened
// yet falls to the bottom rather than vanishing or jumping to the top.
export function sortProjectsByRecent(userId, projects) {
  if (!Array.isArray(projects) || projects.length <= 1) return projects ?? [];
  const map = readMap(userId);
  // Pair each project with its original index so the stable secondary
  // ordering is the caller's input order (the listMyProjects rank, which
  // is created_at desc) rather than something accidental.
  const decorated = projects.map((p, i) => ({ p, i, ts: map[p.id]?.ts || null }));
  decorated.sort((a, b) => {
    // Accessed projects (ts present) win over unaccessed (ts null).
    if (a.ts && !b.ts) return -1;
    if (!a.ts && b.ts) return  1;
    if (a.ts && b.ts) {
      // ISO timestamps sort correctly as strings — newer > older.
      if (a.ts > b.ts) return -1;
      if (a.ts < b.ts) return  1;
    }
    return a.i - b.i;
  });
  return decorated.map((d) => d.p);
}
