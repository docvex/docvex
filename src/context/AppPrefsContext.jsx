import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { applyAppScale } from '../lib/appScale';
import { getPerfLevel } from '../lib/perf';

// App-wide user preferences (Settings → everything except Theme, which has its
// own ThemeContext). Single source of truth so the preferences actually DRIVE
// the app, not just the Settings demos:
//   - textSize    → global UI scale (webFrame zoom)  [applied here]
//   - reduceMotion→ `data-reduce-motion` on <html> + a global CSS kill switch
//   - thumbnails  → FileThumbnail renders the type glyph instead of a poster
//   - fileView    → the Files workspace's initial grid/list view
//   - language    → persisted; full app i18n isn't wired yet (placeholder)
//
// Per-user, persisted under docvex.appPrefs.<userId> (same key the Settings
// page used before), hydrated on auth change. Global side-effects are applied
// whenever the prefs change so a pick in Settings takes effect immediately and
// is restored on every boot.

export const DEFAULT_PREFS = {
  textSize: 100, // app-wide display scale, percent (70–125); see lib/appScale
  thumbnails: true,
  reduceMotion: false,
  fileView: 'grid',
  language: 'en',
  showTokenUsage: false, // show the per-chat token-usage indicator in AI chats
  fpsCounter: 'off', // the title bar's FPS counter: 'off' | 'simple' | 'complex' | 'graph' (components/FpsMeter)
};

const PREF_KEY_PREFIX = 'docvex.appPrefs.';
function prefKey(uid) { return PREF_KEY_PREFIX + (uid || '_anonymous'); }

function loadPrefs(uid) {
  try {
    const stored = JSON.parse(localStorage.getItem(prefKey(uid)) || '{}');
    return { ...DEFAULT_PREFS, ...(stored && typeof stored === 'object' ? stored : {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

// Apply the preferences that have a GLOBAL effect (the rest are read by their
// consumers). Safe to call repeatedly — each application is idempotent.
function applyGlobals(prefs) {
  if (typeof document !== 'undefined') {
    // The user's own choice is kept apart (lib/perf ORs the Low graphics
    // preset into data-reduce-motion) so switching preset never loses it.
    const root = document.documentElement;
    root.setAttribute('data-user-reduce-motion', prefs.reduceMotion ? 'true' : 'false');
    root.setAttribute('data-reduce-motion', prefs.reduceMotion || getPerfLevel() === 'low' ? 'true' : 'false');
  }
  applyAppScale(prefs.textSize);
}

export const AppPrefsContext = createContext(null);

export function AppPrefsProvider({ children }) {
  const { session, loading } = useAuth();
  const uid = session?.user?.id || null;

  const [prefs, setPrefs] = useState(() => loadPrefs(uid));

  // Re-hydrate when the auth user changes (account switch). Guarded so a
  // re-mount / auth-flicker doesn't clobber an in-session change.
  const hydratedForRef = useRef(null);
  useEffect(() => {
    if (loading) return;
    if (hydratedForRef.current === uid) return;
    hydratedForRef.current = uid;
    setPrefs(loadPrefs(uid));
  }, [uid, loading]);

  // Apply global side-effects on every prefs change (incl. the initial mount
  // and post-hydrate), so picks take effect live and survive restarts.
  useEffect(() => { applyGlobals(prefs); }, [prefs]);

  const persist = useCallback((next) => {
    try { localStorage.setItem(prefKey(uid), JSON.stringify(next)); } catch { /* private mode / quota */ }
  }, [uid]);

  const setPref = useCallback((key, value) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      persist(next);
      return next;
    });
  }, [persist]);

  const resetPrefs = useCallback(() => {
    setPrefs({ ...DEFAULT_PREFS });
    persist(DEFAULT_PREFS);
  }, [persist]);

  const value = useMemo(() => ({ prefs, setPref, resetPrefs }), [prefs, setPref, resetPrefs]);

  return <AppPrefsContext.Provider value={value}>{children}</AppPrefsContext.Provider>;
}

export function useAppPrefs() {
  const ctx = useContext(AppPrefsContext);
  if (!ctx) throw new Error('useAppPrefs must be used within <AppPrefsProvider>');
  return ctx;
}
