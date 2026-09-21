# CLAUDE.md — Docvex application

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Scope:** This file documents the **Docvex application** — the Electron
> desktop app and its web-app variant served under `/app`. The separate
> **marketing website** (docvex.ro, source in `landing/`) has its own guide:
> [`landing/CLAUDE.md`](landing/CLAUDE.md). Don't conflate the two — the "Web
> build vs Electron build" section below is the *app's* browser variant, NOT the
> marketing site. They share only the GitHub Pages `docs/` folder (the site at
> the root, the app SPA under `docs/app/`).

> **Note (2026-06):** Migration 031 removed the cloud file store and the
> GitHub-style branching/change-request system described in older versions of
> this doc. Files are now local-only per project (`lib/localFolder.js` +
> `.docvex.json` sidecar via `lib/localBranchMeta.js`). The provider stack,
> routing, and Supabase schema below reflect the post-pivot state. Newer
> surfaces — Hub (project list at `/projects`; the standalone `/launch` hub was
> removed), Doc Viewer (`/doc-viewer`, incl. the AI "Generate" advisor), Admin,
> Settings, Mail, the Project AI hub — exist but aren't documented in
> depth here; read the source directly.

Docvex is a team-collaboration desktop + web app for projects (chat, AI
tools, legal newsfeed) on top of Supabase (auth, Postgres + RLS, Realtime,
Edge Functions). Project files live in a local folder per project — there is
no cloud file store. The Electron build is the primary surface; the web build
(`/app/` on GitHub Pages) is a thin variant of the same renderer.

## Commands

```powershell
npm start                 # electron-forge start (dev + Vite HMR + DevTools open)
npm run start:multi       # launch several dev instances in parallel (scripts/run-many.mjs;
                          # sets DOCVEX_ALLOW_MULTI=1 to skip the single-instance lock)
npm run package           # build app folder in out/ (no installer)
npm run make              # build platform installers (Squirrel.exe on Windows)
npm run publish           # make + upload artifacts to GitHub Releases as a draft
                          # — requires GITHUB_TOKEN env var with public_repo scope

# Web build (GitHub Pages target under docs/app/):
npm run web:dev           # Vite dev server with web entry (src/web.jsx)
npm run web:build         # vite build → dist-web/
npm run web:deploy        # build + copy into landing/home/demo/ (gitignored).
                          # NOTE: the website no longer publishes the web build —
                          # the in-browser demo was removed from docvex.ro on
                          # 2026-07-27, and landing-deploy now clears docs/demo.
                          # The build still works for local/manual use.

# Marketing site (static HTML in landing/home/, no build — see landing/CLAUDE.md):
npm run site:dev          # serve landing/home with Vite → http://localhost:5175
npm run site:deploy       # scripts/landing-deploy.mjs → copy landing/home into docs/

# Release workflow (uses npm-version lifecycle hooks defined in package.json):
npm run release:patch     # bump x.x.(x+1), commit, tag, push, publish, regenerate web
npm run release:minor     # bump x.(x+1).0
npm run release:major     # bump (x+1).0.0
npm run release:status    # show working-tree status + last commit

# release:* run preversion (fail if dirty), `version` (sync README + rebuild
# web bundle into docs/app/), then postversion → scripts/post-release.mjs,
# which runs each step independently (a failure in one doesn't skip the rest):
#   1. git push --follow-tags
#   2. electron-forge publish   — Win Setup.exe + nupkg → draft GitHub release
#   3. publish-mac-zips         — packages + signs both darwin .app bundles, uploads zips
#   4. generate-release-notes   — `claude` CLI summarises commits, PATCHes release body (best-effort)
#   5. finalize-release         — draft=false + rebinds tag_name to v<version> so
#                                  /releases/download/v<x>/* and update.electronjs.org
#                                  start serving it. Needs GITHUB_TOKEN; publish the
#                                  draft manually on github.com as a fallback.

# Repair an existing release's macOS assets (must run ON A MAC):
npm run fix:mac           # rebuild + ad-hoc re-sign + re-zip + replace the
                          # darwin .zip assets on the latest release
npm run fix:mac -- v7.2.5 # ...on a specific tag. Needs GITHUB_TOKEN.
```

> **macOS code-signing — read before cutting a release.** Two mutually
> exclusive paths, chosen by whether `APPLE_SIGNING_IDENTITY` is set:
>
> - **Developer ID + notarization (preferred).** Set `APPLE_SIGNING_IDENTITY`
>   to a `Developer ID Application: … (TEAMID)` cert in the login keychain,
>   plus notarization creds — either `APPLE_API_KEY` / `APPLE_API_KEY_ID` /
>   `APPLE_API_ISSUER` (App Store Connect API key, preferred for CI) **or**
>   `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. Then
>   `forge.config.js` has electron-packager sign with the Hardened Runtime +
>   `build/entitlements.mac.plist`, notarize, and staple the ticket, so the
>   build launches with **no Gatekeeper "Apple could not verify …" block**.
>   `make-mac-zips.mjs` then verifies + zips as-is (it must NOT re-sign, which
>   would strip the notarization). Because the FusesPlugin flips fuse bytes in
>   `packageAfterCopy` (before packager's signing step), the signature covers
>   the flipped bytes and stays valid — so `resetAdHocDarwinSignature` is
>   turned OFF on this path. Still Mac-only (codesign/notarytool are macOS).
> - **Ad-hoc (fallback, when the identity is unset).** The build is ad-hoc
>   signed only, so Gatekeeper shows "Apple could not verify …" and users must
>   "Open Anyway" once. electron-forge's FusesPlugin flips fuse bytes AFTER the
>   ad-hoc sign, invalidating the Electron Framework signature — on Apple
>   Silicon the app gets SIGKILLed at launch (`Code Signature Invalid`). The
>   fix is a full `codesign --deep` re-sign in `make-mac-zips.mjs`, which
>   **only works on macOS**, so darwin artifacts MUST be built/signed on a Mac
>   (`npm run fix:mac` to repair an existing release). Two gotchas the scripts
>   already handle: sign in a `/tmp` copy (an iCloud-synced folder keeps
>   re-applying the `com.apple.FinderInfo` xattr that codesign rejects), and
>   stamp the rebuilt bundle with `DOCVEX_APP_VERSION` or the updater re-prompts
>   forever. The in-app self-updater also re-signs each download on the user's
>   Mac as a safety net.
>
> `npm run fix:mac` honours the same env vars — set them and it repairs an
> existing release's darwin zips as notarized builds. Notarization is a
> Developer ID feature ($99/yr Apple Developer Program); without the cert only
> the ad-hoc path is available. (The `.dmg` from `maker-dmg` isn't separately
> notarized, but the `.app` inside it carries its own stapled ticket, so it
> still launches clean.)

No tests, no linter (`npm run lint` is a stub).

## Tech stack

- **Electron 42** + **Electron Forge 7** (Vite plugin orchestrates main / preload / renderer Vite builds)
- **React 19** + **react-router-dom 7** (MemoryRouter on Electron, BrowserRouter with `basename=/app` on web)
- **Supabase JS 2** — auth, Postgres + RLS, Realtime, Edge Functions
- **pdf.js 5** for in-app PDF preview (`pdfjs-dist`), **html2canvas** for the Report-a-Problem screenshot capture
- **tesseract.js** (+ `@tesseract.js-data/ron`, `/eng`) — local OCR with word positions for the Doc Viewer's image "Extract text" (`lib/textRegions.js`); runtime files copied to `public/ocr/` on postinstall. **libphonenumber-js** + **country-flag-icons** back the identity record's phone field.
- **docx-preview** for rendering `.docx` files (Doc Viewer / `lib/openDocxWindow.js`); lazy-imported so its weight isn't paid until a Word doc is opened
- **Document generation/export** (lazy-imported): **docx** + **pptxgenjs** + **xlsx** (SheetJS) + **jspdf** build real Office files in `lib/documentGen.js` (the AI "Generate" feature — Anthropic Skills sandbox path with a local-builder fallback); **jspdf + html2canvas** power `lib/exportPdf.js` (the office-preview "Convert to PDF"). **word-extractor** (main process) reads legacy `.doc`.
- **react-markdown + remark-gfm** for rendered release notes
- **update-electron-app** → `update.electronjs.org` feed for packaged auto-updates
- **`doc-ai` Edge Function** — Claude (OCR) + OpenAI Whisper (audio transcription) powering the Doc Viewer's "Extract text" and captions tools

## High-level architecture

`forge.config.js` runs three Vite configs (main, preload, renderer). The Vite plugin injects `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME` globals into the main process — `src/main.js` reads them to decide dev-server vs file-loaded bundle.

`src/renderer.jsx` is the Electron entry; `src/web.jsx` is the web entry. They mount the same `<App />` but differ in router type, basename, and which platform shims load. The provider stack (renderer.jsx) is:

```
MemoryRouter
  AuthProvider
    ThemeProvider            — needs auth (per-user theme key); outermost so
                              data-theme is on <html> before first paint
    AppPrefsProvider
      SelectedProjectProvider — per-user storage; auto-clears on access loss
        UpdatesProvider
          NotificationsProvider — source hooks need auth + updates
            ChatUnreadProvider
              <App />
            <NotificationCenter />  — sibling of <App />, toasts at z 9999
