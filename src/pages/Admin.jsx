import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getAdminStats,
  listAppAdmins, addAppAdmin, removeAppAdmin,
  listAppServices, upsertAppService, deleteAppService,
} from '../lib/admin';
import { openExternal } from '../lib/platform';
import { miniHeaderSpot } from '../lib/miniHeaderSpot';
import MiniHeaderFade from '../components/MiniHeaderFade';
import Tooltip from '../components/Tooltip';
import './Admin.css';

// ── Developer Console (Admin) ──────────────────────────────────────────────
// Ported from the Claude Design handoff `docvex-admin-dashboard`
// ("Admin Control Panel" → the default "Command deck" layout). A unified place
// to track every external service DocVex depends on — renewal dates, prices and
// live stats — plus a Mailbox-intelligence section (connect an inbox, let
// Claude extract billing data) and a Danger zone of destructive developer
// actions, each gated behind a type-to-confirm modal.
//
// The prototype's Tweaks panel (theme/layout/currency switcher, inline edit
// mode) is a design-preview harness, not part of the app, so it isn't ported:
// the app already owns theme, and this renders the default deck layout with
// realistic placeholder figures (totals in EUR). All `dc-`-prefixed to avoid
// colliding with the app's own classes; colours come from tokens.css.

// ── Currency + date helpers ────────────────────────────────────────────────
const DEFAULT_RATES = { EUR: 1, USD: 0.92, RON: 0.201 };
const CURRENCY_SYMBOL = { EUR: '€', USD: '$', RON: 'lei' };
const BASE = 'EUR';

function fmtMoney(amount, currency, opts = {}) {
  const { decimals = 2 } = opts;
  const n = Number(amount) || 0;
  const v = n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (currency === 'RON') return `${v} lei`;
  return `${CURRENCY_SYMBOL[currency] || ''}${v}`;
}
function convert(amount, from, to, rates = DEFAULT_RATES) {
  const inEur = (Number(amount) || 0) * (rates[from] ?? 1);
  return inEur / (rates[to] ?? 1);
}
function monthlyNative(svc) {
  const a = Number(svc.amount) || 0;
  return svc.cycle === 'annual' ? a / 12 : a;
}
function annualNative(svc) {
  const a = Number(svc.amount) || 0;
  return svc.cycle === 'annual' ? a : a * 12;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d - today) / 86400000);
}
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function cycleLabel(cycle) {
  return cycle === 'monthly' ? '/ mo' : cycle === 'annual' ? '/ yr' : 'est. / mo';
}

// Start of the current billing period = the renewal/expire date minus one
// cycle (annual → -1 year, everything else → -1 month). Returns YYYY-MM-DD.
function periodStartISO(endStr, cycle) {
  if (!endStr) return null;
  const d = new Date(endStr + 'T00:00:00');
  if (cycle === 'annual') d.setFullYear(d.getFullYear() - 1);
  else d.setMonth(d.getMonth() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Percentage of the current period elapsed (0–100), today relative to the
// start → expire window.
function periodProgress(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const start = new Date(startStr + 'T00:00:00').getTime();
  const end = new Date(endStr + 'T00:00:00').getTime();
  if (!(end > start)) return 0;
  return Math.max(0, Math.min(100, ((Date.now() - start) / (end - start)) * 100));
}

// ── Count / size / token / relative-time formatters (for the live stats) ────
function fmtCount(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}
function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toLocaleString('en-US');
}
function relTime(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Service category glyphs (lucide-style, generic — not brand logos) ──────
const G = {
  supabase: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  ),
  anthropic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2.2 5.6L20 11l-5.8 2.4L12 19l-2.2-5.6L4 11l5.8-2.4z" />
      <path d="M19 16l.9 2.3L22 19l-2.1.7L19 22l-.9-2.3L16 19l2.1-.7z" />
    </svg>
  ),
  resend: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  ),
  domain: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" />
    </svg>
  ),
  apple: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s7-3.5 7-9V6l-7-3-7 3v7c0 5.5 7 9 7 9z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
};

// External-link + edit glyphs for the service-card actions.
const ExtIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></svg>
);
const EditIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);

// ── The service inventory (realistic placeholders, scanned from the stack) ──
const SERVICES = [
  {
    id: 'supabase', provider: 'Supabase', category: 'Backend platform', glyph: G.supabase, accent: '#3ECF8E',
    plan: 'Pro', amount: 25, currency: 'USD', cycle: 'monthly', nextRenewal: '2026-06-18',
    status: 'healthy', statusLabel: 'Healthy', meta: 'eu-west-1 · pntxlvhkqfryyyxlqytr',
    summary: 'Postgres, Auth, Storage, Realtime & Edge Functions — the app backbone.',
    stats: [
      { label: 'Database', value: '1.24 GB', sub: 'of 8 GB', pct: 15 },
      { label: 'Storage', value: '14.3 GB', sub: 'projects + pending', pct: 29 },
      { label: 'Monthly active users', value: '342', sub: 'of 100k', pct: 1 },
      { label: 'Edge invocations', value: '48.2k', sub: 'this month' },
      { label: 'Egress', value: '21.6 GB', sub: 'of 250 GB', pct: 9 },
    ],
  },
  {
    id: 'anthropic', provider: 'Anthropic', category: 'AI · Claude API', glyph: G.anthropic, accent: '#C8643C',
    plan: 'Pay-as-you-go', amount: 38.4, currency: 'USD', cycle: 'usage', nextRenewal: '2026-07-01',
    status: 'active', statusLabel: 'Active', meta: 'claude-opus-4-7',
    summary: 'Powers the legal-ai & project-ai Edge Functions (digests + summaries).',
    stats: [
      { label: 'Spend (MTD)', value: '$38.40', sub: 'usage-based' },
      { label: 'Credit balance', value: '$61.60', sub: 'auto-reload at $20' },
      { label: 'Input tokens', value: '4.21M', sub: 'this month' },
      { label: 'Output tokens', value: '1.08M', sub: 'this month' },
      { label: 'Requests', value: '1,930', sub: 'this month' },
    ],
  },
  {
    id: 'resend', provider: 'Resend', category: 'Transactional email', glyph: G.resend, accent: '#6366F1',
    plan: 'Pro', amount: 20, currency: 'USD', cycle: 'monthly', nextRenewal: '2026-06-24',
    status: 'warning', statusLabel: 'Verify domain', meta: 'from @docvex.ro',
    summary: 'Outbound invite, welcome & support-report emails via Edge Functions.',
    stats: [
      { label: 'Emails sent', value: '1,284', sub: 'of 50,000', pct: 3 },
      { label: 'Deliverability', value: '99.2%', sub: '30-day avg' },
      { label: 'Domain', value: 'docvex.ro', sub: 'pending verification', flag: 'warning' },
      { label: 'Bounce rate', value: '0.4%', sub: 'healthy' },
    ],
  },
  {
    id: 'domain', provider: 'docvex.ro', category: 'Domain & SSL', glyph: G.domain, accent: '#0D9488',
    plan: '.ro registration', amount: 24, currency: 'EUR', cycle: 'annual', nextRenewal: '2027-02-14',
    status: 'healthy', statusLabel: 'Active', meta: 'ROTLD · auto-renew on',
    summary: 'Primary domain. DNS points to GitHub Pages; SSL via Let’s Encrypt.',
    stats: [
      { label: 'Registrar', value: 'ROTLD', sub: 'auto-renew on' },
      { label: 'SSL certificate', value: 'Valid', sub: 'Let’s Encrypt → 30 Aug 2026' },
      { label: 'DNS', value: 'GitHub Pages', sub: 'CNAME + A records' },
      { label: 'Nameservers', value: '2 active', sub: 'propagated' },
    ],
  },
  {
    id: 'apple', provider: 'Apple Developer', category: 'Code signing', glyph: G.apple, accent: '#8A8F98',
    plan: 'Individual', amount: 99, currency: 'USD', cycle: 'annual', nextRenewal: null,
    status: 'action', statusLabel: 'Not enrolled', meta: 'macOS builds ad-hoc signed',
    summary: 'Needed for a Developer-ID signature + notarization on macOS releases.',
    stats: [
      { label: 'Enrollment', value: 'Not enrolled', sub: 'action needed', flag: 'action' },
      { label: 'Current signing', value: 'Ad-hoc', sub: 'no Developer ID' },
      { label: 'Impact', value: 'Gatekeeper warns', sub: 'on Apple Silicon' },
      { label: 'Cost to enroll', value: '$99 / yr', sub: 'individual' },
    ],
  },
];

