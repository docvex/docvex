// The app's interface language.
//
// DocVex was written in English, and its words live in some 300 components.
// Rather than threading a `t()` call through every one of them, the translation
// is applied where the words END UP: a single observer over the document that
// swaps each piece of interface text (a text node, or a placeholder / title /
// aria-label / alt) for its translation from `i18n/ro.json`, and puts the
// English back when the language is switched to English.
//
// What it never touches is the CONTENT — a Word document, a PDF's or a
// picture's text layer, an act's text, chat messages, AI answers, file names,
// anything typed (fields, editable text) and any subtree marked
// `data-no-i18n`. Only text that matches an interface string EXACTLY (or one of
// the patterns made from `${…}` templates) is changed, so a document paragraph
// is never rewritten even outside those areas.
//
// This is the interface only. Nothing here reaches the AI: prompts are built
// from code, not from the screen, so the language a document is WRITTEN in is
// decided by the request (see LANGUAGE_RULE in lib/docRules), never by this
// setting.
//
// React and the swap get along: React writes a text node's value outright on
// its next render, which the observer sees and translates again; it never reads
// a value back.

import RO from './i18n/ro.json';

export const LANGUAGES = [
  { id: 'ro', label: 'Română' },
  { id: 'en', label: 'English' },
  // Follows the operating system's language: Romanian when it is Romanian,
  // English for anything else.
  { id: 'system', label: 'System' },
];
export const DEFAULT_LANGUAGE = 'ro';

const DICTS = { ro: RO };

// Where the words are someone's content, not the app's.
const SKIP = [
  'script', 'style', 'textarea', 'input', 'select', 'option', 'code', 'pre', 'kbd',
  '[contenteditable=""]', '[contenteditable="true"]', '[data-no-i18n]',
  '.dv-docx', '.docx-wrapper', '.docx', '.dv-docx-livecard', '.dcx-inline',
  '.file-preview-pdf-text', '.dv-textlayer', '.dv-textmarks', '.dv-textline',
  '.lg-body', '.lg-src-head', '.lg-tbl', '.lg-table', '.lg-diagram',
  '.aichat-md', '.md', '.vb-msg-text', '.vb-msg-body', '.vb-msg-author',
  '.fx-tile-name', '.fx-name', '.fx-name-ext',
  '.dv-extracted', '.rs-act-card', '.cp-col',
].join(',');

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-hint'];

let lang = 'en';
let pref = null;      // what was asked for: 'ro' | 'en' | 'system'
let exact = null;     // Map: English → translation
let patterns = [];    // [{ re, out }] from strings holding {0}, {1}…
let observer = null;
// node → { src, out }: the English a node held and what it was turned into,
// so switching back to English can restore it.
const textMemo = new WeakMap();
const attrMemo = new WeakMap(); // element → { [attr]: { src, out } }

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(dict) {
  exact = new Map();
  patterns = [];
  for (const [en, out] of Object.entries(dict || {})) {
    if (!out || out === en) continue;
    if (/\{\d+\}/.test(en)) {
      const order = [];
      const src = escapeRe(en).replace(/\\\{(\d+)\\\}/g, (_, n) => { order.push(Number(n)); return '(.+?)'; });
      // A pattern that is nothing but placeholders would match anything.
      if (!/[A-Za-z]{2}/.test(en.replace(/\{\d+\}/g, ''))) continue;
      patterns.push({ re: new RegExp(`^${src}$`), order, out });
    } else {
      exact.set(en, out);
    }
  }
  // Longer patterns first, so the most specific one wins.
  patterns.sort((a, b) => b.out.length - a.out.length);
}

/** The translation of one interface string, or the string itself. */
export function translate(text) {
  if (lang === 'en' || !exact || typeof text !== 'string') return text;
  const key = norm(text);
  if (!key || !/[A-Za-z]/.test(key)) return text;
  let out = exact.get(key);
  if (out == null) {
    for (const p of patterns) {
      const m = key.match(p.re);
      if (!m) continue;
      out = p.out.replace(/\{(\d+)\}/g, (_, n) => {
        const v = m[p.order.indexOf(Number(n)) + 1] ?? '';
        return exact.get(v) ?? v;
      });
      break;
    }
  }
  if (out == null) return text;
  // Keep the spacing around the words (JSX puts text beside numbers).
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  return lead + out + trail;
}

/** For code that builds strings outside the DOM's reach (native dialogs, the window title). */
export const t = translate;
export function currentLanguage() { return lang; }

