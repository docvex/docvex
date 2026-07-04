// Data layer for the Legal Newsfeed (Newsletter tab).
//
// `legal_updates` is the global feed (one row per legal/regulatory
// update, AI-summarised at ingestion). `legal_update_states` holds the
// signed-in user's read/pin/save flags per update. The feed read embeds
// the user's state via PostgREST so a single round-trip returns both —
// RLS on `legal_update_states` scopes the embed to auth.uid(), so other
// users' flags never leak.
//
// Same `{ data, error }` return shape as the other lib/* wrappers; per-
// user writes are fire-and-forget mirrors (the page updates local state
// optimistically and doesn't await).

import { supabase } from './supabaseClient';

const UPDATES = 'legal_updates';
const STATES = 'legal_update_states';

// Select list mirrors the columns the Newsletter renders. The embedded
// `legal_update_states(...)` comes back as an array (0 or 1 row after
// RLS) — `normalizeRow` flattens it to a single `state`.
const SELECT =
  'id, slug, category, impact, title, source, citations, summary, areas, ai_status, published_at, ' +
  'legal_update_states ( read_at, pinned_at, saved_at )';

function normalizeRow(row) {
  const state = Array.isArray(row.legal_update_states)
    ? row.legal_update_states[0]
    : row.legal_update_states;
  return {
    id: row.id,
    slug: row.slug,
    category: row.category,
    impact: row.impact,
    title: row.title,
    source: row.source,
    citations: row.citations,
    summary: row.summary,
    areas: Array.isArray(row.areas) ? row.areas : [],
    aiStatus: row.ai_status,
    publishedAt: row.published_at,
    unread: !state?.read_at,
    pinned: !!state?.pinned_at,
    saved: !!state?.saved_at,
  };
}

// Fetch the feed, newest first. Returns `{ data: Item[], error }`.
export async function listLegalUpdates({ limit = 100 } = {}) {
  const { data, error } = await supabase
    .from(UPDATES)
    .select(SELECT)
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error) return { data: [], error };
  return { data: (data || []).map(normalizeRow), error: null };
}

// Resolve the current user id for a write. Reads the locally-cached
// session (no network round-trip) — RLS still enforces ownership via the
// JWT, but the column is part of the composite PK so we must set it.
async function currentUserId() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id || null;
}

