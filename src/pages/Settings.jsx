import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTheme } from '../context/ThemeContext';
import { useAppPrefs } from '../context/AppPrefsContext';
import { useAuth } from '../context/AuthContext';
import { scalePercentFor, MIN_SCALE, MAX_SCALE, SCALE_STEP } from '../lib/appScale';
import { localFolderApi, isElectronBranch } from '../lib/localFolder';
import { readProjectsDir, writeProjectsDir } from '../lib/projectsDir';
import { ExtGlyph } from '../components/fileGlyph';
import PageMasthead from '../components/PageMasthead';
import DsToggle from '../components/Toggle';
import RuleOptions from '../components/RuleOptions';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { isCloudMediaAllowed, setCloudMediaAllowed, subscribeCloudMedia } from '../lib/cloudMedia';
import { getPseudonymizeMode, setPseudonymizeMode, subscribePseudonymize, getGuessNames, setGuessNames } from '../lib/pseudonymizeSetting';
import { getSentLog, subscribeSentLog, clearSentLog } from '../lib/pseudonymize/sentLog';
import TokenUsagePill from '../components/TokenUsagePill';
import { PERF_PRESETS, PERF_FEATURES, PERF_LEVELS, setPerfPreset, detectPerf, perfAllows } from '../lib/perf';
import { loadReadingMode, saveReadingMode, subscribeReadingMode, DEFAULT_READING_MODE } from '../lib/textRegions';
import { usePerfPreset, usePerfLevel } from '../lib/usePerf';
import { LANGUAGES, systemLanguage } from '../lib/i18n';
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
const SunIcon    = (p) => <Ico s={p?.s || 16}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Ico>;
const MoonIcon   = (p) => <Ico s={p?.s || 16}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Ico>;
const MonitorIcon = (p) => <Ico s={p?.s || 16}><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></Ico>;
const GlobeIcon  = (p) => <Ico s={p?.s || 16}><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></Ico>;
const TypeIcon   = (p) => <Ico s={p?.s || 16}><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></Ico>;
const ImageIcon  = (p) => <Ico s={p?.s || 16}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></Ico>;
const MotionIcon = (p) => <Ico s={p?.s || 16}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /><path d="M3 6v12" /></Ico>;
const ResetIcon  = (p) => <Ico s={p?.s || 15} sw="2.2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Ico>;
const ChevronIcon = (p) => <Ico s={p?.s || 16}><polyline points="6 9 12 15 18 9" /></Ico>;
const ShieldIcon = (p) => <Ico s={p?.s || 16}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></Ico>;
const FolderIcon = (p) => <Ico s={p?.s || 16}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Ico>;

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

// Resolve 'system' → concrete theme via OS preference.
function resolveTheme(theme) {
  if (theme !== 'system') return theme;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'ink' : 'cream';
  }
  return 'cream';
}

/* ───────────────────────── Control primitives ─────────────────────────
   The Design system's own controls (Design system tab → Gallery): the
   segmented choice (components/RuleOptions), the on/off switch
   (components/Toggle). */
function Segmented({ value, onChange, options, label = '' }) {
  return (
    <RuleOptions
      field={{ label, options: options.map((o) => ({ id: o.value, label: o.label })) }}
      value={value}
      onPick={onChange}
    />
  );
}

function Toggle({ checked, onChange }) {
  return <DsToggle on={checked} onChange={onChange} label={checked ? 'On' : 'Off'} />;
}

// Range slider for the app display scale — snaps in SCALE_STEP increments
// between MIN_SCALE and MAX_SCALE. While the thumb is dragged only the slider
// and its percentage move (a local draft); the scale is APPLIED when the thumb
// is let go (pointer up, a key released, focus leaving), since re-zooming the
// whole app on every step made the drag jump around under the pointer.
function ScaleSlider({ value, onChange }) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  useEffect(() => { draftRef.current = value; setDraft(value); }, [value]);
  const commit = () => { if (draftRef.current !== value) onChange(draftRef.current); };
  const pct = ((draft - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)) * 100;
  return (
    <div className="set-scale-control">
      <input
        type="range"
        className="set-slider"
        min={MIN_SCALE}
        max={MAX_SCALE}
        step={SCALE_STEP}
        value={draft}
        onChange={(e) => { const v = Number(e.target.value); draftRef.current = v; setDraft(v); }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        style={{ '--pct': `${pct}%` }}
        aria-label="Display scale"
      />
      <span className="set-scale-value">{draft}%</span>
    </div>
  );
}

