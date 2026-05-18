# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Docvex is a team-collaboration desktop + web app for project files with a GitHub-style branching/change-request flow on top of Supabase. The Electron build is the primary surface; the web build (`/app/` on GitHub Pages) is a thin variant of the same renderer.

## Commands

```powershell
npm start                 # electron-forge start (dev + Vite HMR + DevTools open)
npm run package           # build app folder in out/ (no installer)
npm run make              # build platform installers (Squirrel.exe on Windows)
npm run publish           # make + upload artifacts to GitHub Releases as a draft
                          # — requires GITHUB_TOKEN env var with public_repo scope

# Web build (GitHub Pages target under docs/app/):
npm run web:dev           # Vite dev server with web entry (src/web.jsx)
npm run web:build         # build + scripts/web-deploy.mjs (copies into docs/app/)
npm run web:preview       # preview the built web bundle locally

# Release workflow (uses npm-version lifecycle hooks defined in package.json):
npm run release:patch     # bump x.x.(x+1), commit, tag, push, publish, regenerate web
npm run release:minor     # bump x.(x+1).0
npm run release:major     # bump (x+1).0.0
npm run release:status    # show working-tree status + last commit

# release:* scripts run preversion (fail if dirty), `version` (sync README +
# rebuild web bundle into docs/app/), and postversion
# (git push --follow-tags && electron-forge publish &&
#  node scripts/generate-release-notes.mjs). The notes script summarises
# commits since the previous tag via the `claude` CLI and PATCHes the draft
# release body — best-effort, never fails the release. After publish, the draft
# release on GitHub must still be manually published for update.electronjs.org
# to surface it.
```

No tests, no linter (`npm run lint` is a stub).

## Tech stack

- **Electron 42** + **Electron Forge 7** (Vite plugin orchestrates main / preload / renderer Vite builds)
- **React 19** + **react-router-dom 7** (MemoryRouter on Electron, BrowserRouter with `basename=/app` on web)
- **Supabase JS 2** — auth, Postgres + RLS, Storage (`projects` + `projects-pending` buckets), Realtime, Edge Functions
- **pdf.js 5** for in-app PDF preview (`pdfjs-dist`), **html2canvas** for the Report-a-Problem screenshot capture
- **react-markdown + remark-gfm** for rendered release notes
- **update-electron-app** → `update.electronjs.org` feed for packaged auto-updates

## High-level architecture

`forge.config.js` runs three Vite configs (main, preload, renderer). The Vite plugin injects `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME` globals into the main process — `src/main.js` reads them to decide dev-server vs file-loaded bundle.

`src/renderer.jsx` is the Electron entry; `src/web.jsx` is the web entry. They mount the same `<App />` but differ in router type, basename, and which platform shims load. The provider stack (renderer.jsx) is:

```
MemoryRouter
  AuthProvider
    ThemeProvider           — needs auth (per-user theme key); outermost so
                              data-theme is on <html> before first paint
    SelectedProjectProvider — per-user storage; auto-clears on access loss
      UpdatesProvider
        NotificationsProvider — source hooks need auth + updates
          UploadsProvider     — uses notify() for error toasts
            BranchProvider    — needs ProjectProvider via the route subtree;
                                exposes per-project branch state + RPCs
              <App />
          <NotificationCenter />  — sits above UploadModal z-index
```

### Routing

`src/App.jsx`. All page modules are `React.lazy`-imported. Layout:

- `/auth` — full-screen, no shell.
- `/` — wraps everything in `AppShell` (sidebar + main).
  - Public: `/`, `/updates`, `/notifications`, `/invite/:token` (invite-accept must render before sign-in so it can stash the token).
  - `ProtectedRoute`: `/account`, all `/projects/*`, project-scoped tools (`/files`, `/clients`, `/todos`, `/chat`, `/generate`, `/automate`).
  - `/projects/:projectId` wraps the subtree in `ProjectProvider` (`<ProjectShell>`), so Overview + Dashboard share one fetch and one Realtime channel.

`ProjectAutoSelect` (in App.jsx) mirrors `useProject().project.id` into `SelectedProjectContext` only when on `/projects/:id/dashboard`, with two guarded races: (1) user just deselected (`prev && !selectedProjectId`), (2) project context is mid-fetch (`projectLoading`).

### Main ↔ Renderer IPC contract

`src/preload.js` is the only bridge — exposes `window.electronAPI` via `contextBridge`. Adding any main capability requires editing both files.

