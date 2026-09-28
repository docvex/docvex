import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useMorphPill } from './useMorphPill';
import { perfAllows } from '../lib/perf';
import Toggle from './Toggle';
import { SCAN_FEATURES, loadScanFeatures, saveScanFeatures } from '../lib/scanFeatures';
import { useLiveNetwork, setLiveSettings } from '../lib/liveNetwork';
import { isCloudMediaAllowed, setCloudMediaAllowed, subscribeCloudMedia } from '../lib/cloudMedia';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { getPseudonymizeMode, setPseudonymizeMode, subscribePseudonymize, getGuessNames, setGuessNames } from '../lib/pseudonymizeSetting';
import { getSentLog, subscribeSentLog, clearSentLog } from '../lib/pseudonymize/sentLog';
import RuleOptions from './RuleOptions';

const MASK_FIELD = {
  label: 'Pseudonymise text sent to the AI',
  options: [
    { id: 'default', label: 'On', example: 'Every AI call made in this project sends tokens instead of names, CNPs, CUIs, IBANs, ID numbers, phones, e-mails and addresses. If masking cannot run, the call is not sent.' },
    { id: 'off', label: 'Off', example: 'Nothing is masked \u2014 text goes to the AI as it is. The AI can then notice a misspelled name or a CNP that doesn\u2019t match a birth date.' },
  ],
};
import './RefPill.css';
import './ScanGauges.css';

// The Files tab's AI scan, as a GAUGE CLUSTER: shown while the pointer is over
// the scan button and a scan is running. Two dials — THIS FILE (how far the
// file being worked on is through its own steps) and WHOLE SCAN (the scan as a
// whole) — and a row of readouts under them. Fed by the scan's progress events
// (lib/dataCollections: `overall`, `fileFrac`, `step`, `name`, counts; see
// `sayFile`), kept in ProjectFiles' `filesScan`.

const STAGE_NAMES = {
  list: 'Listing the files',
  read: 'Reading the files',
  understand: 'Understanding',
  connect: 'Connecting',
  faces: 'Comparing faces',
  links: 'Cross-referencing',
  save: 'Writing the collections',
};

// A dial: a 240° arc, open at the bottom, from lower-left round to lower-right.
const START = 150;
const SWEEP = 240;
const polar = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const liveMotion = () => perfAllows('motion') && document.documentElement.dataset.reduceMotion !== 'true';

