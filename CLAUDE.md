# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm start                 # electron-forge start (dev + Vite HMR + DevTools open)
npm run package           # build app folder in out/ (no installer)
npm run make              # build platform installers (Squirrel.exe on Windows)
npm run publish           # make + upload artifacts to GitHub Releases as a draft
                          # — requires GITHUB_TOKEN env var with public_repo scope

# Release workflow (uses npm-version lifecycle hooks defined in package.json):
npm run release:patch     # bump 1.0.x → 1.0.(x+1), commit, tag, push, publish
npm run release:minor     # bump 1.x.0
npm run release:major     # bump x.0.0
npm run release:status    # show working-tree status + last commit

# release:* scripts run preversion (fail if dirty) + postversion
# (git push --follow-tags && electron-forge publish &&
#  node scripts/generate-release-notes.mjs) automatically.
# The notes script summarises commits since the previous tag via the
# `claude` CLI and PATCHes the draft release body — best-effort, never
# fails the release. After publish, the draft release on GitHub must
# still be manually published for update.electronjs.org to surface it.
```

No tests, no linter (`npm run lint` is a stub).

## Architecture

**Electron Forge + Vite + React.** Forge orchestrates main/preload/renderer builds via `@electron-forge/plugin-vite` (see `forge.config.js`). The Vite plugin injects `MAIN_WINDOW_VITE_DEV_SERVER_URL` and `MAIN_WINDOW_VITE_NAME` globals into the main process — these are how `src/main.js` decides whether to load the dev server or the built bundle.

### Main ↔ Renderer IPC contract

`src/preload.js` is the only bridge — it exposes `window.electronAPI` via `contextBridge`. Adding any main-process capability requires editing both `preload.js` and `main.js`. Current channels:

- **OAuth:** `oauth:open-external` (renderer → main, opens browser), `oauth:callback-url` (main → renderer, when OS hands back a `docvex://` URL).
- **Updates:** `app:get-version`, `app:is-packaged`, `update:check`, `update:install`, `update:status` (main → renderer, lifecycle events).
- **General:** `app:open-external` (restricted to `http(s)` only in `main.js` — be careful not to bypass that filter when adding sibling channels).

### Custom protocol `docvex://` for OAuth callbacks

Supabase Google OAuth round-trips through Supabase's hosted callback then redirects to `docvex://auth/callback?code=...`. The OS routes that to docvex via:

- **Windows:** single-instance lock + `app.on('second-instance', argv => ...)` finds the URL in argv.
- **macOS:** `app.on('open-url', ...)`.

Critical dev-mode detail: when `process.defaultApp` is true (running under `electron-forge start`), `setAsDefaultProtocolClient` must be called with the explicit electron exe + app path, otherwise Windows tries to run `electron.exe "docvex://..."` and treats the URL as a path. See `src/main.js` registration block.

### Supabase auth flow

`src/lib/supabaseClient.js` configures `flowType: 'pkce'` and `detectSessionInUrl: false`. The PKCE choice matters: it makes the callback come back as `?code=...` (parseable via `URLSearchParams`) instead of `#access_token=...` (URL fragment, awkward inside a custom-scheme callback). Disabling `detectSessionInUrl` prevents supabase-js from trying to auto-parse `window.location`, which is meaningless in an Electron renderer using `MemoryRouter`.

The renderer drives code exchange manually: `AuthContext` listens for `oauth:callback-url` and calls `supabase.auth.exchangeCodeForSession(code)`.

`eraseData()` (distinct from `signOut()`) calls `signOut({ scope: 'global' })` to revoke refresh tokens server-side across all devices, then defensively clears `sb-*` / `supabase.*` keys from `localStorage`.

### Routing

`MemoryRouter` (not `BrowserRouter`) — Electron has no URL bar and `BrowserRouter` would interact poorly with the renderer's `file://` origin in packaged builds.

Route layout (`src/App.jsx`):
- `/auth` — full-screen, no shell.
- `/` — wraps everything else in `AppShell` (sidebar + main).
  - Public: `/` (Dashboard), `/updates` (Updates).
  - `ProtectedRoute`: `/account` only (redirects to `/auth` if no session).

The sidebar is the same on every shell route. Auth-aware UI lives inside the sidebar itself (`Sidebar.jsx` reads `useAuth()` to swap the footer between an Account NavLink + avatar/username/tier and a "Sign in" CTA).