- **OAuth / deep-links:** `oauth:open-external` (send), `oauth:callback-url` (receive); `app:get-startup-deep-link` (one-shot pull of a `docvex://` URL captured from `process.argv` at cold start).
- **Updates:** `app:get-version`, `app:is-packaged`, `update:check`, `update:install`, `update:status` (main → renderer lifecycle events).
- **Dev menus:** `account:switch-to` (dev-only Account menu), `debug:clear-cache`, `debug:send-test-notifications`, `debug:send-email-previews`.
- **External URLs:** `app:open-external` is filtered to `http(s)` only — preserve that filter when adding sibling channels.
- **Local folder (Files page):** `local-folder:pick / list / download / write-files / delete-files / rename-file / open-path / show-in-folder / watch / unwatch / changed / read-sidecar / write-sidecar`. The watcher is debounced 200 ms; only the active folder is watched.

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

Registered with privileges `standard | secure | supportFetchAPI | stream | bypassCSP | corsEnabled` so `<img src>`, `<video src>`, AND `fetch()` from the Vite dev origin all work. The renderer URL-encodes the full path as one segment; `protocol.handle('localfile', …)` decodes it, streams via `fs.createReadStream` wrapped in a `Response` (so `<video>` byte-range works without buffering whole videos in memory).

### Auto-update pipeline

Two layers running in parallel — don't confuse them:

1. **`update-electron-app` in `src/main.js`** (packaged builds only) — polls `update.electronjs.org` every 10 min, which reads GitHub Releases for `petreluca1105-dotcom/docvex`. Squirrel.Windows downloads in background, installs on next launch.
2. **`UpdatesContext` in renderer** — fetches `https://api.github.com/repos/petreluca1105-dotcom/docvex/releases` (cached in `sessionStorage` under `docvex:releases-cache:v1`, 1 h TTL) and subscribes to `update:status` events from main. Drives the sidebar badge + the Updates page banner.

Layer 1 is the source of truth for "is an installer actually downloaded and ready to apply?" → fires `update-downloaded` → `update:status { state: 'downloaded' }` → renderer shows "Restart & install". Layer 2 is what shows release notes and the version-mismatch indicator. Works in dev too (no Squirrel needed). Web returns `state: 'web'`.

Semver compare is a tiny inline `semverGT()` in `UpdatesContext.jsx` — handles `major.minor.patch` only, strips `v` prefix and pre-release suffix.

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

All under `src/context/`. Every hook returns plain objects; no Redux / Zustand. Persistence keys all share the `docvex.*` prefix.

| Context | Exported shape (via `useXxx()`) | Persistence |
| --- | --- | --- |
| **AuthContext** | `{ session, loading, lastAuthEvent, signInWithEmail, signUpWithEmail, signInWithGoogle, linkGoogle, signOut, eraseData, deleteAccount }` | Supabase-js native (`sb-*` keys); `lastAuthEvent.at` timestamps repeated events so downstream effects can distinguish back-to-back TOKEN_REFRESHED firings. |
| **ThemeContext** | `{ theme, setTheme, themes: [{ id, label, description, swatchOrder }] }` | `docvex.theme.<userId|_anonymous>` |
| **SelectedProjectContext** | `{ selectedProjectId, selectedProject, loading, selectProject(id, prefetched?), clearSelection, patchSelectedProject(patch), pickerOpen, openPicker, closePicker, togglePicker, switching, switchingToName, beginSwitch(name) }` | `docvex.selectedProject.<userId>` |
| **ProjectContext** (URL-scoped) | `{ project, role, members, customRoles, loading, error, refresh, refreshCustomRoles, removeMemberLocal, setMemberRoleLocal, removeCustomRoleLocal }` | None — Realtime subs + optimistic local mutations |
| **BranchContext** | `{ view, setView, branchState, mainVersion, pendingChanges, overlayByFileId, addedChanges, requests, openOwnRequestItems, isBehindMain, isAdmin, isMember, loading, queueChange, discardChange, discardAll, pushRequest, withdrawRequest, approveRequest, rejectRequest, acknowledgeSync, refreshOpenRequestItems, refresh }` | `docvex:branch-view:<projectId>` (Main / My toggle) |
| **NotificationsContext** | `{ notifications, activeToasts, unreadCount, notify(payload), dismissToast(id), markRead(id), markAllRead, remove(id), clearAll }` | `docvex.notifications.v1.<userId|_anonymous>` (debounced). `HISTORY_CAP = 100`, `MAX_ACTIVE_TOASTS = 3`. |
| **UpdatesContext** | `{ currentVersion, latestVersion, isPackaged, releases, loading, error, hasUpdate, installerState, checkNow, installUpdate }` | `sessionStorage` `docvex:releases-cache:v1` |
| **UploadsContext** | `{ uploads, uploadingCount, overallProgress, beginUpload, cancelAllUploads, dismissUpload, staged, stageFiles, removeStaged, clearStaged, sendStaged, updateStagedName, updateStagedDescription, modalOpen, openModal, closeModal, dragActive, sending }` | None. `MAX_CONCURRENT = 3`, `TERMINAL_DISMISS_MS = 5000`. |
| **ReportProblemContext** | `{ open, capturing, screenshot: { blob, dataUrl } | null, captureAndOpen, close, removeScreenshot }` | None; html2canvas is lazy-imported so the first render doesn't pay the cost. |

