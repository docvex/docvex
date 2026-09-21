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
// white in both app themes, exactly like the BRAND palette in documentGen.js —
// which is what the `docvex` theme mirrors, so `docvex` overrides nothing and
// shows the document as it was written.

export const DOC_THEMES = [
  {
    id: 'docvex',
    name: 'DocVex',
    description: 'The DocVex house style — ink and cognac, Georgia over Calibri.',
    fonts: { head: "Georgia, 'Times New Roman', serif", body: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif" },
    palette: ['#0F172A', '#1E293B', '#8B5E3C', '#DCC9A3', '#F5F2EA', '#64748B'],
    sample: { title: '#0F172A', heading: '#8B5E3C', body: '#1E293B', rule: '#8B5E3C' },
    vars: null, // the document as written
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
    id: 'chancery',
    name: 'Chancery',
    description: 'Law-library green and brass — Garamond headings over Cambria.',
    fonts: { head: "Garamond, 'EB Garamond', 'Palatino Linotype', Georgia, serif", body: "Cambria, Georgia, 'Times New Roman', serif" },
    palette: ['#1F3A2E', '#2C4A3B', '#B08D3C', '#7A2E2E', '#E9E2CF', '#6B7568'],
    sample: { title: '#1F3A2E', heading: '#7A2E2E', body: '#26332D', rule: '#B08D3C' },
    vars: {
      title: '#1F3A2E', h1: '#7A2E2E', h2: '#1F3A2E', h3: '#2C4A3B',
      body: '#26332D', rule: '#B08D3C',
    },
  },
];

export const DEFAULT_DOC_THEME = 'docvex';

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
    if (id === DEFAULT_DOC_THEME) window.localStorage.removeItem(keyFor(url));
    else window.localStorage.setItem(keyFor(url), id);
  } catch { /* storage full / unavailable — the theme just isn't remembered */ }
}
