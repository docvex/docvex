// Document themes for the Doc Viewer's Word preview — the ribbon's "Theme" tab
// (components/DocRibbon). A theme is a colour palette + a heading / body font
// pair, the same idea as Word's Design → Themes.
//
// They are applied to the PREVIEW: `applyDocTheme` stamps `data-doc-theme` and a
// handful of `--dt-*` custom properties on the `.dv-docx` host, and DocViewer.css
// maps those onto docx-preview's markup (its `docx_title` / `docx_heading1…`
// style classes). The file on disk is not rewritten. Because a font change moves
// every line, the pane re-renders and re-paginates under the new theme rather
// than restyling the pages it already sliced (see DocxRenderPane).
//
// The hex values here are DOCUMENT colours, not app chrome: the page sheet is
// white in both app themes, exactly like the BRAND palette in documentGen.js.
//
// `original` is the one entry that overrides NOTHING — a theme with no `vars`
// takes every override back off the host, so the document shows exactly as its
// own file styles it. It is first, and it is the default: a theme list with no
// way back to the document as written is a list you cannot undo.
import { setIfChanged, removeAndTouch } from './syncClock';

export const DOC_THEMES = [
  {
    // The way back. `vars: null` is not an empty theme — it is what makes
    // applyDocTheme strip every override, so the file's own styles show through.
    id: 'original',
    name: 'Original',
    description: 'The document exactly as its own file styles it — no colours or fonts changed.',
    fonts: { head: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif", body: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif" },
    // Neutral: this entry has no palette of its own, because the document's is
    // whatever the document says.
    palette: ['#111827', '#374151', '#6B7280', '#9CA3AF', '#D1D5DB', '#F3F4F6'],
    sample: { title: '#1F2328', heading: '#1F2328', body: '#1F2328', rule: '#D1D5DB' },
    vars: null,
  },
  {
    id: 'docvex',
    name: 'DocVex',
    description: 'The DocVex house style — ink and cognac, Georgia over Calibri.',
    fonts: { head: "Georgia, 'Times New Roman', serif", body: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif" },
    palette: ['#0F172A', '#1E293B', '#8B5E3C', '#DCC9A3', '#F5F2EA', '#64748B'],
    sample: { title: '#0F172A', heading: '#8B5E3C', body: '#1E293B', rule: '#8B5E3C' },
    // Now that `original` carries the untouched document, this one applies the
    // house style for real instead of standing for "no theme".
    vars: {
      title: '#0F172A', h1: '#8B5E3C', h2: '#0F172A', h3: '#1E293B',
      body: '#1E293B', rule: '#8B5E3C',
    },
  },
  {
    id: 'office',
    name: 'Word Office',
    description: 'Microsoft Word’s default Office theme — blue headings, Calibri throughout.',
    fonts: { head: "'Calibri Light', Calibri, Carlito, 'Segoe UI', Arial, sans-serif", body: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif" },
    palette: ['#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#70AD47'],
    sample: { title: '#000000', heading: '#2F5496', body: '#000000', rule: '#4472C4' },
    vars: {
      title: '#000000', h1: '#2F5496', h2: '#2F5496', h3: '#1F3763',
      body: '#000000', rule: '#4472C4',
    },
  },
  {
    // The one thing neither of the others can show: the document with NO colour
    // in it. DocVex heads its sections in cognac and Word in blue, so until now
    // there was no way to see a contract as it will actually leave the office —
    // printed, signed and filed, where a coloured heading is at best ignored and
    // at worst reads as a draft. Times New Roman throughout because that is what
    // Romanian courts and notaries are handed.
    id: 'print',
    name: 'Print',
    description: 'Black on white, Times New Roman throughout — the document as it will be printed and filed.',
    fonts: {
      head: "'Times New Roman', Tinos, 'Liberation Serif', Georgia, serif",
      body: "'Times New Roman', Tinos, 'Liberation Serif', Georgia, serif",
    },
    // Greys, for the swatch row: this theme's whole point is that it has no hue.
    palette: ['#000000', '#1A1A1A', '#3D3D3D', '#6B6B6B', '#A3A3A3', '#E5E5E5'],
    sample: { title: '#000000', heading: '#000000', body: '#000000', rule: '#000000' },
    vars: {
      title: '#000000', h1: '#000000', h2: '#000000', h3: '#000000',
      body: '#000000', rule: '#000000',
    },
  },
];

// The document as written — so a file opens showing itself, and a theme is
// something the reader chooses rather than something applied behind them.
export const DEFAULT_DOC_THEME = 'original';

// ── The Original thumbnail, read from the document ─────────────────────────
// Every other theme knows its own colours; this one's ARE the file's, so a
// fixed swatch is a guess that is wrong for most documents. These are measured
// off the pages docx-preview has already laid out — the title's colour and
// face, a heading's, the body's, and the colours the document actually spends
// most of its ink on, for the swatch row.
// Returns a `{ sample, fonts, palette }` to spread over the entry, or null when
// there is nothing rendered yet (the static values then stand).
const TITLE_SEL = 'p[class*="_title" i], p[class*="subtitle" i]';
const HEAD_SEL = 'p[class*="heading1" i], p[class*="heading" i], h1, h2, h3';
// Enough of the document to be representative without walking a 300-page file.
const SAMPLE_CAP = 400;

const isBlank = (el) => !String(el.textContent || '').trim();

export function readDocSample(host) {
  const wrap = host?.querySelector?.('.docx-wrapper');
  if (!wrap) return null;
  const read = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, font: cs.fontFamily };
  };
  const first = (sel) => {
    for (const el of wrap.querySelectorAll(sel)) if (!isBlank(el)) return el;
    return null;
  };
  const titleEl = first(TITLE_SEL);
  const headEl = first(HEAD_SEL);
  // The body is the first paragraph that is NEITHER of those — a document whose
  // first line is its title would otherwise report the title as its body text.
  let bodyEl = null;
  for (const el of wrap.querySelectorAll('p, li, td')) {
    if (isBlank(el) || el === titleEl || el === headEl) continue;
    if (el.matches(TITLE_SEL) || el.matches(HEAD_SEL)) continue;
    bodyEl = el;
    break;
  }
  const title = read(titleEl);
  const head = read(headEl);
  const body = read(bodyEl);
  if (!title && !head && !body) return null;

  // The swatch row: the colours the document uses most, commonest first, so it
  // reads as this document's palette rather than as a list of everything in it.
  const seen = new Map();
  let n = 0;
  for (const el of wrap.querySelectorAll('p, li, td, span')) {
    if (n >= SAMPLE_CAP) break;
    if (isBlank(el)) continue;
    n += 1;
    const c = getComputedStyle(el).color;
    // Nothing see-through: a swatch has to be a colour, and `transparent`
    // comes back as rgba(0, 0, 0, 0) — black, which it is not.
    if (!c || /rgba\(.*,\s*0\)$/.test(c)) continue;
    seen.set(c, (seen.get(c) || 0) + 1);
  }
  const palette = [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([c]) => c);

  const fallback = body || head || title;
  return {
    sample: {
      title: (title || fallback).color,
      heading: (head || fallback).color,
      body: (body || fallback).color,
      // The document draws no rule of its own to measure, so the heading's own
      // colour stands in for it, softened by the sheet.
      rule: (head || fallback).color,
    },
    fonts: {
      head: (title || head || fallback).font,
      body: (body || fallback).font,
    },
    // A document with one colour in it gets one swatch; padding the row out
    // with invented tones would say something about the file that isn't true.
    palette: palette.length ? palette : [(fallback).color],
  };
}


