import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PageMasthead from '../components/PageMasthead';
import Tooltip from '../components/Tooltip';
import Toggle from '../components/Toggle';
import RuleOptions from '../components/RuleOptions';
import DropZone from '../components/DropZone';
import { useAuth } from '../context/AuthContext';
import { extractFileText } from '../lib/extractFileText';
import {
  listSamples, addSample, removeSample,
  loadProfile, rebuildProfile, setStyleEnabled,
} from '../lib/writingStyle';
import {
  RULE_GROUPS, DEFAULT_RULES, loadDocRules, saveDocRules,
  loadRulePresets, addRulePreset, removeRulePreset, updateRulePreset, nextPresetName,
  loadActivePresetId, saveActivePresetId, presetInUse,
} from '../lib/docRules';
import { useItemSpots } from '../components/DocRibbon';
import { useRailSpotlight } from '../lib/pointerSpots';
import { toLayoutPx } from '../lib/appZoom';
import { BarPicker } from '../components/LegalBar';
import '../components/LegalBar.css';
import { SAMPLE_DOCS, sampleDocx, sampleWord } from '../lib/rulesSample';
// The rail's items are the Legislation workspace rail's (.lg-rail-item) — the
// app sidebar's tab, per the design system.
import '../components/LegalWorkspace.css';
import './Playbook.css';

// Playbook — the user's own documents, and the writing voice the AI learns from
// them.
//
// A draft that is correct but does not sound like the person sending it still
// has to be rewritten, so the time it saved is spent again. The fix is not a
// better prompt: it is showing the model how THIS person writes. So they import
// documents they wrote by hand, one pass distils those into a description of
// their drafting habits, and that description rides along with every request
// that writes or edits a document — in this project and every other.
//
// It hangs off the ACCOUNT, not a project: how someone writes follows them.

const ACCEPT = '.docx,.pdf,.txt,.md,.rtf,.csv,.xlsx';
const MAX_BYTES = 25 * 1024 * 1024;

const IconDoc = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H14l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5z" />
    <path d="M14 3v5h5" /><path d="M8.5 13h7M8.5 16h4.5" />
  </svg>
);
const IconPlus = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const IconX = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

function bytesLabel(chars) {
  if (!chars) return '';
  if (chars < 1000) return `${chars} characters`;
  return `${Math.round(chars / 1000)}k characters`;
}
function whenLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Templates (NOT MOUNTED) ──────────────────────────────────────────────
// This section was taken off the page and is kept for a rewrite: render
// <TemplatesSection onNote={setNote} /> in the page body to bring it back. The
// ── Document rules ─────────────────────────────────────────────────────────
// The half of the Playbook that is STATED rather than learned: how a document
// is numbered and laid out. A model asked twice will answer "Art. 1" once and
// "CAPITOLUL I" the next time, so consistency between two documents from the
// same office cannot come from a distilled description — it has to be a
// decision the user makes once, here. See lib/docRules for what each choice
// tells the model, and why the choices are the shapes they are (the app's own
// paragraph parser reads them back).

// ── The rules as a Word document ──────────────────────────────────────────
// A WHOLE sample contract written to the rules (lib/rulesSample `sampleWord`
// — the .docx and its blocks, each marked with the rules that shape it),
// drawn by docx-preview (the Doc Viewer's renderer) as Word draws it: A4
// sheets, the text flowing from one to the next. docx-preview does not
// paginate, so `paginateSheets` does.
//
// INSTANT: building that (the .docx, docx-preview's render, the pagination)
// is the slow part, and its result depends on nothing but the rules — so the
// FINISHED, PAGINATED document is remembered, keyed by the rules: in memory
// for the session and in localStorage across restarts (the last WORD_KEEP
// sets), as its HTML plus, per rule, the indices of the paragraphs that rule
// changes. Showing a set of rules seen before is then one innerHTML, with no
// .docx, no render and no pagination. `buildWordDoc` is the one builder,
// in-flight builds are shared, and the Playbook warms every preset's document
// in idle time so switching presets is instant too.
const WORD_PAGE_W = 794;   // an A4 sheet at 96dpi
const WORD_CACHE_KEY = 'docvex:playbook:word-doc:v1';
const WORD_KEEP = 8;
const wordMem = new Map();       // rules key → { html, affects: { key: [paragraph index] } }
const wordBuilding = new Map();  // rules key → Promise of the same
const wordKeyOf = (rules) => JSON.stringify(rules);
let wordDiskRead = false;
function readWordDisk() {
  if (wordDiskRead) return;
  wordDiskRead = true;
  try {
    const list = JSON.parse(localStorage.getItem(WORD_CACHE_KEY) || '[]');
    if (Array.isArray(list)) list.forEach((e) => { if (e && e.k && e.html) wordMem.set(e.k, { html: e.html, affects: e.affects || {} }); });
  } catch { /* unreadable: build afresh */ }
}
function cachedWordDoc(key) {
  readWordDisk();
  return wordMem.get(key) || null;
}
function keepWordDoc(key, entry) {
  wordMem.delete(key);
  wordMem.set(key, entry);   // newest last
  const list = [...wordMem.entries()].slice(-WORD_KEEP).map(([k, e]) => ({ k, html: e.html, affects: e.affects }));
  try { localStorage.setItem(WORD_CACHE_KEY, JSON.stringify(list)); } catch { /* full or blocked: memory only */ }
}

