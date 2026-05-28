import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMyProjects } from '../../lib/projects';
import {
  sortProjectsByRecent,
  getMostRecentProjectId,
  getRecentMap,
  RECENT_PROJECTS_CHANGED_EVENT,
} from '../../lib/recentProjects';
import { useAuth } from '../../context/AuthContext';
import './ProjectList.css';

// Projects — "Editorial Dossier" redesign (Claude Design handoff
// `docvex-project-redesign`). The list reads like a documents masthead:
// a title + role-count kicker, then two tiers — "Recently opened" (the
// last-7-days projects as big featured cards) and "All projects" (the full
// list as a table-ish view). All `pjx`-prefixed to avoid colliding with the
// generic class names in the prototype's standalone CSS.
//
// Grounded in real data: role counts, member_count, updated_at, the per-user
// recency map, and the member avatar stacks (real profile images / initials
// from get_member_profiles) all come from the data layer.

// ── Icons (inline per the codebase convention; stroke = currentColor) ──
const PlusIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const CaretIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 6 15 12 9 18" />
  </svg>
);
// Per-user avatar colour — same 12-colour djb2 scheme used across the app, so
// a member's fallback initials circle is stable wherever they appear.
const AVATAR_PALETTE = ['#0891B2', '#BE185D', '#4F46E5', '#047857', '#B45309', '#6D28D9', '#DC2626', '#0369A1', '#DB2777', '#059669', '#7C3AED', '#EA580C'];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < (seed || '').length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}
function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
const DAY_MS = 86400000;

// ── Cards / rows ───────────────────────────────────────────────────────
// Overlapping member avatars (account image, or a coloured initials circle as
// fallback). Renders nothing when there are no member profiles — the numeric
// member count is shown separately, right after the stack.
function AvatarStack({ members = [], max = 4 }) {
  const shown = members.slice(0, max);
  if (shown.length === 0) return null;
  return (
    <div className="pjx-avatars">
      {shown.map((m) => (
        <span
          key={m.userId}
          className="pjx-avatar"
          title={m.name}
          style={m.avatarUrl ? undefined : { background: avatarColor(m.userId) }}
        >
          {m.avatarUrl
            ? <img src={m.avatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} />
            : m.initials}
        </span>
      ))}
    </div>
  );
}

// One featured card for a recently-opened project: avatar stack + member
// count + when it was last opened.
function FeaturedCard({ project, lastOpened }) {
  const n = project.member_count;
  return (
    <Link to={`/projects/${project.id}`} className="pjx-pinned-card">
      <div className="pjx-pc-eyebrow">
        <span className="pjx-pc-dot" />
        <span>Recent</span>
      </div>
      <span className={`pjx-pill is-${project.role}`}>{project.role}</span>
      <h3 className="pjx-pc-title">{project.name}</h3>
      <p className="pjx-pc-desc">{project.description || 'No description.'}</p>
      <div className="pjx-pc-foot">
        <AvatarStack members={project.members} />
        <span className="pjx-pc-meta">
          <strong>{n}</strong>&nbsp;{n === 1 ? 'member' : 'members'}
          <span className="pjx-sep">·</span>
          opened {timeAgo(lastOpened)}
        </span>
      </div>
    </Link>
  );
}

function AllRow({ project, mostRecent }) {
  const n = project.member_count;
  return (
    <Link to={`/projects/${project.id}`} className="pjx-all-row">
      <div className="pjx-al-name">
        <div className="pjx-al-name-main">
          {project.name}
          {mostRecent && <span className="pjx-al-recent-tag">most recent</span>}
        </div>
        <div className="pjx-al-name-sub">{project.description || 'No description.'}</div>
      </div>
      <span className={`pjx-pill is-${project.role}`}>{project.role}</span>
      <div className="pjx-al-members">
        <AvatarStack members={project.members} max={3} />
        <span className="pjx-al-member-count">{n}&nbsp;{n === 1 ? 'member' : 'members'}</span>
      </div>
      <div className="pjx-al-updated">
        <strong>updated</strong><br />
        <span>{timeAgo(project.updated_at)}</span>
      </div>
      <div className="pjx-al-end">
        <span className="pjx-al-caret">{CaretIcon}</span>
      </div>
    </Link>
  );
}

