// The design system — the token catalogue behind styles/designSystem.css, the
// overrides a device keeps for them, and the AI that edits them.
//
// A TOKEN is one measurement or treatment the chrome is built from (the bar
// height, the control radius, the search box's width…). Its DEFAULT is the
// app's current value, declared in designSystem.css; an OVERRIDE is a value
// this device keeps instead (`docvex:design-system:v1`), written onto <html>
// at boot and on every change, so the whole app follows it at once. Family
// tokens (card fill, shadow, section gap, row density — one family now, for
// the whole app) are written as a stylesheet rule instead, since they live
// on `[data-ds]`.
//
// The Design system tab (pages/DesignSystem) shows every element built from
// these and edits them — by hand, or by asking the AI (`askDesign`): the
// model is handed the catalogue with the current values and the family
// rules, and answers with the tokens to change. Nothing is applied until
// the user accepts.

import { askProjectAi } from './projectAi';

export const DS_KEY = 'docvex:design-system:v1';

/** The ONE family every section follows (Project and Viewer were folded into
 *  it: the whole app renders by the Legislation tab's rules). */
export const DS_FAMILIES = {
  personal: {
    label: 'DocVex',
    follows: 'the Legislation tab (legislatie.just.ro) and the Newsletter',
    rule: 'Editorial masthead, no card fills — rows and sections stand on the page ground with a hairline; the search and the tools in the tab bar; generous gaps.',
    tabs: 'every tab — Activity, Newsletter and the Legislation sources, the project Hub and every project tab, Versions, Playbook, Mail, Settings, Admin, Debug, this tab — and the Doc Viewer window',
  },
};

/** Which family a route belongs to. */
export function familyOf(pathname) {
  // One family for every route — kept as a function so the frame's
  // `data-ds` stamp stays where it is should a second family ever return.
  void pathname;
  return 'personal';
}

/**
 * The catalogue. `kind` says how the tab edits it (a length, a percentage, a
 * number, a colour expression); `drives` is what a reader sees change.
 * Family tokens carry `family` and are written per `[data-ds]`.
 */
