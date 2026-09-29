// THE LIVE NEURAL NETWORK — a file added to the project is understood on its
// own, within seconds, and linked into the network (the AI scan's Data
// collections and cross-referenced links, lib/dataCollections).
//
// Nothing here is a second pipeline: an arrival is TAGGED for the AI scan
// (lib/scanTags — it wears the AI mark, and "Remove from AI scan" takes it
// out again) and the scan is run INCREMENTALLY on it (`only` = the files that
// arrived): files the network already knows cost nothing, an unchanged
// project returns from the scan's fast path before reading anything, and a
// new file is cross-referenced only against its likeliest matches
// (dataCollections `deltaPlan`).
//
// CONSENT is per project and per device, OFF by default: switching it on
// (the scan card, components/ScanGauges) is what allows files to go to the AI
// as they arrive. Recordings need a second switch (they are transcribed by
// another provider, slowly and at a cost). Files already in the project are
// NOT swept up — only what arrives from then on. PAUSE holds the work (a pass
// under way stops at the next file; what was done is kept) and RESUME picks up
// what arrived meanwhile.
//
// TAGGING is a request too: tagging a file or a FOLDER (right-click → Tag for
// AI scan) queues what it covers at once, and a file later added inside a
// tagged folder is read as it arrives — with or without the automatic
// consent, since the tag is the user asking for exactly those files (Pause
// still holds it). Untagging runs a pass that takes the files out of the
// collections.
//
// The trigger is the project index's `project:delta` — ONE event for every
// way a file arrives (Import, a phone, Explorer, account sync). Arrivals are
// SETTLED (no further change for SETTLE_MS, at most MAX_WAIT_MS) and a burst
// becomes one pass. One pass at a time per project; a manual scan in progress
// is waited for. Runs in the main window (components/LiveNetworkRunner).
import { useSyncExternalStore } from 'react';
import { projectIndexApi, localFolderApi } from './localFolder';
import { loadScanTags, setScanTags, isScanTagged, relInProject, subscribeScanTags } from './scanTags';
import { loadScanFeatures } from './scanFeatures';
import {
  getScan, setScanState, finishScan, isScanRunning, subscribeScans, scanStopRequested, clearScanStop,
} from './scanRunner';
import { secureStorage } from './secureStore';

const SETTLE_MS = 1800;
const MAX_WAIT_MS = 8000;
const KEY = 'docvex:live-network:v1:';
const PENDING_KEY = 'docvex:live-network:pending:v1:';
// The part of the pending list the user ASKED for by tagging (read even with
// the automatic consent off).
const ASKED_KEY = 'docvex:live-network:asked:v1:';

// What the network can read: the scan's kinds (kept here so deciding on an
// arrival doesn't load the whole scan).
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i;
const MEDIA = /\.(mp4|mov|avi|mkv|webm|m4v|3gp|mp3|wav|ogg|oga|opus|m4a|aac|flac|wma|weba|aiff?)$/i;
const DOC = /\.(pdf|docx?|odt|rtf|txt|md|csv|xlsx?|ods|pptx?|html?|xml|json|eml)$/i;
const IGNORED = /(^|\/)(~\$|\.)|\.(tmp|part|crdownload|dvc|docvex)$/i;
export function liveKindOf(name) {
  if (IMAGE.test(name)) return 'pictures';
  if (MEDIA.test(name)) return 'recordings';
  if (DOC.test(name)) return 'documents';
  return null;
}

// Whether a file of this name is read by the scan as its switches stand.
function readable(name, features) {
  const kind = liveKindOf(String(name || ''));
  return !!kind && !!features[kind];
}

