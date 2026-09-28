import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotify } from '../../context/NotificationsContext';
import { useAuth } from '../../context/AuthContext';
import FilesWorkspace from '../../components/FilesWorkspace';
import { useUndoRedo } from '../../components/useUndoRedo';
import { describeLocalFile } from '../../lib/thumbnailDescriptor';
import {
  localFolderApi,
  hasLocalFolderApi,
  isElectronBranch,
  readLocalBlob,
  hasProjectIndex,
  projectIndexApi,
  linkProjectFolder,
  legacyProjectDir,
} from '../../lib/localFolder';
import { openDocx, isDocxFile, openFileWindow, canViewInBrowser, openDocViewerWindow, prepareWhatsAppZip, prepareWhatsAppFolder, detectWhatsApp, notifyFilesRemoved, onFilesRemoved, onFilesChanged, pathForFile } from '../../lib/platform';
import { livePartnerOf, isLivpName, unpackLivp } from '../../lib/livePhoto';
import { openDocxInWindow } from '../../lib/openDocxWindow';
import { emptyDocumentBlob, docKindFromName, mimeForKind } from '../../lib/documentGen';
import { clearConversation, migrateConversation, migrateConversationsUnder } from '../../lib/conversationHistory';
import { readProjectsDir } from '../../lib/projectsDir';
import {
  applyOpsToListing,
  applyOpsToAll,
  applyOpsToTrash,
  pendingPaths,
  normPath,
  samePath as sameOpPath,
  baseName,
  parentOf,
  joinPath,
} from '../../lib/optimisticFiles';
// Data collections (`.dvc`) — the AI scan's output. The scanner itself
// (lib/dataCollections: OCR, captions, face matching) is imported on press.
const isCollectionFile = (name) => /\.dvc$/i.test(String(name || '').trim());
import { loadScanTags, setScanTags, isScanTagged, subscribeScanTags, relInProject as scanRel } from '../../lib/scanTags';
import { loadFileGroups, subscribeFileGroups, addFileGroups, addToFileGroup, renameFileGroup, removeFileGroup, removeFromFileGroup, findSamePairs, proposeGroups, clustersOf, SAME_KINDS } from '../../lib/fileGroups';
import { sha256Of, dhashOf, hamming, shingles, likeness } from '../../lib/fileSimilarity';
import { getPrefetchedProjectFiles } from '../../lib/projectFilesPrefetch';
import { prefetchMetadata } from '../../lib/metadataPrefetch';
import { extractTextOnImport } from '../../lib/autoExtract';
import PhoneUploadModal from '../../components/PhoneUploadModal';
import { subscribeIncoming, decideIncoming, fmtBytes as fmtIncomingBytes } from '../../lib/phoneUploadIncoming';
import { useScanState, setScanState, requestScanStop, scanStopRequested, clearScanStop, finishScan, isScanRunning } from '../../lib/scanRunner';
import './ProjectScoped.css';
import './ProjectFiles.css';

import { hasExtractedText, subscribeAiData, bestTextFor, getAiFacet } from '../../lib/aiData';
import { loadCaptions } from '../../lib/captionsHistory';
import { subscribeIndex } from '../../lib/projectIndexClient';

// Which files can HAVE extracted text: a picture's or a scan's text (the AI
// data store), a recording's captions. Recordings over this size are left out
// of the check (it hashes the file the first time).
const TEXT_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|pdf)$/i;
const MEDIA_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|wma|weba|aif|aiff|mp4|mov|avi|mkv|webm|m4v|3gp)$/i;

// Recently-deleted retention window (mirrors the Electron main sweep).
const TRASH_RETENTION_DAYS = 30;


// ── Small formatting helpers ──────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Masthead-kicker formatters — mirror ProjectOverview's hero so the Files
// masthead reads identically (KB / MB / GB; thousands-separated counts).
function fmtBytesFull(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function fmtCount(n) {
  return (Number(n) || 0).toLocaleString();
}

function splitNameAndExtension(name) {
  if (!name) return { base: '', ext: '' };
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return { base: name, ext: '' };
  const ext = name.slice(lastDot + 1);
  if (ext.length > 8) return { base: name, ext: '' };
  return { base: name.slice(0, lastDot), ext };
}
const fileExtOf = (name) => (splitNameAndExtension(name).ext || '').toLowerCase();

// Compact relative-ish date — "today / yesterday / Nd ago / Mon DD".
function formatDate(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const now = new Date();
  const dayDiff = Math.floor((now - then) / 86400000);
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return `${dayDiff}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Days remaining before a binned file is permanently purged.
function daysUntilPurge(deletedAt) {
  if (!deletedAt) return TRASH_RETENTION_DAYS;
  const age = Math.floor((Date.now() - Date.parse(deletedAt)) / 86400000);
  return Math.max(0, TRASH_RETENTION_DAYS - age);
}

// localfile:// URL for an on-disk path (Electron). Web paths (web://…) have
// no streamable URL, so the thumbnail resolver falls back to a glyph.
function localUrlFor(path, cacheBust) {
  if (!path || (typeof path === 'string' && path.startsWith('web://'))) return null;
  const t = cacheBust ? `?t=${encodeURIComponent(cacheBust)}` : '';
  return `localfile://local/${encodeURIComponent(path)}${t}`;
}

// Ask the disk for something, never letting a thrown IPC error escape: an
// optimistic op whose call threw would otherwise stay laid over the grid.
async function callDisk(fn) {
  try { return (await fn()) || {}; } catch (err) { return { error: err?.message || String(err) }; }
}
const diskFailed = (res) => !!res?.error || res?.ok === false;

// ── The project index, held in memory (src/projectIndex/README.md) ─────
// With the index, the listing is not read from the disk at all: the whole
// project comes out of main's index once (`projectFiles`), and from then on
// only the DIFFERENCES arrive (`project:delta`, from main's own watcher), so
// a folder of thousands of files is never walked or re-sent to show it.
// Rows and folders are keyed by their path inside the project, lower-cased
// (Windows paths are case-insensitive), and a folder view is derived from
// the rows' `dir` rather than listed.
const EMPTY = [];
const relKeyOf = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
const parentRel = (rel) => { const i = rel.lastIndexOf('/'); return i >= 0 ? rel.slice(0, i) : ''; };
const lastSegment = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
// `p`'s path inside `root`, as written (forward slashes), '' for the root
// itself, null for anything outside it.
// WHAT A COLLECTION IS JUDGED BY (lib/fileGroups findSamePairs): the bytes,
// the text — saved extracted text first, else read now from a Word / PDF /
// text file (≤15 MB; kept for the session by path + size + time) — what the AI
// scan understood, the pictures' look, the identity-document readers.
const GROUP_TEXT = new Map();
const GROUP_TEXT_EXT = /\.(docx?|pdf|txt|md|rtf|odt|html?|csv)$/i;
async function groupTextOf(f) {
  const saved = bestTextFor(f.path);
  if (saved) return saved;
  const u = getAiFacet(f.path, 'understanding')?.data;
  if (!GROUP_TEXT_EXT.test(f.name) || f.size > 15 * 1024 * 1024) return u?.text || '';
  const key = `${f.path}|${f.size}|${f.mtime}`;
  if (GROUP_TEXT.has(key)) return GROUP_TEXT.get(key);
  let text = '';
  try {
    const { extractFileText } = await import('../../lib/extractFileText');
    text = (await extractFileText(await readLocalBlob(f.path), f.name))?.text || '';
  } catch { text = ''; }
  GROUP_TEXT.set(key, text);
  return text;
}
async function groupingDeps(signal) {
  const RO = await import('../../lib/roIdDocuments');
  return {
    hash: sha256Of, dhash: dhashOf, hamming, shingles, likeness, signal,
    textOf: groupTextOf,
    understandingOf: (f) => getAiFacet(f.path, 'understanding')?.data || null,
    decodeCnp: RO.decodeCnp, parseMrz: RO.parseMrz,
  };
}
const groupFileOf = (root, lf) => {
  const rel = relOfPath(root, lf?.path);
  if (!rel || rel.split('/').some((seg) => seg.startsWith('.'))) return null;
  return { rel, path: lf.path, name: lf.name, size: Number(lf.sizeBytes) || 0, mtime: lf.mtimeIso ? Date.parse(lf.mtimeIso) || 0 : 0 };
};

function relOfPath(root, p) {
  const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const q = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!r) return null;
  const rl = r.toLowerCase();
  const ql = q.toLowerCase();
  if (ql === rl) return '';
  if (!ql.startsWith(`${rl}/`)) return null;
  return q.slice(r.length + 1);
}
const rowRel = (row) => row?.rel ?? (row?.folderPath ? `${row.folderPath}/${row.name}` : row?.name || '');
// The PROJECT FILE (`<Project name>.docvex` at the folder's root) is how the
// case opens from Explorer; inside the app it is not a document, so the grid
// never shows it. (The index lists it — see src/projectIndex/README.md.)
const isProjectFileRow = (row) => /\.docvex$/i.test(row?.name || '') && !String(rowRel(row)).includes('/');

// A folder and every folder above it, so a file whose folder the index
// didn't list separately still has one to be browsed into.
function addDirChain(ix, rel) {
  let r = rel;
  while (r) {
    const k = relKeyOf(r);
    if (ix.dirs.has(k)) break;
    ix.dirs.set(k, r);
    r = parentRel(r);
  }
}
function makeIndex(projectId, listing) {
  const ix = { projectId, rev: listing?.rev || 0, rows: new Map(), dirs: new Map() };
  for (const rel of listing?.dirs || []) addDirChain(ix, String(rel || ''));
  for (const row of listing?.files || []) {
    if (isProjectFileRow(row)) continue;
    const rel = rowRel(row);
    ix.rows.set(relKeyOf(rel), row);
    addDirChain(ix, parentRel(rel));
  }
  return ix;
}
// Lay one `project:delta` onto the index (mutating it). Returns the rows
// that already existed and came back with a new modified time — an edit made
// on disk — as [before, after] pairs.
function applyIndexDelta(ix, d) {
  const edits = [];
  for (const rel of d.removed || []) ix.rows.delete(relKeyOf(rel));
  for (const rel of d.dirsRemoved || []) {
    const k = relKeyOf(rel);
    for (const key of [...ix.dirs.keys()]) if (key === k || key.startsWith(`${k}/`)) ix.dirs.delete(key);
  }
  for (const rel of d.dirsAdded || []) addDirChain(ix, String(rel || ''));
  for (const row of d.upserted || []) {
    if (isProjectFileRow(row)) continue;
    const rel = rowRel(row);
    const k = relKeyOf(rel);
    const prev = ix.rows.get(k);
    if (prev && prev.mtimeIso && row.mtimeIso && prev.mtimeIso !== row.mtimeIso) edits.push([prev, row]);
    ix.rows.set(k, row);
    addDirChain(ix, parentRel(rel));
  }
  if (typeof d.rev === 'number') ix.rev = Math.max(ix.rev, d.rev);
  return edits;
}
// What the page reads off the index: every row, the rows of each folder, and
// the folders inside each folder.
function indexViews(ix) {
  const files = [...ix.rows.values()];
  const filesByDir = new Map();
  for (const row of files) {
    const k = relKeyOf(parentRel(rowRel(row)));
    const list = filesByDir.get(k);
    if (list) list.push(row); else filesByDir.set(k, [row]);
  }
  const childDirs = new Map();
  for (const rel of ix.dirs.values()) {
    const k = relKeyOf(parentRel(rel));
    const list = childDirs.get(k);
    if (list) list.push(rel); else childDirs.set(k, [rel]);
  }
  return { files, filesByDir, childDirs };
}

// “a.docx”, “b.pdf” and 3 more — names for a notification body.
function fmtNames(names, max = 3) {
  const list = (names || []).filter(Boolean);
  const shown = list.slice(0, max).map((n) => `“${n}”`).join(', ');
  return list.length > max ? `${shown} and ${list.length - max} more` : shown;
}

// Project-scoped Files page. Local-only: files come from a folder the user
// picks on their computer ("My drafts"); deleting a file moves it into a
// hidden `.docvex-trash` recycle bin ("Recently deleted") that auto-purges
// after 30 days.

// Listing entry → the item fields that depend only on it (see toDraftItem).
const DRAFT_FIXED = new WeakMap();