// ── Shared atoms ────────────────────────────────────────────────────────────
function StatusPill({ status, label }) {
  return <span className={`dc-pill s-${status}`}><span className="dot" />{label}</span>;
}

function Countdown({ dateStr }) {
  const d = daysUntil(dateStr);
  if (d == null) return <span className="dc-count-pill dc-count-none">No date set</span>;
  let cls = 'dc-count-ok', txt;
  if (d < 0) { cls = 'dc-count-urgent'; txt = `${Math.abs(d)}d overdue`; }
  else if (d === 0) { cls = 'dc-count-urgent'; txt = 'Renews today'; }
  else if (d <= 14) { cls = 'dc-count-urgent'; txt = `in ${d} days`; }
  else if (d <= 45) { cls = 'dc-count-soon'; txt = `in ${d} days`; }
  else { txt = `in ${d} days`; }
  return <span className={`dc-count-pill ${cls}`}>{txt}</span>;
}

function StatCell({ stat, full }) {
  return (
    <div className={full ? 'dc-stat-full' : ''}>
      <div className="dc-stat-label">{stat.label}</div>
      <div className={`dc-stat-value${stat.flag ? ' flag-' + stat.flag : ''}`}>{stat.value}</div>
      {stat.sub ? <div className="dc-stat-sub">{stat.sub}</div> : null}
      {typeof stat.pct === 'number' ? (
        <div className="dc-stat-bar"><i style={{ width: Math.max(3, stat.pct) + '%' }} /></div>
      ) : null}
    </div>
  );
}

function ServiceCard({ svc, onEdit, displayCurrency }) {
  // "native" keeps each service in its own currency; any real currency converts.
  const cur = displayCurrency === 'native' ? svc.currency : displayCurrency;
  const amt = displayCurrency === 'native' ? svc.amount : convert(svc.amount, svc.currency, displayCurrency);
  return (
    <div className="dc-svc" style={{ '--svc-accent': svc.accent }}>
      <div className="dc-svc-top">
        <div className="dc-svc-icon">{svc.glyph}</div>
        <div className="dc-svc-id">
          <div className="dc-svc-name">{svc.provider}</div>
        </div>
        <Tooltip content="Edit service">
          <button type="button" className="dc-svc-edit" onClick={() => onEdit(svc)} aria-label="Edit service">
            {EditIcon}
          </button>
        </Tooltip>
      </div>
      <div className="dc-svc-pricerow">
        <span className="dc-svc-price-amt">{fmtMoney(amt, cur)} <small>{cycleLabel(svc.cycle)}</small></span>
        {svc.nextRenewal && <Countdown dateStr={svc.nextRenewal} />}
      </div>
      {svc.nextRenewal && (() => {
        const startStr = periodStartISO(svc.nextRenewal, svc.cycle);
        const pct = periodProgress(startStr, svc.nextRenewal);
        return (
          <div className="dc-svc-progress">
            <div className="dc-svc-progress-bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="dc-svc-progress-dates">
              <span>{fmtDate(startStr)}</span>
              <span>{fmtDate(svc.nextRenewal)}</span>
            </div>
          </div>
        );
      })()}
      {svc.stats.length > 0 && (
        <div className="dc-svc-stats">
          {svc.stats.map((s, i) => <StatCell key={i} stat={s} full={s.flag === 'action'} />)}
        </div>
      )}
      <div className="dc-svc-actions">
        {svc.dashboardUrl ? (
          <button type="button" className="dc-svc-link" onClick={() => openExternal(svc.dashboardUrl)}>
            {ExtIcon} Open dashboard
          </button>
        ) : <span className="dc-svc-link is-empty">No dashboard link</span>}
      </div>
    </div>
  );
}

// ── Derived spend math + shared blocks ──────────────────────────────────────
function isActive(s) { return s.status !== 'action'; }
function spendTotals(services, base = BASE, rates = DEFAULT_RATES) {
  let m = 0, a = 0;
  services.forEach((s) => {
    if (!isActive(s)) return;
    m += convert(monthlyNative(s), s.currency, base, rates);
    a += convert(annualNative(s), s.currency, base, rates);
  });
  return { m, a };
}
function soonestRenewal(services) {
  return services
    .filter((s) => s.nextRenewal)
    .map((s) => ({ s, d: daysUntil(s.nextRenewal) }))
    .sort((x, y) => x.d - y.d)[0];
}