const norm = (dir) => String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// ── Settings (consent + pause), per project folder, on this device ─────────
export const LIVE_DEFAULTS = { on: false, recordings: false, paused: false };
export function loadLiveSettings(dir) {
  try { return { ...LIVE_DEFAULTS, ...(JSON.parse(secureStorage.getItem(KEY + norm(dir)) || 'null') || {}) }; } catch { return { ...LIVE_DEFAULTS }; }
}
function loadList(prefix, dir) {
  try { const v = JSON.parse(secureStorage.getItem(prefix + norm(dir)) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
}
function saveList(prefix, dir, set) {
  try {
    if (set.size) secureStorage.setItem(prefix + norm(dir), JSON.stringify([...set].slice(-5000)));
    else secureStorage.removeItem(prefix + norm(dir));
  } catch { /* full — the tags still stand */ }
}
const loadPending = (dir) => loadList(PENDING_KEY, dir);
const savePending = (dir, set) => saveList(PENDING_KEY, dir, set);
const loadAsked = (dir) => loadList(ASKED_KEY, dir);
const saveAsked = (dir, set) => saveList(ASKED_KEY, dir, set);

// ── The store the card reads ───────────────────────────────────────────────
// Per folder: { settings, pending (count), working, last: { at, read, error } }
const states = new Map();
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* its own problem */ } });
function stateOf(dir) {
  const k = norm(dir);
  if (!states.has(k)) states.set(k, { settings: loadLiveSettings(dir), pending: loadPending(dir).size, working: false, last: null });
  return states.get(k);
}
function patchState(dir, patch) {
  states.set(norm(dir), { ...stateOf(dir), ...patch });
  emit();
}
export function subscribeLive(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getLiveState(dir) { return dir ? stateOf(dir) : null; }
export function useLiveNetwork(dir) {
  return useSyncExternalStore(subscribeLive, () => getLiveState(dir), () => null);
}

export function setLiveSettings(dir, patch) {
  if (!dir) return;
  const next = { ...loadLiveSettings(dir), ...patch };
  try { secureStorage.setItem(KEY + norm(dir), JSON.stringify(next)); } catch { /* per device */ }
  patchState(dir, { settings: next });
  const engine = engines.get(norm(dir));
  if (!engine) return;
  // Pausing (or withdrawing consent) stops a pass at the next file.
  if (next.paused || !next.on) engine.halt = true;
  else engine.kick(200);   // resumed / switched on: whatever waits goes now
}

// ── The engine, one per open project ────────────────────────────────────────
const engines = new Map();

// Start watching a project. `notify` posts the quiet outcome toasts.
// Returns a stop function.
export function startLiveNetwork({ projectId, dir, projectName, notify }) {
  if (!projectId || !dir || !projectIndexApi?.onDelta) return () => {};
  const k = norm(dir);
  engines.get(k)?.stop();

  const known = new Map();         // rel → portable id (to tell a MOVE from an arrival)
  let listed = false;
  let timer = 0; let firstAt = 0;
  let running = false; let again = false; let dead = false;

  const engine = {
    halt: false,
    kick(delay = SETTLE_MS) {
      if (dead) return;
      const now = Date.now();
      if (!firstAt) firstAt = now;
      clearTimeout(timer);
      // Settled: no change for SETTLE_MS — but a folder being filled for
      // minutes still gets a pass every MAX_WAIT_MS.
      timer = setTimeout(run, Math.max(0, Math.min(delay, firstAt + MAX_WAIT_MS - now)));
    },
    stop() { dead = true; clearTimeout(timer); offDelta?.(); offTags?.(); offScans?.(); engines.delete(k); },
  };
  engines.set(k, engine);

  // What is in the project now — so a delta can say which rows are NEW.
  (async () => {
    try {
      const res = await localFolderApi.listAll(dir);
      for (const f of res?.files || []) known.set(relInProject(dir, f.path), f.id || null);
    } catch { /* treated as empty: nothing is tagged until the listing is there */ }
    listed = true;
    prevTags = loadScanTags(dir);
    // Arrivals from before a restart or a pause.
    if (stateOf(dir).pending && canRun()) engine.kick(4000);
  })();

  // Consent — or files the user asked for by tagging them; Pause holds both.
  const canRun = () => { const s = loadLiveSettings(dir); return !s.paused && (s.on || loadAsked(dir).size > 0 || tagsMoved); };
  let tagsMoved = false;   // a tag was taken off: a pass takes those files out

  const onDelta = (d) => {
    if (dead || !d || d.projectId !== projectId || !listed) return;
    const settings = loadLiveSettings(dir);
    const features = loadScanFeatures();
    const removedIds = new Map();
    for (const rel of d.removed || []) { removedIds.set(known.get(rel), rel); known.delete(rel); }
    // A reconcile catching up on a big change (a new index, a restore) is not
    // a file "arriving" — only small ones are read as arrivals.
    const upserts = d.reconciled && (d.upserted || []).length > 100 ? [] : (d.upserted || []);
    const tags = loadScanTags(dir);
    const tagNow = [];
    let touched = false;
    const pending = loadPending(dir);
    const asked = loadAsked(dir);
    for (const row of upserts) {
      const rel = row?.rel || relInProject(dir, row?.path);
      if (!rel || IGNORED.test(rel)) continue;
      const isNew = !known.has(rel);
      known.set(rel, row.id || null);
      if (isScanTagged(tags, rel)) {
        // New inside a tagged folder: read it (the tag asked for it). Else an
        // edit of a scanned file.
        if (isNew && readable(row.name || rel, features)) { pending.add(rel); asked.add(rel); }
        touched = true;
        continue;
      }
      if (!isNew) continue;
      // A MOVE keeps what the file was: tagged before → tagged here.
      const from = row.id ? removedIds.get(row.id) : null;
      if (from != null) { if (isScanTagged(tags, from)) { tagNow.push(rel); touched = true; } continue; }
      // A real arrival — taken only with consent and a kind switched on.
      if (!settings.on) continue;
      const kind = liveKindOf(row.name || rel);
      if (!kind || !features[kind] || (kind === 'recordings' && !settings.recordings)) continue;
      tagNow.push(rel); pending.add(rel); touched = true;
    }
    for (const rel of d.removed || []) if (isScanTagged(tags, rel)) touched = true;
    if (tagNow.length) setScanTags(dir, tagNow, true);
    savePending(dir, pending);
    saveAsked(dir, asked);
    if (pending.size !== stateOf(dir).pending) patchState(dir, { pending: pending.size });
    if (touched && canRun()) engine.kick();
  };
  const offDelta = projectIndexApi.onDelta(onDelta);

  // TAGS: what a new tag covers (a file, or everything under a folder) is
  // queued at once; a tag taken off runs a pass that drops those files.
  let prevTags = loadScanTags(dir);
  const onTags = (changedDir) => {
    if (dead || norm(changedDir) !== k || !listed) return;
    const tags = loadScanTags(dir);
    const features = loadScanFeatures();
    const pending = loadPending(dir);
    const asked = loadAsked(dir);
    let added = 0; let dropped = false;
    for (const rel of known.keys()) {
      if (IGNORED.test(rel)) continue;
      const was = isScanTagged(prevTags, rel);
      const now = isScanTagged(tags, rel);
      if (now && !was && readable(rel, features) && !pending.has(rel)) { pending.add(rel); asked.add(rel); added += 1; }
      if (was && !now) { dropped = true; pending.delete(rel); asked.delete(rel); }
    }
    prevTags = tags;
    if (!added && !dropped) return;
    savePending(dir, pending);
    saveAsked(dir, asked);
    if (dropped) tagsMoved = true;
    patchState(dir, { pending: pending.size });
    if (canRun()) engine.kick(added > 20 ? 600 : 300);
  };
  const offTags = subscribeScanTags(onTags);

  // A manual scan in progress is waited for, then the live pass follows.
  let waitingForScan = false;
  const offScans = subscribeScans(() => {
    if (waitingForScan && !isScanRunning(getScan(dir))) { waitingForScan = false; engine.kick(500); }
  });

  async function run() {
    firstAt = 0;
    if (dead) return;
    if (running) { again = true; return; }
    if (!canRun()) return;
    if (isScanRunning(getScan(dir))) { waitingForScan = true; return; }
    running = true; engine.halt = false;
    clearScanStop(dir);
    const only = loadPending(dir);
    tagsMoved = false;
    patchState(dir, { working: true });
    let outcome = null;
    try {
      const { scanProjectFiles } = await import('./dataCollections');
      // Recordings were only queued when allowed (arrivals: the live
      // recordings switch; tags: the scan's own Audio & video switch).
      const features = { ...loadScanFeatures() };
      let shown = false;
      const res = await scanProjectFiles(dir, {
        projectId,
        projectName,
        tags: loadScanTags(dir),
        only,
        features,
        isCancelled: () => dead || engine.halt || !canRun() || scanStopRequested(dir),
        // The gauges and the sidebar spinner show the pass — but only once it
        // has real work (an up-to-date pass never flashes them).
        onProgress: (p) => {
          if (p.quiet && !shown) return;
          shown = true;
          setScanState(dir, (prev) => ({
            ...p, live: true,
            startedAt: prev?.startedAt || Date.now(),
            files: p.stage === 'read' ? p.total : prev?.files,
            done: p.done ?? prev?.done, skipped: p.skipped ?? prev?.skipped, understood: p.understood ?? prev?.understood,
          }));
        },
      });
      if (res.error === 'cancelled') { outcome = null; return; }
      // The arrivals this pass saw are settled (read, or skipped and remembered).
      const left = loadPending(dir);
      const leftAsked = loadAsked(dir);
      for (const rel of only) { left.delete(rel); leftAsked.delete(rel); }
      savePending(dir, left);
      saveAsked(dir, leftAsked);
      if (res.error) {
        outcome = shown ? 'error' : null;
        patchState(dir, { last: { at: Date.now(), error: res.error } });
        return;
      }
      outcome = shown ? 'ok' : null;
      patchState(dir, { last: { at: Date.now(), read: res.read || 0, links: res.links } });
      if (res.read && notify) {
        notify({
          category: 'file', variant: 'success', icon: 'sparkles',
          title: `Understood ${res.read} new file${res.read === 1 ? '' : 's'}`,
          body: [
            res.created ? `${res.created} new data collection${res.created === 1 ? '' : 's'}` : '',
            res.updated ? `${res.updated} updated` : '',
            res.links ? `${res.links} link${res.links === 1 ? '' : 's'} in the network` : '',
          ].filter(Boolean).join(' · ') || 'Added to the neural network.',
          dedupeKey: `live-network:${k}`, dedupeStrategy: 'replace',
        });
      }
    } catch (err) {
      outcome = 'error';
      patchState(dir, { last: { at: Date.now(), error: err?.message || String(err) } });
    } finally {
      finishScan(dir, outcome);
      clearScanStop(dir);
      running = false;
      patchState(dir, { working: false, pending: loadPending(dir).size });
      if (again && !dead) { again = false; engine.kick(300); }
    }
  }

  return () => engine.stop();
}