function paginateSheets(stage) {
  const wrap = stage.querySelector('.docx-wrapper');
  const first = wrap && wrap.querySelector(':scope > section.docx');
  const body = first && first.querySelector(':scope > article');
  if (!body) return;
  // The sheet's own height (docx-preview writes the page size as min-height).
  first.style.height = first.style.minHeight || '297mm';
  const cs = getComputedStyle(first);
  const avail = first.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const nodes = [...body.children];
  body.replaceChildren();
  let cur = body;
  for (const n of nodes) {
    cur.appendChild(n);
    if (cur.scrollHeight > avail + 1 && cur.children.length > 1) {
      const sheet = first.cloneNode(false);
      const next = body.cloneNode(false);
      sheet.appendChild(next);
      wrap.appendChild(sheet);
      next.appendChild(n);
      cur = next;
    }
  }
}

/** The rules' document, finished and paginated — remembered, or built once. */
function buildWordDoc(rules) {
  const key = wordKeyOf(rules);
  const have = cachedWordDoc(key);
  if (have) return Promise.resolve(have);
  if (wordBuilding.has(key)) return wordBuilding.get(key);
  const job = (async () => {
    const { blob, blocks } = await sampleWord(rules, 'services');
    const { renderAsync } = await import('docx-preview');
    // Laid out off-screen at the page's own size, so it can be paginated.
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(stage);
    try {
      await renderAsync(blob, stage, stage, {
        className: 'docx', inWrapper: true, breakPages: true,
        ignoreLastRenderedPageBreak: true, experimental: false,
      });
      // Each block's paragraph, found by its TEXT in document order.
      const paras = [...stage.querySelectorAll('section.docx p')];
      const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
      const byKey = {};
      let at = 0;
      blocks.forEach((b) => {
        const want = norm(b.text);
        if (!want) return;
        let j = at;
        while (j < paras.length && !norm(paras[j].textContent).includes(want)) j += 1;
        if (j >= paras.length) return;
        at = j + 1;
        (b.affects || []).forEach((k) => { (byKey[k] = byKey[k] || []).push(paras[j]); });
      });
      paginateSheets(stage);
      // Paragraphs as indices in the FINISHED document (pagination moves
      // them but keeps their order).
      const order = new Map([...stage.querySelectorAll('section.docx p')].map((el, i) => [el, i]));
      const affects = {};
      Object.entries(byKey).forEach(([k, els]) => { affects[k] = els.map((el) => order.get(el)).filter((i) => i != null); });
      const entry = { html: stage.innerHTML, affects };
      keepWordDoc(key, entry);
      return entry;
    } finally {
      stage.remove();
      wordBuilding.delete(key);
    }
  })();
  wordBuilding.set(key, job);
  return job;
}

/** Build, in idle time and one at a time, the documents not remembered yet. */
function warmWordDocs(rulesList) {
  const todo = rulesList.filter((r) => !cachedWordDoc(wordKeyOf(r)));
  if (!todo.length) return () => {};
  let stop = false;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  const step = () => {
    if (stop || !todo.length) return;
    buildWordDoc(todo.shift()).catch(() => {}).finally(() => { if (!stop) idle(step); });
  };
  idle(step);
  return () => { stop = true; };
}

