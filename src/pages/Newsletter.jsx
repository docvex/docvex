import React, { useMemo, useState } from 'react';
import './Newsletter.css';

// Newsletter — Legal Newsfeed v2 "Editorial" (ported from the Claude
// Design handoff `docvex-newsfeed`). A typographically-led briefing of
// Romanian legal/legislation updates with AI summaries, impact level,
// impacted areas, and AI-workflow insights tying each update to the
// user's matters.
//
// Differences from the prototype: the design's standalone shell +
// sidebar mock + Tweaks panel are dropped (docvex's AppShell + sidebar
// + ThemeContext own those). The theme toggle is therefore not wired
// here — the page reads whatever theme the app is in. The AI brief +
// insights are always shown.
//
// The feed data is demo content; "now" is pinned to 2026-05-24 so the
// Today / Yesterday / This week groupings stay stable.

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

const NOW = new Date('2026-05-24T10:00:00Z'); // fixed "now" for a stable demo

// ── Feed items — realistic Romanian legal updates ───────────────────
const FEED = [
  {
    id: 'l-001',
    category: 'tax',
    impact: 'high',
    title: 'OUG 156/2024 — TVA standard urcă la 21% începând cu 1 august 2026',
    source: 'Monitorul Oficial · OUG 156/2024',
    publishedAt: '2026-05-24T07:30:00Z',
    unread: true,
    pinned: true,
    summary: 'Cota standard de TVA crește de la 19% la 21% pentru toate livrările de bunuri și prestările de servicii care nu beneficiază de o cotă redusă. Cotele reduse de 9% și 5% rămân neschimbate, dar lista bunurilor încadrate la 5% se restrânge — locuințele sociale ies din această categorie.',
    areas: ['Contracte comerciale', 'Facturare', 'Real estate', 'Prețuri & promoții'],
    insight: { active: 3, label: 'matters' },
    citations: 'OUG 156/2024, art. 291 Cod fiscal',
  },
  {
    id: 'l-002',
    category: 'employment',
    impact: 'high',
    title: 'Codul Muncii — concediul medical plătit integral de angajator pentru primele 5 zile',
    source: 'Legea 88/2026',
    publishedAt: '2026-05-24T05:15:00Z',
    unread: true,
    summary: 'Începând cu 1 iunie 2026, primele 5 zile de concediu medical (în loc de primele 5 calendaristice anterioare) sunt suportate integral de angajator, indiferent de cauza incapacității. Indemnizația rămâne 75% din baza de calcul, cu excepția bolilor grave (100%).',
    areas: ['Contracte de muncă', 'Politici HR', 'Bugetare salarială'],
    insight: { active: 7, label: 'employment matters' },
    citations: 'Legea 88/2026 · OUG 158/2005 modificată',
  },
  {
    id: 'l-003',
    category: 'gdpr',
    impact: 'medium',
    title: 'ANSPDCP — Ghid actualizat privind transferurile internaționale de date după Schrems III',
    source: 'ANSPDCP · Comunicat nr. 14/2026',
    publishedAt: '2026-05-23T14:00:00Z',
    unread: true,
    summary: 'Autoritatea publică un nou ghid pentru evaluarea transferurilor către state non-UE care nu beneficiază de decizie de adecvare. Sunt introduse cerințe suplimentare de Transfer Impact Assessment (TIA), iar SCC-urile trebuie completate cu măsuri tehnice documentate până la 30 septembrie 2026.',
    areas: ['DPA', 'Vendor management', 'Cloud agreements'],
    insight: { active: 2, label: 'data processors' },
    citations: 'GDPR art. 46 · Decizia Schrems III (C-311/22)',
  },
  {
    id: 'l-004',
    category: 'corporate',
    impact: 'medium',
    title: 'ONRC — Înregistrare 100% online pentru SRL-uri și obligație nouă de raportare UBO la 12 luni',
    source: 'Lege 265/1994 modificată · OUG 23/2026',
    publishedAt: '2026-05-22T09:00:00Z',
    unread: true,
    summary: 'Înființarea unui SRL devine integral electronică, fără deplasare la registru. În paralel, declarația privind beneficiarul real (UBO) trebuie reconfirmată anual, nu doar la modificări. Termen-limită pentru societățile existente: 15 ianuarie 2027. Amenzi de la 5.000 la 10.000 RON pentru nedepunere.',
    areas: ['Înființări', 'Compliance UBO', 'Restructurări'],
    insight: { active: 12, label: 'corporate matters' },
    citations: 'Legea 129/2019 · OUG 23/2026',
  },
  {
    id: 'l-005',
    category: 'litigation',
    impact: 'medium',
    title: 'ICCJ — Decizie RIL: termenul de apel curge de la comunicarea hotărârii motivate, nu de la dispozitiv',
    source: 'ICCJ · Decizia RIL 8/2026',
    publishedAt: '2026-05-21T11:00:00Z',
    unread: false,
    summary: 'Recurs în interesul legii admis: în procedura civilă, termenul de 30 de zile pentru apel se calculează exclusiv de la data comunicării hotărârii motivate către parte. Soluția pune capăt practicii neunitare a curților de apel și permite redeschiderea termenelor în dosarele în care apelul a fost respins ca tardiv pe baza comunicării minutei.',
    areas: ['Litigii comerciale', 'Litigii de muncă', 'Apeluri'],
    insight: { active: 4, label: 'open appeals' },
    citations: 'Cod procedură civilă art. 468 · ICCJ RIL 8/2026',
  },
  {
    id: 'l-006',
    category: 'employment',
    impact: 'medium',
    title: 'Telemuncă — Indemnizație obligatorie de 400 RON/lună și auditarea condițiilor de la domiciliu',
    source: 'Legea 81/2018 modificată',
    publishedAt: '2026-05-20T08:30:00Z',
    unread: false,
    summary: 'Angajatorii care folosesc telemunca trebuie să acorde o indemnizație lunară minimă de 400 RON pentru utilități și echipamente, neimpozabilă în limita acestui plafon. Se introduce și obligația unui audit anual al condițiilor de muncă de la domiciliu, cu confirmare scrisă a salariatului.',
    areas: ['Telework policies', 'Contracte de muncă', 'Sănătate & securitate'],
    insight: { active: 2, label: 'policy reviews queued' },
    citations: 'Legea 81/2018 · OG 16/2026',
  },
  {
    id: 'l-007',
    category: 'compliance',
    impact: 'high',
    title: 'DAC8 transpus — Raportare automată a tranzacțiilor cripto către ANAF din 1 ianuarie 2027',
    source: 'OG 26/2026',
    publishedAt: '2026-05-19T13:20:00Z',
    unread: false,
    summary: 'România transpune Directiva DAC8. Furnizorii de servicii de cripto-active (CASP) trebuie să raporteze automat ANAF tranzacțiile clienților cu rezidență fiscală în România. Sunt incluse: stablecoins, NFT-uri folosite ca instrumente de plată, și e-money tokens. Prima raportare anuală: 31 ianuarie 2028.',
    areas: ['CASP licensing', 'Reporting', 'KYC/AML'],
    insight: { active: 1, label: 'fintech client' },
    citations: 'Directiva (UE) 2023/2226 · OG 26/2026',
  },
  {
    id: 'l-008',
    category: 'gdpr',
    impact: 'low',
    title: 'EDPB — Linii directoare privind utilizarea pixelilor de tracking în comunicările B2B',
    source: 'EDPB · Guidelines 03/2026',
    publishedAt: '2026-05-18T10:00:00Z',
    unread: false,
    summary: 'Comitetul European pentru Protecția Datelor clarifică faptul că pixelii de tracking în emailurile către contacte B2B necesită consimțământ explicit, inclusiv pentru contactele „business-only". Excepție: monitorizarea agregată, fără identificarea individuală a destinatarului.',
    areas: ['Marketing legal', 'CRM compliance'],
    insight: null,
    citations: 'EDPB Guidelines 03/2026 · GDPR art. 6(1)',
  },
  {
    id: 'l-009',
    category: 'corporate',
    impact: 'low',
    title: 'ASF — Plafonul pentru ofertele publice fără prospect ridicat la 8 milioane EUR',
    source: 'Regulamentul ASF 5/2026',
    publishedAt: '2026-05-17T15:45:00Z',
    unread: false,
    summary: 'Plafonul anual al ofertelor publice de valori mobiliare care nu necesită prospect aprobat crește de la 5 la 8 milioane EUR, aliniindu-se la noul Listing Act european. Documentul de informare simplificat rămâne obligatoriu peste 1 milion EUR.',
    areas: ['Capital markets', 'Crowdfunding'],
    insight: null,
    citations: 'Regulamentul ASF 5/2026 · Regulament (UE) 2024/2809',
  },
  {
    id: 'l-010',
    category: 'tax',
    impact: 'medium',
    title: 'Microîntreprinderi — Plafonul de venituri scade la 100.000 EUR și se exclud activitățile de consultanță IT',
    source: 'Legea 296/2023 modificată',
    publishedAt: '2026-05-16T12:00:00Z',
    unread: false,
    summary: 'De la 1 ianuarie 2027, plafonul pentru regimul microîntreprinderilor scade de la 250.000 la 100.000 EUR. Societățile care depășesc plafonul trec automat la impozit pe profit. Activitățile de consultanță IT și management sunt excluse complet din regim, indiferent de cifra de afaceri.',
    areas: ['Tax planning', 'Restructurări fiscale', 'Consultanță IT'],
    insight: { active: 5, label: 'micro-entities' },
    citations: 'Legea 296/2023 · OUG 159/2024',
  },
  {
    id: 'l-011',
    category: 'litigation',
    impact: 'low',
    title: 'Mediere obligatorie reintrodusă pentru litigii comerciale sub 50.000 RON',
    source: 'OG 27/2026',
    publishedAt: '2026-05-15T09:30:00Z',
    unread: false,
    summary: 'Pentru litigiile patrimoniale între profesioniști cu valoare sub 50.000 RON, ședința de informare privind medierea redevine obligatorie înainte de înregistrarea acțiunii. Lipsa dovezii atrage suspendarea cauzei până la depunerea acesteia.',
    areas: ['Recuperare creanțe', 'Small claims'],
    insight: null,
    citations: 'OG 27/2026 · Legea 192/2006',
  },
];

