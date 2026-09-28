// The Files tab's AI scan, kept OUTSIDE React: its progress lives here, per
// project folder, not in the Files page's state — so leaving the tab neither
// stops the scan nor loses where it is. The scan itself is an async function
// (ProjectFiles' fxScanFiles → lib/dataCollections) that runs on whether or not
// the page is mounted; it writes its progress here, and whoever is on screen
// reads it: the Files page's gauges, the app sidebar's spinner beside Files.
import { useSyncExternalStore } from 'react';

const scans = new Map();        // folder → the latest progress (null / absent = idle)
const stops = new Set();        // folders whose scan was asked to stop
const listeners = new Set();
let snapshotAny = false;
let snapshotOutcome = null;   // 'ok' | 'error' | 'cancelled' while an outcome is shown
const FINISH_SHOW_MS = 2200;
const finishTimers = new Map();

const emit = () => {
  // A scan that has FINISHED (its outcome shown for a moment) is not running.
  const list = [...scans.values()].filter(Boolean);
  snapshotAny = list.some((x) => !x.finished);
  snapshotOutcome = snapshotAny ? null : (list.find((x) => x.finished)?.finished || null);
  listeners.forEach((fn) => { try { fn(); } catch { /* a listener's own problem */ } });
};

export function subscribeScans(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getScan(dir) { return (dir && scans.get(dir)) || null; }
export function anyScanRunning() { return snapshotAny; }

// `next` = the new state, or a function of the previous one; null = finished.
export function setScanState(dir, next) {
  if (!dir) return;
  const prev = scans.get(dir) || null;
  const value = typeof next === 'function' ? next(prev) : next;
  if (value && !value.finished) clearTimeout(finishTimers.get(dir));
  if (value) scans.set(dir, value); else { scans.delete(dir); stops.delete(dir); }
  emit();
}

// The scan has ENDED: its gauges jump to 100% ('ok') or drop back ('error' /
// 'cancelled') and say so for a moment, then the state is cleared. A new scan
// started meanwhile replaces it.
export function finishScan(dir, outcome) {
  if (!dir) return;
  clearTimeout(finishTimers.get(dir));
  if (!outcome) { setScanState(dir, null); return; }
  setScanState(dir, (prev) => ({ ...(prev || {}), finished: outcome, finishedAt: Date.now(), overall: outcome === 'ok' ? 1 : prev?.overall || 0, fileFrac: outcome === 'ok' ? 1 : 0 }));
  finishTimers.set(dir, setTimeout(() => {
    finishTimers.delete(dir);
    if (scans.get(dir)?.finished) setScanState(dir, null);
  }, FINISH_SHOW_MS));
}
export const isScanRunning = (scan) => !!scan && !scan.finished;

export function requestScanStop(dir) { if (dir) stops.add(dir); }
export function scanStopRequested(dir) { return !!dir && stops.has(dir); }
export function clearScanStop(dir) { if (dir) stops.delete(dir); }

// React: the scan of one folder, and whether any scan runs anywhere.
export function useScanState(dir) {
  return useSyncExternalStore(subscribeScans, () => getScan(dir), () => null);
}
export function useAnyScanRunning() {
  return useSyncExternalStore(subscribeScans, anyScanRunning, () => false);
}
// The outcome of a scan that has just ended (for a moment), else null.
export function useScanOutcome() {
  return useSyncExternalStore(subscribeScans, () => snapshotOutcome, () => null);
}
