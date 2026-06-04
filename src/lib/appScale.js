// App-wide UI scale, driven by Settings → "Display scale". Stored as a
// PERCENTAGE (70–125) that snaps in 5% steps, and applied via platform.setAppZoom
// (webFrame zoom on Electron, CSS zoom on web) so it scales the ENTIRE app —
// text, icons, spacing — not just text. AppPrefsContext applies it on change +
// on boot; the Settings slider binds straight to the percentage.

import { setAppZoom } from './platform';

export const MIN_SCALE = 70;
export const MAX_SCALE = 125;
export const SCALE_STEP = 5;
export const DEFAULT_SCALE = 100;

// Back-compat: the setting used to be named sizes (sm/md/lg/xl). Map any stored
// legacy token to its percent (all on the 5% grid) so existing prefs keep
// working without a migration pass.
const LEGACY_SIZE_PCT = { sm: 90, md: 100, lg: 110, xl: 125 };

// Coerce any stored/typed value to a valid snapped, clamped percentage.
export function normalizeScale(value) {
  if (typeof value === 'string' && LEGACY_SIZE_PCT[value] != null) return LEGACY_SIZE_PCT[value];
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SCALE;
  const snapped = Math.round(n / SCALE_STEP) * SCALE_STEP;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, snapped));
}

// Percentage readout — also the value the Settings slider binds to.
export function scalePercentFor(value) {
  return normalizeScale(value);
}

// Apply the app-wide scale for a stored value (percent or a legacy size token).
export function applyAppScale(value) {
  setAppZoom(normalizeScale(value) / 100);
}

// Read the persisted scale for a user (mirrors AppPrefsContext's bag). Defaults
// to 100% when unset/unparseable.
const PREF_KEY_PREFIX = 'docvex.appPrefs.';
export function readTextSize(uid) {
  try {
    const stored = JSON.parse(localStorage.getItem(PREF_KEY_PREFIX + (uid || '_anonymous')) || '{}');
    return normalizeScale(stored && typeof stored === 'object' ? stored.textSize : DEFAULT_SCALE);
  } catch {
    return DEFAULT_SCALE;
  }
}
