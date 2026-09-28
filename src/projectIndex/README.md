# Project data — the contract

How DocVex stores and loads a project's files and everything it knows about
them. Desktop only (the web build was removed). This file is the contract the
main process (`src/projectIndex/*`, `src/main.js`, `src/preload.js`) and the
renderer (`src/lib/projectIndexClient.js` and its callers) are both written
against — change it here first.

## Why

Opening a project used to walk the whole folder tree (a `stat` per file),
send the entire list over IPC, and re-walk the whole tree on every watcher
event. What the app knew about files (AI data, metadata, OCR, captions…) sat in
`localStorage`: synchronous, ~10 MB for ALL projects together (oldest silently
evicted), and on one machine only. File identity needed a `.docvex.json`
sidecar in every folder.

Now: a project is opened from a small **project file**; its listing comes from
a **machine-local SQLite index** at once (no disk walk before the first paint);
the disk is reconciled in the BACKGROUND and only the **differences** reach the
window; knowledge about files lives in the index and, portably, in small files
under **`.docvex/`** beside the documents.

## On disk

```
<case folder>/
  <Project name>.docvex        the PROJECT FILE (entry point, double-click opens)
  .docvex/
    ids.json                   portable file ids   (replaces every .docvex.json sidecar)
    knowledge/<ab>/<sha256>.json   what the app knows about ONE file content
    settings/<store>.json      project-level stores (scan tags, folder colours, timeline, web index…)
  …the documents, as ordinary files…
<userData>/project-index/
  registry.json                { [projectId]: { dir, projectFile, name, lastOpened } }
  <projectId>.db               the machine index (SQLite, WAL) — a CACHE, rebuildable
  _loose.db                    knowledge about files that belong to no project
```

### The project file — `<Project name>.docvex`

```json
{ "type": "docvex/project", "version": 1, "projectId": "<uuid>", "name": "…", "createdAt": "ISO" }
```

- Written the first time a project is linked to a folder (`projectOpen` with a
  `dir`), or found there. A folder holds ONE project file; a second one naming a
  different project is an error (`project_mismatch`).
- Registered with the OS: `.docvex` → "DocVex project", open = the app with the
  path. Windows: HKCU\Software\Classes (written once per install, stamped like the
  Open-with verb). macOS: `CFBundleDocumentTypes` in forge.config's `extendInfo`.
- Opening one (double-click, `second-instance` argv, macOS `open-file`, cold
  start argv) → main registers `{ projectId: dir }` and sends
  `project:opened { projectId, dir, name }` to the main window, which selects
  that project (if the signed-in user can see it) and shows Files.

### `.docvex/ids.json` — portable file ids

`{ "v": 1, "files": { "<uuid>": { "rel": "a/b.docx", "size": 123, "mtimeMs": 1, "hash": "sha256|null", "at": 1 } } }`

- A file's portable `id` (a uuid) is what other records reference (chat
  attachments, timelines). It must survive rename, move, edit and another
  machine opening the same folder.
- Maintained by main. Locally, renames/moves are recognised by the MACHINE file
  id (`fs.stat(p, { bigint: true }).ino` — NTFS keeps it across rename, move and
  edit; a copy gets a new one); the entry's `rel` is updated. On another machine
  (different inos), an unknown file is matched by `rel + size + mtimeMs`, then
  by `hash`; else it gets a new uuid.
- On first open, legacy `.docvex.json` sidecars are IMPORTED (their ids kept —
  Supabase rows reference them) and then deleted.
- Sync conflict copies (`ids-<anything>.json` / `ids (1).json`) are merged
  (union by uuid, newest `at` wins) and removed.

### `.docvex/knowledge/<ab>/<sha256>.json` — portable knowledge

`{ "v": 1, "name": "last known file name", "facets": { "<kind>": Facet } }`,
keyed by the file CONTENT's sha256 (`ab` = its first two hex chars). Content
keying is deliberate: it survives rename / move / copy / another machine, and an
EDIT changes the hash — which is exactly when derived knowledge goes stale.

`Facet = { kind, at (ms), engine, paid (bool), data }`.

- Facet kinds marked LOCAL (none today; a facet may carry `local: true`) are
  NEVER written to `.docvex/`; they live only in the machine index.
