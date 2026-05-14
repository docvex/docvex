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

// Per-user color theme — backed by localStorage, scoped per user_id so two
// accounts on the same machine don't see each other's theme. Applies the
// chosen theme by setting `data-theme="…"` on <html>; src/styles/tokens.css
// reads that attribute and swaps the entire palette in one declarative
// re-paint.
//
// Same persistence + hydrate pattern as SelectedProjectContext:
//   - Key: `docvex.theme.<userId>` (or `docvex.theme._anonymous` signed-out).
//   - Hydrate on mount + on auth user change.
//   - Default when nothing is stored: 'cream' (the brand default).
//
// The DOM attribute is applied synchronously on every change so CSS swaps in
// the same paint. We also write before React mounts (during the first
// hydration effect) to keep FOUC to a single frame at most.

const STORAGE_KEY_PREFIX = 'docvex.theme.';

// The themes shipped today. Order in this array drives the picker layout
// left-to-right. Adding a third theme is two lines here + a new
// :root[data-theme="…"] block in src/styles/tokens.css.
//
// `swatchOrder` is intentionally identical across themes — the picker
// strip always renders the brand palette in the same canonical order
// (Ink · Slate · Sand · Cream · Cognac) so users learn it as the palette
// identity, not the theme identity.
const SWATCH_ORDER = Object.freeze(['ink', 'slate', 'sand', 'cream', 'cognac']);

export const THEMES = Object.freeze([
  {
    id: 'cream',
    label: 'Cream',
    description: 'Light, brand default. Cream surface, ink text, cognac accents.',
    swatchOrder: SWATCH_ORDER,
  },
  {
    id: 'ink',
    label: 'Ink',
    description: 'Dark variant. Ink surface, cream text, sand accents.',
    swatchOrder: SWATCH_ORDER,
  },
]);

const DEFAULT_THEME = 'cream';
const VALID_THEMES = new Set(THEMES.map((t) => t.id));

const ThemeContext = createContext(null);

function storageKey(userId) {
  return STORAGE_KEY_PREFIX + (userId || '_anonymous');
}

// Apply the data-theme attribute to <html>. Pulled out so it runs in both
// the initial hydration effect AND the setTheme path without duplication.
function applyThemeAttribute(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

export function ThemeProvider({ children }) {
  const { session, loading: authLoading } = useAuth();
  const userId = session?.user?.id || null;

  const [theme, _setTheme] = useState(DEFAULT_THEME);

  // Tracks the user-id we last hydrated for. Prevents a re-mount from
  // clobbering the user's pick when only the auth-loading flag flickered.
  const hydratedForUserRef = useRef(null);

  // Hydrate from localStorage whenever the auth user changes. Default to
  // Cream if nothing is stored OR the stored value is unknown (e.g. a
  // value from a future theme the codebase no longer ships).
  useEffect(() => {
    if (authLoading) return;
    if (hydratedForUserRef.current === userId) return;
    hydratedForUserRef.current = userId;

    let next = DEFAULT_THEME;
    try {
      const stored = localStorage.getItem(storageKey(userId));
      if (stored && VALID_THEMES.has(stored)) next = stored;
    } catch {
      // private mode / quota — non-fatal; we keep the default
    }
    _setTheme(next);
    applyThemeAttribute(next);
  }, [userId, authLoading]);

  // Public setter — writes to localStorage AND applies the attribute. Skips
  // gracefully if `t` isn't a known theme so a typo doesn't break the app.
  const setTheme = useCallback((t) => {
    if (!VALID_THEMES.has(t)) return;
    _setTheme(t);
    applyThemeAttribute(t);
    try {
      localStorage.setItem(storageKey(userId), t);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [userId]);

  const value = useMemo(() => ({
    theme,
    setTheme,
    themes: THEMES,
  }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