// Upsert a single state column without clobbering the others. supabase-js
// upsert only writes the keys present in the row, so passing just
// `{ user_id, update_id, <col> }` leaves the sibling flags intact on
// conflict.
async function setStateColumn(updateId, column, on) {
  const userId = await currentUserId();
  if (!userId) return { error: new Error('not_authenticated') };
  const row = {
    user_id: userId,
    update_id: updateId,
    [column]: on ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from(STATES)
    .upsert(row, { onConflict: 'user_id,update_id' });
  return { error };
}

// ── "New brief" pill (sidebar) ──────────────────────────────────────
// The sidebar shows a pill on the Newsletter item when a brief was published
// AFTER the user's last visit to the tab. The visit timestamp is per-device
// (localStorage) and the check is a single one-row select, so it's cheap
// enough to run on every sidebar mount. `docvex:newsletter-changed` fires on
// both a visit (clears the pill) and a debug insert (raises it) so the
// sidebar can re-check without polling.
const LAST_VISIT_PREFIX = 'docvex.newsletter.lastVisit.';
const NEWSLETTER_CHANGED_EVENT = 'docvex:newsletter-changed';

function lastVisitKey(userId) {
  return LAST_VISIT_PREFIX + (userId || '_anonymous');
}

export function notifyNewsletterChanged() {
  try { window.dispatchEvent(new CustomEvent(NEWSLETTER_CHANGED_EVENT)); } catch { /* SSR-safe */ }
}

export function markNewsletterVisited(userId) {
  try { localStorage.setItem(lastVisitKey(userId), new Date().toISOString()); } catch { /* non-fatal */ }
  notifyNewsletterChanged();
}

export function onNewsletterChanged(callback) {
  window.addEventListener(NEWSLETTER_CHANGED_EVENT, callback);
  return () => window.removeEventListener(NEWSLETTER_CHANGED_EVENT, callback);
}

// True when the newest published brief postdates the user's last visit.
export async function hasNewBrief(userId) {
  const { data, error } = await supabase
    .from(UPDATES)
    .select('published_at')
    .order('published_at', { ascending: false })
    .limit(1);
  if (error || !data?.length) return false;
  const newest = Date.parse(data[0].published_at);
  if (Number.isNaN(newest)) return false;
  let lastVisit = 0;
  try { lastVisit = Date.parse(localStorage.getItem(lastVisitKey(userId)) || '') || 0; } catch { /* 0 */ }
  return newest > lastVisit;
}

// ── Debug brief generator (Debug page, app admins only) ─────────────
// Inserts a few sample briefs so the Newsletter feed + its sidebar pill can
// be exercised without the real legal-ai ingest pipeline. Backed by the
// `legal_updates_admin_debug_write` migration — INSERT/DELETE are gated on
// is_app_admin(), so non-admins get an RLS error here. Slugs are prefixed
// `debug-` so removeDebugBriefs can sweep them.
const DEBUG_SAMPLES = [
  { category: 'tax', impact: 'high', title: 'Test brief — VAT registration threshold adjusted', summary: 'Sample brief generated from the Debug page. The VAT registration threshold changes for small enterprises starting next quarter.', areas: ['SMEs', 'Accounting teams'] },
  { category: 'employment', impact: 'medium', title: 'Test brief — remote-work addendum rules clarified', summary: 'Sample brief generated from the Debug page. Employers must attach an updated remote-work addendum to existing contracts.', areas: ['HR departments', 'Employers'] },
  { category: 'gdpr', impact: 'low', title: 'Test brief — cookie-consent guidance refreshed', summary: 'Sample brief generated from the Debug page. The supervisory authority republished its cookie-consent banner guidance.', areas: ['Website operators'] },
  { category: 'corporate', impact: 'medium', title: 'Test brief — beneficial-owner filing window extended', summary: 'Sample brief generated from the Debug page. The annual beneficial-owner declaration window is extended by 60 days.', areas: ['Companies', 'Law firms'] },
  { category: 'compliance', impact: 'high', title: 'Test brief — AML reporting format updated', summary: 'Sample brief generated from the Debug page. Reporting entities must switch to the new AML transaction-report format.', areas: ['Compliance officers', 'Banks'] },
];

export async function insertDebugBriefs({ count = 3 } = {}) {
  const now = Date.now();
  const rows = Array.from({ length: Math.min(count, DEBUG_SAMPLES.length) }, (_, i) => {
    const s = DEBUG_SAMPLES[(now + i) % DEBUG_SAMPLES.length];
    return {
      slug: `debug-${now}-${i}`,
      category: s.category,
      impact: s.impact,
      title: s.title,
      summary: s.summary,
      areas: s.areas,
      source: 'Debug page',
      ai_status: 'done',
      published_at: new Date(now + i).toISOString(),
    };
  });
  const { data, error } = await supabase.from(UPDATES).insert(rows).select('id');
  if (!error) notifyNewsletterChanged();
  return { data, error };
}

// Sweep every debug-generated brief (slug prefix `debug-`).
export async function removeDebugBriefs() {
  const { data, error } = await supabase
    .from(UPDATES)
    .delete()
    .like('slug', 'debug-%')
    .select('id');
  if (!error) notifyNewsletterChanged();
  return { count: data?.length || 0, error };
}

export function setUpdateRead(updateId, read) {
  return setStateColumn(updateId, 'read_at', read);
}
export function setUpdatePinned(updateId, pinned) {
  return setStateColumn(updateId, 'pinned_at', pinned);
}
export function setUpdateSaved(updateId, saved) {
  return setStateColumn(updateId, 'saved_at', saved);
}

// ── AI weekly digest ────────────────────────────────────────────────
// Live Claude summary across the recent feed, generated by the
// `legal-ai` Edge Function. Cached in sessionStorage for an hour so the
// page doesn't pay a model call on every mount / navigation. Mirrors the
// releases-cache pattern in UpdatesContext.
const DIGEST_CACHE_KEY = 'docvex:legal-digest:v1';
const DIGEST_TTL_MS = 60 * 60 * 1000; // 1 hour

function readDigestCache() {
  try {
    const raw = sessionStorage.getItem(DIGEST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.at || Date.now() - parsed.at > DIGEST_TTL_MS) return null;
    return parsed.value || null;
  } catch {
    return null;
  }
}

function writeDigestCache(value) {
  try {
    sessionStorage.setItem(DIGEST_CACHE_KEY, JSON.stringify({ at: Date.now(), value }));
  } catch {
    /* sessionStorage unavailable — non-fatal, digest just re-fetches */
  }
}

// Returns `{ summary, highImpactCount, total, generatedAt }` on success,
// or `{ error }` when the function is unreachable or the AI key isn't
// configured. Callers fall back to a locally-computed line in that case.
// `force` bypasses the cache (used by an explicit "refresh" action).
export async function getWeeklyDigest({ force = false } = {}) {
  if (!force) {
    const cached = readDigestCache();
    if (cached) return { ...cached, cached: true };
  }

  const { data, error } = await supabase.functions.invoke('legal-ai', {
    body: { action: 'digest' },
  });

  if (error) return { error };
  // The function returns a 200 with `{ ok:false, error }` when the AI
  // key isn't set, so the client falls back gracefully instead of
  // throwing on a non-2xx.
  if (!data || data.ok === false) {
    return { error: new Error(data?.error || 'digest_unavailable') };
  }

  const value = {
    summary: data.summary || '',
    highImpactCount: data.highImpactCount ?? 0,
    total: data.total ?? 0,
    generatedAt: data.generatedAt || new Date().toISOString(),
  };
  writeDigestCache(value);
  return value;
}