// The document, shown. Everything it shows comes from `buildWordDoc` —
// remembered documents appear in the same frame. `hoverKey` (the setting
// hovered on the Playbook page) lights up every paragraph that setting
// changes, the rest faded back, and brings the first into view.
// `enter` = { key, dir }: the preset on show and the side the selection
// moved toward — switching preset slides the document in as the Activity tab
// switches (the detail beside it plays the same).
function WordDocView({ rules, hoverKey = null, enter = null }) {
  const enterKey = enter ? enter.key : null;
  const enterDirRef = useRef(0);
  enterDirRef.current = enter ? enter.dir : 0;
  const lastEnterRef = useRef(enterKey);   // the preset the document last slid in for
  const shownKeyRef = useRef(null);        // the rules the document on show was built for
  const slideIn = (stage) => {
    if (lastEnterRef.current === enterKey) return;
    lastEnterRef.current = enterKey;
    stage.classList.remove('is-enter-right', 'is-enter-left');
    void stage.offsetWidth;   // restart the animation on a stage already shown
    stage.classList.add(enterDirRef.current < 0 ? 'is-enter-left' : 'is-enter-right');
  };
  const docRef = useRef(null);
  const hostRef = useRef(null);
  const parasRef = useRef({ list: [], affects: {} });
  const litRef = useRef([]);
  const hoverRef = useRef(null);
  const [state, setState] = useState('loading');   // loading | ready | error
  const [updating, setUpdating] = useState(false);  // a new document is being built over the one on show
  const key = wordKeyOf(rules);

  const light = (k) => {
    hoverRef.current = k;
    litRef.current.forEach((el) => el.classList.remove('pbk-whl'));
    const { list, affects } = parasRef.current;
    litRef.current = k ? (affects[k] || []).map((i) => list[i]).filter(Boolean) : [];
    litRef.current.forEach((el) => el.classList.add('pbk-whl'));
    hostRef.current?.classList.toggle('has-lit', litRef.current.length > 0);
  };
  const show = (entry) => {
    const host = hostRef.current;
    if (!host) return;
    const first = !host.firstChild;
    const stage = document.createElement('div');
    stage.className = `pbk-word-stage is-shown${first ? ' is-first' : ''}`;
    stage.innerHTML = entry.html;
    host.replaceChildren(stage);
    if (!first) slideIn(stage); else lastEnterRef.current = enterKey;
    parasRef.current = { list: [...stage.querySelectorAll('section.docx p')], affects: entry.affects };
    litRef.current = [];
    light(hoverRef.current);   // a pick rebuilt the document under the pointer
    setState('ready');
  };

  // Remembered: shown before the first paint. Otherwise built, then shown
  // (the document on show stays until then — nothing blinks).
  useLayoutEffect(() => {
    const have = cachedWordDoc(key);
    if (have) { show(have); shownKeyRef.current = key; setUpdating(false); return undefined; }
    let cancelled = false;
    setUpdating(true);
    buildWordDoc(rules)
      .then((entry) => { if (!cancelled) { show(entry); shownKeyRef.current = key; setUpdating(false); } })
      .catch((err) => { console.warn('[playbook] word document failed', err); if (!cancelled) { setState('error'); setUpdating(false); } });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A preset switch whose document is the one ALREADY on show (two presets
  // with the same rules): the motion is replayed on it. (A new document
  // slides in as it is shown, above.)
  useLayoutEffect(() => {
    const stage = hostRef.current?.firstChild;
    if (stage && shownKeyRef.current === key) slideIn(stage);
  }, [enterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    light(hoverKey);
    litRef.current[0]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hoverKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sheets' scale: they FILL the width there is (the drawer is resized by
  // its handle), bigger or smaller than a page, within sane bounds.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || typeof ResizeObserver === 'undefined') return undefined;
    const fit = () => {
      const w = Math.max(WORD_PAGE_W * 0.4, Math.min(WORD_PAGE_W * 1.8, doc.clientWidth));
      doc.style.setProperty('--pbk-word-sheets-w', `${w}px`);
      doc.style.setProperty('--pbk-word-zoom', String(w / WORD_PAGE_W));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(doc);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="pbk-word">
      {state === 'loading' ? <p className="pbk-word-note">Writing the document…</p> : null}
      {/* A new document being built over the one on show: a quiet loader,
          the old pages staying until the new ones replace them. */}
      {updating && state === 'ready' ? (
        <div className="pbk-word-updating" role="status"><span className="pbk-word-spin" aria-hidden="true" />Updating…</div>
      ) : null}
      {state === 'error' ? <p className="pbk-word-note is-error">The document could not be built.</p> : null}
      <div className="pbk-word-doc" ref={docRef}>
        <div className="pbk-word-sheets" ref={hostRef} />
      </div>
    </div>
  );
}

// ── The Word preview, as a drawer ─────────────────────────────────────────
// The rules' Word document (WordDocView — the whole sample on A4 sheets;
// hovering a setting on the page lights up in it what that setting changes)
// in a panel that slides
// in from the RIGHT of the screen and floats OVER the page: portalled to the
// body, fixed, so it moves nothing under it. Closed by its × button, Escape,
// or a press outside it; it slides back out before it is taken away.
const DRAWER_MS = 280;
// The drawer's width: dragged by the handle on its left edge, CLAMPED to
// DRAWER_MIN…DRAWER_MAX (and never past the window), kept per device;
// double-click the handle for the default.
const DRAWER_W_KEY = 'docvex:playbook:word-drawer-w';
const DRAWER_W_DEFAULT = 836;   // one A4 sheet, snug
const DRAWER_MIN = 420;
const DRAWER_MAX = 1400;
const clampDrawerW = (w) => Math.round(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, w)));
const IconWordDoc = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="m8.5 12 1.2 5 1.3-4 1.3 4 1.2-5" />
  </svg>
);
// A REMEMBERED document (see buildWordDoc) is in the panel as it slides in.
// One never built waits for the slide to end before it is built — building
// is heavy main-thread work that would stall the slide and make it snap.
// After the first opening the panel is kept (hidden when closed, never
// unmounted), so the document is already there the next time.
function WordDrawer({ open, onClose, rules, hoverKey = null, enter = null }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [docOn, setDocOn] = useState(() => !!cachedWordDoc(wordKeyOf(rules)));
  const panelRef = useRef(null);
  const [width, setWidth] = useState(() => {
    try { const v = Number(localStorage.getItem(DRAWER_W_KEY)); return v ? clampDrawerW(v) : DRAWER_W_DEFAULT; } catch { return DRAWER_W_DEFAULT; }
  });
  const [dragging, setDragging] = useState(false);
  const keepWidth = (w) => { try { localStorage.setItem(DRAWER_W_KEY, String(w)); } catch { /* per-device nicety */ } };
  // Dragging the left edge: the drawer grows to the left (it is pinned right).
  const startDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = toLayoutPx(e.clientX);
    const w0 = panelRef.current ? toLayoutPx(panelRef.current.getBoundingClientRect().width) : width;
    let w = w0;
    setDragging(true);
    const move = (ev) => { w = clampDrawerW(w0 + x0 - toLayoutPx(ev.clientX)); setWidth(w); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      keepWidth(w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const gripKey = (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth((cur) => { const w = clampDrawerW(cur + (e.key === 'ArrowLeft' ? step : -step)); keepWidth(w); return w; });
  };
  useEffect(() => {
    if (!open) { setShown(false); return undefined; }
    setMounted(true);
    let t = 0;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => {
      setShown(true);
      t = setTimeout(() => setDocOn(true), DRAWER_MS + 40);
    }));
    return () => { cancelAnimationFrame(id); clearTimeout(t); };
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => {
      const panel = panelRef.current;
      // A press outside the PLAYBOOK closes it — not one anywhere on the page
      // beside it (the presets, the settings: switching preset or changing a
      // rule while watching the document is the point), nor in a tooltip / menu.
      if (panel && !panel.contains(e.target) && !e.target.closest?.('.pbk-rules-split, .tooltip, .lg-menu')) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <aside
      ref={panelRef}
      className={`pbk-drawer${shown ? ' is-open' : ''}${dragging ? ' is-dragging' : ''}`}
      style={{ '--pbk-drawer-w': `${width}px` }}
      aria-label="Word preview"
      aria-hidden={!open || undefined}
    >
      {/* The resize handle: the drawer's left edge. */}
      <div
        className="pbk-drawer-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the Word preview"
        aria-valuemin={DRAWER_MIN}
        aria-valuemax={DRAWER_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => { setWidth(DRAWER_W_DEFAULT); keepWidth(DRAWER_W_DEFAULT); }}
        onKeyDown={gripKey}
      />
      <header className="pbk-drawer-head">
        <span className="pbk-drawer-title">{IconWordDoc} In Word</span>
        <Tooltip content="Close (Esc)">
          <button type="button" className="pbk-drawer-close" aria-label="Close" onClick={onClose}>{IconX}</button>
        </Tooltip>
      </header>
      <div className="pbk-drawer-body">
        {docOn
          ? <WordDocView rules={rules} hoverKey={open ? hoverKey : null} enter={enter} />
          : <p className="pbk-word-note pbk-drawer-wait">Opening the document…</p>}
      </div>
    </aside>,
    document.body,
  );
}

// The rail's first item: the rules the AI follows NOW. Every other item is a
// preset — a named set kept beside them.
const LIVE = '__live';

function RulesSection({ importSlot = null, head = null, wordOpen = false, setWordOpen = () => {} }) {
  const [rules, setRules] = useState(() => loadDocRules());
  const setLive = useCallback((key, value) => {
    setRules((cur) => saveDocRules({ ...cur, [key]: value }));
  }, []);

  // Presets — named sets of these rules (lib/docRules), down a RAIL at the
  // left with + at its top; the selected one's rules on the right, editable,
  // with the actions that belong to it (use them, rename, delete).
  const [presets, setPresets] = useState(() => loadRulePresets());
  // The preset the rules in use ARE, if any. The rail shows the rules in use
  // as an item of their own ONLY when they match no preset — otherwise the
  // matching preset stands for them (marked "in use"), and there is one
  // Default in the list, not two.
  // ONE preset is in use at a time — the one last put in use (remembered),
  // not every preset that happens to hold the same rules.
  const [activeId, setActiveId] = useState(() => loadActivePresetId());
  const livePreset = presetInUse(presets, rules, activeId);
  const [selected, setSelected] = useState(() => livePreset?.id || LIVE);
  const [confirmDel, setConfirmDel] = useState(null);   // a preset id, asked once
  const nameRef = useRef(null);
  const [focusName, setFocusName] = useState(false);
  const railRef = useItemSpots('.lg-rail-item', true);
  // THE LAYOUT (see "The page layout" in Playbook.css): the page scrolls in
  // a pane of its own, the presets list sticky inside it — plain CSS, nothing
  // run on scroll. The one measurement is the header's height (--pbk-head,
  // on a resize), which the list's scroll-driven height needs so its foot
  // stays at the bottom of the screen while the header scrolls away.
  const headRef = useRef(null);
  useEffect(() => {
    const head = headRef.current;
    const pane = head?.parentElement;
    if (!head || !pane) return undefined;
    const size = () => pane.style.setProperty('--pbk-head', `${head.offsetHeight}px`);
    size();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(size);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);
  // The list is drawn as the APP SIDEBAR — its spotlight too: a soft
  // accent glow and a border shine following the pointer
  // (the `.spot-glow` / `.spot-shine` lib/pointerSpots injects), chasing it with
  // Sidebar.jsx's loop (lib/pointerSpots: exponential ease over elapsed time,
  // parked once settled, snapped on the first move after entering).
  useRailSpotlight(railRef);
  // The Word preview drawer's open state is the PAGE's (`wordOpen` /
  // `setWordOpen`): the Preview switch in the masthead toggles it.
  // The setting under the pointer — lit up in the drawer's document.
  const [hoverKey, setHoverKey] = useState(null);
  // Every preset's document built ahead, in idle time, so opening any is instant.
  useEffect(() => warmWordDocs([rules, ...presets.map((p) => p.rules)]), [presets, rules]);

  const preset = selected === LIVE ? null : presets.find((p) => p.id === selected) || null;
  useEffect(() => { if (selected !== LIVE && !preset) setSelected(livePreset?.id || LIVE); }, [selected, preset, livePreset]);
  // The live item left the rail (the rules now match a preset): select that preset.
  useEffect(() => { if (selected === LIVE && livePreset) setSelected(livePreset.id); }, [selected, livePreset]);
  // A new preset opens with its name selected, ready to be typed over.
  useEffect(() => {
    if (!focusName || !nameRef.current) return;
    nameRef.current.focus();
    nameRef.current.select();
    setFocusName(false);
  }, [focusName, preset]);

  const addPreset = () => {
    const name = nextPresetName(presets);
    const next = addRulePreset(name, rules);
    setPresets(next);
    const made = next.find((p) => p.name === name);
    if (made) { setSelected(made.id); setFocusName(true); }
  };
  // Editing the preset IN USE edits the rules in use with it, so the two stay
  // one thing (and the live item does not reappear beside it).
  const setPresetRule = (key, value) => {
    if (!preset) return;
    const next = { ...preset.rules, [key]: value };
    if (preset.id === livePreset?.id) setRules(saveDocRules({ ...next, enabled: rules.enabled }));
    setPresets(updateRulePreset(preset.id, { rules: next }));
  };
  const renamePreset = (name) => {
    if (!preset) return;
    setPresets(updateRulePreset(preset.id, { name }));
  };
  const usePreset = (p) => {
    setActiveId(saveActivePresetId(p.id));
    setRules(saveDocRules({ ...p.rules, enabled: true }));
  };
  const deletePreset = (p) => {
    if (p.builtin) return;   // Default is always there
    if (confirmDel !== p.id) { setConfirmDel(p.id); return; }
    setPresets(removeRulePreset(p.id));
    setConfirmDel(null);
    if (selected === p.id) setSelected(livePreset && livePreset.id !== p.id ? livePreset.id : LIVE);
  };

  // Switching preset plays the Activity tab's switch (Activity.css
  // .avt-feed.is-enter-*): the detail, keyed by the selection so it remounts,
  // enters from the side the selection moved toward in the list — a preset
  // lower down from the right, one higher up from the left. Nothing plays on
  // arrival.
  const railOrder = [...(livePreset ? [] : [LIVE]), ...presets.map((p) => p.id)];
  const slideRef = useRef({ sel: selected, dir: 0 });
  if (slideRef.current.sel !== selected) {
    const a = railOrder.indexOf(slideRef.current.sel);
    const b = railOrder.indexOf(selected);
    slideRef.current = { sel: selected, dir: a < 0 || b < 0 ? 1 : (Math.sign(b - a) || 1) };
  }
  const slideDir = slideRef.current.dir;

  // What the right side shows and edits: the live rules, or the preset's.
  // Default (the built-in) is edited like any preset; it only cannot be deleted or renamed.
  const shown = preset ? preset.rules : rules;
  const set = preset ? setPresetRule : setLive;
  const inUse = preset ? preset.id === livePreset?.id && rules.enabled : true;
  const dirty = Object.keys(DEFAULT_RULES).some((k) => k !== 'enabled' && shown[k] !== DEFAULT_RULES[k]);
  const resetShown = () => {
    if (preset) {
      if (preset.id === livePreset?.id) setRules(saveDocRules({ ...DEFAULT_RULES, enabled: rules.enabled }));
      setPresets(updateRulePreset(preset.id, { rules: { ...DEFAULT_RULES } }));
    } else setRules(saveDocRules({ ...DEFAULT_RULES, enabled: rules.enabled }));
  };

  return (
    <section className="pbk-rules" aria-label="Document rules">
      <div className="pbk-rules-split">
        {/* The masthead spans the page, over the list and the settings, and
            scrolls away with them. */}
        {head ? <div className="pbk-phead" ref={headRef}>{head}</div> : null}
        <div className="pbk-pgrid">
        {/* ── The rail: the rules in use, then every preset; + at the top. ── */}
        {/* The presets list — a fixed panel, the app sidebar's twin. */}
        <aside className="pbk-prail" ref={railRef} aria-label="Presets">
            <div className="pbk-prail-head">
              <span className="pbk-prail-label">Presets</span>
              <Tooltip content="New preset — a copy of the rules in use">
                <button type="button" className="pbk-prail-add" aria-label="New preset" onClick={addPreset}>{IconPlus}</button>
              </Tooltip>
            </div>
            <div className="pbk-prail-list">
              {!livePreset && <>
              <div
                className={`lg-rail-item${selected === LIVE ? ' is-active' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={selected === LIVE}
                onClick={() => setSelected(LIVE)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(LIVE); } }}
              >
                <span className="lg-rail-title">
                  <span className="lg-rail-kind">{rules.enabled ? 'In use' : 'Paused'}</span>
                  <span className="lg-rail-num">Custom rules</span>
                </span>
              </div>
              <div className="pbk-prail-div" aria-hidden="true" />
              </>}
              {presets.map((p) => {
                const on = p.id === livePreset?.id;
                const asking = confirmDel === p.id;
                return (
                  <React.Fragment key={p.id}>
                  <div
                    className={`lg-rail-item${selected === p.id ? ' is-active' : ''}${asking ? ' is-asking' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected === p.id}
                    onClick={() => { setSelected(p.id); setConfirmDel(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(p.id); } }}
                  >
                    <Tooltip content={p.name}>
                      <span className="lg-rail-title">
                        <span className="lg-rail-kind">{p.builtin ? 'Built in' : 'Preset'}{on ? ' · in use' : ''}</span>
                        <span className="lg-rail-num">{p.name}</span>
                      </span>
                    </Tooltip>
                    {!p.builtin && <span className="lg-rail-actions">
                      <Tooltip content={asking ? 'Press again to delete' : 'Delete'}>
                        <button
                          type="button"
                          aria-label={asking ? `Confirm deleting ${p.name}` : `Delete ${p.name}`}
                          onClick={(e) => { e.stopPropagation(); deletePreset(p); }}
                          onBlur={() => { if (asking) setConfirmDel(null); }}
                        >
                          {asking ? <span className="pbk-prail-sure">Delete?</span> : IconX}
                        </button>
                      </Tooltip>
                    </span>}
                  </div>
                  </React.Fragment>
                );
              })}
              {!presets.length ? (
                <p className="pbk-prail-empty">No presets yet. Press + to keep the rules in use as one.</p>
              ) : null}
            </div>
        </aside>

        {/* ── The selected item's data. ── */}
        <div className="pbk-pmain">
        <div
          key={selected}
          className={`pbk-pdetail${!preset && !rules.enabled ? ' is-paused' : ''}${slideDir > 0 ? ' is-enter-right' : slideDir < 0 ? ' is-enter-left' : ''}`}
        >
          <header className="pbk-pdetail-head">
            <div className="pbk-pdetail-title">
              <div className="pbk-pdetail-namerow">
              {preset?.builtin ? (
                <h3 className="pbk-pdetail-h">{preset.name}</h3>
              ) : preset ? (
                <input
                  ref={nameRef}
                  className="pbk-pdetail-name"
                  defaultValue={preset.name}
                  key={preset.id}
                  maxLength={60}
                  aria-label="Preset name"
                  onBlur={(e) => renamePreset(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { e.currentTarget.value = preset.name; e.currentTarget.blur(); }
                  }}
                />
              ) : (
                <h3 className="pbk-pdetail-h">{livePreset ? livePreset.name : 'Custom rules'}</h3>
              )}
              </div>
              <p className="pbk-pdetail-sub">
                {preset
                  ? (preset.builtin
                    ? 'Built in — the rules DocVex starts with. Change them here; Reset puts them back.'
                    : (preset.at ? `Preset · changed ${whenLabel(preset.at)}` : 'Preset'))
                  : (rules.enabled ? 'What the AI follows in every document it drafts.' : 'Paused — the AI drafts without them until they are switched back on.')}
              </p>
            </div>
            <div className="pbk-pdetail-tools">
              {/* Always laid out, hidden while there is nothing to reset \u2014 so its
                  appearing never moves the In use pill beside it. */}
              <Tooltip content={preset ? 'Put this preset back to DocVex\u2019s default rules' : 'Put every rule back to the default'}>
                <button
                  type="button"
                  className={`pbk-btn pbk-reset${dirty ? '' : ' is-idle'}`}
                  onClick={resetShown}
                  disabled={!dirty}
                  aria-hidden={!dirty || undefined}
                  tabIndex={dirty ? undefined : -1}
                >
                  Reset
                </button>
              </Tooltip>
              {preset ? (
                <>
                  {inUse ? (
                    <span className="pbk-status">In use</span>
                  ) : (
                    <Tooltip content="Make these the rules the AI follows">
                      <button type="button" className="pbk-btn is-primary" onClick={() => usePreset(preset)}>Use</button>
                    </Tooltip>
                  )}
                  {!preset.builtin && <Tooltip content={confirmDel === preset.id ? 'Press again to delete' : 'Delete this preset'}>
                    <button
                      type="button"
                      className={`pbk-btn is-danger${confirmDel === preset.id ? ' is-asking' : ''}`}
                      onClick={() => deletePreset(preset)}
                      onBlur={() => { if (confirmDel === preset.id) setConfirmDel(null); }}
                    >
                      {confirmDel === preset.id ? 'Delete?' : 'Delete'}
                    </button>
                  </Tooltip>}
                </>
              ) : (
                // In use, the "In use" pill; paused (a device that paused them
                // before), "Use these rules" (primary) turns them back on.
                rules.enabled ? (
                  <span className="pbk-status">In use</span>
                ) : (
                  <Tooltip content="Apply these rules again">
                    <button type="button" className="pbk-btn is-primary" onClick={() => setLive('enabled', true)}>Use</button>
                  </Tooltip>
                )
              )}
            </div>
          </header>

          {/* A CUSTOM preset carries the import: the documents you wrote, from
              which the AI learns your voice (not Default, the built-in, nor
              the unsaved rules in use). */}
          {preset && !preset.builtin && importSlot ? (
            <div className="pbk-pimport">{importSlot}</div>
          ) : null}

          <div className="pbk-rules-body">
            <div className="pbk-rules-sets">
              {RULE_GROUPS.map((group) => (
                <div className="pbk-ruleset" key={group.id}>
                  {/* The first group (structure and numbering) opens the form
                      with its rules straight away — no heading over it. */}
                  {group.id !== 'structure' && (
                    <>
                      <h3>{group.title}</h3>
                      <p className="pbk-ruleset-note">{group.note}</p>
                    </>
                  )}
                  {group.fields.map((f) => (
                    <div
                      className="pbk-rule"
                      key={f.key}
                      onMouseEnter={() => setHoverKey(f.key)}
                      onMouseLeave={() => setHoverKey(null)}
                      // A press on the section (not on a choice) CYCLES the
                      // rule to its next choice, round to the first after
                      // the last.
                      onClick={(e) => {
                        if (e.target.closest('.pbk-rule-opt')) return;
                        const i = f.options.findIndex((o) => o.id === shown[f.key]);
                        set(f.key, f.options[(i + 1) % f.options.length].id);
                      }}
                    >
                      {/* The hint that a press here cycles the choices. */}
                      <span className="pbk-rule-cycle" aria-hidden="true">Click to cycle</span>
                      <div className="pbk-rule-label">
                        <span>{f.label}</span>
                        {f.hint && <small>{f.hint}</small>}
                      </div>
                      {/* Each choice shows what it LOOKS like, not just what it is
                          called — "a)" means nothing until you see it in a line. */}
                      <RuleOptions field={f} value={shown[f.key]} onPick={(id) => set(f.key, id)} />
                    </div>
                  ))}
                </div>
              ))}

              <div className="pbk-ruleset">
                <h3>Anything else</h3>
                <p className="pbk-ruleset-note">
                  Rules the settings above don’t cover, in your own words — one per
                  line. They are passed to the AI exactly as written.
                </p>
                <textarea
                  className="pbk-rules-extra"
                  value={shown.extra}
                  rows={5}
                  maxLength={2000}
                  placeholder={'Always cite the article of the Civil Code in brackets.\nEnd every contract with a signature block for both parties.\nNever use the word „prezentul” more than once per clause.'}
                  onChange={(e) => set('extra', e.target.value)}
                />
              </div>
            </div>

          </div>
        </div>
        </div>
        </div>
      </div>
      <WordDrawer open={wordOpen} onClose={() => setWordOpen(false)} rules={shown} hoverKey={hoverKey} enter={{ key: selected, dir: slideDir }} />
    </section>
  );
}

// ── The sample document, as Word draws it ─────────────────────────────────
// The rules written out as a whole contract (lib/rulesSample → a real .docx),
// rendered by docx-preview — the renderer the Doc Viewer uses — over the page.
// Another sample is a dropdown away; Download saves the .docx itself.
function SampleDocViewer({ kind, rules, name, onKind, onClose }) {
  const hostRef = useRef(null);
  const blobRef = useRef(null);
  const [state, setState] = useState('loading');   // loading | ready | error
  const rulesKey = JSON.stringify(rules);
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const blob = await sampleDocx(rules, kind);
        const { renderAsync } = await import('docx-preview');
        if (cancelled || !hostRef.current) return;
        blobRef.current = blob;
        hostRef.current.innerHTML = '';
        await renderAsync(blob, hostRef.current, undefined, {
          className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true,
        });
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [kind, rulesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const label = SAMPLE_DOCS.find((d) => d.id === kind)?.label || 'Sample';
  const download = () => {
    const blob = blobRef.current;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${label} — ${name}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return createPortal(
    <div className="pbk-sample-scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pbk-sample" role="dialog" aria-modal="true" aria-label={`${label} — ${name}`}>
        <header className="pbk-sample-head">
          <div className="pbk-sample-title">
            <span className="pbk-sample-eyebrow">Sample document · {name}</span>
            <BarPicker solo label="Sample document" options={SAMPLE_DOCS} value={kind} onChange={onKind} />
          </div>
          <div className="pbk-sample-tools">
            <Tooltip content="Save this sample as a Word file">
              <button type="button" className="pbk-btn" onClick={download} disabled={state !== 'ready'}>Download .docx</button>
            </Tooltip>
            <Tooltip content="Close (Esc)">
              <button type="button" className="pbk-sample-close" aria-label="Close" onClick={onClose}>{IconX}</button>
            </Tooltip>
          </div>
        </header>
        <div className="pbk-sample-body">
          {state === 'loading' ? <p className="pbk-sample-note">Writing the sample…</p> : null}
          {state === 'error' ? <p className="pbk-sample-note is-error">The sample could not be built.</p> : null}
          <div ref={hostRef} className={`pbk-sample-doc${state === 'ready' ? ' is-ready' : ''}`} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function Playbook() {
  const { session } = useAuth();
  const signedIn = !!session?.user?.id;
  // The Word preview drawer — OPEN on arriving at the Playbook (it slides in
  // with the page); the masthead's Preview switch opens and closes it.
  const [wordOpen, setWordOpen] = useState(true);

  const [samples, setSamples] = useState([]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);
  const [note, setNote] = useState(null);       // { tone, text }
  // Filename → why it was skipped, while a batch is being read.
  const [importing, setImporting] = useState([]);

  const refresh = useCallback(async () => {
    if (!signedIn) { setLoading(false); return; }
    setLoading(true);
    const [s, p] = await Promise.all([listSamples(), loadProfile()]);
    if (!s.error) setSamples(s.samples);
    if (!p.error) setProfile(p.profile);
    setLoading(false);
  }, [signedIn]);
  useEffect(() => { refresh(); }, [refresh]);

  // Learn from whatever is currently imported. Run automatically after an
  // import or a removal — the profile is a claim about the documents on this
  // page, so it must not be allowed to disagree with them.
  const learn = useCallback(async () => {
    setLearning(true);
    const res = await rebuildProfile();
    setLearning(false);
    if (res.error) {
      setNote({
        tone: 'error',
        text: res.error.message === 'ai_not_configured'
          ? 'The AI isn’t configured on the server yet, so it can’t read these documents.'
          : 'Couldn’t reach the AI to read those documents. Try again in a moment.',
      });
      return;
    }
    setProfile(res.profile);
    setNote(res.profile.text
      ? { tone: 'ok', text: 'Learned. New documents will be written in your voice.' }
      : null);
  }, []);

  const ingest = useCallback(async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setNote(null);
    setImporting(list.map((f) => f.name));
    const skipped = [];
    let added = 0;
    for (const f of list) {
      if (f.size > MAX_BYTES) { skipped.push(`${f.name} — too large`); continue; }
      // eslint-disable-next-line no-await-in-loop
      const ex = await extractFileText(f, f.name);
      const text = ex?.text || '';
      if (!text.trim()) {
        skipped.push(`${f.name} — no text could be read from it`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const res = await addSample({ name: f.name, mimeType: f.type || '', text });
      if (res.error) skipped.push(`${f.name} — couldn’t be saved`);
      else added += 1;
    }
    setImporting([]);
    const s = await listSamples();
    if (!s.error) setSamples(s.samples);
    if (skipped.length) {
      setNote({ tone: added ? 'warn' : 'error', text: `Skipped ${skipped.length}: ${skipped.join('; ')}.` });
    }
    if (added) await learn();
  }, [learn]);

  // Optimistic: the document leaves the list the moment × is pressed; if the
  // server refuses, it goes back where it was and the note says so. Only a
  // confirmed removal re-learns the voice (that is an AI call, never guessed).
  const drop = async (id) => {
    const index = samples.findIndex((s) => s.id === id);
    const removed = samples[index];
    if (!removed) return;
    setSamples((prev) => prev.filter((s) => s.id !== id));
    const res = await removeSample(id);
    if (res.error) {
      setSamples((prev) => {
        if (prev.some((s) => s.id === id)) return prev;
        const next = prev.slice();
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
      setNote({ tone: 'error', text: `Couldn’t remove “${removed.name || 'that document'}” — it is back in the list.` });
      return;
    }
    await learn();
  };

  // Optimistic: the switch flips at once and flips back if the save fails.
  const toggle = async (on) => {
    setProfile((p) => (p ? { ...p, enabled: on } : p));
    const res = await setStyleEnabled(on);
    if (res.error) {
      setProfile((p) => (p ? { ...p, enabled: !on } : p));
      setNote({ tone: 'error', text: on ? 'Couldn’t switch your writing voice on — it is still off.' : 'Couldn’t switch your writing voice off — it is still on.' });
    }
  };

  const hasStyle = !!profile?.text;
  const busy = learning || importing.length > 0;

  const masthead = (
        <PageMasthead
          eyebrow="DocVex"
          eyebrowMuted="Your writing"
          title="Playbook"
          actions={signedIn ? (
            // At the masthead's far right, above its divider: the Word
            // preview drawer, on or off.
            <Toggle
              on={wordOpen}
              onChange={setWordOpen}
              label="Preview"
              tip={wordOpen ? 'Hide the Word preview' : 'Show the rules as a Word document, at the right'}
            />
          ) : null}
        >
          Import documents you wrote yourself and the AI learns how you draft —
          your structure, your phrasing, your tone. From then on everything it
          writes or edits for you comes out in your voice instead of its own.
        </PageMasthead>
  );

  return (
    <div className="page-frame pbk-frame">

      {!signedIn ? (
        <>{masthead}<p className="pbk-signedout">Sign in to teach the AI how you write.</p></>
      ) : (
        <div className="pbk">
          {/* ── The rules the user sets ───────────────────────────────── */}
          {/* The documents the AI learns the voice from are imported INSIDE a
              custom preset, under its name (`importSlot`). */}
          <RulesSection head={masthead} wordOpen={wordOpen} setWordOpen={setWordOpen} importSlot={(
            <>
        {/* The Timeline's import surface, shared verbatim — same component,
            same stylesheet. It collapses to its compact row once there are
            documents, exactly as it does there.

            The one deliberate difference is `accept`: the Timeline takes
            any file, because one it cannot read still anchors the story by
            name. Here a file that yields no text teaches nothing, so the
            picker is filtered to the formats that can actually be read. */}
        <DropZone
          compact
          disabled={busy}
          accept={ACCEPT}
          onFiles={ingest}
          title="Drop documents you wrote here"
          sub={
            samples.length > 0
              ? 'Word, PDF or plain text. Only the text is kept — the files stay on your computer.'
              : 'Word, PDF or plain text. The AI reads how you draft — your structure, your phrasing, your tone — and writes in that voice from then on. Only the text is kept, and only the first pages of it; the files stay on your computer.'
          }
        />

        {note && (
          <p className={`pbk-note is-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
            {note.text}
          </p>
        )}

        {importing.length > 0 && (
          <ul className="pbk-list">
            {importing.map((n) => (
              <li className="pbk-item is-reading" key={`reading-${n}`}>
                <span className="pbk-item-mark" aria-hidden="true">{IconDoc}</span>
                <span className="pbk-item-text"><span className="pbk-item-name">{n}</span><span className="pbk-item-meta">Reading…</span></span>
              </li>
            ))}
          </ul>
        )}

        {loading ? (
          <p className="pbk-empty">Loading…</p>
        ) : samples.length === 0 && importing.length === 0 ? (
          <p className="pbk-empty">No documents yet.</p>
        ) : (
          <ul className="pbk-list">
            {samples.map((s) => (
              <li className="pbk-item" key={s.id}>
                <span className="pbk-item-mark" aria-hidden="true">{IconDoc}</span>
                <span className="pbk-item-text">
                  <span className="pbk-item-name">{s.name}</span>
                  <span className="pbk-item-meta">
                    {[bytesLabel(s.char_count), whenLabel(s.created_at)].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <Tooltip content="Remove — the AI relearns without it">
                  <button type="button" className="pbk-item-drop" onClick={() => drop(s.id)} disabled={busy} aria-label={`Remove ${s.name}`}>
                    {IconX}
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
          {/* ── What it learned ───────────────────────────────────────── */}
          {/* What it learned — shown only once there IS something learned;
              before that the documents section below says what to do. */}
          {hasStyle && (
          <section className="pbk-profile">
            <header className="pbk-profile-head">
              <div className="pbk-profile-title">
                <h2>Your writing voice</h2>
                <p>
                  {`Read from ${profile.sampleCount} ${profile.sampleCount === 1 ? 'document' : 'documents'}${profile.generatedAt ? ` on ${whenLabel(profile.generatedAt)}` : ''}.`}
                </p>
              </div>
              {hasStyle && (
                <div className="pbk-profile-tools">
                  {/* Off without forgetting: a one-off piece that has to read
                      neutrally shouldn't cost someone everything they taught it. */}
                  <Tooltip content={profile.enabled ? 'Stop writing in your voice — nothing is forgotten' : 'Write in your voice again'}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!profile.enabled}
                      className={`pbk-switch${profile.enabled ? ' is-on' : ''}`}
                      onClick={() => toggle(!profile.enabled)}
                    >
                      <span className="pbk-switch-track"><span className="pbk-switch-knob" /></span>
                      <span className="pbk-switch-label">{profile.enabled ? 'In use' : 'Paused'}</span>
                    </button>
                  </Tooltip>
                  <Tooltip content="Read your documents again and rewrite this">
                    <button type="button" className="pbk-relearn" onClick={learn} disabled={busy}>
                      {learning ? 'Reading…' : 'Learn again'}
                    </button>
                  </Tooltip>
                </div>
              )}
            </header>
            {hasStyle ? (
              <div className={`pbk-profile-body${profile.enabled ? '' : ' is-paused'}`}>
                {profile.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
              </div>
            ) : null}
          </section>
          )}
            </>
          )} />


        </div>
      )}
    </div>
  );
}
