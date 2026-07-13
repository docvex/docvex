import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../context/NotificationsContext';
import { useUpdates } from '../context/UpdatesContext';
import { buildActions } from '../notifications/actionRegistry';
import { resolveNotificationIcon } from '../notifications/icons';
import { isElectron } from '../lib/platform';
import { guessMimeFromName } from '../lib/localFolder';
import MiniHeaderFade from '../components/MiniHeaderFade';
import FileThumbnail from '../components/FileThumbnail';
import { glyphForFile } from '../components/fileGlyph';
import './Activity.css';

// Activity = the merged home of what used to be the (empty) "/" Activity
// dashboard + the "/notifications" inbox. One feed of everything that has
// happened across the user's projects — file adds, invites, role changes,
// releases, sign-ins. Data comes straight from NotificationsContext.
//
// Presentation mirrors the Events timeline tab (ProjectEvents) 1:1: the big
// editorial masthead scrolls away, a frosted 40px toolbar (title + count +
// filter chips + bulk actions) pins at the top as the mini header, and the
// feed is a day-grouped vertical rail — with each row's marker showing the
// NOTIFICATION'S OWN ICON (resolveNotificationIcon) in a category-tinted
// medallion instead of the Events tab's plain rings.

// Friendly labels + display order for the category filter chips. Mirrors the
// --cat-* token set; `data-cat` on the row/medallion drives the colour in CSS.
const CATEGORY_LABELS = {
  file: 'Files',
  member: 'Members',
  project: 'Projects',
  role: 'Roles',
  update: 'Updates',
  auth: 'Sign-ins',
  support: 'Support',
  social: 'Social',
  system: 'System',
  info: 'Other',
};
const CATEGORY_ORDER = ['file', 'member', 'project', 'role', 'update', 'auth', 'support', 'social', 'system', 'info'];

const DAY = 24 * 3600e3;

// Day-group label: Today / Yesterday / a written date — same grouping idiom
// as the Events timeline.
function dayLabel(iso) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'Earlier';
  const date = new Date(at);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

