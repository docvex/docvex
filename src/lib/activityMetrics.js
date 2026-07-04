// Personal activity metrics for the Activity page (/).
//
// Originally ported from the Claude Design handoff
// (docvex-activity-notification-redesign) and wired to the cloud file /
// branching tables — all dropped in migration 031. The metrics now derive
// from the LOCAL ACTIVITY LOG (lib/activityLog.js): every file action
// (create / import / edit / rename / move / delete / restore) and AI assist
// (text extract, captions, generated document, PDF export) recorded via
// notify()'s `payload.activity` tagging. Scope = the signed-in user on this
// machine, across all their projects — which is exactly what the strip is
// about: "my progress".
//
// Everything is computed synchronously from localStorage; the function stays
// async so the component's loading state and any future remote source keep
// working unchanged.

import { listActivity, activityActionLabel } from './activityLog';

const DAY = 86400000;

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

// Action families used by the verb tiles and the file-KPI sub-line.
const CREATE_ACTIONS = new Set(['create', 'create-folder']);
const IMPORT_ACTIONS = new Set(['import']);
const EDIT_ACTIONS = new Set(['edit', 'rename', 'move']);
const REMOVE_ACTIONS = new Set(['delete', 'purge']);
const AI_ACTIONS = new Set(['extract-text', 'captions', 'generate-doc', 'export-pdf']);

// Names of every file an event touched (single fileName, or a batch's list).
function namesOf(e) {
  if (Array.isArray(e.files) && e.files.length) return e.files;
  return e.fileName ? [e.fileName] : [];
}

