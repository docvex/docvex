// Legal Newsfeed — the desktop app's half of the job.
//
// legislatie.just.ro refuses Supabase's servers (it geo-checks callers and
// drops every connection from the eu-west-1 region), so the part of the feed
// that READS the portal runs here, over the user's own connection, through the
// same main-process channel the Legislation tab uses. The judging — the free
// rules, the screening model, the summaries — stays in the `legal-feed-sync`
// Edge Function; this module only fetches and hands over.
//
// One run:
//   1. `plan` — the function says where to start in each year's Monitorul
//      Oficial (a few issues behind the last one found) and takes a short
//      lease, so two open apps don't both walk. With nothing remembered, the
//      start is found here: the issue about a week back.
//   2. walk issue by issue ("Monitorul Oficial nr. N din", and its "bis"),
//      until three numbers in a row are empty — the portal's own listing of
//      recent acts is unstable and misses acts; its title search isn't;
//   3. `submit` everything in ONE request, and the function judges it in the
//      background.
//
// Who runs it: app admins, while the desktop app is open (every 3 h at most —
// `maybeRunLegalFeedSync`). The feed is global and read as the law, so the
// function accepts submissions from admins only; for anyone else this module
// does nothing at all.

import { supabase } from './supabaseClient';
import { isElectron, legislationSearch } from './platform';

const FUNCTION = 'legal-feed-sync';
const EVERY_MS = 3 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;        // after a failed run
const LAST_KEY = 'docvex:legal-feed-sync:last';
const STOP_AFTER_EMPTY = 3;
const MAX_ISSUES = 60;
const FIRST_RUN_BACK = 12;              // ≈ a week of issues
const TEXT_CHARS = 60000;               // what is sent of an act's text
const ISSUES_PER_DAY = 3;               // Part I runs ~800 issues a year — for a first guess only

const MO_RE = /Monitorul Oficial\s+nr\.\s*([\d.]+)(?:\s*bis)?\s+din\s+\d{1,2}\s+\S+\s+(\d{4})/i;

// The portal is one old server that answers 503 when it is busy — a walk is a
// few dozen searches in a row, and one refused request must not sink the run.
// So every search is paced a little and a busy / unreachable answer is tried
// again after a growing pause; only a portal that stays down fails the run.
const PACE_MS = 150;
const RETRY_WAITS_MS = [2000, 5000, 12000, 25000];
const TRANSIENT = /^(http_5\d\d|http_429|timeout|unreachable)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(query) {
  for (let attempt = 0; ; attempt += 1) {
    await sleep(PACE_MS);
    const res = await legislationSearch(query);
    if (res?.ok) return res;
    const error = res?.error || 'portal_unreachable';
    if (!TRANSIENT.test(error) || attempt >= RETRY_WAITS_MS.length) throw new Error(error);
    await sleep(RETRY_WAITS_MS[attempt]);
  }
}

// Every act printed in issue `n` of `year` (with its "bis" supplement). The
// title search also finds acts that merely CITE that issue in their own title,
// so a record is kept only when the issue it was printed in is `n`.
async function issue(year, n) {
  const out = new Map();
  for (const titlu of [`Monitorul Oficial nr. ${n} din`, `Monitorul Oficial nr. ${n} bis din`]) {
    for (let page = 1; page <= 10; page += 1) {
      const res = await search({ titlu, an: String(year), page, perPage: 10 });
      const rows = res.records || [];
      for (const r of rows) {
        const m = MO_RE.exec(r.titlu || '');
        if (m && Number(m[1].replace(/\./g, '')) === n && m[2] === String(year) && r.link) out.set(r.link, r);
      }
      if (rows.length < 10) break;
    }
  }
  return [...out.values()];
}

// Nothing remembered: a first guess from the date (Part I runs about three
// issues a working day), stepped back until an issue answers, then a week
// behind it. The walk forward is what finds the actual end.
async function firstStart(year) {
  const now = new Date();
  if (year < now.getFullYear()) return 1;
  const day = Math.floor((now - new Date(year, 0, 1)) / 86400000) + 1;
  let n = Math.max(1, Math.round(day * ISSUES_PER_DAY));
  for (let i = 0; i < 25 && n > 1; i += 1, n = Math.max(1, n - 8)) {
    if ((await issue(year, n)).length) break;
  }
  return Math.max(1, n - FIRST_RUN_BACK);
}

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke(FUNCTION, { body });
  if (error) throw error;
  return data;
}

/**
 * One run, start to finish. Resolves a small report; throws on a failure the
 * caller should retry later. `dryRun` asks the function for its decisions
 * without writing or summarising (it still makes one screening call).
 */
export async function runLegalFeedSync({ dryRun = false } = {}) {
  if (!isElectron) return { ok: false, skipped: 'web' };
  const plan = await invoke({ action: 'plan' });
  if (!plan?.ok) return { ok: false, skipped: plan?.error || 'plan_failed' };
  if (plan.busy) return { ok: true, skipped: 'busy' };

  const reports = [];
  try {
    for (const { year, start } of plan.years || []) {
      reports.push(await walkYear(year, start, dryRun));
    }
  } catch (err) {
    // Hand the lease back, so the retry half an hour from now isn't blocked.
    await invoke({ action: 'release' }).catch(() => {});
    throw err;
  }
  return { ok: true, reports };
}

// One year's new issues, walked and submitted in one request.
async function walkYear(year, start, dryRun) {
  {
    let n = start ?? (await firstStart(year));
    let found = start ? start - 1 : 0;
    let empties = 0;
    const records = [];
    for (let steps = 0; steps < MAX_ISSUES; steps += 1, n += 1) {
      const got = await issue(year, n);
      if (got.length) {
        records.push(...got);
        found = Math.max(found, n);
        empties = 0;
      } else if (n > found && (empties += 1) >= STOP_AFTER_EMPTY) {
        break;
      }
    }
    const res = await invoke({
      action: 'submit',
      year,
      lastIssue: found,
      final: true,
      dryRun,
      records: records.map((r) => ({
        link: r.link,
        tipAct: r.tipAct,
        numar: r.numar,
        emitent: r.emitent,
        titlu: r.titlu,
        dataVigoare: r.dataVigoare,
        text: String(r.text || '').slice(0, TEXT_CHARS),
      })),
    });
    return { year, issuesTo: found, records: records.length, ...(dryRun ? res : { started: !!res?.started }) };
  }
}

// ── The schedule ──────────────────────────────────────────────────────────
// Checked every half hour while the app is open; runs when three hours have
// passed since the last run on this machine (half an hour after a failure).
// Admin-only: everyone else is told no once per session and never asks again.
let adminCheck = null;
let running = false;

function lastRun() {
  try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch { return 0; }
}
function setLastRun(t) {
  try { localStorage.setItem(LAST_KEY, String(t)); } catch { /* storage unavailable */ }
}

export async function maybeRunLegalFeedSync() {
  if (!isElectron || running) return null;
  if (Date.now() - lastRun() < EVERY_MS) return null;
  if (!adminCheck) {
    adminCheck = supabase.rpc('is_app_admin').then(({ data }) => data === true).catch(() => false);
  }
  if (!(await adminCheck)) return null;
  running = true;
  try {
    const report = await runLegalFeedSync();
    setLastRun(Date.now());
    return report;
  } catch (err) {
    setLastRun(Date.now() - EVERY_MS + RETRY_MS);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    running = false;
  }
}

/** Forget the admin answer (sign-out / account switch). */
export function resetLegalFeedSync() {
  adminCheck = null;
}