**Provider-order constraints** to remember:
- ThemeProvider above everything else that renders so `data-theme` is set before first paint.
- BranchProvider needs `SelectedProjectContext` to know which project's branch state to load.
- UploadsProvider needs `NotificationsContext` for error toasts.
- `NotificationCenter` mounts OUTSIDE `<App />` so its toasts (z 9999) render above the UploadModal dropzone (z 1000).

## Library layer (`src/lib/`)

| File | Purpose |
| --- | --- |
| `supabaseClient.js` | Singleton supabase-js client (PKCE, no auto-detect-in-URL). |
| `projects.js` | Project CRUD + member listings + auth-user profile upsert. |
| `projectFiles.js` | `listProjectFiles`, `deleteProjectFile`, `createSignedDownloadUrl`, `createPendingSignedUrl`, `fetchUploaderProfile`, `subscribeForProject`. Bucket `projects`, table `project_files`, signed-URL cache evicted on delete. |
| `uploadProjectFile.js` | XHR + AbortController orchestration for a single upload. Accepts `prepped` (thumbnail / frames / duration); regenerates inline if absent. |
| `thumbnails.js` | Offline thumbnail + video-frame extraction (canvas, pdf.js, ffmpeg.wasm where applicable). |
| `pdfCache.js` | Module-level cache of parsed pdf.js documents, keyed by content_hash. Evicted from the "Debug → Clear all cached data" menu. |
| `pdfWorker.js` | pdf.js worker entry point used by pdfCache. |
| `branches.js` | Branch + change-request data layer. `computeBranchDiff(localFiles, cloudFiles, sidecar, localHashByName, cloudHashByFileId, openRequestItems)`, `uploadBlobToPending(blob, projectId, changeId, filename, fileId?)`, `pushChangeRequest`, `listChangeRequests`, `getChangeRequest`, `approveChangeRequest`, `rejectChangeRequest`, `listOpenChangeRequestItemsForProject` (batched, replaces the N+1), `subscribeChangeRequestItemsForProject(projectId, cb)` (Realtime with `project_id=eq.${projectId}` filter from migration 018). |
| `localBranchMeta.js` | Per-(project, folder) sidecar. Async file-backed (`.docvex.json` in the folder; see "Sidecar" below). `loadSidecar`, `saveSidecar`, `addEntry`, `removeEntry`, `removeByFilename`, `renameEntry`, `reconcileWithFilesystem` (3 passes: rename detect → cloud-hash bootstrap → mint UUID), `fileIdForFilename`, `entryForFileId`. `LEGACY_SIDECAR_KEY` and `toPayload` exported for the one-time localStorage→file migration. |
| `localFolder.js` | Unified electron/web folder API (`localFolderApi.pick / list / download / writeFiles / deleteFiles / renameFile / openPath / showInFolder / watch / unwatch / onChange / readSidecar / writeSidecar / persistPickedHandle / restorePersistedHandle / reconnectHandle / forgetPersistedHandle`). Web backend uses `showDirectoryPicker`, persists the `FileSystemDirectoryHandle` in IndexedDB (`docvex-fs-handles` / `handles` store, key = projectId), 3 s poll for change detection. `readLocalBlob(pathOrName)` returns a Blob via `localfile://` (Electron) or the cached file handle (web). |
| `notifications.js` | Pure helpers: `NOTIFICATION_CATEGORIES / VARIANTS / PRIORITIES`, `buildNotification`, `resolveDedupeStrategy`, `formatRelativeTime`, `storageKeyForUser`. |
| `notificationsRepo.js` | Supabase IO for the `notifications` table: `fetchRecent`, `insertOne(row, { ignoreDuplicates })` (upsert on `(user_id, dedupe_key)`), `deleteByDedupeKey`, `markRead`, `markAllRead`, `deleteOne`, `deleteAllForUser`, `subscribeForUser`. |
| `customRoles.js` | `listCustomRoles(projectId)`, `subscribeForProjectRoles`. Custom role = base_role + capability overrides joined many→one. |
| `userStatus.js` | User status enum (online / away / dnd / offline) + `getStatusForUser`. |
| `recentProjects.js` | localStorage map of `projectId → lastAccessedAt` per `userId`. `markProjectAccessed`, `getMostRecentProjectId`, `sortProjectsByRecent`. |
| `support.js` | `sendSupportReport({ category, title, body, screenshot? })` — fire-and-forget to `send-support-report` Edge Function. |
| `sendWelcome.js` | Fire-and-forget `send-welcome` Edge Function; no-op when already sent. |
| `plan.js` | `PLAN = { tier: 'Free', features: [...] }` placeholder — read in Account page AND Sidebar footer pill; update both when wiring real plans. |
| `platform.js` | Electron / web adapter: `isElectron`, `getAppVersion`, `isPackaged`, `showInFolder`, `openPath`, `onDeepLink`, `onAccountSwitch`, `openOAuthUrl`, `checkForUpdates`, `installUpdate`, `onUpdateStatus`, `showOSNotification`. Web stubs out anything that can't work in a browser. |