export async function fetchPersonalActivityMetrics({ userId }) {
  if (!userId) return null;

  const now = Date.now();
  const week1 = now - 7 * DAY;
  const week2 = now - 14 * DAY;
  const within = (t, lo, hi) => t >= lo && t < hi;

  // ── Source: the local activity log (newest-first, ~90 days) ───────────
  const events = listActivity(userId)
    .map((e) => ({ ...e, t: ts(e.at) }))
    .filter((e) => e.t != null);
  const eventTimes = events.map((e) => e.t);

  // ── KPI tiles ──────────────────────────────────────────────────────────
  // Files I touched — UNIQUE file names across all events in the window.
  const touchedIn = (lo, hi) => {
    const names = new Set();
    for (const e of events) if (within(e.t, lo, hi)) for (const n of namesOf(e)) names.add(n.toLowerCase());
    return names.size;
  };
  const spark = [];
  for (let i = 6; i >= 0; i--) {
    const lo = startOfDay(now - i * DAY);
    spark.push(events.filter((e) => within(e.t, lo, lo + DAY)).length);
  }
  const inWindow = (set, lo, hi) => events
    .filter((e) => set.has(e.action) && within(e.t, lo, hi))
    .reduce((s, e) => s + (e.count || 1), 0);

  const aiThis = events.filter((e) => AI_ACTIONS.has(e.action) && e.t >= week1).length;
  const aiPrev = events.filter((e) => AI_ACTIONS.has(e.action) && within(e.t, week2, week1)).length;

  const projThis = new Set(events.filter((e) => e.t >= week1 && e.projectId).map((e) => e.projectId)).size;
  const projPrev = new Set(events.filter((e) => within(e.t, week2, week1) && e.projectId).map((e) => e.projectId)).size;

  const kpis = {
    filesTouched: {
      value: touchedIn(week1, now + 1),
      prev: touchedIn(week2, week1),
      spark,
      sub: {
        added: inWindow(CREATE_ACTIONS, week1, now + 1) + inWindow(IMPORT_ACTIONS, week1, now + 1),
        edited: inWindow(EDIT_ACTIONS, week1, now + 1),
        removed: inWindow(REMOVE_ACTIONS, week1, now + 1),
      },
    },
    projectsActive: {
      value: projThis,
      prev: projPrev,
      detail: projThis ? 'where you made progress' : 'no projects this week',
    },
    aiAssists: {
      value: aiThis,
      prev: aiPrev,
      detail: aiThis ? 'extracts · captions · documents' : 'none this week',
    },
  };

  // ── This week at a glance (hero) ─────────────────────────────────────
  // All Monday-based so the headline, verb tiles and best/quiet day agree.
  // Verbs use the activity log's real action vocabulary:
  //   Created  = files & folders I created this week
  //   Imported = files I brought in (import / paste / folder import)
  //   Edited   = saves the folder watcher caught (+ renames / moves)
  //   AI       = extracts, captions and generated documents
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const monThis = mondayStart(now);
  const monNext = monThis + 7 * DAY;
  const monPrev = monThis - 7 * DAY;

  const eventsThisWeek = eventTimes.filter((t) => within(t, monThis, monNext)).length;
  const eventsPrevWeek = eventTimes.filter((t) => within(t, monPrev, monThis)).length;

  const dayCounts = new Array(7).fill(0);
  for (const t of eventTimes) if (within(t, monThis, monNext)) dayCounts[weekdayMon(t)] += 1;
  const todayWd = weekdayMon(now);
  let bestI = 0; let quietI = 0;
  for (let i = 0; i <= todayWd; i += 1) {
    if (dayCounts[i] > dayCounts[bestI]) bestI = i;
    if (dayCounts[i] < dayCounts[quietI]) quietI = i;
  }

  // 14-day daily series (oldest → today) for the area trend.
  const trend = []; const trendDays = [];
  for (let i = 13; i >= 0; i -= 1) {
    const lo = startOfDay(now - i * DAY);
    trend.push(eventTimes.filter((t) => within(t, lo, lo + DAY)).length);
    trendDays.push(WEEKDAYS[weekdayMon(lo)]);
  }

  const thisWeek = {
    total: eventsThisWeek,
    prev: eventsPrevWeek,
    bestDay: { label: WEEKDAYS[bestI], value: dayCounts[bestI] },
    quietDay: { label: WEEKDAYS[quietI], value: dayCounts[quietI] },
    verbs: [
      { label: 'Created', value: inWindow(CREATE_ACTIONS, monThis, monNext), cat: 'file', sub: 'files & folders' },
      { label: 'Imported', value: inWindow(IMPORT_ACTIONS, monThis, monNext), cat: 'project', sub: 'files' },
      { label: 'Edited', value: inWindow(EDIT_ACTIONS, monThis, monNext), cat: 'member', sub: 'saves & moves' },
      { label: 'AI assists', value: events.filter((e) => AI_ACTIONS.has(e.action) && within(e.t, monThis, monNext)).length, cat: 'update', sub: 'extracts · docs' },
    ],
    trend,
    days: trendDays,
  };

  // ── Time series ──────────────────────────────────────────────────────
  const heatmap = buildHeatmap(eventTimes, now);
  const streak = buildStreak(eventTimes, now);
  const whenIWork = buildWhenIWork(eventTimes, now);

  // ── What I do most (per-action breakdown, 28 days) ────────────────────
  const since28 = now - 28 * DAY;
  const actionCounts = new Map();
  for (const e of events) {
    if (e.t < since28) continue;
    const weight = IMPORT_ACTIONS.has(e.action) ? (e.count || 1) : 1;
    actionCounts.set(e.action, (actionCounts.get(e.action) || 0) + weight);
  }
  const actionBreakdown = [...actionCounts.entries()]
    .map(([action, count]) => ({ action, label: activityActionLabel(action), count }))
    .sort((a, b) => b.count - a.count);

  // ── Files I touched most (whole log, ~90 days) ────────────────────────
  const fileCounts = new Map(); // lower-name → { name, project, edits }
  for (const e of events) {
    for (const n of namesOf(e)) {
      const key = n.toLowerCase();
      const rec = fileCounts.get(key) || { name: n, project: e.projectName || '', edits: 0 };
      rec.edits += 1;
      if (!rec.project && e.projectName) rec.project = e.projectName;
      fileCounts.set(key, rec);
    }
  }
  const topFiles = [...fileCounts.values()]
    .sort((a, b) => b.edits - a.edits)
    .slice(0, 5);

  return { thisWeek, kpis, heatmap, streak, whenIWork, actionBreakdown, topFiles };
}
