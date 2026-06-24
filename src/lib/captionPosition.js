// Global (not per-file) settings for the video caption overlay in the Doc
// Viewer: where the user dragged it and whether it's shown. Stored as a single
// localStorage key so the placement is remembered across files AND app
// restarts. The position is a STAGE-RELATIVE percentage (caption centre as
// x%/y% of the video area), so it lands in the same spot regardless of the
// video's pixel size.
const KEY = 'docvex:doc-viewer:caption-settings:v1';
const ALIGNS = ['left', 'center', 'right'];
const DEFAULTS = { x: 50, y: 80, enabled: true, align: 'center' };

export function loadCaptionSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw);
    return {
      x: typeof v.x === 'number' ? v.x : DEFAULTS.x,
      y: typeof v.y === 'number' ? v.y : DEFAULTS.y,
      enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULTS.enabled,
      align: ALIGNS.includes(v.align) ? v.align : DEFAULTS.align,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Merge a partial patch ({ x, y } and/or { enabled }) into the stored settings.
export function saveCaptionSettings(patch) {
  try {
    const next = { ...loadCaptionSettings(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}