## Supabase data model

Project ID `pntxlvhkqfryyyxlqytr` (eu-west-1, organization `docvex.ro`). Modify via the `claude_ai_Supabase` MCP tools (`list_tables`, `apply_migration`, etc.).

### Tables (current after migration 019)

| Table | Notable columns | Notes |
| --- | --- | --- |
| `projects` | `id, name, description, created_by, created_at, updated_at, main_version int` | `main_version` bumps once per merge; `add_creator_as_owner` trigger inserts owner row. |
| `project_members` | PK `(project_id, user_id)`, `role` enum (`owner / admin / member / viewer`), `custom_role_id?`, `added_at` | RLS via `has_project_role(p_project_id, p_min_role)`. |
| `project_invitations` | `id, project_id, email, role, token unique, invited_by, created_at, expires_at (+7 d), accepted_at?` | Unique index on `(project_id, lower(email))` WHERE `accepted_at IS NULL`. Consumed by the `accept-invite` Edge Function which calls `accept_invitation` RPC. |
| `project_files` | `id, project_id, name, description?, mime_type, size_bytes, storage_path, thumbnail_path?, thumbnail_frames text[]?, duration_seconds?, content_hash?, uploaded_by, uploaded_at` | Index `(project_id, uploaded_at DESC)` covers the file list query. `REPLICA IDENTITY FULL` for Realtime DELETE payloads (migration 006). `content_hash` added migration 014. |
| `project_member_branches` | PK `(project_id, user_id)`, `base_version int, created_at` | Lazy-created on first edit; `base_version` lags `main_version` when the user is behind. |
| `branch_changes` | `id, project_id, user_id, kind (add/edit/delete/replace), target_file_id (CASCADE), proposed jsonb, created_at` | Queue of un-pushed local edits. Cleared on push. |
| `change_requests` | `id, project_id, author_id, title, description, status (open/approved/rejected/withdrawn), submitted_at, decided_at?, decided_by?, decision_note?` | Unique `(project_id, author_id) WHERE status='open'` enforces one open request per author. Index `(project_id, status, submitted_at DESC)`. Visibility widened to all project members in migration 017 (was author + admin). |
| `change_request_items` | `id, request_id (CASCADE), kind, target_file_id?, proposed jsonb, seq int, project_id (denormalised in 018)` | Immutable snapshot at submit time. Index `(request_id, seq)`. Added to the Realtime publication in 018 so the compose view can sub per-project. |
| `custom_roles` | `id, project_id, name, description, base_role` | Each row inherits a base role and adds capability overrides. |
| `role_capabilities` | `id, custom_role_id, capability, enabled` | Per-capability grant / revoke. |
| `notifications` | `id, user_id, category, variant, priority, title, body, icon?, payload jsonb, created_at, read_at?, dedupe_key?` | Unique `(user_id, dedupe_key)`. Index `(user_id, created_at DESC)`. Migration 014 added the notifications trigger for change-request submission; 019 broadened recipients from admins-only to all members (members get `priority='low'`, admins get `priority='normal'` with "to review" framing). |

### RPCs (all SECURITY DEFINER)

| RPC | Signature | Purpose |
| --- | --- | --- |
| `has_project_role` | `(p_project_id uuid, p_min_role project_role) → bool` | STABLE helper used by every RLS policy that needs role checks. |
| `accept_invitation` | `(p_token text, p_user_id uuid) → uuid` | Atomically inserts `project_members` and marks `accepted_at`. |
| `approve_change_request` | `(p_request_id uuid)` | Moves bytes from `projects-pending` to canonical `projects` storage, merges `change_request_items` into `project_files`, bumps `main_version`, marks request approved. Migration 016 disambiguated identifiers; 013 introduced it alongside `reject_change_request`. |
| `reject_change_request` | `(p_request_id uuid, p_note text)` | Sets `status='rejected'`, optional `decision_note`. |
| `get_member_profiles` / `get_member_profiles_status` | `(p_project_id uuid)` | Joins `project_members` with auth user metadata (and user status in the `_status` variant). |

