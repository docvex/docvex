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
//   Row 1 (hero) : Review pipeline — Drafts → In review → Merged
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
const ChevRight = ic(<polyline points="9 6 15 12 9 18" />, 18);
const GlyphDraft = ic(<><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></>, 14);
const GlyphReview = ic(<><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>, 14);
const GlyphMerged = ic(<><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 9v6a6 6 0 0 0 6 6h3" /></>, 14);
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

// ── HERO: review pipeline ─────────────────────────────────────────────
function PipelineCard({ m }) {
  const p = m.pipeline;
  const draftTotal = p.drafts.breakdown.reduce((s, b) => s + b.value, 0);
  return (
    <div className="m-card">
      <div className="m-pipeline-body">
        <div className="m-stage" data-tone="drafts">
          <div className="m-stage-head"><span className="m-stage-glyph">{GlyphDraft}</span><span className="m-stage-label">My drafts</span></div>
          <div className="m-stage-value-row"><span className="m-stage-value">{p.drafts.count}</span></div>
          <div className="m-stage-detail"><strong>{p.drafts.detail}</strong> · {draftTotal} pending edits</div>
          {draftTotal > 0 && (
            <>
              <div className="m-mini-bar">
                {p.drafts.breakdown.map((b) => (
                  <Tooltip key={b.label} content={`${b.label}: ${b.value}`}>
                    <span data-cat={b.cat} style={{ width: `${(b.value / draftTotal) * 100}%` }} />
                  </Tooltip>
                ))}
              </div>
              <div className="m-mini-legend">
                {p.drafts.breakdown.map((b) => (
                  <span key={b.label} className="m-mini-legend-item">
                    <span className="m-mini-legend-swatch" data-cat={b.cat} />{b.label} <strong>{b.value}</strong>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="m-pipe-arrow">{ChevRight}</div>

        <div className="m-stage" data-tone="review">
          <div className="m-stage-head"><span className="m-stage-glyph">{GlyphReview}</span><span className="m-stage-label">In review</span></div>
          <div className="m-stage-value-row"><span className="m-stage-value">{p.inReview.count}</span></div>
          <div className="m-stage-detail">{p.inReview.detail}</div>
          {p.inReview.oldest && <div className="m-stage-detail" style={{ fontSize: 11 }}>{p.inReview.oldest}</div>}
        </div>

        <div className="m-pipe-arrow">{ChevRight}</div>

        <div className="m-stage" data-tone="merged">
          <div className="m-stage-head"><span className="m-stage-glyph">{GlyphMerged}</span><span className="m-stage-label">Merged into main</span></div>
          <div className="m-stage-value-row"><span className="m-stage-value">{p.merged.count}</span><Delta value={p.merged.delta} /></div>
          <div className="m-stage-detail">{p.merged.detail} · was <strong>{p.merged.prev}</strong> prior week</div>
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
      <PipelineCard m={metrics} />
      <div className="m-row">
        <KpiStackCard m={metrics} />
        <HeatmapCard m={metrics} />
        <PeopleCard m={metrics} />
      </div>
      <div className="m-row-3">
        <WhenIWorkCard m={metrics} />
        <TopFilesCard m={metrics} />
      </div>
    </div>
  );
}
