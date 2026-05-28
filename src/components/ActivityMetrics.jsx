import React, { useEffect, useState } from 'react';
import { fetchPersonalActivityMetrics } from '../lib/activityMetrics';
import Tooltip from './Tooltip';
import './ActivityMetrics.css';

// Personal activity metrics for the Activity page (/). Ported from the Claude
// Design handoff (docvex-activity-notification-redesign) and wired to real
// data via lib/activityMetrics.js. Scope = signed-in user across all their
// projects ("my activity").
//
// Layout (all charts inline SVG / CSS — no chart lib):
//   Row 1 (hero) : This week at a glance — headline + verb tiles + 14-day trend
//   Row 2 (3col) : File-activity KPIs | 28-day heatmap | People I worked with
//   Row 3 (3col) : Streak | When I work (24h) | Files I touched

// ── Inline icons (docvex stroke style) ────────────────────────────────
const ic = (children, size = 13) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IconFiles = ic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>);
const IconFile = ic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>, 11);
const IconSend = ic(<><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>, 11);
const ArrowUp = ic(<polyline points="6 15 12 9 18 15" />, 9);
const ArrowDown = ic(<polyline points="6 9 12 15 18 9" />, 9);
const GlyphPipeline = ic(<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />, 14);
const GlyphFlame = ic(<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />, 14);
const GlyphHeatmap = ic(<><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>);
const GlyphPeople = ic(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>);
const GlyphClock = ic(<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>);

// ── Helpers ───────────────────────────────────────────────────────────
function pctDelta(curr, prev) { if (!prev) return 0; return (curr - prev) / prev; }
function fmtPct(d) { if (d === 0 || Number.isNaN(d)) return '0%'; return `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`; }
function deltaClass(d) { if (!d || Number.isNaN(d)) return 'is-flat'; return d > 0 ? 'is-up' : 'is-down'; }

function Sparkline({ values, w = 160, h = 28 }) {
  if (!values || values.length === 0) return null;
  const max = Math.max(...values, 1);
  const step = w / (values.length - 1 || 1);
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 4) - 2]);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="m-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} />
      <circle className="spark-dot" cx={lx} cy={ly} r="2.5" />
    </svg>
  );
}

function Delta({ value }) {
  return (
    <span className={`m-delta ${deltaClass(value)}`}>
      {value > 0 ? ArrowUp : value < 0 ? ArrowDown : null}
      {fmtPct(value)}
    </span>
  );
}