export const DS_TOKENS = [
  // Bars
  { name: '--ds-bar-h', label: 'Bar height', group: 'Bars', kind: 'length', value: '40px', drives: 'Every mini header (the Legislation tab bar, the Files path bar, the compact mastheads) and bottom bar.' },
  { name: '--ds-bar-radius', label: 'Bar corner radius', group: 'Bars', kind: 'length', value: '9.6px', drives: 'The rounded section a pinned bar paints.' },
  { name: '--ds-bar-border', label: 'Bar border', group: 'Bars', kind: 'length', value: '1.5px', drives: 'The hairline round a pinned bar (reserved transparent while it is in flow).' },
  { name: '--ds-bar-frost', label: 'Bar frost', group: 'Bars', kind: 'percent', value: '66%', drives: 'How opaque the page colour is behind a pinned bar; the blur shows through the rest.' },
  { name: '--ds-bar-blur', label: 'Bar blur', group: 'Bars', kind: 'length', value: '6.4px', drives: 'The backdrop blur of a pinned bar.' },
  // Controls
  { name: '--ds-control-h', label: 'Control height', group: 'Controls', kind: 'length', value: '24px', drives: 'Search boxes, view toggles, tool buttons, the field rows in a bar.' },
  { name: '--ds-control-radius', label: 'Control corner radius', group: 'Controls', kind: 'length', value: '4.8px', drives: 'The corners of those controls.' },
  { name: '--ds-control-size', label: 'Control type size', group: 'Controls', kind: 'length', value: '10.4px', drives: 'The text in those controls.' },
  { name: '--ds-control-tint', label: 'Control tint', group: 'Controls', kind: 'percent', value: '4%', drives: 'The faint wash a field has at rest (of the text colour).' },
  { name: '--ds-control-tint-hover', label: 'Control tint, hovered', group: 'Controls', kind: 'percent', value: '8%', drives: 'The wash under the pointer.' },
  { name: '--ds-control-blur', label: 'Control blur', group: 'Controls', kind: 'length', value: '6.4px', drives: 'The backdrop blur of a field.' },
  { name: '--ds-search-w', label: 'Search box width', group: 'Controls', kind: 'length', value: '256px', drives: 'The words box in the Legislation tab bar and the Files search, at rest.' },
  { name: '--ds-search-w-focus', label: 'Search box width, focused', group: 'Controls', kind: 'length', value: '320px', drives: 'The same box while typing.' },
  // Type
  { name: '--ds-eyebrow-size', label: 'Eyebrow size', group: 'Type', kind: 'length', value: '8.8px', drives: 'The small accent line over a masthead title.' },
  { name: '--ds-eyebrow-tracking', label: 'Eyebrow tracking', group: 'Type', kind: 'length', value: '0.22em', drives: 'Its letter-spacing.' },
  { name: '--ds-title-size', label: 'Title size', group: 'Type', kind: 'length', value: '44.8px', drives: 'The masthead title.' },
  { name: '--ds-kicker-size', label: 'Kicker size', group: 'Type', kind: 'length', value: '12px', drives: 'The sentence under the title.' },
  { name: '--ds-label-size', label: 'Label size', group: 'Type', kind: 'length', value: '9.6px', drives: 'Small capital labels (field labels, section labels, the trail pills’ level).' },
  { name: '--ds-label-tracking', label: 'Label tracking', group: 'Type', kind: 'length', value: '0.07em', drives: 'Their letter-spacing.' },
  // Pills and tags
  { name: '--ds-pill-radius', label: 'Pill radius', group: 'Pills and tags', kind: 'length', value: '999px', drives: 'Tags, the tooltip pill, status pills.' },
  { name: '--ds-pill-h', label: 'Pill height', group: 'Pills and tags', kind: 'length', value: '20px', drives: 'Every pill — tags, statuses, the source pill.' },
  { name: '--ds-pill-pad', label: 'Pill padding', group: 'Pills and tags', kind: 'length', value: '9px', drives: 'The space either side of a pill’s text.' },
  { name: '--ds-pill-weight', label: 'Pill weight', group: 'Pills and tags', kind: 'number', value: '650', drives: 'The weight of a pill’s text.' },
  { name: '--ds-pill-tint', label: 'Soft pill tint', group: 'Pills and tags', kind: 'length', value: '14%', drives: 'How much of its tone a soft pill’s ground takes.' },
  { name: '--ds-pill-ring', label: 'Soft pill ring', group: 'Pills and tags', kind: 'length', value: '45%', drives: 'How strong a soft pill’s ring is.' },
  { name: '--ds-tag-size', label: 'Tag type size', group: 'Pills and tags', kind: 'length', value: '10.4px', drives: 'The text in every pill (“Rev. 2”, “republicată”, “Live from legislatie.just.ro”).' },
  { name: '--ds-tag-tracking', label: 'Tag tracking', group: 'Pills and tags', kind: 'length', value: '0.01em', drives: 'Its letter-spacing.' },
  // Surfaces
  { name: '--ds-card-radius', label: 'Card corner radius', group: 'Surfaces', kind: 'length', value: '14px', drives: 'Cards and sections (an act, the Recently viewed section, the CAEN card).' },
  { name: '--ds-row-radius', label: 'Row corner radius', group: 'Surfaces', kind: 'length', value: '8px', drives: 'List rows (a search result, a kept act).' },
  { name: '--ds-menu-radius', label: 'Menu corner radius', group: 'Surfaces', kind: 'length', value: '8px', drives: 'The foot of a dropdown list.' },
  { name: '--ds-hairline', label: 'Hairline', group: 'Surfaces', kind: 'color', value: 'var(--border)', drives: 'The line cards, rows and controls are edged with.' },
  { name: '--ds-content-max', label: 'Content width', group: 'Surfaces', kind: 'length', value: 'var(--content-max-width, 1280px)', drives: 'The cap a page’s content stops at on a wide window.' },
  // ── Page layout: the rules a page is laid out by, read off the Playbook
  // and the Legislation tab.
  { name: '--ds-page-inset', label: 'Window-edge inset', group: 'Page layout', kind: 'length', value: 'var(--chrome-inset, 6.4px)', drives: 'The gap the app sidebar keeps from the window’s edges — and so where a sticky header or side list sticks under the top, and how far above the window’s bottom a side list ends.' },
  { name: '--ds-rail-gap', label: 'Gap from the sidebar', group: 'Page layout', kind: 'length', value: 'var(--rail-gap, 6.4px)', drives: 'How far from the app sidebar a mini header, a footer, the header’s divider and a side list start.' },
  { name: '--ds-content-gap', label: 'Content gap', group: 'Page layout', kind: 'length', value: 'var(--content-left-gap, 17.6px)', drives: 'How far from the app sidebar a page’s CONTENT starts — its text, headings and fields (and the same on its right).' },
  { name: '--ds-divider-pull', label: 'Divider pull', group: 'Page layout', kind: 'length', value: 'calc(var(--ds-content-gap) - var(--ds-rail-gap))', drives: 'How far the header’s divider (and a side list’s left edge) run out past the content edge toward the sidebar — the content gap less the gap from the sidebar, so they start one --ds-rail-gap from it while the text stays on the content edge.' },
  { name: '--ds-head-gap', label: 'Under the header', group: 'Page layout', kind: 'length', value: '8px', drives: 'The space between the header’s divider (or a tab bar’s hairline) and what stands under it — the side list and the content.' },
  { name: '--ds-list-w', label: 'Side list width', group: 'Page layout', kind: 'length', value: '236px', drives: 'The width of a page’s side list (the Legislation workspace rail, the Playbook presets).' },
  { name: '--ds-list-gap', label: 'Side list gap', group: 'Page layout', kind: 'length', value: '20px', drives: 'The space between a side list and the content beside it — and the content’s own right padding, so both sides match.' },
  { name: '--ds-page-foot', label: 'Page foot', group: 'Page layout', kind: 'length', value: '64px', drives: 'The air at the end of a page’s content — inside its last section, so nothing stands below it to push a sticky list.' },
  // Families
  // ── Doc Viewer: the viewer window's chrome, read off the Word document's
  // layout (the reference — every other kind of file now renders by it).
  { name: '--ds-dv-panel-w', label: 'Side panel width', group: 'Doc Viewer', kind: 'length', value: '360px', drives: 'The floating side panel and the Quick actions card above it, until the gutter is dragged (a device keeps its own width after that).' },
  { name: '--ds-dv-inset', label: 'Card inset', group: 'Doc Viewer', kind: 'length', value: '8px', drives: 'How far the floating cards — the side panel, Quick actions, the page list — stand from the window’s edges; the gap between the two side cards; the document’s edge when the panel is hidden.' },
  { name: '--ds-dv-card-radius', label: 'Card corner radius', group: 'Doc Viewer', kind: 'length', value: '11.2px', drives: 'The floating cards’ corners (and the blanks panel’s, the paragraph dock’s).' },
  { name: '--ds-dv-card-frost', label: 'Card frost', group: 'Doc Viewer', kind: 'percent', value: '90%', drives: 'How opaque the page colour is on a floating card; the document shows through the rest, blurred.' },
  { name: '--ds-dv-card-blur', label: 'Card blur', group: 'Doc Viewer', kind: 'length', value: '32px', drives: 'The backdrop blur of a floating card.' },
  { name: '--ds-dv-doc-gap', label: 'Document gap', group: 'Doc Viewer', kind: 'length', value: '16px', drives: 'Added to the panel’s width to place the document’s left edge — the pages, the page list, the pills — for every kind of file (the panel’s own inset plus 8px of air).' },
  { name: '--ds-dv-rail-w', label: 'Page list width', group: 'Doc Viewer', kind: 'length', value: '126px', drives: 'The page list card beside a Word document or a PDF.' },
  { name: '--ds-dv-pill-btn', label: 'Floating pill button', group: 'Doc Viewer', kind: 'length', value: '25.6px', drives: 'The round button inside the pills that float over the document (find, zoom); a pill is that plus its border.' },
  { name: '--ds-dv-pill-top', label: 'Floating pill top', group: 'Doc Viewer', kind: 'length', value: '6.4px', drives: 'How far under the top of the document area the find bar sits.' },
  { name: '--ds-dv-pill-glass', label: 'Floating pill glass', group: 'Doc Viewer', kind: 'color', value: 'rgba(10, 12, 14, 0.92)', drives: 'The dark glass of every pill floating over the document — find, zoom, the counters, the paragraph’s Close button — in both themes.' },
  { name: '--ds-dv-pill-blur', label: 'Floating pill blur', group: 'Doc Viewer', kind: 'length', value: '17.6px', drives: 'Their backdrop blur.' },
  { name: '--ds-dv-find-w', label: 'Find bar width', group: 'Doc Viewer', kind: 'length', value: '288px', drives: 'The find pill once it is open.' },
  { name: '--ds-dv-counter-size', label: 'Counter type size', group: 'Doc Viewer', kind: 'length', value: '11px', drives: 'The page counter and the word count at the foot of the document.' },
  { name: '--ds-card-fill', label: 'Card fill', group: 'Families', kind: 'color', family: 'personal', value: 'transparent', drives: 'Whether a card or section is filled or stands on the page ground.' },
  { name: '--ds-card-shadow', label: 'Card shadow', group: 'Families', kind: 'shadow', family: 'personal', value: 'none', drives: 'The shadow under a card.' },
  { name: '--ds-section-gap', label: 'Section gap', group: 'Families', kind: 'length', family: 'personal', value: '20px', drives: 'The air between a page’s sections.' },
  { name: '--ds-row-density', label: 'Row density', group: 'Families', kind: 'number', family: 'personal', value: '1', drives: 'A factor on list row padding (1 = the Legislation rows; less = tighter).' },
];