// Row timestamp — clock time only ("14:32"); the day is already carried by
// the group label above, so a relative "2 h ago" would just repeat it.
function timeLabel(iso) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ── Inline icons (CLAUDE.md convention) ───────────────────────────────
const CloseIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const BellOffIcon = (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M18.63 13A17.89 17.89 0 0 1 18 8" /><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" /><path d="M18 8a6 6 0 0 0-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);
// Filled folder — folder-event rows show this instead of a file thumbnail.
const FolderGlyph = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

// ── Filter tab strip (the original tab-bar design) ────────────────────
// Flat tabs with a leading category dot, a muted count, and ONE shared
// underline element that SLIDES to the active tab (transform + width
// transition in CSS). Hosted inside the sticky mini header, stretched to the
// bar's height so the underline straddles the bar's bottom edge.
function FilterTabs({ tabs, active, onSelect }) {
  const stripRef = useRef(null);
  const underlineRef = useRef(null);
  // False until the underline has been positioned once. The very first
  // placement (entering the tab) SNAPS into place — the bar starts at the CSS
  // initial width:0 / no transform, so letting the transition run would show
  // it sliding in from the strip's top-left corner on every mount.
  const placedRef = useRef(false);

  // Place the underline under the active tab. Re-runs when the active tab or
  // the tab set changes; a ResizeObserver re-places on width shifts (count
  // digits changing, the bar resizing).
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const bar = underlineRef.current;
    if (!strip || !bar) return undefined;
    const place = () => {
      const btn = strip.querySelector(`[data-tab-id="${active}"]`);
      if (!btn) { bar.style.width = '0px'; return; }
      const snap = !placedRef.current;
      if (snap) bar.style.transition = 'none';
      // Wrap the label text with a symmetric overhang on each side so the
      // bar reads wider than the word and stays centred under it. No clamp
      // to the button's box: the "All" tab has no leading padding, so its
      // underline deliberately pokes past the tab's left edge (the strip's
      // overflow is visible). Offsets are relative to the button
      // (position: relative).
      const EXT = 8;
      const label = btn.querySelector('.activity-filter-label');
      const start = (label ? label.offsetLeft : 0) - EXT;
      const end = (label ? label.offsetLeft + label.offsetWidth : btn.offsetWidth) + EXT;
      const x = btn.offsetLeft + start;
      // Sit just under the label text (the tabs stretch to the bar's full
      // height, so anchoring to the button's bottom would strand the bar far
      // below the word).
      const y = label
        ? btn.offsetTop + label.offsetTop + label.offsetHeight + 6.4
        : btn.offsetTop + btn.offsetHeight - 0.32;
      bar.style.width = `${Math.max(end - start, 0)}px`;
      bar.style.transform = `translate(${x}px, ${y}px)`;
      if (snap) {
        // Commit the untransitioned placement, then hand movement back to the
        // stylesheet transition for subsequent tab changes.
        void bar.offsetWidth;
        bar.style.transition = '';
      }
      placedRef.current = true;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [active, tabs]);

  return (
    <div className="activity-filters" role="tablist" aria-label="Filter activity" ref={stripRef}>
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-cat={tab.id}
            data-tab-id={tab.id}
            className={`activity-filter${isActive ? ' is-active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            <span className="activity-filter-label">{tab.label}</span>
          </button>
        );
      })}
      <span className="activity-filter-underline" data-cat={active} ref={underlineRef} aria-hidden="true" />
    </div>
  );
}

// ── Single timeline row ───────────────────────────────────────────────
// The rail marker is the notification's own contextual icon (trash / plus /
// envelope / …) in a category-tinted round medallion.
function ActivityRow({ notification, ctx, onRemove }) {
  const { id, title, body, created_at, read_at, category, variant } = notification;
  const actions = buildActions(notification, ctx);
  const glyph = resolveNotificationIcon(notification);
  const cat = category || 'system';
  const unread = !read_at;
  // File events carry the touched file in payload.activity — those rows show
  // its thumbnail beside the text, split by a vertical hairline.
  const file = notification.payload?.activity?.fileName ? notification.payload.activity : null;

  const content = (
    <>
      <div className="avt-item-head">
        <span className="avt-item-title">{title}</span>
      </div>
      {body && <p className="avt-item-body">{body}</p>}
      {actions.length > 0 && (
        <div className="avt-item-actions">
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              className={`avt-action is-${a.variant || 'secondary'}`}
              onClick={(e) => {
                e.stopPropagation();
                try { a.onClick?.(); } catch { /* swallow */ }
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </>
  );

  return (
    <li
      className={`avt-item${unread ? ' is-unread' : ''} is-var-${variant || 'info'}`}
      data-cat={cat}
    >
      <span className="avt-ico" data-cat={cat} aria-hidden="true">{glyph}</span>
      {file ? (
        /* thumbnail | text — the thumb sits at the row's vertical centre,
           split from the text column by a vertical hairline. The thumb
           resolves from the on-disk bytes when the event recorded a path
           (Electron localfile://), else the extension glyph — same chain as
           the Files grid. */
        <div className="avt-file-row">
          <span className={`avt-file-thumb${file.folder ? ' is-folder' : ''}`}>
            {file.folder ? FolderGlyph : (
              <FileThumbnail
                mimeType={guessMimeFromName(file.fileName)}
                sourceUrl={isElectron && file.filePath ? `localfile://local/${encodeURIComponent(file.filePath)}` : null}
                glyph={glyphForFile(guessMimeFromName(file.fileName), file.fileName)}
              />
            )}
          </span>
          <span className="avt-file-divider" aria-hidden="true" />
          <div className="avt-file-content">{content}</div>
        </div>
      ) : content}
      {/* Timestamp — pinned to the row's bottom-right corner. */}
      <span className="avt-item-time">{timeLabel(created_at)}</span>
      {/* Dismiss — revealed on row hover, pinned to the row's top-right. */}
      <button
        type="button"
        className="avt-dismiss"
        aria-label="Dismiss"
        onClick={(e) => { e.stopPropagation(); onRemove(id); }}
      >
        {CloseIcon}
      </button>
    </li>
  );
}