// ── Mailbox intelligence ────────────────────────────────────────────────────
const MailIcons = {
  spark: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="m3 7 9 6 9-6" /><path d="M18 2.5l.7 1.8L20.5 5l-1.8.7L18 7.5l-.7-1.8L15.5 5l1.8-.7z" /></svg>,
  gmail: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>,
  outlook: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="5" width="12" height="14" rx="1.5" /><rect x="3" y="7" width="8" height="10" rx="2" /><path d="M5.5 11h3" /></svg>,
  imap: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>,
  scan: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>,
  invoice: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l3 3v15l-2-1.2L15 21l-2-1.2L11 21l-2-1.2L7 21 5 19.8z" /><path d="M9 8h6M9 12h6" /></svg>,
  usage: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="m7 14 3-3 3 3 5-6" /></svg>,
  renewal: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v4h-4" /></svg>,
  price: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M7 9l5-4 5 4" /></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>,
};

const NewSvcGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
  </svg>
);

// Glyph lookup by the stored `icon` key; unknown / custom services fall back to
// the generic package glyph.
const GLYPH_BY_ICON = { supabase: G.supabase, anthropic: G.anthropic, resend: G.resend, domain: G.domain, apple: G.apple, generic: NewSvcGlyph };

// Map a raw app_services row (snake_case) into the shape the cards + spend math
// expect (camelCase + resolved glyph).
function rowToService(r) {
  return {
    ...r,
    amount: Number(r.amount) || 0,
    nextRenewal: r.next_renewal || null,
    statusLabel: r.status_label || '',
    dashboardUrl: r.dashboard_url || '',
    glyph: GLYPH_BY_ICON[r.icon] || NewSvcGlyph,
    stats: Array.isArray(r.stats) ? r.stats : [],
  };
}

// ── Service editor modal (add / edit / delete one subscription) ─────────────
const ICON_OPTIONS = ['supabase', 'anthropic', 'resend', 'domain', 'apple', 'generic'];
const CURRENCY_OPTIONS = ['EUR', 'USD', 'RON'];
const CYCLE_OPTIONS = [['monthly', 'Monthly'], ['annual', 'Annual'], ['usage', 'Usage-based']];
const STATUS_OPTIONS = [['healthy', 'Healthy'], ['active', 'Active'], ['warning', 'Warning'], ['action', 'Action needed']];