/** The key an override is kept under: the token name, or `family:name`. */
export const tokenKey = (t) => (t.family ? `${t.family}:${t.name}` : t.name);

export function loadOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(DS_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

const listeners = new Set();
/** Called with the overrides whenever they change (any window). */
export function onDesignChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function saveOverrides(next) {
  const clean = {};
  for (const [k, v] of Object.entries(next || {})) if (v != null && String(v).trim()) clean[k] = String(v).trim();
  try { localStorage.setItem(DS_KEY, JSON.stringify(clean)); } catch { /* storage unavailable */ }
  applyOverrides(clean);
  for (const fn of listeners) fn(clean);
  return clean;
}

/** Writes the overrides onto the document — base tokens on <html>, family tokens as a rule per family. */
export function applyOverrides(over) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const fam = { personal: [] };
  for (const t of DS_TOKENS) {
    const v = over?.[tokenKey(t)];
    if (t.family) {
      if (v) fam[t.family].push(`${t.name}: ${v};`);
    } else if (v) root.style.setProperty(t.name, v);
    else root.style.removeProperty(t.name);
  }
  let el = document.getElementById('ds-family-overrides');
  if (!el) { el = document.createElement('style'); el.id = 'ds-family-overrides'; document.head.appendChild(el); }
  el.textContent = Object.entries(fam).filter(([, d]) => d.length).map(([f, d]) => `[data-ds="${f}"] { ${d.join(' ')} }`).join('\n');
}

