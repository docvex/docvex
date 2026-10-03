// Fonts BUNDLED with the app (@fontsource) rather than a Google Fonts
// <link>: that stylesheet was render-blocking, so every launch with a cold
// HTTP cache waited a network round trip before the app's JS could run —
// and an office behind a slow or filtering proxy waited longer.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import './index.css';
import './styles/tokens.css';
import './styles/miniHeader.css';
import './styles/designSystem.css';
import './styles/perf.css';
import { initDesignSystem } from './lib/designSystem';
import { initPerf } from './lib/perf';
import { setLanguage, bootLanguage } from './lib/i18n';

// The design system's overrides (Settings → System → Design system) go on
// <html> before anything renders, so the first frame already follows them.
initDesignSystem();
// The graphics preset (Settings → Optimization) likewise: data-perf on <html>
// before the first frame, so a Low machine never paints the heavy look first.
initPerf();
// Interface language (lib/i18n) — started before the first render so no
// English frame flashes; AppPrefsProvider then applies the user's own choice.
setLanguage(bootLanguage());
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { AppPrefsProvider } from './context/AppPrefsContext';
import { UpdatesProvider } from './context/UpdatesContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SelectedProjectProvider } from './context/SelectedProjectContext';
import NotificationCenter from './components/NotificationCenter';
import AuthWindowGate from './components/AuthWindowGate';
import { isElectron, isMac } from './lib/platform';
import App from './App';
import { preloadBootRoute } from './AppRoutes';

// Document-viewer windows (opened from the Files page) boot straight into the
// full-screen /doc-viewer route, carrying the file's path/name/mime through.
// Every other window is the main app.
const launchParams = new URLSearchParams(window.location.search);
const isDocViewer = launchParams.get('docViewer') === '1';
// The dedicated sign-in window (main.js openAuthWindow) — the same renderer
// booted straight into /auth at the Cabinet's fixed size. The app window is
// never reshaped into a login box any more.
const isAuthWindow = launchParams.get('authWindow') === '1';
// The tray's drop window (main.js openTrayDropWindow) — a small card, no title bar.
const isTrayDrop = launchParams.get('trayDrop') === '1';
// A tab opened in a SEPARATE WINDOW (the sidebar's "Open in a new window"):
// the whole app, booted at that tab's route. Not the main window — no toasts,
// no notification sources, no background sync.
const isTabWindow = launchParams.get('tabWindow') === '1';
const tabRoute = launchParams.get('route') || '/files';
// Only the main app window shows notification toasts / runs the notification
// source hooks — aux windows (the Doc Viewer) must not pop toasts over their own surfaces.
const isMainWindow = !isDocViewer && !isTrayDrop && !isAuthWindow && !isTabWindow;

// Frameless Electron build draws a custom title bar — flag the document
// BEFORE first paint so the layout reserves --titlebar-h (no startup shift).
// Web keeps the browser chrome and skips this.
if (isElectron && !isTrayDrop) {
  document.documentElement.classList.add('with-titlebar');
  // macOS keeps the native traffic-light buttons (titleBarStyle:'hidden' in
  // main.js) floating over our bar, so the title bar insets its brand to clear
  // them and hides its own window controls. Flag it before first paint too.
  if (isMac) document.documentElement.classList.add('is-mac');
}
const initialEntries = isAuthWindow
  ? ['/auth']
  : isTabWindow
  ? [tabRoute]
  : isDocViewer
  ? [`/doc-viewer?${launchParams.toString()}`]
  : isTrayDrop
  ? ['/tray-drop']
  // Main window boots straight into the project's Files tab — the tab
  // people actually work in. (Signed out, ProtectedRoute bounces to
  // /auth; with no project selected, the page shows its "pick a project"
  // CTA.) The Activity feed stays one click away on the sidebar's "/".
  : ['/files'];

// Provider order:
//   AuthProvider                — session
//   ThemeProvider               — needs Auth (per-user theme localStorage key);
//                                 sits OUTSIDE the rest so the data-theme
//                                 attribute on <html> is set before any other
//                                 provider's children render (avoids a paint
//                                 with the wrong tokens).
//   SelectedProjectProvider     — needs AuthContext (per-user storage key + auto-clear)
//   UpdatesProvider             — independent
//   NotificationsProvider       — needs Auth + Updates via its source hooks.
//                                 NotificationCenter renders inside it (toast
//                                 stack at z 9999).
if (isMainWindow) preloadBootRoute();
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        {/* Signed in → reveal the app window; signed out → hide it and raise
            the dedicated sign-in window. App window only. */}
        {isMainWindow && <AuthWindowGate />}
        <ThemeProvider>
          <AppPrefsProvider>
            <SelectedProjectProvider>
              <UpdatesProvider>
                {/* Aux windows (the Doc Viewer)
                    restore the cached session on boot — suppress the source
                    hooks there so "Signed in as …" only toasts in the main
                    window, and don't mount the toast stack at all: toasts
                    render ONLY in the main window. */}
                <NotificationsProvider sourcesEnabled={isMainWindow}>
                  <App />
                  {isMainWindow && <NotificationCenter />}
                </NotificationsProvider>
              </UpdatesProvider>
            </SelectedProjectProvider>
          </AppPrefsProvider>
        </ThemeProvider>
      </AuthProvider>
    </MemoryRouter>
  </React.StrictMode>
);