// ── States ─────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="pjx-empty">
      <h2>No projects yet</h2>
      <p>Projects are how you share files and notes with collaborators.</p>
      <Link to="/projects/new" className="pjx-btn-primary">{PlusIcon} Create your first project</Link>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────
export default function ProjectList() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Bump to force a recompute when the recency map changes (e.g. the user
  // opened a project then came back).
  const [recencyTick, setRecencyTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await listMyProjects();
      if (cancelled) return;
      setProjects(data);
      setError(err);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onRecent = () => setRecencyTick((t) => t + 1);
    window.addEventListener(RECENT_PROJECTS_CHANGED_EVENT, onRecent);
    return () => window.removeEventListener(RECENT_PROJECTS_CHANGED_EVENT, onRecent);
  }, [userId]);

  const counts = useMemo(() => ({
    all: projects.length,
    owner: projects.filter((p) => p.role === 'owner').length,
    admin: projects.filter((p) => p.role === 'admin').length,
    member: projects.filter((p) => p.role === 'member').length,
    viewer: projects.filter((p) => p.role === 'viewer').length,
  }), [projects]);

  const orderedProjects = useMemo(
    () => sortProjectsByRecent(userId, projects),
    [userId, projects, recencyTick],
  );
  const mostRecentId = useMemo(
    () => getMostRecentProjectId(userId),
    [userId, projects, recencyTick],
  );

  // No filtering UI anymore — the list is the full set, recency-ordered.
  const filtered = orderedProjects;

  // Featured tier: the projects opened in the last 7 days, rendered as big
  // "Recently opened" cards. The full list still renders below in "All
  // projects". Recency comes from the per-user map.
  const recencyMap = useMemo(() => getRecentMap(userId), [userId, recencyTick]);
  const featured = useMemo(() => {
    const now = Date.now();
    return filtered
      .filter((p) => {
        const ts = recencyMap[p.id]?.ts;
        return ts && (now - new Date(ts).getTime()) < 7 * DAY_MS;
      })
      .slice(0, 4)
      .map((p) => ({ project: p, lastOpened: recencyMap[p.id]?.ts }));
  }, [filtered, recencyMap]);

  const collaborate = counts.member + counts.viewer;

  return (
    <div className="pjx-page">
      {/* Masthead */}
      <header className="pjx-masthead">
        <div className="pjx-mh-left">
          <div className="pjx-mh-eyebrow">
            <span>Workspace</span>
            <span className="pjx-mh-muted">· All projects you collaborate on</span>
          </div>
          <h1 className="pjx-mh-title">Projects.</h1>
          <p className="pjx-mh-kicker">
            <strong>{counts.all} {counts.all === 1 ? 'workspace' : 'workspaces'}</strong> across your account —{' '}
            <strong>{counts.owner}</strong> you own, <strong>{counts.admin}</strong> you administer,{' '}
            <strong>{collaborate}</strong> you collaborate on.
          </p>
        </div>
        <div className="pjx-mh-cta-row">
          <Link to="/projects/new" className="pjx-btn-primary">{PlusIcon} New project</Link>
        </div>
      </header>

      {error && (
        <div className="pjx-error">Couldn't load projects: {error.message}</div>
      )}

      {!loading && !error && projects.length === 0 && <EmptyState />}

      {!loading && !error && projects.length > 0 && (
        <>
          {/* Recently opened — the last-7-days projects as big featured cards. */}
          {featured.length > 0 && (
            <section className="pjx-section">
              <div className="pjx-section-head">
                <div className="pjx-section-title">Recently opened</div>
              </div>
              <div className="pjx-pinned-grid">
                {featured.map((f) => (
                  <FeaturedCard
                    key={f.project.id}
                    project={f.project}
                    lastOpened={f.lastOpened}
                  />
                ))}
              </div>
            </section>
          )}

          {/* All projects */}
          <section className="pjx-section">
            <div className="pjx-section-head">
              <div className="pjx-section-title">All projects <em>{filtered.length} total</em></div>
            </div>
            <div className="pjx-all-list">
              {filtered.map((p) => (
                <AllRow
                  key={p.id}
                  project={p}
                  mostRecent={p.id === mostRecentId}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