function skipped(el) {
  return !el || (el.closest && el.closest(SKIP));
}

function doText(node) {
  const v = node.nodeValue;
  if (!v || !/[A-Za-z]/.test(v)) return;
  const memo = textMemo.get(node);
  if (memo && v === memo.out) return; // already ours
  if (skipped(node.parentElement)) return;
  const out = translate(v);
  if (out !== v) {
    textMemo.set(node, { src: v, out });
    node.nodeValue = out;
  } else if (memo) {
    textMemo.delete(node);
  }
}

function doAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    let memo = attrMemo.get(el);
    if (memo?.[a] && memo[a].out === v) continue;
    // A field's own placeholder is the app's words even though the field is skipped.
    if (a !== 'placeholder' && skipped(el)) continue;
    if (a === 'placeholder' && el.closest('[data-no-i18n],.dv-docx,.docx-wrapper')) continue;
    const out = translate(v);
    if (out !== v) {
      if (!memo) { memo = {}; attrMemo.set(el, memo); }
      memo[a] = { src: v, out };
      el.setAttribute(a, out);
    }
  }
}

function walk(root) {
  if (!root) return;
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  if (root.nodeType === 1) {
    doAttrs(root);
    if (root.matches(SKIP) && root.tagName !== 'INPUT' && root.tagName !== 'TEXTAREA') return;
  }
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        doAttrs(n);
        return n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = tw.nextNode())) doText(n);
}

function restore(root) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n = root;
  do {
    if (n.nodeType === 3) {
      const m = textMemo.get(n);
      if (m && n.nodeValue === m.out) n.nodeValue = m.src;
      textMemo.delete(n);
    } else if (n.nodeType === 1) {
      const m = attrMemo.get(n);
      if (m) {
        for (const [a, { src, out }] of Object.entries(m)) if (n.getAttribute(a) === out) n.setAttribute(a, src);
        attrMemo.delete(n);
      }
    }
  } while ((n = tw.nextNode()));
}

function onMutations(list) {
  for (const m of list) {
    if (m.type === 'characterData') doText(m.target);
    else if (m.type === 'attributes') doAttrs(m.target);
    else for (const n of m.addedNodes) walk(n);
  }
}

/** The OS language as one the app has: 'ro' or 'en'. Chromium's locale is
 *  the operating system's display language in Electron. */
export function systemLanguage() {
  const list = (typeof navigator !== 'undefined' && (navigator.languages?.length ? navigator.languages : [navigator.language])) || [];
  return /^ro\b/i.test(String(list[0] || '')) ? 'ro' : 'en';
}

function resolve(p) {
  if (p === 'system') return systemLanguage();
  return DICTS[p] || p === 'en' ? p : DEFAULT_LANGUAGE;
}

/** Switch the interface language (idempotent). `next` is the preference:
 *  'ro', 'en' or 'system'. */
export function setLanguage(next) {
  pref = next === 'system' || next === 'en' || DICTS[next] ? next : DEFAULT_LANGUAGE;
  try { localStorage.setItem('docvex.uiLanguage', pref); } catch { /* private mode */ }
  const want = resolve(pref);
  if (typeof document === 'undefined') { lang = want; return; }
  document.documentElement.setAttribute('lang', want);
  // Main draws a few native dialogs and menus of its own — tell it.
  try { window.electronAPI?.setUiLanguage?.(want); } catch { /* web / old preload */ }
  if (want === lang && (want === 'en' || observer)) return;
  if (observer) { observer.disconnect(); observer = null; }
  if (lang !== 'en') restore(document.documentElement);
  lang = want;
  if (want === 'en') return;
  compile(DICTS[want]);
  walk(document.body);
  document.title = translate(document.title);
  observer = new MutationObserver(onMutations);
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ATTRS,
  });
}

/** The language to start in before the user's preferences are read. */
export function bootLanguage() {
  try { return localStorage.getItem('docvex.uiLanguage') || DEFAULT_LANGUAGE; } catch { return DEFAULT_LANGUAGE; }
}

// Another window (a Doc Viewer, a tab window) switched language: follow it.
// On "System", follow the OS when its language changes.
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => { if (pref === 'system') setLanguage('system'); });
  window.addEventListener('storage', (e) => {
    if (e.key === 'docvex.uiLanguage' && e.newValue) setLanguage(e.newValue);
  });
}
