import React, { useCallback, useEffect, useState } from 'react';
import { useTheme } from '../context/ThemeContext';
import { useAppPrefs } from '../context/AppPrefsContext';
import { useAuth } from '../context/AuthContext';
import { scalePercentFor, MIN_SCALE, MAX_SCALE, SCALE_STEP } from '../lib/appScale';
import { localFolderApi, isElectronBranch } from '../lib/localFolder';
import { readProjectsDir, writeProjectsDir } from '../lib/projectsDir';
import PageMasthead from '../components/PageMasthead';
import './Settings.css';

// App Settings tab (Claude Design handoff "app settings tab", Direction A —
// "Stacked cards"). Each preference is its own card with an inline mini-demo
// that shows what the setting does, mirroring the existing Theme picker.
//
// Wiring: the Theme card drives the real ThemeContext (so it actually repaints
// the app and persists in the shared docvex.theme.<user> key). The remaining
// preferences (text size, density, thumbnails, minimize motion, default file
// view, language) are persisted per-user under docvex.appPrefs.<user> and
// previewed live in each card's demo region — they don't yet drive global app
// behaviour, but the demo shows their effect exactly as the design intends.

/* ───────────────────────── Icons ───────────────────────── */
const Ico = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={p.sw || 2}
       strokeLinecap="round" strokeLinejoin="round" width={p.s || 20} height={p.s || 20}
       aria-hidden="true" style={p.style}>{p.children}</svg>
);
const CheckIcon  = (p) => <Ico s={p?.s || 14} sw="2.5"><polyline points="20 6 9 17 4 12" /></Ico>;
const FilesIcon  = (p) => <Ico s={p?.s}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></Ico>;
const GridIcon   = (p) => <Ico s={p?.s || 16}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Ico>;
const ListIcon   = (p) => <Ico s={p?.s || 16}><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></Ico>;
const SunIcon    = (p) => <Ico s={p?.s || 16}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Ico>;
const MoonIcon   = (p) => <Ico s={p?.s || 16}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Ico>;
const MonitorIcon = (p) => <Ico s={p?.s || 16}><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></Ico>;
const GlobeIcon  = (p) => <Ico s={p?.s || 16}><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></Ico>;
const TypeIcon   = (p) => <Ico s={p?.s || 16}><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></Ico>;
const ImageIcon  = (p) => <Ico s={p?.s || 16}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></Ico>;
const MotionIcon = (p) => <Ico s={p?.s || 16}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /><path d="M3 6v12" /></Ico>;
const ResetIcon  = (p) => <Ico s={p?.s || 15} sw="2.2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Ico>;
const ChevronIcon = (p) => <Ico s={p?.s || 16}><polyline points="6 9 12 15 18 9" /></Ico>;
const FolderIcon = (p) => <Ico s={p?.s || 16}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Ico>;

/* ────────────────── File-type glyphs ────────────────── */
const PaperBase = (<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>);
function TypeGlyph({ kind }) {
  const common = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, width: '100%', height: '100%' };
  if (kind === 'pdf')   return <svg {...common}>{PaperBase}<text x="8" y="18" fontSize="6" fontWeight="700" fill="currentColor" stroke="none">PDF</text></svg>;
  if (kind === 'doc')   return <svg {...common}>{PaperBase}<text x="7.5" y="18" fontSize="5.4" fontWeight="700" fill="currentColor" stroke="none">DOC</text></svg>;
  if (kind === 'ppt')   return <svg {...common}>{PaperBase}<text x="7.6" y="18" fontSize="5.4" fontWeight="700" fill="currentColor" stroke="none">PPT</text></svg>;
  if (kind === 'image') return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>;
  if (kind === 'video') return <svg {...common}><rect x="2" y="6" width="14" height="12" rx="2" /><polygon points="22 8 16 12 22 16 22 8" /></svg>;
  return <svg {...common}>{PaperBase}<line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="14" y2="17" /></svg>;
}

// CSS "thumbnail" posters — no external assets. Documents render as a tiny
// page with lines; image/video render as a gradient with a marker.
function ThumbPoster({ file }) {
  if (file.kind === 'image' || file.kind === 'video') {
    return (
      <div className="set-thumb-poster" style={{ background: file.poster }}>
        {file.kind === 'video' && <span className="set-thumb-play"><svg viewBox="0 0 24 24" width="60%" height="60%"><polygon points="8 5 19 12 8 19 8 5" fill="#fff" /></svg></span>}
      </div>
    );
  }
  return (
    <div className="set-thumb-doc" data-kind={file.kind}>
      <div className="set-thumb-doc-bar" />
      <div className="set-thumb-doc-lines">
        <span style={{ width: '90%' }} /><span style={{ width: '75%' }} />
        <span style={{ width: '82%' }} /><span style={{ width: '55%' }} />
        <span style={{ width: '70%' }} />
      </div>
      <span className="set-thumb-doc-tag">{file.kind.toUpperCase()}</span>
    </div>
  );
}

