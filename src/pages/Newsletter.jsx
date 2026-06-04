import React, { useEffect, useMemo, useState } from 'react';
import './Newsletter.css';
import PageMasthead from '../components/PageMasthead';
import {
  listLegalUpdates,
  setUpdateRead,
  setUpdatePinned,
  setUpdateSaved,
  getWeeklyDigest,
} from '../lib/legalFeed';

// Newsletter — Legal Newsfeed v2 "Editorial" (ported from the Claude
// Design handoff `docvex-newsfeed`). A typographically-led briefing of
// Romanian legal/legislation updates with AI summaries, impact level,
// and impacted areas.
//
// Data is REAL: the feed comes from the `legal_updates` Supabase table
// (per-item `summary` / `areas` / `impact` / `category` are AI-generated
// at ingestion — see supabase/functions/legal-ai). Per-user read / pin /
// save flags live in `legal_update_states` and persist across devices.
// The "AI weekly" line at the top is generated live by Claude via the
// `legal-ai` Edge Function (digest action), cached for an hour client-
// side; it falls back to a locally-computed line when the AI key isn't
// configured or the function is unreachable.

// ── Category metadata ────────────────────────────────────────────────
const CATEGORIES = {
  employment: { label: 'Employment' },
  corporate:  { label: 'Corporate' },
  gdpr:       { label: 'GDPR' },
  litigation: { label: 'Litigation' },
  tax:        { label: 'Tax' },
  compliance: { label: 'Compliance' },
};
const CATEGORY_ORDER = ['employment', 'corporate', 'gdpr', 'litigation', 'tax', 'compliance'];

// ── Icons ────────────────────────────────────────────────────────────
const SparkleMini = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
  </svg>
);

// ── Helpers ──────────────────────────────────────────────────────────
// Real wall-clock time now that the feed carries genuine publish dates.
function relTimeLong(iso) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function dayGroupKey(iso) {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days < 1) return { key: 'today', label: 'Today', order: 0 };
  if (days < 2) return { key: 'yesterday', label: 'Yesterday', order: 1 };
  if (days < 7) return { key: 'thisweek', label: 'This week', order: 2 };
  if (days < 31) return { key: 'earlier', label: 'Earlier this month', order: 3 };
  return { key: 'older', label: 'Older', order: 4 };
}
function formatDateLong(label, items) {
  if (!items.length) return label;
  const d = new Date(items[0].publishedAt);
  const formatted = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  if (label === 'Today' || label === 'Yesterday') return `${label} · ${formatted}`;
  return formatted;
}

function ImpactMark({ level }) {
  return (
    <>
      <span className="ed-impact-mark" data-level={level} aria-hidden="true">
        <span /><span /><span />
      </span>
      <span className="ed-impact-label" data-level={level}>
        {level === 'low' ? 'Low impact' : level === 'med' ? 'Medium impact' : 'High impact'}
      </span>
    </>
  );
}

