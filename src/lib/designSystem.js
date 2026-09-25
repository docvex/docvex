// The design system — the token catalogue behind styles/designSystem.css, the
// overrides a device keeps for them, and the AI that edits them.
//
// A TOKEN is one measurement or treatment the chrome is built from (the bar
// height, the control radius, the search box's width…). Its DEFAULT is the
// app's current value, declared in designSystem.css; an OVERRIDE is a value
// this device keeps instead (`docvex:design-system:v1`), written onto <html>
// at boot and on every change, so the whole app follows it at once. Family
// tokens (the personal / project / viewer differences) are written as a
// stylesheet rule per family instead, since they live on `[data-ds]`.
//
// The Design system tab (pages/DesignSystem) shows every element built from
// these and edits them — by hand, or by asking the AI (`askDesign`): the
// model is handed the catalogue with the current values and the family
// rules, and answers with the tokens to change. Nothing is applied until
// the user accepts.

import { askProjectAi } from './projectAi';

export const DS_KEY = 'docvex:design-system:v1';

/** The three families and what they follow. */
export const DS_FAMILIES = {
  personal: {
    label: 'Personal',
    follows: 'the Legislation tab (legislatie.just.ro) and the Newsletter',
    rule: 'Editorial masthead, no card fills — rows and sections stand on the page ground with a hairline; the search and the tools in the tab bar; generous gaps.',
    tabs: 'Activity, Newsletter and every Legislation source, Versions, Playbook, Mail, Settings, Admin, Debug, this tab',
  },
  project: {
    label: 'Project',
    follows: 'the Files tab',
    rule: 'Filled cards with the card shadow, denser lists and tiles, the tools in the path bar, actions in a bottom bar.',
    tabs: 'the project Hub and every project tab: Overview, Files, Chat, Events, Advisor',
  },
  viewer: {
    label: 'Viewer',
    follows: 'the Doc Viewer with a Word document open',
    rule: 'Floating panels over the paper with the elevated shadow, the side panel’s tab strip and title bands, quick-action tiles.',
    tabs: 'the Doc Viewer window',
  },
};

/** Which family a route belongs to. */
export function familyOf(pathname) {
  const p = String(pathname || '/');
  if (p.startsWith('/doc-viewer')) return 'viewer';
  if (p === '/projects' || p.startsWith('/projects/') || ['/files', '/chat', '/events', '/ai', '/clients', '/todos', '/generate', '/automate'].includes(p)) return 'project';
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
  { name: '--ds-tag-size', label: 'Tag type size', group: 'Pills and tags', kind: 'length', value: '9.6px', drives: 'The text in a tag (“Rev. 2”, “republicată”).' },
  { name: '--ds-tag-tracking', label: 'Tag tracking', group: 'Pills and tags', kind: 'length', value: '0.04em', drives: 'Its letter-spacing.' },
  // Surfaces
  { name: '--ds-card-radius', label: 'Card corner radius', group: 'Surfaces', kind: 'length', value: '14px', drives: 'Cards and sections (an act, the Recently viewed section, the CAEN card).' },
  { name: '--ds-row-radius', label: 'Row corner radius', group: 'Surfaces', kind: 'length', value: '8px', drives: 'List rows (a search result, a kept act).' },
  { name: '--ds-menu-radius', label: 'Menu corner radius', group: 'Surfaces', kind: 'length', value: '8px', drives: 'The foot of a dropdown list.' },
  { name: '--ds-hairline', label: 'Hairline', group: 'Surfaces', kind: 'color', value: 'var(--border)', drives: 'The line cards, rows and controls are edged with.' },
  { name: '--ds-content-max', label: 'Content width', group: 'Surfaces', kind: 'length', value: 'var(--content-max-width, 1280px)', drives: 'The cap a page’s content stops at on a wide window.' },
  // Families
  { name: '--ds-card-fill', label: 'Card fill', group: 'Families', kind: 'color', family: 'personal', value: 'transparent', drives: 'Whether a card or section is filled (project, viewer) or stands on the page ground (personal).' },
  { name: '--ds-card-fill', label: 'Card fill', group: 'Families', kind: 'color', family: 'project', value: 'var(--bg-card)', drives: 'Whether a card or section is filled (project, viewer) or stands on the page ground (personal).' },
  { name: '--ds-card-fill', label: 'Card fill', group: 'Families', kind: 'color', family: 'viewer', value: 'var(--bg-card)', drives: 'Whether a card or section is filled (project, viewer) or stands on the page ground (personal).' },
  { name: '--ds-card-shadow', label: 'Card shadow', group: 'Families', kind: 'shadow', family: 'personal', value: 'none', drives: 'The shadow under a card.' },
  { name: '--ds-card-shadow', label: 'Card shadow', group: 'Families', kind: 'shadow', family: 'project', value: 'var(--shadow-card)', drives: 'The shadow under a card.' },
  { name: '--ds-card-shadow', label: 'Card shadow', group: 'Families', kind: 'shadow', family: 'viewer', value: 'var(--shadow-elev)', drives: 'The shadow under a card.' },
  { name: '--ds-section-gap', label: 'Section gap', group: 'Families', kind: 'length', family: 'personal', value: '20px', drives: 'The air between a page’s sections.' },
  { name: '--ds-section-gap', label: 'Section gap', group: 'Families', kind: 'length', family: 'project', value: '12px', drives: 'The air between a page’s sections.' },
  { name: '--ds-section-gap', label: 'Section gap', group: 'Families', kind: 'length', family: 'viewer', value: '12px', drives: 'The air between a page’s sections.' },
  { name: '--ds-row-density', label: 'Row density', group: 'Families', kind: 'number', family: 'personal', value: '1', drives: 'A factor on list row padding (1 = the Legislation rows; less = tighter).' },
  { name: '--ds-row-density', label: 'Row density', group: 'Families', kind: 'number', family: 'project', value: '0.85', drives: 'A factor on list row padding.' },
  { name: '--ds-row-density', label: 'Row density', group: 'Families', kind: 'number', family: 'viewer', value: '0.9', drives: 'A factor on list row padding.' },
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
  const fam = { personal: [], project: [], viewer: [] };
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
  const fam = { personal: [], project: [], viewer: [] };
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
    'Rules: keep one design language across the app — every section builds from the same elements, and the three FAMILIES below only differ in the family tokens. Never touch colours except through the tokens listed (colour lives elsewhere). Keep values plausible for a desktop UI at 1x (px, em, %, unitless factors; `var(--x)` expressions are allowed). Change as few tokens as the request needs.',
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
