import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { miniHeaderSpot } from '../../lib/miniHeaderSpot';
import { formatRelativeTime } from '../../lib/notifications';
import MiniHeaderFade from '../../components/MiniHeaderFade';
import './ProjectScoped.css';
import './ProjectEvents.css';

// Events timeline — a project-scoped feed of everything that happened in the
// workspace (files, members, project changes), day-grouped on a vertical rail.
// The page reuses the app's iOS-style header language: a big editorial masthead
// (large title) that scrolls away, with a frosted 40px toolbar that pins to the
// top as the mini header (same recipe as Files' .fx-pathbar / Chat's
// .dvx-toolbar — sticky + .mini-glow + .is-pinned frost + MiniHeaderFade).
//
// There is no project_events table yet, so the feed below is STATIC SAMPLE
// data (per the design-handoff convention: placeholder content, not omission)
// plus the one real event we do know — the project's creation date.

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'file', label: 'Files' },
  { id: 'member', label: 'Members' },
  { id: 'project', label: 'Project' },
  { id: 'system', label: 'System' },
];

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// Placeholder feed. Offsets are relative to "now" so the day grouping and
// relative timestamps always demo sensibly regardless of when it's opened.
function sampleEvents(projectName, createdAt) {
  const now = Date.now();
  const rows = [
    { id: 's1', cat: 'file', title: 'Contract_v3.docx added', body: 'Uploaded to Contracts.', at: now - 2 * HOUR },
    { id: 's2', cat: 'member', title: 'Ana Popescu joined', body: 'Accepted the invitation as Member.', at: now - 5 * HOUR },
    { id: 's3', cat: 'file', title: '3 files renamed', body: 'Annex-A.pdf, Annex-B.pdf and Notes.txt were renamed in Diligence.', at: now - 26 * HOUR },
    { id: 's4', cat: 'project', title: 'Description updated', body: 'The project description was edited by the owner.', at: now - 30 * HOUR },
    { id: 's5', cat: 'system', title: 'Weekly digest generated', body: 'The legal newsfeed digest for this week is ready.', at: now - 2 * DAY - 3 * HOUR },
    { id: 's6', cat: 'member', title: 'Role changed', body: 'Mihai Ionescu was promoted from Viewer to Member.', at: now - 3 * DAY - 6 * HOUR },
    { id: 's7', cat: 'file', title: 'Folder created', body: 'A new folder "Court filings" was added at the root.', at: now - 5 * DAY - HOUR },
  ];
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isNaN(created)) {
    rows.push({
      id: 'created',
      cat: 'project',
      title: 'Project created',
      body: `${projectName} was created — the start of this timeline.`,
      at: created,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

// Day-group label: Today / Yesterday / a written date, matching the Activity
// feed's day grouping idiom.
function dayLabel(at) {
  const date = new Date(at);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function ProjectEvents() {
  const { selectedProject, loading } = useSelectedProject();
  const [filter, setFilter] = useState('all');
  // True once the toolbar is ACTUALLY stuck at the scroller's top (rect-based,
  // like every other mini header) — drives the frosted .is-pinned surface.
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef(null);
  const barRef = useRef(null);

  const events = useMemo(
    () => (selectedProject ? sampleEvents(selectedProject.name, selectedProject.created_at) : []),
    [selectedProject],
  );

  const counts = useMemo(() => {
    const c = { all: events.length };
    for (const ev of events) c[ev.cat] = (c[ev.cat] || 0) + 1;
    return c;
  }, [events]);

  const filtered = filter === 'all' ? events : events.filter((ev) => ev.cat === filter);

  // Day grouping (events are already newest-first).
  const groups = useMemo(() => {
    const out = [];
    for (const ev of filtered) {
      const label = dayLabel(ev.at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(ev);
      else out.push({ label, rows: [ev] });
    }
    return out;
  }, [filtered]);

  // The page (.sv-single-scroll) is the scroller, which lives ABOVE this
  // component — attach the scroll listener imperatively (same pattern as the
  // Chat / Files pin detection).
  useEffect(() => {
    const el = rootRef.current?.closest('.sv-single-scroll, .main-content');
    if (!el) return undefined;
    const onScroll = () => {
      const bar = barRef.current;
      setPinned(!!bar && (bar.getBoundingClientRect().top - el.getBoundingClientRect().top) <= 8);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [selectedProject?.id]);

  if (loading && !selectedProject) return null;

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to see its events timeline.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return (
    <div className="pev-root" ref={rootRef}>
      {/* ── Masthead — the big "large title" hero, 1:1 with the Files / Chat
          masthead language. Scrolls away; the toolbar below pins in its place. */}
      <header className="pev-masthead">
        <div className="pev-mh-eyebrow">
          <span>Events timeline</span>
          <span className="pev-mh-muted">· {selectedProject.name}</span>
        </div>
        <h1 className="pev-mh-title">Events.</h1>
        <p className="pev-mh-kicker">
          Everything that happened in this project — files, members and
          settings — in one chronological feed.
        </p>
      </header>

      {/* ── Mini header — frosted 40px bar that pins at the top once the
          masthead scrolls away. Same surface as every other pinned bar. */}
      <MiniHeaderFade visible={pinned} />
      <div
        ref={barRef}
        className={`pev-toolbar mini-glow${pinned ? ' is-pinned' : ''}`}
        onMouseMove={miniHeaderSpot}
      >
        <span className="pev-tb-title">Events</span>
        <span className="pev-tb-sep" aria-hidden="true">·</span>
        <span className="pev-tb-kicker">
          {counts.all} {counts.all === 1 ? 'event' : 'events'}
        </span>
        <div className="pev-tb-chips" role="tablist" aria-label="Filter events">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={`pev-chip${filter === f.id ? ' is-active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="pev-chip-count">{counts[f.id] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Timeline — day-grouped rows on a vertical rail, dots tinted by the
          notification category palette so kinds read at a glance. */}
      {groups.length === 0 ? (
        <p className="pev-empty">No events in this category yet.</p>
      ) : (
        <div className="pev-timeline">
          {groups.map((group) => (
            <section key={group.label} className="pev-day">
              <h2 className="pev-day-label">{group.label}</h2>
              <ol className="pev-rows">
                {group.rows.map((ev) => (
                  <li key={ev.id} className="pev-item">
                    <span className="pev-dot" data-cat={ev.cat} aria-hidden="true" />
                    <div className="pev-item-head">
                      <span className="pev-item-title">{ev.title}</span>
                      <span className="pev-item-time">{formatRelativeTime(ev.at)}</span>
                    </div>
                    <p className="pev-item-body">{ev.body}</p>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      <p className="pev-foot">
        Sample data — live event tracking wires up in a later build. The
        "Project created" entry is real.
      </p>
    </div>
  );
}