export function docThemeById(id) {
  return DOC_THEMES.find((t) => t.id === id) || DOC_THEMES[0];
}

const VAR_NAMES = ['title', 'h1', 'h2', 'h3', 'body', 'rule'];

// Put a theme on a `.dv-docx` host (or take it off: `docvex` overrides nothing).
export function applyDocTheme(el, id) {
  if (!el) return;
  const theme = docThemeById(id);
  if (!theme.vars) {
    delete el.dataset.docTheme;
    VAR_NAMES.forEach((name) => el.style.removeProperty(`--dt-${name}`));
    el.style.removeProperty('--dt-font-head');
    el.style.removeProperty('--dt-font-body');
    return;
  }
  el.dataset.docTheme = theme.id;
  VAR_NAMES.forEach((name) => el.style.setProperty(`--dt-${name}`, theme.vars[name]));
  el.style.setProperty('--dt-font-head', theme.fonts.head);
  el.style.setProperty('--dt-font-body', theme.fonts.body);
}

// Remembered per file (the preview's url, less any query).
const KEY_PREFIX = 'docvex:doc-viewer:doc-theme:';
export const DOC_THEME_PREFIX = KEY_PREFIX;
const keyFor = (url) => KEY_PREFIX + String(url || '').split('?')[0];

export function loadDocTheme(url) {
  try {
    const id = window.localStorage.getItem(keyFor(url));
    return id && DOC_THEMES.some((t) => t.id === id) ? id : DEFAULT_DOC_THEME;
  } catch {
    return DEFAULT_DOC_THEME;
  }
}

export function saveDocTheme(url, id) {
  try {
    if (id === DEFAULT_DOC_THEME) removeAndTouch(keyFor(url));
    else setIfChanged(keyFor(url), id);
  } catch { /* storage full / unavailable — the theme just isn't remembered */ }
}