### Auto-update pipeline

Two layers running in parallel — don't confuse them:

1. **`update-electron-app` in `src/main.js`** (packaged builds only) — polls `update.electronjs.org` every 10 min, which reads GitHub Releases for `petreluca1105-dotcom/docvex`. Squirrel.Windows downloads in background, installs on next launch.
2. **`UpdatesContext` in renderer** — fetches `https://api.github.com/repos/petreluca1105-dotcom/docvex/releases` directly on mount + subscribes to `update:status` events from main. Drives the badge on the sidebar nav item + the Updates page banner.

Layer 1 is the source of truth for "is an installer actually downloaded and ready to apply?" — that fires `update-downloaded` → `update:status { state: 'downloaded' }` → renderer shows "Restart & install".
Layer 2 is what shows release notes and the version-mismatch indicator. Works in dev too (no Squirrel needed).

Semver compare is a tiny inline `semverGT()` in `UpdatesContext.jsx` — handles `major.minor.patch` only, strips `v` prefix and pre-release suffix.

### Shared state shape

- `src/context/AuthContext.jsx` → `{ session, loading, signInWithEmail, signUpWithEmail, signInWithGoogle, signOut, eraseData }`
- `src/context/UpdatesContext.jsx` → `{ currentVersion, latestVersion, isPackaged, releases, loading, error, hasUpdate, installerState, checkNow, installUpdate }`
- `src/lib/plan.js` → `PLAN` constant (placeholder subscription tier; consumed by both Account page and Sidebar footer pill — update in one place when wiring to real data).

Both providers wrap `<App />` in `src/renderer.jsx` inside `<MemoryRouter>`.

## Configuration that lives outside source

- `.env` — `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Vite inlines these at build time). `.env` is gitignored.
- **Supabase project:** `pntxlvhkqfryyyxlqytr` (eu-west-1, organization `docvex.ro`). Schema is currently empty; modify via the `claude_ai_Supabase` MCP tools (`list_tables`, `apply_migration`, etc.).
- **Supabase dashboard items not in code:** Google OAuth provider config (client ID/secret), `docvex://auth/callback` registered as a redirect URL.
- **Google Cloud Console:** OAuth consent screen must be User Type **External** (Internal blocks `@gmail.com` testers with `org_internal` 403). Authorized redirect URI = `https://pntxlvhkqfryyyxlqytr.supabase.co/auth/v1/callback`.
- **GitHub:** `GITHUB_TOKEN` (PAT, `public_repo` scope) required for `npm run publish` — set via `[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", ..., "User")` or per-session `$env:GITHUB_TOKEN = ...`. VSCode integrated terminals cache env vars from launch; restart the whole VSCode window after setting persistently.

## Conventions

- **Styling:** plain CSS files alongside components (`Foo.jsx` + `Foo.css`). Dark theme: `#0f0f0f` page bg, `#1a1a1a` cards, `#2a2a2a` borders, `#e0e0e0` body text, `#888` muted text, `#6366f1` indigo accent. Destructive uses `#dc2626` / `#f87171`.
- **SVG icons:** inline JSX constants at the top of the file that uses them (no icon library). Stroke icons use `currentColor` so they inherit the nav-item color states.
- **Sidebar expand/collapse:** pure CSS — `.sidebar` is 60px, expands to 220px on `:hover` or `.locked`. `.label` elements fade in via opacity. Anything interactive that should be clickable only when expanded needs `pointer-events: auto` in the `:hover`/`.locked` rule (see `.lock-btn`).
- **Auth-derived display:** display name resolution is `user_metadata.full_name || user_metadata.name || user.email`. Avatar is `user_metadata.avatar_url` (Google) with an indigo first-letter circle fallback. Helper duplicated in `Account.jsx` and `Sidebar.jsx` — keep them in sync if you change one.


## Product & business context

Reference docs live at `C:\Users\Luca\Desktop\docvex\`:
- `Docvex_AI.pdf` — product vision and feature spec
- `text1.txt`, `text2.txt` — business strategy and target market notes (Romanian)
- WhatsApp images — logo variants and brand direction

Read these when reasoning about features, product decisions, positioning,
or anything related to "why" we're building something. Code lives in this repo;
"why" lives in that folder.