// THE DIAL MOVES ON ITS OWN: a frame loop (not React state — nothing re-renders
// per frame) eases the needle, the arc and the percentage toward `goal(now)`,
// which the card makes up out of the scan's real progress PLUS a steady fake
// sweep between the real events (see `useScanDrive`), and — while a scan runs —
// VIBRATES the needle, harder the faster it is climbing, as an engine gauge
// does. No loop, no tremble under reduced motion or a Graphics preset without
// motion: the needle is then simply set.
function Dial({ goal, running, state = null, label, sub, tone }) {
  const cx = 66; const cy = 64; const r = 50;
  const [x0, y0] = polar(cx, cy, r, START);
  const [x1, y1] = polar(cx, cy, r, START + SWEEP);
  const arc = `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  const len = (Math.PI * r * SWEEP) / 180;
  const valueRef = useRef(null);
  const needleRef = useRef(null);
  const pctRef = useRef(null);
  const goalRef = useRef(goal);
  goalRef.current = goal;
  const runRef = useRef(running);
  runRef.current = running;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let shown = clamp01(goalRef.current(Date.now()));
    let lastPct = -1;
    const write = (v, wobble) => {
      valueRef.current?.style.setProperty('stroke-dashoffset', String(len * (1 - v)));
      needleRef.current?.setAttribute('transform', `rotate(${(START + SWEEP * v + wobble).toFixed(2)} ${cx} ${cy})`);
      const pct = Math.round(v * 100);
      if (pct !== lastPct && pctRef.current) { pctRef.current.textContent = `${pct}%`; lastPct = pct; }
    };
    const frame = (t) => {
      const dt = Math.min(100, t - last); last = t;
      const target = clamp01(goalRef.current(Date.now()));
      if (!liveMotion()) { shown = target; write(shown, 0); raf = requestAnimationFrame(frame); return; }
      // FPS-independent easing: quick to rise, quicker to fall back (a file
      // done → the next one starts at 0: the needle drops, then climbs).
      // Quick enough to show the 0.8s burst and a completion's snap.
      const k = 1 - Math.pow(1 - (target < shown ? 0.22 : 0.16), dt / (1000 / 60));
      const before = shown;
      shown += (target - shown) * k;
      const speed = Math.abs(shown - before) / Math.max(1, dt);     // per ms
      const amp = runRef.current ? 0.55 + Math.min(3.2, speed * 900) : 0;   // degrees
      const wobble = amp * (0.55 * Math.sin(t / 31) + 0.3 * Math.sin(t / 17 + 1.7) + 0.35 * (Math.random() - 0.5));
      write(shown, wobble);
      raf = requestAnimationFrame(frame);
    };
    write(shown, 0);
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [len]);
  const ticks = Array.from({ length: 9 }, (_, i) => {
    const deg = START + (SWEEP * i) / 8;
    const [a, b] = polar(cx, cy, r - 9, deg);
    const [c, d] = polar(cx, cy, r - (i % 2 ? 13 : 16), deg);
    return <line key={i} x1={a} y1={b} x2={c} y2={d} className="sg-tick" />;
  });
  return (
    <div className={`sg-dial is-${tone}${running ? ' is-running' : ''}${state ? ` is-${state}` : ''}`}>
      <svg viewBox="0 0 132 112" width="132" height="112" aria-hidden="true">
        <path d={arc} className="sg-track" />
        <path ref={valueRef} d={arc} className="sg-value" style={{ strokeDasharray: len, strokeDashoffset: len }} />
        {ticks}
        <g ref={needleRef} className="sg-needle" transform={`rotate(${START} ${cx} ${cy})`}>
          <line x1={cx} y1={cy} x2={cx + r - 18} y2={cy} />
        </g>
        <circle cx={cx} cy={cy} r="4" className="sg-hub" />
        <text ref={pctRef} x={cx} y={cy + 30} className="sg-pct">0%</text>
      </svg>
      <div className="sg-dial-label">{label}</div>
      <div className="sg-dial-sub">{sub}</div>
    </div>
  );
}

// ── What the needles show — a STAGED, DECELERATING loader ───────────────
// Every task the scan does (a file read, a batch understood, a chunk
// connected, a group cross-referenced) gets the same artificial curve, tied to
// the REAL task:
//   · a fast BURST, 0 → 40% in 0.8s — the press is answered at once;
//   · a steady CRUISE, 40 → 80%, over the time the task is expected to take
//     (a file: the average a file has taken so far; a step: its usual length);
//   · then a HOLDING PATTERN, slowing asymptotically toward 95% — it NEVER
//     reaches 100% by itself.
// When the task really finishes the needle SNAPS to 100% (held a moment), and
// the next task starts again from 0; when it FAILS (a file skipped, the scan
// failed or was stopped) the needle drops back to 0 and the card turns red.
// WHOLE SCAN runs the same curve over the whole run (never behind the real
// progress, never backwards) and completes only when the scan's promise does
// (lib/scanRunner finishScan). Surges and the needle's vibration ride on top.
// Kept per scan at module level (keyed by its start), so the hover pill and the
// card — separate mounts — show the same needles.
const BURST_MS = 800;
const SNAP_MS = 450;
const STEP_MS = { list: 1500, understand: 18000, connect: 22000, faces: 15000, links: 25000, save: 2500 };
export function stagedProgress(t, expected) {
  if (!(t > 0)) return 0;
  if (t < BURST_MS) { const x = t / BURST_MS; return 0.4 * (1 - (1 - x) ** 3); }
  const cruise = Math.max(1000, expected - BURST_MS);
  const c = t - BURST_MS;
  if (c < cruise) return 0.4 + 0.4 * (c / cruise);
  return 0.8 + 0.15 * (1 - Math.exp(-(c - cruise) / Math.max(1500, expected * 0.5)));
}
const drives = new Map();   // startedAt → state
function driveFor(scan) {
  const key = scan?.startedAt || 0;
  let d = drives.get(key);
  if (!d) {
    if (drives.size > 4) drives.clear();
    const now = Date.now();
    d = { key: '', taskAt: now, snapUntil: 0, failed: false, floor: 0, surge: 0, surgeAt: 0, nextSurge: now + 1500 };
    drives.set(key, d);
  }
  return d;
}
const perFileMs = (sc, now) => {
  const elapsed = sc.startedAt ? now - sc.startedAt : 0;
  return sc.done > 0 ? Math.max(2500, Math.min(90000, elapsed / sc.done)) : 6000;
};
export function useScanDrive(scan) {
  const scanRef = useRef(scan);
  scanRef.current = scan;
  // Advances the per-task state; answers { goal, state: 'ok' | 'fail' | null }.
  const fileState = (now) => {
    const sc = scanRef.current;
    if (!sc) return { goal: 0, state: null };
    if (sc.finished) return sc.finished === 'ok' ? { goal: 1, state: 'ok' } : { goal: 0, state: 'fail' };
    const d = driveFor(sc);
    const real = clamp01(sc.fileFrac);
    // One TASK = one file while reading, else one step of the stage (a
    // chunk, a group) — a new key means the one before is over.
    const key = sc.stage === 'read' ? `read|${sc.index}|${sc.name}|${sc.fileAt || ''}` : `${sc.stage}|${sc.step || ''}`;
    if (key !== d.key) {
      if (d.key && !d.failed) d.snapUntil = now + SNAP_MS;
      d.key = key; d.taskAt = now; d.failed = false;
    }
    if (sc.stage === 'read' && real >= 1) {
      if (/^Skipped/i.test(sc.step || '')) { d.failed = true; return { goal: 0, state: 'fail' }; }
      return { goal: 1, state: 'ok' };
    }
    if (sc.stage === 'understand' && /^Understood/i.test(sc.step || '')) return { goal: 1, state: 'ok' };
    if (now < d.snapUntil) return { goal: 1, state: 'ok' };
    const expected = sc.stage === 'read' ? perFileMs(sc, now) : (STEP_MS[sc.stage] || 8000);
    const curve = stagedProgress(now - Math.max(d.taskAt, d.snapUntil), expected);
    if (now > d.nextSurge) { d.surge = 0.02 + Math.random() * 0.05; d.surgeAt = now; d.nextSurge = now + 1400 + Math.random() * 3200; }
    const surge = d.surge * Math.exp(-(now - d.surgeAt) / 650);
    return { goal: Math.min(0.95, Math.max(curve, sc.stage === 'read' ? 0 : real * 0.95) + surge), state: null };
  };
  const fileGoal = (now) => fileState(now).goal;
  const overallGoal = (now) => {
    const sc = scanRef.current;
    if (!sc) return 0;
    const d = driveFor(sc);
    if (sc.finished) {
      if (sc.finished === 'ok') return 1;
      d.floor = 0;
      return 0;
    }
    const real = clamp01(sc.overall);
    const files = sc.files || 0;
    const expected = files ? files * perFileMs(sc, now) + 40000 : 60000;
    const curve = stagedProgress(sc.startedAt ? now - sc.startedAt : 0, expected);
    const surge = d.surge * 0.3 * Math.exp(-(now - d.surgeAt) / 900);
    // Never behind the real progress, never backwards, never 100% on its own.
    d.floor = Math.min(0.95, Math.max(d.floor, real, curve + surge));
    return d.floor;
  };
  return { fileGoal, overallGoal, fileState };
}

const clock = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

const OUTCOME = {
  ok: { label: 'Done', cls: 'is-ok' },
  error: { label: 'Failed', cls: 'is-fail' },
  cancelled: { label: 'Stopped', cls: 'is-fail' },
};

export function ScanGaugeCard({ scan, bare = false }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);
  const { fileGoal, overallGoal, fileState } = useScanDrive(scan);
  const running = !!scan && !scan.finished;
  const outcome = scan?.finished ? OUTCOME[scan.finished] || OUTCOME.error : null;
  const fileNow = fileState(now);
  // The readouts follow the needle's whole-scan value too, so the time left
  // moves with it rather than sitting still between events.
  const overall = scan ? overallGoal(now) : 0;
  const elapsed = scan?.startedAt ? (scan.finishedAt || now) - scan.startedAt : NaN;
  // Time left, from the pace so far — only once there is a pace to go by.
  const left = running && overall > 0.04 && overall < 1 ? (elapsed / overall) * (1 - overall) : (outcome ? 0 : NaN);
  const files = scan?.files || 0;
  const done = Math.min(files, scan?.done || 0);
  const perMin = elapsed > 5000 && done ? (done / elapsed) * 60000 : NaN;
  const fileLabel = scan?.stage === 'read' || scan?.stage === 'understand' ? 'This file' : 'This step';
  // How long the file in hand has been worked on — so a slow file reads as
  // working, not stuck.
  const onFor = running && scan?.stage === 'read' && scan?.fileAt && (scan?.fileFrac ?? 0) < 1 ? Math.max(0, Math.round((now - scan.fileAt) / 1000)) : null;
  const fileSub = outcome
    ? (scan.finished === 'ok' ? 'Everything read' : scan.finished === 'cancelled' ? 'Stopped' : 'Didn\u2019t finish')
    : `${scan?.step || '\u2014'}${onFor >= 3 ? ` \u00b7 ${onFor}s` : ''}`;
  const allSub = outcome
    ? (scan.finished === 'ok' ? (files ? `All ${files} files` : 'Complete') : 'What was read is kept')
    : (files ? `${done} of ${files} files` : '—');
  return (
    <div className={`sg-card${bare ? ' is-bare' : ''}${outcome ? ` ${outcome.cls}` : ''}`} role="status" aria-live="polite">
      <div className="sg-head">
        <span className={`sg-stage${running ? ' is-live' : ''}${outcome ? ` ${outcome.cls}` : ''}`}>
          {outcome ? outcome.label : scan ? (STAGE_NAMES[scan.stage] || 'Scanning') : 'Ready'}
        </span>
        <span className="sg-name">{outcome ? '' : scan?.name || ''}</span>
      </div>
      <div className="sg-dials">
        <Dial goal={fileGoal} running={running} state={fileNow.state} label={fileLabel} sub={fileSub} tone="file" />
        <Dial goal={overallGoal} running={running} state={outcome ? (scan.finished === 'ok' ? 'ok' : 'fail') : null} label="Whole scan" sub={allSub} tone="all" />
      </div>
      <dl className="sg-readouts">
        <div><dt>Elapsed</dt><dd>{clock(elapsed)}</dd></div>
        <div><dt>Time left</dt><dd>{Number.isFinite(left) ? (left > 0 ? `~${clock(left)}` : '0:00') : '—'}</dd></div>
        <div><dt>Files / min</dt><dd>{Number.isFinite(perMin) ? perMin.toFixed(perMin < 10 ? 1 : 0) : '—'}</dd></div>
        <div><dt>Analysed</dt><dd>{scan?.understood ?? 0}</dd></div>
        <div><dt>Skipped</dt><dd>{scan?.skipped ?? 0}</dd></div>
      </dl>
      {!bare && !outcome && <p className="sg-foot">Press the button to stop — what was read is kept.</p>}
    </div>
  );
}

// The card floats under its anchor (right edges aligned, kept inside the
// window), portalled to the body, and takes no pointer.
export default function ScanGauges({ anchorRef, scan }) {
  const cardRef = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const c = cardRef.current?.getBoundingClientRect();
      if (!a || !c) return;
      const left = Math.max(8, Math.min(window.innerWidth - c.width - 8, a.right - c.width));
      const below = a.bottom + 8;
      const top = below + c.height > window.innerHeight - 8 ? Math.max(8, a.top - 8 - c.height) : below;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchorRef]);
  return createPortal(
    <div ref={cardRef} className={`sg-float${pos ? ' is-placed' : ''}`} style={pos ? { left: pos.left, top: pos.top } : undefined}>
      <ScanGaugeCard scan={scan} />
    </div>,
    document.body,
  );
}

// Wraps the scan button: while a scan runs (`scan` set), hovering it shows the
// gauge cluster; otherwise it renders `idle` (the button in its ordinary
// Tooltip). `display: contents`, so it adds no box of its own.
export function ScanHover({ scan, idle, children }) {
  const hostRef = useRef(null);
  const anchorRef = useRef(null);
  const [hover, setHover] = useState(false);
  useEffect(() => { if (!scan) setHover(false); }, [scan]);
  if (!scan) return idle;
  anchorRef.current = hostRef.current?.firstElementChild || null;
  return (
    <span
      ref={(el) => { hostRef.current = el; anchorRef.current = el?.firstElementChild || null; }}
      className="sg-host"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => { if (e.target.matches?.(':focus-visible')) setHover(true); }}
      onBlur={() => setHover(false)}
    >
      {children}
      {hover && <ScanGauges anchorRef={anchorRef} scan={scan} />}
    </span>
  );
}

// ── THE SCAN BUTTON (the Files tab's sparkle button) ─────────────────────
// Built as a highlight is in the Doc Viewer: hovering shows a pill saying what
// it does (while a scan runs: the gauge cluster), and a CLICK expands that pill
// into a CARD — the morph pill's menu state — holding a switch for each thing
// the scan can do (lib/dataCollections SCAN_FEATURES, kept per device), Read
// everything again, the Scan button (Stop while scanning) and Erase memory.
// THE LIVE NEURAL NETWORK's controls (lib/liveNetwork): the CONSENT to send
// new files to the AI as they arrive (per project, on this device, off by
// default), the second consent for recordings, and PAUSE / RESUME.
function LiveSection({ dir }) {
  const live = useLiveNetwork(dir);
  if (!dir || !live) return null;
  const { on, recordings, paused } = live.settings;
  const status = paused
    ? (live.pending ? `Paused \u2014 ${live.pending} file${live.pending === 1 ? '' : 's'} waiting.` : on ? 'Paused \u2014 new files are tagged and wait.' : 'Paused.')
    : live.working
      ? 'Reading the files\u2026'
      : live.pending
        ? `${live.pending} file${live.pending === 1 ? '' : 's'} about to be read\u2026`
        : !on
          ? 'Off \u2014 only files and folders you tag are read, as soon as you tag them.'
          : 'Watching for new files.';
  return (
    <>
      <div className="sg-menu-label">Live neural network</div>
      <ul className="sg-feats sg-live">
        <li>
          <Toggle on={on} onChange={(v) => setLiveSettings(dir, { on: v, ...(v ? { paused: false } : {}) })} label="Understand new files automatically" />
          <span className="sg-feat-note">
            Every file added to this project from now on (imported, sent from a phone, dropped into the folder or synced) is read and sent to the AI (Anthropic, not used for training) within seconds, then linked into the network. Files already here are read when you tag them — a tagged folder: everything in it, and whatever is added to it later. This device only.
          </span>
        </li>
        <li className={on ? '' : 'is-off'}>
          <Toggle on={on && recordings} onChange={(v) => on && setLiveSettings(dir, { recordings: v })} label="Include audio & video" />
          <span className="sg-feat-note">Recordings are transcribed by OpenAI: slower, and paid per minute.</span>
        </li>
        <li>
          <Toggle on={!paused} onChange={(v) => setLiveSettings(dir, { paused: !v })} label={paused ? 'Paused' : 'Running'} />
          <span className={`sg-feat-note sg-live-status${!paused && (live.working || live.pending) ? ' is-busy' : ''}`}>{status}</span>
        </li>
      </ul>
    </>
  );
}

// CLOUD READING OF IMAGES AND AUDIO (lib/cloudMedia): off, pictures and
// scans are read on this computer and recordings are not transcribed.
function CloudMediaSection() {
  const { selectedProjectId } = useSelectedProject();
  const on = useSyncExternalStore(subscribeCloudMedia, () => isCloudMediaAllowed(selectedProjectId), () => false);
  const mode = useSyncExternalStore(subscribePseudonymize, () => getPseudonymizeMode(selectedProjectId), () => 'default');
  const guess = useSyncExternalStore(subscribePseudonymize, () => getGuessNames(selectedProjectId), () => true);
  if (!selectedProjectId) return null;
  return (
    <>
      <div className="sg-menu-label">Privacy</div>
      <ul className="sg-feats">
        <li>
          <Toggle on={on} onChange={(v) => setCloudMediaAllowed(selectedProjectId, v)} label="Cloud reading of images & audio" />
          <span className="sg-feat-note">
            {on
              ? 'Pictures and scanned pages may be sent to Anthropic for reading, and recordings to OpenAI for captions.'
              : 'Pictures and scanned pages are read on this computer; recordings are not transcribed. Nothing visual or audio leaves this computer.'}
            {' '}This project, this device.
          </span>
        </li>
        <li>
          <span className="sg-feat-label">Pseudonymise text sent to the AI</span>
          <RuleOptions field={MASK_FIELD} value={mode === 'off' ? 'off' : 'default'} onPick={(id) => setPseudonymizeMode(selectedProjectId, id)} />
          <span className="sg-feat-note">
            Names, CNPs, CUIs, IBANs, ID numbers, phones, e-mails and addresses leave as tokens and are put back on this computer; the key stays here, encrypted. Pseudonymised text is still personal data under GDPR.
          </span>
        </li>
        <li className={mode === 'off' ? 'is-off' : ''}>
          <Toggle on={mode !== 'off' && guess} onChange={(v) => setGuessNames(selectedProjectId, v)} label="Also guess names the project doesn't know" />
          <span className="sg-feat-note">In the AI scan: a name after "Subsemnatul", "domnul", "reprezentată prin", "Vânzător:"…, or a company before SRL / SA, is masked too. A guess can miss a name, or hide a word the AI needed.</span>
        </li>
      </ul>
      <SentLog />
    </>
  );
}

// WHAT WAS SENT (lib/pseudonymize/sentLog): the last calls this window made
// to the AI — masked, sent as it is, or refused — with the masked text itself.
function SentLog() {
  const log = useSyncExternalStore(subscribeSentLog, getSentLog, getSentLog);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(null);   // the entry whose text is open
  const when = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div className="sg-sent">
      <button type="button" className="sg-sent-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        What was sent to the AI ({log.length})
      </button>
      {open && (
        <div className="sg-sent-list">
          {!log.length && <p className="sg-feat-note">Nothing sent from this window yet.</p>}
          {log.map((e) => (
            <div key={`${e.at}-${e.usageAction}`} className="sg-sent-row">
              <button type="button" className="sg-sent-head" onClick={() => setShown(shown === e ? null : e)} disabled={!e.bodyPreview}>
                <span className={`sg-sent-pill is-${!e.sent ? 'refused' : e.masked ? 'masked' : 'clear'}`}>{!e.sent ? 'Not sent' : e.masked ? 'Masked' : 'Not masked'}</span>
                <span className="sg-sent-action">{e.usageAction}</span>
                <span className="sg-sent-time">{when(e.at)}</span>
              </button>
              {e.reason && <span className="sg-feat-note">{e.reason}</span>}
              {shown === e && e.bodyPreview && <pre className="sg-sent-text">{e.bodyPreview}</pre>}
            </div>
          ))}
          {!!log.length && <button type="button" className="sg-sent-clear" onClick={() => { setShown(null); clearSentLog(); }}>Clear</button>}
        </div>
      )}
    </div>
  );
}

function ScanCard({ scan, taggedCount, onScan, onErase, close, dir }) {
  const [features, setFeatures] = useState(loadScanFeatures);
  const [force, setForce] = useState(false);
  const [erasing, setErasing] = useState(false);   // first press of Erase memory
  const set = (id, on) => setFeatures((f) => { const next = { ...f, [id]: on }; saveScanFeatures(next); return next; });
  const reads = features.documents || features.pictures || features.recordings;
  const canScan = !!taggedCount && reads;
  // A scan that has just ended (its outcome on show) is not running.
  const running = !!scan && !scan.finished;
  return (
    <div className="sg-menu" onClick={(e) => e.stopPropagation()}>
      {/* The gauge cluster heads the card — live while a scan runs, at rest
          (0%, Ready) before one. */}
      <ScanGaugeCard scan={scan} bare />
      <div className="dv-refpill is-full sg-menu-head" style={{ '--refpill-tone': 'var(--accent)' }}>
        <span className="dv-refpill-kind">AI scan</span>
        <span className="dv-refpill-head">
          {running ? `${scan.live ? 'Live \u00b7 ' : ''}${STAGE_NAMES[scan.stage] || 'Scanning'}` : taggedCount ? `${taggedCount} item${taggedCount === 1 ? '' : 's'} tagged` : 'Nothing tagged yet'}
        </span>
        <span className="dv-refpill-line">
          {running
            ? 'Stop keeps what was read \u2014 the next scan picks up from there.'
            : taggedCount
              ? 'Reads the tagged files and connects them into Data collections. Only new or changed files are read again.'
              : 'Right-click a file or folder \u2192 Tag for AI scan.'}
        </span>
      </div>
      <LiveSection dir={dir} />
      <CloudMediaSection />
      {!running && (
        <>
          <div className="sg-menu-label">What the scan does</div>
          <ul className="sg-feats">
            {SCAN_FEATURES.map((f) => (
              <li key={f.id}>
                <Toggle on={!!features[f.id]} onChange={(on) => set(f.id, on)} label={f.label} />
                <span className="sg-feat-note">{f.note}</span>
              </li>
            ))}
            <li className="is-once">
              <Toggle on={force} onChange={setForce} label="Read everything again" />
              <span className="sg-feat-note">This scan only: every file read and understood anew (costs tokens)</span>
            </li>
          </ul>
          {!reads && <p className="sg-menu-warn">Switch on at least one kind of file to read.</p>}
        </>
      )}
      <div className="sg-menu-actions">
        {onErase && (
          <button
            type="button"
            className={`project-files-morph-confirm-btn ${erasing ? 'project-files-morph-confirm-btn-danger' : 'project-files-morph-confirm-btn-cancel'} sg-erase`}
            disabled={running}
            onClick={() => {
              if (!erasing) { setErasing(true); return; }
              close(); onErase();
            }}
            onMouseLeave={() => setErasing(false)}
          >
            {erasing ? 'Press again to erase' : 'Erase memory'}
          </button>
        )}
        <span className="sg-menu-gap" />
        <button type="button" className="project-files-morph-confirm-btn project-files-morph-confirm-btn-cancel" onClick={close}>Close</button>
        {running ? (
          <button type="button" className="project-files-morph-confirm-btn project-files-morph-confirm-btn-danger" onClick={() => { close(); onScan(); }}>Stop scan</button>
        ) : (
          <button
            type="button"
            className="project-files-morph-confirm-btn project-files-morph-confirm-btn-primary"
            disabled={!canScan}
            onClick={() => { close(); onScan({ features, force }); }}
          >
            Scan
          </button>
        )}
      </div>
      {onErase && !running && (
        <p className="sg-menu-foot">Erase memory deletes the Data collections (to the Trash), the links and what the AI understood. The text read out of the files is kept.</p>
      )}
    </div>
  );
}

export function ScanButton({ scan, taggedCount = 0, onScan, onErase, dir = null, children }) {
  const running = !!scan && !scan.finished;
  const morph = useMorphPill({
    hoverContent: scan
      ? <ScanGaugeCard scan={scan} bare />
      : (taggedCount ? 'AI scan \u2014 click for options' : 'AI scan \u2014 tag files first (right-click \u2192 Tag for AI scan)'),
    menuItems: [],
    menuHeader: (close) => <ScanCard scan={scan} taggedCount={taggedCount} onScan={onScan} onErase={onErase} close={close} dir={dir} />,
    className: 'sg-pill',
    placement: 'left',
    stickyMenu: true,
  });
  return (
    <>
      <button
        type="button"
        className={`fx-cat-btn fx-scan-btn${running ? ' is-active is-busy' : ''}${scan?.finished ? ` is-${scan.finished === 'ok' ? 'done' : 'failed'}` : ''}${morph.isMenuOpen ? ' is-open' : ''}`}
        aria-label={running ? 'AI scan \u2014 running' : 'AI scan'}
        aria-haspopup="dialog"
        aria-expanded={morph.isMenuOpen}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onClick={morph.handleOpenMenu}
      >
        {children}
      </button>
      {morph.node}
    </>
  );
}