export default function ActivityPage() {
  const { notifications, remove, clearAll } = useNotifications();
  const navigate = useNavigate();
  const { installUpdate } = useUpdates();

  // Category filter (All = union). In-memory page state, not persisted —
  // matches the rest of the app. slideDir remembers which way the underline
  // travelled on the last filter change (+1 right / -1 left / 0 initial) so
  // the feed below can slide in from the same direction.
  const [filter, setFilter] = useState('all');
  const [slideDir, setSlideDir] = useState(0);
  // True once the toolbar is ACTUALLY stuck at the scroller's top (rect-based,
  // like every other mini header) — drives the frosted .is-pinned surface.
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef(null);
  const barRef = useRef(null);

  const ctx = useMemo(() => ({ navigate, installUpdate }), [navigate, installUpdate]);

  // Per-category counts in one pass; drives both the chip badges and which
  // category chips render (empty categories are hidden).
  const catCounts = useMemo(() => {
    const out = { all: notifications.length };
    for (const n of notifications) {
      const c = n.category || 'system';
      out[c] = (out[c] || 0) + 1;
    }
    return out;
  }, [notifications]);

  const filterTabs = useMemo(() => {
    const present = CATEGORY_ORDER.filter((c) => (catCounts[c] || 0) > 0);
    return [{ id: 'all', label: 'All' }, ...present.map((c) => ({ id: c, label: CATEGORY_LABELS[c] || c }))];
  }, [catCounts]);

  const filtered = useMemo(
    () => (filter === 'all' ? notifications : notifications.filter((n) => (n.category || 'system') === filter)),
    [notifications, filter],
  );

  // Day grouping (the context keeps notifications newest-first).
  const groups = useMemo(() => {
    const out = [];
    for (const n of filtered) {
      const label = dayLabel(n.created_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(n);
      else out.push({ label, rows: [n] });
    }
    return out;
  }, [filtered]);

  // Filter change with direction: compare old/new tab indices so both the
  // underline (CSS transition) and the feed slide-in move the same way.
  const selectFilter = (id) => {
    if (id === filter) return;
    const from = filterTabs.findIndex((t) => t.id === filter);
    const to = filterTabs.findIndex((t) => t.id === id);
    setSlideDir(to >= from ? 1 : -1);
    setFilter(id);
  };

  // The page (.sv-single-scroll) is the scroller, which lives ABOVE this
  // component — attach the scroll listener imperatively (same pattern as the
  // Events / Chat / Files pin detection).
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
  }, []);

  return (
    <div className="avt-root" ref={rootRef}>
      {/* ── Masthead — the big "large title" hero, 1:1 with the Events tab. */}
      <header className="avt-masthead">
        <div className="avt-mh-eyebrow">
          <span>DocVex Journal</span>
          <span className="avt-mh-muted">· All projects</span>
        </div>
        <h1 className="avt-mh-title">Activity.</h1>
        <p className="avt-mh-kicker">
          A running record of everything happening across every project you're
          part of — files added or changed, invites, role updates, releases and
          sign-ins.
        </p>
      </header>

      {/* ── Mini header — frosted 40px bar that pins at the top once the
          masthead scrolls away. Same surface as every other pinned bar. */}
      <MiniHeaderFade visible={pinned} />
      <div
        ref={barRef}
        className={`avt-toolbar${pinned ? ' is-pinned' : ''}`}
      >
        {notifications.length > 0 && (
          <>
            <FilterTabs tabs={filterTabs} active={filter} onSelect={selectFilter} />
            <div className="avt-tb-actions">
              <button type="button" className="act-btn" onClick={clearAll} disabled={notifications.length === 0}>
                Clear all
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Timeline — day-grouped rows on a vertical rail; the marker is each
          notification's own icon in a category-tinted medallion. */}
      {notifications.length === 0 ? (
        <div className="avt-empty">
          {BellOffIcon}
          <p className="avt-empty-title">Nothing here yet</p>
          <p className="avt-empty-help">
            File uploads, invites, role changes, releases and sign-ins show up here as they happen.
          </p>
        </div>
      ) : (
        /* Keyed on the filter so switching tabs remounts the feed and replays
           the slide-in — entering from the side the underline travelled
           toward. slideDir 0 (initial load) renders with no animation. */
        <div
          key={filter}
          className={`avt-feed${slideDir > 0 ? ' is-enter-right' : slideDir < 0 ? ' is-enter-left' : ''}`}
        >
          {filtered.length === 0 ? (
            <div className="avt-empty">
              {BellOffIcon}
              <p className="avt-empty-title">
                No {(CATEGORY_LABELS[filter] || filter).toLowerCase()} activity
              </p>
              <p className="avt-empty-help">Nothing in this category right now. Try the All tab to see everything.</p>
            </div>
          ) : (
            <div className="avt-timeline">
              {groups.map((group) => (
                <section key={group.label} className="avt-day">
                  <h2 className="avt-day-label">{group.label}</h2>
                  <ol className="avt-rows">
                    {group.rows.map((n) => (
                      <ActivityRow
                        key={n.id}
                        notification={n}
                        ctx={ctx}
                        onRemove={remove}
                      />
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