export default function ProjectFiles({ embedded = false } = {}) {
  const { selectedProject, loading: projLoading } = useSelectedProject();
  const navigate = useNavigate();
  const projectId = selectedProject?.id || null;
  const { notify } = useNotify();
  const { session } = useAuth();
  const userId = session?.user?.id || null;

  const supportsFolders = isElectronBranch;

  // One-shot warm-cache seed captured at mount for the project we open with.
  // When <App>'s ProjectPrefetch has already resolved this project's folder +
  // listings (the common "open the Hub, then click Project" path), the page
  // paints its grid from the seed on the first frame — no folder-resolve or
  // "Loading…" flash. Captured once (the `=== null` guard) so a later render
  // can't swap the seed mid-flight; null on a cold open (web, or no prefetch).
  const seedRef = useRef(null);
  if (seedRef.current === null) seedRef.current = getPrefetchedProjectFiles(projectId) || false;
  const seed = seedRef.current || null;

  // ── State ────────────────────────────────────────────────────────────
  // Whether main has the project index (src/projectIndex/README.md). While it
  // doesn't, the page lists the folder itself, as it always did.
  const indexMode = hasProjectIndex();
  const [localFolder, setLocalFolder] = useState(seed?.folder || '');
  // The recursive listing when the folder is walked (no index): counts,
  // folder metrics, the masthead.
  const [listedFiles, setLocalFiles] = useState(seed && !seed.index ? (seed.localFiles || []) : []);
  // The project index in memory (see makeIndex): rows + folders, mutated in
  // place as deltas arrive, with `indexVersion` bumped so what is derived
  // from it is worked out again. Seeded from the prefetch when there is one.
  const indexRef = useRef(null);
  if (indexRef.current === null) indexRef.current = seed?.index ? makeIndex(projectId, seed.index) : false;
  const [indexVersion, setIndexVersion] = useState(0);
  const indexViewsMemo = useMemo(
    () => (indexRef.current ? indexViews(indexRef.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [indexVersion],
  );
  const localFiles = indexMode ? (indexViewsMemo?.files || EMPTY) : listedFiles;
  // The project's folder isn't where this machine last had it (moved,
  // renamed, a drive not plugged in) — { dir } — or the folder picked for it
  // belongs to another project — { mismatch: true }. The page asks where it is.
  const [folderMissing, setFolderMissing] = useState(null);
  const [localLoading, setLocalLoading] = useState(() => indexMode && !seed?.index);
  const [localError, setLocalError] = useState(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [hydratedProjectId, setHydratedProjectId] = useState(seed ? projectId : null);
  // Electron project-directory resolution error + a retry trigger. Without
  // this a failed/rejected projectDir IPC (e.g. the main process hasn't picked
  // up the handler yet) would leave the page stuck on "Setting up…".
  const [folderError, setFolderError] = useState(null);
  const [folderRetry, setFolderRetry] = useState(0);

  // Folder navigation.
  const [folderStack, setFolderStack] = useState([]);    // [{ name, path }]
  const [browseCache, setBrowseCache] = useState(() => {
    const m = new Map(); // dir → { files, dirs } (folder-walking mode only)
    if (seed?.folder && seed.rootListing) m.set(seed.folder, { files: seed.rootListing.files, dirs: seed.rootListing.dirs });
    return m;
  });
  const [browseTick, setBrowseTick] = useState(0);

  // ── Optimistic operations (lib/optimisticFiles) ───────────────────────
  // Every rename / move / delete / restore / new file the user makes is laid
  // over the listings the moment it's made, and taken off once a listing
  // taken AFTER the disk answered has landed (or at once when the disk says
  // no — which is the whole rollback). `pendingOps` drives the render; the ref
  // lets the handlers ask "is this path busy?" without re-binding.
  const [pendingOps, setPendingOps] = useState([]);
  const pendingOpsRef = useRef(pendingOps);
  pendingOpsRef.current = pendingOps;
  const opSeqRef = useRef(0);
  // Listing responses can overtake each other (the watcher's relist, a
  // refetch after an op, another window's broadcast). Each request is
  // numbered and a response older than the last one applied is dropped, so a
  // stale listing can't land after the op that it predates has been retired.
  const listSeqRef = useRef(0);
  const allAppliedSeqRef = useRef(0);
  const dirAppliedSeqRef = useRef(new Map()); // normalised dir → last applied seq

  const [filesTab, setFilesTab] = useState('drafts');    // 'drafts' | 'trash'
  const [trashItems, setTrashItems] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  // Path of a freshly-created file that should be auto-selected + put into
  // rename mode in the workspace (instead of opening it). Cleared once applied.
  // MUST stay up here with the other hooks — the "no project selected" guard
  // below returns early, so a hook declared past it would change the hook
  // count between renders (React: "Rendered more hooks than during the
  // previous render").
  const [renameTargetPath, setRenameTargetPath] = useState(null);
  // True while "Create identity" is scanning — declared up here with the other
  // hooks, above the early returns (see the note above).
  // The AI scan of the whole folder (lib/dataCollections) — its progress while
  // it runs, null otherwise. Kept in lib/scanRunner, NOT in this page: the scan
  // goes on when the Files tab is left, and its progress is here on return
  // (the app sidebar shows a spinner beside Files meanwhile).
  const filesScan = useScanState(localFolder);
  // Files tagged for the AI scan (lib/scanTags) — only these are scanned, and
  // each wears the AI mark in the listing.
  const [scanTags, setScanTagsState] = useState(() => loadScanTags(''));
  useEffect(() => {
    setScanTagsState(loadScanTags(localFolder || ''));
    return subscribeScanTags((dir) => { if (dir === localFolder) setScanTagsState(loadScanTags(localFolder)); });
  }, [localFolder]);
  // COLLECTIONS (lib/fileGroups): custom folders pointing at files anywhere
  // in the project; the one open (its id) takes the grid's place.
  const [fileGroups, setFileGroupsState] = useState(() => loadFileGroups(''));
  const [openGroupId, setOpenGroupId] = useState(null);
  const [collectBusy, setCollectBusy] = useState(false);
  useEffect(() => {
    setFileGroupsState(loadFileGroups(localFolder || ''));
    return subscribeFileGroups((dir) => { if (dir === localFolder) setFileGroupsState(loadFileGroups(localFolder)); });
  }, [localFolder]);
  // Browsing anywhere else closes the collection.
  useEffect(() => { setOpenGroupId(null); }, [folderStack, filesTab, localFolder]);
  // How the open collection's files connect — the neural network's links
  // (lib/dataCollections loadScanGraph) and its duplicate sets — read when it
  // opens and whenever its files change; `key` says which collection it is for.
  const [groupGraph, setGroupGraph] = useState({ key: '', pairs: [] });
  useEffect(() => {
    const g = openGroupId ? fileGroups.find((c) => c.id === openGroupId) : null;
    if (!g || !localFolder) return undefined;
    const key = `${g.id}|${g.rels.join('|')}`;
    let dead = false;
    (async () => {
      const byRel = new Map();
      for (const lf of localFilesRef.current) {
        const f = groupFileOf(localFolder, lf);
        if (f) byRel.set(f.rel, f);
      }
      const list = g.rels.map((r) => byRel.get(r)).filter(Boolean);
      if (list.length < 2) return; // the listing isn't here yet: keep what is known
      let pairs = [];
      try { pairs = await findSamePairs(list, await groupingDeps()); } catch { pairs = []; }
      if (!dead) setGroupGraph({ key, pairs });
    })();
    return () => { dead = true; };
    // …and again once the project's files have loaded (opened before the
    // listing arrived, it had nothing to compare).
  }, [openGroupId, fileGroups, localFolder, projectId, localFiles.length]);
  // Path of a just-created folder the workspace should select (not open) —
  // set after an archive is extracted.
  const [selectTargetPath, setSelectTargetPath] = useState(null);

  // Undo / redo stack for file operations (delete, rename, new folder,
  // import, restore). Each action records its own inverse; see the
  // primitive helpers below.
  const { pushAction, clear: clearUndo, undo, redo, canUndo, canRedo, undoLabel, redoLabel } = useUndoRedo();

  const localUploadInputRef = useRef(null);
  // Import opens a window: this computer's picker, or a phone by QR code
  // (components/PhoneUploadModal — over the local network or DocVex's cloud).
  const [importOpen, setImportOpen] = useState(false);
  // Files a phone sent with the Import window closed, still waiting (lib/
  // phoneUploadIncoming): shown FADED in the folder they are going to, with a
  // download mark — a click accepts one, the right-click menu decides.
  const [incoming, setIncoming] = useState([]);
  useEffect(() => subscribeIncoming(setIncoming), []);
  const localFolderUploadInputRef = useRef(null);
  const localFolderDebounceRef = useRef(null);

  // The project id the warm seed belongs to (null on a cold open). The mount-
  // time reset effects below skip their wipes while we're still showing this
  // project so the seeded grid stays painted. Comparing projectId (rather than
  // a one-shot "first run" flag) keeps the guards idempotent — StrictMode's
  // double effect-invoke in dev re-runs them with the same projectId and so
  // still skips, while a real project switch (different id) takes the cold path.
  const seedProjectIdRef = useRef(seed ? projectId : null);

  const atRoot = folderStack.length === 0;
  const currentDir = atRoot ? localFolder : folderStack[folderStack.length - 1].path;
  // With the index, the folder on show is read off it: its files are the rows
  // whose folder it is, its folders the index's folders directly inside it.
  // Same order the folder listing had (files newest first, folders A→Z) and
  // the same entry shape (a folder's `empty` = nothing visible inside).
  const indexListing = useMemo(() => {
    if (!indexMode || !indexViewsMemo || !localFolder) return undefined;
    const rel = relOfPath(localFolder, currentDir);
    if (rel == null) return { files: EMPTY, dirs: EMPTY };
    const key = relKeyOf(rel);
    const { filesByDir, childDirs } = indexViewsMemo;
    const files = (filesByDir.get(key) || EMPTY).slice()
      .sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : a.mtimeIso > b.mtimeIso ? -1 : 0));
    const dirs = (childDirs.get(key) || EMPTY).map((r) => {
      const k = relKeyOf(r);
      return {
        name: lastSegment(r),
        path: joinPath(localFolder, ...r.split('/')),
        rel: r,
        empty: !(filesByDir.has(k) || childDirs.has(k)),
      };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { files, dirs };
  }, [indexMode, indexViewsMemo, localFolder, currentDir]);
  const browseListing = indexMode ? indexListing : browseCache.get(currentDir);
  // What the grid draws: the disk's last word with the in-flight ops laid
  // over it (see the optimistic block above). Only ops that actually touch
  // listings count here — the memo keys stay stable while none are pending.
  const browseView = useMemo(
    () => applyOpsToListing(browseListing, currentDir, pendingOps),
    [browseListing, currentDir, pendingOps],
  );
  const browseFiles = browseView.files;
  const browseDirs = browseView.dirs;
  const viewLocalFiles = useMemo(() => applyOpsToAll(localFiles, pendingOps), [localFiles, pendingOps]);
  const viewTrashItems = useMemo(() => applyOpsToTrash(trashItems, pendingOps), [trashItems, pendingOps]);
  const busyPaths = useMemo(() => pendingPaths(pendingOps), [pendingOps]);
  // EXTRACTED TEXT — which files on show have any (the mark on their
  // thumbnail). Re-read when the store changes anywhere (a reading saved,
  // a file's knowledge arriving from the index), at most every 250ms.
  const [textTick, setTextTick] = useState(0);
  useEffect(() => {
    let t = 0;
    const bump = () => { if (!t) t = window.setTimeout(() => { t = 0; setTextTick((n) => n + 1); }, 250); };
    const offAi = subscribeAiData(bump);
    const offIndex = subscribeIndex((ev) => { if (ev?.type === 'knowledge') bump(); });
    return () => { offAi(); offIndex(); window.clearTimeout(t); };
  }, []);
  const hasTextOf = useMemo(() => {
    const out = new Set();
    for (const lf of browseFiles) {
      const p = lf?.path;
      if (!p) continue;
      try {
        if (TEXT_EXT.test(lf.name || p) ? hasExtractedText(p)
          : MEDIA_EXT.test(lf.name || p) && (Number(lf.sizeBytes) || 0) <= 500 * 1024 * 1024 && !!String(loadCaptions(p)?.text || '').trim()) out.add(p);
      } catch { /* unknown — no mark */ }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseFiles, textTick]);
  const browseCacheRef = useRef(browseCache);
  browseCacheRef.current = browseCache;
  const currentDirRef = useRef(currentDir);
  currentDirRef.current = currentDir;
  const trashItemsRef = useRef(trashItems);
  trashItemsRef.current = trashItems;

  // Numbered listing requests (see listSeqRef): the answer comes back marked
  // `stale` when a newer request has already been applied, and the caller
  // drops it.
  const listAllFresh = useCallback(async (dir) => {
    const seq = ++listSeqRef.current;
    const res = (await localFolderApi.listAll(dir)) || {};
    if (seq < allAppliedSeqRef.current) return { ...res, stale: true };
    allAppliedSeqRef.current = seq;
    return res;
  }, []);
  const listDirFresh = useCallback(async (dir) => {
    const seq = ++listSeqRef.current;
    const res = (await localFolderApi.list(dir)) || {};
    const key = normPath(dir);
    if (seq < (dirAppliedSeqRef.current.get(key) || 0)) return { ...res, stale: true };
    dirAppliedSeqRef.current.set(key, seq);
    return res;
  }, []);

  // ── WhatsApp-export recognition (content-based) ────────────────────────
  // Probe the folders + .zip archives at the current browse level for a chat
  // transcript INSIDE them (main process: `_chat.txt` / a .txt whose first
  // bytes carry WhatsApp's timestamp signature). Verdicts are keyed by path
  // and stamped onto the item model below — recognition follows the
  // CONTENTS, not the name, so a renamed export keeps its WhatsApp mark.
  // The candidate list is keyed as a joined string so the effect re-probes
  // only when the visible set actually changes (browseFiles is a fresh []
  // every render while a listing is loading).
  const [waByPath, setWaByPath] = useState(() => ({}));
  const waCandidatesKey = [
    ...browseDirs.map((d) => d.path),
    // Folders + .zip archives carry their transcript inside; a loose .txt IS the
    // transcript (an extracted `_chat.txt`), so probe those by content too.
    ...browseFiles.filter((f) => /\.(zip|txt)$/i.test(f.name || '')).map((f) => f.path),
  ].filter(Boolean).join('\n');
  useEffect(() => {
    if (!isElectronBranch || !waCandidatesKey) return undefined;
    let cancelled = false;
    detectWhatsApp(waCandidatesKey.split('\n'))
      .then((res) => {
        if (!cancelled && res && typeof res === 'object') {
          setWaByPath((prev) => ({ ...prev, ...res }));
        }
      })
      .catch(() => { /* recognition is cosmetic — just no mark */ });
    return () => { cancelled = true; };
  }, [waCandidatesKey]);


  // ── Open the project's folder when the project switches ───────────────
  // With the project index, the folder is found by its PROJECT FILE: main's
  // registry knows where this machine has it. A project this machine has
  // never linked is linked where the app used to keep its folder (main's old
  // per-project registry, which also makes a folder for a new project) — so
  // an existing project gets its project file the first time it is opened
  // here. A project the registry DOES know, whose folder isn't there any more
  // (moved, renamed, a drive not plugged in), is never handed a new empty
  // folder: the page asks where it went (folderMissing).
  // Without the index (an older main process), the fixed per-project folder
  // is resolved and listed, as before.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const localFolderRef = useRef(localFolder);
  localFolderRef.current = localFolder;
  // Deltas that arrive while the index is being read are kept, and the ones
  // newer than the listing laid on it once it lands.
  const deltaBufRef = useRef([]);
  const loadingIndexRef = useRef(false);
  const indexWaitersRef = useRef([]);
  // Every settle waiting on the index (settleOps) is asked again after each
  // change: an op comes off the grid once the index shows what it did.
  const runIndexWaiters = useCallback(() => {
    const list = indexWaitersRef.current;
    if (!list.length) return;
    indexWaitersRef.current = list.filter((w) => {
      let ok = false;
      try { ok = w.check(); } catch { ok = true; }
      if (ok) { clearTimeout(w.timer); w.resolve(true); }
      return !ok;
    });
  }, []);
  // Resolves once `check()` holds against the index, or after `ms` whatever
  // it says (main may have named the result differently — "scan (2).jpg" —
  // or the watcher missed it; the grid then shows what the index has).
  const waitForIndex = useCallback((check, ms = 4000) => new Promise((resolve) => {
    let ok = false;
    try { ok = check(); } catch { ok = true; }
    if (ok) { resolve(true); return; }
    const w = { check, resolve, timer: 0 };
    w.timer = setTimeout(() => {
      indexWaitersRef.current = indexWaitersRef.current.filter((x) => x !== w);
      resolve(false);
    }, ms);
    indexWaitersRef.current.push(w);
  }), []);
  // Is there a file (or folder) at this absolute path in the index?
  const indexHas = useCallback((path, isDir) => {
    const ix = indexRef.current;
    if (!ix) return false;
    const rel = relOfPath(localFolderRef.current, path);
    if (rel == null) return false;
    if (rel === '') return !!isDir;
    const k = relKeyOf(rel);
    return isDir ? ix.dirs.has(k) : ix.rows.has(k);
  }, []);
  const loadIndexListing = useCallback(async (pid) => {
    loadingIndexRef.current = true;
    const res = await projectIndexApi.files({ projectId: pid });
    loadingIndexRef.current = false;
    if (pid !== projectIdRef.current) return;
    const buffered = deltaBufRef.current;
    deltaBufRef.current = [];
    if (!res?.ok) {
      setLocalError(res?.error || 'Could not read the project listing.');
      setLocalLoading(false);
      return;
    }
    const ix = makeIndex(pid, res);
    for (const d of buffered) {
      if (d?.projectId !== pid) continue;
      if (typeof d.rev === 'number' && d.rev <= ix.rev) continue;
      applyIndexDelta(ix, d);
    }
    indexRef.current = ix;
    setIndexVersion((v) => v + 1);
    setLocalLoading(false);
    runIndexWaiters();
  }, [runIndexWaiters]);

  useEffect(() => {
    if (!projectId) {
      setLocalFolder('');
      setLocalFiles([]);
      setLocalError(null);
      setNeedsReconnect(false);
      setFolderMissing(null);
      setHydratedProjectId(null);
      return undefined;
    }
    let cancelled = false;
    // While we're still showing the warm-seeded project the listing is
    // already populated from the prefetch cache — don't blank it (that would
    // re-introduce the "Loading…" flash). A switch to a different project
    // (id ≠ the seeded one) blanks normally.
    if (projectId !== seedProjectIdRef.current) {
      setLocalFiles([]);
      if (indexRef.current && indexRef.current.projectId !== projectId) {
        indexRef.current = false;
        setIndexVersion((v) => v + 1);
      }
    }
    setLocalError(null);
    setFolderError(null);
    setFolderMissing(null);
    setNeedsReconnect(false);
    if (!isElectronBranch) {
      setLocalFolder('');
      setFolderError('Project folders are available in the desktop app.');
      setHydratedProjectId(projectId);
      return undefined;
    }
    if (indexMode) {
      if (!(indexRef.current && indexRef.current.projectId === projectId)) setLocalLoading(true);
      (async () => {
        const known = await projectIndexApi.locate(projectId);
        if (cancelled) return;
        let res = await projectIndexApi.open({ projectId });
        if (cancelled) return;
        if (!res?.ok && res?.error === 'not_found' && !known?.dir) {
          // Never linked on this machine: link it where its folder was kept.
          const legacy = await legacyProjectDir({ projectId, name: selectedProject?.name, baseDir: readProjectsDir(userId) || undefined });
          if (cancelled) return;
          res = legacy?.path
            ? await linkProjectFolder({ projectId, name: selectedProject?.name, dir: legacy.path })
            : { ok: false, error: legacy?.error || 'Could not open the project folder.' };
          if (cancelled) return;
        }
        if (!res?.ok) {
          setLocalFolder('');
          setLocalLoading(false);
          if (res?.error === 'not_found' && known?.dir) setFolderMissing({ dir: known.dir });
          else if (res?.error === 'project_mismatch') setFolderMissing({ mismatch: true });
          else setFolderError(res?.error || 'Could not open the project folder. Restart the app and try again.');
          setHydratedProjectId(projectId);
          return;
        }
        setLocalFolder(res.dir);
        setHydratedProjectId(projectId);
        await loadIndexListing(projectId);
      })().catch((err) => {
        if (cancelled) return;
        setLocalFolder('');
        setLocalLoading(false);
        setFolderError(err?.message || 'Could not open the project folder. Restart the app and try again.');
        setHydratedProjectId(projectId);
      });
      return () => { cancelled = true; };
    }
    Promise.resolve(localFolderApi.projectDir(projectId, selectedProject?.name, readProjectsDir(userId) || undefined))
      .then(({ path, error }) => {
        if (cancelled) return;
        if (path) {
          setLocalFolder(path);
        } else {
          setLocalFolder('');
          setFolderError(error || 'Could not open the project folder.');
        }
        setHydratedProjectId(projectId);
      })
      .catch((err) => {
        if (cancelled) return;
        // Most common cause: the Electron main process is still the old one
        // (it doesn't hot-reload) and lacks the project-dir handler. Surface
        // it instead of hanging on the "Setting up…" placeholder.
        setLocalFolder('');
        setFolderError(err?.message || 'Could not open the project folder. Restart the app and try again.');
        setHydratedProjectId(projectId);
      });
    return () => { cancelled = true; };
  }, [projectId, folderRetry]); // eslint-disable-line react-hooks/exhaustive-deps

  // A project file opened from the OS (App.jsx → ProjectFileOpened) may point
  // at a different folder than the one on show: open the project again.
  useEffect(() => {
    const onChanged = (e) => { if (e?.detail?.projectId === projectIdRef.current) setFolderRetry((t) => t + 1); };
    window.addEventListener('docvex:project-folder-changed', onChanged);
    return () => window.removeEventListener('docvex:project-folder-changed', onChanged);
  }, []);

  // Show DocVex where the project's folder is now (it moved), or pick one for
  // a project whose folder belonged to another project. Linking writes the
  // project file there; the page then opens it like any other.
  const handleLinkFolder = useCallback(async () => {
    if (!projectId) return;
    const picked = await localFolderApi.pick();
    if (!picked) return;
    const res = await linkProjectFolder({ projectId, name: selectedProject?.name, dir: picked });
    if (!res?.ok) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Couldn’t use that folder',
        body: res?.error === 'project_mismatch'
          ? 'That folder already belongs to another DocVex project. Pick this project’s own folder.'
          : (res?.error || 'The folder could not be linked to this project.'),
        dedupeKey: `fx-link-folder:${projectId}`,
      });
      return;
    }
    setFolderRetry((t) => t + 1);
  }, [projectId, selectedProject?.name, notify]);

  // ── The index's differences, as they happen ───────────────────────────
  // Main watches the open project and reconciles it itself; every change
  // reaches every window as one delta, laid on the rows here. Nothing is
  // listed again. A delta also refreshes the Trash (a file that left the
  // folder may have gone into it), asks any settle waiting on it, and records
  // files changed on disk (not the catch-up after opening: those were edited
  // while nothing was watching, not just now).
  const recordExternalEditsRef = useRef(null);
  const trashRefreshTimerRef = useRef(0);
  const refetchTrashRef = useRef(null);
  useEffect(() => {
    if (!indexMode || !projectId) return undefined;
    deltaBufRef.current = [];
    const off = projectIndexApi.onDelta((d) => {
      if (!d || d.projectId !== projectIdRef.current) return;
      if (loadingIndexRef.current) deltaBufRef.current.push(d);
      const ix = indexRef.current;
      if (!ix || ix.projectId !== d.projectId) {
        if (!loadingIndexRef.current) deltaBufRef.current.push(d);
        return;
      }
      if (typeof d.rev === 'number' && d.rev <= ix.rev) return;
      const edits = applyIndexDelta(ix, d);
      setIndexVersion((v) => v + 1);
      if (!d.reconciled && edits.length) recordExternalEditsRef.current?.(edits.map((e) => e[0]), edits.map((e) => e[1]));
      clearTimeout(trashRefreshTimerRef.current);
      trashRefreshTimerRef.current = setTimeout(() => refetchTrashRef.current?.({ quiet: true }), 250);
      runIndexWaiters();
    });
    return () => { off?.(); clearTimeout(trashRefreshTimerRef.current); };
  }, [indexMode, projectId, runIndexWaiters]);

  // ── Refresh the recursive listing when the folder resolves ────────────
  // Folder-walking mode only; with the index the listing is already there.
  useEffect(() => {
    if (indexMode) return undefined;
    if (!projectId) return undefined;
    if (!hasLocalFolderApi || !localFolder) {
      setLocalFiles([]);
      setLocalError(null);
      return undefined;
    }
    if (needsReconnect) {
      setLocalFiles([]);
      setLocalError(null);
      return undefined;
    }
    if (localFolderDebounceRef.current) clearTimeout(localFolderDebounceRef.current);
    let cancelled = false;
    localFolderDebounceRef.current = setTimeout(async () => {
      // Only surface the full-panel "Loading…" when we have nothing to show
      // yet. A warm-seeded open already has a populated grid, so it refreshes
      // silently rather than flashing the spinner over it; a cold open (empty
      // list) shows the spinner as before.
      if (listedFiles.length === 0) setLocalLoading(true);
      setLocalError(null);
      const { files: list, error, stale } = await listAllFresh(localFolder);
      if (cancelled) return;
      setLocalLoading(false);
      if (stale) return;
      if (error) { setLocalError(error); setLocalFiles([]); }
      else setLocalFiles(list || []);
    // Debounced only when there is a grid to keep: a cold open has nothing
    // on screen, so waiting 300 ms first was pure delay.
    }, listedFiles.length === 0 ? 0 : 300);
    return () => {
      cancelled = true;
      if (localFolderDebounceRef.current) clearTimeout(localFolderDebounceRef.current);
    };
  }, [projectId, localFolder, hydratedProjectId, needsReconnect]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Recently deleted: sweep expired entries on folder open, then list ──
  // `quiet` refreshes without the Trash's "Loading…" state — used after an
  // operation, where the bin is already on screen and must not blank.
  const refetchTrash = useCallback(async ({ quiet = false } = {}) => {
    if (!hasLocalFolderApi || !localFolder) { setTrashItems([]); return; }
    if (!quiet) setTrashLoading(true);
    const { items } = await localFolderApi.listTrash(localFolder);
    setTrashItems(items || []);
    if (!quiet) setTrashLoading(false);
  }, [localFolder]);
  refetchTrashRef.current = refetchTrash;

  useEffect(() => {
    if (!hasLocalFolderApi || !localFolder || needsReconnect) { setTrashItems([]); return undefined; }
    let cancelled = false;
    (async () => {
      await localFolderApi.purgeTrash({ dir: localFolder });
      if (cancelled) return;
      const { items } = await localFolderApi.listTrash(localFolder);
      if (!cancelled) setTrashItems(items || []);
    })();
    return () => { cancelled = true; };
  }, [localFolder, needsReconnect]);

  // ── Activity tagging ──────────────────────────────────────────────────
  // Attaches project + file context to a notify() payload so the event also
  // lands in the personal activity log (lib/activityLog.js) — that log powers
  // the Activity page's metrics strip and its per-file / per-action grouping.
  const actMeta = useCallback((action, fileName, extra = {}) => ({
    activity: {
      action,
      fileName: fileName || null,
      projectId,
      projectName: selectedProject?.name || null,
      ...extra,
    },
  }), [projectId, selectedProject?.name]);

  // Watcher-detected content edits — a changed mtime on a path that already
  // existed means the file was saved (in Word, an external editor, or by the
  // doc-viewer). Recorded silently (no toast); one event per file per
  // 5 minutes so a save-happy editor doesn't flood the feed. prevFilesRef
  // tracks the last committed listing to diff against.
  const prevFilesRef = useRef(null);
  useEffect(() => { prevFilesRef.current = localFiles; }, [localFiles]);

  // ── Metadata, extracted on arrival ────────────────────────────────────
  // Every file in the folder gets its metadata read and cached in the
  // background, so the Doc Viewer's Metadata tab is already filled in the
  // first time it's opened rather than making the user press a button and
  // wait through a whole-file hash. Uploads come through here too: a write
  // triggers a relist, and a new file has no snapshot yet.
  //
  // The listing array is rebuilt every fetch, so the effect keys on a
  // value-equal signature instead — a poll that returns identical stats must
  // not restart the sweep. Files already cached (unchanged size+mtime) are
  // skipped inside prefetchMetadata, so a steady folder does no work at all.
  const localFilesRef = useRef(localFiles);
  localFilesRef.current = localFiles;
  // With the index a new listing only ever means a delta changed something,
  // so its version is the key — joining a string of every file in a large
  // project on each delta would cost more than the sweep it guards.
  const metaSweepKey = useMemo(
    () => (indexMode
      ? `ix:${indexVersion}:${localFiles.length}`
      : (localFiles || []).map((f) => `${f.path}:${f.sizeBytes}:${f.mtimeIso}`).join('|')),
    [indexMode, indexVersion, localFiles],
  );
  useEffect(() => {
    const files = localFilesRef.current;
    if (!files?.length) return undefined;
    return prefetchMetadata(files.filter((f) => f?.path && !String(f.name || '').startsWith('.docvex')));
  }, [metaSweepKey]);
  const editLogGuardRef = useRef(new Map()); // path → last logged ts
  const recordExternalEdits = useCallback((prevList, nextList) => {
    if (!Array.isArray(prevList) || prevList.length === 0) return;
    const EDIT_LOG_THROTTLE_MS = 5 * 60 * 1000;
    const prevByPath = new Map(prevList.map((f) => [f.path, f]));
    const now = Date.now();
    for (const f of nextList) {
      if (!f?.path || !f.mtimeIso) continue;
      const name = String(f.name || '');
      if (name.startsWith('.docvex')) continue; // sidecar / trash bookkeeping
      const prev = prevByPath.get(f.path);
      if (!prev || !prev.mtimeIso || prev.mtimeIso === f.mtimeIso) continue;
      const last = editLogGuardRef.current.get(f.path) || 0;
      if (now - last < EDIT_LOG_THROTTLE_MS) continue;
      editLogGuardRef.current.set(f.path, now);
      notify({
        category: 'file',
        variant: 'info',
        icon: 'edit',
        title: 'File edited',
        body: `“${name}” changed on disk.`,
        silent: true,
        dedupeKey: `fx-edit:${f.path}:${f.mtimeIso}`,
        payload: actMeta('edit', name, { filePath: f.path }),
      });
    }
  }, [notify, actMeta]);
  recordExternalEditsRef.current = recordExternalEdits;

  // ── Live-reload on disk change (folder-walking mode) ──────────────────
  // With the index, main watches the project itself and its deltas arrive
  // above; this is the older main process's watcher, which only says "the
  // folder changed", so everything is listed again.
  useEffect(() => {
    if (indexMode || !hasLocalFolderApi || !localFolder) return undefined;
    localFolderApi.watch(localFolder);
    const unsub = localFolderApi.onChange((changedDir) => {
      if (changedDir && changedDir !== localFolder) return;
      listAllFresh(localFolder).then(({ files: list, error, stale }) => {
        if (!error && !stale) {
          recordExternalEdits(prevFilesRef.current, list || []);
          setLocalFiles(list || []);
        }
      });
      setBrowseTick((t) => t + 1);
      refetchTrash({ quiet: true });
    });
    return () => { unsub?.(); localFolderApi.unwatch(); };
  }, [localFolder, refetchTrash, recordExternalEdits, listAllFresh]);

  // ── Cross-window change sync ──────────────────────────────────────────
  // The disk watcher only ever pings the main window, so a delete or rename in
  // another window (or the doc-viewer's tab sidebar) leaves other Files tabs —
  // notably the doc-viewer's embedded one — stale. These broadcasts re-list
  // every instance: files:removed after a trash, files:changed after a rename.
  // With the index every window already gets main's deltas, so only the Trash
  // (which the index doesn't hold) is refreshed.
  useEffect(() => {
    if (!hasLocalFolderApi || !localFolder) return undefined;
    const relist = () => {
      if (indexMode) { refetchTrash({ quiet: true }); return; }
      listAllFresh(localFolder).then(({ files: list, error, stale }) => {
        if (!error && !stale) setLocalFiles(list || []);
      });
      setBrowseTick((t) => t + 1);
      refetchTrash({ quiet: true });
    };
    const unsubRemoved = onFilesRemoved(relist);
    const unsubChanged = onFilesChanged(relist);
    return () => { unsubRemoved?.(); unsubChanged?.(); };
  }, [indexMode, localFolder, refetchTrash, listAllFresh]);

  // Reset folder navigation when the project / picked folder changes.
  useEffect(() => {
    // While showing the warm-seeded project at its root, keep the seeded root
    // browse cache so the grid stays painted (clearing it would blank the grid
    // for one IPC). folderStack/undo are empty on a fresh mount anyway, so
    // resetting just them is a no-op. Any project/folder change off the seed
    // takes the full reset. (projectId compare → StrictMode-idempotent)
    if (seed?.folder && projectId === seedProjectIdRef.current && localFolder === seed.folder) {
      setFolderStack([]);
      return;
    }
    setFolderStack([]);
    setBrowseCache(new Map());
    clearUndo(); // undo history is folder-scoped — a switch starts fresh
  }, [projectId, localFolder, clearUndo]);

  // ── Browse listing for the CURRENT directory (folder-walking mode) ─────
  // Lists the folder on show into the browse cache. With the index the
  // folder view is derived from the index (indexListing) instead.
  useEffect(() => {
    if (indexMode || !localFolder) return undefined;
    let cancelled = false;
    const writeCache = (files, dirs) => {
      setBrowseCache((prev) => {
        const next = new Map(prev);
        next.set(currentDir, { files: files || [], dirs: dirs || [] });
        return next;
      });
    };
    listDirFresh(currentDir).then(({ files: bf, dirs: bd, stale }) => {
      if (!cancelled && !stale) writeCache(bf, bd);
    }).catch(() => { if (!cancelled) writeCache([], []); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localFolder, currentDir, browseTick]);

  // File identity: every index Row carries its portable `id` (main keeps
  // `.docvex/ids.json` and imports the old `.docvex.json` sidecars), so the
  // grid keys files by it and a rename keeps the tile, its selection and its
  // thumbnail. There is no sidecar to load, reconcile or save here any more.

  // ── Folder actions ────────────────────────────────────────────────────
  const refetchLocalFiles = useCallback(async () => {
    if (indexMode || !hasLocalFolderApi || !localFolder) return;
    const { files: list, error, stale } = await listAllFresh(localFolder);
    if (!error && !stale) setLocalFiles(list || []);
  }, [indexMode, localFolder, listAllFresh]);

  // Re-list one folder straight into the browse cache (numbered, like every
  // other listing, so an older answer can't overwrite it).
  const relistDir = useCallback(async (dir) => {
    try {
      const { files, dirs, stale } = await listDirFresh(dir);
      if (stale) return;
      setBrowseCache((prev) => {
        const next = new Map(prev);
        next.set(dir, { files: files || [], dirs: dirs || [] });
        return next;
      });
    } catch { /* the watcher catches up */ }
  }, [listDirFresh]);

  // ── Optimistic op bookkeeping ─────────────────────────────────────────
  // beginOps lays ops over the listings (called BEFORE the first await, so
  // the grid changes in the same frame as the click); endOps takes them off —
  // on failure that is the entire rollback, since the listings underneath
  // were never touched. settleOps is the success path: retire the op only once
  // the listing shows what it did, so the old state never shows through in
  // between. With the index that means waiting for the delta main's watcher
  // sends for it (nothing is listed again); without, re-listing what it
  // touched.
  const opsByIdRef = useRef(new Map());
  const beginOps = useCallback((ops) => {
    const stamped = (ops || [])
      .filter(Boolean)
      .map((op) => ({ ...op, id: `op${opSeqRef.current += 1}` }));
    for (const op of stamped) opsByIdRef.current.set(op.id, op);
    if (stamped.length) setPendingOps((prev) => [...prev, ...stamped]);
    return stamped.map((op) => op.id);
  }, []);
  const endOps = useCallback((ids) => {
    if (!ids?.length) return;
    const gone = new Set(ids);
    for (const id of ids) opsByIdRef.current.delete(id);
    setPendingOps((prev) => prev.filter((op) => !gone.has(op.id)));
  }, []);
  // What the index must show before an op can come off the grid.
  const opLanded = useCallback((op) => {
    if (op.type === 'remove') return () => !indexHas(op.path, op.isDir);
    if (op.type === 'move') return () => indexHas(op.to, op.isDir) && (sameOpPath(op.from, op.to) || !indexHas(op.from, op.isDir));
    if (op.type === 'add') return () => indexHas(op.path, op.isDir);
    return () => true; // trash-remove: settled by the Trash refetch
  }, [indexHas]);
  // `expect` = paths the disk said it wrote (they may be named differently
  // from the op — "scan (2).jpg" beside an existing "scan.jpg").
  const settleOps = useCallback(async (ids, { dirs = [], trash = false, expect = [] } = {}) => {
    if (indexMode) {
      const checks = (ids || []).map((id) => opsByIdRef.current.get(id)).filter(Boolean).map(opLanded);
      for (const p of expect || []) if (p) checks.push(() => indexHas(p, false));
      try {
        await Promise.all([
          waitForIndex(() => checks.every((c) => c())),
          trash ? refetchTrash({ quiet: true }) : null,
        ]);
      } finally {
        endOps(ids);
      }
      return;
    }
    // The folders to re-list: the one on show, plus any the op touched that
    // the browse cache already holds (an uncached one is listed when opened).
    const cache = browseCacheRef.current;
    const keys = [];
    const seen = new Set();
    for (const d of [currentDirRef.current, ...dirs]) {
      if (!d) continue;
      const n = normPath(d);
      if (seen.has(n)) continue;
      seen.add(n);
      let key = null;
      for (const k of cache.keys()) { if (normPath(k) === n) { key = k; break; } }
      if (key == null && n === normPath(currentDirRef.current)) key = currentDirRef.current;
      if (key != null) keys.push(key);
    }
    try {
      await Promise.all([
        refetchLocalFiles(),
        ...keys.map(relistDir),
        trash ? refetchTrash({ quiet: true }) : null,
      ]);
    } finally {
      endOps(ids);
    }
  }, [indexMode, opLanded, indexHas, waitForIndex, refetchLocalFiles, relistDir, refetchTrash, endOps]);
  // Is an op already in flight on this path? The handlers refuse a second
  // destructive action on it (the tile is dimmed and inert meanwhile).
  const isBusy = useCallback((path) => !!path && pendingPaths(pendingOpsRef.current).has(normPath(path)), []);
  // The listing row for a path — carried by a move / rename op so the item
  // keeps its size, date and thumbnail while it is in flight.
  const entryFor = useCallback((path, isDir) => {
    const n = normPath(path);
    const ix = indexRef.current;
    if (indexMode && ix) {
      const rel = relOfPath(localFolderRef.current, path);
      if (rel == null || rel === '') return null;
      const k = relKeyOf(rel);
      if (!isDir) return ix.rows.get(k) || null;
      const dirRel = ix.dirs.get(k);
      return dirRel ? { name: lastSegment(dirRel), path, rel: dirRel, empty: false } : null;
    }
    for (const listing of browseCacheRef.current.values()) {
      const hit = (isDir ? listing?.dirs : listing?.files)?.find((e) => normPath(e.path) === n);
      if (hit) return hit;
    }
    if (!isDir) return (localFilesRef.current || []).find((f) => normPath(f.path) === n) || null;
    return null;
  }, []);
  // A Trash record put back: it leaves the bin, and its file (plus any
  // folder that has to be recreated for it) appears where it lived.
  const restoreOps = useCallback((rec, dirsSeen = new Set()) => {
    const ops = [{ type: 'trash-remove', stored: rec.stored }];
    if (!rec?.originalName || !localFolder) return ops;
    const rel = String(rec.originalRelDir || '').split(/[\\/]+/).filter(Boolean);
    for (let i = 1; i <= rel.length; i += 1) {
      const p = joinPath(localFolder, ...rel.slice(0, i));
      if (dirsSeen.has(normPath(p))) continue;
      dirsSeen.add(normPath(p));
      ops.push({ type: 'add', isDir: true, path: p, entry: { empty: false } });
    }
    ops.push({
      type: 'add',
      isDir: false,
      path: joinPath(localFolder, ...rel, rec.originalName),
      entry: { sizeBytes: rec.sizeBytes, mimeType: rec.mimeType, mtimeIso: new Date().toISOString() },
    });
    return ops;
  }, [localFolder]);
  const trashRecord = (stored) => (trashItemsRef.current || []).find((t) => t.stored === stored) || { stored };

  // ── Primitive operations (no undo bookkeeping) ────────────────────────
  // These do the actual filesystem work + settle side-effects and
  // return a small result. The public handlers below call a primitive and
  // then record an inverse on the undo stack; the undo/redo thunks call the
  // primitives directly so they don't push new history. Each one is
  // optimistic: its op goes on before the disk is asked, so an undo or redo
  // shows at once too.
  const primTrash = useCallback(async (filePath, fileName) => {
    const ids = beginOps([{ type: 'remove', path: filePath, isDir: false }]);
    const res = await callDisk(() => localFolderApi.trashFile({ dir: localFolder, path: filePath }));
    if (diskFailed(res)) { endOps(ids); return { ok: false, error: res.error }; }
    // Let the doc-viewer close any tab showing this now-deleted file (and any
    // other Files tab re-list).
    notifyFilesRemoved([filePath]);
    await settleOps(ids, { dirs: [parentOf(filePath)], trash: true });
    return { ok: true, stored: res.stored };
  }, [localFolder, beginOps, endOps, settleOps]);

  const primRestore = useCallback(async (stored) => {
    const ids = beginOps(restoreOps(trashRecord(stored)));
    const res = await callDisk(() => localFolderApi.restoreFromTrash({ dir: localFolder, stored }));
    if (diskFailed(res)) { endOps(ids); return { ok: false, error: res.error }; }
    await settleOps(ids, { dirs: res.restoredPath ? [parentOf(res.restoredPath)] : [], trash: true });
    return { ok: true, restoredPath: res.restoredPath };
  }, [localFolder, beginOps, endOps, settleOps, restoreOps]);

  const primRename = useCallback(async (dir, fromName, toName, { isDir = false } = {}) => {
    if (!fromName || !toName || fromName === toName) return { ok: false };
    // The op carries the file's listing row — and with it its portable id —
    // so the renamed tile keeps its key, selection and thumbnail while the
    // disk catches up, and the delta that lands brings the same id back.
    const entry = entryFor(joinPath(dir, fromName), isDir);
    const ids = beginOps([{ type: 'move', from: entry?.path || joinPath(dir, fromName), to: joinPath(dir, toName), isDir, entry }]);
    const res = await callDisk(() => localFolderApi.renameFile({ dir, fromName, toName }));
    if (diskFailed(res)) {
      endOps(ids);
      return { ok: false, error: res.error };
    }
    // Keep the AI chat (and any saved versions) with the file across the rename.
    // Clear any ORPHANED chat sitting at the destination name first — a since-
    // deleted file of the same name may have left a stale thread there, and
    // because a rename to an occupied name fails on disk, the destination is
    // always free, so any saved thread under it is dead. Without this the
    // renamed file would inherit that other file's history.
    try {
      clearConversation(`${dir}/${toName}`);
      migrateConversation(`${dir}/${fromName}`, `${dir}/${toName}`);
    } catch { /* non-fatal */ }
    await settleOps(ids, { dirs: [dir] });
    return { ok: true };
  }, [beginOps, endOps, settleOps, entryFor]);

  // Move one file / folder into another folder. `defer` leaves the settling
  // to the caller, so a batch re-lists once rather than per item.
  const primMove = useCallback(async (fromPath, toDir, { isDir = false, defer = false } = {}) => {
    const to = joinPath(toDir, baseName(fromPath));
    const ids = beginOps([{ type: 'move', from: fromPath, to, isDir, entry: entryFor(fromPath, isDir) }]);
    const res = await callDisk(() => localFolderApi.move({ root: localFolder, fromPath, toDir }));
    if (diskFailed(res)) { endOps(ids); return { ok: false, error: res.error, opIds: [] }; }
    if (!defer) await settleOps(ids, { dirs: [parentOf(fromPath), toDir] });
    return { ok: true, path: res.path || to, opIds: defer ? ids : [] };
  }, [localFolder, beginOps, endOps, settleOps, entryFor]);

  // A batch of moves: every item leaves at once, each failure is put back on
  // its own, and the folders are re-listed once at the end.
  // `list` = [{ fromPath, toDir, isDir }] → per-item results, in order.
  const moveBatch = useCallback(async (list) => {
    const results = await Promise.all((list || []).map((m) => primMove(m.fromPath, m.toDir, { isDir: m.isDir, defer: true })));
    const ids = results.flatMap((r) => r.opIds || []);
    const dirs = (list || []).flatMap((m) => [parentOf(m.fromPath), m.toDir]);
    await settleOps(ids, { dirs });
    return results;
  }, [primMove, settleOps]);

  const primCreateFolder = useCallback(async (dir, name) => {
    const ids = beginOps([{ type: 'add', isDir: true, path: joinPath(dir, name), entry: { empty: true, mtimeIso: new Date().toISOString() } }]);
    const res = await callDisk(() => localFolderApi.createFolder({ dir, name }));
    if (diskFailed(res)) { endOps(ids); return { ok: false, error: res.error }; }
    // Main may have tidied the name (characters Windows refuses) — the
    // re-list brings the real one, and the caller is told it.
    await settleOps(ids, { dirs: [dir] });
    return { ok: true, name: res.name || name, path: res.path || joinPath(dir, name) };
  }, [beginOps, endOps, settleOps]);

  const primDeleteFolder = useCallback(async (dir, name) => {
    const ids = beginOps([{ type: 'remove', isDir: true, path: joinPath(dir, name) }]);
    const res = await callDisk(() => localFolderApi.deleteFolder({ dir, name }));
    if (diskFailed(res)) { endOps(ids); return { ok: false, error: res.error }; }
    await settleOps(ids, { dirs: [dir] });
    return { ok: true };
  }, [beginOps, endOps, settleOps]);

  // Move a whole folder into the recycle bin (every file inside is trashed,
  // recoverable for 30 days). Returns the stored names so an undo can restore
  // the lot — mirrors primTrash but for a directory. `defer` as primMove.
  const primTrashFolder = useCallback(async (folderPath, { defer = false } = {}) => {
    const ids = beginOps([{ type: 'remove', path: folderPath, isDir: true }]);
    const res = await callDisk(() => localFolderApi.trashFolder({ dir: localFolder, path: folderPath }));
    if (diskFailed(res)) { endOps(ids); return { ok: false, error: res.error, opIds: [] }; }
    // Close doc-viewer tabs for any file that lived inside this folder.
    notifyFilesRemoved([folderPath]);
    if (!defer) await settleOps(ids, { dirs: [parentOf(folderPath)], trash: true });
    return { ok: true, stored: res.stored || [], opIds: defer ? ids : [] };
  }, [localFolder, beginOps, endOps, settleOps]);

  // A file to the bin, deferred — the batch delete's per-item step.
  const primTrashDeferred = useCallback(async (filePath, fileName) => {
    const ids = beginOps([{ type: 'remove', path: filePath, isDir: false }]);
    const res = await callDisk(() => localFolderApi.trashFile({ dir: localFolder, path: filePath }));
    if (diskFailed(res)) { endOps(ids); return { ok: false, error: res.error, opIds: [] }; }
    return { ok: true, stored: res.stored, opIds: ids };
  }, [localFolder, beginOps, endOps]);

  // Delete a set of files / folders together: all leave the grid at once,
  // each failure comes back on its own, one re-list at the end.
  // `list` = [{ path, name, isDir }] → per-item results, in order.
  const trashBatch = useCallback(async (list) => {
    const results = await Promise.all((list || []).map((e) => (e.isDir
      ? primTrashFolder(e.path, { defer: true })
      : primTrashDeferred(e.path, e.name))));
    const okPaths = (list || []).filter((_, i) => results[i]?.ok).map((e) => e.path);
    if (okPaths.length) notifyFilesRemoved(okPaths);
    await settleOps(results.flatMap((r) => r.opIds || []), { dirs: (list || []).map((e) => parentOf(e.path)), trash: true });
    return results;
  }, [primTrashFolder, primTrashDeferred, settleOps]);

  // Unpack a compressed file. A .zip lands in a sibling "<name> - unzipped"
  // folder; every other format is handed to the OS archiver by main, which
  // comes back as { extracted: false } — nothing changed on disk here, so
  // there's nothing to refetch or undo. Not optimistic: what it will create
  // (and under which name) is only known once it has done it.
  const primExtractArchive = useCallback(async (srcPath) => {
    const res = await localFolderApi.extractArchive(srcPath);
    if (!res || res.ok === false) return { ok: false, error: res?.error };
    if (res.extracted) {
      setBrowseTick((t) => t + 1);
      await refetchLocalFiles();
    }
    return { ok: true, extracted: !!res.extracted, path: res.path, created: !!res.created };
  }, [refetchLocalFiles]);

  // Restore a batch of binned files (the inverse of primTrashFolder). Best-
  // effort: keeps going if one item can't be restored. All of them leave the
  // bin (and reappear in the folders) at once; a failure goes back on its own.
  // `out`, when given, collects { stored, restoredPath } for each one put back.
  const primRestoreMany = useCallback(async (storedList, out = null) => {
    const dirsSeen = new Set();
    const plan = (storedList || []).map((s) => ({ stored: s, ids: beginOps(restoreOps(trashRecord(s), dirsSeen)) }));
    let okAll = true;
    const dirs = [];
    const keep = [];
    for (const p of plan) {
      const r = await callDisk(() => localFolderApi.restoreFromTrash({ dir: localFolder, stored: p.stored }));
      if (diskFailed(r)) { okAll = false; endOps(p.ids); continue; }
      keep.push(...p.ids);
      if (r.restoredPath) dirs.push(parentOf(r.restoredPath));
      if (out) out.push({ stored: p.stored, restoredPath: r.restoredPath });
    }
    await settleOps(keep, { dirs, trash: true });
    return okAll;
  }, [localFolder, beginOps, endOps, settleOps, restoreOps]);

  // ── Undo / redo drivers ───────────────────────────────────────────────
  const handleUndo = useCallback(async () => {
    const res = await undo();
    if (!res) return;
    notify(res.ok
      ? { category: 'file', variant: 'info', icon: 'restore', title: 'Undone', body: res.label, dedupeKey: 'fx-undo' }
      : { category: 'file', variant: 'error', title: 'Couldn’t undo', body: `“${res.label}” could not be reversed.`, dedupeKey: 'fx-undo' });
  }, [undo, notify]);

  const handleRedo = useCallback(async () => {
    const res = await redo();
    if (!res) return;
    notify(res.ok
      ? { category: 'file', variant: 'info', icon: 'restore', title: 'Redone', body: res.label, dedupeKey: 'fx-redo' }
      : { category: 'file', variant: 'error', title: 'Couldn’t redo', body: `“${res.label}” could not be reapplied.`, dedupeKey: 'fx-redo' });
  }, [redo, notify]);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. Suppressed while
  // typing in an input (rename field, search) so it doesn't hijack the
  // browser's text undo.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo]);

  const handleEnterFolder = useCallback((dir) => {
    if (!dir?.path) return;
    setFolderStack((stack) => [...stack, { name: dir.name, path: dir.path }]);
  }, []);

  // Open a WhatsApp export folder's reconstructed conversation in the
  // doc-viewer (transcript located inside it by the main process). Falls back
  // to browsing the folder when it isn't really a WhatsApp export / on web.
  const handleOpenWhatsAppFolder = useCallback(async (dir) => {
    if (!dir?.path) return;
    try {
      const prepped = await prepareWhatsAppFolder(dir.path);
      if (prepped?.ok && prepped.chatPath) {
        openDocViewerWindow({ path: prepped.chatPath, name: prepped.name || dir.name, mime: 'text/plain', isWhatsApp: true });
        return;
      }
    } catch { /* fall through to browse */ }
    handleEnterFolder(dir);
  }, [handleEnterFolder]);

  const handleNavigateCrumb = useCallback((index) => {
    setFolderStack((stack) => (index < 0 ? [] : stack.slice(0, index + 1)));
  }, []);

  const handleCreateFolder = useCallback(async (name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const dir = currentDir;
    const res = await primCreateFolder(dir, trimmed);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: `Couldn’t create “${trimmed}”`, body: res.error || 'The folder could not be made here.', dedupeKey: `folder-create-error:${trimmed}` }); return; }
    // Main may have tidied the name; undo / redo work on the one on disk.
    const made = res.name || trimmed;
    notify({ category: 'file', variant: 'success', icon: 'folder-plus', title: 'Folder created', body: `“${made}” added to this folder.`, silent: true, payload: actMeta('create-folder', made, { folder: true }) });
    pushAction({
      label: `New folder “${made}”`,
      undo: async () => (await primDeleteFolder(dir, made)).ok,
      redo: async () => (await primCreateFolder(dir, made)).ok,
    });
  }, [currentDir, notify, actMeta, primCreateFolder, primDeleteFolder, pushAction]);

  const handleRenameFolder = useCallback(async (folder, newName) => {
    const parent = currentDir;
    const from = folder?.name;
    const to = (newName || '').trim();
    if (!from || !to || to === from) return;
    if (isBusy(folder?.path)) return;
    const res = await primRename(parent, from, to, { isDir: true });
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: `Couldn’t rename “${from}”`, body: `A file inside it may be open in another program, or “${to}” is already taken. It kept its old name.`, dedupeKey: `folder-rename-error:${folder?.path || from}` }); return; }
    notify({ category: 'file', variant: 'success', icon: 'edit', title: 'Folder renamed', body: `“${from}” is now “${to}”.`, silent: true, payload: actMeta('rename', to, { detail: `from “${from}”`, folder: true }) });
    // Move every conversation saved for files inside the folder to the new path.
    try { migrateConversationsUnder(`${parent}/${from}`, `${parent}/${to}`); } catch { /* non-fatal */ }
    pushAction({
      label: `Rename “${from}” → “${to}”`,
      undo: async () => { const ok = (await primRename(parent, to, from, { isDir: true })).ok; if (ok) { try { migrateConversationsUnder(`${parent}/${to}`, `${parent}/${from}`); } catch { /* non-fatal */ } } return ok; },
      redo: async () => { const ok = (await primRename(parent, from, to, { isDir: true })).ok; if (ok) { try { migrateConversationsUnder(`${parent}/${from}`, `${parent}/${to}`); } catch { /* non-fatal */ } } return ok; },
    });
  }, [currentDir, notify, actMeta, primRename, pushAction, isBusy]);

  const handleDeleteFolder = useCallback(async (dir) => {
    const folderPath = dir?.path;
    const parent = currentDir;
    if (!folderPath || isBusy(folderPath)) return;
    const res = await primTrashFolder(folderPath);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: `Couldn’t delete “${dir.name}”`, body: 'A file inside it may be open in another program. The folder was left where it was.', dedupeKey: `folder-delete-error:${folderPath}` }); return; }
    // variant 'error' paints the toast/row red (destructive action); explicit
    // normal priority keeps it from being escalated like a real failure.
    notify({ category: 'file', variant: 'error', priority: 'normal', icon: 'trash', title: 'Moved to Trash', body: `“${dir.name}” will be removed for good in ${TRASH_RETENTION_DAYS} days.`, dedupeKey: `fx-trash-folder:${folderPath}`, payload: actMeta('delete', dir.name, { folder: true }) });
    // Track the stored names so redo (re-trash) can update them; an empty
    // folder leaves nothing in the bin, so undo just recreates it.
    const state = { stored: res.stored, path: folderPath };
    pushAction({
      label: `Delete folder “${dir.name}”`,
      undo: async () => {
        if (state.stored.length) return primRestoreMany(state.stored);
        return (await primCreateFolder(parent, dir.name)).ok;
      },
      redo: async () => {
        const r = await primTrashFolder(state.path);
        if (r.ok) state.stored = r.stored;
        return r.ok;
      },
    });
  }, [currentDir, notify, actMeta, primTrashFolder, primRestoreMany, primCreateFolder, pushAction, isBusy]);

  // With no folder to work in, the import buttons ask for one — only when the
  // project's folder has gone missing; otherwise the folder is still being
  // opened and there is nothing to ask.
  const handleBrowseFolder = useCallback(() => {
    if (folderMissing) handleLinkFolder();
  }, [folderMissing, handleLinkFolder]);

  // Double-click / "Open" — render the file inside its OWN DocVex window
  // instead of handing it to the OS default app. Routing:
  //   • image / video / PDF / text → openFileWindow (Chromium renders the
  //     localfile:// URL natively in a titled "DocVex - <file>" window).
  //   • .docx → rasterized to self-contained HTML via docx-preview and shown
  //     in its own window; falls back to Word/Office on render failure.
  //   • anything Chromium can't render (zip / psd / exe / …) → OS default app.
  // On web there's no localfile:// scheme, so we mint an object URL from the
  // cached file handle's bytes for the viewable types.
  const handleOpenLocalFile = useCallback(async (file) => {
    if (!hasLocalFolderApi || !file?.path) return;
    const name = file.name || 'file';
    const mime = file.mimeType;
    // A WhatsApp export ships as a .zip (transcript + media). Extract it and,
    // if it really is a WhatsApp export, open the reconstructed conversation
    // (with media) in the doc-viewer instead of treating the zip as an opaque
    // archive. Non-WhatsApp zips fall through to the normal handling below.
    if (/\.zip$/i.test(name)) {
      const prepped = await prepareWhatsAppZip(file.path);
      if (prepped?.ok && prepped.chatPath) {
        openDocViewerWindow({ path: prepped.chatPath, name: prepped.name || name, mime: 'text/plain', isWhatsApp: true });
        return;
      }
    }
    // Open EVERY file type in DocVex's document-viewer window (file preview +
    // Legal AI panel). Types it can't preview show a fallback with an "open in
    // default app" button. Electron only; returns false on web, so we fall
    // through to the per-type in-app / OS open below.
    if (openDocViewerWindow({ path: file.path, name, mime: mime || '' })) {
      return;
    }
    // Resolve a window-loadable URL for the on-disk file: localfile:// on
    // Electron, an object URL from the file bytes on web.
    const resolveUrl = async () => {
      const direct = localUrlFor(file.path);
      if (direct) return direct;
      try { return URL.createObjectURL(await readLocalBlob(file.path)); } catch { return null; }
    };

    if (isDocxFile(mime, name)) {
      const url = await resolveUrl();
      if (url) {
        const { error } = await openDocxInWindow({ signedUrl: url, fileName: name });
        if (!error) return;
      }
      openDocx({ localPath: file.path, fileName: name }); // Word / Office fallback
      return;
    }

    if (canViewInBrowser(mime, name)) {
      const url = await resolveUrl();
      if (url) { openFileWindow(url, name); return; }
    }

    // Not renderable in a window — let the OS open it in its default app.
    localFolderApi.openPath(file.path);
  }, []);

  // Copy a set of File/Blob objects (filename + bytes) INTO the folder the
  // user is browsing. Shared by the "Import" button (hidden file input) and
  // drag-and-drop from the OS file manager — both just hand off a file list.
  const importFiles = useCallback(async (picked) => {
    if (!picked || picked.length === 0 || !localFolder) return;
    const dir = currentDir;
    // Every picked file shows in the folder at once, dimmed until written
    // (a `.livp` excepted — what it unpacks to is only known once it has).
    // Keyed by name so each write's result can settle or drop its own tile.
    const opByName = new Map();
    for (const f of picked) {
      if (!f?.name || isLivpName(f.name) || opByName.has(f.name)) continue;
      const [id] = beginOps([{ type: 'add', isDir: false, path: joinPath(dir, f.name), entry: { sizeBytes: f.size, mimeType: f.type || undefined, mtimeIso: new Date().toISOString() } }]);
      if (id) opByName.set(f.name, id);
    }
    const allOpIds = [...opByName.values()];
    // Anything thrown on the way (a .livp that won't unpack, a Live Photo
    // partner that can't be read) must not leave the tiles hanging dimmed.
    try {
      // A `.livp` (the ZIP iOS wraps an exported Live Photo in) is unpacked:
      // its picture is written, and its video rides along as the partner below.
      const entries = [];
      for (const file of picked.filter((f) => f && f.name)) {
        if (isLivpName(file.name)) {
          try {
            const u = await unpackLivp(file, file.name);
            if (u?.image) {
              entries.push({ filename: u.image.name, blob: u.image.blob, src: null, video: u.video });
              continue;
            }
          } catch { /* not a readable .livp — written as it is */ }
        }
        entries.push({ filename: file.name, blob: file, src: file, video: null });
      }
      const payload = entries.map(({ filename, blob }) => ({ filename, blob }));
      if (payload.length === 0) { endOps(allOpIds); return; }
      const { results, error } = await callDisk(() => localFolderApi.writeFiles({ dir, files: payload }));
      if (error) {
        endOps(allOpIds);
        notify({ category: 'file', variant: 'error', title: payload.length === 1 ? `Couldn’t add “${payload[0].filename}”` : 'Couldn’t add the files', body: `Nothing was added. ${error}`, dedupeKey: 'fab-write-error' });
        return;
      }
      // A file that failed on its own comes off the grid now; the rest stay
      // dimmed until the re-list below shows them under their real names
      // (main may have written "scan (2).jpg" beside an existing "scan.jpg").
      entries.forEach((e, i) => { if (!results?.[i]?.ok && opByName.has(e.filename)) endOps([opByName.get(e.filename)]); });
      // LIVE PHOTOS: an iPhone Live Photo on a computer is a picture plus a
      // same-name video (IMG_1234.JPG + IMG_1234.MOV). Importing the picture
      // brings its video along — named after the picture AS WRITTEN (it may
      // have become "IMG_1234 (2).JPG"), so the Doc Viewer still pairs them
      // (lib/livePhoto). Skipped when the video was picked as well.
      const pickedNames = new Set(picked.map((f) => String(f?.name || '').toLowerCase()));
      const partners = [];
      const stemOfWritten = (r) => String(r.filename).replace(/\.[^./\\]+$/, '');
      for (let i = 0; i < entries.length; i += 1) {
        const r = results?.[i];
        if (!r?.ok || !r.filename) continue;
        const e = entries[i];
        if (e.video) { partners.push({ filename: `${stemOfWritten(r)}.${String(e.video.name).split('.').pop()}`, blob: e.video.blob }); continue; }
        const src = e.src ? pathForFile(e.src) : null;
        const partner = src ? await livePartnerOf(src, e.filename) : null;
        if (!partner || pickedNames.has(String(partner.name).toLowerCase())) continue;
        try {
          const blob = await readLocalBlob(partner.path);
          if (blob) partners.push({ filename: `${stemOfWritten(r)}.${String(partner.name).split('.').pop()}`, blob });
        } catch { /* the picture came across; its movement did not */ }
      }
      if (partners.length) {
        const pr = await callDisk(() => localFolderApi.writeFiles({ dir, files: partners }));
        for (const x of pr?.results || []) if (x.ok) results.push(x);
      }
      const okCount = (results || []).filter((r) => r.ok).length;
      const failCount = (results || []).length - okCount;
      const importedNames = (results || []).filter((r) => r.ok && r.filename).map((r) => r.filename);
      // Pictures have their text read in the background (lib/autoExtract).
      extractTextOnImport((results || []).filter((r) => r.ok && r.path).map((r) => ({ path: r.path, name: r.filename })), projectId);
      notify({
        category: 'file',
        variant: failCount > 0 ? 'error' : 'success',
        title: failCount > 0 ? 'Added with errors' : 'Files added',
        body: failCount > 0 ? `${okCount} of ${results.length} added · ${failCount} failed` : `${okCount} file${okCount === 1 ? '' : 's'} added.`,
        dedupeKey: 'fab-write-result',
        payload: okCount > 0
          ? actMeta('import', importedNames.length === 1 ? importedNames[0] : null, { count: okCount, files: importedNames })
          : undefined,
      });
      // (New files get their portable id from main as the index picks them up.)
      await settleOps(allOpIds, { dirs: [dir], expect: (results || []).filter((r) => r.ok && r.path).map((r) => r.path) });

      // Record an undo: imported files go to the recycle bin (recoverable),
      // and redo restores them. Each entry's identifiers move with it.
      const added = (results || []).filter((r) => r.ok && r.path).map((r) => ({ path: r.path, name: r.filename, stored: null }));
      if (added.length > 0) {
        pushAction({
          label: added.length === 1 ? `Import “${added[0].name}”` : `Import ${added.length} files`,
          undo: async () => {
            const res = await trashBatch(added.map((ent) => ({ path: ent.path, name: ent.name, isDir: false })));
            res.forEach((r, i) => { if (r.ok) added[i].stored = r.stored; });
            return res.every((r) => r.ok);
          },
          redo: async () => {
            const back = added.filter((ent) => ent.stored);
            const out = [];
            const ok = await primRestoreMany(back.map((ent) => ent.stored), out);
            for (const r of out) {
              const ent = back.find((x) => x.stored === r.stored);
              if (ent && r.restoredPath) ent.path = r.restoredPath;
            }
            return ok && back.length === added.length;
          },
        });
      }
    } catch (err) {
      endOps(allOpIds);
      notify({ category: 'file', variant: 'error', title: 'Couldn’t add the files', body: err?.message || String(err), dedupeKey: 'fab-write-error' });
    }
  }, [localFolder, currentDir, notify, actMeta, pushAction, trashBatch, primRestoreMany, beginOps, endOps, settleOps, projectId]);

  // "Import" button → hidden <input type=file>.
  const handleLocalFilesPicked = useCallback(async (e) => {
    const input = e.target;
    const picked = Array.from(input.files || []);
    input.value = '';
    await importFiles(picked);
  }, [importFiles]);

  // Import a WHOLE folder (preserving its subfolder structure) into the current
  // folder. Each entry is { file, relPath } where relPath is like
  // "myFolder/sub/file.txt"; we group by relative directory and write each
  // group into the matching nested dir. write-files mkdir's the target
  // recursively, so the subfolders are created in place. Shared by the
  // <input webkitdirectory> picker and a drag-dropped folder.
  const importFolderEntries = useCallback(async (entries) => {
    if (!entries || entries.length === 0 || !localFolder) return;
    // relDir -> [{ filename, blob }]
    const groups = new Map();
    for (const ent of entries) {
      const f = ent?.file;
      if (!f || !f.name) continue;
      const rel = String(ent.relPath || f.name).replace(/\\/g, '/');
      const slash = rel.lastIndexOf('/');
      const relDir = slash >= 0 ? rel.slice(0, slash) : '';
      const base = slash >= 0 ? rel.slice(slash + 1) : rel;
      if (!base) continue;
      if (!groups.has(relDir)) groups.set(relDir, []);
      groups.get(relDir).push({ filename: base, blob: f });
    }
    if (groups.size === 0) return;
    const base = currentDir;
    // The imported folder(s) show at once, dimmed, where they will land — the
    // top level of each relative path (that is all this folder's grid shows);
    // the files themselves arrive with the re-list at the end.
    const tops = new Set();
    for (const relDir of groups.keys()) { const top = relDir.split('/')[0]; if (top) tops.add(top); }
    const opIds = beginOps([...tops].map((top) => ({ type: 'add', isDir: true, path: joinPath(base, top), entry: { empty: false, mtimeIso: new Date().toISOString() } })));
    let ok = 0;
    let fail = 0;
    // Forward slashes in the appended relDir are normalised by Node's path on
    // the main side, so this works regardless of the OS separator in currentDir.
    for (const [relDir, groupFiles] of groups) {
      const dir = relDir ? `${base}/${relDir}` : base;
      const { results, error } = await callDisk(() => localFolderApi.writeFiles({ dir, files: groupFiles }));
      if (error) { fail += groupFiles.length; continue; }
      ok += (results || []).filter((r) => r.ok).length;
      fail += (results || []).filter((r) => !r.ok).length;
      extractTextOnImport((results || []).filter((r) => r.ok && r.path).map((r) => ({ path: r.path, name: r.filename })), projectId);
    }
    notify({
      category: 'file',
      variant: fail > 0 ? 'error' : 'success',
      title: fail > 0 ? 'Folder added with errors' : 'Folder added',
      body: fail > 0
        ? `${ok} of ${ok + fail} files imported · ${fail} failed`
        : `${ok} file${ok === 1 ? '' : 's'} imported across ${groups.size} folder${groups.size === 1 ? '' : 's'}.`,
      dedupeKey: 'fx-folder-import',
      payload: ok > 0 ? actMeta('import', null, { count: ok, detail: 'folder import' }) : undefined,
    });
    await settleOps(opIds, { dirs: [base] });
  }, [localFolder, currentDir, notify, actMeta, beginOps, settleOps, projectId]);

  // Drag-and-drop from the OS file manager → copy the dropped files into the
  // current folder. Each entry is { file, relPath }; loose files (no folder in
  // relPath) keep the undo handling of importFiles, while anything
  // dropped inside a folder is routed through importFolderEntries so its nested
  // structure is recreated. (Earlier this only read a flat FileList and so
  // silently dropped folders on the floor.)
  const handleDropFiles = useCallback(async (entries) => {
    const list = Array.isArray(entries)
      ? entries
      : Array.from(entries || []).map((f) => ({ file: f, relPath: f?.name }));
    const loose = [];
    const nested = [];
    for (const ent of list) {
      const f = ent?.file;
      if (!f || !f.name) continue;
      const rel = String(ent.relPath || f.name).replace(/\\/g, '/');
      if (rel.includes('/')) nested.push(ent);
      else loose.push(f);
    }
    if (loose.length) await importFiles(loose);
    if (nested.length) await importFolderEntries(nested);
  }, [importFiles, importFolderEntries]);

  // "Import folder" → hidden <input webkitdirectory>. The picked files carry a
  // `webkitRelativePath`; map them into the shared { file, relPath } shape.
  const handleLocalFolderPicked = useCallback(async (e) => {
    const input = e.target;
    const picked = Array.from(input.files || []);
    input.value = '';
    const entries = picked
      .filter((f) => f && f.name)
      .map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name }));
    await importFolderEntries(entries);
  }, [importFolderEntries]);

  const handleRenameLocalFile = useCallback(async (file, newName) => {
    const trimmed = (newName || '').trim();
    if (!trimmed || !file?.name || trimmed === file.name) return;
    if (isBusy(file.path)) return;
    const parent = currentDir;
    const from = file.name;
    const res = await primRename(parent, from, trimmed);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: `Couldn’t rename “${from}”`, body: `It may be open in another program, or a file called “${trimmed}” already exists. It kept its old name.`, dedupeKey: `fx-rename-err:${file.path || from}` }); return; }
    notify({ category: 'file', variant: 'success', icon: 'edit', title: 'File renamed', body: `“${from}” is now “${trimmed}”.`, silent: true, payload: actMeta('rename', trimmed, { detail: `from “${from}”` }) });
    pushAction({
      label: `Rename “${from}” → “${trimmed}”`,
      undo: async () => (await primRename(parent, trimmed, from)).ok,
      redo: async () => (await primRename(parent, from, trimmed)).ok,
    });
  }, [currentDir, notify, actMeta, primRename, pushAction, isBusy]);

  // ── Copy / paste ──────────────────────────────────────────────────────
  // Paste copies the clipboard's source files (read by their on-disk path)
  // into the CURRENT folder, minting a non-clobbering "… copy" name when a
  // file of the same name already lives here. The copies show at once,
  // dimmed, while their bytes are read and written.
  const handlePasteItems = useCallback(async (clipItems) => {
    if (!localFolder || !Array.isArray(clipItems) || clipItems.length === 0) return;
    const dir = currentDir;
    const taken = new Set(browseFiles.map((f) => (f.name || '').toLowerCase()));
    const uniqueName = (name) => {
      if (!taken.has((name || '').toLowerCase())) return name;
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let candidate = `${base} copy${ext}`;
      let n = 2;
      while (taken.has(candidate.toLowerCase())) { candidate = `${base} copy ${n}${ext}`; n += 1; }
      return candidate;
    };
    const now = new Date().toISOString();
    const plan = [];
    for (const it of clipItems) {
      if (!it?.path) continue;
      const filename = uniqueName(it.name || 'file');
      taken.add(filename.toLowerCase());
      const src = entryFor(it.path, false);
      const [id] = beginOps([{ type: 'add', isDir: false, path: joinPath(dir, filename), entry: { sizeBytes: src?.sizeBytes, mimeType: src?.mimeType, mtimeIso: now } }]);
      plan.push({ it, filename, id });
    }
    const toWrite = [];
    const writeIds = [];
    const unreadable = [];
    for (const p of plan) {
      try {
        const blob = await readLocalBlob(p.it.path);
        toWrite.push({ filename: p.filename, blob });
        writeIds.push(p.id);
      } catch {
        // Unreadable source — its tile comes off, the rest carry on.
        if (p.id) endOps([p.id]);
        unreadable.push(p.it.name || p.filename);
      }
    }
    if (toWrite.length === 0) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t paste', body: `${fmtNames(unreadable)} could not be read — ${unreadable.length === 1 ? 'it may have been moved, or be open in another program' : 'they may have been moved, or be open in another program'}.`, dedupeKey: 'fx-paste-err' });
      return;
    }
    const { results, error } = await callDisk(() => localFolderApi.writeFiles({ dir, files: toWrite }));
    if (error) {
      endOps(writeIds.filter(Boolean));
      notify({ category: 'file', variant: 'error', title: 'Couldn’t paste', body: `Nothing was pasted. ${error}`, dedupeKey: 'fx-paste-err' });
      return;
    }
    (results || []).forEach((r, i) => { if (!r?.ok && writeIds[i]) endOps([writeIds[i]]); });
    const written = (results || []).filter((r) => r.ok && r.path);
    const failedNames = [...unreadable, ...toWrite.filter((_, i) => !results?.[i]?.ok).map((w) => w.filename)];
    await settleOps(writeIds.filter(Boolean), { dirs: [dir], expect: (results || []).filter((r) => r.ok && r.path).map((r) => r.path) });
    if (written.length === 0) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t paste', body: `${fmtNames(failedNames)} could not be written here.`, dedupeKey: 'fx-paste-err' });
      return;
    }
    notify(failedNames.length
      ? { category: 'file', variant: 'error', title: `Pasted ${written.length} of ${written.length + failedNames.length}`, body: `${fmtNames(failedNames)} could not be copied — ${failedNames.length === 1 ? 'it' : 'they'} may be open in another program.`, dedupeKey: 'fx-paste', payload: actMeta('import', null, { count: written.length, files: written.map((r) => r.filename), detail: 'pasted' }) }
      : { category: 'file', variant: 'success', icon: 'copy', title: written.length > 1 ? 'Files pasted' : 'File pasted', body: `${written.length} file${written.length === 1 ? '' : 's'} added to this folder.`, dedupeKey: 'fx-paste', payload: actMeta('import', written.length === 1 ? written[0].filename : null, { count: written.length, files: written.map((r) => r.filename), detail: 'pasted' }) });
    const copies = written.map((r) => ({ path: r.path, name: r.filename }));
    const blobs = toWrite.filter((_, i) => results?.[i]?.ok);
    pushAction({
      label: `Paste ${written.length} file${written.length === 1 ? '' : 's'}`,
      undo: async () => (await trashBatch(copies.map((c) => ({ ...c, isDir: false })))).every((r) => r.ok),
      redo: async () => {
        const ids = beginOps(blobs.map((b) => ({ type: 'add', isDir: false, path: joinPath(dir, b.filename), entry: { sizeBytes: b.blob?.size, mtimeIso: new Date().toISOString() } })));
        const r = await callDisk(() => localFolderApi.writeFiles({ dir, files: blobs }));
        (r.results || []).forEach((x, i) => { if (x?.ok && x.path && copies[i]) copies[i].path = x.path; });
        await settleOps(ids, { dirs: [dir] });
        return !r.error && (r.results || []).every((x) => x?.ok);
      },
    });
  }, [localFolder, currentDir, browseFiles, notify, actMeta, pushAction, beginOps, endOps, settleOps, trashBatch, entryFor]);

  // ── Moves (cut + paste, drag onto a folder or a breadcrumb) ───────────
  // Every item leaves at once and shows, dimmed, in the target if that's the
  // folder on screen; each one the disk refuses goes back on its own. One
  // notification for the lot.
  const runMoves = useCallback(async (list) => {
    const res = await moveBatch(list);
    const moved = [];
    const failedNames = [];
    res.forEach((r, i) => {
      const m = list[i];
      if (!r.ok) { failedNames.push(m.name); return; }
      moved.push({ name: m.name, isDir: m.isDir, origDir: parentOf(m.fromPath), fromPath: m.fromPath, path: r.path });
      // Keep the AI chat with the file/folder across the move. Drop any
      // orphaned chat left at the destination path by a since-gone file of
      // the same name before moving this file's thread in.
      try {
        if (m.isDir) migrateConversationsUnder(m.fromPath, r.path);
        else { clearConversation(r.path); migrateConversation(m.fromPath, r.path); }
      } catch { /* non-fatal */ }
    });
    return { moved, failedNames };
  }, [moveBatch]);
  const pushMoveUndo = useCallback((moved, targetDir, label) => {
    pushAction({
      label,
      undo: async () => {
        const r = await moveBatch(moved.map((m) => ({ fromPath: m.path, toDir: m.origDir, isDir: m.isDir })));
        r.forEach((x, i) => { if (x.ok) moved[i].fromPath = x.path; });
        return r.every((x) => x.ok);
      },
      redo: async () => {
        const r = await moveBatch(moved.map((m) => ({ fromPath: m.fromPath, toDir: targetDir, isDir: m.isDir })));
        r.forEach((x, i) => { if (x.ok) moved[i].path = x.path; });
        return r.every((x) => x.ok);
      },
    });
  }, [pushAction, moveBatch]);
  const notifyMoves = useCallback((moved, failedNames, whereLabel) => {
    const total = moved.length + failedNames.length;
    const why = `${failedNames.length === 1 ? 'It' : 'They'} may be open in another program, or ${whereLabel ? `“${whereLabel}”` : 'this folder'} already has an item with that name.`;
    if (moved.length === 0) {
      notify({ category: 'file', variant: 'error', title: failedNames.length === 1 ? `Couldn’t move “${failedNames[0]}”` : `Couldn’t move ${failedNames.length} items`, body: `${why} Nothing was moved.`, dedupeKey: 'fx-move-err' });
      return;
    }
    const payload = actMeta('move', moved.length === 1 ? moved[0].name : null, { count: moved.length, files: moved.map((m) => m.name), ...(whereLabel ? { detail: `to “${whereLabel}”` } : {}) });
    if (failedNames.length) {
      notify({ category: 'file', variant: 'error', title: `Moved ${moved.length} of ${total} items`, body: `${fmtNames(failedNames)} stayed where ${failedNames.length === 1 ? 'it was' : 'they were'}. ${why}`, dedupeKey: 'fx-move', payload });
      return;
    }
    notify({ category: 'file', variant: 'success', icon: 'folder', title: moved.length > 1 ? 'Files moved' : 'File moved', body: whereLabel ? `${moved.length} item${moved.length === 1 ? '' : 's'} moved to “${whereLabel}”.` : `${moved.length} file${moved.length === 1 ? '' : 's'} moved here.`, dedupeKey: 'fx-move', payload });
  }, [notify, actMeta]);

  // Paste of CUT files — move each from its source folder into the current
  // folder. Inverse moves files back to where they came from.
  const handlePasteCut = useCallback(async (clipItems) => {
    if (!localFolder || !Array.isArray(clipItems) || clipItems.length === 0) return;
    const target = currentDir;
    const list = clipItems
      .filter((it) => it?.path && !isBusy(it.path) && !sameOpPath(parentOf(it.path), target))
      .map((it) => ({ fromPath: it.path, toDir: target, isDir: false, name: it.name || baseName(it.path) }));
    if (list.length === 0) return;
    const { moved, failedNames } = await runMoves(list);
    notifyMoves(moved, failedNames, null);
    if (moved.length) pushMoveUndo(moved, target, `Move ${moved.length} file${moved.length === 1 ? '' : 's'}`);
  }, [localFolder, currentDir, isBusy, runMoves, notifyMoves, pushMoveUndo]);

  // ── Move (drag a file onto a folder) ──────────────────────────────────
  // Dragged items always come from the CURRENT folder, so the inverse of a
  // move is just moving them back into `currentDir`.
  const handleMoveItems = useCallback(async (items, targetFolder) => {
    const toDir = targetFolder?._dir?.path || targetFolder?.path;
    if (!localFolder || !toDir || !Array.isArray(items) || items.length === 0) return;
    if (sameOpPath(toDir, currentDir)) return;
    // Files carry their path on `_raw`, folders on `_dir`. The main-process
    // move handler renames either kind by basename, so both work the same.
    const list = items
      .map((it) => ({ fromPath: it?._raw?.path || it?._dir?.path, toDir, isDir: !!it?._dir, name: it?.name }))
      .filter((m) => m.fromPath && !isBusy(m.fromPath))
      .map((m) => ({ ...m, name: m.name || baseName(m.fromPath) }));
    if (list.length === 0) return;
    const { moved, failedNames } = await runMoves(list);
    notifyMoves(moved, failedNames, targetFolder.name);
    if (moved.length) pushMoveUndo(moved, toDir, `Move ${moved.length} item${moved.length === 1 ? '' : 's'} to “${targetFolder.name}”`);
  }, [localFolder, currentDir, isBusy, runMoves, notifyMoves, pushMoveUndo]);

  // ── Recently deleted actions ──────────────────────────────────────────
  const handleDeleteLocalCard = useCallback(async (file) => {
    if (!file?.path || isBusy(file.path)) return;
    const res = await primTrash(file.path, file.name);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: `Couldn’t delete “${file.name}”`, body: 'It may be open in another program. The file was left where it was.', dedupeKey: `fx-trash-err:${file.path}` }); return; }
    // variant 'error' paints the toast/row red (destructive action); explicit
    // normal priority keeps it from being escalated like a real failure.
    notify({ category: 'file', variant: 'error', priority: 'normal', icon: 'trash', title: 'Moved to Trash', body: `"${file.name}" will be removed for good in ${TRASH_RETENTION_DAYS} days.`, dedupeKey: `fx-trash:${file.path}`, payload: actMeta('delete', file.name, { filePath: file.path }) });
    const state = { stored: res.stored, path: file.path, name: file.name };
    pushAction({
      label: `Delete “${file.name}”`,
      undo: async () => {
        const r = await primRestore(state.stored);
        if (r.ok && r.restoredPath) state.path = r.restoredPath;
        return r.ok;
      },
      redo: async () => {
        const r = await primTrash(state.path, state.name);
        if (r.ok) state.stored = r.stored;
        return r.ok;
      },
    });
  }, [notify, actMeta, primTrash, primRestore, pushAction, isBusy]);

  // Delete a multi-selection (or a drop of several items on the Trash): all
  // of them leave the grid at once, each failure comes back on its own, and
  // there is one notification and one undo for the lot.
  const handleDeleteMany = useCallback(async (items) => {
    const list = (items || [])
      .map((it) => (it?.kind === 'folder'
        ? (it._dir?.path ? { path: it._dir.path, name: it.name || it._dir.name, isDir: true } : null)
        : (it?._raw?.path ? { path: it._raw.path, name: it.name || it._raw.name, isDir: false } : null)))
      .filter(Boolean)
      .filter((e) => !isBusy(e.path));
    if (list.length === 0) return;
    if (list.length === 1) {
      const [only] = list;
      if (only.isDir) handleDeleteFolder({ path: only.path, name: only.name });
      else handleDeleteLocalCard({ path: only.path, name: only.name });
      return;
    }
    const res = await trashBatch(list);
    const done = list.map((e, i) => ({ ...e, ok: !!res[i]?.ok, stored: res[i]?.ok ? (e.isDir ? (res[i].stored || []) : [res[i].stored].filter(Boolean)) : [] }));
    const gone = done.filter((d) => d.ok);
    const failedNames = done.filter((d) => !d.ok).map((d) => d.name);
    if (gone.length === 0) {
      notify({ category: 'file', variant: 'error', title: `Couldn’t delete ${failedNames.length} items`, body: 'They may be open in another program. Everything was left where it was.', dedupeKey: 'fx-trash-many-err' });
      return;
    }
    notify(failedNames.length
      ? { category: 'file', variant: 'error', title: `Moved ${gone.length} of ${list.length} to Trash`, body: `${fmtNames(failedNames)} could not be deleted — ${failedNames.length === 1 ? 'it' : 'they'} may be open in another program.`, dedupeKey: 'fx-trash-many', payload: actMeta('delete', null, { count: gone.length, files: gone.map((d) => d.name) }) }
      : { category: 'file', variant: 'error', priority: 'normal', icon: 'trash', title: 'Moved to Trash', body: `${gone.length} items will be removed for good in ${TRASH_RETENTION_DAYS} days.`, dedupeKey: 'fx-trash-many', payload: actMeta('delete', null, { count: gone.length, files: gone.map((d) => d.name) }) });
    pushAction({
      label: `Delete ${gone.length} items`,
      undo: async () => {
        const stored = gone.flatMap((d) => d.stored);
        let ok = stored.length ? await primRestoreMany(stored) : true;
        // An empty folder left nothing in the bin — undo recreates it.
        for (const d of gone) {
          if (d.isDir && d.stored.length === 0) ok = (await primCreateFolder(parentOf(d.path), d.name)).ok && ok;
        }
        return ok;
      },
      redo: async () => {
        const r = await trashBatch(gone);
        r.forEach((x, i) => { if (x.ok) gone[i].stored = gone[i].isDir ? (x.stored || []) : [x.stored].filter(Boolean); });
        return r.every((x) => x.ok);
      },
    });
  }, [notify, actMeta, pushAction, isBusy, trashBatch, primRestoreMany, primCreateFolder, handleDeleteFolder, handleDeleteLocalCard]);

  const handleRestoreFromTrash = useCallback(async (trash) => {
    if (!trash?.stored) return;
    const res = await primRestore(trash.stored);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: `Couldn’t restore “${trash.originalName}”`, body: 'It is still in the Trash. The folder it came from may be open in another program — try again in a moment.', dedupeKey: `fx-restore-err:${trash.stored}` }); return; }
    notify({ category: 'file', variant: 'success', icon: 'check', title: 'Restored', body: `"${trash.originalName}" is back in your folder.`, dedupeKey: `fx-restore:${trash.stored}`, payload: actMeta('restore', trash.originalName) });
    const state = { stored: trash.stored, path: res.restoredPath, name: trash.originalName };
    pushAction({
      label: `Restore “${trash.originalName}”`,
      undo: async () => {
        const r = await primTrash(state.path, state.name);
        if (r.ok) state.stored = r.stored;
        return r.ok;
      },
      redo: async () => {
        const r = await primRestore(state.stored);
        if (r.ok && r.restoredPath) state.path = r.restoredPath;
        return r.ok;
      },
    });
  }, [notify, actMeta, primTrash, primRestore, pushAction]);

  // Restore a multi-selection from the bin — loose files and deleted
  // folders alike, one notification and one undo.
  const handleRestoreMany = useCallback(async (items) => {
    const recs = (items || []).flatMap((it) => it?._trashGroup || (it?._trash ? [it._trash] : []));
    if (recs.length === 0) return;
    const out = [];
    await primRestoreMany(recs.map((r) => r.stored), out);
    const back = new Set(out.map((o) => o.stored));
    const failedNames = [...new Set(recs.filter((r) => !back.has(r.stored)).map((r) => r.originalName))];
    if (out.length === 0) {
      notify({ category: 'file', variant: 'error', title: `Couldn’t restore ${recs.length === 1 ? `“${recs[0].originalName}”` : `${recs.length} files`}`, body: 'Everything is still in the Trash. Try again in a moment.', dedupeKey: 'fx-restore-many-err' });
      return;
    }
    notify(failedNames.length
      ? { category: 'file', variant: 'error', title: `Restored ${out.length} of ${recs.length}`, body: `${fmtNames(failedNames)} ${failedNames.length === 1 ? 'is' : 'are'} still in the Trash.`, dedupeKey: 'fx-restore-many', payload: actMeta('restore', null, { count: out.length }) }
      : { category: 'file', variant: 'success', icon: 'check', title: 'Restored', body: `${out.length} file${out.length === 1 ? ' is' : 's are'} back in your folder.`, dedupeKey: 'fx-restore-many', payload: actMeta('restore', null, { count: out.length }) });
    const nameOf = new Map(recs.map((r) => [r.stored, r.originalName]));
    const state = out.map((o) => ({ path: o.restoredPath, name: nameOf.get(o.stored), stored: o.stored })).filter((s) => s.path);
    if (state.length === 0) return;
    pushAction({
      label: `Restore ${state.length} file${state.length === 1 ? '' : 's'}`,
      undo: async () => {
        const r = await trashBatch(state.map((s) => ({ path: s.path, name: s.name, isDir: false })));
        r.forEach((x, i) => { if (x.ok) state[i].stored = x.stored; });
        return r.every((x) => x.ok);
      },
      redo: async () => {
        const again = [];
        const ok = await primRestoreMany(state.map((s) => s.stored), again);
        for (const a of again) { const s = state.find((x) => x.stored === a.stored); if (s && a.restoredPath) s.path = a.restoredPath; }
        return ok;
      },
    });
  }, [notify, actMeta, pushAction, primRestoreMany, trashBatch]);

  // Delete Trash records for good. They leave the bin at once; any the disk
  // refuses come back. Returns the records that could NOT be deleted.
  const purgeRecords = useCallback(async (recs) => {
    const plan = (recs || []).filter((r) => r?.stored).map((r) => ({ rec: r, ids: beginOps([{ type: 'trash-remove', stored: r.stored }]) }));
    const res = await Promise.all(plan.map((p) => callDisk(() => localFolderApi.deleteFromTrash({ dir: localFolder, stored: p.rec.stored }))));
    const failed = [];
    const keep = [];
    res.forEach((r, i) => {
      if (diskFailed(r)) { endOps(plan[i].ids); failed.push(plan[i].rec); } else keep.push(...plan[i].ids);
    });
    try { await refetchTrash({ quiet: true }); } finally { endOps(keep); }
    return failed;
  }, [localFolder, beginOps, endOps, refetchTrash]);

  // Empty the whole bin — permanently delete every trashed file. Not
  // undoable (mirrors single permanent delete).
  const handleEmptyBin = useCallback(async () => {
    const all = viewTrashItems;
    if (!localFolder || all.length === 0) return;
    const count = all.length;
    const failed = await purgeRecords(all);
    notify(failed.length > 0
      ? { category: 'file', variant: 'error', title: 'Couldn’t empty the Trash', body: `${failed.length} of ${count} could not be deleted (${fmtNames(failed.map((r) => r.originalName))}) — they are still in the Trash.`, dedupeKey: 'fx-empty-bin' }
      : { category: 'file', variant: 'success', icon: 'trash', title: 'Trash emptied', body: `${count} file${count === 1 ? '' : 's'} permanently deleted.`, dedupeKey: 'fx-empty-bin', payload: actMeta('purge', null, { count }) });
  }, [localFolder, viewTrashItems, notify, actMeta, purgeRecords]);

  const handlePermanentDelete = useCallback(async (trash) => {
    if (!trash?.stored) return;
    const failed = await purgeRecords([trash]);
    if (failed.length) { notify({ category: 'file', variant: 'error', title: `Couldn’t delete “${trash.originalName}”`, body: 'It is still in the Trash. Try again in a moment.', dedupeKey: `fx-perm-del-err:${trash.stored}` }); return; }
    notify({ category: 'file', variant: 'success', icon: 'trash', title: 'Permanently deleted', body: `"${trash.originalName}" is gone for good.`, dedupeKey: `fx-perm-del:${trash.stored}`, payload: actMeta('purge', trash.originalName) });
  }, [notify, actMeta, purgeRecords]);

  // Restore every file of a deleted folder back to where it lived.
  const handleRestoreGroup = useCallback(async (item) => {
    const recs = item?._trashGroup || [];
    if (!recs.length) return;
    const okAll = await primRestoreMany(recs.map((r) => r.stored));
    notify(okAll
      ? { category: 'file', variant: 'success', icon: 'check', title: 'Restored', body: `“${item.name}” is back in your folder.`, dedupeKey: `fx-restore-grp:${item.id}`, payload: actMeta('restore', item.name) }
      : { category: 'file', variant: 'error', title: 'Some files couldn’t be restored', body: `Part of “${item.name}” could not be put back — the rest is still in the Trash.`, dedupeKey: `fx-restore-grp-err:${item.id}` });
  }, [primRestoreMany, notify, actMeta]);

  // Permanently delete every file of a deleted folder.
  const handlePermanentDeleteGroup = useCallback(async (item) => {
    const recs = item?._trashGroup || [];
    if (!recs.length) return;
    const failed = await purgeRecords(recs);
    notify(failed.length
      ? { category: 'file', variant: 'error', title: `Couldn’t delete all of “${item.name}”`, body: `${failed.length} of ${recs.length} files are still in the Trash. Try again in a moment.`, dedupeKey: `fx-perm-del-grp-err:${item.id}` }
      : { category: 'file', variant: 'success', icon: 'trash', title: 'Permanently deleted', body: `“${item.name}” is gone for good.`, dedupeKey: `fx-perm-del-grp:${item.id}`, payload: actMeta('purge', item.name) });
  }, [notify, actMeta, purgeRecords]);

  // Delete a multi-selection in the bin for good — one notification.
  const handlePermanentDeleteMany = useCallback(async (items) => {
    const recs = (items || []).flatMap((it) => it?._trashGroup || (it?._trash ? [it._trash] : []));
    if (recs.length === 0) return;
    const failed = await purgeRecords(recs);
    notify(failed.length
      ? { category: 'file', variant: 'error', title: `Couldn’t delete ${failed.length} of ${recs.length}`, body: `${fmtNames(failed.map((r) => r.originalName))} ${failed.length === 1 ? 'is' : 'are'} still in the Trash. Try again in a moment.`, dedupeKey: 'fx-perm-del-many-err' }
      : { category: 'file', variant: 'success', icon: 'trash', title: 'Permanently deleted', body: `${recs.length} file${recs.length === 1 ? ' is' : 's are'} gone for good.`, dedupeKey: 'fx-perm-del-many', payload: actMeta('purge', null, { count: recs.length }) });
  }, [notify, actMeta, purgeRecords]);

  // PERFORMANCE — folder metrics. Every folder on show is matched against the
  // whole recursive listing (path-prefix), which is folders × files of work;
  // it only changes with those two, so it isn't redone on renders that touch
  // neither (a scan's progress, a notification, the Import window).
  // One pass over the files, each adding itself to every folder above it
  // (keyed by path inside the project), rather than every folder scanning
  // every file — the difference matters on a project of tens of thousands.
  // The folder is read off the PATH, not a row's `dir`: a file with a move
  // in flight carries its old row but already has its new path.
  const statsByRel = useMemo(() => {
    const out = new Map();
    if (!localFolder) return out;
    for (const f of viewLocalFiles) {
      if (typeof f.path !== 'string') continue;
      const rel = relOfPath(localFolder, f.path);
      if (!rel) continue;
      const bytes = Number(f.sizeBytes) || 0;
      const t = f.mtimeIso ? Date.parse(f.mtimeIso) || 0 : 0;
      let dir = relKeyOf(parentRel(rel));
      while (dir) {
        const s = out.get(dir);
        if (s) { s.bytes += bytes; if (t > s.latest) s.latest = t; }
        else out.set(dir, { bytes, latest: t });
        dir = parentRel(dir);
      }
    }
    return out;
  }, [viewLocalFiles, localFolder]);
  const dirStatsByPath = useMemo(() => {
    const out = new Map();
    for (const dir of browseDirs) {
      const dirPath = dir?.path;
      if (typeof dirPath !== 'string' || !dirPath || out.has(dirPath)) continue;
      const rel = relOfPath(localFolder, dirPath);
      out.set(dirPath, rel ? (statsByRel.get(relKeyOf(rel)) || null) : null);
    }
    return out;
  }, [browseDirs, statsByRel, localFolder]);
  // The item models below are rebuilt on every render of this page, and the
  // Files grid memoises its tiles on the item objects. An item whose every
  // field came out the same as last time is handed back as LAST time's object
  // (and a list whose items all did, as last time's list), so a render of this
  // page that changes nothing about a file doesn't redraw its tile. Values are
  // still computed each render — labels like "today" stay exactly as fresh.
  const itemReuseRef = useRef({ items: new Map(), lists: {} });

  // ── Guards (after all hooks) ──────────────────────────────────────────
  if (projLoading && !selectedProject) return null;
  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to see its files.</p>
        <button type="button" className="project-scoped-cta" onClick={() => navigate('/projects')}>Browse projects</button>
      </div>
    );
  }

  // ── Item model ────────────────────────────────────────────────────────
  // Folder metrics — total size + last-modified across EVERYTHING under the
  // folder, from the recursive listing (path-prefix match). Null when the
  // folder has no matched files (empty, or the backend's paths can't be
  // prefix-matched) so the row falls back to its '—' placeholders.
  const statsForDir = (dirPath) => {
    if (typeof dirPath !== 'string' || !dirPath) return null;
    return dirStatsByPath.has(dirPath) ? dirStatsByPath.get(dirPath) : null;
  };
  const realDraftFolders = browseDirs.map((dir) => {
    const stats = statsForDir(dir.path);
    return {
      id: `dir:${dir.path}`,
      kind: 'folder',
      name: dir.name,
      empty: dir.empty,
      status: 'synced',
      sizeLabel: stats ? formatBytes(stats.bytes) : '',
      modifiedLabel: stats?.latest ? formatDate(new Date(stats.latest).toISOString()) : '',
      // For the header's Sort: newest file inside, total size.
      sortTime: stats?.latest || 0,
      sortSize: stats?.bytes || 0,
      // Content-probed (see the waByPath effect) — an extracted WhatsApp
      // export folder keeps its mark whatever it's renamed to.
      isWhatsApp: waByPath[dir.path] === true,
      scanTagged: !!localFolder && isScanTagged(scanTags, `${scanRel(localFolder, dir.path)}/`),
      // In flight (renamed, moved or created, the disk not done yet) — the
      // workspace dims it and keeps hands off until it settles.
      pending: !!dir._pending || busyPaths.has(normPath(dir.path)),
      _dir: dir,
    };
  });

  // The Recycle bin lives INSIDE the My drafts panel as a special folder at
  // the root — opening it shows the deleted files (with restore / delete-
  // forever + the 30-day countdown). No separate tab.
  // Count bin contents the way they're shown: a deleted folder is ONE item, not
  // each file inside it (matching the collapsed folder display below).
  const trashDisplayCount = (() => {
    const groups = new Set();
    let loose = 0;
    for (const t of viewTrashItems) {
      if (t.folderGroup) groups.add(t.folderGroup);
      else loose += 1;
    }
    return groups.size + loose;
  })();
  // The special entries carry real metrics like any folder: total size of
  // their contents, and — since neither has a filesystem mtime of its own —
  // the PROJECT's creation date as their date column.
  const projectCreatedLabel = selectedProject?.created_at ? formatDate(selectedProject.created_at) : '';
  const trashBytes = viewTrashItems.reduce((sum, t) => sum + (Number(t.sizeBytes) || 0), 0);
  const binEntryItem = {
    id: '__recycle-bin',
    kind: 'folder',
    name: 'Trash',
    empty: viewTrashItems.length === 0,
    status: 'synced',
    binEntry: true,
    binCount: trashDisplayCount,
    sizeLabel: viewTrashItems.length > 0 ? formatBytes(trashBytes) : '',
    modifiedLabel: projectCreatedLabel,
  };
  const toDraftItem = (lf) => {
    // The parts that depend only on the listed file itself are worked out once
    // per listing entry (the page re-renders on every scan tick and
    // notification, and rebuilt these for every file in the folder each time).
    let fixed = DRAFT_FIXED.get(lf);
    if (!fixed) {
      // A Data collection wears its own glyph (extCategory 'collection').
      const isDvc = isCollectionFile(lf.name);
      fixed = {
        ext: fileExtOf(lf.name),
        sizeLabel: lf.sizeBytes != null ? formatBytes(lf.sizeBytes) : '',
        modifiedLabel: formatDate(lf.mtimeIso),
        sortTime: lf.mtimeIso ? Date.parse(lf.mtimeIso) || 0 : 0,
        descriptor: isDvc ? null : describeLocalFile({ localFile: lf }),
      };
      DRAFT_FIXED.set(lf, fixed);
    }
    return {
      // The index Row's portable id (survives rename / move); the path for a
      // file the index hasn't reached yet, or without the index.
      id: lf.id || lf.path || lf.name,
      kind: 'file',
      name: lf.name,
      ext: fixed.ext,
      sizeLabel: fixed.sizeLabel,
      modifiedLabel: fixed.modifiedLabel,
      sortTime: fixed.sortTime,
      sortSize: Number(lf.sizeBytes) || 0,
      author: 'You',
      status: 'synced',
      // Content-probed verdict for .zip archives and loose .txt transcripts
      // (true/false once resolved; undefined while pending / for other types →
      // FilesWorkspace falls back to its name heuristic until the probe lands).
      isWhatsApp: lf.path ? waByPath[lf.path] : undefined,
      descriptor: fixed.descriptor,
      scanTagged: !!localFolder && isScanTagged(scanTags, scanRel(localFolder, lf.path || lf.name)),
      hasText: !!lf.path && hasTextOf.has(lf.path),
      pending: !!lf._pending || busyPaths.has(normPath(lf.path)),
      _raw: lf,
    };
  };
  const draftItems = browseFiles.map(toDraftItem);

  // Waiting phone files whose destination is the folder on show, first.
  const samePath = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
  const incomingItems = incoming.filter((p) => samePath(p.dir, currentDir)).map((p) => ({
    id: `incoming:${p.id}`,
    kind: 'file',
    name: p.name,
    ext: fileExtOf(p.name),
    sizeLabel: fmtIncomingBytes(p.size),
    modifiedLabel: 'From your phone',
    sortTime: p.at || 0,
    sortSize: Number(p.size) || 0,
    status: 'synced',
    incoming: true,
    incomingId: p.id,
    descriptor: describeLocalFile({ localFile: { path: p.path, name: p.name } }),
    _raw: { path: p.path, name: p.name },
  }));
  const fxIncoming = async (item, action) => {
    const ids = [item.incomingId];
    const accept = action === 'accept';
    let done = 0;
    for (const id of ids) {
      const res = await decideIncoming(id, accept);
      if (res?.ok) done += 1;
    }
    if (done < ids.length) {
      notify({ category: 'file', variant: 'error', title: accept ? 'Couldn’t add the file' : 'Couldn’t reject the file', body: 'It is still waiting — try again.', dedupeKey: `phone-upload-fail:${Date.now()}` });
    } else if (accept) {
      notify({
        category: 'file', variant: 'success', icon: 'check', silent: true,
        title: ids.length > 1 ? `${ids.length} files added from your phone` : 'Added from your phone',
        body: ids.length > 1 ? 'They are in this folder now.' : `“${item.name}” is in this folder now.`,
        payload: { activity: { action: 'phone-upload', fileName: item.name } },
      });
    }
  };

  // The listing is exactly what's in the folder. Files referenced by the case
  // timeline but stored elsewhere on disk are NOT surfaced here — they'd read
  // as project files that aren't in the project directory. The timeline's own
  // file chips (ProjectEvents) still open them from wherever they live.

  // Surface the bin as the first item in every folder (it opens the one
  // project-wide view regardless of where you are in the tree).
  // The COLLECTIONS stand at the project's root, after the Trash: a custom
  // icon each (FilesWorkspace CollectionGlyph), opened into their own page.
  // Its first four files, for the tile's 2×2 grid of thumbnails.
  const localByRel = new Map();
  if (!folderStack.length && fileGroups.length) {
    for (const lf of viewLocalFiles) {
      const r = typeof lf?.path === 'string' ? relOfPath(localFolder, lf.path) : null;
      if (r) localByRel.set(r, lf);
    }
  }
  const groupEntries = folderStack.length ? [] : fileGroups.map((c) => ({
    previewItems: c.rels.map((r) => localByRel.get(r)).filter(Boolean).slice(0, 4).map(toDraftItem),
    id: `collection:${c.id}`,
    kind: 'folder',
    name: c.name,
    empty: !c.rels.length,
    status: 'synced',
    collectionEntry: true,
    collectionId: c.id,
    binCount: c.rels.length,
    sizeLabel: `${c.rels.length} file${c.rels.length === 1 ? '' : 's'}`,
    modifiedLabel: c.at ? formatDate(new Date(c.at).toISOString()) : '',
    sortTime: c.at || 0,
  }));
  const draftFolders = [binEntryItem, ...groupEntries, ...realDraftFolders];

  // Files deleted as part of a folder share a `folderGroup`; collapse each
  // group into ONE folder item (Windows-style) so the bin shows the deleted
  // folder, not every file inside it. Loose files stay individual.
  const binFolderItems = [];
  const binFileItems = [];
  const trashGroups = new Map();
  for (const t of viewTrashItems) {
    if (t.folderGroup) {
      if (!trashGroups.has(t.folderGroup)) trashGroups.set(t.folderGroup, []);
      trashGroups.get(t.folderGroup).push(t);
      continue;
    }
    const synthetic = { name: t.originalName, path: t.path, mimeType: t.mimeType, mtimeIso: t.deletedAt };
    binFileItems.push({
      id: t.stored,
      kind: 'file',
      name: t.originalName,
      ext: fileExtOf(t.originalName),
      sizeLabel: t.sizeBytes != null ? formatBytes(t.sizeBytes) : '',
      modifiedLabel: formatDate(t.deletedAt),
      sortTime: t.deletedAt ? Date.parse(t.deletedAt) || 0 : 0,
      sortSize: Number(t.sizeBytes) || 0,
      author: 'You',
      status: 'deleted',
      deletesInDays: daysUntilPurge(t.deletedAt),
      descriptor: describeLocalFile({ localFile: synthetic }),
      _raw: synthetic,
      _trash: t,
    });
  }
  for (const [gid, recs] of trashGroups) {
    const first = recs[0];
    const totalBytes = recs.reduce((sum, r) => sum + (r.sizeBytes || 0), 0);
    binFolderItems.push({
      id: `trashgroup:${gid}`,
      kind: 'folder',
      name: first.folderName || 'Folder',
      empty: recs.length === 0,
      status: 'deleted',
      deletesInDays: daysUntilPurge(first.deletedAt),
      sizeLabel: formatBytes(totalBytes),
      modifiedLabel: formatDate(first.deletedAt),
      // The underlying trash records, for whole-folder restore / delete-forever.
      _trashGroup: recs,
    });
  }

  // Breadcrumb. In the bin view, the crumb chain is Home › Trash (clicking
  // Home exits back to drafts).
  const openGroup = openGroupId ? fileGroups.find((c) => c.id === openGroupId) || null : null;
  // The project's files by their path inside it — what a collection points at.
  const projectFileItems = () => {
    const map = new Map();
    for (const lf of viewLocalFiles) {
      if (typeof lf?.path !== 'string') continue;
      const rel = relOfPath(localFolder, lf.path);
      if (!rel || rel.split('/').some((seg) => seg.startsWith('.'))) continue;
      map.set(rel, toDraftItem(lf));
    }
    return map;
  };
  // AN OPEN COLLECTION is drawn BY THE FILES GRID ITSELF: its files are the
  // grid's items (so clicking, double-clicking, the right-click menu, multi-
  // select, the rubber band, drag and drop, the keys, rename and delete behave
  // exactly as anywhere in Files), laid out in SECTIONS (`collectionLayout`,
  // ids per section): Duplicates and Linked files — every group on its own
  // ground — then the other files. A file in two sections is two items
  // (`<section>:<id>`). Its menu adds "Remove from collection".
  let collectionItems = null;
  let collectionLayout = null;
  if (openGroup && filesTab === 'drafts') {
    const byRel = projectFileItems();
    const present = openGroup.rels.filter((r) => byRel.has(r));
    // The pairs re-checked just now, else the ones it was made with.
    const graphNow = groupGraph.key.startsWith(`${openGroup.id}|`) && groupGraph.pairs.length ? groupGraph : { pairs: openGroup.pairs || [] };
    const { sections: kinds, loose, why } = clustersOf(present, graphNow);
    collectionItems = [];
    const mk = (sec, rel, tie) => {
      const base = byRel.get(rel);
      const it = { ...base, id: `${sec}:${base.id}`, tie, collectionRel: rel, collectionId: openGroup.id };
      collectionItems.push(it);
      return it.id;
    };
    const sections = kinds.map(({ kind, groups }) => ({
      key: kind,
      label: SAME_KINDS[kind].label,
      icon: SAME_KINDS[kind].icon,
      boxed: true,
      tie: { label: SAME_KINDS[kind].tie, tone: SAME_KINDS[kind].tone },
      groups: groups.map((g) => g.map((r) => mk(kind[0], r, { why: why.get(`${kind}|${r}`) || '' }))),
    }));
    if (loose.length) {
      sections.push({ key: 'files', label: sections.length ? 'Other files' : 'Files', icon: 'file-doc', boxed: false, groups: [loose.map((r) => mk('f', r, null))] });
    }
    const counts = kinds.map(({ kind, groups }) => `${groups.length} ${kind === 'exact' ? `set${groups.length === 1 ? '' : 's'} of exact duplicates` : kind === 'content' ? `set${groups.length === 1 ? '' : 's'} with the same content` : `document${groups.length === 1 ? '' : 's'} in parts`}`);
    const missing = openGroup.rels.length - present.length;
    collectionLayout = {
      id: openGroup.id,
      name: openGroup.name,
      sub: [
        `${present.length} file${present.length === 1 ? '' : 's'}`,
        ...counts,
        openGroup.source === 'ai' ? 'grouped by DocVex' : '',
        missing ? `${missing} no longer in the project` : '',
      ].filter(Boolean).join(' · '),
      sections,
    };
  }

  // COLLECT (the footer): the selected items become ONE collection (a folder
  // brings everything under it); with nothing selected, the NEURAL NETWORK
  // groups the project — the scan's typed links between files (lib/
  // dataCollections loadScanGraph) and the duplicate files (identical bytes, or
  // one name with a copy mark), joined into connected groups, each named after
  // the Data collection covering most of it (lib/fileGroups proposeGroups).
  const fxCollect = async (selected = []) => {
    if (!localFolder || collectBusy) return;
    const relOf = (path) => relOfPath(localFolder, path);
    if (selected.length) {
      const rels = new Set();
      for (const it of selected) {
        if (it.collectionEntry || it.binEntry || it.incoming) continue;
        if (it.kind === 'folder' && it._dir?.path) {
          const base = relOf(it._dir.path);
          for (const lf of viewLocalFiles) {
            const r = relOf(lf.path);
            if (r && base != null && (base === '' || r.startsWith(`${base}/`))) rels.add(r);
          }
        } else if (it._raw?.path) {
          const r = relOf(it._raw.path);
          if (r) rels.add(r);
        }
      }
      if (!rels.size) return;
      const n = fileGroups.length + 1;
      addFileGroups(localFolder, [{ name: `Collection ${n}`, rels: [...rels], source: 'manual' }]);
      notify({ category: 'file', variant: 'success', title: 'Collection made', body: `${rels.size} file${rels.size === 1 ? '' : 's'} grouped in “Collection ${n}” — at the top of Home. Right-click it to rename.`, dedupeKey: 'fx-collect' });
      return;
    }
    setCollectBusy(true);
    try {
      const all = viewLocalFiles.map((lf) => groupFileOf(localFolder, lf)).filter((f) => f && !isCollectionFile(f.name));
      const pairs = await findSamePairs(all, await groupingDeps());
      const exists = new Set(fileGroups.flatMap((c) => c.rels));
      const byRel = new Map(all.map((f) => [f.rel, f]));
      const titleOf = (rel) => {
        const f = byRel.get(rel);
        const u = f ? getAiFacet(f.path, 'understanding')?.data : null;
        if (!u) return '';
        const who = u.idDocument?.holder || u.subject || '';
        return [u.documentType, who].filter(Boolean).join(' — ').slice(0, 80);
      };
      const proposals = proposeGroups({ pairs, exists, titleOf });
      if (!proposals.length) {
        notify({
          category: 'file', variant: 'info', title: 'Nothing new to group',
          body: 'No exact duplicates, no files with the same content in another format and no documents in several parts were found that aren’t already in a collection.',
          dedupeKey: 'fx-collect',
        });
        return;
      }
      addFileGroups(localFolder, proposals.map((g) => ({ ...g, source: 'ai' })));
      const n = (k) => proposals.filter((g) => g.kind === k).length;
      notify({
        category: 'file', variant: 'success', title: `${proposals.length} collection${proposals.length === 1 ? '' : 's'} made`,
        body: [n('exact') && `${n('exact')} of exact duplicates`, n('content') && `${n('content')} of the same content in other formats`, n('document') && `${n('document')} of one document in parts`].filter(Boolean).join(', ') + ' — at the top of Home.',
        dedupeKey: 'fx-collect',
      });
    } catch (e) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t make collections', body: e?.message || 'Something went wrong while grouping the files.', dedupeKey: 'fx-collect' });
    } finally {
      setCollectBusy(false);
    }
  };

  const fxCrumbs = filesTab === 'trash'
    ? [
        { label: 'Home', path: '__drafts' },
        { label: 'Trash', path: '__bin' },
      ]
    : [
        { label: 'Home', path: '__root' },
        ...folderStack.map((seg, i) => ({ label: seg.name, path: `__stack:${i}` })),
        ...(openGroup ? [{ label: openGroup.name, path: '__collection' }] : []),
      ];
  const fxCanUp = filesTab !== 'drafts' ? true : (folderStack.length > 0 || !!openGroup);

  // ── Workspace action handlers ─────────────────────────────────────────
  const fxOpen = (item) => {
    if (item.binEntry) { setFilesTab('trash'); return; }        // open the recycle bin
    if (item.collectionEntry) { setOpenGroupId(item.collectionId); return; } // open a collection
    if (item.kind === 'folder') {
      // Double-clicking any folder — including a WhatsApp export — browses its
      // contents. The export's reconstructed conversation is reachable from the
      // right-click menu's "Open conversation" instead.
      if (item._dir) handleEnterFolder(item._dir);
      return;
    }
    // Data collections (the AI scan's `.dvc` files) open in the Doc Viewer as
    // what the AI gathered, not the JSON they are stored as.
    if (isCollectionFile(item.name)) { openCollectionInViewer(item._raw); return; }
    handleOpenLocalFile(item._raw);
  };
  // The menu's "Open content(s)". For a folder it browses the files (bypassing
  // the WhatsApp conversation a WhatsApp export folder opens by default). For a
  // compressed file it unpacks the archive: a .zip extracts to a sibling folder
  // we then navigate into; other formats open in the OS archiver.
  const fxOpenContent = async (item) => {
    if (item?._dir) {
      // A WhatsApp export folder's menu entry opens the reconstructed
      // conversation (double-click now browses instead).
      if (item.isWhatsApp && item._dir.path) { handleOpenWhatsAppFolder(item._dir); return; }
      handleEnterFolder(item._dir);
      return;
    }
    const src = item?._raw?.path;
    if (!src) return;
    const res = await primExtractArchive(src);
    if (!res.ok) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t open the archive', body: res.error || 'The compressed file could not be opened.', dedupeKey: 'fx-extract-fail' });
      return;
    }
    // Handed to the OS archiver — nothing landed in this folder.
    if (!res.extracted || !res.path) return;
    // Select the new folder rather than navigating into it: extracting is a
    // step in whatever you were doing here, not a reason to leave the folder.
    const folderName = res.path.split(/[\\/]/).pop();
    setSelectTargetPath(res.path);
    notify({ category: 'file', variant: 'success', icon: 'folder-plus', title: 'Archive extracted', body: `“${item.name}” unpacked into “${folderName}”.`, silent: true, payload: actMeta('create-folder', folderName, { folder: true }) });
    // Undoable only when the extract CREATED the folder. If it already existed
    // we merged into it, and we can't tell the archive's files apart from the
    // ones that were already there — so an "undo" would delete someone's work.
    if (!res.created) return;
    const state = { path: res.path, stored: [] };
    pushAction({
      label: `Extract “${item.name}”`,
      // Undo bins the folder (30-day recycle bin) rather than deleting it, so
      // even a failed redo can't lose the extracted files.
      undo: async () => {
        const r = await primTrashFolder(state.path);
        if (r.ok) state.stored = r.stored;
        return r.ok;
      },
      // Prefer restoring what undo binned — faster than unpacking again, and it
      // brings back anything the user had added to the folder meanwhile.
      redo: async () => {
        if (state.stored.length) return primRestoreMany(state.stored);
        const r = await primExtractArchive(src);
        if (r.ok && r.path) state.path = r.path;
        return r.ok;
      },
    });
  };
  const fxCrumbNav = (path) => {
    if (path === '__drafts') { setFilesTab('drafts'); return; } // leave the bin
    if (path === '__bin' || path === '__collection') return;
    if (openGroup) setOpenGroupId(null);
    if (path === '__root') handleNavigateCrumb(-1);
    else if (typeof path === 'string' && path.startsWith('__stack:')) handleNavigateCrumb(Number(path.slice(8)));
  };
  const fxUp = () => {
    if (filesTab !== 'drafts') { setFilesTab('drafts'); return; }
    if (openGroup) { setOpenGroupId(null); return; }
    handleNavigateCrumb(folderStack.length - 2);
  };
  const fxRename = (item, newName) => {
    if (item?.pending) return;
    if (item?.collectionEntry) { renameFileGroup(localFolder, item.collectionId, newName); return; }
    if (item.kind === 'folder') { if (item._dir?.name) handleRenameFolder(item._dir, (newName || '').trim()); return; }
    handleRenameLocalFile(item._raw, newName);
  };
  const fxDelete = (item) => {
    // A collection: the grouping goes, never a file.
    if (item?.collectionEntry) { removeFileGroup(localFolder, item.collectionId); return; }
    // A waiting phone file isn't a project file yet: "delete" means reject it.
    if (item?.incoming) { fxIncoming(item, 'reject'); return; }
    // Already on its way somewhere (renamed, moved, created) — hands off.
    if (item?.pending) return;
    if (filesTab === 'trash') {
      if (item?._trashGroup) { handlePermanentDeleteGroup(item); return; }
      handlePermanentDelete(item._trash);
      return;
    }
    if (item.kind === 'folder') { if (item._dir) handleDeleteFolder(item._dir); return; }
    handleDeleteLocalCard(item._raw);
  };
  const fxRestore = (item) => {
    if (item?._trashGroup) { handleRestoreGroup(item); return; }
    if (item?._trash) handleRestoreFromTrash(item._trash);
  };
  // Multi-selection delete / restore — one batch, one notification (the
  // single-item paths above stay as they were for a lone item).
  const fxDeleteMany = (items) => {
    const list = (items || []).filter(Boolean);
    if (list.length <= 1) { if (list[0]) fxDelete(list[0]); return; }
    // Waiting phone files aren't project files: each is rejected on its own.
    list.filter((it) => it.incoming).forEach((it) => fxIncoming(it, 'reject'));
    const rest = list.filter((it) => !it.incoming && !it.pending);
    if (filesTab === 'trash') handlePermanentDeleteMany(rest);
    else handleDeleteMany(rest);
  };
  const fxRestoreMany = (items) => {
    const list = (items || []).filter(Boolean);
    if (list.length <= 1) { if (list[0]) fxRestore(list[0]); return; }
    handleRestoreMany(list);
  };
  const fxOpenLocation = (item) => {
    const p = item?.kind === 'folder' ? item?._dir?.path : item?._raw?.path;
    if (p) localFolderApi.showInFolder(p);
  };
  const fxNewFolder = (name) => {
    if (!localFolder) { notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then you can organise it.', dedupeKey: 'fx-newfolder-nofolder' }); return; }
    const trimmed = (name || '').trim();
    if (trimmed) handleCreateFolder(trimmed);
  };
  // New file → create an empty file of the named type on disk, then open it in a
  // Doc Viewer window with the AI generator armed, so the user can describe what
  // they want in the advisor and have Claude fill the document.
  const fxNewFile = async (name) => {
    if (!localFolder) { notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then you can create files in it.', dedupeKey: 'fx-newfile-nofolder' }); return; }
    const filename = (name || '').trim();
    if (!filename) return;
    // Don't assume a type. If the user typed a recognised extension, honour it;
    // otherwise create a "wildcard" placeholder with no extension — the AI
    // advisor infers the real kind from what the user describes and renames the
    // file to the matching extension when it generates the document.
    const kind = docKindFromName(filename);
    const dir = currentDir;
    // The new file shows at once, dimmed, while its empty document is built
    // and written.
    const ids = beginOps([{ type: 'add', isDir: false, path: joinPath(dir, filename), entry: { sizeBytes: 0, mtimeIso: new Date().toISOString() } }]);
    try {
      const blob = kind ? await emptyDocumentBlob(kind) : new Blob([''], { type: 'application/octet-stream' });
      const { results, error } = await callDisk(() => localFolderApi.writeFiles({ dir, files: [{ filename, blob }] }));
      const res = results?.[0];
      if (error || !res?.ok || !res?.path) {
        endOps(ids);
        notify({ category: 'file', variant: 'error', title: `Couldn’t create “${filename}”`, body: error || res?.error || 'The file could not be written in this folder.', dedupeKey: 'fx-newfile-error' });
        return;
      }
      await settleOps(ids, { dirs: [dir], expect: [res.path] });
      notify({ category: 'file', variant: 'success', icon: 'plus', title: 'File created', body: `“${filename}” added to this folder.`, silent: true, payload: actMeta('create', filename, { filePath: res.path }) });
      // A brand-new file must start with a clean AI thread — drop any stale
      // conversation saved at this exact path by a previous, since-renamed file
      // (e.g. an earlier "Untitled" that became "Untitled.docx"). Without this,
      // the new file would load the old file's chat history.
      clearConversation(res.path);
      // Leave the new file in place (selected for rename) — don't auto-open a
      // Doc Viewer window. The user opens it themselves when ready.
    } catch (err) {
      endOps(ids);
      notify({ category: 'file', variant: 'error', title: 'Couldn’t create file', body: err?.message || String(err), dedupeKey: 'fx-newfile-error' });
    }
  };
  // ── Data collections ──────────────────────────────────────────────────
  // What the AI gathered about one subject (lib/dataCollections) — made only
  // by the AI scan; opened in the Doc Viewer.
  // Nothing here is edited in a dialog: a record is a file, so creating one
  // writes a blank record and opens it in the Doc Viewer — the same place an
  // existing identity opens, and where it is actually filled in.
  const openCollectionInViewer = (raw) => {
    if (!raw?.path) return;
    openDocViewerWindow({ path: raw.path, name: raw.name, mime: 'application/json' });
  };

  // The AI scan: read every file in the project (text, a picture's text, an
  // audio or video file's captions), have the AI understand each one, connect
  // them into Data collections. A second run only reads what is new or changed
  // since — with nothing new it costs nothing. One progress toast, updated.
  // `opts` (the scan button's card): `features` — which kinds of file are read
  // and which steps run (lib/dataCollections SCAN_FEATURES); `force` — read
  // and understand everything again.
  const fxScanFiles = async (opts = {}) => {
    if (isScanRunning(filesScan)) { requestScanStop(localFolder); return; }   // pressed again = stop
    if (!localFolder) {
      notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then the AI can scan it.', dedupeKey: 'fx-scan-nofolder' });
      return;
    }
    // The folder this scan belongs to — fixed now, whatever the page shows
    // later (it may be left, or switched to another project).
    const scanDir = localFolder;
    clearScanStop(scanDir);
    const setFilesScan = (next) => setScanState(scanDir, next);
    // How it ended — the gauges jump to 100% or drop back and say so for a
    // moment (lib/scanRunner finishScan); null = nothing to show (not started).
    let outcome = null;
    const say = (body, extra = {}) => notify({
      category: 'file', variant: 'info', icon: 'sparkles', title: 'Scanning the files', body,
      dedupeKey: 'fx-files-scan', dedupeStrategy: 'replace', persistent: true, ...extra,
    });
    const STAGE = {
      list: () => 'Listing the files…',
      read: (p) => `Reading ${p.index + 1} of ${p.total} — \u201c${p.name}\u201d…`,
      understand: (p) => `Understanding the files — ${Math.min(p.index + 1, p.total)} of ${p.total}…`,
      connect: (p) => (p.incremental ? `Fitting ${p.total} new file${p.total === 1 ? '' : 's'} into the collections…` : 'Connecting what the files say…'),
      faces: (p) => (p.total ? `Comparing faces with the identity documents — ${p.index + 1} of ${p.total} (on this computer)…` : 'Comparing faces with the identity documents (on this computer)…'),
      links: (p) => (p.total ? `Cross-referencing the files — ${Math.min(p.index + 1, p.total)} of ${p.total} group${p.total === 1 ? '' : 's'}…` : 'Cross-referencing the files…'),
      save: () => 'Writing the data collections…',
    };
    setFilesScan({ stage: 'list', overall: 0, startedAt: Date.now() });
    say(STAGE.list());
    try {
      const { scanProjectFiles } = await import('../../lib/dataCollections');
      const tags = loadScanTags(scanDir);
      if (!tags.size) {
        notify({ category: 'file', variant: 'info', icon: 'sparkles', title: 'Tag files for the scan first', body: 'Right-click a file or a folder and choose \u201cTag for AI scan\u201d. Only tagged files are scanned; they show the AI mark.', dedupeKey: 'fx-files-scan', dedupeStrategy: 'replace' });
        return;
      }
      const res = await scanProjectFiles(scanDir, {
        tags,
        projectId,
        projectName: selectedProject?.name,
        features: opts.features,
        force: !!opts.force,
        isCancelled: () => scanStopRequested(scanDir),
        // The scan button's gauges read this: the latest event, plus what is
        // kept across events (when it started, how many files there are).
        onProgress: (p) => {
          setFilesScan((prev) => ({
            ...p,
            startedAt: prev?.startedAt || Date.now(),
            files: p.stage === 'read' ? p.total : prev?.files,
            done: p.done ?? prev?.done,
            skipped: p.skipped ?? prev?.skipped,
            understood: p.understood ?? prev?.understood,
          }));
          // Files that needed no work pass silently (no toast per file).
          if (p.quiet) return;
          const line = STAGE[p.stage]?.(p); if (line) say(line);
        },
      });
      const WHY = {
        timed_out: 'took too long \u2014 tried again next scan', no_speech: 'no speech in it', no_text: 'no text in it', too_large: 'too large', no_captions: 'no captions saved for it', decode_failed: 'the picture couldn\u2019t be opened',
        unsupported: 'this file type can\u2019t be read', ocr_failed: 'the AI service couldn\u2019t be reached', ai_failed: 'the AI couldn\u2019t understand it',
      };
      const skippedNote = res.skipped?.length
        ? ` Skipped ${res.skipped.length}: ${res.skipped.slice(0, 4).map((k) => `\u201c${k.name}\u201d (${WHY[k.error] || k.error || 'unreadable'})`).join('; ')}${res.skipped.length > 4 ? '\u2026' : ''}.`
        : '';
      if (res.error) {
        const body = {
          cancelled: 'The scan was stopped. What was read so far is kept, so the next scan picks up from there.',
          none_tagged: 'None of the tagged files are in this project any more. Tag files for the scan and try again.',
          empty: 'There are no files in this project to scan.',
          nothing_read: `None of the files could be read.${skippedNote}`,
          no_folder: 'No project folder is connected.',
        }[res.error] || `${res.error}${skippedNote}`;
        notify({ category: 'file', variant: res.error === 'cancelled' ? 'info' : 'error', title: res.error === 'cancelled' ? 'Scan stopped' : 'Couldn\u2019t scan the files', body, dedupeKey: 'fx-files-scan', dedupeStrategy: 'replace' });
        outcome = res.error === 'cancelled' ? 'cancelled' : 'error';
        return;
      }
      outcome = 'ok';
      setBrowseTick((t) => t + 1);
      await refetchLocalFiles();
      const faceNote = (res.faceMatches ? ` ${res.faceMatches} face match${res.faceMatches === 1 ? '' : 'es'} with identity documents.` : '')
        + (res.links ? ` ${res.links} link${res.links === 1 ? '' : 's'} between files.` : '')
        + (res.linkErrors?.length ? ` Some files couldn\u2019t be cross-referenced (${res.linkErrors[0]}) \u2014 the next scan tries again.` : '');
      const body = res.upToDate && !res.created && !res.updated
        ? `Nothing new since the last scan \u2014 the ${res.collections.length} data collection${res.collections.length === 1 ? ' is' : 's are'} up to date.${faceNote}`
        : [
          res.created ? `${res.created} new data collection${res.created === 1 ? '' : 's'}` : '',
          res.updated ? `${res.updated} updated` : '',
          res.removed ? `${res.removed} removed` : '',
        ].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase()) + `${res.read ? ` from ${res.read} file${res.read === 1 ? '' : 's'} read` : ''}.${faceNote}${skippedNote}`;
      notify({
        category: 'file', variant: 'success', icon: 'sparkles', title: 'Files scanned', body,
        dedupeKey: 'fx-files-scan', dedupeStrategy: 'replace',
        payload: actMeta('create', `${res.collections.length} data collections`, { filePath: res.collections[0]?.path }),
      });
    } catch (err) {
      notify({ category: 'file', variant: 'error', title: 'Couldn\u2019t scan the files', body: err?.message || String(err), dedupeKey: 'fx-files-scan', dedupeStrategy: 'replace' });
      if (!outcome) outcome = 'error';
    } finally {
      finishScan(scanDir, outcome);
      clearScanStop(scanDir);
    }
  };

  // ERASE THE SCAN'S MEMORY (the scan card's Erase memory): the Data
  // collections go to the Trash, the links and the web index are wiped and
  // what the AI understood of each file is forgotten. What was READ out of the
  // files (extracted text, captions) is kept, so the next scan reads nothing
  // again — it only asks the AI again.
  const fxEraseScanMemory = async () => {
    if (isScanRunning(filesScan) || !localFolder) return;
    try {
      const { eraseScanMemory } = await import('../../lib/dataCollections');
      const res = await eraseScanMemory(localFolder, { projectId });
      if (res.error) throw new Error(res.error);
      setBrowseTick((t) => t + 1);
      await refetchLocalFiles();
      notify({
        category: 'file', variant: 'success', icon: 'sparkles', title: 'Scan memory erased',
        body: `${res.collections} data collection${res.collections === 1 ? '' : 's'} moved to the Trash; the links and what the AI understood of ${res.understood} file${res.understood === 1 ? '' : 's'} forgotten. The text read out of the files is kept.`,
        dedupeKey: 'fx-files-scan', dedupeStrategy: 'replace',
      });
    } catch (err) {
      notify({ category: 'file', variant: 'error', title: 'Couldn\u2019t erase the scan memory', body: err?.message || String(err), dedupeKey: 'fx-files-scan', dedupeStrategy: 'replace' });
    }
  };

  // Tag / untag items for the AI scan. A folder is tagged as a whole (every
  // file under it, now and later); untagging a file inside a tagged folder
  // keeps just that file out.
  const fxToggleScanTag = (items, on) => {
    if (!localFolder) return;
    const rels = (items || []).map((it) => {
      const path = it?._raw?.path || it?._dir?.path;
      if (!path) return '';
      const rel = scanRel(localFolder, path);
      return it.kind === 'folder' ? `${rel}/` : rel;
    }).filter(Boolean);
    if (!rels.length) return;
    setScanTagsState(setScanTags(localFolder, rels, on));
  };

  // Create new <type> file → write an empty styled Office file of the chosen kind
  // (docx / pptx / xlsx) to disk, then open it in a Doc Viewer window with the AI
  // generator armed (generate:true) so the user describes what they want and
  // The toolbar's "Highlights sample": a Word document holding every highlight
  // the file viewer draws (lib/highlightsSample), written into the folder on
  // show under a free name — never over a file — and selected.
  const fxAddHighlightsSample = async () => {
    if (!localFolder) { notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then you can add the sample to it.', dedupeKey: 'fx-hlsample-nofolder' }); return; }
    const { buildHighlightsSampleDocx, HIGHLIGHTS_SAMPLE_NAME } = await import('../../lib/highlightsSample');
    const existing = new Set((viewLocalFiles || []).map((f) => String(f.name || '').toLowerCase()));
    const stem = HIGHLIGHTS_SAMPLE_NAME.replace(/\.docx$/i, '');
    let filename = HIGHLIGHTS_SAMPLE_NAME;
    for (let n = 2; existing.has(filename.toLowerCase()); n += 1) filename = `${stem} (${n}).docx`;
    const dir = currentDir;
    const ids = beginOps([{ type: 'add', isDir: false, path: joinPath(dir, filename), entry: { sizeBytes: 0, mtimeIso: new Date().toISOString() } }]);
    try {
      const blob = await buildHighlightsSampleDocx();
      const { results, error } = await callDisk(() => localFolderApi.writeFiles({ dir, files: [{ filename, blob }] }));
      const res = results?.[0];
      if (error || !res?.ok || !res?.path) {
        endOps(ids);
        notify({ category: 'file', variant: 'error', title: 'Couldn’t add the highlights sample', body: error || res?.error || 'The file could not be written in this folder.', dedupeKey: 'fx-hlsample-error' });
        return;
      }
      await settleOps(ids, { dirs: [dir], expect: [res.path] });
      notify({ category: 'file', variant: 'success', icon: 'plus', title: 'Highlights sample added', body: `“${filename}” — open it to see every highlight.`, silent: true, payload: actMeta('create', filename, { filePath: res.path }) });
    } catch (err) {
      endOps(ids);
      notify({ category: 'file', variant: 'error', title: 'Couldn’t add the highlights sample', body: String(err?.message || err), dedupeKey: 'fx-hlsample-error' });
    }
  };

  // Claude builds it. Uses a unique "Untitled" name so repeated creates don't
  // collide. Backs the "Create new file" dropdown in the Files toolbar.
  const fxCreateTypedFile = async (kind) => {
    if (!localFolder) { notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then you can create files in it.', dedupeKey: 'fx-newfile-nofolder' }); return; }
    // 'auto' (the Create menu's single "Document" entry) makes a "wildcard": an
    // empty file with NO extension. Opening it lands on "What do you want to
    // make?", and the advisor picks Word / PowerPoint / Excel / PDF from what
    // the user asks for, renaming the file to match when it writes it.
    const ext = kind === 'auto' ? '' : (['pptx', 'xlsx', 'pdf'].includes(kind) ? kind : 'docx');
    const suffix = ext ? `.${ext}` : '';
    // Pick the first free "Untitled[ n]" against the current folder listing. A
    // wildcard also steers clear of "Untitled.docx" and friends — it is about
    // to become one of them.
    const existing = new Set((viewLocalFiles || []).map((f) => String(f.name || '').toLowerCase()));
    const taken = (base) => (ext
      ? existing.has(`${base}${suffix}`.toLowerCase())
      : ['', '.docx', '.pptx', '.xlsx', '.pdf'].some((s) => existing.has(`${base}${s}`.toLowerCase())));
    let base = 'Untitled';
    for (let n = 2; taken(base); n += 1) base = `Untitled ${n}`;
    const filename = `${base}${suffix}`;
    const dir = currentDir;
    // Shows at once, dimmed, while the empty document is built and written.
    const ids = beginOps([{ type: 'add', isDir: false, path: joinPath(dir, filename), entry: { sizeBytes: 0, mtimeIso: new Date().toISOString() } }]);
    try {
      // A PDF starts as zero bytes too: it isn't written, it's converted from
      // another file, and an empty file is what makes the viewer ask which.
      const blob = (ext && ext !== 'pdf')
        ? await emptyDocumentBlob(ext)
        : new Blob([''], { type: ext === 'pdf' ? 'application/pdf' : 'application/octet-stream' });
      const { results, error } = await callDisk(() => localFolderApi.writeFiles({ dir, files: [{ filename, blob }] }));
      const res = results?.[0];
      if (error || !res?.ok || !res?.path) {
        endOps(ids);
        notify({ category: 'file', variant: 'error', title: `Couldn’t create “${filename}”`, body: error || res?.error || 'The file could not be written in this folder.', dedupeKey: 'fx-newfile-error' });
        return;
      }
      await settleOps(ids, { dirs: [dir], expect: [res.path] });
      notify({ category: 'file', variant: 'success', icon: 'plus', title: 'File created', body: `“${filename}” added to this folder.`, silent: true, payload: actMeta('create', filename, { filePath: res.path }) });
      // A brand-new file starts with a clean AI thread (drop any stale chat saved
      // at this exact path by a since-renamed file).
      clearConversation(res.path);
      // Don't open it — select the new file and drop into rename mode so the
      // user can name it first (the workspace applies this once it lists).
      setRenameTargetPath(res.path);
    } catch (err) {
      endOps(ids);
      notify({ category: 'file', variant: 'error', title: 'Couldn’t create file', body: err?.message || String(err), dedupeKey: 'fx-newfile-error' });
    }
  };
  const fxUpload = () => {
    if (!localFolder) { handleBrowseFolder(); return; }
    setImportOpen(true);
  };
  // Resolve a breadcrumb path token to its real directory, then move the
  // dragged files there (reuses the same move + undo machinery).
  const fxMoveToCrumb = (crumb, items) => {
    const tokenPath = crumb?.path;
    let dir = null;
    if (tokenPath === '__root') dir = { path: localFolder, name: 'Home' };
    else if (typeof tokenPath === 'string' && tokenPath.startsWith('__stack:')) {
      const seg = folderStack[Number(tokenPath.slice(8))];
      if (seg) dir = { path: seg.path, name: seg.name };
    }
    if (!dir?.path) return;
    handleMoveItems(items, { name: dir.name, _dir: { path: dir.path } });
  };
  const fxUploadFolder = () => {
    if (!localFolder) { handleBrowseFolder(); return; }
    localFolderUploadInputRef.current?.click();
  };

  // Masthead — a Versions-style hero for the Files tab. The eyebrow + kicker
  // describe the FILES (not the project): where they live, how many, how big,
  // and when they last changed. Totals come from the recursive listing.
  // Shown only in the drafts tab (not the recycle bin).
  // The masthead follows the folder you're in: at Home it's the project-wide
  // "Files" hero; inside a subfolder the hero becomes THAT folder (its name
  // as the title, its contents' stats as the kicker, and the containing path
  // as the muted eyebrow tail). Stats scope to everything under the current
  // folder via a path-prefix match on the recursive listing, falling back to
  // the current level's listing when paths can't be matched (web backend).
  const inFolder = folderStack.length > 0;
  const mastheadFiles = (() => {
    if (!inFolder) return viewLocalFiles;
    if (typeof currentDir === 'string' && currentDir) {
      const matches = viewLocalFiles.filter((f) => typeof f.path === 'string'
        && (f.path.startsWith(`${currentDir}\\`) || f.path.startsWith(`${currentDir}/`)));
      if (matches.length) return matches;
    }
    return browseFiles;
  })();
  const fxTotalBytes = mastheadFiles.reduce((sum, f) => sum + (Number(f.sizeBytes) || 0), 0);
  const fxLatestMtime = mastheadFiles.reduce((latest, f) => {
    const t = f.mtimeIso ? new Date(f.mtimeIso).getTime() : 0;
    return t > latest ? t : latest;
  }, 0);
  const fxUpdatedLabel = fxLatestMtime
    ? new Date(fxLatestMtime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const fxKicker = mastheadFiles.length === 0
    ? (inFolder ? 'Empty folder' : 'No files yet — add or import files to get started')
    : [
        `${fmtCount(mastheadFiles.length)} ${mastheadFiles.length === 1 ? 'file' : 'files'}`,
        fmtBytesFull(fxTotalBytes),
        fxUpdatedLabel ? `Updated ${fxUpdatedLabel}` : null,
      ].filter(Boolean).join(' · ');
  // An open COLLECTION names itself in the page's own header (the same
  // masthead a folder gets): its name as the title, what is in it under it.
  const filesMasthead = collectionLayout ? {
    eyebrow: 'Project files',
    access: 'Home › Collection',
    title: collectionLayout.name,
    kicker: collectionLayout.sub,
  } : filesTab === 'drafts' ? (inFolder ? {
    eyebrow: 'Project files',
    // The folder's location — Home plus any folders above it in the stack.
    access: ['Home', ...folderStack.slice(0, -1).map((s) => s.name)].join(' › '),
    title: folderStack[folderStack.length - 1].name,
    kicker: fxKicker,
  } : {
    eyebrow: 'Project files',
    access: 'Stored in your local folder',
    title: 'Files',
    kicker: fxKicker,
  }) : {
    eyebrow: 'Project files',
    access: 'Recycle bin',
    title: 'Trash',
    kicker: trashDisplayCount === 0
      ? 'Trash is empty'
      : `${fmtCount(trashDisplayCount)} ${trashDisplayCount === 1 ? 'item' : 'items'} · Removed for good after ${TRASH_RETENTION_DAYS} days`,
  };

  // See itemReuseRef: hand back last render's item objects / lists when
  // nothing in them changed. One level deep — an item's nested plain objects
  // (its descriptor, its `_raw` listing entry) are compared field by field.
  const sameValue = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
  };
  const sameItem = (a, b) => {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  };
  const reuseList = (slot, list) => {
    const cache = itemReuseRef.current;
    const next = list.map((it) => {
      const prev = it && it.id != null ? cache.items.get(`${slot}:${it.id}`) : null;
      return prev && sameItem(prev, it) ? prev : it;
    });
    for (const it of next) if (it && it.id != null) cache.items.set(`${slot}:${it.id}`, it);
    // Keep the cache to what is on show (plus the other slot's entries).
    if (cache.items.size > next.length * 2 + 400) {
      const keep = new Map();
      for (const [k, v] of cache.items) if (!k.startsWith(`${slot}:`)) keep.set(k, v);
      for (const it of next) if (it && it.id != null) keep.set(`${slot}:${it.id}`, it);
      cache.items = keep;
    }
    const prevList = cache.lists[slot];
    if (prevList && prevList.length === next.length && prevList.every((it, i) => it === next[i])) return prevList;
    cache.lists[slot] = next;
    return next;
  };

  const filesWorkspaceProps = {
    projectId,
    masthead: filesMasthead,
    summaryText: `${viewLocalFiles.length} ${viewLocalFiles.length === 1 ? 'file' : 'files'}`,
    // `tab` ('drafts' | 'trash') is the in-panel mode: 'trash' is the recycle
    // bin, entered by opening its root folder entry and exited via the
    // breadcrumb.
    tab: filesTab,
    canEdit: true,
    hasLocalFolder: Boolean(localFolder),
    // The project's folder is found by its project file; the user is only
    // asked for one when it has gone missing, or the folder picked for it
    // belongs to another project.
    onPickFolder: folderMissing ? handleLinkFolder : undefined,
    pickFolderCopy: folderMissing ? (folderMissing.mismatch ? {
      title: 'This folder belongs to another project',
      body: 'The folder DocVex had for this project holds another project’s file. Show DocVex this project’s own folder.',
      button: 'Choose folder',
    } : {
      title: 'Couldn’t find this project’s folder',
      body: `It was at “${folderMissing.dir}”. If you moved or renamed it, show DocVex where it is now.`,
      button: 'Find the folder',
    }) : null,
    hasLocalFolderApi,
    folderError,
    onRetryFolder: () => setFolderRetry((t) => t + 1),
    crumbs: fxCrumbs,
    onCrumb: fxCrumbNav,
    onBack: fxUp,
    onUp: fxUp,
    canBack: fxCanUp,
    canUp: fxCanUp,
    folders: reuseList('folders', collectionLayout ? [] : filesTab === 'drafts' ? draftFolders : binFolderItems),
    items: reuseList('items', collectionItems || (filesTab === 'drafts' ? [...incomingItems, ...draftItems] : binFileItems)),
    onIncoming: fxIncoming,
    loading: filesTab === 'trash' ? trashLoading : localLoading,
    onOpen: fxOpen,
    onOpenContent: fxOpenContent,
    onRename: (item, ...rest) => { if (!item?.incoming) fxRename(item, ...rest); },
    onDelete: fxDelete,
    onDeleteMany: fxDeleteMany,
    onRestore: fxRestore,
    onRestoreMany: fxRestoreMany,
    onOpenLocation: fxOpenLocation,
    // No toolbar refresh button — the doc-viewer's "Files" chrome has its own
    // refresh (which broadcasts files:changed → relist), and the main Files page
    // auto-refreshes on the disk watcher.
    onRefresh: undefined,
    onNewFolder: fxNewFolder,
    onNewFile: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxNewFile : undefined,
    onCreateTypedFile: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxCreateTypedFile : undefined,
    onAddHighlightsSample: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxAddHighlightsSample : undefined,
    onScanFiles: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxScanFiles : undefined,
    onToggleScanTag: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxToggleScanTag : undefined,
    onEraseScanMemory: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxEraseScanMemory : undefined,
    // The Graph view (File explorer · Graph): what the AI scan read and linked.
    graphSource: (hasLocalFolderApi && localFolder) ? { dir: localFolder, projectId } : null,
    // Collections (lib/fileGroups): the footer's Collect, the open one's page.
    onCollect: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxCollect : undefined,
    collectBusy,
    collectionLayout,
    onRemoveFromCollection: (items) => {
      const byGroup = new Map();
      for (const it of items || []) {
        if (!it?.collectionId || !it.collectionRel) continue;
        if (!byGroup.has(it.collectionId)) byGroup.set(it.collectionId, []);
        byGroup.get(it.collectionId).push(it.collectionRel);
      }
      for (const [id, rels] of byGroup) removeFromFileGroup(localFolder, id, rels);
    },
    onOpenPath: (path, name) => openDocViewerWindow({ path, name: name || String(path).split(/[\\/]/).pop(), mime: '' }),
    scanTaggedCount: scanTags.size,
    scanDir: localFolder || null,
    scanState: filesScan,
    renameTargetPath,
    onRenameTargetConsumed: () => setRenameTargetPath(null),
    selectTargetPath,
    onSelectTargetConsumed: () => setSelectTargetPath(null),
    onUpload: fxUpload,
    onUploadFolder: fxUploadFolder,
    onEmptyBin: handleEmptyBin,
    // DEV-only: seed the bin with items at staggered expiry to preview the
    // countdown rings.
    onDebugSeedTrash: (import.meta.env.DEV && filesTab === 'trash' && Boolean(localFolder))
      ? async () => {
          await localFolderApi.debugSeedTrash({ dir: localFolder, days: [30, 25, 20, 15, 10, 5, 3, 2, 1] });
          setBrowseTick((t) => t + 1);
          await refetchTrash();
        }
      : undefined,
    // Open the current folder in the OS file manager (Electron only).
    onOpenDirectory: (hasLocalFolderApi && currentDir)
      ? () => localFolderApi.openPath(currentDir)
      : undefined,
    // Drag-and-drop import — copies dropped OS files into the current folder.
    // Disabled in the bin and when no folder is bound.
    onDropFiles: (filesTab === 'drafts' && Boolean(localFolder)) ? handleDropFiles : undefined,
    // Copy / paste (footer + Ctrl+C / Ctrl+V) and drag-to-move between folders
    // — drafts only, and only with a bound local folder.
    onPasteItems: (filesTab === 'drafts' && Boolean(localFolder)) ? (items, ...rest) => handlePasteItems((items || []).filter((i) => !i?.incoming), ...rest) : undefined,
    onPasteCut: (filesTab === 'drafts' && Boolean(localFolder)) ? handlePasteCut : undefined,
    onMoveItems: (filesTab === 'drafts' && Boolean(localFolder)) ? (items, target, ...rest) => {
      // Dropped on a COLLECTION: the files join it (nothing moves on disk).
      if (target?.collectionEntry) {
        const rels = (items || []).map((i) => (i?._raw?.path ? relOfPath(localFolder, i._raw.path) : null)).filter(Boolean);
        if (rels.length) addToFileGroup(localFolder, target.collectionId, rels);
        return;
      }
      handleMoveItems((items || []).filter((i) => !i?.incoming), target, ...rest);
    } : undefined,
    onMoveToCrumb: (filesTab === 'drafts' && Boolean(localFolder)) ? fxMoveToCrumb : undefined,
    // Undo / redo (footer buttons + Ctrl+Z / Ctrl+Y).
    onUndo: handleUndo,
    onRedo: handleRedo,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
  };

  return (
    <div className="project-scoped-page project-files-page fx-root">
      <FilesWorkspace {...filesWorkspaceProps} />
      <input
        ref={localUploadInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleLocalFilesPicked}
      />
      {/* Folder import — webkitdirectory/directory are set via the ref callback
          because React doesn't reliably render those non-standard attributes. */}
      <input
        ref={(el) => {
          localFolderUploadInputRef.current = el;
          if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
        }}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleLocalFolderPicked}
      />
      <PhoneUploadModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        dir={currentDir}
        folderLabel={atRoot ? 'Home' : folderStack[folderStack.length - 1]?.name}
        projectId={projectId}
        projectName={selectedProject?.name || ''}
        onPickFromComputer={() => { setImportOpen(false); localUploadInputRef.current?.click(); }}
        onReject={(filePath, fileName) => primTrash(filePath, fileName)}
      />
      {localError && filesTab === 'drafts' && (
        <p className="fx-local-error" role="alert">{localError}</p>
      )}
    </div>
  );
}