/* ───────────────────────── Demo data + i18n ───────────────────────── */
const DEMO_FILES = [
  { id: 'f1', name: 'Q3 Financials.pdf',     kind: 'pdf',   meta: ['2.4 MB', 'Apr 12'], poster: null },
  { id: 'f2', name: 'Brand Guidelines.docx', kind: 'doc',   meta: ['880 KB', 'Apr 09'], poster: null },
  { id: 'f3', name: 'Launch deck.pptx',      kind: 'ppt',   meta: ['6.1 MB', 'Apr 08'], poster: null },
  { id: 'f4', name: 'Cover render.png',      kind: 'image', meta: ['1.2 MB', 'Apr 07'], poster: 'linear-gradient(135deg,#8B5E3C,#DCC9A3)' },
  { id: 'f5', name: 'Walkthrough.mp4',       kind: 'video', meta: ['48 MB', 'Apr 05'],  poster: 'linear-gradient(135deg,#1E293B,#0F172A)' },
  { id: 'f6', name: 'Site photo.jpg',        kind: 'image', meta: ['3.0 MB', 'Apr 03'], poster: 'linear-gradient(135deg,#0D9488,#38BDF8)' },
];

const I18N = {
  en: { name: 'English',  title: 'Files',    sub: '6 files · 2 folders',     neu: 'New',     col: ['Name', 'Modified', 'Size'] },
  ro: { name: 'Română',   title: 'Fișiere',  sub: '6 fișiere · 2 foldere',   neu: 'Nou',     col: ['Nume', 'Modificat', 'Mărime'] },
  es: { name: 'Español',  title: 'Archivos', sub: '6 archivos · 2 carpetas', neu: 'Nuevo',   col: ['Nombre', 'Modificado', 'Tamaño'] },
  de: { name: 'Deutsch',  title: 'Dateien',  sub: '6 Dateien · 2 Ordner',    neu: 'Neu',     col: ['Name', 'Geändert', 'Größe'] },
  fr: { name: 'Français', title: 'Fichiers', sub: '6 fichiers · 2 dossiers', neu: 'Nouveau', col: ['Nom', 'Modifié', 'Taille'] },
};

// Resolve 'system' → concrete theme via OS preference.
function resolveTheme(theme) {
  if (theme !== 'system') return theme;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'ink' : 'cream';
  }
  return 'cream';
}