/** At boot: apply what the device keeps, and follow changes made in another window. */
export function initDesignSystem() {
  applyOverrides(loadOverrides());
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => { if (e.key === DS_KEY) { const o = loadOverrides(); applyOverrides(o); for (const fn of listeners) fn(o); } });
  }
}

/** The overrides as a stylesheet — what a release would carry into designSystem.css. */
export function overridesToCss(over) {
  const base = [];
  const fam = { personal: [] };
  for (const t of DS_TOKENS) {
    const v = over?.[tokenKey(t)];
    if (!v) continue;
    if (t.family) fam[t.family].push(`  ${t.name}: ${v};`); else base.push(`  ${t.name}: ${v};`);
  }
  const out = [];
  if (base.length) out.push(`:root {\n${base.join('\n')}\n}`);
  for (const [f, d] of Object.entries(fam)) if (d.length) out.push(`[data-ds="${f}"] {\n${d.join('\n')}\n}`);
  return out.join('\n\n') || '/* no overrides */';
}

/** The current value of a token: its override, else its default. */
export const currentValue = (t, over) => over?.[tokenKey(t)] || t.value;

/**
 * Ask the AI for a design change. Returns `{ changes: { key: value }, note }`
 * — `key` as `tokenKey` gives it — or `{ error }`. Nothing is applied here.
 */
export async function askDesign(prompt, over) {
  const catalogue = DS_TOKENS.map((t) => `${tokenKey(t)} | ${t.label}${t.family ? ` (${DS_FAMILIES[t.family].label} family)` : ''} | ${t.group} | ${t.kind} | now: ${currentValue(t, over)} | default: ${t.value} | ${t.drives}`).join('\n');
  const families = Object.entries(DS_FAMILIES).map(([k, f]) => `${f.label} (${k}): follows ${f.follows}. ${f.rule} Tabs: ${f.tabs}.`).join('\n');
  const text = [
    'You are editing the DESIGN SYSTEM of Docvex, a desktop app for Romanian law firms. It is a set of CSS custom properties (tokens) that every element of the app\'s chrome is built from; changing a token changes every instance at once.',
    'Rules: keep one design language across the app — every section builds from the same elements, and there is ONE family (below) whose tokens apply everywhere. Never touch colours except through the tokens listed (colour lives elsewhere). Keep values plausible for a desktop UI at 1x (px, em, %, unitless factors; `var(--x)` expressions are allowed). Change as few tokens as the request needs.',
    'FAMILIES:\n' + families,
    'TOKENS (key | label | group | kind | now | default | drives):\n' + catalogue,
    'REQUEST: «' + String(prompt || '').trim() + '»',
    'Answer with JSON only: {"changes": {"<key>": "<value>", ...}, "note": "<one sentence saying what changed and why>"}. Keys must be from the list (a family token\'s key is "family:--name"). Give a value to RESET a token by writing its default.',
  ].join('\n\n');
  let res;
  try {
    res = await askProjectAi({ messages: [{ role: 'user', content: text }], tools: false, model: 'claude-sonnet-4-6', usageAction: 'design-system' });
  } catch (e) { return { error: e?.message || 'ai_failed' }; }
  if (res?.error) return { error: res.error };
  const m = /\{[\s\S]*\}/.exec(res?.text || '');
  if (!m) return { error: 'no_json', raw: res?.text || '' };
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return { error: 'bad_json', raw: res?.text || '' }; }
  const known = new Set(DS_TOKENS.map(tokenKey));
  const changes = {};
  for (const [k, v] of Object.entries(parsed?.changes || {})) {
    if (known.has(k) && typeof v === 'string' && v.trim()) changes[k] = v.trim();
  }
  return { changes, note: String(parsed?.note || ''), raw: res?.text || '' };
}