```

`web.jsx` uses the identical provider order, differing only in router
(`BrowserRouter basename='/app'`). The former `SplitViewProvider` was removed —
SplitView is now a single-pane shell (`components/SplitView.jsx`) that publishes
its header/footer chrome through `PaneChromeContext` (per-pane, in-memory)
rather than a global multi-pane context.

### Routing

`src/AppRoutes.jsx` defines the full route tree, extracted so it can be rendered both by the main window shell (with the sidebar) and by each SplitView pane (sidebar-less, own MemoryRouter) — `Shell` / `ProjectShell` are passed in as props so the two surfaces can't drift. All page modules are `React.lazy`-imported.

- `/auth` — full-screen, no shell. (The standalone `/launch` hub was removed; the project list at `/projects` is the in-app hub.)
- `/doc-viewer` — full-screen Doc Viewer window (file preview + Legal AI panel), opened from the Files page.
- `/` — wraps everything in `Shell`.
  - Public: `/` (Activity feed), `/versions` (release history; `/updates` redirects here), `/newsletter`, `/notifications` (redirects to `/`), `/invite/:token`.
  - Dev-only: `/debug`.
  - `ProtectedRoute`: `/account`, `/settings`, `/admin`, all `/projects/*`, and project-scoped tools (`/files`, `/clients`, `/todos`, `/chat`, `/generate`, `/automate`, `/ai`, `/mail`) which read the active project from `SelectedProjectContext` rather than a URL param.
  - `/projects/:projectId` wraps `Overview` + `Dashboard` in `ProjectShell`, sharing one fetch and one Realtime channel.

### Main ↔ Renderer IPC contract

`src/preload.js` is the only bridge — exposes `window.electronAPI` via `contextBridge`. Adding any main capability requires editing both files.

- **OAuth / deep-links:** `oauth:open-external` (send), `oauth:callback-url` (receive); `app:get-startup-deep-link` (one-shot pull of a `docvex://` URL captured from `process.argv` at cold start).
- **Updates:** `app:get-version`, `app:is-packaged`, `app:get-platform-info` (`{ platform, arch }`), `update:check`, `update:install`, `update:status` (main → renderer lifecycle events), `update:download-and-install` (macOS self-updater — downloads + extracts + re-signs the arch zip).
- **Window controls (frameless):** `window:minimize / toggle-maximize / close / is-maximized / maximized-changed / is-fullscreen / fullscreen-changed`, and `window:auth-state` (`'locked' | 'app' | 'unlock'` — drives the title-bar chrome before auth). Backs the custom React `TitleBar`. `setZoomFactor` / `getZoomFactor` wrap webFrame zoom (Settings display-scale).
- **In-app file windows / Doc Viewer:** `app:open-file-window`, `app:open-html-window`, `app:open-docx` (Word fallback chain), `window:open-doc-viewer`; the Doc Viewer multi-tab bus is `doc-viewer:add-file / list / focus / close / tabs`.
- **Cross-window file sync:** `files:removed` (paths) and `files:changed` broadcast so other windows refresh their listings.
- **Legacy-format extraction (main-process):** `doc:extract-text` (legacy `.doc` via word-extractor), `whatsapp:prepare-zip / prepare-folder / detect` (WhatsApp export ingest).
- **Dev menus:** `account:switch-to` (dev-only Account menu), `debug:clear-cache`, `debug:send-test-notifications`, `debug:send-email-previews`.
- **External URLs:** `app:open-external` is filtered to `http(s)` only — preserve that filter when adding sibling channels.
- **Local folder (Files page), `local-folder:*`:** `pick / project-dir / list / list-recursive / download / write-files / delete-files / rename-file / create-folder / delete-folder / move / open-path / save-as / extract-archive / show-in-folder / watch / unwatch / changed / read-sidecar / write-sidecar`, plus a recycle-bin set writing a `.docvex-trash/` folder: `trash-file / trash-folder / list-trash / restore-from-trash / delete-from-trash / purge-trash` (sweeps entries > 30 days). The watcher is debounced ~200 ms; only the active folder is watched.

### Custom protocol `docvex://`

Supabase Google OAuth round-trips through Supabase's hosted callback then redirects to `docvex://auth/callback?code=...`. The OS routes it back:

- **Windows:** single-instance lock + `app.on('second-instance', argv => …)` finds the URL in `argv`.
- **macOS:** `app.on('open-url', ...)`.
- **Cold-start race:** if the app wasn't running, `second-instance` never fires — main scans its own `argv` once at startup and exposes it via `app:get-startup-deep-link`, which the renderer pulls once during AuthContext mount.

Critical dev-mode detail: when `process.defaultApp` is true (under `electron-forge start`), `setAsDefaultProtocolClient` MUST be called with the explicit electron exe + app path, otherwise Windows tries to run `electron.exe "docvex://..."` and treats the URL as a path. See the registration block in `src/main.js`.

### Supabase auth flow

`src/lib/supabaseClient.js` sets `flowType: 'pkce'` and `detectSessionInUrl: false`. PKCE → `?code=...` query (parseable via `URLSearchParams`) instead of `#access_token=...` fragment which is awkward in a custom-scheme callback. Disabling `detectSessionInUrl` prevents supabase-js from poking at `window.location`, which is meaningless under MemoryRouter.

`AuthContext` listens for `oauth:callback-url` and calls `supabase.auth.exchangeCodeForSession(code)` itself.

`eraseData()` (distinct from `signOut()`) calls `signOut({ scope: 'global' })` to revoke refresh tokens server-side across all devices, then defensively clears `sb-*` / `supabase.*` keys from `localStorage`. `deleteAccount()` calls the `delete-user` Edge Function with the user's JWT.

### Custom `localfile://` protocol

Registered with privileges `standard | secure | supportFetchAPI | stream | bypassCSP | corsEnabled` so `<img src>`, `<video src>`, AND `fetch()` from the Vite dev origin all work. The renderer URL-encodes the full path as one segment; `protocol.handle('localfile', …)` decodes it, streams via `fs.createReadStream` wrapped in a `Response` (so `<video>` byte-range works without buffering whole videos in memory). A `?thumb=N` query returns an OS-downscaled thumbnail (cached, bounded) for image/doc tiles; HTTP Range requests are honoured (206) for media seeking.

### Auto-update pipeline

Two layers running in parallel — don't confuse them:

1. **`update-electron-app` in `src/main.js`** (packaged builds only) — polls `update.electronjs.org` every 10 min, which reads GitHub Releases for `petreluca1105-dotcom/docvex`. Squirrel.Windows downloads in background, installs on next launch.
2. **`UpdatesContext` in renderer** — fetches `https://api.github.com/repos/petreluca1105-dotcom/docvex/releases` (cached in `sessionStorage` under `docvex:releases-cache:v1`, 1 h TTL) and subscribes to `update:status` events from main. Drives the sidebar badge + the Updates page banner.

Layer 1 is the source of truth for "is an installer downloaded and ready?" → `update-downloaded` → `update:status { state: 'downloaded' }` → renderer shows "Restart & install". Layer 2 shows release notes + version-mismatch. Works in dev too (no Squirrel needed). Web returns `state: 'web'`.

**Windows-only Squirrel.** Layer 1 is gated on `AUTO_UPDATE_SUPPORTED` (`process.platform === 'win32'`) — the macOS build isn't Developer-ID signed, so Squirrel.Mac can't apply updates. `update:check` returns `{ state: 'unsupported' }` on macOS/Linux.

**macOS self-updater.** `update:download-and-install` (main) downloads the arch-correct release zip (`installerAssetFor` in `UpdatesContext`), extracts with `ditto`, strips xattrs + ad-hoc re-signs (`xattr -cr` then `codesign --force --deep --sign -`) to repair the fuse-invalidated signature, then a detached script swaps the `.app` and relaunches (with rollback). Progress flows back as `update:status { state: 'downloading', percent }` → `'installing'`. On failure it falls back to a browser download (`downloadUpdate`); Linux always uses that fallback.

Semver compare is a tiny inline `semverGT()` in `UpdatesContext.jsx` — `major.minor.patch` only, strips `v` prefix and pre-release suffix.

## Theme system

`src/styles/tokens.css` defines all colour tokens. Two themes: **Cream** (default) and **Ink** (dark variant). Selectors are scoped via `[data-theme="…"]` on `<html>`, set by `ThemeContext`. Brand constants live on bare `:root`, semantic aliases live on `:root[data-theme="cream|ink"]`.

The unsuffixed `:root` block also paints in Cream so the first frame before React mounts isn't a flash. The bare `[data-theme="…"]` selector (without `:root`) lets ANY element declare its own subtree theme — `ThemePicker.jsx` uses this so each preview card paints in its own theme regardless of the app's active theme.

**Brand palette:** `--color-ink`, `--color-slate`, `--color-sand`, `--color-cream`, `--color-cognac`.

**Semantic tokens** (every component reads via `var(...)` — no hex literals):

```
--bg-page / --bg-card / --bg-elevated / --bg-sidebar / --bg-input
--border / --border-strong
--text-primary / --text-secondary / --text-muted / --text-on-accent
--accent / --accent-hover / --accent-soft / --accent-tint
--danger / --danger-soft / --danger-text
--success / --success-soft
--warning / --warning-soft
--info / --info-soft
--shadow-card / --shadow-elev
--overlay-scrim / --scrollbar-thumb
```

**Notification category palette:** `--cat-auth / project / member / file / role / update / support / system` (darker on Cream, lighter on Ink so each category reads at a glance in the toast stack + history view).

**Typography:** `--font-body` = Inter; `--font-display` = Plus Jakarta Sans. Loaded via `<link>` in `index.html` / `index.web.html`.

Adding a third theme = 30-line addition (new `:root[data-theme="…"]` block + entry in `ThemeContext`'s themes list).

## Context layer

All under `src/context/`. Every hook returns plain objects; no Redux / Zustand. Persistence keys all share the `docvex.*` prefix. `SplitViewContext` was removed (see the provider-stack note above); `PaneChromeContext` is in-memory and per-pane (publishes a pane's header/footer chrome into the SplitView shell via `usePaneChromeSlot`).

| Context | Exported shape (via `useXxx()`) | Persistence |
| --- | --- | --- |
| **AuthContext** | `{ session, loading, lastAuthEvent, signInWithEmail, signUpWithEmail, signInWithGoogle, linkGoogle, setPassword, signOut, logout, eraseData, deleteAccount }` | Supabase-js native (`sb-*` keys); `lastAuthEvent.at` timestamps repeated events so downstream effects can distinguish back-to-back TOKEN_REFRESHED firings. |
| **AppPrefsContext** | `{ prefs: { textSize, thumbnails, reduceMotion, fileView, language, showTokenUsage }, setPref(key, value), resetPrefs }` | `docvex.appPrefs.<userId>` (JSON). Side-effects on change: `data-reduce-motion` on `<html>`, display-scale via `appScale`/`platform.setAppZoom`. |
| **ChatUnreadContext** | `{ unreadCount, markRead() }` | `docvex.chat.lastRead.<userId>.<projectId>` (ISO ts); Realtime sub on `chat_messages` per project. |
| **PaneChromeContext** | `usePaneChromeSlot({description})` (publish), `usePaneChromePortalEl()` / `usePaneChromeFooterEl()` (chrome targets) | None — in-memory, one provider per SplitView pane. |
| **ThemeContext** | `{ theme (resolved `cream`/`ink`), themePreference (`cream`/`ink`/`system`), setTheme, themes: [{ id, label, description, swatchOrder }] }` | `docvex.theme.<userId>` (+ `docvex.theme.last` signed-out fallback). `system` tracks the OS via `matchMedia`. |
| **SelectedProjectContext** | `{ selectedProjectId, selectedProject, loading, selectProject(id, prefetched?), clearSelection, patchSelectedProject(patch), pickerOpen, openPicker, closePicker, togglePicker, switching, switchingToName, beginSwitch(name) }` | `docvex.selectedProject.<userId>` |
| **ProjectContext** (URL-scoped) | `{ project, role, members, customRoles, loading, error, refresh, refreshCustomRoles, removeMemberLocal, setMemberRoleLocal, removeCustomRoleLocal }` | None — Realtime subs + optimistic local mutations |
| **NotificationsContext** | `{ notifications, activeToasts, unreadCount, notify(payload), dismissToast(id), markRead(id), markAllRead, remove(id), clearAll }` | `docvex.notifications.v1.<userId|_anonymous>` (debounced). `HISTORY_CAP = 100`, `MAX_ACTIVE_TOASTS = 3`. |
| **UpdatesContext** | `{ currentVersion, latestVersion, isPackaged, releases, loading, error, hasUpdate, installerState, checkNow, installUpdate }` | `sessionStorage` `docvex:releases-cache:v1` |
| **ReportProblemContext** | `{ open, capturing, screenshot: { blob, dataUrl } | null, captureAndOpen, close, removeScreenshot }` | None; html2canvas is lazy-imported so the first render doesn't pay the cost. |

**Provider-order constraints** to remember:
- ThemeProvider above everything else that renders so `data-theme` is set before first paint.
- AppPrefsProvider sits below ThemeProvider, above SelectedProjectProvider.
- ChatUnreadProvider wraps `<App />` inside NotificationsProvider (chat unread badges). `NotificationCenter` is a sibling of `<App />`, not nested.
- `NotificationCenter` mounts as a sibling of `<App />` so its toasts (z 9999) render above any modal.

## Library layer (`src/lib/`)

| File | Purpose |
| --- | --- |
| `supabaseClient.js` | Singleton supabase-js client (PKCE, no auto-detect-in-URL). |
| `projects.js` | Project CRUD + member listings + auth-user profile upsert. |
| `thumbnails.js` | Byte-level thumbnail generators (canvas / pdf.js / PPTX preview / DOCX render). Only the *fallback* path — see `thumbnailEngine.js`. |
| `thumbnailEngine.js` | The thumbnail system. Turns a file into an ordered list of candidate URLs (OS thumbnail via `localfile://…?thumb=N` → original bytes → renderer-generated blob) that `FileThumbnail` walks on error. Owns the bounded generation queue, single-flight, refcounted blob cache, and failure memo. |
| `pdfCache.js` | Module-level cache of parsed pdf.js documents, keyed by content hash. Evicted from the "Debug → Clear all cached data" menu. |
| `pdfWorker.js` | pdf.js worker entry point used by pdfCache. |
| `localBranchMeta.js` | Per-(project, folder) `.docvex.json` sidecar — gives each local file a stable id that survives renames. `loadSidecar`, `saveSidecar`, `addEntry`, `removeEntry`, `removeByFilename`, `renameEntry`, `reconcileWithFilesystem`, `fileIdForFilename`, `entryForFileId`. |
| `localFolder.js` | Unified electron/web folder API (`localFolderApi.pick / list / download / writeFiles / deleteFiles / renameFile / openPath / showInFolder / watch / unwatch / onChange / readSidecar / writeSidecar / persistPickedHandle / restorePersistedHandle / reconnectHandle / forgetPersistedHandle`). Web backend uses `showDirectoryPicker`, persists the `FileSystemDirectoryHandle` in IndexedDB (`docvex-fs-handles` / `handles` store, key = projectId), 3 s poll for change detection. `readLocalBlob(pathOrName)` returns a Blob via `localfile://` (Electron) or the cached file handle (web). |
| `notifications.js` | Pure helpers: `NOTIFICATION_CATEGORIES / VARIANTS / PRIORITIES`, `buildNotification`, `resolveDedupeStrategy`, `formatRelativeTime`, `storageKeyForUser`. |
| `notificationsRepo.js` | Supabase IO for the `notifications` table: `fetchRecent`, `insertOne(row, { ignoreDuplicates })` (upsert on `(user_id, dedupe_key)`), `deleteByDedupeKey`, `markRead`, `markAllRead`, `deleteOne`, `deleteAllForUser`, `subscribeForUser`. |
| `customRoles.js` | `listCustomRoles(projectId)`, `subscribeForProjectRoles`. Custom role = `base_role` + `custom_role_capabilities` overrides; resolution happens server-side via `has_capability()`. |
| `userStatus.js` | User status enum (online / away / dnd / offline) + `getStatusForUser`. |
| `recentProjects.js` | localStorage map of `projectId → lastAccessedAt` per `userId`. `markProjectAccessed`, `getMostRecentProjectId`, `getRecentMap`, `sortProjectsByRecent`. |
| `support.js` | `sendSupportReport({ category, title, body, screenshot? })` — fire-and-forget to `send-support-report` Edge Function. |
| `sendWelcome.js` | Fire-and-forget `send-welcome` Edge Function; no-op when already sent. |
| `plan.js` | `PLAN = { tier: 'Free', features: [...] }` placeholder — read in Account page AND Sidebar footer pill; update both when wiring real plans. |
| `platform.js` | Electron / web adapter: `isElectron`, `getAppVersion`, `isPackaged`, `showInFolder`, `openPath`, `onDeepLink`, `onAccountSwitch`, `openOAuthUrl`, `checkForUpdates`, `installUpdate`, `onUpdateStatus`, `showOSNotification`. Web stubs out anything that can't work in a browser. |
| `legalFeed.js` | Legal Newsfeed (Newsletter) data layer. `listLegalUpdates()` (embeds the user's `legal_update_states`), `setUpdateRead`/`setUpdatePinned`/`setUpdateSaved`, `getWeeklyDigest()` (invokes `legal-ai`'s `digest` action, cached 1 h in `sessionStorage`). |
| `ocr.js` / `transcribe.js` | Doc Viewer "Extract text" (Claude OCR) and audio/video captions (Whisper) — both call the `doc-ai` Edge Function. `transcribe.js` ships only the audio: for **video** it extracts the audio track in-renderer (Web Audio `decodeAudioData` → downmix + resample to 16 kHz mono → 16-bit PCM WAV; **no ffmpeg dep**) so the upload stays under Whisper's 25 MB cap (~13 min of speech). |
| `extractionHistory.js` | Per-file localStorage history of OCR snippets for the Doc Viewer (a *list* per file). |
| `captionsHistory.js` | Per-file localStorage cache of the audio pane's AI transcript — *one* result per file (text + timed segments + language), so reopening a file restores captions instantly instead of re-paying for Whisper. Key prefix `docvex:doc-viewer:captions:`. |

Other notable `lib/` modules (read source for depth):

| File | Purpose |
| --- | --- |
| `projectAi.js` | Client wrapper for the `project-ai` Edge Function + the `AI_MODELS` picker catalog. Backs the AI hub. |
| `documentGen.js` | AI document generation — builds `.docx`/`.pptx`/`.xlsx`/`.pdf` via the Anthropic Skills sandbox (Path A) with local builders (docx / pptxgenjs / SheetJS / jsPDF) as the offline fallback (Path B). |
| `docConstructor.js` | Pure model behind the Doc Viewer's **per-paragraph Constructor** (`components/DocConstructor`). Parses a generated document's line-based source into sections → pieces → `[[role.field]]` blanks, composes it back (`template` keeps blanks, `text` has them filled), fills a party from an identity record and settles gender / county-vs-sector / house-vs-flat clauses. There is no separate Constructor view any more: a `.docx` opens straight on the Word preview (`DocxWorkspace` → `DocxRenderPane` in DocViewer.jsx). Picking a paragraph ZOOMS the document in on it (a transform on the `.dv-docx` host; blur veil inside the host; ↑/↓, wheel and the corner buttons step between paragraphs), and `findPieceForText` ties it back to its source piece. When that piece has data (`pieceHasData`) the paragraph is shown through a PREVIEW COPY laid over the real one (`.dv-docx-livecard`, the component renders into it via a portal): every `[[blank]]` of the clause is an inline **input** in the sentence, and a panel docked under it lists the project's **identity records as a grid** (hover previews, click fills the party everywhere and rewrites the clause in the person/company formula; the former signature Sync/Restore was removed — the signature section is ordinary text). Those options are portalled into the SIDE PANEL, above its composer (`optionsSlot` ← the advisor context's `ctorSlot`, a node in `MultitoolComposer`; `.dv-advisor-ctorslot`) — the per-paragraph ask field was removed, the side panel's composer is aimed at the picked paragraph instead. Only with no panel to go to do they fall back to the dock under the paragraph: that dock (`.dv-docx-liftpanel`) lives OUTSIDE the zoomed host but rides the camera with the paragraph like the heading card: `layoutLift` FLIPs it from under the card's current on-screen rect to its place on the host's own duration/easing (`.is-riding` — keep it in step with `.dv-docx`'s transition), and on close a lifeless clone of its markup (`.is-ghost`) flies back out. Nothing reaches the document while a paragraph is open — changes show only in the copy and are written on exit. Such a paragraph is filled through its inputs, not typed over; one with no data stays editable in place. **Versions are per paragraph**: `paragraphHistory` reads a paragraph's history out of the document versions and the pane shows it as a row of dots over the picked paragraph (click = put the paragraph back that way, as a draft change); the user's own saves no longer add a version card to the advisor thread (AI-written versions still do). The draft lives in `DocxWorkspace` (it outlives both the panel and the pane, which remounts on every rewrite); the panel's Save and closing the paragraph both go through the advisor's `saveConstructorVersion` as a new version (a file not written in DocVex only saves on the explicit Save — it is rebuilt from text). |
| `identities.js` / `identityExtract.js` | **Identity records** — a party to the case as a `.dvx` (JSON) file. Records are written BESIDE the documents (the folder being viewed, else the project root); nothing creates an `Identities/` folder any more — the Files tab's **Identities category** (Group by category) gathers them, and `listProjectIdentities` finds them anywhere (legacy `Identities/` folders still work). `identityExtract.js` reads ANY file to text (`readSourceText`: OCR for pictures and text-less PDFs, text layer / Office / plain-text extraction otherwise; audio, video and records themselves are refused) and backs both the viewer's multi-file "Fill from documents" picker (`readIdentityFromFiles`) and the Files right-click **Create identity** (`createIdentitiesFromFiles` — files are read together, so two sides of a card make one record and a contract makes one per party; merged into existing records, never overwritten). |
| `docThemes.js` | **Document themes** for the Word preview — `docvex` (the document as written), `Word Office`, `Chancery`: a palette + heading/body fonts each. Shown in the Doc Viewer's SIDE PANEL, not over the preview (the floating Word-style ribbon was removed): for a Word file `DocExtractPanel` adds **Theme** and **Add** tabs beside Advisor / Metadata (Theme = `DocThemeGrid`, a grid of thumbnails; Add is empty) and a **Quick actions** card above the side panel (`DocQuickActions`, portalled into `.dv-quick-card`: Page numbers + Open in Word, replacing the docx pane's old bottom-left button stack) — both exported from `components/DocRibbon.jsx`, styled like the app sidebar's tab buttons (selected theme = the pressed quick-action look). The state lives in `DocxRenderPane`, which publishes it to the panel through the advisor context as one memoised `docTools` object (memoised because publishing re-renders the provider and with it the pane). `applyDocTheme` stamps `data-doc-theme` + `--dt-*` vars on the `.dv-docx` host and DocViewer.css maps them onto docx-preview's style classes. PREVIEW ONLY (the file on disk isn't rewritten; Convert-to-PDF does carry it). A switch re-renders + re-paginates (fonts move lines), so it is locked while a paragraph is open or typed edits are unsaved. Remembered per file in `docvex:doc-viewer:doc-theme:<url>`. For Word files the find bar (`.dv-find`) sits in the pane's top-RIGHT corner, clear of the round Close button. |
| Word preview · paragraph affordances (in `pages/DocViewer.jsx`) | **`DocParaPill`** — every paragraph gets the app's morph pill (`useMorphPill`): a cursor-following tooltip naming the block ("Paragraph 1.1" / "Heading"), right-click morphs it into a dropdown with **Open** (the pick a click makes — `openPara`) and, on headings, **Collapse / Expand**. Fed by NATIVE listeners delegated on the host (docx-preview's nodes aren't React's) and isolated in its own component because the hook re-renders per mouse move; only a LEFT mousedown hides the tooltip — a right-click's mousedown precedes `contextmenu`, and the menu needs the tooltip's rect to morph out of. **Collapsible headings** (`docFoldLevel` / `markDocFolds` / `applyDocFolds`): Word's collapse triangle on styled headings AND paragraphs that read as one (short, all bold, numbered or capitals); folding hides everything down to the next heading of the same/higher level. The triangle is an `::after` pseudo-element (a click left of the heading's box = the triangle; handled in the capture phase, ahead of the pick). A fold RE-PAGINATES (sheets keep their size): sliced pages can't flow text back up (split paragraph halves can't be rejoined), so toggling re-renders the document and the render effect marks + applies the folds on the off-stage flow BEFORE `paginateDocx`, where a `.dv-folded` block takes no room and rides along on the open sheet (order + `paraIndex` unchanged). Only with unsaved typed edits (a re-render would drop them) is the fold applied in place, sheets shortening (`shrinkPages` → `.has-folded`) until the next render. Folds are kept per pane by heading text. **Empty blanks** (`.dv-field.is-chip`) are drawn as the same rounded slot as the picked paragraph's inputs (`.dcx-inline`) — no placeholder words in either; the hint is a Tooltip on the input, and an empty input takes the chip's width so picking doesn't re-wrap. |
| Identity record viewer (`IdentityPane` in `pages/DocViewer.jsx`, `dvr-` CSS) | Laid out as the **Entity dossier** design: header (kind tile, the name as a READ-ONLY heading — it shows **Full legal name**, and `set` / `acceptInto` keep the record's `name` in step with `legalName` — and a subline: kind · format · file), the kinds as pills (only Individual / Organisation exist in the record format — Property, Vehicle, Court file, Contract, Bank account, Object are shown disabled, as designed placeholders), then the fields as **sections** of two-column rows (`IDENTITY_SECTIONS`, per kind; unfiled fields land in the last section), and **Custom entries** (the former "In this case" section is gone, and `role` / `notes` with it — they are no longer record keys, so an older record drops them on its next save). The header and sheet run up to 1100px wide. Two record keys back it (`lib/identities.js`): `fieldSources: { [fieldKey]: filename }` — written when a reading is accepted (the row shows it as a chip → a peek card with "Open document"); typing over a field sets it to `''` ("typed"); no entry = unknown — and `custom: [{ id, label, value }]`. No page numbers or confidence are shown in the peek: the reader reports neither, and inventing them on legal data is worse than omitting them. The side panel gains a **Sources** tab for records — the tab a record's panel OPENS on — published through the advisor context as `recordPanel` (callbacks reach the pane through a ref so the published object stays stable). **Import flow — attach, click, tick:** importing only ATTACHES. With no sources the WHOLE tab is the drop zone (it fills the panel; its icon drawn like the advisor's empty-state mark — bare 64px thin-stroke glyph; no heading, no empty-state text); once there is one it becomes the tab's footer. It is the shared `components/DropZone` (Timeline / Playbook; `RecordDropZone`), whose **Import** button opens the project-file picker modal in its `attach` mode (`PICKER_MODES.attach` + `onChosen`: it hands the chosen files back UNREAD; DropZone's `onButtonClick` is what reroutes the button) and which also takes drops from the computer. Attached files appear under "Taken from" as unread (dashed) items — `attached` in `IdentityPane`, session-only: a file joins the record's `sources` only when something read from it is filled in. CLICKING an item reads it (`readSource` → `readIdentityFromFiles`; a source already in the record is looked for beside the record). **It reads from what is already known first** — the file's AI data (`lib/aiData`, shown in the Doc Viewer's Data tab): the details it gave a record of this kind before (`identity` facet) come back with no AI call at all, else its saved text (`ocr` / `text` — e.g. the image pane's Extract text) skips the transcription; only with nothing saved does the scan run and lays its data out under the fields as readings, each with a **checkbox** (`checks`: ticked where the field is empty, unticked where it would replace a value). A reading (`.dvr-pickrow`) is drawn as one of the app sidebar's tabs — bare at rest, the cursor-following accent wash on hover (`useItemSpots`, exported from `components/DocRibbon.jsx`, bound on the sheet), ticked = the active tab; it shows the value only (no "replaces …" note — the banner counts the ones that would replace something). The banner over the sheet has Tick all / Untick all and **Fill in N** (`fillChecked` → `acceptInto`, which records `fieldSources`). Clicking another source swaps whose data is shown. Each item also has its **thumbnail** (`FileThumbnail`; an imported file's own bytes when it has no path), an **open** button and a **remove** button (unlinks it from `sources` / `fieldSources`; the file and the values read from it are kept). A source item is laid out as the document ITSELF: its thumbnail left of the name (104×92 box, no frame or fill under it, `object-fit: contain` — whole, never cropped, never stretched, whatever the page's proportions), the name and state beside it, the two buttons at the row's right end (`.dvr-side-acts`). The old peek card is gone. **Typed fields:** a PERSON is named in two rows — **Last name** / **First name** (`lastName` / `firstName`); `legalName` is DERIVED from them, surname first (`joinPersonName`; `settlePersonName` reconciles the three on parse and on extraction, splitting an older record's full name — first word = surname — when it has no parts), and stays what clauses and the record's title read; an organisation keeps the single Full legal name row. **Nationality** is a searchable picker over a FIXED list (`lib/nationalities.js` — ~90 citizenships as the Romanian feminine adjective a clause uses, "cetățenie română"; `normalizeNationality` maps older spellings / English / country names onto it on parse, on readings and on accept; an unlisted value is shown as written). Also: the act of identity is a PICKER over `IDENTITY_ID_TYPES` — only the documents Romania issues (CI, CEI, CIP, the three passports, permis de ședere, document de călătorie; `id` is the clause wording that gets stored) — and AI readings are held to the same list (`ID_TYPE_RULE` in every prompt, `normalizeIdType` on the way back; an older unsupported value such as BI is shown marked, not dropped). Dates (`IDENTITY_DATE_KEYS`: date of birth, issued on) are `RecordDateField`: a TEXT field masked to the Romanian order **zz.ll.aaaa** (day.month.year; digits only, the dots insert themselves) + a calendar button that opens the native picker off a hidden `<input type="date">` via `showPicker()` — a visible native date input displays in the OS's regional format (month-first on an English Windows), which is exactly what this avoids. Stored as **DD.MM.YYYY** (`normalizeRoDate` / `roDateToIso`); a half-typed or impossible date is never stored; an unreadable legacy value is flagged under the field. Phone is a country-prefix chip (FLAG + "+40") + the rest of the number grouped as that country groups it while typed, WITHOUT the trunk zero the prefix replaces ("0721…" typed shows "721 …"); stored in international form — `lib/phone.js` over **libphonenumber-js** (`RecordPhoneField`). Flags are real SVGs (**country-flag-icons**, lazily imported — Windows has no flag emoji glyphs). **City** and **County / sector** are pickers over what exists in Romania (`lib/roPlaces.js`): the 41 counties + București's six sectors, and all 13,851 localities (`lib/roLocalities.json`, lazily imported; built from the public-domain catalin87/baza-de-date-localitati-romania dataset with cedilla ş/ţ rewritten to comma-below ș/ț) — the city list is the picked county's, biggest first; with no county it searches the whole country and picking a place fills the county in. A value not in the list (older record, a reading) is still shown as written. The **Country** row was removed from the form (records are Romanian-format only, so it sat beside County / sector saying nothing); the `country` key stays in the record, so a stored value still fills a clause. All three pickers are one component, `RecordComboPicker` — a button over a search box + list PORTALLED to `<body>` and placed from the button's rect (the section card clips overflow; native `<select>` options can't carry a flag or a second column). The per-row source chips were removed (a typed-over field still says "typed"); the peek card is reached from the Sources tab. There is **no save indicator**: the record autosaves silently and only a FAILED save shows a pill. The old ID-card read-out (`dvi-card*`) is no longer rendered; its CSS is still in the file. Also in the viewer shell: Word files get a **Quick actions card** of their own ABOVE the side panel (`.dv-quick-card`; its measured height is `--dv-quick-h`, which pushes `.dv-advisor-card` down) — `DocExtractPanel` portals `DocQuickActions` into it via the context's `quickSlot`. |
| Doc Viewer · **Data** tab (`MetadataPanel` in `pages/DocViewer.jsx`) | The side panel's former Metadata tab is labelled **Data** (tab id still `metadata`) and has two titled sections: **Metadata** (the file's own properties, as before) and **AI data** (`AiDataSection`) — everything saved about the file in the AI data store (`lib/aiData.js`, see its row): one card per facet with how/when it was made, the text (plain, selectable — no click-to-copy) and a **Recapture** button that makes it again (the tooltip says when that costs tokens). It follows the store live, so pressing Extract text in the pane fills it in; an image with nothing saved gets an Extract text button here too. |
| **AI data store** (`lib/aiData.js`) | The single home for what the app has WORKED OUT about a file, so nothing is computed or paid for twice and any document in the project can read it. One RECORD per file (`{ path, name, projectId, facets }`), one FACET per kind of knowledge (`{ kind, at, engine, paid, stamp: { size, mtime }, data }`); `AI_FACETS` is the catalogue — today `text` (a picture's text with positions, `lib/textRegions.js`), `ocr` (the PAID Claude transcription of a picture / scanned PDF) and `identity` (`{ kind, fields }` — the record details read OUT of a file). **Nothing is ever read twice:** `readSourceText` takes whatever text the store already has for the file (`bestTextFor` — either facet, so a picture the image pane already extracted costs the Sources tab nothing) and only scans when there is none; `readIdentityFromFiles`, given ONE file with a path, returns the saved `identity` fields when the record kind matches (`cached: true` → the pane says so) and saves them after a fresh read. `force` bypasses both (Recapture). API: `getAiFacet(path, kind, stamp)` (refuses a facet made from an older version of the file — `stampFor(path)` is the stat), `saveAiFacet`, `clearAiFacet`, `loadAiData`, `listAiData({ paths, projectId })` (project-wide), `bestTextFor(path)` (paid transcription wins over local OCR), `subscribeAiData` (same-window event + cross-window `storage` event). The Advisor's project digest quotes it (`aiProjectContext.js` → "Text read from pictures and scans"). **Adding a kind of AI data = an `AI_FACETS` entry + a `saveAiFacet` call** (+ a refresher in `AiDataSection` if it can be remade) — no new cache key or UI plumbing; per-file summaries, identity readings and `aiFileIndex` descriptions are the obvious next facets. Backend: `localStorage` (`docvex:ai-data:v1:<path>`, oldest records evicted when full) — shared by every window, i.e. project-wide ON THIS MACHINE; callers never touch storage, so the planned second backend (a mirror inside the project folder, so the data travels with the case) slots in behind the same functions. |
| Doc Viewer · **photo editor** (`components/PhotoEditor.jsx` + `.css`, `phe-`; mounted by `MediaOcrPane`) | Images get an **Edit photo** quick action (the Quick actions card above the side panel — `MediaOcrPane` portals `DocQuickActions` into the context's `quickSlot`, as Word files do). The editor takes the image STAGE's place (the stage stays mounted but `hidden`, so OCR state and the side panel survive): rotate left/right, a **Straighten** slider (±45°, double-click = 0), and two crops — **Rectangle** (a box with eight handles, draggable) and **Four points** (each corner placed on a corner of the page; saving pulls that quadrilateral out flat — a homography solved by Gaussian elimination + inverse-mapped bilinear sampling in `warpQuad` — which is what corrects a document photographed at an angle). It works on a ≤1600px PREVIEW of the rotated image and keeps the crop normalised (0…1), replaying the same geometry on the full-resolution pixels (≤5000px) only on save. **Save a copy** writes `name (edited).ext` beside the original (never over an existing file); **Replace original** asks twice and then overwrites (`photoBust` re-requests the image past the cache). JPEG/PNG/WebP are written in their own format; any other format (HEIC, TIFF…) can only be saved as a JPEG copy. Writing goes through `localFolderApi.writeFiles`; the component itself knows nothing about folders (`onSave({ blob, ext, replace })`). **In the editor the PICTURE FILLS THE PANE**, edge to edge (`.phe-stage`, `position: absolute; inset: 0`, no inset of any kind): it runs UNDER the floating side panel and the Quick actions card, which are painted over it (`z-index: 10` against the editor's 4). The chrome FLOATS over it too (`.phe-chrome`: the sleeve then the zoom pill, `pointer-events: none` but for the controls themselves; the hint sits at its foot). Nothing is stacked above or below the picture, which is what keeps it the same size in edit mode as out of it. **In the editor:** its tool bar spans the pane and is the same frosted material as the side panel / Quick actions card beside it, titled **Edit controls** (`.phe-bartitle` over `.phe-barrow`, the same header band as `.drb-quick-title`), and **the sleeve slides in from above the pane** (`.phe` clips it) over 360ms. It moves by TRANSFORM (`translateY(calc(-100% - 24px))` → none; `-100%` is its own height whatever it wraps to, the 24px is shadow clearance) and its SPACE IS RESERVED from the first frame, so the picture below is the same size before, during and after — the whole of edit mode shows it at one scale. Moving its `margin-top` instead was tried: that pushes the picture down AND shrinks it as the sleeve arrives, so entering edit looked like the preview zooming in. The transition is declared on the arrived state (`.phe-bar.is-in`) only. The crop's handles follow it (`.phe-overlay` fades in after a 300ms delay); the find bar and the zoom pill fade out at the same time (`:has(.phe)`). **Opening is a cross-fade, not a cut:** the editor fades in OVER the preview (`.dv-pdf-edit` / `.phe` are positioned above it) while the preview fades out where it stands (`.dv-doc-main.is-hidden` for a PDF; `.dv-media-stage.is-editing` for a picture — ONLY its opacity changes: it keeps its place in the row and every property that decides its size, because the editor is an overlay of its own (`.dv-photo-edit`, the same rule as `.dv-pdf-edit`). Pulling the stage out of the flex row so the editor could have the width was tried and is wrong: it changes the stage's width, so the picture GREW as it faded and the preview appeared to zoom in) — cutting the preview away instead left the pane blank for a frame. At t=0 the sleeve is still out of sight, so the editor's picture has the pane's full height and starts at almost exactly the preview's size. Nothing is drawn before the picture has loaded, either: an empty 1×1 SQUARE frame used to paint first, which on a portrait page read as the picture stretching sideways and then snapping. (A per-frame FLIP from the preview's rect was tried for this and REMOVED — two animations on one picture fight, and it silently mis-measured whenever the frame was still square.) **Pressing Edit takes effect at once:** for a PDF the editor opens on its "Opening the picture…" state and the 200dpi page render arrives into it (`setPdfEdit({})` first, then the page) — awaiting the render before opening made the button feel dead. A `pdfEditSeq` ref is what stops a page that finishes after Cancel from reopening the editor. **Zoom and pan are the IMAGE PANE's, to the letter.** The pill is the document panes' (`.dv-zoom-controls.is-doc` inside `.phe-zoom`), pinned at the STAGE's top-left — under the tool bar, which pushes it into view instead of sitting over it — and outside the moving layer, so it stays put while the picture is dragged. `.phe-view` is a FIXED view (`overflow: hidden`, `place-items: center`) and the picture is moved across it by a translate on `.phe-pan`, so it can be dragged at ANY zoom, 100% included. A SCROLLER was tried here first and is wrong: it can only pan what overflows, so at the fit — where the picture fits — it couldn't be moved at all. The plain WHEEL zooms (a picture's gesture). The zoom is SHOWN the way the preview shows it — `translate(pan) scale(zoom)` on `.phe-pan`, eased over 120ms and dropped while dragging, with the image pane's own `ZOOM_STEP` 1.3 and `ZOOM_MAX` 8 — so the two zooms are ONE behaviour. It was laid out instead at first (`width: calc(fit * --phe-zoom)`), which re-flowed the frame and its SVG overlay on every step and felt nothing like the preview; the reason for that was that each handle's on-screen size comes from the overlay's MEASURED width, so the measurement is now simply re-taken whenever the zoom changes (a transform doesn't ring a ResizeObserver). The moving layer is separate from the frame because the frame's own transform belongs to the quarter-turn. The pan is scaled by the zoom (which keeps the middle of the view where it was) and let go on the way back to the fit — `stepZoom` / `resetView`, the same arithmetic as the image pane's `applyZoom`; a turn and Reset call `resetView` too (the fit changes with the orientation). `.phe-view` lives one layer in from `.phe-stage` on purpose: the stage is the size CONTAINER, so `100cqw` / `100cqh` stay the FIT size whatever the zoom. **Pressing Edit changes NOTHING about how the picture is being viewed.** The editor is handed `fromRect` — the viewport rect of the preview's `<img>`, taken the moment Edit is pressed — and places its own picture exactly there, in a layout effect once the frame knows its proportions (`base.w > 1`; the canvas's size is published by a DIFFERENT layout effect, so on the commit where `img` first arrives the frame is still 1×1 square and measuring it there is meaningless). It is one scale factor (`fromRect.width / frame.width`, about the frame's own centre) and one outright move of the centre (in screen pixels — the translate comes before the scale — via `toLayoutPx`). MEASURED, not derived: deriving it by giving `.phe-stage` the preview's CSS box was tried twice and is too brittle, an 8px inset on one side being enough to shift and rescale the picture, and the two stages genuinely differ (the editor's runs edge to edge, under the side panel). When that placing is SMALLER than the stage's own fit it also becomes the zoom FLOOR, so zooming out can get back to what was on screen and no further. The pill's percentage, a quarter-turn and Reset all go to the stage's own fit (`resetFit`) — once the picture has been altered, how the preview was showing it is no longer a view worth returning to. The loupe is still what a close look at one corner is for. **A loupe** (`.phe-loupe`, 132px, ×3.4, nearest-neighbour + a cross on the point) opens while a RECTANGLE handle or a FOUR-POINT corner is dragged — the finger covers exactly the pixels that say whether the corner is on the page's corner — and RIDES the cursor, `position: fixed` from the pointer's viewport position (via `toLayoutPx`), lifted 108px clear of the hand and dropping below it near the top of the screen. **A quarter-turn is animated** (`SPIN_MS` 300ms): the frame swings round, scaled to fit its own turned bounds (a HALF-turn needs no shrinking), and only on landing is `turns` committed and the canvas redrawn upright — committing first would make the turn instantaneous. A press never waits for the swing: it adds to `pendingRef` and the frame transitions on toward the new angle (four quick presses = four turns), the LAST press scheduling the landing. The landing paint must have `transition: none` (`is-landing`, cleared on the next frame): the transform drops to none as the canvas redraws, and animating that unwinds the whole turn backwards. **Straighten snaps**: within 1.2° of 0 it lands on 0 (straight is what the slider is for, and hitting 0 by dragging a 90-step bar is fiddly), and within 0.2° of any whole degree on that degree. |
| Doc Viewer · **Extract text** on images (`lib/textRegions.js`, `TextRegionsLayer` in `pages/DocViewer.jsx`) | The image pane's other quick action (beside Edit photo): detect the picture's text WITH positions, dim the picture and lift every piece of text under a soft milky pane where it is (the Windows-Photos / phone live-text look — `.dv-textlayer` / `.dv-textregion`, `backdrop-filter: brightness`), and **copy it on click**. **The engine is LOCAL: Tesseract** (`tesseract.js`, WASM in a Web Worker, OEM LSTM-only, `PSM.SPARSE_TEXT`, models `ron` + `eng`) — a highlight has to sit ON its text, and only a real OCR engine MEASURES glyph positions (a box per word); the first two versions asked a vision model for boxes, which reads well but only estimates where, and the highlights never wrapped their text. Runtime files (worker, three LSTM cores, both `.traineddata.gz`) are copied from node_modules to **`public/ocr/`** by `scripts/copy-ocr-assets.mjs` (**postinstall**; gitignored, ~13 MB) and served at an un-hashed URL (`import.meta.env.BASE_URL + 'ocr/'`) — they can't go through the bundler (the worker `importScripts` its core by URL; language data is asked for as `<dir>/<lang>.traineddata.gz`). `workerBlobURL: false` (a blob worker can't import a file:// script). Packaged Electron is file://, where the worker's `fetch` of the models is refused, so `seedLanguageCache` puts them into tesseract's own IndexedDB cache first (idb-keyval's `keyval-store`/`keyval`, key `./<lang>.traineddata`, read with XHR) — tesseract checks that cache before fetching. The picture is read at ~2200px on its long edge (upscaled ≤2.5×). **Orientation:** upright first; only a poor reading (little confident text) tries the other three quarter-turns and keeps the best-scoring one, mapping boxes back (`unturn`) — a phone photo lying on its side is the normal case. **WHO DOES WHAT (settled after trying every other split):** WHERE the text is, is always MEASURED by the local engine — never the AI: a language model guesses coordinates, and boxes asked of it (raw, with rulers, then snapped to the ink) never sat on their text; that whole path (`detectWithVisionModel`, `snapBox`, the ink map) was REMOVED. WHAT the text says comes from the AI, asked the only way that involves no coordinates: `detectLocally` returns the measured RUNS (`{ turns, cw, ch, runs }`, pixels of the upright `ocrCanvas`); `buildSheets` cuts every run out of the upright picture (a little margin, text scaled to ~38px) onto NUMBERED SHEETS (1000px wide, ≤1100 tall, ≤6 sheets, sized to pass the API's image limits unscaled); `readRunsWithAi` sends the sheets in ONE `project-ai` `ask` call (`claude-sonnet-4-6`, `usageAction: 'text-regions'`) with `sheetsPrompt` — transcribe strip N exactly, one line per strip, `""` for a strip with no text — and `parseSheets` maps answers back by number. A run the AI says holds no text (flag, signature, smudge) is DROPPED, which is what clears the engine's noise. `runWithText` lays the AI's words onto the run's measured word boxes: same count → one each; fewer → boxes grouped at the WIDEST gaps (the real spaces; "LUCA -ANDRE I" → "LUCA-ANDREI"); more → the line's length shared out by word length. Then `composeReading` (regions + per-word extents + merged shapes). If the strip call fails, the page-wide transcription (`readSourceText` → `doc-ai`, `ocr` facet) is matched onto the lines by likeness (`reconcileWithAi`); failing that the engine's own reading stands. So strips of the picture DO go to the Anthropic API on Extract text (same terms as the rest — see the training-posture table). **Reading MODE (debug):** one toggle under AI data — Result: Local engine | AI (`loadReadingMode` / `saveReadingMode`, default `ai`); `data.parts` keeps `local` (the runs) and `ai` (text per run), so switching is free once both exist; Recapture = `force`. The pane ignores store changes that leave no CURRENT reading so highlights don't blink off mid-compose. In the Data tab a picture shows ONE **Extracted text** card (`AiDataSection`). **The reading is saved as the file's AI data** (`lib/aiData.js`, facet `text`: `{ text, regions }`, stamped with the file's size + mtime) — `extractImageText(file, { el, force })` returns the saved reading or makes one (it decodes the file itself when no `<img>` is on screen, which is how the Data tab's Recapture works), and the pane follows the store so a refresh replaces the highlights on screen. **Regions** are Tesseract LINES split where two words stand >2.2 median-letter-heights apart or at a bar/rule token (label vs value, two columns on one baseline), **nothing the engine reads is filtered out** (no confidence floor, no piece cap, no minimum size — a confidence floor used to drop real words on worn cards; confidence now only JUDGES orientation, `SCORE_MIN_CONF`), and the winning orientation is read a SECOND time in page mode (`PSM.AUTO`), whose words are added wherever the sparse pass found nothing (`regionsFromPages` / `isTaken`); a saved reading carries `v` (`READING_VERSION`) so one made by older rules is made again; cedilla ş/ţ rewritten to ș/ț. `regions` are LINES in reading order (`readingOrder`), each with its own box; the lit **`shapes`** are separate: a padded rectangle per word (own top/bottom, levelled when under half a letter apart; punctuation takes its neighbour's height — `runRects`), plus bridges between NEIGHBOURS (lines under 1.15 letters apart, pieces on one baseline under 3.5 letters apart — `bridgeRects`), united on a compressed grid into rectilinear outlines (`unionLoops`, coordinates snapped so near-equal edges don't nick) — so neighbouring text lights up as ONE shape and overlap is impossible. `dropDuplicates` keeps the surer of two readings of the SAME spot (intersection ≥ 60% of the LARGER box). A blot read as a giant letter gets no giant margin (`ref` ≤ 1.6 × the picture's median letter). Computed in the turned canvas, mapped back at the end; the facet also stores `turns`. One worker per window, kept alive. The vision-model route (`detectWithVisionModel`, via `project-ai` `ask`) survives ONLY as a fallback when the engine can't start. **There is no click-to-copy: the text is SELECTABLE.** `TextRegionsLayer` draws ONE dimming pane with every shape CUT OUT of it (`.dv-textdim`, `clip-path: path(evenodd, frame + shapes)` from `textShapesPath` — inside a shape the picture is untouched, its own pixels; an earlier frosted/brightened pane washed the text out), selection is Windows' selection blue (`#0078d7`, 50%, deliberately not a theme token), corners rounded to ≤ half the adjoining edge; rim = the same path stroked in an SVG) and lays real, transparent text over every line, WORD BY WORD (`.dv-textline` › `.dv-textword`: each region carries `words: [text, from, to]` — every word's extent along its line — and a word's cell is as wide as the room from its start to the next word's start, its text `scaleX`-stretched to fill exactly that; one stretch per whole line drifted, because a photograph doesn't space words the way a font does, and the blue selection didn't sit on what was being selected; font-size = the line's thickness; the line is rotated by `-90° × turns` for a sideways photo), so dragging selects it and Ctrl+C copies it, across lines in reading order. The lines AND the whole of every lit shape take the mouse (`.dv-texthit`, a transparent fill of the shapes path; `mousedown` stopped — on the stage it starts a pan), so a press anywhere in a shape starts a selection, never a pan; outside the shapes the stage still pans. **Extracted text tab:** the image side panel's tabs are **Advisor · Extracted text · Data** (`sideTabsForKind('image')`, tab id `extracted`); Extracted text is `TextPiecesList` — every region cropped from the full-resolution picture (`cropTextPiece`, turned upright by `turns`) on the left, its text on the right; each row is a button — HOVER brings that piece FORWARD over the picture with everything behind slightly dimmed (no blur; the crop is only ~8% larger, ≤25% for tiny print, and eases in over ~420ms) (`onHover(i, crop)` → the pane's `textHot` / `textHotSrc` → `TextRegionsLayer`'s `active` / `activeSrc`: `.dv-textveil`, a dim veil far larger than the layer so the whole stage dims at any pan/zoom, and `.dv-textpop`, the list's own upright crop over the piece's place, clamped inside the picture; with Extract text off the layer mounts `bare`, showing only these), CLICK copies its text (a fast ~240ms press: fuller accent background + an inset ring pulsing inward, `.is-pressed` / `dv-textlist-press` — no green); it lists the SAVED reading too (loaded on opening the tab, without switching the highlights on) and offers an Extract text button when there is none. (The earlier List / Picture toggle under the zoom controls and its stage overlay were removed.) **Leaving the mode:** a plain CLICK on the stage's backdrop — the spotlight around the picture — switches Extract text off (`onStageMouseDown`: `onBackdrop` + `textModeRef`; a drag there still pans, a click on the picture does nothing). **Panning works at any zoom, 100% included** (the old `canPan = zoom > 1` guard is gone — `applyZoom` scales the pan with the zoom, which keeps the stage's centre fixed whatever the offset; zooming OUT at 100% re-centres). On images this replaces the top-centre selection-tool pill (`dv-tool-pill`), which is now **video-only**. The image panel opens on Advisor; video keeps its Extract text / Captions tabs. |
| Doc Viewer · **document view controls** — page list, zoom, fit (Word + PDF; `pages/DocViewer.jsx`, `components/FilePreview.jsx`) | Both document kinds get **Pages** (toggle) and **Fit** as Quick actions ahead of their own, and the image pane's ZOOM PILL (− 100% +; `DocZoomPill`, `.dv-docpill` around `.dv-zoom-controls.is-doc`) at the top of the document area just right of the page list (`left` = the list's footprint, 8px when it is off), level with the side panel by the same measurement as the list; the percentage is against fit-to-width and pressing it returns to 100%. Word mounts it in `.dv-docview`; for a PDF `DocPane` hands it to `FilePreview` as `pdfOverlay(left)`, since only the preview knows whether its list is showing. **Page list** (`.dv-pagerail`, 128px, one preference for both kinds — `docvex:doc-viewer:page-rail`, default on): a column of page thumbnails at the document area's left edge, i.e. just right of the floating side panel; click = smooth-scroll to that page; the page crossing the upper third of the view is marked (`is-current`) and kept in view in the list; every item but the current one is faded back a little (`opacity: 0.7`; `is-current` / hover / focus = full). For a WORD file (`DocPageRail`) a thumbnail is the page's OWN DOM cloned and shrunk with `zoom` inside a stand-in `.dv-docx.dv-docx-thumb` host (docx-preview's styles are document-wide and the theme rides on the host's `data-doc-theme` + `--dt-*` vars, which are copied) — nothing is rasterised; clones are made lazily (IntersectionObserver on the rail) and rebuilt on `renderTick` / theme change, NOT per keystroke; the rail is absolutely placed in `.dv-docview` and the scroller makes room via a `:has()` margin; it is inert while a paragraph is open (`is-locked`). The list stands LEVEL with the floating side panel, top and bottom: the panel's inset can't be written in CSS from inside a pane whose own top isn't the main row's, so `lib/sidePanelEdges.js` (`alignWithSidePanel`) MEASURES the topmost / bottommost of `.dv-quick-card` + `.dv-advisor-card` against the list's frame and hands it `--rail-top` / `--rail-bottom` (re-measured on resize; CSS falls back to 8px); 4px of that is padding INSIDE the scroller so the first / last thumbnail's outline isn't clipped (`scroll-padding` for the auto-scroll). Switched off, a list is HIDDEN (`is-hidden`), not unmounted, so what it has made stays made and switching it back on is instant; PDF thumbnails are additionally kept in a window-lifetime cache (`PDF_THUMB_CACHE`, `<file>:<page>` → finished bitmap, ≤600, oldest out) and drawn from it before the first frame, so reopening a PDF doesn't repaint them. A PDF's list is only MOUNTED once it has been wanted. For a PDF (`PdfThumb` in FilePreview) a thumbnail is a small canvas painted lazily and kept; the rail is a flex sibling of the scroller (`.is-inline`). **Zoom** multiplies the fit-to-WIDTH size (1 = as wide as the pane): steps × `ZOOM_STEP` like the image pane (`stepDocZoom`, 0.1–5), keeps what is at the middle of the view in the middle, and is EASED (~200ms, geometric; snaps under reduce-motion) — Word re-runs `fitWidth` per frame; the PDF glides only the page holders' sizes (`animWidth`; painted pixels are CSS-stretched, the text layer is `scale()`d to match) and re-paints each page ONCE, off-screen then swapped in, when it settles (`paintWidth`). **Fit = a whole page inside the window's HEIGHT** (never wider than the pane), for the page being read, which is then scrolled square into view: Word works it out from the page's on-screen height ÷ the zoom it is under (`fitPage`); for a PDF only the preview can measure it, so `DocPane` bumps `pdfView.fitTick` and the preview answers with `onPdfZoom(<number>)`. **Which gesture zooms depends on whether the wheel is needed for reading.** Where the content is one fixed STAGE — a picture, a ONE-page PDF, the photo editor — the plain wheel zooms, no key held. Where it is a document to scroll through — a Word file, a PDF of more than one page — the plain wheel scrolls it and zooming is **Ctrl + wheel**, held (native non-passive listener on the scroller; `count > 1 && !e.ctrlKey` in `PdfPreview`). Word: `userZoom` → `fitWidth` sets `wrapper.style.zoom = fit × userZoom` (refused while a paragraph is open — that view is a camera move over the same pages); PDF: `DocPane` holds `pdfZoom` / `pdfRail` and hands them to `FilePreview` as `pdfView`, with `onPdfZoom` for Ctrl + wheel; page width = fit × zoom. Zoomed past the pane's width, pages align `safe center` so their left half stays reachable by scrolling. A PDF uses the pane's FULL height (`.dv-doc-main:has(.file-preview-pdf-shell)` drops its top/bottom padding) and **OPENS FITTED**: once the document and the pane's width are known the preview works out the Fit zoom itself and reports it (`fitReady` — nothing is laid out before that, so the file never shows at one size and jumps to another; no glide on open). A fitted page keeps `PDF_FIT_GAP` (12px) of air above and under it — the fit subtracts it and the page column is padded by the same. A PDF's find bar sits top-RIGHT (its top-left is the page list), as a Word file's does, and **so does a picture's** — an image is now `searchable` (the live text laid over it by Extract text is real text, so the find bar highlights matches in place; with Extract text off there is nothing to find). The bar is hidden while the photo editor has the pane (`:has(.phe)`). Inside a TEXT LAYER (a PDF's or a picture's) the shared find rules are overridden to keep the text transparent and tint only its ground — `lib/useChatFind.css` paints `color` as well, which would double every matched word over the canvas / photograph beneath. |
| Doc Viewer · **PDF tools** (`lib/pdfConvert.js`; wired in `DocPane` / `DocExtractPanel`, `pages/DocViewer.jsx`) | A PDF gets a Quick actions card (`DocPane` portals `DocQuickActions` into the context's `quickSlot`, as Word files and images do) with **To Word** and **To images** — under their own **Convert** title (an action may name a `group`; `DocQuickActions` makes consecutive actions sharing one a BLOCK with its own title, and blocks stand side by side in one row with a hairline between them — `.drb-quick-row` / `.drb-quick-block`. Each block is a GRID that WRAPS (`repeat(auto-fill, minmax(64px, 1fr))`), its width being its share of the row (`flexGrow` = how many actions it holds); one line per block was fine when a pane offered two or three actions, but the card now shows the whole catalogue and a single row would squeeze them to nothing; **The card shows EVERY quick action the viewer has** — `QUICK_ACTIONS_ALL` at the foot of DocViewer.jsx (at the foot because it names glyphs declared all through the file), handed to each `DocQuickActions` as `catalogue`. A pane still supplies only the actions that WORK on its kind of file; the rest are drawn greyed and inert (`.is-unavailable`, `aria-disabled` rather than `disabled` — a disabled button fires no mouse events and its tooltip is the only thing that says why), so what the app can do is visible from any document instead of being discovered by opening the right kind of file. The catalogue's ORDER is the card's order, so a tile keeps its place between files, and an entry may name `also` ids that satisfy it (a PDF's page editor and a picture's are one action to a reader, two ids in the code). A file with no quick actions at all still gets no card. A tile carries a faint DIVIDER on its right — a hairline centred in the grid's gap, faded out at both ends — except where it ends a row: which tile that is depends on how the grid wrapped and CSS can't ask, so `DocQuickActions` measures it (a tile whose successor sits lower) and sets `.is-rowend`, re-measured on resize. A title is `.drb-quick-title`, styled as the side panel's own Advisor / Data strip — a `--bg-sidebar` band closed by a hairline, the label at a tab's size and weight at FULL strength, i.e. `.dv-side-tab.is-active`, NOT the nav rail's small caps or a resting tab's grey. The band runs EDGE TO EDGE: it is the top of the card, not a pill on it, so `.drb-quick` carries no padding and the card's inset sits on `.drb-actions` instead, and the divider between two blocks runs the band's full height so the titles read as one strip (`.dv-quick-card`'s `overflow: hidden` is what rounds its corners). The photo editor's **Edit controls** bar title is the same band). Both work from the pdf.js document the preview already parsed (`getCachedPdf`). A PDF's text needs no tab and no AI: it is selectable in the preview itself (the local pdf.js text layer; selection = Windows' blue `#0078d7`, 50%) — the short-lived Extracted text tab (`PdfTextList` / `pdfTextByPage`) was REMOVED; the side panel is Advisor · Data. **The preview itself shows EVERY page** (`PdfPreview` / `PdfPage` in `components/FilePreview.jsx` — it used to draw page 1 only): a scrolling column at the pane's width (≤1100px), each page's holder sized to the page's real proportions up front so the scrollbar is honest; a page's canvas is PAINTED only while within ~1400px of the viewport (`IntersectionObserver` rooted on the scroller) and given back (`canvas.width = 0`) when it scrolls away, so a 300-page file costs a handful of canvases; text layers are kept once laid and, for documents of ≤60 pages, all laid up front so the find bar reaches every page; a "Page N of M" pill sits at the bottom, centred on what is VISIBLE — a SIBLING of the scroller, not a sticky child of it, because inside the scroller `margin: auto` centres against the CONTENT box, which zooming makes wider than the pane, so the pill drifted off-centre as the pages grew; its `left` is the page list's footprint. **Text selection depends on CSS this app must carry itself:** pdf.js 5's `TextLayer` no longer writes a run's size and stretch onto the span — it sets `--font-height` / `--scale-x` / `--rotate` and leaves `font-size: calc(var(--text-scale-factor) * var(--font-height))` + `transform: rotate() scaleX()` to `pdfjs-dist/web/pdf_viewer.css`, which isn't loaded here; those rules are copied onto `.file-preview-pdf-text` in DocViewer.css (without them every run sits at the default size, unstretched, and the selection rectangle misses its text), and `PdfPage` sets `--total-scale-factor` on the layer. Re-check them when pdfjs-dist is upgraded. (A PDF's page could once be opened in the photo editor and saved back as a PDF — **removed**: editing is for pictures only. `pdfPageImage` / `pdfFromImage` are still in `lib/pdfConvert.js`, now unused.) **A one-page PDF is a STAGE, like the image pane** (`.is-single`): nothing scrolls — the page is centred in the pane and moved by a TRANSFORM, so it can be dragged at ANY zoom, 100% included (a scroller can only pan what overflows, so a fitted page couldn't be moved at all), and its plain WHEEL zooms as a picture's does. Its zoom is also SHOWN like a picture's — as a composited `scale()` on the page column, eased toward the target over ~200ms — and only when it settles is the page re-laid-out and re-painted at the new size (`paintZoom` / `animZoom`; the VALUE is eased rather than a CSS transition declared, so the scale reaches exactly 1 in the same tick as the layout reaches its target and there is nothing to unwind — the same trap as the editor's quarter-turn landing). The transform is written `translate(pan) scale(z)`, in that order, so the pan stays in screen pixels. The FIT is its floor and its 100%: the preview measures it and publishes it (`onPdfFit`), `DocPane` clamps `stepPdfZoom` to it (a step out that would pass it LANDS on it) and the pill reads `zoom / pdfFit`, so — as over a picture — 100% is the whole page and nothing goes below it. A PDF of several pages keeps fit-to-WIDTH as its 100%: it is a document being read. The pan is scaled by the zoom, which keeps the middle of the view where it was, and is let go once the whole page fits again — the same arithmetic as the image pane's `applyZoom`; Fit re-centres it. `align-items: center`, not `safe center`: a page bigger than the stage hangs off BOTH sides, as a zoomed picture does. A press ON A GLYPH RUN still starts a text selection rather than a pan (the text layer takes no pointer, only its runs do — the same split the picture's live text uses), and a press anywhere else LETS GO of the selection by hand, since the pan's `preventDefault` is exactly what stops the browser collapsing it. **To images:** every page rendered at ~200 dpi (capped at ~16 MP per page) to PNG — `pdfToImages`; one page → the picture beside the PDF, several → a new `<name> (pages)` folder (`localFolderApi.createFolder`; where folders can't be made, beside it, page-numbered). **To Word:** a PDF has no paragraphs, only glyph runs at coordinates, so the document is REBUILT (`pdfToDocx`): `linesFromItems` (runs on one baseline → a line; a gap over a fifth of the letter size = a missing space, a gap over three letters = two things on one baseline, kept apart with em spaces; sideways runs skipped) → `paragraphsFromLines` (a line joins the one above when it is the same size, a normal leading below, the line above ran to the right margin and it doesn't open with a number / bullet / `Art.` / an indent; hyphenated words rejoined; headings by size against the document's body size; centred / right-aligned by position) → `docx` paragraphs, each PDF page starting a Word page (`pageBreakBefore`). It is an editable TEXT of the document, not a copy of its layout — columns, tables and drawings don't survive as such. A page with no text layer is a scan and is placed as its picture; when the WHOLE file is a scan its text is read by the AI instead (`readSourceText` — the cached `ocr` facet, so paid once) — the success toast says which happened. **Nothing is overwritten:** the Word file takes the first free name (`freeName`: `x.docx`, `x (2).docx`…) — a `contract.docx` beside `contract.pdf` is very likely the original it was exported from. Verified in Node: the line/paragraph rebuild against a real two-page jsPDF document (wrapped paragraph rejoined, title centred + Heading 1, `Art. 1` Heading 2, numbered items kept apart, two signature blocks on one baseline kept apart) and the `docx` output (headings, centring, page break, image, em spaces all present in `document.xml`); rendering pages and writing files are NOT verified outside the app. |
| `exportPdf.js` | Office-preview → PDF (lazy `html2canvas` + `jspdf`), one page per rendered element. |
| `conversationHistory.js` | Per-file localStorage cache of the Doc Viewer AI-advisor thread + generated-doc iterations (`docvex:doc-viewer:conversation:<path>`). |
| `mail.js` | Gmail/Outlook OAuth client for the Mail tab (`mail-sync` / `mail-callback`), three-leg PKCE-style flow. |
| `admin.js` | `get_admin_stats` aggregates + admin-allowlist CRUD (`app_admins`). |
| `appZoom.js` / `appScale.js` | `appZoom.js`: base-zoom constant (now **1**) + `toLayoutPx` viewport→layout-px helper. `appScale.js`: normalises the Settings display-scale preference (70–125%, 5% steps). |
| `audioEnvelopeCache.js` / `captionPosition.js` | Doc Viewer audio: cached waveform envelope (LRU, base64 in localStorage) and the persisted caption-overlay position. |
| `chat.js` / `privateMessages.js` | Supabase IO for `chat_messages` (+ reactions, threads, pins) and `private_messages` (DMs). |
| `extractFileText.js` | Best-effort text extraction (txt/PDF/DOCX/XLSX) for AI attachments. |
| `useChatFind.js` | Find-in-conversation via the CSS Custom Highlight API (no DOM mutation). |
| `fileDragBus.js` / `folderColors.js` / `projectsDir.js` / `projectFilesPrefetch.js` | Files-page support: rich drag-preview bus; per-folder colour tags; per-user "projects folder" pref; background Files warm-cache (Electron-only). |
| `thumbnailDescriptor.js` | Descriptor builders (`describeLocalFile` / `describeLooseFile`) feeding `thumbnailEngine.js`. |
| `whatsappChat.js` | WhatsApp `.txt` export parser/detector (Android + iOS layouts). |
| `aiFileIndex.js` | One-time per-file AI description (Haiku, batched 8 text / 4 images), cached in `localStorage` (`docvex:ai-file-index:v1`) against size+mtime. Makes AI search cheap: a photo is decoded and uploaded once in its life, not once per search. |
| `aiSearchCache.js` | AI-search answer cache — `(folder signature, normalised query) → hits` in `docvex:ai-search-answers:v1`. A repeat search costs nothing; any add/delete/rename/edit changes the signature and invalidates the folder's answers. |
| `metadataPrefetch.js` | Background sweep that extracts + caches file metadata (`metadataHistory.js`) as files appear in a folder, so the Doc Viewer's Metadata tab is pre-filled. One file at a time, on idle, size-capped, cancelled by the next listing. |
| `activityMetrics.js` | Personal Activity-page metrics (heatmap, streak, breakdown). |

## Supabase data model

Project ID `pntxlvhkqfryyyxlqytr` (eu-west-1, organization `docvex.ro`). Modify via the `claude_ai_Supabase` MCP tools (`list_tables`, `apply_migration`, etc.). **No cloud file store** — the `drop_branching_and_cloud_files` migration (2026-06-02, "migration 031") dropped the tables `project_files`, `change_requests`, `change_request_items`, `branch_changes`, `project_member_branches`, the `projects.main_version` column, and the branching RPCs. The `projects` / `projects-pending` **storage buckets still physically exist** in the project but are orphaned — the app no longer reads or writes them (files are local-only). They're a cleanup candidate, not a live dependency.

Migrations continued **after** the branching drop (it is NOT the latest): the admin stack (`admin_stats_rpc`, `app_admins_table_and_rpcs`, `app_services_inventory`), the Mail stack (`create_user_mail_connections`, `create_mail_oauth_states`), and `create_enrollments` (the current latest, 2026-06-17). Use `list_migrations` for the authoritative order.

### Tables (current)

| Table | Notable columns | Notes |
| --- | --- | --- |
| `projects` | `id, name, description, created_by, created_at, updated_at, ai_context?, ai_context_updated_at?` | `add_creator_as_owner` trigger inserts owner row. `ai_context*` (migration 030) feeds the Project AI tab — admin-writable. |
| `project_members` | PK `(project_id, user_id)`, `role` enum (`owner/admin/member/viewer`), `custom_role_id?`, `added_at` | RLS via `has_project_role` / `has_capability`. |
| `project_invitations` | `id, project_id, email, role, custom_role_id?, token unique, invited_by, created_at, expires_at (+7d), accepted_at?` | Unique on `(project_id, lower(email))` WHERE `accepted_at IS NULL`. Consumed by `accept-invite` Edge Function → `accept_invitation` RPC. |
| `custom_roles` | `id, project_id, name, description, base_role` (`admin/member/viewer`, owner excluded) | Migration 008. |
| `custom_role_capabilities` | PK `(custom_role_id, capability)`, `granted bool` | `project_capability` enum: `files.view/upload/delete_any/delete_own`, `members.invite/remove/change_role`. Row absence = inherit from base tier. |
| `project_ai_usage` | `id, project_id, user_id?, action, model, input_tokens, output_tokens, session_id?, created_at` | Migration 030. Backs the Project AI usage panel via `get_project_ai_usage`. |
| `notifications` | `id, user_id, category, variant, priority, title, body, icon?, payload jsonb, created_at, read_at?, dedupe_key?` | Unique `(user_id, dedupe_key)`. Index `(user_id, created_at DESC)`. |
| `chat_messages` | `id, project_id, author_id, body, mentions uuid[], attached_file_ids uuid[], created_at, edited_at?, deleted_at?, parent_id?, pinned_at?, pinned_by?` | Soft-delete via `deleted_at`. `parent_id` / pin columns + `chat_message_reactions` table from migration 026. |
| `private_messages` | — | DM messages; see `lib/privateMessages.js`. |
| `legal_updates` | `id, slug unique, category, impact (low/medium/high), title, source?, citations?, summary?, areas text[], raw_content?, ai_status, published_at, created_at, updated_at` | Global Legal Newsfeed, not project-scoped. Migration 029. Public read (`for select using (true)`); written only by `legal-ai` Edge Function (service role) or seed. |
| `legal_update_states` | PK `(user_id, update_id)`, `read_at?, pinned_at?, saved_at?, updated_at` | Per-user read/pin/save flags. Migration 029. RLS: `user_id = auth.uid()`. |
| `chat_message_reactions` | `(message_id, user_id, emoji)` | Emoji reactions on `chat_messages` (migration 026). Toggled via `lib/chat.js`. |
| `app_admins` | app-admin allowlist | Backs `is_app_admin` / the Admin page gate. Not project-scoped. |
| `app_services` | service-inventory rows | Powers the Admin "Developer Console" service tracker (Supabase/Anthropic/Resend/domains). |
| `user_mail_connections` | per-user mailbox tokens (encrypted at rest) | Gmail/Outlook OAuth connections for the Mail tab; tokens AES-GCM-encrypted by `mail-sync` (`MAIL_TOKEN_KEY`). |
| `mail_oauth_states` | OAuth nonce/state rows | Short-lived CSRF/state records for the Mail OAuth round-trip (`mail-callback`). |
| `enrollments` | — | Present but unused (0 rows) — future feature; no live code path. |

### RPCs

| RPC | Purpose |
| --- | --- |
| `has_project_role(project_id, min_role)` | STABLE tier-check used by RLS. |
| `has_capability(project_id, capability)` | SECURITY DEFINER, custom-role-aware capability check (migration 008); supersedes `has_project_role` for files/members RLS. |
| `accept_invitation(token, user_id)` | SECURITY DEFINER. Atomically inserts `project_members` (propagating `custom_role_id`) + marks `accepted_at`. |
| `create_custom_role` / `update_custom_role` | SECURITY INVOKER. Atomically write a custom role + replace its capability overrides. |
| `get_member_profiles` / `get_member_profiles_status` | `(p_project_id uuid)` — joins `project_members` with auth user metadata (+ status). |
| `get_project_ai_usage(project_id, since?)` | SECURITY INVOKER, defaults `since` to start of current month. Monthly usage aggregate for the Project AI tab. |
| `get_admin_stats` | SECURITY DEFINER, email-allowlisted. Admin-page live metrics — see `lib/admin.js`. |
| `is_app_admin` | SECURITY DEFINER. True when the caller is in the `app_admins` allowlist — gates the Admin page + admin RPCs. |
| `current_user_has_password` | Whether the signed-in user has a password set (vs. OAuth-only) — drives the Account "set/change password" affordance. |
| `set_chat_message_pin` | Pin/unpin a chat message (migration 026). |

**Dropped in migration 031 — do not use:** `approve_change_request`, `approve_change_requests`, `_apply_change_request_items`, `reject_change_request`, `reject_change_request_item`.

### RLS patterns

- Project-scoped reads/writes call `has_project_role(...)` or `has_capability(...)`; deletes typically require admin/owner.
- Personal rows (`notifications`, `legal_update_states`) gate on `user_id = auth.uid()`.
- `accept_invitation` and `delete-user` (Edge Function) bypass RLS via SECURITY DEFINER.

### Storage

Project files are local-only (`lib/localFolder.js`, `.docvex.json` sidecar via `lib/localBranchMeta.js`) — the app reads/writes no Supabase Storage bucket. The legacy `projects` / `projects-pending` buckets still exist in the project but are orphaned (see the data-model note above); the only live bucket is `email-assets` (public), used by the email Edge Functions.

### AI providers + training posture

Docvex handles privileged legal material, so **no provider in this stack may
train on what users send.** That is a property of the *contract and endpoint*,
not of the model id — there is no "trains" vs "doesn't train" variant of a
model to switch between, and changing `claude-opus-4-7` to something else does
nothing for it. What matters is which company receives the bytes and under
which terms. The full list of third parties that ever see user content:

| Endpoint | Reached from | Sees | Training posture |
| --- | --- | --- | --- |
| `api.anthropic.com/v1/messages` | `project-ai`, `doc-ai`, `legal-ai`, `legal-assist` | document text, chat, OCR images, AI-search file stills | Commercial API terms: inputs/outputs **not** used for training. ~30-day retention for trust & safety; ZDR negotiable. |
| `api.anthropic.com/v1/files` + code-execution container | `project-ai` `office` action | generated Office files | Same commercial terms. |
| `api.openai.com/v1/audio/transcriptions` | `doc-ai` `transcribe` | recorded audio / video audio tracks | API traffic **not** used for training by default (since 2023-03); 30-day retention. |
| `api.deepgram.com/v1/listen` | `doc-ai` diarization | the same audio | **Weakest of the three.** Standard (non-Enterprise) terms allow using data to improve their models. Gated behind `DOC_AI_ALLOW_DEEPGRAM=1` on top of the key — see below. |

Rules for anything added later:

- **API endpoints only, never a consumer surface.** Consumer tiers (claude.ai,
  chatgpt.com) *do* train on conversations. Everything here is `api.*` with a
  server-held key, and it must stay that way.
- **Deepgram needs two opt-ins.** `DEEPGRAM_API_KEY` alone no longer enables
  diarization; `DOC_AI_ALLOW_DEEPGRAM=1` must be set too. A key sitting in the
  environment must not be enough to start shipping client and witness audio to
  the one provider whose default terms permit learning from it — that flag is
  the operator confirming their Deepgram contract forbids training.
- **New provider ⇒ check its default, not its marketing.** If the default is
  "we may train unless you opt out", either don't use it or gate it the same
  way Deepgram is gated, and add a row to the table above.
- Zero-Data-Retention is the remaining upgrade for Anthropic + OpenAI: both
  keep API payloads ~30 days for abuse monitoring unless a ZDR agreement is in
  place. Not the same thing as training, but it's the next thing a firm's
  security review will ask about.

### Edge Functions (`supabase/functions/`)

`accept-invite`, `send-invite`, `revoke-invite`, `send-welcome`, `send-support-report`, `delete-user` — shared HTML email templates in `_shared/emailTemplates.ts`; SMTP via Supabase, fire-and-forget from the client.

`legal-ai` — Claude-powered Legal Newsfeed AI. Raw REST to the Anthropic Messages API, model `claude-opus-4-7` (override via `LEGAL_AI_MODEL`). `{ action: 'digest' }` returns a weekly briefing (`{ ok, summary, highImpactCount, total, generatedAt }`, or `{ ok:false, error:'ai_not_configured' }` at 200 so the client falls back); `{ action: 'ingest', items: [...] }` classifies + summarises raw legal text into `legal_updates` (service role, gated on `x-ingest-secret` matching `LEGAL_INGEST_SECRET`). Needs `ANTHROPIC_API_KEY`.

`doc-ai` — Doc Viewer AI. Actions: `ask / summary / risks / romanian / draft / review` (Claude, `claude-opus-4-7`, override `DOC_AI_MODEL`), `ocr` (Claude, `claude-haiku-4-5`, `lib/ocr.js`), `transcribe` (OpenAI `whisper-1`, `lib/transcribe.js`; optional `DEEPGRAM_API_KEY` for speaker diarization). Needs `ANTHROPIC_API_KEY` (+ `OPENAI_API_KEY` for transcribe).

`mail-sync` / `mail-callback` — Gmail/Outlook OAuth sync for the Mail tab. `mail-sync` (JWT-gated) proxies the OAuth exchange and encrypts tokens at rest (`MAIL_TOKEN_KEY`); `mail-callback` is **public** (`verify_jwt = false`) — it bridges the provider redirect back to `docvex://` (or web `/mail`) via the `state` nonce. Needs `GOOGLE_CLIENT_ID/SECRET` and/or `MS_CLIENT_ID/SECRET`.

`project-ai` — backs the AI hub (`/ai`) and `project_ai_usage` logging. Actions `ask / suggest / generate / office`; model `claude-opus-4-7` (override `PROJECT_AI_MODEL`), with `office`/code-execution defaulting to `claude-sonnet-4-6` (`OFFICE_MODEL`). The model-picker catalog (`AI_MODELS` in `lib/projectAi.js`) now also offers `claude-opus-4-8`. Deployed as a neutral Claude.ai-style assistant (not a legal advisor); supports the real `ask_user` tool. Needs `ANTHROPIC_API_KEY`.

`legal-assist` — **deployed-only, no source under `supabase/functions/`** (it lives with the Word add-in in `docs/word-addin/`). Claude backend for the **DocVex Legal AI Microsoft Word add-in** (Office.js taskpane); JWT-gated, tasks `summary / risks / romanian / ask`; model `claude-opus-4-7` (override `LEGAL_ASSIST_MODEL` / `LEGAL_AI_MODEL`). Needs `ANTHROPIC_API_KEY`. This is a separate product surface from the in-app Doc Viewer — don't confuse it with `doc-ai`.

## Local project files

Each project's files live in a folder on the user's machine, picked via `localFolderApi` (`lib/localFolder.js`). `lib/localBranchMeta.js` maintains a `.docvex.json` sidecar in that folder — `{ version: 1, projectId, entries: { [fileId]: { filename, contentHash, mtime } } }` — giving each file a stable id that survives renames, syncs via Dropbox/iCloud, and re-attaches without prompting when the folder is re-picked. `ProjectFiles.jsx` (presentation: `components/FilesWorkspace`) owns folder nav, hashing, and sidecar reconciliation.

## Notification system

Three layers:

1. **Source hooks** (`src/notifications/sources/use*NotificationSource.js`)
   - `useAuthNotificationSource(notify, { ready })` — SIGNED_IN welcome, SIGNED_OUT goodbye.
   - `useUpdateNotificationSource(notify, { ready })` — installer state transitions (downloading / downloaded / restart).
   - `useSocialNotificationSource(notify, userId, { ready })` — placeholder hook for future @-mentions / DMs.
2. **Context** — `notify(payload)` accepts `{ category, variant, title, body, icon?, priority?, duration?, persistent?, dedupeKey?, osLevel? }`. Resolves dedupe strategy (`coalesce` / `replace` / `insert`), enforces the 3-toast cap, mirrors writes to Supabase + localStorage. Returns the notification id (existing id on coalesce).
3. **Action registry** (`src/notifications/actionRegistry.js`) — maps notification types to icons / actions / titles for the history view + test menu.

UI: `NotificationToast` auto-dismisses after `duration` (5 s default; `persistent: true` opts out), `NotificationCenter` is both the floating toast stack AND the `/notifications` page with category / priority filters. Icons live in `src/notifications/icons.jsx`; the dev "Send all test notifications" menu fires every entry in `src/notifications/testNotifications.js`.

**Realtime flow.** notify() mutates local state immediately, then asyncly mirrors to Supabase + localStorage. Realtime INSERT events from other devices dedupe by `id` (no re-toast). UPDATEs sync `read_at` across devices; DELETEs remove rows.

## Pages

### Root pages (`src/pages/`)

| Page | Purpose |
| --- | --- |
| `Activity` (`/`) | Signed-in landing — merged feed of activity + the old notifications inbox. Reads `NotificationsContext`; renders category-tinted activity cards with category **filter tabs** + a **Day / Category** group toggle + Mark-all-read / Clear-all. `/notifications` `Navigate`-redirects here. |
| `Account` | Profile, link Google, plan info (`lib/plan.js`), `eraseData` and `deleteAccount` actions. |
| `Updates` (`/versions`) | Release history, current vs latest, "Check now", installer state badge. |
| `Newsletter` (`/newsletter`) | Legal Newsfeed — Romanian legislation/compliance briefing. Typographically-led feed (masthead, AI-weekly line, Section/Impact/Search filters, day-grouped `ed-article` rows with category eyebrow + impact mark, AI-brief lead, "Affects …" meta line, per-item read/pin/mark/save). Data is real (`legal_updates` + `legal_update_states` via `lib/legalFeed.js`); AI weekly line from `legal-ai`'s `digest` action, cached 1 h (`docvex:legal-digest:v1`), with a local fallback when the AI key isn't configured. Public personal route (not behind `ProtectedRoute`), reached from the **Personal** sidebar section. Styles `ed-`-prefixed in `Newsletter.css`. |

Other root pages (read source for depth):
- `Admin` (`/admin`) — "Developer Console": `app_services` inventory tracker, mailbox-intelligence panel, live platform metrics (`get_admin_stats`), destructive-ops danger zone. App-admin-gated (`app_admins` allowlist / `is_app_admin`).
- `Settings` (`/settings`) — app preferences (theme, display scale, thumbnails, file view, reduce motion, token-usage indicator, language) + the Electron "projects folder" picker.
- `Mail` (`/mail`) — personal inbox with real Gmail/Outlook OAuth sync (`mail-sync` / `mail-callback`); AI-drafts replies in the user's voice with tone/length controls.
- `Debug` (`/debug`, dev-only), `DocViewer` (`/doc-viewer`).

### Project-scoped (`src/pages/Projects/`)

| Page | Purpose |
| --- | --- |
| `ProjectList` | "Editorial Dossier" layout — documents-masthead header (accent eyebrow + big display "Projects." title), a **Recently opened** featured-card tier (last-7-days from `recentProjects.js`) and **All projects** (full list). Member avatar stacks from `get_member_profiles`, per-project accent derived from the id hash. All `pjx-`-prefixed CSS in `ProjectList.css`. |
| `ProjectCreate` | New-project form. |
| `ProjectOverview` | `/projects/:id` landing — `pjd-`-prefixed "Dossier" shell: back-link, hero (serif name + description), a 4-cell meta strip (Files / Members / Joined / Last activity), tab bar **Overview · Members · Roles · AI · Settings**. **Overview**: usage gauges + real Team list + placeholder activity timeline. **AI**: project-context textarea (`projects.ai_context`, admin-writable) + usage stats backed by `project_ai_usage` / `get_project_ai_usage` (real, but zero until AI features log requests). **Members / Settings**: real member management + invites, rename/description + danger zone. **Roles**: `RolesDossier` — role-catalog cards with per-role headcounts + a capability-matrix table wired to `lib/customRoles` (tri-state inherit/grant/revoke, optimistic overlay + debounced persist), `CustomRoleEditor` for create/delete. Chrome + Roles styles in `ProjectDossier.css`. |
| `ProjectDashboard` | Tabbed project dashboard (Members via `TeamTree`, Activity). Tab persistence via `useSearchParams ?tab=`. The former "Pending edits" / version-control tab (change-request review) was removed with the branching system (migration 031). |
| `ProjectFiles` | Local-files page — folder picker, listing, hashing, sidecar reconciliation (`lib/localBranchMeta.js`), search/nav, every action handler. Presentation via `components/FilesWorkspace`. |
| `ProjectChat` | Team + Private (DM) chat — split-pane layout. **Team**: message thread + collapsible right rail (**Pinned / Threads / Mentions / Files** sub-tabs). **Private**: 3-column DM pane (member list · thread · shared-files rail). Bubbled messages with @mention chips, day dividers, attachment cards, typing dots; per-message hover actions (react / reply-in-thread / pin, + edit/delete on own); reactions strip, thread pill, header search, inline edit, scroll-to-latest pill. Data: `chat_messages` (+ `parent_id`, `pinned_at`/`pinned_by`, `chat_message_reactions` from migration 026; pinning via `set_chat_message_pin`). Lib: `src/lib/chat.js` (`listThreadReplies`, `listProjectReplies`, `sendThreadReply`, `setChatMessagePin`, `listReactionsForProject`, `toggleReaction`, `subscribeReactions`) + `src/lib/privateMessages.js`. Styles in `ProjectChatVariantB.css` (`dvx-`/`vb-`-prefixed), full-height via `.project-page-frame:has(.dvx-chat.vb-chat)`. Renders **chromeless + flush** like Files (`/chat` is in both `CHROMELESS_FULLSCREEN_ROUTES` and `FLUSH_CONTENT_ROUTES`): a big `.dvx-mh` masthead + a sticky single-row `.dvx-toolbar` mini-header (tabs + chrome tools), the composer portalled into the SplitView footer (`usePaneChromeFooterEl`), and an internal `.dvx-scroll-area` block scroll container (the sticky toolbar must be a *direct* child of the scroller, not a flex item, or it won't pin). The toolbar gets `.is-pinned` (rect-based detection: bar.top − scroller.top ≤ 8) which paints the `--bg-sidebar` background only while actually stuck at the top. |
| `ProjectGenerate / ProjectAutomate / ProjectClients` | Stubs for future features. |
| `ProjectTodos` | To-do list stub. |
| `TeamTree` | Org-chart view of project members + roles. |
| `InviteAccept` | Token-driven invite acceptance; public so unauthenticated invitees can land here and bounce through `/auth`. |

Newer project-scoped page (read source for depth): `ProjectAI` (`/ai`) — the project **AI chat**, backed by the `project-ai` Edge Function's `ask` action (+ `project_ai_usage` logging). Laid out exactly like the Chat tab (same `.dvx-mh` masthead / sticky `.dvx-toolbar` mini header / `.dvx-scroll-area` page scroller / footer-docked `.dvx-composer`): two tabs — **Chat** (a left rail of saved conversations with create/delete, per user+project in localStorage `docvex.aichat.v3.*`, plus the thread + composer) and **Debug** (intentionally empty). Labelled **Advisor** in the sidebar / pane nav / masthead. The assistant sees the whole project: `lib/aiProjectContext.js` builds a size-capped digest (project card + `ai_context`, members, the local-folder file inventory with cached `aiFileIndex` descriptions, the last team-chat messages — DMs excluded, the case timeline, OCR snippets, captions and file metadata) that rides transiently on each turn's last user message (never persisted into the thread, cached ~60 s). On top of that, attached (paperclip / drag-from-Files) or name-mentioned files get their full text extracted (`lib/extractFileText`) and inlined. The advisor can also CREATE files in the Files tab (Doc-Viewer-generate-style): turns run with `docTools: true`, `write_document` results build a real docx/pptx/xlsx/pdf via `buildDocumentBlobSmart` and save into the project folder (`localFolderApi.writeFiles` + `notifyFilesChanged`), and `ask_user` pauses into an inline `AskUserPanel` above the composer when the model is unsure whether/what to create (steer note in `FILE_STEER`). Styles in `ProjectAIChat.css` (+ the `.ai-hub` bubbles in `ProjectAI.css`); icons in `Projects/aiHub.jsx`. (The former AI hub with its five tools was removed; `ProjectAITools.jsx` remains on disk, orphaned. `components/ExtractionsPanel` and `lib/extractionHistory.js` still exist but are no longer mounted by any page.)

Shared layout: `ProjectScoped.css` provides the standard project page frame (sticky header, content container).

## Component patterns

All components live in `src/components/` with a sibling `.css` file.

### Modals

`ConfirmModal` is the base shape (title / body / confirm + cancel). Domain modals (`DeleteProjectModal`, `DeleteAccountModal`, `InviteMemberModal`, `ChangeMemberRoleModal`, `RemoveMemberModal`, `ReportProblemModal`) follow the same z-index conventions and overlay scrim (`var(--overlay-scrim)`). Toasts render at `z 9999` so they pop over any modal.

### Role gating

`RoleGate` renders children only when the user's role meets `minRole` (integer rank: viewer 0 → owner 3).
`RoleLocked` is the alternative pattern requested in user feedback: keep the feature rendered for everyone and overlay a "[role] only" mask for users who lack the role, so the layout is consistent and discoverable rather than disappearing.
`RoleBadge` is a coloured pill of the role name. `CustomRoleEditor` drives create/edit of custom roles; `RolesDossier` is the current capability-matrix surface on ProjectOverview (the older grid-based `RoleCapabilityMatrix` stays on disk, unused there).

### Tooltip + morph-pill

`Tooltip` is a cursor-following pill — fixed-position, `transform: translate(x, y)` updated on `mousemove`, animated via `transition: transform 45ms ease-out` (re-targets per move, no queue). Trigger wrapper uses `display: contents` so it doesn't add a layout box. It opens on hover and on **`:focus-visible` only** — `onFocus` early-returns unless `target.matches(':focus-visible')`, so a mouse/programmatic focus doesn't pop the pill at a stale screen location. A window `pointermove` safety net (gated on a `shown` flag) hides it when the pointer leaves the trigger node (`node.contains(under)`), covering missed `mouseleave`s.

**Use `<Tooltip>`, not native `title=`.** Hover hints throughout the app go through this component (DocViewer, FilesWorkspace, AppShell, AskUserPanel, Sidebar, SplitView, TokenUsagePill, TitleBar). The only remaining `title=` usages are component *props* (PageMasthead/ConfirmModal/DangerRow/SettingCard/StreamDoc), not native HTML tooltips — don't reintroduce a raw `title=` attribute.

**Morph-pill FLIP recipe** (`useMorphPill.jsx`, used by FilesWorkspace tiles and elsewhere). Same DOM node serves as hover tooltip and right-click menu; the menu state adds an `.is-menu` modifier and a FLIP animation morphs between sizes. The CSS `transition: transform` is intentionally suppressed (`.is-menu { transition: none; }`) so a JS-set inline `transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1)` can drive the morph without racing.

Recipe per right-click:
1. Snapshot the pre-menu rect (`oldPillRectRef = pillRef.current.getBoundingClientRect()`).
2. Toggle `menuMode = true`; React commits the larger menu layout.
3. `useLayoutEffect`: compute `sx = oldRect.width / newRect.width`, `sy = oldRect.height / newRect.height`. Snap `translate(x, y) scale(sx, sy)` with no transition. Force reflow.
4. Add `transition: transform 220ms`; set `translate(x, y) scale(1, 1)` — GPU-composable.

Dismissal: Escape, scroll (capture), outside `mousedown`, or mouseleave on the menu when `pointer-events: auto` is in effect.

### FilesWorkspace

`FilesWorkspace.jsx` + `.css` — presentation layer for the local Files page: file-explorer-style chrome, tile/list canvas (Ctrl+scroll zoom), `useMorphPill` hover/right-click menus per tile/row. Driven entirely by props from `ProjectFiles.jsx`; holds only local UI state (view mode/zoom, search, selection, menu/properties open). All `fx-`-prefixed CSS. Currently being reworked alongside the migration-031 local-files pivot — read directly for the current tab/action structure.

### Status + theme

- **StatusBadge / StatusPicker** — user status enum (`online / away / dnd / offline`).
- **ThemePicker** — mock cards painted via `[data-theme="…"]` on each card so they preview in their own theme regardless of the app's active theme.

### Layout

- **AppShell** — wraps Sidebar + content; mounts the global ReportProblem modal, the `CursorSpotlight`, the `UpdateProgressBar`, and the `SplitView` content shell.
- **Flush-left layout + route sets.** `.app-chrome` uses `gap: 0` so page content sits **flush against the sidebar** (no gap); the window-edge inset (top/right/bottom) still comes from `.app-shell` padding, and right-side padding is kept so content doesn't hug the scrollbar. Two route sets drive per-route chrome:
  - `CHROMELESS_FULLSCREEN_ROUTES` (`SplitView.jsx`) — render WITHOUT the in-content chrome bar (page carries its own masthead): `/`, `/newsletter`, `/versions`, `/settings`, `/debug`, `/mail`, `/projects`, `/account`, `/files`, `/chat` (+ the exact `/projects/:id` overview).
  - `FLUSH_CONTENT_ROUTES` (`AppShell.jsx`) — full-bleed editorial surface (no rounded frame, negative margins to the window edges, flush to the rail): `/`, `/newsletter`, `/versions`, `/files`, `/chat` (+ the exact `/projects/:id` overview). Non-flush "card" pages get a flattened left edge (`border-left:none`, no left radius) so they still sit flush against the rail.
- **Unified mini-headers.** Every tab's compact sticky header is the same shape: a rounded `--bg-sidebar` section (matches the window top bar), `height: 40px`, `border-radius: 9.6px`, `top` offset by `--chrome-inset` (so it doesn't tuck behind the sidebar), right gap = the tab's content width, with `padding` matching Files. Per-surface class names: `pmh-compact` (PageMasthead — Activity/Versions/Newsletter/Settings/Debug), `pjd-compact` (ProjectOverview), `dc-compact` (Admin), `fx-pathbar` (Files), `dvx-toolbar` (Chat). Each gets `.is-pinned`/`is-pinned` only when actually stuck at the top (rect-based detection), painting the bg then and staying transparent while scrolling under the masthead.
- **Sidebar** — 60 px collapsed, 220 px expanded on `:hover` / `.locked`. `.label` elements fade via opacity. Anything interactive that should respond when expanded needs `pointer-events: auto` in the `:hover` / `.locked` rule (see `.lock-btn`). Auth-aware footer swaps between Account NavLink + avatar / username / tier and a "Sign in" CTA. Has a cursor-following spotlight glow (see the zoom/native-event Conventions notes).
- **TitleBar** — custom frameless title bar (Electron): window controls + Documentation/Theme/Updates/Account, driven by the `window:*` IPC. Layout reserves `--titlebar-h`. (`ProjectPickerPanel` was removed.)
- **SplitView** — single-pane content shell; portals a pane's header/footer chrome into fixed slots via `PaneChromeContext` (it replaced the old multi-pane SplitView + its context).
- **ProjectBanner** — small **fixed-position pill** at top-centre of the viewport ("Working in <project>"), border-radius 999 px, shadow `0 8px 24px rgba(0,0,0,0.32)`. Not in-flow — `.project-page-frame` resets its `margin-top` accordingly.
- **Other shared components:** `CursorSpotlight` (cursor-tracked radial glow), `AskUserPanel` (interactive `ask_user`-tool controls above a composer), `GavelThinking` (AI loading indicator), `TokenUsagePill` (per-chat token total, gated on the `showTokenUsage` pref), `PageMasthead` (shared eyebrow/title/description header), `SwitchProjectLoader`, `ActivityMetrics`, `DangerZone`, `fileGlyph`.

### File previews

`FileThumbnail` resolves a poster URL (cached thumbnail or MIME glyph). `FilePreview` renders PDF (pdf.js) / image / video / text inline. Double-clicking a file in the Files page opens it in the **Doc Viewer** (`/doc-viewer`, `src/pages/DocViewer.jsx`) — a dedicated window with a `classify(mime, name)` dispatcher per mime type: photo/video get an "Extract text" OCR **lasso** tool (freeform Photoshop-style selection, clipped canvas → `lib/ocr.js`) with a persisted, resizable extraction-history panel (`lib/extractionHistory.js`); audio/video get a custom player whose **loudness-envelope canvas doubles as the seek control** (the full-file waveform is the scrubber — click / drag / arrow-key to seek; `role="slider"`), **YouTube-Music-style karaoke lyrics** in the player pane (the active timed segment highlights + auto-scrolls to centre), and a side AI-captions panel with **inline editing** of the generated transcript (fix mistranscriptions, recompute joined text). Captions come from `lib/transcribe.js` (Whisper) and are cached per file via `lib/captionsHistory.js`; the panel pushes edits/regenerations back to the player's lyrics live via an `onCaptionsChange` callback. `.docx` renders via `docx-preview` (lazy-imported, `lib/openDocxWindow.js`).

## Conventions

- **Styling:** plain CSS files alongside components (`Foo.jsx` + `Foo.css`); zero CSS-in-JS / Tailwind. Use only `var(--…)` from `tokens.css`. Adding a hard-coded hex is a smell — there's a semantic token for almost everything.
- **SVG icons:** inline JSX constants at the top of the file that uses them — no icon library. Stroke icons use `currentColor` so they inherit hover / active states.
- **`display: contents` wrappers** for synthetic event hosts that shouldn't add a layout box (e.g. Tooltip's `.tooltip-trigger-wrap`).
- **App base zoom is `1`** (`:root { zoom: 1 }` in `index.css`; `BASE_APP_ZOOM = 1` in `lib/appZoom.js`). The former 20% downscale (`zoom: 0.8`) was removed. The Settings "Display scale" preference still composes on top — webFrame zoom on Electron, inline CSS `zoom` on `<html>` on web (`platform.setAppZoom`). Any code that writes a **viewport** coordinate (`clientX`, a `getBoundingClientRect()` value) into a **CSS length** (a `style.left`/`transform`, an SVG coord, a `--spot-x`-style gradient var) must still pass it through `toLayoutPx()` — it's an identity at base zoom 1 but compensates the web display-scale (also CSS zoom). Ratios of two viewport values (percent splitters, seek bars) cancel the zoom and need no conversion.
- **Spotlight / cursor-tracked glows over portalled content** must use a **native** `addEventListener('mousemove')` on the host node, not React's `onMouseMove`. React synthetic events bubble along the React tree, so a handler on an ancestor whose visual children are `createPortal`'d elsewhere (e.g. the Doc Viewer advisor card, whose side panel portals into `.dv-advisor-slot`) never fires over that content — only on the host's own border/padding. Native listeners follow the real DOM tree where the portal nodes actually live.
- **FPS-independent cursor-chase easing.** Any rAF loop that eases a glow/spotlight toward the cursor must compute its lerp factor from the frame's timestamp delta, not a fixed per-frame constant, or the chase speed varies with refresh rate. Recipe: `factor = 1 - Math.pow(1 - EASE, dt / FRAME_60)` with `FRAME_60 = 1000/60` and `dt = clamp(ts - lastTs, …, 100)` (used by the Sidebar rail glow; `CursorSpotlight` instead snaps the box directly to the cursor each move).
- **5-stop animated gradient pill** (`.updates-banner-uptodate` and similar status pills): `linear-gradient(120deg, 5% / 16% / 18% / 16% / 5%)`, `background-size: 300% 100%`, 8 s shimmer keyframe; centred dot with `box-shadow: 0 0 0 6px ...` halo. Reusing this shape keeps "status pill" semantically consistent across the app.
- **Auth-derived display:** display name resolution is `user_metadata.full_name || user_metadata.name || user.email`. Avatar is `user_metadata.avatar_url` (Google) with a deterministic first-letter circle fallback (palette of 12 colours, djb2 hash on the id). Helper is duplicated across a few components (`Account.jsx`, `Sidebar.jsx`, ...) — keep them in sync if you change one.
- **Notification dedupe keys** are mandatory for anything that can fire repeatedly (uploads, downloads, errors). The notify() resolver coalesces / replaces / inserts based on category + dedupeKey, so a bad key spams the user.
- **Realtime subs** belong in a `useEffect` keyed on the resource id (projectId / userId), with a cleanup that unsubscribes. Don't open subs in render. Don't share a sub across providers — channel state is per-mount.
- **Fire-and-forget** is the default for non-critical writes (analytics, send-welcome, saveSidecar) — they return promises but call sites don't await. Errors are swallowed and the next operation retries naturally.
- **No tests, no lint.** Verify renderer changes via `npx esbuild --bundle --format=esm --platform=browser --loader:.jsx=jsx --loader:.js=jsx --loader:.css=empty --loader:.ico=empty --loader:.png=empty --loader:.jpg=empty --loader:.svg=empty --jsx=automatic --outfile=/tmp/check.js src/renderer.jsx` before claiming a change works.

## Web build vs Electron build

| Aspect | Electron | Web |
| --- | --- | --- |
| Entry | `src/renderer.jsx` | `src/web.jsx` |
| Router | `MemoryRouter` (`initialEntries=['/']`) | `BrowserRouter basename='/app'` |
| HTML | `index.html` | `index.web.html` (Vite plugin renames to `index.html` on build) |
| `localFolder` backend | `fs.watch` + `fsp` + `shell` via IPC | File System Access API + IDB-persisted directory handle + 3 s poll |
| Folder persistence | path string in localStorage | `FileSystemDirectoryHandle` in IndexedDB; permission re-granted via "Reconnect" each session |
| OAuth callback | `docvex://auth/callback` custom protocol | Supabase redirect to web origin |
| Version | `platform.getAppVersion()` IPC | `VITE_APP_VERSION` (package.json at build time) |
| Update lifecycle | `autoUpdater` + IPC events | `state: 'web'` (no installer) |
| `showInFolder` / `openPath` | `shell.showItemInFolder` / `shell.openPath` | no-op success |
| Deploy | electron-forge publisher → GitHub Releases | `scripts/web-deploy.mjs` → `docs/app/` (GitHub Pages, `404.html` SPA fallback) |

## Configuration outside source

- `.env` — `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (Vite inlines at build time). Gitignored.
- **Supabase project `pntxlvhkqfryyyxlqytr`** (eu-west-1, organization `docvex.ro`). Modify schema via `claude_ai_Supabase` MCP tools.
- **Supabase dashboard, not in code:** Google OAuth provider config (client id / secret), `docvex://auth/callback` and the web origin registered as redirect URLs, the SMTP for email Edge Functions.
- **Edge Function secrets (Supabase dashboard → Edge Functions → Secrets), not in code:** `RESEND_API_KEY` (email functions); `ANTHROPIC_API_KEY` (`legal-ai` + `doc-ai` OCR — without it the Newsletter AI line falls back to a computed line, ingest 500s, and OCR fails); `OPENAI_API_KEY` (`doc-ai` Whisper transcription — **not yet configured**); `DOC_AI_ALLOW_DEEPGRAM` (must be `1` before `DEEPGRAM_API_KEY` does anything — see the training-posture table); `LEGAL_INGEST_SECRET` (optional — guards `legal-ai`'s `ingest` action; while unset, ingest returns 403); `LEGAL_AI_MODEL` (optional — overrides the default `claude-opus-4-7`, e.g. `claude-haiku-4-5` to cut digest cost).
- **Google Cloud Console:** OAuth consent screen must be User Type **External** (Internal blocks `@gmail.com` testers with `org_internal` 403). Authorized redirect URI = `https://pntxlvhkqfryyyxlqytr.supabase.co/auth/v1/callback`.
- **macOS signing env (release-time, not in code):** `APPLE_SIGNING_IDENTITY`
  (a `Developer ID Application: … (TEAMID)` cert in the login keychain) enables
  the Developer ID + notarization path in `forge.config.js`; pair it with notary
  creds — `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` **or**
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. Unset ⇒ ad-hoc
  fallback (Gatekeeper-blocked). See the code-signing note above.
- **GitHub:** `GITHUB_TOKEN` (PAT, `public_repo` scope) required for `npm run publish` — set via `[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", ..., "User")` or per-session `$env:GITHUB_TOKEN = ...`. VSCode integrated terminals cache env vars from launch; restart the whole VSCode window after setting persistently.

## Scripts (`scripts/`)

| Script | Purpose |
| --- | --- |
| `sync-readme-version.mjs` | Bumps the version string in README.md to match package.json. Runs in the `version` lifecycle. |
| `web-deploy.mjs` | Copies `dist-web/` → `docs/app/`, renames `index.web.html` → `index.html`, writes `404.html` SPA fallback for GitHub Pages. Also runs in `version`. |
| `post-release.mjs` | Runs after `npm version`: `git push --follow-tags`, `electron-forge publish`, `generate-release-notes.mjs`. |
| `generate-release-notes.mjs` | Summarises commits since the previous tag via the `claude` CLI and PATCHes the draft GitHub release body. Best-effort, never fails the release. |
| `make-mac-zips.mjs` | Zips the packaged `.app` bundles, preserving framework symlinks (archiver, not cross-zip). **On macOS** it first copies to a non-iCloud temp dir, `xattr -cr`, `codesign --force --deep --sign -`, and `--verify --strict` (fails the build if invalid). `MAC_ZIP_VERSION` overrides the filename version. Non-Mac hosts can't sign → those zips crash on Apple Silicon. |
| `publish-mac-zips.mjs` | Release-time companion: packages both darwin arches, runs make-mac-zips, uploads the two zips to the draft release (deletes same-named assets first for idempotency). Called from `post-release.mjs`. |
| `fix-mac-release.mjs` (`npm run fix:mac`) | One-shot repair for an existing release's macOS assets — **must run on a Mac.** Resolves the target tag (default: latest), rebuilds both arches stamped with the release version (`DOCVEX_APP_VERSION`), re-signs + verifies + zips (`MAC_ZIP_VERSION`), and replaces the release's darwin zips. Needs `GITHUB_TOKEN`. |

## Release notes style (user preference)

Four sections (`Added` / `Changed` / `Removed` / `Misc`), no emojis, plain English understandable to non-programmers. This overrides the auto-generator's default format — adjust the prompt in `generate-release-notes.mjs` if the template drifts.

## Product & business context

Reference docs live at `C:\Users\Luca\Desktop\docvex\`:

- `Docvex_AI.pdf` — product vision and feature spec
- `text1.txt`, `text2.txt` — business strategy and target market notes (Romanian)
- WhatsApp images — logo variants and brand direction

Read these when reasoning about features, product decisions, positioning, or anything related to "why" we're building something. Code lives in this repo; "why" lives in that folder.
