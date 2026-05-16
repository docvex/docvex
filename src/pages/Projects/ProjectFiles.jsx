import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import FileDetailModal from '../../components/FileDetailModal';
import { useUploads } from '../../context/UploadsContext';
import VideoFrameSlideshow from '../../components/VideoFrameSlideshow';
import Tooltip from '../../components/Tooltip';
import {
  listProjectFiles,
  createSignedDownloadUrl,
  subscribeForProject,
} from '../../lib/projectFiles';
import './ProjectScoped.css';
import './ProjectFiles.css';

// Local-folder API only exists in the Electron build (see preload.js).
// The web build hides every local-folder affordance via the same gate.
const localFolderApi = typeof window !== 'undefined' ? window.electronAPI?.localFolder : null;
const hasLocalFolderApi = Boolean(localFolderApi);

// Per-project memory of the user's chosen download folder. Different
// projects naturally sync to different local locations (one to a
// Documents subfolder, another to a OneDrive path) so the key carries
// the project id.
const LOCAL_FOLDER_KEY = (projectId) => `docvex:project-files-local-folder:${projectId}`;

// Active tab preference lives globally (not per-project) so the user's
// chosen view persists across project switches. Cloud is the default
// because that's where the source-of-truth files live; users typically
// start there and only swap to Local to inspect what's on disk.
const ACTIVE_TAB_KEY = 'docvex:project-files-active-tab';

function readCachedActiveTab() {
  try {
    const v = localStorage.getItem(ACTIVE_TAB_KEY);
    if (v === 'cloud' || v === 'local') return v;
  } catch { /* private-mode etc. — fall through */ }
  return 'cloud';
}

// Project-scoped file list. Uploads come in via the global upload
// modal (UploadModal + UploadsContext) — this page doesn't own the
// upload pipeline, it only reads the result. The bottom-right FAB on
// this page opens the modal; drag-and-drop anywhere in the app routes
// through the same modal too. The Realtime subscription on
// `project_files` makes new uploads appear here without an explicit
// callback from the uploader, so this works whether the user uploaded
// while on this page or from any other route. Cross-user uploads from
// other project members also show up live via the same channel.
//
// No delete UI in v1 — the RLS for it exists (admins delete project
// files), so the next iteration is purely a button + a confirm modal.

// MIME → glyph mapping. PDFs / videos / text get distinguishable icons
// so the user can scan the list without reading every filename. Images
// render their actual thumbnail instead, see FileCard below.
const PdfIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <text x="8" y="18" fontSize="6" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
  </svg>
);

const VideoIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
    <polygon points="22 8 16 12 22 16 22 8" />
  </svg>
);

const TextIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="14" y2="17" />
  </svg>
);

const GenericFileIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

// Cloud icon — used on the Cloud tab. Standard cloud silhouette so it
// reads as "files in the cloud" without legend.
const CloudIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.5 19a5.5 5.5 0 0 0 .5-10.97 7 7 0 1 0-13.4 3.5A4.5 4.5 0 0 0 6.5 19z" />
  </svg>
);

// Hard-drive icon — used on the Local tab. Reads as "files on this
// machine" / "on disk" at glance.
const HardDriveIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="22" y1="12" x2="2" y2="12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    <line x1="6" y1="16" x2="6.01" y2="16" />
    <line x1="10" y1="16" x2="10.01" y2="16" />
  </svg>
);

function iconForMime(mime) {
  if (!mime) return GenericFileIcon;
  if (mime === 'application/pdf') return PdfIcon;
  if (mime.startsWith('video/')) return VideoIcon;
  if (mime.startsWith('text/')) return TextIcon;
  return GenericFileIcon;
}

// Top-level visual category for the section a file belongs to in the
// grid. Anything that isn't image/* or video/* falls into 'documents'
// — covers PDFs, text files, and any future Word/Excel/etc. additions
// to the upload allowlist without requiring a fresh case here.
function categorizeMime(mime) {
  const m = mime || '';
  if (m.startsWith('image/')) return 'photos';
  if (m.startsWith('video/')) return 'videos';
  return 'documents';
}

