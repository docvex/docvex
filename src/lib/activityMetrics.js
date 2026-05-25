// Personal activity metrics for the Activity page (/).
//
// Ported from the Claude Design handoff (docvex-activity-notification-redesign,
// `activity-metrics.jsx`). Scope = the SIGNED-IN USER across ALL their projects
// ("my activity"), which is exactly what the mockup was built for — the Activity
// page is itself a cross-project personal feed.
//
// Every number is derived from real docvex data (RLS scopes each table to the
// projects the caller belongs to; the personal rows are scoped to auth.uid()):
//   • branch_changes (mine)        → un-pushed drafts + breakdown
//   • change_requests (mine)       → in review / merged + deltas
//   • project_files (mine)         → files I synced, file-activity spark
//   • change_request_items (mine)  → files I touched most
//   • project_invitations (mine)   → invites I sent
//   • everyone's files/requests in my projects → people I worked with
// Event timestamps (uploads + requests + queued edits) feed the heatmap,
// streak, and 24h "when I work" histogram. Every query is best-effort: a
// failure degrades that one section to empty rather than blanking the strip.

import { supabase } from './supabaseClient';
import { listMyProjects } from './projects';

const DAY = 86400000;

// Deterministic avatar palette (mirrors the app's 12-colour djb2 scheme).
const AVATAR_COLORS = ['#0891B2', '#BE185D', '#4F46E5', '#047857', '#B45309', '#6D28D9', '#DC2626', '#0369A1', '#DB2777', '#059669', '#7C3AED', '#EA580C'];
function colorForId(id) {
  if (!id) return AVATAR_COLORS[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h |= 0; }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function displayName(profile) {
  if (!profile) return 'Teammate';
  return profile.full_name || profile.name || profile.email || 'Teammate';
}
function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

const pad2 = (n) => String(n).padStart(2, '0');
function ts(v) { const t = new Date(v).getTime(); return Number.isNaN(t) ? null : t; }
function startOfDay(t) { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); }
function dayKey(t) { const x = new Date(t); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; }
function mondayStart(t) {
  const x = new Date(t); x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // Mon = 0
  x.setDate(x.getDate() - day);
  return x.getTime();
}
function weekdayMon(t) { return (new Date(t).getDay() + 6) % 7; }

export function relTime(input) {
  const t = input instanceof Date ? input.getTime() : (typeof input === 'number' ? input : ts(input));
  if (t == null) return '';
  const ms = Date.now() - t;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  return `${d} d ago`;
}

// Kind → label/category for the drafts breakdown bar.
const KIND_META = {
  add:     { label: 'Added',    cat: 'file' },
  edit:    { label: 'Edited',   cat: 'file' },
  replace: { label: 'Replaced', cat: 'member' },
  delete:  { label: 'Removed',  cat: 'role' },
};

// ── Shared time-series builders (pure functions of an event-time list) ──
function buildHeatmap(eventTimes, now) {
  const monThis = mondayStart(now);
  const base = monThis - 21 * DAY; // Monday, 3 weeks before this week
  const weeks = Array.from({ length: 4 }, () => new Array(7).fill(0));
  for (const t of eventTimes) {
    if (t >= base && t < monThis + 7 * DAY) {
      const w = Math.floor((startOfDay(t) - base) / (7 * DAY));
      const d = weekdayMon(t);
      if (w >= 0 && w < 4 && d >= 0 && d < 7) weeks[w][d] += 1;
    }
  }
  return { rows: ['M', 'T', 'W', 'T', 'F', 'S', 'S'], weeks, todayRowIdx: weekdayMon(now) };
}
function buildStreak(eventTimes, now) {
  const activeDays = new Set(eventTimes.map((t) => dayKey(t)));
  let current = 0;
  for (let i = 0; ; i++) { if (activeDays.has(dayKey(now - i * DAY))) current += 1; else break; }
  const last14 = [];
  for (let i = 13; i >= 0; i--) last14.push(activeDays.has(dayKey(now - i * DAY)));
  let longest = 0; let run = 0;
  for (let i = 59; i >= 0; i--) {
    if (activeDays.has(dayKey(now - i * DAY))) { run += 1; longest = Math.max(longest, run); } else run = 0;
  }
  return { current, longest: Math.max(longest, current), last14 };
}
function buildWhenIWork(eventTimes, now) {
  const since28 = now - 28 * DAY;
  const hours = new Array(24).fill(0);
  for (const t of eventTimes) { if (t >= since28) hours[new Date(t).getHours()] += 1; }
  const total = hours.reduce((a, b) => a + b, 0);
  let bestStart = 0; let bestSum = -1;
  for (let h = 0; h < 24; h++) {
    const s = hours[h] + (hours[h + 1] || 0) + (hours[h + 2] || 0);
    if (s > bestSum) { bestSum = s; bestStart = h; }
  }
  return {
    hours,
    peak: total ? `${pad2(bestStart)}:00 – ${pad2(Math.min(bestStart + 3, 24))}:00` : '—',
    avgPerDay: (total / 28).toFixed(1),
  };
}