// ── HERO: This week at a glance ───────────────────────────────────────
// Panoramic personal summary: headline total + 2×2 verb tiles on the left,
// a 14-day area trend (with a "this week" divider) on the right.
function ThisWeekCard({ m }) {
  const w = m.thisWeek;
  const delta = pctDelta(w.total, w.prev);

  // 14-day area chart geometry — normalized viewBox so it scales fluidly.
  const V_W = 520; const V_H = 160; const PAD_T = 16; const PAD_B = 8;
  const max = Math.max(...w.trend, 1);
  const step = V_W / (w.trend.length - 1 || 1);
  const pts = w.trend.map((v, i) => [i * step, PAD_T + (1 - v / max) * (V_H - PAD_T - PAD_B)]);
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${V_W} ${V_H} L0 ${V_H} Z`;

  const todayIdx = w.trend.length - 1;
  const [todayX, todayY] = pts[todayIdx];
  const bestIdx = w.trend.reduce((best, v, i) => (v > w.trend[best] ? i : best), 0);
  const [bestX, bestY] = pts[bestIdx];
  const gridY = (frac) => PAD_T + (1 - frac) * (V_H - PAD_T - PAD_B);
  const weekCutX = 7 * step;

  return (
    <div className="m-card">
      <div className="m-card-head">
        <h3 className="m-card-title"><span className="m-card-title-icon">{GlyphPipeline}</span>This week at a glance</h3>
        <span className="m-card-period">Mon – today</span>
      </div>

      <div className="m-week">
        {/* LEFT — headline + verb tiles */}
        <div className="m-week-left">
          <div className="m-week-hero">
            <div className="m-week-hero-row">
              <span className="m-week-hero-value">{w.total}</span>
              <span className="m-week-hero-unit">things I did</span>
              <Delta value={delta} />
            </div>
            <span className="m-week-hero-prev">
              Up from <strong>{w.prev}</strong> last week · Best day <strong>{w.bestDay.label}</strong> ({w.bestDay.value} event{w.bestDay.value === 1 ? '' : 's'})
            </span>
          </div>

          <div className="m-week-verbs">
            {w.verbs.map((v) => (
              <div key={v.label} className="m-week-verb" data-cat={v.cat}>
                <div className="m-week-verb-row">
                  <span className="m-week-verb-value">{v.value}</span>
                  <span className="m-week-verb-label">{v.label}</span>
                </div>
                <span className="m-week-verb-sub">{v.sub}</span>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT — 14-day area trend */}
        <div className="m-week-right">
          <div className="m-week-right-head">
            <h4>Last 14 days</h4>
            <span className="m-week-right-head-foot">
              Peak <strong>{w.bestDay.value}</strong> · Quiet <strong>{w.quietDay.value}</strong>
            </span>
          </div>

          <div className="m-week-chart">
            <svg viewBox={`0 0 ${V_W} ${V_H + 4}`} preserveAspectRatio="none">
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <line key={f} className="area-grid" x1="0" x2={V_W} y1={gridY(f)} y2={gridY(f)} />
              ))}
              <line className="area-week-cut" x1={weekCutX} x2={weekCutX} y1={PAD_T - 6} y2={V_H} />
              <text className="area-week-cut-label" x={weekCutX + 6} y={PAD_T - 4}>This week →</text>
              <path className="area-fill" d={areaPath} />
              <path className="area-line" d={linePath} />
              <circle className="area-dot-best" cx={bestX} cy={bestY} r="4.5" />
              <text className="area-callout-value" x={bestX} y={bestY - 10} textAnchor="middle">{w.trend[bestIdx]}</text>
              <circle className="area-dot" cx={todayX} cy={todayY} r="4.5" />
              <text className="area-callout" x={todayX} y={todayY - 12} textAnchor="end" dx="-6">Today</text>
            </svg>
          </div>

          <div className="m-week-axis" aria-hidden="true">
            {w.days.map((d, i) => (
              <span key={i} className={i === todayIdx ? 'is-today' : ''}>{i === todayIdx ? 'Now' : d[0]}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Streak counter ────────────────────────────────────────────────────
function StreakCard({ m }) {
  const s = m.streak;
  const todayIdx = s.last14.length - 1;
  return (
    <div className="m-card">
      <div className="m-card-head">
        <h3 className="m-card-title"><span className="m-card-title-icon">{GlyphFlame}</span>Current streak</h3>
        <span className="m-card-period">14 d</span>
      </div>
      <div className="m-streak-body">
        <div className="m-streak-hero">
          <span className="m-streak-value">{s.current}</span>
          <span className="m-streak-unit">day{s.current === 1 ? '' : 's'} active</span>
        </div>
        <div className="m-streak-dots" aria-label="Last 14 days">
          {s.last14.map((on, i) => (
            <Tooltip key={i} content={`${i === todayIdx ? 'Today' : `${todayIdx - i} d ago`} — ${on ? 'active' : 'idle'}`}>
              <span className={`m-streak-dot${on ? ' is-on' : ''}${i === todayIdx ? ' is-today' : ''}`} />
            </Tooltip>
          ))}
        </div>
        <div className="m-streak-foot">
          <span>Longest <strong>{s.longest} days</strong></span>
          <span>Keep it going →</span>
        </div>
      </div>
    </div>
  );
}

// ── KPI stack ─────────────────────────────────────────────────────────
function KpiStackCard({ m }) {
  const k = m.kpis;
  const filesDelta = pctDelta(k.filesSynced.value, k.filesSynced.prev);
  const projDelta = pctDelta(k.projectsActive.value, k.projectsActive.prev);
  const sub = k.filesSynced.sub;
  return (
    <div className="m-card">
      <div className="m-card-head">
        <h3 className="m-card-title"><span className="m-card-title-icon">{IconFiles}</span>My file activity</h3>
        <span className="m-card-period">7 days</span>
      </div>
      <div className="m-kpis">
        <div className="m-kpi">
          <span className="m-kpi-label">Files I synced</span>
          <span className="m-kpi-value">{k.filesSynced.value}</span>
          <span className="m-kpi-meta"><Delta value={filesDelta} /></span>
          <span className="m-kpi-sub">
            <strong>{sub.added}</strong> added · <strong>{sub.edited}</strong> edited · <strong>{sub.removed}</strong> removed
          </span>
          <Sparkline values={k.filesSynced.spark} />
        </div>
        <div className="m-kpi">
          <span className="m-kpi-label">Projects active in</span>
          <span className="m-kpi-value">{k.projectsActive.value}</span>
          <span className="m-kpi-meta"><Delta value={projDelta} /></span>
          <span className="m-kpi-sub">{k.projectsActive.detail}</span>
        </div>
        <div className="m-kpi">
          <span className="m-kpi-label">Invites I sent</span>
          <span className="m-kpi-value">{k.invitesSent.value}</span>
          <span className="m-kpi-meta">
            {k.invitesSent.prev === 0
              ? <span className="m-delta is-flat">{k.invitesSent.value ? 'new' : 'none'}</span>
              : <Delta value={pctDelta(k.invitesSent.value, k.invitesSent.prev)} />}
          </span>
          <span className="m-kpi-sub">{k.invitesSent.detail}</span>
        </div>
      </div>
    </div>
  );
}

// ── 28-day heatmap ────────────────────────────────────────────────────
function HeatmapCard({ m }) {
  const h = m.heatmap;
  const weekLabels = ['4w', '3w', '2w', 'now'];
  const all = h.weeks.flat();
  const max = Math.max(...all, 1);
  const level = (v) => {
    if (v === 0) return 0;
    const r = v / max;
    if (r > 0.75) return 4;
    if (r > 0.50) return 3;
    if (r > 0.25) return 2;
    return 1;
  };
  const total = all.reduce((a, b) => a + b, 0);
  const lastWeekIdx = h.weeks.length - 1;

  // First cell's date = Monday of the week 3 weeks before this one (matches how
  // the grid is built in lib/activityMetrics.js). Computed here so each square
  // can show its real calendar date regardless of the data payload.
  const gridStart = new Date();
  gridStart.setHours(0, 0, 0, 0);
  gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7) - 21);

  return (
    <div className="m-card">
      <div className="m-card-head">
        <h3 className="m-card-title"><span className="m-card-title-icon">{GlyphHeatmap}</span>My activity heatmap</h3>
        <span className="m-card-period">{total} events · 28 d</span>
      </div>
      <div className="m-heatmap-body">
        {/* Header row: empty corner + day-of-week labels across the top. */}
        <span />
        {h.rows.map((d, i) => <span key={`d${i}`} className="m-heat-col-label">{d}</span>)}
        {/* One row per week (oldest → this week), week label on the left. */}
        {h.weeks.map((week, wIdx) => (
          <React.Fragment key={wIdx}>
            <span className="m-heat-row-label">{weekLabels[wIdx]}</span>
            {h.rows.map((_, rIdx) => {
              const v = week[rIdx] || 0;
              const isToday = wIdx === lastWeekIdx && rIdx === h.todayRowIdx;
              const dt = new Date(gridStart);
              dt.setDate(dt.getDate() + wIdx * 7 + rIdx);
              const weekday = dt.toLocaleDateString(undefined, { weekday: 'long' });
              const dateStr = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              return (
                <Tooltip key={rIdx} content={`${weekday} · ${dateStr} · ${v} event${v === 1 ? '' : 's'}`}>
                  <div className={`m-heat-cell${isToday ? ' is-today' : ''}`} data-level={level(v)} />
                </Tooltip>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="m-heat-footer">
        <span>Less</span>
        <div className="m-heat-scale">
          {[0, 1, 2, 3, 4].map((lvl) => <span key={lvl} className="m-heat-scale-swatch m-heat-cell" data-level={lvl} />)}
        </div>
        <span>More</span>
      </div>
    </div>
  );
}

// ── People I worked with ──────────────────────────────────────────────
function Avatar({ p }) {
  return (
    <Tooltip content={p.name}>
      <span className={`m-people-avatar${p.online ? ' is-online' : ''}`} style={{ background: p.avatarUrl ? 'var(--bg-elevated)' : p.color }}>
        {p.avatarUrl ? <img src={p.avatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} /> : p.initials}
      </span>
    </Tooltip>
  );
}
function PeopleCard({ m }) {
  const people = m.collaborators;
  const totalShared = people.reduce((s, p) => s + p.sharedFiles, 0);
  const totalReviews = people.reduce((s, p) => s + p.reviewsTraded, 0);
  return (
    <div className="m-card">
      <div className="m-card-head">
        <h3 className="m-card-title"><span className="m-card-title-icon">{GlyphPeople}</span>People I worked with</h3>
        <span className="m-card-period">{people.length} teammate{people.length === 1 ? '' : 's'}</span>
      </div>
      {people.length === 0 ? (
        <div className="m-empty">No teammates active in your projects yet.</div>
      ) : (
        <div className="m-people-body">
          <div className="m-people-summary">
            <div className="m-people-stack">{people.slice(0, 4).map((p) => <Avatar key={p.userId} p={p} />)}</div>
            <span className="m-people-summary-text">
              Across <strong>{totalShared}</strong> shared files and <strong>{totalReviews}</strong> change requests with your team
            </span>
          </div>
          <div className="m-people-list">
            {people.map((p) => (
              <div key={p.userId} className="m-people-row" style={{ '--project-color': 'var(--accent)' }}>
                <Avatar p={p} />
                <div className="m-people-meta">
                  <div className="m-people-name-row">
                    <span className="m-people-name">{p.name}</span>
                    {p.project && <span className="m-people-project">{p.project}</span>}
                  </div>
                  <span className="m-people-last">{p.lastAgo ? <><strong>{p.lastTouch}</strong> · {p.lastAgo}</> : p.lastTouch}</span>
                </div>
                <div className="m-people-right">
                  {p.sharedFiles > 0 && (
                    <Tooltip content={`${p.sharedFiles} shared file${p.sharedFiles === 1 ? '' : 's'}`}>
                      <span className="m-people-stat" data-type="file">{IconFile}{p.sharedFiles}</span>
                    </Tooltip>
                  )}
                  {p.reviewsTraded > 0 && (
                    <Tooltip content={`${p.reviewsTraded} change request${p.reviewsTraded === 1 ? '' : 's'}`}>
                      <span className="m-people-stat" data-type="review">{IconSend}{p.reviewsTraded}</span>
                    </Tooltip>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── When I work — 24h histogram ───────────────────────────────────────
function WhenIWorkCard({ m }) {
  const w = m.whenIWork;
  const max = Math.max(...w.hours, 1);
  const total = w.hours.reduce((a, b) => a + b, 0);
  const labels = ['00', '', '', '', '', '', '06', '', '', '', '', '', '12', '', '', '', '', '', '18', '', '', '', '', '23'];
  return (
    <div className="m-card m-card-when">
      <div className="m-card-head">
        <h3 className="m-card-title"><span className="m-card-title-icon">{GlyphClock}</span>When I work</h3>
        <span className="m-card-period">{total} events · 28 d</span>
      </div>
      <div className="m-when-body">
        <div className="m-when-bars">
          {w.hours.map((v, i) => {
            const heightPct = (v / max) * 100;
            const isPeak = v === max && v > 0;
            return (
              <Tooltip key={i} content={`${String(i).padStart(2, '0')}:00 — ${v} event${v === 1 ? '' : 's'}`}>
                <span className={`m-when-bar${isPeak ? ' is-peak' : ''}${v > 0 ? ' is-active' : ''}`}
                  style={{ height: `${Math.max(heightPct, v ? 8 : 0)}%` }} />
              </Tooltip>
            );
          })}
        </div>
        <div className="m-when-axis" aria-hidden="true">{labels.map((l, i) => <span key={i}>{l}</span>)}</div>
        <div className="m-when-foot">
          <div className="m-when-stat"><span className="m-when-stat-label">Peak hours</span><span className="m-when-stat-value">{w.peak}</span></div>
          <div className="m-when-stat"><span className="m-when-stat-label">Avg / day</span><span className="m-when-stat-value">{w.avgPerDay}</span></div>
        </div>
      </div>
    </div>
  );
}

// ── Files I touched ───────────────────────────────────────────────────
function TopFilesCard({ m }) {
  const max = Math.max(...m.topFiles.map((f) => f.edits), 1);
  return (
    <div className="m-card">
      <div className="m-card-head">
        <h3 className="m-card-title"><span className="m-card-title-icon">{IconFiles}</span>Files I touched</h3>
        <span className="m-card-period">recent</span>
      </div>
      {m.topFiles.length === 0 ? (
        <div className="m-empty">No file edits yet.</div>
      ) : (
        <div className="m-files-body">
          {m.topFiles.map((f) => (
            <Tooltip key={`${f.project}/${f.name}`} content={`${f.name} — ${f.edits} edit${f.edits === 1 ? '' : 's'}`}>
            <div className="m-file-row">
              <div className="m-file-meta">
                <span className="m-file-name">{f.name}</span>
                <span className="m-file-project">{f.project}</span>
              </div>
              <span className="m-file-edits">{f.edits}</span>
              <div className="m-file-bar"><span style={{ width: `${(f.edits / max) * 100}%` }} /></div>
            </div>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Container ─────────────────────────────────────────────────────────
export default function ActivityMetrics({ userId }) {
  const [metrics, setMetrics] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    setState('loading');
    fetchPersonalActivityMetrics({ userId })
      .then((m) => { if (cancelled) return; if (m) { setMetrics(m); setState('ready'); } else setState('error'); })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [userId]);

  if (!userId) return null;
  if (state === 'loading') return <div className="metrics-status">Loading your activity…</div>;
  if (state === 'error' || !metrics) return <div className="metrics-status">Couldn’t load activity metrics. Try again in a moment.</div>;

  return (
    <div className="metrics">
      <ThisWeekCard m={metrics} />
      <div className="m-row">
        <KpiStackCard m={metrics} />
        <HeatmapCard m={metrics} />
        <PeopleCard m={metrics} />
      </div>
      <div className="m-row-3">
        <StreakCard m={metrics} />
        <WhenIWorkCard m={metrics} />
        <TopFilesCard m={metrics} />
      </div>
    </div>
  );
}