- RETIRED kinds (`faces` — the removed face matching's biometric descriptors)
  are refused on put, skipped on shard import and deleted from every index on
  open (`IndexDb.purgeRetired`, then VACUUM).
- Conflict copies of a shard (`<sha256>*.json`) are merged per facet (newest
  `at` wins) on read, rewritten, and the copies removed.

### `.docvex/settings/<store>.json`

`{ "v": 1, "at": ms, "value": <any JSON> }` — one small file per store so two
people rarely touch the same file. Last write wins by `at`.

### The machine index — `<projectId>.db` (node:sqlite, WAL)

```sql
files(fid TEXT PRIMARY KEY,     -- machine file id (ino, as a decimal string)
      id TEXT,                  -- portable uuid (ids.json)
      rel TEXT UNIQUE,          -- posix path relative to the project folder
      name TEXT, dir TEXT, ext TEXT,
      size INTEGER, mtime INTEGER, hash TEXT,  -- hash valid for (size, mtime) only
      seen INTEGER)
dirs(rel TEXT PRIMARY KEY, name TEXT, parent TEXT)
knowledge(hash TEXT, kind TEXT, facet TEXT, local INTEGER, PRIMARY KEY(hash, kind))
settings(store TEXT PRIMARY KEY, value TEXT, at INTEGER)
private(user TEXT, key TEXT, value TEXT, at INTEGER, PRIMARY KEY(user, key))
meta(key TEXT PRIMARY KEY, value TEXT)
```

It is a CACHE of the folder + `.docvex/`: deleting it costs one background
rescan. `private` is the exception — per-user data that must not travel with
the case folder (the Doc Viewer's advisor threads, the Advisor's chats). It is
machine-local; the account sync's PRIVATE bundle still carries it between the
user's own devices.

## What gets indexed

Exactly what `local-folder:list-recursive` lists today (same filters — see
`walkLocalDir` in main.js): no dotfiles / dot-dirs (`.docvex`, `.docvex-trash`,
`.docvex-incoming`, `*.part`, legacy `.docvex.json`), no `Thumbs.db` /
`desktop.ini`. The index keeps them out; nothing else changes.

## Loading, reconciling, watching

1. `projectOpen` → index opened, rows available at once.
2. Reconcile runs in the background right after (and on demand): a walk of the
   folder, `stat` with `bigint`, compared to the index — changed (size / mtime),
   added, removed, renamed / moved (same `fid`, new `rel`). It yields between
   directories so main stays responsive. (Folder modified dates are NOT used —
   verified on Windows: adding a file does not change its folder's date.)
3. While a project is open, a recursive `fs.watch` on its folder reports the
   relative path of each change; after a ~150 ms debounce only those paths are
   `stat`ed and applied. A null filename (buffer overflow) → full reconcile.
4. Every change to the index is broadcast as ONE `project:delta` to every
   window. Windows never re-list.
5. Hashes are computed lazily (streamed sha256, in main): when knowledge is read
   or written for a file, or when account sync needs them — never on the open path.

## IPC — `window.electronAPI.*` (preload) → main

Paths are ABSOLUTE unless called `rel`. A `Row` is a SUPERSET of today's
`local-folder:list-recursive` file entry (so existing consumers keep working):

`Row = { ...listRecursiveEntry, id, fid, rel, dir, ext, mtimeMs }`

| Call | Returns |
| --- | --- |
| `projectOpen({ projectId, name?, dir? })` | `{ ok, dir, projectFile, rev }` or `{ ok: false, error: 'not_found' \| 'project_mismatch' \| … }`. With `dir`: link (write / validate the project file, register). Without: from the registry. |
| `projectLocate(projectId)` | `{ dir, projectFile }` or `{ dir: null }` |
| `projectFiles({ projectId })` | `{ ok, dir, rev, files: Row[], dirs: string[] (rel), reconciling }` — from the index, no disk access |
| `projectReconcile({ projectId })` | resolves when a background rescan has finished: `{ ok, changed }` |
| `projectFileId({ path })` | `{ id }` (portable) |
| `projectPathForId({ projectId, id })` | `{ path }` or `{ path: null }` |
| `knowledgeGet({ path, kinds? })` | `{ ok, facets: { [kind]: Facet } }` — only facets for the file's CURRENT content |
| `knowledgePut({ path, kind, facet })` | `{ ok }` — main hashes the file, writes the index and (unless the kind is local) the shard |
| `knowledgeClear({ path, kind })` | `{ ok }` |
| `knowledgeList({ projectId, kinds? })` | `{ items: [{ path, rel, id, facets }] }` — project-wide |
| `settingsGet({ projectId, store })` / `settingsPut({ projectId, store, value })` | `{ value }` / `{ ok }` |
| `privateGet({ projectId, userId, key })` / `privatePut({ projectId, userId, key, value })` / `privateList({ projectId, userId, prefix })` | the machine-local per-user store |

Events (main → every window), subscribed through preload `onX(cb) → unsubscribe`:

| Event | Payload |
| --- | --- |
| `project:delta` | `{ projectId, rev, upserted: Row[], removed: string[] (rel), dirsAdded: string[], dirsRemoved: string[], reconciled?: true }` |
| `project:opened` | `{ projectId, dir, name }` — a project file was opened from the OS |
| `knowledge:changed` | `{ path, kind, projectId }` |
| `settings:changed` | `{ projectId, store }` |

A path that belongs to no open / registered project uses `_loose.db` for
knowledge and private data (no `.docvex/` shards).

## Renderer

`src/lib/projectIndexClient.js` wraps the IPC. Stores that are read
SYNCHRONOUSLY today (`getAiFacet`, metadata, captions…) keep their signatures:
the client HYDRATES an in-memory copy per project (`hydrateProject(projectId)`,
awaited when a project / a Doc Viewer file opens; `hydratePath(path)` for a
single file) and serves reads from it; writes update memory at once and go to
main in the background; `knowledge:changed` keeps every window's copy current.

Existing `localStorage` data is MIGRATED once per project on first open (every
key that belongs to a file inside the folder goes through `knowledgePut` /
`settingsPut` / `privatePut`), then those keys are removed to free the quota.

## Sync

`.docvex/` is ordinary small files, so it travels TWO ways:
- with the case folder through OneDrive / Dropbox / a network share, and
- through DocVex's account sync (`lib/projectSync.js` includes the project file,
  `.docvex/ids.json`, `.docvex/knowledge/**` and `.docvex/settings/**`; never the
  machine index). The stores that now live in `.docvex/` leave
  `lib/projectSyncData.js`'s shared bundle; the PRIVATE bundle stays.

## Main-process notes (as built)

Modules: `walk.js` (the listing's filters, shared with main.js's
`local-folder:list*`), `atomic.js` (temp + rename writes), `db.js` (`IndexDb`,
`Registry`), `projectFile.js`, `ids.js` (`IdStore`), `knowledge.js` (hashing,
shards), `project.js` (one open project: reconcile + watcher), `index.js`
(`createProjectIndexService` — what main.js wires to IPC; no Electron import).
Tests: `npm run test:index` (runs `tests/projectIndex/` under Electron's Node,
which has node:sqlite).

IPC channels behind the preload names: `project:open`, `project:locate`,
`project:files`, `project:reconcile`, `project:file-id`,
`project:path-for-id`, `knowledge:get|put|clear|list`, `settings:get|put`,
`private:get|put|list`. `onProjectOpened` also sends `project:opened-ready`
— main holds `project:opened` events until the MAIN window has subscribed.

Where the build goes beyond, or differs from, the text above:

- **Id matching** for a file the index has never seen: after `rel + size +
  mtimeMs` and `hash`, a third step — the same `rel` alone, if no file on this
  machine holds that id — so a document edited on another machine keeps its id.
  The hash step only hashes the new file when ids.json has an unclaimed entry
  with a hash and the same size. Also: a new inode at a path whose previous
  inode is gone (an atomic save — Word writes a temp file and renames it over
  the original) keeps the old row's id, and a dropped row's id is remembered
  for 15 s by inode so a move reported in two watcher batches stays one file.
- A dropped row's ids.json entry is removed only while it still names that
  path (another machine may have recorded the file elsewhere since).
- The project file itself (`<name>.docvex`) IS a listed row — it is an
  ordinary non-dot file, and the contract says the index lists exactly what
  `list-recursive` lists. Hide it in the renderer if it shouldn't show.
- Legacy sidecars naming a DIFFERENT project are neither imported nor deleted.
  main.js's `local-folder:project-dir` now reads a folder's project file
  before its `.docvex.json` (which this layer deletes after importing).
- A stored facet keeps any extra fields the caller put on it (e.g. `stamp`);
  `local: true` on a facet makes it index-only like the LOCAL kinds.
- Settings and private calls with a `projectId` not registered on this
  machine use `_loose.db` (keys namespaced by that id); `settingsGet` and
  `privateGet` also return `at`. `privatePut` with `value: undefined`
  deletes the key. `projectFileId` for a path in no project returns
  `{ id: null }`.
- Watchers: projects opened this session stay watched, at most 4 (LRU). The
  watcher also follows `.docvex/`: a settings file or knowledge shard changed
  by a sync client is folded into the index and announced
  (`settings:changed` / `knowledge:changed`); our own writes are ignored.
- A reconcile of a folder that no longer exists changes nothing (`{ ok:false,
  error:'not_found' }`) rather than emptying the index.