### RLS patterns

- Project-scoped reads/writes call `has_project_role(...)`; deletes typically require `admin` or `owner`.
- Personal rows (`notifications`, `project_member_branches`, `branch_changes`) gate on `user_id = auth.uid()`.
- `change_request_items` denormalises `project_id` so the Realtime filter can be a single `eq` (avoid `requested_by_admin OR …` policies that wouldn't survive a `filter`).
- `accept_invitation`, `approve_change_request`, `delete-user` (Edge Function) all bypass RLS via SECURITY DEFINER.

### Storage buckets

- `projects` — canonical file bytes, path `{project_id}/{file_id}/{filename}`.
- `projects-pending` — in-flight bytes for unapproved change-request items, path `{project_id}/{user_id}/{change_id}/{filename}`. `approve_change_request` moves objects from pending into canonical on merge.

### Edge Functions (`supabase/functions/`)

`accept-invite`, `send-invite`, `revoke-invite`, `send-welcome`, `send-support-report`, `delete-user`. Shared HTML email templates in `_shared/emailTemplates.ts`. Email send uses the project's configured SMTP via Supabase — fire-and-forget from the client.

## Branch / change-request flow

End-to-end for a member editing files:

1. **Local edits.** User adds / renames / replaces files inside the local folder. The FAB on My branch writes bytes via `localFolderApi.writeFiles`; in-place edits done via the OS just modify the bytes.
2. **Sidecar reconciliation.** `reconcileWithFilesystem` runs whenever `localFiles` / `localHashByName` / `cloudHashByFileId` change. Three passes: (1a) rename detection (hash match + old name gone), (1b) cloud-hash bootstrap (only when seeing a folder for the first time without a sidecar), (1c) mint a fresh UUID for brand-new local files. Pass 2 prunes stale entries; pass 3 refreshes hashes for in-place byte edits.
3. **Queue.** Metadata-only operations (rename / description edit / delete) go through `BranchContext.queueChange(...)`, which writes to `branch_changes` and lights up the "Changes made" pill.
4. **Commit modal.** Opens from the "Changes made" pill; lists every diff entry from `computeBranchDiff`. Renames render as `oldName → newName` with the old half dimmed. On submit the modal uploads each add / replace blob to `projects-pending/{projectId}/{userId}/{changeId}/{filename}` via `uploadBlobToPending(blob, projectId, changeId, filename, fileId?)` — the `fileId` ride-along makes `proposed.id` match the sidecar so post-approval `project_files.id` equals the sidecar's id (no re-link needed). `pushChangeRequest` then inserts `change_requests` + immutable `change_request_items` snapshot and clears `branch_changes`.
5. **Review** (Version Control tab on the Project Dashboard). `ChangeRequestsView` renders one file block per `(target_file_id || proposed.name)`; each block lists every author's version as an `AuthorAvatar` chip. Compose by dragging chips into the staged column; right-click a chip opens the morph-menu (Approve / Reject / Open). The "Approve release" FAB calls `approveRequest(requestId)` for every distinct staged `requestId` (current backend approves whole requests at a time; a warning surfaces when partial selection drags in untargeted items).
6. **Merge.** `approve_change_request` RPC streams bytes from `projects-pending` to `projects`, upserts `project_files`, bumps `main_version`. Realtime fires on `change_requests` → BranchContext refreshes; the author's `base_version` auto-bumps if it matched the pre-merge `main_version`.

### Sidecar (`.docvex.json`)

Lives in the picked folder itself. Shape: `{ version: 1, projectId, entries: { [fileId]: { filename, contentHash, mtime } } }`. Survives a `localStorage` clear, ships to teammates via Dropbox / iCloud, re-attaches without a bootstrap window when the user re-picks the folder. The in-memory representation is `{ projectId, localFolder, byFileId: Map<id, entry>, byFilename: Map<lowercase-name, id> }`.

**Legacy migration.** The first time `loadSidecar` returns empty for a folder, `ProjectFiles.jsx` reads the old `docvex:branch-meta:${projectId}:${localFolder}` localStorage entry (`LEGACY_SIDECAR_KEY` export), hydrates an in-memory sidecar, writes `.docvex.json` via `writeSidecar`, and `localStorage.removeItem`s the legacy key. Existing users keep their mapping seamlessly.

### Branch status pills (Main tab)

- **Change requests** (`.is-requests`) — count of open requests; clicking opens the Version Control tab.
- **Delete all files** (`.is-danger`) — admin-only destructive escape hatch; loops `deleteProjectFile` over every cloud row after a `window.confirm`.

### Branch status pills (My tab)

Four signals, only active ones render:

- **New update on main** (`.is-update`, animated 5 s shimmer + pulsing dot) — `base_version < main_version`; clicking opens `SyncToMainModal`.
- **Changes made** (`.is-changes`) — local edits or queued metadata changes; clicking opens `CommitChangesModal`.
- **Awaiting review** (`.is-requests`) — pushed already, request is still open. Without this signal the chip would falsely fall to "Synced" between push and approval.
- **Synced with main** (`.is-synced`) — calm steady-state.

All chips use the **5-stop animated gradient** pattern from `.updates-banner-uptodate`: `border-radius: 10px`, `border: 1px solid color-mix(... 40%, transparent)`, `background: linear-gradient(120deg, 5%/16%/18%/16%/5%)`, `background-size: 300% 100%`, 8 s pan keyframe. The dot has a 6 px halo; `.is-update` runs a 1.6 s `branch-status-pulse` keyframe additionally. Two-line content (title + sub) is laid out with `flex-direction: column` inside `.project-files-branch-status-text`.

### Modified pill / open-request derivation

The per-card "Modified" pill is **derived from `branchDiff`** (`diffReplaceCloudIds` memo) so it shares the same filter as the status chip — open-request items soft-held for 4 s post-approval via `lastOpenItemsRef`, then the chip + per-card pill both clear together. Earlier the per-card pill recomputed `bytesDiffer` independently and stayed lit after a push.

`openRequestDeleteIds` suppresses "missing — download" cards for files whose deletion is queued: rendering one would invite the user to re-create the file their pending request is removing.

### Filename fallback for the bootstrap window

The missing-detection loop in `ProjectFiles.jsx` first consults the sidecar; if the sidecar hasn't linked a cloud row yet (e.g. just after a fresh download / folder repick, while the async hasher is still catching up), it falls back to matching the cloud's display name **and** the storage_path's last segment against local filenames. This is the only place filename matching is allowed — the actual sidecar / diff logic stays purely ID-based.

## Notification system

Three layers:

1. **Source hooks** (`src/notifications/sources/use*NotificationSource.js`)
   - `useAuthNotificationSource(notify, { ready })` — SIGNED_IN welcome, SIGNED_OUT goodbye.
   - `useUpdateNotificationSource(notify, { ready })` — installer state transitions (downloading / downloaded / restart).
   - `useSocialNotificationSource(notify, userId, { ready })` — placeholder hook for future @-mentions / DMs.
2. **Context** — `notify(payload)` accepts `{ category, variant, title, body, icon?, priority?, duration?, persistent?, dedupeKey?, osLevel? }`. Resolves dedupe strategy (`coalesce` / `replace` / `insert`), enforces the 3-toast cap, mirrors writes to Supabase + localStorage. Returns the notification id (existing id on coalesce).
3. **Action registry** (`src/notifications/actionRegistry.js`) — maps notification types to icons / actions / titles for the history view + test menu.

UI: `NotificationToast` auto-dismisses after `duration` (5 s default; `persistent: true` opts out), `NotificationCenter` is both the floating toast stack AND the `/notifications` page with category / priority filters. Icons live in `src/notifications/icons.jsx`; the dev "Send all test notifications" menu fires every entry in `src/notifications/testNotifications.js` so devs can see every category × priority × icon combo without triggering live actions.

**Realtime flow.** notify() mutates local state immediately, then asyncly mirrors to Supabase + localStorage. Realtime INSERT events from other devices dedupe by `id` (no re-toast). UPDATEs sync `read_at` across devices; DELETEs remove rows.

## Pages

### Root pages (`src/pages/`)

| Page | Purpose |
| --- | --- |
| `Dashboard` | Signed-in landing — currently a status display. |
| `Account` | Profile, link Google, plan info (reads `lib/plan.js`), `eraseData` and `deleteAccount` actions. |
| `Updates` | Release history, current vs latest, "Check now", installer state badge. |
| `Notifications` | Full-page history with filter tabs + mark-read / clear. |

### Project-scoped (`src/pages/Projects/`, under `/projects/:projectId`)

| Page | Purpose |
| --- | --- |
| `ProjectList` | All projects + recent (sorted via `recentProjects.js`), member counts, "+ New project" CTA. |
| `ProjectCreate` | New-project form. |
| `ProjectOverview` | Settings (rename / description), Members tab, Custom-role editor (`RoleCapabilityMatrix` + `CustomRoleEditor`). |
| `ProjectDashboard` | Tabbed: **Files** (embeds the relevant ProjectFiles surface), **Version control** (`ChangeRequestsView`), to-dos and other future tabs. Tab persistence via `useSearchParams ?tab=`. Title has a description line; the role pill was removed. |
| `ProjectFiles` | Main + My-branch surfaces of the file grid (drag-to-upload, branch toggle, status pills, commit modal, sidecar reconciliation, local folder picker / web Reconnect). The bulk of the branching UX lives here. |
| `ProjectChat / ProjectGenerate / ProjectAutomate / ProjectClients` | Stubs for future features. |
| `ProjectTodos` | To-do list stub. |
| `TeamTree` | Org-chart view of project members + roles. |
| `InviteAccept` | Token-driven invite acceptance; public so unauthenticated invitees can land here and bounce through `/auth`. |

Shared layout: `ProjectScoped.css` provides the standard project page frame (sticky header, content container).

## Component patterns

All components live in `src/components/` with a sibling `.css` file.

### Modals

`ConfirmModal` is the base shape (title / body / confirm + cancel). Domain modals (`DeleteProjectModal`, `DeleteAccountModal`, `InviteMemberModal`, `ChangeMemberRoleModal`, `RemoveMemberModal`, `ReportProblemModal`, `CommitChangesModal`, `SyncToMainModal`, `ResetBranchModal`, `FileDetailModal`, `UploadModal`) follow the same z-index conventions and overlay scrim (`var(--overlay-scrim)`). The morph-menu portal renders at `z 2000`; toasts at `z 9999` so they pop over any modal.

### Role gating

`RoleGate` renders children only when the user's role meets `minRole` (integer rank: viewer 0 → owner 3).
`RoleLocked` is the alternative pattern requested in user feedback: keep the feature rendered for everyone and overlay a "[role] only" mask for users who lack the role, so the layout is consistent and discoverable rather than disappearing.
`RoleBadge` is a coloured pill of the role name. `CustomRoleEditor` + `RoleCapabilityMatrix` drive the custom-role configuration in ProjectOverview.

### Tooltip + morph-pill

`Tooltip` is a cursor-following pill — fixed-position, `transform: translate(x, y)` updated on `mousemove`, animated via `transition: transform 90ms ease-out` (re-targets per move, no queue). Trigger wrapper uses `display: contents` so it doesn't add a layout box.

**Morph-pill FLIP recipe.** Used in two surfaces (LocalFileCard in ProjectFiles, AvatarMorphPill in ChangeRequestsView). Same DOM node serves as hover tooltip and right-click menu; the menu state adds an `.is-menu` modifier and a FLIP animation morphs between sizes. The CSS `transition: transform` is intentionally suppressed (`.is-menu { transition: none; }`) so the JS-set inline `transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1)` can drive the morph without racing.

Recipe per right-click:
1. Snapshot the pre-menu rect (`oldPillRectRef = pillRef.current.getBoundingClientRect()`).
2. Toggle `menuMode = true`; React commits the larger menu layout.
3. `useLayoutEffect`: compute `sx = oldRect.width / newRect.width`, `sy = oldRect.height / newRect.height`. Snap `translate(x, y) scale(sx, sy)` with no transition. Force reflow.
4. Add `transition: transform 220ms`; set `translate(x, y) scale(1, 1)` — GPU-composable.

Dismissal: Escape, scroll (capture), outside `mousedown`, or mouseleave on the menu when `pointer-events: auto` is in effect.

### Branching components

- **BranchToggle** — segmented Main / My switch with the pending-count badge on My and the behind-main dot on Main.
- **ChangeRequestsView** — compose-release surface with the file-block layout and the morph menu described above. Files sorted by display name; partial-request warning rendered in the stage footer; "Approve release" is a fixed-position FAB at bottom-right of the viewport.
- **CommitChangesModal** — diff list with renames rendered `old → new`; threads `fileId` into `uploadBlobToPending`; receives `sidecar` prop.
- **SyncToMainModal** — `onSyncComplete` returns `{ syncedHashes, deletedNames, syncedFileIds: Map<filename, cloudId> }` so the parent populates the sidecar without waiting for the next reconcile pass.
- **ResetBranchModal** — confirm discard-all-pending.

### Status + theme

- **StatusBadge / StatusPicker** — user status enum (`online / away / dnd / offline`).
- **ThemePicker** — mock cards painted via `[data-theme="…"]` on each card so they preview in their own theme regardless of the app's active theme.

### Layout

- **AppShell** — wraps Sidebar + content; mounts the global ReportProblem + Upload modals.
- **Sidebar** — 60 px collapsed, 220 px expanded on `:hover` / `.locked`. `.label` elements fade via opacity. Anything interactive that should respond when expanded needs `pointer-events: auto` in the `:hover` / `.locked` rule (see `.lock-btn`). Auth-aware footer swaps between Account NavLink + avatar / username / tier and a "Sign in" CTA.
- **ProjectPickerPanel** — sliding drawer of all projects (sorted by recency), triggered from the sidebar.
- **ProjectBanner** — small **fixed-position pill** at top-centre of the viewport ("Working in <project>"), border-radius 999 px, shadow `0 8px 24px rgba(0,0,0,0.32)`. Not in-flow — `.project-page-frame` resets its `margin-top` accordingly.

### File previews

`FileThumbnail` resolves the right poster URL for the surface (cloud `thumbnail_path` signed, falling back to `thumbnail_pending_path` on pending bucket, or the MIME glyph). `FilePreview` is the full-content renderer (PDF via pdf.js, image, video, text). `FileDetailModal` reuses both for its inspector view (the Version Control surface mounts it with `readOnly` so admin clicks on a chip open the same modal the Files page uses for a row).

## Conventions

- **Styling:** plain CSS files alongside components (`Foo.jsx` + `Foo.css`); zero CSS-in-JS / Tailwind. Use only `var(--…)` from `tokens.css`. Adding a hard-coded hex is a smell — there's a semantic token for almost everything.
- **SVG icons:** inline JSX constants at the top of the file that uses them — no icon library. Stroke icons use `currentColor` so they inherit hover / active states.
- **`display: contents` wrappers** for synthetic event hosts that shouldn't add a layout box (Tooltip's `.tooltip-trigger-wrap`, ChangeRequestsView's `.cr-morph-wrap`).
- **5-stop animated gradient pill** (`.updates-banner-uptodate`, all `.project-files-branch-status-item` variants, `.cr-stage-header-text`): `linear-gradient(120deg, 5% / 16% / 18% / 16% / 5%)`, `background-size: 300% 100%`, 8 s `branch-status-shimmer` keyframe; centred dot with `box-shadow: 0 0 0 6px ...` halo. Reusing this shape keeps "status pill" semantically consistent across the app.
- **Auth-derived display:** display name resolution is `user_metadata.full_name || user_metadata.name || user.email`. Avatar is `user_metadata.avatar_url` (Google) with a deterministic first-letter circle fallback (palette of 12 colours, djb2 hash on the id). Helper is duplicated in `Account.jsx`, `Sidebar.jsx`, and `ChangeRequestsView.jsx`'s `AuthorAvatar` — keep them in sync if you change one.
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
- **Google Cloud Console:** OAuth consent screen must be User Type **External** (Internal blocks `@gmail.com` testers with `org_internal` 403). Authorized redirect URI = `https://pntxlvhkqfryyyxlqytr.supabase.co/auth/v1/callback`.
- **GitHub:** `GITHUB_TOKEN` (PAT, `public_repo` scope) required for `npm run publish` — set via `[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", ..., "User")` or per-session `$env:GITHUB_TOKEN = ...`. VSCode integrated terminals cache env vars from launch; restart the whole VSCode window after setting persistently.

## Scripts (`scripts/`)

| Script | Purpose |
| --- | --- |
| `sync-readme-version.mjs` | Bumps the version string in README.md to match package.json. Runs in the `version` lifecycle. |
| `web-deploy.mjs` | Copies `dist-web/` → `docs/app/`, renames `index.web.html` → `index.html`, writes `404.html` SPA fallback for GitHub Pages. Also runs in `version`. |
| `post-release.mjs` | Runs after `npm version`: `git push --follow-tags`, `electron-forge publish`, `generate-release-notes.mjs`. |
| `generate-release-notes.mjs` | Summarises commits since the previous tag via the `claude` CLI and PATCHes the draft GitHub release body. Best-effort, never fails the release. |

## Release notes style (user preference)

Four sections (`Added` / `Changed` / `Removed` / `Misc`), no emojis, plain English understandable to non-programmers. This overrides the auto-generator's default format — adjust the prompt in `generate-release-notes.mjs` if the template drifts.

## Product & business context

Reference docs live at `C:\Users\Luca\Desktop\docvex\`:

- `Docvex_AI.pdf` — product vision and feature spec
- `text1.txt`, `text2.txt` — business strategy and target market notes (Romanian)
- WhatsApp images — logo variants and brand direction

Read these when reasoning about features, product decisions, positioning, or anything related to "why" we're building something. Code lives in this repo; "why" lives in that folder.