function ServiceEditorModal({ service, onSave, onDelete, onCancel }) {
  const isNew = !service?.id;
  const [f, setF] = useState(() => ({
    id: service?.id || '',
    provider: service?.provider || '',
    category: service?.category || '',
    plan: service?.plan || '',
    icon: service?.icon || 'generic',
    accent: service?.accent || '#6366F1',
    amount: service?.amount ?? 0,
    currency: service?.currency || 'USD',
    cycle: service?.cycle || 'monthly',
    next_renewal: service?.nextRenewal || '',
    status: service?.status || 'active',
    status_label: service?.statusLabel || '',
    meta: service?.meta || '',
    summary: service?.summary || '',
    dashboard_url: service?.dashboardUrl || '',
  }));
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!f.provider.trim()) return;
    setSaving(true);
    await onSave({ ...f, amount: Number(f.amount) || 0, next_renewal: f.next_renewal || null });
    setSaving(false);
  };

  return (
    <div className="dc-modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dc-modal dc-modal-wide" role="dialog" aria-modal="true">
        <div className="dc-modal-hd">
          <div className="dc-modal-hd-icon" style={{ background: 'var(--accent-tint)', color: 'var(--accent)' }}>{NewSvcGlyph}</div>
          <div>
            <h3>{isNew ? 'Add service' : `Edit ${service.provider || 'service'}`}</h3>
            <p>Subscription details drive the renewals timeline and spend totals.</p>
          </div>
        </div>
        <form className="dc-form" onSubmit={submit}>
          <div className="dc-form-grid">
            <label className="dc-field dc-col-2"><span>Provider *</span><input value={f.provider} onChange={(e) => set('provider', e.target.value)} required autoFocus /></label>
            <label className="dc-field"><span>Amount</span><input type="number" step="0.01" min="0" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></label>
            <label className="dc-field"><span>Currency</span><select value={f.currency} onChange={(e) => set('currency', e.target.value)}>{CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <label className="dc-field"><span>Billing cycle</span><select value={f.cycle} onChange={(e) => set('cycle', e.target.value)}>{CYCLE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="dc-field"><span>Next renewal</span><input type="date" value={f.next_renewal || ''} onChange={(e) => set('next_renewal', e.target.value)} /></label>
            <label className="dc-field"><span>Status</span><select value={f.status} onChange={(e) => set('status', e.target.value)}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="dc-field"><span>Icon</span><select value={f.icon} onChange={(e) => set('icon', e.target.value)}>{ICON_OPTIONS.map((i) => <option key={i} value={i}>{i}</option>)}</select></label>
            <label className="dc-field"><span>Accent</span><input type="color" value={f.accent} onChange={(e) => set('accent', e.target.value)} /></label>
            <label className="dc-field dc-col-2"><span>Dashboard URL</span><input type="url" value={f.dashboard_url} onChange={(e) => set('dashboard_url', e.target.value)} placeholder="https://…" /></label>
          </div>
          <div className="dc-modal-actions">
            {!isNew && (
              <button type="button" className="dc-btn dc-btn-danger" style={{ marginRight: 'auto' }} onClick={() => onDelete(service)}>
                Delete
              </button>
            )}
            <button type="button" className="dc-btn dc-btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="submit" className="dc-btn dc-btn-primary" disabled={saving || !f.provider.trim()}>
              {saving ? 'Saving…' : isNew ? 'Add service' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const KIND_META = {
  invoice: { label: 'Invoice', icon: MailIcons.invoice },
  usage: { label: 'Usage', icon: MailIcons.usage },
  renewal: { label: 'Renewal', icon: MailIcons.renewal },
  'price-change': { label: 'Price change', icon: MailIcons.price },
  action: { label: 'Action needed', icon: MailIcons.alert },
  'new-service': { label: 'New service', icon: MailIcons.plus },
};

const EXTRACTIONS = [
  { id: 'x1', kind: 'invoice', serviceId: 'supabase', confidence: 98, subject: 'Your Supabase Pro invoice — receipt #SB-20847', sender: 'billing@supabase.io', when: '2 days ago', note: 'Monthly Pro charge confirmed. Next billing date matches your tracked renewal.', fields: { amount: 25, currency: 'USD', nextRenewal: '2026-06-18' } },
  { id: 'x2', kind: 'price-change', serviceId: 'resend', confidence: 91, subject: 'Important: an update to your Resend plan pricing', sender: 'team@resend.com', when: '4 days ago', note: 'Pro tier rising from $20 → $24 / mo, effective 1 Aug 2026.', fields: { amount: 24, currency: 'USD' } },
  { id: 'x3', kind: 'usage', serviceId: 'anthropic', confidence: 95, subject: 'Your Anthropic API usage summary is ready', sender: 'billing@anthropic.com', when: 'Yesterday', note: 'Month-to-date usage across the legal-ai & project-ai functions.', fields: { amount: 38.4, currency: 'USD' } },
  { id: 'x4', kind: 'renewal', serviceId: 'domain', confidence: 93, subject: 'ROTLD — domeniul docvex.ro: notificare de reînnoire', sender: 'noreply@rotld.ro', when: '5 days ago', note: 'Annual .ro registration. Renewal date and fee confirmed.', fields: { nextRenewal: '2027-02-14', amount: 24, currency: 'EUR' } },
  { id: 'x5', kind: 'action', serviceId: 'resend', confidence: 88, subject: 'Verify your sending domain to keep delivering email', sender: 'no-reply@resend.com', when: '6 days ago', note: 'docvex.ro is still pending DNS verification — invites may not be delivered.', fields: {} },
  { id: 'x6', kind: 'new-service', serviceId: null, confidence: 84, subject: 'Your GitHub receipt — Copilot Business', sender: 'receipt@github.com', when: '1 week ago', note: 'A recurring charge from a service you’re not tracking yet. Add it to the console?', fields: { amount: 19, currency: 'USD' }, newService: { provider: 'GitHub Copilot', category: 'AI · Dev tooling', plan: 'Business', cycle: 'monthly', accent: '#6E5494' } },
];

const PROVIDERS = [
  { id: 'gmail', label: 'Gmail', icon: MailIcons.gmail, addr: 'billing@docvex.ro' },
  { id: 'outlook', label: 'Outlook', icon: MailIcons.outlook, addr: 'billing@docvex.ro' },
  { id: 'imap', label: 'IMAP / other', icon: MailIcons.imap, addr: 'billing@docvex.ro' },
];

function fieldRows(fields) {
  const rows = [];
  if (fields.amount != null) rows.push({ label: 'Amount', value: fmtMoney(fields.amount, fields.currency || 'USD') });
  if (fields.nextRenewal) rows.push({ label: 'Renewal', value: fmtDate(fields.nextRenewal) });
  return rows;
}

function ExtractionCard({ item, services, onApply, onDismiss }) {
  const meta = KIND_META[item.kind] || KIND_META.invoice;
  const svc = services.find((s) => s.id === item.serviceId);
  const matchName = item.kind === 'new-service' ? (item.newService && item.newService.provider) : (svc ? svc.provider : 'Unmatched');
  const rows = fieldRows(item.fields);
  const canApply = item.kind === 'new-service' || rows.length > 0;
  const applyLabel = item.kind === 'new-service' ? 'Add to tracker' : 'Apply to ' + (svc ? svc.provider : 'service');
  return (
    <div className={`dc-extract ${item.status === 'applied' ? 'is-applied' : ''} ${item.status === 'dismissed' ? 'is-dismissed' : ''}`}>
      <div className="dc-extract-top">
        <span className={`dc-kind k-${item.kind}`}>{meta.icon}{meta.label}</span>
        <span className="dc-extract-conf">
          {item.confidence}% match
          <span className="dc-conf-bar"><i style={{ width: item.confidence + '%' }} /></span>
        </span>
      </div>
      <div>
        <div className="dc-extract-subject">{item.subject}</div>
        <div className="dc-extract-from">{item.sender} · {item.when}</div>
      </div>
      <div className="dc-extract-match">
        {item.kind === 'new-service' ? 'Not yet tracked · ' : 'Matched to '}<b>{matchName}</b>
      </div>
      <div className="dc-extract-note">{item.note}</div>
      {rows.length > 0 && (
        <div className="dc-fields">
          {rows.map((r, i) => <div className="dc-field" key={i}><span>{r.label}</span><b>{r.value}</b></div>)}
        </div>
      )}
      <div className="dc-extract-actions">
        {item.status === 'applied' ? (
          <span className="dc-applied-tag">{MailIcons.check}{item.appliedSummary || (item.kind === 'new-service' ? 'Added to tracker' : 'Applied')}</span>
        ) : item.status === 'dismissed' ? (
          <button className="dc-btn dc-btn-ghost dc-btn-sm" onClick={() => onApply(item)}>Restore</button>
        ) : (
          <>
            {canApply && (
              <button className="dc-btn dc-btn-primary dc-btn-sm" onClick={() => onApply(item)}>
                {item.kind === 'new-service' ? MailIcons.plus : MailIcons.check}{applyLabel}
              </button>
            )}
            <button className="dc-btn dc-btn-ghost dc-btn-sm" onClick={() => onDismiss(item)}>Dismiss</button>
          </>
        )}
      </div>
    </div>
  );
}

function EmailSection({ inbox, extractions, services, onConnect, onDisconnect, onScan, onToggleAuto, onApply, onDismiss }) {
  const pending = extractions.filter((x) => x.status === 'new').length;
  return (
    <section className="dc-mail">
      <div className="dc-mail-head">
        <h2>Mailbox intelligence</h2>
        <span className="dc-ai-chip">{MailIcons.spark} Claude · claude-opus-4-7</span>
        <div className="dc-mail-head-spacer" />
        {inbox.connected && <button className="dc-btn dc-btn-sm" onClick={onScan}>{MailIcons.scan} Scan now</button>}
      </div>

      {!inbox.connected ? (
        <div className="dc-connect">
          <div className="dc-connect-icon">{MailIcons.spark}</div>
          <h3>Connect your company inbox</h3>
          <p>Let Claude read incoming billing emails and automatically extract invoices, renewal dates and price changes — then apply them to the services above. Read-only, via your existing Edge Functions.</p>
          <div className="dc-providers">
            {PROVIDERS.map((p) => (
              <button className="dc-provider" key={p.id} onClick={() => onConnect(p)}>{p.icon} {p.label}</button>
            ))}
          </div>
          <div className="dc-connect-note">{MailIcons.lock} Read-only access · emails are parsed inside your own Supabase project and never stored.</div>
        </div>
      ) : (
        <>
          <div className="dc-inbox">
            <div className="dc-inbox-avatar">{MailIcons.check}</div>
            <div className="dc-inbox-id">
              <div className="dc-inbox-addr">{inbox.address}<StatusPill status="healthy" label="Connected" /></div>
              <div className="dc-inbox-sub">{inbox.provider} · last scan {inbox.lastScan}</div>
            </div>
            <div className="dc-inbox-spacer" />
            <div className="dc-inbox-stat"><b>{inbox.scanned.toLocaleString('en-US')}</b><span>EMAILS SCANNED</span></div>
            <div className="dc-inbox-stat"><b>{pending}</b><span>NEW SIGNALS</span></div>
            <div className="dc-inbox-stat" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <button className="dc-toggle-mini" onClick={onToggleAuto} aria-pressed={inbox.autoScan}
                style={{ width: 34, height: 19, borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative', background: inbox.autoScan ? 'var(--success)' : 'var(--border-strong)', transition: 'background 150ms' }}>
                <i style={{ position: 'absolute', top: 2, left: inbox.autoScan ? 17 : 2, width: 15, height: 15, borderRadius: '50%', background: '#fff', transition: 'left 150ms', boxShadow: '0 1px 2px rgba(0,0,0,.3)' }} />
              </button>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>AUTO-SCAN</span>
            </div>
            <button className="dc-btn dc-btn-ghost dc-btn-sm" onClick={onDisconnect}>Disconnect</button>
          </div>

          <div className="dc-section-label" style={{ margin: '4px 0 14px' }}>
            Extracted from your inbox <span className="dc-count">{extractions.length} signals</span>
          </div>
          <div className="dc-extract-grid">
            {extractions.map((x) => (
              <ExtractionCard key={x.id} item={x} services={services} onApply={onApply} onDismiss={onDismiss} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ── Danger zone ─────────────────────────────────────────────────────────────
const DangerIcons = {
  skull: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a9 9 0 0 0-5 16.5V21a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.5A9 9 0 0 0 12 2z" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><path d="M10 21v-2M14 21v-2" /></svg>,
  db: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" /></svg>,
  bucket: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16l-1.5 13a1 1 0 0 1-1 .9H6.5a1 1 0 0 1-1-.9z" /><path d="M3 7h18M9 4h6" /></svg>,
  session: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17 5 12l5-5M5 12h12" /></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.5 12.5 8-8M17 3l3 3-3 3-3-3z" /></svg>,
  mail: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6M5 19l5-5M19 19l-5-5" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>,
  warn: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>,
};

const DANGER_ACTIONS = [
  { id: 'purge-db', icon: DangerIcons.db, title: 'Drop the entire database', admin: true, button: 'Drop database', confirm: 'DROP DATABASE', modalTitle: 'Drop the entire database?', modalSub: 'This wipes all data in project pntxlvhkqfryyyxlqytr. There is no undo and no backup is taken automatically.', descNode: (<>Permanently truncate <b>every table</b> in the Supabase project — projects, files, members, change&nbsp;requests, notifications and legal updates.</>), consequences: ['All 11 tables are truncated (projects, project_files, members, change_requests, …)', 'Every user loses all of their projects and history', 'RLS policies and schema remain; only rows are deleted'], toast: 'Database drop executed — all tables truncated.' },
  { id: 'empty-buckets', icon: DangerIcons.bucket, title: 'Empty all storage buckets', admin: true, button: 'Empty buckets', confirm: 'EMPTY BUCKETS', modalTitle: 'Empty all storage buckets?', modalSub: 'Canonical and pending file bytes are deleted from Supabase Storage. Thumbnails and uploads cannot be recovered.', descNode: (<>Delete every object in the <code>projects</code> and <code>projects-pending</code> buckets. File rows will point at missing bytes.</>), consequences: ['All objects under projects/ and projects-pending/ are removed', 'Downloads and previews will 404 until files are re-uploaded', 'Database rows are left intact (orphaned)'], toast: 'Storage buckets emptied — all objects deleted.' },
  { id: 'revoke-sessions', icon: DangerIcons.session, title: 'Revoke all sessions', admin: false, button: 'Revoke sessions', confirm: 'REVOKE', modalTitle: 'Revoke all active sessions?', modalSub: 'Calls signOut with global scope for every user. Active sessions are terminated immediately.', descNode: (<>Sign every user out across all devices and invalidate refresh tokens. Everyone must re-authenticate.</>), consequences: ['All refresh tokens are revoked server-side', 'Every signed-in user is logged out on next request', 'OAuth links remain; users just sign in again'], toast: 'All sessions revoked — every user signed out.' },
  { id: 'rotate-keys', icon: DangerIcons.key, title: 'Rotate all API keys', admin: true, button: 'Rotate keys', confirm: 'ROTATE KEYS', modalTitle: 'Rotate all API keys?', modalSub: 'New secrets are generated for every connected service. Anything using the current keys will break until redeployed.', descNode: (<>Roll the Supabase anon key, Resend and Anthropic secrets. Old keys stop working immediately — a redeploy is required.</>), consequences: ['Supabase anon + service keys regenerated', 'RESEND_API_KEY and ANTHROPIC_API_KEY rolled', 'Edge Functions + clients must be redeployed with new secrets'], toast: 'API keys rotated — redeploy with the new secrets.' },
  { id: 'erase-mailbox', icon: DangerIcons.mail, title: 'Erase mailbox data & disconnect', admin: false, button: 'Erase & disconnect', confirm: 'ERASE', modalTitle: 'Erase mailbox data?', modalSub: 'The connected inbox is unlinked and every extracted signal is discarded. Re-connecting starts a fresh scan.', descNode: (<>Disconnect the linked inbox and permanently delete all AI-extracted signals.</>), consequences: ['Inbox connection is removed', 'All extracted invoices / renewals / price changes are deleted', 'Applied changes to services are kept'], toast: 'Mailbox disconnected and extracted data erased.' },
  { id: 'nuke', icon: DangerIcons.skull, title: 'Reset everything', admin: true, nuclear: true, button: 'Reset everything', confirm: 'DELETE EVERYTHING', modalTitle: 'Reset the entire console?', modalSub: 'This runs every destructive action at once. The DocVex backend is returned to an empty state. This absolutely cannot be undone.', descNode: (<>The nuclear option: drop the database, empty storage, revoke every session, rotate all keys and disconnect every integration in one go.</>), consequences: ['Database truncated + storage emptied', 'All sessions revoked + API keys rotated', 'Every integration disconnected and reset'], toast: 'Full reset executed — backend returned to empty state.' },
];

function DangerModal({ action, onConfirm, onCancel }) {
  const [text, setText] = useState('');
  const match = text.trim() === action.confirm;
  return (
    <div className="dc-modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dc-modal" role="dialog" aria-modal="true">
        <div className="dc-modal-hd">
          <div className="dc-modal-hd-icon">{DangerIcons.warn}</div>
          <div>
            <h3>{action.modalTitle}</h3>
            <p>{action.modalSub}</p>
          </div>
        </div>
        <div className="dc-modal-body">
          <ul className="dc-modal-consequences">
            {action.consequences.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
          <div className="dc-confirm-label">Type <b>{action.confirm}</b> to confirm</div>
          <input
            className="dc-confirm-input" value={text} autoFocus spellCheck="false" placeholder={action.confirm}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && match) onConfirm(action); }}
          />
        </div>
        <div className="dc-modal-actions">
          <button className="dc-btn dc-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="dc-btn dc-btn-danger-solid" disabled={!match} onClick={() => onConfirm(action)}>{action.button}</button>
        </div>
      </div>
    </div>
  );
}

function DangerZone({ done, onRequest }) {
  return (
    <section className="dc-danger">
      <div className="dc-danger-card">
        <div className="dc-danger-hd">
          <div className="dc-danger-hd-icon">{DangerIcons.warn}</div>
          <div>
            <h2>Danger zone</h2>
            <p>Permanent, irreversible actions. Each one asks you to type a confirmation phrase.</p>
          </div>
        </div>
        {DANGER_ACTIONS.map((a) => (
          <div className={`dc-danger-row${a.nuclear ? ' is-nuclear' : ''}`} key={a.id}>
            <div className="dc-danger-info">
              <div className="dc-danger-title">{a.title}{a.admin && <span className="dc-admin-tag">Owner only</span>}</div>
              <div className="dc-danger-desc">{a.descNode}</div>
            </div>
            {done[a.id] ? (
              <span className="dc-danger-done">{DangerIcons.check} Done</span>
            ) : (
              <button className="dc-btn dc-btn-danger" onClick={() => onRequest(a)}>{a.button}</button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Live platform metrics (real data from get_admin_stats) ──────────────────
// A grid of the genuinely-real aggregates the backend RPC rolls up across
// every project + auth + storage. Distinct from the spend band below, which
// reflects the owner-maintained subscription config.
function PlatformBand({ stats, loading, error }) {
  if (error) {
    return (
      <div className="dc-metrics-msg">
        {DangerIcons.warn} Couldn’t load live stats — {error}
      </div>
    );
  }
  const s = stats;
  const cells = s ? [
    { label: 'Users', value: fmtCount(s.users.total), sub: `${fmtCount(s.users.active_30d)} active · 30 days` },
    { label: 'Projects', value: fmtCount(s.projects.total), sub: s.projects.new_30d > 0 ? `+${fmtCount(s.projects.new_30d)} this month` : 'none new this month' },
    { label: 'Memberships', value: fmtCount(s.members), sub: `${fmtCount(s.invitations_pending)} invites pending` },
    { label: 'Files', value: fmtCount(s.storage.files), sub: `${fmtCount(s.storage.pending_files)} pending review` },
    { label: 'Storage', value: fmtBytes(s.storage.bytes), sub: `+ ${fmtBytes(s.storage.pending_bytes)} pending` },
    { label: 'AI requests', value: fmtCount(s.ai.requests), sub: s.ai.last_used_at ? `last ${relTime(s.ai.last_used_at)}` : 'none logged yet' },
    { label: 'Emails sent', value: fmtCount(s.emails?.invites_total), sub: `${fmtCount(s.emails?.invites_accepted)} accepted · ${fmtCount(s.invitations_pending)} pending` },
    { label: 'Notifications', value: fmtCount(s.notifications), sub: 'delivered all-time' },
    { label: 'Messages', value: fmtCount((s.chat_messages || 0) + (s.private_messages || 0)), sub: `${fmtCount(s.chat_messages)} team · ${fmtCount(s.private_messages)} DM` },
  ] : [];
  return (
    <div className="dc-metrics">
      {loading && !s
        ? Array.from({ length: 8 }).map((_, i) => <div className="dc-metric-cell is-loading" key={i} />)
        : cells.map((c) => (
            <div className="dc-metric-cell" key={c.label}>
              <div className="dc-metric-label">{c.label}</div>
              <div className="dc-metric-value">{c.value}</div>
              <div className="dc-metric-sub">{c.sub}</div>
            </div>
          ))}
    </div>
  );
}

// ── Console access (manage the admin allowlist) ─────────────────────────────
// Self-contained section backed by the app_admins RPCs. Lets an existing
// admin authorize / revoke other emails for the Developer Console.
function AccessSection() {
  const [admins, setAdmins] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);

  const load = async () => {
    const { data, error: e } = await listAppAdmins();
    if (e) setError(e.message || 'Could not load the allowlist.');
    else { setAdmins(data); setError(null); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const onAdd = async (ev) => {
    ev.preventDefault();
    const v = email.trim().toLowerCase();
    if (!v || !v.includes('@')) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    const { error: e } = await addAppAdmin(v);
    setBusy(false);
    if (e) { setError(e.message || 'Could not authorize that email.'); return; }
    setEmail('');
    setError(null);
    load();
  };
  const onRemove = async (addr) => {
    setRemoving(addr);
    const { error: e } = await removeAppAdmin(addr);
    setRemoving(null);
    if (e) { setError(e.message || 'Could not revoke that email.'); return; }
    setError(null);
    load();
  };

  return (
    <section className="dc-access">
      <div className="dc-section-label">
        Console access
        {admins && <span className="dc-count">{admins.length}</span>}
      </div>

      <form className="dc-access-add" onSubmit={onAdd}>
        <input
          className="dc-access-input"
          type="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          spellCheck="false"
          autoComplete="off"
        />
        <button className="dc-btn dc-btn-primary" type="submit" disabled={busy || !email.trim()}>
          {MailIcons.plus} {busy ? 'Authorizing…' : 'Authorize'}
        </button>
      </form>

      {error && <div className="dc-access-error">{DangerIcons.warn} {error}</div>}

      <div className="dc-access-list">
        {loading && !admins ? (
          <div className="dc-access-empty">Loading allowlist…</div>
        ) : admins && admins.length ? (
          admins.map((a) => (
            <div className="dc-access-row" key={a.email}>
              <span className="dc-access-avatar">{(a.email[0] || '?').toUpperCase()}</span>
              <div className="dc-access-id">
                <div className="dc-access-mail">{a.email}</div>
                <div className="dc-access-sub">
                  Added {a.added_at ? relTime(a.added_at) : ''}{a.added_by_email ? ` · by ${a.added_by_email}` : ''}
                </div>
              </div>
              <Tooltip content={admins.length <= 1 ? 'Cannot remove the last admin' : 'Revoke access'}>
                <button
                  type="button"
                  className="dc-access-remove"
                  onClick={() => onRemove(a.email)}
                  disabled={removing === a.email || admins.length <= 1}
                >
                  {removing === a.email ? '…' : '✕'}
                </button>
              </Tooltip>
            </div>
          ))
        ) : (
          <div className="dc-access-empty">No authorized emails.</div>
        )}
      </div>
    </section>
  );
}

// ── Animated currency dropdown (replaces the native select so the menu can
// fade + pop in). Closes on outside-click / Escape. ────────────────────────
const CurChevron = (
  <svg className="dc-cur-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
);
// Display options: "As set" keeps each service in its own currency; the rest
// convert every price + the total into the chosen currency.
const CURRENCY_DISPLAY_OPTIONS = [
  { value: 'native', label: 'As set' },
  { value: 'EUR', label: 'EUR' },
  { value: 'USD', label: 'USD' },
  { value: 'RON', label: 'RON' },
];
function CurrencyDropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (
    <div className="dc-cur-dd" ref={wrapRef}>
      <button
        type="button"
        className={`dc-cur-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current?.label ?? value}{CurChevron}
      </button>
      {open && (
        <div className="dc-cur-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dc-cur-opt${o.value === value ? ' is-active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Total recurring cost (currency controlled by the section dropdown) ──────
function TotalCost({ services, currency }) {
  const activeCount = services.filter(isActive).length;
  // A single total can't be "native" (mixed currencies) — fall back to EUR.
  const cur = currency === 'native' ? 'EUR' : currency;
  const { m, a } = spendTotals(services, cur);

  return (
    <div className="dc-svc-total">
      <div className="dc-svc-total-label">
        Total recurring cost
        <span className="dc-svc-total-sub">{activeCount} active · in {cur}{currency === 'native' ? ' (converted)' : ''}</span>
      </div>
      <div className="dc-svc-total-figs">
        <span className="dc-svc-total-fig"><strong>{fmtMoney(m, cur)}</strong> / month</span>
        <span className="dc-svc-total-fig"><strong>{fmtMoney(a, cur, { decimals: 0 })}</strong> / year</span>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function Admin() {
  // Service inventory — real, loaded from app_services (was the hardcoded
  // SERVICES constant). `editorService`: undefined = closed, null = add-new,
  // object = editing that row.
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [editorService, setEditorService] = useState(undefined);
  // Display currency for the All services section (cards + total). "native"
  // shows each service as entered; a real currency converts everything.
  const [displayCurrency, setDisplayCurrency] = useState('native');

  const reloadServices = async () => {
    const { data, error } = await listAppServices();
    if (!error && data) setServices(data.map(rowToService));
    return { error };
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await listAppServices();
      if (cancelled) return;
      if (!error && data) setServices(data.map(rowToService));
      setServicesLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);
  const [inbox, setInbox] = useState({ connected: false, address: '', provider: '', lastScan: '', scanned: 0, autoScan: true });
  const [extractions, setExtractions] = useState(() => EXTRACTIONS.map((x) => ({ ...x, status: 'new' })));
  const [pendingDanger, setPendingDanger] = useState(null);
  const [dangerDone, setDangerDone] = useState({});
  const [toast, setToast] = useState(null);

  const today = useMemo(() => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), []);

  // Compact-header-on-scroll, mirroring the Versions page exactly. The page
  // scrolls inside the single-window pane's `.sv-single-scroll` (falling back
  // to `.main-content`); we listen there and fade a fixed, blurred bar in once
  // the masthead has scrolled away. Hysteresis (show past 32px, hide under 8px)
  // prevents flicker at the threshold.
  const pageRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    if (!scroller) return undefined;
    const onScroll = () => {
      const top = scroller.scrollTop;
      setScrolled((s) => (s ? top > 8 : top > 32));
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);
  const scrollToTop = () => {
    pageRef.current?.closest('.sv-single-scroll, .main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Spend summary figures for the masthead kicker + compact status pill.
  const { m: monthlySpend } = spendTotals(services);
  const activeCount = services.filter(isActive).length;
  const nextRenewal = soonestRenewal(services.filter(isActive));

  // Real platform aggregates from the backend (get_admin_stats RPC). Gated to
  // the admin allowlist server-side; non-admins get an error we surface inline.
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await getAdminStats();
      if (cancelled) return;
      if (error) setStatsError(error.message || 'request failed');
      else setStats(data);
      setStatsLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Mailbox handlers ──
  const onConnect = (p) => setInbox({ connected: true, address: p.addr, provider: p.label, lastScan: 'just now', scanned: 1284, autoScan: true });
  const onDisconnect = () => setInbox({ connected: false, address: '', provider: '', lastScan: '', scanned: 0, autoScan: true });
  const onScan = () => setInbox((p) => ({ ...p, lastScan: 'just now', scanned: p.scanned + 7 }));
  const onToggleAuto = () => setInbox((p) => ({ ...p, autoScan: !p.autoScan }));
  const onDismiss = (item) => setExtractions((prev) => prev.map((x) => (x.id === item.id ? { ...x, status: 'dismissed' } : x)));
  const onApply = (item) => {
    if (item.status === 'dismissed') {
      setExtractions((prev) => prev.map((x) => (x.id === item.id ? { ...x, status: 'new' } : x)));
      return;
    }
    let summary;
    if (item.kind === 'new-service' && item.newService) {
      const ns = item.newService;
      const newSvc = {
        id: 'inbox-' + item.id, provider: ns.provider, category: ns.category, plan: ns.plan,
        glyph: NewSvcGlyph, accent: ns.accent || '#6366F1',
        amount: item.fields.amount || 0, currency: item.fields.currency || 'USD', cycle: ns.cycle || 'monthly',
        nextRenewal: item.fields.nextRenewal || null, status: 'active', statusLabel: 'Active',
        meta: 'Added from inbox · ' + item.sender, summary: 'Detected from a billing email and added to your tracker.',
        stats: [
          { label: 'Source', value: 'Inbox scan' },
          { label: 'Detected', value: item.when },
          { label: 'Confidence', value: item.confidence + '%' },
        ],
      };
      setServices((prev) => (prev.some((s) => s.id === newSvc.id) ? prev : [...prev, newSvc]));
      summary = 'Added ' + ns.provider;
    } else {
      const svc = services.find((s) => s.id === item.serviceId);
      const cur = svc ? svc.currency : (item.fields.currency || 'USD');
      const parts = [];
      if (item.fields.amount != null) parts.push('price ' + fmtMoney(item.fields.amount, cur));
      if (item.fields.nextRenewal) parts.push('renewal ' + fmtDate(item.fields.nextRenewal));
      setServices((prev) => prev.map((s) => {
        if (s.id !== item.serviceId) return s;
        const next = { ...s };
        if (item.fields.amount != null) next.amount = item.fields.amount;
        if (item.fields.nextRenewal) next.nextRenewal = item.fields.nextRenewal;
        return next;
      }));
      summary = parts.length ? 'Updated ' + parts.join(' · ') : 'Applied';
    }
    setExtractions((prev) => prev.map((x) => (x.id === item.id ? { ...x, status: 'applied', appliedSummary: summary } : x)));
  };

  // ── Danger handlers ──
  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(window.__dcToastT);
    window.__dcToastT = setTimeout(() => setToast(null), 3800);
  };
  const onConfirmDanger = (action) => {
    if (action.id === 'erase-mailbox' || action.id === 'nuke') {
      setInbox({ connected: false, address: '', provider: '', lastScan: '', scanned: 0, autoScan: true });
      setExtractions([]);
    }
    setDangerDone((prev) => ({ ...prev, [action.id]: true }));
    setPendingDanger(null);
    showToast(action.toast);
  };

  // ── Service inventory handlers ──
  const onSaveService = async (form) => {
    const { error } = await upsertAppService(form);
    if (error) { showToast(`Could not save service — ${error.message || 'error'}`); return; }
    await reloadServices();
    setEditorService(undefined);
    showToast(form.id ? 'Service updated.' : 'Service added.');
  };
  const onDeleteService = async (svc) => {
    if (!window.confirm(`Remove ${svc.provider} from the tracked inventory? This only deletes the record here, not the actual subscription.`)) return;
    const { error } = await deleteAppService(svc.id);
    if (error) { showToast('Could not delete service.'); return; }
    setServices((prev) => prev.filter((s) => s.id !== svc.id));
    setEditorService(undefined);
    showToast('Service removed.');
  };

  return (
    <div className="dc-console" ref={pageRef}>
      {/* Compact header — fades/slides in once the masthead has scrolled away,
          mirroring the Versions page exactly: title · eyebrow · a clickable
          status pill (with a dot) that jumps back to the top. */}
      <MiniHeaderFade visible={scrolled} />
      <div className={`dc-compact mini-glow${scrolled ? ' is-visible' : ''}`} aria-hidden={!scrolled} onMouseMove={miniHeaderSpot}>
        <span className="dc-compact-title">Services &amp; billing</span>
        <span className="dc-compact-sep" aria-hidden="true">·</span>
        <span className="dc-compact-eyebrow">Developer console</span>
        <Tooltip content="Back to top">
          <button
            type="button"
            className="dc-compact-status"
            onClick={scrollToTop}
          >
            <span className="dc-compact-dot" aria-hidden="true" />
            {activeCount} active · {fmtMoney(monthlySpend, BASE, { decimals: 0 })} / mo
          </button>
        </Tooltip>
      </div>

      <div className="dc-page">
        {/* Masthead — mirrors the Versions page: accent eyebrow + muted kicker,
            big display title, then a stat line summarising spend + renewals. */}
        <header className="dc-masthead">
          <div className="dc-mh-left">
            <div className="dc-mh-eyebrow">
              <span>Developer console</span>
              <span className="dc-mh-muted">· {today}</span>
            </div>
            <h1 className="dc-mh-title">Services &amp; billing.</h1>
            <p className="dc-mh-kicker">
              <strong>{services.length} {services.length === 1 ? 'service' : 'services'}</strong> tracked
              {' · '}<strong>{fmtMoney(monthlySpend, BASE)}</strong> / month
              {nextRenewal && <> · next renewal <strong>{nextRenewal.s.provider}</strong> in {nextRenewal.d} days</>}
            </p>
          </div>
        </header>

        <AccessSection />

        <div className="dc-section-label">Platform metrics</div>
        <PlatformBand stats={stats} loading={statsLoading} error={statsError} />

        <div className="dc-section-label">
          All services <span className="dc-count">{services.length}</span>
          <div className="dc-section-spacer" />
          <CurrencyDropdown value={displayCurrency} options={CURRENCY_DISPLAY_OPTIONS} onChange={setDisplayCurrency} />
          <button type="button" className="dc-btn dc-btn-sm dc-btn-primary" onClick={() => setEditorService(null)}>
            {MailIcons.plus} Add service
          </button>
        </div>
        {servicesLoading && services.length === 0 ? null : services.length === 0 ? (
          <div className="dc-svc-empty">No services tracked yet. Add your first subscription to populate the spend totals.</div>
        ) : (
          <>
            <div className="dc-svc-grid">
              {services.map((s) => (
                <ServiceCard key={s.id} svc={s} onEdit={setEditorService} displayCurrency={displayCurrency} />
              ))}
            </div>
            {/* Total recurring cost — sum of every active subscription,
                normalised to per-month + per-year. Click to shuffle currency. */}
            <TotalCost services={services} currency={displayCurrency} />
          </>
        )}

        <EmailSection
          inbox={inbox} extractions={extractions} services={services}
          onConnect={onConnect} onDisconnect={onDisconnect} onScan={onScan}
          onToggleAuto={onToggleAuto} onApply={onApply} onDismiss={onDismiss}
        />

        <DangerZone done={dangerDone} onRequest={setPendingDanger} />
      </div>

      {editorService !== undefined && (
        <ServiceEditorModal
          service={editorService}
          onSave={onSaveService}
          onDelete={onDeleteService}
          onCancel={() => setEditorService(undefined)}
        />
      )}
      {pendingDanger && (
        <DangerModal action={pendingDanger} onConfirm={onConfirmDanger} onCancel={() => setPendingDanger(null)} />
      )}
      {toast && (
        <div className="dc-toast">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          {toast}
        </div>
      )}
    </div>
  );
}