// ── Icons ────────────────────────────────────────────────────────────
const SparkleMini = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
  </svg>
);

// ── Helpers ──────────────────────────────────────────────────────────
function relTimeLong(iso) {
  const then = new Date(iso);
  const mins = Math.round((NOW - then) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function dayGroupKey(iso) {
  const then = new Date(iso);
  const days = Math.floor((NOW - then) / 86400000);
  if (days < 1) return { key: 'today', label: 'Today', order: 0 };
  if (days < 2) return { key: 'yesterday', label: 'Yesterday', order: 1 };
  if (days < 7) return { key: 'thisweek', label: 'This week', order: 2 };
  return { key: 'earlier', label: 'Earlier this month', order: 3 };
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

function Article({ item, onOpen, onPin, onToggleRead }) {
  const cat = CATEGORIES[item.category];
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
        <p className="ed-lead">
          <span className="ed-ai-byline">{SparkleMini}<span>AI brief</span></span>
          {item.summary}
        </p>
        <div className="ed-meta">
          <span className="ed-meta-label">Affects</span>
          <span className="ed-meta-areas">
            {item.areas.map((a) => <span key={a}>{a}</span>)}
          </span>
          {item.insight && (
            <>
              <span className="ed-meta-dot" />
              <span className="ed-meta-insight">
                Touches <strong>{item.insight.active}</strong> of your {item.insight.label}
              </span>
            </>
          )}
        </div>
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
          <button type="button" className="ed-action" onClick={(e) => e.stopPropagation()}>
            Save to project
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
  const [items, setItems] = useState(() => sortFeed(FEED.map((f) => ({ ...f }))));

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
      const hay = `${it.title} ${it.summary} ${it.source} ${it.areas.join(' ')}`.toLowerCase();
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
  const touched = items.reduce((acc, i) => acc + (i.insight?.active || 0), 0);

  const onOpen = (item) => setItems((arr) => arr.map((i) => (i.id === item.id ? { ...i, unread: false } : i)));
  const onToggleRead = (id) => setItems((arr) => arr.map((i) => (i.id === id ? { ...i, unread: !i.unread } : i)));
  const onPin = (id) => setItems((arr) => sortFeed(arr.map((i) => (i.id === id ? { ...i, pinned: !i.pinned } : i))));

  const filterTabs = useMemo(() => {
    const present = CATEGORY_ORDER.filter((c) => (counts[c] || 0) > 0);
    return [{ id: 'all', label: 'All' }, ...present.map((c) => ({ id: c, label: CATEGORIES[c].label }))];
  }, [counts]);

  const today = NOW.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="ed-page">
      <header className="ed-masthead">
        <div className="ed-mast-left">
          <span className="ed-mast-eyebrow">DocVex Briefing · Romania</span>
          <h1 className="ed-mast-title">Newsletter</h1>
        </div>
        <div className="ed-mast-meta">
          <div>
            <div className="ed-mast-meta-num">{unreadCount}</div>
            <div>Unread today</div>
          </div>
          <span className="ed-mast-meta-sep" />
          <div>
            <div className="ed-mast-meta-num">{today.split(',')[0]}</div>
            <div>{today.split(',').slice(1).join(',').trim()}</div>
          </div>
        </div>
      </header>

      <p className="ed-weekly">
        <span className="ed-weekly-mark">AI weekly</span>
        <span>
          <strong>{highImpactUnread} high-impact</strong> updates this week, touching{' '}
          <strong>{touched}</strong> of your active matters. Tax and employment dominate —
          expect compliance work on the OUG 156 TVA change and the new sick-leave rules
          taking effect 1 June.
        </span>
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

      {groups.length === 0 ? (
        <div className="ed-empty">
          <div className="ed-empty-title">Nothing matches these filters</div>
          <div style={{ fontSize: 13 }}>Clear the search or pick a different section.</div>
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
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