// One setting: a ROW on the page ground (Design system: no card fill, a
// hairline under it) — icon, title and description on the left, the control
// on the right, and its preview under it.
function SettingCard({ icon, title, desc, control, children }) {
  return (
    <section className="set-row">
      <div className="set-row-head">
        <span className="set-row-ico">{icon}</span>
        <div className="set-row-meta">
          <h3 className="set-row-title">{title}</h3>
          <p className="set-row-desc">{desc}</p>
        </div>
        {control ? <div className="set-row-control">{control}</div> : null}
      </div>
      {children ? <div className="set-row-demo">{children}</div> : null}
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
        {prefs.thumbnails ? <ThumbPoster file={file} /> : <span className="set-d-glyph"><ExtGlyph ext={file.name.split('.').pop()} /></span>}
      </div>
      <div className="set-d-tile-name">{file.name}</div>
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

/* ───────────────────────── Workspace ───────────────────────── */
// "Projects folder" — the directory under which Docvex auto-creates a folder
// for each new project (so the Files page resolves straight to it). Migrated
// from the old launch hub's Settings view. Electron only: web has no ambient
// filesystem path, so the card is hidden there.
// SECURITY (V10): how well this computer protects DocVex's local keys. The
// index key and the pseudonymisation vault are wrapped by the OS key store;
// on Linux without a Secret Service that store is 'basic_text' — no real
// protection — and this card says so. Case folders themselves are ordinary
// files: full-disk encryption is what protects them on a lost laptop.
const KEYSTORE_LABEL = { dpapi: 'Windows (DPAPI)', keychain: 'macOS Keychain', gnome_libsecret: 'GNOME Keyring', kwallet: 'KWallet', kwallet5: 'KWallet 5', kwallet6: 'KWallet 6', basic_text: 'none (plain text)', unknown: 'unknown' };
function SecurityCard() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let alive = true;
    window.electronAPI?.getKeystoreStatus?.().then((v) => { if (alive) setSt(v || null); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const disk = st?.platform === 'darwin' ? 'FileVault' : st?.platform === 'win32' ? 'BitLocker (or Device Encryption)' : 'full-disk encryption (LUKS)';
  let line;
  if (!st) line = 'Checking…';
  else if (!st.available) line = 'This computer offers no key store. DocVex keeps its index unsealed and will not create a pseudonymisation vault, so AI calls that need masking are not sent.';
  else if (!st.strong) line = `The key store here is ${KEYSTORE_LABEL[st.backend] || st.backend}: DocVex's local keys are only obfuscated. Install and unlock GNOME Keyring or KWallet, then restart DocVex.`;
  else line = `DocVex's local keys are protected by ${KEYSTORE_LABEL[st.backend] || st.backend}.`;
  return (
    <SettingCard
      icon={<ShieldIcon />}
      title="Local encryption"
      desc={`How this computer protects DocVex's keys. Case files are ordinary files on your disk — turn on ${disk} so a lost or stolen computer doesn't expose them.`}
    >
      <div className={'set-ws-path' + (st && !st.strong ? ' is-empty' : '')}>
        <span className="set-ws-path-ico"><ShieldIcon s={16} /></span>
        <span className="set-ws-path-text">{line}</span>
      </div>
    </SettingCard>
  );
}

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
          <button type="button" className="set-btn" onClick={choose}>
            <FolderIcon s={15} /> {dir ? 'Change…' : 'Choose folder…'}
          </button>
          {dir && (
            <button type="button" className="set-btn" onClick={clear}>Clear</button>
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

/* ───────────────────────── Privacy (per project) ─────────────────────────
   What reaches the AI for the selected project, on this device: cloud reading
   of pictures and audio (lib/cloudMedia), pseudonymisation of text
   (lib/pseudonymizeSetting) and the log of what this window sent
   (lib/pseudonymize/sentLog). Moved here from the removed AI-scan card. */
const CloudIcon = (p) => <Ico s={p?.s || 16}><path d="M17.5 19H8a5 5 0 1 1 1.6-9.7A6 6 0 0 1 21 12.5 3.5 3.5 0 0 1 17.5 19z" /></Ico>;
const MaskIcon = (p) => <Ico s={p?.s || 16}><path d="M3 7c3-2 15-2 18 0 0 6-3 10-9 10S3 13 3 7z" /><circle cx="9" cy="10" r="1.2" /><circle cx="15" cy="10" r="1.2" /></Ico>;
const NameIcon = (p) => <Ico s={p?.s || 16}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Ico>;
const LogIcon = (p) => <Ico s={p?.s || 16}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></Ico>;
const SPECIAL_LABEL = { health: 'Health', criminal: 'Criminal', biometric: 'Biometric', 'beliefs-origin': 'Beliefs / origin' };

function SentLog() {
  const log = useSyncExternalStore(subscribeSentLog, getSentLog, getSentLog);
  const [shown, setShown] = useState(null);
  const when = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (!log.length) return <p className="set-sent-empty">Nothing sent to the AI from this window yet.</p>;
  return (
    <div className="set-sent">
      {log.map((e) => (
        <div key={`${e.at}-${e.usageAction}`} className="set-sent-row">
          <button type="button" className="set-sent-head" onClick={() => setShown(shown === e ? null : e)} disabled={!e.bodyPreview}>
            <span className={`set-sent-pill is-${!e.sent ? 'refused' : e.masked ? 'masked' : 'clear'}`}>{!e.sent ? 'Not sent' : e.masked ? 'Masked' : 'Not masked'}</span>
            <span className="set-sent-action">{e.usageAction}</span>
            {(e.flags || []).map((f) => <span key={f} className="set-sent-pill is-refused">{SPECIAL_LABEL[f] || f}</span>)}
            <span className="set-sent-time">{when(e.at)}</span>
          </button>
          {e.reason && <span className="set-sent-note">{e.reason}</span>}
          {shown === e && e.bodyPreview && <pre className="set-sent-text">{e.bodyPreview}</pre>}
        </div>
      ))}
    </div>
  );
}

function PrivacySettings() {
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const cloud = useSyncExternalStore(subscribeCloudMedia, () => isCloudMediaAllowed(selectedProjectId), () => false);
  const mode = useSyncExternalStore(subscribePseudonymize, () => getPseudonymizeMode(selectedProjectId), () => 'default');
  const guess = useSyncExternalStore(subscribePseudonymize, () => getGuessNames(selectedProjectId), () => true);
  const log = useSyncExternalStore(subscribeSentLog, getSentLog, getSentLog);
  const name = selectedProject?.name || 'this project';
  if (!selectedProjectId) {
    return <p className="set-foot">Open a project to set what its files may send to the AI — these settings are kept per project.</p>;
  }
  return (
    <>
      <SettingCard
        icon={<CloudIcon />}
        title="Cloud reading of images & audio"
        desc={cloud
          ? `Pictures and scanned pages of ${name} may be sent to Claude (Anthropic) for reading. Recordings are always transcribed on this computer. This project, this device.`
          : `Pictures and scanned pages of ${name} are read on this computer, and recordings are transcribed on it. Nothing visual or audio leaves this computer. This project, this device.`}
        control={<Toggle checked={cloud} onChange={(v) => setCloudMediaAllowed(selectedProjectId, v)} />}
      />
      <SettingCard
        icon={<MaskIcon />}
        title="Pseudonymise text sent to the AI"
        desc="Names, CNPs, CUIs, IBANs, ID numbers, phones, e-mails and addresses leave as tokens and are put back on this computer; the key stays here, encrypted. If masking can't run, the call is not sent. Pseudonymised text is still personal data under GDPR."
        control={(
          <Segmented
            value={mode === 'off' ? 'off' : 'default'}
            onChange={(id) => setPseudonymizeMode(selectedProjectId, id)}
            label="Pseudonymise text sent to the AI"
            options={[{ value: 'default', label: 'On' }, { value: 'off', label: 'Off' }]}
          />
        )}
      />
      <SettingCard
        icon={<NameIcon />}
        title="Also guess names the project doesn't know"
        desc={'A name after “Subsemnatul”, “domnul”, “reprezentată prin”, “Vânzător:”…, or a company before SRL / SA, is masked too. A guess can miss a name, or hide a word the AI needed.'}
        control={mode === 'off'
          ? <span className="set-sent-note">Masking is off</span>
          : <Toggle checked={guess} onChange={(v) => setGuessNames(selectedProjectId, v)} />}
      />
      <SettingCard
        icon={<LogIcon />}
        title={`What was sent to the AI (${log.length})`}
        desc="The last calls this window made to the AI — masked, sent as it is, or refused. Click one to see the text that left, as it left."
        control={log.length ? <button type="button" className="set-btn" onClick={() => clearSentLog()}>Clear</button> : null}
      >
        <SentLog />
      </SettingCard>
    </>
  );
}

/* ───────────────────────── Settings catalogue ───────────────────────── */
function buildSettings(prefs, set) {
  return [
    {
      key: 'theme', group: 'Appearance', icon: <SunIcon />,
      title: 'Theme', desc: 'Choose a light or dark palette, or follow your system.',
      Control: () => null,
      Mini: () => <MiniTheme prefs={prefs} set={set} />,
    },
    {
      key: 'textSize', group: 'Appearance', icon: <TypeIcon />,
      title: 'Display scale',
      desc: 'Make the whole app larger or smaller — text, icons, and spacing scale together, from 70% to 125%. Applies everywhere instantly.',
      Control: () => <ScaleSlider value={scalePercentFor(prefs.textSize)} onChange={(v) => set('textSize', v)} />,
      Mini: () => null,
    },
    {
      key: 'thumbnails', group: 'Text & display', icon: <ImageIcon />,
      title: 'Display thumbnails', desc: 'Show file previews, or compact type glyphs to load faster.',
      Control: () => <Toggle checked={prefs.thumbnails} onChange={(v) => set('thumbnails', v)} label="Display thumbnails" />,
      Mini: () => <MiniThumbs prefs={prefs} />,
    },
    {
      key: 'reduceMotion', group: 'Behavior', icon: <MotionIcon />,
      title: 'Minimize motion', desc: 'Reduce animations, transitions, and loading shimmers.',
      Control: () => <Toggle checked={prefs.reduceMotion} onChange={(v) => set('reduceMotion', v)} label="Minimize motion" />,
      Mini: () => <MiniMotion prefs={prefs} />,
    },
    {
      key: 'showTokenUsage', group: 'Behavior',
      icon: <Ico><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9 10h4.5a1.5 1.5 0 0 1 0 3H9h4.8a1.6 1.6 0 0 1 0 3.2H9" /></Ico>,
      title: 'Show token usage', desc: 'Display a running total of the AI tokens used in each chat, shown next to the message box.',
      Control: () => <Toggle checked={prefs.showTokenUsage} onChange={(v) => set('showTokenUsage', v)} label="Show token usage" />,
      Mini: () => <div className="set-demo-tokens"><TokenUsagePill tokens={1240} /></div>,
    },
    {
      key: 'language', group: 'Language & region', icon: <GlobeIcon />,
      title: 'Language', desc: 'The language of menus, buttons and labels. System follows your computer: Romanian when it is set to Romanian, English otherwise. Documents are not affected: the AI writes each document in the language you ask in.',
      // Each language is named in itself, so the switch is kept out of the
      // translation (data-no-i18n) — "English" must stay findable in Romanian.
      Control: () => (
        <span data-no-i18n="" style={{ display: 'contents' }}>
          <Segmented value={prefs.language} onChange={(v) => set('language', v)} label="Language"
            options={LANGUAGES.map((l) => ({ value: l.id, label: l.id === 'system'
              // Named in the interface language, since it is no language of its own.
              ? ((prefs.language === 'system' ? systemLanguage() : prefs.language) === 'ro' ? 'Sistem' : 'System')
              : l.label }))} />
        </span>
      ),
      Mini: () => null,
    },
  ];
}

const GROUPS = ['Appearance', 'Text & display', 'Behavior', 'Language & region'];
// Each group's place in the page's uneven grid (Settings.css, .set-group.is-*).
const GROUP_SLOT = { Appearance: 'appearance', 'Text & display': 'display', Behavior: 'behavior', 'Language & region': 'language' };

/* ───────────────────────── Optimization ───────────────────────── */
const GaugeIcon = () => <Ico><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-6" /><circle cx="12" cy="18" r="1.2" /></Ico>;
const levelLabel = (l) => PERF_PRESETS.find((p) => p.id === l)?.label || l;

// Graphics quality: game-style presets (lib/perf). Kept per DEVICE — the
// setting describes the computer, so it is not in the per-account prefs.
function GraphicsCard() {
  const preset = usePerfPreset();
  const level = usePerfLevel();
  const det = detectPerf();
  const chosen = PERF_PRESETS.find((p) => p.id === preset);
  return (
    <SettingCard
      icon={<GaugeIcon />}
      title="Graphics quality"
      desc="Trade the app's glass, glow and motion for speed. Lower presets draw less, which keeps older office computers smooth. Applies instantly, on this computer only."
      control={<Segmented value={preset} onChange={setPerfPreset} options={PERF_PRESETS.map((p) => ({ value: p.id, label: p.label }))} />}
    >
      <div className="set-perf">
        <p className="set-perf-blurb">
          {preset === 'auto'
            ? <>Auto chose <b>{levelLabel(det.level)}</b> for this computer{det.gpu ? <> — {det.gpu}</> : null}{det.cores ? <>, {det.cores} processor threads</> : null}{det.memory ? <>, {det.memory >= 8 ? '8 GB or more' : `${det.memory} GB`} of memory</> : null}.</>
            : chosen?.blurb}
        </p>
        <table className="set-perf-table">
          <thead>
            <tr><th scope="col" />{PERF_LEVELS.map((l) => <th key={l} scope="col" className={l === level ? 'is-on' : ''}>{levelLabel(l)}</th>)}</tr>
          </thead>
          <tbody>
            {Object.entries(PERF_FEATURES).map(([id, f]) => (
              <tr key={id}>
                <th scope="row">{f.label}</th>
                {PERF_LEVELS.map((l) => (
                  <td key={l} className={l === level ? 'is-on' : ''}>
                    {perfAllows(id, l) ? <span className="set-perf-yes" aria-label="on">●</span> : <span className="set-perf-no" aria-label="off">–</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingCard>
  );
}

/* ───────────────────────── Extract text ───────────────────────── */
const ReadIcon = () => <Ico><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" /><path d="M8 10h8M8 14h5" /></Ico>;
// Who reads the WORDS of a picture's text (lib/textRegions, "The reading MODE"):
// the local engine (PaddleOCR, nothing leaves this computer) or the AI (strips
// of the picture go to Claude, and only where the project allows cloud reading
// of images). WHERE the text is, is always measured on this computer. Kept per
// device; an open picture follows a change at once.
function ReadingModeCard() {
  const [mode, setMode] = useState(loadReadingMode);
  useEffect(() => subscribeReadingMode(setMode), []);
  const pick = (result) => { const next = { ...mode, result }; setMode(next); saveReadingMode(next); };
  return (
    <SettingCard
      icon={<ReadIcon />}
      title="Text in pictures"
      desc="Who reads the words when you extract a picture's text. The local engine reads on this computer and sends nothing. The AI reads each line more accurately, but sends strips of the picture to Claude and uses AI tokens; it runs only in projects that allow cloud reading of images. Where the text sits on the picture is always measured on this computer."
      control={<Segmented value={mode.result} onChange={pick} label="Text in pictures" options={[{ value: 'local', label: 'Local engine' }, { value: 'ai', label: 'AI' }]} />}
    />
  );
}

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
    setPerfPreset('auto');
    saveReadingMode(DEFAULT_READING_MODE);
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
          <button type="button" className="set-btn" onClick={onReset}><ResetIcon /> Reset to defaults</button>
        )}
      >
        Personalize how Docvex looks and behaves on this device.
      </PageMasthead>
      <div className="set-stack">
        {isElectronBranch && (
          <div className="set-group is-workspace">
            <h2 className="set-group-title">Workspace</h2>
            <WorkspaceCard />
          </div>
        )}
        {GROUPS.map((g) => (
          <div key={g} className={'set-group is-' + GROUP_SLOT[g]}>
            <h2 className="set-group-title">{g}</h2>
            {settings.filter((s) => s.group === g).map((s) => (
              <SettingCard key={s.key} icon={s.icon} title={s.title} desc={s.desc}
                           control={s.Control()}>
                {s.Mini()}
              </SettingCard>
            ))}
          </div>
        ))}
        <div className="set-group is-extract">
          <h2 className="set-group-title">Extract text</h2>
          <ReadingModeCard />
        </div>
        <div className="set-group is-optimization">
          <h2 className="set-group-title">Optimization</h2>
          <GraphicsCard />
        </div>
        <div className="set-group is-privacy">
          <h2 className="set-group-title">Privacy & security</h2>
          <PrivacySettings />
          {isElectronBranch && <SecurityCard />}
        </div>
        <p className="set-foot">Preferences are saved on this device. Other devices keep their own.</p>
      </div>
    </div>
  );
}