// Section render order. Photos first since they're the most visual /
// most common in a typical project; documents last as the "everything
// else" bucket. Sections with zero items are skipped at render time.
const FILE_SECTIONS = [
  { key: 'photos', title: 'Photos' },
  { key: 'videos', title: 'Videos' },
  { key: 'documents', title: 'Documents' },
];

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Format a number of seconds as M:SS or H:MM:SS for the video
// duration badge. Duplicated between this file and UploadModal.jsx
// (matches the codebase's convention of inlining tiny helpers rather
// than extracting a shared util). Defensive against non-finite inputs.
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n) => n.toString().padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(mins)}:${pad(secs)}`;
  return `${mins}:${pad(secs)}`;
}

// Split a filename into base + extension for the card's display:
// the basename fills the name line and the extension gets pulled out
// into the top-right corner tag. Splits on the LAST dot only — so
// "my.report.v2.pdf" → base "my.report.v2", ext "pdf".
// Edge cases that DON'T get split (return ext: ''):
//   • No dot at all (e.g. "README")
//   • Dot at position 0 (e.g. ".env" — that's the leading-dot
//     convention, not an extension)
//   • Trailing dot (e.g. "name." — the part after is empty)
//   • Extension >8 chars (anything that long is almost certainly part
//     of the name, like "report.final-2026-04" — keeps weird names
//     readable instead of stamping a giant tag in the corner)
function splitNameAndExtension(name) {
  if (!name) return { base: '', ext: '' };
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return { base: name, ext: '' };
  const ext = name.slice(lastDot + 1);
  if (ext.length > 8) return { base: name, ext: '' };
  return { base: name.slice(0, lastDot), ext };
}

// Compact relative-ish date — "today / yesterday / N days ago / Mon DD".
// Keeps the metadata line short and scannable. Falls back to the locale
// date for anything older than a week.
function formatDate(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const now = new Date();
  const diffMs = now - then;
  const oneDay = 24 * 60 * 60 * 1000;
  const dayDiff = Math.floor(diffMs / oneDay);
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return `${dayDiff}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// One file card. Resolution order for the thumbnail visual:
//   1. `thumbnail_path` (new in migration 004) — a sibling _thumb.jpg
//      generated at upload time for images / PDFs / videos. Cheap to
//      fetch (~50 KB), uniform 400×300, exists for any post-migration
//      upload that wasn't text/* and didn't fail generation.
//   2. For images uploaded BEFORE migration 004: fall back to fetching
//      the full image and CSS-scaling it. Wasteful but functional —
//      keeps legacy rows usable until they're re-uploaded.
//   3. Everything else (PDF/video/text with no thumbnail_path; failed-
//      generation rows): MIME-keyed stroke glyph in the gold accent.
//
// Click → `onOpen(file)` hands the row up to the page, which mounts
// FileDetailModal. The previous behavior (open the signed URL directly
// in a new tab) now lives inside the modal as the View button — same
// semantics, just one click further away.
function FileCard({ file, onOpen }) {
  const isImage = (file.mime_type || '').startsWith('image/');
  const hasThumbnail = Boolean(file.thumbnail_path);
  // Fall back to fetching the source image only if no pre-baked thumb
  // exists AND the file is an image — that covers legacy uploads.
  const shouldFetchSourceAsThumb = isImage && !hasThumbnail;
  // Video with the 5-frame slideshow column populated (migration 010).
  // Legacy videos (uploaded before migration 010 or that failed multi-
  // frame extraction) take the single-thumbnail path below — no slideshow.
  const hasFrames = Array.isArray(file.thumbnail_frames) && file.thumbnail_frames.length > 1;

  const [thumbUrl, setThumbUrl] = useState(null);
  const [hovered, setHovered] = useState(false);

  // Lazy signed-URL fetch. Pick the thumbnail object when migration-004
  // populated it; otherwise the source image as a legacy fallback.
  // Cancellation flag so a fast project switch + remount doesn't write
  // stale URLs into the new card's state.
  useEffect(() => {
    const path = hasThumbnail ? file.thumbnail_path : (shouldFetchSourceAsThumb ? file.storage_path : null);
    if (!path) return;
    let cancelled = false;
    createSignedDownloadUrl(path, 300).then(({ data, error }) => {
      if (cancelled || error || !data?.signedUrl) return;
      setThumbUrl(data.signedUrl);
    });
    return () => { cancelled = true; };
  }, [hasThumbnail, shouldFetchSourceAsThumb, file.thumbnail_path, file.storage_path]);

  // Extension source: prefer storage_path (which always preserves the
  // original filename verbatim — see buildStoragePath in
  // uploadProjectFile.js — so its last segment carries the real
  // extension). file.name is the user-editable display name and may
  // contain unrelated dots from camera/screenshot naming patterns
  // (e.g. macOS "Screenshot at 14.12.26") which would otherwise be
  // mis-split as ext="26" and stamp a numeric pill on the card.
  // Fall back to splitting file.name only when storage_path didn't
  // yield an extension (extensionless originals like "README").
  const storageFilename = (file.storage_path || '').split('/').pop() || '';
  const fromStorage = splitNameAndExtension(storageFilename);
  const nameExt = fromStorage.ext || splitNameAndExtension(file.name || '').ext;
  // Base name = file.name with a trailing ".{realExt}" stripped only
  // if it actually matches the real extension. Handles legacy rows
  // where the user kept the extension in the display name.
  let nameBase = file.name || '';
  if (nameExt && nameBase.toLowerCase().endsWith(`.${nameExt.toLowerCase()}`)) {
    nameBase = nameBase.slice(0, -(nameExt.length + 1));
  }

  return (
    <Tooltip content={file.name}>
      <button
        type="button"
        className="project-files-card"
        onClick={() => onOpen?.(file)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
      <div className="project-files-thumb">
        {hasFrames ? (
          // Video with multi-frame slideshow: cycles on hover, pins to
          // frame 0 otherwise. posterUrl reuses the already-fetched
          // thumbnail signed URL so frame 0 paints instantly without a
          // second round-trip.
          <VideoFrameSlideshow
            framePaths={file.thumbnail_frames}
            active={hovered}
            posterUrl={thumbUrl}
            alt=""
          />
        ) : thumbUrl ? (
          <img src={thumbUrl} alt="" loading="lazy" />
        ) : (
          <span className="project-files-icon">{iconForMime(file.mime_type)}</span>
        )}
        {/* Video runtime badge — bottom-right of the thumb. Only
            rendered when migration 011's duration_seconds column is
            populated (post-migration video uploads). Legacy video
            rows fall back to no badge. */}
        {file.duration_seconds && (
          <span className="project-files-duration" aria-hidden="true">
            {formatDuration(file.duration_seconds)}
          </span>
        )}
      </div>
        {/* Extension tag — anchored to the top-right corner of the
            card, floats above the thumb. Hidden when there's nothing
            to show (extensionless names like README, or split returned
            empty for an edge case) so we don't render an empty pill. */}
        {nameExt && (
          <span className="project-files-ext" aria-hidden="true">
            {nameExt.toUpperCase()}
          </span>
        )}
        <div className="project-files-meta">
          <div className="project-files-name">{nameBase}</div>
          <div className="project-files-sub">
            {formatBytes(file.size_bytes)} · {formatDate(file.uploaded_at)}
          </div>
        </div>
      </button>
    </Tooltip>
  );
}

// Compact card for a locally-listed file. Stripped-down sibling of
// FileCard above: no signed-URL fetching, no realtime, no video-frame
// slideshow — just an icon, name, size, and mtime. Clicking the card
// asks the main process to open the file in its default OS handler.
//
// `modified` is set by the parent when this local file has a matching
// cloud counterpart but its bytes differ (size mismatch = the user
// edited it locally after downloading). The "Modified" pill in the
// top-left calls that out so the user knows which files are out of
// sync with cloud.
function LocalFileCard({ file, onOpen, modified }) {
  const { base, ext } = splitNameAndExtension(file.name);
  const tooltipBody = modified
    ? `${file.path || file.name}\nDiffers from cloud version`
    : (file.path || file.name);
  // The pill sits OUTSIDE the .project-files-card so it can render
  // below the card without being clipped by the card's
  // `overflow: hidden` (which is what gives the thumb its rounded
  // corners). The wrapper is the grid item; the button fills it and
  // the pill is absolute-positioned relative to the wrapper, sitting
  // below the bottom edge without taking grid space — adjacent cards
  // don't shift to make room for it.
  return (
    <div className="project-files-local-card-wrap">
      <Tooltip content={tooltipBody}>
        <button
          type="button"
          className="project-files-card"
          onClick={() => onOpen?.(file)}
        >
          <div className="project-files-thumb">
            <span className="project-files-icon">{iconForMime(file.mimeType)}</span>
          </div>
          {ext && (
            <span className="project-files-ext" aria-hidden="true">
              {ext.toUpperCase()}
            </span>
          )}
          <div className="project-files-meta">
            <div className="project-files-name">{base || file.name}</div>
            <div className="project-files-sub">
              {formatBytes(file.sizeBytes)} · {formatDate(file.mtimeIso)}
            </div>
          </div>
        </button>
      </Tooltip>
      {modified && (
        <span className="project-files-modified-pill" aria-label="Local changes">
          Modified
        </span>
      )}
    </div>
  );
}

// Per-project file count cached in localStorage so the next visit's
// skeleton matches what the user is about to see (zero layout shift on
// hand-off). The cache is written after every successful list load —
// see the effect in ProjectFiles below. On first-ever visit the read
// returns null and the skeleton falls back to a small default count.
const FILES_COUNT_KEY = (projectId) => `docvex:project-files-count:${projectId}`;
const DEFAULT_SKELETON_COUNT = 8;

// Ctrl+wheel card resize — Windows-Explorer style. The card-size CSS
// variable drives `.project-files-grid`'s `minmax(var(--card-size),
// 1fr)`; everything else (thumb aspect-ratio, icon size, meta padding)
// is relative to the card width, so the whole tile scales together.
// Bounds picked empirically: 96px ≈ "tiny icons" (a few cards per row,
// thumbs still recognisable); 320px ≈ "extra-large icons" (one or two
// columns on a 820px-max page). 16px step matches the visual jump the
// Explorer's scroll-zoom uses — small enough to feel smooth, large
// enough that a single tick reads as a real size change.
const CARD_SIZE_KEY = 'docvex:project-files-card-size';
const CARD_SIZE_DEFAULT = 160;
const CARD_SIZE_MIN = 96;
const CARD_SIZE_MAX = 320;
const CARD_SIZE_STEP = 16;

function readCachedCardSize() {
  try {
    const raw = localStorage.getItem(CARD_SIZE_KEY);
    if (raw === null) return CARD_SIZE_DEFAULT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return CARD_SIZE_DEFAULT;
    return Math.max(CARD_SIZE_MIN, Math.min(CARD_SIZE_MAX, n));
  } catch {
    return CARD_SIZE_DEFAULT;
  }
}

function readCachedFilesCount(projectId) {
  if (!projectId) return null;
  try {
    const raw = localStorage.getItem(FILES_COUNT_KEY(projectId));
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    // localStorage can throw in private-browsing / quota-exceeded modes —
    // the skeleton just falls back to the default count in that case.
    return null;
  }
}

function writeCachedFilesCount(projectId, count) {
  if (!projectId) return;
  try {
    localStorage.setItem(FILES_COUNT_KEY(projectId), String(count));
  } catch { /* see read above */ }
}

// Shimmering grid of thumbnail-card-shaped placeholders shown while
// listProjectFiles() resolves. Mirrors .project-files-card dimensions
// (4:3 thumb + 2-line meta) so real cards drop into the same slots.
// `count` is the cached file count from the previous visit — null on
// first ever visit; falls back to DEFAULT_SKELETON_COUNT.
function ProjectFilesGridSkeleton({ count }) {
  const n = count ?? DEFAULT_SKELETON_COUNT;
  // count===0 means "user has no files" — render the empty grid (the
  // empty state will swap in immediately after the fetch resolves).
  if (n === 0) return <div className="project-files-grid" aria-hidden="true" />;
  return (
    <div className="project-files-grid" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="project-files-card project-files-card-skeleton">
          <div className="project-files-thumb skel-bar skel-files-thumb" />
          <div className="project-files-meta">
            <div className="skel-bar skel-files-name" />
            <div className="skel-bar skel-files-sub" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ProjectFiles() {
  const { selectedProject, loading: projLoading } = useSelectedProject();
  const projectId = selectedProject?.id || null;

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The currently-open file detail modal. Holds only the id of the
  // selected file — the actual file row is re-resolved from `files`
  // every render so realtime UPDATE / DELETE events automatically
  // flow into the modal's prop (and a DELETE event reduces the prop
  // to null, which the modal interprets as "auto-close").
  const [openFileId, setOpenFileId] = useState(null);
  // Upload modal open/close now lives in UploadsContext so drag-drop
  // events (handled in the context's window listener) can open it
  // from any route — not just the FAB on this page.
  const { openModal: openUploadModal, modalOpen: uploadOpen } = useUploads();
  const { notify } = useNotifications();

  // ── Local-folder sync state ───────────────────────────────────────────
  // localFolder is the absolute path the user picked (or typed) as the
  // download target. localFiles is what's actually in that directory
  // right now (refreshed after each download + when the user changes
  // the path). downloading guards the "Download all" button against
  // re-entry while a batch is in flight.
  const [localFolder, setLocalFolder] = useState('');
  const [localFiles, setLocalFiles] = useState([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  // Tracks which projectId has been hydrated from localStorage. Until
  // hydrate runs for the current project, the persist effect skips
  // writes — otherwise the initial render's localFolder='' would
  // clobber the cache before hydrate's setState commits. Critical for
  // StrictMode dev mode where effects double-fire on mount: the first
  // pass would wipe the key before the second pass could read it.
  const [hydratedProjectId, setHydratedProjectId] = useState(null);
  // Debounce timer for the text-input path. When the user types into
  // the folder input, we don't want to fire an IPC listing on every
  // keystroke; wait until they stop typing.
  const localFolderDebounceRef = useRef(null);

  // Hydrate the chosen folder from localStorage when the project switches.
  // Clearing on project switch (instead of carrying the value forward)
  // avoids accidentally syncing project A's files into project B's
  // folder if the user picked one and forgot. `hydratedProjectId` flips
  // last so the persist effect's closure sees the same projectId only
  // AFTER hydration has set the folder state.
  useEffect(() => {
    if (!projectId) {
      setLocalFolder('');
      setLocalFiles([]);
      setLocalError(null);
      setHydratedProjectId(null);
      return;
    }
    let cached = '';
    try {
      cached = localStorage.getItem(LOCAL_FOLDER_KEY(projectId)) || '';
    } catch { /* private-mode etc. — fall through with empty */ }
    setLocalFolder(cached);
    setLocalFiles([]);
    setLocalError(null);
    setHydratedProjectId(projectId);
  }, [projectId]);

  // Persist the folder + refresh the listing whenever the path changes.
  // 300ms debounce lets the user type a path without firing an IPC on
  // every keystroke; the dialog-picker path resolves instantly because
  // setState there happens once with the final value.
  //
  // Persistence gate: only write to localStorage once the hydrate
  // effect has run for THIS project (hydratedProjectId === projectId).
  // Before that point, `localFolder` still reflects the previous
  // project / the initial '' default and writing it would clobber the
  // user's saved path.
  useEffect(() => {
    if (!projectId) return undefined;
    if (hydratedProjectId === projectId) {
      try {
        if (localFolder) localStorage.setItem(LOCAL_FOLDER_KEY(projectId), localFolder);
        else localStorage.removeItem(LOCAL_FOLDER_KEY(projectId));
      } catch { /* private-mode / quota — non-fatal */ }
    }

    if (!hasLocalFolderApi || !localFolder) {
      setLocalFiles([]);
      setLocalError(null);
      return undefined;
    }

    if (localFolderDebounceRef.current) {
      clearTimeout(localFolderDebounceRef.current);
    }
    let cancelled = false;
    localFolderDebounceRef.current = setTimeout(async () => {
      setLocalLoading(true);
      setLocalError(null);
      const { files: localList, error: listErr } = await localFolderApi.list(localFolder);
      if (cancelled) return;
      setLocalLoading(false);
      if (listErr) {
        setLocalError(listErr);
        setLocalFiles([]);
      } else {
        setLocalFiles(localList || []);
      }
    }, 300);

    return () => {
      cancelled = true;
      if (localFolderDebounceRef.current) clearTimeout(localFolderDebounceRef.current);
    };
  }, [projectId, localFolder, hydratedProjectId]);

  // Open the native folder picker; main returns the absolute path or
  // null if the user canceled. No-op when no Electron API (web build).
  const handleBrowseFolder = useCallback(async () => {
    if (!hasLocalFolderApi) return;
    const picked = await localFolderApi.pick();
    if (picked) setLocalFolder(picked);
  }, []);

  // Open the chosen folder in the OS file manager.
  const handleOpenFolder = useCallback(() => {
    if (!hasLocalFolderApi || !localFolder) return;
    localFolderApi.openPath(localFolder);
  }, [localFolder]);

  // Open a local file in its default OS application.
  const handleOpenLocalFile = useCallback((file) => {
    if (!hasLocalFolderApi || !file?.path) return;
    localFolderApi.openPath(file.path);
  }, []);

  // ── Active tab (Cloud / Local) ─────────────────────────────────────────
  const [activeTab, setActiveTab] = useState(readCachedActiveTab);

  useEffect(() => {
    try { localStorage.setItem(ACTIVE_TAB_KEY, activeTab); }
    catch { /* private-mode / quota — falls back to default next mount */ }
  }, [activeTab]);

  // Force Cloud when the web build hides the Local tab — otherwise a
  // cached 'local' preference would leave the file area blank since the
  // Local tab isn't rendered.
  useEffect(() => {
    if (!hasLocalFolderApi && activeTab !== 'cloud') setActiveTab('cloud');
  }, [activeTab]);

  // Sign every cloud file's storage_path, ship the batch to main, and
  // reconcile via a toast + a refresh of the local listing. Existing
  // files at the target path are overwritten — cloud is the source of
  // truth for this user-initiated action.
  const handleDownloadAll = useCallback(async () => {
    if (!hasLocalFolderApi || !localFolder || downloading) return;
    if (files.length === 0) return;
    setDownloading(true);
    try {
      // Generate signed URLs in parallel — each one is a single HTTP
      // round-trip; doing them sequentially would add seconds of
      // latency for a 20-file project.
      const signed = await Promise.all(
        files.map(async (f) => {
          // 10-minute TTL covers slow connections + large videos.
          const { data, error: signErr } = await createSignedDownloadUrl(f.storage_path, 600);
          if (signErr || !data?.signedUrl) return null;
          // The storage path's last segment is the original filename
          // (with extension), which is what we want on disk — not the
          // user-edited display name.
          const filename = (f.storage_path || '').split('/').pop() || f.name;
          return { url: data.signedUrl, filename };
        }),
      );
      const payload = signed.filter(Boolean);
      const { results, error: dlErr } = await localFolderApi.download({
        dir: localFolder,
        files: payload,
      });
      if (dlErr) {
        notify({
          category: 'file',
          variant: 'error',
          icon: 'upload',
          title: 'Download failed',
          body: dlErr,
          dedupeKey: 'local-folder-download-error',
        });
      } else {
        const okCount = results.filter((r) => r.ok).length;
        const failCount = results.length - okCount;
        notify({
          category: 'file',
          variant: failCount > 0 ? 'error' : 'success',
          icon: 'upload',
          title: failCount > 0 ? 'Download finished with errors' : 'Download finished',
          body: failCount > 0
            ? `${okCount} of ${results.length} files downloaded · ${failCount} failed`
            : `${okCount} file${okCount === 1 ? '' : 's'} saved to ${localFolder}`,
          dedupeKey: 'local-folder-download-result',
        });
        // Refresh the local listing so the newly-downloaded files
        // appear immediately.
        const { files: localList } = await localFolderApi.list(localFolder);
        setLocalFiles(localList || []);
      }
    } finally {
      setDownloading(false);
    }
  }, [files, localFolder, downloading, notify]);

  // Ctrl+wheel resize. cardSize hydrates from localStorage so the
  // user's last-chosen size sticks across reloads and project switches.
  // The wheel listener attaches via a native addEventListener (not
  // React's onWheel) because we need `{ passive: false }` to call
  // preventDefault and suppress the browser's default ctrl+wheel zoom.
  const pageRef = useRef(null);
  const [cardSize, setCardSize] = useState(readCachedCardSize);

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setCardSize((prev) => {
        const next = prev + (e.deltaY < 0 ? CARD_SIZE_STEP : -CARD_SIZE_STEP);
        return Math.max(CARD_SIZE_MIN, Math.min(CARD_SIZE_MAX, next));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // selectedProject is the gate that decides whether the page container
    // even renders (the !selectedProject branch returns a different tree).
    // Re-running this effect when it changes ensures we (re-)attach to
    // the actual mounted .project-scoped-page node rather than miss the
    // initial mount that happened during a null-selectedProject render.
  }, [selectedProject]);

  // Persist size on change. Write is cheap (a few chars) and runs only
  // when the user actually rolls the wheel, so no debounce needed.
  useEffect(() => {
    try { localStorage.setItem(CARD_SIZE_KEY, String(cardSize)); }
    catch { /* private-mode / quota — falls back to default next mount */ }
  }, [cardSize]);

  // Load + subscribe per project. Re-fires whenever the user switches
  // projects so the list reflects the new context. The cleanup runs
  // before the next effect, unsubscribing the old channel.
  useEffect(() => {
    if (!projectId) {
      setFiles([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    listProjectFiles(projectId).then(({ data, error: listErr }) => {
      if (cancelled) return;
      if (listErr) {
        setError(listErr.message || 'Failed to load files');
        setFiles([]);
      } else {
        setFiles(data);
        // Cache the count so the next mount can render exactly this many
        // skeleton cards — zero layout shift on hand-off.
        writeCachedFilesCount(projectId, data.length);
      }
      setLoading(false);
    });

    // Realtime — same shape as NotificationsContext's subscription.
    // INSERTs from other members appear live; DELETEs (once the admin
    // delete UI ships) drop the row; UPDATEs (future renames) refresh
    // in place. The dedupe guard on INSERT covers the optimistic-add
    // race when *this* client uploaded the file (the upload pipeline
    // inserts the row AND the Realtime echo arrives, both with the
    // same id).
    const unsubscribe = subscribeForProject(projectId, (payload) => {
      const { eventType, new: newRow, old: oldRow } = payload;
      if (eventType === 'INSERT' && newRow?.id) {
        setFiles((prev) => (prev.some((f) => f.id === newRow.id) ? prev : [newRow, ...prev]));
      } else if (eventType === 'DELETE' && oldRow?.id) {
        setFiles((prev) => prev.filter((f) => f.id !== oldRow.id));
      } else if (eventType === 'UPDATE' && newRow?.id) {
        setFiles((prev) => prev.map((f) => (f.id === newRow.id ? newRow : f)));
      }
    });

    return () => { cancelled = true; unsubscribe(); };
  }, [projectId]);

  // Auto-close the file detail modal when its file disappears from the
  // list — covers realtime DELETE from another device, project switch
  // (whole `files` array replaced), or our own delete that already
  // called `onClose`. Without this the modal lingers with a null prop
  // (renders null visually, but `openFileId` stays set, blocking the
  // next reopen until the user navigates away).
  useEffect(() => {
    if (openFileId && !files.some((f) => f.id === openFileId)) {
      setOpenFileId(null);
    }
  }, [openFileId, files]);

  // Initial skeleton while the SelectedProjectContext is still hydrating
  // — matches the prior placeholder's pattern.
  if (projLoading && !selectedProject) {
    return <ProjectScopedSkeleton />;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to see its files.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  // Bucket helper shared by both panes — categorizes a list of files
  // (cloud rows OR local entries) into the three visual sections and
  // returns them in render order. Cloud cards use `mime_type` from the
  // DB row; local cards use the inferred `mimeType` from the file
  // extension (set by main.js). The bucket key matches FILE_SECTIONS.
  const bucketFiles = (items, mimeKey) => {
    const buckets = { photos: [], videos: [], documents: [] };
    for (const f of items) {
      buckets[categorizeMime(f[mimeKey])].push(f);
    }
    return buckets;
  };

  // Lookup of cloud files keyed by their on-disk filename — i.e. the
  // `storage_path`'s last segment, which is exactly what the download
  // pipeline writes to disk. Lower-cased so a Windows filesystem's
  // case-insensitive name resolution doesn't miss a match between e.g.
  // `Photo.jpg` (cloud) and `photo.jpg` (local). Used to detect local
  // files that have been edited after download — size mismatch = the
  // user changed something. Computed inline since `files` already
  // re-renders on cloud-list changes; a useMemo would add a hook
  // dependency without saving any work on the hot path.
  const cloudByFilename = new Map();
  for (const f of files) {
    const filename = (f.storage_path || '').split('/').pop();
    if (filename) cloudByFilename.set(filename.toLowerCase(), f);
  }

  return (
    <div
      className="project-scoped-page project-files-page"
      ref={pageRef}
      style={{ '--project-files-card-size': `${cardSize}px` }}
    >
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Files</h1>
        <p className="project-scoped-subtitle">
          Drop files anywhere in the app to upload to <strong>{selectedProject.name}</strong>.
        </p>

        {/* Local-folder bar — only rendered in the Electron build (the
            web build has no fs access). Input is editable so the user
            can paste a path; the Browse button opens the native folder
            picker; the Download button pulls every cloud file into the
            chosen folder. */}
        {hasLocalFolderApi && (
          <div className="project-files-local-bar">
            <input
              type="text"
              className="project-files-local-input"
              value={localFolder}
              onChange={(e) => setLocalFolder(e.target.value)}
              placeholder="C:\Users\you\Documents\project-files"
              spellCheck={false}
              aria-label="Local download folder"
            />
            <button
              type="button"
              className="project-files-local-btn"
              onClick={handleBrowseFolder}
            >
              Browse…
            </button>
            <button
              type="button"
              className="project-files-local-btn project-files-local-btn-primary"
              onClick={handleDownloadAll}
              disabled={!localFolder || downloading || files.length === 0}
            >
              {downloading
                ? 'Downloading…'
                : `Download ${files.length || ''} ${files.length === 1 ? 'file' : 'files'}`.trim()}
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="project-files-error" role="alert">{error}</div>
      )}

      {/* Tab strip — Cloud (Supabase Storage) | Local (user's folder).
          Only one tab's content renders at a time. The Local tab is
          hidden in the web build (no fs access); the activeTab effect
          force-falls-back to Cloud if the cached preference was Local. */}
      <div className="project-files-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          id="project-files-tab-cloud"
          aria-selected={activeTab === 'cloud'}
          aria-controls="project-files-panel-cloud"
          className={`project-files-tab${activeTab === 'cloud' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('cloud')}
        >
          {CloudIcon}
          <span>Cloud</span>
          <span className="project-files-tab-count">{files.length}</span>
        </button>
        {hasLocalFolderApi && (
          <button
            type="button"
            role="tab"
            id="project-files-tab-local"
            aria-selected={activeTab === 'local'}
            aria-controls="project-files-panel-local"
            className={`project-files-tab${activeTab === 'local' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('local')}
          >
            {HardDriveIcon}
            <span>Local</span>
            <span className="project-files-tab-count">{localFiles.length}</span>
          </button>
        )}
      </div>

      {activeTab === 'cloud' && (
        <div
          id="project-files-panel-cloud"
          role="tabpanel"
          aria-labelledby="project-files-tab-cloud"
          className="project-files-panel"
        >
          {loading ? (
            <ProjectFilesGridSkeleton count={readCachedFilesCount(projectId)} />
          ) : files.length === 0 ? (
            <div className="project-files-empty">
              <h2>No files yet</h2>
              <p>Drag a PDF, image, video, or text document anywhere in the app to upload it here.</p>
            </div>
          ) : (() => {
            const buckets = bucketFiles(files, 'mime_type');
            return FILE_SECTIONS.map(({ key, title }) => {
              const items = buckets[key];
              if (items.length === 0) return null;
              return (
                <section key={key} className="project-files-section">
                  <h3 className="project-files-section-title">
                    {title}
                    <span className="project-files-section-count">{items.length}</span>
                  </h3>
                  <div className="project-files-grid">
                    {items.map((f) => (
                      <FileCard key={f.id} file={f} onOpen={(file) => setOpenFileId(file.id)} />
                    ))}
                  </div>
                </section>
              );
            });
          })()}
        </div>
      )}

      {activeTab === 'local' && hasLocalFolderApi && (
        <div
          id="project-files-panel-local"
          role="tabpanel"
          aria-labelledby="project-files-tab-local"
          className="project-files-panel"
        >
          {/* Open-folder button is the only Local-specific affordance
              kept here — the folder-picker + Download live in the
              header bar so they're reachable from either tab. */}
          {localFolder && (
            <div className="project-files-panel-actions">
              <button
                type="button"
                className="project-files-side-action"
                onClick={handleOpenFolder}
              >
                Open folder
              </button>
            </div>
          )}
          {!localFolder ? (
            <div className="project-files-empty">
              <h2>No folder chosen</h2>
              <p>Pick a folder above to mirror this project's files to your PC.</p>
            </div>
          ) : localError ? (
            <div className="project-files-error" role="alert">{localError}</div>
          ) : localLoading ? (
            <ProjectFilesGridSkeleton count={null} />
          ) : localFiles.length === 0 ? (
            <div className="project-files-empty">
              <h2>Folder is empty</h2>
              <p>Click <strong>Download</strong> to copy this project's cloud files here.</p>
            </div>
          ) : (() => {
            const buckets = bucketFiles(localFiles, 'mimeType');
            return FILE_SECTIONS.map(({ key, title }) => {
              const items = buckets[key];
              if (items.length === 0) return null;
              return (
                <section key={key} className="project-files-section">
                  <h3 className="project-files-section-title">
                    {title}
                    <span className="project-files-section-count">{items.length}</span>
                  </h3>
                  <div className="project-files-grid">
                    {items.map((f) => {
                      // Match by lower-cased filename so the
                      // case-insensitive Windows filesystem agrees
                      // with the case-sensitive Map lookup.
                      const cloud = cloudByFilename.get(f.name.toLowerCase());
                      // Size mismatch = the bytes differ from what
                      // we last downloaded. Editing a file almost
                      // always changes its size by at least one
                      // byte; a rare same-size content change won't
                      // be flagged, which is acceptable for v1
                      // (hashing every file would be far more
                      // expensive than the value it adds).
                      const isModified = Boolean(cloud)
                        && Number(cloud.size_bytes) !== Number(f.sizeBytes);
                      return (
                        <LocalFileCard
                          key={f.path}
                          file={f}
                          onOpen={handleOpenLocalFile}
                          modified={isModified}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            });
          })()}
        </div>
      )}

      {/* File detail modal. Re-resolving the file row from `files` on
          every render is the realtime hook — when the page's existing
          subscription updates `files` (someone edited a description,
          someone deleted a row), the modal's `file` prop changes too.
          A DELETE event reduces the prop to null, which the modal
          interprets as "auto-close".
          onDeleted fires synchronously when the user deletes a file
          from inside the modal — drops it from local state immediately
          so the UI updates without waiting for the Realtime echo
          (the postgres_changes DELETE event is filtered out before
          it reaches this client when REPLICA IDENTITY isn't FULL on
          project_files; migration 006 fixes that for cross-device
          updates, this callback fixes the local case unconditionally). */}
      {openFileId && (
        <FileDetailModal
          file={files.find((f) => f.id === openFileId) || null}
          onClose={() => setOpenFileId(null)}
          onDeleted={(id) => setFiles((prev) => prev.filter((f) => f.id !== id))}
        />
      )}

      {/* Floating action button — bottom-right corner of the viewport,
          opens the full-screen upload modal. Position is `fixed` so it
          stays anchored regardless of page scroll. Hidden via aria when
          the modal is open so the FAB doesn't redundantly grab focus
          while its panel is already on screen. */}
      <button
        type="button"
        className="project-files-fab"
        onClick={openUploadModal}
        aria-label="Upload files"
        aria-haspopup="dialog"
        aria-expanded={uploadOpen}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}