export async function fetchPersonalActivityMetrics({ userId }) {
  if (!userId) return null;

  const now = Date.now();
  const week1 = now - 7 * DAY;
  const week2 = now - 14 * DAY;
  const within = (t, lo, hi) => t >= lo && t < hi;

  // ── Fetch across all my projects (RLS scopes rows to my memberships). ──
  const ok = (r) => r;
  const fail = () => ({ data: [] });
  const [projRes, filesRes, reqRes, bcRes, invRes] = await Promise.all([
    listMyProjects().catch(fail),
    supabase.from('project_files').select('id, name, project_id, uploaded_by, uploaded_at')
      .order('uploaded_at', { ascending: false }).limit(2000).then(ok, fail),
    supabase.from('change_requests').select('id, project_id, author_id, title, status, submitted_at, decided_at')
      .order('submitted_at', { ascending: false }).limit(2000).then(ok, fail),
    supabase.from('branch_changes').select('kind, target_file_id, project_id, created_at')
      .eq('user_id', userId).then(ok, fail),
    supabase.from('project_invitations').select('id, accepted_at')
      .eq('invited_by', userId).then(ok, fail),
  ]);

  const projectNameById = new Map((projRes?.data || []).map((p) => [p.id, p.name]));
  const allFiles = filesRes?.data || [];
  const fileById = new Map(allFiles.map((f) => [f.id, f]));
  const myFiles = allFiles.filter((f) => f.uploaded_by === userId);

  const allReqs = reqRes?.data || [];
  const myReqs = allReqs.filter((r) => r.author_id === userId);
  const myOpenReqs = myReqs.filter((r) => r.status === 'open');
  const myApproved = myReqs.filter((r) => r.status === 'approved');

  const branchChanges = (bcRes && !bcRes.error && bcRes.data) ? bcRes.data : [];
  const invites = (invRes && !invRes.error && invRes.data) ? invRes.data : [];
  const pendingInvites = invites.filter((i) => !i.accepted_at);

  // Items of my open requests → "files I touched".
  let myOpenItemTargets = [];
  const openIds = myOpenReqs.map((r) => r.id);
  if (openIds.length) {
    const itRes = await supabase.from('change_request_items')
      .select('target_file_id, request_id').in('request_id', openIds).then(ok, fail);
    myOpenItemTargets = (itRes?.data || []).map((it) => it.target_file_id).filter(Boolean);
  }

  // ── Event timeline (my activity, with project for "projects active in") ─
  const myEvents = [
    ...myFiles.map((f) => ({ t: ts(f.uploaded_at), pid: f.project_id })),
    ...myReqs.map((r) => ({ t: ts(r.submitted_at), pid: r.project_id })),
    ...branchChanges.map((c) => ({ t: ts(c.created_at), pid: c.project_id })),
  ].filter((e) => e.t != null);
  const eventTimes = myEvents.map((e) => e.t);

  // ── Pipeline: Drafts → In review → Merged ────────────────────────────
  const draftCounts = {};
  for (const c of branchChanges) {
    const k = KIND_META[c.kind] ? c.kind : 'edit';
    draftCounts[k] = (draftCounts[k] || 0) + 1;
  }
  const breakdown = Object.entries(draftCounts)
    .map(([k, v]) => ({ label: KIND_META[k].label, value: v, cat: KIND_META[k].cat }))
    .sort((a, b) => b.value - a.value);

  const decidedTime = (r) => ts(r.decided_at) ?? ts(r.submitted_at);
  const mergedThisWeek = myApproved.filter((r) => (decidedTime(r) ?? 0) >= week1).length;
  const mergedPrevWeek = myApproved.filter((r) => { const t = decidedTime(r) ?? 0; return within(t, week2, week1); }).length;
  const mergedDelta = mergedPrevWeek ? (mergedThisWeek - mergedPrevWeek) / mergedPrevWeek : 0;
  const oldestOpen = myOpenReqs.reduce((min, r) => { const t = ts(r.submitted_at) ?? Infinity; return t < min ? t : min; }, Infinity);

  const pipeline = {
    drafts: {
      count: branchChanges.length,
      detail: branchChanges.length ? 'ready to send' : 'nothing staged',
      breakdown,
    },
    inReview: {
      count: myOpenReqs.length,
      detail: myOpenReqs.length ? 'opened by you' : 'nothing in review',
      oldest: myOpenReqs.length && oldestOpen !== Infinity ? `oldest ${relTime(oldestOpen)}` : '',
    },
    merged: { count: mergedThisWeek, detail: 'this week', delta: mergedDelta, prev: mergedPrevWeek },
  };

  // ── KPI tiles ────────────────────────────────────────────────────────
  const myUploadTimes = myFiles.map((f) => ts(f.uploaded_at)).filter((t) => t != null);
  const filesLast7 = myUploadTimes.filter((t) => t >= week1).length;
  const filesPrev7 = myUploadTimes.filter((t) => within(t, week2, week1)).length;
  const spark = [];
  for (let i = 6; i >= 0; i--) {
    const lo = startOfDay(now - i * DAY);
    spark.push(myUploadTimes.filter((t) => within(t, lo, lo + DAY)).length);
  }

  const projThis = new Set(myEvents.filter((e) => e.t >= week1 && e.pid).map((e) => e.pid)).size;
  const projPrev = new Set(myEvents.filter((e) => within(e.t, week2, week1) && e.pid).map((e) => e.pid)).size;

  const kpis = {
    filesSynced: {
      value: filesLast7,
      prev: filesPrev7,
      spark,
      sub: {
        added: branchChanges.filter((c) => c.kind === 'add').length,
        edited: branchChanges.filter((c) => c.kind === 'edit' || c.kind === 'replace').length,
        removed: branchChanges.filter((c) => c.kind === 'delete').length,
      },
    },
    projectsActive: {
      value: projThis,
      prev: projPrev,
      detail: projThis ? 'where you contributed' : 'no projects this week',
    },
    invitesSent: {
      value: pendingInvites.length,
      prev: 0,
      detail: pendingInvites.length ? 'pending acceptance' : 'none pending',
    },
  };

  // ── Time series ──────────────────────────────────────────────────────
  const heatmap = buildHeatmap(eventTimes, now);
  const streak = buildStreak(eventTimes, now);
  const whenIWork = buildWhenIWork(eventTimes, now);

  // ── People I worked with (everyone else active in my projects) ───────
  const otherIds = new Set();
  for (const f of allFiles) if (f.uploaded_by && f.uploaded_by !== userId) otherIds.add(f.uploaded_by);
  for (const r of allReqs) if (r.author_id && r.author_id !== userId) otherIds.add(r.author_id);
  let profilesById = new Map();
  if (otherIds.size) {
    const profRes = await supabase.rpc('get_member_profiles', { p_user_ids: [...otherIds] }).then(ok, fail);
    profilesById = new Map((profRes?.data || []).map((p) => [p.id, p]));
  }
  const collaborators = [...otherIds].map((uid) => {
    const theirFiles = allFiles.filter((f) => f.uploaded_by === uid);
    const theirReqs = allReqs.filter((r) => r.author_id === uid);
    const name = displayName(profilesById.get(uid));
    const lastFile = theirFiles[0]; // files come newest-first
    const lastReq = theirReqs[0];
    const lastFileT = lastFile ? (ts(lastFile.uploaded_at) ?? 0) : 0;
    const lastReqT = lastReq ? (ts(lastReq.submitted_at) ?? 0) : 0;
    let lastTouch = 'No recent activity'; let lastAgo = ''; let pid = null;
    if (lastFileT >= lastReqT && lastFile) {
      lastTouch = `Added ${lastFile.name}`; lastAgo = relTime(lastFileT); pid = lastFile.project_id;
    } else if (lastReq) {
      lastTouch = `Opened "${lastReq.title}"`; lastAgo = relTime(lastReqT); pid = lastReq.project_id;
    }
    return {
      userId: uid,
      name,
      initials: initialsOf(name),
      avatarUrl: profilesById.get(uid)?.avatar_url || null,
      color: colorForId(uid),
      project: pid ? (projectNameById.get(pid) || '') : '',
      sharedFiles: theirFiles.length,
      reviewsTraded: theirReqs.length,
      lastTouch,
      lastAgo,
      online: false,
    };
  })
    .sort((a, b) => (b.sharedFiles + b.reviewsTraded) - (a.sharedFiles + a.reviewsTraded))
    .slice(0, 6);

  // ── Files I touched most (my edits/replaces/deletes, queued or in review) ─
  const editCounts = new Map();
  const bump = (fid) => { if (fid) editCounts.set(fid, (editCounts.get(fid) || 0) + 1); };
  for (const c of branchChanges) bump(c.target_file_id);
  for (const fid of myOpenItemTargets) bump(fid);
  let topFiles = [...editCounts.entries()]
    .map(([fid, edits]) => { const f = fileById.get(fid); return f ? { name: f.name, project: projectNameById.get(f.project_id) || '', edits } : null; })
    .filter(Boolean)
    .sort((a, b) => b.edits - a.edits)
    .slice(0, 5);
  if (topFiles.length === 0) {
    topFiles = myFiles.slice(0, 5).map((f) => ({ name: f.name, project: projectNameById.get(f.project_id) || '', edits: 1 }));
  }

  return { pipeline, kpis, heatmap, collaborators, streak, whenIWork, topFiles };
}