/* ───────────────────────── Control primitives ───────────────────────── */
function Segmented({ value, onChange, options }) {
  return (
    <div className="set-seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
                className={'set-seg-opt' + (value === o.value ? ' is-on' : '')}
                onClick={() => onChange(o.value)}>
          {o.icon ? <span className="set-seg-ico">{o.icon}</span> : null}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
            className={'set-toggle' + (checked ? ' is-on' : '')} onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

function Select({ value, onChange, options }) {
  return (
    <div className="set-sel-wrap">
      <select className="set-sel" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="set-sel-chev"><ChevronIcon /></span>
    </div>
  );
}

// Range slider for the app display scale — snaps in SCALE_STEP increments
// between MIN_SCALE and MAX_SCALE, with a live percentage readout. The accent
// fill tracks the thumb via the inline `--pct` custom property.
function ScaleSlider({ value, onChange }) {
  const pct = ((value - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)) * 100;
  return (
    <div className="set-scale-control">
      <input
        type="range"
        className="set-slider"
        min={MIN_SCALE}
        max={MAX_SCALE}
        step={SCALE_STEP}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--pct': `${pct}%` }}
        aria-label="Display scale"
      />
      <span className="set-scale-value">{value}%</span>
    </div>
  );
}

// A settings card: icon + title + description on the left, control area, and a
// demo region underneath.
function SettingCard({ icon, title, desc, control, children, wide }) {
  return (
    <section className={'set-card' + (wide ? ' is-wide' : '')}>
      <div className="set-card-head">
        <span className="set-card-ico">{icon}</span>
        <div className="set-card-meta">
          <h3 className="set-card-title">{title}</h3>
          <p className="set-card-desc">{desc}</p>
        </div>
        {control ? <div className="set-card-control">{control}</div> : null}
      </div>
      {children ? <div className="set-card-demo">{children}</div> : null}
    </section>
  );
}

/* ───────────────────────── Demo surfaces ───────────────────────── */
// Wrap any demo so it paints in the chosen theme and honors reduce-motion.
// data-theme drives tokens.css's [data-theme] rules locally, so the demo
// recolors independently of the page around it. Text size is no longer
// previewed per-demo with --ts: it now scales the ENTIRE app live (webFrame
// zoom), so every demo here renders at a stable 1× baseline and the global
// zoom is what visibly grows/shrinks the whole settings page as you pick a
// size. --ts is kept at 1 so the existing calc()-based CSS still resolves.
function DemoFrame({ prefs, children, className, style }) {
  const theme = resolveTheme(prefs.theme);
  return (
    <div
      className={'set-demo-frame' + (prefs.reduceMotion ? ' no-motion' : '') + (className ? ' ' + className : '')}
      data-theme={theme}
      style={{ '--ts': 1, ...(style || {}) }}
    >
      {children}
    </div>
  );
}

function FileTile({ file, prefs }) {
  return (
    <div className="set-d-tile">
      <div className={'set-d-tile-thumb' + (prefs.thumbnails ? '' : ' is-glyph')}>
        {prefs.thumbnails ? <ThumbPoster file={file} /> : <span className="set-d-glyph"><TypeGlyph kind={file.kind} /></span>}
      </div>
      <div className="set-d-tile-name">{file.name}</div>
    </div>
  );
}

function FileRow({ file, prefs }) {
  return (
    <div className="set-d-row">
      <div className="set-d-row-name">
        <span className={'set-d-row-thumb' + (prefs.thumbnails ? '' : ' is-glyph')}>
          {prefs.thumbnails ? <ThumbPoster file={file} /> : <span className="set-d-glyph"><TypeGlyph kind={file.kind} /></span>}
        </span>
        <span className="set-d-name-text">{file.name}</span>
      </div>
      <span className="set-d-row-meta">{file.meta[1]}</span>
      <span className="set-d-row-meta set-d-row-size">{file.meta[0]}</span>
    </div>
  );
}

// Theme: three theme cards, each painting in its own theme; active is ringed.
function MiniTheme({ prefs, set }) {
  const opts = [
    { id: 'cream',  label: 'Cream',  theme: 'cream',                icon: <SunIcon /> },
    { id: 'ink',    label: 'Ink',    theme: 'ink',                  icon: <MoonIcon /> },
    { id: 'system', label: 'System', theme: resolveTheme('system'), icon: <MonitorIcon /> },
  ];
  return (
    <div className="set-mini-theme">
      {opts.map((o) => {
        const active = prefs.theme === o.id;
        return (
          <button key={o.id} type="button" data-theme={o.theme}
                  className={'set-theme-card' + (active ? ' is-active' : '')}
                  aria-pressed={active} onClick={() => set('theme', o.id)}>
            <div className="set-theme-mock">
              <div className="set-theme-mock-row"><span className="set-theme-mock-aa">Aa</span><span className="set-theme-mock-cta" /></div>
              <div className="set-theme-mock-lines"><span /><span /></div>
            </div>
            <div className="set-theme-card-row">
              <span className="set-theme-card-ico">{o.icon}</span>
              <span className="set-theme-card-name">{o.label}</span>
              {active && <span className="set-theme-card-check"><CheckIcon /></span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Text size: a mini Docvex window mock + a live percentage readout. Unlike the
// other cards, the real demonstration is the WHOLE app zooming live as the user
// picks a size — so this demo just illustrates that the scale covers the entire
// app (chrome, nav, and content alike) and shows the current percentage.
function MiniAppScale({ prefs }) {
  const pct = scalePercentFor(prefs.textSize);
  return (
    <DemoFrame prefs={prefs} className="set-mini-scale">
      <div className="set-sc-window">
        <div className="set-sc-titlebar">
          <span className="set-sc-dots"><i /><i /><i /></span>
          <span className="set-sc-brand">Docvex</span>
        </div>
        <div className="set-sc-nav">
          <span className="set-sc-nav-item is-on"><FilesIcon s={13} /> Files</span>
          <span className="set-sc-nav-item"><TypeIcon s={13} /> Activity</span>
          <span className="set-sc-nav-item"><GlobeIcon s={13} /> AI</span>
        </div>
        <div className="set-sc-body">
          <h5 className="set-sc-title">Everything scales together</h5>
          <p className="set-sc-text">Text, icons, and spacing across the entire app grow or shrink with this setting.</p>
          <span className="set-sc-btn">+ New</span>
        </div>
      </div>
      <div className="set-sc-caption">Applies to the entire app · <strong>{pct}%</strong></div>
    </DemoFrame>
  );
}

// Thumbnails: file tiles toggling poster vs glyph.
function MiniThumbs({ prefs }) {
  return (
    <DemoFrame prefs={prefs} className="set-mini-thumbs">
      <div className="set-d-grid set-mini-thumb-grid">
        {DEMO_FILES.slice(0, 4).map((f) => <FileTile key={f.id} file={f} prefs={prefs} />)}
      </div>
    </DemoFrame>
  );
}

// Reduce motion: a skeleton-loading row + a hover-lift card.
function MiniMotion({ prefs }) {
  return (
    <DemoFrame prefs={prefs} className="set-mini-motion">
      <div className="set-mm-grid">
        <div className="set-mm-skel">
          <div className="set-mm-skel-thumb" />
          <div className="set-mm-skel-lines"><span /><span /></div>
          <div className="set-mm-skel-cap">{prefs.reduceMotion ? 'Static placeholder' : 'Animated shimmer'}</div>
        </div>
        <div className="set-mm-hover">
          <div className="set-mm-hover-card">
            <span className="set-mm-hover-ico"><FilesIcon s={18} /></span>
            <span>Hover me</span>
          </div>
          <div className="set-mm-spinner-wrap"><span className="set-mm-spinner" /><span className="set-mm-spin-cap">{prefs.reduceMotion ? 'No spin' : 'Spinner'}</span></div>
        </div>
      </div>
    </DemoFrame>
  );
}

// File view: mini files preview switching grid/list.
function MiniView({ prefs }) {
  return (
    <DemoFrame prefs={prefs} className="set-mini-view">
      {prefs.fileView === 'grid' ? (
        <div className="set-d-grid set-mini-thumb-grid">
          {DEMO_FILES.slice(0, 4).map((f) => <FileTile key={f.id} file={f} prefs={prefs} />)}
        </div>
      ) : (
        <div className="set-d-list">
          {DEMO_FILES.slice(0, 4).map((f) => <FileRow key={f.id} file={f} prefs={prefs} />)}
        </div>
      )}
    </DemoFrame>
  );
}

// Language: a mini header showing translated chrome labels.
function MiniLang({ prefs }) {
  const t = I18N[prefs.language] || I18N.en;
  return (
    <DemoFrame prefs={prefs} className="set-mini-lang">
      <div className="set-ml-head">
        <div className="set-ml-head-text"><h4 className="set-d-h">{t.title}</h4><p className="set-d-sub">{t.sub}</p></div>
        <button type="button" className="set-d-new-btn">+ {t.neu}</button>
      </div>
      <div className="set-ml-cols">{t.col.map((c, i) => <span key={i}>{c}</span>)}</div>
    </DemoFrame>
  );
}

/* ───────────────────────── Workspace ───────────────────────── */
// "Projects folder" — the directory under which Docvex auto-creates a folder
// for each new project (so the Files page resolves straight to it). Migrated
// from the old launch hub's Settings view. Electron only: web has no ambient
// filesystem path, so the card is hidden there.
function WorkspaceCard() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const [dir, setDir] = useState('');

  useEffect(() => { setDir(readProjectsDir(userId)); }, [userId]);

  const choose = useCallback(async () => {
    const picked = await localFolderApi.pick();
    if (picked) { setDir(picked); writeProjectsDir(userId, picked); }
  }, [userId]);

  const clear = useCallback(() => {
    setDir('');
    writeProjectsDir(userId, '');
  }, [userId]);

  return (
    <SettingCard
      icon={<FolderIcon />}
      title="Projects folder"
      desc="Where Docvex creates a folder for each new project. New projects get their own folder here automatically, and the Files page opens straight to it."
      control={(
        <div className="set-ws-actions">
          <button type="button" className="set-reset-btn" onClick={choose}>
            <FolderIcon s={15} /> {dir ? 'Change…' : 'Choose folder…'}
          </button>
          {dir && (
            <button type="button" className="set-reset-btn" onClick={clear}>Clear</button>
          )}
        </div>
      )}
    >
      <div className={'set-ws-path' + (dir ? '' : ' is-empty')}>
        <span className="set-ws-path-ico"><FolderIcon s={16} /></span>
        <span className="set-ws-path-text">{dir || 'No projects folder set yet.'}</span>
      </div>
    </SettingCard>
  );
}

/* ───────────────────────── Settings catalogue ───────────────────────── */
function buildSettings(prefs, set) {
  return [
    {
      key: 'theme', group: 'Appearance', icon: <SunIcon />,
      title: 'Theme', desc: 'Choose a light or dark palette, or follow your system.',
      Control: () => null,
      Mini: () => <MiniTheme prefs={prefs} set={set} />, wide: true,
    },
    {
      key: 'textSize', group: 'Appearance', icon: <TypeIcon />,
      title: 'Display scale',
      desc: 'Make the whole app larger or smaller — text, icons, and spacing scale together, from 70% to 125%. Applies everywhere instantly.',
      Control: () => <ScaleSlider value={scalePercentFor(prefs.textSize)} onChange={(v) => set('textSize', v)} />,
      Mini: () => <MiniAppScale prefs={prefs} />,
    },
    {
      key: 'thumbnails', group: 'Text & display', icon: <ImageIcon />,
      title: 'Display thumbnails', desc: 'Show file previews, or compact type glyphs to load faster.',
      Control: () => <Toggle checked={prefs.thumbnails} onChange={(v) => set('thumbnails', v)} label="Display thumbnails" />,
      Mini: () => <MiniThumbs prefs={prefs} />,
    },
    {
      key: 'fileView', group: 'Text & display', icon: <GridIcon />,
      title: 'Default file view', desc: 'How files first appear when you open a project.',
      Control: () => <Segmented value={prefs.fileView} onChange={(v) => set('fileView', v)}
        options={[{ value: 'grid', label: 'Grid', icon: <GridIcon s={14} /> }, { value: 'list', label: 'List', icon: <ListIcon s={14} /> }]} />,
      Mini: () => <MiniView prefs={prefs} />,
    },
    {
      key: 'reduceMotion', group: 'Behavior', icon: <MotionIcon />,
      title: 'Minimize motion', desc: 'Reduce animations, transitions, and loading shimmers.',
      Control: () => <Toggle checked={prefs.reduceMotion} onChange={(v) => set('reduceMotion', v)} label="Minimize motion" />,
      Mini: () => <MiniMotion prefs={prefs} />,
    },
    {
      key: 'language', group: 'Language & region', icon: <GlobeIcon />,
      title: 'Language', desc: 'Your preferred language for menus and labels. Saved now; full app translation is still rolling out — the preview shows the effect.',
      Control: () => <Select value={prefs.language} onChange={(v) => set('language', v)}
        options={Object.entries(I18N).map(([v, o]) => ({ value: v, label: o.name }))} />,
      Mini: () => <MiniLang prefs={prefs} />,
    },
  ];
}

const GROUPS = ['Appearance', 'Text & display', 'Behavior', 'Language & region'];

export default function Settings() {
  // Theme flows through ThemeContext (its own per-user key + paint). Every other
  // preference lives in AppPrefsContext, which is the single source of truth the
  // rest of the app reads — so these settings actually drive behaviour (text
  // scale, reduce-motion, thumbnails, default file view), not just the demos.
  const { themePreference, setTheme } = useTheme();
  const { prefs: appPrefs, setPref, resetPrefs } = useAppPrefs();

  const set = useCallback((key, value) => {
    if (key === 'theme') { setTheme(value); return; }
    setPref(key, value);
  }, [setTheme, setPref]);

  const onReset = useCallback(() => {
    setTheme('cream');
    resetPrefs();
  }, [setTheme, resetPrefs]);

  const prefs = { ...appPrefs, theme: themePreference };
  const settings = buildSettings(prefs, set);

  return (
    <div className="set-page">
      <PageMasthead
        eyebrow="Preferences"
        eyebrowMuted="On this device"
        title="Settings."
        actions={(
          <button type="button" className="set-reset-btn" onClick={onReset}><ResetIcon /> Reset to defaults</button>
        )}
      >
        Personalize how Docvex looks and behaves on this device.
      </PageMasthead>
      <div className="set-stack">
        {GROUPS.map((g) => (
          <div key={g} className="set-group">
            <h2 className="set-group-title">{g}</h2>
            {settings.filter((s) => s.group === g).map((s) => (
              <SettingCard key={s.key} icon={s.icon} title={s.title} desc={s.desc}
                           control={s.Control()} wide={s.wide}>
                {s.Mini()}
              </SettingCard>
            ))}
          </div>
        ))}
        {isElectronBranch && (
          <div className="set-group">
            <h2 className="set-group-title">Workspace</h2>
            <WorkspaceCard />
          </div>
        )}
        <p className="set-foot">Preferences are saved on this device. Other devices keep their own.</p>
      </div>
    </div>
  );
}