function Article({ item, onOpen, onPin, onToggleRead, onSave }) {
  const cat = CATEGORIES[item.category] || { label: item.category };
  const impactKey = item.impact === 'high' ? 'high' : item.impact === 'medium' ? 'med' : 'low';
  return (
    <li
      className={`ed-article${item.unread ? '' : ' is-read'}`}
      data-cat={item.category}
      onClick={() => onOpen(item)}
    >
      <div className="ed-rail">
        <div className="ed-rail-category">{cat.label}</div>
        <ImpactMark level={impactKey} />
        <div className="ed-rail-time">{relTimeLong(item.publishedAt)}</div>
      </div>

      <div className="ed-body">
        <h2 className="ed-headline">
          {item.title}
          {item.pinned && <span className="ed-pinned-mark">★ Pinned</span>}
        </h2>
        <div className="ed-source">
          <span className="ed-source-strong">Source:</span> {item.source}
          {item.citations && <> · <span style={{ fontStyle: 'normal' }}>{item.citations}</span></>}
        </div>
        {item.summary ? (
          <p className="ed-lead">
            <span className="ed-ai-byline">{SparkleMini}<span>AI brief</span></span>
            {item.summary}
          </p>
        ) : (
          <p className="ed-lead" style={{ opacity: 0.6 }}>
            <span className="ed-ai-byline">{SparkleMini}<span>AI brief</span></span>
            Summary pending — this update hasn't been processed yet.
          </p>
        )}
        {item.areas.length > 0 && (
          <div className="ed-meta">
            <span className="ed-meta-label">Affects</span>
            <span className="ed-meta-areas">
              {item.areas.map((a) => <span key={a}>{a}</span>)}
            </span>
          </div>
        )}
        <div className="ed-actions">
          <button type="button" className="ed-action is-primary" onClick={(e) => { e.stopPropagation(); onOpen(item); }}>
            Read full update →
          </button>
          <button type="button" className="ed-action" onClick={(e) => { e.stopPropagation(); onPin(item.id); }}>
            {item.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button type="button" className="ed-action" onClick={(e) => { e.stopPropagation(); onToggleRead(item.id); }}>
            {item.unread ? 'Mark read' : 'Mark unread'}
          </button>
          <button type="button" className="ed-action" onClick={(e) => { e.stopPropagation(); onSave(item.id); }}>
            {item.saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </li>
  );
}

const sortFeed = (arr) => arr.slice().sort((a, b) => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return new Date(b.publishedAt) - new Date(a.publishedAt);
});

export default function Newsletter() {
  const [filter, setFilter] = useState('all');
  const [impactFilter, setImpactFilter] = useState('all');
  const [query, setQuery] = useState('');

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // AI weekly digest: 'loading' → 'ok' (use digest.summary) → 'fallback'
  // (use the locally-computed line). Never blocks the feed render.
  const [digest, setDigest] = useState(null);
  const [digestState, setDigestState] = useState('loading');

  // Load the feed once on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const { data, error } = await listLegalUpdates();
      if (!alive) return;
      if (error) {
        setLoadError(error.message || 'Could not load the feed.');
        setItems([]);
      } else {
        setLoadError(null);
        setItems(sortFeed(data));
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  // Generate / fetch the AI weekly digest (cached 1h). Independent of the
  // feed load so a slow model call never delays the articles.
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await getWeeklyDigest();
      if (!alive) return;
      if (res?.error || !res?.summary) {
        setDigestState('fallback');
      } else {
        setDigest(res);
        setDigestState('ok');
      }
    })();
    return () => { alive = false; };
  }, []);

  const counts = useMemo(() => {
    const out = { all: items.length };
    for (const it of items) out[it.category] = (out[it.category] || 0) + 1;
    return out;
  }, [items]);

  const filtered = useMemo(() => items.filter((it) => {
    if (filter !== 'all' && it.category !== filter) return false;
    if (impactFilter !== 'all') {
      const m = { low: 'low', med: 'medium', high: 'high' };
      if (it.impact !== m[impactFilter]) return false;
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const hay = `${it.title} ${it.summary || ''} ${it.source || ''} ${it.areas.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [items, filter, impactFilter, query]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const it of filtered) {
      const g = dayGroupKey(it.publishedAt);
      if (!map.has(g.key)) map.set(g.key, { ...g, items: [] });
      map.get(g.key).items.push(it);
    }
    return [...map.values()].sort((a, b) => a.order - b.order);
  }, [filtered]);

  const unreadCount = items.filter((i) => i.unread).length;
  const highImpactUnread = items.filter((i) => i.unread && i.impact === 'high').length;

  // Optimistic local update + fire-and-forget Supabase persistence. The
  // page doesn't await the write — RLS errors are swallowed and the next
  // toggle naturally retries (same pattern as saveSidecar / notify()).
  const onOpen = (item) => {
    if (!item.unread) return;
    setItems((arr) => arr.map((i) => (i.id === item.id ? { ...i, unread: false } : i)));
    setUpdateRead(item.id, true);
  };
  const onToggleRead = (id) => {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const newRead = it.unread; // toggling an unread item marks it read
    setItems((arr) => arr.map((i) => (i.id === id ? { ...i, unread: !i.unread } : i)));
    setUpdateRead(id, newRead);
  };
  const onPin = (id) => {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const nowPinned = !it.pinned;
    setItems((arr) => sortFeed(arr.map((i) => (i.id === id ? { ...i, pinned: nowPinned } : i))));
    setUpdatePinned(id, nowPinned);
  };
  const onSave = (id) => {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const nowSaved = !it.saved;
    setItems((arr) => arr.map((i) => (i.id === id ? { ...i, saved: nowSaved } : i)));
    setUpdateSaved(id, nowSaved);
  };

  const filterTabs = useMemo(() => {
    const present = CATEGORY_ORDER.filter((c) => (counts[c] || 0) > 0);
    return [{ id: 'all', label: 'All' }, ...present.map((c) => ({ id: c, label: CATEGORIES[c].label }))];
  }, [counts]);

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="ed-page">
      <PageMasthead
        eyebrow="DocVex Briefing"
        eyebrowMuted="Romania"
        title="Newsletter"
        actions={(
          <div className="ed-mast-meta">
            <div>
              <div className="ed-mast-meta-num">{unreadCount}</div>
              <div>Unread</div>
            </div>
            <span className="ed-mast-meta-sep" />
            <div>
              <div className="ed-mast-meta-num">{today.split(',')[0]}</div>
              <div>{today.split(',').slice(1).join(',').trim()}</div>
            </div>
          </div>
        )}
        compactRight={<span className="ed-mast-meta-num" style={{ fontSize: '13px' }}>{unreadCount} unread</span>}
      />

      <p className="ed-weekly">
        <span className="ed-weekly-mark">AI weekly</span>
        {digestState === 'loading' && (
          <span style={{ opacity: 0.65 }}>Generating this week's briefing…</span>
        )}
        {digestState === 'ok' && <span>{digest.summary}</span>}
        {digestState === 'fallback' && (
          <span>
            <strong>{highImpactUnread} high-impact</strong> {highImpactUnread === 1 ? 'update' : 'updates'} awaiting
            review out of <strong>{unreadCount}</strong> unread. Tax and employment changes dominate the
            latest briefing — review the OUG 156 VAT increase and the new sick-leave rules taking effect 1 June.
          </span>
        )}
      </p>

      <div className="ed-filters">
        <div className="ed-filter-group">
          <span className="ed-filter-label">Section</span>
          {filterTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              data-cat={tab.id}
              className={`ed-filter-btn${filter === tab.id ? ' is-active' : ''}`}
              onClick={() => setFilter(tab.id)}
            >
              {tab.label}
              {tab.id !== 'all' && <span style={{ opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}>·{counts[tab.id] || 0}</span>}
            </button>
          ))}
        </div>
        <div className="ed-filter-group">
          <span className="ed-filter-label">Impact</span>
          {['all', 'high', 'med', 'low'].map((id) => (
            <button
              key={id}
              type="button"
              className={`ed-filter-btn${impactFilter === id ? ' is-active' : ''}`}
              onClick={() => setImpactFilter(id)}
            >
              {id === 'all' ? 'Any' : id === 'med' ? 'Medium' : id[0].toUpperCase() + id.slice(1)}
            </button>
          ))}
        </div>
        <div className="ed-search">
          <input
            type="text"
            placeholder="Search briefings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search briefings"
          />
        </div>
      </div>

      {loading ? (
        <div className="ed-empty">
          <div className="ed-empty-title">Loading the briefing…</div>
        </div>
      ) : loadError ? (
        <div className="ed-empty">
          <div className="ed-empty-title">Couldn't load the feed</div>
          <div style={{ fontSize: 13 }}>{loadError}</div>
        </div>
      ) : groups.length === 0 ? (
        <div className="ed-empty">
          <div className="ed-empty-title">
            {items.length === 0 ? 'No updates yet' : 'Nothing matches these filters'}
          </div>
          <div style={{ fontSize: 13 }}>
            {items.length === 0
              ? 'New legal updates will appear here as they are published.'
              : 'Clear the search or pick a different section.'}
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="ed-section">
            <header className="ed-section-head">
              <h2 className="ed-section-date">{formatDateLong(g.label, g.items)}</h2>
              <span className="ed-section-rule" />
              <span className="ed-section-meta">{g.items.length} {g.items.length === 1 ? 'update' : 'updates'}</span>
            </header>
            <ul className="ed-list">
              {g.items.map((it) => (
                <Article
                  key={it.id}
                  item={it}
                  onOpen={onOpen}
                  onPin={onPin}
                  onToggleRead={onToggleRead}
                  onSave={onSave}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
