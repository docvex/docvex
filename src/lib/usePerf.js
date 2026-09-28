import { useSyncExternalStore } from 'react';
import { getPerfLevel, getPerfPreset, perfAllows, subscribePerf } from './perf';

// React side of lib/perf: re-renders when the graphics preset changes.
export function usePerfLevel() {
  return useSyncExternalStore(subscribePerf, getPerfLevel, getPerfLevel);
}

export function usePerfPreset() {
  return useSyncExternalStore(subscribePerf, getPerfPreset, getPerfPreset);
}

/** true while the current preset keeps `feature` (lib/perf PERF_FEATURES). */
export function usePerfAllows(feature) {
  return perfAllows(feature, usePerfLevel());
}
